/**
 * Audit hash parity — bash helper vs TS canonical (P3-3 / codex round 1).
 *
 * # Why this test exists
 *
 * `hooks/_lib/bootstrap-allowlist.sh` hand-writes a JSONL audit record for
 * every `rea.bash.bootstrap_allow` event. The hash is computed INSIDE the
 * bash helper (`crypto.createHash("sha256").update(JSON.stringify(recordBase))`)
 * with a hand-pinned field order that mirrors the canonical TS
 * `AuditRecord` produced by `src/audit/append.ts → doAppend`.
 *
 * The hash chain only stays linear if both serializations are byte-identical.
 * Anything that drifts — a field renamed, a default changed, a new optional
 * field appearing in TS but not in bash — silently corrupts the chain
 * because `appendAuditRecord` would compute a different hash over the same
 * logical record. The bug surfaces ONLY at `rea audit verify` time and only
 * for downstream consumers who run verify (rare).
 *
 * This test wires both writers up to the SAME synthetic record body and
 * asserts hash equality. It is the canonical drift-detector for the bash
 * helper.
 *
 * # Test strategy
 *
 * 1. Run the bash helper with a fully-controlled fixture (`pnpm install`
 *    against a fresh package.json that declares `@bookedsolid/rea`). It
 *    writes a single line to `.rea/audit.jsonl` and computes the hash
 *    via its own embedded node script.
 *
 * 2. Read that line, extract every field that participates in the hash
 *    (everything except `hash` itself), feed it into the TS canonical
 *    `computeHash` from `src/audit/fs.ts`, and assert equality.
 *
 * This pattern matches `__tests__/hooks/bootstrap-allowlist/corpus.test.ts`
 * which already spawns the bash helper via `child_process.spawnSync`.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { computeHash } from '../../src/audit/fs.js';
import type { AuditRecord } from '../../src/gateway/middleware/audit-types.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const HELPER = path.join(REPO_ROOT, 'hooks', '_lib', 'bootstrap-allowlist.sh');

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-hash-parity-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const DEFAULT_POLICY = [
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

async function withFixture(pkgJson: unknown, policy: string = DEFAULT_POLICY): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, 'package.json'),
    typeof pkgJson === 'string' ? pkgJson : JSON.stringify(pkgJson, null, 2) + '\n',
    'utf8',
  );
  await fs.mkdir(path.join(tmpDir, '.rea'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, '.rea', 'policy.yaml'), policy, 'utf8');
}

function runAllowlist(cmd: string): { stdout: string; status: number; stderr: string } {
  const pj = path.join(tmpDir, 'package.json');
  const policy = path.join(tmpDir, '.rea', 'policy.yaml');
  const script = `
set -uo pipefail
source ${JSON.stringify(HELPER)}
out=$(bootstrap_allowlist_check "blocked-paths-bash-gate" ${JSON.stringify(cmd)} ${JSON.stringify(pj)} ${JSON.stringify(policy)} ${JSON.stringify(tmpDir)})
printf '%s' "$out"
`;
  const res = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: tmpDir },
  });
  return {
    stdout: res.stdout ?? '',
    status: res.status ?? -1,
    stderr: res.stderr ?? '',
  };
}

async function readAuditLines(): Promise<AuditRecord[]> {
  const raw = await fs.readFile(path.join(tmpDir, '.rea', 'audit.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditRecord);
}

describe('audit hash parity — bash helper vs TS canonical (P3-3)', () => {
  it('rea.bash.bootstrap_allow record hashes identically via TS computeHash', async () => {
    await withFixture({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('allow');

    const lines = await readAuditLines();
    expect(lines.length).toBe(1);
    const written = lines[0]!;

    // Sanity checks on the canonical fields — these guard against the
    // class of regression where the bash helper drifts away from the
    // TS schema. If any of these flip, the hash parity check below
    // will ALSO fail but with a less helpful message.
    expect(written.tool_name).toBe('rea.bash.bootstrap_allow');
    expect(written.server_name).toBe('rea');
    expect(written.tier).toBe('write');
    expect(written.status).toBe('allowed');
    expect(written.emission_source).toBe('rea-cli');

    // Reconstruct the record sans the `hash` field and recompute via the
    // canonical TS hasher. The bash helper builds `recordBase` with a
    // pinned field order (timestamp / session_id / tool_name / server_name
    // / tier / status / autonomy_level / duration_ms / prev_hash /
    // emission_source / metadata); we re-emit those fields in the same
    // order here.
    //
    // `JSON.stringify` honors insertion order in V8 for non-integer
    // string keys, which is the contract both this test and the bash
    // helper depend on. If V8 ever changed this, every consumer's
    // audit chain would break — that's outside the scope this test
    // can defend against.
    const rebuilt = {
      timestamp: written.timestamp,
      session_id: written.session_id,
      tool_name: written.tool_name,
      server_name: written.server_name,
      tier: written.tier,
      status: written.status,
      autonomy_level: written.autonomy_level,
      duration_ms: written.duration_ms,
      prev_hash: written.prev_hash,
      emission_source: written.emission_source,
      metadata: written.metadata,
    } satisfies Omit<AuditRecord, 'hash'>;

    const reHash = computeHash(rebuilt);
    expect(reHash).toBe(written.hash);
  });

  it('two consecutive allows keep the chain linear (prev_hash continuity)', async () => {
    await withFixture({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    runAllowlist('pnpm install');
    runAllowlist('npm ci');

    const lines = await readAuditLines();
    expect(lines.length).toBe(2);
    const [first, second] = lines;
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    // Second record's prev_hash must equal the first record's hash.
    expect(second!.prev_hash).toBe(first!.hash);

    // And re-hashing the second through TS canonical must match — proves
    // the parity invariant on the SECOND emission as well, not only the
    // genesis case.
    const rebuilt = {
      timestamp: second!.timestamp,
      session_id: second!.session_id,
      tool_name: second!.tool_name,
      server_name: second!.server_name,
      tier: second!.tier,
      status: second!.status,
      autonomy_level: second!.autonomy_level,
      duration_ms: second!.duration_ms,
      prev_hash: second!.prev_hash,
      emission_source: second!.emission_source,
      metadata: second!.metadata,
    } satisfies Omit<AuditRecord, 'hash'>;

    const reHash = computeHash(rebuilt);
    expect(reHash).toBe(second!.hash);
  });
});
