/**
 * `rea init` self-pin (0.49.0).
 *
 * # Problem
 *
 * `rea init` writes hook shims under `.claude/hooks/` that depend on the
 * `@bookedsolid/rea` CLI being resolvable from `node_modules/`. The
 * pre-0.49.0 init flow did NOT add the dep to the consumer's
 * `package.json`, so any fresh clone + `pnpm install` produced a repo
 * where the shims found no CLI and (correctly) refused every Bash
 * call — including the very `pnpm add -D @bookedsolid/rea` that would
 * recover the install. The bash-gate bootstrap allowlist (Fix B) is the
 * paired safety net; this module is the structural fix.
 *
 * # Contract
 *
 * - Caret-pinned (`^<current-CLI-version>`) entry in `devDependencies`.
 * - Lands in workspace ROOT `package.json`. Walks up from `targetDir`
 *   until a `package.json` is found; refuses to mutate a parent that
 *   the operator did not explicitly target (we only mutate when the
 *   FIRST `package.json` we find IS the target).
 * - Existing different version: warn + skip (do NOT mutate). The
 *   operator owns their pin.
 * - Idempotent: re-runs are byte-identical when the pin already
 *   matches. Detects and preserves indent / EOL / trailing-newline so
 *   no spurious diff churn lands in the consumer's repo.
 * - Dogfood short-circuit: when the consumer's `pkg.name` is
 *   `@bookedsolid/rea` itself, skip silently — the dogfood install
 *   pins the version via the build, not via the manifest.
 *
 * # Why caret
 *
 * A caret pin (`^0.49.0` → satisfies 0.49.x AND 0.50.0+) gives
 * consumers automatic minor-version uptake without breaking when the
 * shim ABI bumps. Major bumps remain a deliberate operator action.
 *
 * # Why warn-and-skip on existing different version
 *
 * Three scenarios where this matters:
 *
 *   1. Operator explicitly pinned an exact version (`"0.48.1"`) for
 *      reproducibility — `rea init` overwriting that to caret would
 *      silently widen their pin.
 *   2. Operator is running an OLDER `rea init` against a `package.json`
 *      that has a NEWER `rea` pin. Downgrading the pin would brick the
 *      install once the operator's lockfile resolves against it.
 *   3. Operator deliberately pinned a workspace-relative path (`"workspace:^"`,
 *      `"file:../rea"`). Replacing that with a registry pin breaks the
 *      monorepo wiring.
 *
 * Warn-and-skip preserves operator intent in all three cases.
 */

import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

import semver from 'semver';

/** Package name we self-pin. */
export const REA_PACKAGE_NAME = '@bookedsolid/rea';

export interface SelfPinResult {
  /**
   * Outcome of the operation. Single value so the caller can format a
   * one-line console message uniformly.
   *
   *   - `'wrote'`     — package.json was mutated (new dep added OR an
   *                      existing matching pin re-serialized identically).
   *   - `'bumped'`    — `mode: 'upgrade'` only. Existing pin was a
   *                     managed-caret form on the SAME major as the new
   *                     CLI but did not admit the new minor (e.g.
   *                     `^0.49.0` + new CLI `0.50.0` — `^0.49.0` rejects
   *                     `0.50.0` because pre-1.0 caret behaves like
   *                     tilde). We re-write the pin to the new caret
   *                     form. Operator-facing message includes the
   *                     "bumped from X to Y" delta so the change is
   *                     visible in the upgrade log.
   *   - `'skipped-same'` — the existing pin already matches what we
   *                        would write (idempotent re-run, byte-identical).
   *   - `'skipped-different'` — the existing pin differs from ours and
   *                              we refuse to mutate (operator owns the pin).
   *   - `'skipped-dogfood'` — `pkg.name === '@bookedsolid/rea'`, the
   *                            self-host case; we never self-pin.
   *   - `'skipped-no-package-json'` — no `package.json` in the explicit
   *                                    target directory. P2-4: we never
   *                                    walk upward — invocation from a
   *                                    pkg-less subdir refuses rather
   *                                    than silently mutating the parent.
   *   - `'skipped-malformed-package-json'` — `package.json` exists but
   *                                           is not valid JSON or not an
   *                                           object; we refuse to mutate
   *                                           a file we do not understand.
   *   - `'skipped-symlink-package-json'` — R10-P2 (codex round 10):
   *                                          `package.json` is a symlink.
   *                                          DRY-RUN only — live mode
   *                                          THROWS rather than returning
   *                                          this. The skip-shape exists
   *                                          so `rea upgrade --dry-run`
   *                                          / `--check` can complete a
   *                                          preview even when the
   *                                          symlink would block the
   *                                          live run.
   *   - `'skipped-global-default'` — 0.53.0 GLOBAL-FIRST default. No existing
   *                                   pin AND `--pin` was NOT passed. `rea init`
   *                                   / `rea upgrade` no longer self-pin by
   *                                   default: the global rea CLI tier governs,
   *                                   so no local dep is written. This is the
   *                                   ordinary healthy state, not a problem.
   *   - `'skipped-global-tier-trusted'` — 0.53.0. Same "no pin written"
   *                                        outcome as `skipped-global-default`,
   *                                        but the caller additionally CONFIRMED
   *                                        the checkout is trusted in the
   *                                        global-tier registry
   *                                        (`options.trustedGlobalTier`). Purely
   *                                        a messaging distinction — the print
   *                                        ladder can say "trusted" rather than
   *                                        the generic default line.
   */
  action:
    | 'wrote'
    | 'bumped'
    | 'skipped-same'
    | 'skipped-different'
    | 'skipped-dogfood'
    | 'skipped-no-package-json'
    | 'skipped-malformed-package-json'
    | 'skipped-symlink-package-json'
    | 'skipped-global-default'
    | 'skipped-global-tier-trusted';
  /** Absolute path to the package.json we resolved (or null when none found). */
  packageJsonPath: string | null;
  /** Caret-pinned version range we wrote (e.g. `^0.49.0`). Empty when no write happened. */
  pinnedRange: string;
  /** Existing range when the action was `skipped-different`. */
  existingRange?: string;
  /** Operator-facing message (one line, no newline). */
  message: string;
}

