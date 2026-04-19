import { z } from 'zod';
import type { Middleware, InvocationContext } from './chain.js';
import { InvocationStatus, Tier } from '../../policy/types.js';
import { wrapRegex, type SafeRegex } from '../redact-safe/match-timeout.js';

/**
 * Known prompt injection phrases (lowercase for case-insensitive matching).
 * These patterns are commonly used to override system instructions in tool
 * descriptions or resource content returned by downstream MCP servers.
 *
 * SECURITY (G9 follow-up): inputs are NFKC-normalized, whitespace-collapsed,
 * and zero-width-stripped before matching (see `normalizeForMatch`). That
 * means the phrases below can safely be written with plain ASCII spaces —
 * the normalizer will fold NBSP, en-space, em-space, zero-width joiners,
 * etc. into the same form so crafted Unicode variants cannot bypass.
 *
 * The pattern library is intentionally terse. Extending it is follow-up
 * work (G9.1): pattern-set extensibility via policy is out of scope for
 * this patch. Phrases added here must be short, lowercase, and tolerate
 * the normalization pipeline (no Unicode, no non-ASCII punctuation).
 */
export const INJECTION_PHRASES: readonly string[] = [
  'ignore previous instructions',
  'disregard your',
  'your new instructions are',
  'system prompt override',
  'forget all previous',
  // 'you are now' is too broad — fires on "you are now connected", "you are now in /home/foo", etc.
  // The role-reassignment vector is "you are now a [different persona]" — the trailing space+article
  // is what distinguishes injection from ordinary status messages.
  'you are now a ',
  'you are now an ',
  // G9 follow-up: additional role-reassignment / persona-swap vectors.
  // Intentionally NARROW: broader phrases like "act as a" / "act as an"
  // were considered and dropped because at read-tier any literal hit
  // escalates to `likely_injection`, which would deny benign prose such
  // as "this proxy can act as a bridge" or "the service can act as an
  // intermediary." The phrases below all contain a direct second-person
  // address ("you") or an explicit roleplay framing ("roleplay as"),
  // which is rare in ordinary documentation/chat content.
  'pretend you are ',
  'roleplay as ',
];

/**
 * G9 follow-up — Unicode whitespace class covering the most common bypass
 * vectors for literal-phrase matchers: NBSP (U+00A0), OGHAM SPACE MARK
 * (U+1680), the EN/EM/THIN/HAIR space family (U+2000..U+200A), NARROW NBSP
 * (U+202F), MEDIUM MATHEMATICAL SPACE (U+205F), IDEOGRAPHIC SPACE (U+3000).
 * Collapsed to a single ASCII space before matching.
 */
