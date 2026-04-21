/**
 * Regressions for rea 0.9.3:
 *
 *   - Defect B — remove `push_review: false` / `commit_review: false` policy
 *     grep bypass from the gates. Pre-0.9.3, an operator (or an attacker who
 *     could write the policy file) could short-circuit the entire push or
 *     commit gate by adding a single line to `.rea/policy.yaml`. The
 *     escape-hatch contract is explicit and auditable — `REA_SKIP_PUSH_REVIEW`
 *     writes a skip record; a grep on a YAML field does not.
 *
 *   - Defect C — protected-paths matcher omitted `.rea/` and `.husky/`. A
 *     policy-file edit (including silently relaxing `blocked_paths`) or a
 *     husky hook-body rewrite could ship without `/codex-review`. Both are
 *     higher-blast-radius than the five paths already in the matcher.
 *
 * The final assertion (file-path containing `rea/` without a leading dot)
 * pins the bracket form `[.]rea/`: a bare `rea/` regex would match a Bug
 * Reports markdown file under `Projects/rea/` and spuriously demand a Codex
 * review for harmless documentation changes.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const PUSH_HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'push-review-gate.sh');
const COMMIT_HOOK_SRC = path.join(REPO_ROOT, 'hooks', 'commit-review-gate.sh');
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
    COMMIT_HOOK_SRC,
    path.join(destDir, 'commit-review-gate.sh'),
  );
  await fs.chmod(path.join(destDir, 'commit-review-gate.sh'), 0o755);
  const libDir = path.join(destDir, '_lib');
  await fs.mkdir(libDir, { recursive: true });
  await fs.copyFile(CORE_LIB_SRC, path.join(libDir, 'push-review-core.sh'));
  await fs.chmod(path.join(libDir, 'push-review-core.sh'), 0o755);
}

function pushHookPath(dir: string): string {
  return path.join(dir, '.claude', 'hooks', 'push-review-gate.sh');
}

function commitHookPath(dir: string): string {
  return path.join(dir, '.claude', 'hooks', 'commit-review-gate.sh');
}

function toolInput(command: string): string {
  return JSON.stringify({ tool_input: { command } });
}

interface ScratchRepo {
  dir: string;
  headSha: string;
  bareRemote: string;
}

/**
 * Create a scratch repo with a feature branch. The caller supplies which
 * files the feature commit touches — this controls whether the protected-
 * path matcher should fire.
 */
async function makeScratchRepo(opts: {
  /** Relative paths (from repo root) to write + stage on the feature commit. */
  featureFiles: Array<{ path: string; contents: string }>;
  /** Raw policy.yaml content. Defaults to a minimal codex_required:true policy. */
  policyContent?: string;
  /** Link `dist/` helpers so the hook can invoke rea CLI bits. */
  linkDist?: boolean;
}): Promise<ScratchRepo> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'rea-093-policy-bypass-')),
  );

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

  git('init', '--initial-branch=main', '--quiet');
  git('config', 'user.email', 'policy-bypass@example.test');
  git('config', 'user.name', 'REA 0.9.3 Test');
  git('config', 'commit.gpgsign', 'false');

  await fs.writeFile(path.join(dir, 'README.md'), '# scratch\n');
  git('add', 'README.md');
  git('commit', '-m', 'baseline', '--quiet');

  // Bare remote + push main so `refs/remotes/origin/main` exists — the gate's
  // new-branch merge-base resolution anchors on it.
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

  if (opts.linkDist !== false) {
    await fs.mkdir(path.join(dir, 'dist'), { recursive: true });
    for (const sub of ['audit', 'scripts', 'policy']) {
      await fs.symlink(
        path.join(REPO_ROOT, 'dist', sub),
        path.join(dir, 'dist', sub),
      );
    }
  }

  const policyContent = opts.policyContent ?? defaultPolicy(true);
  await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
  await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), policyContent);

  await installHooks(dir);

  return { dir, headSha, bareRemote };
}

