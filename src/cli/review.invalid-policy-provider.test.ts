/**
 * codex round-7 P2 — an EXISTING-but-invalid `.rea/policy.yaml` configured for
 * `openrouter`/`both` must still route to the openrouter provider (→ the VISIBLE
 * `invalid-policy` fail-closed path), never silently degrade to a plain codex
 * run that hides the broken config. `bestEffortConfiguredProvider` is the
 * raw-file read that preserves the configured intent across schema failure.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bestEffortConfiguredProvider } from './review.js';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-invpol-'));
  fs.mkdirSync(path.join(tmp, '.rea'), { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeRaw(yaml: string): void {
  fs.writeFileSync(path.join(tmp, '.rea', 'policy.yaml'), yaml);
}

describe('bestEffortConfiguredProvider (codex round-7 P2)', () => {
  it('reads provider:openrouter from a schema-INVALID but YAML-valid policy', () => {
    // `autonomy_level: BOGUS` fails zod validation, but the YAML still parses
    // structurally — the configured provider must survive that failure.
    writeRaw('autonomy_level: BOGUS\nreview:\n  provider: openrouter\n');
    expect(bestEffortConfiguredProvider(tmp)).toEqual({ provider: 'openrouter', rawParsed: true });
  });

  it('reads provider:both', () => {
    writeRaw('review:\n  provider: both\n');
    expect(bestEffortConfiguredProvider(tmp)).toEqual({ provider: 'both', rawParsed: true });
  });

  it('provider absent but YAML parsed → rawParsed true, no provider (→ safe codex default)', () => {
    writeRaw('review:\n  local_review:\n    mode: enforced\n');
    const r = bestEffortConfiguredProvider(tmp);
    expect(r.provider).toBeUndefined();
    expect(r.rawParsed).toBe(true);
  });

  it('MISSING policy file → rawParsed false (caller treats as missing, not fail-closed)', () => {
    // beforeEach creates only `.rea/` — no policy.yaml is written here.
    expect(fs.existsSync(path.join(tmp, '.rea', 'policy.yaml'))).toBe(false);
    const r = bestEffortConfiguredProvider(tmp);
    expect(r.provider).toBeUndefined();
    expect(r.rawParsed).toBe(false);
  });

  it('rejects an unknown provider value but still rawParsed (only codex|openrouter|both)', () => {
    writeRaw('review:\n  provider: gemini\n');
    const r = bestEffortConfiguredProvider(tmp);
    expect(r.provider).toBeUndefined();
    expect(r.rawParsed).toBe(true);
  });

  it('codex round-10 P1: syntactically-broken YAML → rawParsed FALSE (forces fail-closed upstream)', () => {
    // A genuinely unparseable document — the provider cannot be read at all, so
    // the caller must NOT assume codex. Must not throw; must report rawParsed:false.
    writeRaw('review:\n  provider: openrouter\n: : : :\n  - [unbalanced\n    nested: {');
    const r = bestEffortConfiguredProvider(tmp);
    expect(r.rawParsed).toBe(false);
    expect(r.provider).toBeUndefined();
  });
});