const UNICODE_WHITESPACE_RE = /[\s\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g;

/**
 * G9 follow-up (Codex round-2, finding #1) — strip all Default_Ignorable_Code_Point
 * characters before matching. The Unicode property `Default_Ignorable_Code_Point`
 * covers every codepoint that is invisible and has no glyph in standard rendering:
 * soft hyphen (U+00AD), combining grapheme joiner (U+034F), Arabic letter mark
 * (U+061C), Mongolian vowel separator (U+180E), zero-width space/non-joiner/joiner
 * (U+200B–U+200D), word joiner (U+2060), invisible times/separator/plus
 * (U+2062–U+2064), BIDI isolation controls (U+2066–U+2069), variation selector-16
 * (U+FE0F), zero-width no-break space / BOM (U+FEFF), and others.
 *
 * Using `\p{Default_Ignorable_Code_Point}` (requires the `u` flag, Node 22+)
 * is future-proof: new Default_Ignorable codepoints added to Unicode are
 * automatically covered without updating this regex.
 */
const IGNORABLE_CP_RE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * G9 follow-up — normalize an input string to a canonical form for literal
 * phrase matching.
 *
 *   1. NFKC Unicode normalization — folds compatibility forms (fullwidth
 *      letters, mathematical alphanumerics) into ASCII equivalents.
 *   2. Strip all Default_Ignorable_Code_Point characters — invisible codepoints
 *      that have no rendering and are used only to visually split or obscure
 *      injection keywords (soft hyphen, zero-width joiners/non-joiners/spaces,
 *      BIDI isolation controls, variation selectors, BOM, etc.).
 *   3. Collapse any run of Unicode whitespace (including NBSP, en/em space)
 *      to a single ASCII space.
 *   4. Lowercase — matches the case-insensitive contract of INJECTION_PHRASES.
 *
 * NEVER logs or exports the normalized text; it is used only for match-time
 * comparison. The audit record still surfaces the PHRASE that matched, not
 * the normalized input.
 */
export function normalizeForMatch(input: string): string {
  return input
    .normalize('NFKC')
    .replace(IGNORABLE_CP_RE, '')
    .replace(UNICODE_WHITESPACE_RE, ' ')
    .toLowerCase();
}

/**
 * Base64-token scanner regex. The only regex the injection middleware runs
 * against untrusted payloads; wrapped in `SafeRegex` at middleware creation
 * time so a catastrophic input cannot hang the event loop. See G3
 * (`src/gateway/redact-safe/match-timeout.ts`).
 */
export const INJECTION_BASE64_PATTERN = /[A-Za-z0-9+/]{20,}={0,2}/g;

/**
 * Base64 shape-validation regex used by `tryDecodeBase64`. Shorter inputs are
 * rejected before we reach this test; the pattern itself is linear, so the
 * SafeRegex wrap is purely a defense-in-depth measure.
 */
export const INJECTION_BASE64_SHAPE = /^[A-Za-z0-9+/]+=*$/;

/**
 * Audit metadata key for injection-scan regex timeouts. Multiple timeouts in
 * one invocation append to an array under this key.
 */
export const INJECTION_TIMEOUT_METADATA_KEY = 'injection.regex_timeout';

/**
 * Audit metadata key for the classifier verdict. The value is an
 * `InjectionClassifierMetadata` object.
 */
export const INJECTION_METADATA_KEY = 'injection';

export interface InjectionTimeoutEvent {
  event: 'injection.regex_timeout';
  pattern_source: 'default';
  pattern_id: string;
  input_bytes: number;
  timeout_ms: number;
}

/**
 * G9 — classifier verdict written under `ctx.metadata.injection`. The audit
 * middleware exports `ctx.metadata` verbatim, so this object becomes the
 * permanent record of why a call was allowed, warned, or denied.
 *
 * `verdict` —
 *   `clean`: no match, no metadata is written (this type exists only to
 *     describe the internal return of `classifyInjection`).
 *   `suspicious`: exactly one literal match at write/destructive tier, no
 *     base64 escalation. Warn-only by default; deny when
 *     `policy.injection.suspicious_blocks_writes === true`.
 *   `likely_injection`: always deny. Triggered by any of:
 *     - ≥2 distinct literal pattern matches
 *     - any match found after base64 decoding
 *     - any match at read tier (read-tier is permissive by design — a hit
 *       there is anomalous)
 *     - an unknown/missing tier (fail-closed)
 *   `error` (G9 follow-up): scanner failure — at least one regex call
 *     exceeded its worker-bounded timeout. Treated as inconclusive; the
 *     call is NOT denied on this signal alone, but the metadata record
 *     carries a stable `verdict` field so downstream audit consumers do
 *     not receive a timeout event without a verdict shape.
 *
 * `matched_patterns` — the distinct phrase strings from `INJECTION_PHRASES`
 * that matched. Sorted for audit-log determinism. NEVER includes the input
 * text itself (no payload leakage). On `verdict: 'error'` this array may be
 * empty (the scan was abandoned).
 *
 * `base64_decoded` — true iff at least one match was found in content that
 * was base64-decoded before matching. On `verdict: 'error'` this field
 * reports whether any base64-decoded match was observed BEFORE the timeout.
 */
export interface InjectionClassifierMetadata {
  verdict: 'suspicious' | 'likely_injection' | 'error';
  matched_patterns: string[];
  base64_decoded: boolean;
}

/**
 * G9 follow-up — zod schema for the `ctx.metadata.injection` record the
 * middleware emits. Every emitted record has a `verdict` field; the schema
 * exists so internal test code (and a follow-up public surface, once we
 * decide how to expose audit-record types) can catch shape regressions —
 * notably the pre-fix behavior where a regex-timeout emitted timing
 * metadata under a different key without ever writing a verdict.
 *
 * INTERNAL today. Not reachable via the published package `exports` map
 * (only `.`, `./policy`, `./middleware`, and `./audit` are public). If
 * downstream consumers (e.g. Helix) need to validate audit records they
 * read off `.rea/audit.jsonl`, we will promote this to a public entrypoint
 * in a follow-up (filed as G9.2). Do not rely on this symbol from outside
 * the rea repo yet.
 */
export const InjectionMetadataSchema = z
  .object({
    verdict: z.enum(['suspicious', 'likely_injection', 'error']),
    matched_patterns: z.array(z.string()),
    base64_decoded: z.boolean(),
  })
  .strict();

interface CompiledInjectionPatterns {
  base64Token: SafeRegex;
  base64Shape: SafeRegex;
}

/**
 * G9 — scan result split by match origin so the classifier can distinguish
 * a single-literal hit (potentially `suspicious`) from a base64-decoded hit
 * (always `likely_injection`). The Sets deduplicate by phrase; same phrase
 * matched twice counts as one distinct pattern.
 */
export interface InjectionScanResult {
  literalMatches: Set<string>;
  base64DecodedMatches: Set<string>;
}

/**
 * Decode a base64 string, returning the decoded text or null if decoding fails.
 * Only decodes if the input looks like base64 (64-char alphabet, length divisible by 4 or padded).
 */
function tryDecodeBase64(input: string, safe: CompiledInjectionPatterns): string | null {
  // Quick heuristic: must be at least 20 chars and use only base64 chars
  if (input.length < 20) return null;
  const shape = safe.base64Shape.test(input);
  if (shape.timedOut || !shape.matched) return null;
  try {
    return Buffer.from(input, 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Minimum token length considered for standalone base64 probing via
 * `decodeBase64Strings`. Below this, the decoded payload is too short to
 * plausibly contain an injection phrase (the shortest phrase in
 * `INJECTION_PHRASES` is 16 chars; 24 base64 chars → 18 decoded chars, with
 * some slack for leading/trailing noise).
 */
const MIN_BASE64_PROBE_LENGTH = 24;

/**
 * G9 — printable-ASCII ratio threshold for accepting a base64 decode as a
 * potential injection payload. The spec requires ≥95% printable characters
 * and no null bytes; stricter than the inline decoder used by
 * `scanForInjection` (which accepts any successful UTF-8 decode) because this
 * probe is used to FORCE-escalate to `likely_injection`, and we want the
 * probe's positive signal to be near-certain.
 */
const BASE64_PRINTABLE_RATIO = 0.95;

/**
 * Return true when `s` is printable-enough to plausibly be an injection
 * payload. Printable = ASCII 0x20..0x7E, plus tab/newline/CR. Null bytes
 * (often used for payload truncation games) disqualify the string outright.
 */
function isPrintableDecoded(s: string): boolean {
  if (s.length === 0) return false;
  let printable = 0;
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code === 0) return false; // null byte → fail closed
    if (
      (code >= 0x20 && code <= 0x7e) ||
      code === 0x09 /* tab */ ||
      code === 0x0a /* LF */ ||
      code === 0x0d /* CR */
    ) {
      printable++;
    }
  }
  return printable / s.length >= BASE64_PRINTABLE_RATIO;
}

/**
 * G9 — pure helper that walks an arbitrary `unknown` value and returns every
 * successfully decoded base64-looking string. Decoding is attempted only for
 * strings that:
 *   - are ≥ `MIN_BASE64_PROBE_LENGTH` (24) chars
 *   - have length divisible by 4 (base64 framing)
 *   - match the `INJECTION_BASE64_SHAPE` (`^[A-Za-z0-9+/]+=*$`)
 *   - decode to a UTF-8 string that is ≥95% printable and contains no null bytes
 *
 * This is a separate entry point from the inline base64 probe in
 * `scanForInjection`: the inline path scans tokens extracted from within
 * strings (via `INJECTION_BASE64_PATTERN`, which finds embedded base64
 * fragments), while `decodeBase64Strings` is a whole-string probe used by
 * the classifier as a second-opinion signal.
 */
export function decodeBase64Strings(input: unknown): string[] {
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      if (v.length < MIN_BASE64_PROBE_LENGTH) return;
      if (v.length % 4 !== 0) return;
      if (!INJECTION_BASE64_SHAPE.test(v)) return;
      let decoded: string;
      try {
        decoded = Buffer.from(v, 'base64').toString('utf8');
      } catch {
        return;
      }
      if (!isPrintableDecoded(decoded)) return;
      out.push(decoded);
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (v !== null && typeof v === 'object') {
      for (const val of Object.values(v as Record<string, unknown>)) visit(val);
    }
  };
  visit(input);
  return out;
}

export interface ScanForInjectionOptions {
  onTimeout?: (patternId: string, input: string) => void;
}

/**
 * Build compiled injection patterns with the provided timeout. Precompiled at
 * middleware creation so the worker spawn is the only per-call overhead.
 */
export function compileInjectionPatterns(
  timeoutMs: number,
  onTimeout?: (patternId: string, input: string) => void,
): CompiledInjectionPatterns {
  return {
    base64Token: wrapRegex(INJECTION_BASE64_PATTERN, {
      timeoutMs,
      ...(onTimeout
        ? { onTimeout: (_p, i) => onTimeout('INJECTION_BASE64_PATTERN', i) }
        : {}),
    }),
    base64Shape: wrapRegex(INJECTION_BASE64_SHAPE, {
      timeoutMs,
      ...(onTimeout
        ? { onTimeout: (_p, i) => onTimeout('INJECTION_BASE64_SHAPE', i) }
        : {}),
    }),
  };
}

/**
 * Scan a single string and record hits into the provided `InjectionScanResult`
 * buckets. Exported for test surface and for callers who want to scan a known
 * string without walking a tree.
 *
 * - Literal matches (case-insensitive substring) go into `literalMatches`.
 * - Base64-decoded matches (tokens extracted via `INJECTION_BASE64_PATTERN`,
 *   decoded, then re-scanned for literals) go into `base64DecodedMatches`.
 *
 * Set semantics dedupe by phrase: the same phrase matched five times in one
 * string counts as one distinct pattern, which is intentional for the
 * classifier's "≥2 distinct patterns → likely" rule.
 */
export function scanStringForInjection(
  input: string,
  result: InjectionScanResult,
  safe: CompiledInjectionPatterns,
): void {
  if (!input || typeof input !== 'string') return;

  // G9 follow-up: normalize before matching so NBSP / zero-width / fullwidth
  // variants of injection phrases cannot bypass the literal check. The raw
  // input is still scanned by the base64 tokenizer (SafeRegex expects the
  // pre-normalization bytes).
  const normalized = normalizeForMatch(input);

  // Literal phrases (indexOf — no regex, no ReDoS surface).
  for (const phrase of INJECTION_PHRASES) {
    if (normalized.includes(phrase)) {
      result.literalMatches.add(phrase);
    }
  }

  // Embedded base64 tokens. SafeRegex wraps the scan so a pathological input
  // cannot hang the event loop.
  const tokenResult = safe.base64Token.matchAll(input);
  const base64Tokens = tokenResult.matches;
  for (const token of base64Tokens) {
    const decoded = tryDecodeBase64(token, safe);
    if (!decoded) continue;
    const decodedNormalized = normalizeForMatch(decoded);
    for (const phrase of INJECTION_PHRASES) {
      if (decodedNormalized.includes(phrase)) {
        result.base64DecodedMatches.add(phrase);
      }
    }
  }
}

/**
 * Back-compat wrapper: legacy callers (and the old audit-metadata consumer)
 * received a flat `string[]` of "literal: …" / "base64-encoded: …" descriptions.
 * Kept as an exported helper so `scripts/lint-safe-regex.mjs` and any external
 * consumer that imported it continue to work. New code should call
 * `scanStringForInjection` directly.
 */
export function scanForInjection(
  input: string,
  safe: CompiledInjectionPatterns,
): string[] {
  const result: InjectionScanResult = {
    literalMatches: new Set(),
    base64DecodedMatches: new Set(),
  };
  scanStringForInjection(input, result, safe);
  const out: string[] = [];
  for (const p of result.literalMatches) out.push(`literal: "${p}"`);
  for (const p of result.base64DecodedMatches) out.push(`base64-encoded: "${p}"`);
  return out;
}

/**
 * Recursively scan an unknown value (string, array, or plain object) and
 * accumulate matches into the supplied `InjectionScanResult` buckets.
 */
export function scanValueForInjection(
  value: unknown,
  result: InjectionScanResult,
  safe: CompiledInjectionPatterns,
): void {
  if (typeof value === 'string') {
    scanStringForInjection(value, result, safe);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) scanValueForInjection(item, result, safe);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      scanValueForInjection(v, result, safe);
    }
  }
}

