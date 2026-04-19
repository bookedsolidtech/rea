import { describe, it, expect } from 'vitest';
import { loadProfile } from './profiles.js';

describe('profile schema — G9 injection flag propagation', () => {
  it('bst-internal pins injection.suspicious_blocks_writes = true', () => {
    const profile = loadProfile('bst-internal');
    expect(profile).not.toBeNull();
    expect(profile?.injection?.suspicious_blocks_writes).toBe(true);
  });

  it('bst-internal-no-codex pins injection.suspicious_blocks_writes = true', () => {
    const profile = loadProfile('bst-internal-no-codex');
    expect(profile).not.toBeNull();
    expect(profile?.injection?.suspicious_blocks_writes).toBe(true);
  });

  it('open-source does NOT set injection block — schema default (false) applies at load', () => {
    const profile = loadProfile('open-source');
    expect(profile).not.toBeNull();
    expect(profile?.injection).toBeUndefined();
  });

  it('client-engagement does NOT set injection block — schema default (false) applies', () => {
    const profile = loadProfile('client-engagement');
    expect(profile).not.toBeNull();
    expect(profile?.injection).toBeUndefined();
  });

  it('minimal does NOT set injection block — schema default (false) applies', () => {
    const profile = loadProfile('minimal');
    expect(profile).not.toBeNull();
    expect(profile?.injection).toBeUndefined();
  });

  it('lit-wc does NOT set injection block — schema default (false) applies', () => {
    const profile = loadProfile('lit-wc');
    expect(profile).not.toBeNull();
    expect(profile?.injection).toBeUndefined();
  });
});
