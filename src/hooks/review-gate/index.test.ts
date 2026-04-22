/**
 * Integration-shaped tests for the Phase 2b composition.
 *
 * These tests exercise `runPushReviewGate()` and `runCommitReviewGate()`
 * end-to-end WITHIN the TS module: GitRunner is stubbed so we don't
 * hit a real git repo, but every other module (policy loader, audit
 * append, cache lookup, banner render) runs for real against a
 * tmpdir-backed `.rea/`.
 *
 * Security invariant coverage (per the design doc §5.3 + the Phase
 * 2b burst brief):
 *
 *   - **J — mixed-push deletion guard**: a `[push, delete]` stdin
 *     must fail-closed with `DeletionBlockedError`, even when the
 *     push refspec is otherwise reviewable.
 *   - **P — Codex receipt forgery rejection**: an audit line with
 *     `emission_source: "other"` must NOT satisfy the protected-path
 *     gate. Only `rea-cli` / `codex-cli` pass the predicate.
 *   - **U — streaming-parse tolerance**: a corrupt line in audit.jsonl
 *     must not abort the scan; a legitimate record BEFORE or AFTER
 *     the corruption is still found.
 *   - **C0 + C1 control-char rejection**: a cache-error stderr
 *     containing 0x1B CSI / 0x9B bare-C1 bytes must be stripped from
 *     any banner that echoes it (banner.ts::stripControlChars).
 *   - **Path-traversal rejection**: a pushed path with `..` or null
 *     bytes must not escape the protected-path prefix match.
 *
 * None of these is a new invariant — the primitives already enforce
 * them. The composition tests confirm the wiring preserves them.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectCommitSensitiveFiles,
  runCommitReviewGate,
  runPushReviewGate,
  scoreCommit,
  stripControlChars,
} from './index.js';
import type { GitRunner, GitRunResult } from './diff.js';
import type { PushReviewContext } from './index.js';

// ── test fixtures ───────────────────────────────────────────────────────

const LOCAL_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const REMOTE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MERGE_BASE = 'cccccccccccccccccccccccccccccccccccccccc';
const ZERO = '0000000000000000000000000000000000000000';

async function freshRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'review-gate-index-test-'));
  await mkdir(join(dir, '.rea'), { recursive: true });
  await writeFile(
    join(dir, '.rea', 'policy.yaml'),
    [
      'version: "1"',
      'profile: "test"',
      'autonomy_level: L1',
      'max_autonomy_level: L2',
      'review:',
      '  codex_required: true',
      '',
    ].join('\n'),
  );
  return dir;
}

/**
 * Scripted GitRunner builder. Matches on args-prefix → canned result.
 * Returns a default `{status: 1, stdout: '', stderr: ''}` when nothing
 * matches — the caller's test assertion will surface the miss.
 */