/**
 * G9 — classify a scan result into `clean` / `suspicious` / `likely_injection`
 * using the tier and the distinctness of literal matches.
 *
 * Decision table (first match wins):
 *
 *   1. No literal AND no base64-decoded matches
 *      → { verdict: 'clean' }
 *   2. Any base64-decoded match (regardless of count/tier)
 *      → { verdict: 'likely_injection', base64_decoded: true }
 *   3. ≥2 distinct literal matches
 *      → { verdict: 'likely_injection' }
 *   4. Tier is Read (or undefined — fail closed)
 *      → { verdict: 'likely_injection' }
 *   5. Exactly 1 literal match at Write/Destructive
 *      → { verdict: 'suspicious' }
 *
 * Extension point: a future "deny-tag" per-pattern metadata layer can force
 * any match to `likely_injection`. Not wired in this PR — TODO below.
 */
export type InjectionClassification =
  | { verdict: 'clean' }
  | InjectionClassifierMetadata;

export function classifyInjection(
  scan: InjectionScanResult,
  tier: Tier | undefined,
): InjectionClassification {
  const literalCount = scan.literalMatches.size;
  const base64Count = scan.base64DecodedMatches.size;

  if (literalCount === 0 && base64Count === 0) {
    return { verdict: 'clean' };
  }

  // Dedupe: a phrase that appears both literally AND in a base64-decoded
  // payload in the same input counts once in `matched_patterns`. Union via
  // Set before sorting.
  const matched = [
    ...new Set([...scan.literalMatches, ...scan.base64DecodedMatches]),
  ].sort();

  // Rule 2 — base64 always escalates, regardless of count or tier.
  if (base64Count > 0) {
    return {
      verdict: 'likely_injection',
      matched_patterns: matched,
      base64_decoded: true,
    };
  }

  // Rule 3 — multi-literal (distinct patterns) always escalates.
  if (literalCount >= 2) {
    return {
      verdict: 'likely_injection',
      matched_patterns: matched,
      base64_decoded: false,
    };
  }

  // Rule 4 — any match at read-tier, or unknown tier, is anomalous enough
  // to treat as likely. Tier middleware runs before injection middleware,
  // so an undefined tier here means tier-classification failed; fail closed.
  if (tier === Tier.Read || tier === undefined) {
    return {
      verdict: 'likely_injection',
      matched_patterns: matched,
      base64_decoded: false,
    };
  }

  // TODO (G9-follow-up): per-pattern "deny-tag" metadata can force this
  // branch to `likely_injection` even for a single literal at write tier.
  // Not shipped in this PR; pattern list is unchanged.

  // Rule 5 — exactly 1 literal at write/destructive.
  return {
    verdict: 'suspicious',
    matched_patterns: matched,
    base64_decoded: false,
  };
}

