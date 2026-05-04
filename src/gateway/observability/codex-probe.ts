/**
 * Codex availability probe (G11.3).
 *
 * Passive, periodic reachability check for the Codex CLI, used by `rea serve`
 * at startup and by `rea doctor` to surface a one-line status about whether
 * Codex is actually usable right now. This is INTENTIONALLY separate from
 * the reviewer-selection path in `src/gateway/reviewers/select.ts`:
 *
 *   - The selector decides which reviewer to run for a specific push (it
 *     respects `REA_REVIEWER`, registry pin, policy, etc.).
 *   - The probe just reports "is the Codex CLI responding at all?" as a
 *     observability signal — never gates a review.
 *
 * Startup must NEVER fail-closed on a probe failure. Codex going away is a
 * degraded state, not a fatal one; the push gate has its own audited escape
 * hatch (`REA_SKIP_CODEX_REVIEW`, G11.1).
 *
 * ## Probe shape
 *
 *   1. `codex --version`  — must exit 0 within {@link VERSION_TIMEOUT_MS}.
 *      Success → `cli_installed: true` and `version` populated from stdout.
 *   2. Catalog check     — see the `tryCatalogProbe` comment below. We try
 *      a best-effort authenticated subcommand with a short timeout. If the
 *      subcommand is unrecognized by this Codex build, we degrade to "assume
 *      authenticated iff cli_installed is true" rather than flagging a false
 *      negative.
 *
 * `cli_responsive` is the AND of both. Consumers should treat
 * `cli_responsive: false` as "Codex may be unavailable — plan accordingly",
 * not as authoritative proof that a specific review will fail.
 *
 * ## Concurrency
 *
 * `probe()` is safe to call concurrently. We serialize via a module-local
 * promise; callers queue up behind the in-flight probe instead of kicking off
 * duplicate exec calls. `start()` / `stop()` manage a single `setInterval`
 * with `.unref()` so the probe never pins the event loop.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Upper bound on `codex --version`. A hung CLI must not stall the gateway. */
const VERSION_TIMEOUT_MS_DEFAULT = 2_000;

/** Upper bound on the catalog probe. Longer because it may hit the network. */
const CATALOG_TIMEOUT_MS_DEFAULT = 5_000;

/** Default polling cadence — 10 minutes. Codex state rarely flaps faster. */
const DEFAULT_INTERVAL_MS = 10 * 60 * 1_000;

/**
 * Narrow test seam mirroring the shape in `src/gateway/reviewers/codex.ts`.
 * Kept module-local; production callers never pass their own.
 */
