/**
 * 0.50.x — `provider: both` shadow + parity orchestration (Phase 5A).
 *
 * Principal-engineer Decision 5 (binding): in `provider: both`, the
 * AUTHORITATIVE Codex outcome (already written under the canonical
 * `rea.local_review` tool name + driving the exit code) is untouched. This
 * module runs the OpenRouter provider in a NEVER-THROWING wrapper, writes the
 * gpt-oss outcome under the distinct informational `rea.local_review.shadow`
 * tool name, and emits a side-by-side parity report. The shadow's
 * failure / error / verdict MUST NOT affect the exit code or the canonical
 * record, and the shadow record is NEVER preflight coverage.
 *
 * The parity report (verdict agreement, P1/P2 overlap, FP delta,
 * malformed-rate, latency, cost) is a SEPARATE artifact — never written into
 * the audit verdict fields.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import {
  LOCAL_REVIEW_SHADOW_TOOL_NAME,
  type LocalReviewMetadata,
} from '../audit/local-review-event.js';
import { InvocationStatus, type Policy } from '../policy/types.js';
import type { Finding } from '../hooks/push-gate/findings.js';
import { OpenRouterUnauthorizedError } from './review-openrouter.js';
import type { ReviewProvider } from './review-provider.js';
import type { ReviewOutcome, RunReviewOptions, ShadowCapture } from './review.js';

/** Where the side-by-side parity artifact is written. */
export const PARITY_REPORT_RELATIVE = path.join('.rea', 'review-parity.json');

export interface ParityReport {
  schema_version: 1;
  generated_at: string;
  /** Did the two providers agree on the verdict? */
  verdict_agreement: boolean;
  codex_verdict: string;
  openrouter_verdict: string;
  /** P1 titles present in BOTH (count). */
  p1_overlap: number;
  /** P2 titles present in BOTH (count). */
  p2_overlap: number;
  /**
   * False-positive delta: findings openrouter raised that codex did NOT
   * (by title), as a count. A proxy for "extra noise."
   */
  fp_delta: number;
  /** Did the openrouter lane produce a malformed (error) outcome? */
  malformed: boolean;
  codex_latency_seconds: number;
  openrouter_latency_seconds: number;
  /**
   * FIX L (round-6): the REAL est. cost of the SHADOW openrouter call in USD,
   * threaded from the shadow run's telemetry. `0` only when the shadow lane
   * refused / failed / produced no usage (NOT a fake success-zero).
   */
  openrouter_est_cost_usd: number;
  /**
   * FIX K (round-6): set when the shadow openrouter lane REFUSED (e.g.
   * strawn-legal path, backend-pin violation) — there is no parity data this
   * run. The refusal is surfaced HERE, never as a `refused_external` audit
   * record (that would imply a codex fallback that never ran in shadow mode).
   */
  openrouter_refused?: { refusal_class: string; matched_rule?: string };
  /**
   * M3 (round-8): set when the shadow openrouter lane was UNAVAILABLE (no /
   * revoked key). `provider: both` must ALWAYS emit a CURRENT parity artifact
   * (spec contract) — so this branch rewrites a FRESH self-describing report
   * (`malformed: true`, `openrouter_verdict: 'error'`, cost 0) rather than
   * leaving a prior run's report looking current.
   */
  openrouter_unavailable?: true;
  /**
   * codex round-6 P2: set when the shadow lane was ABANDONED after exceeding its
   * single-attempt budget (`SHADOW_DEFAULT_BUDGET_MS` / configured `timeout_ms`)
   * — `provider: both` must never block the authoritative codex exit on the
   * shadow's full 3-attempt retry ladder.
   */
  openrouter_timed_out?: true;
}

/**
 * The shadow lane (provider:both) is bounded to a SINGLE attempt's wall-clock,
 * NOT the authoritative 3-attempt + backoff ladder. A slow/unreachable backend
 * must not turn a successful codex review into a multi-minute wait — the shadow
 * is purely informational (separate parity artifact + `*.shadow` audit record,
 * never coverage), so abandoning it on a deadline is safe. (codex round-6 P2)
 */
const SHADOW_DEFAULT_BUDGET_MS = 120_000;

function resolveShadowBudgetMs(policy: Policy | undefined): number {
  const t = policy?.review?.providers?.openrouter?.timeout_ms;
  return typeof t === 'number' && t > 0 ? t : SHADOW_DEFAULT_BUDGET_MS;
}

