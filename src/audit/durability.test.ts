/**
 * Durability tests (G1) — the four categories the G1 orchestrator plan called
 * out explicitly: tamper, crash-recovery, concurrency, `rea audit verify`
 * happy path. Rotation boundary coverage lives next to the rotator in
 * `src/gateway/audit/rotator.test.ts`.
 */

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { appendAuditRecord } from './append.js';
import {
  GENESIS_HASH,
  computeHash,
  readLastRecord,
  withAuditLock,
} from './fs.js';
import type { AuditRecord } from '../gateway/middleware/audit-types.js';
import { forceRotate } from '../gateway/audit/rotator.js';
import { runAuditVerify } from '../cli/audit.js';

async function readLines(file: string): Promise<AuditRecord[]> {
  const raw = await fs.readFile(file, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditRecord);
}

describe('durability — tamper detection via rea audit verify', () => {
  let baseDir: string;
  let auditFile: string;
  let originalCwd: string;

  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-durability-')));
    auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('flips a byte inside a rotated file and verify walks in via --since and exits 1', async () => {
    // Write 10 records, rotate, then corrupt the rotated file.
    for (let i = 0; i < 10; i++) {
      await appendAuditRecord(baseDir, {
        tool_name: 't',
        server_name: 'u',
        metadata: { i },
      });
    }

    const rot = await forceRotate(auditFile);
    expect(rot.rotated).toBe(true);
    const rotatedPath = rot.rotatedTo!;

    // Flip the tool_name in record index 5 from "t" to "Z". This guarantees
    // the serialization changes without depending on the inner metadata layout,
    // and the recomputed hash will no longer match the stored one.
    const raw = await fs.readFile(rotatedPath, 'utf8');
    const lines = raw.split('\n');
    expect(lines[5]).toBeDefined();
    const target = lines[5]!;
    expect(target).toContain('"tool_name":"t"');
    const tampered = target.replace('"tool_name":"t"', '"tool_name":"Z"');
    expect(tampered).not.toBe(target);
    lines[5] = tampered;
    await fs.writeFile(rotatedPath, lines.join('\n'));

    // Capture exit + stderr by monkey-patching process.exit and console.error.
    process.chdir(baseDir);
    const captured: string[] = [];
    const origError = console.error;
    const origLog = console.log;
    console.error = (...args: unknown[]) => {
      captured.push(args.map(String).join(' '));
    };
    console.log = () => {
      /* swallow */
    };
    const origExit = process.exit;
    let exitCode: number | undefined;
    // @ts-expect-error — test shim for process.exit
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error('__exit__');
    }) as typeof process.exit;

    try {
      await expect(
        runAuditVerify({ since: path.basename(rotatedPath) }),
      ).rejects.toThrow('__exit__');
    } finally {
      console.error = origError;
      console.log = origLog;
      process.exit = origExit;
    }

    expect(exitCode).toBe(1);
    const joined = captured.join('\n');
    expect(joined).toMatch(/TAMPER DETECTED/);
    expect(joined).toMatch(new RegExp(path.basename(rotatedPath)));
    expect(joined).toMatch(/Record index:\s*5/);
  });
});

describe('durability — partial-write crash recovery', () => {
  let baseDir: string;
  let auditFile: string;

  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-durability-')));
    auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('truncates a trailing partial line before the next append', async () => {
    // Seed two clean records.
    await appendAuditRecord(baseDir, { tool_name: 'a', server_name: 'u' });
    const second = await appendAuditRecord(baseDir, { tool_name: 'b', server_name: 'u' });

    // Now simulate a crash: open the file and write a partial JSON line
    // (no trailing newline). Releasing the handle without a newline is the
    // defined crash signal.
    await fs.appendFile(auditFile, '{"timestamp":"2026-04-18T00:00:00Z","tool_n');

    // Precondition: file tail does NOT end in newline.
    const before = await fs.readFile(auditFile, 'utf8');
    expect(before.endsWith('\n')).toBe(false);

    // readLastRecord should recover and return the second record's hash.
    const { hash } = await readLastRecord(auditFile);
    expect(hash).toBe(second.hash);

    const afterRecovery = await fs.readFile(auditFile, 'utf8');
    expect(afterRecovery.endsWith('\n')).toBe(true);

    // Next clean append chains on top of the recovered tail.
    const third = await appendAuditRecord(baseDir, { tool_name: 'c', server_name: 'u' });
    expect(third.prev_hash).toBe(second.hash);

    const lines = await readLines(auditFile);
    expect(lines).toHaveLength(3);
    expect(lines[2]!.prev_hash).toBe(second.hash);
  });

  it('treats a file that is entirely a partial write (no newlines) as empty', async () => {
    await fs.mkdir(path.dirname(auditFile), { recursive: true });
    await fs.writeFile(auditFile, '{"not a complete record"');
    const { hash } = await readLastRecord(auditFile);
    expect(hash).toBe(GENESIS_HASH);
    const stat = await fs.stat(auditFile);
    expect(stat.size).toBe(0);
  });

  it('withAuditLock serializes a reader-then-appender mid-write sequence', async () => {
    // Acquire the lock, drop half a record into the file, release. Mirror
    // what a crashed holder would leave. Next call through the helper
    // recovers cleanly.
    await fs.mkdir(path.dirname(auditFile), { recursive: true });
    await fs.writeFile(auditFile, ''); // must exist for the test
    await withAuditLock(auditFile, async () => {
      await fs.appendFile(auditFile, '{"incomplete');
    });
    // The lock was released, but the tail is a partial write. Next append
    // must recover.
    const r = await appendAuditRecord(baseDir, { tool_name: 'recover', server_name: 'u' });
    expect(r.prev_hash).toBe(GENESIS_HASH);
    const lines = await readLines(auditFile);
    expect(lines).toHaveLength(1);
  });
});

