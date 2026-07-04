/**
 * Unit tests for `runBillingCapHalt` (0.51.0 — spend-governance E1 seed,
 * INCIDENT-2026-07-04 denial-of-wallet).
 *
 * Behavior matrix:
 *   - billing signature + halt  → exit 2, .rea/HALT written
 *   - billing signature + warn  → exit 2, NO HALT
 *   - billing signature + off / enabled:false → exit 0, NO HALT (opt-out)
 *   - billing signature + ABSENT block → HALT (opt-out default is ON)
 *   - billing signature + malformed block shape → HALT (protect)
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
/**
 * Billing text on the STDERR channel of a FAILED command (exit_code 1) —
 * the realistic wall scenario. stderr is scanned ONLY on failure (round-7),
 * so this helper marks the command failed.
 */
function payload(command: string, stderr: string): string {
  return JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout: '', stderr, exit_code: 1 },
  });
}
/** Billing text on the STDERR channel of a SUCCESSFUL command (exit 0). */
function successStderrPayload(command: string, stderr: string): string {
  return JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout: '', stderr, exit_code: 0 },
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

  it('billing signature + absent block → HALT (opt-out default, round-5 P1)', async () => {
    // A present rea policy with NO spend_governance block is the exact
    // upgrade-from-0.50.x state. Opt-out default: the reflex is ON, so a
    // real billing wall still freezes rather than the hook being dead.
    writePolicy(root); // no spend_governance block at all
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: payload('node tts.mjs', BILLING),
    });
    expect(r.exitCode).toBe(2);
    expect(r.action).toBe('halt');
    expect(fs.existsSync(haltPath(root))).toBe(true);
  });

  it('malformed block shape (spend_governance: []) → PROTECT (round-5 P2)', async () => {
    // A parseable-but-schema-invalid shape the strict loader rejects must
    // not silently disable the guard.
    fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.rea', 'policy.yaml'),
      'version: "1"\nblocked_paths: []\nspend_governance: []\n',
    );
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: payload('node tts.mjs', BILLING),
    });
    expect(r.exitCode).toBe(2);
    expect(r.action).toBe('halt');
    expect(fs.existsSync(haltPath(root))).toBe(true);
  });

  it('malformed enabled value (enabled: "true" string) → PROTECT (round-5 P2)', async () => {
    fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.rea', 'policy.yaml'),
      'version: "1"\nblocked_paths: []\nspend_governance:\n  enabled: "true"\n',
    );
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: payload('node tts.mjs', BILLING),
    });
    expect(r.exitCode).toBe(2);
    expect(r.action).toBe('halt');
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

  it('does NOT scan stdout even when the command errored (round-4 P1: stderr-only)', async () => {
    // A failed command that prints a benign match to STDOUT must not
    // freeze — only stderr is scanned. Pre-fix an `is_error` stdout scan
    // froze on this.
    writePolicy(root, 'halt');
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: stdoutPayload('node tts.mjs', 'FATAL: spending cap exceeded', true),
    });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('noop');
    expect(fs.existsSync(haltPath(root))).toBe(false);
  });

  it('grep -R that fails on a missing path but matches docs on stdout → no freeze (round-4 P1)', async () => {
    // The canonical false-positive: grep exits non-zero because one path
    // is missing (stderr: "No such file"), but prints real doc matches to
    // stdout. stderr does not match BILLING_RE, so no HALT.
    writePolicy(root, 'halt');
    const grepPayload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'grep -R "spending cap" docs missing_dir' },
      tool_response: {
        stdout: 'docs/THREAT_MODEL.md: ... the spending cap wall ...',
        stderr: 'grep: missing_dir: No such file or directory',
        exit_code: 2,
      },
    });
    const r = await runBillingCapHalt({ reaRoot: root, stdinOverride: grepPayload });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('noop');
    expect(fs.existsSync(haltPath(root))).toBe(false);
  });

  it('billing error on STDERR of a failed command → halt (the real wall still fires)', async () => {
    writePolicy(root, 'halt');
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: payload('node tts.mjs', 'FATAL: spending cap exceeded'),
    });
    expect(r.exitCode).toBe(2);
    expect(r.action).toBe('halt');
    expect(r.haltWritten).toBe(true);
  });

  it('billing phrase on STDERR of a SUCCESSFUL command → no freeze (round-7 P1)', async () => {
    // A passing helper/test that logs an example provider response to
    // stderr must not freeze the session — only failed commands are scanned.
    writePolicy(root, 'halt');
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: successStderrPayload('node print-example.mjs', 'example: spending cap exceeded'),
    });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('noop');
    expect(fs.existsSync(haltPath(root))).toBe(false);
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

describe('policy degradation — malformed YAML fails toward protection (round-2 P2)', () => {
  it('present-but-unparseable policy → PROTECT (billing signal still HALTs)', async () => {
    const root = makeRoot();
    // A real spend-governance install (feature on by default) whose YAML
    // is broken by a syntax error in an UNRELATED section — the exact
    // mid-edit / merge-conflict scenario. The guard must NOT silently
    // vanish; it defaults to the protective halt.
    fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(root, '.rea', 'policy.yaml'),
      'version: "1"\nblocked_paths: [unclosed\n  : : bad indent :\n',
    );
    const res = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: payload('node tts.mjs', 'Error: spending cap exceeded'),
    });
    expect(res.action).toBe('halt');
    expect(res.exitCode).toBe(2);
    expect(fs.existsSync(haltPath(root))).toBe(true);
    rm(root);
  });

  it('MISSING policy file → disabled (no HALT even on a billing signal)', async () => {
    const root = makeRoot(); // no .rea/policy.yaml at all
    const res = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: payload('node tts.mjs', 'spending cap exceeded'),
    });
    expect(res.action).toBe('noop');
    expect(res.exitCode).toBe(0);
    expect(fs.existsSync(haltPath(root))).toBe(false);
    rm(root);
  });
});

describe('BILLING_RE distinctness from rate-limit', () => {
  it('matches provider-specific terminal billing phrases', () => {
    for (const s of [
      'spending cap',
      'prepayment credits are depleted',
      'prepayment credits depleted',
      'credit balance is too low',
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

  it('does NOT match AMBIGUOUS phrases (round-7 P2 — app/402/business-domain)', () => {
    // These occur in ordinary app errors, paywall/402 flows, and
    // business-domain test output; too broad for a hook with no
    // metered-endpoint scoping yet. PR2 restores them scoped to a host.
    for (const s of [
      'payment required',
      '402 payment required',
      'insufficient funds',
      'insufficient balance',
      'insufficient credits',
    ]) {
      expect(BILLING_RE.test(s)).toBe(false);
    }
  });
});
