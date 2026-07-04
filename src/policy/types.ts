export enum Tier {
  Read = 'read',
  Write = 'write',
  Destructive = 'destructive',
}

export enum AutonomyLevel {
  L0 = 'L0',
  L1 = 'L1',
  L2 = 'L2',
  L3 = 'L3',
}

export enum InvocationStatus {
  Allowed = 'allowed',
  Denied = 'denied',
  Error = 'error',
}

export interface ContextProtection {
  delegate_to_subagent: string[];
  max_bash_output_lines?: number;
}

/**
 * Review policy knobs for the 0.11.0 stateless push-gate.
 *
 * The gate runs `codex exec review --json` on every push and infers a verdict
 * from the streamed findings (see `src/hooks/push-gate/findings.ts`). No
 * cache, no audit-receipt consultation, no SHA-keyed attestation. These
 * knobs shape only the immediate run.
 *
 * The 0.10.x knobs `cache_max_age_seconds` and `allow_skip_in_ci` were
 * removed in 0.11.0. `rea upgrade` strips them from consumer policy files.
 */
export interface ReviewPolicy {
  /**
   * When `true` or unset, `git push` runs `codex exec review` before the
   * push is allowed to proceed. When `false`, the push-gate short-circuits
   * to `disabled` (exit 0, audit event still recorded). No middle state —
   * either we run Codex or we don't.
   *
   * Profile default: `true` in `bst-internal`, `client-engagement`,
   * `lit-wc`, `open-source`. `false` in `*-no-codex` variants.
   */
  codex_required?: boolean;
  /**
   * Whether a `concerns` verdict blocks the push. `true` (default) means any
   * non-trivial Codex finding halts the push; the agent must address the
   * concerns (or re-run with `REA_ALLOW_CONCERNS=1` for a one-push override)
   * before retrying. `false` means only `blocking` verdicts halt — concerns
   * are logged and written to `.rea/last-review.json` but the push proceeds.
   *
   * Added in 0.11.0. Default when unset is `true` — safer posture for
   * consumers who have not thought about it.
   */
  concerns_blocks?: boolean;
  /**
   * Hard cap on the `codex exec review` subprocess in milliseconds. Exceeding
   * this kills the subprocess and the gate returns exit 2 with a timeout
   * error (audited). Default when unset is 1_800_000 (30 minutes) as of
   * 0.12.0 — raised from 10 minutes after the helixir migration session
   * 2026-04-26 showed realistic feature-branch diffs routinely exceeded
   * the previous default. Operators with explicit `timeout_ms:` in
   * `.rea/policy.yaml` are unaffected.
   *
   * Positive integer only. The loader rejects zero/negative values.
   */
  timeout_ms?: number;
  /**
   * When set, `rea hook push-gate` resolves the diff base to `HEAD~N`
   * instead of the upstream → origin/HEAD ladder. Useful when a feature
   * branch accumulates many commits and the full origin/main diff
   * overwhelms the reviewer (the helixir 2026-04-26 case: 50+ commits
   * relative to origin/main produced non-deterministic Codex verdicts and
   * 10-minute timeouts).
   *
   * Precedence: explicit `--base <ref>` flag wins; then `--last-n-commits N`
   * flag; then this policy key; then refspec-aware base resolution; then
   * the upstream-ladder fallback. When `--base` AND
   * `--last-n-commits`/`policy.last_n_commits` are both set, `--base`
   * wins and a stderr warning is emitted.
   *
   * Resolution: `git rev-parse HEAD~N`. When `HEAD~N` is unreachable
   * the resolver consults `git rev-parse --is-shallow-repository` to
   * pick the right clamp:
   *
   *   - FULL clone, branch shorter than N: clamps to the empty-tree
   *     sentinel so the root commit's changes are included
   *     (`git diff base..HEAD` excludes `base`, so diffing against
   *     `HEAD~K` would silently drop the root commit). Reports
   *     `last_n_commits: K+1` — every commit on the branch reviewed.
   *
   *   - SHALLOW clone: clamps to `HEAD~K` (the deepest LOCALLY
   *     resolvable ancestor) since older history exists on the remote
   *     but isn't fetched. Using empty-tree here would balloon the
   *     review to every tracked file in the checkout. Reports
   *     `last_n_commits: K`. The K-th commit's content is excluded —
   *     accepted as the cost of the shallow clone.
   *
   * A stderr warning surfaces the requested-vs-clamped numbers in
   * both cases. Audit metadata records `base_source: 'last-n-commits'`,
   * `last_n_commits: <count actually reviewed>`, and
   * `last_n_commits_requested: N` (only present when clamped).
   *
   * Positive integer. The loader rejects zero/negative values.
   */
  last_n_commits?: number;
  /**
   * Auto-narrow threshold (J / 0.13.0). When the resolved diff base is more
   * than N commits behind HEAD, the gate automatically scopes the review to
   * the last 10 commits (or `last_n_commits` if pinned) and emits a stderr
   * warning explaining the auto-narrow + how to override.
   *
   * Default `30` when unset. Explicit `0` disables auto-narrow entirely.
   *
   * Auto-narrow is SUPPRESSED when the operator already expressed explicit
   * intent — any of these prevents auto-narrow from firing:
   *
   *   - `--last-n-commits N` flag (the operator picked an exact window)
   *   - `--base <ref>` flag (the operator picked an exact base)
   *   - `policy.review.last_n_commits` (persistent narrow-window config)
   *
   * Audit metadata records `auto_narrowed: true|false` and
   * `original_commit_count: N` on every reviewed event so operators can
   * grep their audit log for narrowed reviews.
   *
   * Background: large feature branches (50+ commits relative to origin/main)
   * routinely produced non-deterministic Codex verdicts, 10-minute timeouts,
   * and the "thrashing" reported in helixir migration 2026-04-26. The 0.12.0
   * `last_n_commits` knob fixed it for operators who knew to set it; J makes
   * the protective default automatic.
   *
   * Non-negative integer. The loader rejects negative values.
   */
  auto_narrow_threshold?: number;
  /**
   * Codex CLI model override (0.13.4+). Pinned via `-c model="<name>"` on
   * every `codex exec review` invocation. When unset, codex's own default
   * applies — which today is the special-purpose `codex-auto-review` model
   * at medium reasoning, NOT the flagship.
   *
   * Recommended for serious adversarial review: `gpt-5.4` paired with
   * `codex_reasoning_effort: high`. Higher reasoning trades push-gate
   * latency for verdict consistency — fewer same-code-different-verdict
   * round-trips like the 2026-04-26 helixir migration session.
   *
   * Loose string type — codex's model catalog evolves. Codex itself
   * validates the model name at exec time; an unknown name surfaces as
   * a clear runtime error rather than a silent fallback.
   */
  codex_model?: string;
  /**
   * Codex reasoning effort (0.13.4+). Pinned via
   * `-c model_reasoning_effort="<level>"` on every invocation. Only
   * meaningful when paired with a reasoning-capable model (gpt-5.4,
   * gpt-5.3-codex). Codex's own default is `medium`.
   *
   * Recommended: `high` for serious review on long-running branches
   * (more compute spent per finding, fewer flips). `low` for
   * cost-bounded environments where consistency matters less than
   * throughput.
   */
  codex_reasoning_effort?: 'low' | 'medium' | 'high';
  /**
   * Verdict cache TTL in milliseconds (0.18.1+ helixir #1, #4, #7, #8).
   * Default 86_400_000 (24 hours). When a push of `head_sha` produces a
   * non-blocking verdict, the result is written to
   * `.rea/last-review.cache.json`. Subsequent pushes of the same SHA
   * within the TTL skip the codex invocation and reuse the cached
   * verdict. Set to `0` to disable caching (every push re-invokes
   * codex — pre-0.18.1 behavior). Verdict flips on the same SHA emit
   * a `rea.push_gate.verdict_flip` audit event and overwrite the cache.
   */
  cache_ttl_ms?: number;
  /**
   * 0.28.0 helix-029 — path-scoped finding filter. Gitignore-style
   * globs against repo-relative paths. Findings whose `file` matches
   * any glob in this list are filtered OUT before the verdict is
   * computed, but are still emitted on stderr (so the operator can
   * file them upstream). Useful for downstream consumers of rea who
   * cannot patch rea-managed paths but should not be blocked from
   * pushing while waiting on an upstream fix.
   *
   * Setting this list also enables `auto_exclude_managed` by default —
   * paths from `.rea/install-manifest.json` are excluded in addition
   * to whatever globs are listed here. Pass `auto_exclude_managed:
   * false` to opt out and rely on `exclude_paths` alone.
   *
   * Empty (or unset) → no filtering, pre-0.28.0 behavior.
   *
   * The audit shape is unchanged; the gate emits a
   * `filtered_findings_count` counter into the audit metadata so
   * operators can grep `rea.push_gate.reviewed` to see how many
   * findings were suppressed without re-parsing prose.
   */
  exclude_paths?: string[];
  /**
   * 0.28.0 helix-029 — derived default. When `exclude_paths` is set,
   * defaults to `true` — paths from `.rea/install-manifest.json` are
   * excluded in addition to the explicit globs. Set explicitly to
   * `false` to rely only on `exclude_paths`. When `exclude_paths` is
   * unset, this field is a no-op (no filter is active in the first
   * place).
   */
  auto_exclude_managed?: boolean;
  /**
   * Local-first review enforcement (0.26.0+ — CTO directive 2026-05-05).
   *
   * The push-gate is the BACKUP layer. The primary review surface is the
   * working tree BEFORE commit, run via `rea review`, recorded as a
   * `rea.local_review` audit entry. The Bash-tier `local-review-gate.sh`
   * hook + husky `rea preflight --strict` refuse `git push` (and optionally
   * `git commit`) when no recent matching audit entry exists for HEAD.
   *
   * The off-switch is the FIRST-class concern. Teams without codex/claude
   * installed set `mode: off` to disable the new enforcement layers
   * cleanly — no env-var hacks, no policy strip, no special init flag.
   *
   * The provider seam is the audit-record `provider` field, NOT this
   * policy block. Future providers (Claude-subagent, Pi, Gemma) write
   * `rea.local_review` records with their own `provider:` value; this
   * block governs WHETHER the gate fires, not WHO runs the review.
   */
  local_review?: LocalReviewPolicy;
}

