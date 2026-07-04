/**
 * Unit tests for `runBillingCapHalt` (0.51.0 — spend-governance E1 seed,
 * INCIDENT-2026-07-04 denial-of-wallet).
 *
 * Behavior matrix:
 *   - billing signature + halt  → exit 2, .rea/HALT written
 *   - billing signature + warn  → exit 2, NO HALT
 *   - billing signature + off   → exit 0, NO HALT
 *   - billing signature, block disabled / absent → exit 0, NO HALT
 *   - rate-limit-only (429)     → exit 0, NO HALT (billing ≠ rate-limit)
 *   - clean output              → exit 0, NO HALT
 *   - malformed payload         → exit 0, NO HALT (fail-SAFE)
 *   - HALT already present      → exit 2, idempotent (file not rewritten)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runBillingCapHalt, BILLING_RE } from './index.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-billing-'));
}
function rm(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
function writePolicy(root: string, mode?: 'halt' | 'warn' | 'off', enabled = true): void {
  fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
  let body = `version: "1"
profile: "test"
installed_by: "test"
installed_at: "2026-07-04T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: false
blocked_paths: []
`;
  if (mode !== undefined || enabled === false) {
    body += `spend_governance:\n  enabled: ${enabled ? 'true' : 'false'}\n`;
    if (mode !== undefined) body += `  billing_error_response: ${mode}\n`;
  }
  fs.writeFileSync(path.join(root, '.rea', 'policy.yaml'), body);
}
function haltPath(root: string): string {
  return path.join(root, '.rea', 'HALT');
}
/** Billing text on the STDERR (error) channel — always scanned. */
function payload(command: string, stderr: string): string {
  return JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout: '', stderr },
  });
}
/** Text on the STDOUT (benign) channel; `errored` toggles the failure flag. */
function stdoutPayload(command: string, stdout: string, errored = false): string {
  return JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout, stderr: '', ...(errored ? { is_error: true } : {}) },
  });
}

const BILLING = 'Error: you have exceeded your spending cap. Prepayment credits are depleted.';
const RATE_LIMIT = '429 Too Many Requests: rate limit exceeded, retry after 30s';

