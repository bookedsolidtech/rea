import { describe, expect, it, vi } from 'vitest';
import { CodexReviewer, type ExecFileFn } from './codex.js';

function mockExec(stdout: string): ExecFileFn {
  return vi.fn().mockResolvedValue({ stdout, stderr: '' });
}

function failingExec(err: Error): ExecFileFn {
  return vi.fn().mockRejectedValue(err);
}

describe('CodexReviewer', () => {
  describe('isAvailable', () => {
    it('returns true on exit 0 and caches the version', async () => {
      const exec = mockExec('codex 1.2.3\n');
      const reviewer = new CodexReviewer({ exec });
      await expect(reviewer.isAvailable()).resolves.toBe(true);
      expect(reviewer.version).toBe('codex 1.2.3');
    });

    it('returns false when execFile rejects (ENOENT)', async () => {
      const err = Object.assign(new Error('not found'), { code: 'ENOENT' });
      const reviewer = new CodexReviewer({ exec: failingExec(err) });
      await expect(reviewer.isAvailable()).resolves.toBe(false);
      expect(reviewer.version).toBe('unknown');
    });

    it('returns false on timeout', async () => {
      const err = Object.assign(new Error('killed'), { signal: 'SIGTERM' });
      const reviewer = new CodexReviewer({ exec: failingExec(err) });
      await expect(reviewer.isAvailable()).resolves.toBe(false);
    });

    it('returns false on non-zero exit', async () => {
      const err = Object.assign(new Error('exit 1'), { code: 1 });
      const reviewer = new CodexReviewer({ exec: failingExec(err) });
      await expect(reviewer.isAvailable()).resolves.toBe(false);
    });

    it('falls back to unknown when stdout is empty', async () => {
      const reviewer = new CodexReviewer({ exec: mockExec('   \n') });
      await expect(reviewer.isAvailable()).resolves.toBe(true);
      expect(reviewer.version).toBe('unknown');
    });
  });

  describe('version caching', () => {
    it('does not re-invoke exec on repeat version reads', async () => {
      const exec = vi.fn<ExecFileFn>().mockResolvedValue({ stdout: 'codex 0.4.0', stderr: '' });
      const reviewer = new CodexReviewer({ exec });
      await reviewer.isAvailable();
      // Reading `version` is a getter — it must not trigger another exec.
      expect(reviewer.version).toBe('codex 0.4.0');
      expect(reviewer.version).toBe('codex 0.4.0');
      expect(exec).toHaveBeenCalledTimes(1);
    });
  });

  describe('review', () => {
    it('throws — the in-process path is the codex-adversarial agent', async () => {
      const reviewer = new CodexReviewer({ exec: mockExec('codex 1.0.0') });
      await expect(
        reviewer.review({
          diff: '',
          commit_log: '',
          branch: 'main',
          head_sha: 'deadbeef',
          target: 'origin/main',
        }),
      ).rejects.toThrow(/codex-adversarial agent/);
    });
  });

  describe('identity', () => {
    it('name is codex', () => {
      const reviewer = new CodexReviewer({ exec: mockExec('') });
      expect(reviewer.name).toBe('codex');
    });

    it('version is unknown before first successful probe', () => {
      const reviewer = new CodexReviewer({ exec: mockExec('') });
      expect(reviewer.version).toBe('unknown');
    });
  });
});
