/**
 * 0.50.x — the OpenRouter (`gpt-oss-120b`) review provider.
 *
 * `gpt-oss-120b` is a raw chat-completions model — no review harness. So
 * this provider supplies the harness Codex bundles for free: assemble the
 * diff, prompt the model to perform an adversarial review, force structured
 * JSON output, and adapt it onto the canonical `Finding[]` + verdict ->
 * `ReviewOutcome` shape.
 *
 * Outbound safety (security-architect, binding — fail-closed):
 *   1. PATH-GUARD is the PRIMARY control. It runs BEFORE any diff bytes are
 *      assembled (review-pathguard.ts). Refusal is TERMINAL for the external
 *      lane — we fall back to the declared local lane (default codex), write
 *      a `rea.local_review.refused_external` record FIRST, and surface a loud
 *      stderr naming the RULE (never the raw path).
 *   2. REDACTION is defense-in-depth, at a SINGLE chokepoint AFTER payload
 *      assembly, BEFORE JSON.stringify + fetch. On redact timeout → ABORT
 *      send, fall back to codex (`refusal_class: 'redact-timeout'`).
 *   3. The assembled diff is byte-capped at `max_diff_bytes`; over-cap falls
 *      back to codex (`refusal_class: 'diff-too-large'`), never truncate-send.
 *   4. The request body sends `provider: { data_collection: 'deny',
 *      only: [backend_pin], allow_fallbacks: false }` +
 *      `response_format: { type: 'json_schema', json_schema: { strict } }`.
 *      The response's serving backend is VERIFIED ∈ backend_pin; a mismatch
 *      discards the findings and falls back to codex
 *      (`refusal_class: 'backend-pin-violation'`).
 *   5. The API key is read from `process.env.OPENROUTER_API_KEY` ONLY, used in
 *      an `Authorization: Bearer` header via in-process `fetch` (no curl
 *      subprocess). It is NEVER logged / audited / in telemetry / in doctor.
 *
 * Testability (QA plan, binding): the transport is injectable
 * (`OpenRouterTransport`) so NO required test hits the network. The whole
 * `execute` is ALSO injectable via the `ExecuteOpenRouterReview` seam (mirror
 * of `executeCodexReview`). Live tests are separate + key-gated.
 *
 * Degradation ladder: HTTP 429 → exponential backoff → fallback backend
 * (within pin) → codex; malformed → ONE repair retry → codex. Every fallback
 * is surfaced; the lane never hangs.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRealGitExecutor } from '../hooks/push-gate/codex-runner.js';
import { resolveBaseRef } from '../hooks/push-gate/base.js';
import { computeTreeToken, EMPTY_TREE_SHA } from '../audit/content-token.js';
import {
  compileDefaultSecretPatterns,
  compileUserRedactPatterns,
  redactSecrets,
  sanitizeInput,
  REDACT_TIMEOUT_SENTINEL,
  type CompiledSecretPattern,
} from '../gateway/middleware/redact.js';
import { inferVerdict, type Finding, type Severity, type Verdict } from '../hooks/push-gate/findings.js';
import { loadPolicyAsync } from '../policy/loader.js';
import type { OpenRouterProviderPolicy, ReviewPathOverride } from '../policy/types.js';
import {
  committedScopeArgs,
  isUnbornHead,
  evaluatePathGuard,
  realPerCommitChangedPaths,
  type ChangedPathsEnumerator,
  type PathGuardResult,
} from './review-pathguard.js';
import type {
  ProviderAvailability,
  ReviewProvider,
} from './review-provider.js';
import type { ReviewOutcome, RunReviewOptions } from './review.js';
import { resolveOpenRouterKey } from './openrouter-key-source.js';

// ---------------------------------------------------------------------------
// Defaults + pricing
// ---------------------------------------------------------------------------

export const OPENROUTER_DEFAULT_MODEL = 'openai/gpt-oss-120b';
export const OPENROUTER_DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const OPENROUTER_DEFAULT_TIMEOUT_MS = 120_000;
/** Default diff byte cap — over-cap falls back to codex, never truncate. */
export const OPENROUTER_DEFAULT_MAX_DIFF_BYTES = 1_500_000;
/** gpt-oss native reasoning effort recorded on the outcome. */
export const OPENROUTER_REASONING_EFFORT = 'medium';
/**
 * Per-REQUEST context budget (commit-aware review, 0.50.x). `gpt-oss-120b` has
 * a ~131k-token window; a diff larger than this is rejected by the backend
 * BEFORE inference (proven empirically — a fast 0-token failure). Our
 * biggest-ever single commit was 421KB / ~105k tokens (fit); 350KB ≈ ~90k
 * tokens leaves room for the system prompt + reasoning + JSON output. This is
 * the per-request budget that decides `auto`-mode chunking; it is DISTINCT from
 * `max_diff_bytes` (the absolute send cap — an over-cap unit escalates the
 * whole review to codex rather than being sent).
 */
export const OPENROUTER_CONTEXT_BUDGET_BYTES = 350 * 1024;

/**
 * Paid `openai/gpt-oss-120b` pricing (USD per 1M tokens), verified
 * 2026-06-08 on the OpenRouter model page. Used ONLY for the est-cost
 * telemetry row; not billing-grade. Re-check at release (volatile).
 */
const PRICE_INPUT_PER_1M = 0.039;
const PRICE_OUTPUT_PER_1M = 0.18;

export function estimateCostUsd(inputTokens: number, outputTokens: number): number {
  const cost =
    (inputTokens / 1_000_000) * PRICE_INPUT_PER_1M +
    (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_1M;
  // Round to 8 decimals — sub-cent precision without float noise.
  return Math.round(cost * 1e8) / 1e8;
}

// ---------------------------------------------------------------------------
// Transport seam
// ---------------------------------------------------------------------------

/** Minimal Response-like the provider consumes from the transport. */
export interface TransportResponse {
  status: number;
  /** Parsed JSON body, or `undefined` when the body was not valid JSON. */
  json?: unknown;
  /** Raw text body (used to surface non-JSON error pages in diagnostics). */
  text: string;
}

/**
 * Injectable transport. Production uses native `fetch`; tests inject a mock
 * so NO required test performs a real outbound request.
 *
 * FIX G (round-4): an optional `signal` is threaded through so the default
 * `fetch` transport is genuinely ABORTED when the per-attempt `timeout_ms`
 * elapses. `postWithBackoff` ALSO races each call against the timeout at the
 * CALL site, so a transport that ignores the signal (a buggy or never-resolving
 * mock) can never hang the governance gate.
 */
export interface OpenRouterTransport {
  post(
    url: string,
    body: unknown,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<TransportResponse>;
}

/** P2-1 (round-6): max response body bytes we will read before rejecting. */
const MAX_RESPONSE_BODY_BYTES = 4 * 1024 * 1024;

/**
 * P2-1 (round-6): read a fetch Response body with a HARD byte cap, honoring the
 * abort signal. `res.text()` reads the entire body with no limit and no read
 * deadline — a hostile endpoint that returns 200 then slow-dribbles (slowloris)
 * or floods a huge body would stream under the unref'd timer. We read the
 * stream chunk-by-chunk, abort + reject the instant the cap is crossed, and the
 * shared `signal` (the per-attempt timeout's controller) covers the read too.
 */
async function readBodyCapped(res: Response, signal: AbortSignal | undefined): Promise<string> {
  const stream = res.body;
  if (stream === null) return '';
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const onAbort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) {
        total += value.byteLength;
        if (total > MAX_RESPONSE_BODY_BYTES) {
          void reader.cancel().catch(() => undefined);
          throw new Error(
            `openrouter response body exceeded ${MAX_RESPONSE_BODY_BYTES} bytes — refused`,
          );
        }
        chunks.push(value);
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Default transport — native `fetch` (Node 22+). NO new dependency. */
export const defaultTransport: OpenRouterTransport = {
  async post(url, body, headers, signal) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      // FIX G (round-4): abort the request when the per-attempt timeout fires.
      ...(signal !== undefined ? { signal } : {}),
      // P3-2 (round-6): a `base_url` that 302s to a non-pinned host would be
      // followed silently before any backend-pin check (with no pin set, that
      // is exfiltration to an arbitrary host). Refuse redirects outright — the
      // pinned endpoint never legitimately redirects an API POST.
      redirect: 'error',
    });
    // P2-1 (round-6): bounded, abort-covered body read (no unbounded text()).
    const text = await readBodyCapped(res, signal);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { status: res.status, json, text };
  },
};

/**
 * FIX G (round-4): race a transport call against a wall-clock timeout. Creates
 * an `AbortController`, passes its signal to `post` (so a real `fetch` is
 * aborted), and rejects with a typed timeout marker when `timeoutMs` elapses —
 * guaranteeing the CALL SITE never hangs even if the transport ignores the
 * signal (e.g. a never-resolving mock). The timer is always cleared.
 */
const TRANSPORT_TIMEOUT = Symbol('openrouter.transport.timeout');