type ScriptedCase = {
  match: readonly string[];
  result: GitRunResult;
};
function scriptedRunner(cases: ScriptedCase[]): GitRunner {
  return vi.fn((args: readonly string[]): GitRunResult => {
    for (const c of cases) {
      if (c.match.length > args.length) continue;
      let ok = true;
      for (let i = 0; i < c.match.length; i++) {
        if (c.match[i] !== args[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return c.result;
    }
    return { status: 1, stdout: '', stderr: '' };
  });
}

/** Standard runner for a normal push scenario: actor + base + diff. */
function happyPathRunner(opts: {
  diff: string;
  nameStatus: string;
  count: number;
}): GitRunner {
  return scriptedRunner([
    { match: ['config', '--get', 'user.email'], result: { status: 0, stdout: 'dev@example.com', stderr: '' } },
    { match: ['config', '--get', 'user.name'], result: { status: 0, stdout: 'Dev', stderr: '' } },
    { match: ['branch', '--show-current'], result: { status: 0, stdout: 'feature/foo', stderr: '' } },
    { match: ['rev-parse', 'HEAD'], result: { status: 0, stdout: LOCAL_SHA, stderr: '' } },
    { match: ['cat-file', '-e', `${REMOTE_SHA}^{commit}`], result: { status: 0, stdout: '', stderr: '' } },
    { match: ['merge-base', REMOTE_SHA, LOCAL_SHA], result: { status: 0, stdout: MERGE_BASE, stderr: '' } },
    { match: ['diff', '--name-status', `${MERGE_BASE}..${LOCAL_SHA}`], result: { status: 0, stdout: opts.nameStatus, stderr: '' } },
    { match: ['rev-list', '--count', `${MERGE_BASE}..${LOCAL_SHA}`], result: { status: 0, stdout: String(opts.count), stderr: '' } },
    { match: ['diff', `${MERGE_BASE}..${LOCAL_SHA}`], result: { status: 0, stdout: opts.diff, stderr: '' } },
  ]);
}

// ── invariant J: mixed-push deletion guard ──────────────────────────────

describe('invariant J — mixed-push deletion guard', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshRepo();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('blocks the entire push when stdin contains both a push and a deletion', async () => {
    // Stdin: one push (safe:safe) + one deletion (:main).
    const input =
      `refs/heads/safe ${LOCAL_SHA} refs/heads/safe ${REMOTE_SHA}\n` +
      `(delete) ${ZERO} refs/heads/main ${REMOTE_SHA}\n`;
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({ diff: 'irrelevant', nameStatus: '', count: 3 }),
      input,
      cmd: 'git push origin safe:safe :main',
      argv_remote: 'origin',
      env: {},
    };
    await expect(runPushReviewGate(ctx)).rejects.toMatchObject({
      name: 'DeletionBlockedError',
      code: 'PUSH_BLOCKED_DELETE',
      exitCode: 2,
    });
  });

  it('blocks a single-deletion push too', async () => {
    const input = `(delete) ${ZERO} refs/heads/main ${REMOTE_SHA}\n`;
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({ diff: '', nameStatus: '', count: 0 }),
      input,
      cmd: 'git push origin :main',
      argv_remote: 'origin',
      env: {},
    };
    await expect(runPushReviewGate(ctx)).rejects.toMatchObject({
      name: 'DeletionBlockedError',
      code: 'PUSH_BLOCKED_DELETE',
      exitCode: 2,
    });
  });
});

// ── invariant P: Codex-receipt forgery rejection ────────────────────────

describe('invariant P — forgery rejection via emission_source', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshRepo();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const nameStatusWithProtectedPath = 'M\tsrc/gateway/middleware/audit.ts\n';
  const smallDiff = '--- a/src/gateway/middleware/audit.ts\n+++ b/src/gateway/middleware/audit.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n';

  it('rejects a forged codex.review record with emission_source: "other"', async () => {
    // Forged record — tool_name and verdict are right, but the
    // emission_source predicate rejects it per defect P.
    await writeFile(
      join(dir, '.rea', 'audit.jsonl'),
      JSON.stringify({
        tool_name: 'codex.review',
        emission_source: 'other',
        metadata: { head_sha: LOCAL_SHA, verdict: 'pass' },
      }) + '\n',
    );
    const input = `refs/heads/feat ${LOCAL_SHA} refs/heads/feat ${REMOTE_SHA}\n`;
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({
        diff: smallDiff,
        nameStatus: nameStatusWithProtectedPath,
        count: 1,
      }),
      input,
      cmd: '',
      argv_remote: 'origin',
      env: {},
    };
    await expect(runPushReviewGate(ctx)).rejects.toMatchObject({
      code: 'PUSH_BLOCKED_PROTECTED_PATHS',
      exitCode: 2,
    });
  });

  it('accepts a legitimate codex.review with emission_source: "rea-cli"', async () => {
    await writeFile(
      join(dir, '.rea', 'audit.jsonl'),
      JSON.stringify({
        tool_name: 'codex.review',
        emission_source: 'rea-cli',
        metadata: { head_sha: LOCAL_SHA, verdict: 'pass' },
      }) + '\n',
    );
    const input = `refs/heads/feat ${LOCAL_SHA} refs/heads/feat ${REMOTE_SHA}\n`;
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({
        diff: smallDiff,
        nameStatus: nameStatusWithProtectedPath,
        count: 1,
      }),
      input,
      cmd: '',
      argv_remote: 'origin',
      env: {},
    };
    const out = await runPushReviewGate(ctx);
    // Protected-path gate satisfied; caller falls through to cache/
    // review-required. Either `pass` (if diff is empty) or
    // `review_required` is acceptable — we just need protected-path
    // to NOT block.
    expect(out.kind === 'review_required' || out.kind === 'pass').toBe(true);
  });

  it('rejects a legacy record missing emission_source entirely', async () => {
    await writeFile(
      join(dir, '.rea', 'audit.jsonl'),
      JSON.stringify({
        tool_name: 'codex.review',
        metadata: { head_sha: LOCAL_SHA, verdict: 'pass' },
      }) + '\n',
    );
    const input = `refs/heads/feat ${LOCAL_SHA} refs/heads/feat ${REMOTE_SHA}\n`;
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({
        diff: smallDiff,
        nameStatus: nameStatusWithProtectedPath,
        count: 1,
      }),
      input,
      cmd: '',
      argv_remote: 'origin',
      env: {},
    };
    await expect(runPushReviewGate(ctx)).rejects.toMatchObject({
      code: 'PUSH_BLOCKED_PROTECTED_PATHS',
    });
  });
});

