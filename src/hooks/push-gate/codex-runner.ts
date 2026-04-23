/**
 * Codex CLI runner for the push-gate.
 *
 * Shells to `codex exec review --base <ref> --json --ephemeral` and consumes
 * the JSONL event stream. Every event is parsed; the sequence of
 * `agent_message` items becomes the review text that `findings.ts` then
 * parses for P1/P2/P3 markers.
 *
 * Errors are typed so `index.ts` can distinguish:
 *
 *   - `CodexNotInstalledError`  → clear install-Codex prompt
 *   - `CodexTimeoutError`       → `review.timeout_ms` exceeded; kill signal
 *   - `CodexProtocolError`      → stdout was not JSONL or lacked agent output
 *   - `CodexSubprocessError`    → non-zero exit with captured stderr
 *
 * The `GitExecutor` interface is a narrow shim around `git` invocations the
 * gate needs (base resolution, diff-names, HEAD resolution). Extracted so
 * `./base.ts` and `./index.ts` can be unit-tested with deterministic fakes
 * and so the one git dependency surface is in one place.
 */

import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CodexNotInstalledError extends Error {
  readonly kind = 'not-installed' as const;
  constructor() {
    super(
      'codex CLI not found on PATH. Install with `npm i -g @openai/codex`, or set `review.codex_required: false` in .rea/policy.yaml to disable the push-gate.',
    );
    this.name = 'CodexNotInstalledError';
  }
}

export class CodexTimeoutError extends Error {
  readonly kind = 'timeout' as const;
  constructor(public readonly timeoutMs: number) {
    super(
      `codex exec review exceeded policy.review.timeout_ms (${timeoutMs}ms). The subprocess was killed. Consider raising the timeout, narrowing the diff, or running /codex-review manually to debug.`,
    );
    this.name = 'CodexTimeoutError';
  }
}

export class CodexProtocolError extends Error {
  readonly kind = 'protocol' as const;
  constructor(public readonly detail: string, public readonly sampleLine?: string) {
    super(
      `codex exec review produced unexpected output: ${detail}${
        sampleLine !== undefined ? ` (sample: ${sampleLine.slice(0, 120)})` : ''
      }`,
    );
    this.name = 'CodexProtocolError';
  }
}

export class CodexSubprocessError extends Error {
  readonly kind = 'subprocess' as const;
  constructor(
    public readonly exitCode: number | null,
    public readonly signal: NodeJS.Signals | null,
    public readonly stderrTail: string,
  ) {
    super(
      `codex exec review exited ${
        exitCode !== null ? `with code ${exitCode}` : `via signal ${signal ?? 'unknown'}`
      }. stderr tail: ${stderrTail.slice(-800)}`,
    );
    this.name = 'CodexSubprocessError';
  }
}

export type CodexRunError =
  | CodexNotInstalledError
  | CodexTimeoutError
  | CodexProtocolError
  | CodexSubprocessError;

// ---------------------------------------------------------------------------
// Git executor — narrow injection surface for base resolution + HEAD probe.
// ---------------------------------------------------------------------------

export interface GitExecutor {
  /** `git rev-parse <args>`. Returns stdout trimmed or '' on non-zero exit. */
  tryRevParse(args: string[]): string;
  /** `git symbolic-ref <ref>`. Returns stdout trimmed or '' on non-zero. */
  trySymbolicRef(ref: string): string;
  /** `git rev-parse HEAD`. Returns the 40-char SHA or '' on non-zero. */
  headSha(): string;
  /** `git diff --name-only <base> <head>`. Returns path list (possibly empty). */
  diffNames(base: string, head: string): string[];
}

/**
 * Real git implementation using `spawnSync`. Each call is independent (no
 * persistent git process) — the gate runs infrequently enough that the
 * fork overhead is inaudible.
 */
export function createRealGitExecutor(cwd: string): GitExecutor {
  const run = (args: string[]): { code: number; stdout: string; stderr: string } => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
    return {
      code: r.status ?? -1,
      stdout: typeof r.stdout === 'string' ? r.stdout : '',
      stderr: typeof r.stderr === 'string' ? r.stderr : '',
    };
  };
  return {
    tryRevParse(args) {
      const r = run(['rev-parse', ...args]);
      return r.code === 0 ? r.stdout.trim() : '';
    },
    trySymbolicRef(ref) {
      const r = run(['symbolic-ref', ref]);
      return r.code === 0 ? r.stdout.trim() : '';
    },
    headSha() {
      const r = run(['rev-parse', 'HEAD']);
      return r.code === 0 ? r.stdout.trim() : '';
    },
    diffNames(base, head) {
      const r = run(['diff', '--name-only', base, head]);
      if (r.code !== 0) return [];
      return r.stdout.split(/\r?\n/).filter((l) => l.length > 0);
    },
  };
}

// ---------------------------------------------------------------------------
// Codex invocation
// ---------------------------------------------------------------------------