export type InjectionAction = 'block' | 'warn';

export interface InjectionMiddlewareOptions {
  /** Timeout budget for each regex call. Default 100ms. */
  matchTimeoutMs?: number;
  /**
   * G9 — governs whether `suspicious` classifications at write/destructive
   * tier deny. `likely_injection` is ALWAYS deny regardless of this flag.
   *
   * Interpreted by `createInjectionMiddleware` with the `action` parameter:
   *
   *   - `action: 'warn'` (legacy `injection_detection: warn`): this flag is
   *     IGNORED. Suspicious stays warn-only, 0.2.x parity. Operators who
   *     pinned warn mode never get a suspicious-deny, even if a profile
   *     layer flipped the flag to `true`.
   *   - `action: 'block'` + flag `true`: suspicious denies.
   *   - `action: 'block'` + flag `false`: suspicious warns only (explicit
   *     opt-out). Non-bst consumers who want the looser posture must ask
   *     for it.
   *   - `action: 'block'` + flag `undefined` (UNSET): defaults to `true`,
   *     restoring 0.2.x `injection_detection: block` parity for consumers
   *     who omit the `injection:` policy block entirely. This was the
   *     Codex-reported regression in PR #25 — non-bst consumers got
   *     silently looser behavior on upgrade.
   *
   * Wired from `policy.injection.suspicious_blocks_writes` by the gateway.
   * When the policy omits the `injection:` block, the field is `undefined`
   * (the loader schema no longer applies a default) so this middleware can
   * distinguish "not configured" from "explicitly false".
   */
  suspiciousBlocksWrites?: boolean;
}

