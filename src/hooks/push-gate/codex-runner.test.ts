import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  CodexModelUnsupportedError,
  CodexNotInstalledError,
  CodexProtocolError,
  CodexSubprocessError,
  IRON_GATE_DEFAULT_MODEL,
  IRON_GATE_MODEL_LADDER,
  isModelRejection,
  parseCodexJsonl,
  runCodexReview,
} from './codex-runner.js';
import { PUSH_GATE_DEFAULT_CODEX_MODEL } from './policy.js';
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
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'First message.' },
      }),
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
    child.stdout = Readable.from([
      Buffer.from(stdoutLines),
    ]) as ChildProcessWithoutNullStreams['stdout'];
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

  it('0.18.0 iron-gate: passes the ladder-top model + high as runtime defaults when options unset (no codex-default fallback)', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    await runCodexReview({
      baseRef: 'origin/main',
      cwd: '/tmp',
      timeoutMs: 60_000,
      spawnImpl: makeFakeSpawn(captured),
    });
    const { args } = captured[0]!;
    // Runtime hardcodes the ladder top + high regardless of options
    // (0.52.0: the default model is IRON_GATE_MODEL_LADDER[0], not a
    // literal — the ladder is the single source of truth).
    expect(args.filter((a) => a === '-c')).toHaveLength(2);
    expect(args).toContain(`model="${IRON_GATE_MODEL_LADDER[0]}"`);
    expect(args).toContain('model_reasoning_effort="high"');
    // Overrides land BEFORE the exec subcommand.
    const lastDashC = args.lastIndexOf('-c');
    const execIdx = args.indexOf('exec');
    expect(execIdx).toBeGreaterThan(lastDashC);
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

  // 0.16.3 helix-016.1 #1: when spawn succeeds but the child emits an
  // ENOENT-class 'error' event (the async-failure shape that leaked
  // through the synchronous try/catch pre-fix), the runner must surface
  // CodexNotInstalledError so index.ts formats the headline as the
  // friendly install hint rather than an opaque subprocess message.
  it('throws CodexNotInstalledError when child emits async ENOENT error', async () => {
    const fakeSpawn = (): ChildProcessWithoutNullStreams => {
      const child = new EventEmitter() as ChildProcessWithoutNullStreams;
      child.stdout = Readable.from([]) as ChildProcessWithoutNullStreams['stdout'];
      child.stderr = Readable.from([]) as ChildProcessWithoutNullStreams['stderr'];
      child.kill = (() => true) as ChildProcessWithoutNullStreams['kill'];
      queueMicrotask(() => {
        const err = new Error('spawn codex ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        child.emit('error', err);
      });
      return child;
    };
    await expect(
      runCodexReview({
        baseRef: 'origin/main',
        cwd: '/tmp',
        timeoutMs: 60_000,
        spawnImpl: fakeSpawn,
      }),
    ).rejects.toBeInstanceOf(CodexNotInstalledError);
  });

  it('CodexNotInstalledError carries the install-hint headline message', () => {
    const e = new CodexNotInstalledError();
    expect(e.message).toMatch(/codex CLI not found on PATH/);
    expect(e.message).toMatch(/npm i -g @openai\/codex/);
    expect(e.message).toMatch(/review\.codex_required: false/);
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

// ---------------------------------------------------------------------------
// 0.52.0 — silent-pass fix (error events) + model ladder
// ---------------------------------------------------------------------------

/** The observed codex error-event shape for an unsupported model (exit 0!). */
function modelUnsupportedLine(model: string): string {
  return JSON.stringify({
    type: 'error',
    status: 400,
    error: {
      type: 'invalid_request_error',
      message: `The '${model}' model is not supported when using Codex with a ChatGPT account.`,
    },
  });
}

/**
 * Scripted spawn: each call pops the next stdout script entry and exits 0.
 * Lets ladder tests fail attempt 1 (error event) and succeed attempt 2.
 */
function makeScriptedSpawn(
  scripts: string[],
  captured: { cmd: string; args: readonly string[] }[],
) {
  let call = 0;
  return (cmd: string, args: readonly string[]): ChildProcessWithoutNullStreams => {
    captured.push({ cmd, args });
    const stdout = scripts[Math.min(call, scripts.length - 1)]!;
    call += 1;
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdoutStream = Readable.from([Buffer.from(stdout)]);
    child.stdout = stdoutStream as ChildProcessWithoutNullStreams['stdout'];
    child.stderr = Readable.from([]) as ChildProcessWithoutNullStreams['stderr'];
    // Emit `close` only AFTER stdout fully drains — a bare queueMicrotask
    // races the stream's data delivery and the runner can see empty stdout
    // (these tests assert on STREAM CONTENT, unlike the argv-only ones above).
    stdoutStream.on('end', () => queueMicrotask(() => child.emit('close', 0, null)));
    return child;
  };
}

const OK_STREAM = [
  JSON.stringify({ type: 'thread.started', thread_id: 't' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({
    type: 'item.completed',
    item: { id: '1', type: 'agent_message', text: 'No findings.' },
  }),
  JSON.stringify({ type: 'turn.completed' }),
].join('\n');

describe('parseCodexJsonl — error events (0.52.0 silent-pass fix)', () => {
  it('collects nested error.message from the observed 400 shape', () => {
    const r = parseCodexJsonl(
      [JSON.stringify({ type: 'turn.started' }), modelUnsupportedLine('gpt-9.9')].join('\n'),
    );
    expect(r.errorMessages).toHaveLength(1);
    expect(r.errorMessages[0]).toMatch(/model is not supported/);
    expect(r.reviewText).toBe('');
  });

  it('collects flat message variants too', () => {
    const r = parseCodexJsonl(JSON.stringify({ type: 'error', message: 'boom' }));
    expect(r.errorMessages).toEqual(['boom']);
  });

  it('clean streams report zero errorMessages', () => {
    expect(parseCodexJsonl(OK_STREAM).errorMessages).toEqual([]);
  });
});

describe('runCodexReview — errored, review-less runs can NEVER pass (0.52.0)', () => {
  it('unsupported-model error event + exit 0 → CodexModelUnsupportedError (was: silent pass)', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    await expect(
      runCodexReview({
        baseRef: 'origin/main',
        cwd: '/tmp',
        timeoutMs: 60_000,
        model: 'gpt-5.6-typo', // EXPLICIT pin — no ladder substitution
        spawnImpl: makeScriptedSpawn([modelUnsupportedLine('gpt-5.6-typo')], captured),
      }),
    ).rejects.toBeInstanceOf(CodexModelUnsupportedError);
    // Explicit pin: exactly ONE attempt, never substituted.
    expect(captured).toHaveLength(1);
  });

  it('generic error event with no review text → CodexProtocolError, not pass', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    await expect(
      runCodexReview({
        baseRef: 'origin/main',
        cwd: '/tmp',
        timeoutMs: 60_000,
        model: 'gpt-5.5',
        spawnImpl: makeScriptedSpawn(
          [JSON.stringify({ type: 'error', message: 'stream disconnected' })],
          captured,
        ),
      }),
    ).rejects.toBeInstanceOf(CodexProtocolError);
  });

  it('error event ALONGSIDE real review text is tolerated (review completed)', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    const stream = [
      JSON.stringify({ type: 'error', message: 'transient warning' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: '1', type: 'agent_message', text: 'Review text.' },
      }),
    ].join('\n');
    const r = await runCodexReview({
      baseRef: 'origin/main',
      cwd: '/tmp',
      timeoutMs: 60_000,
      model: 'gpt-5.5',
      spawnImpl: makeScriptedSpawn([stream], captured),
    });
    expect(r.reviewText).toBe('Review text.');
  });

  it('legit empty diff (events, no errors, no messages) still returns empty text', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    const stream = [
      JSON.stringify({ type: 'thread.started' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    const r = await runCodexReview({
      baseRef: 'origin/main',
      cwd: '/tmp',
      timeoutMs: 60_000,
      model: 'gpt-5.5',
      spawnImpl: makeScriptedSpawn([stream], captured),
    });
    expect(r.reviewText).toBe('');
    expect(r.eventCount).toBe(3);
  });
});

describe('runCodexReview — model ladder (0.52.0, default case only)', () => {
  it('default rides the ladder top on success (modelUsed, no fallback)', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    const r = await runCodexReview({
      baseRef: 'origin/main',
      cwd: '/tmp',
      timeoutMs: 60_000,
      spawnImpl: makeScriptedSpawn([OK_STREAM], captured),
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]!.args).toContain(`model="${IRON_GATE_MODEL_LADDER[0]}"`);
    expect(r.modelUsed).toBe(IRON_GATE_MODEL_LADDER[0]);
    expect(r.modelFellBack).toBe(false);
  });

  it('default falls to the next ladder entry when the top is unsupported', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    const r = await runCodexReview({
      baseRef: 'origin/main',
      cwd: '/tmp',
      timeoutMs: 60_000,
      spawnImpl: makeScriptedSpawn(
        [modelUnsupportedLine(IRON_GATE_MODEL_LADDER[0]!), OK_STREAM],
        captured,
      ),
    });
    expect(captured).toHaveLength(2);
    expect(captured[0]!.args).toContain(`model="${IRON_GATE_MODEL_LADDER[0]}"`);
    expect(captured[1]!.args).toContain(`model="${IRON_GATE_MODEL_LADDER[1]}"`);
    expect(r.modelUsed).toBe(IRON_GATE_MODEL_LADDER[1]);
    expect(r.modelFellBack).toBe(true);
  });

  it('ladder exhausted (every entry unsupported) → CodexModelUnsupportedError', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    await expect(
      runCodexReview({
        baseRef: 'origin/main',
        cwd: '/tmp',
        timeoutMs: 60_000,
        spawnImpl: makeScriptedSpawn(
          IRON_GATE_MODEL_LADDER.map((m) => modelUnsupportedLine(m)),
          captured,
        ),
      }),
    ).rejects.toBeInstanceOf(CodexModelUnsupportedError);
    expect(captured).toHaveLength(IRON_GATE_MODEL_LADDER.length);
  });

  it('non-model failures do NOT trigger ladder fallback (single attempt)', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    await expect(
      runCodexReview({
        baseRef: 'origin/main',
        cwd: '/tmp',
        timeoutMs: 60_000,
        spawnImpl: makeScriptedSpawn(
          [JSON.stringify({ type: 'error', message: 'internal server error' })],
          captured,
        ),
      }),
    ).rejects.toBeInstanceOf(CodexProtocolError);
    expect(captured).toHaveLength(1);
  });
});

