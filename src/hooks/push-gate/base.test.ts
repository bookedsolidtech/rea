import { describe, expect, it } from 'vitest';
import { EMPTY_TREE_SHA, resolveBaseRef } from './base.js';
import type { GitExecutor } from './codex-runner.js';

function fakeGit(overrides: Partial<GitExecutor> = {}): GitExecutor {
  return {
    tryRevParse: () => '',
    trySymbolicRef: () => '',
    headSha: () => 'deadbeef',
    diffNames: () => [],
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
        tryRevParse: (args) =>
          args.includes('@{upstream}') ? 'origin/feature-base' : '',
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