// ── invariant U: streaming-parse tolerance ──────────────────────────────

describe('invariant U — streaming-parse tolerance', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshRepo();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const nameStatusWithProtectedPath = 'M\thooks/push-review-gate.sh\n';
  const smallDiff = '--- a/hooks/push-review-gate.sh\n+++ b/hooks/push-review-gate.sh\n@@ -1,1 +1,1 @@\n-old\n+new\n';

  it('finds a valid codex.review record after a malformed audit line', async () => {
    const lines = [
      '{ this is not valid json ~~~',
      JSON.stringify({
        tool_name: 'codex.review',
        emission_source: 'rea-cli',
        metadata: { head_sha: LOCAL_SHA, verdict: 'pass' },
      }),
      '',
    ];
    await writeFile(join(dir, '.rea', 'audit.jsonl'), lines.join('\n'));

    const input = `refs/heads/feat ${LOCAL_SHA} refs/heads/feat ${REMOTE_SHA}\n`;
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({
        diff: smallDiff,
        nameStatus: nameStatusWithProtectedPath,
        count: 1,
      }),
      input,
      cmd: '',
      argv_remote: 'origin',
      env: {},
    };
    const out = await runPushReviewGate(ctx);
    // If U tolerance works, the valid record satisfies protected-path
    // and we proceed to cache/review logic. If the scan bailed on the
    // corrupt line, we'd get PUSH_BLOCKED_PROTECTED_PATHS.
    expect(out.kind === 'review_required' || out.kind === 'pass').toBe(true);
  });

  it('finds a valid codex.review record before a malformed audit line', async () => {
    const lines = [
      JSON.stringify({
        tool_name: 'codex.review',
        emission_source: 'rea-cli',
        metadata: { head_sha: LOCAL_SHA, verdict: 'concerns' },
      }),
      '{broken record with ] mismatched braces',
      '',
    ];
    await writeFile(join(dir, '.rea', 'audit.jsonl'), lines.join('\n'));

    const input = `refs/heads/feat ${LOCAL_SHA} refs/heads/feat ${REMOTE_SHA}\n`;
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({
        diff: smallDiff,
        nameStatus: nameStatusWithProtectedPath,
        count: 1,
      }),
      input,
      cmd: '',
      argv_remote: 'origin',
      env: {},
    };
    const out = await runPushReviewGate(ctx);
    expect(out.kind === 'review_required' || out.kind === 'pass').toBe(true);
  });
});

// ── invariant C0 + C1: control-char stripping ───────────────────────────

describe('invariant C0 + C1 — control-character stripping for banners', () => {
  it('strips C0 control chars except tab/LF/CR', () => {
    const attack = 'rea push-review: \x1b[31mCACHE CHECK FAILED\x1b[0m \t(legit tab)\n';
    const cleaned = stripControlChars(attack);
    // \x1b gone; tab + LF preserved.
    expect(cleaned).not.toContain('\x1b');
    expect(cleaned).toContain('\t(legit tab)');
    expect(cleaned.endsWith('\n')).toBe(true);
  });

  it('strips bare C1 introducers (0x80-0x9F) including CSI 0x9B and OSC 0x9D', () => {
    const attack = 'rea\x9b2Jpush-review\x9dmalicious';
    const cleaned = stripControlChars(attack);
    expect(cleaned).not.toMatch(/[\x80-\x9f]/);
    expect(cleaned).toBe('rea2Jpush-reviewmalicious');
  });

  it('strips 0x7F DEL', () => {
    expect(stripControlChars('foo\x7fbar')).toBe('foobar');
  });

  it('preserves printable ASCII unchanged', () => {
    const s = 'Scope: 3 files changed, 47 lines (src/foo.ts)';
    expect(stripControlChars(s)).toBe(s);
  });
});

