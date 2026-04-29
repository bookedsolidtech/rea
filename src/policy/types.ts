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
  notification_channel: string;
  injection_detection?: 'block' | 'warn';
  injection?: InjectionPolicy;
  context_protection?: ContextProtection;
  review?: ReviewPolicy;
  redact?: RedactPolicy;
  audit?: AuditPolicy;
  gateway?: GatewayPolicy;
}
