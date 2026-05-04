import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';

/**
 * G3 — ReDoS safety wrapper.
 *
 * Every regex that the middleware chain runs on untrusted MCP payloads must be
 * bounded. This module provides a `SafeRegex` wrapper that enforces a per-call
 * timeout by executing the match inside a worker thread, then `Promise.race`-ing
 * against a `setTimeout`. On timeout the worker is terminated, the caller is told
 * the operation timed out, and an optional callback fires so the audit layer can
 * record the event.
 *
 * Implementation decision — Option A (worker thread per exec):
 *   - No native dependency (compare: `re2` would add a native build step and a
 *     second regex dialect to keep consistent with JS defaults).
 *   - Timeout is authoritative: terminating the worker is a hard kill, unlike
 *     interpreter-level heuristics.
 *   - Overhead is ~1ms per call. That is acceptable for gateway payloads; if it
 *     ever becomes measurable we can pool workers in a later release without
 *     changing the public `SafeRegex` surface.
 *   - Rejected Option B (re2): native dep + a different regex dialect than the
 *     rest of the codebase assumes. Rejected Option C (length cap only): caps
 *     bound worst-case cost but don't eliminate catastrophic backtracking.
 *
 * SECURITY: The `onTimeout` callback is invoked with the pattern and input. The
 * callback contract (enforced by callers, not here) is that the input is used
 * only for size accounting — the middleware must NEVER log the input text, only
 * its byte length and pattern id. See `redact.ts` / `injection.ts` for the
 * audit-event shape.
 */

export interface MatchTimeoutOptions {
  /** Per-call timeout budget in milliseconds. Default 100ms. */
  timeoutMs?: number;
  /**
   * Invoked exactly once when a match exceeds the timeout. Callers record an
   * audit event here. The input text MUST NOT be logged — only size.
   */
  onTimeout?: (pattern: RegExp, input: string) => void;
}

export interface SafeRegexTestResult {
  matched: boolean;
  timedOut: boolean;
}

export interface SafeRegexReplaceResult {
  output: string;
  timedOut: boolean;
}

export interface SafeRegexMatchAllResult {
  matches: string[];
  timedOut: boolean;
}

export interface SafeRegex {
  readonly pattern: RegExp;
  /**
   * Test whether the pattern matches `input`. On timeout returns
   * `{ matched: false, timedOut: true }` and invokes `onTimeout`.
   */
  test(input: string): SafeRegexTestResult;
  /**
   * Replace pattern matches in `input` with `replacer`. On timeout returns
   * `{ output: input, timedOut: true }` (unchanged input) and invokes
   * `onTimeout`. The input is NEVER passed through unredacted when a timeout
   * fires at a higher layer — the middleware substitutes a sentinel. See
   * `redact.ts` for the sentinel contract.
   */
  replace(input: string, replacer: string): SafeRegexReplaceResult;
  /**
   * Return all full-string matches of the pattern in `input`. The pattern is
   * compiled inside the worker with the global flag forced on so matchAll is
   * meaningful regardless of how the original pattern was specified. On
   * timeout returns `{ matches: [], timedOut: true }` and invokes `onTimeout`.
   */
  matchAll(input: string): SafeRegexMatchAllResult;
}

const DEFAULT_TIMEOUT_MS = 100;

/**
 * Worker source — one script handles both `test` and `replace` ops. The worker
 * receives the request + a SharedArrayBuffer for synchronization via
 * `workerData`, compiles the regex inside the worker (so a catastrophic
 * pattern burns worker CPU only), writes the result payload into a parentPort
 * message, and then signals completion by writing `1` into the SAB and calling
 * `Atomics.notify`. The parent blocks on `Atomics.wait(sab, 0, 0, timeoutMs)`
 * and wakes when the worker notifies — OR when the timeout expires, in which
 * case the parent terminates the worker.
 *
 * SECURITY: The parent must NOT rely on the `message` event alone, because
 * `Atomics.wait` blocks the main thread's event loop. The SAB signal is the
 * authoritative wake source. The parent reads the reply AFTER wake by draining
 * the worker's `receiveMessageOnPort` queue.
 */