// ── invariant path-traversal: no protected-path escape ──────────────────

describe('invariant path-traversal — protected-path prefix integrity', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshRepo();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('a file at `some-other-dir/.rea/fake.txt` is NOT protected (prefix match only)', async () => {
    // A path containing `.rea/` mid-string should not trigger the
    // protected-path scan — only prefix matches count. This is the
    // invariant protecting against "craft a path whose tail looks
    // like .rea/ to sneak past the gate".
    const input = `refs/heads/feat ${LOCAL_SHA} refs/heads/feat ${REMOTE_SHA}\n`;
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({
        diff: '',
        nameStatus: 'M\tsome-other-dir/.rea/fake.txt\n',
        count: 0,
      }),
      input,
      cmd: '',
      argv_remote: 'origin',
      env: {},
    };
    // No diff → pass. Would throw PROTECTED_PATHS if the prefix match
    // were a substring.
    const out = await runPushReviewGate(ctx);
    expect(out.kind).toBe('pass');
  });

  it('a literal `..` in a pushed path is treated as a filename, not a directory traversal', async () => {
    // If the scan mishandled `..`, the path `foo/../.rea/secret` could
    // normalize to `.rea/secret` and bypass. The prefix-match
    // implementation never normalizes the path, so `foo/../.rea/secret`
    // stays literal and does not match `.rea/` as a prefix.
    const input = `refs/heads/feat ${LOCAL_SHA} refs/heads/feat ${REMOTE_SHA}\n`;
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({
        diff: '',
        nameStatus: 'M\tfoo/../.rea/secret\n',
        count: 0,
      }),
      input,
      cmd: '',
      argv_remote: 'origin',
      env: {},
    };
    const out = await runPushReviewGate(ctx);
    expect(out.kind).toBe('pass');
  });

  it('a legitimate `.rea/` prefix path IS still caught', async () => {
    // Regression guard for the above: the protected-path scan still
    // works on genuine `.rea/` changes.
    const input = `refs/heads/feat ${LOCAL_SHA} refs/heads/feat ${REMOTE_SHA}\n`;
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({
        diff: 'a diff',
        nameStatus: 'M\t.rea/policy.yaml\n',
        count: 1,
      }),
      input,
      cmd: '',
      argv_remote: 'origin',
      env: {},
    };
    await expect(runPushReviewGate(ctx)).rejects.toMatchObject({
      code: 'PUSH_BLOCKED_PROTECTED_PATHS',
    });
  });
});

// ── happy-path composition smoke ────────────────────────────────────────

