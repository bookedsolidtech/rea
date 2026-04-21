/**
 * Regressions for rea 0.9.4:
 *
 *   - Defect J (rea#61) — mixed-push deletion bypass. Hoist the HAS_DELETE
 *     guard above the `-z SOURCE_SHA` fallback so `git push origin safe:safe
 *     :main` fails closed regardless of whether another refspec resolved a
 *     SOURCE_SHA.
 *
 *   - Defect K (rea#62) — `grep -c ... || echo "0"` renders `0\n0` in the
 *     PUSH REVIEW GATE banner. Replace with `|| true` + `${VAR:-0}`.
 *
 *   - Defect L (rea#63) — `shasum` missing on Alpine / distroless silently
 *     produces empty PUSH_SHA, disarming cache. Portable hasher chain
 *     (sha256sum → shasum → openssl with $NF not -r) + hex-64 validation.
 *
 *   - Defect M (rea#64) — `jq --arg os_pid` stringifies numeric pid/ppid in
 *     SKIP_METADATA. Use `--argjson` so downstream auditors querying
 *     `.metadata.os_identity.pid == 1234` (numeric) match correctly.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PUSH_HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'push-review-gate.sh');
const PUSH_HOOK_GIT_SRC = path.join(
  REPO_ROOT,
  'hooks',
  'push-review-gate-git.sh',
);
const CORE_LIB_SRC = path.join(
  REPO_ROOT,
  'hooks',
  '_lib',
  'push-review-core.sh',
);

async function installHooks(dir: string): Promise<void> {
  const destDir = path.join(dir, '.claude', 'hooks');
  await fs.mkdir(destDir, { recursive: true });
  await fs.copyFile(PUSH_HOOK_SRC, path.join(destDir, 'push-review-gate.sh'));
  await fs.chmod(path.join(destDir, 'push-review-gate.sh'), 0o755);
  await fs.copyFile(
    PUSH_HOOK_GIT_SRC,
    path.join(destDir, 'push-review-gate-git.sh'),
  );
  await fs.chmod(path.join(destDir, 'push-review-gate-git.sh'), 0o755);
  const libDir = path.join(destDir, '_lib');
  await fs.mkdir(libDir, { recursive: true });
  await fs.copyFile(CORE_LIB_SRC, path.join(libDir, 'push-review-core.sh'));
  await fs.chmod(path.join(libDir, 'push-review-core.sh'), 0o755);
}

function pushHookPath(dir: string): string {
  return path.join(dir, '.claude', 'hooks', 'push-review-gate.sh');
}

function pushHookGitPath(dir: string): string {
  return path.join(dir, '.claude', 'hooks', 'push-review-gate-git.sh');
}

function toolInput(command: string): string {
  return JSON.stringify({ tool_input: { command } });
}

interface ScratchRepo {
  dir: string;
  headSha: string;
  baselineSha: string;
  bareRemote: string;
}

function defaultPolicy(): string {
  return [
    'version: "1"',
    'profile: "bst-internal"',
    'installed_by: "test"',
    'installed_at: "2026-04-21T00:00:00Z"',
    'autonomy_level: L1',
    'max_autonomy_level: L2',
    'promotion_requires_human_approval: true',
    'block_ai_attribution: true',
    'blocked_paths:',
    '  - .env',
    'notification_channel: ""',
    'review:',
    '  codex_required: false',
    '',
  ].join('\n');
}

async function makeScratchRepo(opts: {
  featureFiles: Array<{ path: string; contents: string }>;
}): Promise<ScratchRepo> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'rea-094-portability-')),
  );

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  git('init', '--initial-branch=main', '--quiet');
  git('config', 'user.email', 'portability@example.test');
  git('config', 'user.name', 'REA 0.9.4 Test');
  git('config', 'commit.gpgsign', 'false');

  await fs.writeFile(path.join(dir, 'README.md'), '# scratch\n');
  git('add', 'README.md');
  git('commit', '-m', 'baseline', '--quiet');
  const baselineSha = git('rev-parse', 'HEAD');

  const bareRemote = path.join(dir, '..', path.basename(dir) + '.git');
  execFileSync(
    'git',
    ['init', '--bare', '--initial-branch=main', '--quiet', bareRemote],
    { encoding: 'utf8' },
  );
  git('remote', 'add', 'origin', bareRemote);
  git('push', 'origin', 'main', '--quiet');

  git('checkout', '-b', 'feature', '--quiet');
  for (const f of opts.featureFiles) {
    const fp = path.join(dir, f.path);
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, f.contents);
    git('add', f.path);
  }
  git('commit', '-m', 'feature commit', '--quiet');
  const headSha = git('rev-parse', 'HEAD');

  // Link dist/ for the escape-hatch node invocation.
  await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
  for (const sub of ['audit', 'scripts', 'policy']) {
    await fs.symlink(
      path.join(REPO_ROOT, 'dist', sub),
      path.join(dir, 'dist', sub),
    );
  }

  await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
  await fs.writeFile(
    path.join(dir, '.rea', 'policy.yaml'),
    defaultPolicy(),
  );

  await installHooks(dir);

  return { dir, headSha, baselineSha, bareRemote };
}

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runPushHook(
  repo: ScratchRepo,
  env: NodeJS.ProcessEnv = {},
  command: string,
): HookResult {
  const res = spawnSync('bash', [pushHookPath(repo.dir)], {
    cwd: repo.dir,
    env: {
      PATH: process.env.PATH ?? '',
      ...env,
      CLAUDE_PROJECT_DIR: repo.dir,
    },
    input: toolInput(command),
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

/**
 * Run the native-git adapter. Stdin is the `<local_ref> <local_sha>
 * <remote_ref> <remote_sha>` refspec list that git feeds `.husky/pre-push`
 * — NOT the Claude Code JSON shape. Use this for the mixed-push deletion
 * test because the JSON adapter parses the command string differently.
 */