async function postWithTimeout(
  transport: OpenRouterTransport,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<TransportResponse> {
  const controller = new AbortController();
  let firedTimeout = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      firedTimeout = true;
      // Abort the in-flight fetch (best effort) AND reject the race so the
      // call site proceeds even if the transport never settles.
      try {
        controller.abort();
      } catch {
        /* abort is best-effort */
      }
      reject(TRANSPORT_TIMEOUT);
    }, timeoutMs);
    // Do not keep the event loop alive solely for this timer.
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
  });
  // A transport that honors the AbortSignal rejects with its own error the
  // instant we abort — which could win the race over `timeoutPromise` and be
  // misclassified as a generic transport error. If the timer already fired,
  // surface the rejection AS the timeout marker so the caller attributes it
  // correctly (refusal_class 'timeout').
  const transportPromise = transport
    .post(url, body, headers, controller.signal)
    .catch((e: unknown) => {
      if (firedTimeout) throw TRANSPORT_TIMEOUT;
      throw e;
    });
  try {
    return await Promise.race([transportPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** True when an error is the transport-timeout marker. */
function isTransportTimeout(e: unknown): boolean {
  return e === TRANSPORT_TIMEOUT;
}

/**
 * SECURITY (codex round-2 FIX 2): there is intentionally NO env-var fixture
 * transport on the shipped provider. A test seam reachable from production
 * `process.env` (e.g. `REA_OPENROUTER_FIXTURE=<path>`) would let any
 * environment with that var set mint a canonical `rea.local_review` PASS
 * from attacker-controlled JSON — a shipped trust bypass. Unit tests inject
 * a mocked transport via the in-process `OpenRouterTransport` /
 * `RunReviewDeps.executeOpenRouterReview?` seam (never production env). The
 * black-box cross-repo harness points `review.providers.openrouter.base_url`
 * at a `http://127.0.0.1:<port>` localhost fixture HTTP server via the narrow
 * loopback-http exception in the base_url validator — so the REAL shipped
 * `defaultTransport` (native fetch) is exercised end-to-end with no key and
 * no shipped backdoor.
 */

/** Injectable sleep (tests assert on call ordering, not wall time). */
export type SleepFn = (ms: number) => Promise<void>;
const realSleep: SleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The `execute` seam — mirror of `RunReviewDeps.executeCodexReview`. When a
 * test injects this, the provider's `execute` delegates to it and never
 * builds a transport.
 */
export type ExecuteOpenRouterReview = (
  baseDir: string,
  options: RunReviewOptions,
) => Promise<ReviewOutcome>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OpenRouterUnavailableError extends Error {
  readonly kind = 'unavailable' as const;
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterUnavailableError';
  }
}

/**
 * Thrown when the model produced output we cannot parse/validate AND the
 * degradation ladder did not (or could not) escalate to codex. `runReview`
 * maps this to `verdict: 'error'` exit 2 — NEVER a silent pass.
 */
export class OpenRouterMalformedError extends Error {
  readonly kind = 'malformed' as const;
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterMalformedError';
  }
}

/**
 * Thrown when `.rea/policy.yaml` EXISTS but is malformed / schema-invalid
 * (codex round-2 FIX 3). The external lane MUST NOT proceed with permissive
 * empty-default blocked_paths/path_overrides when an operator is iterating
 * on `review.providers.openrouter` — that would bypass the `:free` / HTTPS /
 * path-override safeguards precisely when they matter. The executor catches
 * this and refuses the external lane (fall back to codex,
 * `refusal_class: 'invalid-policy'`). A genuinely MISSING policy file is NOT
 * this error — defaults are safe there (the evidentiary constants still
 * guard, the key check still gates).
 */
export class OpenRouterInvalidPolicyError extends Error {
  readonly kind = 'invalid-policy' as const;
  constructor(message: string) {
    super(message);
    this.name = 'OpenRouterInvalidPolicyError';
  }
}

/**
 * FIX H (round-4): thrown when the external (OpenRouter) lane refuses a diff
 * AND the codex fallback is UNAVAILABLE (codex not installed). `runReview`
 * catches this distinct type and defers to `policy.review.local_review.mode`,
 * mirroring its existing codex-unavailable branch: `mode: off` → write a
 * `skipped_unavailable` record + exit 0 (the documented opt-out); `mode:
 * enforced` (default) → exit 2. Carries the refusal context for the skip
 * record (refusal class + head/base for forensics) — NEVER a raw path.
 *
 * This is distinct from `OpenRouterMalformedError` (a genuine non-execution
 * outcome that ALWAYS exits 2). The difference: a refused-but-codex-absent run
 * under `mode: off` is an intentional opt-out, not an error.
 */
/**
 * Refusal classes that mean the external lane was ACTUALLY CONTACTED and the
 * result was unusable/untrusted: a request timeout, an HTTP exhaustion (429/5xx
 * past backoff), repeated malformed JSON, or a backend-pin violation. These are
 * genuine provider FAILURES — distinct from a deliberate LOCAL non-send
 * (path-guard refusal, invalid policy, oversized diff, redact timeout, git
 * tooling fault) where the external provider was never reached. codex round-2
 * P2: an operational failure must NOT be downgraded to a benign
 * `skipped_unavailable` under `mode: off`; it surfaces as an error (exit 2),
 * exactly like a codex EXECUTION failure already does regardless of mode.
 */
export const OPENROUTER_OPERATIONAL_FAILURE_CLASSES: ReadonlySet<string> = new Set([
  'malformed',
  'backend-pin-violation',
  'timeout',
  'http-exhausted',
]);

export class OpenRouterExternalRefusedError extends Error {
  readonly kind = 'external-refused-no-fallback' as const;
  constructor(
    public readonly refusalClass: string,
    public readonly headSha: string | undefined,
    public readonly baseRef: string | undefined,
  ) {
    super(
      `openrouter external lane refused (${refusalClass}) and codex is not installed`,
    );
    this.name = 'OpenRouterExternalRefusedError';
  }

  /** True when the refusal is a real provider failure (see the set above). */
  get isOperationalFailure(): boolean {
    return OPENROUTER_OPERATIONAL_FAILURE_CLASSES.has(this.refusalClass);
  }
}

/**
 * Round-15 P2: a DISTINCT error for an OpenRouter AUTH failure (401/403/407 —
 * e.g. an expired/revoked `OPENROUTER_API_KEY`). It is NOT the
 * `OpenRouterExternalRefusedError` "codex unavailable" case: the cause is the
 * OpenRouter credential, not codex's absence — so the message and the
 * `runReview` audit reason must name the real cause (never "codex is not
 * installed"). `runReview` defers to `local_review.mode`: off → skip
 * (reason `openrouter-unauthorized`), enforced → exit 2 with this message.
 * No codex fallback (a silent codex substitution would mask the dead key).
 */
export class OpenRouterUnauthorizedError extends Error {
  readonly kind = 'openrouter-unauthorized' as const;
  constructor(
    public readonly headSha: string | undefined,
    public readonly baseRef: string | undefined,
  ) {
    super(
      'openrouter unauthorized (401/403) — OPENROUTER_API_KEY may be expired or ' +
        'revoked. Check the key (export OPENROUTER_API_KEY=…), or change ' +
        'policy.review.provider / local_review.mode.',
    );
    this.name = 'OpenRouterUnauthorizedError';
  }
}

// ---------------------------------------------------------------------------
// Resolved policy
// ---------------------------------------------------------------------------

export interface ResolvedOpenRouterPolicy {
  model: string;
  base_url: string;
  data_policy: string;
  backend_pin: string[];
  timeout_ms: number;
  max_diff_bytes: number;
  path_overrides: ReviewPathOverride[];
  blocked_paths: string[];
  protected_writes: string[];
  /** codex round-17 P2 — subtracted from the governance refuse-set in the guard. */
  protected_paths_relax: string[];
  /** 0.50.x — commit-aware review granularity (`'auto'` default). */
  review_granularity: 'auto' | 'per-commit' | 'whole';
}

export async function resolveOpenRouterPolicy(baseDir: string): Promise<ResolvedOpenRouterPolicy> {
  let blockedPaths: string[] = [];
  let protectedWrites: string[] = [];
  let protectedPathsRelax: string[] = [];
  let or: OpenRouterProviderPolicy = {};
  // FIX 3 (codex round-2): a MISSING policy file is fine — defaults apply
  // (the evidentiary constants still guard, the key check still gates). But a
  // policy that EXISTS and is malformed / schema-invalid MUST fail closed: we
  // throw `OpenRouterInvalidPolicyError` so the executor refuses the external
  // lane rather than proceeding with permissive empty blocked_paths /
  // path_overrides — which would silently bypass the safeguards the operator
  // is in the middle of configuring.
  const policyExists = fs.existsSync(path.join(baseDir, '.rea', 'policy.yaml'));
  try {
    const policy = await loadPolicyAsync(baseDir);
    blockedPaths = policy.blocked_paths ?? [];
    protectedWrites = policy.protected_writes ?? [];
    protectedPathsRelax = policy.protected_paths_relax ?? [];
    or = policy.review?.providers?.openrouter ?? {};
  } catch (e) {
    if (policyExists) {
      // The file is present but unparseable / schema-invalid → FAIL CLOSED.
      const msg = e instanceof Error ? e.message : String(e);
      throw new OpenRouterInvalidPolicyError(msg);
    }
    // Genuinely missing policy — defaults are safe.
  }
  return {
    model: or.model ?? OPENROUTER_DEFAULT_MODEL,
    base_url: or.base_url ?? OPENROUTER_DEFAULT_BASE_URL,
    data_policy: or.data_policy ?? 'deny-training',
    backend_pin: or.backend_pin ?? [],
    timeout_ms: or.timeout_ms ?? OPENROUTER_DEFAULT_TIMEOUT_MS,
    max_diff_bytes: or.max_diff_bytes ?? OPENROUTER_DEFAULT_MAX_DIFF_BYTES,
    path_overrides: or.path_overrides ?? [],
    blocked_paths: blockedPaths,
    protected_writes: protectedWrites,
    protected_paths_relax: protectedPathsRelax,
    review_granularity: or.review_granularity ?? 'auto',
  };
}

/**
 * Best-effort model id for the availability probe / doctor `version`. Never
 * throws — an invalid policy yields the default model name here (cosmetic
 * metadata only); the fail-closed refusal for an invalid policy is
 * `execute`'s job (FIX 3), NOT the availability probe's.
 */
async function resolveModelForProbe(baseDir: string): Promise<string> {
  try {
    const policy = await loadPolicyAsync(baseDir);
    return policy.review?.providers?.openrouter?.model ?? OPENROUTER_DEFAULT_MODEL;
  } catch {
    // Missing OR invalid policy → safe default display value. Availability is
    // unchanged; `execute` enforces the invalid-policy fail-closed refusal.
    return OPENROUTER_DEFAULT_MODEL;
  }
}

// ---------------------------------------------------------------------------
// Adversarial prompt + JSON schema
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = [
  'You are a hostile, adversarial code reviewer. Your job is to find REAL',
  'defects in the supplied diff — security holes, correctness bugs, data',
  'loss, race conditions, missing error handling, and unsafe assumptions.',
  'Surface ONLY genuine defects; do not invent issues to look thorough.',
  'Classify each finding by severity:',
  '  - P1: blocking. Must be fixed before merge (security / correctness / data loss).',
  '  - P2: concerns. Significant risk you want fixed.',
  '  - P3: nits / low-priority suggestions.',
  'Return JSON ONLY, matching this exact contract, with no prose outside the JSON:',
  '{ "verdict": "pass" | "concerns" | "blocking",',
  '  "findings": [ { "severity": "P1"|"P2"|"P3", "title": string, "body": string,',
  '                  "file": string (optional), "line": number (optional) } ] }',
  'The verdict MUST be "blocking" if any P1 exists, else "concerns" if any P2,',
  'else "pass".',
].join('\n');

const RESPONSE_JSON_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'rea_review',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['verdict', 'findings'],
      properties: {
        verdict: { type: 'string', enum: ['pass', 'concerns', 'blocking'] },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['severity', 'title', 'body'],
            properties: {
              severity: { type: 'string', enum: ['P1', 'P2', 'P3'] },
              title: { type: 'string' },
              body: { type: 'string' },
              file: { type: 'string' },
              line: { type: 'number' },
            },
          },
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Output adapter
// ---------------------------------------------------------------------------

export interface ParsedReview {
  verdict: Verdict;
  findings: Finding[];
  /**
   * STRUCTURAL FIX 1 / P2-2 (round-6): true when the model returned more
   * findings than `MAX_FINDINGS` and the array was capped. Surfaced to the
   * outcome / last-review so the truncation is forensically visible.
   */
  truncated: boolean;
}

/**
 * The outcome of ONE send (whole diff or a single per-commit unit) through the
 * `attemptOnce` + repair-retry path. The whole path and every per-commit unit
 * share this exact union so the two lanes stay byte-for-byte aligned.
 */
type UnitAttempt =
  | {
      kind: 'ok';
      parsed: ParsedReview;
      servedBy?: string;
      usage: { input?: number; output?: number };
      rateLimited: boolean;
    }
  | { kind: 'http-exhausted'; rateLimited: boolean; timedOut: boolean }
  | {
      kind: 'malformed';
      rateLimited: boolean;
      servedBy?: string;
      usage?: { input?: number; output?: number };
    }
  | {
      kind: 'backend-pin-violation';
      servedBy?: string;
      rateLimited: boolean;
      usage?: { input?: number; output?: number };
    }
  | { kind: 'unauthorized'; rateLimited: boolean };

// ---------------------------------------------------------------------------
// STRUCTURAL FIX 1 (round-6) — response-ingress sanitizer.
//
// `adaptOpenRouterResponse` + `extractServedBy` are the ONLY ingress for
// attacker-controlled response data into the hash-chained audit log,
// last-review.json, stdout, and telemetry. `appendAuditRecord` does NOT redact
// (it only validates JSON round-trip), and — unlike the codex path — the
// openrouter path never redacted. Every model-sourced string is scrubbed HERE,
// at the single adapter boundary, BEFORE it reaches any sink:
//   P1-1 REDACT finding title/body (the model echoes diff content verbatim).
//   P1-2 VALIDATE served_by (bound + char-class; drop on violation).
//   P2-3 CONTROL-CHAR sanitize all model strings.
//   P2-2 BOUND findings count + per-finding body/title size.
// ---------------------------------------------------------------------------

/** Max findings retained from a response; excess is dropped + flagged. */
export const MAX_FINDINGS = 50;
/** Max bytes of a finding `body` kept (excess truncated with a marker). */
const MAX_FINDING_BODY_BYTES = 8 * 1024;
/** Max bytes of a finding `title` kept. */
const MAX_FINDING_TITLE_BYTES = 1024;
/** Max bytes of a `served_by` string (also char-class validated). */
const SERVED_BY_RE = /^[a-zA-Z0-9._-]{1,64}$/;

/** Shared default redactor for model-sourced strings (P1-1). */
let _modelRedactPatterns: ReturnType<typeof compileDefaultSecretPatterns> | undefined;
function modelRedactPatterns(): ReturnType<typeof compileDefaultSecretPatterns> {
  if (_modelRedactPatterns === undefined) {
    _modelRedactPatterns = compileDefaultSecretPatterns({ source: 'default' });
  }
  return _modelRedactPatterns;
}

/** Truncate a string to at most `maxBytes` UTF-8 bytes (whole-char safe). */
function clampBytes(s: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return { value: s, truncated: false };
  // Walk back to a valid char boundary under the cap.
  let out = s;
  while (Buffer.byteLength(out, 'utf8') > maxBytes && out.length > 0) {
    out = out.slice(0, -1);
  }
  return { value: out, truncated: true };
}

/**
 * Scrub ONE model string: control-char strip (P2-3) → secret-redact (P1-1) →
 * byte-cap (P2-2). Order matters: control-char strip first so a NUL can't
 * defeat the redactor; redact before cap so a cap can't slice a secret in half
 * and leak a prefix.
 */
function scrubModelString(
  raw: string,
  maxBytes: number,
  patterns: CompiledSecretPattern[] = modelRedactPatterns(),
): { value: string; truncated: boolean } {
  const stripped = sanitizeInput(raw);
  const redacted = redactSecrets(stripped, patterns).output;
  return clampBytes(redacted, maxBytes);
}

/** Sanitize ONE finding's strings in place (returns a new, scrubbed Finding). */
function sanitizeFinding(
  f: Finding,
  patterns: CompiledSecretPattern[] = modelRedactPatterns(),
): Finding {
  const title = scrubModelString(f.title, MAX_FINDING_TITLE_BYTES, patterns).value;
  const bodyClamp = scrubModelString(f.body, MAX_FINDING_BODY_BYTES, patterns);
  const body = bodyClamp.truncated ? `${bodyClamp.value}…[truncated]` : bodyClamp.value;
  // file/line are structural (path / number) — file is scrubbed of control
  // chars but NOT redacted (it is a path the guard already vetted; redacting it
  // would corrupt the location). It is byte-capped defensively.
  return {
    severity: f.severity,
    title,
    body,
    ...(f.file !== undefined
      ? { file: clampBytes(sanitizeInput(f.file), 1024).value }
      : {}),
    ...(f.line !== undefined ? { line: f.line } : {}),
  };
}

/** Severity rank for the verdict alphabet — higher is more severe. */
const VERDICT_RANK: Record<Verdict, number> = { pass: 0, concerns: 1, blocking: 2 };

/**
 * FIX J (round-5): reconcile the model's SELF-stated verdict against the
 * verdict DERIVED from its own findings, taking the MORE SEVERE of the two.
 * The OSS model is untrusted output everywhere else — its self-verdict must
 * not be trusted over its own findings:
 *   - `{verdict:'pass'}` alongside a P1/P2 finding → blocking/concerns
 *     (findings win, prevents a passing record that preflight would accept).
 *   - `{verdict:'blocking'}` with no structured findings → still blocking
 *     (don't downgrade — the model's higher severity wins).
 * Uses the SAME `inferVerdict` mapping the codex path uses.
 */
export function reconcileVerdict(modelVerdict: Verdict, findings: Finding[]): Verdict {
  const fromFindings = inferVerdict(findings);
  return VERDICT_RANK[modelVerdict] >= VERDICT_RANK[fromFindings] ? modelVerdict : fromFindings;
}

/**
 * Parse + validate the model's structured response into `Finding[]` + verdict.
 * Returns `undefined` (NOT a partial result) when the body is malformed /
 * unparseable / schema-violating — the caller maps that to the error path.
 *
 * FIX J (round-5): the returned `verdict` is the MORE SEVERE of the model's
 * self-verdict and `inferVerdict(findings)` — never the model's self-verdict
 * alone. A `{verdict:'pass', findings:[P1]}` response yields `blocking`.
 */
export function adaptOpenRouterResponse(
  body: unknown,
  patterns: CompiledSecretPattern[] = modelRedactPatterns(),
): ParsedReview | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const choices = (body as Record<string, unknown>).choices;
  if (!Array.isArray(choices) || choices.length === 0) return undefined;
  const first = choices[0] as Record<string, unknown> | undefined;
  const message = first?.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content !== 'string' || content.trim().length === 0) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const obj = parsed as Record<string, unknown>;
  const verdict = obj.verdict;
  if (verdict !== 'pass' && verdict !== 'concerns' && verdict !== 'blocking') return undefined;
  const rawFindings = obj.findings;
  if (!Array.isArray(rawFindings)) return undefined;

  // STRUCTURAL FIX 1 / P2-2 (round-6): cap the findings array length BEFORE the
  // per-element loop so a hostile endpoint returning 100k findings cannot bloat
  // the audit log or drive O(n·m) parity loops. The cap is on the RAW array;
  // anything past `MAX_FINDINGS` is dropped and flagged `truncated`.
  const truncated = rawFindings.length > MAX_FINDINGS;
  const consider = truncated ? rawFindings.slice(0, MAX_FINDINGS) : rawFindings;

  const findings: Finding[] = [];
  for (const rf of consider) {
    if (rf === null || typeof rf !== 'object') return undefined;
    const f = rf as Record<string, unknown>;
    const severity = f.severity;
    if (severity !== 'P1' && severity !== 'P2' && severity !== 'P3') return undefined;
    if (typeof f.title !== 'string' || typeof f.body !== 'string') return undefined;
    const raw: Finding = {
      severity: severity as Severity,
      title: f.title,
      body: f.body,
      // Omit (never null/undefined) absent file/line — matches report.ts.
      ...(typeof f.file === 'string' && f.file.length > 0 ? { file: f.file } : {}),
      ...(typeof f.line === 'number' && Number.isFinite(f.line) ? { line: f.line } : {}),
    };
    // STRUCTURAL FIX 1 / P1-1 + P2-2 + P2-3: scrub (control-strip → redact →
    // byte-cap) every model-sourced string BEFORE it reaches any sink.
    findings.push(sanitizeFinding(raw, patterns));
  }
  // Round-12 P1: the cap above is a STORAGE bound — but the VERDICT must reflect
  // the FULL payload, or a P1 past `MAX_FINDINGS` would be laundered into a
  // pass/concerns that preflight accepts. Do a CHEAP severity-only scan over the
  // ENTIRE raw array (no per-finding sanitize/redact — that expensive work stays
  // bounded to the stored subset, preserving the P2-2 DoS bound) and reconcile
  // the verdict against THAT, not just the truncated stored set.
  const verdictView: Finding[] =
    truncated
      ? rawFindings.reduce<Finding[]>((acc, rf) => {
          if (rf !== null && typeof rf === 'object') {
            const sev = (rf as Record<string, unknown>).severity;
            if (sev === 'P1' || sev === 'P2' || sev === 'P3') {
              acc.push({ severity: sev as Severity, title: '', body: '' });
            }
          }
          return acc;
        }, [])
      : findings;
  // FIX J (round-5): NEVER trust the model's self-verdict over its own
  // findings — take the more severe of (model verdict, inferVerdict(findings)).
  return { verdict: reconcileVerdict(verdict, verdictView), findings, truncated };
}