export type ExecFileFn = (
  file: string,
  args: readonly string[],
  options: { timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

const defaultExec: ExecFileFn = (file, args, options) => execFileAsync(file, [...args], options);

/**
 * Observable Codex state. Serialized verbatim into the doctor output and
 * (later, G5) into a metrics export. Keep field names stable.
 */
export interface CodexProbeState {
  /** `codex --version` exited 0 within the version-probe timeout. */
  cli_installed: boolean;
  /** Catalog probe succeeded (or was degraded-skipped — see module header). */
  cli_authenticated: boolean;
  /** `cli_installed && cli_authenticated`. */
  cli_responsive: boolean;
  /** ISO-8601 timestamp of the most recent `probe()` completion. */
  last_probe_at: string;
  /** Populated on failure; cleared on the next successful probe. */
  last_error?: string;
  /** Parsed from `codex --version` stdout on success. */
  version?: string;
}

export interface CodexProbeOptions {
  execFileFn?: ExecFileFn;
  timeoutInstallMs?: number;
  timeoutCatalogMs?: number;
}

/** Initial sentinel state — cli considered unresponsive until first probe. */
function unknownState(): CodexProbeState {
  return {
    cli_installed: false,
    cli_authenticated: false,
    cli_responsive: false,
    last_probe_at: new Date(0).toISOString(),
  };
}

/**
 * Shallow equality check across the probe-state shape. We fire listeners
 * only on actual transitions — callers don't want a timer tick to re-log
 * identical state every 10 minutes.
 */
function statesEqual(a: CodexProbeState, b: CodexProbeState): boolean {
  return (
    a.cli_installed === b.cli_installed &&
    a.cli_authenticated === b.cli_authenticated &&
    a.cli_responsive === b.cli_responsive &&
    a.last_error === b.last_error &&
    a.version === b.version
  );
}

export class CodexProbe {
  private readonly exec: ExecFileFn;
  private readonly versionTimeoutMs: number;
  private readonly catalogTimeoutMs: number;

  private state: CodexProbeState = unknownState();
  private inFlight: Promise<CodexProbeState> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly listeners = new Set<(s: CodexProbeState) => void>();

  constructor(opts: CodexProbeOptions = {}) {
    this.exec = opts.execFileFn ?? defaultExec;
    this.versionTimeoutMs = opts.timeoutInstallMs ?? VERSION_TIMEOUT_MS_DEFAULT;
    this.catalogTimeoutMs = opts.timeoutCatalogMs ?? CATALOG_TIMEOUT_MS_DEFAULT;
  }

  /**
   * Execute a single probe. Safe to call concurrently — overlapping callers
   * await the single in-flight attempt. Never throws.
   */
  probe(): Promise<CodexProbeState> {
    if (this.inFlight !== undefined) return this.inFlight;
    const attempt = this.runProbe().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = attempt;
    return attempt;
  }

  /** Start periodic polling. Immediate probe, then every `intervalMs`. */
  start(intervalMs: number = DEFAULT_INTERVAL_MS): void {
    if (this.timer !== undefined) return;
    // Fire-and-forget the initial probe; callers can await `probe()`
    // separately if they need the result right now.
    void this.probe();
    this.timer = setInterval(() => void this.probe(), intervalMs);
    // `unref` so the poller doesn't keep the Node event loop alive when the
    // rest of the process is idle/exiting.
    this.timer.unref?.();
  }

  /** Stop periodic polling. Safe to call even if never started. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Snapshot of the most recent probe state. Never throws. */
  getState(): CodexProbeState {
    return { ...this.state };
  }

  /**
   * Subscribe to state transitions. Returns an unsubscribe function. The
   * listener fires only when any observable field changes, not on every
   * tick.
   */
  onStateChange(listener: (state: CodexProbeState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Core probe logic. Private — use `probe()`. */
  private async runProbe(): Promise<CodexProbeState> {
    const next: CodexProbeState = {
      cli_installed: false,
      cli_authenticated: false,
      cli_responsive: false,
      last_probe_at: new Date().toISOString(),
    };

    // 1. `codex --version` — cheap reachability signal.
    try {
      const { stdout } = await this.exec('codex', ['--version'], {
        timeout: this.versionTimeoutMs,
      });
      next.cli_installed = true;
      const parsed = stdout.trim();
      if (parsed.length > 0) next.version = parsed;
    } catch (err) {
      next.last_error = formatExecError(err, 'codex --version');
      this.commit(next);
      return this.getState();
    }

    // 2. Catalog probe — best-effort authenticated check.
    //
    // `codex catalog --json` is the aspirational subcommand. If this Codex
    // build doesn't recognize it, we refuse to fail the probe solely on
    // that basis — the risk of a false "unauthenticated" flag driving users
    // to re-login for no reason is higher than the benefit of a rigorous
    // catalog check today. When the subcommand truly errors (not
    // "unrecognized"), we surface the error verbatim.
    const catalogResult = await this.tryCatalogProbe();
    if (catalogResult.ok) {
      next.cli_authenticated = true;
    } else if (catalogResult.skipped) {
      // Degraded path: CLI installed, catalog subcommand unrecognized → we
      // assume auth-healthy iff version probe succeeded AND nothing else
      // has written `last_error`. Documented assumption in module header.
      next.cli_authenticated = next.last_error === undefined;
    } else {
      next.last_error = catalogResult.error;
    }

    next.cli_responsive = next.cli_installed && next.cli_authenticated;
    this.commit(next);
    return this.getState();
  }

  /**
   * Try `codex catalog --json`. Returns:
   *   - `{ ok: true }` on exit 0.
   *   - `{ ok: false, skipped: true }` when the subcommand is unrecognized
   *     (best-effort detection on stderr).
   *   - `{ ok: false, skipped: false, error }` on any other failure.
   */
  private async tryCatalogProbe(): Promise<
    { ok: true } | { ok: false; skipped: true } | { ok: false; skipped: false; error: string }
  > {
    try {
      await this.exec('codex', ['catalog', '--json'], {
        timeout: this.catalogTimeoutMs,
      });
      return { ok: true };
    } catch (err) {
      const message = formatExecError(err, 'codex catalog --json');
      // A subcommand that isn't baked into this Codex build typically prints
      // something like "unknown command" or "unrecognized" and exits non-
      // zero. Treat those as degraded-skip rather than a hard failure.
      if (/unknown command|unrecognized|usage:|invalid subcommand/i.test(message)) {
        return { ok: false, skipped: true };
      }
      return { ok: false, skipped: false, error: message };
    }
  }

  /** Persist `next` and fire listeners if anything observable changed. */
  private commit(next: CodexProbeState): void {
    const changed = !statesEqual(this.state, next);
    this.state = next;
    if (!changed) return;
    // Snapshot listeners in case a handler mutates the set.
    for (const listener of [...this.listeners]) {
      try {
        listener({ ...next });
      } catch {
        // Listener errors must not break the probe.
      }
    }
  }
}

/** Format a child_process error into a single human-readable line. */
function formatExecError(err: unknown, context: string): string {
  if (err instanceof Error) {
    const maybeCode = (err as NodeJS.ErrnoException).code;
    const maybeSignal = (err as { signal?: string }).signal;
    // execFile surfaces SIGTERM when `timeout` fires.
    if (maybeSignal === 'SIGTERM' || /ETIMEDOUT|ESRCH/.test(String(maybeCode))) {
      return `${context}: timeout`;
    }
    if (maybeCode === 'ENOENT') return `${context}: not installed (ENOENT)`;
    return `${context}: ${err.message}`;
  }
  return `${context}: ${String(err)}`;
}
