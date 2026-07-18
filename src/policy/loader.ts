import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import safeRegex from 'safe-regex';
import { AutonomyLevel } from './types.js';
import type { Policy } from './types.js';

const LEVEL_ORDER: Record<AutonomyLevel, number> = {
  [AutonomyLevel.L0]: 0,
  [AutonomyLevel.L1]: 1,
  [AutonomyLevel.L2]: 2,
  [AutonomyLevel.L3]: 3,
};

const ContextProtectionSchema = z.object({
  delegate_to_subagent: z.array(z.string()).default([]),
  max_bash_output_lines: z.number().int().positive().optional(),
});

/**
 * 0.50.x — per-path provider override entry. Gitignore-style globs + a
 * lane. Strict so a typo (`path`, `providr`) fails loud.
 */
const ReviewPathOverrideSchema = z
  .object({
    paths: z.array(z.string().min(1)).min(1),
    // Round-14: DOWNGRADE targets only. `'openrouter'` removed — per-path
    // upgrade is incoherent for a whole-diff review (was a silent no-op).
    provider: z.enum(['codex', 'refuse']),
  })
  .strict();

/**
 * 0.50.x — OpenRouter (`gpt-oss-120b`) provider config. Strict-validated.
 *
 * Security-relevant constraints baked into the schema:
 *   - `model`: safe character class; a `:free` suffix is rejected by a
 *     separate runtime guard (`checkOpenRouterModel`) with a loud message
 *     — the `:free` endpoint trains on prompts and is NOT wired.
 *   - `base_url`: HTTPS-pinned AND host-pinned at the schema layer — only
 *     `openrouter.ai` (or a subdomain) over TLS. The ONLY plaintext exception
 *     is an http LOOPBACK address (127.0.0.0/8 with valid 0-255 octets, `[::1]`,
 *     or exactly `localhost`, optional 1-65535 port) — loopback http never
 *     leaves the machine, so it carries no exfiltration risk. The cross-repo
 *     smoke harness drives the REAL shipped transport against a
 *     `http://127.0.0.1:<port>` localhost responder via this exception. Any
 *     other https host (`https://evil.example`), non-loopback http (public host,
 *     LAN IP, `*.evil.com` suffix), or out-of-range octet/port is rejected.
 *   - `data_policy`: only `'deny-training'` — the always-on safe default.
 *   - `backend_pin`: a safe identifier class per entry.
 */
const OpenRouterProviderPolicySchema = z
  .object({
    model: z
      .string()
      .regex(/^[a-zA-Z0-9._/:-]{1,128}$/)
      .optional(),
    // HTTPS-pinned for the production lane. The ONLY plaintext exception is an
    // http LOOPBACK address — the IPv4 loopback block 127.0.0.0/8 (any
    // 127.x.x.x), the IPv6 loopback `[::1]`, or the `localhost` name — used by
    // the cross-repo smoke harness's local fixture responder and by an operator
    // running a local proxy. Loopback http never leaves the machine, so it
    // carries no exfiltration risk. ANY non-loopback http (a public host, a LAN
    // IP, 0.0.0.0, a hostname that is not exactly `localhost`) is REJECTED — the
    // host alternation is anchored so `127.0.0.1.evil.com` / `localhost.evil.com`
    // cannot slip through.
    // The HTTPS host is PINNED to `openrouter.ai` (or a subdomain) — codex
    // round-4 P1: an unconstrained `https://[^\s]+` let a config point the lane
    // at `https://evil.example/api/v1`, which would receive the full diff +
    // commit log and pass policy load. The security contract (THREAT_MODEL
    // §5.26) is "openrouter.ai over TLS, plus a NARROW http-loopback test/proxy
    // exception" — nothing else. The host alternation `(?:[a-z0-9-]+\.)*
    // openrouter\.ai` is anchored so `openrouter.ai.evil.com` and
    // `evilopenrouter.ai` are rejected.
    //
    // codex round-3 P2: the loopback exception bounds octet VALUE (0-255) and
    // port RANGE (1-65535), not just digit count — otherwise `127.256.0.1` or
    // `:65536` pass load and fail only at `fetch`. Octet =
    // `25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d`; port = `6553[0-5]|655[0-2]\d|
    // 65[0-4]\d{2}|6[0-4]\d{3}|[1-5]\d{4}|[1-9]\d{0,3}` (1-65535, no `:0`). Each
    // alternation is fixed-width-anchored → linear, no catastrophic backtracking.
    base_url: z
      .string()
      .regex(
        /^(?:https:\/\/(?:[a-z0-9-]+\.)*openrouter\.ai(?::(?:6553[0-5]|655[0-2]\d|65[0-4]\d{2}|6[0-4]\d{3}|[1-5]\d{4}|[1-9]\d{0,3}))?(?:\/[^\s]{0,500})?|http:\/\/(?:127\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)|localhost|\[::1\])(?::(?:6553[0-5]|655[0-2]\d|65[0-4]\d{2}|6[0-4]\d{3}|[1-5]\d{4}|[1-9]\d{0,3}))?(?:\/[^\s]{0,500})?)$/,
      )
      .optional(),
    data_policy: z.enum(['deny-training']).optional(),
    backend_pin: z
      .array(z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/))
      .optional(),
    timeout_ms: z.number().int().positive().optional(),
    max_diff_bytes: z.number().int().positive().optional(),
    path_overrides: z.array(ReviewPathOverrideSchema).optional(),
    // 0.50.x — commit-aware review granularity. `'auto'` (default) sends the
    // whole diff when it fits the context budget and splits per-commit
    // otherwise; `'per-commit'` always splits; `'whole'` never splits. The
    // path-guard runs once on the whole diff regardless — granularity only
    // shapes what is SENT post-approval. See OpenRouterProviderPolicy.
    review_granularity: z.enum(['auto', 'per-commit', 'whole']).optional(),
  })
  .strict();

