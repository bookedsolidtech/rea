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

import path from 'node:path';
import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { appendAuditRecord } from '../audit/append.js';
import {
  LOCAL_REVIEW_TOOL_NAME,
  LOCAL_REVIEW_SKIPPED_UNAVAILABLE_TOOL_NAME,
  LOCAL_REVIEW_SERVER_NAME,
  type LocalReviewMetadata,
  type LocalReviewSkippedUnavailableMetadata,
  type LocalReviewVerdict,
} from '../audit/local-review-event.js';
import { Tier, InvocationStatus, type Policy } from '../policy/types.js';
import { loadPolicyAsync } from '../policy/loader.js';
import {
  CodexNotInstalledError,
  CodexProtocolError,
  CodexSubprocessError,
  CodexTimeoutError,
  IRON_GATE_DEFAULT_MODEL,
  IRON_GATE_DEFAULT_REASONING,
  createRealGitExecutor,
  runCodexReview,
} from '../hooks/push-gate/codex-runner.js';
import { resolvePushGatePolicy } from '../hooks/push-gate/policy.js';
import { resolveBaseRef } from '../hooks/push-gate/base.js';
import { summarizeReview } from '../hooks/push-gate/findings.js';
import { computeTreeToken, EMPTY_TREE_SHA } from '../audit/content-token.js';
import { err, log } from './utils.js';

const PROVIDER_CODEX = 'codex';

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
}

interface ReviewOutcome {
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
}

/**
 * Probe `codex --version` synchronously. Same shape as the push-gate's
 * pre-flight probe — ENOENT/EACCES means "not installed".
 */