/**
 * Local-first review enforcement (0.26.0+).
 *
 * `mode: 'enforced'` — the new Bash-tier gate, husky preflight, and
 * `rea review` requirement all fire. Pushes are refused unless a
 * recent matching `rea.local_review` audit entry exists OR
 * `bypass_env_var` is set with a non-empty reason.
 *
 * `mode: 'off'` — every new enforcement layer becomes a silent no-op.
 * Teams without codex/claude opt out cleanly. The push-gate (which is
 * a separate layer governed by `codex_required`) is unaffected by this
 * setting.
 *
 * Default when unset: `enforced`. The CTO directive 2026-05-05 applies
 * to ALL rea work, OSS + enterprise — the off-switch is opt-out, never
 * opt-in.
 */
export interface LocalReviewPolicy {
  mode?: 'enforced' | 'off';
  /**
   * Maximum age (seconds) of a `rea.local_review` audit entry that
   * `rea preflight` will accept as covering the current HEAD. A review
   * older than this is treated as missing and the gate refuses.
   * Default 86400 (24 hours).
   */
  max_age_seconds?: number;
  /**
   * Which git operations the Bash-tier gate refuses when no recent
   * review covers HEAD.
   *   - `'push'`   — refuse `git push` only (default)
   *   - `'commit'` — refuse `git commit` only
   *   - `'both'`   — refuse both
   *
   * The husky pre-push hook honors `'push' | 'both'`. The Bash-tier
   * hook honors all three.
   */
  refuse_at?: 'push' | 'commit' | 'both';
  /**
   * Env-var name that, when set with a non-empty value, causes
   * `rea preflight` to short-circuit (exit 0) AFTER writing a
   * `rea.local_review.skipped_override` audit entry that records
   * the reason. Default `REA_SKIP_LOCAL_REVIEW`.
   *
   * The override is per-invocation, audited every time, and a
   * release valve — not a sustained way to disable enforcement.
   * Teams that need to DISABLE enforcement set `mode: off`.
   */
  bypass_env_var?: string;
}

