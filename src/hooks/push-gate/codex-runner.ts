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
// Iron-gate runtime defaults (0.18.0+)
// ---------------------------------------------------------------------------

/**
 * Model preference LADDER for the default (no policy pin) case — newest
 * first. 0.52.0: when policy does not pin `codex_model`, the runner tries
 * ladder entries in order and falls to the next on a "model is not
 * supported" error event, so an install automatically rides the newest
 * codex flagship its account can use instead of going stale on a
 * hardcode (the "one team still on 5.4" problem — a machine with 5.5
 * access was stuck on 5.4 purely because rea pinned it). An EXPLICIT
 * `policy.review.codex_model` is never substituted — the operator chose;
 * an unsupported explicit pin fails loudly with remediation (and can
 * never silently pass; see CodexModelUnsupportedError).
 *
 * Bump here (prepend the new flagship) to bump everywhere.
 */
export const IRON_GATE_MODEL_LADDER: readonly string[] = ['gpt-5.5', 'gpt-5.4'];

/**
 * Default codex model when policy doesn't pin one — the TOP of the
 * ladder. Always passed via `-c model="<name>"` so codex's own default
 * (`codex-auto-review` at medium reasoning) is unreachable through the
 * rea push-gate.
 *
 * 0.19.0 code-reviewer P3-4: exported as a single source of truth.
 * `src/hooks/push-gate/index.ts` imports this for the verdict-cache
 * write so the cached `model` field reflects the same constant the
 * runner actually used. NOTE (0.52.0): with the ladder, the model a run
 * ACTUALLY used is `CodexRunResult.modelUsed` — prefer it post-run.
 */
export const IRON_GATE_DEFAULT_MODEL = IRON_GATE_MODEL_LADDER[0]!;

/**
 * Default reasoning effort when policy doesn't pin one. `high` for
 * verdict stability — the helixir 2026-04-26 thrashing came from the
 * lower-reasoning default.
 */
export const IRON_GATE_DEFAULT_REASONING: 'low' | 'medium' | 'high' = 'high';

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
  constructor(
    public readonly detail: string,
    public readonly sampleLine?: string,
  ) {
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

/**
 * 0.52.0 — codex accepted the run (exit 0!) but streamed an error event
 * saying the requested MODEL is not supported for this account, and
 * produced no review text. Pre-0.52.0 this was the WORST failure shape in
 * the gate: exit 0 + parseable events + no agent_message → empty
 * reviewText → zero findings → verdict 'pass'. A one-character typo in
 * `policy.review.codex_model` (or codex retiring an old model) silently
 * turned every review into a rubber stamp. Now it is a typed, loud
 * failure; for the DEFAULT (no policy pin) case the runner falls to the
 * next `IRON_GATE_MODEL_LADDER` entry instead.
 */
export class CodexModelUnsupportedError extends Error {
  readonly kind = 'model-unsupported' as const;
  constructor(
    public readonly model: string,
    public readonly detail: string,
  ) {
    super(
      `codex does not support model "${model}" for this account: ${detail.slice(0, 300)} — ` +
        `update policy.review.codex_model in .rea/policy.yaml (or remove it to ride rea's ` +
        `model ladder: ${IRON_GATE_MODEL_LADDER.join(' → ')}).`,
    );
    this.name = 'CodexModelUnsupportedError';
  }
}

export type CodexRunError =
  | CodexNotInstalledError
  | CodexTimeoutError
  | CodexProtocolError
  | CodexSubprocessError
  | CodexModelUnsupportedError;

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
  /**
   * `git rev-list --count <base>..<head>`. Returns the integer commit count
   * or `null` when the range cannot be resolved (unreachable base, shallow
   * clone, etc.) — null lets the caller treat divergence-counting as
   * best-effort without breaking the gate. Used by the auto-narrow probe
   * (J / 0.13.0).
   */
  revListCount(base: string, head: string): number | null;
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
    revListCount(base, head) {
      // `git rev-list --count base..head` — number of commits reachable
      // from head but not base. Returns null on any failure so the caller
      // can treat divergence-counting as best-effort (auto-narrow probe).
      const r = run(['rev-list', '--count', `${base}..${head}`]);
      if (r.code !== 0) return null;
      const trimmed = r.stdout.trim();
      if (trimmed.length === 0) return null;
      const n = Number(trimmed);
      return Number.isFinite(n) && n >= 0 ? Math.floor(n) : null;
    },
  };
}