describe('runPushReviewGate — happy path', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshRepo();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns not_a_push when neither stdin nor cmd looks like a push', async () => {
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({ diff: '', nameStatus: '', count: 0 }),
      input: '',
      cmd: 'git status',
      argv_remote: 'origin',
      env: {},
    };
    const out = await runPushReviewGate(ctx);
    expect(out.kind).toBe('not_a_push');
  });

  it('returns review_required with a PUSH REVIEW GATE banner on cache miss', async () => {
    const diff =
      '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,2 @@\n-one\n+one\n+two\n';
    const input = `refs/heads/feat ${LOCAL_SHA} refs/heads/feat ${REMOTE_SHA}\n`;
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({
        diff,
        nameStatus: 'M\tfoo.ts\n',
        count: 1,
      }),
      input,
      cmd: '',
      argv_remote: 'origin',
      env: {},
    };
    const out = await runPushReviewGate(ctx);
    expect(out.kind).toBe('review_required');
    if (out.kind === 'review_required') {
      expect(out.exitCode).toBe(2);
      expect(out.banner).toContain('PUSH REVIEW GATE: Review required before pushing');
      expect(out.banner).toContain(`Source ref: refs/heads/feat (${LOCAL_SHA.slice(0, 12)})`);
      expect(out.banner).toContain('Target: feat');
      expect(out.banner).toContain('Scope:');
      expect(out.push_sha).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('returns pass on empty diff (no-op push)', async () => {
    const input = `refs/heads/feat ${LOCAL_SHA} refs/heads/feat ${REMOTE_SHA}\n`;
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({
        diff: '',
        nameStatus: '',
        count: 0,
      }),
      input,
      cmd: '',
      argv_remote: 'origin',
      env: {},
    };
    const out = await runPushReviewGate(ctx);
    expect(out.kind).toBe('pass');
  });

  it('honors REA_SKIP_PUSH_REVIEW and emits a push.review.skipped audit record', async () => {
    const input = `refs/heads/feat ${LOCAL_SHA} refs/heads/feat ${REMOTE_SHA}\n`;
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({ diff: 'd', nameStatus: 'M\tfoo\n', count: 1 }),
      input,
      cmd: 'git push origin feat',
      argv_remote: 'origin',
      env: { REA_SKIP_PUSH_REVIEW: 'maintenance window' },
    };
    const out = await runPushReviewGate(ctx);
    expect(out.kind).toBe('skipped');
    if (out.kind === 'skipped') {
      expect(out.banner).toContain('PUSH REVIEW GATE SKIPPED via REA_SKIP_PUSH_REVIEW');
      expect(out.banner).toContain('maintenance window');
    }
    const audit = await readFile(join(dir, '.rea', 'audit.jsonl'), 'utf8');
    const record = JSON.parse(audit.split('\n').find((l) => l.length > 0)!);
    expect(record.tool_name).toBe('push.review.skipped');
    expect(record.metadata.reason).toBe('maintenance window');
  });

  it('refuses REA_SKIP_PUSH_REVIEW in CI when allow_skip_in_ci is not set', async () => {
    const input = `refs/heads/feat ${LOCAL_SHA} refs/heads/feat ${REMOTE_SHA}\n`;
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({ diff: 'd', nameStatus: 'M\tfoo\n', count: 1 }),
      input,
      cmd: 'git push origin feat',
      argv_remote: 'origin',
      env: { REA_SKIP_PUSH_REVIEW: 'agent says ok', CI: '1' },
    };
    await expect(runPushReviewGate(ctx)).rejects.toMatchObject({
      code: 'PUSH_BLOCKED_SKIP_REFUSED_IN_CI',
      exitCode: 2,
    });
  });
});

// ── commit-review-gate composition smoke ────────────────────────────────

describe('runCommitReviewGate — triage', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshRepo();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns not_a_commit when cmd is not a git commit', async () => {
    const out = await runCommitReviewGate({
      baseDir: dir,
      runner: scriptedRunner([]),
      cmd: 'git push origin main',
    });
    expect(out.kind).toBe('pass');
    if (out.kind === 'pass') expect(out.reason).toBe('not_a_commit');
  });

  it('returns amend when cmd contains --amend', async () => {
    const out = await runCommitReviewGate({
      baseDir: dir,
      runner: scriptedRunner([]),
      cmd: 'git commit --amend --no-edit',
    });
    expect(out.kind).toBe('pass');
    if (out.kind === 'pass') expect(out.reason).toBe('amend');
  });

  it('returns no_staged_changes when there is no staged diff', async () => {
    const runner = scriptedRunner([
      { match: ['diff', '--cached'], result: { status: 0, stdout: '', stderr: '' } },
    ]);
    const out = await runCommitReviewGate({
      baseDir: dir,
      runner,
      cmd: 'git commit -m "x"',
    });
    expect(out.kind).toBe('pass');
    if (out.kind === 'pass') expect(out.reason).toBe('no_staged_changes');
  });

  it('returns trivial pass for <20-line non-sensitive diff', async () => {
    const smallDiff =
      '--- a/foo.ts\n+++ b/foo.ts\n@@ -1,1 +1,2 @@\n-x\n+x\n+y\n';
    const runner = scriptedRunner([
      { match: ['diff', '--cached'], result: { status: 0, stdout: smallDiff, stderr: '' } },
    ]);
    const out = await runCommitReviewGate({
      baseDir: dir,
      runner,
      cmd: 'git commit -m "small"',
    });
    expect(out.kind).toBe('pass');
    if (out.kind === 'pass') {
      expect(out.reason).toBe('trivial');
      expect(out.score).toBe('trivial');
    }
  });

  it('returns significant + review_required when touching sensitive paths', async () => {
    // Include `+++ b/.claude/hooks/foo.sh` header → sensitive hit.
    const sensitiveDiff =
      '--- a/.claude/hooks/foo.sh\n+++ b/.claude/hooks/foo.sh\n@@ -1,1 +1,2 @@\n-one\n+one\n+two\n';
    const runner = scriptedRunner([
      { match: ['diff', '--cached'], result: { status: 0, stdout: sensitiveDiff, stderr: '' } },
      { match: ['branch', '--show-current'], result: { status: 0, stdout: 'feat', stderr: '' } },
      { match: ['symbolic-ref', 'refs/remotes/origin/HEAD'], result: { status: 0, stdout: 'refs/remotes/origin/main', stderr: '' } },
    ]);
    const out = await runCommitReviewGate({
      baseDir: dir,
      runner,
      cmd: 'git commit -m "touch hook"',
    });
    expect(out.kind).toBe('review_required');
    if (out.kind === 'review_required') {
      expect(out.score).toBe('significant');
      expect(out.sensitive_files.length).toBeGreaterThan(0);
      expect(out.banner).toContain('COMMIT REVIEW GATE');
    }
  });

  it('scoreCommit boundaries', () => {
    expect(scoreCommit({ line_count: 0, sensitive: false })).toBe('trivial');
    expect(scoreCommit({ line_count: 19, sensitive: false })).toBe('trivial');
    expect(scoreCommit({ line_count: 20, sensitive: false })).toBe('standard');
    expect(scoreCommit({ line_count: 200, sensitive: false })).toBe('standard');
    expect(scoreCommit({ line_count: 201, sensitive: false })).toBe('significant');
    expect(scoreCommit({ line_count: 1, sensitive: true })).toBe('significant');
  });
});