/**
 * Extract + VALIDATE the OpenRouter serving backend from a response body.
 *
 * STRUCTURAL FIX 1 / P1-2 + P2-3 (round-6): the response `provider` string is
 * attacker-controlled and, when no `backend_pin` is set, is written verbatim to
 * the hash-chained audit log + metrics. Bound + char-validate it
 * (`^[a-zA-Z0-9._-]{1,64}$`, after a control-char strip); on violation DROP it
 * (return undefined) so a 10KB / control-char / `"codex"`-forgery value never
 * lands in any sink. When a pin IS set, a mismatch is still caught as the
 * existing backend-pin-violation (this validation runs first / independently).
 */
export function extractServedBy(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const prov = (body as Record<string, unknown>).provider;
  if (typeof prov !== 'string' || prov.length === 0) return undefined;
  // FIX (round-11): validate the RAW value — do NOT sanitize-then-match. The
  // backend-pin check compares served_by against the pin; stripping control
  // chars FIRST would launder a forged value like `fire\x00works` (a NUL
  // between `fire` and `works`) into a clean `fireworks` that PASSES the pin,
  // defeating the control. A served_by that
  // does not match the strict class exactly as reported is invalid /
  // undeterminable → undefined (under a pin that is a backend-pin-violation;
  // in the audit record it is simply omitted). Strictly safer than the prior
  // sanitize-then-validate, and legit OpenRouter backend slugs (fireworks,
  // deepinfra, …) already match the class as-reported.
  if (!SERVED_BY_RE.test(prov)) return undefined;
  return prov;
}

/** Extract the usage block (token counts) when present. */
/**
 * P3-1 (round-6): a sane upper bound on a single review's token count. Larger
 * than any realistic gpt-oss context window; anything beyond is a forged /
 * buggy value that would write nonsense cost to metrics.jsonl. Clamped, not
 * rejected, so a slightly-over value still records a (bounded) row.
 */
const MAX_TOKENS_PER_CALL = 100_000_000;

/** Clamp a model-supplied token count to a finite, non-negative, bounded int. */
function clampTokens(n: unknown): number | undefined {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
  return Math.min(Math.floor(n), MAX_TOKENS_PER_CALL);
}

export function extractUsage(body: unknown): { input?: number; output?: number } {
  if (body === null || typeof body !== 'object') return {};
  const usage = (body as Record<string, unknown>).usage;
  if (usage === null || typeof usage !== 'object') return {};
  const u = usage as Record<string, unknown>;
  // P3-1: clamp attacker-controlled token counts — forged absurd values must
  // not write nonsense to metrics.jsonl / est-cost.
  const input = clampTokens(u.prompt_tokens);
  const output = clampTokens(u.completion_tokens);
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}

// ---------------------------------------------------------------------------
// Provider factory
// ---------------------------------------------------------------------------