export interface SelfPinOptions {
  /**
   * Starting directory for the upward `package.json` walk. The walk
   * stops at the first `package.json` found OR at the filesystem root.
   */
  cwd: string;
  /**
   * The currently-running `@bookedsolid/rea` CLI version (e.g.
   * `'0.49.0'`). The written pin is `^<version>`.
   */
  cliVersion: string;
  /**
   * When true, never log to stderr — the caller will surface the result
   * structurally. Used by `rea upgrade` which composes its own output.
   */
  silent?: boolean;
  /**
   * R3-P2 (codex round 3): when true, perform the read + decision
   * logic but skip the on-disk write. The returned `action`
   * discriminant is the SAME as the live run would produce
   * (`'wrote'`, `'bumped'`, `'skipped-same'`, `'skipped-different'`,
   * etc.) so the caller can preview exactly what the live run will
   * do. `message` carries a `would-` prefix on the actions that
   * would have mutated the file (`wrote` / `bumped`) so the caller's
   * console output is unambiguous.
   *
   * Pre-fix, `rea upgrade --dry-run` short-circuited around the entire
   * `selfPinRea` call, hiding the planned self-pin action from the
   * dry-run preview. Operators ran dry-run, saw zero pin-related
   * lines, then ran the live upgrade and got a surprise mutation of
   * their package.json.
   *
   * Default: `false` (write path active — preserves existing behavior
   * for every caller that does not opt in).
   */
  dryRun?: boolean;
  /**
   * Call-site discriminator (P1-1 / codex round 2).
   *
   *   - `'init'` (default) — `rea init` semantics: warn-and-skip on every
   *      existing-different-version pin. Respects whatever pin the
   *      operator already chose; we never overwrite on a fresh install.
   *
   *   - `'upgrade'` — `rea upgrade` semantics: when the existing pin is
   *      a managed-caret form (a caret pin we previously wrote, with no
   *      operator-authored shape laundering) AND the new CLI is on the
   *      SAME major as the existing pin AND the existing caret does NOT
   *      admit the new CLI version, BUMP the pin to the new caret. This
   *      closes the pre-1.0 caret tightness trap: `^0.49.0` does NOT
   *      admit `0.50.0` (pre-1.0 caret is npm-spec'd to behave like
   *      tilde), so without auto-bump a 0.49.x → 0.50.x upgrade would
   *      copy the newer hooks but leave the old CLI pinned, recreating
   *      the hook/CLI skew this whole feature exists to prevent.
   *
   *      Auto-bump shape gate: existing range matches a strict managed-
   *      caret regex (`^\^\d+\.\d+(\.\d+)?(-prerelease)?$`). Anything
   *      else (`workspace:*`, `file:..`, git URLs, `next`, exact pins,
   *      tildes, complex ranges) is operator-authored and we hands-off.
   *      Cross-major bumps (`^0.x` → `1.x` or `^1.x` → `0.x`) are
   *      ALSO operator-authored decisions and we hands-off — major
   *      changes are meaningful and should not be silent.
   *
   * Default: `'init'`. R13-P1 (codex round 13) update: BOTH the
   * `rea init` and `rea upgrade` call sites now pass `mode:
   * 'upgrade'` explicitly. The R11-P1 preflight (init) +
   * R9-P1 preflight (upgrade) filter out non-managed-caret cases
   * BEFORE `selfPinRea` runs, so the only thing that reaches the
   * write path is either a fresh write OR a managed-caret bump —
   * and `mode: 'upgrade'` is the correct semantics for both.
   *
   * The `'init'` default is preserved for backwards-compat with any
   * external caller of this exported function. New rea-internal
   * call sites should pass `mode: 'upgrade'` explicitly.
   */
  mode?: 'init' | 'upgrade';
  /**
   * 0.53.0 GLOBAL-FIRST — OPT-IN to a hermetic local pin. When `true` AND
   * there is NO existing pin, `selfPinRea` writes `^<cliVersion>` into
   * `devDependencies` (the pre-0.53.0 behavior). When `false`/omitted (the
   * DEFAULT), no pin is written — the global rea CLI tier governs and a local
   * dep is neither needed nor recommended.
   *
   * `--pin` on `rea init` / `rea upgrade` sets this. NARROWNESS: `pin` only
   * affects the no-existing-pin branch (write vs skip). An existing pin is
   * still operator-owned and handled by the skip-same / managed-caret-bump /
   * skip-different branches above regardless of this flag. Default: `false`.
   */
  pin?: boolean;
  /**
   * 0.53.0 — the CALLER determined this is a TRUSTED global-tier checkout:
   * `realpath(cwd)` is a member of `<home>/.rea/trusted-projects`, the global
   * rea CLI tier resolves, and `runtime.allow_global_cli` is not vetoed by
   * policy. (The caller computes this via the shared `resolveGlobalCliTier`
   * predicate — the SAME one `rea doctor` renders — so the scaffolders and
   * doctor never disagree about what "trusted global-tier" means.)
   *
   * Under global-first this is PURELY a messaging signal: on the no-pin
   * default branch it selects `skipped-global-tier-trusted` (confirmed
   * trusted) over the generic `skipped-global-default`. It does NOT gate
   * whether a pin is written — the `pin` flag does that. Kept as a separate
   * signal so `rea doctor` and the install summary can report trust status.
   *
   * The trust/home I/O is kept in the caller so this module stays pure and
   * injectable — no `~/.rea` reads happen here. Default: `false`.
   */
  trustedGlobalTier?: boolean;
}

interface FileShape {
  /** Detected indent (spaces). 2 by default; we sniff existing content. */
  indent: number;
  /** Detected EOL — '\n' or '\r\n'. */
  eol: '\n' | '\r\n';
  /** Whether the original file ended with a trailing newline. */
  trailingNewline: boolean;
}

interface PackageJsonShape {
  raw: string;
  /** Parsed JSON. Always an object — caller's responsibility to refuse non-objects. */
  parsed: Record<string, unknown>;
  shape: FileShape;
}

/**
 * Look for `package.json` in the explicit target directory ONLY. No upward
 * walk.
 *
 * P2-4 (codex round 1 / locked design): the architect's "pin lands in
 * workspace root package.json (refuse to mutate parent the operator did
 * not explicitly target)" rule is implemented here as a hard refusal to
 * walk past `start`. Earlier revisions walked upward up to 64 directories
 * — that meant `rea init` invoked from a workspace subdirectory (e.g.
 * `apps/web/`) with no `package.json` of its own would silently land on
 * the monorepo root's manifest and mutate it. That violates the locked
 * intent: the operator picked the cwd; if there's no `package.json`
 * there, we refuse rather than guessing which parent to touch.
 *
 * Concretely:
 *   - `apps/web/` with no package.json → return `null`, caller maps to
 *     `skipped-no-package-json` (operator-facing message says
 *     "no package.json in the target directory").
 *   - `apps/web/` with its own package.json → pin there.
 *   - Monorepo root with package.json → pin there.
 *
 * The walk-up semantics also applied to `checkSelfPinDeclaredSync` (the
 * doctor brick-state detector). Same tightening — doctor reports the
 * absence rather than scanning the parent chain. Operators who want
 * doctor to validate a parent's pin run `rea doctor` from that parent.
 */
function findPackageJson(start: string): string | null {
  const cur = path.resolve(start);
  const candidate = path.join(cur, 'package.json');
  if (fsSync.existsSync(candidate)) return candidate;
  return null;
}

/**
 * Detect indent / EOL / trailing-newline so re-serialization preserves
 * the operator's existing formatting verbatim. JSON.stringify with a
 * numeric `space` argument always emits `\n` separators, so we
 * post-process to apply CRLF when the source used it.
 */
function detectShape(raw: string): FileShape {
  // EOL: take the first newline pair we encounter. Default to LF.
  let eol: '\n' | '\r\n' = '\n';
  const lf = raw.indexOf('\n');
  if (lf > 0 && raw[lf - 1] === '\r') eol = '\r\n';

  // Indent: find the first line that begins with a space-or-tab and
  // count the leading whitespace. Falls back to 2 (the package.json
  // convention) when the file has no nested indentation visible.
  let indent = 2;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const m = /^(\t+|[ ]+)\S/.exec(line);
    if (!m) continue;
    const ws = m[1] ?? '';
    if (ws.startsWith('\t')) {
      indent = 1; // tab-indented; JSON.stringify will use `\t` when we pass it directly
    } else {
      indent = ws.length;
    }
    break;
  }
  // Clamp to a sensible range. 0 indent (single-line JSON) is preserved
  // by the caller — we don't re-serialize when no change is needed.
  if (indent < 1 || indent > 8) indent = 2;

  const trailingNewline = raw.endsWith('\n');

  return { indent, eol, trailingNewline };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Strip a leading UTF-8 BOM (U+FEFF / EF BB BF) from a string, returning the
 * rest. No-op when no BOM is present.
 *
 * Some Windows operators commit `package.json` with a leading BOM; `JSON.parse`
 * rejects it (the spec says JSON.parse must error on a leading BOM). We
 * silently strip it before parse — npm and pnpm both tolerate either form
 * when writing back, so dropping the BOM on save is the simpler, more
 * invariant choice. The alternative (detect-and-preserve) would need an
 * extra field on `FileShape` plus a re-prepend in `serialize`, and the cost
 * (one operator who deliberately wanted a BOM no longer has one) is much
 * lower than the cost of an unrecoverable false-positive
 * `skipped-malformed-package-json` on every BOM-bearing manifest.
 *
 * P3-1 (codex round 1): extracted into a shared helper so the same canonical
 * BOM-strip applies to BOTH `readPackageJson` (the write path used by
 * `selfPinRea`) AND `checkSelfPinDeclaredSync` (the doctor brick-state
 * detector). Pre-extraction, only the write path stripped — doctor would
 * report `fail-malformed` for a BOM-prefixed manifest that self-pin
 * tolerated fine, which is the asymmetric-fix class we explicitly want
 * to defend against.
 */
export function stripUtf8Bom(input: string): string {
  if (input.length > 0 && input.charCodeAt(0) === 0xfeff) {
    return input.slice(1);
  }
  return input;
}