/**
 * Commit-hygiene refusal thresholds (0.26.0+). `rea preflight` runs
 * `git rev-list --count <base>..HEAD` and compares against these
 * thresholds. Set to a sentinel value (e.g. very large integer) to
 * effectively disable.
 */
export interface CommitHygienePolicy {
  warn_at_commits?: number;
  refuse_at_commits?: number;
}

/**
 * User-supplied redaction pattern entry. Each pattern has a stable `name` used
 * in audit events, a raw `regex` source string, and optional `flags`. The
 * loader validates every pattern via `safe-regex` at load time (G3) — any
 * pattern flagged unsafe fails the load with a specific error naming the
 * offender. The `regex` source is compiled inside a `SafeRegex` timeout
 * wrapper by the gateway at middleware-creation time.
 */
export interface UserRedactPattern {
  name: string;
  regex: string;
  flags?: string;
}

/**
 * Redaction policy knobs (G3). `match_timeout_ms` bounds every per-call regex
 * execution; `patterns` are user-supplied regexes layered on top of the
 * built-in SECRET_PATTERNS.
 */
export interface RedactPolicy {
  match_timeout_ms?: number;
  patterns?: UserRedactPattern[];
}

/**
 * Audit rotation knobs (G1). Both thresholds are optional; absence of the
 * block leaves rotation inactive (back-compat with 0.2.x behavior).
 *
 * `max_bytes` — when `.rea/audit.jsonl` crosses this size the next append
 * triggers a rotation (size-based). Typical operator setting: 50 MiB.
 *
 * `max_age_days` — when the current `audit.jsonl`'s oldest record is older
 * than this many days, the next append triggers a rotation (age-based). Both
 * triggers are evaluated independently; either crossing threshold rotates.
 *
 * Rotation renames the current file to `audit-YYYYMMDD-HHMMSS.jsonl` in the
 * same directory and seeds a fresh `audit.jsonl` with a single rotation
 * marker record whose `prev_hash` equals the SHA-256 of the last record in
 * the rotated file — preserving hash-chain continuity across the boundary.
 */