describe('model-default parity (0.52.0)', () => {
  it('IRON_GATE_DEFAULT_MODEL is the ladder top', () => {
    expect(IRON_GATE_DEFAULT_MODEL).toBe(IRON_GATE_MODEL_LADDER[0]);
  });
  it('PUSH_GATE_DEFAULT_CODEX_MODEL matches the ladder top', () => {
    expect(PUSH_GATE_DEFAULT_CODEX_MODEL).toBe(IRON_GATE_MODEL_LADDER[0]);
  });
});

describe('runCodexReview — onAttempt attribution (0.52.0 review P3)', () => {
  it('reports the rung that actually failed, not the ladder top', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    const attempts: string[] = [];
    // Rung 1 (5.5): model-unsupported → ladder falls. Rung 2 (5.4):
    // generic error event → propagates. The LAST onAttempt call must be
    // the failing rung (5.4), so error-path audits blame the right model.
    await expect(
      runCodexReview({
        baseRef: 'origin/main',
        cwd: '/tmp',
        timeoutMs: 60_000,
        onAttempt: (m) => attempts.push(m),
        spawnImpl: makeScriptedSpawn(
          [
            modelUnsupportedLine(IRON_GATE_MODEL_LADDER[0]!),
            JSON.stringify({ type: 'error', message: 'internal server error' }),
          ],
          captured,
        ),
      }),
    ).rejects.toBeInstanceOf(CodexProtocolError);
    // Two rungs are scripted, so exactly the first two are attempted —
    // asserted as a slice rather than the whole ladder so prepending a new
    // flagship (0.54.0 added gpt-6-astra) does not falsify the assertion.
    expect(attempts).toEqual(IRON_GATE_MODEL_LADDER.slice(0, 2));
    expect(attempts[attempts.length - 1]).toBe(IRON_GATE_MODEL_LADDER[1]);
  });

  it('onAttempt callback errors never break the run', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    const r = await runCodexReview({
      baseRef: 'origin/main',
      cwd: '/tmp',
      timeoutMs: 60_000,
      onAttempt: () => {
        throw new Error('observer exploded');
      },
      spawnImpl: makeScriptedSpawn([OK_STREAM], captured),
    });
    expect(r.reviewText).toBe('No findings.');
  });
});