/**
 * R10-P2 (codex round 10 / 0.49.0) — refuse symlinked `package.json`.
 *
 * Writing the rea pin through a `package.json` that is itself a
 * symlink would silently mutate the target — typically a workspace-
 * root or sibling-checkout manifest the operator did not explicitly
 * target. R2-P4 established "don't mutate a parent the operator did
 * not target"; symlink-follow is the same security class. We refuse
 * pre-emptively with an operator-actionable message.
 *
 * The check uses `lstat` (NOT `stat`) so the symlink itself is
 * observed, not its target. Returns:
 *   - `'ok'`           — regular file or path doesn't exist (the
 *                        non-existence case is left for the caller's
 *                        existing "no package.json" handling).
 *   - `'symlink'`      — the path IS a symlink. Caller should refuse.
 *   - `'lstat-error'`  — permission denied / EIO / etc. Caller
 *                        decides; we err on the side of "ok" so
 *                        existing not-found semantics still work
 *                        (caller's read will fail with the same
 *                        error and be handled by the existing path).
 */
type PackageJsonShapeCheck = 'ok' | 'symlink' | 'lstat-error';

function checkPackageJsonShapeSync(pkgPath: string): PackageJsonShapeCheck {
  let lst: fsSync.Stats;
  try {
    lst = fsSync.lstatSync(pkgPath);
  } catch (e) {
    // ENOENT is fine — caller handles missing pkg.json with its own
    // logic. Any other error: treat as 'lstat-error' so the caller
    // can fall through to existing read paths (which will surface
    // the same error in a context-appropriate way).
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'ok';
    return 'lstat-error';
  }
  if (lst.isSymbolicLink()) return 'symlink';
  return 'ok';
}

async function checkPackageJsonShape(pkgPath: string): Promise<PackageJsonShapeCheck> {
  let lst: fsSync.Stats;
  try {
    lst = await fs.lstat(pkgPath);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return 'ok';
    return 'lstat-error';
  }
  if (lst.isSymbolicLink()) return 'symlink';
  return 'ok';
}

/**
 * Build the operator-facing refusal message for a symlinked
 * package.json. Pulled out as a helper so `selfPinRea` (throws),
 * `checkUpgradeBlockingPin` (returns block), and
 * `checkSelfPinDeclaredSync` (returns fail-symlink) all surface
 * IDENTICAL wording. Drift between these three surfaces would
 * confuse operators reading the same diagnostic at different layers.
 */
function buildSymlinkRefusalMessage(pkgPath: string): string {
  return (
    `rea self-pin refusing: ${pkgPath} is a symlink. ` +
    `Writing through it would mutate a file outside the requested ` +
    `project tree (the symlink's target). ` +
    `To reconcile, either replace the symlink with a regular ` +
    `package.json or run rea init/upgrade in the target directory ` +
    `the symlink points to.`
  );
}