export interface OpenRouterProviderOpts {
  /** Full `execute` override (the deps seam). */
  execute?: ExecuteOpenRouterReview;
  /** Injectable transport (tests). Defaults to native fetch. */
  transport?: OpenRouterTransport;
  /** Injectable env (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Injectable sleep (tests assert call ordering). */
  sleep?: SleepFn;
  /** Injectable changed-paths enumerator (tests). */
  enumerate?: ChangedPathsEnumerator;
  /**
   * Injectable codex fallback (`execute` of the codex provider). The
   * degradation ladder and the path-guard refusal both fall back to this.
   * `runReview` passes the real CodexProvider.execute; tests pass a fake.
   * When absent, fallback escalates to `OpenRouterMalformedError` (→ error
   * exit 2) rather than silently passing.
   */
  codexFallback?: ExecuteOpenRouterReview;
  /**
   * FIX H (round-4): probe whether the codex fallback lane is actually usable
   * (codex installed). When this returns `false`, a refusal does NOT run codex
   * — it throws `OpenRouterExternalRefusedError` so `runReview` defers to
   * `local_review.mode` (off → exit 0 skip; enforced → exit 2). When absent,
   * codex is assumed available (back-compat: a wired `codexFallback` is run as
   * before). `runReview` wires the codex provider's availability probe.
   */
  codexAvailable?: () => boolean;
  /**
   * FIX A (round-2): probe codex's `--version` so a codex-fallback outcome
   * carries codex's real `provider_version`. `runReview` wires the codex
   * provider's availability probe; tests pass a fake. Never throws.
   */
  codexProbeVersion?: () => string | undefined;
  /**
   * Sink for the `rea.local_review.refused_external` audit record + the
   * shadow telemetry. `runReview` wires these to `safeAudit` + telemetry;
   * tests capture them. Optional — when absent, refusal is still loud on
   * stderr and the fallback still runs.
   */
  onRefusedExternal?: (info: {
    refusalClass: string;
    matchedRule?: string;
    changedPathCount: number;
    fallbackProvider: string;
    headSha?: string;
    baseRef?: string;
  }) => Promise<void> | void;
  /** Telemetry sink for a per-call token/cost row. */
  onTelemetry?: (row: {
    model: string;
    servedBy?: string;
    inputTokens?: number;
    outputTokens?: number;
    estCostUsd?: number;
    durationMs: number;
    rateLimited: boolean;
    /**
     * FIX C (round-2): the REAL exit status of the openrouter attempt. `0` ONLY
     * for a clean openrouter success; non-zero for malformed / backend-pin
     * violation / HTTP-exhausted / any path that fell back to codex. Hard-coding
     * 0 wrote failures + fallbacks to metrics.jsonl as successful, breaking
     * doctor/metrics troubleshooting.
     */
    exitCode: number;
    /** FIX C (round-2): true when the attempt fell back to codex. */
    fellBack: boolean;
  }) => Promise<void> | void;
}

const KEY_ENV = 'OPENROUTER_API_KEY';

export function OpenRouterProvider(opts: OpenRouterProviderOpts = {}): ReviewProvider {
  const env = opts.env ?? process.env;
  // Transport selection: explicit injection wins (unit tests); else native
  // fetch. There is NO env-var fixture transport — see the SECURITY note above
  // (codex round-2 FIX 2). The black-box harness drives `defaultTransport`
  // against a localhost HTTP server via the base_url loopback exception.
  const transport = opts.transport ?? defaultTransport;
  const sleep = opts.sleep ?? realSleep;

  return {
    id: 'openrouter',
    async isAvailable(baseDir: string): Promise<ProviderAvailability> {
      // When an `execute` override (the deps test seam) is present, the
      // caller is driving the execute path directly — availability is
      // implied (no key needed for a mocked execution). This keeps the
      // 0.28.1 deps-seam contract: injecting the execute seam exercises the
      // full downstream wiring WITHOUT requiring an API key in the env.
      if (opts.execute !== undefined) {
        return { available: true, version: await resolveModelForProbe(baseDir) };
      }
      // Presence is necessary; reachability is best-effort. A missing key
      // makes the provider unavailable. With a key present we OPTIMISTICALLY
      // report available — the reachability ping is doctor's job (and would
      // hit the network, which the required gate forbids). There is NO
      // env-var fixture escape hatch: a missing key is ALWAYS unavailable.
      //
      // Key resolution is env-FIRST, then the managed credentials file
      // (`rea config set-key openrouter`). A symlinked / world-readable /
      // foreign-owned creds file is REFUSED by the resolver → no key → here we
      // report unavailable, exactly as if the key were absent.
      const { key } = resolveOpenRouterKey(env);
      if (key === undefined || key.length === 0) {
        return { available: false };
      }
      // version === the model id (no binary version to probe). An invalid
      // policy does NOT change availability — the fail-closed refusal for an
      // invalid policy happens in `execute` (FIX 3), not here.
      return { available: true, version: await resolveModelForProbe(baseDir) };
    },
    async execute(baseDir: string, options: RunReviewOptions): Promise<ReviewOutcome> {
      if (opts.execute !== undefined) return opts.execute(baseDir, options);
      return executeOpenRouterReview(baseDir, options, {
        transport,
        env,
        sleep,
        ...(opts.enumerate !== undefined ? { enumerate: opts.enumerate } : {}),
        ...(opts.codexFallback !== undefined ? { codexFallback: opts.codexFallback } : {}),
        ...(opts.codexAvailable !== undefined ? { codexAvailable: opts.codexAvailable } : {}),
        ...(opts.codexProbeVersion !== undefined
          ? { codexProbeVersion: opts.codexProbeVersion }
          : {}),
        ...(opts.onRefusedExternal !== undefined
          ? { onRefusedExternal: opts.onRefusedExternal }
          : {}),
        ...(opts.onTelemetry !== undefined ? { onTelemetry: opts.onTelemetry } : {}),
      });
    },
    classifyError(e: unknown): string {
      if (e instanceof OpenRouterUnavailableError) return 'unavailable';
      if (e instanceof OpenRouterMalformedError) return 'malformed';
      // 0.50.x P3 (codex): a 401/403 throws OpenRouterUnauthorizedError. Keep
      // the specific cause in the `rea.local_review` error audit `kind` (an
      // expired/revoked key reads as 'unauthorized', not generic 'unknown') so
      // operator diagnostics + audit reporting can distinguish credential
      // failure from a transport/parse fault.
      if (e instanceof OpenRouterUnauthorizedError) return 'unauthorized';
      // codex round-2 P2: keep the SPECIFIC refusal class in the error audit
      // `kind` (e.g. 'malformed', 'timeout', 'backend-pin-violation',
      // 'path-guard') so an operator can tell a real provider failure from a
      // deliberate refusal — never a generic 'unknown'.
      if (e instanceof OpenRouterExternalRefusedError) return e.refusalClass;
      return 'unknown';
    },
    unavailableMessage(): string[] {
      return [
        `${KEY_ENV} not set — the openrouter review provider needs an API key.`,
        '',
        '  Set:    rea config set-key openrouter   (stored 0600 in ~/.config/rea)',
        `  Or:     export ${KEY_ENV}=sk-or-...      (per-project / CI; env wins)`,
        '  Or set: policy.review.provider: codex   (use the codex lane)',
        '  Or set: policy.review.local_review.mode: off   (disable enforcement)',
        '',
      ];
    },
  };
}

// ---------------------------------------------------------------------------
// The real executor
// ---------------------------------------------------------------------------

interface ExecuteDeps {
  transport: OpenRouterTransport;
  env: NodeJS.ProcessEnv;
  sleep: SleepFn;
  enumerate?: ChangedPathsEnumerator;
  /**
   * codex round-13 P1 test seam — the PER-COMMIT sent-path enumerator used by
   * the per-commit guard. Production uses `realPerCommitChangedPaths`; tests
   * inject one to drive the guard over a synthetic union (e.g. a blocked path
   * present in an intermediate commit but absent from the net diff).
   */
  enumeratePerCommit?: ChangedPathsEnumerator;
  codexFallback?: ExecuteOpenRouterReview;
  /**
   * FIX H (round-4): whether the codex fallback lane is usable (codex
   * installed). `false` → a refusal throws `OpenRouterExternalRefusedError`
   * (mode-deferred in `runReview`). Absent → assume available.
   */
  codexAvailable?: () => boolean;
  /**
   * FIX A (round-2): probe codex's `--version` so a codex-fallback outcome
   * can carry codex's actual `provider_version` into the audit record. Never
   * throws — returns undefined when codex's version can't be determined.
   */
  codexProbeVersion?: () => string | undefined;
  onRefusedExternal?: OpenRouterProviderOpts['onRefusedExternal'];
  onTelemetry?: OpenRouterProviderOpts['onTelemetry'];
}

/**
 * FIX I (round-5): flags that neutralize external / textconv diff drivers so
 * the CONTENT we send off-machine is exactly the raw patch the path-guard
 * reasoned about — never the stdout of `GIT_EXTERNAL_DIFF` / `diff.external` /
 * a per-path textconv driver (which could emit arbitrary bytes from elsewhere
 * in the checkout, past the guard, or hang).
 *
 *   - `--no-ext-diff`  neutralizes BOTH `GIT_EXTERNAL_DIFF` and `diff.external`.
 *   - `--no-textconv`  neutralizes per-path `textconv` filters (only valid on
 *                      content-producing diffs, NOT on `--name-only`).
 *
 * Defense-in-depth env scrub (`SAFE_GIT_DIFF_ENV`) ALSO clears
 * `GIT_EXTERNAL_DIFF`/`GIT_DIFF_OPTS` and pins `-c diff.external=` /
 * `-c core.attributesFile=/dev/null` so even a path that forgot a flag, or a
 * future git that changes flag semantics, cannot reach an external helper.
 */
const NO_EXT_DIFF_FLAG = '--no-ext-diff';
const NO_TEXTCONV_FLAG = '--no-textconv';

/**
 * Git `-c` overrides prepended to EVERY content/path diff so config-driven
 * external/textconv drivers cannot fire even if a flag were ever dropped.
 *
 * STRUCTURAL FIX 2 / P1-3 (round-6): `-c core.quotePath=false` so the patch
 * headers carry REAL byte-exact paths (default `core.quotePath=true` octal-
 * escapes + double-quote-wraps non-ASCII names). Combined with the guard's
 * `-z` + `core.quotePath=false` enumeration, both sides see identical real
 * paths so the guard==diff invariant holds for non-ASCII / newline names.
 */
const SAFE_DIFF_CONFIG = [
  '-c',
  'diff.external=',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'core.quotePath=false',
];

/**
 * Sanitized env for the spawned `git`: strip the env vars that can install an
 * external diff/log helper, on top of the `--no-ext-diff` flag. Belt-and-
 * suspenders — `--no-ext-diff` already neutralizes `GIT_EXTERNAL_DIFF`.
 */
function safeGitDiffEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_DIFF_OPTS;
  return env;
}

/**
 * Build the outbound diff text from GIT PLUMBING. NOTE: the diff *content*
 * goes off-machine, so it is the redaction chokepoint's responsibility; the
 * PATH-GUARD has already decided (over the changed-PATH set) whether the
 * send is permitted. We never parse this diff text to decide routing.
 *
 * FIX I (round-5): every content diff carries `--no-ext-diff --no-textconv`
 * (+ the safe `-c` overrides + a scrubbed env) so the bytes are the RAW patch,
 * never an external/textconv helper's output.
 */
