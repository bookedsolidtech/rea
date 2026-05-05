/**
 * Push-gate policy resolution.
 *
 * Loads `.rea/policy.yaml` via the shared loader and flattens the subset the
 * gate cares about into a single `ResolvedReviewPolicy`. Env-var overrides
 * (`REA_SKIP_PUSH_GATE`, `REA_ALLOW_CONCERNS`) are NOT consumed here — the
 * gate composition in `./index.ts` inspects them directly after policy load
 * so the audit trail can distinguish "policy says skip" from "env says
 * skip". This module is pure policy.
 *
 * Defaults (when a field is absent or `review:` is missing entirely):
 *   - `codex_required`   → `true`    (safe-by-default: run Codex)
 *   - `concerns_blocks`  → `true`    (safe-by-default: concerns halt the push)
 *   - `timeout_ms`       → 1_800_000 (30 minutes — raised in 0.12.0 from the
 *                                     previous 10-minute default after the
 *                                     helixir migration session 2026-04-26
 *                                     showed realistic feature-branch
 *                                     reviews routinely exceeded 10 minutes
 *                                     on large diffs. Operators who pin
 *                                     `timeout_ms:` in policy.yaml are
 *                                     unaffected by this change.)
 *
 * A missing `.rea/policy.yaml` is treated as "defaults apply" — the
 * operator may not have run `rea init` yet, and the gate's behavior
 * should match the most protective stance available. The caller is free
 * to treat `policyMissing: true` as a doctor finding.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadPolicyAsync } from '../../policy/loader.js';
import type { Policy, ReviewPolicy } from '../../policy/types.js';

export interface ResolvedReviewPolicy {
  codex_required: boolean;
  concerns_blocks: boolean;
  timeout_ms: number;
  /**
   * When set, the gate resolves the diff base to `HEAD~N` (see Fix D in
   * 0.12.0). The CLI flag `--last-n-commits N` overrides this; the
   * policy key surfaces here as a runtime knob with the same effect.
   * `undefined` when unset (default-untouched behavior).
   */
  last_n_commits: number | undefined;
  /**
   * Auto-narrow threshold (J / 0.13.0). When the resolved diff base is more
   * than N commits behind HEAD AND no explicit narrowing was pinned, the
   * gate scopes to `PUSH_GATE_DEFAULT_LAST_N_COMMITS_FALLBACK` (10) and
   * emits a stderr warning. Defaults to 30 when unset; 0 disables.
   */
  auto_narrow_threshold: number;
  /**
   * Codex CLI model override (0.13.4+). When set, the runner passes
   * `-c model="<value>"` to every `codex exec review`. `undefined` falls
   * back to codex's own default (currently `codex-auto-review`, NOT the
   * flagship `gpt-5.4`).
   */
  codex_model: string | undefined;
  /**
   * Codex reasoning effort (0.13.4+). When set, the runner passes
   * `-c model_reasoning_effort="<value>"`. `undefined` falls back to
   * codex's own default (currently `medium`).
   */
  codex_reasoning_effort: 'low' | 'medium' | 'high' | undefined;
  /**
   * Verdict cache TTL in milliseconds (0.18.1+). `0` disables caching;
   * positive values enable the same-SHA short-circuit. Default 86_400_000
   * (24 hours) when policy.review.cache_ttl_ms is unset.
   */
  cache_ttl_ms: number;
  /**
   * 0.28.0 helix-029 — path-scoped finding filter. Gitignore-style
   * globs (anchored to repo root). Empty when no filter is active.
   * Includes both `policy.review.exclude_paths` AND, when
   * `auto_exclude_managed` is on, paths from `.rea/install-manifest.json`.
   * Resolved BEFORE the gate runs so the gate has a single list to
   * filter against.
   */
  exclude_paths: string[];
  /**
   * 0.28.0 helix-029 — true when the resolver pulled paths from
   * `.rea/install-manifest.json` into `exclude_paths`. Surfaced for
   * audit shape only; the gate filter consumes `exclude_paths`.
   */
  auto_exclude_managed: boolean;
  /** `true` when `.rea/policy.yaml` was absent; defaults apply. */
  policyMissing: boolean;
}