// ---------------------------------------------------------------------------
// Codex invocation
// ---------------------------------------------------------------------------

/**
 * Escape a string for safe inclusion inside a TOML basic-string literal.
 * Codex's `-c key=value` parser runs the value through TOML, so we have to
 * close over the same escape contract — namely backslash and double-quote
 * (TOML basic strings forbid raw `"` and `\` in the body). The model names
 * and reasoning levels we expect (`gpt-5.4`, `high`, etc.) never contain
 * either character; this guard exists so a future model-name typo with a
 * shell metacharacter cannot smuggle a TOML escape that codex misparses
 * into something dangerous.
 */
function escapeTomlString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export interface CodexRunOptions {
  baseRef: string;
  cwd: string;
  timeoutMs: number;
  /** Optional custom review prompt; defaults to Codex's built-in. */
  prompt?: string;
  /**
   * Codex CLI model override (0.13.4+). When set, the runner passes
   * `-c model="<value>"` to `codex exec review`. Codex itself validates
   * the name. `undefined` falls back to codex's own default
   * (`codex-auto-review` today, NOT the `gpt-5.4` flagship).
   */
  model?: string;
  /**
   * Codex reasoning effort (0.13.4+). When set, the runner passes
   * `-c model_reasoning_effort="<value>"`. Only meaningful when paired
   * with a reasoning-capable model (gpt-5.4, gpt-5.3-codex). Codex's
   * own default is `medium`.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
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
  /**
   * 0.27.0 — optional callback fired for every raw stdout chunk from
   * `codex exec review`. Used by `rea hook codex-review` (the thin Bash-
   * direct CLI) to tee the JSONL stream into a tempfile so the caller can
   * read the un-summarized review JSON directly. Errors thrown from the
   * sink are caught and ignored — sink failure must NEVER change the
   * verdict. Receives chunks in arrival order.
   */
  rawStdoutSink?: (chunk: Buffer) => void;
}

export interface CodexRunResult {
  /** The concatenated text of every `item.completed` agent_message item. */
  reviewText: string;
  /** Number of JSONL events observed — useful for debugging protocol issues. */
  eventCount: number;
  /** Seconds of wall time spent in the subprocess. */
  durationSeconds: number;
  /**
   * 0.52.0 — the model the run ACTUALLY used. Equals the explicit
   * `options.model` when pinned; in the default case it is whichever
   * `IRON_GATE_MODEL_LADDER` entry succeeded (which may not be the top,
   * if the account lacks the newest flagship). Callers should audit THIS,
   * not the pre-run assumption.
   */
  modelUsed: string;
  /**
   * 0.52.0 — true when the default-model run fell past at least one
   * ladder entry (e.g. account has no gpt-5.5 → ran gpt-5.4). Surfaced
   * so operators can see they're not on the newest flagship.
   */
  modelFellBack: boolean;
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
  // 0.52.0 model ladder. An EXPLICIT policy pin is authoritative — one
  // candidate, no substitution (an unsupported pin throws
  // CodexModelUnsupportedError with remediation). The DEFAULT case walks
  // IRON_GATE_MODEL_LADDER newest-first, falling to the next entry ONLY on
  // the model-unsupported signature — every other failure (timeout,
  // protocol, subprocess) propagates immediately, unchanged. An
  // unsupported-model attempt fails in ~2s with no review compute, so the
  // fallback costs nothing when the account has the newest flagship.
  const explicitModel =
    options.model !== undefined && options.model.length > 0 ? options.model : undefined;
  const candidates = explicitModel !== undefined ? [explicitModel] : [...IRON_GATE_MODEL_LADDER];
  let lastErr: unknown;
  for (let i = 0; i < candidates.length; i += 1) {
    try {
      const result = await runCodexReviewOnce(options, candidates[i]!);
      return { ...result, modelFellBack: i > 0 };
    } catch (e) {
      if (e instanceof CodexModelUnsupportedError && i < candidates.length - 1) {
        lastErr = e;
        continue; // default-case ladder: try the next (older) flagship
      }
      throw e;
    }
  }
  // Unreachable (the last candidate either returned or threw), but keep
  // the compiler + a paranoid future refactor honest.
  throw lastErr instanceof Error ? lastErr : new Error('codex model ladder exhausted');
}

