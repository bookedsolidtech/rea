/**
 * T-PATH-01..06 — path-guard (PRIMARY control, fail-closed) — AC-5.
 *
 * Every test asserts the path-guard REFUSES the external lane for sensitive
 * paths (decision: 'refuse'), and that the matcher is fail-closed on
 * uncertainty. The `evaluatePathGuard` enumerator is injected so no test
 * touches git or the network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluatePathGuard,
  matchesDoubleStarGlob,
  matchDoubleStarGlob,
  matchesLiteralBlockedPattern,
  realChangedPaths,
  committedDiffArgs,
  isUnbornHead,
  EVIDENTIARY_REFUSE_GLOBS,
  type ChangedPathsEnumerator,
} from './review-pathguard.js';
import { matchesBlockedPattern } from '../gateway/middleware/blocked-paths.js';
import { assembleDiff } from './review-openrouter.js';
import { EMPTY_TREE_SHA } from '../audit/content-token.js';

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir !== undefined) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

/** A real temp dir so realpath checks resolve to a true root. */
function makeRepo(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-pg-'));
  return tmpDir;
}

function enumerator(paths: string[]): ChangedPathsEnumerator {
  return () => ({ paths, errored: false });
}

describe('matchesDoubleStarGlob — evidentiary globs', () => {
  it('strawn-legal/** matches nested paths but NOT a similarly-named sibling', () => {
    expect(matchesDoubleStarGlob('strawn-legal/a/b/c.txt', 'strawn-legal/**')).toBe(true);
    expect(matchesDoubleStarGlob('strawn-legal/x', 'strawn-legal/**')).toBe(true);
    // The hard discriminator from the contract:
    expect(matchesDoubleStarGlob('strawnlegal-notes/x', 'strawn-legal/**')).toBe(false);
    expect(matchesDoubleStarGlob('other/strawn-legal/x', 'strawn-legal/**')).toBe(false);
  });

  it('**/*.secret.* matches secret files at any depth', () => {
    const g = EVIDENTIARY_REFUSE_GLOBS.find((e) => e.rule === 'evidentiary:secret-file')!.glob;
    expect(matchesDoubleStarGlob('config.secret.json', g)).toBe(true);
    expect(matchesDoubleStarGlob('a/b/db.secret.yaml', g)).toBe(true);
    expect(matchesDoubleStarGlob('a/b/normal.json', g)).toBe(false);
  });

  it('FIX M (round-8): dir/** matches the bare directory ROOT (symlink-to-root bypass)', () => {
    // The codex round-8 P1: a symlink whose realpath IS `strawn-legal` (the dir
    // root, no trailing segment) slipped the guard because `strawn-legal/**`
    // did not match the bare root. It must now match BOTH root and descendants.
    expect(matchesDoubleStarGlob('strawn-legal', 'strawn-legal/**')).toBe(true);
    expect(matchDoubleStarGlob('strawn-legal', 'strawn-legal/**')).toBe('match');
    // …without losing descendant matching or over-matching a sibling.
    expect(matchesDoubleStarGlob('strawn-legal/sub/file.txt', 'strawn-legal/**')).toBe(true);
    expect(matchesDoubleStarGlob('strawn-legal-notes', 'strawn-legal/**')).toBe(false);
    // Same property for any `dir/**` refuse pattern (e.g. an `.rea/`-style root).
    expect(matchesDoubleStarGlob('.rea', '.rea/**')).toBe(true);
    expect(matchesDoubleStarGlob('.reabackup', '.rea/**')).toBe(false);
  });
});

