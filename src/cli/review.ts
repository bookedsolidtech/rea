/**
 * `rea review` — local-first codex review CLI (0.26.0+).
 *
 * Runs `codex exec review` against the working tree (or a specified
 * base ref), parses the verdict, and writes a `rea.local_review`
 * audit entry that `rea preflight` consults.
 *
 * Exit codes:
 *
 *   0 — pass (or skipped because `mode: off` + codex unavailable)
 *   1 — concerns (configurable via --strict-fail-on)
 *   2 — blocking, codex error, or codex unavailable in `mode: enforced`
 *
 * Behavior matrix:
 *
 *   policy.local_review.mode  codex available?  result
 *   ------------------------  ---------------   ----------------------
 *   enforced or unset (def.)  yes               run review, audit
 *   enforced or unset (def.)  no                exit 2 with helpful msg
 *   off                       yes               run review, audit
 *   off                       no                exit 0, audit skipped
 *
 * The `provider` field on the audit record is `'codex'` today. Future
 * providers (Claude-subagent, Pi, Gemma) write the SAME `rea.local_review`
 * shape with their own `provider:` value — `rea preflight` accepts any.
 *
 * The CLI is a thin wrapper around `runCodexReview` from
 * `src/hooks/push-gate/codex-runner.ts`. We do NOT re-implement codex
 * spawning. The push-gate's iron-gate defaults (gpt-5.4 + high reasoning)
 * apply identically here so a local review carries the same weight as
 * the push-gate's review.
 */

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { Command } from 'commander';
import { createRealGitExecutor } from '../hooks/push-gate/codex-runner.js';
import { appendAuditRecord } from '../audit/append.js';
import {
  LOCAL_REVIEW_TOOL_NAME,
  LOCAL_REVIEW_REFUSED_EXTERNAL_TOOL_NAME,
  LOCAL_REVIEW_SKIPPED_UNAVAILABLE_TOOL_NAME,
  LOCAL_REVIEW_SERVER_NAME,
  type LocalReviewMetadata,
  type LocalReviewRefusedExternalMetadata,
  type LocalReviewSkippedUnavailableMetadata,
  type LocalReviewVerdict,
} from '../audit/local-review-event.js';
import { recordTelemetry } from '../gateway/observability/codex-telemetry.js';
import { Tier, InvocationStatus, type Policy } from '../policy/types.js';
import { loadPolicyAsync } from '../policy/loader.js';
import {
  type Finding,
  type Verdict as PushGateVerdict,
} from '../hooks/push-gate/findings.js';
import { writeLastReview, type LastReviewPayload } from '../hooks/push-gate/report.js';
import {
  compileDefaultSecretPatterns,
  redactSecrets,
  type CompiledSecretPattern,
} from '../gateway/middleware/redact.js';
import {
  CodexProvider,
  probeCodexVersion,
  isCodexAvailable,
  type ReviewProvider,
} from './review-provider.js';
import {
  OpenRouterProvider,
  OpenRouterExternalRefusedError,
  OpenRouterUnauthorizedError,
  type ExecuteOpenRouterReview,
  type OpenRouterTransport,
} from './review-openrouter.js';
import type { ChangedPathsEnumerator } from './review-pathguard.js';
import {
  runShadowParity,
  startShadowExecution,
  type ShadowExecResult,
} from './review-shadow.js';
import { err, log } from './utils.js';

/** Relative path to the last-review snapshot, surfaced in JSON output. */
const LAST_REVIEW_RELATIVE = '.rea/last-review.json';

/**
 * 0.28.1 defect-V round-1 P2-1: shared redactor for the
 * `writeLastReview` failure path. The canonical writer redacts findings
 * before serialization; if it threw we still need to redact the
 * in-memory findings before they reach `--with-findings` stdout or
 * `--json --with-findings`. Without this, a writer failure (read-only
 * .rea/, ENOSPC, race) would let unredacted Codex prose — which can
 * quote secrets from the diff — escape via the new surfaces, defeating
 * the redaction guarantee the writer provides.
 */
function redactFindingsInMemory(findings: readonly Finding[]): Finding[] {
  const patterns: CompiledSecretPattern[] = compileDefaultSecretPatterns({ source: 'default' });
  const redactStr = (s: string): string => redactSecrets(s, patterns).output;
  return findings.map((f) => ({
    severity: f.severity,
    title: redactStr(f.title),
    body: redactStr(f.body),
    ...(f.file !== undefined ? { file: f.file } : {}),
    ...(f.line !== undefined ? { line: f.line } : {}),
  }));
}

export interface RunReviewOptions {
  /** Optional explicit base ref. Defaults to upstream-ladder resolution. */
  base?: string;
  /**
   * Verdict floor that turns into a non-zero exit. `'concerns'` exits 1
   * on concerns; `'blocking'` (default) exits 0 on concerns and 2 only
   * on blocking. Aligns with the push-gate's `concerns_blocks` knob.
   */
  strictFailOn?: 'concerns' | 'blocking';
  /** Emit a single JSON line on stdout instead of pretty output. */
  json?: boolean;
  /**
   * 0.28.1 defect-V: when true, after the human-readable summary line
   * (or alongside the JSON payload), emit the finding bodies grouped by
   * severity. Default off — preserves backward-compatible single-line
   * stdout for existing CI consumers.
   */
  withFindings?: boolean;
  /**
   * 0.50.x — `--provider` flag. When set, OVERRIDES
   * `policy.review.provider` for this invocation only. Useful for the
   * cross-repo smoke harness and for an operator who wants to try the
   * openrouter lane without editing policy. Resolution precedence:
   * `options.provider` → `policy.review.provider` → `'codex'`.
   */
  provider?: 'codex' | 'openrouter' | 'both';
}

/**
 * Exported so tests can construct fake outcomes for the seam in
 * `runReview`. Production callers don't reference this directly.
 */