// ---------------------------------------------------------------------------
// 0.54.0 — non-zero exit: classify from STDOUT, not from an empty stderr
// ---------------------------------------------------------------------------

/**
 * Scripted spawn whose children exit NON-ZERO. Codex's observed failure shape
 * is exactly this: a JSON `error` event on stdout, an EMPTY stderr, exit 1.
 */
function makeFailingSpawn(
  scripts: string[],
  captured: { cmd: string; args: readonly string[] }[],
  opts: { exitCode?: number; stderr?: string } = {},
) {
  let call = 0;
  return (cmd: string, args: readonly string[]): ChildProcessWithoutNullStreams => {
    captured.push({ cmd, args });
    const stdout = scripts[Math.min(call, scripts.length - 1)]!;
    call += 1;
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    const stdoutStream = Readable.from([Buffer.from(stdout)]);
    child.stdout = stdoutStream as ChildProcessWithoutNullStreams['stdout'];
    child.stderr = Readable.from(
      opts.stderr !== undefined && opts.stderr.length > 0 ? [Buffer.from(opts.stderr)] : [],
    ) as ChildProcessWithoutNullStreams['stderr'];
    stdoutStream.on('end', () =>
      queueMicrotask(() => child.emit('close', opts.exitCode ?? 1, null)),
    );
    return child;
  };
}