export interface AuditRotationPolicy {
  max_bytes?: number;
  max_age_days?: number;
}

export interface AuditPolicy {
  rotation?: AuditRotationPolicy;
}

/**
 * Attribution augmenter policy (0.30.0+).
 *
 * Drives the husky `prepare-commit-msg` hook that appends a single
 * `Co-Authored-By: <name> <email>` trailer to every commit message. The
 * intended use case: a contributor whose enterprise git identity (e.g.
 * `alice@enterprise.example`) differs from their personal GitHub identity
 * (e.g. `alice@personal.example`) — GitHub's contribution graph keys off
 * the commit author/co-author email, so adding the personal address as a
 * trailer rolls the work onto their personal heatmap.
 *
 * The augmenter does NOT modify the primary author line. It appends a
 * trailer only — and is idempotent: re-running on a message that already
 * contains the trailer (by email match, case-insensitive) is a no-op.
 *
 * Note: this is orthogonal to the `attribution-advisory.sh` Bash hook
 * and the `block_ai_attribution` enforcement in the commit-msg hook.
 * Those reject AI-tool noreply emails + AI assistant names. A
 * human-authored `Co-Authored-By: Real Name <real@email.tld>` trailer
 * is not AI attribution and is not blocked.
 *
 * Profile defaults: every shipped profile leaves `co_author.enabled:
 * false`. The opt-in lives in repo-local edits to `.rea/policy.yaml`,
 * never in the profile, because the identity to roll commits onto is
 * inherently per-developer.
 */
export interface AttributionPolicy {
  co_author?: AttributionCoAuthorPolicy;
}

/**
 * Co-author trailer config. When `enabled: true`, BOTH `name` AND `email`
 * must be non-empty — the policy loader fails closed with a clear error
 * message when one is empty. `skip_merge: true` skips augmentation on
 * merge commits (commit source `merge`) only; all other sources
 * (`message`, `template`, `squash`, `commit`) are always augmented when
 * enabled.
 */
export interface AttributionCoAuthorPolicy {
  enabled?: boolean;
  name?: string;
  email?: string;
  skip_merge?: boolean;
}