export interface ReviewOutcome {
  verdict: LocalReviewVerdict;
  findingCount: number;
  baseRef: string;
  headSha: string;
  /**
   * 0.26.0 helix-026 finding-1: tree SHA of HEAD at review time. The
   * deterministic content fingerprint `rea preflight` matches coverage
   * on. Empty string when not resolvable (no HEAD, no git repo) — the
   * audit writer omits `content_token` from metadata in that case.
   */
  contentToken: string;
  durationSeconds: number;
  model: string;
  reasoningEffort: string;
  /**
   * 0.28.1 defect-V: structured findings produced by the review. Pre-fix
   * the CLI threw these away after counting; agents could not remediate
   * blocking verdicts because the bodies were unreadable through any
   * documented surface.
   */
  findings: Finding[];
  /**
   * 0.28.1 defect-V: full agent-prose review text. Persisted to
   * `.rea/last-review.json` (post-redaction) so consumers have a
   * machine-readable transcript for parser-miss debugging.
   */
  reviewText: string;
  /** Count of raw JSONL events from codex — recorded in last-review.json. */
  eventCount: number;
  /**
   * 0.50.x — provider version reported by the provider's availability probe
   * (codex `--version`) OR, for openrouter, omitted (the version is the
   * model id, already in `model`). When set, `runReview` writes it to the
   * audit record's `provider_version`. For the CODEX path this is left
   * undefined here — codex's `provider_version` comes from the availability
   * probe captured in `runReview`, NOT from the outcome — so the codex audit
   * line stays byte-identical. OpenRouter never sets it.
   */
  providerVersion?: string;
  /**
   * 0.50.x — OpenRouter serving backend (e.g. `'fireworks'`). Written to the
   * audit record's `served_by` AFTER `provider_version`. OMITTED on the
   * codex path (codex outcomes never set it), so codex audit lines do not
   * gain the key.
   */
  servedBy?: string;
  /**
   * 0.50.x round-8 (M1) — the REQUESTED data-policy posture (what rea asked
   * for on the outbound request — `'deny'` on an openrouter success). Written
   * to the audit record's `data_policy_requested`. OMITTED on the codex path
   * and on refusal/fallback outcomes (openrouter produced no kept outcome).
   */
  dataPolicyRequested?: string;
  /**
   * 0.50.x round-8 (M1) — the DERIVED enforcement posture:
   * `'pin-verified'` when a non-empty `backend_pin` is set AND `served_by ∈
   * pin`; `'routing-requested'` otherwise. DERIVED in `executeOpenRouterReview`
   * (the only place served_by + pin are both in scope); review.ts does NOT
   * recompute. Written to the audit record's `data_policy_enforced`. OMITTED
   * on the codex path and on refusal/fallback outcomes.
   */
  dataPolicyEnforced?: 'pin-verified' | 'routing-requested';
  /**
   * 0.50.x round-2 FIX A — the provider that ACTUALLY produced this outcome,
   * which may DIFFER from the authoritative provider selected by policy. When
   * `provider: openrouter` is configured but the external lane refused
   * (path-guard / redact-timeout / backend-pin / HTTP failure / invalid-policy)
   * and the codex fallback ran, this is `'codex'` — so the audit record and
   * `--json` name the provider that really reviewed, not the one that was
   * asked. When undefined (the pure single-provider path), `runReview` falls
   * back to the authoritative provider's id (preserves codex byte-identity:
   * the codex provider leaves this undefined, so `provider` stays `'codex'`).
   */
  actualProviderId?: 'codex' | 'openrouter';
  /**
   * 0.50.x round-2 FIX A — the `provider_version` of the provider that
   * ACTUALLY ran. Sourced into `metadata.provider_version` when present (e.g.
   * codex's `--version` when the openrouter lane fell back to codex). When
   * undefined, `runReview` falls back to its own availability-probe version
   * (codex byte-identity preserved on the pure codex path).
   */
  actualProviderVersion?: string;
}

/**
 * Resolve the effective `local_review.mode`. A missing policy is treated
 * as `enforced` — the protective default. A missing `local_review` block
 * also enforces. Only an explicit `mode: off` opts out.
 */
export interface BestEffortProvider {
  /** The raw `review.provider` value, when readable and a known lane. */
  provider?: 'codex' | 'openrouter' | 'both';
  /**
   * codex round-10 P1: TRUE iff the raw YAML PARSED (even if schema-invalid
   * elsewhere). This distinguishes "YAML parsed but `provider` absent" — a
   * genuine codex default, SAFE to run — from "YAML is syntactically broken so
   * we cannot read the provider AT ALL" — which must FAIL CLOSED, because the
   * repo may have been configured for openrouter/both and we can't confirm it
   * is codex-only.
   */
  rawParsed: boolean;
}

/**
 * codex round-7 P2 + round-10 P1: best-effort read of `review.provider` from the
 * RAW policy file, used ONLY when full schema validation fails (the file EXISTS
 * but is temporarily malformed). A repo configured for `openrouter`/`both` must
 * still route to the openrouter provider so it writes the VISIBLE
 * `invalid-policy` refusal (fail-closed) — never silently degrade to a plain
 * codex run that hides the broken config. When the YAML itself is unparseable we
 * report `rawParsed: false` so the caller fails closed rather than assuming codex.
 */
export function bestEffortConfiguredProvider(baseDir: string): BestEffortProvider {
  try {
    const raw = fs.readFileSync(path.join(baseDir, '.rea', 'policy.yaml'), 'utf8');
    const doc = parseYaml(raw) as { review?: { provider?: unknown } } | undefined;
    const p = doc?.review?.provider;
    if (p === 'codex' || p === 'openrouter' || p === 'both') return { provider: p, rawParsed: true };
    return { rawParsed: true };
  } catch {
    // Unreadable OR syntactically-unparseable YAML — we cannot determine intent.
    return { rawParsed: false };
  }
}

async function resolveLocalReviewMode(baseDir: string): Promise<{
  mode: 'enforced' | 'off';
  policy: Policy | undefined;
  configuredProvider?: 'codex' | 'openrouter' | 'both';
  /**
   * codex round-8 B1: true when `.rea/policy.yaml` EXISTS but failed to load
   * (schema-invalid / unparseable). Distinct from a genuinely MISSING policy
   * (file absent → safe codex defaults). When this is true AND the configured
   * provider is openrouter/both, `runReview` refuses the review with a VISIBLE
   * `invalid-policy` outcome (fail-closed) rather than silently writing codex
   * coverage for a broken external-lane config.
   */
  policyInvalidButPresent: boolean;
  /**
   * codex round-10 P1: whether the raw policy YAML parsed when the policy was
   * invalid-but-present. FALSE means the YAML is syntactically broken so the
   * configured provider could NOT be read — the caller must fail closed (it
   * cannot confirm a codex-only config). Always true on the valid-policy path.
   */
  policyRawReadable: boolean;
}> {
  let policy: Policy | undefined;
  try {
    policy = await loadPolicyAsync(baseDir);
  } catch {
    // Missing OR invalid. Best-effort the configured provider from the raw
    // file so an EXISTING-but-invalid openrouter/both config still routes to
    // the openrouter provider (→ visible `invalid-policy` fail-closed), not a
    // silent plain-codex run (codex round-7 P2). A genuinely MISSING policy
    // yields undefined here → the safe codex default, unchanged.
    const be = bestEffortConfiguredProvider(baseDir);
    // codex round-8 B1: distinguish invalid-but-PRESENT from genuinely MISSING.
    const present = fs.existsSync(path.join(baseDir, '.rea', 'policy.yaml'));
    return {
      mode: 'enforced',
      policy: undefined,
      policyInvalidButPresent: present,
      policyRawReadable: be.rawParsed,
      ...(be.provider !== undefined ? { configuredProvider: be.provider } : {}),
    };
  }
  const mode = policy.review?.local_review?.mode ?? 'enforced';
  const cp = policy.review?.provider;
  return {
    mode,
    policy,
    policyInvalidButPresent: false,
    policyRawReadable: true,
    ...(cp !== undefined ? { configuredProvider: cp } : {}),
  };
}

/**
 * 0.28.1 defect-V — narrow test seam. Production callers never set this;
 * tests inject a fake to drive `runReview` deterministically without
 * spawning codex. The seam matches `executeCodexReview`'s signature so
 * the production path and the test path go through the same downstream
 * wiring (audit append, last-review.json, exit code, output).
 *
 * 0.50.x: extended with `executeOpenRouterReview` (the sibling seam for the
 * openrouter provider — the QA plan REQUIRES an injectable transport so no
 * required test ever hits the network) and `providerOverride` (lets a test
 * inject a fully-faked `ReviewProvider` to drive `isAvailable`/`unavailable`
 * branches deterministically without spawning codex).
 */