describe('durability — cross-process concurrency', () => {
  let baseDir: string;
  let auditFile: string;

  beforeAll(async () => {
    // The worker imports dist/audit/append.js. If a fresh checkout hasn't
    // built yet, build now — once per test run, cached across the process.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const projectRoot = path.resolve(here, '..', '..');
    const distMarker = path.join(projectRoot, 'dist', 'audit', 'append.js');
    try {
      await fs.access(distMarker);
    } catch {
      const result = spawnSync(
        'pnpm',
        ['exec', 'tsc', '-p', 'tsconfig.build.json'],
        { cwd: projectRoot, stdio: 'inherit' },
      );
      if (result.status !== 0) {
        throw new Error(
          `concurrency test: failed to build dist/ (exit ${result.status}). Run 'pnpm build' manually.`,
        );
      }
    }
  }, 60_000);

  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-durability-')));
    auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it(
    'two processes each appending 50 records produce a linear 100-record chain',
    async () => {
      // Resolve the compiled-or-source append path. Tests run under vitest
      // with TS-source, so point children at the TS file via tsx — but we
      // avoid that dependency by spawning a child that re-imports the same
      // vitest-configured module path via Node's loader hook.
      //
      // Simpler: write a tiny JS worker that requires a pre-built dist/
      // artifact. Our pipeline runs `pnpm build` before `pnpm test`... no,
      // it does not. Vitest runs TS directly, and we need the CHILD to run
      // TS directly too. Easiest: the child reads stdin for config and
      // exec's its worker logic via dynamic import of the test file's own
      // source tree through vite-node.
      //
      // We sidestep the TS/JS question entirely by using vite-node's CLI via
      // pnpm, which is already on PATH in any environment running this
      // suite. The child script is a minimal loop that calls
      // `appendAuditRecord` N times.
      const here = path.dirname(fileURLToPath(import.meta.url));
      const workerPath = path.join(here, '__fixtures__', 'concurrency-worker.mjs');

      // Ensure the worker file exists — it's a checked-in fixture next to
      // this test.
      await fs.access(workerPath);

      const spawnOne = (
        label: string,
      ): Promise<{ code: number | null; stderr: string }> =>
        new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [workerPath, baseDir, label, '50'],
            {
              stdio: ['ignore', 'ignore', 'pipe'],
              env: { ...process.env },
            },
          );
          let stderr = '';
          child.stderr.on('data', (d: Buffer) => {
            stderr += d.toString('utf8');
          });
          child.on('error', reject);
          child.on('exit', (code) => {
            resolve({ code, stderr });
          });
        });

      const [a, b] = await Promise.all([spawnOne('proc-a'), spawnOne('proc-b')]);
      expect(a.code, `proc-a stderr:\n${a.stderr}`).toBe(0);
      expect(b.code, `proc-b stderr:\n${b.stderr}`).toBe(0);

      const lines = await readLines(auditFile);
      expect(lines).toHaveLength(100);

      // Chain integrity: every prev_hash is the previous record's hash,
      // and every stored hash matches its record body.
      let prev = GENESIS_HASH;
      for (let i = 0; i < lines.length; i++) {
        const r = lines[i]!;
        expect(r.prev_hash).toBe(prev);
        const { hash, ...rest } = r;
        expect(computeHash(rest)).toBe(hash);
        prev = hash;
      }

      // Distribution sanity: both processes made progress. If one crowded
      // out the other we'd still see 100, but we want to know both wrote.
      const fromA = lines.filter((l) => l.tool_name === 'proc-a').length;
      const fromB = lines.filter((l) => l.tool_name === 'proc-b').length;
      expect(fromA).toBe(50);
      expect(fromB).toBe(50);
    },
    60_000,
  );
});

describe('durability — rea audit verify happy path', () => {
  let baseDir: string;
  let auditFile: string;
  let originalCwd: string;

  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-durability-')));
    auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
    originalCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('exits 0 after 20 clean appends', async () => {
    for (let i = 0; i < 20; i++) {
      await appendAuditRecord(baseDir, {
        tool_name: 'happy',
        server_name: 'u',
        metadata: { i },
      });
    }

    process.chdir(baseDir);

    const origLog = console.log;
    const origError = console.error;
    const origExit = process.exit;
    const logs: string[] = [];
    console.log = (...a: unknown[]) => logs.push(a.map(String).join(' '));
    console.error = () => {
      /* swallow */
    };
    let exitCalled = false;
    // @ts-expect-error — test shim
    process.exit = () => {
      exitCalled = true;
      throw new Error('__exit__');
    };

    try {
      await runAuditVerify({});
    } finally {
      console.log = origLog;
      console.error = origError;
      process.exit = origExit;
    }

    expect(exitCalled).toBe(false);
    expect(logs.join('\n')).toMatch(/Audit chain verified: 20 records/);

    // Sanity: file still valid on disk.
    expect(auditFile).toContain('.rea');
    const lines = await readLines(auditFile);
    expect(lines).toHaveLength(20);
  });
});
