/**
 * Codex adversarial reviewer adapter (G11.2).
 *
 * ## Why this class throws from `review()`
 *
 * The actual Codex review path is the `codex-adversarial` agent shipped under
 * `.claude/agents/`, invoked from Claude Code via the `/codex-review` slash
 * command (which eventually reaches the Codex plugin's
 * `/codex:adversarial-review`). None of that is importable from TS — the
 * agent runtime is the harness, not a library.
 *
 * `CodexReviewer` exists so:
 *
 *   1. `selectReviewer()` can return a typed reviewer handle with a stable
 *      `name`/`version` that the audit log and CLI can surface.
 *   2. `isAvailable()` can cheaply probe the CLI without invoking a review.
 *   3. G11.3 (startup probe) and G11.4 (no-Codex policy) have something to
 *      type-check against now, so the broader flow can land without waiting
 *      for an in-process Codex SDK that may never ship.
 *
 * If we ever get a native Codex TS client, `review()` becomes real and this
 * comment block goes away. Until then: treat a Codex selection as
 * "dispatch to the agent", not "await reviewer.review(...)".
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AdversarialReviewer, ReviewRequest, ReviewResult } from './types.js';

const execFileAsync = promisify(execFile);

/** Upper bound on `codex --version` so a hung CLI can't stall the push gate. */
const VERSION_PROBE_TIMEOUT_MS = 2_000;

/** Token used as `version` when we never successfully read one. */
const UNKNOWN_VERSION = 'unknown';

/**
 * Narrow test seam: the unit tests swap the exec implementation via the
 * constructor so we don't have to hit the real CLI. Kept internal to this
 * file — production callers always use the default.
 */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFileFn = (file, args, options) => execFileAsync(file, [...args], options);

export class CodexReviewer implements AdversarialReviewer {
  readonly name = 'codex';

  private readonly exec: ExecFileFn;
  private cachedVersion: string | undefined;

  constructor(opts: { exec?: ExecFileFn } = {}) {
    this.exec = opts.exec ?? defaultExec;
  }

  /**
   * Lazily populated via `codex --version`. We don't block construction on
   * the probe because the selector calls `isAvailable()` before it commits
   * to Codex, so we'll have a fresh value by the time anything reads it.
   */
  get version(): string {
    return this.cachedVersion ?? UNKNOWN_VERSION;
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { stdout } = await this.exec('codex', ['--version'], {
        timeout: VERSION_PROBE_TIMEOUT_MS,
      });
      // Cache on success so `version` is non-`unknown` the moment the
      // selector picks this reviewer.
      this.cachedVersion = stdout.trim() || UNKNOWN_VERSION;
      return true;
    } catch {
      // Any failure — timeout, ENOENT, non-zero exit — means we shouldn't
      // route through Codex. Callers don't need the reason; the selector
      // logs why it fell back.
      return false;
    }
  }

  /**
   * Not invokable from TS — see the file header. The selector contract is
   * "CodexReviewer handles mean dispatch to the codex-adversarial agent";
   * if a caller ignores that and awaits this, we throw loudly rather than
   * silently produce a bad `ReviewResult`.
   *
   * TODO(0.3.0): when Codex ships a native TS client, this path will
   * actually run the review. At that point, instrument with
   * `recordTelemetry` the same way `ClaudeSelfReviewer.review()` does
   * today (G11.5). The throwing placeholder below is deliberately NOT
   * instrumented — there is nothing to measure.
   */
  async review(_req: ReviewRequest): Promise<ReviewResult> {
    throw new Error(
      'CodexReviewer.review() is invoked via the codex-adversarial agent, not directly from TS',
    );
  }
}