export const PUSH_GATE_DEFAULT_TIMEOUT_MS = 1_800_000;
export const PUSH_GATE_DEFAULT_CODEX_REQUIRED = true;
export const PUSH_GATE_DEFAULT_CONCERNS_BLOCKS = true;
/**
 * Default auto-narrow threshold (J / 0.13.0). When the divergence between
 * the resolved base and HEAD exceeds this count and the operator has not
 * pinned an explicit window, the gate auto-narrows to
 * `PUSH_GATE_DEFAULT_LAST_N_COMMITS_FALLBACK` commits.
 */
export const PUSH_GATE_DEFAULT_AUTO_NARROW_THRESHOLD = 30;
/**
 * Window the gate auto-narrows to when the threshold trips and the operator
 * has not pinned `policy.review.last_n_commits`. Conservative — small
 * enough that Codex review stays fast, large enough to capture meaningful
 * recent work.
 */
export const PUSH_GATE_DEFAULT_LAST_N_COMMITS_FALLBACK = 10;
/**
 * Default codex model for the push-gate (0.14.0+). Pinned to the flagship
 * (`gpt-5.4`) instead of falling through to codex's own default of
 * `codex-auto-review` (a lower-reasoning special-purpose model). Verdict
 * stability matters more than per-push compute cost for adversarial
 * review of consumer codebases — the helixir 2026-04-26 thrashing came
 * from the lower-reasoning default.
 *
 * Override via `policy.review.codex_model: <name>` in `.rea/policy.yaml`
 * for cost-bounded environments. `codex-auto-review` is the explicit
 * opt-in to the prior 0.13.x behavior.
 */
export const PUSH_GATE_DEFAULT_CODEX_MODEL = 'gpt-5.4';
/**
 * Default codex reasoning effort (0.14.0+). Pinned to `high` for maximum
 * compute per finding — fewer same-code-different-verdict round-trips.
 * Trades latency for stability. Override via
 * `policy.review.codex_reasoning_effort: medium | low` in
 * `.rea/policy.yaml` for cost-bounded environments.
 */
export const PUSH_GATE_DEFAULT_CODEX_REASONING_EFFORT: 'low' | 'medium' | 'high' = 'high';
/**
 * Default verdict-cache TTL in milliseconds (0.18.1+). 24 hours: long
 * enough to amortize multi-push iteration of the same SHA (push, push
 * --force-with-lease after a quick fixup, push again post-rebase),
 * short enough that a stale cache from yesterday doesn't suppress
 * review of code whose context (env, dependencies, .rea/policy.yaml)
 * has changed. Operators can shorten to a few minutes for tighter
 * loops or extend via `policy.review.cache_ttl_ms`. `0` disables
 * caching — every push re-invokes codex (pre-0.18.1 behavior).
 */
export const PUSH_GATE_DEFAULT_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

/**
 * Resolve the push-gate policy for `baseDir`. Never throws — a malformed
 * policy file surfaces as a typed error via the underlying zod validator,
 * which we re-raise. The gate's `runPushGate()` catches that and returns
 * `{ status: 'error', exitCode: 2 }` rather than silently bypassing.
 *
 * Returning a fully-populated object (no `undefined` knobs) means every
 * downstream module can treat the policy as total — no `?? default` dance
 * at each call site.
 */
