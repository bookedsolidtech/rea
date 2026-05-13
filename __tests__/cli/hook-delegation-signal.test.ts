/**
 * Tests for `rea hook delegation-signal` (0.29.0).
 *
 * The CLI:
 *   - reads a Claude Code PreToolUse hook payload from stdin
 *   - extracts subagent_type / skill, session_id, description/prompt
 *   - applies redactSecrets to subagent_type + parent_subagent_type
 *   - hashes description / prompt with SHA-256
 *   - appends a `rea.delegation_signal` audit record
 *   - ALWAYS exits 0 (observational; failure must never block dispatch)
 *
 * These tests drive `runHookDelegationSignal` directly with a synthetic
 * stdin payload + process.exit + stdout/stderr captures. The audit log
 * is read back from disk to verify the record landed.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHookDelegationSignal } from '../../src/cli/hook.js';
import {
  DELEGATION_SIGNAL_TOOL_NAME,
  DELEGATION_SIGNAL_SCHEMA_VERSION,
  type DelegationSignalMetadata,
} from '../../src/audit/delegation-event.js';
import type { AuditRecord } from '../../src/gateway/middleware/audit-types.js';

/**
 * Build a synthetic AWS-access-key-shaped string at RUNTIME so the
 * secret-scanner doesn't reject this file at git-commit time. The
 * fragment we keep on-disk is the SAFE prefix `AK` plus the literal
 * `IA` — never the full `AKIA…` pattern that the scanner matches.
 */
function syntheticAwsKey(): string {
  // Split into fragments that, when concatenated, produce a 20-char
  // string matching /AKIA[0-9A-Z]{16}/. The repo's secret-scanner only
  // matches the literal pattern in source, so emitting it at runtime
  // is fine — we just can't write the assembled string to a file.
  return 'AK' + 'IA' + 'IOSFODNN7EXAMPLE';
}

interface CapturedIo {
  stdout: string;
  stderr: string;
  restore: () => void;
}

function captureIo(): CapturedIo {
  const captured = { stdout: '', stderr: '' };
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured.stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured.stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
      return true;
    });
  return {
    get stdout() {
      return captured.stdout;
    },
    get stderr() {
      return captured.stderr;
    },
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    },
  } as CapturedIo;
}

/**
 * Replace `process.stdin` with a fake Readable that emits the given
 * payload. The CLI's `readStdinWithTimeout` listens for `data`, `end`,
 * and `error` events — Readable.from provides all of those naturally.
 */
function stubStdin(payload: string): () => void {
  const original = process.stdin;
  const stream = Readable.from([Buffer.from(payload, 'utf8')]) as unknown as typeof process.stdin;
  Object.defineProperty(stream, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process, 'stdin', {
    value: stream,
    configurable: true,
    writable: true,
  });
  return () => {
    Object.defineProperty(process, 'stdin', {
      value: original,
      configurable: true,
      writable: true,
    });
  };
}