/**
 * Record a regex-timeout event on `ctx.metadata`. Array-valued so multiple
 * timeouts in one invocation are all recorded.
 *
 * SECURITY: The input text is NEVER written into metadata — only `input_bytes`.
 */
function recordInjectionTimeout(
  ctx: InvocationContext,
  patternId: string,
  inputBytes: number,
  timeoutMs: number,
): void {
  const ev: InjectionTimeoutEvent = {
    event: 'injection.regex_timeout',
    pattern_source: 'default',
    pattern_id: patternId,
    input_bytes: inputBytes,
    timeout_ms: timeoutMs,
  };
  const existing = ctx.metadata[INJECTION_TIMEOUT_METADATA_KEY];
  if (Array.isArray(existing)) {
    existing.push(ev);
  } else {
    ctx.metadata[INJECTION_TIMEOUT_METADATA_KEY] = [ev];
  }
}

/**
 * PostToolUse middleware: classifies tool results for prompt injection.
 *
 * G9 tiered classifier:
 *   - `clean` → allow, no log
 *   - `suspicious` → warn (stderr + audit metadata `injection.suspicious`).
 *     Denies only when `suspiciousBlocksWrites: true`.
 *   - `likely_injection` → always deny, always log.
 *
 * Operates on tool output (ctx.result) returned from downstream MCP servers.
 *
 * SECURITY: Checking PostToolUse (after downstream execution, before the
 * result reaches the LLM) is the correct place to catch injection in tool
 * descriptions and resource content coming from potentially untrusted
 * downstream servers.
 *
 * SECURITY (G3): The only regexes this middleware runs are wrapped in
 * `SafeRegex` with a 100ms default per-call timeout. On timeout the scanner
 * records an audit event and proceeds — blocking is governed by the literal
 * substring checks (which have no ReDoS surface).
 *
 * The legacy `action` parameter (`'block' | 'warn'`) selects the fallback
 * behavior for `suspicious` verdicts when the G9 flag is unset — preserving
 * 0.2.x `injection_detection: 'warn'` semantics for operators who pinned it.
 * `likely_injection` ignores this parameter.
 */
