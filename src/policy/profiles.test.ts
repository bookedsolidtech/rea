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

describe('profile schema — R20-P1 package.json in blocked_paths on every profile', () => {
  // R20-P1 (codex round 20): `bootstrap_allowlist` defaults to
  // `enabled: true` on every profile (schema default). The
  // allowlist's precondition — "`package.json` declares
  // `@bookedsolid/rea`" — is only meaningful as a security
  // boundary when AGENT Edit/Write to `package.json` is gated.
  // Pre-R20, only `bst-internal*` listed `package.json` in
  // `blocked_paths`; the other 5 profiles allowed an agent to
  // first ADD the declaration via Edit, then route an otherwise-
  // disallowed PM command through the allowlist's CLI-missing
  // pass-through. R20-P1 propagates the entry to all 6 shipped
  // profiles. PM-induced writes remain explicitly out of scope
  // (THREAT_MODEL.md §5.23 "Out of scope" — preserves the R17
  // scope cut on the static manifest-write detector).
  //
  // These tests pin the entry so a future profile refactor cannot
  // silently regress the gate.

  it.each(['bst-internal', 'bst-internal-no-codex', 'client-engagement', 'lit-wc', 'minimal', 'open-source', 'open-source-no-codex'])(
    '%s — `package.json` is in blocked_paths',
    (name) => {
      const profile = loadProfile(name);
      expect(profile).not.toBeNull();
      expect(profile?.blocked_paths).toBeDefined();
      expect(profile?.blocked_paths).toContain('package.json');
    },
  );
});