async function runCodexReviewOnce(
  options: CodexRunOptions,
  effectiveModel: string,
): Promise<Omit<CodexRunResult, 'modelFellBack'>> {
  const spawner = options.spawnImpl ?? spawn;
  // 0.18.0 iron-gate runtime default: ALWAYS pass model + reasoning
  // effort to codex. Pre-fix, undefined options fell back to codex's
  // own default (`codex-auto-review` at medium reasoning), which
  // bypassed the iron-gate intent and let weaker reviews ship. Now
  // the runtime hardcodes the ladder top + `high` as the floor; policy
  // can OVERRIDE to a different model/effort but cannot opt out into
  // codex's defaults (config.toml or otherwise). The user's directive
  // — "we want codex to be using its BEST. EVERY TIME" — is enforced
  // here, not at the policy layer.
  //
  // Model + reasoning overrides go BEFORE the `exec` subcommand because
  // `-c key=value` is a top-level codex CLI flag, not an `exec` flag.
  // Codex's TOML parser interprets the value, so we wrap strings in TOML
  // quotes — `-c model="gpt-5.5"` not `-c model=gpt-5.5` — to ensure the
  // value lands as a string regardless of upstream parsing changes.
  const effectiveReasoning = options.reasoningEffort ?? IRON_GATE_DEFAULT_REASONING;
  const overrideArgs: string[] = [
    '-c',
    `model="${escapeTomlString(effectiveModel)}"`,
    '-c',
    `model_reasoning_effort="${escapeTomlString(effectiveReasoning)}"`,
  ];
  const baseArgs = [
    ...overrideArgs,
    'exec',
    'review',
    '--base',
    options.baseRef,
    '--json',
    '--ephemeral',
  ];
  const args =
    options.prompt !== undefined && options.prompt.length > 0
      ? [...baseArgs, options.prompt]
      : baseArgs;

  // 0.16.3 helix-016.1 #1 fix: pre-flight probe for the codex CLI before
  // we hand control to the long-running review subprocess. The original
  // try/catch around `spawner(...)` only caught synchronous ENOENT; on
  // some platforms (Linux child_process under certain shell configs)
  // the missing-binary error arrives as a `'error'` event AFTER spawn
  // has returned a child handle, and on others codex CLI is present
  // but a wrapper script exits non-zero before any JSONL emerges. Both
  // shapes leak through the existing classify path as `subprocess` /
  // `protocol` errors with stack-frame-shaped messages instead of the
  // friendly install hint defined on `CodexNotInstalledError`.
  //
  // The probe runs `codex --version` synchronously with a 2-second cap
  // (cheap; codex --version returns in <50ms when the binary exists).
  // If the binary is absent OR the probe exits non-zero AND the error
  // is ENOENT-class, we throw `CodexNotInstalledError` directly so
  // `index.ts:561` formats it as the headline `PUSH BLOCKED:` line.
  // We deliberately do NOT use the probe for binaries that exist but
  // fail their version check — those are real subprocess errors and
  // belong in the existing classify path.
  //
  // The probe is skipped when `spawnImpl` is provided so unit tests
  // continue to control the entire spawn surface deterministically.
  if (options.spawnImpl === undefined) {
    const probe = spawnSync('codex', ['--version'], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      timeout: 2000,
      encoding: 'utf8',
    });
    // `error` is set when the OS could not start the binary at all
    // (ENOENT, EACCES, ENOTDIR). Codex returning a non-zero status
    // because of a downstream issue is NOT the same condition — let
    // it fall through to the main run where the existing classifier
    // produces a meaningful subprocess error.
    if (probe.error !== undefined) {
      const code = (probe.error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new CodexNotInstalledError();
      // EACCES on the codex binary is operationally identical to "not
      // installed" for the user — they need to install or fix perms.
      if (code === 'EACCES') throw new CodexNotInstalledError();
      throw probe.error;
    }
  }

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

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      // 0.27.0 raw-stdout tee for `rea hook codex-review`. Sink errors
      // are swallowed — a bad sink must not make a passing review fail.
      const sink = options.rawStdoutSink;
      if (sink !== undefined) {
        try {
          sink(chunk);
        } catch {
          /* sink failure is non-fatal */
        }
      }
    });
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

    child.on('error', (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (isEnoent(e)) {
        reject(new CodexNotInstalledError());
        return;
      }
      reject(e);
    });
    // `close` (not `exit`) fires after BOTH stdio streams drain and the
    // process has exited. Node can emit `exit` before the final stdout
    // chunks are flushed on large reviews or slow pipes, causing
    // `parseCodexJsonl()` to run against a truncated buffer and
    // misclassify a blocking review as pass. Waiting for `close`
    // guarantees every agent_message chunk is in `stdoutChunks`.
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      if (code === null && signal !== null) {
        reject(
          new CodexSubprocessError(null, signal, Buffer.concat(stderrChunks).toString('utf8')),
        );
        return;
      }
      resolve(code);
    });
  });

  const durationSeconds = (Date.now() - started) / 1000;
  if (exitCode !== 0 && exitCode !== null) {
    throw new CodexSubprocessError(exitCode, null, Buffer.concat(stderrChunks).toString('utf8'));
  }

  const stdout = Buffer.concat(stdoutChunks).toString('utf8');
  const { reviewText, eventCount, errorMessages } = parseCodexJsonl(stdout);

  // 0.52.0 SILENT-PASS fix. codex exits 0 even when the run FAILED via a
  // streamed `{"type":"error",...}` event (e.g. unsupported model:
  // status 400 invalid_request_error, still exit 0). Pre-fix that shape
  // sailed through: parseable events, no agent_message, empty reviewText,
  // zero findings → verdict 'pass'. A review that ERRORED must never
  // pass. When the stream carried error events AND produced no review
  // text, classify: model-unsupported (typed, drives the ladder) vs.
  // generic protocol failure. Error events ALONGSIDE real review text are
  // tolerated (transient warnings; the review completed).
  if (reviewText.length === 0 && errorMessages.length > 0) {
    const joined = errorMessages.join('; ');
    if (/model.{0,40}(is )?not supported|unsupported model|unknown model/i.test(joined)) {
      throw new CodexModelUnsupportedError(effectiveModel, joined);
    }
    throw new CodexProtocolError(
      `codex streamed ${errorMessages.length} error event(s) and no review text: ${joined.slice(0, 400)}`,
    );
  }

  return { reviewText, eventCount, durationSeconds, modelUsed: effectiveModel };
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
  /**
   * 0.52.0 — messages from streamed `{"type":"error",...}` events. codex
   * exits 0 even on failed runs (e.g. unsupported model → 400 error event
   * + exit 0), so error events are the ONLY reliable failure signal for
   * this class. The runner refuses to return an empty-review result when
   * any are present (silent-pass fix).
   */
  errorMessages: string[];
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
  const errorMessages: string[] = [];
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
    // 0.52.0 — collect `error` events. codex exits 0 even when the run
    // failed via a streamed error (observed shape:
    // {"type":"error","status":400,"error":{"type":"invalid_request_error",
    //  "message":"The 'X' model is not supported…"}}; a flat
    // {"type":"error","message":"…"} variant is handled too). The caller
    // uses these to refuse a silent pass on an errored, review-less run.
    if (evt.type === 'error') {
      const nested = (evt as { error?: { message?: unknown } }).error;
      const msg =
        nested !== undefined && typeof nested.message === 'string'
          ? nested.message
          : typeof (evt as { message?: unknown }).message === 'string'
            ? ((evt as { message?: unknown }).message as string)
            : line.slice(0, 200);
      errorMessages.push(msg);
    }
  }
  if (!parsedAny && lines.length > 0) {
    throw new CodexProtocolError('no parseable JSONL events in stdout', lines[0]);
  }
  return { reviewText, eventCount, errorMessages };
}

function isEnoent(e: unknown): boolean {
  if (e === null || typeof e !== 'object') return false;
  const code = (e as NodeJS.ErrnoException).code;
  return code === 'ENOENT';
}