/**
 * 0.50.x — `policy.review.providers`. Strict so a typo in the provider
 * name (`openrouters`, `open_router`) fails loud at load.
 */
const ReviewProvidersPolicySchema = z
  .object({
    openrouter: OpenRouterProviderPolicySchema.optional(),
  })
  .strict();

/**
 * 0.11.0 push-gate review policy. Three knobs only — the stateless gate does
 * not have a cache and does not treat CI differently. Strict mode so typos
 * (`codex_require`, `concerns_block`) fail loudly rather than silently
 * defaulting. `rea upgrade` strips the removed 0.10.x fields
 * (`cache_max_age_seconds`, `allow_skip_in_ci`) from consumer policy files.
 */
const ReviewPolicySchema = z
  .object({
    codex_required: z.boolean().optional(),
    concerns_blocks: z.boolean().optional(),
    timeout_ms: z.number().int().positive().optional(),
    last_n_commits: z.number().int().positive().optional(),
    /**
     * Auto-narrow threshold (J / 0.13.0). When the resolved diff base is more
     * than N commits away from HEAD, the gate auto-scopes to
     * `last_n_commits` (or the 0.13 fallback default of 10) and emits a
     * stderr warning. Default 30 when unset; explicit 0 disables auto-narrow
     * entirely. Suppressed when the operator pinned `--last-n-commits`,
     * `--base`, or `policy.review.last_n_commits` (those are explicit
     * intent and auto-narrow stays out of the way).
     */
    auto_narrow_threshold: z.number().int().nonnegative().optional(),
    /**
     * Codex CLI model override (0.13.4+; runtime-default since 0.18.0).
     * Pinned via `-c model="<name>"` on every `codex exec review`
     * invocation. **0.52.0 model LADDER default**: when unset, the runtime
     * walks `IRON_GATE_MODEL_LADDER` (gpt-5.5 → gpt-5.4) newest-first,
     * falling to the next entry when the account lacks the newest flagship
     * — so installs ride the latest codex automatically instead of going
     * stale on a hardcode. codex's own default (`codex-auto-review` at
     * medium) is still unreachable through the rea push-gate. Setting this
     * key explicitly is AUTHORITATIVE: no ladder substitution — an
     * unsupported explicit pin fails loudly (never a silent pass; see
     * CodexModelUnsupportedError). config.toml is consulted ONLY when the
     * explicit value passed by rea is `undefined`, which the runtime never
     * does.
     *
     * RECOMMENDATION: leave this UNSET and ride the ladder. Pin only for
     * cost-bounded environments or when a specific model is required for
     * verdict reproducibility. Higher reasoning trades push-gate latency
     * for finding consistency — fewer same-code-different-verdict
     * round-trips like the 2026-04-26 helixir migration session.
     *
     * Loose string type: codex's model catalog evolves over time and we do
     * NOT want to lock consumers to a hardcoded enum that drifts behind
     * upstream. Codex itself validates the model name at exec time.
     */
    // 0.19.0 security review M4: restrict to a safe character class so
    // a typo or malicious value can't smuggle TOML control characters
    // (NUL, NL, CR, escape sequences) through the `-c model="<value>"`
    // injection point. Accepts published codex model names; rejects
    // re-quote / TOML-escape edge cases.
    codex_model: z
      .string()
      .regex(/^[a-zA-Z0-9._-]{1,64}$/)
      .optional(),
    /**
     * Codex reasoning effort knob (0.13.4+). Pinned via
     * `-c model_reasoning_effort="<level>"` on every invocation. Only
     * meaningful when paired with a reasoning-capable model (gpt-5.5,
     * gpt-5.4, etc.). The `codex-auto-review` model honors this but caps
     * lower than the flagships.
     *
     * Recommended: `high` for serious review on long-running branches
     * (more compute spent per finding, fewer flips). `medium` is codex's
     * own default. `low` for cost-bounded environments where consistency
     * matters less than throughput.
     */
    codex_reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
    /**
     * Verdict cache TTL in milliseconds (0.18.1+ helixir #1, #4, #7, #8).
     * Default 86_400_000 (24 hours). When a push of `head_sha` produces
     * a non-blocking verdict, the result is written to
     * `.rea/last-review.cache.json`. Subsequent pushes of the same SHA
     * within the TTL skip the codex invocation and reuse the cached
     * verdict. Set to 0 to disable caching (every push re-invokes codex).
     */
    cache_ttl_ms: z.number().int().nonnegative().optional(),
    /**
     * 0.28.0 helix-029 — path-scoped finding filter. Gitignore-style
     * globs; findings whose `file` matches any are filtered out before
     * verdict computation. Enables `auto_exclude_managed: true` by
     * default; pass `auto_exclude_managed: false` explicitly to opt out.
     */
    exclude_paths: z.array(z.string().min(1)).optional(),
    /**
     * 0.28.0 helix-029 — derived default. Defaults to true when
     * `exclude_paths` is set, false when `exclude_paths` is unset.
     */
    auto_exclude_managed: z.boolean().optional(),
    /**
     * 0.26.0 local-first enforcement. Strict so a typo in the off-switch
     * surface (`mode: of`, `refuse_at: pushh`) fails policy load instead
     * of silently disabling. `bypass_env_var` is constrained to the
     * shell-safe identifier alphabet so a nonsense value can't smuggle
     * shell metacharacters through the Bash-tier gate that reads it.
     */
    local_review: z
      .object({
        mode: z.enum(['enforced', 'off']).optional(),
        max_age_seconds: z.number().int().positive().optional(),
        refuse_at: z.enum(['push', 'commit', 'both']).optional(),
        bypass_env_var: z
          .string()
          .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
          .optional(),
      })
      .strict()
      .optional(),
    /**
     * 0.50.x — review provider selector. NO `.default` — the consumer
     * resolves `provider ?? 'codex'` so absence stays distinguishable
     * from an explicit value (a default here would make a 0.49 policy
     * round-trip as `provider: 'codex'` instead of omitting the key).
     */
    provider: z.enum(['codex', 'openrouter', 'both']).optional(),
    /** 0.50.x — per-provider config. Today only `openrouter` is wired. */
    providers: ReviewProvidersPolicySchema.optional(),
  })
  .strict();