export interface RunReviewDeps {
  executeCodexReview?: (
    baseDir: string,
    options: RunReviewOptions,
  ) => Promise<ReviewOutcome>;
  /**
   * 0.50.x — the openrouter execution seam. Mirrors `executeCodexReview`.
   * When set, the openrouter provider's `execute` delegates to this instead
   * of building a real transport — so unit tests inject a mocked transport
   * outcome and never call `fetch`.
   */
  executeOpenRouterReview?: ExecuteOpenRouterReview;
  /**
   * 0.50.x — fully replace provider selection. When set, `runReview` uses
   * THIS provider regardless of `policy.review.provider`. Used by golden /
   * availability tests to drive the codex-unavailable + error branches
   * deterministically. Mutually independent of the two execute seams.
   */
  providerOverride?: ReviewProvider;
  /**
   * TEST-ONLY (round-8 accuracy matrix): inject the openrouter provider's
   * transport / changed-path enumerator / env into the REAL `selectProvider`
   * wiring so the accuracy tests drive the full production path (refusal
   * records, data-policy derivation, fallback truth) end-to-end through
   * `runReview` against a mock transport, with NO network. Production never
   * sets this. Merged into the `ProviderWiringCtx`.
   */
  __testProviderSeams?: {
    transport?: OpenRouterTransport;
    enumerate?: ChangedPathsEnumerator;
    env?: NodeJS.ProcessEnv;
    /** Force codex availability deterministically (FIX H gate). */
    codexAvailable?: () => boolean;
    /** Codex fallback execute (so refuse+codex-avail runs a fake codex). */
    codexFallback?: ExecuteOpenRouterReview;
    /** Codex version probe (for the fallback record's provider_version). */
    codexProbeVersion?: () => string | undefined;
  };
}

/**
 * FIX H (round-4): write the `skipped_unavailable` audit record and exit 0 —
 * the documented `local_review.mode: off` opt-out. Factored out so BOTH the
 * provider-unavailable branch AND the openrouter "external refused + codex
 * absent" branch reuse the SAME semantics (the prescription's
 * "reuse that mode branch rather than duplicating"). Never returns.
 */
async function writeSkippedUnavailableAndExit(args: {
  baseDir: string;
  provider: string;
  reason: string;
  json: boolean;
  policy: Policy | undefined;
  /** When the external lane refused, the refusal class (forensic only). */
  refusalClass?: string;
  /** Best-effort head sha to record (already resolved by the caller). */
  headSha?: string;
}): Promise<never> {
  const { baseDir, provider, reason, json, policy } = args;
  const skipped: LocalReviewSkippedUnavailableMetadata = { reason, provider };
  // Prefer a caller-supplied head sha; else best-effort probe.
  let head = args.headSha;
  if (head === undefined || head.length === 0) {
    try {
      head = createRealGitExecutor(baseDir).headSha();
    } catch {
      head = undefined;
    }
  }
  if (head !== undefined && head.length > 0) skipped.head_sha = head;
  await safeAudit(
    baseDir,
    LOCAL_REVIEW_SKIPPED_UNAVAILABLE_TOOL_NAME,
    InvocationStatus.Allowed,
    skipped as unknown as Record<string, unknown>,
    policy,
  );
  if (json) {
    process.stdout.write(
      JSON.stringify({
        status: 'skipped',
        reason,
        ...(args.refusalClass !== undefined ? { refusal_class: args.refusalClass } : {}),
      }) + '\n',
    );
  } else {
    log(`${provider} unavailable — review skipped (policy.review.local_review.mode: off).`);
  }
  process.exit(0);
}

/**
 * Public runner — exposed so tests can drive the function in-process and
 * the commander binding can stay thin. Throws via `process.exit` (CLI
 * convention across `src/cli/`).
 */
/**
 * Round-16: resolve the GIT ROOT. `git diff --name-only` yields
 * repo-root-relative paths, so policy load, the path-guard `canonRoot`, and
 * diff assembly must all key off the toplevel — NOT a nested cwd, which makes
 * `loadPolicyAsync` miss the root `.rea/policy.yaml` (wrong lane) and the guard
 * join repo-relative paths onto the wrong base (over-refusal). Falls back to
 * cwd outside a git repo (the unborn/scaffolding case stays supported).
 */
export function resolveRepoRoot(cwd: string): string {
  // Round-16: key off the GIT TOPLEVEL, not a nested cwd. This is LOAD-BEARING
  // and intentionally NOT "nearest `.rea/`": `git diff --name-only` from a subdir
  // yields REPO-ROOT-RELATIVE paths (`packages/api/...`), which the path-guard
  // joins onto this base — so the base MUST be the git root or ordinary files
  // resolve as `<pkg>/packages/api/...` and refuse as realpath-unresolved. The
  // whole rea state directory is ALSO top-level: `rea preflight` + the pre-push
  // hook read the top-level `.rea/`, so writing coverage into a package-local
  // `.rea/` would be invisible to the push gate. A package-local `.rea/` install
  // inside a larger checkout is therefore NOT supported — the git toplevel is
  // authoritative. (codex round-19 proposed nearest-`.rea/`; round-20 showed it
  // breaks both the guard's path-joining and push-gate coverage — reverted.)
  try {
    const top = createRealGitExecutor(cwd).tryRevParse(['--show-toplevel']);
    return top.length > 0 ? top : cwd;
  } catch {
    return cwd;
  }
}

