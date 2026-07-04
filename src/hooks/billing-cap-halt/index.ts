/**
 * `rea hook billing-cap-halt` — PostToolUse Bash billing→HALT reflex.
 *
 * 0.51.0 — first control on the spend-governance axis (E1 seed slice).
 * Introduced in response to INCIDENT-2026-07-04 (denial-of-wallet on a
 * metered TTS lane): an agent ran uncommitted scripts against a paid API
 * with retry/racing loops, treated a "spending cap exceeded" error as
 * retryable, and blew past the budget cap. rea had NO concept of money
 * anywhere. See `THREAT_MODEL.md §5.25`.
 *
 * # What it does
 *
 * Fires on every Bash PostToolUse. Scans the just-run command AND its
 * output (stdout/stderr) for a BILLING-CLASS signature — a TERMINAL,
 * non-retryable spend error (e.g. "spending cap", "prepayment credits
 * are depleted"). On a match it writes `.rea/HALT` (the existing
 * kill-switch that every middleware + hook already respects), turning the
 * field-proven client-side reflex (`BILLING_RE ⇒ process.exit`, no retry)
 * into a governance-layer primitive: stop everything, no retry, zero
 * exceptions.
 *
 * Billing-class is DELIBERATELY DISTINCT from a mere rate-limit. A `429`
 * / "rate limit" / "usage limit" / "exceeded quota" is retryable
 * (`RATE_LIMIT_REGEX` in `src/gateway/observability/codex-telemetry.ts`
 * already detects those, observe-only). "spending cap exceeded" /
 * "prepayment credits depleted" / "payment required" is a wall — retrying
 * it just burns more money. ONLY the billing-class set writes HALT.
 *
 * # Response modes (`policy.spend_governance.billing_error_response`)
 *
 *   - `halt` (DEFAULT) — write `.rea/HALT` + emit banner + exit 2.
 *   - `warn`           — emit banner + exit 2, do NOT write HALT. The
 *                        non-zero exit still surfaces the finding to the
 *                        agent so it stops retrying; it just doesn't
 *                        freeze the whole session.
 *   - `off`            — silent no-op (exit 0) even on a match.
 *
 * `enabled: false` or an absent `spend_governance` block → silent no-op.
 *
 * # Fail posture (discussed explicitly per the incident lesson)
 *
 * A billing reflex that SILENTLY DISAPPEARS is the incident. So the two
 * failure surfaces are handled with opposite biases, on purpose:
 *
 *   - CLI-MISSING (shim tier): FAIL-CLOSED. The `billing-cap-halt.sh`
 *     shim sets `SHIM_FAIL_OPEN=0` and only reaches the "CLI missing"
 *     branch as relevant when the raw payload already carries a billing
 *     keyword — so a genuine billing signal with no CLI to enforce it
 *     surfaces loudly (banner + exit 2) instead of vanishing. A payload
 *     with no billing keyword and no CLI exits 0 (no spam on every Bash).
 *
 *   - MALFORMED / UNREADABLE payload (this body): FAIL-SAFE (exit 0, no
 *     HALT). We only ACT on a POSITIVE match in successfully-parsed
 *     content. Halting on unparseable input would be a self-inflicted
 *     denial-of-service — freezing the session on garbage input is itself
 *     an availability harm, and the parent incident was about SPEND, not
 *     input integrity. Conservatism against false-positive freezes (the
 *     explicit design constraint) governs here.
 *
 * HALT short-circuit is the first line, uniform with every other hook:
 * when `.rea/HALT` already exists we exit 2 with the shared banner and
 * never re-write it (idempotency falls out for free — a second billing
 * match under an existing freeze does not churn the file).
 */