describe('detectCommitSensitiveFiles', () => {
  it('flags .rea/, .claude/, .env, auth, security, and .github/workflows', () => {
    const diff = [
      '+++ b/.rea/policy.yaml',
      '+++ b/.claude/settings.json',
      '+++ b/.env.production',
      '+++ b/src/auth/login.ts',
      '+++ b/src/security/threat.ts',
      '+++ b/.github/workflows/release.yml',
      '+++ b/src/feature/ok.ts',
    ].join('\n');
    const r = detectCommitSensitiveFiles(diff);
    expect(r.hit).toBe(true);
    expect(r.files).toEqual(
      expect.arrayContaining([
        '.rea/policy.yaml',
        '.claude/settings.json',
        '.env.production',
        'src/auth/login.ts',
        'src/security/threat.ts',
        '.github/workflows/release.yml',
      ]),
    );
    // The unrelated file should NOT be in the list.
    expect(r.files).not.toContain('src/feature/ok.ts');
  });

  it('Codex P2 regression: flags .envrc as sensitive (plain substring match)', () => {
    // Bash §131 uses a plain `\.env` substring match — `.envrc` must
    // trigger. An earlier TS draft tightened this to a non-word-
    // boundary regex and dropped `.envrc` / `.envvar-dump` files from
    // the sensitive set, letting trivial edits slip past the commit
    // gate unreviewed. Byte-compatible parity with bash is the design
    // non-goal anchor.
    const diff = '+++ b/.envrc\n';
    const r = detectCommitSensitiveFiles(diff);
    expect(r.hit).toBe(true);
    expect(r.files).toContain('.envrc');
  });

  it('ignores /dev/null targets (new-file deletions)', () => {
    const diff = '+++ /dev/null\n';
    const r = detectCommitSensitiveFiles(diff);
    expect(r.hit).toBe(false);
    expect(r.files).toEqual([]);
  });

  it('empty diff → no hit', () => {
    const r = detectCommitSensitiveFiles('');
    expect(r.hit).toBe(false);
    expect(r.files).toEqual([]);
  });
});

// ── Codex P1: env threading through to evaluateCodexGate ────────────────