async function readPackageJson(pkgPath: string): Promise<PackageJsonShape | null> {
  let raw: string;
  try {
    raw = await fs.readFile(pkgPath, 'utf8');
  } catch {
    return null;
  }
  // P2-3 (codex round 1): strip leading UTF-8 BOM. The original bytes
  // tracked in `raw` go forward without the BOM so `detectShape` does
  // not have to special-case its leading-whitespace scans either.
  raw = stripUtf8Bom(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  return { raw, parsed, shape: detectShape(raw) };
}

/**
 * Format a JS object back to a JSON string honoring the detected shape.
 * Always uses spaces (JSON.stringify's `space` argument). Trailing
 * newline is restored if the original carried one.
 *
 * Indent semantics: pass the indent count directly to JSON.stringify.
 * When the source was tab-indented (`indent === 1` per detectShape's
 * conversion above) we still emit spaces — JSON.stringify only supports
 * a string or a positive integer for indent, and supporting tabs would
 * require post-processing every indent run. The cost (one operator who
 * tabs their package.json sees a one-time switch to spaces) is lower
 * than the risk of indent-conversion bugs.
 */
/**
 * Managed-caret pin shape (P1-1 / codex round 2).
 *
 * Matches what `selfPinRea` itself writes — a caret prefix followed by
 * a 2- or 3-segment semver, with optional `-prerelease` tail. Anything
 * NOT matching this shape is treated as operator-authored and
 * `mode: 'upgrade'` will hands-off rather than bump.
 *
 * Examples that MATCH (rea-managed):
 *   `^0.49.0`, `^0.49`, `^1.0.0`, `^1.2.3-beta.1`
 *
 * Examples that DO NOT MATCH (operator-authored, hands-off):
 *   `workspace:^`, `workspace:*`, `file:../rea`, `git+https://...`,
 *   `next`, `latest`, `0.49.0` (exact pin), `~0.49.0` (tilde),
 *   `>=0.49.0 <0.50.0` (range), `0.49.x` (x-range), `^0.49.0 || ^0.48.0`.
 *
 * R4-P2 (codex round 4): the per-shape "is this a managed pin?" gate
 * is still our own regex (semver doesn't have a "did rea write this?"
 * concept — operator-authored carets like `^1.2.3` would also satisfy
 * any semver-only shape gate, and we explicitly don't want to bump
 * those without an audit-traceable rea-managed marker). The
 * VERSION-SATISFIES decision uses `semver.satisfies` so prerelease
 * upgrades are handled correctly: a non-prerelease range like
 * `^0.49.0` does NOT satisfy `0.49.1-beta.0` (npm spec excludes
 * prereleases from non-prerelease ranges); the pre-fix predicate
 * compared major/minor only and treated this as already-covered,
 * leaving the pin pointing at the older CLI when newer hooks shipped.
 */
const MANAGED_CARET_RE =
  /^\^(\d+)\.(\d+)(?:\.(\d+))?(?:-[A-Za-z0-9.+-]+)?$/;

/**
 * Extract the major version number from a managed-caret range string,
 * or null when the input is not a managed-caret shape (in which case
 * the caller hands off — operator-authored).
 */
function managedCaretMajor(range: string): number | null {
  const m = MANAGED_CARET_RE.exec(range);
  if (m === null || m[1] === undefined) return null;
  return Number(m[1]);
}

/**
 * Decide whether `rea upgrade` should auto-bump an existing pin to the
 * newly-written caret. Returns `true` only when:
 *
 *   1. `existing` matches the managed-caret shape (we wrote it; it
 *      isn't a workspace/file/git/tag/exact pin).
 *   2. `newRange` ALSO matches the managed-caret shape (sanity — the
 *      function should never be called with a non-caret target, but
 *      the predicate stays self-contained).
 *   3. Both ranges share the same major version. Cross-major bumps
 *      are intentional operator decisions and we hands-off.
 *   4. The existing caret does NOT already admit the version the new
 *      range would resolve to. We extract the floor version from
 *      `newRange` (strip the leading `^`) and ask
 *      `semver.satisfies(floor, existing)`:
 *
 *        - `^0.49.0` + `^0.49.5` → 0.49.5 satisfies ^0.49.0 → NO bump
 *        - `^0.49.0` + `^0.50.0` → 0.50.0 does NOT satisfy → BUMP
 *        - `^0.49.0` + `^0.49.1-beta.0` → prerelease does NOT satisfy
 *          a non-prerelease range (npm spec) → BUMP (R4-P2)
 *        - `^1.0.0` + `^1.5.0` → 1.5.0 satisfies ^1.0.0 → NO bump
 *        - `^1.0.0` + `^1.1.0-beta.0` → prerelease does NOT satisfy
 *          → BUMP (R4-P2)
 *
 * The pre-fix predicate compared major/minor by hand, which
 * mis-classified prerelease bumps as already-covered. Switching to
 * `semver.satisfies` gives us npm-spec-correct semver behavior in
 * one place.
 */
export function shouldBumpManagedCaret(existing: string, newRange: string): boolean {
  const existingMajor = managedCaretMajor(existing);
  if (existingMajor === null) return false;
  const newMajor = managedCaretMajor(newRange);
  if (newMajor === null) return false;
  if (existingMajor !== newMajor) return false;
  // Extract the version floor from the new range. `^X.Y.Z` floor is
  // exactly `X.Y.Z` (with optional prerelease tail). Strip the `^`;
  // semver.satisfies handles the rest. We do not use `semver.minVersion`
  // here because for prerelease shapes (`^0.49.1-beta.0`) its result
  // is `0.49.1-beta.0` — same as a manual strip — but for our managed
  // shape the strip is unambiguous and avoids the cross-version
  // semver quirks.
  const newFloor = newRange.startsWith('^') ? newRange.slice(1) : newRange;
  // Coerce-via-parse to validate the floor is a real semver; if not,
  // we cannot reason about it and hands-off.
  if (semver.valid(newFloor) === null) return false;
  // R9-P1 (codex round 9 / 0.49.0): hands-off on downgrades. The
  // managed-caret bump is an UPGRADE primitive — when the existing
  // caret pins a HIGHER floor than the new CLI version, the operator
  // explicitly pinned newer-than-us (deliberate forward pin) and we
  // must not silently rewrite their pin DOWN to an older floor. The
  // R9-P1 abort gate in `runUpgrade` handles this case separately:
  // it sees `shouldBumpManagedCaret = false` AND `existing range
  // does not admit new CLI`, then blocks the upgrade with a clear
  // operator-actionable message rather than silently downgrading.
  const existingFloor = existing.startsWith('^') ? existing.slice(1) : existing;
  if (semver.valid(existingFloor) !== null && semver.lt(newFloor, existingFloor)) {
    return false;
  }
  // `includePrerelease: false` is semver's default and what we want:
  // a non-prerelease range like `^0.49.0` does NOT include
  // `0.49.1-beta.0`, so the !satisfies branch correctly returns true
  // and we bump.
  return !semver.satisfies(newFloor, existing);
}

/**
 * R9-P1 (codex round 9 / 0.49.0) — `rea upgrade` blocking-pin check.
 *
 * # Why this exists
 *
 * `rea init` and `rea upgrade` write the consumer's `.rea/policy.yaml`
 * with the new `bootstrap_allowlist:` top-level key (added in 0.49.0).
 * `src/policy/loader.ts::PolicySchema` is `.strict()` — older CLIs
 * (≤ 0.48.x) cannot parse a policy file with that key and throw on
 * load. So if `rea upgrade` writes 0.49 hooks + policy artifacts on
 * top of a `package.json` that still pins an OLD `@bookedsolid/rea`
 * version, the hooks resolve the OLD CLI from `node_modules/` on the
 * next fire and that CLI refuses every payload (policy.yaml strict
 * parse fails). The seemingly-successful upgrade leaves the consumer
 * with non-functional gates.
 *
 * R2-P1-1 closed the managed-caret-bump case (we write the new pin in
 * place). R9-P1 closes the gap for EVERY other shape: workspace:*,
 * file:.., git URLs, dist-tags like `next`, exact pins like `0.48.0`,
 * and managed-caret-cross-major. The fix: abort the upgrade BEFORE
 * any artifacts hit disk when the existing pin would not admit the
 * new CLI version.
 *
 * # Contract
 *
 * Returns a discriminated result:
 *
 *   - `kind: 'ok'`              — proceed with upgrade. Either:
 *       * no existing pin (will write fresh), OR
 *       * existing pin admits the new CLI version (semver.satisfies), OR
 *       * existing pin is a managed-caret that bumps cleanly (R2-P1-1).
 *   - `kind: 'no-pkg-json'`     — no package.json in cwd; proceed.
 *       `selfPinRea` will return `skipped-no-package-json` later.
 *   - `kind: 'malformed-pkg-json'` — same; `selfPinRea` will return
 *       `skipped-malformed-package-json` later.
 *   - `kind: 'dogfood'`         — pkg.name === '@bookedsolid/rea';
 *       proceed (dogfood install never mutates the manifest).
 *   - `kind: 'block'`           — existing pin won't admit the new
 *       CLI; the caller MUST abort before writing artifacts.
 *       Carries the operator-facing reason string.
 *
 * # Why a separate function?
 *
 * `selfPinRea` is the WRITE-path helper. `checkUpgradeBlockingPin` is
 * a READ-only preflight that gives the caller a yes/no answer before
 * any disk mutation. We do NOT fold the abort logic into `selfPinRea`
 * because:
 *   1. Other callers of `selfPinRea` (rea init) want the warn-and-skip
 *      posture, not abort.
 *   2. The upgrade entry needs to run this check BEFORE the canonical
 *      file-write loop, well upstream of the existing `selfPinRea`
 *      invocation.
 *   3. Keeping the check stateless and read-only makes it testable in
 *      isolation without filesystem side effects beyond reading
 *      package.json (and even those are bounded — single read).
 */
export type UpgradeBlockingPinCheckResult =
  | { kind: 'ok'; packageJsonPath: string | null; existingRange?: string | undefined }
  | { kind: 'no-pkg-json' }
  | { kind: 'malformed-pkg-json'; packageJsonPath: string }
  | { kind: 'dogfood'; packageJsonPath: string }
  | {
      kind: 'block';
      packageJsonPath: string;
      existingRange: string;
      newCliVersion: string;
      newPinnedRange: string;
      reason: string;
    }
  // R10-P2 (codex round 10): package.json is a symlink. Writing
  // through it would mutate a file outside the requested project
  // tree. The shape here mirrors `'block'` so the caller's existing
  // refuse-on-block path (throw with `reason`) handles both
  // uniformly — only the `kind` discriminant differs.
  | {
      kind: 'block-symlink';
      packageJsonPath: string;
      newCliVersion: string;
      newPinnedRange: string;
      reason: string;
    };

export interface UpgradeBlockingPinCheckOptions {
  cwd: string;
  cliVersion: string;
  /**
   * R11-P1 (codex round 11): which call site is invoking the
   * pre-flight. The check logic is identical for both modes — what
   * changes is the operator-facing message prefix:
   *
   *   - `'upgrade'` (default) → `rea upgrade refusing: ...`
   *   - `'init'`              → `rea init refusing: ...`
   *
   * Both `runInit` and `runUpgrade` write the same 0.49 hooks +
   * policy artifacts, so the skew-creation risk is identical and
   * the pre-flight needs to fire on both surfaces. Pre-R11 the
   * pre-flight was upgrade-only; `rea init` on an existing-install
   * scenario could still leave the bash gates non-functional.
   */
  mode?: 'init' | 'upgrade';
}

/**
 * Determine whether the existing `@bookedsolid/rea` pin would block
 * `rea init` / `rea upgrade` from writing 0.49 artifacts safely.
 * See type doc.
 *
 * R11-P1 (codex round 11): the check applies to BOTH `rea init` and
 * `rea upgrade`. The implementation is unchanged; only the
 * operator-facing message prefix varies with `mode`.
 */
export async function checkUpgradeBlockingPin(
  options: UpgradeBlockingPinCheckOptions,
): Promise<UpgradeBlockingPinCheckResult> {
  const newCliVersion = options.cliVersion;
  const newPinnedRange = `^${newCliVersion}`;
  const cmdName = options.mode === 'init' ? 'rea init' : 'rea upgrade';

  const pkgPath = findPackageJson(options.cwd);
  if (pkgPath === null) return { kind: 'no-pkg-json' };

  // R10-P2 (codex round 10): symlink check BEFORE `readPackageJson`
  // so the parser never touches the symlink target. Even on the
  // read-only preview path, surfacing this as a block is the right
  // signal to the operator — `selfPinRea`'s write path would throw
  // moments later anyway, and the upgrade preflight needs to refuse
  // before any artifact-writing step.
  if (checkPackageJsonShapeSync(pkgPath) === 'symlink') {
    return {
      kind: 'block-symlink',
      packageJsonPath: pkgPath,
      newCliVersion,
      newPinnedRange,
      reason: buildSymlinkRefusalMessage(pkgPath),
    };
  }

  const pkg = await readPackageJson(pkgPath);
  if (pkg === null) return { kind: 'malformed-pkg-json', packageJsonPath: pkgPath };

  if (pkg.parsed['name'] === REA_PACKAGE_NAME) {
    return { kind: 'dogfood', packageJsonPath: pkgPath };
  }

  const deps = isPlainObject(pkg.parsed['dependencies']) ? pkg.parsed['dependencies'] : null;
  const devDeps = isPlainObject(pkg.parsed['devDependencies'])
    ? pkg.parsed['devDependencies']
    : null;
  const existingDep =
    deps !== null && typeof deps[REA_PACKAGE_NAME] === 'string'
      ? (deps[REA_PACKAGE_NAME] as string)
      : undefined;
  const existingDevDep =
    devDeps !== null && typeof devDeps[REA_PACKAGE_NAME] === 'string'
      ? (devDeps[REA_PACKAGE_NAME] as string)
      : undefined;

  // Authoritative pin (matches `selfPinRea`'s precedence).
  const existing = existingDep ?? existingDevDep;
  if (existing === undefined) {
    return { kind: 'ok', packageJsonPath: pkgPath };
  }

  // Exact match — pin already at the new version. No skew possible.
  if (existing === newPinnedRange) {
    return { kind: 'ok', packageJsonPath: pkgPath, existingRange: existing };
  }

  // Managed-caret bumpable — `selfPinRea` will rewrite the pin in
  // place; no skew once the upgrade completes.
  if (shouldBumpManagedCaret(existing, newPinnedRange)) {
    return { kind: 'ok', packageJsonPath: pkgPath, existingRange: existing };
  }

  // Does the existing pin admit the new CLI version?
  //   - Pin is a valid semver range AND semver.satisfies(newCliVersion, existing)
  //     → ok (e.g. `^0.49.0` admits `0.49.5`).
  //   - Pin is NOT a valid semver range (workspace:*, file:.., git URL,
  //     dist-tag like `next`) → semver.validRange returns null →
  //     we cannot statically determine admittance → block on uncertainty.
  //     The operator can re-run after editing the manifest.
  let admits = false;
  if (semver.validRange(existing) !== null) {
    admits = semver.satisfies(newCliVersion, existing);
  }
  if (admits) {
    return { kind: 'ok', packageJsonPath: pkgPath, existingRange: existing };
  }

  // Build the operator-facing reason. Customize the third bullet for
  // workspace / file / git / tag shapes — those need a workspace-
  // specific fix path.
  const isWorkspacePin = existing.startsWith('workspace:');
  const isFilePin = existing.startsWith('file:');
  const isGitPin =
    existing.startsWith('git') ||
    existing.startsWith('github:') ||
    existing.startsWith('gitlab:') ||
    existing.startsWith('bitbucket:') ||
    /^https?:\/\//.test(existing);
  const isLooksDistTag =
    semver.validRange(existing) === null && !isWorkspacePin && !isFilePin && !isGitPin;

  const lines: string[] = [
    `${cmdName} refusing: package.json pins ${REA_PACKAGE_NAME} to "${existing}"`,
    `which does not admit the installed CLI version ${newCliVersion}.`,
    '',
    `Writing ${newCliVersion} hooks/policy artifacts now would create a hook/CLI skew:`,
    `your shims would resolve the older CLI from node_modules, which cannot`,
    `parse the new policy.yaml schema (strict).`,
    '',
    // R12-P2 (codex round 12): recommend the bare-spec form. The
    // CLI-missing bootstrap allowlist (hooks/_lib/bootstrap-allowlist.sh)
    // accepts ONLY `pnpm add -D @bookedsolid/rea` — bare. Version-
    // pinned `@bookedsolid/rea@^X.Y.Z` forms are REFUSED at the bash
    // gate (R6-P2 lock — security: prevents attacker version-pin
    // downgrade in the CLI-missing state). If we recommended the
    // version-pinned form here, agents running the diagnostic-
    // suggested command would loop forever — the bash gate refuses
    // the very recovery command we printed. The bare-spec form
    // installs the latest version matching the consumer's existing
    // constraint (or absolute latest if no constraint); a follow-up
    // `${cmdName}` then runs the managed-caret bump (R2-P1-1) to
    // set the canonical pin under audit.
    'To reconcile, choose one:',
    `  1. pnpm add -D ${REA_PACKAGE_NAME}     (installs latest within range,`,
    `                                  then re-run: ${cmdName})`,
    `  2. Edit package.json to pin a version that admits ${newCliVersion},`,
    '     then: pnpm install',
  ];
  if (isWorkspacePin) {
    lines.push(
      `  3. workspace:* points to a sibling package; ensure that package's`,
      `     version admits ${newCliVersion} before re-running ${cmdName}`,
    );
  } else if (isFilePin) {
    lines.push(
      `  3. file: pins to a local path; ensure the linked package's`,
      `     version admits ${newCliVersion} before re-running ${cmdName}`,
    );
  } else if (isGitPin) {
    lines.push(
      `  3. git URL pins to a remote ref; ensure the target ref's`,
      `     package version admits ${newCliVersion} before re-running ${cmdName}`,
    );
  } else if (isLooksDistTag) {
    lines.push(
      `  3. dist-tag "${existing}" resolves at install time; ensure the`,
      `     tag currently points at a version that admits ${newCliVersion}`,
    );
  } else {
    lines.push(
      `  3. If using workspace:* or file:.., ensure the workspace target`,
      `     resolves to >= ${newCliVersion} before re-running ${cmdName}`,
    );
  }
  lines.push('', `Then re-run: ${cmdName}`);

  return {
    kind: 'block',
    packageJsonPath: pkgPath,
    existingRange: existing,
    newCliVersion,
    newPinnedRange,
    reason: lines.join('\n'),
  };
}

function serialize(obj: unknown, shape: FileShape): string {
  let s = JSON.stringify(obj, null, shape.indent);
  if (shape.eol === '\r\n') {
    s = s.replace(/\n/g, '\r\n');
  }
  if (shape.trailingNewline) {
    s += shape.eol;
  }
  return s;
}

/**
 * Idempotent self-pin step. See module header for the full contract.
 */
export async function selfPinRea(options: SelfPinOptions): Promise<SelfPinResult> {
  const pinnedRange = `^${options.cliVersion}`;
  const pkgPath = findPackageJson(options.cwd);
  if (pkgPath === null) {
    return {
      action: 'skipped-no-package-json',
      packageJsonPath: null,
      pinnedRange,
      message:
        `self-pin skipped — no package.json in the target directory ${options.cwd}. ` +
        `rea init refuses to walk up and mutate a parent the operator did not ` +
        `explicitly target — re-invoke from the workspace root if that is the ` +
        `intent.`,
    };
  }

  // R10-P2 (codex round 10): refuse symlinked package.json BEFORE
  // any read or write. Writing through a symlink mutates the target
  // — typically outside the requested project tree — which violates
  // the R2-P4 "don't mutate a parent the operator did not target"
  // contract.
  //
  // Live mode THROWS — security refusals must surface, not silently
  // no-op. Dry-run mode RETURNS a `skipped-symlink-package-json`
  // skip-shape so `rea upgrade --dry-run` can complete a full preview
  // even when the symlink would block the live run. The upgrade
  // pre-flight (`checkUpgradeBlockingPin`) already surfaced a
  // `block-symlink` to the operator before reaching this code path,
  // so dry-run consumers see the diagnostic ONCE at the pre-flight
  // and the downstream `selfPinRea({ dryRun: true })` call simply
  // reports "skipped — symlinked" without re-throwing.
  if ((await checkPackageJsonShape(pkgPath)) === 'symlink') {
    const message = buildSymlinkRefusalMessage(pkgPath);
    if (options.dryRun === true) {
      return {
        action: 'skipped-symlink-package-json',
        packageJsonPath: pkgPath,
        pinnedRange,
        message,
      };
    }
    throw new Error(message);
  }

  const pkg = await readPackageJson(pkgPath);
  if (pkg === null) {
    return {
      action: 'skipped-malformed-package-json',
      packageJsonPath: pkgPath,
      pinnedRange,
      message: `self-pin skipped — ${pkgPath} is missing or not a valid JSON object`,
    };
  }

  // Dogfood short-circuit: pkg.name === '@bookedsolid/rea'.
  if (pkg.parsed['name'] === REA_PACKAGE_NAME) {
    return {
      action: 'skipped-dogfood',
      packageJsonPath: pkgPath,
      pinnedRange,
      message: `self-pin skipped — this IS @bookedsolid/rea (dogfood)`,
    };
  }

  // Conflict check: where does `@bookedsolid/rea` currently live?
  // We look in dependencies + devDependencies — those are the surfaces
  // the bootstrap allowlist (Fix B) accepts. We do NOT look in
  // peerDependencies / optionalDependencies / pnpm.overrides — those
  // are NOT bootstrap declarations and inserting our pin there would
  // silently shift the contract.
  const deps = isPlainObject(pkg.parsed['dependencies']) ? pkg.parsed['dependencies'] : null;
  const devDeps = isPlainObject(pkg.parsed['devDependencies'])
    ? pkg.parsed['devDependencies']
    : null;

  const existingDep = deps !== null && typeof deps[REA_PACKAGE_NAME] === 'string'
    ? (deps[REA_PACKAGE_NAME] as string)
    : undefined;
  const existingDevDep =
    devDeps !== null && typeof devDeps[REA_PACKAGE_NAME] === 'string'
      ? (devDeps[REA_PACKAGE_NAME] as string)
      : undefined;

  // P1-1 (codex round 2): upgrade-mode bump predicate. Resolved here
  // once so the dependencies + devDependencies branches share the
  // same shape gate. `mode: 'upgrade'` opts the caller in to auto-
  // bumping a managed-caret pin when the existing range does not
  // admit the new CLI minor (pre-1.0 caret = tilde, so `^0.49.0`
  // does NOT admit `0.50.0` and a 0.49 → 0.50 upgrade would otherwise
  // ship newer hooks against the older CLI — exactly the brick state
  // this whole feature exists to prevent). `mode: 'init'` (default)
  // never bumps: respects whatever pin the operator already chose.
  const mode = options.mode ?? 'init';
  const allowBump = mode === 'upgrade';
  // R3-P2: dry-run prefixes "would " on the mutation messages so the
  // operator-visible string is unambiguous. The `action` discriminant
  // itself is identical between dry-run and live run — callers that
  // pattern-match on `action` see the same value either way; only the
  // message and the absence of an on-disk write differ.
  const dryRun = options.dryRun ?? false;
  const wroteVerb = dryRun ? 'would add' : 'added';
  const bumpedVerb = dryRun ? 'would bump' : 'bumped';

  // A dep present in `dependencies` AND `devDependencies` is unusual
  // but legal. We treat the `dependencies` value as authoritative for
  // conflict detection (npm install resolves it that way) and refuse
  // to mutate the more constrained surface. Operator owns it.
  if (existingDep !== undefined) {
    if (existingDep === pinnedRange) {
      return {
        action: 'skipped-same',
        packageJsonPath: pkgPath,
        pinnedRange,
        existingRange: existingDep,
        message: `self-pin: ${REA_PACKAGE_NAME} already pinned in dependencies as ${existingDep}`,
      };
    }
    if (allowBump && shouldBumpManagedCaret(existingDep, pinnedRange)) {
      await writePin(pkgPath, pkg, 'dependencies', pinnedRange, deps, devDeps, dryRun);
      return {
        action: 'bumped',
        packageJsonPath: pkgPath,
        pinnedRange,
        existingRange: existingDep,
        message:
          `self-pin: ${bumpedVerb} ${REA_PACKAGE_NAME} pin in dependencies from ` +
          `${existingDep} to ${pinnedRange} (managed-caret upgrade)`,
      };
    }
    return {
      action: 'skipped-different',
      packageJsonPath: pkgPath,
      pinnedRange,
      existingRange: existingDep,
      message:
        `self-pin: ${REA_PACKAGE_NAME} already pinned in dependencies as ${existingDep} ` +
        `(different from ${pinnedRange}) — leaving operator's pin intact`,
    };
  }

  if (existingDevDep !== undefined) {
    if (existingDevDep === pinnedRange) {
      return {
        action: 'skipped-same',
        packageJsonPath: pkgPath,
        pinnedRange,
        existingRange: existingDevDep,
        message: `self-pin: ${REA_PACKAGE_NAME} already pinned in devDependencies as ${existingDevDep}`,
      };
    }
    if (allowBump && shouldBumpManagedCaret(existingDevDep, pinnedRange)) {
      await writePin(pkgPath, pkg, 'devDependencies', pinnedRange, deps, devDeps, dryRun);
      return {
        action: 'bumped',
        packageJsonPath: pkgPath,
        pinnedRange,
        existingRange: existingDevDep,
        message:
          `self-pin: ${bumpedVerb} ${REA_PACKAGE_NAME} pin in devDependencies from ` +
          `${existingDevDep} to ${pinnedRange} (managed-caret upgrade)`,
      };
    }
    return {
      action: 'skipped-different',
      packageJsonPath: pkgPath,
      pinnedRange,
      existingRange: existingDevDep,
      message:
        `self-pin: ${REA_PACKAGE_NAME} already pinned in devDependencies as ${existingDevDep} ` +
        `(different from ${pinnedRange}) — leaving operator's pin intact`,
    };
  }

  // No existing pin.
  //
  // 0.53.0 GLOBAL-FIRST (Jake's foundational call): `rea init` / `rea upgrade`
  // NEVER self-pin by default. A no-pin checkout is the NORMAL healthy state
  // — the resolved CLI is the GLOBAL tier (`<home>/.rea/cli`), not a local
  // node_modules copy.
  //
  // WHY THIS IS SAFE — brick-prevention reasoning (load-bearing):
  //   self-pin (0.49.0) existed to stop the hooks-newer-than-local-CLI brick:
  //   `rea init` wrote shims that resolved `@bookedsolid/rea` from
  //   node_modules, so a fresh clone + `pnpm install` without the dep found
  //   NO CLI and every Bash gate refused. Global-first removes the local CLI
  //   from the equation entirely — there is no node_modules copy to be stale.
  //   The guard against a too-old resolved CLI is now the 0.52.0 version-skew
  //   handling in the shim (fail-closed under enforce / warn under shadow when
  //   the resolved global CLI predates the installed hooks), NOT a package.json
  //   pin. So no pin is needed for correctness — omitting it is the point.
  //
  // `--pin` (options.pin === true) is the explicit OPT-IN for teams that want
  // a hermetic local install (the pre-0.53.0 behavior). Only then do we write.
  if (options.pin !== true) {
    if (options.trustedGlobalTier === true) {
      // Trusted checkout — additionally CONFIRMED in the global-tier registry.
      return {
        action: 'skipped-global-tier-trusted',
        packageJsonPath: pkgPath,
        pinnedRange,
        message:
          'self-pin skipped — checkout is trusted in the global-tier registry; ' +
          'refreshing hooks/spine without re-adding the dep',
      };
    }
    // Ordinary global-first default — no pin, no local dep. Healthy.
    return {
      action: 'skipped-global-default',
      packageJsonPath: pkgPath,
      pinnedRange,
      message:
        `self-pin skipped — global-first (default): the global rea CLI tier governs, ` +
        `no local ${REA_PACKAGE_NAME} pin needed. Pass --pin for a hermetic local install.`,
    };
  }

  // `--pin` opt-in — write a new pin into devDependencies (pre-0.53.0 behavior).
  const result = await writePin(pkgPath, pkg, 'devDependencies', pinnedRange, deps, devDeps, dryRun);
  if (result.newRaw === pkg.raw) {
    return {
      action: 'skipped-same',
      packageJsonPath: pkgPath,
      pinnedRange,
      existingRange: pinnedRange,
      message: `self-pin: ${REA_PACKAGE_NAME} already pinned at ${pinnedRange} (byte-identical)`,
    };
  }
  return {
    action: 'wrote',
    packageJsonPath: pkgPath,
    pinnedRange,
    message: `self-pin: ${wroteVerb} ${REA_PACKAGE_NAME}@${pinnedRange} to devDependencies in ${pkgPath}`,
  };
}

/**
 * Write the rea pin into either `dependencies` or `devDependencies`
 * (caller picks). Sorts the target dep block alphabetically (matches
 * the pre-refactor behavior for devDependencies and is the common
 * tooling convention for both). Preserves top-level key order in the
 * package.json object so the on-disk diff is minimal — JSON.stringify
 * honors insertion order in V8.
 *
 * Returns `{ newRaw }` so the caller can compare against
 * `pkg.raw` for the byte-fidelity guard.
 *
 * P1-1 (codex round 2): extracted as a shared helper so the new-write
 * path and the upgrade-mode bump path use the same serializer. Pre-
 * extraction the bump path would have needed duplicated logic.
 */
async function writePin(
  pkgPath: string,
  pkg: PackageJsonShape,
  target: 'dependencies' | 'devDependencies',
  pinnedRange: string,
  deps: Record<string, unknown> | null,
  devDeps: Record<string, unknown> | null,
  dryRun: boolean,
): Promise<{ newRaw: string }> {
  const baseBlock = target === 'dependencies' ? deps : devDeps;
  const newBlock: Record<string, unknown> = { ...(baseBlock ?? {}), [REA_PACKAGE_NAME]: pinnedRange };
  const sortedKeys = Object.keys(newBlock).sort();
  const sortedBlock: Record<string, unknown> = {};
  for (const k of sortedKeys) sortedBlock[k] = newBlock[k];

  const out: Record<string, unknown> = { ...pkg.parsed, [target]: sortedBlock };
  const newRaw = serialize(out, pkg.shape);

  // R3-P2: skip the write when previewing. The caller still gets the
  // `newRaw` value back so the byte-fidelity guard ("did this even
  // change?") works identically in both modes.
  if (!dryRun && newRaw !== pkg.raw) {
    await fs.writeFile(pkgPath, newRaw, 'utf8');
  }
  return { newRaw };
}

// ---------------------------------------------------------------------------
// 0.53.0 — `rea migrate --to-global` (assisted removal of the local pin)
// ---------------------------------------------------------------------------

export interface MigrateToGlobalOptions {
  /** Starting directory for the (non-walking) `package.json` lookup. */
  cwd: string;
  /** Read + decide but do not write. Default: false. */
  dryRun?: boolean;
}

export interface MigrateToGlobalResult {
  action:
    /** Dep stripped from one or both blocks; package.json rewritten. */
    | 'removed'
    /** No `@bookedsolid/rea` dep present — already global-first, nothing to do. */
    | 'skipped-already-global'
    /** `pkg.name === @bookedsolid/rea` — dogfood, never mutate. */
    | 'skipped-dogfood'
    | 'skipped-no-package-json'
    | 'skipped-malformed-package-json'
    | 'skipped-symlink-package-json';
  packageJsonPath: string | null;
  /** Blocks the dep was removed from (empty unless `action === 'removed'`). */
  removedFrom: Array<'dependencies' | 'devDependencies'>;
  message: string;
}

/**
 * Remove one key from a dep block, PRESERVING the surrounding key order
 * (unlike `writePin`, which re-sorts). Byte-minimal: only the removed line
 * disappears; every other entry keeps its original position.
 */
function removeKeyPreservingOrder(
  block: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(block)) {
    if (k === key) continue;
    out[k] = block[k];
  }
  return out;
}