import type { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { checkHalt, formatHaltBanner } from '../_lib/halt-check.js';
import {
  parsePostToolUsePayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';
import { writeHaltFile, sanitizeHaltReason } from '../../cli/freeze.js';

export type BillingErrorResponse = 'halt' | 'warn' | 'off';

export interface BillingCapHaltOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
}

export interface BillingCapHaltResult {
  exitCode: number;
  stderr: string;
  /** What the reflex did. */
  action: 'halt' | 'warn' | 'noop';
  /** The billing signature that matched (sanitized snippet), or null. */
  matched: string | null;
  /** Whether this invocation wrote `.rea/HALT`. */
  haltWritten: boolean;
}

/**
 * Billing-class signature set. TERMINAL / non-retryable spend errors —
 * kept DISTINCT from the retryable rate-limit set on purpose (see the
 * file header). Conservative by design: each alternative is a
 * money-specific phrase that a 429 / throttle / quota-window error does
 * NOT contain, so a routine rate-limit never triggers a freeze.
 *
 * Pattern list (case-insensitive), with provenance:
 *   - `spending cap`                         — field-proven (Gemini, the
 *                                              incident's own `BILLING_RE`)
 *   - `prepayment credits (are) depleted`    — field-proven (Gemini)
 *   - `billing (hard) (cap|limit) … exceeded/reached`
 *                                            — generic billing wall
 *   - `credit balance is too low`            — Anthropic billing
 *   - `insufficient (funds|credit|credits|balance)`
 *                                            — generic prepay exhaustion
 *   - `payment required` / a bare `402` next to `payment`
 *                                            — HTTP 402 Payment Required
 *   - `insufficient_quota`                   — OpenAI billing error code
 *                                              (note: the human-readable
 *                                              "exceeded your current
 *                                              quota" is intentionally
 *                                              NOT matched — it overlaps
 *                                              the retryable rate-limit
 *                                              phrasing; the machine code
 *                                              is the unambiguous signal)
 *
 * Deliberately NOT included (retryable — belong to RATE_LIMIT_REGEX):
 *   `429`, `rate limit`, `usage limit`, `exceeded quota`, `too many
 *   requests`, `resource exhausted`, `deadline exceeded`.
 */
export const BILLING_RE =
  /spending cap|prepayment credits (?:are )?depleted|billing (?:hard )?(?:cap|limit)[^.\n]{0,40}(?:exceeded|reached)|credit balance is too low|insufficient (?:funds|credits?|balance)|payment required|\b402 payment required\b|insufficient_quota/i;

interface RawSpendGovernance {
  enabled?: unknown;
  billing_error_response?: unknown;
}

/**
 * Read `spend_governance.{enabled,billing_error_response}` permissively
 * from `.rea/policy.yaml`. We deliberately do NOT use the strict
 * `loadPolicy()` here (same reasoning as architecture-review-gate): the
 * strict zod schema throws on any legacy / unknown key ANYWHERE in the
 * file, which would silently disable the billing reflex for a consumer
 * whose policy has one stray field. The canonical `yaml.parse` accepts
 * the whole document; we pull just the two fields we need and validate
 * them locally.
 *
 * Returns `{ enabled: false }` (disabled) when:
 *   - the policy file is missing or unparseable,
 *   - `spend_governance` is absent or not an object,
 *   - `enabled` is anything other than the literal `true`.
 *
 * `billing_error_response` is validated against the enum; any other
 * value (including a typo the strict loader would reject) is treated as
 * `'halt'` — the fail-SAFE default for a spend control.
 */
function readSpendGovernance(reaRoot: string): {
  enabled: boolean;
  mode: BillingErrorResponse;
} {
  const disabled = { enabled: false, mode: 'halt' as BillingErrorResponse };
  const policyPath = path.join(reaRoot, '.rea', 'policy.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(policyPath, 'utf8');
  } catch {
    return disabled;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return disabled;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return disabled;
  }
  const sg = (parsed as Record<string, unknown>)['spend_governance'];
  if (sg === undefined || sg === null || typeof sg !== 'object' || Array.isArray(sg)) {
    return disabled;
  }
  const block = sg as RawSpendGovernance;
  const enabled = block.enabled === true;
  let mode: BillingErrorResponse = 'halt';
  const rawMode = block.billing_error_response;
  if (rawMode === 'warn' || rawMode === 'off' || rawMode === 'halt') {
    mode = rawMode;
  }
  return { enabled, mode };
}

function buildBanner(matched: string, mode: 'halt' | 'warn'): string {
  const head =
    mode === 'halt'
      ? 'BILLING HALT: metered-spend billing error detected — session frozen'
      : 'BILLING WARNING: metered-spend billing error detected';
  const lines = [
    `${head}\n`,
    '\n',
    `  Signature: ${matched}\n`,
    '\n',
    '  A billing-class error is TERMINAL — it is NOT a rate limit (429).\n',
    '  Retrying it multiplies spend against a metered endpoint. Do NOT retry.\n',
  ];
  if (mode === 'halt') {
    lines.push(
      '\n',
      '  .rea/HALT written — all governed tool calls are now blocked.\n',
      '  Investigate the billing state, then `rea unfreeze` to resume.\n',
    );
  } else {
    lines.push(
      '\n',
      '  spend_governance.billing_error_response is `warn` — no HALT written.\n',
      '  Stop issuing further requests to the metered endpoint.\n',
    );
  }
  return lines.join('');
}

export async function runBillingCapHalt(
  options: BillingCapHaltOptions = {},
): Promise<BillingCapHaltResult> {
  const reaRoot = options.reaRoot ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
  let stderr = '';
  const writeStderr = (s: string): void => {
    stderr += s;
    if (options.stderrWrite) options.stderrWrite(s);
  };

  // 1. HALT short-circuit (uniform with every hook). If already frozen we
  //    exit 2 with the shared banner and do NOT re-write HALT — this is
  //    what makes a repeated billing match idempotent.
  const halt = checkHalt(reaRoot);
  if (halt.halted) {
    writeStderr(formatHaltBanner(halt.reason));
    return { exitCode: 2, stderr, action: 'noop', matched: null, haltWritten: false };
  }

  // 2. Policy gate. Absent block / enabled:false / mode:off → no-op.
  const { enabled, mode } = readSpendGovernance(reaRoot);
  if (!enabled || mode === 'off') {
    return { exitCode: 0, stderr, action: 'noop', matched: null, haltWritten: false };
  }

  // 3. Parse the payload (command + output). A parse failure is FAIL-SAFE:
  //    exit 0, no HALT (see the header — never a false-positive freeze on
  //    unparseable input). A one-line breadcrumb goes to stderr so the
  //    failure is observable without being a gate.
  const stdinRaw =
    options.stdinOverride !== undefined
      ? options.stdinOverride
      : await readStdinWithTimeout(5_000);

  let command = '';
  let output = '';
  try {
    const payload = parsePostToolUsePayload(stdinRaw);
    command = payload.command;
    output = payload.output;
  } catch (err) {
    if (err instanceof MalformedPayloadError || err instanceof TypePayloadError) {
      writeStderr('billing-cap-halt: payload unreadable; skipping (no freeze on malformed input)\n');
      return { exitCode: 0, stderr, action: 'noop', matched: null, haltWritten: false };
    }
    throw err;
  }

  // 4. Scan command + output for a billing-class signature.
  const haystack = output.length > 0 ? `${command}\n${output}` : command;
  const m = BILLING_RE.exec(haystack);
  if (m === null) {
    return { exitCode: 0, stderr, action: 'noop', matched: null, haltWritten: false };
  }

  // Sanitize + bound the matched snippet before it goes anywhere near a
  // banner or the HALT file — the match came from untrusted vendor output
  // and could carry terminal-escape / control bytes.
  const matched = sanitizeHaltReason(m[0]).slice(0, 120) || 'billing-class error';

  // 5. Act per mode.
  if (mode === 'warn') {
    writeStderr(buildBanner(matched, 'warn'));
    return { exitCode: 2, stderr, action: 'warn', matched, haltWritten: false };
  }

  // mode === 'halt'
  const reason = sanitizeHaltReason(
    `billing-cap-halt: billing-class error detected ("${matched}") — automated freeze, no retry`,
  );
  let haltWritten = false;
  try {
    writeHaltFile(reaRoot, reason);
    haltWritten = true;
  } catch (err) {
    // Writing HALT failed (permissions, read-only FS). Still surface the
    // banner + exit 2 so the reflex does not silently disappear — the
    // agent is told to stop even though the global freeze could not be
    // laid down.
    writeStderr(
      `billing-cap-halt: FAILED to write .rea/HALT (${
        err instanceof Error ? err.message : String(err)
      }) — surfacing banner anyway\n`,
    );
  }
  writeStderr(buildBanner(matched, 'halt'));
  return { exitCode: 2, stderr, action: 'halt', matched, haltWritten };
}

/**
 * CLI entry — `rea hook billing-cap-halt`.
 */
export async function runHookBillingCapHalt(
  options: BillingCapHaltOptions = {},
): Promise<void> {
  const result = await runBillingCapHalt({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}