describe('Codex P1 regression — env threading', () => {
  let dir: string;
  const origCiEnv = process.env['CI'];
  const origSkipEnv = process.env['REA_SKIP_CODEX_REVIEW'];
  beforeEach(async () => {
    dir = await freshRepo();
    // Poison the parent env so a failure-to-thread lets the wrong
    // value reach the gate. These are deliberately dangerous values.
    process.env['CI'] = '1';
    process.env['REA_SKIP_CODEX_REVIEW'] = 'parent-process-forged-waiver';
  });
  afterEach(async () => {
    if (origCiEnv === undefined) delete process.env['CI'];
    else process.env['CI'] = origCiEnv;
    if (origSkipEnv === undefined) delete process.env['REA_SKIP_CODEX_REVIEW'];
    else process.env['REA_SKIP_CODEX_REVIEW'] = origSkipEnv;
    await rm(dir, { recursive: true, force: true });
  });

  it('ignores ambient REA_SKIP_CODEX_REVIEW when ctx.env omits it', async () => {
    // Protected path touched; no codex.review audit record exists;
    // ctx.env is a clean `{}`. The gate MUST block despite an
    // ambient `REA_SKIP_CODEX_REVIEW` in process.env — the waiver
    // would otherwise unblock the push through env-leakage.
    const input = `refs/heads/feat ${LOCAL_SHA} refs/heads/feat ${REMOTE_SHA}\n`;
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({
        diff: 'd',
        nameStatus: 'M\tsrc/gateway/middleware/audit.ts\n',
        count: 1,
      }),
      input,
      cmd: '',
      argv_remote: 'origin',
      env: {}, // clean env — parent ambient waiver must NOT apply.
    };
    await expect(runPushReviewGate(ctx)).rejects.toMatchObject({
      code: 'PUSH_BLOCKED_PROTECTED_PATHS',
      exitCode: 2,
    });
  });

  it('honors caller-provided CI=1 for REA_SKIP_PUSH_REVIEW refusal regardless of parent CI', async () => {
    // Flip the scenario: caller explicitly passes CI=1 through
    // ctx.env to simulate running under CI. The skip env var is
    // ALSO set in ctx.env. The gate MUST refuse the skip (policy
    // allow_skip_in_ci is false). If env-threading is broken and
    // the gate reads process.env, this test still passes (parent
    // has CI=1) — but the symmetric case with CI undefined would
    // regress; the invariant is that ctx.env.CI is authoritative.
    const input = `refs/heads/feat ${LOCAL_SHA} refs/heads/feat ${REMOTE_SHA}\n`;
    // Clear parent CI so only ctx.env.CI can make the gate refuse.
    delete process.env['CI'];
    const ctx: PushReviewContext = {
      baseDir: dir,
      runner: happyPathRunner({ diff: 'd', nameStatus: 'M\tfoo.ts\n', count: 1 }),
      input,
      cmd: '',
      argv_remote: 'origin',
      env: { CI: '1', REA_SKIP_PUSH_REVIEW: 'trying to bypass' },
    };
    await expect(runPushReviewGate(ctx)).rejects.toMatchObject({
      code: 'PUSH_BLOCKED_SKIP_REFUSED_IN_CI',
      exitCode: 2,
    });
  });
});

// ── Codex P2: audit-read I/O failures translate to BlockedError ─────────

describe('Codex P2 regression — fail-closed audit read errors', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await freshRepo();
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('converts a non-ENOENT audit read error into BlockedError with PROTECTED_PATHS code', async () => {
    // Create an audit file, then chmod it unreadable. The scan will
    // throw EACCES; the gate must translate to a typed BlockedError.
    const auditPath = join(dir, '.rea', 'audit.jsonl');
    await writeFile(
      auditPath,
      JSON.stringify({
        tool_name: 'codex.review',
        emission_source: 'rea-cli',
        metadata: { head_sha: LOCAL_SHA, verdict: 'pass' },
      }) + '\n',
    );
    // 0o000 — unreadable. Must be restored before afterEach.
    const { chmod } = await import('node:fs/promises');
    await chmod(auditPath, 0o000);
    try {
      const input = `refs/heads/feat ${LOCAL_SHA} refs/heads/feat ${REMOTE_SHA}\n`;
      const ctx: PushReviewContext = {
        baseDir: dir,
        runner: happyPathRunner({
          diff: 'd',
          nameStatus: 'M\t.rea/policy.yaml\n',
          count: 1,
        }),
        input,
        cmd: '',
        argv_remote: 'origin',
        env: {},
      };
      const thrown = await runPushReviewGate(ctx).catch((e) => e);
      // Running as root (CI occasionally does) would bypass the
      // chmod and read the file anyway — that yields a legitimate
      // pass which is NOT what this test intends. Skip the
      // assertion in that narrow case rather than flake CI.
      if (thrown === undefined || !(thrown instanceof Error)) {
        // The I/O path succeeded (likely root) — skip the assertion.
        return;
      }
      expect(thrown).toMatchObject({
        code: 'PUSH_BLOCKED_PROTECTED_PATHS',
        exitCode: 2,
      });
      expect(String(thrown.message)).toContain('audit log is unreadable');
    } finally {
      await chmod(auditPath, 0o644);
    }
  });
});
