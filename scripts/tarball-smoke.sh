#!/usr/bin/env bash
# tarball-smoke.sh — exercise the packed @bookedsolid/rea tarball end-to-end
# in an isolated tempdir. Catches packaging regressions (missing files from
# `files:`, broken exports map, shebang / chmod issues on `bin`, postinstall
# failures, dependency resolution drift) BEFORE the tarball reaches npm.
#
# Must be run from the repo root. Assumes `dist/` has already been built.
#
# Runs under CI on every PR and on every push to main; also recommended as a
# manual gate before hand-authorizing a Changesets release PR merge.
#
# ## Developer-run negative probe (optional, not in CI)
#
# To verify the tree-equality asserts actually fail loud on a missing shipped
# file, temporarily drop `commands/` or `.husky/` from `package.json#files[]`,
# run this script, and confirm it exits non-zero at the install-surface diff
# step. Revert the `files:` edit before committing. CI does not run this probe
# because it would mutate package.json.
#
# Exit codes:
#   0 — smoke passed
#   1 — preflight failure (missing dist, pack failed)
#   2 — smoke assertion failure (bin missing, init/doctor failed, exports broken)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -d "dist" ]; then
  echo "[smoke] FAIL — dist/ not found. Run 'pnpm build' first." >&2
  exit 1
fi

PACK_DIR="$(mktemp -d -t rea-smoke-pack-XXXXXX)"
SMOKE_DIR="$(mktemp -d -t rea-smoke-install-XXXXXX)"
DIFF_TMP="$(mktemp -t rea-smoke-diff-XXXXXX)"
cleanup() { rm -rf -- "$PACK_DIR" "$SMOKE_DIR" 2>/dev/null || true; rm -f "$DIFF_TMP"; }
# EXIT alone misses Ctrl-C / TERM / HUP during local runs, leaving
# /tmp/rea-smoke-* tempdirs behind. Trap the interrupt signals too.
trap cleanup EXIT HUP INT TERM

echo "[smoke] pack → $PACK_DIR"
pnpm pack --pack-destination "$PACK_DIR" >/dev/null
TARBALL="$(ls "$PACK_DIR"/bookedsolid-rea-*.tgz | head -1)"
if [ -z "$TARBALL" ] || [ ! -f "$TARBALL" ]; then
  echo "[smoke] FAIL — pnpm pack produced no tarball in $PACK_DIR" >&2
  exit 1
fi
echo "[smoke] tarball: $(basename "$TARBALL") ($(wc -c < "$TARBALL" | awk '{printf "%.0f KB\n", $1/1024}'))"

echo "[smoke] install in $SMOKE_DIR"
cd "$SMOKE_DIR"
npm init -y >/dev/null
npm install --no-audit --no-fund --loglevel=error "$TARBALL"

# Drop the temp package.json + lockfile that `npm init -y` + `npm install`
# wrote. The tempdir must look like a fresh consumer project (no package.json)
# so `rea init` exercises the same code path a brand-new consumer hits.
rm -f package.json package-lock.json
git init -q

echo "[smoke] rea --version"
VERSION_OUT="$(./node_modules/.bin/rea --version)"
# Pass the repo-root package.json path via argv to avoid interpolating it
# into a JS string literal — paths with apostrophes, backslashes, or `${...}`
# expansions would otherwise break the require() call.
EXPECTED_VERSION="$(node -p "require(process.argv[1]).version" "$REPO_ROOT/package.json")"
if [ "$VERSION_OUT" != "$EXPECTED_VERSION" ]; then
  echo "[smoke] FAIL — rea --version returned '$VERSION_OUT', expected '$EXPECTED_VERSION'" >&2
  exit 2
fi
echo "[smoke]   → $VERSION_OUT"

echo "[smoke] rea --help"
./node_modules/.bin/rea --help >/dev/null

echo "[smoke] rea init --yes --profile open-source"
./node_modules/.bin/rea init --yes --profile open-source

# Verify the installed layout matches what init claims it wrote.
for expected in .rea/policy.yaml .rea/registry.yaml .claude/settings.json CLAUDE.md .rea/install-manifest.json; do
  if [ ! -f "$expected" ]; then
    echo "[smoke] FAIL — rea init did not create $expected" >&2
    exit 2
  fi