describe('evaluatePathGuard (AC-5) — sensitive paths refuse external lane', () => {
  it('T-PATH-01: strawn-legal/* → refuse, no send', () => {
    const r = evaluatePathGuard({
      baseDir: makeRepo(),
      baseRef: 'origin/main',
      blockedPaths: [],
      pathOverrides: [],
      enumerate: enumerator(['strawn-legal/contract.md']),
    });
    expect(r.decision).toBe('refuse');
    expect(r.refusalClass).toBe('path-guard');
    expect(r.matchedRule).toContain('strawn-legal');
  });

  it('T-PATH-01b (FIX M): a path resolving to the strawn-legal ROOT refuses external', () => {
    // The symlink-to-root bypass at the guard level: a changed path that is
    // exactly the evidentiary dir root (no trailing segment) must refuse.
    const r = evaluatePathGuard({
      baseDir: makeRepo(),
      baseRef: 'origin/main',
      blockedPaths: [],
      pathOverrides: [],
      enumerate: enumerator(['strawn-legal']),
    });
    expect(r.decision).toBe('refuse');
    expect(r.matchedRule).toContain('strawn-legal');
  });

  it('T-PATH-02: **/*.secret.* → refuse', () => {
    const r = evaluatePathGuard({
      baseDir: makeRepo(),
      baseRef: 'origin/main',
      blockedPaths: [],
      pathOverrides: [],
      enumerate: enumerator(['src/config.secret.json']),
    });
    expect(r.decision).toBe('refuse');
    expect(r.matchedRule).toContain('secret');
  });

  it('T-PATH-03: a blocked_paths entry → refuse', () => {
    const r = evaluatePathGuard({
      baseDir: makeRepo(),
      baseRef: 'origin/main',
      blockedPaths: ['.env'],
      pathOverrides: [],
      enumerate: enumerator(['.env']),
    });
    expect(r.decision).toBe('refuse');
    expect(r.refusalClass).toBe('path-guard');
    expect(r.matchedRule).toContain('blocked_paths');
  });

  it('T-PATH-03b (codex round-2 P1): a DOT-ANCHORED MULTI-SEGMENT blocked_paths entry refuses', () => {
    // matchesBlockedPattern bails on dot-anchored multi-segment patterns, so
    // this repo's own `.github/workflows/release.yml` (and `.rea/HALT`) would
    // otherwise be uploaded to the external lane. The guard must refuse.
    for (const p of ['.github/workflows/release.yml', '.rea/HALT']) {
      const r = evaluatePathGuard({
        baseDir: makeRepo(),
        baseRef: 'origin/main',
        blockedPaths: ['.env', '.env.*', '.rea/HALT', '.github/workflows/release.yml'],
        pathOverrides: [],
        enumerate: enumerator([p]),
      });
      expect(r.decision, `${p} must refuse external`).toBe('refuse');
      expect(r.matchedRule).toContain('blocked_paths');
    }
  });

  it('T-PATH-03c: a non-blocked nested file under the same dirs still SENDS (no over-refusal)', () => {
    // The multi-segment fix must not over-refuse: a sibling file that is NOT a
    // blocked entry stays allowed.
    const r = evaluatePathGuard({
      baseDir: makeRepo(),
      baseRef: 'origin/main',
      blockedPaths: ['.github/workflows/release.yml'],
      pathOverrides: [],
      enumerate: enumerator(['.github/workflows/ci.yml']),
    });
    expect(r.decision).toBe('send');
  });

  it('T-PATH-08 (round-9): protected governance surfaces refuse the external lane', () => {
    // The guard must refuse the SAME protected-write set the rest of rea
    // enforces (settings-protection / protected-paths-bash-gate) — not just
    // blocked_paths + .rea/. Sending a hook/settings diff off-machine is the
    // exposure this closes.
    for (const p of [
      '.claude/settings.json',
      '.claude/settings.local.json',
      '.husky/pre-commit',
      '.claude/hooks/secret-scanner.sh',
    ]) {
      const r = evaluatePathGuard({
        baseDir: makeRepo(),
        baseRef: 'origin/main',
        blockedPaths: [],
        pathOverrides: [],
        enumerate: enumerator([p]),
      });
      expect(r.decision, `${p} must refuse external`).toBe('refuse');
      expect(r.matchedRule).toContain('protected-write');
    }
  });

  it('T-PATH-09 (round-9): a consumer protected_writes entry refuses external', () => {
    const r = evaluatePathGuard({
      baseDir: makeRepo(),
      baseRef: 'origin/main',
      blockedPaths: [],
      protectedWrites: ['ops/governance/'],
      pathOverrides: [],
      enumerate: enumerator(['ops/governance/policy.rego']),
    });
    expect(r.decision).toBe('refuse');
    expect(r.matchedRule).toContain('protected-write');
  });

  it('codex round-17 P2: protected_paths_relax UNPROTECTS a governance path → ALLOW external', () => {
    // A consumer that intentionally unprotects `.husky/` should be able to send
    // a `.husky/` change on the external lane, mirroring normal enforcement.
    const r = evaluatePathGuard({
      baseDir: makeRepo(),
      baseRef: 'origin/main',
      blockedPaths: [],
      protectedPathsRelax: ['.husky/'],
      pathOverrides: [],
      enumerate: enumerator(['.husky/pre-commit']),
    });
    expect(r.decision).toBe('send');
  });

  it('codex round-17 P2: kill-switch invariants are NEVER relaxable (still refuse)', () => {
    // Even if listed in protected_paths_relax, the trust-root invariants must
    // never egress.
    for (const p of ['.rea/policy.yaml', '.claude/settings.json']) {
      const r = evaluatePathGuard({
        baseDir: makeRepo(),
        baseRef: 'origin/main',
        blockedPaths: [],
        protectedPathsRelax: ['.rea/policy.yaml', '.claude/settings.json', '.rea/HALT'],
        pathOverrides: [],
        enumerate: enumerator([p]),
      });
      expect(r.decision, `${p} must STILL refuse`).toBe('refuse');
    }
  });

  it('T-PATH-10 (round-9): a normal source path still SENDS (governance set does not over-refuse)', () => {
    const r = evaluatePathGuard({
      baseDir: makeRepo(),
      baseRef: 'origin/main',
      blockedPaths: [],
      pathOverrides: [],
      enumerate: enumerator(['src/app.ts']),
    });
    expect(r.decision).toBe('send');
  });

  it('T-PATH-11 (round-10): a literal % in a git filename is NOT a URL escape → sends', () => {
    // `git diff --name-only -z` reports literal bytes; a `%` is just a char.
    // The old `hasMalformedEscape` / `hasDeepEncodedSeparator` gates rejected
    // these legit names as hostile encoding, making valid diffs unusable.
    for (const p of ['docs/50% complete.md', 'foo%2Fbar.txt', 'a/100%done.txt']) {
      const r = evaluatePathGuard({
        baseDir: makeRepo(),
        baseRef: 'origin/main',
        blockedPaths: [],
        pathOverrides: [],
        enumerate: enumerator([p]),
      });
      expect(r.decision, `${p} must send (literal filename, not URL-encoded)`).toBe('send');
    }
  });

  it('T-PATH-12 (round-10): an UPPERCASE-named symlink into strawn-legal still refuses (case-preserved FS probe)', () => {
    // Security side of the case-fix: the realpath probe must use git's exact
    // bytes. Lowercasing `Public` → `public` would miss the symlink on a
    // case-sensitive FS and EXFILTRATE strawn-legal. (On a case-insensitive
    // dev FS both spellings resolve, so this discriminates on case-sensitive CI;
    // it pins the intended secure behavior either way.)
    const repo = makeRepo();
    fs.mkdirSync(path.join(repo, 'strawn-legal'), { recursive: true });
    fs.symlinkSync('strawn-legal', path.join(repo, 'Public'));
    const r = evaluatePathGuard({
      baseDir: repo,
      baseRef: 'origin/main',
      blockedPaths: [],
      pathOverrides: [],
      enumerate: enumerator(['Public/contract.md']),
    });
    expect(r.decision).toBe('refuse');
    expect(r.matchedRule).toContain('strawn-legal');
  });

  it('round-13: matchesLiteralBlockedPattern AGREES with matchesBlockedPattern on the non-% corpus', () => {
    // The literal matcher only activates for %-bearing paths; on everything
    // else it must behave EXACTLY like the proven production matcher (no
    // over- or under-refusal divergence — a security invariant).
    const corpus: Array<[string, string]> = [
      ['.env', '.env'], ['config/.env', '.env'], ['.env.local', '.env.*'],
      ['.rea/x', '.rea/'], ['a/.rea/x', '.rea/'], ['.reafile', '.rea/'],
      ['.envfile', '.env'], ['UPPER/.ENV', '.env'], ['a/b/c.env', '.env'],
      ['package.json', 'package.json'], ['src/package.json', 'package.json'],
      ['x/.env.local', '.env.*'], ['.env', '.env.*'],
    ];
    for (const [v, p] of corpus) {
      expect(matchesLiteralBlockedPattern(v, p), `${p} vs ${v}`).toBe(matchesBlockedPattern(v, p));
    }
  });

  it('round-13: matchesLiteralBlockedPattern does NOT URL-decode %xx', () => {
    expect(matchesLiteralBlockedPattern('.rea%2Fnotes.md', '.rea/')).toBe(false); // not decoded into .rea/
    expect(matchesLiteralBlockedPattern('.rea/real', '.rea/')).toBe(true); // real dir still matches
  });

  it('T-PATH-13 (round-13): a literal %xx in a filename is NOT decoded into a protected path → sends', () => {
    for (const p of ['.rea%2Fnotes.md', '.claude%2Fsettings.json', 'docs/a%2Eb.md', '.husky%2Fhook']) {
      const r = evaluatePathGuard({
        baseDir: makeRepo(),
        baseRef: 'origin/main',
        blockedPaths: [],
        pathOverrides: [],
        enumerate: enumerator([p]),
      });
      expect(r.decision, `${p} is a literal name, must SEND`).toBe('send');
    }
  });

  it('T-PATH-13b (round-13): a REAL protected path still refuses (decode fix did not weaken protection)', () => {
    for (const p of ['.rea/x', '.claude/settings.json', '.husky/pre-commit']) {
      const r = evaluatePathGuard({
        baseDir: makeRepo(),
        baseRef: 'origin/main',
        blockedPaths: [],
        pathOverrides: [],
        enumerate: enumerator([p]),
      });
      expect(r.decision, `${p} must refuse`).toBe('refuse');
    }
  });

  it('.rea/ is always refused (trust root) even with empty blocked_paths', () => {
    const r = evaluatePathGuard({
      baseDir: makeRepo(),
      baseRef: 'origin/main',
      blockedPaths: [],
      pathOverrides: [],
      enumerate: enumerator(['.rea/policy.yaml']),
    });
    expect(r.decision).toBe('refuse');
  });

  it('T-PATH-04: each sensitive override glob refuses (table-driven)', () => {
    const globs = ['legal/**', 'private/**/*.key', 'vault/secrets'];
    for (const g of globs) {
      const sample =
        g === 'legal/**'
          ? 'legal/a.txt'
          : g === 'private/**/*.key'
            ? 'private/x/y.key'
            : 'vault/secrets';
      const r = evaluatePathGuard({
        baseDir: makeRepo(),
        baseRef: 'origin/main',
        blockedPaths: [],
        pathOverrides: [{ paths: [g], provider: 'codex' }],
        enumerate: enumerator([sample]),
      });
      expect(r.decision, `glob ${g}`).toBe('refuse');
      expect(r.refusalClass, `glob ${g}`).toBe('path-override');
      expect(r.fallbackLane, `glob ${g}`).toBe('codex');
    }
  });

  it('T-PATH-05: fail-closed on uncertain — traversal segment → refuse', () => {
    const r = evaluatePathGuard({
      baseDir: makeRepo(),
      baseRef: 'origin/main',
      blockedPaths: [],
      pathOverrides: [],
      enumerate: enumerator(['src/../../etc/passwd']),
    });
    expect(r.decision).toBe('refuse');
  });

  it('round-10: a literal %-containing name adjacent to .rea is NOT a lexical escape → sends', () => {
    // Pre-round-10 this refused via `hasMalformedEscape`. But `git diff -z`
    // reports LITERAL bytes — `.rea%ZZ/foo` is a file in a dir literally named
    // `.rea%ZZ`, which is NOT the protected `.rea/` (so it carries no sensitive
    // content). The real escape defense is the realpath check: a SYMLINK
    // evasion into `.rea`/strawn-legal is still caught (see T-PATH-12).
    const r = evaluatePathGuard({
      baseDir: makeRepo(),
      baseRef: 'origin/main',
      blockedPaths: [],
      pathOverrides: [],
      enumerate: enumerator(['.rea%ZZ/foo']),
    });
    expect(r.decision).toBe('send');
  });

  it('round-10: a real `.rea/` path STILL refuses (the literal-path change did not weaken .rea protection)', () => {
    const r = evaluatePathGuard({
      baseDir: makeRepo(),
      baseRef: 'origin/main',
      blockedPaths: [],
      pathOverrides: [],
      enumerate: enumerator(['.rea/policy.yaml']),
    });
    expect(r.decision).toBe('refuse');
    expect(r.matchedRule).toContain('.rea');
  });

  it('fail-closed: git enumeration error → refuse with git-enumeration-error', () => {
    const r = evaluatePathGuard({
      baseDir: makeRepo(),
      baseRef: 'origin/main',
      blockedPaths: [],
      pathOverrides: [],
      enumerate: () => ({ errored: true }),
    });
    expect(r.decision).toBe('refuse');
    expect(r.refusalClass).toBe('git-enumeration-error');
  });

  it('fail-closed: malformed path_override (empty paths) → refuse', () => {
    const r = evaluatePathGuard({
      baseDir: makeRepo(),
      baseRef: 'origin/main',
      blockedPaths: [],
      // an override the schema would reject, but we defend here too
      pathOverrides: [{ paths: [], provider: 'codex' }],
      enumerate: enumerator(['app.ts']),
    });
    expect(r.decision).toBe('refuse');
    expect(r.refusalClass).toBe('path-override');
  });

  it('T-PATH-06: strawn-legal is NON-OVERRIDABLE — refuses even with a downgrade override (evidentiary wins)', () => {
    // The hard invariant: the evidentiary refuse-set is checked BEFORE
    // path_overrides, so strawn-legal always refuses the external lane.
    // Round-14: `provider: 'openrouter'` was REMOVED from the override enum
    // (overrides only DOWNGRADE — codex/refuse), so an operator can no longer
    // even express "route strawn-legal to openrouter" (schema rejects it; see
    // the loader test). A `codex` downgrade override still resolves to refuse.
    const r = evaluatePathGuard({
      baseDir: makeRepo(),
      baseRef: 'origin/main',
      blockedPaths: [],
      pathOverrides: [{ paths: ['strawn-legal/**'], provider: 'codex' }],
      enumerate: enumerator(['strawn-legal/contract.md']),
    });
    expect(r.decision).toBe('refuse');
    expect(r.matchedRule).toContain('strawn-legal');
    // It matched the EVIDENTIARY rule, not the override.
    expect(r.refusalClass).toBe('path-guard');
  });

  it('a clean diff with no sensitive paths → send', () => {
    const r = evaluatePathGuard({
      baseDir: makeRepo(),
      baseRef: 'origin/main',
      blockedPaths: ['.env'],
      pathOverrides: [],
      enumerate: enumerator(['src/app.ts', 'README.md']),
    });
    expect(r.decision).toBe('send');
    expect(r.changedPathCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// FIX 1 (codex round-2) — guard set == assembleDiff sent set; no `.rea/` leak.
// ---------------------------------------------------------------------------

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

/** Parse the `b/<path>` headers out of a unified diff (TEST ONLY — the
 *  production guard NEVER parses diff text; this is just to prove the guard's
 *  path set equals what assembleDiff actually emitted). */
function pathsInDiffText(diff: string): Set<string> {
  const out = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    const m = /^\+\+\+ b\/(.+)$/.exec(line);
    if (m && m[1] !== undefined && m[1] !== '/dev/null') out.add(m[1]);
  }
  return out;
}

describe('FIX 1 — guard==diff invariant + `.rea/` never leaks', () => {
  let repo: string | undefined;
  afterEach(() => {
    if (repo !== undefined) {
      fs.rmSync(repo, { recursive: true, force: true });
      repo = undefined;
    }
  });
  function makeGitRepo(): string {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-pg-git-'));
    git(['init', '-q'], repo);
    git(['config', 'user.email', 'pg@test.test'], repo);
    git(['config', 'user.name', 'PG'], repo);
    git(['config', 'commit.gpgsign', 'false'], repo);
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1;\n');
    git(['add', 'app.ts'], repo);
    git(['commit', '-qm', 'baseline'], repo);
    return repo;
  }

  it('a TRACKED .rea/policy.yaml change IS in the guard set and REFUSES external', () => {
    const r = makeGitRepo();
    // Track a `.rea/` file and modify it → it must appear in the diff AND refuse.
    fs.mkdirSync(path.join(r, '.rea'), { recursive: true });
    fs.writeFileSync(path.join(r, '.rea', 'policy.yaml'), 'version: "1"\n');
    git(['add', '.rea/policy.yaml'], r);
    git(['commit', '-qm', 'add policy'], r);
    fs.appendFileSync(path.join(r, '.rea', 'policy.yaml'), 'changed: true\n');

    const enumerated = realChangedPaths(r, 'HEAD~1');
    expect(enumerated.errored).toBe(false);
    // The tracked .rea change IS enumerated (not silently dropped).
    expect(enumerated.paths).toContain('.rea/policy.yaml');

    const guard = evaluatePathGuard({
      baseDir: r,
      baseRef: 'HEAD~1',
      blockedPaths: [],
      pathOverrides: [],
    });
    // The external lane is REFUSED — the governance file never leaves the box.
    expect(guard.decision).toBe('refuse');
    expect(guard.refusalClass).toBe('path-guard');
    expect(guard.matchedRule).toContain('.rea/');
  });

  it('an UNTRACKED .rea/policy.yaml does NOT enter the guard set → NO false refusal', () => {
    const r = makeGitRepo();
    // Untracked .rea/ (the real-consumer case) + a tracked code change.
    fs.mkdirSync(path.join(r, '.rea'), { recursive: true });
    fs.writeFileSync(path.join(r, '.rea', 'policy.yaml'), 'version: "1"\n'); // untracked
    fs.appendFileSync(path.join(r, 'app.ts'), 'export const b = 2;\n'); // tracked change

    const enumerated = realChangedPaths(r, 'HEAD');
    expect(enumerated.errored).toBe(false);
    // Untracked .rea/ is NOT sent by assembleDiff → NOT enumerated.
    expect(enumerated.paths).not.toContain('.rea/policy.yaml');
    expect(enumerated.paths).toContain('app.ts');

    const guard = evaluatePathGuard({
      baseDir: r,
      baseRef: 'HEAD',
      blockedPaths: [],
      pathOverrides: [],
    });
    expect(guard.decision).toBe('send');
  });

  it('guard path set == assembleDiff sent set for a mixed diff', () => {
    const r = makeGitRepo();
    // Mixed: a tracked working-tree change + a tracked staged change + an
    // untracked file (which must NOT appear in either set).
    fs.appendFileSync(path.join(r, 'app.ts'), 'export const c = 3;\n');
    fs.writeFileSync(path.join(r, 'lib.ts'), 'export const d = 4;\n');
    git(['add', 'lib.ts'], r);
    fs.writeFileSync(path.join(r, 'untracked.ts'), 'export const u = 5;\n'); // untracked

    const guardPaths = new Set(realChangedPaths(r, 'HEAD').paths);
    const diffText = assembleDiff(r, 'HEAD');
    const sentPaths = pathsInDiffText(diffText);

    // The guard evaluated EXACTLY the paths the diff sent — no more, no less.
    expect(guardPaths).toEqual(sentPaths);
    // And untracked content is in NEITHER (it is never sent).
    expect(guardPaths.has('untracked.ts')).toBe(false);
    expect(sentPaths.has('untracked.ts')).toBe(false);
    expect(guardPaths.has('app.ts')).toBe(true);
    expect(guardPaths.has('lib.ts')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FIX B (codex round-3) — empty-tree base uses two-dot diff (no exit 128).
// ---------------------------------------------------------------------------

describe('FIX B — empty-tree base does not exit 128; guard==diff holds', () => {
  let r: string | undefined;
  afterEach(() => {
    if (r !== undefined) {
      fs.rmSync(r, { recursive: true, force: true });
      r = undefined;
    }
  });

  it('committedDiffArgs uses two-dot for empty-tree, three-dot for a commit base', () => {
    expect(committedDiffArgs(EMPTY_TREE_SHA)).toEqual([EMPTY_TREE_SHA, 'HEAD']);
    expect(committedDiffArgs('origin/main')).toEqual(['origin/main...HEAD']);
  });

  it('fresh repo (committed but no upstream/default) → base=EMPTY_TREE_SHA → realChangedPaths + assembleDiff succeed', () => {
    r = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-pg-et-'));
    git(['init', '-q'], r);
    git(['config', 'user.email', 'et@test.test'], r);
    git(['config', 'user.name', 'ET'], r);
    git(['config', 'commit.gpgsign', 'false'], r);
    // A committed file + a tracked working-tree change. No remote/upstream, so
    // resolveBaseRef would return EMPTY_TREE_SHA for this repo.
    fs.writeFileSync(path.join(r, 'app.ts'), 'export const a = 1;\n');
    git(['add', 'app.ts'], r);
    git(['commit', '-qm', 'baseline'], r);
    fs.writeFileSync(path.join(r, 'feature.ts'), 'export const f = 2;\n');
    git(['add', 'feature.ts'], r);
    git(['commit', '-qm', 'feature'], r);

    // Guard against the empty-tree base — MUST NOT exit 128 / error.
    const enumerated = realChangedPaths(r, EMPTY_TREE_SHA);
    expect(enumerated.errored).toBe(false);
    // Two-dot empty-tree...HEAD lists every committed file.
    expect(enumerated.paths).toContain('app.ts');
    expect(enumerated.paths).toContain('feature.ts');

    // assembleDiff against the empty-tree base also succeeds (non-empty diff).
    const diff = assembleDiff(r, EMPTY_TREE_SHA);
    expect(diff.length).toBeGreaterThan(0);
    expect(diff).toContain('feature.ts');
    expect(diff).toContain('app.ts');

    // The guard==diff invariant holds for the empty-tree case too.
    const guardPaths = new Set(enumerated.paths);
    const sentPaths = pathsInDiffText(diff);
    expect(guardPaths).toEqual(sentPaths);

    // The lane does NOT spuriously refuse — a clean fresh repo sends.
    const guard = evaluatePathGuard({
      baseDir: r,
      baseRef: EMPTY_TREE_SHA,
      blockedPaths: [],
      pathOverrides: [],
    });
    expect(guard.decision).toBe('send');
  });

  it('normal commit base still uses three-dot (regression: merge-base semantics)', () => {
    r = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-pg-3dot-'));
    git(['init', '-q'], r);
    git(['config', 'user.email', 't@t.test'], r);
    git(['config', 'user.name', 'T'], r);
    git(['config', 'commit.gpgsign', 'false'], r);
    fs.writeFileSync(path.join(r, 'app.ts'), 'export const a = 1;\n');
    git(['add', 'app.ts'], r);
    git(['commit', '-qm', 'baseline'], r);
    fs.appendFileSync(path.join(r, 'app.ts'), 'export const b = 2;\n');

    const enumerated = realChangedPaths(r, 'HEAD');
    expect(enumerated.errored).toBe(false);
    expect(enumerated.paths).toContain('app.ts');
    const diff = assembleDiff(r, 'HEAD');
    expect(new Set(enumerated.paths)).toEqual(pathsInDiffText(diff));
  });
});

// ---------------------------------------------------------------------------
// FIX D (codex round-3) — UNBORN HEAD (repo before its first commit).
// ---------------------------------------------------------------------------

describe('FIX D — unborn HEAD reviews the staged tree (parity with codex bootstrap)', () => {
  let r: string | undefined;
  afterEach(() => {
    if (r !== undefined) {
      fs.rmSync(r, { recursive: true, force: true });
      r = undefined;
    }
  });

  function makeInitRepo(): string {
    r = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-pg-unborn-'));
    git(['init', '-q'], r);
    git(['config', 'user.email', 'u@t.test'], r);
    git(['config', 'user.name', 'U'], r);
    git(['config', 'commit.gpgsign', 'false'], r);
    return r;
  }

  it('isUnbornHead distinguishes unborn / born / non-repo', () => {
    const repo = makeInitRepo();
    // Just `git init`, no commit → unborn.
    expect(isUnbornHead(repo)).toEqual({ unborn: true, errored: false });
    // After a commit → born.
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1;\n');
    git(['add', 'app.ts'], repo);
    git(['commit', '-qm', 'baseline'], repo);
    expect(isUnbornHead(repo)).toEqual({ unborn: false, errored: false });
    // A non-git directory → errored (real failure, fail closed).
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-nonrepo-'));
    try {
      expect(isUnbornHead(nonRepo)).toEqual({ unborn: false, errored: true });
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('unborn HEAD + staged files → realChangedPaths + assembleDiff succeed, return staged paths, guard==diff, sends', () => {
    const repo = makeInitRepo();
    // Stage files but DO NOT commit → unborn HEAD with a staged initial tree.
    fs.writeFileSync(path.join(repo, 'app.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'lib.ts'), 'export const b = 2;\n');
    git(['add', 'app.ts', 'lib.ts'], repo);

    // base resolves to EMPTY_TREE_SHA in this state, but the unborn-HEAD branch
    // ignores base and uses `git diff --cached`.
    const enumerated = realChangedPaths(repo, EMPTY_TREE_SHA);
    expect(enumerated.errored).toBe(false); // NOT a git error — no exit 128
    expect(enumerated.paths).toContain('app.ts');
    expect(enumerated.paths).toContain('lib.ts');

    const diff = assembleDiff(repo, EMPTY_TREE_SHA);
    expect(diff.length).toBeGreaterThan(0);
    expect(diff).toContain('app.ts');
    expect(diff).toContain('lib.ts');

    // guard==diff invariant holds in the unborn-HEAD case too.
    expect(new Set(enumerated.paths)).toEqual(pathsInDiffText(diff));

    // The lane does NOT spuriously refuse — a clean staged tree sends.
    const guard = evaluatePathGuard({
      baseDir: repo,
      baseRef: EMPTY_TREE_SHA,
      blockedPaths: [],
      pathOverrides: [],
    });
    expect(guard.decision).toBe('send');
  });

  it('truly empty repo (unborn HEAD, nothing staged) → empty set, no error, no refuse', () => {
    const repo = makeInitRepo();
    const enumerated = realChangedPaths(repo, EMPTY_TREE_SHA);
    expect(enumerated.errored).toBe(false);
    expect(enumerated.paths).toEqual([]);
    const diff = assembleDiff(repo, EMPTY_TREE_SHA);
    expect(diff).toBe('');
    const guard = evaluatePathGuard({
      baseDir: repo,
      baseRef: EMPTY_TREE_SHA,
      blockedPaths: [],
      pathOverrides: [],
    });
    // Empty changed-path set → nothing sensitive → send (an empty review).
    expect(guard.decision).toBe('send');
  });

  it('a real git failure (non-repo) still fails closed (errored → refuse)', () => {
    const nonRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-nonrepo2-'));
    try {
      const enumerated = realChangedPaths(nonRepo, EMPTY_TREE_SHA);
      expect(enumerated.errored).toBe(true);
      const guard = evaluatePathGuard({
        baseDir: nonRepo,
        baseRef: EMPTY_TREE_SHA,
        blockedPaths: [],
        pathOverrides: [],
      });
      expect(guard.decision).toBe('refuse');
      expect(guard.refusalClass).toBe('git-enumeration-error');
    } finally {
      fs.rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it('a STAGED .rea/ file under unborn HEAD still refuses external (trust root preserved)', () => {
    const repo = makeInitRepo();
    fs.mkdirSync(path.join(repo, '.rea'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.rea', 'policy.yaml'), 'version: "1"\n');
    git(['add', '.rea/policy.yaml'], repo);
    const enumerated = realChangedPaths(repo, EMPTY_TREE_SHA);
    expect(enumerated.errored).toBe(false);
    // A STAGED .rea/ change IS in scope (it would be sent) → must refuse.
    expect(enumerated.paths).toContain('.rea/policy.yaml');
    const guard = evaluatePathGuard({
      baseDir: repo,
      baseRef: EMPTY_TREE_SHA,
      blockedPaths: [],
      pathOverrides: [],
    });
    expect(guard.decision).toBe('refuse');
    expect(guard.matchedRule).toContain('.rea/');
  });
});

// ---------------------------------------------------------------------------
// FIX I (codex round-5) — external/textconv diff drivers are neutralized.
// ---------------------------------------------------------------------------

describe('FIX I — git diff content is the RAW patch, never an external/textconv helper', () => {
  let r: string | undefined;
  let prevEnv: string | undefined;
  let prevDiffOpts: string | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
    if (prevEnv === undefined) delete process.env.GIT_EXTERNAL_DIFF;
    else process.env.GIT_EXTERNAL_DIFF = prevEnv;
    if (prevDiffOpts === undefined) delete process.env.GIT_DIFF_OPTS;
    else process.env.GIT_DIFF_OPTS = prevDiffOpts;
    if (r !== undefined) {
      fs.rmSync(r, { recursive: true, force: true });
      r = undefined;
    }
  });

  function makeRepoWithChange(): string {
    r = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-pg-extdiff-'));
    git(['init', '-q'], r);
    git(['config', 'user.email', 'x@t.test'], r);
    git(['config', 'user.name', 'X'], r);
    git(['config', 'commit.gpgsign', 'false'], r);
    fs.writeFileSync(path.join(r, 'app.ts'), 'export const a = 1;\n');
    git(['add', 'app.ts'], r);
    git(['commit', '-qm', 'baseline'], r);
    fs.appendFileSync(path.join(r, 'app.ts'), 'export const b = 2;\n');
    return r;
  }

  it('GIT_EXTERNAL_DIFF set → helper is NOT invoked; assembleDiff returns the raw patch', () => {
    const repo = makeRepoWithChange();
    // An external-diff helper that, if invoked, emits a UNIQUE sentinel string
    // instead of the patch. We assert that sentinel is ABSENT from the output.
    const helper = path.join(repo, 'evil-ext-diff.sh');
    fs.writeFileSync(helper, '#!/bin/sh\necho "EXTERNAL_DIFF_SENTINEL_LEAK_9f3a"\n', { mode: 0o755 });
    prevEnv = process.env.GIT_EXTERNAL_DIFF;
    process.env.GIT_EXTERNAL_DIFF = helper;

    const diff = assembleDiff(repo, 'HEAD');
    // The helper's output never appears — `--no-ext-diff` + env scrub neutralized it.
    expect(diff).not.toContain('EXTERNAL_DIFF_SENTINEL_LEAK_9f3a');
    // The RAW patch is present (the actual line we added).
    expect(diff).toContain('export const b = 2;');
    expect(diff).toContain('app.ts');
  });

  it('diff.external configured → helper is NOT invoked; assembleDiff returns the raw patch', () => {
    const repo = makeRepoWithChange();
    const helper = path.join(repo, 'evil-cfg-diff.sh');
    fs.writeFileSync(helper, '#!/bin/sh\necho "CFG_DIFF_SENTINEL_LEAK_7b21"\n', { mode: 0o755 });
    // Configure diff.external in the repo's own config.
    git(['config', 'diff.external', helper], repo);

    const diff = assembleDiff(repo, 'HEAD');
    expect(diff).not.toContain('CFG_DIFF_SENTINEL_LEAK_7b21');
    expect(diff).toContain('export const b = 2;');
  });

  it('per-path textconv filter is NOT invoked; assembleDiff returns the raw patch', () => {
    const repo = makeRepoWithChange();
    // Configure a textconv filter for *.ts that, if invoked, replaces the file
    // content with a sentinel. `--no-textconv` must neutralize it.
    const helper = path.join(repo, 'evil-textconv.sh');
    fs.writeFileSync(helper, '#!/bin/sh\necho "TEXTCONV_SENTINEL_LEAK_4c8d"\n', { mode: 0o755 });
    git(['config', 'diff.evilconv.textconv', helper], repo);
    fs.writeFileSync(path.join(repo, '.gitattributes'), '*.ts diff=evilconv\n');
    git(['add', '.gitattributes'], repo);
    git(['commit', '-qm', 'attrs'], repo);
    // Re-create the working-tree change after committing attrs.
    fs.appendFileSync(path.join(repo, 'app.ts'), 'export const c = 3;\n');

    const diff = assembleDiff(repo, 'HEAD');
    expect(diff).not.toContain('TEXTCONV_SENTINEL_LEAK_4c8d');
    // The raw patch content is present.
    expect(diff).toContain('app.ts');
  });

  it('GIT_DIFF_OPTS is scrubbed from the spawned git env (defensive)', () => {
    const repo = makeRepoWithChange();
    // GIT_DIFF_OPTS could inject -U… etc.; we scrub it so the patch shape is
    // deterministic and not operator-env-controlled. Set a value that, if
    // honored, would change the output (a huge context); assert the diff still
    // produces the expected change line regardless.
    prevDiffOpts = process.env.GIT_DIFF_OPTS;
    process.env.GIT_DIFF_OPTS = '-U99999';
    const diff = assembleDiff(repo, 'HEAD');
    expect(diff).toContain('export const b = 2;');
  });
});

// ---------------------------------------------------------------------------
// STRUCTURAL FIX 2 (round-6) — non-ASCII / newline paths + glob compile fail.
// ---------------------------------------------------------------------------

describe('STRUCTURAL FIX 2 — guard sees REAL byte-exact paths (non-ASCII / newline)', () => {
  let r: string | undefined;
  afterEach(() => {
    if (r !== undefined) {
      fs.rmSync(r, { recursive: true, force: true });
      r = undefined;
    }
  });
  function makeRepo(): string {
    r = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-pg-utf8-'));
    git(['init', '-q'], r);
    git(['config', 'user.email', 'u@t.test'], r);
    git(['config', 'user.name', 'U'], r);
    git(['config', 'commit.gpgsign', 'false'], r);
    fs.writeFileSync(path.join(r, 'app.ts'), 'export const a = 1;\n');
    git(['add', 'app.ts'], r);
    git(['commit', '-qm', 'baseline'], r);
    return r;
  }

  it('a tracked NON-ASCII secret file matching the evidentiary glob → guard REFUSES', () => {
    const repo = makeRepo();
    // A non-ASCII directory + a `.secret.` file — matches the evidentiary glob.
    const dir = path.join(repo, 'crédentials');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'db.secret.env'), 'PASSWORD=x\n');
    git(['add', '-A'], repo);
    git(['commit', '-qm', 'add secret'], repo);
    // Modify it so it shows in the working-tree diff.
    fs.appendFileSync(path.join(dir, 'db.secret.env'), 'MORE=y\n');

    const enumerated = realChangedPaths(repo, 'HEAD');
    expect(enumerated.errored).toBe(false);
    // The REAL non-ASCII path is enumerated (not a quoted/escaped mangle).
    expect(enumerated.paths.some((p) => p.includes('crédentials'))).toBe(true);

    const guard = evaluatePathGuard({
      baseDir: repo,
      baseRef: 'HEAD',
      blockedPaths: [],
      pathOverrides: [],
    });
    expect(guard.decision).toBe('refuse');
    expect(guard.matchedRule).toContain('secret');
  });

  it('guard path set == assembleDiff sent set for a NON-ASCII path', () => {
    const repo = makeRepo();
    const dir = path.join(repo, 'naïve');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'café.ts'), 'export const x = 1;\n');
    git(['add', '-A'], repo);

    const guardPaths = new Set(realChangedPaths(repo, EMPTY_TREE_SHA).paths);
    const diff = assembleDiff(repo, EMPTY_TREE_SHA);
    // The diff header carries the real path (core.quotePath=false), so both
    // sides agree on the non-ASCII name.
    expect(guardPaths.has('naïve/café.ts')).toBe(true);
    expect(diff).toContain('naïve/café.ts');
  });

  it('a path containing a NEWLINE is split on NUL only (not on \\n) — both sides agree', () => {
    const repo = makeRepo();
    // A file name with an embedded newline (legal on POSIX).
    const weird = `we\nird.ts`;
    fs.writeFileSync(path.join(repo, weird), 'export const w = 1;\n');
    git(['add', '--', weird], repo);

    const paths = realChangedPaths(repo, EMPTY_TREE_SHA).paths;
    // The newline-containing path is ONE entry (NUL-split), not two.
    expect(paths).toContain(weird);
    expect(paths.includes('we')).toBe(false);
    expect(paths.includes('ird.ts')).toBe(false);
  });
});

describe('STRUCTURAL FIX 2 / P2-5 — glob compile failure is UNCERTAIN (fail-closed)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('matchDoubleStarGlob is tri-state: match / no-match / uncertain', () => {
    expect(matchDoubleStarGlob('a/b', 'a/**')).toBe('match');
    expect(matchDoubleStarGlob('x/y', 'a/**')).toBe('no-match');
    // Force a regex compile failure → 'uncertain'. The matcher's escaper is
    // robust against all input, so we make `new RegExp` throw to exercise the
    // documented fail-closed branch.
    const spy = vi.spyOn(global, 'RegExp').mockImplementation((() => {
      throw new SyntaxError('forced invalid regex');
    }) as never);
    expect(matchDoubleStarGlob('a/b', 'a/**')).toBe('uncertain');
    spy.mockRestore();
  });

  it('the path-guard refuses (fail-closed) when ANY glob match goes uncertain', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-pg-badglob-'));
    try {
      // Make RegExp construction throw so EVERY `**`-glob compile fails. The
      // FIRST glob the guard evaluates (the evidentiary set) then goes
      // UNCERTAIN, and the guard must REFUSE the external lane — never allow.
      // This pins the fail-CLOSED contract that P2-5 restored (the old bare
      // `false` would have let a clean path slip through to ALLOW).
      const spy = vi.spyOn(global, 'RegExp').mockImplementation((() => {
        throw new SyntaxError('forced invalid regex');
      }) as never);
      const r = evaluatePathGuard({
        baseDir: tmp,
        baseRef: 'origin/main',
        blockedPaths: [],
        pathOverrides: [{ paths: ['some-operator-glob/**'], provider: 'codex' }],
        enumerate: () => ({ paths: ['app.ts'], errored: false }),
      });
      spy.mockRestore();
      // A glob that cannot compile → UNCERTAIN ≡ refuse (NOT allow).
      expect(r.decision).toBe('refuse');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
