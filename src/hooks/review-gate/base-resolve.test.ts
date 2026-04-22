/**
 * Unit tests for `base-resolve.ts`.
 *
 * Uses a recording GitRunner stub (no real git repo). Covers each of the
 * four code paths from the module docstring + every branch of the
 * new-branch config walk.
 *
 * Scenario matrix:
 *
 *   A   tracked branch, clean merge-base
 *   A'  tracked branch, remote object not locally present (fetch needed)
 *   A'' tracked branch, merge-base fails (unrelated histories)
 *   B   new branch, branch.<src>.base → remote-tracking ref hit
 *   B'  new branch, branch.<src>.base → local-ref fallback + WARN
 *   B'' new branch, branch.<src>.base set but neither ref resolves → falls through
 *   C   new branch, no config, symbolic-ref resolves → origin/main
 *   C'  new branch, symbolic-ref fails, refs/remotes/<remote>/main probe hits
 *   C'' new branch, symbolic-ref fails, main probe fails, master probe hits
 *   D   bootstrap — nothing resolves → empty-tree anchor
 *
 *   Plus:
 *   - Deletion refspec → returns a no-op ok
 *   - Initial label computation (defect N carry-forward)
 */

import { describe, expect, it } from 'vitest';
import {
  computeInitialTargetLabel,
  resolveBaseForRefspec,
  resolveNewBranchBase,
  stripRefsHeadsOnly,
  stripRefsPrefix,
} from './base-resolve.js';
import type { GitRunResult, GitRunner } from './diff.js';
import type { RefspecRecord } from './args.js';
import { EMPTY_TREE_SHA, ZERO_SHA } from './constants.js';

/** Build a deterministic stub runner from an argv→result table. */
function stubRunner(table: Record<string, GitRunResult>): GitRunner {
  return (args, _cwd) => {
    const key = args.join(' ');
    const value = table[key];
    if (value === undefined) {
      // Return a generic failure for unexpected calls — the stub is
      // deliberately strict about required commands but we can't list
      // every git command each test might incidentally hit. Callers that
      // care about assertion-on-call-history use `recordingRunner` from
      // diff.test.ts directly.
      return { status: 128, stdout: '', stderr: `unstubbed: ${key}` };
    }
    return value;
  };
}

const OK = (stdout: string): GitRunResult => ({ status: 0, stdout, stderr: '' });
const FAIL = (): GitRunResult => ({ status: 128, stdout: '', stderr: '' });

const LOCAL_SHA = '1111111111111111111111111111111111111111';
const REMOTE_SHA = '2222222222222222222222222222222222222222';
const MERGE_BASE_SHA = '3333333333333333333333333333333333333333';

function trackedRefspec(overrides: Partial<RefspecRecord> = {}): RefspecRecord {
  return {
    local_sha: LOCAL_SHA,
    remote_sha: REMOTE_SHA,
    local_ref: 'refs/heads/feature/foo',
    remote_ref: 'refs/heads/feature/foo',
    source_is_head: false,
    is_deletion: false,
    ...overrides,
  };
}

function newBranchRefspec(overrides: Partial<RefspecRecord> = {}): RefspecRecord {
  return {
    local_sha: LOCAL_SHA,
    remote_sha: ZERO_SHA,
    local_ref: 'refs/heads/feature/foo',
    remote_ref: 'refs/heads/feature/foo',
    source_is_head: false,
    is_deletion: false,
    ...overrides,
  };
}

describe('stripRefsPrefix', () => {
  it('strips refs/heads/', () => {
    expect(stripRefsPrefix('refs/heads/feature/foo')).toBe('feature/foo');
  });
  it('strips refs/for/', () => {
    expect(stripRefsPrefix('refs/for/main')).toBe('main');
  });
  it('leaves bare refs untouched', () => {
    expect(stripRefsPrefix('main')).toBe('main');
    expect(stripRefsPrefix('HEAD')).toBe('HEAD');
  });
});