/** The observed codex 404 shape — the wording the pre-0.54.0 regex missed. */
function modelNotFoundLine(model: string): string {
  return JSON.stringify({
    type: 'error',
    status: 404,
    error: {
      type: 'invalid_request_error',
      message: `The model \`${model}\` does not exist or you do not have access to it.`,
    },
  });
}

describe('isModelRejection (0.54.0)', () => {
  it('matches the 400 "not supported" wording', () => {
    expect(
      isModelRejection("The 'gpt-5.4' model is not supported when using Codex with a ChatGPT account."),
    ).toBe(true);
  });

  it('matches the 404 "does not exist or you do not have access" wording', () => {
    expect(
      isModelRejection('The model `gpt-5.5` does not exist or you do not have access to it.'),
    ).toBe(true);
  });

  it('does not match unrelated run failures', () => {
    expect(isModelRejection('internal server error')).toBe(false);
    expect(isModelRejection('connection reset by peer')).toBe(false);
  });
});

describe('runCodexReview — non-zero exit classification (0.54.0)', () => {
  it('non-zero exit + model-rejection on stdout → ladder falls to the next rung', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    let call = 0;
    // Rung 1 exits 1 with a 404 error event on stdout (the live failure that
    // killed every unpinned install). Rung 2 succeeds normally.
    const spawnImpl = (
      cmd: string,
      args: readonly string[],
    ): ChildProcessWithoutNullStreams => {
      const isFirst = call === 0;
      call += 1;
      if (isFirst) {
        return makeFailingSpawn([modelNotFoundLine(IRON_GATE_MODEL_LADDER[0]!)], captured)(
          cmd,
          args,
        );
      }
      return makeScriptedSpawn([OK_STREAM], captured)(cmd, args);
    };
    const r = await runCodexReview({
      baseRef: 'origin/main',
      cwd: '/tmp',
      timeoutMs: 60_000,
      spawnImpl,
    });
    expect(captured).toHaveLength(2);
    expect(captured[0]!.args).toContain(`model="${IRON_GATE_MODEL_LADDER[0]}"`);
    expect(captured[1]!.args).toContain(`model="${IRON_GATE_MODEL_LADDER[1]}"`);
    expect(r.modelUsed).toBe(IRON_GATE_MODEL_LADDER[1]);
    expect(r.modelFellBack).toBe(true);
  });

  it('an EXPLICIT pin rejected on a non-zero exit fails loudly, never silently', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    await expect(
      runCodexReview({
        baseRef: 'origin/main',
        cwd: '/tmp',
        timeoutMs: 60_000,
        model: 'gpt-5.5',
        spawnImpl: makeFailingSpawn([modelNotFoundLine('gpt-5.5')], captured),
      }),
    ).rejects.toBeInstanceOf(CodexModelUnsupportedError);
    // Explicit pin is a single candidate — no substitution.
    expect(captured).toHaveLength(1);
  });

  it('non-model failure on a non-zero exit surfaces the stdout tail (was: empty)', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    let err: unknown;
    try {
      await runCodexReview({
        baseRef: 'origin/main',
        cwd: '/tmp',
        timeoutMs: 60_000,
        model: 'gpt-6-astra',
        spawnImpl: makeFailingSpawn(
          [JSON.stringify({ type: 'error', status: 500, message: 'upstream exploded' })],
          captured,
        ),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodexSubprocessError);
    const message = (err as CodexSubprocessError).message;
    // The pre-0.54.0 message ended at `stderr tail: ` with nothing after it.
    expect(message).toContain('stderr tail:');
    expect(message).toContain('codex reported on stdout:');
    expect(message).toContain('upstream exploded');
  });

  it('a real stderr tail is still reported, and stdout is NOT appended', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    let err: unknown;
    try {
      await runCodexReview({
        baseRef: 'origin/main',
        cwd: '/tmp',
        timeoutMs: 60_000,
        model: 'gpt-6-astra',
        spawnImpl: makeFailingSpawn([''], captured, { stderr: 'codex: fatal: bad config' }),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodexSubprocessError);
    const message = (err as CodexSubprocessError).message;
    expect(message).toContain('codex: fatal: bad config');
    expect(message).not.toContain('codex reported on stdout:');
  });

  it('unparseable stdout on a non-zero exit reports the raw tail, not a protocol error', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    let err: unknown;
    try {
      await runCodexReview({
        baseRef: 'origin/main',
        cwd: '/tmp',
        timeoutMs: 60_000,
        model: 'gpt-6-astra',
        spawnImpl: makeFailingSpawn(['panic: not json at all'], captured),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CodexSubprocessError);
    expect((err as CodexSubprocessError).message).toContain('panic: not json at all');
  });

  it('FAIL-CLOSED: a non-zero exit never returns a review, even with review text', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    await expect(
      runCodexReview({
        baseRef: 'origin/main',
        cwd: '/tmp',
        timeoutMs: 60_000,
        model: 'gpt-6-astra',
        spawnImpl: makeFailingSpawn([OK_STREAM], captured),
      }),
    ).rejects.toBeInstanceOf(CodexSubprocessError);
  });
});

