/**
 * 0.50.x — the `ReviewProvider` seam for `rea review` (review.ts).
 *
 * Principal-engineer reconciliation (binding): this is the canonical
 * provider abstraction for the LIVE `rea review` path. It imports ONLY the
 * canonical `Finding` / `ReviewOutcome` vocabulary (from
 * `push-gate/findings.ts` and `review.ts`). The earlier dormant reviewer
 * abstraction (`src/gateway/reviewers/`, with its divergent `ReviewFinding`
 * / `ReviewResult` vocabulary) was orphaned scaffolding from the removed
 * push-review-gate era and was DELETED in 0.50.x; this seam is its
 * replacement. The live path unifies on `Finding`/`ReviewOutcome` with no
 * adapter.
 *
 * `runReview` switches on `policy.review.provider ?? 'codex'` (a plain
 * switch, NOT a registry — it does not consult `REA_REVIEWER` or
 * `registry.reviewer`). Each provider supplies the four pieces `runReview`
 * used to hardcode for codex: a stable `id` string, `isAvailable`,
 * `classifyError`, and `unavailableMessage`.
 */

import { spawnSync } from 'node:child_process';
import {
  IRON_GATE_DEFAULT_MODEL,
  IRON_GATE_DEFAULT_REASONING,
  CodexNotInstalledError,
  CodexProtocolError,
  CodexSubprocessError,
  CodexTimeoutError,
  createRealGitExecutor,
  runCodexReview,
} from '../hooks/push-gate/codex-runner.js';
import { resolvePushGatePolicy } from '../hooks/push-gate/policy.js';
import { resolveBaseRef } from '../hooks/push-gate/base.js';
import { summarizeReview } from '../hooks/push-gate/findings.js';
import { computeTreeToken, EMPTY_TREE_SHA } from '../audit/content-token.js';
import type { ReviewOutcome, RunReviewOptions } from './review.js';

/** A provider's availability probe result. */
export interface ProviderAvailability {
  available: boolean;
  version?: string;
}

/**
 * The provider contract. `runReview` selects one by `policy.review.provider`
 * and uses these methods in place of its former hardcoded codex coupling.
 */
export interface ReviewProvider {
  /** Written verbatim to the audit record's `provider` field. */
  readonly id: 'codex' | 'openrouter';
  /** Probe whether the provider can run (codex on PATH, key present, etc.). */
  isAvailable(baseDir: string): Promise<ProviderAvailability>;
  /** Run the review and translate the result to a canonical `ReviewOutcome`. */
  execute(baseDir: string, options: RunReviewOptions): Promise<ReviewOutcome>;
  /** Classify an error thrown by `execute` into `metadata.kind`. */
  classifyError(e: unknown): string;
  /** Operator-facing remediation lines printed in enforced mode. */
  unavailableMessage(): string[];
}

// ---------------------------------------------------------------------------
// CodexProvider — BYTE-IDENTICAL to the pre-0.50.x codex path.
// ---------------------------------------------------------------------------

/**
 * Probe `codex --version` synchronously. Same shape as the push-gate's
 * pre-flight probe — ENOENT/EACCES means "not installed". (Lifted verbatim
 * from review.ts's `probeCodexAvailable` — the golden test pins parity.)
 */
function probeCodexAvailable(cwd: string): ProviderAvailability {
  const probe = spawnSync('codex', ['--version'], {
    cwd,
    timeout: 2000,
    encoding: 'utf8',
  });
  if (probe.error !== undefined) {
    return { available: false };
  }
  if (probe.status !== 0) {
    return { available: false };
  }
  const version = (probe.stdout ?? '').toString().trim();
  return version.length > 0 ? { available: true, version } : { available: true };
}

/**
 * FIX A (round-2): synchronous codex `--version` probe for the openrouter
 * provider's codex-fallback path — so a codex-served outcome can carry codex's
 * real `provider_version`. Returns undefined when codex is unavailable / has
 * no version. Never throws.
 */