/**
 * FIX N (round-8): a `git diff` that FAILS — a non-zero exit (bad ref, repo
 * corruption) or a spawn error like ENOBUFS when the patch exceeds `maxBuffer`
 * — must NOT be silently collapsed to an empty diff. Reviewing a partial/empty
 * patch and writing a `pass` would claim HEAD was reviewed when part of it
 * never reached the provider (false coverage — the worst failure for a gate).
 * The caller catches this and FAILS CLOSED to codex. A `status === 0` result
 * with empty stdout is a LEGITIMATE no-changes diff and is returned as `''`.
 */
export class DiffAssemblyError extends Error {
  readonly kind: 'diff-too-large' | 'diff-error';
  constructor(kind: 'diff-too-large' | 'diff-error', message: string) {
    super(message);
    this.name = 'DiffAssemblyError';
    this.kind = kind;
  }
}

export function diffStdoutOrThrow(r: ReturnType<typeof spawnSync>, what: string): string {
  // Spawn-level error: ENOBUFS (patch > maxBuffer) → diff-too-large; any other
  // (ENOENT, etc.) → diff-error. Either way, fail closed — never review partial.
  if (r.error !== undefined) {
    const code = (r.error as NodeJS.ErrnoException).code;
    if (code === 'ENOBUFS') {
      throw new DiffAssemblyError('diff-too-large', `${what} exceeded the diff buffer`);
    }
    throw new DiffAssemblyError('diff-error', `${what} failed: ${r.error.message}`);
  }
  // Non-zero exit (bad ref, corruption) — NOT a legitimate empty diff.
  if (r.status !== 0) {
    throw new DiffAssemblyError('diff-error', `${what} exited ${String(r.status)}`);
  }
  return typeof r.stdout === 'string' ? r.stdout : '';
}

export function assembleDiff(baseDir: string, baseRef: string): string {
  // FIX D (round-3): when HEAD is UNBORN (bootstrap repo, no first commit),
  // the reviewable content is the STAGED initial tree — use `git diff --cached`
  // ONLY (index vs empty tree); there is no `git diff HEAD` working scope. This
  // matches the guard's `realChangedPaths` unborn branch so the guard==diff
  // invariant holds. When HEAD exists, FIX B applies (two/three-dot committed
  // scope + the `git diff HEAD` working scope).
  const unborn = isUnbornHead(baseDir).unborn;
  const env = safeGitDiffEnv();
  const r = spawnSync(
    'git',
    [
      ...SAFE_DIFF_CONFIG,
      'diff',
      '--no-color',
      NO_EXT_DIFF_FLAG,
      NO_TEXTCONV_FLAG,
      ...committedScopeArgs(baseRef, unborn),
    ],
    { cwd: baseDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env },
  );
  const committed = diffStdoutOrThrow(r, 'git diff (committed scope)');
  if (unborn) {
    // No HEAD → no working-tree-vs-HEAD scope; the staged tree IS the review.
    return committed;
  }
  // Also include working-tree changes (staged + unstaged) so a pre-commit
  // review sees what `rea review` is meant to review.
  const wt = spawnSync(
    'git',
    [...SAFE_DIFF_CONFIG, 'diff', '--no-color', NO_EXT_DIFF_FLAG, NO_TEXTCONV_FLAG, 'HEAD'],
    { cwd: baseDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env },
  );
  const working = diffStdoutOrThrow(wt, 'git diff HEAD (working tree)');
  return [committed, working].filter((s) => s.length > 0).join('\n');
}

/**
 * Commit-aware review unit — ONE coherent slice of the approved diff sent in a
 * single request. A `commit <sha7>: <subject>` unit carries that commit's OWN
 * patch (cross-file context preserved within the commit, NOT a per-file silo);
 * the trailing `working-tree` unit carries uncommitted tracked changes vs HEAD.
 */
export interface ReviewUnit {
  label: string;
  diff: string;
}

/**
 * Enumerate the per-commit (+ trailing working-tree) review units for the
 * approved range, oldest→newest. Used ONLY for `per-commit` chunking — the
 * path-guard has already approved the WHOLE changed-path set; this just splits
 * what is SENT, post-approval.
 *
 * INVARIANT (matches `assembleDiff`): the UNION of all units' changed paths
 * equals the whole-diff changed-path set the guard evaluated. Each commit C's
 * patch is `C^..C` (root commit → empty tree as the parent), and the trailing
 * `working-tree` unit is `git diff HEAD` (tracked working-tree + index vs
 * HEAD) — together exactly the `base..HEAD` ∪ `HEAD..working-tree` shape
 * `assembleDiff` sends.
 *
 * FAIL-CLOSED: every git invocation carries `SAFE_DIFF_CONFIG` +
 * `--no-ext-diff --no-textconv` + a scrubbed env, and each per-commit diff goes
 * through `diffStdoutOrThrow` so a git failure THROWS `DiffAssemblyError`
 * (never a silently-empty unit). `rev-list` failure throws too.
 */