done

# ---------------------------------------------------------------------------
# Install-surface tree-equality asserts.
#
# Prior versions counted `.claude/agents/*.md` and `.claude/hooks/*.sh` and
# never verified `.claude/commands/` or the shipped `.husky/pre-push`. A
# tarball that dropped either surface still passed. We now diff sorted file
# lists: any missing OR extra file fails loud and names the delta.
#
# Surfaces under test:
#   1. .claude/agents/         ↔ repo agents/*.md              (flat)
#   2. .claude/hooks/          ↔ repo hooks/**/*.sh            (flat + _lib/)
#   3. .claude/commands/       ↔ repo commands/*.md            (flat)
#   4. node_modules/.../.husky ↔ repo .husky/{commit-msg,pre-push}
#
# The `.husky/` check targets the package tree under node_modules because
# `rea init` only copies `.husky/*` into the consumer when `.husky/` already
# exists there. On a fresh consumer (this smoke's default), the hooks live as
# `.git/hooks/{commit-msg,pre-push}` via the fallback installers. What must
# ALWAYS be true is that the tarball itself ships the `.husky/` source of
# truth — without it, husky-using consumers get nothing.
# ---------------------------------------------------------------------------

assert_tree_equal() {
  # $1 — label for error messages
  # $2 — file listing of the source tree (one relative path per line)
  # $3 — file listing of the installed tree (one relative path per line)
  local label="$1" src="$2" dst="$3"
  if [ -z "$src" ] || [ -z "$dst" ]; then
    printf '[smoke] FAIL — empty file listing for %s\n' "$label" >&2
    exit 2
  fi
  if ! diff -u <(printf '%s\n' "$src" | sort -u) <(printf '%s\n' "$dst" | sort -u) > "$DIFF_TMP" 2>&1; then
    echo "[smoke] FAIL — $label differs between source tree and installed tree:" >&2
    cat "$DIFF_TMP" >&2
    exit 2
  fi
}

# 1. agents — flat listing of *.md
AGENTS_SRC="$(cd "$REPO_ROOT/agents" && find . -maxdepth 1 -type f -name '*.md' | sed 's|^\./||')"
AGENTS_DST="$(cd "$SMOKE_DIR/.claude/agents" && find . -maxdepth 1 -type f -name '*.md' | sed 's|^\./||')"
assert_tree_equal ".claude/agents tree" "$AGENTS_SRC" "$AGENTS_DST"

# 2. hooks — recursive listing of *.sh (walks hooks/_lib/ too)
HOOKS_SRC="$(cd "$REPO_ROOT/hooks" && find . -type f -name '*.sh' | sed 's|^\./||')"
HOOKS_DST="$(cd "$SMOKE_DIR/.claude/hooks" && find . -type f -name '*.sh' | sed 's|^\./||')"
assert_tree_equal ".claude/hooks tree" "$HOOKS_SRC" "$HOOKS_DST"

# 3. commands — flat listing of *.md
COMMANDS_SRC="$(cd "$REPO_ROOT/commands" && find . -maxdepth 1 -type f -name '*.md' | sed 's|^\./||')"
COMMANDS_DST="$(cd "$SMOKE_DIR/.claude/commands" && find . -maxdepth 1 -type f -name '*.md' | sed 's|^\./||')"
assert_tree_equal ".claude/commands tree" "$COMMANDS_SRC" "$COMMANDS_DST"

# 4. husky — explicit pre-push + commit-msg existence inside the package
#    tree under node_modules. `rea init` does not copy these into a fresh
#    consumer's root, so we check the shipped copy directly. If either file
#    is missing from the tarball, husky-using consumers silently get zero
#    enforcement on their next `pnpm install`.
#
#    Executable-bit check is intentionally NOT asserted here: npm's tarball
#    format strips the group/other execute bits from non-`bin:` files on
#    install, so the shipped file lives at mode 0644. What matters is that
#    the installers in commit-msg.ts and pre-push.ts use these as templates
#    and chmod the destination (.git/hooks/... or .husky/...) themselves.
HUSKY_PKG_DIR="$SMOKE_DIR/node_modules/@bookedsolid/rea/.husky"
for husky_file in commit-msg pre-push; do
  path="$HUSKY_PKG_DIR/$husky_file"
  if [ ! -f "$path" ]; then
    echo "[smoke] FAIL — tarball missing .husky/$husky_file (expected at $path)" >&2
    exit 2
  fi