describe('stripRefsHeadsOnly (Codex Phase-2a P3 — bash-parity fix)', () => {
  it('strips refs/heads/', () => {
    expect(stripRefsHeadsOnly('refs/heads/feature/foo')).toBe('feature/foo');
  });
  it('leaves refs/for/ UNTOUCHED (unlike stripRefsPrefix)', () => {
    // The critical parity with push-review-core.sh §797: bash only strips
    // refs/heads/. A Gerrit push must NOT normalize to a bare branch name
    // that could accidentally match `branch.<name>.base` config.
    expect(stripRefsHeadsOnly('refs/for/main')).toBe('refs/for/main');
  });
  it('leaves refs/tags/ untouched', () => {
    expect(stripRefsHeadsOnly('refs/tags/v1.2.3')).toBe('refs/tags/v1.2.3');
  });
  it('leaves bare refs untouched', () => {
    expect(stripRefsHeadsOnly('main')).toBe('main');
    expect(stripRefsHeadsOnly('HEAD')).toBe('HEAD');
  });
});

describe('computeInitialTargetLabel', () => {
  it('returns the short name of the remote ref', () => {
    expect(computeInitialTargetLabel(trackedRefspec())).toBe('feature/foo');
  });
  it('defaults to main when remote_ref is empty (defensive)', () => {
    expect(computeInitialTargetLabel(trackedRefspec({ remote_ref: '' }))).toBe('main');
  });
  it('handles refs/for/ (gerrit-style)', () => {
    expect(computeInitialTargetLabel(trackedRefspec({ remote_ref: 'refs/for/main' }))).toBe(
      'main',
    );
  });
});

describe('resolveBaseForRefspec — deletion', () => {
  it('returns a no-op ok for a deletion refspec (caller owns policy)', () => {
    const record: RefspecRecord = {
      local_sha: ZERO_SHA,
      remote_sha: ZERO_SHA,
      local_ref: '(delete)',
      remote_ref: 'refs/heads/old',
      source_is_head: false,
      is_deletion: true,
    };
    const runner = stubRunner({});
    const r = resolveBaseForRefspec(record, { runner, cwd: '/repo', remote: 'origin' });
    expect(r.status).toBe('ok');
    expect(r.merge_base).toBeNull();
    expect(r.path).toBe('tracked');
    expect(r.target_label).toBe('old');
  });
});

describe('resolveBaseForRefspec — tracked branch (path A)', () => {
  it('resolves merge-base when remote object is present', () => {
    const runner = stubRunner({
      [`cat-file -e ${REMOTE_SHA}^{commit}`]: OK(''),
      [`merge-base ${REMOTE_SHA} ${LOCAL_SHA}`]: OK(MERGE_BASE_SHA),
    });
    const r = resolveBaseForRefspec(trackedRefspec(), {
      runner,
      cwd: '/repo',
      remote: 'origin',
    });
    expect(r.status).toBe('ok');
    expect(r.merge_base).toBe(MERGE_BASE_SHA);
    expect(r.path).toBe('tracked');
    expect(r.target_label).toBe('feature/foo');
  });

  it('returns remote_object_missing when cat-file fails (fetch needed)', () => {
    const runner = stubRunner({
      [`cat-file -e ${REMOTE_SHA}^{commit}`]: FAIL(),
    });
    const r = resolveBaseForRefspec(trackedRefspec(), {
      runner,
      cwd: '/repo',
      remote: 'origin',
    });
    expect(r.status).toBe('remote_object_missing');
    expect(r.merge_base).toBeNull();
    expect(r.remote_sha).toBe(REMOTE_SHA);
  });

  it('returns no_merge_base when merge-base fails (unrelated histories)', () => {
    const runner = stubRunner({
      [`cat-file -e ${REMOTE_SHA}^{commit}`]: OK(''),
      [`merge-base ${REMOTE_SHA} ${LOCAL_SHA}`]: FAIL(),
    });
    const r = resolveBaseForRefspec(trackedRefspec(), {
      runner,
      cwd: '/repo',
      remote: 'origin',
    });
    expect(r.status).toBe('no_merge_base');
    expect(r.merge_base).toBeNull();
  });
});