/**
 * 0.26.0 commit hygiene refusal thresholds. Top-level policy block (NOT
 * under `review`) — it's a process-discipline knob, not a review knob.
 * `rea preflight` reads it; the push-gate ignores it.
 */
const CommitHygienePolicySchema = z
  .object({
    warn_at_commits: z.number().int().nonnegative().optional(),
    refuse_at_commits: z.number().int().nonnegative().optional(),
  })
  .strict();

/**
 * G3: user-supplied redaction pattern. `name` is audit-stable; `regex` is a
 * raw pattern source (no leading/trailing slashes); `flags` follows JS
 * RegExp flag semantics. Every pattern is passed through `safe-regex` at
 * load time — a flagged pattern rejects the entire policy load with an
 * error that names the offender.
 */
const UserRedactPatternSchema = z
  .object({
    name: z.string().min(1),
    regex: z.string().min(1),
    flags: z.string().optional(),
  })
  .strict();

const RedactPolicySchema = z
  .object({
    match_timeout_ms: z.number().int().positive().optional(),
    patterns: z.array(UserRedactPatternSchema).optional(),
  })
  .strict();

/**
 * G1: audit rotation thresholds. Both knobs optional; a policy that omits the
 * `audit` block (or the `audit.rotation` sub-block) retains 0.2.x behavior
 * with no rotation. Defaults are NOT baked into the schema — the rotator
 * resolves them at consumption time so absence remains distinguishable from
 * an explicit value.
 */
const AuditRotationPolicySchema = z
  .object({
    max_bytes: z.number().int().positive().optional(),
    max_age_days: z.number().int().positive().optional(),
  })
  .strict();

const AuditPolicySchema = z
  .object({
    rotation: AuditRotationPolicySchema.optional(),
  })
  .strict();

/**
 * G9: injection tier escalation. `suspicious_blocks_writes` is fully
 * optional at the schema layer — absence is distinguishable from an
 * explicit `false`. The middleware (`createInjectionMiddleware`) then
 * applies the action-aware default:
 *
 *   - `injection_detection: block` (default) + flag unset  → `true`
 *     (0.2.x parity — a single literal match at write/destructive tier
 *     still denies for upgraded consumers who omit the `injection:` block)
 *   - `injection_detection: block` + flag explicit `false` → `false`
 *     (explicit opt-out)
 *   - `injection_detection: warn`  + flag unset or `false` → `false`
 *     (warn mode preserves 0.2.x warn-only semantics)
 *   - flag explicit `true` (pinned in `bst-internal*`)      → `true`
 *
 * This avoids the Codex-reported regression in PR #25 where the schema
 * default of `false` silently loosened `injection_detection: block`
 * behavior on upgrade for non-bst consumers.
 *
 * `likely_injection` verdicts (multi-literal matches, base64-decoded matches,
 * or any read-tier match) are ALWAYS deny regardless of this flag.
 */
const InjectionPolicySchema = z
  .object({
    suspicious_blocks_writes: z.boolean().optional(),
  })
  .strict();

/**
 * BUG-011 (0.6.2) — gateway-level policy. Currently only the `health`
 * sub-block is defined; kept strict so typos (`gateway.heath`) fail loudly.
 */
const GatewayHealthPolicySchema = z
  .object({
    expose_diagnostics: z.boolean().optional(),
  })
  .strict();

const GatewayPolicySchema = z
  .object({
    health: GatewayHealthPolicySchema.optional(),
  })
  .strict();