const WORKER_SOURCE = `
const { workerData } = require('node:worker_threads');
const { signalSab, replyPort, req } = workerData;
const view = new Int32Array(signalSab);
try {
  const re = new RegExp(req.source, req.flags);
  let reply;
  if (req.op === 'test') {
    re.lastIndex = 0;
    reply = { ok: true, op: 'test', matched: re.test(req.input) };
  } else if (req.op === 'replace') {
    re.lastIndex = 0;
    reply = { ok: true, op: 'replace', output: req.input.replace(re, req.replacer) };
  } else if (req.op === 'matchAll') {
    // Force the global flag on so matchAll is meaningful.
    const flags = req.flags.includes('g') ? req.flags : req.flags + 'g';
    const gre = new RegExp(req.source, flags);
    const out = [];
    for (const m of req.input.matchAll(gre)) {
      out.push(m[0]);
    }
    reply = { ok: true, op: 'matchAll', matches: out };
  } else {
    reply = { ok: false, error: 'unknown op: ' + req.op };
  }
  replyPort.postMessage(reply);
} catch (err) {
  replyPort.postMessage({ ok: false, error: err && err.message ? err.message : String(err) });
} finally {
  // Signal completion via SAB so the parent's Atomics.wait unblocks. The parent
  // then drains the replyPort synchronously via receiveMessageOnPort.
  Atomics.store(view, 0, 1);
  Atomics.notify(view, 0);
}
`;

interface WorkerTestReply {
  ok: true;
  op: 'test';
  matched: boolean;
}
interface WorkerReplaceReply {
  ok: true;
  op: 'replace';
  output: string;
}
interface WorkerMatchAllReply {
  ok: true;
  op: 'matchAll';
  matches: string[];
}
interface WorkerErrorReply {
  ok: false;
  error: string;
}
type WorkerReply = WorkerTestReply | WorkerReplaceReply | WorkerMatchAllReply | WorkerErrorReply;

interface WorkerRequestBase {
  source: string;
  flags: string;
  input: string;
}
interface WorkerTestRequest extends WorkerRequestBase {
  op: 'test';
}
interface WorkerReplaceRequest extends WorkerRequestBase {
  op: 'replace';
  replacer: string;
}
interface WorkerMatchAllRequest extends WorkerRequestBase {
  op: 'matchAll';
}
type WorkerRequest = WorkerTestRequest | WorkerReplaceRequest | WorkerMatchAllRequest;

interface RunOutcome {
  reply: WorkerReply | null;
  timedOut: boolean;
}

/**
 * Synchronous wrapper around the worker. Middleware hot paths call `.test()`
 * and `.replace()` inside tight synchronous loops (see `redactSecrets`), so the
 * public `SafeRegex` surface has to be synchronous to be a drop-in replacement.
 *
 * How it works:
 *   1. Allocate a 4-byte SharedArrayBuffer. The worker and parent both see it.
 *   2. Spawn the worker with `workerData: { signalSab, req }`.
 *   3. Parent blocks on `Atomics.wait(view, 0, 0, timeoutMs)` — allowed on the
 *      Node main thread (unlike the browser).
 *   4. Worker computes the result, posts the reply message, then writes `1` to
 *      the SAB and calls `Atomics.notify`. The SAB notify is the authoritative
 *      wake — the message event cannot fire because the event loop is blocked.
 *   5. Parent wakes, drains the worker's message queue synchronously via
 *      `receiveMessageOnPort`, then terminates the worker.
 *
 * On timeout the parent `terminate()`s the worker — a hard kill that stops a
 * catastrophic backtracker cold.
 */