interface ShadowRaceResult {
  outcome?: ReviewOutcome;
  timedOut: boolean;
  /** The rejection reason when the execute promise rejected (else undefined). */
  error?: unknown;
}

/**
 * codex round-8 B2: the result of the shadow lane's EXECUTION (availability
 * probe + budget-raced execute), captured so it can run CONCURRENTLY with the
 * authoritative codex review and be assembled into the parity report AFTER
 * codex settles. Never throws — every failure mode is a flag here, so a hung /
 * unavailable / crashing shadow can never affect the codex exit or canonical
 * record.
 */
export interface ShadowExecResult {
  /** The shadow outcome when it completed in budget and was available. */
  outcome?: ReviewOutcome;
  /** The shadow provider was unavailable (no/revoked key). */
  unavailable: boolean;
  /** The shadow execute exceeded its single-attempt budget. */
  timedOut: boolean;
  /** The shadow execute threw / produced an error outcome. */
  malformed: boolean;
}

/**
 * Kick off the shadow lane's EXECUTION (availability probe + budget-raced
 * execute). NEVER throws. In `provider: both` the caller starts this BEFORE
 * awaiting the authoritative codex review so the gpt-oss shadow overlaps the
 * (typically far longer) codex run — adding ≈0 to wall-clock — then awaits the
 * already-(nearly-)finished result to assemble the parity report. The
 * round-6 single-attempt budget (`resolveShadowBudgetMs`) is preserved as a
 * backstop so a hung shadow can't dominate even when overlapped.
 */
export async function startShadowExecution(input: {
  baseDir: string;
  options: RunReviewOptions;
  policy: Policy | undefined;
  shadowProvider: ReviewProvider;
}): Promise<ShadowExecResult> {
  const { baseDir, options, policy, shadowProvider } = input;
  try {
    const avail = await shadowProvider.isAvailable(baseDir);
    if (!avail.available) {
      return { unavailable: true, timedOut: false, malformed: false };
    }
    const raced = await raceShadowExecute(
      shadowProvider.execute(baseDir, options),
      resolveShadowBudgetMs(policy),
    );
    if (raced.timedOut) {
      return { unavailable: false, timedOut: true, malformed: false };
    }
    // codex round-10 P3: a present-but-revoked key makes the shadow execute
    // throw OpenRouterUnauthorizedError. Surface it as UNAVAILABLE (the
    // actionable auth problem → parity report shows `openrouter_unavailable`),
    // not generic `malformed` (a model/output failure the operator can't act on).
    if (raced.error instanceof OpenRouterUnauthorizedError) {
      return { unavailable: true, timedOut: false, malformed: false };
    }
    if (raced.outcome === undefined || raced.outcome.verdict === 'error') {
      return {
        unavailable: false,
        timedOut: false,
        malformed: true,
        ...(raced.outcome !== undefined ? { outcome: raced.outcome } : {}),
      };
    }
    return { outcome: raced.outcome, unavailable: false, timedOut: false, malformed: false };
  } catch {
    // Any throw from the shadow lane is swallowed — it is informational.
    return { unavailable: false, timedOut: false, malformed: true };
  }
}

/**
 * Resolve with the shadow outcome if it completes within `budgetMs`, else
 * `{ timedOut: true }`. A rejection resolves to `{ timedOut: false }` (no
 * outcome → treated as malformed downstream, matching the pre-existing throw
 * path). The deadline timer is `unref`'d and the dangling execute is left to be
 * reaped by the imminent `process.exit`; its late settlement is a no-op here.
 */
function raceShadowExecute(p: Promise<ReviewOutcome>, budgetMs: number): Promise<ShadowRaceResult> {
  return new Promise<ShadowRaceResult>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ timedOut: true });
    }, budgetMs);
    if (typeof timer.unref === 'function') timer.unref();
    p.then(
      (outcome) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ outcome, timedOut: false });
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ timedOut: false, error });
      },
    );
  });
}

