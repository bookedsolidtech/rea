/**
 * T-GOLD-01 / T-GOLD-02 — byte-identical codex audit record (AC-7).
 *
 * The 0.50.x `runReview` refactor lifts four hardcoded `PROVIDER_CODEX`
 * sites, the codex availability probe, error classification, and the
 * install message into a `ReviewProvider` abstraction (the `CodexProvider`).
 * The codex path's OBSERVABLE output — the appended `rea.local_review`
 * audit JSON line, the `--json` stdout payload, the `.rea/last-review.json`
 * bytes, and the exit code — MUST NOT move a byte.
 *
 * This test is the regression wall around AC-7 and AC-9. It is the
 * acceptance gate for the refactor (sequencing step 1): it must stay green
 * through every subsequent commit.
 *
 * Strategy:
 *   - Real temp git repo at a fixed HEAD (deterministic content_token).
 *   - A fake `codex` binary on PATH that prints a fixed `--version` (so
 *     `provider_version` is deterministic and the availability probe is
 *     exercised, not stubbed).
 *   - The `RunReviewDeps.executeCodexReview` seam returns a FIXED outcome.
 *   - `process.exit` intercepted; stdout/stderr captured.
 *   - The appended audit line is read from disk, its chain-level fields
 *     (timestamp / hash / prev_hash / session_id / autonomy_level /
 *     duration_ms / emission_source — all owned by `appendAuditRecord`,
 *     orthogonal to the refactor) normalized, and the result snapshotted as
 *     a canonical JSON string. Byte equality of THAT string is the gate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReview, type ReviewOutcome } from './review.js';
import { invalidatePolicyCache } from '../policy/loader.js';

// ---------------------------------------------------------------------------
// Deterministic fixed codex outcome — same across T-GOLD-01 and T-GOLD-02.
// ---------------------------------------------------------------------------
const FIXED_OUTCOME: ReviewOutcome = {
  verdict: 'concerns',
  findingCount: 2,
  baseRef: 'refs/remotes/origin/main',
  headSha: '1111111111111111111111111111111111111111',
  contentToken: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  durationSeconds: 12.5,
  model: 'gpt-5.4',
  reasoningEffort: 'high',
  findings: [
    {
      severity: 'P2',
      title: 'divide has no zero-guard',
      body: '- [P2] divide has no zero-guard — app.ts:4\n  divide(a,b) returns a/b with no guard.',
      file: 'app.ts',
      line: 4,
    },
    {
      severity: 'P3',
      title: 'nit: prefer const',
      body: '- [P3] nit: prefer const',
    },
  ],
  reviewText:
    '- [P2] divide has no zero-guard — app.ts:4\n  divide(a,b) returns a/b with no guard.\n- [P3] nit: prefer const',
  eventCount: 7,
};

const FAKE_CODEX_VERSION = 'codex-cli 9.9.9-golden';

interface CapturedRun {
  auditLine: Record<string, unknown>;
  stdout: string;
  lastReview: unknown;
  exitCode: number;
}

let tmpDir: string;
let prevCwd: string;
let prevPath: string | undefined;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-gold-'));
  prevCwd = process.cwd();
  prevPath = process.env.PATH;

  // Real git repo at a fixed HEAD.
  git(['init', '-q'], tmpDir);
  git(['config', 'user.email', 'gold@test.test'], tmpDir);
  git(['config', 'user.name', 'Gold'], tmpDir);
  git(['config', 'commit.gpgsign', 'false'], tmpDir);
  fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const add = (a, b) => a + b;\n');
  git(['add', 'app.ts'], tmpDir);
  git(['commit', '-qm', 'baseline'], tmpDir);

  // A minimal policy so resolveLocalReviewMode loads a policy object (the
  // codex path writes `...(policy ? { policy } : {})` into the audit input;
  // we want that branch exercised deterministically).
  fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.rea', 'policy.yaml'),
    [
      'version: "0.50.0"',
      'profile: open-source-no-codex',
      'installed_by: test',
      'installed_at: "2026-06-08T00:00:00Z"',
      'autonomy_level: L1',
      'max_autonomy_level: L2',
      'promotion_requires_human_approval: true',
      'block_ai_attribution: true',
      'blocked_paths: []',
      'protected_paths_relax: []',
      'notification_channel: ""',
      'review:',
      '  local_review:',
      '    mode: enforced',
      '',
    ].join('\n'),
  );

  // Fake codex on PATH with a fixed version → deterministic provider_version.
  const binDir = path.join(tmpDir, 'fakebin');
  fs.mkdirSync(binDir, { recursive: true });
  const codexPath = path.join(binDir, 'codex');
  fs.writeFileSync(
    codexPath,
    `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "${FAKE_CODEX_VERSION}"; exit 0; fi\nexit 0\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${binDir}${path.delimiter}${prevPath ?? ''}`;

  process.chdir(tmpDir);
  invalidatePolicyCache();
});

afterEach(() => {
  process.chdir(prevCwd);
  if (prevPath !== undefined) process.env.PATH = prevPath;
  vi.restoreAllMocks();
  invalidatePolicyCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Run the codex (default-provider) path and capture every observable. */