done

# On a fresh consumer (no pre-existing .husky/), rea installs the fallback
# pre-push + commit-msg into .git/hooks/. Assert that path landed too — it is
# the enforcement surface for this smoke's simulated consumer.
for git_hook in commit-msg pre-push; do
  path="$SMOKE_DIR/.git/hooks/$git_hook"
  if [ ! -f "$path" ]; then
    echo "[smoke] FAIL — .git/hooks/$git_hook missing after rea init" >&2
    exit 2
  fi
  if [ ! -x "$path" ]; then
    echo "[smoke] FAIL — .git/hooks/$git_hook is not executable" >&2
    exit 2
  fi
done

AGENT_COUNT="$(printf '%s\n' "$AGENTS_DST" | grep -c . || true)"
HOOK_COUNT="$(printf '%s\n' "$HOOKS_DST" | grep -c . || true)"
COMMAND_COUNT="$(printf '%s\n' "$COMMANDS_DST" | grep -c . || true)"
echo "[smoke]   → $AGENT_COUNT agents, $HOOK_COUNT hooks, $COMMAND_COUNT commands, .husky/{commit-msg,pre-push} shipped, .git/hooks/{commit-msg,pre-push} installed"

echo "[smoke] rea doctor"
./node_modules/.bin/rea doctor