describe('runBillingCapHalt', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rm(root);
  });

  it('billing signature + halt → exit 2, HALT written', async () => {
    writePolicy(root, 'halt');
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: payload('node tts.mjs', BILLING),
    });
    expect(r.exitCode).toBe(2);
    expect(r.action).toBe('halt');
    expect(r.haltWritten).toBe(true);
    expect(fs.existsSync(haltPath(root))).toBe(true);
    expect(fs.readFileSync(haltPath(root), 'utf8')).toMatch(/billing-cap-halt/);
    expect(r.stderr).toMatch(/BILLING HALT/);
  });

  it('billing signature + warn → exit 2, NO HALT', async () => {
    writePolicy(root, 'warn');
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: payload('node tts.mjs', BILLING),
    });
    expect(r.exitCode).toBe(2);
    expect(r.action).toBe('warn');
    expect(r.haltWritten).toBe(false);
    expect(fs.existsSync(haltPath(root))).toBe(false);
    expect(r.stderr).toMatch(/BILLING WARNING/);
  });

  it('billing signature + off → exit 0, NO HALT', async () => {
    writePolicy(root, 'off');
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: payload('node tts.mjs', BILLING),
    });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('noop');
    expect(fs.existsSync(haltPath(root))).toBe(false);
  });

  it('billing signature + enabled:false → exit 0, NO HALT', async () => {
    writePolicy(root, undefined, false);
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: payload('node tts.mjs', BILLING),
    });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('noop');
    expect(fs.existsSync(haltPath(root))).toBe(false);
  });

  it('billing signature + absent block → exit 0, NO HALT', async () => {
    writePolicy(root); // no spend_governance block at all
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: payload('node tts.mjs', BILLING),
    });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('noop');
    expect(fs.existsSync(haltPath(root))).toBe(false);
  });

  it('rate-limit only (429) + halt → exit 0, NO HALT (billing ≠ rate-limit)', async () => {
    writePolicy(root, 'halt');
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: payload('node tts.mjs', RATE_LIMIT),
    });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('noop');
    expect(fs.existsSync(haltPath(root))).toBe(false);
  });

  it('clean output + halt → exit 0, NO HALT', async () => {
    writePolicy(root, 'halt');
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: payload('echo hi', 'hi'),
    });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('noop');
  });

  it('malformed payload + halt → exit 0, NO HALT (fail-safe)', async () => {
    writePolicy(root, 'halt');
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: '{not json at all',
    });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('noop');
    expect(fs.existsSync(haltPath(root))).toBe(false);
    expect(r.stderr).toMatch(/payload unreadable/);
  });

  it('HALT already present → exit 2, idempotent (file not rewritten)', async () => {
    writePolicy(root, 'halt');
    fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
    const original = 'pre-existing freeze reason\n';
    fs.writeFileSync(haltPath(root), original);
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: payload('node tts.mjs', BILLING),
    });
    expect(r.exitCode).toBe(2);
    expect(r.haltWritten).toBe(false);
    // The pre-existing HALT content must be untouched.
    expect(fs.readFileSync(haltPath(root), 'utf8')).toBe(original);
  });

  it('does NOT scan the command text (billing phrase only in command → no halt)', async () => {
    // codex round-1 P2: `rg "spending cap" .` must not self-freeze the session.
    writePolicy(root, 'halt');
    const raw = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'rg "spending cap" .' },
      tool_response: { stdout: 'src/foo.ts\nTHREAT_MODEL.md', stderr: '' },
    });
    const r = await runBillingCapHalt({ reaRoot: root, stdinOverride: raw });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('noop');
    expect(fs.existsSync(haltPath(root))).toBe(false);
  });

  it('does NOT scan a SUCCESSFUL command stdout (cat THREAT_MODEL.md → no halt)', async () => {
    // codex round-1 P1: benign docs containing the phrase must not freeze.
    writePolicy(root, 'halt');
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: stdoutPayload('cat THREAT_MODEL.md', 'A billing spending cap exceeded example.'),
    });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('noop');
    expect(fs.existsSync(haltPath(root))).toBe(false);
  });

  it('DOES scan stdout when the command errored (billing on stdout + is_error → halt)', async () => {
    writePolicy(root, 'halt');
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: stdoutPayload('node tts.mjs', 'FATAL: spending cap exceeded', true),
    });
    expect(r.exitCode).toBe(2);
    expect(r.action).toBe('halt');
    expect(r.haltWritten).toBe(true);
  });

  it('write failure → exit 2, haltWritten false, DEGRADED banner (does not claim frozen)', async () => {
    writePolicy(root, 'halt');
    // Make `.rea` read-only (r-x) so policy.yaml still reads but
    // writeFileSync(`.rea/HALT`) throws EACCES — simulating a read-only
    // checkout / permissions problem.
    fs.chmodSync(path.join(root, '.rea'), 0o500);
    try {
      const r = await runBillingCapHalt({
        reaRoot: root,
        stdinOverride: payload('node tts.mjs', BILLING),
      });
      expect(r.exitCode).toBe(2);
      expect(r.action).toBe('halt');
      expect(r.haltWritten).toBe(false);
      expect(fs.existsSync(haltPath(root))).toBe(false);
      expect(r.stderr).toMatch(/DEGRADED/);
      expect(r.stderr).toMatch(/NOT frozen/);
    } finally {
      fs.chmodSync(path.join(root, '.rea'), 0o700);
    }
  });

  it('sanitizes control bytes out of the matched snippet before it reaches HALT', async () => {
    writePolicy(root, 'halt');
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: payload('node tts.mjs', 'billing limit \x1b[31m reached'),
    });
    expect(r.exitCode).toBe(2);
    const halt = fs.readFileSync(haltPath(root), 'utf8');
    // No ESC byte should survive into the HALT file.
    expect(halt.includes('\x1b')).toBe(false);
  });
});

describe('BILLING_RE distinctness from rate-limit', () => {
  it('matches terminal billing phrases', () => {
    for (const s of [
      'spending cap',
      'prepayment credits are depleted',
      'prepayment credits depleted',
      'credit balance is too low',
      'insufficient funds',
      'insufficient balance',
      'payment required',
      'insufficient_quota',
      'billing hard limit exceeded',
    ]) {
      expect(BILLING_RE.test(s)).toBe(true);
    }
  });

  it('does NOT match retryable rate-limit phrases', () => {
    for (const s of [
      '429 Too Many Requests',
      'rate limit exceeded',
      'usage limit reached',
      'exceeded quota',
      'resource exhausted',
      'deadline exceeded',
      'too many requests',
    ]) {
      expect(BILLING_RE.test(s)).toBe(false);
    }
  });
});