/**
 * Delegation-advisory nudge policy (0.31.0+).
 *
 * 0.29.0 shipped the delegation-telemetry *observability* layer (the
 * `Agent|Skill` PreToolUse capture hook + `rea audit specialists`
 * reader). 0.31.0 closes the loop with the *nudge*: the
 * `delegation-advisory.sh` PostToolUse hook (matcher
 * `Bash|Edit|Write|MultiEdit|NotebookEdit`) counts the current
 * session's write-class tool calls and, when that count crosses
 * `threshold` WITHOUT a `rea.delegation_signal` record landing in the
 * session, prints a one-time stderr advisory: "this session has done a
 * lot of work without delegating to a specialist".
 *
 * The advisory is purely informational — the hook always exits 0
 * (except under HALT, which exits 2 to keep the kill-switch contract
 * uniform). It NEVER blocks a tool call.
 *
 * Profile defaults: `enabled: true` for the `bst-internal*` profiles
 * (BST's own delegation discipline is load-bearing); `enabled: false`
 * for every external profile (`open-source*`, `minimal`,
 * `client-engagement`, `lit-wc`) — OSS consumers opt in per-repo via
 * `.rea/policy.yaml`, since "you should delegate more" is an opinion
 * not every team shares.
 */
export interface DelegationAdvisoryPolicy {
  /**
   * Master switch. When `false` (or the whole block is omitted) the
   * `delegation-advisory.sh` hook is a silent no-op. Default `false` at
   * the schema layer; `bst-internal*` profiles pin `true`.
   */
  enabled?: boolean;
  /**
   * Write-class tool-call count at which the advisory fires. The
   * `delegation-advisory.sh` hook maintains a per-session counter file
   * and emits the nudge the first time the counter reaches this value
   * with zero delegation signals recorded for the session. Default
   * `25` — a session that has run 25 Bash/Edit/Write/MultiEdit/
   * NotebookEdit calls without once dispatching a specialist is doing
   * meaningful work solo. Must be a positive integer.
   */
  threshold?: number;
  /**
   * Subagent / skill names that do NOT count as "real delegation" for
   * the purpose of suppressing the advisory. A session that only ever
   * delegated to `general-purpose` / `Explore` / `Plan` (the built-in
   * Claude Code helpers) has not actually routed work to a curated
   * specialist, so those signals don't reset the nudge. Default:
   * `["general-purpose", "Explore", "Plan", "output-style-setup",
   * "statusline-setup"]`. A delegation signal whose `subagent_type` is
   * in this list is ignored when deciding whether to fire.
   */
  exempt_subagents?: string[];
}

/**
 * 0.51.0 — spend-governance policy axis (E1, seed slice).
 *
 * Introduced in response to INCIDENT-2026-07-04 (denial-of-wallet on a
 * metered TTS lane): an agent treated a "spending cap exceeded" error as
 * retryable and multiplied requests against a paid endpoint until the
 * budget blew past its cap. rea had NO concept of money anywhere — no
 * schema field, no hook, no threat class. This block is the first anchor
 * for that axis. See `THREAT_MODEL.md §5.25` (Denial-of-wallet / runaway
 * metered spend).
 *
 * This is the SEED slice only. It carries the two lowest-risk,
 * highest-value fields:
 *
 *   - `enabled` — master switch. When `false` (or the whole block is
 *     omitted) the `billing-cap-halt.sh` PostToolUse hook is a silent
 *     no-op. Matching every other governance block, an ABSENT block =
 *     disabled: a consumer whose `.rea/policy.yaml` predates 0.51.0 sees
 *     no behavior change until they add the block (all shipped profiles
 *     pin `enabled: true`).
 *
 *   - `billing_error_response` — what the billing→HALT reflex does when a
 *     billing-class signature is detected in a command's output:
 *       * `halt` (DEFAULT) — write `.rea/HALT` (the existing kill-switch,
 *         which every middleware + hook already respects) and surface a
 *         banner. Stop everything; NO retry. This is the field-proven
 *         reflex from the incident: a billing-class error is TERMINAL,
 *         never retryable like a 429.
 *       * `warn` — surface the banner (so the agent stops retrying) but
 *         do NOT write HALT.
 *       * `off` — silent no-op even when a signature matches.
 *
 * Deliberately does NOT yet carry `metered_endpoints` / `retry_discipline`
 * / `consumption_limits` — those are later PRs in the spend-governance
 * sequence (E1 full / E2 run-gate / E3 consumption). The block is
 * `.strict()` at the loader so any unknown sub-field (a typo, or a
 * premature future-field) fails loudly at policy load, exactly like every
 * other block.
 */
