import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  UnsafeInstallPathError,
  atomicReplaceFile,
  resolveContained,
  safeDeleteFile,
  safeReadFile,
} from './fs-safe.js';

async function mkTmp(prefix: string): Promise<string> {
  return fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), `${prefix}-`)));
}

describe('resolveContained', () => {
  it('accepts a simple nested relative path', async () => {
    const root = await mkTmp('rea-fs-safe');
    const out = resolveContained(root, 'a/b/c.txt');
    expect(out).toBe(path.join(root, 'a', 'b', 'c.txt'));
  });

  it('refuses absolute paths', async () => {
    const root = await mkTmp('rea-fs-safe');
    expect(() => resolveContained(root, '/etc/passwd')).toThrow(UnsafeInstallPathError);
  });

  it('refuses `..` segments', async () => {
    const root = await mkTmp('rea-fs-safe');
    expect(() => resolveContained(root, '../escape')).toThrow(UnsafeInstallPathError);
    expect(() => resolveContained(root, 'a/../../out')).toThrow(UnsafeInstallPathError);
  });

  it('refuses Windows-separator `..` segments', async () => {
    const root = await mkTmp('rea-fs-safe');
    expect(() => resolveContained(root, 'a\\..\\..\\etc')).toThrow(UnsafeInstallPathError);
  });
});

describe('atomicReplaceFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkTmp('rea-atomic');
  });
  afterEach(async () => {
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  it('creates a new file when none exists', async () => {
    const f = path.join(dir, 'new.json');
    await atomicReplaceFile(f, '{"a":1}');
    expect(await fsPromises.readFile(f, 'utf8')).toBe('{"a":1}');
  });

  it('replaces an existing file atomically', async () => {
    const f = path.join(dir, 'existing.json');
    await fsPromises.writeFile(f, '{"old":true}');
    await atomicReplaceFile(f, '{"new":true}');
    expect(await fsPromises.readFile(f, 'utf8')).toBe('{"new":true}');
    // No stray tmp/bak artifacts.
    expect(fs.existsSync(`${f}.tmp`)).toBe(false);
    expect(fs.existsSync(`${f}.bak`)).toBe(false);
  });

  it('creates any missing parent directories', async () => {
    const f = path.join(dir, 'nested', 'deep', 'file.json');
    await atomicReplaceFile(f, 'x');
    expect(await fsPromises.readFile(f, 'utf8')).toBe('x');
  });

  it('accepts Buffer contents', async () => {
    const f = path.join(dir, 'buf.bin');
    await atomicReplaceFile(f, Buffer.from([0x01, 0x02, 0x03]));
    expect(await fsPromises.readFile(f)).toEqual(Buffer.from([0x01, 0x02, 0x03]));
  });
});

describe('safeDeleteFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkTmp('rea-safe-del');
  });
  afterEach(async () => {
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  it('deletes a regular file inside the root', async () => {
    const f = path.join(dir, 'a.txt');
    await fsPromises.writeFile(f, 'x');
    await safeDeleteFile(dir, 'a.txt');
    expect(fs.existsSync(f)).toBe(false);
  });

  it('no-ops on an already-absent file (idempotent)', async () => {
    await expect(safeDeleteFile(dir, 'never-existed.txt')).resolves.toBeUndefined();
  });

  it('refuses to delete outside the root', async () => {
    await expect(safeDeleteFile(dir, '../outside')).rejects.toThrow(UnsafeInstallPathError);
  });

  it('refuses to delete a symlink (even inside root)', async () => {
    const target = path.join(dir, 'target.txt');
    const link = path.join(dir, 'link.txt');
    await fsPromises.writeFile(target, 'y');
    await fsPromises.symlink(target, link);
    await expect(safeDeleteFile(dir, 'link.txt')).rejects.toThrow(/refusing to delete symlink/);
    // Original target still on disk.
    expect(fs.existsSync(target)).toBe(true);
  });
});

describe('safeReadFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkTmp('rea-safe-read');
  });
  afterEach(async () => {
    await fsPromises.rm(dir, { recursive: true, force: true });
  });

  it('returns null for an absent file', async () => {
    expect(await safeReadFile(dir, 'missing.txt')).toBeNull();
  });

  it('returns the file bytes for a regular file', async () => {
    await fsPromises.writeFile(path.join(dir, 'a.txt'), 'hi');
    const buf = await safeReadFile(dir, 'a.txt');
    expect(buf?.toString('utf8')).toBe('hi');
  });

  it('refuses to read a symlink', async () => {
    const target = path.join(dir, 'target.txt');
    const link = path.join(dir, 'link.txt');
    await fsPromises.writeFile(target, 'secret');
    await fsPromises.symlink(target, link);
    await expect(safeReadFile(dir, 'link.txt')).rejects.toThrow(/refusing to read symlink/);
  });

  it('refuses a path that escapes the root', async () => {
    await expect(safeReadFile(dir, '../../etc/passwd')).rejects.toThrow(UnsafeInstallPathError);
  });
});