# ---------------------------------------------------------------------------
# BUG-013 — security-claim content gate.
#
# If any changeset carries the `[security]` marker, the tarball MUST ship
# compiled evidence of the claimed fix. The rule:
#
#   1. Find every `.changeset/*.md` in the source tree that contains `[security]`
#   2. Assert AT LEAST ONE `*sanitize*.test.ts` or `*security*.test.ts` exists
#      under `src/` (a "security-claim" changeset without a matching regression
#      test is a marketing bullet, not a shipped fix)
#   3. For every such test file, extract the symbols it imports from the
#      module under test (named imports from relative paths) and assert each
#      symbol appears somewhere under `dist/`. Tests are excluded from the
#      npm build (tsconfig.build.json), so a stale dist/ from a prior release
#      would not contain the new symbol that the test exercises — this catches
#      the 0.6.0→0.6.1 byte-identical dist/ regression that motivated BUG-013.
#
# Bypass-resistant: the gate keys on the changeset marker, not a flag the
# release author chooses. Narrow: no-op when no `[security]` changesets exist.
#
# Known limits (called out honestly rather than papered over):
#   - The gate asserts the imported SYMBOLS are present in dist/. It does
#     NOT assert those symbols are NEW vs. the previous published release.
#     A test that imports only pre-existing symbols would satisfy the gate
#     against a stale dist/. The two defense-in-depth layers that close
#     this gap — `Rebuild dist/ from HEAD before publish` and
#     `Verify published tarball dist/ matches CI-built dist/` — live in
#     `.github/workflows/release.yml` (see `.rea/drafts-0.6.2/` for the
#     pending hand-apply patch). The content gate here catches the
#     0.6.0→0.6.1 class of regression in the common case; the workflow
#     hash check catches the adversarial case.
#   - The gate does not tie a specific changeset to a specific test file.
#     If a security changeset names BUG-X but the shipping security test
#     covers BUG-Y, the gate passes. Mitigation is the same: the workflow
#     hash verification plus human review of the changeset at PR time.
# ---------------------------------------------------------------------------
SEC_CHANGESETS="$(grep -l '\[security\]' "$REPO_ROOT"/.changeset/*.md 2>/dev/null || true)"
if [ -n "$SEC_CHANGESETS" ]; then
  echo "[smoke] security-claim gate: $(printf '%s\n' "$SEC_CHANGESETS" | wc -l | awk '{print $1}') changeset(s) tagged [security]"

  SEC_SRC_TESTS="$(cd "$REPO_ROOT" && find src -type f \( -name '*sanitize*.test.ts' -o -name '*security*.test.ts' \) 2>/dev/null | sort)"
  # 0.9.3 extension — some security hotfixes touch ONLY shell hooks (no TS/dist
  # symbols), so the compiled-symbol gate above doesn't apply. For those, the
  # regression proof lives under __tests__/hooks/*{security,bypass,injection,
  # sanitize}*.test.ts and the tarball must ship the hook file(s) the test
  # exercises. This block runs IN ADDITION to the src/ symbol gate — either
  # layer alone can satisfy a [security] changeset, but at least one MUST.
  SEC_HOOK_TESTS="$(cd "$REPO_ROOT" && find __tests__/hooks -type f \( -name '*security*.test.ts' -o -name '*bypass*.test.ts' -o -name '*sanitize*.test.ts' -o -name '*injection*.test.ts' \) 2>/dev/null | sort)"

  if [ -z "$SEC_SRC_TESTS" ] && [ -z "$SEC_HOOK_TESTS" ]; then
    echo "[smoke] FAIL — [security] changeset present but no matching regression test found:" >&2
    echo "[smoke]        - src/**/(*sanitize*|*security*).test.ts — for compiled-symbol fixes" >&2
    echo "[smoke]        - __tests__/hooks/(*security*|*bypass*|*sanitize*|*injection*).test.ts — for hook fixes" >&2
    echo "[smoke]        a security-claim changeset with no matching regression test is a trust violation" >&2
    exit 2
  fi

  # Hook-level gate: for each hook-security test FILE, extract the hook
  # file path(s) it installs/exercises (relative to REPO_ROOT) and assert
  # the tarball ships that hook under node_modules/@bookedsolid/rea/hooks/
  # AND that `rea init` fanned it out to $SMOKE_DIR/.claude/hooks/.
  #
  # Known narrowness (called out honestly rather than papered over):
  #   - Granularity is per-test-file, not per-`it()` block. A file may
  #     contain multiple `it(...)` cases; the extractor scans the whole
  #     file body. In practice a [security]-claim test file should focus
  #     on one defect class; mixing unrelated `it()` cases with different
  #     hook refs dilutes the proof. PR review is the mitigation.
  #   - A [security] file with zero extractable refs fails LOUDLY (see
  #     EMPTY_REF_TESTS below). The narrowness only applies to files that
  #     do extract refs but don't scope them per `it()`.
  if [ -n "$SEC_HOOK_TESTS" ]; then
    HOOK_MISSING=""
    HOOK_COUNT=0
    EMPTY_REF_TESTS=""
    while IFS= read -r hook_test; do
      [ -z "$hook_test" ] && continue
      # Pull hook paths referenced by the test. Matches forms like:
      #   'hooks', 'push-review-gate.sh'
      #   'hooks', '_lib', 'push-review-core.sh'
      #   'hooks', 'commit-review-gate.sh'
      HOOK_REFS="$(perl -0777 -ne '
        while (/path\.join\(\s*REPO_ROOT\s*,\s*[\x27"]hooks[\x27"](?:\s*,\s*[\x27"]([^\x27"]+)[\x27"])*\s*\)/sg) {
          my $all = $&;
          my @parts;
          while ($all =~ /[\x27"]([^\x27"]+)[\x27"]/g) {
            push @parts, $1 unless $1 eq "REPO_ROOT";
          }
          print join("/", @parts), "\n" if @parts;
        }
      ' "$REPO_ROOT/$hook_test" 2>/dev/null | sort -u)"

      # Per-test failure: a [security] hook-test that yields zero extractable
      # refs (e.g. uses template literals, dynamic concatenation, or helper
      # indirection) is invisible to this gate. Fail loud so the author is
      # forced to use the extractable path.join(REPO_ROOT, 'hooks', ...) shape,
      # rather than having a lone extractable neighbor test silently satisfy
      # the whole gate.
      if [ -z "$HOOK_REFS" ]; then
        EMPTY_REF_TESTS="$EMPTY_REF_TESTS
  $hook_test"
        continue
      fi

      while IFS= read -r rel; do
        [ -z "$rel" ] && continue
        HOOK_COUNT=$((HOOK_COUNT + 1))
        # `rel` already includes the leading `hooks/` segment from perl. It
        # looks like `hooks/push-review-gate.sh` or
        # `hooks/_lib/push-review-core.sh`. The tarball ships hooks under
        # `node_modules/@bookedsolid/rea/hooks/` and `rea init` fans them out
        # to `$SMOKE_DIR/.claude/hooks/`. Assert BOTH — the tarball
        # source-of-truth AND the post-init install surface.
        rel_no_prefix="${rel#hooks/}"
        TARBALL_HOOK="$SMOKE_DIR/node_modules/@bookedsolid/rea/hooks/$rel_no_prefix"
        INSTALLED_HOOK="$SMOKE_DIR/.claude/hooks/$rel_no_prefix"
        if [ ! -f "$TARBALL_HOOK" ] || [ ! -f "$INSTALLED_HOOK" ]; then
          HOOK_MISSING="$HOOK_MISSING
  $rel (exercised by $hook_test)"
        fi
      done <<< "$HOOK_REFS"
    done <<< "$SEC_HOOK_TESTS"

    if [ -n "$HOOK_MISSING" ]; then
      echo "[smoke] FAIL — [security] hook-test gate: hook file(s) under test are MISSING from tarball:" >&2
      printf '%s\n' "$HOOK_MISSING" >&2
      exit 2
    fi

    if [ -n "$EMPTY_REF_TESTS" ]; then
      echo "[smoke] FAIL — [security] hook-test gate: one or more hook-security tests yielded zero extractable hook references:" >&2
      printf '%s\n' "$EMPTY_REF_TESTS" >&2
      echo "[smoke]        hook-security tests MUST reference hook files via the literal shape" >&2
      echo "[smoke]        path.join(REPO_ROOT, 'hooks', '<name>.sh')  (or with a nested '_lib' arg)" >&2
      echo "[smoke]        Template literals, dynamic concatenation, and helper indirection are" >&2
      echo "[smoke]        invisible to this gate and would let hook changes ship unverified." >&2
      exit 2
    fi

    if [ "$HOOK_COUNT" -eq 0 ]; then
      echo "[smoke] FAIL — [security] hook-test gate: no checkable hook references extracted" >&2
      echo "[smoke]        hook-security tests must reference hook files via path.join(REPO_ROOT, 'hooks', ...)" >&2
      echo "[smoke]        so the gate can verify the hook ships in the tarball" >&2
      exit 2
    fi

    echo "[smoke]   → $(printf '%s\n' "$SEC_HOOK_TESTS" | wc -l | awk '{print $1}') hook-security test(s), $HOOK_COUNT hook ref(s) all present in tarball"
  fi

  # The compiled-symbol gate below only runs when src/ security tests exist.
  # A hook-only hotfix satisfies via the block above. Flag the src/ gate to
  # skip gracefully — the remaining smoke checks (export resolution, tree
  # equality) still run unconditionally below.
  SKIP_SRC_SYMBOL_GATE=0
  if [ -z "$SEC_SRC_TESTS" ]; then
    SKIP_SRC_SYMBOL_GATE=1
  fi

  # For each src security test, collect the named imports pulled from relative
  # paths — those are the symbols under test and must be compiled into dist/.
  # Example line we want to match:
  #   import { sanitizeHealthSnapshot, INJECTION_REDACTED_PLACEHOLDER } from './health';
  # We ignore imports from bare package names ('vitest', 'node:fs', etc.).
  #
  # Skipped when only __tests__/hooks/ security tests exist (hook-only hotfix);
  # the hook-test gate above is authoritative for that case.
  if [ "$SKIP_SRC_SYMBOL_GATE" = "1" ]; then
    echo "[smoke]   → src/ symbol gate skipped (no src/*{security,sanitize}*.test.ts — hook-test gate is authoritative)"
  else
  MISSING_SYMBOLS=""
  SYMBOL_COUNT=0
  while IFS= read -r src_test; do
    [ -z "$src_test" ] && continue
    # Collect named imports from relative-path sources using perl for a
    # multi-line regex. Output: one symbol per line.
    # We intentionally skip:
    #   - `import type { ... }`      — entire clause is type-only
    #   - `{ ..., type Foo, ... }`   — inline type-only marker on a member
    # TypeScript erases both at compile time, so asserting them against dist/
    # would false-positive. Also skip `as` aliases (the aliased symbol is a
    # local rebind, not the exported one we want to grep).
    SYMBOLS="$(perl -0777 -ne '
      while (/import(\s+type)?\s*\{([^}]+)\}\s*from\s*[\x27"](\.[^\x27"]+)[\x27"]/sg) {
        next if $1;  # whole clause is `import type { ... }` — skip
        my $group = $2;
        $group =~ s/\s+/ /g;
        for my $sym (split /,/, $group) {
          $sym =~ s/^\s+|\s+$//g;
          next if $sym =~ /^type\s+/;  # inline `type Foo` — skip
          $sym =~ s/\s+as\s+\w+$//;
          next unless $sym =~ /^\w+$/;
          print "$sym\n";
        }
      }
    ' "$REPO_ROOT/$src_test" | sort -u)"

    while IFS= read -r sym; do
      [ -z "$sym" ] && continue
      SYMBOL_COUNT=$((SYMBOL_COUNT + 1))
      # grep -r across dist/ — if the symbol does not appear anywhere, the
      # build did not include the fix the test covers.
      if ! grep -r --include='*.js' -l -F -w "$sym" "$REPO_ROOT/dist" >/dev/null 2>&1; then
        MISSING_SYMBOLS="$MISSING_SYMBOLS
  $sym (imported by $src_test)"
      fi
    done <<< "$SYMBOLS"
  done <<< "$SEC_SRC_TESTS"

  if [ -n "$MISSING_SYMBOLS" ]; then
    echo "[smoke] FAIL — [security] changeset present but symbols under test are MISSING from dist/:" >&2
    echo "[smoke]        (dist/ may be stale — rebuild before publishing)" >&2
    printf '%s\n' "$MISSING_SYMBOLS" >&2
    exit 2
  fi

  # Codex review blocker #1 (2026-04-20) — a test file written with
  # namespace/default/dynamic imports, or one that only imports from bare
  # packages, produces zero symbols to check. Before this guard, the gate
  # would pass with "0 symbols all present in dist/", re-opening the
  # byte-identical-dist/ regression that BUG-013 was written to catch.
  if [ "$SYMBOL_COUNT" -eq 0 ]; then
    echo "[smoke] FAIL — [security] changeset present but no checkable symbols extracted" >&2
    echo "[smoke]        one or more src/**/(*sanitize*|*security*).test.ts files must use" >&2
    echo "[smoke]        the \`import { Named } from './relative'\` shape so the gate can" >&2
    echo "[smoke]        verify the symbol under test appears in compiled dist/." >&2
    echo "[smoke]        (namespace/default/dynamic-only imports can't be verified)" >&2
    exit 2
  fi

  echo "[smoke]   → $(printf '%s\n' "$SEC_SRC_TESTS" | wc -l | awk '{print $1}') security regression test(s), $SYMBOL_COUNT imported symbol(s) all present in dist/"
  fi  # SKIP_SRC_SYMBOL_GATE
fi

# Verify every declared public export resolves. If the exports map points at a
# file that didn't ship in `files:`, this is where we catch it.
echo "[smoke] resolve exports"
node --input-type=module -e "
import('@bookedsolid/rea').then(m => { if (typeof m !== 'object') { console.error('bad root export'); process.exit(2); } });
import('@bookedsolid/rea/policy').then(m => { if (!m) { console.error('bad /policy export'); process.exit(2); } });
import('@bookedsolid/rea/middleware').then(m => { if (!m) { console.error('bad /middleware export'); process.exit(2); } });
import('@bookedsolid/rea/audit').then(m => {
  if (typeof m.appendAuditRecord !== 'function') { console.error('audit.appendAuditRecord not a function'); process.exit(2); }
});
"
echo "[smoke]   → root, /policy, /middleware, /audit all resolve"

echo "[smoke] PASS"
