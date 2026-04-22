/**
 * Unit tests for `diff.ts`. Uses a recording GitRunner stub to assert both
 * the commands issued and the translated return shape — no real git repo
 * is touched.
 *
 * The `spawnGit` production runner is NOT unit-tested here (that would
 * require a real git install + repo, which belongs in the Phase 3
 * integration suites). What we test is that every wrapper passes the
 * expected argv array, handles the `status !== 0` branch correctly, and
 * validates the output shape (SHA regex, number parsing, trimmed output).
 */

import { describe, expect, it } from 'vitest';
import {
  currentBranch,
  diffNameStatus,
  fullDiff,
  gitCommonDir,
  hasCommitLocally,
  mergeBase,
  readGitActor,
  readGitConfig,
  refExists,
  resolveHead,
  resolveRefToSha,
  resolveRemoteDefaultRef,
  resolveUpstream,
  revListCount,
  spawnGit,
  type GitRunResult,
  type GitRunner,
} from './diff.js';

/**
 * Build a deterministic runner from a (argv -> result) map. The map's
 * keys are joined argv strings for readability; unexpected calls throw so
 * tests catch unplanned git invocations loudly.
 */
function recordingRunner(table: Record<string, GitRunResult>): {
  runner: GitRunner;
  calls: readonly string[][];
} {
  const calls: string[][] = [];
  const runner: GitRunner = (args, _cwd) => {
    calls.push([...args]);
    const key = args.join(' ');
    const value = table[key];
    if (value === undefined) {
      throw new Error(`unexpected git invocation in test: git ${key}`);
    }
    return value;
  };
  return { runner, calls };
}

const OK = (stdout: string, stderr = ''): GitRunResult => ({ status: 0, stdout, stderr });
const FAIL = (stderr = 'boom'): GitRunResult => ({ status: 128, stdout: '', stderr });

const VALID_SHA = '0123456789abcdef0123456789abcdef01234567';
const ANOTHER_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

describe('currentBranch', () => {
  it('returns git branch --show-current output when git succeeds', () => {
    const { runner } = recordingRunner({
      'branch --show-current': OK('feat/foo'),
    });
    expect(currentBranch(runner, '/repo')).toBe('feat/foo');
  });

  it('returns an empty string on git failure (detached HEAD / error)', () => {
    const { runner } = recordingRunner({
      'branch --show-current': FAIL(),
    });
    expect(currentBranch(runner, '/repo')).toBe('');
  });
});

describe('resolveHead', () => {
  it('returns a valid SHA on success', () => {
    const { runner } = recordingRunner({
      'rev-parse HEAD': OK(VALID_SHA),
    });
    expect(resolveHead(runner, '/repo')).toBe(VALID_SHA);
  });

  it('returns empty string when git succeeds but output is malformed', () => {
    const { runner } = recordingRunner({
      'rev-parse HEAD': OK('not-a-sha'),
    });
    expect(resolveHead(runner, '/repo')).toBe('');
  });

  it('returns empty string on git failure', () => {
    const { runner } = recordingRunner({
      'rev-parse HEAD': FAIL(),
    });
    expect(resolveHead(runner, '/repo')).toBe('');
  });
});

describe('resolveRefToSha', () => {
  it('spawns rev-parse --verify <ref>^{commit} and returns SHA', () => {
    const { runner, calls } = recordingRunner({
      'rev-parse --verify feature/foo^{commit}': OK(VALID_SHA),
    });
    expect(resolveRefToSha(runner, '/repo', 'feature/foo')).toBe(VALID_SHA);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['rev-parse', '--verify', 'feature/foo^{commit}']);
  });

  it('returns null on git failure', () => {
    const { runner } = recordingRunner({
      'rev-parse --verify bad^{commit}': FAIL(),
    });
    expect(resolveRefToSha(runner, '/repo', 'bad')).toBeNull();
  });

  it('returns null on malformed SHA output', () => {
    const { runner } = recordingRunner({
      'rev-parse --verify feature/x^{commit}': OK('not-a-sha'),
    });
    expect(resolveRefToSha(runner, '/repo', 'feature/x')).toBeNull();
  });
});