/**
 * `rea migrate --to-global` — strip the local `@bookedsolid/rea` dep from
 * `dependencies` AND `devDependencies` so the checkout resolves the global
 * rea CLI tier instead of a vendored node_modules copy. This is the
 * assisted-removal half of Jake's global-first call: `doctor` flags a local
 * dep as non-recommended, and this command performs the byte-minimal edit.
 *
 * Reuses the same read/shape/symlink/dogfood posture as {@link selfPinRea} so
 * the two operations agree on what a mutable `package.json` is. Idempotent
 * (no dep → `skipped-already-global`) and dogfood-safe (never touches the
 * rea repo's own manifest). Empties a dep block entirely rather than leaving
 * a dangling `"devDependencies": {}` when rea was its only entry.
 *
 * The caller (`rea migrate`) prints the lockfile follow-up (`pnpm install` /
 * `npm install` to prune node_modules) — this function only edits the
 * manifest.
 */
export async function migrateToGlobal(
  options: MigrateToGlobalOptions,
): Promise<MigrateToGlobalResult> {
  const dryRun = options.dryRun ?? false;
  const pkgPath = findPackageJson(options.cwd);
  if (pkgPath === null) {
    return {
      action: 'skipped-no-package-json',
      packageJsonPath: null,
      removedFrom: [],
      message:
        `migrate skipped — no package.json in the target directory ${options.cwd}. ` +
        `Run \`rea migrate --to-global\` from the workspace root.`,
    };
  }

  // Symlink refusal mirrors selfPinRea: live mode THROWS, dry-run returns the
  // skip-shape so a preview can complete.
  if ((await checkPackageJsonShape(pkgPath)) === 'symlink') {
    const message = buildSymlinkRefusalMessage(pkgPath);
    if (dryRun) {
      return {
        action: 'skipped-symlink-package-json',
        packageJsonPath: pkgPath,
        removedFrom: [],
        message,
      };
    }
    throw new Error(message);
  }

  const pkg = await readPackageJson(pkgPath);
  if (pkg === null) {
    return {
      action: 'skipped-malformed-package-json',
      packageJsonPath: pkgPath,
      removedFrom: [],
      message: `migrate skipped — ${pkgPath} is missing or not a valid JSON object`,
    };
  }

  if (pkg.parsed['name'] === REA_PACKAGE_NAME) {
    return {
      action: 'skipped-dogfood',
      packageJsonPath: pkgPath,
      removedFrom: [],
      message: `migrate skipped — this IS ${REA_PACKAGE_NAME} (dogfood); nothing to strip`,
    };
  }

  const deps = isPlainObject(pkg.parsed['dependencies']) ? pkg.parsed['dependencies'] : null;
  const devDeps = isPlainObject(pkg.parsed['devDependencies'])
    ? pkg.parsed['devDependencies']
    : null;
  const inDeps = deps !== null && REA_PACKAGE_NAME in deps;
  const inDevDeps = devDeps !== null && REA_PACKAGE_NAME in devDeps;

  if (!inDeps && !inDevDeps) {
    return {
      action: 'skipped-already-global',
      packageJsonPath: pkgPath,
      removedFrom: [],
      message: `already global-first — no local ${REA_PACKAGE_NAME} dep in ${pkgPath}, nothing to do`,
    };
  }

  // Rebuild the top-level object preserving key order; drop the rea entry from
  // each block it appears in, and drop a block entirely if it becomes empty.
  const removedFrom: Array<'dependencies' | 'devDependencies'> = [];
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(pkg.parsed)) {
    if ((k === 'dependencies' && inDeps) || (k === 'devDependencies' && inDevDeps)) {
      const block = pkg.parsed[k] as Record<string, unknown>;
      const pruned = removeKeyPreservingOrder(block, REA_PACKAGE_NAME);
      removedFrom.push(k as 'dependencies' | 'devDependencies');
      if (Object.keys(pruned).length === 0) continue; // drop now-empty block
      out[k] = pruned;
    } else {
      out[k] = pkg.parsed[k];
    }
  }

  const newRaw = serialize(out, pkg.shape);
  if (!dryRun && newRaw !== pkg.raw) {
    await fs.writeFile(pkgPath, newRaw, 'utf8');
  }
  const verb = dryRun ? 'would remove' : 'removed';
  return {
    action: 'removed',
    packageJsonPath: pkgPath,
    removedFrom,
    message: `migrate: ${verb} ${REA_PACKAGE_NAME} from ${removedFrom.join(' + ')} in ${pkgPath}`,
  };
}