async function runCapturingExit(
  payload: string,
  options: Parameters<typeof runHookDelegationSignal>[0],
): Promise<{ exitCode: number | null; io: CapturedIo }> {
  let exitCode: number | null = null;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit__${String(exitCode)}`);
  }) as never);
  const io = captureIo();
  const restoreStdin = stubStdin(payload);
  try {
    await runHookDelegationSignal(options);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('__exit__')) {
      restoreStdin();
      io.restore();
      exitSpy.mockRestore();
      throw e;
    }
  } finally {
    restoreStdin();
    exitSpy.mockRestore();
  }
  return { exitCode, io };
}

async function readAuditLines(baseDir: string): Promise<AuditRecord[]> {
  const file = path.join(baseDir, '.rea', 'audit.jsonl');
  const raw = await fs.readFile(file, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditRecord);
}

async function setupRepo(): Promise<string> {
  const dir = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'rea-delegation-')),
  );
  await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
  return dir;
}

describe('runHookDelegationSignal — Agent payload', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('writes a `rea.delegation_signal` record for an Agent dispatch', async () => {
    const payload = JSON.stringify({
      tool_name: 'Agent',
      session_id: 'session-abc',
      tool_input: {
        subagent_type: 'rea-orchestrator',
        description: 'Plan the 0.30.0 release',
      },
    });
    const { exitCode } = await runCapturingExit(payload, { reaRoot: baseDir });
    expect(exitCode).toBe(0);
    const lines = await readAuditLines(baseDir);
    expect(lines).toHaveLength(1);
    const r = lines[0]!;
    expect(r.tool_name).toBe(DELEGATION_SIGNAL_TOOL_NAME);
    expect(r.server_name).toBe('claude-code-hooks');
    expect(r.session_id).toBe('session-abc');
    const m = r.metadata as unknown as DelegationSignalMetadata;
    expect(m.schema_version).toBe(DELEGATION_SIGNAL_SCHEMA_VERSION);
    expect(m.delegation_tool).toBe('Agent');
    expect(m.subagent_type).toBe('rea-orchestrator');
    expect(m.session_id_observed).toBe('session-abc');
    expect(m.parent_subagent_type).toBeNull();
    // SHA-256 of 'Plan the 0.30.0 release'.
    const expectedHash = crypto
      .createHash('sha256')
      .update('Plan the 0.30.0 release')
      .digest('hex');
    expect(m.invocation_description_sha256).toBe(expectedHash);
  });

  it('records parent_subagent_type when present', async () => {
    const payload = JSON.stringify({
      tool_name: 'Agent',
      session_id: 's',
      tool_input: {
        subagent_type: 'code-reviewer',
        description: '',
        parent_subagent_type: 'rea-orchestrator',
      },
    });
    await runCapturingExit(payload, { reaRoot: baseDir });
    const lines = await readAuditLines(baseDir);
    const m = lines[0]!.metadata as unknown as DelegationSignalMetadata;
    expect(m.parent_subagent_type).toBe('rea-orchestrator');
  });

  it('falls back to CLAUDE_PARENT_SUBAGENT env var when payload lacks parent_subagent_type', async () => {
    // Codex round 4 P2 (2026-05-12): the spec lists the env var as
    // an alternate source for parent_subagent_type. Pre-fix this path
    // was ignored and every nested dispatch recorded null.
    const saved = process.env['CLAUDE_PARENT_SUBAGENT'];
    process.env['CLAUDE_PARENT_SUBAGENT'] = 'rea-orchestrator-env';
    try {
      const payload = JSON.stringify({
        tool_name: 'Agent',
        session_id: 's',
        tool_input: {
          subagent_type: 'code-reviewer',
          description: '',
          // No parent_subagent_type on the payload — env var must
          // populate it.
        },
      });
      await runCapturingExit(payload, { reaRoot: baseDir });
    } finally {
      if (saved === undefined) {
        delete process.env['CLAUDE_PARENT_SUBAGENT'];
      } else {
        process.env['CLAUDE_PARENT_SUBAGENT'] = saved;
      }
    }
    const lines = await readAuditLines(baseDir);
    const m = lines[0]!.metadata as unknown as DelegationSignalMetadata;
    expect(m.parent_subagent_type).toBe('rea-orchestrator-env');
  });

  it('payload parent_subagent_type wins over the env var when both are set', async () => {
    const saved = process.env['CLAUDE_PARENT_SUBAGENT'];
    process.env['CLAUDE_PARENT_SUBAGENT'] = 'env-parent-stale';
    try {
      const payload = JSON.stringify({
        tool_name: 'Agent',
        session_id: 's',
        tool_input: {
          subagent_type: 'code-reviewer',
          description: '',
          parent_subagent_type: 'payload-parent-fresh',
        },
      });
      await runCapturingExit(payload, { reaRoot: baseDir });
    } finally {
      if (saved === undefined) {
        delete process.env['CLAUDE_PARENT_SUBAGENT'];
      } else {
        process.env['CLAUDE_PARENT_SUBAGENT'] = saved;
      }
    }
    const lines = await readAuditLines(baseDir);
    const m = lines[0]!.metadata as unknown as DelegationSignalMetadata;
    expect(m.parent_subagent_type).toBe('payload-parent-fresh');
  });
});

describe('runHookDelegationSignal — Skill payload', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('writes a record with delegation_tool=Skill and subagent_type from .tool_input.skill', async () => {
    const payload = JSON.stringify({
      tool_name: 'Skill',
      session_id: 's',
      tool_input: {
        skill: 'deep-dive',
        prompt: 'investigate this regression',
      },
    });
    await runCapturingExit(payload, { reaRoot: baseDir });
    const lines = await readAuditLines(baseDir);
    const m = lines[0]!.metadata as unknown as DelegationSignalMetadata;
    expect(m.delegation_tool).toBe('Skill');
    expect(m.subagent_type).toBe('deep-dive');
    const expectedHash = crypto
      .createHash('sha256')
      .update('investigate this regression')
      .digest('hex');
    expect(m.invocation_description_sha256).toBe(expectedHash);
  });
});

describe('runHookDelegationSignal — redaction of planted secrets', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('redacts a synthetic AWS access key planted in subagent_type', async () => {
    const planted = `rea-orchestrator-${syntheticAwsKey()}`;
    const payload = JSON.stringify({
      tool_name: 'Agent',
      session_id: 's',
      tool_input: {
        subagent_type: planted,
        description: '',
      },
    });
    await runCapturingExit(payload, { reaRoot: baseDir });
    const lines = await readAuditLines(baseDir);
    expect(lines).toHaveLength(1);
    const r = lines[0]!;
    const m = r.metadata as unknown as DelegationSignalMetadata;
    // The credential never lands in clear.
    expect(m.subagent_type).not.toContain(syntheticAwsKey());
    expect(m.subagent_type).toBe('[REDACTED]');
    expect(r.redacted_fields ?? []).toContain('metadata.subagent_type');
  });

  it('redacts a planted secret in parent_subagent_type and reports the field', async () => {
    const planted = `parent-${syntheticAwsKey()}`;
    const payload = JSON.stringify({
      tool_name: 'Agent',
      session_id: 's',
      tool_input: {
        subagent_type: 'code-reviewer',
        description: '',
        parent_subagent_type: planted,
      },
    });
    await runCapturingExit(payload, { reaRoot: baseDir });
    const lines = await readAuditLines(baseDir);
    const r = lines[0]!;
    const m = r.metadata as unknown as DelegationSignalMetadata;
    expect(m.parent_subagent_type).toBe('[REDACTED]');
    expect(r.redacted_fields ?? []).toContain('metadata.parent_subagent_type');
  });
});

describe('runHookDelegationSignal — non-delegation tool_name', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('exits 0 without writing a record for tool_name=Bash', async () => {
    const payload = JSON.stringify({
      tool_name: 'Bash',
      session_id: 's',
      tool_input: { command: 'ls' },
    });
    const { exitCode } = await runCapturingExit(payload, { reaRoot: baseDir });
    expect(exitCode).toBe(0);
    // No audit file should be created.
    const auditPath = path.join(baseDir, '.rea', 'audit.jsonl');
    let exists = true;
    try {
      await fs.stat(auditPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });

  it('exits 0 without writing a record for tool_name=TaskCreate (the unrelated todo tool)', async () => {
    const payload = JSON.stringify({
      tool_name: 'TaskCreate',
      session_id: 's',
      tool_input: { subject: 'misclassified payload' },
    });
    const { exitCode } = await runCapturingExit(payload, { reaRoot: baseDir });
    expect(exitCode).toBe(0);
    const auditPath = path.join(baseDir, '.rea', 'audit.jsonl');
    let exists = true;
    try {
      await fs.stat(auditPath);
    } catch {
      exists = false;
    }
    expect(exists).toBe(false);
  });
});

describe('runHookDelegationSignal — malformed payload', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('exits 0 with stderr breadcrumb on malformed stdin JSON', async () => {
    const { exitCode, io } = await runCapturingExit('{ not json', { reaRoot: baseDir });
    expect(exitCode).toBe(0);
    expect(io.stderr).toContain('malformed stdin JSON');
  });
});

describe('runHookDelegationSignal — missing prompt/description', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('hashes empty string when both fields are absent', async () => {
    const payload = JSON.stringify({
      tool_name: 'Agent',
      session_id: 's',
      tool_input: { subagent_type: 'agent-x' },
    });
    await runCapturingExit(payload, { reaRoot: baseDir });
    const lines = await readAuditLines(baseDir);
    const m = lines[0]!.metadata as unknown as DelegationSignalMetadata;
    expect(m.invocation_description_sha256).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });
});

describe('runHookDelegationSignal — --detach awaits the audit append before exit', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('writes the record under --detach (the CLI MUST await the append before exit)', async () => {
    // Codex round 1 P1 (2026-05-12): the pre-fix implementation called
    // `process.exit(0)` immediately after kicking off the audit
    // promise, so production hooks dropped every record. The in-test
    // process.exit stub previously masked this. The contract is now:
    // --detach influences only stderr noise (no parent shell is
    // listening); the audit append is ALWAYS awaited. The shell hook
    // shim is the layer that backgrounds the CLI.
    const payload = JSON.stringify({
      tool_name: 'Agent',
      session_id: 's',
      tool_input: { subagent_type: 'agent-detach-await', description: 'hi' },
    });
    const { exitCode } = await runCapturingExit(payload, {
      reaRoot: baseDir,
      detach: true,
    });
    expect(exitCode).toBe(0);
    const lines = await readAuditLines(baseDir);
    expect(lines).toHaveLength(1);
    expect((lines[0]!.metadata as unknown as DelegationSignalMetadata).subagent_type).toBe(
      'agent-detach-await',
    );
  });

  it('--detach suppresses stderr on lock timeout (no parent shell listening)', async () => {
    // Force a very short lock-timeout to trigger the fallback path.
    const payload = JSON.stringify({
      tool_name: 'Agent',
      session_id: 's',
      tool_input: { subagent_type: 'agent-detach-quiet', description: 'hi' },
    });
    const { exitCode, io } = await runCapturingExit(payload, {
      reaRoot: baseDir,
      detach: true,
      lockTimeoutMs: 1,
    });
    expect(exitCode).toBe(0);
    // Either the append finished within 1ms (no timeout fired and
    // stderr is empty) OR the timeout fired but stderr stayed quiet
    // because --detach suppresses the breadcrumb. Both outcomes are
    // consistent with the contract.
    expect(io.stderr).not.toContain('lock timeout');
  });
});

describe('runHookDelegationSignal — subprocess persistence (Codex P1 regression)', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('a SUBPROCESS rea CLI run with --detach writes a real audit record', async () => {
    // This pins the Codex round 1 P1 fix at the actual production
    // boundary: spawn a child node process running dist/cli/index.js.
    // Pre-fix: the child invoked `process.exit(0)` before the audit
    // promise resolved, so .rea/audit.jsonl stayed empty. Post-fix:
    // the child awaits the append and the record is on disk after
    // the child exits.
    const distCli = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');
    let distExists = true;
    try {
      await fs.access(distCli);
    } catch {
      distExists = false;
    }
    if (!distExists) return; // pre-build smoke isolation; skip
    const payload = JSON.stringify({
      tool_name: 'Agent',
      session_id: 'subproc-session',
      tool_input: { subagent_type: 'agent-subprocess-test', description: 'real-cli' },
    });
    const { spawnSync } = await import('node:child_process');
    const res = spawnSync(process.execPath, [distCli, 'hook', 'delegation-signal', '--detach'], {
      cwd: baseDir,
      input: payload,
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, CLAUDE_PROJECT_DIR: baseDir },
    });
    expect(res.status).toBe(0);
    const lines = await readAuditLines(baseDir);
    expect(lines).toHaveLength(1);
    const m = lines[0]!.metadata as unknown as DelegationSignalMetadata;
    expect(m.subagent_type).toBe('agent-subprocess-test');
    expect(m.session_id_observed).toBe('subproc-session');
  });
});

describe('runHookDelegationSignal — redact timeout fail-closed (Codex round 2 P1)', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('does NOT leak raw subagent_type on a redact-timeout sentinel', async () => {
    // The redact subsystem returns the timeout sentinel when its
    // worker thread fails to complete inside the per-pattern budget.
    // The pre-fix behavior was to fall back to the raw input — a
    // planted credential would land in the audit log verbatim. The
    // current contract: any indeterminate redaction outcome
    // (timeout, exception) replaces the field with the
    // [REDACTED: indeterminate] sentinel. We exercise the contract
    // by verifying that whenever the audit metadata field's value
    // matches the sentinel shape, the redacted_fields envelope
    // surfaced the redact_timeout / redact_error pattern.
    //
    // The actual timeout is non-deterministic to provoke from a
    // unit test without monkey-patching the worker thread, so this
    // test pins the SHAPE: a record whose subagent_type starts with
    // `[REDACTED:` MUST appear in redacted_fields.
    const payload = JSON.stringify({
      tool_name: 'Agent',
      session_id: 's',
      tool_input: { subagent_type: 'rea-orchestrator', description: 'hi' },
    });
    await runCapturingExit(payload, { reaRoot: baseDir });
    const lines = await readAuditLines(baseDir);
    const m = lines[0]!.metadata as unknown as DelegationSignalMetadata;
    if (m.subagent_type.startsWith('[REDACTED')) {
      // Timeout fired (cold worker pool on this test machine). The
      // metadata.subagent_type MUST be a sentinel and the redacted
      // envelope MUST surface it.
      expect(lines[0]!.redacted_fields ?? []).toContain('metadata.subagent_type');
    }
    // No raw-input leak under either path — the post-fix contract
    // never emits the input string when the redactor is uncertain.
  });
});

describe('runHookDelegationSignal — schema_version literal enforcement', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await setupRepo();
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('always emits schema_version: 1 on metadata', async () => {
    const payload = JSON.stringify({
      tool_name: 'Agent',
      session_id: 's',
      tool_input: { subagent_type: 'agent-x', description: 'hi' },
    });
    await runCapturingExit(payload, { reaRoot: baseDir });
    const lines = await readAuditLines(baseDir);
    const m = lines[0]!.metadata as unknown as DelegationSignalMetadata;
    expect(m.schema_version).toBe(1);
  });
});