export async function runReview(
  options: RunReviewOptions,
  deps: RunReviewDeps = {},
): Promise<void> {
  // Round-16: key off the git root, not a nested cwd, so policy/provider
  // selection + the path-guard + diff assembly are consistent from a monorepo
  // subdirectory. Byte-identical when cwd IS the root (golden test unaffected).
  const baseDir = resolveRepoRoot(process.cwd());
  const strictFailOn = options.strictFailOn ?? 'blocking';
  const { mode, policy, configuredProvider, policyInvalidButPresent, policyRawReadable } =
    await resolveLocalReviewMode(baseDir);

  // 0.50.x — select the AUTHORITATIVE provider by `policy.review.provider`.
  // A plain switch (NOT a registry, NOT REA_REVIEWER, NOT registry.reviewer).
  // `'both'` is parity-test mode: codex is authoritative + drives the exit
  // code, the openrouter outcome is a never-throwing shadow handled AFTER the
  // canonical record is written. So selection collapses to codex|openrouter
  // here; the shadow lane is orchestrated separately below.
  // `--provider` flag overrides policy for this invocation only. When the
  // policy is valid, `configuredProvider` IS `policy.review.provider`; when it
  // is invalid-but-present, it is the best-effort raw read (codex round-7 P2)
  // so an openrouter/both repo still hits the visible `invalid-policy`
  // fail-closed path instead of a silent codex run.
  const providerKind = options.provider ?? configuredProvider ?? 'codex';

  // codex round-8 B1 [P2]: a `.rea/policy.yaml` that EXISTS but fails to load
  // (schema-invalid / unparseable) must FAIL CLOSED for the external lane.
  // Today `provider: both` resolves the AUTHORITATIVE lane to codex, so a broken
  // openrouter parity config would silently write canonical codex coverage (the
  // shadow swallows the invalid policy). When the configured provider is
  // openrouter OR both AND the policy is invalid-but-present, refuse the review
  // with a VISIBLE `invalid-policy` outcome (exit 2) — mirroring the fail-closed
  // semantics the openrouter executor already applies for `provider: openrouter`
  // — rather than running codex as if the config were fine. A genuinely MISSING
  // policy is distinct (safe codex defaults) and never trips this.
  // codex round-10 P1: fail closed for openrouter/both AND for the case where
  // the YAML is so broken we cannot even read the provider (`!policyRawReadable`
  // + no explicit `--provider`). The ONLY invalid-but-present case allowed to
  // proceed as codex is an affirmatively codex-or-absent config we could READ
  // (`policyRawReadable` true with provider codex/absent), or an explicit
  // `--provider codex`. Otherwise we cannot confirm the repo isn't an
  // openrouter/both parity config, so we must not silently write codex coverage.
  const intendedProvider = options.provider ?? configuredProvider; // undefined if YAML unreadable + no flag
  const cannotConfirmCodex =
    intendedProvider === 'openrouter' ||
    intendedProvider === 'both' ||
    (intendedProvider === undefined && !policyRawReadable);
  if (policyInvalidButPresent && cannotConfirmCodex) {
    const which = intendedProvider ?? 'undetermined (policy YAML unparseable)';
    const reason =
      '.rea/policy.yaml exists but is invalid (schema-invalid or unparseable) — ' +
      `refusing the ${which} review (fail-closed). Fix the policy file ` +
      '(rea doctor surfaces the error), or switch policy.review.provider to codex.';
    err(`invalid-policy: ${reason}`);
    // Report the INTENDED provider when known, else 'unknown' — never the
    // misleading codex default (providerKind falls back to codex but we are
    // refusing precisely because we can't confirm codex).
    const reportedProvider = intendedProvider ?? 'unknown';
    if (options.json === true) {
      process.stdout.write(
        JSON.stringify({
          status: 'error',
          provider: reportedProvider,
          error: reason,
          reason: 'invalid-policy',
          exit_code: 2,
        }) + '\n',
      );
    }
    // Audit the refusal so operators can correlate the fail-closed exit.
    await safeAudit(
      baseDir,
      LOCAL_REVIEW_TOOL_NAME,
      InvocationStatus.Error,
      { provider: reportedProvider, error: reason, kind: 'invalid-policy' },
      // Policy failed to load — pass undefined (no rotation hint available).
      undefined,
    );
    process.exit(2);
  }

  const seams = deps.__testProviderSeams;
  const providerCtx: ProviderWiringCtx = {
    baseDir,
    policy,
    // TEST-ONLY seams merged in (production leaves __testProviderSeams unset).
    ...(seams?.transport !== undefined ? { testTransport: seams.transport } : {}),
    ...(seams?.enumerate !== undefined ? { testEnumerate: seams.enumerate } : {}),
    ...(seams?.env !== undefined ? { testEnv: seams.env } : {}),
    ...(seams?.codexAvailable !== undefined ? { testCodexAvailable: seams.codexAvailable } : {}),
    ...(seams?.codexFallback !== undefined ? { testCodexFallback: seams.codexFallback } : {}),
    ...(seams?.codexProbeVersion !== undefined
      ? { testCodexProbeVersion: seams.codexProbeVersion }
      : {}),
  };
  const authoritativeProvider: ReviewProvider =
    deps.providerOverride ?? selectProvider(providerKind, deps, providerCtx);

  // Probe availability before any heavy lifting so we can branch.
  const probe = await authoritativeProvider.isAvailable(baseDir);

  // Provider unavailable — branch on policy mode.
  if (!probe.available) {
    if (mode === 'off') {
      // Off mode: skip silently and audit so the absence is forensically
      // visible. Exit 0 — the team has explicitly opted out.
      const skippedReason =
        authoritativeProvider.id === 'codex'
          ? 'codex-not-installed'
          : `${authoritativeProvider.id}-unavailable`;
      await writeSkippedUnavailableAndExit({
        baseDir,
        provider: authoritativeProvider.id,
        reason: skippedReason,
        json: options.json === true,
        policy,
      });
      // (writeSkippedUnavailableAndExit calls process.exit(0).)
    }
    // Enforced mode: hard-refuse with the provider's remediation message.
    // The FIRST line goes through `err()` (the `[rea] ERROR:` prefix);
    // remaining lines through `console.error` — preserving the exact codex
    // rendering byte-for-byte (golden test pins it).
    const lines = authoritativeProvider.unavailableMessage();
    if (lines.length > 0) err(lines[0] as string);
    for (let i = 1; i < lines.length; i += 1) console.error(lines[i]);
    // 0.50.x P2 (codex): under --json, emit the SAME structured `{"status":
    // "error"}` shape the execute-error path below produces, so automation can
    // parse EVERY non-execution outcome from stdout (not just the
    // execute-failure ones). The human stderr rendering above is unchanged.
    if (options.json === true) {
      process.stdout.write(
        JSON.stringify({
          status: 'error',
          provider: authoritativeProvider.id,
          error: (lines[0] as string | undefined) ?? `${authoritativeProvider.id} unavailable`,
          reason: 'provider-unavailable',
          exit_code: 2,
        }) + '\n',
      );
    }
    process.exit(2);
  }

  // codex round-8 B2 [P2]: in `provider: both` the codex review is
  // AUTHORITATIVE but typically takes far longer than the gpt-oss shadow (e.g.
  // codex 441s vs a ~30-60s shadow). Awaiting `runShadowParity` AFTER codex
  // would add up to the shadow budget to wall-clock even on a successful codex
  // run. So kick the shadow's gpt-oss EXECUTION off CONCURRENTLY with the codex
  // execute below — the overlap adds ≈0 — and assemble the parity report after
  // codex settles (it needs `codexOutcome`). The kickoff is NEVER-throwing
  // (`startShadowExecution` is total) and the round-6 single-attempt budget is
  // preserved as a backstop, so it can never affect the codex exit, the
  // canonical record, or preflight coverage. Built here (after the codex
  // availability probe passed) so we don't start a shadow for a run that is
  // about to refuse on codex-unavailable.
  let shadowCapture: ShadowCapture | undefined;
  let shadowProvider: ReviewProvider | undefined;
  let shadowExec: Promise<ShadowExecResult> | undefined;
  if (providerKind === 'both' && authoritativeProvider.id === 'codex') {
    // The shadow provider must NOT fall back to codex internally (codex already
    // ran authoritatively) — `shadow: true` omits the codex sink/fallback so a
    // refusal/malformed surfaces as a shadow outcome, never a re-run.
    shadowCapture = {};
    shadowProvider = selectProvider('openrouter', deps, providerCtx, {
      shadow: true,
      shadowCapture,
    });
    shadowExec = startShadowExecution({
      baseDir,
      options,
      policy,
      shadowProvider,
    });
    // Defensively attach a no-op catch so an unawaited rejection can never log
    // an unhandled-rejection warning before `runShadowParity` awaits it.
    // (startShadowExecution is total, but this is belt-and-suspenders.)
    shadowExec.catch(() => undefined);
  }

  // Provider available — run the review.
  let outcome: ReviewOutcome;
  try {
    outcome = await authoritativeProvider.execute(baseDir, options);
  } catch (e) {
    // FIX H (round-4): the openrouter external lane refused AND codex is not
    // installed. Defer to `local_review.mode` — mirroring the provider-
    // unavailable branch above: `off` → skipped_unavailable + exit 0 (the
    // documented opt-out); `enforced` → fall through to exit 2. This is NOT an
    // error outcome under `mode: off` — it is an intentional opt-out.
    if (e instanceof OpenRouterExternalRefusedError) {
      // codex round-2 P2: `mode: off` only suppresses a DELIBERATE local
      // non-send (path-guard refused, invalid policy, oversized diff, redact
      // timeout) — the documented "nothing was reviewed by design" opt-out. An
      // OPERATIONAL failure (the external lane was contacted and timed out /
      // returned malformed JSON / violated the backend pin) is a REAL provider
      // failure and must surface as an error (exit 2), exactly like a codex
      // execution failure does regardless of mode — never a benign skip.
      if (mode === 'off' && !e.isOperationalFailure) {
        await writeSkippedUnavailableAndExit({
          baseDir,
          provider: 'openrouter',
          reason: 'openrouter-refused-and-codex-unavailable',
          json: options.json === true,
          policy,
          refusalClass: e.refusalClass,
          ...(e.headSha !== undefined ? { headSha: e.headSha } : {}),
        });
        // (never returns)
      }
      // Enforced mode (any class), OR mode: off + operational failure → fall
      // through to the generic error handling below, which audits + exits 2.
    }
    // Round-15 P2: an OpenRouter AUTH failure is NOT a codex-availability
    // problem — surface the REAL cause (the credential), never "codex is not
    // installed". mode: off → skip with reason `openrouter-unauthorized`;
    // enforced → fall through to the generic handler, which prints e.message
    // (the clear "OPENROUTER_API_KEY may be expired/revoked" text) + exits 2.
    if (e instanceof OpenRouterUnauthorizedError) {
      if (mode === 'off') {
        await writeSkippedUnavailableAndExit({
          baseDir,
          provider: 'openrouter',
          reason: 'openrouter-unauthorized',
          json: options.json === true,
          policy,
          refusalClass: 'unauthorized',
          ...(e.headSha !== undefined ? { headSha: e.headSha } : {}),
        });
        // (never returns)
      }
      // Enforced mode → fall through to the generic error handler below.
    }
    const msg = e instanceof Error ? e.message : String(e);
    // Round-18 P2: when `provider: openrouter` degraded to the CODEX fallback
    // and codex itself errored, the FAILING provider is CODEX — attribute the
    // message / audit provider / kind to codex (its classifyError yields a real
    // kind; `OpenRouterProvider.classifyError` collapses codex exceptions to
    // 'unknown' and points operators at the wrong remediation). Detect it
    // structurally: `CodexProvider.classifyError` returns a SPECIFIC kind for a
    // codex exception, 'unknown' otherwise — so a codex error routes to codex,
    // an openrouter error stays openrouter. (codex-path provider is unchanged →
    // golden byte-identity holds.)
    const failingProvider =
      CodexProvider.classifyError(e) !== 'unknown' ? CodexProvider : authoritativeProvider;
    err(`${failingProvider.id} review failed: ${msg}`);
    // 0.50.x: emit a structured `{"status":"error"}` line under --json so the
    // cross-repo smoke harness (and CI consumers) can branch deterministically
    // on the non-execution outcome. The error path writes NO last-review.json
    // (there are no findings to serialize) — the smoke harness asserts exactly
    // that. Codex's error path gains the same structured surface; no test
    // pinned its prior empty-stdout behavior.
    if (options.json === true) {
      process.stdout.write(
        JSON.stringify({
          status: 'error',
          provider: failingProvider.id,
          error: msg,
          exit_code: 2,
        }) + '\n',
      );
    }
    // Audit the error so operators can correlate failures.
    await safeAudit(
      baseDir,
      LOCAL_REVIEW_TOOL_NAME,
      InvocationStatus.Error,
      {
        provider: failingProvider.id,
        error: msg,
        kind: failingProvider.classifyError(e),
      },
      policy,
    );
    process.exit(2);
  }

  // Write the canonical audit record. THIS is the entry `rea preflight`
  // looks for. Use server_name='rea' (the pre-existing convention) and
  // tool_name='rea.local_review'.
  //
  // 0.26.0 helix-026 finding-1: `content_token` is the field preflight
  // matches coverage on. `head_sha` is recorded for forensics. The token
  // stays optional so legacy `codex.review` entries and future providers
  // that can't compute a tree fingerprint still flow through preflight's
  // back-compat head-sha fallback.
  //
  // 0.50.x: key INSERTION ORDER is load-bearing for the codex byte-identity
  // golden test. The codex path inserts exactly:
  //   head_sha, base_ref, verdict, finding_count, provider, model,
  //   reasoning_effort, duration_seconds, [content_token], [provider_version]
  // and NOTHING after. The openrouter path appends `served_by` then
  // `data_policy` AFTER `provider_version` (data-architect contract) — keys
  // that codex outcomes never set, so codex lines do not gain them.
  // FIX A (round-2): name the provider that ACTUALLY ran. On the pure codex
  // path `outcome.actualProviderId` is undefined → `authoritativeProvider.id`
  // (= 'codex'), and `outcome.actualProviderVersion` is undefined → the
  // codex availability-probe version — so the codex audit line stays
  // byte-identical (golden test). When `provider: openrouter` fell back to
  // codex, the outcome carries `actualProviderId: 'codex'` + codex's version
  // + NO served_by/data_policy, so the record names codex, not openrouter.
  const actualProvider = outcome.actualProviderId ?? authoritativeProvider.id;
  // Round-16 P3: `provider_version` is a provider BINARY/SDK version. Only the
  // codex availability probe yields one; the openrouter probe's `version` is
  // just the model id (already recorded in `model`) — stamping it here makes
  // provider_version === model and unreliable. So fall back to `probe.version`
  // ONLY for codex; openrouter omits it (served_by/model carry the forensics).
  const actualProviderVersion =
    outcome.actualProviderVersion ?? (actualProvider === 'codex' ? probe.version : undefined);
  const metadata: LocalReviewMetadata = {
    head_sha: outcome.headSha,
    base_ref: outcome.baseRef,
    verdict: outcome.verdict,
    finding_count: outcome.findingCount,
    provider: actualProvider,
    model: outcome.model,
    reasoning_effort: outcome.reasoningEffort,
    duration_seconds: outcome.durationSeconds,
  };
  if (outcome.contentToken.length > 0) metadata.content_token = outcome.contentToken;
  // `provider_version`: codex sources it from the availability probe (so the
  // codex line is byte-identical). OpenRouter success carries no probe
  // version; an openrouter→codex fallback carries codex's version via the
  // outcome's `actualProviderVersion`.
  if (actualProviderVersion !== undefined) metadata.provider_version = actualProviderVersion;
  // OpenRouter-only siblings, AFTER provider_version. Present ONLY when
  // openrouter ACTUALLY served (codex-fallback outcomes clear them).
  // M1 (round-8): the honest data-policy posture is DERIVED in
  // executeOpenRouterReview (where served_by + pin are in scope) — review.ts
  // does NOT recompute, it just copies the outcome's fields. Both omitted on
  // codex-only + fallback records (codex byte-identity preserved).
  if (outcome.servedBy !== undefined) metadata.served_by = outcome.servedBy;
  if (outcome.dataPolicyRequested !== undefined) {
    metadata.data_policy_requested = outcome.dataPolicyRequested;
  }
  if (outcome.dataPolicyEnforced !== undefined) {
    metadata.data_policy_enforced = outcome.dataPolicyEnforced;
  }

  await safeAudit(
    baseDir,
    LOCAL_REVIEW_TOOL_NAME,
    outcome.verdict === 'blocking' ? InvocationStatus.Denied : InvocationStatus.Allowed,
    metadata as unknown as Record<string, unknown>,
    policy,
  );

  // 0.50.x — `provider: both` shadow lane. The canonical (codex) record is
  // already written above and is authoritative; now assemble the parity report
  // from the shadow execution that was kicked off CONCURRENTLY with the codex
  // execute (codex round-8 B2). Its failure/error/verdict MUST NOT affect the
  // exit code or the canonical record. Guard: only when codex is the
  // authoritative provider AND policy asks for `both` (same condition that
  // started `shadowExec` above, so all three are defined here).
  //
  // FIX K + L (round-6): the shared `ShadowCapture` carries the shadow lane's
  // refusal (NOT written as a `refused_external` audit record — that would imply
  // a codex fallback that never ran) and its REAL est-cost into the parity
  // report. The SAME object is shared between the provider's sinks and
  // `runShadowParity`.
  if (
    providerKind === 'both' &&
    authoritativeProvider.id === 'codex' &&
    shadowProvider !== undefined &&
    shadowExec !== undefined &&
    shadowCapture !== undefined
  ) {
    await runShadowParity({
      baseDir,
      options,
      policy,
      codexOutcome: outcome,
      shadowProvider,
      // The shadow's gpt-oss execution already ran concurrently with codex —
      // await its (nearly-finished) result here, adding ≈0 wall-clock.
      shadowExec,
      shadowCapture,
      safeAudit,
    });
  }

  // 0.28.1 defect-V: persist `.rea/last-review.json` on EVERY successful
  // codex run (pass / concerns / blocking) BEFORE the exit so agents can
  // read structured findings to remediate. Pre-fix only the push-gate
  // wrote this file; `rea review` discarded the bodies after counting,
  // so consumers saw stale snapshots from days-old push-gate runs (Ava
  // reported a 2026-05-08 file surviving across new 2026-05-09 runs).
  //
  // Reuses the push-gate's writer — the canonical atomic-write path with
  // redaction. We do NOT inline a second implementation: any divergence
  // between the two writers would silently desynchronize the schema for
  // `rea preflight` and any tooling that reads last-review.json.
  //
  // Skipped/error paths (codex unavailable, codex error) do NOT call this
  // — there are no findings to serialize.
  let lastReviewWritten: LastReviewPayload | undefined;
  try {
    // `LocalReviewVerdict` permits `'error'` for the audit-record schema
    // (transport / subprocess failures) but the codex success path can
    // only produce pass | concerns | blocking — we caught throw above.
    // Narrow here so the report writer's stricter `Verdict` type accepts
    // it without losing the audit shape elsewhere in this file.
    const verdict = outcome.verdict as PushGateVerdict;
    lastReviewWritten = writeLastReview({
      baseDir,
      summary: {
        verdict,
        findings: outcome.findings,
        reviewText: outcome.reviewText,
      },
      baseRef: outcome.baseRef,
      headSha: outcome.headSha,
      eventCount: outcome.eventCount,
      durationSeconds: outcome.durationSeconds,
    });
  } catch (e) {
    // last-review.json is a remediation surface, not a gate. A write
    // failure (read-only fs, ENOSPC, race with another run) must not
    // change the verdict-driven exit code. Surface the error to stderr
    // so operators can correlate, then continue.
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`rea: last-review.json write failed: ${msg}\n`);
  }

  // Decide exit code based on strictFailOn.
  let exitCode: 0 | 1 | 2;
  if (outcome.verdict === 'blocking') {
    exitCode = 2;
  } else if (outcome.verdict === 'concerns') {
    exitCode = strictFailOn === 'concerns' ? 1 : 0;
  } else {
    exitCode = 0;
  }

  // 0.28.1 defect-V: redacted findings come from the writer when it
  // succeeded (so `--with-findings` shows the same bodies that landed on
  // disk). When the write FAILED we re-redact the in-memory findings
  // inline (round-1 P2-1) — without this fallback, secrets that codex
  // copied from the diff into a finding body would escape via stdout/
  // JSON in the exact failure mode where the on-disk surface is gone.
  const findingsForOutput: Finding[] =
    lastReviewWritten !== undefined
      ? lastReviewWritten.findings
      : redactFindingsInMemory(outcome.findings);

  if (options.json === true) {
    const payload: Record<string, unknown> = {
      status: outcome.verdict,
      finding_count: outcome.findingCount,
      head_sha: outcome.headSha,
      base_ref: outcome.baseRef,
      // FIX A (round-2): the provider that ACTUALLY ran (codex when the
      // openrouter lane fell back), NOT the configured provider.
      provider: actualProvider,
      model: outcome.model,
      reasoning_effort: outcome.reasoningEffort,
      duration_seconds: outcome.durationSeconds,
      exit_code: exitCode,
      // 0.28.1 defect-V round-1 P2-2: only advertise `last_review_path`
      // when the writer actually produced a current snapshot. If the
      // write threw, the file on disk is either missing or a stale
      // snapshot from an older run — pointing JSON consumers at it
      // would let agents remediate against the wrong findings while
      // the current run still exits successfully. Emit `null` and an
      // explicit `last_review_error` so consumers can branch
      // deterministically.
      last_review_path: lastReviewWritten !== undefined ? LAST_REVIEW_RELATIVE : null,
    };
    if (lastReviewWritten === undefined) {
      payload.last_review_error = 'write_failed';
    }
    if (options.withFindings === true) {
      // Mirror last-review.json's Finding shape so JSON consumers see one
      // schema. Findings are pre-redacted (writer-redacted on success,
      // re-redacted inline on writer failure — see findingsForOutput).
      payload.findings = findingsForOutput;
    }
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else {
    log(
      `local review: ${outcome.verdict} (${outcome.findingCount} finding(s)) — head=${outcome.headSha.slice(0, 12)} base=${outcome.baseRef}`,
    );
    log(`audit entry written: tool_name=${LOCAL_REVIEW_TOOL_NAME}`);
    if (options.withFindings === true) {
      printFindingsBySeverity(findingsForOutput, lastReviewWritten !== undefined);
    }
  }
  process.exit(exitCode);
}

