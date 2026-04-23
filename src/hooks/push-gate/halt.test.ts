import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readHalt } from './halt.js';

describe('readHalt', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-halt-test-')));
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('returns halted=false when .rea/HALT is absent', () => {
    const s = readHalt(baseDir);
    expect(s.halted).toBe(false);
    expect(s.reason).toBeUndefined();
  });

  it('returns halted=true + reason=first-line when HALT exists', async () => {
    await fs.writeFile(path.join(baseDir, '.rea', 'HALT'), 'emergency stop\n\ncontext\n', 'utf8');
    const s = readHalt(baseDir);
    expect(s.halted).toBe(true);
    expect(s.reason).toBe('emergency stop');
  });

  it('returns halted=true + reason=unknown when HALT is empty', async () => {
    await fs.writeFile(path.join(baseDir, '.rea', 'HALT'), '', 'utf8');
    const s = readHalt(baseDir);
    expect(s.halted).toBe(true);
    expect(s.reason).toBe('unknown');
  });

  it('trims whitespace from the first line', async () => {
    await fs.writeFile(path.join(baseDir, '.rea', 'HALT'), '   halted for audit   \n', 'utf8');
    const s = readHalt(baseDir);
    expect(s.halted).toBe(true);
    expect(s.reason).toBe('halted for audit');
  });

  it('skips leading blank lines when finding the reason', async () => {
    await fs.writeFile(path.join(baseDir, '.rea', 'HALT'), '\n\nreal reason\n', 'utf8');
    const s = readHalt(baseDir);
    expect(s.halted).toBe(true);
    expect(s.reason).toBe('real reason');
  });
});