export interface RunShadowParityInput {
  baseDir: string;
  options: RunReviewOptions;
  policy: Policy | undefined;
  /** The authoritative codex outcome (already written canonically). */
  codexOutcome: ReviewOutcome;
  /** The openrouter provider (selected by the caller). */
  shadowProvider: ReviewProvider;
  /**
   * codex round-8 B2: an OPTIONAL pre-started shadow execution. When the caller
   * (runReview, `provider: both`) kicks the shadow's gpt-oss execute off
   * CONCURRENTLY with the authoritative codex review and passes the resulting
   * promise here, `runShadowParity` awaits it instead of starting a fresh
   * execution — so the shadow's latency overlaps codex's (≈0 added wall-clock).
   * When absent (direct test callers), `runShadowParity` runs the execution
   * itself via `startShadowExecution`, preserving the prior behavior.
   */
  shadowExec?: Promise<ShadowExecResult>;
  /**
   * FIX K + L (round-6): shared capture object the shadow provider's sinks
   * write into — carries the shadow lane's refusal (instead of a
   * `refused_external` audit record) and its REAL est-cost, both surfaced in
   * the parity report. Optional for back-compat with direct callers/tests.
   */
  shadowCapture?: ShadowCapture;
  /** The caller's best-effort audit appender (never throws). */
  safeAudit: (
    baseDir: string,
    toolName: string,
    status: InvocationStatus,
    metadata: Record<string, unknown>,
    policy: Policy | undefined,
  ) => Promise<void>;
}

/**
 * Count title overlaps at a given severity between two finding lists.
 */
function overlapAtSeverity(a: Finding[], b: Finding[], sev: 'P1' | 'P2'): number {
  const titlesB = new Set(b.filter((f) => f.severity === sev).map((f) => f.title));
  let n = 0;
  for (const f of a) {
    if (f.severity === sev && titlesB.has(f.title)) n += 1;
  }
  return n;
}

/**
 * Best-effort atomic-ish write of the parity artifact. A write failure must
 * never surface — the shadow lane is purely informational.
 */
async function writeParityReport(baseDir: string, report: ParityReport): Promise<void> {
  try {
    const reportPath = path.join(baseDir, PARITY_REPORT_RELATIVE);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  } catch {
    // Parity artifact is best-effort — a write failure must not surface.
  }
}

/**
 * Run the shadow lane. NEVER throws. Returns the parity report it wrote (or
 * undefined when the shadow lane could not produce one). The caller awaits
 * this AFTER the canonical record + exit-code decision are settled enough
 * that nothing here can change them.
 */