export type BillingErrorResponse = 'halt' | 'warn' | 'off';

export interface SpendGovernancePolicy {
  /**
   * Master switch. OPT-OUT: the `billing-cap-halt.sh` reflex is a no-op
   * ONLY when this is positively `false` (or `billing_error_response:
   * off`). Default `true` at the schema layer, and an ABSENT block also
   * resolves to enabled (`.default({})`) — the reflex is ON for any present
   * rea policy unless it opts out, per the incident mandate. Every shipped
   * profile still pins `true` explicitly.
   */
  enabled?: boolean;
  /**
   * What the billing→HALT reflex does on a billing-class match:
   * `halt` (default) writes `.rea/HALT`; `warn` surfaces a banner only;
   * `off` is a silent no-op. An unrecognized value is treated as `halt`
   * by the hook (fail-safe), though the strict loader rejects any value
   * outside the enum at load time.
   */
  billing_error_response?: BillingErrorResponse;
}

/**
 * G9 — injection tier escalation knobs. The classifier bucketed matches into
 * `clean` / `suspicious` / `likely_injection`; this block governs what happens
 * to the `suspicious` bucket (a single literal match at write/destructive tier,
 * no base64 escalation). `likely_injection` is ALWAYS a deny regardless of
 * these knobs.
 *
 * `suspicious_blocks_writes` —
 *   `undefined` (omitted): middleware defaults based on `injection_detection`:
 *     block mode defaults to `true` (0.2.x parity — single literal at
 *     write/destructive tier still denies); warn mode defaults to `false`
 *     (preserves 0.2.x warn-only semantics).
 *   `false` (explicit opt-out): suspicious matches warn-only (log + audit
 *     metadata, `status: allowed`), regardless of `injection_detection`.
 *   `true` (pinned in `bst-internal*` and this repo's own policy): suspicious
 *     matches at write/destructive tier deny with verdict `suspicious` in the
 *     audit record.
 *
 * G9 follow-up (post-merge Codex finding #1): the pre-patch schema default
 * of `false` silently loosened 0.2.x `injection_detection: block` behavior
 * for any consumer who upgraded without adding the `injection:` block.
 * Making this field optional and defaulting it at the middleware restores
 * 0.2.x parity.
 */
export interface InjectionPolicy {
  suspicious_blocks_writes?: boolean;
}

/**
 * BUG-011 (0.6.2) — gateway-level policy knobs.
 *
 * `health.expose_diagnostics` governs whether `__rea__health` emits
 * `halt_reason` and per-downstream `last_error` strings in its MCP response
 * (vs. dropping them to `null`). The short-circuit responds BEFORE the
 * middleware chain — so it bypasses `redact` and `injection` middleware by
 * design (the tool must stay callable under HALT). That means downstream
 * error strings, which are populated verbatim from `err.message`, can carry
 * secrets or injection payloads all the way to the caller unless we
 * sanitize in the short-circuit path itself.
 *
 * Default `false` (fields emitted as `null`). The Helix team's explicit
 * preference was "strip, don't redact" — a smaller trust ask than trusting
 * our secret/injection pattern coverage. Operators who accept that trade-off
 * (e.g. single-tenant dev boxes) can flip `expose_diagnostics: true`, at
 * which point the short-circuit applies the same `redactSecrets` +
 * `classifyInjection` pass the middleware chain would. The full untouched
 * values always flow into the audit log regardless — diagnostics remain
 * available via `rea doctor`, just not over the MCP wire.
 */
export interface GatewayHealthPolicy {
  expose_diagnostics?: boolean;
}

export interface GatewayPolicy {
  health?: GatewayHealthPolicy;
}

/**
 * Runtime resolver policy (0.50.0+).
 *
 * Governs the global rea CLI resolver tier in
 * `hooks/_lib/shim-runtime.sh`. The tier is enabled PRIMARILY by a
 * per-user registry (an A5 consent gate). `allow_global_cli` is the
 * OPTIONAL project-level SECONDARY veto: registry can only ENABLE the
 * tier, this knob can only further-RESTRICT it. A project can refuse the
 * global CLI even when the registry has blessed it, but a project can
 * never turn the tier ON when the registry has not.
 *
 * See `RuntimePolicy.allow_global_cli` for the tri-state contract.
 */