/**
 * `rea doctor` check: FAIL when hook shims are present but no self-pin
 * is declared. This is the "brick state" detector — a fresh clone of a
 * consumer repo whose `.claude/hooks/` exists but whose `package.json`
 * declares no `@bookedsolid/rea` dep is exactly the scenario the bash
 * allowlist (Fix B) recovers from. Doctor surfaces it loudly so the
 * operator knows to run `rea upgrade` (which re-runs the self-pin
 * step) instead of fighting the gates.
 *
 * Returns a discriminated result:
 *   - `kind: 'pass'`           — hooks + self-pin both present.
 *   - `kind: 'pass-no-hooks'`  — no `.claude/hooks/` directory; the
 *                                check is N/A (caller emits an `info`
 *                                row instead of a check row).
 *   - `kind: 'pass-no-pkg'`    — no `package.json` in the doctor's
 *                                target directory (P2-4: no upward
 *                                walk — doctor reports the absence
 *                                rather than scanning the parent
 *                                chain). Doctor treats this as a
 *                                `warn` not a `fail` because the
 *                                bootstrap allowlist refuses pkg-less
 *                                projects anyway.
 *   - `kind: 'pass-dogfood'`   — `pkg.name === '@bookedsolid/rea'`.
 *   - `kind: 'fail'`           — hooks present, package.json present,
 *                                no self-pin declared. Caller emits
 *                                a `fail` row with the recovery
 *                                instruction.
 *   - `kind: 'fail-malformed'` — package.json exists but is malformed
 *                                or not an object. Caller emits a
 *                                `fail` row naming the file.
 *   - `kind: 'fail-symlink'`   — R10-P2 (codex round 10):
 *                                package.json is a symlink. Doctor
 *                                emits a `fail` row mirroring the
 *                                write path's refusal so operators
 *                                discover the misconfiguration before
 *                                running `rea upgrade`.
 */