export function probeCodexVersion(cwd: string): string | undefined {
  const r = probeCodexAvailable(cwd);
  return r.available ? r.version : undefined;
}

/**
 * FIX H (round-4): synchronous codex availability check for the openrouter
 * provider's fallback gate. Returns `true` iff codex is installed/usable
 * (independent of whether it reports a version string). Never throws.
 */
export function isCodexAvailable(cwd: string): boolean {
  return probeCodexAvailable(cwd).available;
}

/**
 * Execute the codex review subprocess and translate the output to a
 * verdict. Reuses the push-gate's resolved policy so `codex_model` /
 * `codex_reasoning_effort` / `timeout_ms` flow through identically.
 *
 * Lifted VERBATIM from review.ts's `executeCodexReview` (the body at the
 * pre-0.50.x review.ts:486–556). The golden test (review.golden.test.ts)
 * is the byte-identity acceptance gate for this move.
 */
async function executeCodexReview(
  baseDir: string,
  options: RunReviewOptions,
): Promise<ReviewOutcome> {
  const resolved = await resolvePushGatePolicy(baseDir);
  const git = createRealGitExecutor(baseDir);
  const explicit = options.base !== undefined && options.base.length > 0 ? options.base : undefined;
  const base = explicit !== undefined ? resolveBaseRef(git, { explicit }) : resolveBaseRef(git);
  const resolvedHeadSha = git.headSha();
  const headSha = resolvedHeadSha.length > 0 ? resolvedHeadSha : EMPTY_TREE_SHA;
  const contentToken = computeTreeToken(baseDir);

  const codexResult = await runCodexReview({
    baseRef: base.ref,
    cwd: baseDir,
    timeoutMs: resolved.timeout_ms,
    env: process.env,
    ...(resolved.codex_model !== undefined ? { model: resolved.codex_model } : {}),
    ...(resolved.codex_reasoning_effort !== undefined
      ? { reasoningEffort: resolved.codex_reasoning_effort }
      : {}),
  });
  const summary = summarizeReview(codexResult.reviewText);
  return {
    verdict: summary.verdict,
    findingCount: summary.findings.length,
    baseRef: base.ref,
    headSha,
    contentToken,
    durationSeconds: codexResult.durationSeconds,
    model: resolved.codex_model ?? IRON_GATE_DEFAULT_MODEL,
    reasoningEffort: resolved.codex_reasoning_effort ?? IRON_GATE_DEFAULT_REASONING,
    findings: summary.findings,
    reviewText: codexResult.reviewText,
    eventCount: codexResult.eventCount,
  };
}

/** Classify a codex execution error into `metadata.kind`. Verbatim. */
function classifyCodexError(e: unknown): string {
  if (e instanceof CodexNotInstalledError) return 'not-installed';
  if (e instanceof CodexTimeoutError) return 'timeout';
  if (e instanceof CodexProtocolError) return 'protocol';
  if (e instanceof CodexSubprocessError) return 'subprocess';
  return 'unknown';
}

/**
 * The codex provider. `id === 'codex'`. Every method is a verbatim lift of
 * the pre-0.50.x review.ts codex coupling, so the codex path's observable
 * output (audit line, JSON payload, last-review.json, exit code) is
 * unchanged. The golden test is the regression wall.
 */
export const CodexProvider: ReviewProvider = {
  id: 'codex',
  isAvailable(baseDir: string): Promise<ProviderAvailability> {
    return Promise.resolve(probeCodexAvailable(baseDir));
  },
  execute: executeCodexReview,
  classifyError: classifyCodexError,
  unavailableMessage(): string[] {
    // The exact lines printed at the pre-0.50.x review.ts:260–267.
    return [
      'codex CLI not found on PATH.',
      '',
      '  Install:  npm i -g @openai/codex',
      '  Or set:   policy.review.local_review.mode: off',
      '            (in .rea/policy.yaml — disables local-review enforcement',
      '             for teams without codex/claude installed)',
      '',
    ];
  },
};