// ---------------------------------------------------------------------------
// codex round-1 P2 — rejection classification must be narrow AND unambiguous
// ---------------------------------------------------------------------------

describe('isModelRejection — does not swallow config/filesystem failures', () => {
  it('does NOT match a missing model CONFIGURATION file', () => {
    expect(isModelRejection('The model configuration file does not exist.')).toBe(false);
  });

  it('does NOT match a model CACHE DIRECTORY permission failure', () => {
    expect(isModelRejection('You do not have access to the model cache directory.')).toBe(false);
  });

  it('still matches the provider 404 phrase in full', () => {
    expect(
      isModelRejection('The model `gpt-5.5` does not exist or you do not have access to it.'),
    ).toBe(true);
  });
});

describe('mixed error streams stay fail-closed (no weaker-model retry)', () => {
  it('rejection + an unrelated fatal error on a non-zero exit → CodexSubprocessError, ONE attempt', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    await expect(
      runCodexReview({
        baseRef: 'origin/main',
        cwd: '/tmp',
        timeoutMs: 60_000,
        spawnImpl: makeFailingSpawn(
          [
            [
              modelNotFoundLine(IRON_GATE_MODEL_LADDER[0]!),
              JSON.stringify({ type: 'error', status: 500, message: 'upstream exploded' }),
            ].join('\n'),
          ],
          captured,
        ),
      }),
    ).rejects.toBeInstanceOf(CodexSubprocessError);
    // The ladder must NOT advance — a mixed failure is not a model problem.
    expect(captured).toHaveLength(1);
  });

  it('rejection + an unrelated fatal error on exit 0 → CodexProtocolError, ONE attempt', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    await expect(
      runCodexReview({
        baseRef: 'origin/main',
        cwd: '/tmp',
        timeoutMs: 60_000,
        spawnImpl: makeScriptedSpawn(
          [
            [
              modelUnsupportedLine(IRON_GATE_MODEL_LADDER[0]!),
              JSON.stringify({ type: 'error', message: 'disk full' }),
            ].join('\n'),
          ],
          captured,
        ),
      }),
    ).rejects.toBeInstanceOf(CodexProtocolError);
    expect(captured).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 0.54.1 — turn.failed is the authoritative failure signal
// ---------------------------------------------------------------------------

/**
 * The REAL stream a dead ladder rung produces, captured live on an account
 * lacking the requested model (15 lines / 3065 bytes, stderr 0 bytes, exit 1).
 * Abridged to the shape-bearing lines. Note the two traps it contains:
 *   - an `item.completed` whose `item.type` is `error`, leading with a
 *     TRANSPORT note before the 404;
 *   - an `item.completed`/`agent_message` carrying PROSE, which makes
 *     reviewText NON-empty and defeats the 0.52.0 empty-review guard;
 *   - `turn.failed` last.
 */
const DEAD_RUNG_STREAM = [
  JSON.stringify({ type: 'thread.started', thread_id: 't' }),
  JSON.stringify({ type: 'turn.started' }),
  JSON.stringify({
    type: 'error',
    message:
      'Reconnecting... 2/5 (unexpected status 404 Not Found: The model `gpt-5.5` does not exist or you do not have access to it.)',
  }),
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_0',
      type: 'error',
      message:
        'Falling back from WebSockets to HTTPS transport. unexpected status 404 Not Found: The model `gpt-5.5` does not exist or you do not have access to it.',
    },
  }),
  JSON.stringify({
    type: 'error',
    message:
      'unexpected status 404 Not Found: The model `gpt-5.5` does not exist or you do not have access to it., url: https://chatgpt.com/backend-api/codex/responses',
  }),
  JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_1',
      type: 'agent_message',
      text: 'Review was interrupted. Please re-run /review and wait for it to complete.',
    },
  }),
  JSON.stringify({
    type: 'turn.failed',
    error: {
      message:
        'unexpected status 404 Not Found: The model `gpt-5.5` does not exist or you do not have access to it.',
    },
  }),
].join('\n');