describe('resolveBaseForRefspec — new branch, branch.<src>.base config (path B)', () => {
  it('resolves via refs/remotes/<remote>/<configured> when it exists (B)', () => {
    const runner = stubRunner({
      'config --get branch.feature/foo.base': OK('dev'),
      'rev-parse --verify --quiet refs/remotes/origin/dev': OK(''),
      [`merge-base refs/remotes/origin/dev ${LOCAL_SHA}`]: OK(MERGE_BASE_SHA),
    });
    const r = resolveBaseForRefspec(newBranchRefspec(), {
      runner,
      cwd: '/repo',
      remote: 'origin',
    });
    expect(r.status).toBe('ok');
    expect(r.merge_base).toBe(MERGE_BASE_SHA);
    expect(r.path).toBe('new_branch_config');
    // Defect N: label promoted to the configured base's short name.
    expect(r.target_label).toBe('dev');
    expect(r.local_ref_fallback_warning).toBeUndefined();
  });

  it('falls back to refs/heads/<configured> + carries WARN (B-prime)', () => {
    const runner = stubRunner({
      'config --get branch.feature/foo.base': OK('dev'),
      'rev-parse --verify --quiet refs/remotes/origin/dev': FAIL(),
      'rev-parse --verify --quiet refs/heads/dev': OK(''),
      [`merge-base refs/heads/dev ${LOCAL_SHA}`]: OK(MERGE_BASE_SHA),
    });
    const r = resolveBaseForRefspec(newBranchRefspec(), {
      runner,
      cwd: '/repo',
      remote: 'origin',
    });
    expect(r.status).toBe('ok');
    expect(r.merge_base).toBe(MERGE_BASE_SHA);
    expect(r.path).toBe('new_branch_config');
    expect(r.target_label).toBe('dev');
    expect(r.local_ref_fallback_warning).toContain('branch.feature/foo.base=dev');
    expect(r.local_ref_fallback_warning).toContain('resolved to local ref');
    expect(r.local_ref_fallback_warning).toContain('origin/dev missing');
  });

  it('falls through to origin/HEAD when configured base resolves to no ref (B-prime-prime)', () => {
    const runner = stubRunner({
      'config --get branch.feature/foo.base': OK('nonexistent'),
      'rev-parse --verify --quiet refs/remotes/origin/nonexistent': FAIL(),
      'rev-parse --verify --quiet refs/heads/nonexistent': FAIL(),
      'symbolic-ref refs/remotes/origin/HEAD': OK('refs/remotes/origin/main'),
      [`merge-base refs/remotes/origin/main ${LOCAL_SHA}`]: OK(MERGE_BASE_SHA),
    });
    const r = resolveBaseForRefspec(newBranchRefspec(), {
      runner,
      cwd: '/repo',
      remote: 'origin',
    });
    expect(r.status).toBe('ok');
    expect(r.merge_base).toBe(MERGE_BASE_SHA);
    // Defect N: label stays at refspec target (config didn't actually
    // contribute the anchor ref).
    expect(r.target_label).toBe('feature/foo');
    expect(r.path).toBe('new_branch_origin_head');
  });

  it('anchors on empty-tree when configured base resolves but merge-base fails (grafted branch)', () => {
    const runner = stubRunner({
      'config --get branch.feature/foo.base': OK('dev'),
      'rev-parse --verify --quiet refs/remotes/origin/dev': OK(''),
      [`merge-base refs/remotes/origin/dev ${LOCAL_SHA}`]: FAIL(),
    });
    const r = resolveBaseForRefspec(newBranchRefspec(), {
      runner,
      cwd: '/repo',
      remote: 'origin',
    });
    expect(r.status).toBe('ok');
    expect(r.merge_base).toBe(EMPTY_TREE_SHA);
    expect(r.path).toBe('new_branch_config');
    expect(r.target_label).toBe('dev');
  });
});

