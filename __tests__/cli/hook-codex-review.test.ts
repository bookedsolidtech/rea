/**
 * Tests for `rea hook codex-review` (0.27.0).
 *
 * The CLI is the canonical Bash-direct codex invocation — runs
 * `codex exec review --json --ephemeral`, tees the raw JSONL to a
 * tempfile, writes a `codex.review` audit entry, and prints a single
 * terse status line on stderr. The verbose-paraphrasing path is
 * INTENTIONALLY not entered — these tests pin that contract.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runHookCodexReview } from '../../src/cli/hook.js';

const POLICY_HEADER = `version: "1"
profile: "test"
installed_by: "test@1.0.0"
installed_at: "2026-05-04T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths: []
notification_channel: ""
`;

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

async function runCapturingExit(
  options: Parameters<typeof runHookCodexReview>[0],
): Promise<{ exitCode: number | null; io: CapturedIo }> {
  let exitCode: number | null = null;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit__${String(exitCode)}`);
  }) as never);
  const io = captureIo();
  try {
    await runHookCodexReview(options);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('__exit__')) {
      io.restore();
      exitSpy.mockRestore();
      throw e;
    }
  } finally {
    exitSpy.mockRestore();
  }
  return { exitCode, io };
}

async function setupRepo(): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-hook-codex-')));
  await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
  await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), POLICY_HEADER);
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'README.md'), '# test\n');
  spawnSync('git', ['add', '.'], { cwd: dir });
  spawnSync('git', ['commit', '-q', '-m', 'init', '--no-gpg-sign'], { cwd: dir });
  return dir;
}

/**
 * Build a fake spawn that emits a deterministic JSONL stream containing
 * the supplied agent_message text and exits 0. Captures spawn args so
 * tests can assert on them.
 */
function makeFakeSpawn(agentText: string, captured: { cmd: string; args: readonly string[] }[]) {
  return (cmd: string, args: readonly string[]): ChildProcessWithoutNullStreams => {
    captured.push({ cmd, args });
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: '1', type: 'agent_message', text: agentText },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    // Custom Readable that emits the buffer on `_read` so the consumer
    // gets data before close fires. `Readable.from(...)` schedules
    // emission via process.nextTick batches, which (combined with
    // queueMicrotask close emission) can land close before all data
    // events when the runner has additional handlers attached
    // synchronously after spawn returns. Driving the emission ourselves
    // makes the order deterministic.
    const stdoutLines = lines;
    let pushed = false;
    const stdout = new Readable({
      read() {
        if (!pushed) {
          pushed = true;
          this.push(Buffer.from(stdoutLines));
          this.push(null);
        }
      },
    });
    const stderr = new Readable({
      read() {
        this.push(null);
      },
    });
    child.stdout = stdout as ChildProcessWithoutNullStreams['stdout'];
    child.stderr = stderr as ChildProcessWithoutNullStreams['stderr'];
    // Fire `close` only AFTER the stdout stream has actually ended.
    // This matches real ChildProcess semantics — `close` fires when
    // both stdio streams have drained AND the process has exited.
    let exited = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    const maybeClose = (): void => {
      if (exited && stdoutEnded && stderrEnded) {
        child.emit('close', 0, null);
      }
    };
    stdout.on('end', () => {
      stdoutEnded = true;
      maybeClose();
    });
    stderr.on('end', () => {
      stderrEnded = true;
      maybeClose();
    });
    queueMicrotask(() => {
      exited = true;
      maybeClose();
    });
    return child;
  };
}