/**
 * 0.30.0 — attribution augmenter policy. The husky `prepare-commit-msg`
 * hook appends a `Co-Authored-By: <name> <email>` trailer to every commit
 * when `co_author.enabled: true`. Idempotent (skip if the email already
 * appears on a `Co-Authored-By:` line, case-insensitive); skips merge
 * commits when `skip_merge: true`.
 *
 * Cross-field refinement: when `enabled: true`, BOTH `name` AND `email`
 * MUST be non-empty. Fail-closed at policy load — pre-fix a partial
 * config (`enabled: true` with empty `email`) would silently fail at
 * hook fire time, producing zero-name trailers and confusing audit
 * records. Loud failure at load surfaces the misconfiguration immediately.
 *
 * Email validation is permissive (`<local>@<host>.<tld>` shape) — codex
 * + claude + github noreply emails all pass; the only reject case is a
 * malformed string (spaces, angle brackets, missing `@` or domain dot).
 * Stricter validation is the consumer's job — RFC 5322 is too permissive
 * for an opt-in audit footprint anyway.
 */
// 0.30.1 round-5 P2: the `name` value lands verbatim inside a
// `Co-Authored-By: <name> <email>` git trailer. A newline or carriage
// return in `name` would split the trailer across lines — git's
// `interpret-trailers` would drop the continuation and the augmenter
// could even inject arbitrary extra trailer lines. Reject any ASCII
// control character (newline, CR, tab, NUL, …) in `name`.
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

const AttributionCoAuthorSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z
      .string()
      .refine((v) => !CONTROL_CHAR_RE.test(v), {
        message:
          'attribution.co_author.name must not contain control characters ' +
          '(newlines, tabs, carriage returns) — the value is written verbatim ' +
          'into a single-line Co-Authored-By git trailer.',
      })
      .optional(),
    email: z
      .string()
      .regex(/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/, {
        message:
          'attribution.co_author.email must match <local>@<host>.<tld> ' +
          '(no spaces, no angle brackets, must contain @ and a dot in the host)',
      })
      .optional()
      .or(z.literal('')),
    skip_merge: z.boolean().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.enabled !== true) return;
    const name = (val.name ?? '').trim();
    const email = (val.email ?? '').trim();
    if (name.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['name'],
        message:
          'attribution.co_author.enabled: true requires a non-empty `name`. ' +
          'Either set `name: "Your Name"` and `email: "you@example.com"`, or ' +
          'set `enabled: false` to disable the augmenter.',
      });
    }
    if (email.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['email'],
        message:
          'attribution.co_author.enabled: true requires a non-empty `email`. ' +
          'Either set `name: "Your Name"` and `email: "you@example.com"`, or ' +
          'set `enabled: false` to disable the augmenter.',
      });
    }
  });

const AttributionPolicySchema = z
  .object({
    co_author: AttributionCoAuthorSchema.optional(),
  })
  .strict();

/**
 * 0.31.0 — delegation-advisory nudge policy. Drives the
 * `delegation-advisory.sh` PostToolUse hook (matcher
 * `Bash|Edit|Write|MultiEdit|NotebookEdit`): when a session crosses
 * `threshold` write-class tool calls without a `rea.delegation_signal`
 * record (to a non-exempt subagent), the hook emits a one-time stderr
 * advisory. The hook is advisory-only — exit 0 always except HALT.
 *
 * Defaults live here at the schema layer, not in the hook: a vanilla
 * install with no `delegation_advisory` block gets `enabled: false`
 * (silent no-op), `threshold: 25`, and the 5-entry built-in exempt
 * list. The `bst-internal*` profiles pin `enabled: true`; OSS profiles
 * leave it `false` so consumers opt in.
 *
 * `threshold` is a positive integer — a single write-class count
 * rather than the 0.29.0 design memo's "15 edits + 5 Bash" split.
 * Modeling the threshold as one number keeps the hook's counter file
 * a single integer and the policy surface a single knob; the
 * distinction between an Edit and a Bash call doesn't change the
 * signal the nudge exists to send ("you've done a lot solo").
 *
 * Strict mode rejects unknown keys so a typo (`thresholds`,
 * `exempt_subagent`) fails loudly at policy load.
 */
const DelegationAdvisoryPolicySchema = z
  .object({
    enabled: z.boolean().default(false),
    threshold: z.number().int().positive().default(25),
    exempt_subagents: z
      .array(z.string())
      .default([
        'general-purpose',
        'Explore',
        'Plan',
        'output-style-setup',
        'statusline-setup',
      ]),
  })
  .strict();

/**
 * 0.51.0 — spend-governance policy (E1 seed slice). Drives the
 * `billing-cap-halt.sh` PostToolUse hook (matcher `Bash`): when a
 * just-run command's output carries a billing-class signature (distinct
 * from a mere rate-limit / 429), the hook writes `.rea/HALT` — reusing
 * the existing kill-switch every middleware + hook already respects.
 *
 * Introduced after INCIDENT-2026-07-04 (denial-of-wallet): rea had no
 * concept of money, so a billing-cap error was retried like a 429 and
 * multiplied spend against a metered endpoint. See `THREAT_MODEL.md
 * §5.25`.
 *
 * SEED slice only — `enabled` + `billing_error_response`. The full E1
 * axis (`metered_endpoints`, `retry_discipline`) and E3
 * (`consumption_limits`) land in later PRs. Kept `.strict()` so a typo
 * or a premature future-field fails loudly at policy load, matching
 * every other block.
 *
 * OPT-OUT defaults (incident mandate "default ON, zero-exception", codex
 * 0.51.0 round-5/6): a block that is present but omits `enabled` gets
 * `enabled: true`, and an ABSENT block gets the whole default object
 * (`.default({})` at the top-level schema) so `loadPolicy()` agrees with
 * the runtime hook's opt-out reading — the reflex is ON for any present
 * rea policy unless it positively sets `enabled: false` (or
 * `billing_error_response: off`). This keeps the strict loader and the
 * `billing-cap-halt` hook in lockstep; a split where one says on and the
 * other off was the round-6 finding. `billing_error_response` defaults to
 * the protective `'halt'`. Every shipped profile still pins the block
 * explicitly for documentation, but absence no longer means disabled.
 */
const SpendGovernancePolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    // SEED default is `warn`, NOT `halt` (codex 0.51.0 round-12 P1). The
    // hook fires on every Bash PostToolUse with no metered-endpoint scoping
    // yet, so a phrase-only global `halt` would freeze sessions in
    // budgeting / payments / loyalty repos whose own errors say "spending
    // cap" etc. `warn` detects + banners + audits without freezing. `halt`
    // stays available as an explicit opt-in and becomes the default once
    // PR2's endpoint registry supplies the provider discriminator that
    // makes freezing safe.
    billing_error_response: z.enum(['halt', 'warn', 'off']).default('warn'),
  })
  .strict();

/**
 * 0.48.0 — per-session shim cache policy. The
 * `hooks/_lib/shim-cache.sh` helper, sourced by every Node-binary
 * shim via `hooks/_lib/shim-runtime.sh`, caches the (sandbox-ok,
 * shape-ok) tuple for a given (session, project, CLI realpath,
 * mtime, size, euid, enforce_shape) key, with a 3600s TTL ceiling.
 * The cache is an OPTIMIZATION — every cache-miss path falls through
 * to the existing uncached hot path. See
 * `docs/shim-session-cache-design.md` for the full contract.
 *
 * Strict mode rejects unknown keys so a typo (`enabld`, `enable`)
 * fails loudly at policy load. The block is optional — vanilla
 * installs with no `shim_cache:` block get the default behavior
 * (cache enabled). To disable: `shim_cache: { enabled: false }`.
 *
 * The bash-tier helper does a narrow YAML grep for the field
 * BEFORE the canonical 4-tier policy reader is available (cache
 * runs in the shim's pre-CLI section). This zod schema validates
 * the field at CLI load time so wrong types / typos are caught at
 * the load boundary.
 */
const ShimCachePolicySchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .strict();

/**
 * 0.49.0 — bootstrap allowlist policy. Drives the narrow CLI-missing
 * pass-through in `hooks/_lib/bootstrap-allowlist.sh` that the
 * `blocked-paths-bash-gate.sh` and `protected-paths-bash-gate.sh`
 * shims consult when the rea CLI is unreachable. See the helper
 * header for the full security contract.
 *
 * The block is optional — vanilla installs with no
 * `bootstrap_allowlist:` block get the default behavior (enabled).
 * To disable: `bootstrap_allowlist: { enabled: false }`.
 *
 * Strict mode rejects unknown keys so a typo (`enabld`, `enable`)
 * fails loudly at policy load.
 *
 * The bash-tier helper does a narrow YAML grep for the field via
 * inline node (engines.node >=22 guarantees availability) BEFORE the
 * canonical 4-tier policy reader is available (the allowlist runs
 * precisely BECAUSE the CLI is missing). This zod schema validates
 * the field at CLI load time so wrong types / typos are caught at the
 * load boundary.
 */
const BootstrapAllowlistPolicySchema = z
  .object({
    enabled: z.boolean().default(true),
  })
  .strict();

/**
 * 0.50.0 — runtime resolver policy. Currently the sole field is
 * `allow_global_cli`, the OPTIONAL project-level veto over the global rea
 * CLI resolver tier in `hooks/_lib/shim-runtime.sh`.
 *
 * The global tier is gated PRIMARILY by a per-user registry (A5 consent
 * gate). This project-level knob is a SECONDARY veto layered on top —
 * registry can only ENABLE the tier; policy can only further-RESTRICT it.
 * The asymmetry is deliberate: a project can refuse the global CLI even
 * when the machine's registry has blessed it, but a project can NEVER
 * turn the tier ON when the registry has not.
 *
 * Tri-state (locked):
 *   - absent   → permitted (registry alone governs — the veto is silent)
 *   - `true`   → permitted (affirm; identical effect to absent, but
 *                explicit — a project can pin "yes, the global tier is
 *                fine here")
 *   - `false`  → veto (the project refuses the global tier even when the
 *                registry has blessed it)
 *
 * `.optional()` — NOT `.default()` — so absent stays distinguishable from
 * an explicit `false`. The distinction is load-bearing: the shim's veto
 * wiring (a later phase) must treat "field omitted" (registry governs)
 * differently from "explicitly false" (project refuses), and a schema
 * default would collapse the two.
 *
 * Deliberately OFF / absent by default — no profile and no shipped
 * `.rea/policy.yaml` carries a `runtime:` block. The global CLI tier is a
 * per-developer / per-machine opt-in via the per-user registry; the
 * project-level veto exists only for repos that want to affirmatively
 * refuse it, so its natural state is "not present."
 *
 * Strict mode rejects unknown keys so a typo (`allow_globcli`,
 * `allow_global_clis`) fails loudly at policy load rather than silently
 * omitting the veto. The `runtime` schema is REQUIRED even though it holds
 * a single optional field: the top-level `PolicySchema` is `.strict()`, so
 * without a `runtime` schema ANY `policy.yaml` carrying a `runtime:` block
 * would fail to load entirely.
 */
