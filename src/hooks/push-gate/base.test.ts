import { describe, expect, it } from 'vitest';
import { EMPTY_TREE_SHA, resolveBaseRef } from './base.js';
import type { GitExecutor } from './codex-runner.js';

function fakeGit(overrides: Partial<GitExecutor> = {}): GitExecutor {
  return {
    tryRevParse: () => '',
    trySymbolicRef: () => '',
    headSha: () => 'deadbeef',
    diffNames: () => [],
    revListCount: () => null,
    ...overrides,
  };
}

describe('resolveBaseRef', () => {
  it('returns explicit ref when provided', () => {
    const res = resolveBaseRef(fakeGit(), { explicit: 'origin/develop' });
    expect(res).toEqual({ ref: 'origin/develop', source: 'explicit' });
  });

  it('returns upstream when @{upstream} resolves', () => {
    const res = resolveBaseRef(
      fakeGit({
        tryRevParse: (args) => (args.includes('@{upstream}') ? 'origin/feature-base' : ''),
      }),
    );
    expect(res.ref).toBe('origin/feature-base');
    expect(res.source).toBe('upstream');
  });

  it('falls back to origin/HEAD symbolic ref when upstream absent', () => {
    const res = resolveBaseRef(
      fakeGit({
        trySymbolicRef: (ref) =>
          ref === 'refs/remotes/origin/HEAD' ? 'refs/remotes/origin/main' : '',
      }),
    );
    expect(res.ref).toBe('refs/remotes/origin/main');
    expect(res.source).toBe('origin-head');
  });

  it('probes origin/main explicitly when neither upstream nor origin/HEAD exist', () => {
    const res = resolveBaseRef(
      fakeGit({
        tryRevParse: (args) => {
          // Simulate `git rev-parse --verify --quiet refs/remotes/origin/main` success
          if (args.includes('refs/remotes/origin/main')) return 'some-sha';
          return '';
        },
      }),
    );
    expect(res.ref).toBe('refs/remotes/origin/main');
    expect(res.source).toBe('origin-main');
  });

  it('probes origin/master when origin/main missing', () => {
    const res = resolveBaseRef(
      fakeGit({
        tryRevParse: (args) => {
          if (args.includes('refs/remotes/origin/master')) return 'some-sha';
          return '';
        },
      }),
    );
    expect(res.ref).toBe('refs/remotes/origin/master');
    expect(res.source).toBe('origin-master');
  });

  it('falls back to local main when no remote-tracking refs exist', () => {
    const res = resolveBaseRef(
      fakeGit({
        tryRevParse: (args) => {
          if (args.includes('refs/heads/main')) return 'some-sha';
          return '';
        },
      }),
    );
    expect(res.ref).toBe('refs/heads/main');
    expect(res.source).toBe('local-main');
  });

  it('returns the empty-tree sentinel when nothing else resolves', () => {
    const res = resolveBaseRef(fakeGit());
    expect(res.ref).toBe(EMPTY_TREE_SHA);
    expect(res.source).toBe('empty-tree');
  });
});