export interface RuntimePolicy {
  /**
   * Project-level veto over the global rea CLI resolver tier. Tri-state
   * (locked):
   *   - `undefined` (omitted) → permitted; the per-user registry alone
   *     governs the tier. This is the default state — no shipped profile
   *     or `.rea/policy.yaml` carries a `runtime:` block.
   *   - `true`  → permitted; explicit affirmation (same effect as absent,
   *     but pins "the global tier is fine in this repo").
   *   - `false` → veto; the project refuses the global tier even when the
   *     registry has blessed the machine.
   *
   * Modeled as an optional boolean (not defaulted) so absent stays
   * distinguishable from an explicit `false` — the shim's veto wiring
   * treats "registry governs" and "project refuses" as different states.
   */
  allow_global_cli?: boolean;
}

export interface Policy {
  version: string;
  profile: string;
  installed_by: string;
  installed_at: string;
  autonomy_level: AutonomyLevel;
  max_autonomy_level: AutonomyLevel;
  promotion_requires_human_approval: boolean;
  block_ai_attribution: boolean;
  blocked_paths: string[];
  protected_writes?: string[];
  protected_paths_relax: string[];
  notification_channel: string;
  injection_detection?: 'block' | 'warn';
  injection?: InjectionPolicy;
  context_protection?: ContextProtection;
  review?: ReviewPolicy;
  redact?: RedactPolicy;
  audit?: AuditPolicy;
  gateway?: GatewayPolicy;
  /**
   * Architecture-review patterns (0.20.1+). When set, the
   * `architecture-review-gate.sh` hook fires an advisory when a
   * Write/Edit/MultiEdit/NotebookEdit lands on a path matching one
   * of the patterns. When unset or empty, the hook is a silent no-op
   * — consumers without architecture-sensitive paths see zero noise.
   * bst-internal profile pins rea's own source-tree patterns
   * (`src/gateway/`, `hooks/_lib/`, etc.).
   */
  architecture_review?: {
    patterns?: string[];
  };
  /**
   * Commit-hygiene refusal thresholds (0.26.0+). `rea preflight` checks
   * `git rev-list --count <base>..HEAD`; `> warn_at_commits` warns
   * (exit 1), `> refuse_at_commits` refuses (exit 2). The CTO directive
   * 2026-05-05 sets the new BST default at warn_at=1 / refuse_at=5 to
   * push every change toward squash-on-commit hygiene.
   *
   * Top-level (not under `review`) because it's a process-discipline
   * knob, not a review knob. The push-gate doesn't consume it.
   */
  commit_hygiene?: CommitHygienePolicy;
  /**
   * Attribution augmenter (0.30.0+). When `co_author.enabled: true`, the
   * husky `prepare-commit-msg` hook appends a `Co-Authored-By:` trailer
   * to every commit (or every non-merge commit when `skip_merge: true`).
   * Idempotent — repeated runs over a message that already carries the
   * trailer are no-ops. See `AttributionPolicy` for the full contract.
   */
  attribution?: AttributionPolicy;
  /**
   * Delegation-advisory nudge (0.31.0+). When `enabled: true`, the
   * `delegation-advisory.sh` PostToolUse hook emits a one-time stderr
   * advisory when a session crosses `threshold` write-class tool calls
   * without dispatching a curated specialist. Advisory only — never
   * blocks. See `DelegationAdvisoryPolicy` for the full contract.
   */
  delegation_advisory?: DelegationAdvisoryPolicy;
  spend_governance?: SpendGovernancePolicy;
  /**
   * Per-session shim cache (0.48.0+).
   *
   * The `hooks/_lib/shim-cache.sh` helper, sourced by every Node-binary
   * shim via `hooks/_lib/shim-runtime.sh`, records the answers to the
   * sandbox check + version probe under a per-user, per-session,
   * per-CLI key. Subsequent shim fires within the same Claude Code
   * session against the same CLI (mtime + size unchanged) skip
   * straight to the forward step.
   *
   * The cache is an OPTIMIZATION, not a security boundary. Cache miss
   * / disabled / corruption all fall through to the existing uncached
   * hot path — never fail closed.
   *
   * `enabled` default: `true`. Set `false` to disable the cache layer
   * at the policy tier (equivalent effect to setting the
   * `REA_SHIM_CACHE=0` env var on every invocation). Operators who
   * want to measure unconditional steady-state latency should use the
   * env-var form so the cache stays off only for the measurement
   * window. See `docs/shim-session-cache-design.md` for the security
   * contract and `docs/hook-perf-baseline.md` for the perf
   * methodology note.
   */
  shim_cache?: ShimCachePolicy;
  /**
   * Bootstrap allowlist (0.49.0+).
   *
   * Drives the narrow CLI-missing pass-through in
   * `hooks/_lib/bootstrap-allowlist.sh`. When the bash-tier
   * `blocked-paths-bash-gate.sh` / `protected-paths-bash-gate.sh`
   * shims would refuse a Bash payload because the rea CLI is
   * unreachable, the allowlist consults this block + the
   * consumer's `package.json` to decide whether the payload is a
   * legitimate recovery command (pnpm install / npm ci / yarn /
   * corepack enable / etc.) that should pass through.
   *
   * Always-on by default. Set `enabled: false` to disable.
   * Opt-out is the only knob — the allowlist itself does not
   * accept env-var participation in the decision (security
   * architect locked).
   */
  bootstrap_allowlist?: BootstrapAllowlistPolicy;
  /**
   * Runtime resolver policy (0.50.0+). Currently only the optional
   * `allow_global_cli` project-level veto over the global rea CLI
   * resolver tier in `hooks/_lib/shim-runtime.sh`. Absent → the tier is
   * governed by the per-user registry alone; `false` → the project
   * refuses the tier even when registry-blessed; `true` → explicit
   * affirmation. See `RuntimePolicy` for the full contract.
   */
  runtime?: RuntimePolicy;
}

