#!/usr/bin/env node
/**
 * Concurrency fixture: a worker process spawned by
 * `src/audit/durability.test.ts` to exercise cross-process locking around
 * `.rea/audit.jsonl`. The test spawns two of these and asserts the resulting
 * hash chain is unbroken.
 *
 * Usage: node concurrency-worker.mjs <baseDir> <toolLabel> <count>
 *
 * Imports the compiled `dist/audit/append.js` — the test's `beforeAll`
 * ensures the build is present before spawning. We intentionally do not
 * load TypeScript sources here; a child process running through Node
 * natively is the most faithful simulation of a separate `rea` install
 * writing to the same audit log.
 */

import path from 'node:path';
import url from 'node:url';

async function main() {
  const [baseDir, toolLabel, countStr] = process.argv.slice(2);
  if (!baseDir || !toolLabel || !countStr) {
    console.error('usage: concurrency-worker.mjs <baseDir> <toolLabel> <count>');
    process.exit(2);
  }
  const count = Number.parseInt(countStr, 10);
  if (!Number.isFinite(count) || count <= 0) {
    console.error('count must be a positive integer');
    process.exit(2);
  }

  const here = path.dirname(url.fileURLToPath(import.meta.url));
  // Walk up from src/audit/__fixtures__/ → project root, then dist/audit/append.js.
  const projectRoot = path.resolve(here, '..', '..', '..');
  const distAppend = path.join(projectRoot, 'dist', 'audit', 'append.js');

  let mod;
  try {
    mod = await import(url.pathToFileURL(distAppend).href);
  } catch (err) {
    console.error(
      `concurrency-worker: cannot import ${distAppend}\n` +
        `                   run 'pnpm build' before running durability tests\n` +
        `                   ${err instanceof Error ? err.message : err}`,
    );
    process.exit(3);
  }

  for (let i = 0; i < count; i++) {
    try {
      await mod.appendAuditRecord(baseDir, {
        tool_name: toolLabel,
        server_name: 'concurrency',
        metadata: { i, pid: process.pid },
      });
    } catch (err) {
      console.error(
        `concurrency-worker[${toolLabel}]: append #${i} failed: ${
          err instanceof Error ? err.stack : String(err)
        }`,
      );
      process.exit(4);
    }
  }
}

main().catch((err) => {
  console.error(`concurrency-worker: fatal: ${err instanceof Error ? err.stack : String(err)}`);
  process.exit(5);
});