const RuntimePolicySchema = z
  .object({
    allow_global_cli: z.boolean().optional(),
  })
  .strict();

/**
 * Artifact Gates (0.54.0+). Three deterministic, model-judgment-free
 * process gates — G1 spec-gate, G2 verification-gate, G3 review-gate —
 * each with a three-state `mode`: `off` (silent no-op — the default, so
 * an absent block is byte-identical to prior behavior), `shadow` (log
 * would-block to the audit chain, never block), `enforce` (block into
 * the review queue, never an interactive prompt). Policy can TIGHTEN
 * but never loosen the floor. See THREAT_MODEL §11 and the gates spec.
 */
const GateModeSchema = z.enum(['off', 'shadow', 'enforce']);
const ArtifactGatesPolicySchema = z
  .object({
    g1_spec: z
      .object({
        mode: GateModeSchema.default('off'),
        // Non-trivial-work thresholds — the gate is SILENT below these
        // (unless the active ticket is `requires_spec`), preserving the
        // "just do it" branch for single-smart-zone work.
        diff_lines: z.number().int().positive().default(150),
        diff_files: z.number().int().positive().default(5),
      })
      .strict()
      .default({}),
    g2_verify: z
      .object({ mode: GateModeSchema.default('off') })
      .strict()
      .default({}),
    g3_review: z
      .object({ mode: GateModeSchema.default('off') })
      .strict()
      .default({}),
  })
  .strict();

const PolicySchema = z
  .object({
    version: z.string(),
    profile: z.string(),
    installed_by: z.string(),
    installed_at: z.string(),
    autonomy_level: z.nativeEnum(AutonomyLevel),
    max_autonomy_level: z.nativeEnum(AutonomyLevel),
    promotion_requires_human_approval: z.boolean(),
    block_ai_attribution: z.boolean().default(false),
    blocked_paths: z.array(z.string()),
    // 0.16.5 F9 (helix-018 Option A): full policy-driven definition of
    // the rea-managed write-protection list. When set, fully owns the
    // protected set (kill-switch invariants are always added). When
    // unset, defaults to the 5 historical patterns. Consumers who want
    // to ADD a path (e.g. `.github/workflows/`) or remove non-invariant
    // entries (e.g. `.husky/`) declare the full list here.
    protected_writes: z.array(z.string()).optional(),
    // 0.16.3 F7: opt-in subtractor. Removes entries from whatever the
    // effective protected set is (default OR `protected_writes`).
    // Kill-switch invariants (`.rea/HALT`, `.rea/policy.yaml`,
    // `.claude/settings.json`) are silently dropped from the relax
    // list — see hooks/_lib/protected-paths.sh. Both keys can coexist;
    // `protected_paths_relax` runs AFTER `protected_writes`.
    protected_paths_relax: z.array(z.string()).default([]),
    notification_channel: z.string().default(''),
    injection_detection: z.enum(['block', 'warn']).optional(),
    injection: InjectionPolicySchema.optional(),
    context_protection: ContextProtectionSchema.optional(),
    review: ReviewPolicySchema.optional(),
    redact: RedactPolicySchema.optional(),
    audit: AuditPolicySchema.optional(),
    gateway: GatewayPolicySchema.optional(),
    // 0.20.1 helix-round-N P2: architecture-review-gate.sh patterns
    // are now policy-driven. Pre-fix the hook hardcoded rea-internal
    // source-tree patterns (`src/gateway/`, `hooks/_lib/`, etc.) which
    // produced irrelevant advisory output in consumer projects.
    // Empty (or unset) → silent no-op. bst-internal profile pins the
    // rea-source patterns so dogfood behaves as before.
    architecture_review: z
      .object({
        patterns: z.array(z.string()).optional(),
      })
      .optional(),
    // 0.26.0 commit-hygiene thresholds — top-level so it's discoverable
    // separately from `review.local_review`. `rea preflight` consumes it.
    commit_hygiene: CommitHygienePolicySchema.optional(),
    // 0.30.0 attribution augmenter — drives the husky
    // `prepare-commit-msg` hook. The cross-field refinement on
    // `AttributionCoAuthorSchema` fails closed when `enabled: true` but
    // `name`/`email` are empty so we never ship a half-configured trailer.
    attribution: AttributionPolicySchema.optional(),
    // 0.31.0 delegation-advisory nudge — drives the
    // `delegation-advisory.sh` PostToolUse hook. `.optional()` so a
    // vanilla install with no block sees the hook as a silent no-op
    // (the hook reads `enabled` via `rea hook policy-get` and exits 0
    // when unset/false). When the block IS present the inner schema
    // supplies defaults for any omitted field.
    delegation_advisory: DelegationAdvisoryPolicySchema.optional(),
    // 0.51.0 spend-governance (E1 seed) — drives the `billing-cap-halt.sh`
    // PostToolUse hook. `.default({})` (NOT `.optional()`) so an ABSENT
    // block resolves to the opt-out default (`enabled: true`,
    // `billing_error_response: 'halt'`) — the reflex is ON for any present
    // rea policy unless it positively opts out. This keeps `loadPolicy()`
    // in lockstep with the runtime hook's opt-out reading (codex round-6:
    // a split where the schema said off-by-default while the hook enforced
    // on was the defect). When the block IS present the inner schema fills
    // any omitted field. Every shipped profile still pins it explicitly.
    // See `SpendGovernancePolicySchema` and `THREAT_MODEL.md §5.25`.
    spend_governance: SpendGovernancePolicySchema.default({}),
    // 0.48.0 per-session shim cache — drives `hooks/_lib/shim-cache.sh`
    // which short-circuits the sandbox check + version probe in
    // `hooks/_lib/shim-runtime.sh` on session-warm fires of the same
    // shim. Optional — vanilla installs get the default behavior
    // (cache enabled). The bash-tier `shim_cache_disabled` helper
    // honors `enabled: false` via a narrow inline YAML grep before
    // the canonical policy reader is reachable. `REA_SHIM_CACHE=0`
    // in env overrides this to `false` for the current invocation
    // regardless of policy.
    shim_cache: ShimCachePolicySchema.optional(),
    // 0.49.0 — bootstrap allowlist. Narrow CLI-missing pass-through
    // for the `pnpm install` / `npm ci` / `yarn` / `corepack enable`
    // class of recovery commands. ALWAYS-ON by default; opt-out via
    // `bootstrap_allowlist: { enabled: false }`. The bash-tier
    // gate consults the field via inline node BEFORE the canonical
    // 4-tier policy reader is reachable, since the whole reason it
    // runs is that the CLI is unbuilt. See
    // `hooks/_lib/bootstrap-allowlist.sh` and
    // `THREAT_MODEL.md §5.X`.
    bootstrap_allowlist: BootstrapAllowlistPolicySchema.optional(),
    // 0.50.0 runtime resolver policy — currently only the optional
    // `allow_global_cli` project-level veto over the global rea CLI
    // resolver tier. `.optional()` so a vanilla install with no
    // `runtime:` block leaves the tier governed by the per-user registry
    // alone (absent → permitted). See `RuntimePolicySchema` for the full
    // tri-state contract and the registry-primary / policy-secondary
    // asymmetry.
    runtime: RuntimePolicySchema.optional(),
    // 0.54.0 Artifact Gates — G1/G2/G3 process gates. `.optional()` so an
    // absent block is a total no-op (all modes default `off` when the
    // block IS present). See `ArtifactGatesPolicySchema`.
    artifact_gates: ArtifactGatesPolicySchema.optional(),
  })
  .strict();