/**
 * Bootstrap allowlist policy (0.49.0+).
 *
 * See `hooks/_lib/bootstrap-allowlist.sh` for the full contract and
 * `THREAT_MODEL.md §5.X` for the threat-model analysis. The single
 * knob is `enabled` — there is no list of allowed shapes in policy;
 * the shape set is hardcoded in the helper because the threat model
 * depends on it being fixed (a consumer-mutable shape list would let
 * an attacker who can edit `policy.yaml` widen the pass-through).
 *
 * `policy.yaml` is itself a `blocked_paths` entry in the
 * `bst-internal` profile (so a consumer who is dogfooding rea's
 * own profile cannot turn the allowlist off via a Bash payload
 * without first earning a separate Write-tier audit event), but
 * the field is intentionally simple so external profiles can drop
 * it back to consumer-editable.
 */
export interface BootstrapAllowlistPolicy {
  enabled?: boolean;
}

/**
 * Per-session shim cache policy (0.48.0+).
 *
 * The cache short-circuits the sandbox check + version probe in
 * `hooks/_lib/shim-runtime.sh` on session-warm fires of the same
 * shim. The on-disk entry shape is bound to `schema_version: "v1"`
 * — a schema bump (future cache field additions) invalidates every
 * existing entry. TTL is hard-capped at 3600s (1h) inside the
 * runtime; this block does not expose a TTL knob in 0.48.0 because
 * the optimization is steady-state-bound and a longer TTL would
 * extend staleness without measurable benefit.
 */
export interface ShimCachePolicy {
  /**
   * Master switch. `true` (default) enables the cache. `false`
   * disables both reads and writes — the runtime falls through to
   * the existing uncached hot path on every fire. `REA_SHIM_CACHE=0`
   * in env overrides this to `false` for the current invocation
   * regardless of policy.
   *
   * NOTE 0.48.0: the bash-tier `shim_cache_disabled` helper consults
   * this field via a narrow YAML grep BEFORE the canonical 4-tier
   * policy reader is available (cache runs in the shim's pre-CLI
   * section). The TS loader's schema validation runs at full CLI
   * load time and catches typos / wrong types.
   */
  enabled?: boolean;
}