function runInWorkerSync(req: WorkerRequest, timeoutMs: number): RunOutcome {
  const signalSab = new SharedArrayBuffer(4);
  const view = new Int32Array(signalSab);

  // Create a MessageChannel so the parent can drain the reply synchronously
  // via `receiveMessageOnPort`. We give the worker the `port1` end and keep
  // `port2` on the parent side.
  const { port1: workerSendPort, port2: parentRecvPort } = new MessageChannel();

  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: { signalSab, replyPort: workerSendPort, req },
    transferList: [workerSendPort],
  });
  // Don't pin the process on the worker's existence.
  worker.unref();

  // Block this thread until the worker signals completion OR the timeout
  // expires. `Atomics.wait` is allowed on the Node main thread (unlike the
  // browser, where it is blocked on the UI thread).
  const waitResult = Atomics.wait(view, 0, 0, timeoutMs);

  if (waitResult === 'timed-out') {
    // Worker is still running — kill it and report timeout.
    void worker.terminate();
    parentRecvPort.close();
    return { reply: null, timedOut: true };
  }

  // Worker signaled completion. Drain the port queue synchronously to
  // recover the reply payload. `receiveMessageOnPort` returns `undefined` if
  // no message is queued — that should not happen on the happy path because
  // the worker posts the message BEFORE notifying the SAB, but we guard
  // defensively.
  let reply: WorkerReply | null = null;
  const msg = receiveMessageOnPort(parentRecvPort);
  if (msg !== undefined) {
    reply = msg.message as WorkerReply;
  }

  // Release the worker thread and close the port.
  void worker.terminate();
  parentRecvPort.close();

  if (reply !== null) {
    return { reply, timedOut: false };
  }
  return { reply: { ok: false, error: 'worker produced no result' }, timedOut: false };
}

/**
 * Wrap a RegExp in a timeout-enforced `SafeRegex`. Compilation happens both in
 * the parent (to catch syntax errors early) and inside the worker (so a
 * catastrophic compile or match spends only worker CPU).
 *
 * SECURITY: callers should pass regexes that have ALSO been cleared by
 * `safe-regex` at load time — the timeout is a defense-in-depth backstop, not
 * a replacement for static analysis. See `scripts/lint-safe-regex.mjs` and the
 * load-time check in `src/policy/loader.ts`.
 */
export function wrapRegex(pattern: RegExp, opts?: MatchTimeoutOptions): SafeRegex {
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const onTimeout = opts?.onTimeout;
  const source = pattern.source;
  const flags = pattern.flags;

  const emitTimeout = (input: string): void => {
    if (onTimeout) {
      try {
        onTimeout(pattern, input);
      } catch {
        // Callback errors MUST NOT break middleware. Swallow silently — the
        // middleware has its own audit path if it cares.
      }
    }
  };

  return {
    pattern,
    test(input: string): SafeRegexTestResult {
      const { reply, timedOut } = runInWorkerSync({ op: 'test', source, flags, input }, timeoutMs);
      if (timedOut) {
        emitTimeout(input);
        return { matched: false, timedOut: true };
      }
      if (reply && reply.ok && reply.op === 'test') {
        return { matched: reply.matched, timedOut: false };
      }
      // Worker errored (compile error, etc.) — treat as no match, no timeout.
      return { matched: false, timedOut: false };
    },
    replace(input: string, replacer: string): SafeRegexReplaceResult {
      const { reply, timedOut } = runInWorkerSync(
        { op: 'replace', source, flags, input, replacer },
        timeoutMs,
      );
      if (timedOut) {
        emitTimeout(input);
        return { output: input, timedOut: true };
      }
      if (reply && reply.ok && reply.op === 'replace') {
        return { output: reply.output, timedOut: false };
      }
      // Worker errored — preserve input unchanged (never corrupt payload).
      return { output: input, timedOut: false };
    },
    matchAll(input: string): SafeRegexMatchAllResult {
      const { reply, timedOut } = runInWorkerSync(
        { op: 'matchAll', source, flags, input },
        timeoutMs,
      );
      if (timedOut) {
        emitTimeout(input);
        return { matches: [], timedOut: true };
      }
      if (reply && reply.ok && reply.op === 'matchAll') {
        return { matches: reply.matches, timedOut: false };
      }
      // Worker errored — return empty match set.
      return { matches: [], timedOut: false };
    },
  };
}