describe('parseCodexJsonl — turn.failed + item-level errors (0.54.1)', () => {
  it('flags turnFailed and captures its message', () => {
    const r = parseCodexJsonl(DEAD_RUNG_STREAM);
    expect(r.turnFailed).toBe(true);
    expect(r.turnFailedMessage).toMatch(/does not exist or you do not have access/);
  });

  it('collects item.type:error separately from top-level errors', () => {
    const r = parseCodexJsonl(DEAD_RUNG_STREAM);
    expect(r.itemErrorMessages).toHaveLength(1);
    expect(r.itemErrorMessages[0]).toContain('Falling back from WebSockets');
    // The transport note must NOT be in the classification input.
    expect(r.errorMessages.join(' ')).not.toContain('Falling back from WebSockets');
  });

  it('the prose agent_message DOES land in reviewText — which is why exit code alone is not enough', () => {
    const r = parseCodexJsonl(DEAD_RUNG_STREAM);
    expect(r.reviewText).toContain('Review was interrupted');
    expect(r.reviewText.length).toBeGreaterThan(0);
  });

  it('a clean stream reports turnFailed false', () => {
    const r = parseCodexJsonl(OK_STREAM);
    expect(r.turnFailed).toBe(false);
    expect(r.itemErrorMessages).toHaveLength(0);
  });
});

