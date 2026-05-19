/**
 * Bootstrap allowlist — cross-process audit-write race (P2-2 / codex round 1).
 *
 * # Why this test exists
 *
 * `hooks/_lib/bootstrap-allowlist.sh::_bootstrap_emit_audit` reads the
 * audit-file tail to seed `prev_hash`, computes the new record's hash, and
 * appends. Without a mutex around that sequence, two concurrent bootstrap
 * allows would read the SAME `prev_hash`, compute two DIFFERENT records
 * pointing at the same parent, and break the linear hash chain.
 *
 * The fix (P2-2): a mkdir-based mutex on `.rea/.audit.lock`. mkdir is
 * atomic on POSIX, requires no external tooling (proper-lockfile lives in
 * node_modules — unavailable in the bootstrap-state codepath this helper
 * defends), and works on macOS/Linux/Alpine/Busybox bash 3.2+.
 *
 * # Test strategy
 *
 * Spawn N concurrent bash processes that each call
 * `bootstrap_allowlist_check` against the same fixture. After they all
 * complete, read `.rea/audit.jsonl` and assert that the hash chain is
 * linear — each record's `prev_hash` matches the previous record's `hash`,
 * with no fork.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HELPER = path.join(REPO_ROOT, 'hooks', '_lib', 'bootstrap-allowlist.sh');

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-bsa-conc-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const POLICY = [
  'version: "1"',
  'profile: "open-source"',
  'installed_by: "rea@0.49.0"',
  'installed_at: "2026-05-18T00:00:00Z"',
  'autonomy_level: L1',
  'max_autonomy_level: L2',
  'promotion_requires_human_approval: true',
  'block_ai_attribution: false',
  'blocked_paths:',
  '  - .env',
  'notification_channel: ""',
  '',
].join('\n');

async function setupFixture(): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, 'package.json'),
    JSON.stringify({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    }) + '\n',
    'utf8',
  );
  await fs.mkdir(path.join(tmpDir, '.rea'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, '.rea', 'policy.yaml'), POLICY, 'utf8');
}

interface ChildResult {
  stdout: string;
  exitCode: number | null;
}

/**
 * Spawn a single bash invocation that calls `bootstrap_allowlist_check`
 * with the given command. Returns when the child exits.
 */
function spawnAllow(cmd: string): Promise<ChildResult> {
  return new Promise((resolve) => {
    const pj = path.join(tmpDir, 'package.json');
    const policy = path.join(tmpDir, '.rea', 'policy.yaml');
    const script = `
set -uo pipefail
source ${JSON.stringify(HELPER)}
out=$(bootstrap_allowlist_check "blocked-paths-bash-gate" ${JSON.stringify(cmd)} ${JSON.stringify(pj)} ${JSON.stringify(policy)} ${JSON.stringify(tmpDir)})
printf '%s' "$out"
`;
    const child = spawn('bash', ['-c', script], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.on('close', (code) => {
      resolve({ stdout, exitCode: code });
    });
  });
}

interface AuditLine {
  hash: string;
  prev_hash: string;
  tool_name: string;
  metadata?: Record<string, unknown>;
}

async function readAuditLines(): Promise<AuditLine[]> {
  const raw = await fs.readFile(path.join(tmpDir, '.rea', 'audit.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditLine);
}

describe('bootstrap allowlist — concurrent audit chain integrity (P2-2)', () => {
  it('N=8 concurrent allows preserve linear hash chain (no fork)', async () => {
    await setupFixture();

    // Eight concurrent invocations — every one should allow + emit an
    // audit record. Each command is single-segment and matches an
    // allowed shape (pnpm install / npm ci / yarn / corepack enable
    // round-robin), so every invocation reaches `_bootstrap_emit_audit`.
    const shapes = [
      'pnpm install',
      'npm ci',
      'yarn',
      'corepack enable',
      'pnpm i --frozen-lockfile',
      'npm install -D @bookedsolid/rea',
      'pnpm install',
      'yarn',
    ];
    const promises = shapes.map((s) => spawnAllow(s));
    const results = await Promise.all(promises);

    // Every concurrent invocation should have produced "allow" — if
    // any returned "refuse", the lock-acquire window was too short or
    // the lock helper itself broke (which would be a P0 regression).
    for (let i = 0; i < results.length; i += 1) {
      expect(results[i]!.stdout, `invocation ${i} (${shapes[i]}) stdout`).toBe('allow');
    }

    const lines = await readAuditLines();
    // Every allow MUST emit an audit record. If the count is less than
    // the spawn count, the helper silently dropped some records —
    // also a P0 regression.
    expect(lines.length).toBe(shapes.length);

    // Linear-chain invariant: for every record after the first, its
    // prev_hash must equal the previous record's hash. A forked chain
    // (the bug P2-2 closes) violates this with two records sharing
    // the same prev_hash but different hash values.
    for (let i = 1; i < lines.length; i += 1) {
      expect(
        lines[i]!.prev_hash,
        `record ${i} prev_hash should equal record ${i - 1} hash`,
      ).toBe(lines[i - 1]!.hash);
    }

    // Every record carries the right tool_name. Defensive: catches a
    // regression where the helper started emitting a different event.
    for (const line of lines) {
      expect(line.tool_name).toBe('rea.bash.bootstrap_allow');
    }

    // No duplicate hashes — a properly serialised chain has unique
    // hashes per record (different timestamps / pm-shapes / argv-sha
    // values guarantee that the canonical-serialised body differs even
    // for identical commands).
    const hashes = new Set(lines.map((l) => l.hash));
    expect(hashes.size).toBe(lines.length);
  });
});