describe('resolveBaseForRefspec — new branch, origin/HEAD (path C)', () => {
  it('resolves via symbolic-ref when no config is set', () => {
    const runner = stubRunner({
      'config --get branch.feature/foo.base': FAIL(),
      'symbolic-ref refs/remotes/origin/HEAD': OK('refs/remotes/origin/main'),
      [`merge-base refs/remotes/origin/main ${LOCAL_SHA}`]: OK(MERGE_BASE_SHA),
    });
    const r = resolveBaseForRefspec(newBranchRefspec(), {
      runner,
      cwd: '/repo',
      remote: 'origin',
    });
    expect(r.status).toBe('ok');
    expect(r.merge_base).toBe(MERGE_BASE_SHA);
    expect(r.path).toBe('new_branch_origin_head');
    expect(r.target_label).toBe('feature/foo');
  });

  it('probes refs/remotes/<remote>/main when symbolic-ref fails (C-prime)', () => {
    const runner = stubRunner({
      'config --get branch.feature/foo.base': FAIL(),
      'symbolic-ref refs/remotes/origin/HEAD': FAIL(),
      'rev-parse --verify --quiet refs/remotes/origin/main': OK(''),
      [`merge-base refs/remotes/origin/main ${LOCAL_SHA}`]: OK(MERGE_BASE_SHA),
    });
    const r = resolveBaseForRefspec(newBranchRefspec(), {
      runner,
      cwd: '/repo',
      remote: 'origin',
    });
    expect(r.status).toBe('ok');
    expect(r.path).toBe('new_branch_origin_head');
    expect(r.merge_base).toBe(MERGE_BASE_SHA);
  });

  it('probes master as a last resort when main is absent (C-prime-prime)', () => {
    const runner = stubRunner({
      'config --get branch.feature/foo.base': FAIL(),
      'symbolic-ref refs/remotes/origin/HEAD': FAIL(),
      'rev-parse --verify --quiet refs/remotes/origin/main': FAIL(),
      'rev-parse --verify --quiet refs/remotes/origin/master': OK(''),
      [`merge-base refs/remotes/origin/master ${LOCAL_SHA}`]: OK(MERGE_BASE_SHA),
    });
    const r = resolveBaseForRefspec(newBranchRefspec(), {
      runner,
      cwd: '/repo',
      remote: 'origin',
    });
    expect(r.path).toBe('new_branch_origin_head');
    expect(r.merge_base).toBe(MERGE_BASE_SHA);
  });

  it('respects the remote name (not hardcoded to origin)', () => {
    const runner = stubRunner({
      'config --get branch.feature/foo.base': FAIL(),
      'symbolic-ref refs/remotes/upstream/HEAD': OK('refs/remotes/upstream/main'),
      [`merge-base refs/remotes/upstream/main ${LOCAL_SHA}`]: OK(MERGE_BASE_SHA),
    });
    const r = resolveBaseForRefspec(newBranchRefspec(), {
      runner,
      cwd: '/repo',
      remote: 'upstream',
    });
    expect(r.path).toBe('new_branch_origin_head');
    expect(r.merge_base).toBe(MERGE_BASE_SHA);
  });
});

describe('resolveBaseForRefspec — bootstrap (path D)', () => {
  it('anchors on the empty-tree SHA when nothing resolves', () => {
    const runner = stubRunner({
      'config --get branch.feature/foo.base': FAIL(),
      'symbolic-ref refs/remotes/origin/HEAD': FAIL(),
      'rev-parse --verify --quiet refs/remotes/origin/main': FAIL(),
      'rev-parse --verify --quiet refs/remotes/origin/master': FAIL(),
    });
    const r = resolveBaseForRefspec(newBranchRefspec(), {
      runner,
      cwd: '/repo',
      remote: 'origin',
    });
    expect(r.status).toBe('ok');
    expect(r.merge_base).toBe(EMPTY_TREE_SHA);
    expect(r.path).toBe('bootstrap_empty_tree');
    expect(r.target_label).toBe('feature/foo');
  });
});

describe('resolveNewBranchBase — HEAD / empty source branch', () => {
  it('skips the config probe when source is HEAD (bare pushes)', () => {
    const runner = stubRunner({
      'symbolic-ref refs/remotes/origin/HEAD': OK('refs/remotes/origin/main'),
    });
    const r = resolveNewBranchBase('HEAD', { runner, cwd: '/repo', remote: 'origin' });
    // Note we explicitly did NOT stub `config --get branch.HEAD.base` — it
    // is never called, otherwise the stub would throw unstubbed errors
    // into our result. Getting a plain `origin_head` result means the
    // source=='HEAD' early-out fired correctly.
    expect(r.kind).toBe('origin_head');
  });

  it('skips the config probe on empty source branch', () => {
    const runner = stubRunner({
      'symbolic-ref refs/remotes/origin/HEAD': OK('refs/remotes/origin/main'),
    });
    const r = resolveNewBranchBase('', { runner, cwd: '/repo', remote: 'origin' });
    expect(r.kind).toBe('origin_head');
  });
});

