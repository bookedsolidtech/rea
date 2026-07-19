/**
 * Unit tests for `src/hooks/_lib/halt-check.ts`.
 *
 * Coverage focus:
 *   - Absent HALT file → `{ halted: false }`
 *   - Present HALT file with content → first non-empty line as reason
 *   - Present HALT file with whitespace-only / empty content → fallback reason
 *   - Read failure (mocked via fs.readFileSync mock) → fail-closed halted
 *   - 1024-byte cap — pathological multi-MB input does not blow stderr
 *   - CRLF line ending tolerance (Windows-authored HALT files)
 *   - `formatHaltBanner` byte-for-byte parity with the pre-0.32.0
 *     inline copies in `src/cli/hook.ts`.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { checkHalt, checkHaltRoots, formatHaltBanner } from './halt-check.js';

function mkProjectRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-halt-check-test-'));
}

describe('checkHalt', () => {
  let root: string;

  beforeEach(() => {
    root = mkProjectRoot();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('returns not-halted when .rea/HALT is absent', () => {
    const result = checkHalt(root);
    expect(result).toEqual({ halted: false });
  });

  it('returns not-halted when .rea/ exists but HALT does not', () => {
    fs.mkdirSync(path.join(root, '.rea'));
    const result = checkHalt(root);
    expect(result).toEqual({ halted: false });
  });

  it('extracts the first non-empty line as reason', () => {
    fs.mkdirSync(path.join(root, '.rea'));
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'Mid-deploy lockdown — see Slack\n');
    const result = checkHalt(root);
    expect(result).toEqual({ halted: true, reason: 'Mid-deploy lockdown — see Slack' });
  });

  it('skips leading blank lines and uses the first non-empty line', () => {
    fs.mkdirSync(path.join(root, '.rea'));
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), '\n\n   \nReal reason here\nAnother line\n');
    const result = checkHalt(root);
    expect(result).toEqual({ halted: true, reason: 'Real reason here' });
  });

  it('tolerates CRLF line endings', () => {
    fs.mkdirSync(path.join(root, '.rea'));
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'Windows-edited reason\r\nsecond\r\n');
    const result = checkHalt(root);
    expect(result).toEqual({ halted: true, reason: 'Windows-edited reason' });
  });

  it('falls back to "Reason unknown" when content is whitespace-only', () => {
    fs.mkdirSync(path.join(root, '.rea'));
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), '   \n\t\n  \n');
    const result = checkHalt(root);
    expect(result).toEqual({ halted: true, reason: 'Reason unknown' });
  });

  it('falls back to "Reason unknown" on a fully empty file', () => {
    fs.mkdirSync(path.join(root, '.rea'));
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), '');
    const result = checkHalt(root);
    expect(result).toEqual({ halted: true, reason: 'Reason unknown' });
  });

  it('caps reason scan at 1024 bytes — pathological large file does not over-read', () => {
    fs.mkdirSync(path.join(root, '.rea'));
    // Build a 4-MiB blob whose first 2000 bytes are blank (so the
    // first non-empty line lives past the cap). Verify we still emit
    // a finite reason rather than scanning the whole megabyte.
    const blob = ' '.repeat(2000) + '\nVisible only past the cap\n' + 'x'.repeat(4 * 1024 * 1024);
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), blob);
    const result = checkHalt(root);
    // Within the 1024-byte cap, every line is whitespace-only — so
    // the function falls back to the placeholder. This is the desired
    // outcome: bounded work, predictable stderr.
    expect(result).toEqual({ halted: true, reason: 'Reason unknown' });
  });

  it('truncates an oversized first-line reason at 1024 bytes worth of content', () => {
    fs.mkdirSync(path.join(root, '.rea'));
    // Single line of 3000 characters — the cap slices to the first
    // 1024 bytes BEFORE splitting, so we expect a 1024-char reason.
    const longLine = 'a'.repeat(3000);
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), longLine);
    const result = checkHalt(root);
    expect(result.halted).toBe(true);
    if (result.halted) {
      expect(result.reason.length).toBe(1024);
      expect(result.reason).toBe('a'.repeat(1024));
    }
  });

  it('fails closed (halted with sentinel reason) when readFileSync throws', () => {
    fs.mkdirSync(path.join(root, '.rea'));
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'real reason');
    // Force a read failure AFTER existsSync passes — this models a
    // permissions glitch / race / EIO mid-read.
    const originalReadFileSync = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation((p, opts) => {
      if (typeof p === 'string' && p.endsWith('HALT')) {
        throw new Error('EACCES: simulated permission denied');
      }
      return originalReadFileSync(p, opts);
    });
    const result = checkHalt(root);
    expect(result).toEqual({ halted: true, reason: 'unknown (HALT file unreadable)' });
  });
});

describe('formatHaltBanner', () => {
  it('renders the canonical operator-facing string', () => {
    // Byte-for-byte match against the pre-0.32.0 inline string in
    // src/cli/hook.ts. If the message changes here it MUST change in
    // every consumer of this primitive simultaneously.
    expect(formatHaltBanner('mid-deploy lockdown')).toBe(
      'REA HALT: mid-deploy lockdown\nAll agent operations suspended. Run: rea unfreeze\n',
    );
  });

  it('renders the placeholder reason cleanly', () => {
    expect(formatHaltBanner('Reason unknown')).toBe(
      'REA HALT: Reason unknown\nAll agent operations suspended. Run: rea unfreeze\n',
    );
  });
});

describe('checkHaltRoots — worktree-aware kill switch (0.54.0)', () => {
  it('local HALT still freezes (legacy per-worktree file)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-haltroots-'));
    fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'local freeze');
    const r = checkHaltRoots(root);
    expect(r.halted).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('COMMON HALT freezes a caller that only passed the local root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-haltroots-'));
    const common = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-haltcommon-'));
    fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
    fs.mkdirSync(path.join(common, '.rea'), { recursive: true });
    fs.writeFileSync(path.join(common, '.rea', 'HALT'), 'repo-wide freeze');
    const r = checkHaltRoots(root, common);
    expect(r.halted).toBe(true);
    if (r.halted) expect(r.reason).toBe('repo-wide freeze');
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(common, { recursive: true, force: true });
  });

  it('degenerate (common === local): single probe, clear → not halted', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-haltroots-'));
    fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
    expect(checkHaltRoots(root, root)).toEqual({ halted: false });
    fs.rmSync(root, { recursive: true, force: true });
  });
});