export function enumerateReviewUnits(baseDir: string, baseRef: string): ReviewUnit[] {
  const env = safeGitDiffEnv();
  const unborn = isUnbornHead(baseDir).unborn;
  if (unborn) {
    // No HEAD → no commits to walk; the staged tree IS the review. `assembleDiff`
    // returns the `--cached` diff in this case — mirror it as a single unit so
    // the union invariant holds (and per-commit degenerates to one unit).
    const staged = spawnSync(
      'git',
      [...SAFE_DIFF_CONFIG, 'diff', '--no-color', NO_EXT_DIFF_FLAG, NO_TEXTCONV_FLAG, '--cached'],
      { cwd: baseDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env },
    );
    const diff = diffStdoutOrThrow(staged, 'git diff --cached (unborn HEAD)');
    return diff.length > 0 ? [{ label: 'staged (unborn HEAD)', diff }] : [];
  }

  // Commits oldest→newest. A two-dot `base..HEAD` range lists commits reachable
  // from HEAD but not base — for an empty-tree base that is ALL of HEAD's
  // history; for a real base it is base..HEAD. (rev-list takes the range
  // directly, unlike `git log`/`git diff` which want three-dot for the symmetric
  // committed scope — but rev-list of base..HEAD over a linear range is exactly
  // the commit set we want to walk per-commit.)
  const range = `${baseRef}..HEAD`;
  const revList = spawnSync(
    'git',
    [...SAFE_DIFF_CONFIG, 'rev-list', '--reverse', range],
    { cwd: baseDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env },
  );
  if (revList.error !== undefined) {
    const code = (revList.error as NodeJS.ErrnoException).code;
    if (code === 'ENOBUFS') {
      throw new DiffAssemblyError('diff-too-large', 'git rev-list exceeded the buffer');
    }
    throw new DiffAssemblyError('diff-error', `git rev-list failed: ${revList.error.message}`);
  }
  if (revList.status !== 0) {
    throw new DiffAssemblyError('diff-error', `git rev-list exited ${String(revList.status)}`);
  }
  const shas = (typeof revList.stdout === 'string' ? revList.stdout : '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const units: ReviewUnit[] = [];
  for (const sha of shas) {
    // Each commit's OWN patch: `C^..C`. For a root commit `C^` does not exist,
    // so diff against the empty tree (`EMPTY_TREE_SHA C`) — the same shape
    // assembleDiff uses for an empty-tree base.
    const hasParent =
      spawnSync('git', [...SAFE_DIFF_CONFIG, 'rev-parse', '--verify', '--quiet', `${sha}^`], {
        cwd: baseDir,
        encoding: 'utf8',
        env,
      }).status === 0;
    const left = hasParent ? `${sha}^` : EMPTY_TREE_SHA;
    const patch = spawnSync(
      'git',
      [...SAFE_DIFF_CONFIG, 'diff', '--no-color', NO_EXT_DIFF_FLAG, NO_TEXTCONV_FLAG, left, sha],
      { cwd: baseDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env },
    );
    const diff = diffStdoutOrThrow(patch, `git diff (${sha.slice(0, 7)})`);
    // Subject for the human label (SAFE config + scrubbed env). Best-effort —
    // a missing subject only degrades the label, never the diff content.
    const subjectResult = spawnSync(
      'git',
      [...SAFE_DIFF_CONFIG, 'show', '-s', '--format=%s', sha],
      { cwd: baseDir, encoding: 'utf8', env },
    );
    const subject =
      subjectResult.status === 0 && typeof subjectResult.stdout === 'string'
        ? subjectResult.stdout.split(/\r?\n/)[0]?.trim() ?? ''
        : '';
    const label = `commit ${sha.slice(0, 7)}${subject.length > 0 ? `: ${subject}` : ''}`;
    if (diff.length > 0) units.push({ label, diff });
  }

  // Trailing working-tree unit — uncommitted tracked changes vs HEAD. Append
  // only when non-empty. This is the `git diff HEAD` half of assembleDiff.
  const wt = spawnSync(
    'git',
    [...SAFE_DIFF_CONFIG, 'diff', '--no-color', NO_EXT_DIFF_FLAG, NO_TEXTCONV_FLAG, 'HEAD'],
    { cwd: baseDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env },
  );
  const working = diffStdoutOrThrow(wt, 'git diff HEAD (working tree)');
  if (working.length > 0) units.push({ label: 'working-tree', diff: working });

  return units;
}

/**
 * Run one transport round-trip with backoff over HTTP 429 / 5xx. Returns the
 * response, or `undefined` when the ladder exhausted retries (caller falls
 * back to codex). Never hangs — bounded retries, injected sleep, AND a
 * per-attempt wall-clock timeout (FIX G, round-4). The whole loop is bounded by
 * roughly `timeoutMs × MAX_ATTEMPTS` plus backoff — never unbounded.
 */
async function postWithBackoff(
  deps: ExecuteDeps,
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<{ response?: TransportResponse; rateLimited: boolean; timedOut: boolean }> {
  const MAX_ATTEMPTS = 3;
  let rateLimited = false;
  let timedOut = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let res: TransportResponse;
    try {
      // FIX G: each attempt is bounded by `timeoutMs`. A timeout aborts the
      // in-flight fetch and counts as a FAILED attempt → go to the ladder.
      res = await postWithTimeout(deps.transport, url, body, headers, timeoutMs);
    } catch (e) {
      if (isTransportTimeout(e)) {
        // Stalled attempt — record it and treat like a 5xx (retry/fall back).
        timedOut = true;
      }
      // Transport error (network down / timeout) — sibling of 5xx. Back off.
      if (attempt < MAX_ATTEMPTS - 1) await deps.sleep(2 ** attempt * 250);
      continue;
    }
    if (res.status === 429) {
      rateLimited = true;
      if (attempt < MAX_ATTEMPTS - 1) await deps.sleep(2 ** attempt * 250);
      continue;
    }
    if (res.status >= 500) {
      if (attempt < MAX_ATTEMPTS - 1) await deps.sleep(2 ** attempt * 250);
      continue;
    }
    return { response: res, rateLimited, timedOut };
  }
  return { rateLimited, timedOut };
}

/**
 * Production executor. Honors the outbound-safety chokepoint in order:
 * path-guard → assemble → byte-cap → redact → transport → backend-pin verify
 * → adapt → (repair retry) → fallback. Telemetry recorded on every outcome.
 */
export async function executeOpenRouterReview(
  baseDir: string,
  options: RunReviewOptions,
  deps: ExecuteDeps,
): Promise<ReviewOutcome> {
  // Resolve git base/head FIRST — these do NOT depend on the openrouter
  // policy, so they remain available for the refusal/fallback path even when
  // the openrouter policy itself is invalid.
  const git = createRealGitExecutor(baseDir);
  const explicit = options.base !== undefined && options.base.length > 0 ? options.base : undefined;
  const base = explicit !== undefined ? resolveBaseRef(git, { explicit }) : resolveBaseRef(git);
  const resolvedHeadSha = git.headSha();
  const headSha = resolvedHeadSha.length > 0 ? resolvedHeadSha : EMPTY_TREE_SHA;
  // Content token computed BEFORE the model call — race-free (same as codex).
  const contentToken = computeTreeToken(baseDir);

  // --- Fallback helper (defined before policy resolution so an invalid
  //     policy can fail closed through it) -----------------------------------
  const fallbackToCodex = async (
    refusalClass: string,
    matchedRule: string | undefined,
    changedPathCount: number,
    fallbackProvider: 'codex' | 'refuse',
  ): Promise<ReviewOutcome> => {
    // M2 (round-8): determine the TRUTH of what will actually happen BEFORE
    // writing the refusal record, so the record never claims a codex fallback
    // that never runs. The codex fallback runs ONLY when a fallback is wired
    // AND codex is available AND this isn't a hard `path_override: refuse`.
    const codexAvailable =
      deps.codexFallback !== undefined &&
      (deps.codexAvailable === undefined || deps.codexAvailable() === true);
    const willRunCodex = fallbackProvider === 'codex' && codexAvailable;
    // The provider the run ACTUALLY falls back to: 'codex' only when codex
    // will really run; otherwise 'none' (the run skips under mode:off or errors
    // under mode:enforced — no review lane runs).
    const resolvedFallbackProvider: 'codex' | 'none' = willRunCodex ? 'codex' : 'none';

    // Loud stderr naming the RULE that matched, NOT the raw path value — and
    // the REAL destination ('codex' or 'none'), not the requested lane.
    process.stderr.write(
      `rea: openrouter external lane refused (${refusalClass}` +
        `${matchedRule !== undefined ? `: ${matchedRule}` : ''}) — ` +
        `${willRunCodex ? 'falling back to codex' : 'no fallback lane runs'}.\n`,
    );
    // Write the refused_external audit record BEFORE falling back — with the
    // ACCURATE fallback_provider.
    if (deps.onRefusedExternal !== undefined) {
      await deps.onRefusedExternal({
        refusalClass,
        ...(matchedRule !== undefined ? { matchedRule } : {}),
        changedPathCount,
        fallbackProvider: resolvedFallbackProvider,
        headSha,
        baseRef: base.ref,
      });
    }
    if (fallbackProvider === 'refuse') {
      // A `path_override: refuse` blocks the run entirely → error exit 2.
      throw new OpenRouterMalformedError(
        `external review refused by path_override (${matchedRule ?? refusalClass}) and ` +
          `no fallback lane is permitted`,
      );
    }
    // FIX H (round-4): the codex fallback is UNAVAILABLE when no fallback was
    // wired OR codex is not installed. In that case throw the typed
    // `OpenRouterExternalRefusedError` so `runReview` defers to
    // `local_review.mode` (off → exit 0 skip; enforced → exit 2) instead of
    // unconditionally exiting 2.
    if (!codexAvailable) {
      throw new OpenRouterExternalRefusedError(refusalClass, headSha, base.ref);
    }
    // codexFallback is defined here (guarded above).
    const runCodexFallback = deps.codexFallback;
    if (runCodexFallback === undefined) {
      // Unreachable given the guard above, but keep the type narrow + safe.
      throw new OpenRouterExternalRefusedError(refusalClass, headSha, base.ref);
    }
    // FIX A (round-2) + M1 (round-8): the codex fallback ACTUALLY ran — stamp
    // the outcome so `runReview` names codex (not openrouter) in the audit
    // record + --json, attaches codex's `provider_version`, and emits NO
    // served_by / data_policy_* (openrouter never served). The codex provider's
    // own outcome never sets these, so we rebuild WITHOUT them (omit, never set
    // to undefined — exactOptionalPropertyTypes forbids the latter).
    const codexOutcome = await runCodexFallback(baseDir, options);
    const codexVersion = deps.codexProbeVersion?.();
    const {
      servedBy: _sb,
      dataPolicyRequested: _dpr,
      dataPolicyEnforced: _dpe,
      ...codexOnly
    } = codexOutcome;
    void _sb;
    void _dpr;
    void _dpe;
    return {
      ...codexOnly,
      actualProviderId: 'codex',
      ...(codexVersion !== undefined ? { actualProviderVersion: codexVersion } : {}),
    };
  };

  // FIX 3 (codex round-2): a malformed/invalid `.rea/policy.yaml` MUST fail
  // closed — refuse the external lane (fall back to codex) rather than
  // proceeding with permissive empty defaults that bypass the
  // :free/HTTPS/path-override safeguards. A genuinely MISSING policy is fine
  // (resolveOpenRouterPolicy returns safe defaults; the evidentiary constants
  // still guard).
  let resolved: ResolvedOpenRouterPolicy;
  try {
    resolved = await resolveOpenRouterPolicy(baseDir);
  } catch (e) {
    if (e instanceof OpenRouterInvalidPolicyError) {
      return fallbackToCodex('invalid-policy', undefined, 0, 'codex');
    }
    throw e;
  }

  // Round-17 P1/P2: honor `policy.redact.patterns` (org-specific secrets/PII) on
  // BOTH the outbound chokepoint AND the finding sanitizer — built-in patterns
  // alone would let custom-matched values reach OpenRouter and the audit log.
  // Default + user, compiled ONCE. `resolveOpenRouterPolicy` already loaded +
  // validated the policy (threw on invalid); loadPolicyAsync is cached so this
  // best-effort re-read is cheap. A missing/unreadable policy → defaults only.
  // codex round-7 P2: honor `policy.redact.match_timeout_ms` for BOTH the
  // built-in and user pattern sets — a constant 2000ms diverged from every
  // other redaction path (a smaller configured budget could block longer than
  // policy allows; a larger one could spuriously trip `redact-timeout`). When
  // the policy doesn't configure it, keep the lane's established 2000ms default
  // (a large diff needs a roomier budget than the gateway's 100ms tool-input
  // default).
  const LANE_REDACT_TIMEOUT_DEFAULT_MS = 2000;
  let userRedactPatterns: CompiledSecretPattern[] = [];
  let redactTimeoutMs = LANE_REDACT_TIMEOUT_DEFAULT_MS;
  try {
    const pol = await loadPolicyAsync(baseDir);
    if (typeof pol.redact?.match_timeout_ms === 'number' && pol.redact.match_timeout_ms > 0) {
      redactTimeoutMs = pol.redact.match_timeout_ms;
    }
    userRedactPatterns = compileUserRedactPatterns(pol.redact?.patterns ?? [], {
      timeoutMs: redactTimeoutMs,
    });
  } catch {
    /* missing/invalid policy: resolveOpenRouterPolicy already gated it */
  }
  const redactPatterns: CompiledSecretPattern[] = [
    ...compileDefaultSecretPatterns({ source: 'default', timeoutMs: redactTimeoutMs }),
    ...userRedactPatterns,
  ];

  // A real API key is REQUIRED — there is no fixture/env placeholder escape
  // (codex round-2 FIX 2). The black-box harness supplies a dummy key in env
  // and points base_url at a localhost responder; that exercises the real
  // transport without minting trust from a shipped backdoor. Resolution is
  // env-FIRST, then the managed credentials file (fail-closed on a tampered
  // file — see openrouter-key-source.ts).
  const { key } = resolveOpenRouterKey(deps.env);
  if (key === undefined || key.length === 0) {
    throw new OpenRouterUnavailableError(`${KEY_ENV} not set`);
  }

  // --- 1. PATH-GUARD (primary control, before any diff bytes) -------------
  const guard: PathGuardResult = evaluatePathGuard({
    baseDir,
    baseRef: base.ref,
    blockedPaths: resolved.blocked_paths,
    protectedWrites: resolved.protected_writes,
    protectedPathsRelax: resolved.protected_paths_relax,
    pathOverrides: resolved.path_overrides,
    ...(deps.enumerate !== undefined ? { enumerate: deps.enumerate } : {}),
  });
  if (guard.decision === 'refuse') {
    return fallbackToCodex(
      guard.refusalClass ?? 'path-guard',
      guard.matchedRule,
      guard.changedPathCount,
      guard.fallbackLane ?? 'codex',
    );
  }

  // --- 2. Assemble diff + byte-cap ----------------------------------------
  // FIX N (round-8): a git-diff command failure (non-zero exit, or ENOBUFS when
  // the patch exceeds the buffer) must FAIL CLOSED — never review a partial/
  // empty diff and write a `pass` claiming HEAD was reviewed. Route to codex
  // (or error per mode) with the real refusal class.
  let diffText: string;
  try {
    diffText = assembleDiff(baseDir, base.ref);
  } catch (e) {
    if (e instanceof DiffAssemblyError) {
      return fallbackToCodex(e.kind, undefined, guard.changedPathCount, 'codex');
    }
    throw e;
  }
  // FIX B (round-2): `git log <empty-tree>...HEAD` errors (empty-tree is not a
  // commit) — use a two-dot range there so the empty-tree base lists every
  // commit. FIX D (round-3): when HEAD is unborn there are no commits — skip
  // the log entirely (`git log HEAD` would error). Non-fatal either way
  // (`.stdout ?? ''`), but keep it correct.
  const unbornHead = resolvedHeadSha.length === 0;
  let commitLog = '';
  if (!unbornHead) {
    const logRange = base.ref === EMPTY_TREE_SHA ? `${base.ref}..HEAD` : `${base.ref}...HEAD`;
    // FIX I (round-5): `--oneline` shows no patch, but the log content still
    // goes off-machine — carry `--no-ext-diff` + the safe `-c`/env scrub so a
    // config-injected external/textconv driver can never fire here either.
    commitLog =
      spawnSync(
        'git',
        [...SAFE_DIFF_CONFIG, 'log', '--no-ext-diff', '--oneline', '-n', '20', logRange],
        { cwd: baseDir, encoding: 'utf8', env: safeGitDiffEnv() },
      ).stdout ?? '';
  }
  // The user content the model reviews — diff + a short commit-log header.
  // P2-4 (round-6): the commit log (branch names + commit subjects, which can
  // carry PII like ticket URLs / customer names) is part of `userContent` and
  // therefore passes through the SAME redaction chokepoint below as the diff —
  // it egresses, and that egress is disclosed in THREAT_MODEL §5.25.
  let userContent = `Commits under review:\n${commitLog}\n\nDiff:\n${diffText}`;
  // codex round-16 P1: the WHOLE-diff `max_diff_bytes` cap and whole-diff
  // redaction apply ONLY when the whole `userContent` is what gets sent (the
  // `whole` lane, and `auto` when it fits). In EXPLICIT `per-commit` mode the
  // whole diff is NEVER sent — it is split into per-commit units, each of which
  // is size-checked AND redacted INDEPENDENTLY in the per-commit loop below.
  // Applying the whole-diff cap here would make per-commit unusable for exactly
  // the large multi-commit branches it exists to handle (a 1.5MB total diff
  // falls back to codex even though every commit fits). So skip the whole-diff
  // gates for per-commit; the per-unit gates are the real controls there.
  const isPerCommit = resolved.review_granularity === 'per-commit';
  if (!isPerCommit) {
    if (Buffer.byteLength(userContent, 'utf8') > resolved.max_diff_bytes) {
      return fallbackToCodex('diff-too-large', undefined, guard.changedPathCount, 'codex');
    }
    // --- 3. REDACT (defense-in-depth chokepoint, BEFORE stringify+fetch) -----
    //         covers BOTH the diff AND the commit-log header (P2-4).
    const redaction = redactSecrets(userContent, redactPatterns);
    if (redaction.timedOut || redaction.output === REDACT_TIMEOUT_SENTINEL) {
      // Cannot guarantee the body is clean → ABORT send, fall back to codex.
      return fallbackToCodex('redact-timeout', undefined, guard.changedPathCount, 'codex');
    }
    userContent = redaction.output;
  }

  // --- 4. Request scaffolding (URL + headers, shared by every unit) --------
  const url = `${resolved.base_url.replace(/\/+$/, '')}/chat/completions`;
  // Authorization header from process env ONLY. NEVER logged/audited.
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };

  // Build the request body for a SINGLE unit's content. The `whole` path passes
  // the full `userContent` here, so its body is byte-identical to the
  // pre-chunking shape (golden / ~15k tests pin this).
  const buildRequestBody = (content: string): Record<string, unknown> => ({
    model: resolved.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content },
    ],
    response_format: RESPONSE_JSON_SCHEMA,
    // Native gpt-oss reasoning effort.
    reasoning: { effort: OPENROUTER_REASONING_EFFORT },
    provider: {
      data_collection: 'deny',
      allow_fallbacks: false,
      ...(resolved.backend_pin.length > 0 ? { only: resolved.backend_pin } : {}),
    },
  });

  const started = Date.now();

  // --- 5. Transport with backoff + ONE repair retry on malformed ----------
  const attemptOnce = async (
    body: Record<string, unknown>,
  ): Promise<UnitAttempt> => {
    // FIX G: pass the configured per-attempt timeout so a stalled handshake /
    // unresponsive backend aborts and falls over rather than hanging the gate.
    const { response, rateLimited, timedOut } = await postWithBackoff(
      deps,
      url,
      body,
      headers,
      resolved.timeout_ms,
    );
    if (response === undefined) return { kind: 'http-exhausted', rateLimited, timedOut };
    // Round-14 P1: 401/403/407 are AUTH failures, NOT malformed output. An
    // expired/revoked OPENROUTER_API_KEY must SURFACE on the authoritative
    // openrouter path (so the operator notices the configured provider cannot
    // run) — never silently downgrade to codex like a content/transport issue.
    if (response.status === 401 || response.status === 403 || response.status === 407) {
      return { kind: 'unauthorized', rateLimited };
    }
    if (response.status < 200 || response.status >= 300) {
      // Other non-2xx (e.g. 400) — no usable review; the ladder escalates to codex.
      return { kind: 'malformed', rateLimited };
    }
    const servedBy = extractServedBy(response.json);
    // FIX O (round-8): this is a billable 200 — capture the real usage NOW so a
    // backend-pin-violation or schema-invalid response (which still consumed
    // tokens) records its true spend in telemetry instead of zero.
    const usage = extractUsage(response.json);
    // BACKEND-PIN verification: served-by must be in the pin (when a pin is
    // set). Undeterminable served-by under a pin → UNCERTAIN → fall back.
    if (resolved.backend_pin.length > 0) {
      if (servedBy === undefined) {
        return { kind: 'backend-pin-violation', rateLimited, usage };
      }
      if (!resolved.backend_pin.includes(servedBy)) {
        return { kind: 'backend-pin-violation', servedBy, rateLimited, usage };
      }
    }
    const parsed = adaptOpenRouterResponse(response.json, redactPatterns);
    if (parsed === undefined) {
      return {
        kind: 'malformed',
        rateLimited,
        usage,
        ...(servedBy !== undefined ? { servedBy } : {}),
      };
    }
    return {
      kind: 'ok',
      parsed,
      ...(servedBy !== undefined ? { servedBy } : {}),
      usage,
      rateLimited,
    };
  };

  // Review ONE unit's content through the IDENTICAL send / repair / backend-pin
  // / parse path. The whole-diff path and EACH per-commit unit both call this,
  // so `whole` stays byte-identical and the per-commit lane reuses the exact
  // same outbound contract. Returns the final attempt AFTER the one repair
  // retry. (`reviewUnitContent` in the prescription.)
  const reviewUnitContent = async (content: string): Promise<UnitAttempt> => {
    let attempt = await attemptOnce(buildRequestBody(content));
    if (attempt.kind === 'malformed') {
      // ONE repair retry with an explicit repair instruction.
      const repairBody: Record<string, unknown> = {
        ...buildRequestBody(content),
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
          {
            role: 'system',
            content:
              'Your previous response did not match the required JSON schema. ' +
              'Respond again with JSON ONLY matching the schema — no prose, no markdown fences.',
          },
        ],
      };
      const retry = await attemptOnce(repairBody);
      // Preserve the rate-limit signal across the repair (FIX: a 429 on the
      // first attempt then a clean repair must still mark the run rate-limited).
      if (attempt.rateLimited && !retry.rateLimited && 'rateLimited' in retry) {
        attempt = { ...retry, rateLimited: true } as UnitAttempt;
      } else {
        attempt = retry;
      }
    }
    return attempt;
  };

  // Telemetry row writer — takes the run's `durationMs` + `rateLimited` as
  // arguments so BOTH the whole path and the per-commit merge (whose duration +
  // rate-limit are SUMMED/OR'd over units) write a correct row.
  const recordTelemetryRow = async (
    servedBy: string | undefined,
    usage: { input?: number; output?: number },
    status: { exitCode: number; fellBack: boolean },
    durationMs: number,
    rateLimited: boolean,
  ): Promise<void> => {
    if (deps.onTelemetry === undefined) return;
    const inputTokens = usage.input;
    const outputTokens = usage.output;
    const estCostUsd =
      inputTokens !== undefined && outputTokens !== undefined
        ? estimateCostUsd(inputTokens, outputTokens)
        : undefined;
    await deps.onTelemetry({
      model: resolved.model,
      ...(servedBy !== undefined ? { servedBy } : {}),
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(estCostUsd !== undefined ? { estCostUsd } : {}),
      durationMs,
      rateLimited,
      // FIX C (round-2): the real status — 0 only on a clean openrouter success.
      exitCode: status.exitCode,
      fellBack: status.fellBack,
    });
  };

  // --- 5b. Granularity decision (commit-aware review) ----------------------
  // `whole`: always one request (byte-identical to pre-chunking).
  // `auto`:  whole when the redacted body fits the context budget, else ESCALATE
  //          TO CODEX. codex round-11 P1: per-commit review of `C^..C` is NOT
  //          semantically equivalent to reviewing the net `base...HEAD` — a
  //          problem introduced in commit A and FIXED in commit B would still be
  //          flagged against the clean final diff. So `auto` must NOT silently
  //          switch to per-commit semantics as a gate substitute; an over-budget
  //          NET diff goes to codex (the escalation scalpel, full net-diff
  //          context). Per-commit semantics are an EXPLICIT opt-in only.
  // `per-commit`: always per-commit — the "review each commit as you make it"
  //          PRACTICE. Each commit is reviewed independently on its own patch;
  //          a fix-up in a LATER commit does NOT suppress an earlier commit's
  //          finding. That is INTENTIONAL for commit-level review (you review A
  //          before B exists), and DISTINCT from a net-diff gate — documented so
  //          operators choose it deliberately, never as a silent fallback.
  // The path-guard already approved the WHOLE changed-path set above — chunking
  // ONLY splits what is SENT. The redacted `userContent` is what would be sent
  // on the whole path, so its byte length is the budget test.
  const userContentBytes = Buffer.byteLength(userContent, 'utf8');
  if (
    resolved.review_granularity === 'auto' &&
    userContentBytes > OPENROUTER_CONTEXT_BUDGET_BYTES
  ) {
    // Net diff too large for gpt-oss's context window → escalate to codex with
    // CORRECT net-diff semantics rather than silently degrading to per-commit.
    return fallbackToCodex('diff-too-large', undefined, guard.changedPathCount, 'codex');
  }
  const usePerCommit = resolved.review_granularity === 'per-commit';

  // The merged attempt + run-level duration/rate-limit. The whole path fills
  // these from a single send; the per-commit path fills them from the merge.
  let attempt: UnitAttempt;
  let rateLimited: boolean;
  let durationMs: number;

  if (usePerCommit) {
    // --- PER-COMMIT path -------------------------------------------------
    // codex round-13 P1: the whole-diff guard above evaluated the NET
    // `base...HEAD` changed-path set, but per-commit mode sends each commit's
    // own `C^..C` patch — whose union can include a path absent from the net
    // diff (reverted before HEAD, or merged from main). Re-run the guard over
    // the ACTUAL per-commit sent-path union so every byte we send here was
    // approved. A refuse → escalate the whole review to codex (fail-closed).
    // (`enumerate` is honored as a test seam; production uses the real union.)
    const perCommitGuard = evaluatePathGuard({
      baseDir,
      baseRef: base.ref,
      blockedPaths: resolved.blocked_paths,
      protectedWrites: resolved.protected_writes,
      protectedPathsRelax: resolved.protected_paths_relax,
      pathOverrides: resolved.path_overrides,
      enumerate: deps.enumeratePerCommit ?? realPerCommitChangedPaths,
    });
    if (perCommitGuard.decision === 'refuse') {
      return fallbackToCodex(
        perCommitGuard.refusalClass ?? 'path-guard',
        perCommitGuard.matchedRule,
        perCommitGuard.changedPathCount,
        perCommitGuard.fallbackLane ?? 'codex',
      );
    }
    // Enumerate the units (fail-closed: a git error throws DiffAssemblyError).
    let units: ReviewUnit[];
    try {
      units = enumerateReviewUnits(baseDir, base.ref);
    } catch (e) {
      if (e instanceof DiffAssemblyError) {
        return fallbackToCodex(e.kind, undefined, guard.changedPathCount, 'codex');
      }
      throw e;
    }
    // A degenerate empty unit set (no changes) collapses to a single send.
    // codex round-16 P1: in per-commit mode `userContent` was NOT redacted above
    // (the whole-diff redaction is skipped for per-commit), so REDACT it here
    // before the degenerate send — no unredacted bytes ever leave, on any path.
    if (units.length === 0) {
      const red = redactSecrets(userContent, redactPatterns);
      if (red.timedOut || red.output === REDACT_TIMEOUT_SENTINEL) {
        return fallbackToCodex('redact-timeout', undefined, guard.changedPathCount, 'codex');
      }
      const single = await reviewUnitContent(red.output);
      attempt = single;
      rateLimited = single.rateLimited;
      durationMs = Date.now() - started;
    } else {
      const okUnits: Array<Extract<UnitAttempt, { kind: 'ok' }>> = [];
      let anyRateLimited = false;
      for (const unit of units) {
        // Build + REDACT this unit's content (per-SENT-unit redaction — no
        // unredacted bytes ever leave). The commit-log header for a unit is its
        // own label (commit sha+subject, or `working-tree`).
        const rawUnitContent = `Commits under review:\n${unit.label}\n\nDiff:\n${unit.diff}`;
        const unitRedaction = redactSecrets(rawUnitContent, redactPatterns);
        if (unitRedaction.timedOut || unitRedaction.output === REDACT_TIMEOUT_SENTINEL) {
          return fallbackToCodex('redact-timeout', undefined, guard.changedPathCount, 'codex');
        }
        const unitContent = unitRedaction.output;
        // A single unit too big to split further (over the context budget OR
        // over the absolute send cap) → escalate the WHOLE review to codex.
        // Never send an over-budget unit.
        const unitBytes = Buffer.byteLength(unitContent, 'utf8');
        if (unitBytes > OPENROUTER_CONTEXT_BUDGET_BYTES || unitBytes > resolved.max_diff_bytes) {
          return fallbackToCodex('diff-too-large', undefined, guard.changedPathCount, 'codex');
        }
        const unitAttempt = await reviewUnitContent(unitContent);
        if (unitAttempt.rateLimited) anyRateLimited = true;
        if (unitAttempt.kind !== 'ok') {
          // FAIL-CLOSED: a non-ok unit is handled EXACTLY as the whole-diff
          // failure path — unauthorized surfaces; the rest fall back to codex
          // with that unit's refusal class. Never merge a set with a dropped
          // unit. Telemetry: record the failing unit's real status before exit.
          const fServedBy = 'servedBy' in unitAttempt ? unitAttempt.servedBy : undefined;
          const fUsage =
            'usage' in unitAttempt && unitAttempt.usage !== undefined ? unitAttempt.usage : {};
          const codexAvailableForFallback =
            deps.codexFallback !== undefined &&
            (deps.codexAvailable === undefined || deps.codexAvailable() === true);
          const willFallBack =
            unitAttempt.kind !== 'unauthorized' && codexAvailableForFallback;
          await recordTelemetryRow(
            fServedBy,
            fUsage,
            { exitCode: 2, fellBack: willFallBack },
            Date.now() - started,
            anyRateLimited,
          );
          if (unitAttempt.kind === 'unauthorized') {
            throw new OpenRouterUnauthorizedError(headSha, base.ref);
          }
          if (unitAttempt.kind === 'backend-pin-violation') {
            return fallbackToCodex(
              'backend-pin-violation',
              undefined,
              guard.changedPathCount,
              'codex',
            );
          }
          if (unitAttempt.kind === 'http-exhausted') {
            return fallbackToCodex(
              unitAttempt.timedOut ? 'timeout' : 'http-exhausted',
              undefined,
              guard.changedPathCount,
              'codex',
            );
          }
          // malformed after repair → escalate.
          return fallbackToCodex('malformed', undefined, guard.changedPathCount, 'codex');
        }
        okUnits.push(unitAttempt);
      }
      // ALL units ok → merge into one synthetic 'ok' feeding the EXISTING
      // finalization code unchanged. Downstream-indistinguishable from a
      // whole-diff review (one outcome, one audit record).
      attempt = mergeUnitAttempts(okUnits, anyRateLimited);
      rateLimited = anyRateLimited;
      durationMs = Date.now() - started;
    }
  } else {
    // --- WHOLE path (granularity 'whole', or 'auto' under budget) --------
    const single = await reviewUnitContent(userContent);
    attempt = single;
    rateLimited = single.rateLimited;
    durationMs = Date.now() - started;
  }

  if (attempt.kind === 'ok') {
    // Clean openrouter success → exit 0, no fallback.
    await recordTelemetryRow(
      attempt.servedBy,
      attempt.usage,
      { exitCode: 0, fellBack: false },
      durationMs,
      rateLimited,
    );
    const { verdict, findings, truncated } = attempt.parsed;
    // STRUCTURAL FIX 1 / P2-2: surface a truncation marker in the review text
    // (→ last-review.json) so a capped findings array is forensically visible.
    const baseText = renderReviewText(verdict, findings);
    const reviewText = truncated
      ? `${baseText}\n[rea: findings capped at ${MAX_FINDINGS}; the model returned more — excess dropped]`
      : baseText;
    // M1 (round-8): DERIVE the honest data-policy posture HERE (the only place
    // served_by + backend_pin are both in scope). `requested` is always 'deny'
    // (what we asked); `enforced` is 'pin-verified' ONLY when a non-empty pin
    // is set AND served_by is a member — otherwise 'routing-requested', which
    // is the default `backend_pin: []` case and is NOT a verified guarantee.
    const dataPolicyRequested = 'deny';
    const dataPolicyEnforced: 'pin-verified' | 'routing-requested' =
      resolved.backend_pin.length > 0 &&
      attempt.servedBy !== undefined &&
      resolved.backend_pin.includes(attempt.servedBy)
        ? 'pin-verified'
        : 'routing-requested';
    return {
      verdict,
      findingCount: findings.length,
      baseRef: base.ref,
      headSha,
      contentToken,
      durationSeconds: durationMs / 1000,
      model: resolved.model,
      reasoningEffort: OPENROUTER_REASONING_EFFORT,
      findings,
      reviewText,
      eventCount: 1,
      // FIX A (round-2): openrouter ACTUALLY served this outcome.
      actualProviderId: 'openrouter',
      ...(attempt.servedBy !== undefined ? { servedBy: attempt.servedBy } : {}),
      // M1: honest data-policy posture (requested + derived enforcement).
      dataPolicyRequested,
      dataPolicyEnforced,
    };
  }

  // Telemetry on the failure path too (latency + rate-limit visibility).
  // FIX C (round-2): a failed external attempt is NOT exit 0 — record the
  // real non-zero status + fellBack=true so doctor/metrics see the failure.
  const failServedBy = 'servedBy' in attempt ? attempt.servedBy : undefined;
  // FIX O (round-8): a backend-pin-violation or schema-invalid response was a
  // billable 200 — record the REAL usage it consumed (not zero) so doctor /
  // metrics don't undercount exactly the fallback paths operators diagnose.
  const failUsage = 'usage' in attempt && attempt.usage !== undefined ? attempt.usage : {};
  // Round-15 P3: `fellBack` must reflect whether a codex review ACTUALLY runs.
  // An `unauthorized` failure SURFACES (no fallback); the other kinds fall back
  // ONLY when codex is wired + available. Compute the truth here instead of
  // hardcoding `true` (which wrote a misleading "fell back to codex" marker to
  // metrics.jsonl for no-fallback runs — the exact rows operators inspect).
  const codexAvailableForFallback =
    deps.codexFallback !== undefined &&
    (deps.codexAvailable === undefined || deps.codexAvailable() === true);
  const willFallBack = attempt.kind !== 'unauthorized' && codexAvailableForFallback;
  await recordTelemetryRow(
    failServedBy,
    failUsage,
    { exitCode: 2, fellBack: willFallBack },
    durationMs,
    rateLimited,
  );

  // Round-14 P1: an AUTH failure SURFACES on the authoritative path — it does
  // NOT silently fall back to codex (which would mask a revoked/expired key).
  // Throw the mode-defer error directly: `runReview` reports it (enforced →
  // error/exit 2 with the `unauthorized` cause; mode: off → skip). The shadow
  // lane catches this and records shadow-unavailable, so `provider: both` (codex
  // authoritative) is unaffected.
  if (attempt.kind === 'unauthorized') {
    throw new OpenRouterUnauthorizedError(headSha, base.ref);
  }
  if (attempt.kind === 'backend-pin-violation') {
    return fallbackToCodex('backend-pin-violation', undefined, guard.changedPathCount, 'codex');
  }
  if (attempt.kind === 'http-exhausted') {
    // FIX G: distinguish a timeout-driven exhaustion from a pure HTTP one so the
    // refusal/telemetry name the real cause ('timeout' vs 'http-exhausted').
    return fallbackToCodex(
      attempt.timedOut ? 'timeout' : 'http-exhausted',
      undefined,
      guard.changedPathCount,
      'codex',
    );
  }
  // attempt.kind === 'malformed' after the repair retry → escalate.
  return fallbackToCodex('malformed', undefined, guard.changedPathCount, 'codex');
}