describe('runHookCodexReview — pass verdict (no findings)', () => {
  let dir: string;
  let rawDir: string;
  let previousCwd: string;
  beforeEach(async () => {
    dir = await setupRepo();
    rawDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-hook-codex-raw-')));
    previousCwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(rawDir, { recursive: true, force: true });
  });

  it('exits 0, writes audit entry, tees raw JSONL to tempfile', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    const { exitCode, io } = await runCapturingExit({
      reaRoot: dir,
      rawStdoutDir: rawDir,
      spawnImpl: makeFakeSpawn('No findings.', captured),
    });
    expect(exitCode).toBe(0);

    // Stderr carries exactly the terse status line.
    const stderrLines = io.stderr.split('\n').filter((l) => l.length > 0);
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toMatch(
      /^\[codex-review\] verdict=pass findings=0 audit=[0-9a-f]+ raw=.+\.json$/,
    );
    // Stdout is empty in non-JSON mode.
    expect(io.stdout).toBe('');

    // Spawn was called with the iron-gate model overrides BEFORE `exec`.
    expect(captured).toHaveLength(1);
    const args = captured[0]!.args;
    const execIdx = args.indexOf('exec');
    const lastDashC = args.lastIndexOf('-c');
    expect(execIdx).toBeGreaterThan(lastDashC);
    expect(args).toContain('model="gpt-5.4"');
    expect(args).toContain('model_reasoning_effort="high"');
    expect(args).toContain('--json');
    expect(args).toContain('--ephemeral');

    // Audit entry written.
    const auditPath = path.join(dir, '.rea', 'audit.jsonl');
    expect(existsSync(auditPath)).toBe(true);
    const audit = await fs.readFile(auditPath, 'utf8');
    expect(audit).toMatch(/"tool_name":"codex\.review"/);
    expect(audit).toMatch(/"verdict":"pass"/);
    expect(audit).toMatch(/"finding_count":0/);
    expect(audit).toMatch(/"raw_path":/);

    // Raw JSONL was teed to disk and is parseable.
    const rawPathMatch = stderrLines[0]!.match(/raw=(.+\.json)$/);
    expect(rawPathMatch).not.toBeNull();
    const rawPath = rawPathMatch![1]!;
    expect(existsSync(rawPath)).toBe(true);
    const rawContents = await fs.readFile(rawPath, 'utf8');
    // First line must be a parseable JSONL event.
    const firstLine = rawContents.split('\n').find((l) => l.length > 0);
    expect(firstLine).toBeDefined();
    expect(() => JSON.parse(firstLine!)).not.toThrow();
  });

  it('emits canonical JSON on stdout when --json is set', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    const { exitCode, io } = await runCapturingExit({
      reaRoot: dir,
      rawStdoutDir: rawDir,
      json: true,
      spawnImpl: makeFakeSpawn('No findings.', captured),
    });
    expect(exitCode).toBe(0);
    // JSON line on stdout.
    const stdoutLines = io.stdout.split('\n').filter((l) => l.length > 0);
    expect(stdoutLines).toHaveLength(1);
    const parsed = JSON.parse(stdoutLines[0]!) as Record<string, unknown>;
    expect(parsed['verdict']).toBe('pass');
    expect(parsed['finding_count']).toBe(0);
    expect(parsed['exit_code']).toBe(0);
    expect(typeof parsed['audit_hash']).toBe('string');
    expect(typeof parsed['raw_path']).toBe('string');
    expect(typeof parsed['head_sha']).toBe('string');
  });
});

describe('runHookCodexReview — concerns + blocking verdict mapping', () => {
  let dir: string;
  let rawDir: string;
  let previousCwd: string;
  beforeEach(async () => {
    dir = await setupRepo();
    rawDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-hook-codex-raw-')));
    previousCwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(rawDir, { recursive: true, force: true });
  });

  it('exits 1 on concerns verdict (any P2, no P1)', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    const text = '- [P2] Title — README.md:1\n  Body line.';
    const { exitCode, io } = await runCapturingExit({
      reaRoot: dir,
      rawStdoutDir: rawDir,
      spawnImpl: makeFakeSpawn(text, captured),
    });
    expect(exitCode).toBe(1);
    expect(io.stderr).toMatch(/verdict=concerns findings=1/);
    const audit = await fs.readFile(path.join(dir, '.rea', 'audit.jsonl'), 'utf8');
    expect(audit).toMatch(/"verdict":"concerns"/);
    expect(audit).toMatch(/"finding_count":1/);
  });

  it('exits 2 on blocking verdict (any P1)', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    const text = '- [P1] Critical — README.md:1\n  Body.\n- [P3] Nit — README.md:2';
    const { exitCode, io } = await runCapturingExit({
      reaRoot: dir,
      rawStdoutDir: rawDir,
      spawnImpl: makeFakeSpawn(text, captured),
    });
    expect(exitCode).toBe(2);
    expect(io.stderr).toMatch(/verdict=blocking findings=2/);
    const audit = await fs.readFile(path.join(dir, '.rea', 'audit.jsonl'), 'utf8');
    expect(audit).toMatch(/"verdict":"blocking"/);
    expect(audit).toMatch(/"status":"denied"/);
  });
});