export async function resolvePushGatePolicy(baseDir: string): Promise<ResolvedReviewPolicy> {
  const policyPath = path.join(baseDir, '.rea', 'policy.yaml');
  if (!fs.existsSync(policyPath)) {
    return {
      codex_required: PUSH_GATE_DEFAULT_CODEX_REQUIRED,
      concerns_blocks: PUSH_GATE_DEFAULT_CONCERNS_BLOCKS,
      timeout_ms: PUSH_GATE_DEFAULT_TIMEOUT_MS,
      last_n_commits: undefined,
      auto_narrow_threshold: PUSH_GATE_DEFAULT_AUTO_NARROW_THRESHOLD,
      codex_model: PUSH_GATE_DEFAULT_CODEX_MODEL,
      codex_reasoning_effort: PUSH_GATE_DEFAULT_CODEX_REASONING_EFFORT,
      cache_ttl_ms: PUSH_GATE_DEFAULT_CACHE_TTL_MS,
      exclude_paths: [],
      auto_exclude_managed: false,
      policyMissing: true,
    };
  }
  const policy: Policy = await loadPolicyAsync(baseDir);
  const review: ReviewPolicy = policy.review ?? {};
  // 0.28.0 helix-029 — derived default for auto_exclude_managed:
  // - true when `exclude_paths` is set AND the operator did not
  //   explicitly disable it
  // - false when `exclude_paths` is unset (no filter to compose)
  // - false when explicitly set to `false`
  const explicitGlobs = review.exclude_paths ?? [];
  const hasExplicitGlobs = explicitGlobs.length > 0;
  // Principal-engineer redesign: auto_exclude_managed is meaningful
  // only when the operator signaled intent via exclude_paths. A bare
  // `auto_exclude_managed: true` without globs is a no-op — the
  // operator is otherwise opting OUT of any filter. Default true when
  // exclude_paths is set; false when unset; explicit false always wins.
  const autoExcludeDefault = hasExplicitGlobs;
  const autoExcludeFlag = review.auto_exclude_managed ?? autoExcludeDefault;
  const autoExcludeActive = autoExcludeFlag && hasExplicitGlobs;
  let mergedExcludes: string[] = [...explicitGlobs];
  if (autoExcludeActive) {
    mergedExcludes = mergedExcludes.concat(readManifestPaths(baseDir));
  }
  // De-dupe — globs and manifest entries can overlap.
  mergedExcludes = Array.from(new Set(mergedExcludes));
  return {
    codex_required: review.codex_required ?? PUSH_GATE_DEFAULT_CODEX_REQUIRED,
    concerns_blocks: review.concerns_blocks ?? PUSH_GATE_DEFAULT_CONCERNS_BLOCKS,
    timeout_ms: review.timeout_ms ?? PUSH_GATE_DEFAULT_TIMEOUT_MS,
    last_n_commits: review.last_n_commits,
    auto_narrow_threshold: review.auto_narrow_threshold ?? PUSH_GATE_DEFAULT_AUTO_NARROW_THRESHOLD,
    codex_model: review.codex_model ?? PUSH_GATE_DEFAULT_CODEX_MODEL,
    codex_reasoning_effort:
      review.codex_reasoning_effort ?? PUSH_GATE_DEFAULT_CODEX_REASONING_EFFORT,
    cache_ttl_ms: review.cache_ttl_ms ?? PUSH_GATE_DEFAULT_CACHE_TTL_MS,
    exclude_paths: mergedExcludes,
    auto_exclude_managed: autoExcludeActive,
    policyMissing: false,
  };
}

/**
 * 0.28.0 helix-029 — read repo-relative paths from
 * `.rea/install-manifest.json` for the auto-exclude path. The manifest
 * shape is `{ files: { "<rel-path>": { sha256: ..., source: ... } } }`
 * (or similar). We pull only the keys (relative paths) and degrade to
 * an empty array on parse / shape errors — auto-exclude is best-effort,
 * never the gate's failure mode.
 */
function readManifestPaths(baseDir: string): string[] {
  const manifestPath = path.join(baseDir, '.rea', 'install-manifest.json');
  if (!fs.existsSync(manifestPath)) return [];
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return [];
    const obj = parsed as Record<string, unknown>;
    const candidates: unknown[] = [];
    // Common shapes: `{ files: {...} }` (object keyed by path), or
    // `{ files: [...] }` (array of strings or `{path: ...}`). Be
    // tolerant — the manifest format has shifted across rea minors.
    if (obj.files !== undefined) {
      if (Array.isArray(obj.files)) candidates.push(...obj.files);
      else if (typeof obj.files === 'object' && obj.files !== null) {
        candidates.push(...Object.keys(obj.files as Record<string, unknown>));
      }
    } else if (Array.isArray(obj)) {
      candidates.push(...obj);
    }
    const out: string[] = [];
    for (const c of candidates) {
      const candidate = typeof c === 'string'
        ? c
        : typeof c === 'object' && c !== null && typeof (c as Record<string, unknown>).path === 'string'
          ? ((c as Record<string, unknown>).path as string)
          : '';
      if (candidate.length === 0) continue;
      // 0.28.0 codex round-1 P1: manifest entries are LITERAL paths to
      // managed files written by `rea init`. They are NEVER glob
      // patterns. Reject any entry containing glob metachars to prevent
      // a manifest like `{"files":["**"]}` from suppressing every
      // finding via the auto_exclude_managed code path. Fail closed —
      // a tampered manifest entry is dropped, never trusted as a glob.
      if (/[*?\[\]!]/.test(candidate)) continue;
      out.push(candidate);
    }
    return out;
  } catch {
    return [];
  }
}
