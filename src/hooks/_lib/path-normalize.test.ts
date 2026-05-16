/**
 * Tests for the shared `_lib/path-normalize.ts` primitives.
 *
 * Each function is covered against the byte-parity contract with
 * `hooks/_lib/path-normalize.sh`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  normalizePath,
  hasTraversalSegment,
  hasInteriorDotSegment,
  resolveCanonRoot,
  resolveParentRealpath,
} from './path-normalize.js';

describe('normalizePath', () => {
  it('strips $REA_ROOT/ prefix', () => {
    expect(normalizePath('/tmp/project/src/foo.ts', '/tmp/project')).toBe(
      'src/foo.ts',
    );
  });

  it('returns empty for exact REA_ROOT match', () => {
    expect(normalizePath('/tmp/project', '/tmp/project')).toBe('');
  });

  it('URL-decodes %2F → /, %2E → ., %20 → space, %5C → \\', () => {
    expect(normalizePath('foo%2Fbar', '/x')).toBe('foo/bar');
    expect(normalizePath('foo%2Ebar', '/x')).toBe('foo.bar');
    expect(normalizePath('foo%20bar', '/x')).toBe('foo bar');
    // %5C decodes to backslash which is then translated to / in step 3.
    expect(normalizePath('foo%5Cbar', '/x')).toBe('foo/bar');
  });

  it('case-insensitive percent encoding (lowercase + uppercase)', () => {
    expect(normalizePath('foo%2fbar', '/x')).toBe('foo/bar');
    expect(normalizePath('foo%2ebar', '/x')).toBe('foo.bar');
  });

  it('translates backslash separators to forward slashes', () => {
    expect(normalizePath('foo\\bar\\baz', '/x')).toBe('foo/bar/baz');
  });

  it('strips leading ./ segments', () => {
    expect(normalizePath('./src/foo.ts', '/x')).toBe('src/foo.ts');
    expect(normalizePath('././src/foo.ts', '/x')).toBe('src/foo.ts');
  });

  it('does NOT strip interior ./ segments', () => {
    expect(normalizePath('foo/./bar', '/x')).toBe('foo/./bar');
  });

  it('does NOT strip .. segments', () => {
    expect(normalizePath('foo/../bar', '/x')).toBe('foo/../bar');
  });
});

describe('hasTraversalSegment', () => {
  it('detects /../ at start', () => {
    expect(hasTraversalSegment('../foo')).toBe(true);
  });
  it('detects /../ in middle', () => {
    expect(hasTraversalSegment('a/../b')).toBe(true);
  });
  it('detects /../ at end', () => {
    expect(hasTraversalSegment('foo/..')).toBe(true);
  });
  it('rejects "..filename" with no segment', () => {
    expect(hasTraversalSegment('..hidden')).toBe(false);
  });
  it('rejects clean path', () => {
    expect(hasTraversalSegment('src/foo.ts')).toBe(false);
  });
});

describe('hasInteriorDotSegment', () => {
  it('detects /./ in middle', () => {
    expect(hasInteriorDotSegment('a/./b')).toBe(true);
  });
  it('detects single leading ./', () => {
    // bash hook treats leading ./ as interior too (the bracketed form)
    expect(hasInteriorDotSegment('./foo')).toBe(true);
  });
  it('rejects clean path', () => {
    expect(hasInteriorDotSegment('src/foo.ts')).toBe(false);
  });
});

describe('resolveCanonRoot', () => {
  it('returns absolute path unchanged when no symlinks', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-pn-canon-'));
    try {
      const resolved = resolveCanonRoot(tmp);
      // realpath of /tmp on macOS resolves to /private/tmp.
      expect(fs.statSync(resolved).isDirectory()).toBe(true);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('falls back to input on realpath failure', () => {
    expect(resolveCanonRoot('/__nonexistent_path__/xyzzy123')).toBe(
      '/__nonexistent_path__/xyzzy123',
    );
  });
});

describe('resolveParentRealpath', () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-pn-realpath-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('returns realpath when parent exists', () => {
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    const r = resolveParentRealpath(path.join(root, 'sub', 'file.txt'));
    expect(r).toContain('sub');
  });

  it('walks up to nearest existing ancestor when parent missing', () => {
    fs.mkdirSync(path.join(root, 'present'), { recursive: true });
    // .../present/notyet/file → walk up to /present, append "notyet"
    const r = resolveParentRealpath(
      path.join(root, 'present', 'notyet', 'file.txt'),
    );
    expect(r).toContain('present');
    expect(r).toContain('notyet');
  });

  it('returns empty when no existing ancestor inside the path', () => {
    const r = resolveParentRealpath('/totally_missing/never_existed/x');
    // Walks up to "/" which is the stop condition → empty.
    expect(r).toBe('');
  });

  it('handles a symlinked parent', () => {
    fs.mkdirSync(path.join(root, 'target'), { recursive: true });
    fs.symlinkSync(path.join(root, 'target'), path.join(root, 'link'));
    const r = resolveParentRealpath(path.join(root, 'link', 'file.txt'));
    // Realpath should resolve `link` → `target`.
    expect(r).toContain('target');
    expect(r).not.toContain('link');
  });
});