function runPushHookGit(
  repo: ScratchRepo,
  env: NodeJS.ProcessEnv = {},
  args: [remoteName: string, remoteUrl: string],
  prepushStdin: string,
): HookResult {
  const res = spawnSync('bash', [pushHookGitPath(repo.dir), ...args], {
    cwd: repo.dir,
    env: {
      PATH: process.env.PATH ?? '',
      ...env,
      CLAUDE_PROJECT_DIR: repo.dir,
    },
    input: prepushStdin,
    encoding: 'utf8',
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function jqExists(): boolean {
  return spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;
}

describe('push-review-gate — 0.9.4 Defect J (mixed-push deletion bypass)', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    cleanup.length = 0;
  });

  afterEach(async () => {
    await Promise.all(
      cleanup.map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  function track(repo: ScratchRepo): void {
    cleanup.push(repo.dir);
    cleanup.push(repo.bareRemote);
  }

  it('blocks a mixed push that combines a safe refspec with a branch deletion', async () => {
    if (!jqExists()) return;

    // Use the native-git adapter: it parses the refspec list directly from
    // stdin, which is where the mixed-push vector lives. The JSON adapter
    // parses the single command string, so it cannot naturally see two
    // refspecs in one invocation.
    const repo = await makeScratchRepo({
      featureFiles: [{ path: 'safe.txt', contents: 'safe change\n' }],
    });
    track(repo);

    // Pre-push stdin format: `<local_ref> <local_sha> <remote_ref> <remote_sha>\n`
    // First line: safe refspec (local feature → remote feature).
    // Second line: deletion (local "(delete)" sha → remote main).
    //
    // Git writes the "local sha" for a deletion as 40 zeros.
    const zeroSha = '0'.repeat(40);
    const prepushStdin = [
      `refs/heads/feature ${repo.headSha} refs/heads/feature ${zeroSha}`,
      `(delete) ${zeroSha} refs/heads/main ${repo.baselineSha}`,
      '',
    ].join('\n');

    const res = runPushHookGit(
      repo,
      {},
      ['origin', repo.bareRemote],
      prepushStdin,
    );

    expect(res.status).toBe(2);
    expect(res.stderr).toContain('PUSH BLOCKED');
    expect(res.stderr).toMatch(/branch deletion|deletion/i);
  });

  it('still blocks a pure deletion push (no safe refspec alongside)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      featureFiles: [{ path: 'safe.txt', contents: 'safe change\n' }],
    });
    track(repo);

    const zeroSha = '0'.repeat(40);
    const prepushStdin = [
      `(delete) ${zeroSha} refs/heads/main ${repo.baselineSha}`,
      '',
    ].join('\n');

    const res = runPushHookGit(
      repo,
      {},
      ['origin', repo.bareRemote],
      prepushStdin,
    );

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/branch deletion|deletion/i);
  });
});

