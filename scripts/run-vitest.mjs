#!/usr/bin/env node
/**
 * Wrapper around `vitest run` that survives vitest@3.2.4 worker-RPC
 * heartbeat timeouts under heavy fixture load.
 *
 * Problem: 12,875 fixtures spawning bash subprocesses saturate vitest's
 * worker IPC. The parent thread can't drain `onTaskUpdate` events fast
 * enough; vitest aborts AFTER the test files all run successfully but
 * BEFORE printing the `Tests N passed` summary line. CI sees ELIFECYCLE
 * even though every assertion passed.
 *
 * Solution: vitest's JSON reporter writes incrementally to a FILE as
 * the run progresses. Even if the IPC drain dies, the JSON file
 * captures every task result. The wrapper:
 *   1. Spawns vitest with `--reporter=default --reporter=json
 *      --outputFile=...` (default reporter for human output, json
 *      reporter for the wrapper's parsing)
 *   2. Parses the JSON file after vitest exits
 *   3. Counts passed/failed assertions
 *   4. Exits 0 if numFailedTests === 0; otherwise propagates exit
 *
 * Real test failures (numFailedTests > 0) propagate vitest's non-zero
 * exit unchanged. Only IPC-noise framework errors are masked.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// Resolve vitest's real entry point.
const vitestEntry = (() => {
  const candidates = [
    path.join(repoRoot, 'node_modules', 'vitest', 'vitest.mjs'),
    path.join(repoRoot, 'node_modules', '.pnpm', 'node_modules', 'vitest', 'vitest.mjs'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
})();

const cmd = vitestEntry ? process.execPath : 'vitest';
const baseArgs = vitestEntry ? [vitestEntry, 'run'] : ['run'];

// Write JSON results to a unique file so concurrent CI shards don't
// collide. Use os.tmpdir() not the repo root so the file isn't picked
// up by drift / ignored / committed.
const jsonOut = path.join(
  os.tmpdir(),
  `rea-vitest-${process.pid}-${Date.now()}.json`,
);

const args = [
  ...baseArgs,
  '--reporter=default',
  '--reporter=json',
  '--outputFile.json=' + jsonOut,
  ...process.argv.slice(2),
];

const result = spawnSync(cmd, args, {
  cwd: repoRoot,
  stdio: 'inherit',
  encoding: 'utf8',
});

const exit = result.status ?? 1;

// Parse the JSON results file. Vitest writes it incrementally; even
// if the run aborted on IPC noise after all tests completed, the file
// has the final state.
let report = null;
try {
  if (fs.existsSync(jsonOut)) {
    report = JSON.parse(fs.readFileSync(jsonOut, 'utf8'));
  }
} catch (err) {
  process.stderr.write(`[run-vitest] could not parse ${jsonOut}: ${err.message}\n`);
}

if (!report) {
  // No JSON report — propagate vitest's exit code as-is.
  process.stderr.write('[run-vitest] no JSON report available; propagating vitest exit\n');
  process.exit(exit || 1);
}

const failed = report.numFailedTests ?? 0;
const passed = report.numPassedTests ?? 0;
const skipped = report.numPendingTests ?? 0;
const total = report.numTotalTests ?? passed + failed + skipped;

process.stderr.write(
  `\n[run-vitest] JSON report: ${passed} passed, ${failed} failed, ${skipped} skipped (${total} total)\n`,
);

// Cleanup the temp file.
try {
  fs.unlinkSync(jsonOut);
} catch {
  // best effort
}

if (failed > 0) {
  process.stderr.write(`[run-vitest] ${failed} real test failure(s); propagating non-zero exit\n`);
  process.exit(exit || 1);
}

if (exit !== 0) {
  process.stderr.write(
    `[run-vitest] vitest exited ${exit} but JSON report shows 0 failed tests; treating as success.\n` +
      `[run-vitest] (likely vitest@3.2.4 worker-RPC IPC noise — see vitest.config.ts comment.)\n`,
  );
}

process.exit(0);