export type SelfPinCheckResult =
  | { kind: 'pass'; packageJsonPath: string; declaredRange: string; declaredIn: 'dependencies' | 'devDependencies' }
  | { kind: 'pass-no-hooks' }
  | { kind: 'pass-no-pkg'; hooksDir: string }
  | { kind: 'pass-dogfood'; packageJsonPath: string }
  | { kind: 'fail'; packageJsonPath: string; hooksDir: string }
  | { kind: 'fail-malformed'; packageJsonPath: string }
  | { kind: 'fail-symlink'; packageJsonPath: string; reason: string }
  // R11-P3 (codex round 11): declared but the range does not admit
  // the running CLI version. Same skew the R9-P1 / R11-P1 pre-
  // flights prevent at write time; doctor needs to surface it
  // before the brick state lands on a consumer who hasn't yet run
  // `rea upgrade`.
  | {
      kind: 'fail-incompatible';
      packageJsonPath: string;
      declaredRange: string;
      declaredIn: 'dependencies' | 'devDependencies';
      currentCliVersion: string;
      reason: string;
    }
  // R11-P3: declared as a non-semver shape (workspace:*, file:.., git
  // URL, dist-tag like `next`) — we cannot statically determine
  // whether the resolved version admits the running CLI. Doctor
  // surfaces this as a fail so the operator audits the resolution
  // path. Pre-R11 this was reported as `pass` (presence-only check).
  | {
      kind: 'fail-non-semver';
      packageJsonPath: string;
      declaredRange: string;
      declaredIn: 'dependencies' | 'devDependencies';
      reason: string;
    };