/**
 * 0.28.1 defect-V — group findings by severity (P1 → P2 → P3) and print
 * to stdout via `log()`. Each finding renders as
 *
 *   - [P1] <title> — <file>:<line>
 *
 * mirroring the codex-banner shape produced by the push-gate, so muscle
 * memory transfers between the two surfaces. The full body is intentionally
 * NOT printed here — the body can be very long, and the canonical place to
 * read full bodies is `.rea/last-review.json`. We print enough to identify
 * each finding and drive the agent to the file.
 *
 * Round-2 P2 fix: only point at last-review.json when the writer
 * actually produced a current snapshot. Mirrors the JSON-path guard on
 * `last_review_path`. If the write failed, the on-disk file is missing
 * or stale; pointing a human there would let them remediate against the
 * wrong findings. Falls back to a self-contained banner that names the
 * failure mode.
 */
function printFindingsBySeverity(findings: readonly Finding[], lastReviewWritten: boolean): void {
  if (findings.length === 0) return;
  const order: Array<'P1' | 'P2' | 'P3'> = ['P1', 'P2', 'P3'];
  log('');
  if (lastReviewWritten) {
    log(`findings (see ${LAST_REVIEW_RELATIVE} for full bodies):`);
  } else {
    log('findings (last-review.json write FAILED — bodies shown inline below; stale file may exist on disk and should be ignored):');
  }
  for (const sev of order) {
    const group = findings.filter((f) => f.severity === sev);
    if (group.length === 0) continue;
    for (const f of group) {
      const loc =
        f.file !== undefined ? ` — ${f.file}${f.line !== undefined ? `:${f.line}` : ''}` : '';
      log(`  - [${sev}] ${f.title}${loc}`);
      // Round-3 P2 fix: when the writer failed, the on-disk surface is
      // gone — agents and humans have no other place to read the body.
      // Render the body inline (already redacted upstream) so the
      // banner's "bodies shown inline below" promise is truthful and
      // remediation can still happen. On the success path, bodies stay
      // in last-review.json so the stdout surface stays scannable.
      if (!lastReviewWritten && f.body.length > 0) {
        for (const bodyLine of f.body.split(/\r?\n/)) {
          if (bodyLine.length === 0) continue;
          log(`      ${bodyLine}`);
        }
      }
    }
  }
}