/**
 * Merge per-commit 'ok' unit attempts into ONE synthetic 'ok' attempt that
 * feeds the EXISTING whole-path finalization unchanged (downstream-
 * indistinguishable from a whole-diff review):
 *   - verdict   = MAX severity over units (pass < concerns < blocking), via the
 *                 SAME `VERDICT_RANK` the response adapter uses.
 *   - findings  = concat of all units' findings, capped at `MAX_FINDINGS`.
 *   - truncated = true if the cap dropped any finding OR any unit was truncated.
 *   - usage     = sum of input/output tokens across units.
 *   - servedBy  = first defined served_by (best-effort identity for the record).
 *   - rateLimited = OR over units (passed in — the caller already OR'd it).
 *
 * Exported for unit tests (verdict=max + findings-union+cap).
 */
export function mergeUnitAttempts(
  units: ReadonlyArray<{
    parsed: ParsedReview;
    servedBy?: string;
    usage: { input?: number; output?: number };
  }>,
  rateLimited: boolean,
): Extract<UnitAttempt, { kind: 'ok' }> {
  let verdict: Verdict = 'pass';
  let anyTruncated = false;
  const allFindings: Finding[] = [];
  let inputSum: number | undefined;
  let outputSum: number | undefined;
  let servedBy: string | undefined;
  for (const u of units) {
    if (VERDICT_RANK[u.parsed.verdict] > VERDICT_RANK[verdict]) verdict = u.parsed.verdict;
    if (u.parsed.truncated) anyTruncated = true;
    for (const f of u.parsed.findings) allFindings.push(f);
    if (u.usage.input !== undefined) inputSum = (inputSum ?? 0) + u.usage.input;
    if (u.usage.output !== undefined) outputSum = (outputSum ?? 0) + u.usage.output;
    if (servedBy === undefined && u.servedBy !== undefined) servedBy = u.servedBy;
  }
  // Cap the concatenated findings at MAX_FINDINGS — the SAME bound the response
  // adapter applies to a single response, now over the union. codex round-11 P2:
  // when capping, keep the HIGHEST-severity findings, not just the first in unit
  // order — otherwise a later unit's P1/P2 (which drove the merged blocking/
  // concerns verdict) could be dropped while earlier P3s survive, leaving
  // last-review.json / --with-findings without the actionable finding that
  // caused the failure. Stable severity sort (P1 < P2 < P3) preserves relative
  // order within a severity. Only reorder when we actually cap.
  const capped = allFindings.length > MAX_FINDINGS;
  const SEVERITY_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2 };
  const findings = capped
    ? [...allFindings]
        .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3))
        .slice(0, MAX_FINDINGS)
    : allFindings;
  const truncated = anyTruncated || capped;
  const usage: { input?: number; output?: number } = {
    ...(inputSum !== undefined ? { input: inputSum } : {}),
    ...(outputSum !== undefined ? { output: outputSum } : {}),
  };
  return {
    kind: 'ok',
    parsed: { verdict, findings, truncated },
    ...(servedBy !== undefined ? { servedBy } : {}),
    usage,
    rateLimited,
  };
}

/**
 * Render canonical review text from the structured findings — the
 * `[severity] title — file:line` shape `summarizeReview` produces, so
 * `last-review.json`'s `review_text` is consistent across providers and
 * the parser-debug surface stays uniform.
 */
function renderReviewText(verdict: Verdict, findings: Finding[]): string {
  const lines: string[] = [`verdict: ${verdict}`];
  for (const f of findings) {
    const loc =
      f.file !== undefined ? ` — ${f.file}${f.line !== undefined ? `:${f.line}` : ''}` : '';
    lines.push(`- [${f.severity}] ${f.title}${loc}`);
    if (f.body.length > 0 && f.body !== f.title) lines.push(f.body);
  }
  return lines.join('\n');
}
