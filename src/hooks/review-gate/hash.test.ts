/**
 * Unit tests for `hash.ts`. Closes defect L regression class — a single
 * portable helper replaces the sha256sum/shasum/openssl fallback chain,
 * and the parity test in `cache-key.test.ts` asserts the output is
 * byte-identical to what `sha256sum` produces on the same bytes.
 */

import { describe, expect, it } from 'vitest';
import { sha256Hex, isValidSha256Hex } from './hash.js';

describe('sha256Hex', () => {
  it('hashes the empty string to the canonical empty-sha256', () => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('matches GNU sha256sum / shasum -a 256 for ASCII input', () => {
    // `printf 'hello world' | sha256sum` → this digest.
    expect(sha256Hex('hello world')).toBe(
      'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9',
    );
  });

  it('handles UTF-8 multi-byte codepoints consistently', () => {
    // Captured from `node -e "console.log(crypto.createHash('sha256').update('café','utf8').digest('hex'))"`
    // and independently verified by Codex pass-1 review. The digest is
    // deterministic across Node versions because `createHash` operates on
    // UTF-8 bytes regardless of platform locale.
    expect(sha256Hex('café')).toBe(
      '850f7dc43910ff890f8879c0ed26fe697c93a067ad93a7d50f466a7028a9bf4e',
    );
  });

  it('always returns a lowercase 64-char hex string', () => {
    const digest = sha256Hex('any input here');
    expect(digest).toHaveLength(64);
    expect(digest).toBe(digest.toLowerCase());
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic across calls', () => {
    const a = sha256Hex('deterministic input');
    const b = sha256Hex('deterministic input');
    expect(a).toBe(b);
  });

  it('differs for inputs that differ by a single byte', () => {
    const a = sha256Hex('input A');
    const b = sha256Hex('input B');
    expect(a).not.toBe(b);
  });
});

describe('isValidSha256Hex', () => {
  it('accepts a canonical digest', () => {
    expect(
      isValidSha256Hex('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'),
    ).toBe(true);
  });

  it('rejects uppercase hex', () => {
    expect(
      isValidSha256Hex('E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855'),
    ).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidSha256Hex('')).toBe(false);
  });

  it('rejects too-short', () => {
    expect(isValidSha256Hex('abc123')).toBe(false);
  });

  it('rejects too-long', () => {
    expect(isValidSha256Hex('a'.repeat(65))).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidSha256Hex('g'.repeat(64))).toBe(false);
  });
});