describe('runCodexReview — turn.failed never yields a review (0.54.1)', () => {
  it('EXIT 0 + turn.failed + prose reviewText → throws, does NOT rubber-stamp a pass', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    // This is the silent-pass hole: exit 0, non-empty reviewText, zero
    // findings. Pre-0.54.1 this returned a successful review → verdict pass.
    await expect(
      runCodexReview({
        baseRef: 'origin/main',
        cwd: '/tmp',
        timeoutMs: 60_000,
        model: 'gpt-6-astra', // explicit pin: no ladder, so the throw is visible
        spawnImpl: makeScriptedSpawn([DEAD_RUNG_STREAM], captured),
      }),
    ).rejects.toThrow(/does not exist or you do not have access|turn\.failed/);
    expect(captured).toHaveLength(1);
  });

  it('EXIT 0 + turn.failed on the DEFAULT ladder → falls through to the next rung', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    const r = await runCodexReview({
      baseRef: 'origin/main',
      cwd: '/tmp',
      timeoutMs: 60_000,
      spawnImpl: makeScriptedSpawn([DEAD_RUNG_STREAM, OK_STREAM], captured),
    });
    expect(captured).toHaveLength(2);
    expect(r.modelUsed).toBe(IRON_GATE_MODEL_LADDER[1]);
    expect(r.modelFellBack).toBe(true);
    expect(r.reviewText).toBe('No findings.');
  });

  it('turn.failed with a NON-model reason → CodexProtocolError, ladder does NOT advance', async () => {
    const captured: { cmd: string; args: readonly string[] }[] = [];
    const stream = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: '1', type: 'agent_message', text: 'Review was interrupted.' },
      }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'upstream exploded' } }),
    ].join('\n');
    await expect(
      runCodexReview({
        baseRef: 'origin/main',
        cwd: '/tmp',
        timeoutMs: 60_000,
        spawnImpl: makeScriptedSpawn([stream], captured),
      }),
    ).rejects.toBeInstanceOf(CodexProtocolError);
    expect(captured).toHaveLength(1);
  });

  it('a bare transport note must NOT stick the gate closed on the model path', async () => {
    // itemErrorMessages is diagnostic-only: a transport note carrying no 404
    // must not defeat the all-messages-agree test and block the ladder.
    const captured: { cmd: string; args: readonly string[] }[] = [];
    const stream = [
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: '0', type: 'error', message: 'Falling back from WebSockets to HTTPS transport.' },
      }),
      JSON.stringify({
        type: 'error',
        message: 'The model `gpt-6-astra` does not exist or you do not have access to it.',
      }),
      JSON.stringify({ type: 'turn.failed', error: { message: 'The model `gpt-6-astra` does not exist or you do not have access to it.' } }),
    ].join('\n');
    const r = await runCodexReview({
      baseRef: 'origin/main',
      cwd: '/tmp',
      timeoutMs: 60_000,
      spawnImpl: makeScriptedSpawn([stream, OK_STREAM], captured),
    });
    // Ladder advanced rather than refusing: the transport note was ignored.
    expect(captured).toHaveLength(2);
    expect(r.modelFellBack).toBe(true);
  });
});