describe('resolveBaseRef — last-n-commits (Fix D / 0.12.0)', () => {
  it('resolves to a SHA via `git rev-parse HEAD~N` when lastNCommits is set (default headRef)', () => {
    const res = resolveBaseRef(
      fakeGit({
        tryRevParse: (args) => {
          if (args.some((a) => a === 'HEAD~3^{commit}')) {
            return 'cafefeed1234567890abcdef1234567890abcdef';
          }
          return '';
        },
      }),
      { lastNCommits: 3 },
    );
    expect(res.ref).toBe('cafefeed1234567890abcdef1234567890abcdef');
    expect(res.source).toBe('last-n-commits');
    expect(res.lastNCommits).toBe(3);
  });

  it('walks back from the explicit headRef when provided (pushed-ref correctness)', () => {
    const seen: string[][] = [];
    const res = resolveBaseRef(
      fakeGit({
        tryRevParse: (args) => {
          seen.push(args);
          if (args.some((a) => a === 'beefcafe1234567890abcdef1234567890abcdef~2^{commit}')) {
            return '0123456789abcdef0123456789abcdef01234567';
          }
          return '';
        },
      }),
      {
        lastNCommits: 2,
        headRef: 'beefcafe1234567890abcdef1234567890abcdef',
      },
    );
    expect(res.ref).toBe('0123456789abcdef0123456789abcdef01234567');
    expect(res.source).toBe('last-n-commits');
    // The probe should have used the pushed ref, not literal HEAD.
    const probed = seen.find((a) =>
      a.some((x) => x.includes('beefcafe1234567890abcdef1234567890abcdef~2')),
    );
    expect(probed).toBeDefined();
  });

  it('full clone, branch shorter than N: clamps to empty-tree and reviews K+1 commits (root commit included)', () => {
    // Full clone (`--is-shallow-repository` returns "false"); branch is
    // 12 commits deep; operator asked for last 50. The deepest
    // resolvable ancestor (HEAD~12) IS the root — diffing against it
    // would silently EXCLUDE the root commit's changes
    // (`git diff base..HEAD` excludes `base`). The resolver returns
    // EMPTY_TREE_SHA so all 13 commits are reviewed (12 ancestors plus
    // the root). Codex [P1] 2026-04-29 (first finding).
    const reachableDepths = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const probed: number[] = [];
    const res = resolveBaseRef(
      fakeGit({
        tryRevParse: (args) => {
          if (args.includes('--is-shallow-repository')) return 'false';
          for (const a of args) {
            const m = /^HEAD~(\d+)\^\{commit\}$/.exec(a);
            if (m !== null) {
              const depth = Number(m[1]);
              probed.push(depth);
              if (reachableDepths.has(depth)) {
                return `cafe${depth.toString(16).padStart(36, '0')}`;
              }
              return '';
            }
          }
          return '';
        },
      }),
      { lastNCommits: 50 },
    );
    expect(res.source).toBe('last-n-commits');
    expect(res.ref).toBe(EMPTY_TREE_SHA);
    expect(res.lastNCommits).toBe(13);
    expect(res.lastNCommitsRequested).toBe(50);
    // Sanity: the binary search probed at most ~log2(50) depths plus the
    // initial direct probe and the `~1` boundary check.
    expect(probed.length).toBeLessThan(20);
  });

  it('shallow clone, depth shorter than N: clamps to ~K SHA (NOT empty-tree) so the review does not balloon to every tracked file', () => {
    // Shallow clone (`--is-shallow-repository` returns "true"); only 5
    // commits are locally available; operator asked for last 50. We
    // MUST diff against `<headRef>~5` (a real SHA), NOT EMPTY_TREE_SHA
    // — using empty-tree here would make the review include every
    // tracked file in the checkout (the entire base-branch snapshot),
    // defeating the narrowing the operator asked for. Codex [P1]
    // 2026-04-29 (second finding).
    const reachableDepths = new Set([1, 2, 3, 4, 5]);
    const res = resolveBaseRef(
      fakeGit({
        tryRevParse: (args) => {
          if (args.includes('--is-shallow-repository')) return 'true';
          for (const a of args) {
            const m = /^HEAD~(\d+)\^\{commit\}$/.exec(a);
            if (m !== null) {
              const depth = Number(m[1]);
              if (reachableDepths.has(depth)) {
                return `cafe${depth.toString(16).padStart(36, '0')}`;
              }
              return '';
            }
          }
          return '';
        },
      }),
      { lastNCommits: 50 },
    );
    expect(res.source).toBe('last-n-commits');
    expect(res.ref).toBe(`cafe${(5).toString(16).padStart(36, '0')}`);
    expect(res.ref).not.toBe(EMPTY_TREE_SHA);
    expect(res.lastNCommits).toBe(5);
    expect(res.lastNCommitsRequested).toBe(50);
  });

  it('falls back to empty-tree with lastNCommits=1 when even HEAD~1 is unreachable (single-commit history)', () => {
    const res = resolveBaseRef(
      fakeGit({
        tryRevParse: () => '', // every probe fails — single-commit branch
      }),
      { lastNCommits: 50 },
    );
    expect(res.ref).toBe(EMPTY_TREE_SHA);
    expect(res.source).toBe('empty-tree');
    expect(res.lastNCommits).toBe(1);
    expect(res.lastNCommitsRequested).toBe(50);
  });

  it('explicit ref wins over lastNCommits (precedence)', () => {
    const res = resolveBaseRef(fakeGit(), {
      explicit: 'origin/release-1.0',
      lastNCommits: 3,
    });
    expect(res.ref).toBe('origin/release-1.0');
    expect(res.source).toBe('explicit');
  });

  it('lastNCommits=0 is treated as unset (falls through to ladder)', () => {
    const res = resolveBaseRef(
      fakeGit({
        tryRevParse: (args) => (args.includes('@{upstream}') ? 'origin/feature-base' : ''),
      }),
      { lastNCommits: 0 },
    );
    expect(res.source).toBe('upstream');
  });
});