const DEFAULT_CACHE_TTL_MS = 30_000;
const POLICY_DIR = '.rea';
const POLICY_FILE = 'policy.yaml';

interface PolicyCacheEntry {
  policy: Policy;
  cachedAt: number;
  mtimeMs: number;
}

/**
 * SECURITY: Cache never serves a more permissive policy than disk.
 * mtime invalidation ensures policy tightening takes effect before TTL expires.
 */
const policyCache = new Map<string, PolicyCacheEntry>();

const inflightReads = new Map<string, Promise<Policy>>();

/**
 * Convert `{ key: undefined }` to omitted keys so Policy satisfies
 * exactOptionalPropertyTypes. Zod defaults produce explicit undefined.
 */
function stripUndefined(input: z.infer<typeof PolicySchema>): Policy {
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) result[k] = v;
  }
  return result as unknown as Policy;
}

function applyMaxCeiling(policy: Policy): Policy {
  if (LEVEL_ORDER[policy.autonomy_level] > LEVEL_ORDER[policy.max_autonomy_level]) {
    console.error(
      `[rea] WARNING: autonomy_level ${policy.autonomy_level} exceeds max_autonomy_level ${policy.max_autonomy_level} — clamping to ${policy.max_autonomy_level}`,
    );
    return { ...policy, autonomy_level: policy.max_autonomy_level };
  }
  return policy;
}

/**
 * G3: run every user-supplied redact pattern through `safe-regex`. A flagged
 * pattern rejects the entire policy load with an error that names the
 * offender. Also verifies the pattern actually compiles — a malformed regex
 * source is a clear policy authoring bug and should fail loud.
 */