export function createInjectionMiddleware(
  action: InjectionAction = 'block',
  opts: InjectionMiddlewareOptions = {},
): Middleware {
  const timeoutMs = opts.matchTimeoutMs ?? 100;
  // G9 follow-up (Codex round-1, finding #1): when `action === 'block'` and
  // `suspicious_blocks_writes` is unset, default to `true` (strict, matches
  // 0.2.x). The pre-patch default of `false` silently loosened upgraded
  // consumers who had `injection_detection: block` pinned — a security
  // regression masquerading as a refinement.
  //
  // Non-bst consumers who want the looser warn-only behavior MUST now opt
  // out explicitly by setting `injection.suspicious_blocks_writes: false`.
  // Operators who pinned `injection_detection: warn` still get warn-only by
  // default (0.2.x warn parity), regardless of this flag.
  const denyOnSuspicious =
    action === 'warn'
      ? false // warn mode hard-overrides suspicious deny — 0.2.x parity with `injection_detection: warn`
      : (opts.suspiciousBlocksWrites ?? true); // block mode: default true (0.2.x parity)

  return async (ctx, next) => {
    await next();

    // Only scan if we have a result to inspect
    if (ctx.result == null) return;

    // G9 follow-up (finding #4): track scanner timeout via a closure flag so
    // we can emit a stable `verdict: 'error'` metadata record alongside the
    // existing `injection.regex_timeout` event. Downstream audit consumers
    // that key off `metadata.injection.verdict` no longer see a bare timing
    // record with no verdict shape.
    let scanTimedOut = false;
    const safe = compileInjectionPatterns(timeoutMs, (patternId, input) => {
      scanTimedOut = true;
      recordInjectionTimeout(ctx, patternId, Buffer.byteLength(input, 'utf8'), timeoutMs);
    });

    const scan: InjectionScanResult = {
      literalMatches: new Set(),
      base64DecodedMatches: new Set(),
    };
    scanValueForInjection(ctx.result, scan, safe);

    // G9 follow-up (finding #3): second-opinion base64 probe. The inline
    // probe in `scanStringForInjection` scans tokens extracted from WITHIN
    // strings. `decodeBase64Strings` is a stricter whole-string probe
    // (length%4==0, ≥95% printable, no null bytes) that walks the whole
    // result tree. Pre-patch, this helper was exported but never called —
    // the G9 changeset advertised a probe that did not exist in the
    // execution path. Any phrase detected in a decoded whole-string payload
    // is merged into `base64DecodedMatches`, so classification rule #2
    // (any base64 match → `likely_injection`) fires.
    const base64Decoded = decodeBase64Strings(ctx.result);
    for (const decoded of base64Decoded) {
      const normalized = normalizeForMatch(decoded);
      for (const phrase of INJECTION_PHRASES) {
        if (normalized.includes(phrase)) {
          scan.base64DecodedMatches.add(phrase);
        }
      }
    }

    const classification = classifyInjection(scan, ctx.tier);

    // G9 follow-up (finding #4 + Codex round-2 finding #2): on scanner
    // timeout, the behavior depends on the configured action:
    //
    //   block mode: fail-closed — a timeout under block policy means we
    //     cannot verify the payload is clean, so we DENY. The attacker who
    //     crafted a payload that defeats the timeout budget must not get a
    //     free pass. ctx.status is set to Denied and we return without
    //     calling next().
    //
    //   warn/log mode: fail-open — emit a verdict:'error' metadata record
    //     alongside the existing injection.regex_timeout event so downstream
    //     audit consumers see a stable verdict shape, then allow through.
    //
    // In both cases the audit record and stderr warning are written first.
    // Real matches observed before the timeout fired classify normally via
    // the branches below — this branch only fires when classification is
    // 'clean' (no actionable signal was collected before the timeout).
    if (classification.verdict === 'clean' && scanTimedOut) {
      const errorMeta: InjectionClassifierMetadata = {
        verdict: 'error',
        matched_patterns: [],
        base64_decoded: false,
      };
      ctx.metadata[INJECTION_METADATA_KEY] = errorMeta;
      process.stderr.write(
        `[rea] INJECTION-GUARD (error): regex-timeout during scan of tool "${ctx.tool_name}" result; verdict inconclusive\n`,
      );
      if (action === 'block') {
        ctx.status = InvocationStatus.Denied;
        ctx.error =
          'injection scan timed out — failing closed under block policy';
        return; // do NOT call next()
      }
      // warn/log mode: let through but record — verdict:'error' is written above.
      return;
    }

    if (classification.verdict === 'clean') return;

    // Write audit metadata. Export verdict + distinct matched phrases +
    // base64 flag. NEVER export the input text.
    const auditMeta: InjectionClassifierMetadata = {
      verdict: classification.verdict,
      matched_patterns: classification.matched_patterns,
      base64_decoded: classification.base64_decoded,
    };
    ctx.metadata[INJECTION_METADATA_KEY] = auditMeta;

    // Always emit a stderr warning. Operators rely on this as the live signal.
    process.stderr.write(
      `[rea] INJECTION-GUARD (${classification.verdict}): pattern(s) detected in tool "${ctx.tool_name}" result\n`,
    );
    for (const p of classification.matched_patterns) {
      process.stderr.write(`  Pattern: ${p}\n`);
    }
    if (classification.base64_decoded) {
      process.stderr.write(`  Base64-decoded match detected\n`);
    }
    process.stderr.write(
      `  Action: review the downstream server "${ctx.server_name}" for compromise.\n`,
    );

    // Deny policy:
    //   likely_injection → always deny
    //   suspicious       → deny iff denyOnSuspicious (constructed above)
    const shouldDeny =
      classification.verdict === 'likely_injection' ||
      (classification.verdict === 'suspicious' && denyOnSuspicious);

    if (shouldDeny) {
      ctx.status = InvocationStatus.Denied;
      ctx.error =
        classification.verdict === 'likely_injection'
          ? `Likely prompt injection detected in tool result (${classification.matched_patterns.length} pattern(s), base64=${classification.base64_decoded}). Result blocked.`
          : `Suspicious prompt injection pattern in tool result (1 pattern at ${String(ctx.tier)} tier). Result blocked by policy.`;
      ctx.result = undefined;
    }
  };
}
