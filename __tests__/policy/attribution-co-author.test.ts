/**
 * 0.30.0 — `attribution.co_author` policy schema tests.
 *
 * Covers the cross-field zod refinement:
 *   - enabled: true + name + email → parses clean
 *   - enabled: true + name='' → fails with explicit name-required error
 *   - enabled: true + email='' → fails with explicit email-required error
 *   - enabled: false → parses regardless of name/email state (off-switch
 *     should NEVER require identity)
 *   - email regex validation (permissive)
 *   - all 7 shipped profiles parse with `enabled: false`
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPolicy } from '../../src/policy/loader.js';

const POLICY_HEADER = `version: "1"
profile: minimal
installed_by: test
installed_at: "2026-05-12T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths:
  - .env
notification_channel: ""
`;

async function writePolicy(dir: string, body: string): Promise<void> {
  const reaDir = path.join(dir, '.rea');
  await fs.mkdir(reaDir, { recursive: true });
  await fs.writeFile(path.join(reaDir, 'policy.yaml'), POLICY_HEADER + body);
}

describe('AttributionPolicy — cross-field refinement', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-attr-policy-'));
    dir = await fs.realpath(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('accepts enabled: false with NO name/email', async () => {
    await writePolicy(
      dir,
      `attribution:
  co_author:
    enabled: false
`,
    );
    const policy = loadPolicy(dir);
    expect(policy.attribution?.co_author?.enabled).toBe(false);
  });

  it('accepts enabled: true when BOTH name and email are non-empty', async () => {
    await writePolicy(
      dir,
      `attribution:
  co_author:
    enabled: true
    name: "Real Name"
    email: "real@example.com"
`,
    );
    const policy = loadPolicy(dir);
    expect(policy.attribution?.co_author?.enabled).toBe(true);
    expect(policy.attribution?.co_author?.name).toBe('Real Name');
    expect(policy.attribution?.co_author?.email).toBe('real@example.com');
  });

  it('REJECTS enabled: true with empty name (cross-field refinement)', async () => {
    await writePolicy(
      dir,
      `attribution:
  co_author:
    enabled: true
    name: ""
    email: "real@example.com"
`,
    );
    expect(() => loadPolicy(dir)).toThrow(/non-empty `name`/);
  });

  it('REJECTS enabled: true with omitted name (cross-field refinement)', async () => {
    await writePolicy(
      dir,
      `attribution:
  co_author:
    enabled: true
    email: "real@example.com"
`,
    );
    expect(() => loadPolicy(dir)).toThrow(/non-empty `name`/);
  });

  it('REJECTS enabled: true with empty email (cross-field refinement)', async () => {
    await writePolicy(
      dir,
      `attribution:
  co_author:
    enabled: true
    name: "Real Name"
    email: ""
`,
    );
    expect(() => loadPolicy(dir)).toThrow(/non-empty `email`/);
  });

  it('REJECTS a malformed email (missing dot)', async () => {
    await writePolicy(
      dir,
      `attribution:
  co_author:
    enabled: true
    name: "Real Name"
    email: "bad-email-no-dot"
`,
    );
    expect(() => loadPolicy(dir)).toThrow(/email/);
  });

  it('REJECTS a malformed email (with whitespace)', async () => {
    await writePolicy(
      dir,
      `attribution:
  co_author:
    enabled: true
    name: "Real Name"
    email: "spaces in@email.com"
`,
    );
    expect(() => loadPolicy(dir)).toThrow(/email/);
  });

  it('accepts skip_merge: true', async () => {
    await writePolicy(
      dir,
      `attribution:
  co_author:
    enabled: true
    name: "Real Name"
    email: "real@example.com"
    skip_merge: true
`,
    );
    const policy = loadPolicy(dir);
    expect(policy.attribution?.co_author?.skip_merge).toBe(true);
  });

  it('accepts no attribution block at all (back-compat)', async () => {
    await writePolicy(dir, '');
    const policy = loadPolicy(dir);
    expect(policy.attribution).toBeUndefined();
  });

  // 0.30.1 round-5 P2 — the `name` value is written verbatim into a
  // single-line `Co-Authored-By:` git trailer. A newline or other
  // control char would split the trailer and could inject extra
  // trailer lines. The schema must reject control chars in `name`.
  it('REJECTS a name containing a newline (control-char guard)', async () => {
    await writePolicy(
      dir,
      'attribution:\n  co_author:\n    enabled: true\n' +
        '    name: "Real Name\\nCo-Authored-By: Injected <evil@example.com>"\n' +
        '    email: "real@example.com"\n',
    );
    expect(() => loadPolicy(dir)).toThrow(/control character/);
  });

  it('REJECTS a name containing a carriage return', async () => {
    await writePolicy(
      dir,
      'attribution:\n  co_author:\n    enabled: true\n' +
        '    name: "Real\\rName"\n' +
        '    email: "real@example.com"\n',
    );
    expect(() => loadPolicy(dir)).toThrow(/control character/);
  });

  it('REJECTS a name containing a tab', async () => {
    await writePolicy(
      dir,
      'attribution:\n  co_author:\n    enabled: true\n' +
        '    name: "Real\\tName"\n' +
        '    email: "real@example.com"\n',
    );
    expect(() => loadPolicy(dir)).toThrow(/control character/);
  });

  it('accepts a name with non-ASCII letters (control-char guard is not over-broad)', async () => {
    await writePolicy(
      dir,
      'attribution:\n  co_author:\n    enabled: true\n' +
        '    name: "Joăo Strawn-Müller"\n' +
        '    email: "real@example.com"\n',
    );
    const policy = loadPolicy(dir);
    expect(policy.attribution?.co_author?.name).toBe('Joăo Strawn-Müller');
  });
});

describe('AttributionPolicy — all shipped profiles parse with enabled: false', () => {
  // The 0.30.0 charter requires every shipped profile to ship
  // `enabled: false` so other contributors using the profile do NOT
  // silently get their commits routed onto the profile author's
  // GitHub heatmap. This test imports each profile and asserts that
  // contract.
  it('every profile/*.yaml carries attribution.co_author.enabled: false', async () => {
    const { loadProfile } = await import('../../src/policy/profiles.js');
    const profiles = [
      'minimal',
      'bst-internal',
      'bst-internal-no-codex',
      'open-source',
      'open-source-no-codex',
      'client-engagement',
      'lit-wc',
    ];
    for (const name of profiles) {
      const profile = loadProfile(name);
      expect(profile).not.toBeNull();
      expect(profile?.attribution?.co_author?.enabled).toBe(false);
    }
  });
});