function checkUserRedactPatterns(policy: z.infer<typeof PolicySchema>, policyPath: string): void {
  const patterns = policy.redact?.patterns;
  if (!patterns || patterns.length === 0) return;

  for (const entry of patterns) {
    let compiled: RegExp;
    try {
      compiled = new RegExp(entry.regex, entry.flags);
    } catch (err) {
      throw new Error(
        `Invalid redact pattern "${entry.name}" at ${policyPath}: ` +
          `cannot compile regex ${JSON.stringify(entry.regex)}` +
          (entry.flags ? ` with flags ${JSON.stringify(entry.flags)}` : '') +
          ` — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!safeRegex(compiled)) {
      throw new Error(
        `Unsafe redact pattern "${entry.name}" at ${policyPath}: ` +
          `safe-regex flagged ${JSON.stringify(entry.regex)} as potentially ReDoS-vulnerable. ` +
          `Rewrite with bounded quantifiers / no nested repetition / no disjoint alternation.`,
      );
    }
  }
}

/**
 * 0.50.x — config-vs-capability guard. The `:free` OpenRouter endpoint
 * (`openai/gpt-oss-120b:free`) trains on prompts, has a rate-limit cliff,
 * and routes nondeterministically — it is deliberately NOT wired. The
 * schema's `model` regex permits `:` (other models use it legitimately),
 * so this guard fails LOUD if a consumer points the openrouter provider
 * at any `:free` variant rather than silently hitting a train-on-prompts
 * endpoint. A governance layer must never quietly degrade its data
 * posture.
 */
function checkOpenRouterModel(policy: z.infer<typeof PolicySchema>, policyPath: string): void {
  const model = policy.review?.providers?.openrouter?.model;
  if (model === undefined) return;
  if (/:free$/i.test(model.trim())) {
    throw new Error(
      `Invalid review.providers.openrouter.model "${model}" at ${policyPath}: ` +
        `the ":free" OpenRouter endpoint is NOT wired — it trains on prompts ` +
        `and routes nondeterministically. Use the paid lane ` +
        `("openai/gpt-oss-120b") instead. If you intended the free tier, that ` +
        `is unsupported by design for a governance-layer review provider.`,
    );
  }
}

function parseRawPolicy(raw: string, policyPath: string): Policy {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (yamlErr) {
    throw new Error(
      `Failed to parse policy YAML at ${policyPath}: ${yamlErr instanceof Error ? yamlErr.message : yamlErr}`,
    );
  }

  let parsedPolicy: z.infer<typeof PolicySchema>;
  try {
    parsedPolicy = PolicySchema.parse(parsed);
  } catch (zodErr) {
    throw new Error(
      `Invalid policy schema at ${policyPath}: ${zodErr instanceof Error ? zodErr.message : zodErr}`,
    );
  }

  // G3: reject unsafe user-supplied redaction patterns. This runs BEFORE
  // stripUndefined so the error references the user-authored field exactly.
  checkUserRedactPatterns(parsedPolicy, policyPath);

  // 0.50.x: reject a `:free` openrouter model loudly (config-vs-capability).
  checkOpenRouterModel(parsedPolicy, policyPath);

  return applyMaxCeiling(stripUndefined(parsedPolicy));
}

function policyPathFor(baseDir: string): string {
  return path.join(baseDir, POLICY_DIR, POLICY_FILE);
}

async function readPolicyFromDisk(
  baseDir: string,
  policyPath: string,
  currentMtime: number,
): Promise<Policy> {
  const raw = await fsPromises.readFile(policyPath, 'utf8');
  const policy = parseRawPolicy(raw, policyPath);
  policyCache.set(baseDir, { policy, cachedAt: Date.now(), mtimeMs: currentMtime });
  return policy;
}

/**
 * Async policy loader with TTL cache and mtime-based invalidation.
 *
 * TTL is configurable via REA_POLICY_CACHE_TTL_MS.
 *
 * SECURITY: mtime invalidation ensures a tightened policy takes effect on the next call.
 * CONCURRENCY: inflightReads map guarantees at most one disk read per baseDir at a time.
 */
export async function loadPolicyAsync(baseDir: string): Promise<Policy> {
  const policyPath = policyPathFor(baseDir);
  const ttlMs = Number(process.env.REA_POLICY_CACHE_TTL_MS ?? DEFAULT_CACHE_TTL_MS);
  const now = Date.now();

  let currentMtime: number;
  try {
    const stat = await fsPromises.stat(policyPath);
    currentMtime = stat.mtimeMs;
  } catch {
    throw new Error(`Policy file not found: ${policyPath}`);
  }

  const cached = policyCache.get(baseDir);
  if (cached !== undefined && cached.mtimeMs === currentMtime && now - cached.cachedAt < ttlMs) {
    return cached.policy;
  }

  const inflight = inflightReads.get(baseDir);
  if (inflight) return inflight;

  const read = readPolicyFromDisk(baseDir, policyPath, currentMtime).finally(() => {
    inflightReads.delete(baseDir);
  });
  inflightReads.set(baseDir, read);
  return read;
}

/**
 * Synchronous policy loader — for CLI startup paths that must be sync.
 * Does NOT use the cache — always reads from disk.
 *
 * Prefer loadPolicyAsync for middleware and any async context.
 */
export function loadPolicy(baseDir: string): Policy {
  const policyPath = policyPathFor(baseDir);

  if (!fs.existsSync(policyPath)) {
    throw new Error(`Policy file not found: ${policyPath}`);
  }

  const raw = fs.readFileSync(policyPath, 'utf8');
  return parseRawPolicy(raw, policyPath);
}

/**
 * Invalidate the cache for a given baseDir.
 * Exposed for testing — production code relies on TTL and mtime invalidation.
 */
export function invalidatePolicyCache(baseDir?: string): void {
  if (baseDir === undefined) {
    policyCache.clear();
  } else {
    policyCache.delete(baseDir);
  }
}

export { PolicySchema };