describe('runHookCodexReview — HALT short-circuits before spawn', () => {
  let dir: string;
  let rawDir: string;
  let previousCwd: string;
  beforeEach(async () => {
    dir = await setupRepo();
    rawDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-hook-codex-raw-')));
    previousCwd = process.cwd();
    process.chdir(dir);
    await fs.writeFile(path.join(dir, '.rea', 'HALT'), 'test halt\n');
  });
  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(rawDir, { recursive: true, force: true });
  });

  it('exits 2 with HALT message and never invokes spawn', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    const fakeSpawn = makeFakeSpawn('No findings.', captured);
    const { exitCode, io } = await runCapturingExit({
      reaRoot: dir,
      rawStdoutDir: rawDir,
      spawnImpl: fakeSpawn,
    });
    expect(exitCode).toBe(2);
    expect(io.stderr).toMatch(/REA HALT: test halt/);
    // Spawn was NEVER called — HALT short-circuits before resolution.
    expect(captured).toHaveLength(0);
  });
});

describe('runHookCodexReview — output discipline (the contract)', () => {
  let dir: string;
  let rawDir: string;
  let previousCwd: string;
  beforeEach(async () => {
    dir = await setupRepo();
    rawDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-hook-codex-raw-')));
    previousCwd = process.cwd();
    process.chdir(dir);
  });
  afterEach(async () => {
    process.chdir(previousCwd);
    await fs.rm(dir, { recursive: true, force: true });
    await fs.rm(rawDir, { recursive: true, force: true });
  });

  it('does NOT paraphrase findings into prose on stderr (the directive)', async () => {
    // The user directive: "the codex JSON IS the review. Do not paraphrase
    // findings into prose." Pin that the stderr output is a single status
    // line — no paraphrased findings, no recommendations of what to fix.
    const captured: { cmd: string; args: readonly string[] }[] = [];
    const verboseFinding =
      '- [P1] SQL injection in user query — src/api.ts:42\n' +
      '  The query interpolates user input directly without parameterization.\n' +
      '  Suggested: use $1, $2 placeholders.\n' +
      '\n' +
      '- [P2] Missing rate limit — src/api.ts:80\n' +
      '  Public endpoint with no rate limit.';
    const { io } = await runCapturingExit({
      reaRoot: dir,
      rawStdoutDir: rawDir,
      spawnImpl: makeFakeSpawn(verboseFinding, captured),
    });
    // Stderr is EXACTLY one status line. No prose, no body, no fix
    // suggestions leaked through.
    const stderrLines = io.stderr.split('\n').filter((l) => l.length > 0);
    expect(stderrLines).toHaveLength(1);
    expect(stderrLines[0]).toMatch(/^\[codex-review\] verdict=blocking findings=2 /);
    // The finding bodies must NOT appear in the agent-visible output.
    expect(io.stderr).not.toMatch(/SQL injection/);
    expect(io.stderr).not.toMatch(/parameterization/);
    expect(io.stderr).not.toMatch(/Suggested:/);
    expect(io.stdout).not.toMatch(/SQL injection/);
    // The full review prose IS preserved in the audit entry's summary
    // (truncated) AND in the raw JSON sink — those are the two places
    // an interested caller looks. The terse stderr line is just a
    // breadcrumb pointing to them.
    const audit = await fs.readFile(path.join(dir, '.rea', 'audit.jsonl'), 'utf8');
    expect(audit).toMatch(/"verdict":"blocking"/);
    // raw_path is in the audit metadata.
    expect(audit).toMatch(/"raw_path":".+\.json"/);
  });
});
