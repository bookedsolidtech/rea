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
import {
  summarizeReview,
  type Finding,
  type Verdict as PushGateVerdict,
} from '../hooks/push-gate/findings.js';
import { writeLastReview, type LastReviewPayload } from '../hooks/push-gate/report.js';
import { computeTreeToken, EMPTY_TREE_SHA } from '../audit/content-token.js';
import {
  compileDefaultSecretPatterns,
  redactSecrets,
  type CompiledSecretPattern,
} from '../gateway/middleware/redact.js';
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
  /**
   * 0.28.1 defect-V: when true, after the human-readable summary line
   * (or alongside the JSON payload), emit the finding bodies grouped by
   * severity. Default off — preserves backward-compatible single-line
   * stdout for existing CI consumers.
   */
  withFindings?: boolean;
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
 * 0.28.1 defect-V — narrow test seam. Production callers never set this;
 * tests inject a fake to drive `runReview` deterministically without
 * spawning codex. The seam matches `executeCodexReview`'s signature so
 * the production path and the test path go through the same downstream
 * wiring (audit append, last-review.json, exit code, output).
 */
export interface RunReviewDeps {
  executeCodexReview?: (
    baseDir: string,
    options: RunReviewOptions,
  ) => Promise<ReviewOutcome>;
}

/**
 * Public runner — exposed so tests can drive the function in-process and
 * the commander binding can stay thin. Throws via `process.exit` (CLI
 * convention across `src/cli/`).
 */
export async function runReview(
  options: RunReviewOptions,
  deps: RunReviewDeps = {},
): Promise<void> {
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
    const exec = deps.executeCodexReview ?? executeCodexReview;
    outcome = await exec(baseDir, options);
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
      provider: PROVIDER_CODEX,
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
    // 0.28.1 defect-V: thread the structured findings + reviewText + event
    // count through to the caller so `runReview` can persist last-review.json
    // and (optionally) print bodies. Pre-fix these were dropped on the floor
    // after `summary.findings.length` was computed.
    findings: summary.findings,
    reviewText: codexResult.reviewText,
    eventCount: codexResult.eventCount,
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
    .option(
      '--with-findings',
      'after the summary, print findings grouped by severity (P1/P2/P3); when combined with --json, the JSON payload gains a `findings` array',
    )
    .action(
      async (opts: {
        base?: string;
        strictFailOn?: 'concerns' | 'blocking';
        json?: boolean;
        withFindings?: boolean;
      }) => {
        await runReview({
          ...(opts.base !== undefined ? { base: opts.base } : {}),
          ...(opts.strictFailOn !== undefined ? { strictFailOn: opts.strictFailOn } : {}),
          ...(opts.json === true ? { json: true } : {}),
          ...(opts.withFindings === true ? { withFindings: true } : {}),
        });
      },
    );
}

// Path constant for tests — not consumed elsewhere.
export const REA_AUDIT_RELATIVE = path.join('.rea', 'audit.jsonl');
