/**
 * Tests for the shared `_lib/protected-paths.ts` primitives.
 */

import { describe, expect, it } from 'vitest';
import {
  KILL_SWITCH_INVARIANTS,
  PROTECTED_PATTERNS_FULL,
  PATCH_SESSION_PATTERNS,
  isExtensionSurface,
  resolveProtectedPatterns,
  matchAny,
  isProtected,
  sanitizeForStderr,
} from './protected-paths.js';

describe('isExtensionSurface', () => {
  it('matches .husky/commit-msg.d/X', () => {
    expect(isExtensionSurface('.husky/commit-msg.d/00-lint')).toBe(true);
  });
  it('matches .husky/pre-push.d/X', () => {
    expect(isExtensionSurface('.husky/pre-push.d/00-act-ci')).toBe(true);
  });
  it('matches .husky/pre-commit.d/X', () => {
    expect(isExtensionSurface('.husky/pre-commit.d/00-lint')).toBe(true);
  });
  it('matches .husky/prepare-commit-msg.d/X (0.32.0 Phase 3)', () => {
    expect(isExtensionSurface('.husky/prepare-commit-msg.d/00-co')).toBe(true);
  });
  it('case-insensitive', () => {
    expect(isExtensionSurface('.HUSKY/PRE-PUSH.D/X')).toBe(true);
  });
  it('refuses bare directory', () => {
    expect(isExtensionSurface('.husky/pre-push.d/')).toBe(false);
    expect(isExtensionSurface('.husky/pre-push.d')).toBe(false);
  });
  it('refuses .husky/pre-push (not the .d/ surface)', () => {
    expect(isExtensionSurface('.husky/pre-push')).toBe(false);
  });
  it('refuses similar-but-not-surface paths', () => {
    expect(isExtensionSurface('.husky/pre-push.d.bak/x')).toBe(false);
    expect(isExtensionSurface('.husky/pre-push.dump')).toBe(false);
  });
  it('allows nested fragments', () => {
    expect(isExtensionSurface('.husky/pre-push.d/sub/file')).toBe(true);
  });
});

describe('resolveProtectedPatterns', () => {
  it('default → PROTECTED_PATTERNS_FULL', () => {
    const r = resolveProtectedPatterns();
    expect(r.patterns).toEqual(PROTECTED_PATTERNS_FULL);
    expect(r.overridePatterns).toEqual([]);
    expect(r.advisories).toEqual([]);
  });

  it('protected_writes set → replaces default + adds invariants back', () => {
    const r = resolveProtectedPatterns({
      protectedWrites: ['custom/sensitive/'],
    });
    expect(r.patterns).toContain('custom/sensitive/');
    for (const inv of KILL_SWITCH_INVARIANTS) {
      expect(r.patterns).toContain(inv);
    }
    // .husky/ from the FULL default should NOT be in the override set.
    expect(r.patterns).not.toContain('.husky/');
    expect(r.overridePatterns).toEqual(['custom/sensitive/']);
  });

  it('protected_paths_relax subtracts from default', () => {
    const r = resolveProtectedPatterns({
      protectedPathsRelax: ['.husky/'],
    });
    expect(r.patterns).not.toContain('.husky/');
    expect(r.patterns).toContain('.rea/HALT');
  });

  it('kill-switch invariant in relax → silently dropped with advisory', () => {
    const r = resolveProtectedPatterns({
      protectedPathsRelax: ['.rea/HALT'],
    });
    expect(r.patterns).toContain('.rea/HALT');
    expect(r.advisories).toHaveLength(1);
    expect(r.advisories[0]).toContain('kill-switch invariant');
  });

  it('case-insensitive relax comparison', () => {
    const r = resolveProtectedPatterns({
      protectedPathsRelax: ['.HUSKY/'],
    });
    expect(r.patterns).not.toContain('.husky/');
  });
});

describe('matchAny', () => {
  it('exact match returns pattern (lowercase comparison)', () => {
    expect(matchAny('.rea/halt', ['.rea/HALT'])).toBe('.rea/HALT');
  });
  it('directory-prefix match returns pattern', () => {
    expect(matchAny('.husky/pre-push', ['.husky/'])).toBe('.husky/');
  });
  it('no match → null', () => {
    expect(matchAny('src/foo.ts', ['.husky/'])).toBe(null);
  });
});

describe('isProtected', () => {
  const defaultResolution = resolveProtectedPatterns();

  it('blocks .claude/settings.json', () => {
    const { protected: p, matchedPattern } = isProtected('.claude/settings.json', defaultResolution);
    expect(p).toBe(true);
    expect(matchedPattern).toBe('.claude/settings.json');
  });

  it('blocks .husky/pre-push via prefix', () => {
    const { protected: p, matchedPattern } = isProtected('.husky/pre-push', defaultResolution);
    expect(p).toBe(true);
    expect(matchedPattern).toBe('.husky/');
  });

  it('allows .husky/pre-push.d/X via extension-surface short-circuit', () => {
    const { protected: p } = isProtected('.husky/pre-push.d/00-fragment', defaultResolution);
    expect(p).toBe(false);
  });

  it('explicit override re-protects an extension-surface path', () => {
    const r = resolveProtectedPatterns({ protectedWrites: ['.husky/pre-push.d/'] });
    const { protected: p, matchedPattern } = isProtected('.husky/pre-push.d/00-fragment', r);
    expect(p).toBe(true);
    expect(matchedPattern).toBe('.husky/pre-push.d/');
  });

  it('allows clean src/ paths', () => {
    const { protected: p } = isProtected('src/foo.ts', defaultResolution);
    expect(p).toBe(false);
  });
});

describe('PATCH_SESSION_PATTERNS', () => {
  it('contains .claude/hooks/', () => {
    expect(PATCH_SESSION_PATTERNS).toContain('.claude/hooks/');
  });
});

describe('sanitizeForStderr', () => {
  it('strips C0 controls', () => {
    expect(sanitizeForStderr('ab')).toBe('ab');
    expect(sanitizeForStderr('ab')).toBe('ab');
  });
  it('strips DEL', () => {
    expect(sanitizeForStderr('ab')).toBe('ab');
  });
  it('strips C1 controls', () => {
    expect(sanitizeForStderr('ab')).toBe('ab');
  });
  it('preserves normal text and unicode', () => {
    expect(sanitizeForStderr('hello world: café 🎉')).toBe('hello world: café 🎉');
  });
  it('preserves printable ascii', () => {
    expect(sanitizeForStderr('foo/bar.ts')).toBe('foo/bar.ts');
  });
});