function probeCodexAvailable(cwd: string): { available: boolean; version?: string } {
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
 * Resolve the effective `local_review.mode`. A missing policy is treated
 * as `enforced` — the protective default. A missing `local_review` block
 * also enforces. Only an explicit `mode: off` opts out.
 */
async function resolveLocalReviewMode(
  baseDir: string,
): Promise<{ mode: 'enforced' | 'off'; policy: Policy | undefined }> {
  let policy: Policy | undefined;
  try {
    policy = await loadPolicyAsync(baseDir);
  } catch {
    // Missing/invalid policy — protective default.
    return { mode: 'enforced', policy: undefined };
  }
  const mode = policy.review?.local_review?.mode ?? 'enforced';
  return { mode, policy };
}

/**
 * Public runner — exposed so tests can drive the function in-process and
 * the commander binding can stay thin. Throws via `process.exit` (CLI
 * convention across `src/cli/`).
 */
export async function runReview(options: RunReviewOptions): Promise<void> {
  const baseDir = process.cwd();
  const strictFailOn = options.strictFailOn ?? 'blocking';
  const { mode, policy } = await resolveLocalReviewMode(baseDir);

  // Probe codex before any heavy lifting so we can branch on availability.
  const probe = probeCodexAvailable(baseDir);

  // Codex unavailable — branch on policy mode.
  if (!probe.available) {
    if (mode === 'off') {
      // Off mode: skip silently and audit so the absence is forensically
      // visible. Exit 0 — the team has explicitly opted out.
      const skipped: LocalReviewSkippedUnavailableMetadata = {
        reason: 'codex-not-installed',
        provider: PROVIDER_CODEX,
      };
      // Best-effort HEAD probe for the audit record.
      try {
        const git = createRealGitExecutor(baseDir);
        const head = git.headSha();
        if (head.length > 0) skipped.head_sha = head;
      } catch {
        /* no head — leave undefined */
      }
      await safeAudit(
        baseDir,
        LOCAL_REVIEW_SKIPPED_UNAVAILABLE_TOOL_NAME,
        InvocationStatus.Allowed,
        skipped as unknown as Record<string, unknown>,
        policy,
      );
      if (options.json === true) {
        process.stdout.write(
          JSON.stringify({ status: 'skipped', reason: 'codex-not-installed' }) + '\n',
        );
      } else {
        log('codex not found on PATH — review skipped (policy.review.local_review.mode: off).');
      }
      process.exit(0);
    }
    // Enforced mode: hard-refuse with a helpful message.
    err('codex CLI not found on PATH.');
    console.error('');
    console.error('  Install:  npm i -g @openai/codex');
    console.error('  Or set:   policy.review.local_review.mode: off');
    console.error('            (in .rea/policy.yaml — disables local-review enforcement');
    console.error('             for teams without codex/claude installed)');
    console.error('');
    process.exit(2);
  }

  // Codex available — run the review.
  let outcome: ReviewOutcome;
  try {
    outcome = await executeCodexReview(baseDir, options);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    err(`codex review failed: ${msg}`);
    // Audit the error so operators can correlate failures.
    await safeAudit(
      baseDir,
      LOCAL_REVIEW_TOOL_NAME,
      InvocationStatus.Error,
      {
        provider: PROVIDER_CODEX,
        error: msg,
        kind: classifyCodexError(e),
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
  const metadata: LocalReviewMetadata = {
    head_sha: outcome.headSha,
    base_ref: outcome.baseRef,
    verdict: outcome.verdict,
    finding_count: outcome.findingCount,
    provider: PROVIDER_CODEX,
    model: outcome.model,
    reasoning_effort: outcome.reasoningEffort,
    duration_seconds: outcome.durationSeconds,
  };
  if (outcome.contentToken.length > 0) metadata.content_token = outcome.contentToken;
  if (probe.version !== undefined) metadata.provider_version = probe.version;

  await safeAudit(
    baseDir,
    LOCAL_REVIEW_TOOL_NAME,
    outcome.verdict === 'blocking' ? InvocationStatus.Denied : InvocationStatus.Allowed,
    metadata as unknown as Record<string, unknown>,
    policy,
  );

  // Decide exit code based on strictFailOn.
  let exitCode: 0 | 1 | 2;
  if (outcome.verdict === 'blocking') {
    exitCode = 2;
  } else if (outcome.verdict === 'concerns') {
    exitCode = strictFailOn === 'concerns' ? 1 : 0;
  } else {
    exitCode = 0;
  }

  if (options.json === true) {
    process.stdout.write(
      JSON.stringify({
        status: outcome.verdict,
        finding_count: outcome.findingCount,
        head_sha: outcome.headSha,
        base_ref: outcome.baseRef,
        provider: PROVIDER_CODEX,
        model: outcome.model,
        reasoning_effort: outcome.reasoningEffort,
        duration_seconds: outcome.durationSeconds,
        exit_code: exitCode,
      }) + '\n',
    );
  } else {
    log(
      `local review: ${outcome.verdict} (${outcome.findingCount} finding(s)) — head=${outcome.headSha.slice(0, 12)} base=${outcome.baseRef}`,
    );
    log(`audit entry written: tool_name=${LOCAL_REVIEW_TOOL_NAME}`);
  }
  process.exit(exitCode);
}

/**
 * Execute the codex review subprocess and translate the output to a
 * verdict. Reuses the push-gate's resolved policy so `codex_model` /
 * `codex_reasoning_effort` / `timeout_ms` flow through identically.
 */
async function executeCodexReview(
  baseDir: string,
  options: RunReviewOptions,
): Promise<ReviewOutcome> {
  const resolved = await resolvePushGatePolicy(baseDir);
  const git = createRealGitExecutor(baseDir);
  const explicit = options.base !== undefined && options.base.length > 0 ? options.base : undefined;
  const base =
    explicit !== undefined
      ? resolveBaseRef(git, { explicit })
      : resolveBaseRef(git);
  // 0.26.0 round-25 P2-B fix: do NOT throw on empty HEAD. An unborn-HEAD
  // repo (`git init` + immediately `rea review`, before any commit) is a
  // legitimate scaffolding state — `create-helix-app` and similar tools
  // bootstrap consumer repos this way. Pre-fix, `runReview()` threw
  // "could not resolve HEAD sha — is this a valid git repo?" which under
  // `refuse_at: commit/both` caused a deadlock: the commit-tier hook
  // refused commits until rea review wrote an audit entry, but rea
  // review refused without HEAD.
  //
  // Resolution: when HEAD is unborn, use git's well-known empty-tree
  // SHA as the synthetic head_sha for the audit record. `computeTreeToken`
  // already returns empty cleanly in this state; the working-tree tokens
  // takes over via `git stash create` once the tree is dirty (round-25
  // P1-A path), or remains empty for a truly empty repo. Preflight's
  // content-token match (round-25 P1-A) handles either case.
  //
  // Round-27 F2 fix: EMPTY_TREE_SHA promoted to a shared constant in
  // `src/audit/content-token.ts` so `rea preflight` (reader) uses the
  // SAME value when its `git rev-parse HEAD` probe fails. Without that
  // symmetry the reader returned `''` and short-circuited the lookup,
  // deadlocking the documented `git init → rea review → git commit`
  // bootstrap flow under `refuse_at: both`.
  const resolvedHeadSha = git.headSha();
  const headSha = resolvedHeadSha.length > 0 ? resolvedHeadSha : EMPTY_TREE_SHA;
  // 0.26.0 helix-026 finding-1: capture working-tree token as the content
  // token for preflight coverage matching. Computed BEFORE codex runs so
  // we never race a concurrent commit (the token reflects the state codex
  // is about to review). An empty token is allowed — preflight falls back
  // to head_sha matching when the field is absent.
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
  };
}

function classifyCodexError(e: unknown): string {
  if (e instanceof CodexNotInstalledError) return 'not-installed';
  if (e instanceof CodexTimeoutError) return 'timeout';
  if (e instanceof CodexProtocolError) return 'protocol';
  if (e instanceof CodexSubprocessError) return 'subprocess';
  return 'unknown';
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
    .action(
      async (opts: { base?: string; strictFailOn?: 'concerns' | 'blocking'; json?: boolean }) => {
        await runReview({
          ...(opts.base !== undefined ? { base: opts.base } : {}),
          ...(opts.strictFailOn !== undefined ? { strictFailOn: opts.strictFailOn } : {}),
          ...(opts.json === true ? { json: true } : {}),
        });
      },
    );
}

// Path constant for tests — not consumed elsewhere.
export const REA_AUDIT_RELATIVE = path.join('.rea', 'audit.jsonl');