describe('resolveBaseForRefspec — Gerrit-style refs/for/ (Codex Phase-2a P3)', () => {
  it('does NOT look up branch.<bare>.base when source is refs/for/main', () => {
    // Scenario: `git push origin HEAD:refs/for/main` from a Gerrit workflow.
    // `local_ref` is `refs/for/main`. Bash core strips only `refs/heads/`,
    // leaving the raw `refs/for/main` as the source-branch key — which
    // does not match any `branch.<name>.base` entry. A naive
    // normalization that also stripped `refs/for/` would look up
    // `branch.main.base` and potentially promote the wrong label.
    //
    // The fix: `stripRefsHeadsOnly` preserves `refs/for/main`, the
    // config probe returns empty, and we fall through to origin/HEAD.
    const runner = stubRunner({
      // Critical: `branch.main.base` is SET in the repo (e.g. because
      // the operator configured it for the real `main` branch). If we
      // incorrectly stripped refs/for/, we'd read this and promote.
      'config --get branch.main.base': OK('release'),
      // Expected lookup — bash-parity: `branch.refs/for/main.base` is
      // what we WOULD query if we looked at all. We don't — source
      // branch is the full ref, and the hyphen-rule for config keys
      // would refuse this regardless. Fall through to symbolic-ref.
      'config --get branch.refs/for/main.base': FAIL(),
      'symbolic-ref refs/remotes/origin/HEAD': OK('refs/remotes/origin/main'),
      [`merge-base refs/remotes/origin/main ${LOCAL_SHA}`]: OK(MERGE_BASE_SHA),
    });
    const r = resolveBaseForRefspec(
      newBranchRefspec({
        local_ref: 'refs/for/main',
        remote_ref: 'refs/for/main',
      }),
      { runner, cwd: '/repo', remote: 'origin' },
    );
    expect(r.status).toBe('ok');
    expect(r.path).toBe('new_branch_origin_head');
    // Target label uses stripRefsPrefix (display normalization) so it
    // comes out as "main" for the banner — but the CONFIG lookup used
    // the full ref, which is the key parity invariant.
    expect(r.target_label).toBe('main');
  });
});

describe('resolveBaseForRefspec — state isolation across multi-refspec (N carry-forward)', () => {
  it('does not leak configured_base between refspecs when config set on only one', () => {
    // Scenario: push A: configured base=dev → resolves, should promote label.
    //           push B: feature/bar with NO config → must NOT inherit "dev" label.
    const runner = stubRunner({
      'config --get branch.feature/foo.base': OK('dev'),
      'rev-parse --verify --quiet refs/remotes/origin/dev': OK(''),
      [`merge-base refs/remotes/origin/dev ${LOCAL_SHA}`]: OK(MERGE_BASE_SHA),
      'config --get branch.feature/bar.base': FAIL(),
      'symbolic-ref refs/remotes/origin/HEAD': OK('refs/remotes/origin/main'),
      [`merge-base refs/remotes/origin/main ${LOCAL_SHA}`]: OK(MERGE_BASE_SHA),
    });
    const a = resolveBaseForRefspec(newBranchRefspec(), {
      runner,
      cwd: '/repo',
      remote: 'origin',
    });
    const b = resolveBaseForRefspec(
      newBranchRefspec({
        local_ref: 'refs/heads/feature/bar',
        remote_ref: 'refs/heads/feature/bar',
      }),
      { runner, cwd: '/repo', remote: 'origin' },
    );
    expect(a.target_label).toBe('dev'); // promoted by config hit
    expect(b.target_label).toBe('feature/bar'); // NOT promoted — clean state
    expect(b.path).toBe('new_branch_origin_head');
  });
});