/** Context needed to wire the openrouter provider's production sinks. */
interface ProviderWiringCtx {
  baseDir: string;
  policy: Policy | undefined;
  /**
   * TEST-ONLY injection seams (production never sets these). They let a test
   * drive the REAL `selectProvider` wiring (incl. the shadow-mode
   * `onRefusedExternal` capture + the round-8 accuracy matrix) against a mock
   * transport + a deterministic changed-path set + deterministic codex
   * availability, with no network.
   */
  testTransport?: OpenRouterTransport;
  testEnumerate?: ChangedPathsEnumerator;
  testEnv?: NodeJS.ProcessEnv;
  testCodexAvailable?: () => boolean;
  testCodexFallback?: ExecuteOpenRouterReview;
  testCodexProbeVersion?: () => string | undefined;
}

/**
 * FIX K + L (round-6): capture sink for the SHADOW (`provider: both`) lane.
 *
 * In shadow mode the openrouter provider must NOT write a
 * `rea.local_review.refused_external` audit record — there is NO codex
 * fallback (codex already ran authoritatively), so an entry claiming
 * `fallback_provider: codex` would be a materially inaccurate audit trail
 * (FIX K). Instead, a shadow refusal and the shadow lane's REAL est-cost are
 * captured HERE and surfaced in the parity report (`review-parity.json`),
 * never as an audit entry. A mutable object the shadow `onRefusedExternal` /
 * `onTelemetry` write into and `runShadowParity` reads.
 */