describe('push-review-gate — 0.9.4 Defect K (LINE_COUNT/FILE_COUNT "0\\n0" render)', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    cleanup.length = 0;
  });

  afterEach(async () => {
    await Promise.all(
      cleanup.map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  function track(repo: ScratchRepo): void {
    cleanup.push(repo.dir);
    cleanup.push(repo.bareRemote);
  }

  it('does NOT emit "0\\n0" in the Scope banner when the diff has zero added/removed content-lines', async () => {
    if (!jqExists()) return;

    // Edge case: a commit that adds only a file without any `+content` /
    // `-content` lines (e.g., rename-only or pure empty file). We still hit
    // the banner path — and we must not see "0\n0".
    const repo = await makeScratchRepo({
      featureFiles: [
        // A trivial safe file — small diff, non-protected path.
        { path: 'changelog.md', contents: 'minor\n' },
      ],
    });
    track(repo);

    const res = runPushHook(repo, {}, 'git push origin feature:feature');

    // Either exit 0 (cached/clean) or exit 2 (review required) — we only
    // care that the banner stderr never embeds a literal "0\n0" sequence.
    const combined = res.stdout + res.stderr;
    // Match a literal newline-separated 0-then-0 inside a single field,
    // or two 0s bracketing a newline (the exact defect shape).
    expect(combined).not.toMatch(/0\n0 files changed/);
    expect(combined).not.toMatch(/0\n0 lines/);
  });
});

describe('push-review-gate — 0.9.4 Defect L (portable sha256 hasher chain)', () => {
  // These tests are static-analysis only — they read the core script from disk
  // and assert the hasher-chain structure. No scratch repo / cleanup needed.

  it('core script references the portable hasher chain (sha256sum → shasum → openssl)', async () => {
    const core = await fs.readFile(CORE_LIB_SRC, 'utf8');
    // Hasher order matters: sha256sum first (universal on Linux), shasum
    // second (macOS default), openssl last (distroless fallback).
    const sha256sumIdx = core.indexOf('sha256sum');
    const shasumIdx = core.indexOf('shasum -a 256');
    const opensslIdx = core.indexOf('openssl dgst -sha256');
    expect(sha256sumIdx).toBeGreaterThan(0);
    expect(shasumIdx).toBeGreaterThan(0);
    expect(opensslIdx).toBeGreaterThan(0);
    expect(sha256sumIdx).toBeLessThan(shasumIdx);
    expect(shasumIdx).toBeLessThan(opensslIdx);
  });

  it('openssl branch does NOT use -r (broken on OpenSSL 1.1.x)', async () => {
    const core = await fs.readFile(CORE_LIB_SRC, 'utf8');
    // The openssl branch is the third in the chain. Match the `openssl
    // dgst -sha256 ...` line and confirm no `-r` flag.
    const line = core
      .split('\n')
      .find((l) => l.includes('openssl dgst -sha256'));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/-r\b/);
    expect(line).toMatch(/\$NF/); // handles both 1.1.x and 3.x output shapes
  });

  it('core script validates hasher output as 64-hex before accepting', async () => {
    const core = await fs.readFile(CORE_LIB_SRC, 'utf8');
    // The guard must be there — any non-hex-64 output is rejected with a WARN.
    expect(core).toMatch(/\[0-9a-f\]\{64\}/);
    expect(core).toMatch(/hasher returned invalid output/i);
  });

  it('core script emits a visible WARN when no hasher is found', async () => {
    const core = await fs.readFile(CORE_LIB_SRC, 'utf8');
    expect(core).toMatch(/no sha256 hasher found/i);
    expect(core).toMatch(/cache disabled/i);
  });
});

describe('push-review-gate — 0.9.4 Defect M (SKIP_METADATA numeric os_pid/os_ppid)', () => {
  const cleanup: string[] = [];

  beforeEach(() => {
    cleanup.length = 0;
  });

  afterEach(async () => {
    await Promise.all(
      cleanup.map((d) => fs.rm(d, { recursive: true, force: true })),
    );
  });

  function track(repo: ScratchRepo): void {
    cleanup.push(repo.dir);
    cleanup.push(repo.bareRemote);
  }

  it('REA_SKIP_PUSH_REVIEW emits numeric pid/ppid in the audit record', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      featureFiles: [{ path: 'safe.txt', contents: 'safe change\n' }],
    });
    track(repo);

    const res = runPushHook(
      repo,
      { REA_SKIP_PUSH_REVIEW: '0.9.4 M regression test' },
      'git push origin feature:feature',
    );

    // Exit 0 (or 2 if another gate blocks — but the skip audit should
    // still have landed; the metadata is what we're asserting).
    expect([0, 2]).toContain(res.status);

    const auditPath = path.join(repo.dir, '.rea', 'audit.jsonl');
    const raw = await fs.readFile(auditPath, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    const skipRecord = lines
      .map((l) => JSON.parse(l))
      .find((r) => r.tool_name === 'push.review.skipped');
    expect(skipRecord).toBeDefined();
    expect(skipRecord.metadata.os_identity.pid).toBeTypeOf('number');
    expect(skipRecord.metadata.os_identity.ppid).toBeTypeOf('number');
    expect(skipRecord.metadata.os_identity.pid).toBeGreaterThan(0);
    expect(skipRecord.metadata.os_identity.ppid).toBeGreaterThan(0);
  });

  it('uid remains a string (tolerates empty `id -u` output)', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      featureFiles: [{ path: 'safe.txt', contents: 'safe change\n' }],
    });
    track(repo);

    runPushHook(
      repo,
      { REA_SKIP_PUSH_REVIEW: '0.9.4 M uid-string test' },
      'git push origin feature:feature',
    );

    const auditPath = path.join(repo.dir, '.rea', 'audit.jsonl');
    const raw = await fs.readFile(auditPath, 'utf8');
    const skipRecord = raw
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((r) => r.tool_name === 'push.review.skipped');
    expect(skipRecord).toBeDefined();
    // uid comes from `id -u` which may be empty on edge platforms; keep as
    // string so empty-string doesn't crash --argjson parse.
    expect(typeof skipRecord.metadata.os_identity.uid).toBe('string');
  });
});