describe('resolveUpstream', () => {
  it('returns the upstream short name on success', () => {
    const { runner } = recordingRunner({
      'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': OK('origin/main'),
    });
    expect(resolveUpstream(runner, '/repo')).toBe('origin/main');
  });

  it('returns null when there is no upstream', () => {
    const { runner } = recordingRunner({
      'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': FAIL(),
    });
    expect(resolveUpstream(runner, '/repo')).toBeNull();
  });

  it('returns null on empty stdout', () => {
    const { runner } = recordingRunner({
      'rev-parse --abbrev-ref --symbolic-full-name @{upstream}': OK(''),
    });
    expect(resolveUpstream(runner, '/repo')).toBeNull();
  });
});

describe('hasCommitLocally', () => {
  it('returns true when cat-file -e exits zero', () => {
    const { runner, calls } = recordingRunner({
      [`cat-file -e ${VALID_SHA}^{commit}`]: OK(''),
    });
    expect(hasCommitLocally(runner, '/repo', VALID_SHA)).toBe(true);
    expect(calls[0]).toEqual(['cat-file', '-e', `${VALID_SHA}^{commit}`]);
  });

  it('returns false when cat-file fails', () => {
    const { runner } = recordingRunner({
      [`cat-file -e ${VALID_SHA}^{commit}`]: FAIL(),
    });
    expect(hasCommitLocally(runner, '/repo', VALID_SHA)).toBe(false);
  });

  it('returns false without invoking git for a non-SHA input', () => {
    const { runner, calls } = recordingRunner({});
    expect(hasCommitLocally(runner, '/repo', 'not-a-sha')).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('mergeBase', () => {
  it('returns the merge-base SHA when git succeeds', () => {
    const { runner } = recordingRunner({
      [`merge-base ${VALID_SHA} ${ANOTHER_SHA}`]: OK(VALID_SHA),
    });
    expect(mergeBase(runner, '/repo', VALID_SHA, ANOTHER_SHA)).toBe(VALID_SHA);
  });

  it('returns null when git fails (unrelated histories)', () => {
    const { runner } = recordingRunner({
      [`merge-base ${VALID_SHA} ${ANOTHER_SHA}`]: FAIL(),
    });
    expect(mergeBase(runner, '/repo', VALID_SHA, ANOTHER_SHA)).toBeNull();
  });

  it('returns null when git succeeds with malformed SHA output', () => {
    const { runner } = recordingRunner({
      [`merge-base ${VALID_SHA} ${ANOTHER_SHA}`]: OK('junk'),
    });
    expect(mergeBase(runner, '/repo', VALID_SHA, ANOTHER_SHA)).toBeNull();
  });
});

describe('refExists', () => {
  it('returns true when rev-parse --verify --quiet exits zero', () => {
    const { runner } = recordingRunner({
      'rev-parse --verify --quiet refs/remotes/origin/main': OK(''),
    });
    expect(refExists(runner, '/repo', 'refs/remotes/origin/main')).toBe(true);
  });

  it('returns false when rev-parse --verify --quiet exits non-zero', () => {
    const { runner } = recordingRunner({
      'rev-parse --verify --quiet refs/heads/missing': FAIL(),
    });
    expect(refExists(runner, '/repo', 'refs/heads/missing')).toBe(false);
  });
});

describe('readGitConfig', () => {
  it('returns the value when the config key is set', () => {
    const { runner, calls } = recordingRunner({
      'config --get branch.feat.base': OK('dev'),
    });
    expect(readGitConfig(runner, '/repo', 'branch.feat.base')).toBe('dev');
    expect(calls[0]).toEqual(['config', '--get', 'branch.feat.base']);
  });

  it('returns empty string when the key is absent', () => {
    const { runner } = recordingRunner({
      'config --get branch.feat.base': FAIL(),
    });
    expect(readGitConfig(runner, '/repo', 'branch.feat.base')).toBe('');
  });
});

describe('resolveRemoteDefaultRef', () => {
  it('returns the symbolic-ref target when set', () => {
    const { runner } = recordingRunner({
      'symbolic-ref refs/remotes/origin/HEAD': OK('refs/remotes/origin/main'),
    });
    expect(resolveRemoteDefaultRef(runner, '/repo', 'origin')).toBe('refs/remotes/origin/main');
  });

  it('returns null when symbolic-ref is not set (shallow clones)', () => {
    const { runner } = recordingRunner({
      'symbolic-ref refs/remotes/origin/HEAD': FAIL(),
    });
    expect(resolveRemoteDefaultRef(runner, '/repo', 'origin')).toBeNull();
  });

  it('returns null on empty stdout', () => {
    const { runner } = recordingRunner({
      'symbolic-ref refs/remotes/origin/HEAD': OK(''),
    });
    expect(resolveRemoteDefaultRef(runner, '/repo', 'origin')).toBeNull();
  });

  it('uses the remote name in the ref path', () => {
    const { runner, calls } = recordingRunner({
      'symbolic-ref refs/remotes/upstream/HEAD': OK('refs/remotes/upstream/main'),
    });
    resolveRemoteDefaultRef(runner, '/repo', 'upstream');
    expect(calls[0]).toEqual(['symbolic-ref', 'refs/remotes/upstream/HEAD']);
  });
});

describe('fullDiff', () => {
  it('returns the full diff body on success', () => {
    const body = 'diff --git a/x b/x\n+foo\n';
    const { runner, calls } = recordingRunner({
      [`diff ${VALID_SHA}..${ANOTHER_SHA}`]: OK(body),
    });
    const r = fullDiff(runner, '/repo', VALID_SHA, ANOTHER_SHA);
    expect(r.status).toBe(0);
    expect(r.diff).toBe(body);
    // Two-dot, NEVER three-dot — see push-review-core.sh §1053-1060.
    expect(calls[0]).toEqual(['diff', `${VALID_SHA}..${ANOTHER_SHA}`]);
  });

  it('returns the error status + stderr on failure', () => {
    const { runner } = recordingRunner({
      [`diff ${VALID_SHA}..${ANOTHER_SHA}`]: { status: 129, stdout: '', stderr: 'fatal' },
    });
    const r = fullDiff(runner, '/repo', VALID_SHA, ANOTHER_SHA);
    expect(r.status).toBe(129);
    expect(r.stderr).toBe('fatal');
  });

  it('preserves an empty diff on a same-ref push', () => {
    const { runner } = recordingRunner({
      [`diff ${VALID_SHA}..${VALID_SHA}`]: OK(''),
    });
    const r = fullDiff(runner, '/repo', VALID_SHA, VALID_SHA);
    expect(r.status).toBe(0);
    expect(r.diff).toBe('');
  });
});

describe('diffNameStatus', () => {
  it('returns the name-status body on success', () => {
    const body = 'M\tsrc/a.ts\nA\tnewfile.ts\n';
    const { runner, calls } = recordingRunner({
      [`diff --name-status ${VALID_SHA}..${ANOTHER_SHA}`]: OK(body),
    });
    const r = diffNameStatus(runner, '/repo', VALID_SHA, ANOTHER_SHA);
    expect(r.status).toBe(0);
    expect(r.output).toBe(body);
    expect(calls[0]).toEqual(['diff', '--name-status', `${VALID_SHA}..${ANOTHER_SHA}`]);
  });

  it('returns the error status + stderr on failure', () => {
    const { runner } = recordingRunner({
      [`diff --name-status ${VALID_SHA}..${ANOTHER_SHA}`]: { status: 1, stdout: '', stderr: 'oops' },
    });
    const r = diffNameStatus(runner, '/repo', VALID_SHA, ANOTHER_SHA);
    expect(r.status).toBe(1);
    expect(r.stderr).toBe('oops');
  });
});

describe('revListCount', () => {
  it('returns the parsed commit count on success', () => {
    const { runner } = recordingRunner({
      [`rev-list --count ${VALID_SHA}..${ANOTHER_SHA}`]: OK('7'),
    });
    expect(revListCount(runner, '/repo', VALID_SHA, ANOTHER_SHA)).toBe(7);
  });

  it('returns 0 when stdout is empty (same-ref push)', () => {
    const { runner } = recordingRunner({
      [`rev-list --count ${VALID_SHA}..${ANOTHER_SHA}`]: OK(''),
    });
    expect(revListCount(runner, '/repo', VALID_SHA, ANOTHER_SHA)).toBe(0);
  });

  it('returns -1 on git failure', () => {
    const { runner } = recordingRunner({
      [`rev-list --count ${VALID_SHA}..${ANOTHER_SHA}`]: FAIL(),
    });
    expect(revListCount(runner, '/repo', VALID_SHA, ANOTHER_SHA)).toBe(-1);
  });

  it('returns 0 on non-numeric stdout', () => {
    const { runner } = recordingRunner({
      [`rev-list --count ${VALID_SHA}..${ANOTHER_SHA}`]: OK('not a number'),
    });
    expect(revListCount(runner, '/repo', VALID_SHA, ANOTHER_SHA)).toBe(0);
  });
});

describe('gitCommonDir', () => {
  it('returns the absolute common-dir when in a repo', () => {
    const { runner } = recordingRunner({
      'rev-parse --path-format=absolute --git-common-dir': OK('/repo/.git'),
    });
    expect(gitCommonDir(runner, '/repo')).toBe('/repo/.git');
  });

  it('returns null outside a git repo', () => {
    const { runner } = recordingRunner({
      'rev-parse --path-format=absolute --git-common-dir': FAIL(),
    });
    expect(gitCommonDir(runner, '/not-a-repo')).toBeNull();
  });

  it('returns null on empty stdout', () => {
    const { runner } = recordingRunner({
      'rev-parse --path-format=absolute --git-common-dir': OK(''),
    });
    expect(gitCommonDir(runner, '/repo')).toBeNull();
  });
});

describe('spawnGit — production runner smoke test', () => {
  // The production runner forks real `git`. These tests exercise the wiring
  // (stdout/stderr capture, status translation, cwd) using git subcommands
  // that are idempotent and read-only. We do NOT simulate a full repo here
  // — deeper integration tests against `git diff`, etc. live in Phase 3.

  it('returns status=0 and version output for `git --version`', () => {
    const r = spawnGit(['--version'], process.cwd());
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^git version /);
    expect(r.stderr).toBe('');
  });

  it('trims trailing newlines from stdout (bash $() parity)', () => {
    const r = spawnGit(['--version'], process.cwd());
    // `git --version` always prints a single trailing newline — we must
    // have stripped it to match the bash `$(...)` shape.
    expect(r.stdout.endsWith('\n')).toBe(false);
  });

  it('returns non-zero status for an unknown subcommand and captures stderr', () => {
    const r = spawnGit(['this-is-not-a-real-git-subcommand'], process.cwd());
    expect(r.status).not.toBe(0);
    // Git prints an error message to stderr for unknown subcommands.
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  it('runs in the provided cwd (git --git-dir-style observation)', () => {
    // Running `git rev-parse --is-inside-work-tree` from cwd == repo root
    // returns "true"; from a non-repo tmpdir it returns non-zero.
    const inRepo = spawnGit(['rev-parse', '--is-inside-work-tree'], process.cwd());
    expect(inRepo.status).toBe(0);
    expect(inRepo.stdout).toBe('true');
  });
});

describe('readGitActor', () => {
  it('returns user.email when set', () => {
    const { runner } = recordingRunner({
      'config --get user.email': OK('jake@example.com'),
    });
    expect(readGitActor(runner, '/repo')).toBe('jake@example.com');
  });

  it('falls back to user.name when email is unset', () => {
    const { runner } = recordingRunner({
      'config --get user.email': FAIL(),
      'config --get user.name': OK('Jake'),
    });
    expect(readGitActor(runner, '/repo')).toBe('Jake');
  });

  it('returns empty string when both are unset', () => {
    const { runner } = recordingRunner({
      'config --get user.email': FAIL(),
      'config --get user.name': FAIL(),
    });
    expect(readGitActor(runner, '/repo')).toBe('');
  });
});
