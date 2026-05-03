import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CodexProtocolError,
  parseCodexJsonl,
  runCodexReview,
} from './codex-runner.js';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

describe('parseCodexJsonl', () => {
  it('extracts a single agent_message text from a minimal stream', () => {
    const stream = [
      JSON.stringify({ type: 'thread.started', thread_id: 'x' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: '1', type: 'agent_message', text: 'Looks good.' },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    const r = parseCodexJsonl(stream);
    expect(r.reviewText).toBe('Looks good.');
    expect(r.eventCount).toBe(4);
  });

  it('concatenates multiple agent_message items across turns', () => {
    const stream = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'First message.' } }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Second message.' },
      }),
    ].join('\n');
    const r = parseCodexJsonl(stream);
    expect(r.reviewText).toContain('First message.');
    expect(r.reviewText).toContain('Second message.');
    // Separator should be a blank line for readability.
    expect(r.reviewText).toBe('First message.\n\nSecond message.');
  });

  it('ignores command_execution and other non-agent_message items', () => {
    const stream = [
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'git diff',
          aggregated_output: 'diff text',
          exit_code: 0,
          status: 'completed',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'The final review.' },
      }),
    ].join('\n');
    const r = parseCodexJsonl(stream);
    expect(r.reviewText).toBe('The final review.');
  });

  it('tolerates non-JSON lines (skips them silently)', () => {
    const stream = [
      'Warning: some shell noise bleeding onto stdout',
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Review text' },
      }),
    ].join('\n');
    const r = parseCodexJsonl(stream);
    expect(r.reviewText).toBe('Review text');
    expect(r.eventCount).toBe(1);
  });

  it('returns empty reviewText when only lifecycle events present (e.g. empty diff)', () => {
    const stream = [
      JSON.stringify({ type: 'thread.started' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    const r = parseCodexJsonl(stream);
    expect(r.reviewText).toBe('');
    expect(r.eventCount).toBe(3);
  });

  it('throws CodexProtocolError when stdout is all-non-JSON and non-empty', () => {
    expect(() => parseCodexJsonl('zsh: command not found: codex\nexit 127\n')).toThrow(
      CodexProtocolError,
    );
  });

  it('returns empty result for truly empty stdout (no error)', () => {
    const r = parseCodexJsonl('');
    expect(r.reviewText).toBe('');
    expect(r.eventCount).toBe(0);
  });
});

/**
 * Build a fake child process that emits a deterministic JSONL stream and
 * exits 0. Captures the args it was spawned with into a shared `captured`
 * array so tests can assert on them.
 */
function makeFakeSpawn(captured: { cmd: string; args: readonly string[] }[]) {
  return (cmd: string, args: readonly string[]): ChildProcessWithoutNullStreams => {
    captured.push({ cmd, args });
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdoutLines = [
      JSON.stringify({ type: 'thread.started', thread_id: 't' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: '1', type: 'agent_message', text: 'No findings.' },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    child.stdout = Readable.from([Buffer.from(stdoutLines)]) as ChildProcessWithoutNullStreams['stdout'];
    child.stderr = Readable.from([]) as ChildProcessWithoutNullStreams['stderr'];
    // Synthesize the `close` event after a microtask so callers can wire
    // listeners first.
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };
}

describe('runCodexReview — model + reasoning_effort plumbing (0.14.0)', () => {
  it('passes -c model="<value>" before `exec` when options.model is set', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    await runCodexReview({
      baseRef: 'origin/main',
      cwd: '/tmp',
      timeoutMs: 60_000,
      model: 'gpt-5.4',
      spawnImpl: makeFakeSpawn(captured),
    });
    expect(captured).toHaveLength(1);
    const { args } = captured[0]!;
    // The override must precede `exec` (top-level codex flag, not exec flag).
    const cIndex = args.indexOf('-c');
    const execIndex = args.indexOf('exec');
    expect(cIndex).toBeGreaterThanOrEqual(0);
    expect(execIndex).toBeGreaterThan(cIndex);
    // Value is TOML-quoted.
    expect(args[cIndex + 1]).toBe('model="gpt-5.4"');
  });

  it('passes -c model_reasoning_effort="<value>" when options.reasoningEffort is set', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    await runCodexReview({
      baseRef: 'origin/main',
      cwd: '/tmp',
      timeoutMs: 60_000,
      reasoningEffort: 'high',
      spawnImpl: makeFakeSpawn(captured),
    });
    const { args } = captured[0]!;
    expect(args).toContain('model_reasoning_effort="high"');
  });

  it('passes BOTH -c flags when both are set (iron-gate combination)', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    await runCodexReview({
      baseRef: 'origin/main',
      cwd: '/tmp',
      timeoutMs: 60_000,
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      spawnImpl: makeFakeSpawn(captured),
    });
    const { args } = captured[0]!;
    expect(args.filter((a) => a === '-c')).toHaveLength(2);
    expect(args).toContain('model="gpt-5.4"');
    expect(args).toContain('model_reasoning_effort="high"');
    // Both override pairs must come BEFORE the `exec` subcommand.
    const lastDashC = args.lastIndexOf('-c');
    const execIdx = args.indexOf('exec');
    expect(execIdx).toBeGreaterThan(lastDashC);
  });

  it('passes NO -c override flags when neither option is set (preserves codex default behavior)', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    await runCodexReview({
      baseRef: 'origin/main',
      cwd: '/tmp',
      timeoutMs: 60_000,
      spawnImpl: makeFakeSpawn(captured),
    });
    const { args } = captured[0]!;
    expect(args).not.toContain('-c');
    expect(args[0]).toBe('exec');
  });

  it('escapes embedded quotes in the model name to prevent TOML injection', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    await runCodexReview({
      baseRef: 'origin/main',
      cwd: '/tmp',
      timeoutMs: 60_000,
      model: 'malicious"', // would close the TOML string
      spawnImpl: makeFakeSpawn(captured),
    });
    const { args } = captured[0]!;
    // The `"` must be escaped to `\"` so the TOML parser sees one string,
    // not a closed string followed by a token.
    expect(args).toContain('model="malicious\\""');
  });

  it('preserves original baseRef and --json --ephemeral flags after the overrides', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    await runCodexReview({
      baseRef: 'feature/branch',
      cwd: '/tmp',
      timeoutMs: 60_000,
      model: 'gpt-5.4',
      reasoningEffort: 'high',
      spawnImpl: makeFakeSpawn(captured),
    });
    const { args } = captured[0]!;
    // Argument order after overrides: exec review --base <ref> --json --ephemeral
    const execIdx = args.indexOf('exec');
    expect(args.slice(execIdx)).toEqual([
      'exec',
      'review',
      '--base',
      'feature/branch',
      '--json',
      '--ephemeral',
    ]);
  });
});