export interface ShadowCapture {
  /** Set when the shadow openrouter lane refused (no parity data this run). */
  refusal?: { refusalClass: string; matchedRule?: string };
  /** The shadow openrouter call's REAL estimated cost in USD (FIX L). */
  estCostUsd?: number;
}

/**
 * 0.50.x — provider dispatch. A plain switch on the resolved provider kind
 * (NOT a registry, NOT `REA_REVIEWER`, NOT `registry.reviewer`). When a
 * test injects an `executeCodexReview` / `executeOpenRouterReview` seam, the
 * returned provider's `execute` delegates to it instead of doing real work —
 * preserving the 0.28.1 deps-seam contract while routing through the new
 * `ReviewProvider` abstraction.
 *
 * For the `'openrouter'` lane this also wires the PRODUCTION sinks: the codex
 * fallback (so the degradation ladder + path-guard refusal re-route to codex),
 * the `rea.local_review.refused_external` audit writer (written BEFORE the
 * fallback), and the telemetry row writer. `shadowMode` omits the codex
 * fallback (the shadow lane must never re-run codex — it already ran
 * authoritatively).
 */
/**
 * Exported for tests: the exact production provider-selection + sink wiring,
 * so a test can drive the SHADOW-mode openrouter provider (its
 * `onRefusedExternal` capture, no-audit behavior) against a mock transport.
 * Production callers reach this only via `runReview`.
 */