export async function checkSelfPinDeclared(
  baseDir: string,
  cliVersion?: string,
): Promise<SelfPinCheckResult> {
  return checkSelfPinDeclaredSync(baseDir, cliVersion);
}

/**
 * Synchronous variant of {@link checkSelfPinDeclared}. `rea doctor`
 * runs all checks sync; the read+parse cost here is microseconds so
 * the sync form is acceptable.
 *
 * R11-P3 (codex round 11): when `cliVersion` is provided, this check
 * also verifies that the declared range admits the running CLI
 * version (semver.satisfies). Without `cliVersion` the check
 * reverts to presence-only behavior (backwards-compat for callers
 * that don't yet pass the version). The doctor wrapper
 * (`checkSelfPinDeclaredCheck`) passes `getPkgVersion()` so the
 * skew detection always runs in the doctor surface.
 */
export function checkSelfPinDeclaredSync(
  baseDir: string,
  cliVersion?: string,
): SelfPinCheckResult {
  const hooksDir = path.join(baseDir, '.claude', 'hooks');
  if (!fsSync.existsSync(hooksDir)) {
    return { kind: 'pass-no-hooks' };
  }
  const pkgPath = findPackageJson(baseDir);
  if (pkgPath === null) {
    return { kind: 'pass-no-pkg', hooksDir };
  }
  // R10-P2 (codex round 10): mirror the write-path's symlink refusal
  // here so doctor surfaces the same diagnostic. Operators get
  // told about the misconfiguration BEFORE running `rea upgrade`,
  // which would throw at the symlink check otherwise.
  if (checkPackageJsonShapeSync(pkgPath) === 'symlink') {
    return {
      kind: 'fail-symlink',
      packageJsonPath: pkgPath,
      reason: buildSymlinkRefusalMessage(pkgPath),
    };
  }
  let raw: string;
  try {
    raw = fsSync.readFileSync(pkgPath, 'utf8');
  } catch {
    return { kind: 'fail-malformed', packageJsonPath: pkgPath };
  }
  // P3-1 (codex round 1): tolerate a leading UTF-8 BOM the same way
  // the write path does — otherwise doctor reports `fail-malformed`
  // on Windows-authored manifests that selfPinRea handles fine.
  raw = stripUtf8Bom(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'fail-malformed', packageJsonPath: pkgPath };
  }
  if (!isPlainObject(parsed)) {
    return { kind: 'fail-malformed', packageJsonPath: pkgPath };
  }
  const pkg: PackageJsonShape = { raw, parsed, shape: detectShape(raw) };
  if (pkg.parsed['name'] === REA_PACKAGE_NAME) {
    return { kind: 'pass-dogfood', packageJsonPath: pkgPath };
  }
  const deps = isPlainObject(pkg.parsed['dependencies']) ? pkg.parsed['dependencies'] : null;
  const devDeps = isPlainObject(pkg.parsed['devDependencies'])
    ? pkg.parsed['devDependencies']
    : null;
  // Resolve the authoritative pin + its location (deps wins over
  // devDeps, matching `selfPinRea`'s precedence).
  let declaredRange: string | undefined;
  let declaredIn: 'dependencies' | 'devDependencies' | undefined;
  if (deps !== null && typeof deps[REA_PACKAGE_NAME] === 'string') {
    declaredRange = deps[REA_PACKAGE_NAME] as string;
    declaredIn = 'dependencies';
  } else if (devDeps !== null && typeof devDeps[REA_PACKAGE_NAME] === 'string') {
    declaredRange = devDeps[REA_PACKAGE_NAME] as string;
    declaredIn = 'devDependencies';
  }
  if (declaredRange === undefined || declaredIn === undefined) {
    return { kind: 'fail', packageJsonPath: pkgPath, hooksDir };
  }
  // R11-P3 (codex round 11): pin-compatibility check. When the
  // caller passed a `cliVersion`, run semver.satisfies against the
  // declared range. Non-semver shapes (workspace:*, file:.., git,
  // dist-tag) cannot be resolved statically — surface a dedicated
  // `fail-non-semver` so the operator audits the resolution path
  // rather than seeing a misleading `pass`.
  if (cliVersion !== undefined) {
    const validRange = semver.validRange(declaredRange);
    if (validRange === null) {
      return {
        kind: 'fail-non-semver',
        packageJsonPath: pkgPath,
        declaredRange,
        declaredIn,
        reason:
          `Self-pin declared as a non-semver shape: ${REA_PACKAGE_NAME} pinned to ` +
          `"${declaredRange}" in ${declaredIn}.\n\n` +
          `rea doctor cannot statically determine whether the resolved version admits the\n` +
          `installed CLI version ${cliVersion}. Workspace, file:, git URL, and dist-tag\n` +
          `pins resolve at install time — if the resolved version does not admit ${cliVersion},\n` +
          `your hook scripts will resolve the older CLI from node_modules and may fail to\n` +
          `parse the current policy.yaml schema.\n\n` +
          // R12-P2 (codex round 12): bare-spec form only. The
          // CLI-missing bash gate refuses version-pinned adds.
          `To reconcile, either:\n` +
          `  1. Replace the pin with pnpm add -D ${REA_PACKAGE_NAME}\n` +
          `     (installs latest within range, then re-run: rea upgrade)\n` +
          `  2. Verify the resolved version admits ${cliVersion} (check node_modules/${REA_PACKAGE_NAME}/package.json)`,
      };
    }
    // semver.satisfies with includePrerelease so a 0.49.0-beta.0
    // running CLI passes against `^0.49.0` (otherwise a prerelease
    // would fail-incompatible against its own non-prerelease range).
    const admits = semver.satisfies(cliVersion, validRange, { includePrerelease: true });
    if (!admits) {
      return {
        kind: 'fail-incompatible',
        packageJsonPath: pkgPath,
        declaredRange,
        declaredIn,
        currentCliVersion: cliVersion,
        reason:
          `Self-pin declared but incompatible: package.json pins ${REA_PACKAGE_NAME} to ` +
          `"${declaredRange}" in ${declaredIn} which does not admit the installed CLI ` +
          `version ${cliVersion}.\n\n` +
          `Your hook scripts will resolve the older CLI from node_modules and may fail to\n` +
          `parse the current policy.yaml schema (strict).\n\n` +
          // R12-P2 (codex round 12): bare-spec form only — see the
          // R9-P1 reason builder above for the full rationale.
          `To reconcile:\n` +
          `  pnpm add -D ${REA_PACKAGE_NAME}     (installs latest within range,\n` +
          `                                       then re-run: rea upgrade)`,
      };
    }
  }
  return {
    kind: 'pass',
    packageJsonPath: pkgPath,
    declaredRange,
    declaredIn,
  };
}
