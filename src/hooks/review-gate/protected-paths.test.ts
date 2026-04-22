/**
 * Unit tests for `protected-paths.ts`. Ensures every protected-path prefix
 * is detected and that non-relevant status letters (W for write-conflict,
 * X for unknown) are skipped.
 */

import { describe, expect, it } from 'vitest';
import {
  extractPathsFromStatusLine,
  isProtectedPath,
  scanNameStatusForProtectedPaths,
} from './protected-paths.js';
import { PROTECTED_PATH_PREFIXES } from './constants.js';

describe('isProtectedPath', () => {
  it.each(PROTECTED_PATH_PREFIXES)('flags %s as protected', (prefix) => {
    expect(isProtectedPath(prefix + 'some/file.ts')).toBe(true);
  });

  it('flags .rea/policy.yaml as protected', () => {
    expect(isProtectedPath('.rea/policy.yaml')).toBe(true);
  });

  it('flags src/gateway/middleware/foo.ts as protected', () => {
    expect(isProtectedPath('src/gateway/middleware/foo.ts')).toBe(true);
  });

  it('does NOT flag a sibling file that only starts with a protected prefix string', () => {
    // `.reactconfig` shares a prefix with `.rea/` but is not under `.rea/`.
    // Our prefix-with-slash rule rejects this correctly.
    expect(isProtectedPath('.reactconfig')).toBe(false);
  });

  it('does not flag non-protected paths', () => {
    expect(isProtectedPath('src/cli/doctor.ts')).toBe(false);
    expect(isProtectedPath('README.md')).toBe(false);
    expect(isProtectedPath('__tests__/some.test.ts')).toBe(false);
  });
});

describe('extractPathsFromStatusLine', () => {
  it('extracts the single path for status A/M/D', () => {
    expect(extractPathsFromStatusLine('M\tsrc/policy/loader.ts')).toEqual(['src/policy/loader.ts']);
    expect(extractPathsFromStatusLine('A\thooks/new-hook.sh')).toEqual(['hooks/new-hook.sh']);
    expect(extractPathsFromStatusLine('D\t.rea/HALT')).toEqual(['.rea/HALT']);
  });

  it('extracts both paths for rename (R) with similarity', () => {
    const r = extractPathsFromStatusLine('R100\thooks/old.sh\thooks/new.sh');
    expect(r).toEqual(['hooks/old.sh', 'hooks/new.sh']);
  });

  it('extracts both paths for copy (C) with similarity', () => {
    const r = extractPathsFromStatusLine('C95\tsrc/policy/types.ts\tsrc/policy/types-v2.ts');
    expect(r).toEqual(['src/policy/types.ts', 'src/policy/types-v2.ts']);
  });

  it('returns empty for irrelevant status letter (W, X, anything not in ACDMRTU)', () => {
    expect(extractPathsFromStatusLine('W\tsome/file.ts')).toEqual([]);
    expect(extractPathsFromStatusLine('X\tsome/file.ts')).toEqual([]);
  });

  it('returns empty for malformed line (no tab)', () => {
    expect(extractPathsFromStatusLine('Msome/file.ts')).toEqual([]);
  });

  it('returns empty for empty line', () => {
    expect(extractPathsFromStatusLine('')).toEqual([]);
  });
});

describe('scanNameStatusForProtectedPaths', () => {
  it('returns hit:false on empty input', () => {
    const r = scanNameStatusForProtectedPaths('');
    expect(r.hit).toBe(false);
    expect(r.paths).toEqual([]);
  });

  it('detects a single protected path', () => {
    const r = scanNameStatusForProtectedPaths('M\tsrc/policy/loader.ts\nM\tREADME.md\n');
    expect(r.hit).toBe(true);
    expect(r.paths).toEqual(['src/policy/loader.ts']);
  });

  it('detects renames into a protected path', () => {
    const r = scanNameStatusForProtectedPaths('R100\thooks/from.sh\thooks/to.sh\n');
    expect(r.hit).toBe(true);
    expect(r.paths.length).toBe(2);
  });

  it('deduplicates hits and sorts them', () => {
    const r = scanNameStatusForProtectedPaths(
      'M\t.rea/policy.yaml\nM\t.rea/policy.yaml\nM\thooks/a.sh\n',
    );
    expect(r.paths).toEqual(['.rea/policy.yaml', 'hooks/a.sh']);
  });

  it('returns hit:false when no protected paths match', () => {
    const r = scanNameStatusForProtectedPaths('M\tREADME.md\nM\tsrc/cli/doctor.ts\n');
    expect(r.hit).toBe(false);
  });

  it('handles mixed protected + non-protected correctly', () => {
    const r = scanNameStatusForProtectedPaths(
      [
        'M\tREADME.md',
        'M\tsrc/gateway/middleware/audit.ts',
        'A\t.github/workflows/release.yml',
        'M\tsrc/cli/doctor.ts',
      ].join('\n'),
    );
    expect(r.hit).toBe(true);
    expect(r.paths).toEqual(['.github/workflows/release.yml', 'src/gateway/middleware/audit.ts']);
  });
});