export interface CodexRunOptions {
  baseRef: string;
  cwd: string;
  timeoutMs: number;
  /** Optional custom review prompt; defaults to Codex's built-in. */
  prompt?: string;
  /**
   * Env passthrough. Tests inject a clean env to prevent ambient overrides.
   * Production passes `process.env`.
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Injection seam for tests. When set, replaces `spawn` entirely. Must
   * return an object whose `stdout`/`stderr` are async iterables of Buffer
   * chunks and whose `on('exit')` yields `(code, signal)` like a real
   * ChildProcess. Keeping this narrow means we don't have to fake the
   * whole ChildProcess API.
   */
  spawnImpl?: (
    command: string,
    args: readonly string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => ChildProcessWithoutNullStreams;
}

export interface CodexRunResult {
  /** The concatenated text of every `item.completed` agent_message item. */
  reviewText: string;
  /** Number of JSONL events observed — useful for debugging protocol issues. */
  eventCount: number;
  /** Seconds of wall time spent in the subprocess. */
  durationSeconds: number;
}

/**
 * Execute `codex exec review` and return the concatenated review text on
 * success. Callers then pass the text to `summarizeReview()` to get a
 * structured verdict.
 *
 * Every error case throws a typed `CodexRunError`. Callers are expected to
 * catch and translate to an exit code + audit event.
 */
export async function runCodexReview(options: CodexRunOptions): Promise<CodexRunResult> {
  const spawner = options.spawnImpl ?? spawn;
  const baseArgs = ['exec', 'review', '--base', options.baseRef, '--json', '--ephemeral'];
  const args =
    options.prompt !== undefined && options.prompt.length > 0 ? [...baseArgs, options.prompt] : baseArgs;

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawner('codex', args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
    });
  } catch (e) {
    if (isEnoent(e)) throw new CodexNotInstalledError();
    throw e;
  }

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const started = Date.now();

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      // SIGTERM first; graceful shutdown. Codex cleans up its session files
      // on SIGTERM. We don't escalate to SIGKILL here — if the subprocess
      // hangs the event loop's own timeout handling will surface it.
      child.kill('SIGTERM');
      reject(new CodexTimeoutError(options.timeoutMs));
    }, options.timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (isEnoent(e)) {
        reject(new CodexNotInstalledError());
        return;
      }
      reject(e);
    });
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (code === null && signal !== null) {
        reject(
          new CodexSubprocessError(
            null,
            signal,
            Buffer.concat(stderrChunks).toString('utf8'),
          ),
        );
        return;
      }
      resolve(code);
    });
  });

  const durationSeconds = (Date.now() - started) / 1000;
  if (exitCode !== 0 && exitCode !== null) {
    throw new CodexSubprocessError(
      exitCode,
      null,
      Buffer.concat(stderrChunks).toString('utf8'),
    );
  }

  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const { reviewText, eventCount } = parseCodexJsonl(stdout);
  return { reviewText, eventCount, durationSeconds };
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

interface CodexEvent {
  type: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface CodexJsonlParseResult {
  reviewText: string;
  eventCount: number;
}

/**
 * Parse the JSONL event stream emitted by `codex exec review --json`. We
 * tolerate partial lines (stream chunks may split mid-object; our caller
 * gives us the full stdout after exit, but robustness costs nothing).
 *
 * The only events we care about are `item.completed` where `item.type ===
 * "agent_message"` — those carry the review text. Everything else (turn
 * lifecycle, command_execution telemetry, thread metadata) is counted but
 * discarded.
 *
 * A JSONL line that doesn't parse as JSON is tolerated: we skip it and
 * continue. Codex occasionally emits warnings outside the JSON envelope
 * (e.g. macOS xcrun cache errors leak into stderr but can accidentally
 * land on stdout in misbehaving shells); we treat these as non-fatal.
 *
 * We throw `CodexProtocolError` only when the ENTIRE stdout contains zero
 * parseable events AND zero `agent_message`-carrying items. An empty diff
 * can legitimately yield zero agent messages with events (thread.started,
 * turn.started, turn.completed), so we allow zero findings when at least
 * one event parsed.
 */
export function parseCodexJsonl(stdout: string): CodexJsonlParseResult {
  const lines = stdout.split(/\r?\n/).filter((l) => l.length > 0);
  let reviewText = '';
  let eventCount = 0;
  let parsedAny = false;
  for (const line of lines) {
    let evt: CodexEvent;
    try {
      evt = JSON.parse(line) as CodexEvent;
    } catch {
      // Non-JSON line. Could be a shell warning that leaked to stdout. Skip.
      continue;
    }
    parsedAny = true;
    eventCount += 1;
    if (
      evt.type === 'item.completed' &&
      evt.item !== undefined &&
      evt.item.type === 'agent_message' &&
      typeof evt.item.text === 'string'
    ) {
      reviewText = reviewText.length > 0 ? `${reviewText}\n\n${evt.item.text}` : evt.item.text;
    }
  }
  if (!parsedAny && lines.length > 0) {
    throw new CodexProtocolError(
      'no parseable JSONL events in stdout',
      lines[0],
    );
  }
  return { reviewText, eventCount };
}

function isEnoent(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false;
  const code = (e as NodeJS.ErrnoException).code;
  return code === 'ENOENT';
}