export async function runShadowParity(
  input: RunShadowParityInput,
): Promise<ParityReport | undefined> {
  const {
    baseDir,
    options,
    policy,
    codexOutcome,
    shadowProvider,
    shadowExec,
    shadowCapture,
    safeAudit,
  } = input;
  try {
    // codex round-8 B2: consume the PRE-STARTED shadow execution when the caller
    // overlapped it with codex; otherwise run it now (direct-call back-compat).
    // Either way the execution NEVER throws (startShadowExecution is total).
    const exec: ShadowExecResult =
      shadowExec !== undefined
        ? await shadowExec
        : await startShadowExecution({ baseDir, options, policy, shadowProvider });

    if (exec.unavailable) {
      // Shadow provider unavailable (no/revoked key) — record a skip-shaped
      // shadow entry so the absence is visible. Codex stays authoritative.
      await safeAudit(
        baseDir,
        LOCAL_REVIEW_SHADOW_TOOL_NAME,
        InvocationStatus.Allowed,
        {
          head_sha: codexOutcome.headSha,
          base_ref: codexOutcome.baseRef,
          verdict: 'error',
          finding_count: 0,
          provider: shadowProvider.id,
          error: 'shadow provider unavailable',
        },
        policy,
      );
      // M3 (round-8): `provider: both` must ALWAYS emit a CURRENT parity
      // artifact — write a FRESH self-describing unavailable report so a
      // prior run's report can't persist looking current.
      const unavailableReport: ParityReport = {
        schema_version: 1,
        generated_at: new Date().toISOString(),
        verdict_agreement: false,
        codex_verdict: codexOutcome.verdict,
        openrouter_verdict: 'error',
        p1_overlap: 0,
        p2_overlap: 0,
        fp_delta: 0,
        malformed: true,
        codex_latency_seconds: codexOutcome.durationSeconds,
        openrouter_latency_seconds: 0,
        openrouter_est_cost_usd: 0,
        openrouter_unavailable: true,
      };
      await writeParityReport(baseDir, unavailableReport);
      return unavailableReport;
    }

    const shadowOutcome: ReviewOutcome | undefined = exec.outcome;
    const timedOut = exec.timedOut;
    // A timed-out / throwing / error-verdict execution is malformed for parity.
    const malformed = exec.malformed || shadowOutcome === undefined || shadowOutcome.verdict === 'error';

    // Write the shadow audit record under the DISTINCT tool name. Same
    // metadata shape as the canonical record so forensics line up, but it
    // can NEVER count as coverage (preflight's accept-list excludes it).
    const shadowMeta: LocalReviewMetadata = {
      head_sha: (shadowOutcome ?? codexOutcome).headSha,
      base_ref: (shadowOutcome ?? codexOutcome).baseRef,
      verdict: shadowOutcome?.verdict ?? 'error',
      finding_count: shadowOutcome?.findingCount ?? 0,
      provider: shadowProvider.id,
      model: shadowOutcome?.model ?? 'openai/gpt-oss-120b',
      reasoning_effort: shadowOutcome?.reasoningEffort ?? 'medium',
      duration_seconds: shadowOutcome?.durationSeconds ?? 0,
    };
    // The timeout signal is carried in the parity report (`openrouter_timed_out`)
    // — the shadow audit record shows verdict 'error' / finding_count 0, matching
    // the other non-completion shapes. (LocalReviewMetadata has no `error` field.)
    if (shadowOutcome?.contentToken !== undefined && shadowOutcome.contentToken.length > 0) {
      shadowMeta.content_token = shadowOutcome.contentToken;
    }
    if (shadowOutcome?.servedBy !== undefined) shadowMeta.served_by = shadowOutcome.servedBy;
    // M1 (round-8): the shadow record carries the SAME honest data-policy
    // posture (requested + derived enforcement), never the old `'deny-training'`
    // literal. Both omitted when the shadow outcome didn't produce them.
    if (shadowOutcome?.dataPolicyRequested !== undefined) {
      shadowMeta.data_policy_requested = shadowOutcome.dataPolicyRequested;
    }
    if (shadowOutcome?.dataPolicyEnforced !== undefined) {
      shadowMeta.data_policy_enforced = shadowOutcome.dataPolicyEnforced;
    }
    await safeAudit(
      baseDir,
      LOCAL_REVIEW_SHADOW_TOOL_NAME,
      InvocationStatus.Allowed,
      shadowMeta as unknown as Record<string, unknown>,
      policy,
    );

    // Build + write the parity report (separate artifact, NOT audit fields).
    const codexFindings = codexOutcome.findings;
    const orFindings = shadowOutcome?.findings ?? [];
    const codexTitles = new Set(codexFindings.map((f) => f.title));
    let fpDelta = 0;
    for (const f of orFindings) if (!codexTitles.has(f.title)) fpDelta += 1;

    // FIX K (round-6): a shadow refusal is surfaced in the parity report, NOT
    // as a `refused_external` audit record. FIX L: thread the REAL est-cost
    // from the shadow telemetry. On refusal/failure the cost is 0 (no
    // successful billable call), with the refusal noted.
    const refused = shadowCapture?.refusal;
    const estCostUsd =
      refused === undefined && typeof shadowCapture?.estCostUsd === 'number'
        ? shadowCapture.estCostUsd
        : 0;
    const report: ParityReport = {
      schema_version: 1,
      generated_at: new Date().toISOString(),
      verdict_agreement:
        !malformed && shadowOutcome !== undefined && shadowOutcome.verdict === codexOutcome.verdict,
      codex_verdict: codexOutcome.verdict,
      openrouter_verdict: shadowOutcome?.verdict ?? 'error',
      p1_overlap: overlapAtSeverity(codexFindings, orFindings, 'P1'),
      p2_overlap: overlapAtSeverity(codexFindings, orFindings, 'P2'),
      fp_delta: fpDelta,
      malformed,
      codex_latency_seconds: codexOutcome.durationSeconds,
      openrouter_latency_seconds: shadowOutcome?.durationSeconds ?? 0,
      openrouter_est_cost_usd: estCostUsd,
      ...(timedOut ? { openrouter_timed_out: true as const } : {}),
      ...(refused !== undefined
        ? {
            openrouter_refused: {
              refusal_class: refused.refusalClass,
              ...(refused.matchedRule !== undefined ? { matched_rule: refused.matchedRule } : {}),
            },
          }
        : {}),
    };
    await writeParityReport(baseDir, report);
    return report;
  } catch {
    // Belt-and-suspenders: the WHOLE shadow lane is non-throwing.
    return undefined;
  }
}
