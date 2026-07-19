/**
 * Unit tests for the turn-budget reflex (Artifact Gates §5 — make the
 * turn-budget folklore real). Covers the permissive config reader
 * (`parseTurnBudget`), the per-session counter mechanism (`runTurnBudget`),
 * and end-to-end integration through the `billing-cap-halt` PostToolUse path
 * (`runBillingCapHalt`).
 *
 * Behavior matrix:
 *   - absent config             → no-op (no counter file, no events)
 *   - counter increments across successive invocations (per session file)
 *   - warn fires ONCE at/after warn_turns, not on every subsequent turn
 *   - response: halt writes .rea/HALT at/after halt_turns + audits halt event
 *   - response: warn audits at halt_turns but does NOT freeze
 *   - response: off → parseTurnBudget returns null → silent no-op
 *   - separate sessions keep independent counters
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseTurnBudget, runTurnBudget, updateCounter } from './turn-budget.js';
import { runBillingCapHalt } from './index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-turnbudget-'));
}
function rm(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
function haltPath(root: string): string {
  return path.join(root, '.rea', 'HALT');
}
function auditPath(root: string): string {
  return path.join(root, '.rea', 'audit.jsonl');
}
function readAudit(root: string): Array<Record<string, unknown>> {
  let raw: string;
  try {
    raw = fs.readFileSync(auditPath(root), 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
/** Policy with a turn_budget block. */
function writePolicy(
  root: string,
  turnBudget: { warn: number; halt: number; response?: 'warn' | 'halt' | 'off' } | null,
  billingMode: 'off' | 'warn' | 'halt' = 'off',
): void {
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
spend_governance:
  enabled: true
  billing_error_response: ${billingMode}
`;
  if (turnBudget !== null) {
    body += `  turn_budget:\n    warn_turns: ${turnBudget.warn}\n    halt_turns: ${turnBudget.halt}\n`;
    if (turnBudget.response !== undefined) body += `    response: ${turnBudget.response}\n`;
  }
  fs.writeFileSync(path.join(root, '.rea', 'policy.yaml'), body);
}
/** A benign Bash PostToolUse payload (no billing signature). */
function benignPayload(): string {
  return JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'echo hi' },
    tool_response: { stdout: 'hi', stderr: '', exit_code: 0 },
  });
}
/** An Edit PostToolUse payload (non-Bash — no command/stderr). */
function editPayload(stderr = ''): string {
  return JSON.stringify({
    tool_name: 'Edit',
    tool_input: { file_path: '/x/y.ts', old_string: 'a', new_string: 'b' },
    // Even if a (nonsensical) stderr with a billing phrase is present on a
    // non-Bash tool, the billing scan must NOT run — it is Bash-only.
    tool_response: { filePath: '/x/y.ts', ...(stderr ? { stderr, is_error: true } : {}) },
  });
}
/** A READ PostToolUse payload — a read-only tool (no command/stderr). The
 *  turn counter must still advance (F1: the budget counts ALL tool calls,
 *  else it is bypassable via read/search tools). */
function readPayload(): string {
  return JSON.stringify({
    tool_name: 'Read',
    tool_input: { file_path: '/x/y.ts' },
    tool_response: { type: 'text', file: { filePath: '/x/y.ts', numLines: 3 } },
  });
}

describe('parseTurnBudget', () => {
  it('parses a valid block and defaults response to warn', () => {
    expect(parseTurnBudget({ warn_turns: 10, halt_turns: 20 })).toEqual({
      warnTurns: 10,
      haltTurns: 20,
      response: 'warn',
    });
  });
  it('preserves explicit halt response', () => {
    expect(parseTurnBudget({ warn_turns: 5, halt_turns: 5, response: 'halt' })).toEqual({
      warnTurns: 5,
      haltTurns: 5,
      response: 'halt',
    });
  });
  it('returns null when response is off (silent)', () => {
    expect(parseTurnBudget({ warn_turns: 10, halt_turns: 20, response: 'off' })).toBeNull();
  });
  it('returns null for absent / non-object / malformed blocks', () => {
    expect(parseTurnBudget(undefined)).toBeNull();
    expect(parseTurnBudget(null)).toBeNull();
    expect(parseTurnBudget([])).toBeNull();
    expect(parseTurnBudget('on')).toBeNull();
    expect(parseTurnBudget({ warn_turns: 10 })).toBeNull(); // missing halt
    expect(parseTurnBudget({ warn_turns: 0, halt_turns: 10 })).toBeNull(); // non-positive
    expect(parseTurnBudget({ warn_turns: 1.5, halt_turns: 10 })).toBeNull(); // non-integer
    expect(parseTurnBudget({ warn_turns: 100, halt_turns: 50 })).toBeNull(); // warn > halt
  });
});

describe('runTurnBudget', () => {
  let root: string;
  const stderrSink = (): { write: (s: string) => void; text: () => string } => {
    let buf = '';
    return { write: (s: string) => (buf += s), text: () => buf };
  };
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => rm(root));

  it('is a no-op when config is null (feature off)', async () => {
    const sink = stderrSink();
    const r = await runTurnBudget({
      localRoot: root,
      commonRoot: root,
      config: null,
      sessionId: 's1',
      stderrWrite: sink.write,
    });
    expect(r).toEqual({ action: 'noop', count: null, haltWritten: false });
    expect(sink.text()).toBe('');
    expect(fs.existsSync(auditPath(root))).toBe(false);
    // No counter file (indeed no .rea dir) created.
    expect(fs.existsSync(path.join(root, '.rea'))).toBe(false);
  });

  it('increments the per-session counter across invocations', async () => {
    const cfg = { warnTurns: 100, haltTurns: 200, response: 'warn' as const };
    const sink = stderrSink();
    for (let i = 1; i <= 3; i++) {
      const r = await runTurnBudget({
        localRoot: root,
        commonRoot: root,
        config: cfg,
        sessionId: 'sess-A',
        stderrWrite: sink.write,
      });
      expect(r.count).toBe(i);
      expect(r.action).toBe('noop');
    }
    const file = path.join(root, '.rea', 'turn-count.sess-A.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).count).toBe(3);
  });

  it('fires warn ONCE at the threshold, not on every subsequent turn', async () => {
    const cfg = { warnTurns: 2, haltTurns: 100, response: 'warn' as const };
    const actions: string[] = [];
    for (let i = 1; i <= 4; i++) {
      const sink = stderrSink();
      const r = await runTurnBudget({
        localRoot: root,
        commonRoot: root,
        config: cfg,
        sessionId: 's',
        stderrWrite: sink.write,
      });
      actions.push(r.action);
    }
    // Turn 1: noop; turn 2: warn (crossing); turns 3,4: noop (already emitted).
    expect(actions).toEqual(['noop', 'warn', 'noop', 'noop']);
    const warnEvents = readAudit(root).filter((e) => e.tool_name === 'rea.spend.turn_budget_warn');
    expect(warnEvents).toHaveLength(1);
  });

  it('response: halt writes .rea/HALT and audits a halt event at the halt threshold', async () => {
    const cfg = { warnTurns: 1, haltTurns: 2, response: 'halt' as const };
    const sink = stderrSink();
    // Turn 1 → warn crossing.
    await runTurnBudget({ localRoot: root, commonRoot: root, config: cfg, sessionId: 's', stderrWrite: sink.write });
    expect(fs.existsSync(haltPath(root))).toBe(false);
    // Turn 2 → halt crossing.
    const r2 = await runTurnBudget({
      localRoot: root,
      commonRoot: root,
      config: cfg,
      sessionId: 's',
      stderrWrite: sink.write,
    });
    expect(r2.action).toBe('halt');
    expect(r2.haltWritten).toBe(true);
    expect(fs.existsSync(haltPath(root))).toBe(true);
    const haltEvents = readAudit(root).filter((e) => e.tool_name === 'rea.spend.turn_budget_halt');
    expect(haltEvents).toHaveLength(1);
  });

  it('keeps independent counters per session', async () => {
    const cfg = { warnTurns: 2, haltTurns: 100, response: 'warn' as const };
    const sink = stderrSink();
    // sess-A twice, sess-B once.
    await runTurnBudget({ localRoot: root, commonRoot: root, config: cfg, sessionId: 'A', stderrWrite: sink.write });
    await runTurnBudget({ localRoot: root, commonRoot: root, config: cfg, sessionId: 'A', stderrWrite: sink.write });
    const rB = await runTurnBudget({
      localRoot: root,
      commonRoot: root,
      config: cfg,
      sessionId: 'B',
      stderrWrite: sink.write,
    });
    expect(rB.count).toBe(1);
    expect(JSON.parse(fs.readFileSync(path.join(root, '.rea', 'turn-count.A.json'), 'utf8')).count).toBe(2);
    expect(JSON.parse(fs.readFileSync(path.join(root, '.rea', 'turn-count.B.json'), 'utf8')).count).toBe(1);
  });

  it('falls back to a single shared counter file when no session id', async () => {
    const cfg = { warnTurns: 100, haltTurns: 200, response: 'warn' as const };
    const sink = stderrSink();
    await runTurnBudget({ localRoot: root, commonRoot: root, config: cfg, sessionId: undefined, stderrWrite: sink.write });
    expect(fs.existsSync(path.join(root, '.rea', 'turn-count.json'))).toBe(true);
  });

  it('F2: response halt with an unwritable commonRoot still returns action=halt (haltWritten=false) + degraded banner', async () => {
    // commonRoot points at a FILE, so writeHaltFile's mkdir(.rea) throws
    // ENOTDIR deterministically (root-safe — no chmod). The hard stop must
    // NOT silently downgrade: action stays 'halt', the banner is the honest
    // DEGRADED variant (not "session frozen"), and the counter still advanced.
    const commonFile = path.join(root, 'not-a-dir');
    fs.writeFileSync(commonFile, 'x');
    const sink = stderrSink();
    const r = await runTurnBudget({
      localRoot: root,
      commonRoot: commonFile,
      config: { warnTurns: 1, haltTurns: 1, response: 'halt' },
      sessionId: 'wf',
      stderrWrite: sink.write,
    });
    expect(r.action).toBe('halt');
    expect(r.haltWritten).toBe(false);
    expect(sink.text()).toContain('DEGRADED');
    expect(sink.text()).not.toContain('session frozen');
    // Counter (LOCAL root) still incremented despite the HALT-write failure.
    expect(JSON.parse(fs.readFileSync(path.join(root, '.rea', 'turn-count.wf.json'), 'utf8')).count).toBe(1);
  });
});

describe('updateCounter — F3 serialization', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
    fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
  });
  afterEach(() => rm(root));

  const cfg = { warnTurns: 1_000_000, haltTurns: 1_000_000, response: 'warn' as const };

  it('sequential increments never lose a count', () => {
    const file = path.join(root, '.rea', 'turn-count.s.json');
    for (let i = 1; i <= 50; i++) {
      expect(updateCounter(file, cfg).count).toBe(i);
    }
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).count).toBe(50);
  });

  it('crossedWarn/crossedHalt fire exactly once across increments', () => {
    const file = path.join(root, '.rea', 'turn-count.c.json');
    const c2 = { warnTurns: 2, haltTurns: 3, response: 'warn' as const };
    const results = [1, 2, 3, 4].map(() => updateCounter(file, c2));
    expect(results.map((r) => r.crossedWarn)).toEqual([false, true, false, false]);
    expect(results.map((r) => r.crossedHalt)).toEqual([false, false, true, false]);
  });

  it('round-42 F2: SUPPRESSES a crossing whose state did not persist, then fires it EXACTLY ONCE once writable', () => {
    // Force a deterministic, root-safe write failure: make the counter PATH a
    // directory, so writeState's writeFileSync fails with EISDIR (fails even as
    // root — not mode-bit dependent).
    const file = path.join(root, '.rea', 'turn-count.wf.json');
    fs.mkdirSync(file, { recursive: true });
    const c = { warnTurns: 1, haltTurns: 1, response: 'halt' as const };

    // Increment crosses the threshold in memory, but the write is LOST →
    // the crossing must be SUPPRESSED (reporting it now would re-fire next call
    // since the emitted flags were never saved).
    const failed = updateCounter(file, c);
    expect(failed.crossedWarn).toBe(false);
    expect(failed.crossedHalt).toBe(false);
    // Nothing persisted — the path is still the (empty) directory, no JSON file.
    expect(fs.statSync(file).isDirectory()).toBe(true);

    // Path becomes writable (remove the blocking directory).
    fs.rmdirSync(file);

    // Next call: the write succeeds → the crossing fires ONCE.
    const fires = updateCounter(file, c);
    expect(fires.crossedHalt).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).halt_emitted).toBe(true);

    // And a subsequent call does NOT re-fire (persisted halt_emitted holds).
    const again = updateCounter(file, c);
    expect(again.crossedHalt).toBe(false);
  });

  it('round-42 F2: a persistence failure NEVER throws (fail-safe degrade to no-accounting)', () => {
    const file = path.join(root, '.rea', 'turn-count.nothrow.json');
    fs.mkdirSync(file, { recursive: true }); // unwritable path (EISDIR on write)
    const c = { warnTurns: 1, haltTurns: 2, response: 'warn' as const };
    expect(() => updateCounter(file, c)).not.toThrow();
    // Repeated calls under a persistent failure keep suppressing, never throw,
    // and never fire a crossing they can't record.
    for (let i = 0; i < 3; i++) {
      const r = updateCounter(file, c);
      expect(r.crossedWarn).toBe(false);
      expect(r.crossedHalt).toBe(false);
    }
  });

  it('resets IMPOSSIBLE persisted state instead of trusting it (round-31 P2)', () => {
    const file = path.join(root, '.rea', 'turn-count.imp.json');
    const c = { warnTurns: 1, haltTurns: 2, response: 'warn' as const };
    // Tampered/stale: count 0 but flags "emitted" — trusting this would suppress
    // every future crossing. The flags must be cleared (impossible at count 0).
    fs.writeFileSync(file, JSON.stringify({ count: 0, warn_emitted: true, halt_emitted: true }));
    const r1 = updateCounter(file, c);
    expect(r1.count).toBe(1);
    expect(r1.crossedWarn).toBe(true); // fires despite the bogus warn_emitted
    expect(updateCounter(file, c).crossedHalt).toBe(true); // and halt still fires
    // A negative count is impossible → reset to 0, so the next increment is 1.
    fs.writeFileSync(file, JSON.stringify({ count: -5, warn_emitted: false, halt_emitted: false }));
    expect(updateCounter(file, c).count).toBe(1);
  });

  it('concurrent cross-process increments do NOT lose a count (proper-lockfile)', () => {
    // The real race the lock addresses is CROSS-PROCESS (each PostToolUse hook
    // is a separate node process). Spawn N processes that each call the built
    // updateCounter once against the SAME counter file, in parallel; with the
    // lock the final count is exactly N (a lost read-modify-write would drop
    // one). Uses the compiled dist (build runs before tests in CI).
    const distModule = path.resolve(HERE, '../../../dist/hooks/billing-cap-halt/turn-budget.js');
    if (!fs.existsSync(distModule)) {
      // Build not present in this run — skip rather than fail spuriously.
      return;
    }
    const file = path.join(root, '.rea', 'turn-count.p.json');
    const worker = path.join(root, 'worker.mjs');
    fs.writeFileSync(
      worker,
      `import { updateCounter } from ${JSON.stringify(distModule)};\n` +
        `updateCounter(process.argv[2], { warnTurns: 1e9, haltTurns: 1e9, response: 'warn' });\n`,
    );
    // Launch all N workers in parallel through one `sh -c '… & … & wait'`,
    // maximizing overlap so an UNLOCKED read-modify-write would actually
    // collide and drop increments. With the lock, the final count is exactly N.
    const N = 12;
    const nodeBin = process.execPath;
    const one = `${JSON.stringify(nodeBin)} ${JSON.stringify(worker)} ${JSON.stringify(file)} &`;
    const cmd = `${Array.from({ length: N }, () => one).join(' ')} wait`;
    execFileSync('sh', ['-c', cmd], { stdio: 'ignore' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).count).toBe(N);
  });
});

describe('runBillingCapHalt — turn-budget integration', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => rm(root));

  it('feature-absent turn_budget is a no-op (no counter, billing path unaffected)', async () => {
    writePolicy(root, null);
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: benignPayload(),
      sessionId: 's',
      stderrWrite: () => {},
    });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('noop');
    expect(fs.readdirSync(path.join(root, '.rea')).some((f) => f.startsWith('turn-count'))).toBe(false);
  });

  it('counts each PostToolUse and warns once at warn_turns', async () => {
    writePolicy(root, { warn: 2, halt: 100, response: 'warn' });
    const run = async (): Promise<number> =>
      (await runBillingCapHalt({ reaRoot: root, stdinOverride: benignPayload(), sessionId: 'x', stderrWrite: () => {} }))
        .exitCode;
    expect(await run()).toBe(0); // turn 1
    expect(await run()).toBe(0); // turn 2 — warn, still exit 0 (advisory)
    expect(await run()).toBe(0); // turn 3
    const warnEvents = readAudit(root).filter((e) => e.tool_name === 'rea.spend.turn_budget_warn');
    expect(warnEvents).toHaveLength(1);
    expect(fs.existsSync(haltPath(root))).toBe(false);
  });

  it('response: halt freezes the session (exit 2 + .rea/HALT) at halt_turns', async () => {
    writePolicy(root, { warn: 1, halt: 2, response: 'halt' });
    const run = async (): Promise<number> =>
      (await runBillingCapHalt({ reaRoot: root, stdinOverride: benignPayload(), sessionId: 'x', stderrWrite: () => {} }))
        .exitCode;
    expect(await run()).toBe(0); // turn 1 — warn crossing, no freeze
    expect(fs.existsSync(haltPath(root))).toBe(false);
    const r2exit = await run(); // turn 2 — halt crossing
    expect(r2exit).toBe(2);
    expect(fs.existsSync(haltPath(root))).toBe(true);
    // A subsequent call short-circuits on the existing HALT (exit 2, idempotent).
    expect(await run()).toBe(2);
    const haltEvents = readAudit(root).filter((e) => e.tool_name === 'rea.spend.turn_budget_halt');
    expect(haltEvents).toHaveLength(1);
  });

  it('counts a NON-Bash (Edit) PostToolUse tool call — the counter is tool-agnostic', async () => {
    writePolicy(root, { warn: 2, halt: 100, response: 'warn' });
    const runEdit = async (): Promise<number> =>
      (await runBillingCapHalt({ reaRoot: root, stdinOverride: editPayload(), sessionId: 'e', stderrWrite: () => {} }))
        .exitCode;
    expect(await runEdit()).toBe(0); // turn 1
    expect(await runEdit()).toBe(0); // turn 2 — warn crossing on an Edit call
    const warnEvents = readAudit(root).filter((e) => e.tool_name === 'rea.spend.turn_budget_warn');
    expect(warnEvents).toHaveLength(1);
    // Counter persisted at 2 from Edit calls alone.
    expect(JSON.parse(fs.readFileSync(path.join(root, '.rea', 'turn-count.e.json'), 'utf8')).count).toBe(2);
  });

  it('halt threshold fires from a non-Bash-only session (Edit calls)', async () => {
    writePolicy(root, { warn: 1, halt: 2, response: 'halt' });
    const runEdit = async (): Promise<number> =>
      (await runBillingCapHalt({ reaRoot: root, stdinOverride: editPayload(), sessionId: 'e', stderrWrite: () => {} }))
        .exitCode;
    expect(await runEdit()).toBe(0); // turn 1 — warn
    const exit2 = await runEdit(); // turn 2 — halt
    expect(exit2).toBe(2);
    expect(fs.existsSync(haltPath(root))).toBe(true);
  });

  it('billing scan stays Bash-ONLY: a billing phrase on an Edit payload never freezes', async () => {
    // Billing ENABLED in halt mode so the flow reaches the Bash-only tool gate
    // (an Edit call must still not scan/freeze despite the billing phrase).
    writePolicy(root, { warn: 100, halt: 200, response: 'warn' }, 'halt');
    const r = await runBillingCapHalt({
      reaRoot: root,
      // Edit tool with a "spending cap" phrase on stderr + errored — must NOT
      // trigger a billing HALT (the scan is Bash-only). The turn counter still
      // runs (count increments) but no billing action.
      stdinOverride: editPayload('Error: you have exceeded your spending cap.'),
      sessionId: 'e',
      stderrWrite: () => {},
    });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('noop');
    expect(fs.existsSync(haltPath(root))).toBe(false);
    // No billing audit; counter did increment (turn accounting is tool-agnostic).
    expect(readAudit(root).filter((e) => e.tool_name === 'rea.spend_governance.billing')).toHaveLength(0);
    expect(JSON.parse(fs.readFileSync(path.join(root, '.rea', 'turn-count.e.json'), 'utf8')).count).toBe(1);
  });

  it('F1: a READ PostToolUse (read-only tool) increments the counter', async () => {
    // The budget counts ALL tool calls — a session in Read/LS/Glob/Grep must
    // still advance toward warn_turns/halt_turns (else the budget is bypassable
    // by using read/search tools). Read has no command/stderr; only the counter
    // runs, never the billing scan.
    writePolicy(root, { warn: 2, halt: 100, response: 'warn' });
    const runRead = async (): Promise<number> =>
      (await runBillingCapHalt({ reaRoot: root, stdinOverride: readPayload(), sessionId: 'r', stderrWrite: () => {} }))
        .exitCode;
    expect(await runRead()).toBe(0); // turn 1
    expect(await runRead()).toBe(0); // turn 2 — warn crossing on a Read call
    expect(JSON.parse(fs.readFileSync(path.join(root, '.rea', 'turn-count.r.json'), 'utf8')).count).toBe(2);
    expect(readAudit(root).filter((e) => e.tool_name === 'rea.spend.turn_budget_warn')).toHaveLength(1);
  });

  it('F2 (round-42): an unpersistable counter SUPPRESSES the halt crossing → exit 0 (fail-safe, no HALT)', async () => {
    // When the per-session counter cannot persist, the crossing must NOT be
    // reported — reporting it would re-fire on EVERY subsequent call (the
    // emitted flags were never saved), a repeated block. So a halt crossing
    // whose state was lost degrades to a no-op (exit 0), no HALT written.
    // Deterministic + root-safe write failure: make the counter file path a
    // DIRECTORY, so writeState's writeFileSync fails with EISDIR regardless of
    // euid. (The complementary case — counter PERSISTS but the .rea/HALT file
    // write fails → still action:halt / exit 2 — is covered by the runTurnBudget
    // unit test with an unwritable commonRoot.)
    writePolicy(root, { warn: 1, halt: 1, response: 'halt' });
    fs.mkdirSync(path.join(root, '.rea', 'turn-count.hf.json'), { recursive: true });
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: readPayload(),
      sessionId: 'hf',
      stderrWrite: () => {},
    });
    expect(r.exitCode).toBe(0);
    expect(r.action).toBe('noop');
    expect(fs.existsSync(haltPath(root))).toBe(false);
  });

  it('exactly one increment per invocation (no double-count)', async () => {
    writePolicy(root, { warn: 100, halt: 200, response: 'warn' });
    // Mix Bash and Edit calls; each invocation increments by exactly 1.
    await runBillingCapHalt({ reaRoot: root, stdinOverride: benignPayload(), sessionId: 'm', stderrWrite: () => {} });
    await runBillingCapHalt({ reaRoot: root, stdinOverride: editPayload(), sessionId: 'm', stderrWrite: () => {} });
    await runBillingCapHalt({ reaRoot: root, stdinOverride: benignPayload(), sessionId: 'm', stderrWrite: () => {} });
    expect(JSON.parse(fs.readFileSync(path.join(root, '.rea', 'turn-count.m.json'), 'utf8')).count).toBe(3);
  });

  it('response: off is silent (parseTurnBudget → null → no counter, no events)', async () => {
    writePolicy(root, { warn: 1, halt: 1, response: 'off' });
    const r = await runBillingCapHalt({
      reaRoot: root,
      stdinOverride: benignPayload(),
      sessionId: 's',
      stderrWrite: () => {},
    });
    expect(r.exitCode).toBe(0);
    expect(fs.readdirSync(path.join(root, '.rea')).some((f) => f.startsWith('turn-count'))).toBe(false);
    expect(readAudit(root)).toHaveLength(0);
  });
});