async function runCodexAndCapture(): Promise<CapturedRun> {
  const stdoutChunks: string[] = [];
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: unknown): boolean => {
      stdoutChunks.push(String(chunk));
      return true;
    });
  // Swallow stderr/console so the test output stays clean.
  vi.spyOn(process.stderr, 'write').mockImplementation((): boolean => true);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);

  let exitCode = -999;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit__${exitCode}`);
  }) as never);

  try {
    await runReview(
      { json: true, withFindings: true },
      { executeCodexReview: async () => FIXED_OUTCOME },
    );
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('__exit__')) throw e;
  } finally {
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  }

  const auditPath = path.join(tmpDir, '.rea', 'audit.jsonl');
  const auditRaw = fs.readFileSync(auditPath, 'utf8').trim();
  const lines = auditRaw.split('\n').filter(Boolean);
  const auditLine = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;

  const lrPath = path.join(tmpDir, '.rea', 'last-review.json');
  const lastReview = fs.existsSync(lrPath)
    ? (JSON.parse(fs.readFileSync(lrPath, 'utf8')) as unknown)
    : undefined;

  // Find the single JSON stdout line.
  const stdoutJoined = stdoutChunks.join('');
  return { auditLine, stdout: stdoutJoined, lastReview, exitCode };
}

/**
 * Normalize the chain-level fields owned by `appendAuditRecord` (not the
 * `runReview` refactor) so the snapshot is stable across machines/runs.
 * Everything that survives — `tool_name`, `server_name`, `tier`, `status`,
 * and the full `metadata` sub-object with its key ordering — is what the
 * refactor must keep byte-identical.
 */
function canonicalizeAudit(line: Record<string, unknown>): string {
  const clone: Record<string, unknown> = { ...line };
  clone.timestamp = '<ts>';
  clone.hash = '<hash>';
  clone.prev_hash = '<prev>';
  clone.session_id = '<sid>';
  // `policy` is passed to `appendAuditRecord` only as a rotation hint — it
  // is NOT serialized into the on-disk audit line. Normalize defensively in
  // case that ever changes, so the golden stays focused on review fields.
  if ('policy' in clone) clone.policy = '<policy>';
  return JSON.stringify(clone);
}

describe('codex golden record (AC-7) — byte-identical audit line', () => {
  it('T-GOLD-01/02: produces the locked canonical audit record + JSON + last-review + exit code', async () => {
    const run = await runCodexAndCapture();

    // --- The audit record (metadata key ordering is load-bearing) ---------
    const canonical = canonicalizeAudit(run.auditLine);

    // The exact bytes of the metadata sub-object are the #1 risk. Pin them
    // explicitly so a key-ordering or cleanMeta regression in the refactor
    // fails LOUD here, not silently downstream.
    expect(run.auditLine.tool_name).toBe('rea.local_review');
    expect(run.auditLine.server_name).toBe('rea');
    expect(run.auditLine.tier).toBe('read');
    expect(run.auditLine.status).toBe('allowed'); // concerns → allowed
    const meta = run.auditLine.metadata as Record<string, unknown>;
    // BYTE-exact metadata serialization (insertion order must be preserved):
    expect(JSON.stringify(meta)).toBe(
      JSON.stringify({
        head_sha: FIXED_OUTCOME.headSha,
        base_ref: FIXED_OUTCOME.baseRef,
        verdict: FIXED_OUTCOME.verdict,
        finding_count: FIXED_OUTCOME.findingCount,
        provider: 'codex',
        model: FIXED_OUTCOME.model,
        reasoning_effort: FIXED_OUTCOME.reasoningEffort,
        duration_seconds: FIXED_OUTCOME.durationSeconds,
        content_token: FIXED_OUTCOME.contentToken,
        provider_version: FAKE_CODEX_VERSION,
      }),
    );

    // Full canonical line — the snapshot gate. If ANYTHING the refactor
    // touches changes (tool_name/server_name/tier/status/metadata), this
    // string moves and the test fails.
    expect(canonical).toMatchInlineSnapshot(
      `"{"timestamp":"<ts>","session_id":"<sid>","tool_name":"rea.local_review","server_name":"rea","tier":"read","status":"allowed","autonomy_level":"unknown","duration_ms":0,"prev_hash":"<prev>","emission_source":"other","metadata":{"head_sha":"1111111111111111111111111111111111111111","base_ref":"refs/remotes/origin/main","verdict":"concerns","finding_count":2,"provider":"codex","model":"gpt-5.4","reasoning_effort":"high","duration_seconds":12.5,"content_token":"deadbeefdeadbeefdeadbeefdeadbeefdeadbeef","provider_version":"codex-cli 9.9.9-golden"},"hash":"<hash>"}"`,
    );

    // --- The --json stdout payload ---------------------------------------
    const jsonLine = run.stdout
      .split('\n')
      .filter(Boolean)
      .find((l) => l.trim().startsWith('{'));
    expect(jsonLine).toBeDefined();
    const payload = JSON.parse(jsonLine as string) as Record<string, unknown>;
    expect(payload.status).toBe('concerns');
    expect(payload.provider).toBe('codex');
    expect(payload.finding_count).toBe(2);
    expect(payload.exit_code).toBe(0);
    expect(payload.model).toBe('gpt-5.4');
    expect(payload.reasoning_effort).toBe('high');
    expect(payload.last_review_path).toBe('.rea/last-review.json');

    // --- .rea/last-review.json -------------------------------------------
    const lr = run.lastReview as Record<string, unknown>;
    expect(lr.schema_version).toBe(1);
    expect(lr.verdict).toBe('concerns');
    expect(Array.isArray(lr.findings)).toBe(true);
    expect((lr.findings as unknown[]).length).toBe(2);

    // --- exit code --------------------------------------------------------
    expect(run.exitCode).toBe(0); // concerns under default strictFailOn:blocking
  });
});