function defaultPolicy(codexRequired: boolean): string {
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
    `  codex_required: ${codexRequired}`,
    '',
  ].join('\n');
}

interface HookResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runPushHook(
  repo: ScratchRepo,
  env: NodeJS.ProcessEnv = {},
  command = 'git push origin feature:main',
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

function runCommitHook(
  repo: ScratchRepo,
  env: NodeJS.ProcessEnv = {},
  command = 'git commit -m "x"',
): HookResult {
  const res = spawnSync('bash', [commitHookPath(repo.dir)], {
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

function jqExists(): boolean {
  const res = spawnSync('jq', ['--version'], { encoding: 'utf8' });
  return res.status === 0;
}

describe('push-review-gate — 0.9.3 Defect B (policy.yaml grep bypass removed)', () => {
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

  it('push_review: false in policy does NOT bypass the gate', async () => {
    if (!jqExists()) return;

    // Policy carries the deprecated bypass token AND a diff that touches a
    // protected path (`hooks/`). Pre-0.9.3 the grep short-circuit would exit
    // 0 before protected-path detection. Post-fix: the gate runs and blocks.
    const policy = [
      defaultPolicy(true).trim(),
      'quality_gates:',
      '  push_review: false',
      '',
    ].join('\n');

    const repo = await makeScratchRepo({
      featureFiles: [
        {
          path: 'hooks/__test__.sh',
          contents: '#!/bin/bash\necho protected\n',
        },
      ],
      policyContent: policy,
    });
    track(repo);

    const res = runPushHook(repo);

    // The bypass is gone → the Codex-required gate fires on a protected-path
    // diff with no codex.review audit entry. Status 2, stderr carries the
    // protected-path banner.
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/protected paths changed/);
    expect(res.stderr).toMatch(/codex-review required/);
  });

  it('commit_review: false in policy does NOT bypass the commit gate', async () => {
    if (!jqExists()) return;

    // Stage a >200-line diff so the triage score becomes `significant` and
    // the gate would normally block.
    const bigBlob = Array.from({ length: 250 }, (_, i) => `line ${i}`).join(
      '\n',
    );
    const policy = [
      defaultPolicy(true).trim(),
      'quality_gates:',
      '  commit_review: false',
      '',
    ].join('\n');

    const repo = await makeScratchRepo({
      featureFiles: [{ path: 'doc.md', contents: 'placeholder\n' }],
      policyContent: policy,
    });
    track(repo);

    // Stage a large new file ON TOP of the existing commit so the commit
    // gate sees a non-trivial cached diff.
    const fp = path.join(repo.dir, 'big.txt');
    await fs.writeFile(fp, bigBlob + '\n');
    execFileSync('git', ['add', 'big.txt'], { cwd: repo.dir });

    const res = runCommitHook(repo);

    // Pre-0.9.3: grep matched `commit_review: false` → exit 0 silently.
    // Post-0.9.3: the gate runs through to the REVIEW REQUIRED branch.
    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/COMMIT REVIEW GATE/);
  });
});

describe('push-review-gate — 0.9.3 Defect C (protected-paths matcher extended)', () => {
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

  it('diff touching .rea/policy.yaml fires the Codex protected-path gate', async () => {
    if (!jqExists()) return;

    // A policy edit is the ultimate protected-path change — it controls the
    // gate itself. Before 0.9.3 the matcher missed it. After: `/codex-review`
    // is required.
    const repo = await makeScratchRepo({
      featureFiles: [
        {
          path: '.rea/dummy.yaml',
          contents: 'profile: altered\n',
        },
      ],
    });
    track(repo);

    const res = runPushHook(repo);

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/protected paths changed/);
    expect(res.stderr).toMatch(/codex-review required/);
    // And the new error-message listing surfaces `.rea/`.
    expect(res.stderr).toMatch(/- \.rea\//);
  });

  it('diff touching .husky/pre-push fires the Codex protected-path gate', async () => {
    if (!jqExists()) return;

    const repo = await makeScratchRepo({
      featureFiles: [
        {
          path: '.husky/pre-push',
          contents: '#!/bin/sh\nexec bash rea-hook "$@"\n',
        },
      ],
    });
    track(repo);

    const res = runPushHook(repo);

    expect(res.status).toBe(2);
    expect(res.stderr).toMatch(/protected paths changed/);
    expect(res.stderr).toMatch(/codex-review required/);
    expect(res.stderr).toMatch(/- \.husky\//);
  });

  it('diff touching Projects/rea/ (bare `rea` segment, no leading dot, nested path) does NOT fire the gate', async () => {
    if (!jqExists()) return;

    // Anchor-guard: a drifted matcher like `^(rea/)` would still pass this
    // test because `Projects/rea/...` does not start with `rea/`. This case
    // specifically pins the `^` anchor against future drift that loosens it
    // to an unanchored `rea/` subpath match.
    const repo = await makeScratchRepo({
      featureFiles: [
        {
          path: 'Projects/rea/Bug Reports/note.md',
          contents: '# notes\n',
        },
      ],
    });
    track(repo);

    const res = runPushHook(repo);

    // The protected-path Codex gate must NOT fire. Other downstream gates
    // (generic REVIEW REQUIRED) may still block the push, but specifically
    // not the Codex-required banner.
    expect(res.stderr).not.toMatch(/protected paths changed/);
    expect(res.stderr).not.toMatch(/codex-review required/);
  });

  it('diff touching top-level rea/ (bare `rea` segment, no leading dot) does NOT fire the gate', async () => {
    if (!jqExists()) return;

    // Load-bearing `[.]` bracket-literal guard: if a future edit replaced
    // `[.]rea/` with bare `rea/`, the previous anchored-negative case
    // (`Projects/rea/...`) would still pass because it's nested under
    // `Projects/`. A root-level `rea/note.md` is the minimal input that
    // distinguishes `^(rea/)` from `^([.]rea/)`. If this test starts
    // failing, someone has dropped the literal dot.
    const repo = await makeScratchRepo({
      featureFiles: [
        {
          path: 'rea/note.md',
          contents: '# notes at project root\n',
        },
      ],
    });
    track(repo);

    const res = runPushHook(repo);

    expect(res.stderr).not.toMatch(/protected paths changed/);
    expect(res.stderr).not.toMatch(/codex-review required/);
  });
});

describe('push-review-gate — 0.9.3 dogfood mirror parity (Defect B+C)', () => {
  // The security hotfix edits both the canonical `hooks/` sources and the
  // `.claude/hooks/` dogfood mirrors under this repo. A future edit that
  // updates only one side silently ships a divergent install: the pre-push
  // hook installed in `.husky/pre-push` invokes the `.claude/hooks/` path,
  // not `hooks/`. Assert byte-identity so drift is caught by CI.
  it('hooks/commit-review-gate.sh and .claude/hooks/commit-review-gate.sh are byte-identical', async () => {
    const a = await fs.readFile(
      path.join(REPO_ROOT, 'hooks', 'commit-review-gate.sh'),
    );
    const b = await fs.readFile(
      path.join(REPO_ROOT, '.claude', 'hooks', 'commit-review-gate.sh'),
    );
    expect(b.equals(a)).toBe(true);
  });

  it('hooks/_lib/push-review-core.sh and .claude/hooks/_lib/push-review-core.sh are byte-identical', async () => {
    const a = await fs.readFile(
      path.join(REPO_ROOT, 'hooks', '_lib', 'push-review-core.sh'),
    );
    const b = await fs.readFile(
      path.join(REPO_ROOT, '.claude', 'hooks', '_lib', 'push-review-core.sh'),
    );
    expect(b.equals(a)).toBe(true);
  });
});