export function selectProvider(
  kind: 'codex' | 'openrouter' | 'both',
  deps: RunReviewDeps,
  ctx: ProviderWiringCtx,
  flags: { shadow?: boolean; shadowCapture?: ShadowCapture } = {},
): ReviewProvider {
  if (kind === 'openrouter') {
    const isShadow = flags.shadow === true;
    const capture = flags.shadowCapture;
    // The codex fallback for the degradation ladder. Omitted in shadow mode.
    // TEST-ONLY: a `testCodexFallback` overrides the real codex provider so the
    // accuracy tests can run a fake codex with no subprocess.
    const codexFallback = isShadow
      ? undefined
      : (ctx.testCodexFallback ?? selectProvider('codex', deps, ctx).execute);
    // Codex availability + version probes — TEST-ONLY overrides take precedence
    // over the real subprocess probes so the accuracy matrix is deterministic.
    const codexAvailableFn = ctx.testCodexAvailable ?? (() => isCodexAvailable(ctx.baseDir));
    const codexProbeVersionFn =
      ctx.testCodexProbeVersion ?? (() => probeCodexVersion(ctx.baseDir));
    return OpenRouterProvider({
      ...(deps.executeOpenRouterReview !== undefined
        ? { execute: deps.executeOpenRouterReview }
        : {}),
      // TEST-ONLY seams (production never sets these on ctx).
      ...(ctx.testTransport !== undefined ? { transport: ctx.testTransport } : {}),
      ...(ctx.testEnumerate !== undefined ? { enumerate: ctx.testEnumerate } : {}),
      ...(ctx.testEnv !== undefined ? { env: ctx.testEnv } : {}),
      ...(codexFallback !== undefined ? { codexFallback } : {}),
      // FIX H (round-4): probe codex availability so a refusal with codex
      // ABSENT throws the mode-deferred `OpenRouterExternalRefusedError`
      // (runReview honors `local_review.mode: off`) instead of running codex.
      // Omitted in shadow mode (the shadow lane never falls back to codex).
      ...(isShadow ? {} : { codexAvailable: codexAvailableFn }),
      // FIX A (round-2): probe codex's version so a codex-fallback outcome
      // carries codex's real provider_version into the audit record. Omitted
      // in shadow mode (the shadow lane never falls back to codex).
      ...(isShadow ? {} : { codexProbeVersion: codexProbeVersionFn }),
      // FIX K (round-6): in SHADOW mode do NOT write a
      // `rea.local_review.refused_external` audit record — there is no codex
      // fallback, so an entry claiming `fallback_provider: codex` would be
      // materially inaccurate. Instead CAPTURE the refusal into the shadow
      // sink; `runShadowParity` surfaces it in the parity report. In the
      // NON-shadow (authoritative) lane the audit record is correct + kept.
      onRefusedExternal: isShadow
        ? async (info) => {
            if (capture !== undefined) {
              capture.refusal = {
                refusalClass: info.refusalClass,
                ...(info.matchedRule !== undefined ? { matchedRule: info.matchedRule } : {}),
              };
            }
          }
        : async (info) => {
            const meta: LocalReviewRefusedExternalMetadata = {
              attempted_provider: 'openrouter',
              fallback_provider: info.fallbackProvider,
              refusal_class: info.refusalClass,
              ...(info.matchedRule !== undefined ? { matched_rule: info.matchedRule } : {}),
              changed_path_count: info.changedPathCount,
              ...(info.headSha !== undefined ? { head_sha: info.headSha } : {}),
              ...(info.baseRef !== undefined ? { base_ref: info.baseRef } : {}),
            };
            await safeAudit(
              ctx.baseDir,
              LOCAL_REVIEW_REFUSED_EXTERNAL_TOOL_NAME,
              InvocationStatus.Allowed,
              meta as unknown as Record<string, unknown>,
              ctx.policy,
            );
          },
      // Per-call token/cost telemetry row. Reuses the canonical writer. In
      // shadow mode it ALSO captures the REAL est-cost for the parity report
      // (FIX L) — the shadow run's spend is the whole point of the report.
      onTelemetry: async (row) => {
        if (isShadow && capture !== undefined && row.estCostUsd !== undefined) {
          capture.estCostUsd = row.estCostUsd;
        }
        // FIX C (round-2): record the REAL exit status — non-zero for a
        // failed/fell-back external attempt, 0 only for a clean openrouter
        // success. A `fellBack`/`rate-limited` marker goes into `stderr` so the
        // telemetry reader's rate-limit detector + doctor see the failure.
        const stderrMarker = row.fellBack
          ? row.rateLimited
            ? 'rate-limited; fell back to codex'
            : 'fell back to codex'
          : row.rateLimited
            ? 'rate-limited'
            : undefined;
        await recordTelemetry(ctx.baseDir, {
          invocation_type: 'review',
          input_text: '',
          output_text: '',
          duration_ms: row.durationMs,
          exit_code: row.exitCode,
          provider: 'openrouter',
          model: row.model,
          ...(row.servedBy !== undefined ? { served_by: row.servedBy } : {}),
          ...(stderrMarker !== undefined ? { stderr: stderrMarker } : {}),
          usage: {
            ...(row.inputTokens !== undefined ? { input_tokens: row.inputTokens } : {}),
            ...(row.outputTokens !== undefined ? { output_tokens: row.outputTokens } : {}),
            ...(row.estCostUsd !== undefined ? { est_cost_usd: row.estCostUsd } : {}),
          },
        });
      },
    });
  }
  // codex (and the residual 'both' authoritative lane). When a test injects
  // `executeCodexReview`, wrap CodexProvider so its `execute` uses the seam.
  // ALSO honor `ctx.testCodexAvailable` for `isAvailable` when set, so a unit
  // test that mocks codex EXECUTION does not silently depend on codex being
  // INSTALLED: the default `CodexProvider.isAvailable` spawns the real `codex`
  // binary, which is absent in CI — making those tests pass locally (codex
  // present) but fail on CI runners (exit 2, codex-unavailable-in-enforced).
  const withCodexAvailability = (p: ReviewProvider): ReviewProvider =>
    ctx.testCodexAvailable === undefined
      ? p
      : {
          ...p,
          isAvailable: () =>
            Promise.resolve(
              ctx.testCodexAvailable!() ? { available: true } : { available: false },
            ),
        };
  if (deps.executeCodexReview !== undefined) {
    const seam = deps.executeCodexReview;
    return withCodexAvailability({ ...CodexProvider, execute: (b, o) => seam(b, o) });
  }
  return withCodexAvailability(CodexProvider);
}

/**
 * Best-effort audit append — never throws. An audit failure must not
 * change the CLI exit code.
 */
async function safeAudit(
  baseDir: string,
  toolName: string,
  status: InvocationStatus,
  metadata: Record<string, unknown>,
  policy: Policy | undefined,
): Promise<void> {
  try {
    const cleanMeta: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(metadata)) {
      if (v !== undefined) cleanMeta[k] = v;
    }
    await appendAuditRecord(baseDir, {
      tool_name: toolName,
      server_name: LOCAL_REVIEW_SERVER_NAME,
      tier: Tier.Read,
      status,
      ...(Object.keys(cleanMeta).length > 0 ? { metadata: cleanMeta } : {}),
      ...(policy !== undefined ? { policy } : {}),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stderr.write(`rea: audit append failed (${toolName}): ${msg}\n`);
  }
}

/**
 * Attach `rea review` to a commander Program.
 */
export function registerReviewCommand(program: Command): void {
  program
    .command('review')
    .description(
      'Run a local codex adversarial review of the working tree, write a `rea.local_review` audit entry, and exit 0 (pass), 1 (concerns), or 2 (blocking). The push-gate is the BACKUP layer — this is the primary review surface.',
    )
    .option(
      '--base <ref>',
      'explicit base ref to diff against (default: @{upstream} → origin/HEAD → main/master)',
    )
    .option(
      '--strict-fail-on <level>',
      'verdict floor that triggers non-zero exit: `concerns` or `blocking` (default `blocking`)',
      (raw: string): 'concerns' | 'blocking' => {
        if (raw !== 'concerns' && raw !== 'blocking') {
          throw new Error(`--strict-fail-on must be "concerns" or "blocking", got ${JSON.stringify(raw)}`);
        }
        return raw;
      },
    )
    .option('--json', 'emit a single-line JSON result instead of human-readable output')
    .option(
      '--with-findings',
      'after the summary, print findings grouped by severity (P1/P2/P3); when combined with --json, the JSON payload gains a `findings` array',
    )
    .option(
      '--provider <name>',
      'review provider for this invocation: `codex`, `openrouter`, or `both` (overrides policy.review.provider)',
      (raw: string): 'codex' | 'openrouter' | 'both' => {
        if (raw !== 'codex' && raw !== 'openrouter' && raw !== 'both') {
          throw new Error(
            `--provider must be "codex", "openrouter", or "both", got ${JSON.stringify(raw)}`,
          );
        }
        return raw;
      },
    )
    .action(
      async (opts: {
        base?: string;
        strictFailOn?: 'concerns' | 'blocking';
        json?: boolean;
        withFindings?: boolean;
        provider?: 'codex' | 'openrouter' | 'both';
      }) => {
        await runReview({
          ...(opts.base !== undefined ? { base: opts.base } : {}),
          ...(opts.strictFailOn !== undefined ? { strictFailOn: opts.strictFailOn } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.withFindings === true ? { withFindings: true } : {}),
          ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
        });
      },
    );
}

// Path constant for tests — not consumed elsewhere.
export const REA_AUDIT_RELATIVE = path.join('.rea', 'audit.jsonl');
