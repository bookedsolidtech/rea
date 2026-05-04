---
'@bookedsolid/rea': minor
---

Round 12 closure (codex BLOCKING — 5 P0 + 3 P1 + 1 P2 against the round-11-fixed scanner): nine INDEPENDENT findings in the adjacent-utility / cumulative-parity space; round 11 added new dispatchers without applying the cumulative discipline established by prior rounds (mv-source, shell-out re-parse, ancestry-destructive, basename normalization). Round 12 closes those gaps across PHP and archives plus three previously-overlooked utilities. **F12-1 [P0] PHP `rename(SRC, DEST)` source-side blindspot**: round-4 F3 established mv-shape source IS destructive; round-11 bundled PHP rename with the destination-only group (copy/move_uploaded_file/symlink/link), so SRC slipped past. Fix: split rename into TWO patterns (SRC + DEST) + add `rename(` to DESTRUCTIVE_API_TOKENS for protected-ancestry. **F12-2 [P0] PHP `rmdir(PATH)` not flagged destructive**: bundled with mkdir/touch (creates), so the captured PATH didn't carry isDestructive: true. Fix: split rmdir into its own pattern + add `rmdir(` to DESTRUCTIVE_API_TOKENS. **F12-3 [P0] PHP shell-out missing entirely**: `pickShellOutPatternsFor` had no php_r_path case, so `php -r 'system("rm .rea/HALT");'` slipped past with no re-parse. Fix: new `PHP_SHELL_OUT_RE` array mirroring perl/ruby/python/node shape with quote-aware backref body extraction; covers system, exec, shell_exec, passthru, popen, proc_open, and PHP backtick. Captured payload re-parsed via parseBashCommand and walked. **F12-4 [P0] PHP -B / -E / --process-begin / --process-end eval flags**: round-11 PHP_EVAL_FLAGS only had -r/--run. Fix: extend exactLong to `[--run, --process-begin, --process-end]` and shortChars to `[r, B, E]` (case-sensitive uppercase B/E, since lowercase -e is "extended info" not eval in PHP). **F12-5 [P0] archive CREATE direction missing**: only EXTRACT was checked. `tar -cf .rea/policy.yaml docs/`, `zip .rea/policy.yaml docs/file`, `7z a .rea/policy.yaml docs/` all silently overwrote the OUTPUT archive at the protected path. Fix: detectTar gains an `isCreateOrAppend` first-pass detection (--create/--update/--append long forms or c/u/r in single-dash clusters) and emits `-f FILE` / `--file FILE` / `--file=FILE` / cluster-`f` value as a new `archive_create_dest` form when in CREATE mode; detect7z gains an explicit a/u/d (compress) branch emitting first non-flag positional after the subcommand; new `detectZip` dispatcher handles `zip [flags] OUTPUT.zip [files...]` with first-positional emit. **F12-6 [P1] cmake `-E` utility surface**: rm/remove/rename (mv-shape SRC + DEST destructive) / copy / copy_if_different / copy_directory / copy_directory_if_different / touch / remove_directory (dir + destructive) / make_directory (dir) / create_symlink (LINK is second positional) / create_hardlink. New `detectCmake` dispatcher with per-subcommand argv shapes; read-only subcommands (echo, sleep, capabilities, environment, compare_files, sha256sum, time) silent-skip. **F12-7 [P1] mkfifo / mknod**: pre-fix neither dispatcher existed. New `detectMkfifo` (variadic positionals after flag-strip including `-m MODE`/`--mode MODE`) and `detectMknod` (NAME is the FIRST bare positional; subsequent positionals are type/major/minor numerals). **F12-8 [P1] find write-predicates `-fls` / `-fprint` / `-fprintf`**: pre-fix detectFind only knew -delete / -exec / -name. Fix: scan for these predicates and emit FILE positional as a destructive write target; -fprintf consumes TWO args (FILE + FORMAT). **F12-9 [P2 false-positive regression]**: TRUE REGRESSION vs 0.22.0 — `unzip -p` (extract to stdout) and `unzip -l/-Z/-t/-v/-z` (list/test/verbose/comment-only) don't write to filesystem but the round-11 detectUnzip emitted `archive_extract_unresolvable` dynamic detection. Fix: early-return ALLOW from detectUnzip when any of `-p`/`-l`/`-t`/`-v`/`-z`/`-Z` is present (or any cluster char). The previously-incorrect `unzip -p` Class U fixture moved to U-neg per the regression-fix correction. New DetectedForms: `archive_create_dest`, `cmake_e_dest`, `mkfifo_dest`, `mknod_dest`. Class W (round-12 closures — 173 positives + 18 negatives) pins the closure across every round-12 finding × every protected target plus composition tests (nice + cmake, sudo + mkfifo, bash -c + cmake, bash -c + tar -cf). Total adversarial corpus: 12875 fixtures.

Round 11 closure (codex BLOCKING — 3 P0 + 3 P1 + 1 P2 against the round-10-fixed scanner): seven INDEPENDENT classes against the wrapper-class closure, none variants of the round-10 family. **F11-1 [P0] find -exec `{}` placeholder**: `find . -name HALT -exec rm {} \;` runs `rm` against runtime-resolved matches; pre-fix the inner-argv recursed but `{}` never matched any protected pattern (literal `{}` in AST). Fix: when inner argv contains `{}` AND inner head is not in a small read-only allow-list (`cat`, `grep`, `head`, `wc`, `cksum`, etc.), emit synthetic `find_exec_placeholder_unresolvable` dynamic detection. **F11-2 [P0] git rm/mv not in TRACKED**: `git rm -f .rea/HALT` deletes from working tree; `git mv` removes source. Pre-fix `detectGit`'s `TRACKED` set only had `checkout`/`restore`/`reset`. Fix: extend with `rm` (with `--cached` carve-out) and `mv` (sources as `git_mv_src` destructive, dest as redirect). **F11-3 [P0] git history-rewrite re-parse seams**: `git filter-branch --tree-filter PAYLOAD` (and `--index-filter`/`--msg-filter`/`--env-filter`/`--commit-filter`/`--parent-filter`/`--tag-name-filter`), `git rebase --exec`/`-x` (separate-arg + `--exec=`-joined), `git rebase -i --exec`, `git bisect run CMD ARGS`, `git commit --template=PATH`. Each is a re-parse seam that pre-fix's `TRACKED` ignored. Fix: per-subcommand branches in `detectGit`. Filter flags extracted in both forms; PAYLOAD fed through new `recurseShellPayload` helper that calls `parseBashCommand` and walks via `walkForWrites` (full top-level walker re-dispatch, same visitor used at top level). `bisect run` dispatches inner argv through `recurseInnerArgv`. `commit --template=PATH` emits `git_commit_template`. **F11-4 [P1] archive extraction**: `tar -xf x.tar -C . .rea/HALT`, `tar -xzf x.tgz` (no -C, no member list), `unzip x.zip -d .rea`, `7z x x.7z -o.rea`, `gunzip -k .rea/HALT.gz` (creates `.rea/HALT`), `gzip -k .rea/HALT` (creates `.rea/HALT.gz`), `pax -rf x.tar -s ":^:.rea/:" .`. Fix: `detectTar` extended with extract-mode positional harvesting (each non-flag positional in -x mode emits `archive_member_dest` with `isDestructive`). When -x set with no -C AND no explicit members, emit `archive_extract_unresolvable`. New dispatchers: `detectUnzip` (`-d DEST`, member positionals, refuse-on-uncertainty when both absent), `detect7z` (`x` subcommand + `-o<DEST>` joined-form), `detectGzip` (input + derived `.gz`/`-stripped` outputs as targets), `detectPax` (`-r` extract action with cluster-flag support). `bsdtar` aliases to `tar`. All wired into `walkCallExpr` and `recurseInnerArgv`. **F11-5 [P1] parallel without `:::`**: `echo .rea/HALT | parallel rm` reads stdin (no separator means parallel falls back to stdin); per-input substitution is runtime-resolved. Fix: in `walkCallExpr` BEFORE `stripEnvAndModifiers` synthesizes the template+inputs argv, detect parallel head and check whether argv contains `:::`/`::::`/`:::+`/`::::+`. When NO separator AND positional template tokens, emit `parallel_stdin_unresolvable`. Pre-strip placement is required because the wrapper-strip would erase the no-separator signal. **F11-6 [P1] more wrappers**: `fakeroot rm .rea/HALT`, `flock /tmp/lock rm .rea/HALT`, `gtimeout 5 rm .rea/HALT`, `unshare -r rm .rea/HALT`, `env --chdir=. rm .rea/HALT`, `sudo -s -- "rm .rea/HALT"`. Fix: `fakeroot` joins no-arg wrapper list. `flock` consumes one positional LOCKFILE plus `-w/-x/-s/-n/-u/-o` flags. `gtimeout` aliases to `timeout`. `unshare` strips namespace flags greedily. `env --chdir=DIR` / `env -C DIR` recognized in env's flag-strip loop. `sudo -s --` / `sudo -i --` detects shell-mode and synthesizes `sh -c PAYLOAD` for nested-shell unwrap. **F11-7 [P2] PHP `-r` interpreter**: `php -r "unlink('.rea/HALT');"` slipped through pre-fix because PHP wasn't in the dispatcher. Fix: `php` head case added with `PHP_EVAL_FLAGS` (short `-r`, long `--run`) + `PHP_WRITE_PATTERNS` covering `unlink`/`file_put_contents`/`rename`/`copy`/`move_uploaded_file`/`fopen` (write modes `w`/`a`/`x`/`c` plus `b`/`+` suffixes)/`mkdir`/`rmdir`/`touch`/`chmod`/`chown`/`chgrp`/`symlink`/`link`. Class U (round-11 find/git/archive/parallel — 360 positives + 17 negatives) and Class V (round-11 wrappers + PHP — 124 positives + 8 negatives). Total adversarial corpus: 10728 fixtures.

Round 10 closure (codex CONCERNS — 1 P1 + 1 P3 against the round-9-fixed scanner): the wrapper-class enumeration approach surfaced 5 more wrappers (`chronic`, `parallel`, `watch`, `script -c PAYLOAD`, `dbus-launch`) that round-9's 21-wrapper allow-list missed. **Job 1 STRUCTURAL closure**: new `detectWrappedNestedShell` pass runs in `walkCallExpr`'s `default:` case (head not in dispatcher's allow-list) and detects the bypass shape `<UNRECOGNIZED-HEAD> [...flags...] <KNOWN-SHELL> -c PAYLOAD` regardless of wrapper identity. Synthesizes a `[shell, -c, PAYLOAD, ...]` argv slice and re-dispatches through `detectNestedShell` so dynamic-payload refuse-on-uncertainty is shared. False-positive guards: introspection/output utilities (`echo`, `printf`, `man`, `which`, `type`, `whereis`, `apropos`, `whatis`, `help`, `alias`, `compgen`, ...) are explicitly excluded as heads AND as argv[1] (so `xfooblar echo bash` still allows). Three-token lookahead window between shell positional and `-c` flag bounds false-positive risk. Bare-shell-without-`-c` form refuses on uncertainty (stdin read). Closes the wrapper-class bypass family STRUCTURALLY — every future unknown wrapper (`expect`, `dtruss`, `xtrace`, `eatmydata`, ...) that fork/execs a shell is caught without enumeration. **Job 2 wrapper enumerations** for clean dispatch (no refuse-on-uncertainty banner): `chronic` (no-arg), `dbus-launch` (flag-prefixed: `--exit-with-session`, `--autolaunch=ID`, `--config-file=PATH`, `--binary-syntax`, `--close-stderr`, `--sh-syntax`, `--csh-syntax`), `watch` (flag-prefixed: `-n SECS`, `--interval=SECS`, `-d`/`--differences`, `-t`/`--no-title`, `-b`, `-e`, `-g`, `-c`/`--color` is `watch`'s own bare flag NOT shell `-c`, `-x`, `-p`, `-w`), `script` (re-parse seam: `-c PAYLOAD` synthesizes `sh -c PAYLOAD` like `su -c`; supports `-a`, `-f`, `-q`, `-t[FILE]`, `-T FILE`, `-e`, `-E auto|always|never`, `-B/I/O FILE`, `-m`), `parallel` (`:::` / `::::` / `:::+` / `::::+` separators; template tokens collected pre-separator and input tokens post-separator; argv synthesized as template ++ inputs so `parallel rm ::: TGT` becomes argv `[rm, TGT]` and the rm dispatcher catches the target). **Job 3 corpus**: new Class S (233 positives + 38 negatives across 5 wrappers × 6 shells × 3-4 variants × every protected target, plus parallel `:::` separator forms and script `-c` re-parse seam variants) + Class T (314 synthetic-wrapper positives + 29 false-positive-guard negatives across 7 fictional wrapper names × 6 shells × cluster forms `-c`/`-lc`/`-ic`/`-cl` × every protected target). Class T-neg pins the false-positive guards (`man bash`, `which bash`, `echo bash`, `echo bash -c hello`, `printf "%s\n" bash`, `xfooblar echo bash`, `xfooblar printf bash`, `xfooblar ls -la`). **Job 4 cleanup**: stray `walker.ts.bak` removed; `*.bak` added to `.gitignore` so `sed -i'.bak'` invocations don't leave editor backups. Total adversarial corpus rises to 10219 fixtures (6352 positives + 3763 negatives + 73 skipped).

Round 9 closure (codex P1×2): two adjacent utility-dispatch bypass classes against the round-8-fixed scanner. **F1 wrapper-shell-exec**: 14 transparent process-launcher wrappers (`nice`, `ionice`, `taskset`, `stdbuf`, `unbuffer`, `timeout`, `chrt`, `sg`, `newgrp`, `systemd-run`, `flatpak run`, `su`, `runuser`, `setsid`, `pkexec`, `firejail`, `bwrap`, `proot`, `numactl`, `cgexec`, `setpriv`, `env --`, `env -S`/`--split-string=`) were not recognized by `stripEnvAndModifiers`, so the head-dispatch saw the wrapper name and missed the inner `<shell> -c PAYLOAD`. Each wrapper's argv consumption (no-arg, one-arg, flag-prefixed, subcommand, re-parse-seam) is now documented in walker.ts TSDoc and modeled in the strip loop. `su -c PAYLOAD` and `runuser -c PAYLOAD` synthesize a `sh -c PAYLOAD` argv so detectNestedShell unwraps the re-parse seam; `env -S FRAGMENT` / `--split-string=FRAGMENT` ditto. **F2 busybox/toybox multiplexer**: the single-binary multiplexer dispatches to applets by argv[1]; `busybox rm <target>`, `busybox sh -c PAYLOAD`, `busybox -- rm <target>`, `/bin/busybox <applet>`, and the `toybox` parity all now strip the multiplexer head and re-dispatch. busybox-provided shells (`ash`) plus `mksh`, `yash`, `posh`, `rc` added to the head-dispatch nested-shell case set in both walkCallExpr and recurseInnerArgv. New Class Q corpus (1344 positives + 200 negatives across 21 wrappers × 6 shells × 4 variants × every protected target) and Class R corpus (316 positives + 32 negatives across 2 multiplexers × 11 applets × 3 separator forms × every protected target). Total adversarial corpus: 9605 fixtures.

Parser-backed Bash-tier scanner replaces the regex-and-segmenter
pipeline at `hooks/_lib/cmd-segments.sh` + `hooks/_lib/interpreter-
scanner.sh`. Detection moves into a new module at
`src/hooks/bash-scanner/` that parses every Bash command via
`mvdan-sh@0.10.1`, walks the AST, and emits a verdict JSON.

Round 7 closure (codex P0): `mvdan-sh@0.10.1`'s `syntax.Walk` empirically does NOT visit `ParamExp.Slice.Offset` / `Slice.Length` (Word fields that can hold CmdSubst payloads). Pre-fix this defeated 17 PoCs. Tactical fix: `recurseParamExpSlice` helper re-enters Walk on Slice fields with the SAME visitor for fixed-point recursion through nested forms. Structural pin: new Class O exhaustiveness contract test enumerates every Word-bearing AST position mvdan-sh's parser populates.

Round 8 closure (codex P0): `unshellEscape` collapsed only `\"` and `\'`. Bash spec says DQ collapses 5 chars (`$`, `` ` ``, `"`, `\`, `<newline>`). Pre-fix the walker re-parsed `bash -c "echo \"\$(rm .rea/HALT)\""` seeing `\$` as a literal `$` (no CmdSubst child), no detector fired, ALLOW. Real shell collapses `\$` → `$`, executes the cmdsubst, deletes HALT. Verified end-to-end exploit. Three-layer fix: (a) widened the regex from `[\"']` to `[$\"\`\\\\\\n']`; (b) tightened Class O contract — `acceptDynamic` opt-in per row, default path-explicit (was `|| w.dynamic` lenient); (c) new Class P corpus (340 positives + 8 negatives across 5 shells × 16 DQ-escape shapes × every protected target).

Eight rounds of Codex adversarial review converged the scanner.
The convergence ladder
(34→14→9→8→5→2→1→1) shows why the round-6 architectural refactor
was necessary: rounds 1–5 patched detection gaps, round 6 closed
the structural class (per-`Cmd`-kind dispatch replaced with
`syntax.Walk`), round 7 closed Walk's own field gaps
(ParamExp.Slice + Class O exhaustiveness contract), round 8 closed
DQ-escape parity (`unshellEscape` widened + Class O contract
tightened + Class P corpus pinning).

The two affected hooks — `protected-paths-bash-gate.sh` and
`blocked-paths-bash-gate.sh` — are now ~80-line shims that forward
stdin to a new CLI subcommand `rea hook scan-bash --mode
protected|blocked` and verify the verdict JSON shape via `node -e`
before honoring the exit code. The other nine hooks remain
regex-based bash unchanged.

### Bug reports closed

- **helix-023** Phase 1 (deletion of bash segmenter): 6 findings
  (F1–F6). Closed by removing the segmenter — there is nothing to
  bypass.
- **discord-ops Round 13**: 3 findings against the bash pipeline.
  Closed-by-removal.
- **codex round 1 against the 0.23.0 scanner**: 34 findings — 3 P0
  + 12 P1 + 9 P2 + 10 P3. Every P0/P1 lands a regression-positive
  fixture in `__tests__/hooks/bash-tier-corpus.test.ts` (new
  describe block: `codex round 1 — adversarial findings against
  0.23.0 scanner`). P2 fixed in-tree; P3 fixed where economical
  (rest documented).
- **codex round 2 against the round-1-fixed scanner**: 14 findings —
  2 P0 (R2-3 REA_NODE_CLI hijack class via the shape-gate accepting
  any */dist/cli/index.js, R2-14 absolute-path command-head dispatch
  bypass), 9 P1 (R2-1 decoupled-variable interpreter writes, R2-2
  symlink cycle / depth, R2-4 cp/mv/install/ln joined -t<DIR>, R2-7
  tar -C, R2-8 rsync DEST, R2-9 curl/wget output-file, R2-10 shred,
  R2-12 heredoc-into-shell, R2-13 eval), 2 P2 (R2-11 git
  checkout/restore/reset, R2-15 test harness bypass-class fixtures),
  1 P3 (R2-16 doc updates). Round-2 fixes are STRUCTURAL — they
  close the bypass class, not just the literal PoC. Each finding
  has 3-5 bypass-class fixtures in
  __tests__/hooks/bash-tier-corpus-round2.test.ts.
- **codex round 3 against the round-2-fixed scanner**: 9 findings —
  1 P0 (Finding 1: `eval $(cmd)` empty-inner short-circuit happened
  BEFORE the dynamic check; ordering reversed in `detectEval` so
  `anyDynamic` always fires the refusal first), 4 P1 (Finding 2:
  pipe-into-bare-shell — `<cmd> | bash` / `<cmd> | sudo bash` /
  `<cmd> | tee | bash` walked into walkCmd's BinaryCmd branch which
  only walked X and Y; new `detectPipeIntoBareShell` fires on op
  `|` / `|&` when RHS is a bare shell with no `-c`. Finding 3: tar
  `-xzfC archive .rea/` cluster mis-handled — the `C` short-flag in
  a cluster consumes the NEXT argv as a directory; `detectTar`
  rewritten to walk every cluster char and consume value-bearing
  flag arguments in order. Finding 4: git top-level value-bearing
  flags `-C dir`, `-c name=val`, `--git-dir=`, `--work-tree=`,
  `--namespace=`, `--super-prefix=`, `--config-env=`,
  `--exec-path[=…]` mis-classified as the subcommand;
  `detectGit`'s subcommand-finder now skips them. Finding 5: python
  `subprocess.run(..., shell=True)` / `os.popen` / `os.system` /
  argv-form-with-`stdout=open(...)` — added 4 patterns to
  PYTHON_SHELL_OUT_RE + 1 to PYTHON_WRITE_PATTERNS), 4 P2
  (Finding 6: node fs API breadth — added cp/cpSync/rename/
  renameSync/copyFile/copyFileSync/rm/rmSync/mkdir/mkdirSync/
  unlink/unlinkSync/rmdir/rmdirSync/truncate/truncateSync.
  Finding 7: python API breadth — added os.open with O_WRONLY/
  O_RDWR/O_APPEND/O_CREAT/O_TRUNC, shutil.rmtree, os.unlink/
  remove/rmdir/removedirs. Finding 8: ruby API breadth — added
  Pathname#write, FileUtils.cp/mv/cp_r/copy/move/copy_file/rename/
  rm/rm_r/rm_rf/remove/mkdir/mkdir_p. Finding 9: corpus didn't
  exercise the bash shim subprocess — added `adversarial corpus —
  bash shim subprocess sampling` describe block that spawns
  `hooks/protected-paths-bash-gate.sh` against 100 deterministically-
  sampled fixtures and cross-checks shim verdict against in-process
  verdict). New corpus classes J/K/C-ext/D-ext/B-ext add 393 fixtures.
- **codex round 4 against the round-3-fixed scanner**: 8 findings —
  2 P0 + 5 P1 + 1 P2. STRUCTURAL fixes:
  - **Finding 1 P0** (recursive directory delete bypass): `rm -rf
    .rea`, `rmdir .rea`, `find .rea -delete`, `shutil.rmtree`,
    `fs.rmSync`, `FileUtils.rm_rf` etc all flag `isDestructive` on
    emit. New protected-ancestry match path in `matchPatterns`: when
    an input target is an ancestor of any protected pattern AND the
    detection is destructive, treat as a hit. Structural corpus
    extension: `PROTECTED_DIR_ANCESTORS` and `NEGATIVE_DIR_TARGETS`
    added to types.ts; new Class L generator (270 fixtures) closes
    the structural gap that prevented directory-write detection.
  - **Finding 2 P0** (workspace-bin attacker rea hijack): tier 1
    (`command -v rea` PATH lookup) and tier 2 (`node_modules/.bin/
    rea` symlink) DROPPED from both bash shims. New 2-tier sandboxed
    resolver uses `node_modules/@bookedsolid/rea/dist/cli/index.js`
    (the published artifact) or `dist/cli/index.js` (rea-repo
    dogfood). A realpath sandbox check verifies the resolved CLI
    lives in a package directory whose `package.json` has
    `name === "@bookedsolid/rea"`.
  - **Finding 3 P1** (mv source-side path is a write): `detectCpMv`
    emits SOURCE positionals as destructive write detections for `mv`.
  - **Finding 4 P1** (find -delete unmodeled): `detectFind` rewritten
    to emit seed paths as destructive write targets when `-delete` is
    present; dynamic when `-name`/`-iname`/`-path` predicates narrow.
  - **Finding 5 P1** (interpreter shell-out shapes missing): perl
    `exec("cmd")` / `open(F, "|-", "cmd")`, ruby `Kernel.system` /
    `Open3.capture3` / `IO.popen`, node `spawnSync("bash",["-c",
    "cmd"])`, python `pty.spawn(["bash","-c","cmd"])` patterns added.
    New `PYTHON_OPAQUE_SPAWN_RE` for `os.spawnv*`/`os.execv*`/
    `pty.fork()` emits dynamic.
  - **Finding 6 P1** (pathlib & File-class destructive APIs):
    `Path('FILE').touch/.unlink/.rmdir/.rename`, ruby `File.delete /
    .unlink / .rmdir / .rename`, bare `open('FILE', 'w')`, perl
    `unlink "FILE"` / `rename SRC DEST`. Per-substring destructive-API
    recognition via `isMatchedDestructive` plumbs `isDestructive`
    through interpreter-tier emissions.
  - **Finding 7 P1** (misc utilities + procsubst-feeding-bash): new
    `detectPatch`, `detectSort`/`detectShuf`, `detectGpg`,
    `detectSplit`, `detectTrap` (re-parses trap command), extended
    `detectGit` for `config --file FILE`. New procsubst-feeding-bash
    handling: `bash <(cmd)`, `bash 0< <(cmd)`, `bash <<< "cmd"` all
    emit dynamic detections. `extractHeredocShellPayloads` extended
    for op codes 0x38 (RdrIn) and 0x3f (WordHdoc here-string).
  - **Finding 8 P2** (THREAT_MODEL §8 stale + acknowledge denylist
    architecture limit): §8.2 updated with all round-3 + round-4
    closures. §8.3 acknowledges that a denylist scanner is structurally
    limited — defense in depth via mvdan-sh AST + comprehensive walker
    + adversarial corpus + per-round Codex review + fail-closed
    defaults.
  Total adversarial corpus across rounds: 8768 fixtures across 14
  classes (A–I + J/K/C-ext/D-ext/B-ext + L).
- **codex round 5 against the round-4-fixed scanner**: 5 findings —
  2 P0 + 3 P1. STRUCTURAL fixes:
  - **F1 P0** (assignment-side cmdsubst silent bypass): walker
    short-circuited at `args.length === 0` and ignored
    `CallExpr.Assigns`; clauses `DeclClause`, `TestClause`,
    `ArithmCmd`, `LetClause`, `SelectClause`, and `CaseClause.Word`
    fell to walkCmd's default. `extractStmtRedirects` didn't walk
    redirect Words on read ops. Pre-fix `FOO=$(rm -rf .rea)`,
    `export X=$(rm)`, `[[ -n $(rm) ]]`, `case $(rm) in`,
    `cat <<< $(rm)`, `read X < <(rm)`, `(( $(rm) ))`,
    `for x in $(rm)` all silently bypassed every detector. New
    `walkAssignsForSubstNodes` walks every `Assign.Value` /
    `Assign.Array.Elems[*].Value` / `Assign.Index` for embedded
    CmdSubst/ProcSubst/ArithmExp; new `walkTestExpr` recurses
    through UnaryTest/BinaryTest/ParenTest leaves; walkCmd cases
    added for every dropped clause type; `extractStmtRedirects`
    walks the Word for cmdsubst regardless of operator.
  - **F2 P0** (CLAUDE_PROJECT_DIR sandbox bypass via symlink-out):
    pre-fix the realpath check only walked up looking for a
    `package.json` with `name === "@bookedsolid/rea"`. An attacker
    who could write a symlink at `node_modules/@bookedsolid/rea`
    pointing to `/tmp/sym-attacker/` containing a forged
    `package.json` + a forged `dist/cli/index.js` that exits 0 with
    `{"verdict":"allow"}` defeated the sandbox. PRIMARY check now
    is `realpath(cli).startsWith(realpath(CLAUDE_PROJECT_DIR) + sep)`;
    the pkg.json walk-up remains as the SECONDARY guard for
    intra-project hijacks.
  - **F3 P1** (mixed-quote interpreter shell-out): per-language
    `*_SHELL_OUT_RE` arrays gained quote-aware variants
    `(["'])((?:(?!\1)[^\\]|\\.)+)\1` per call site. Closes
    mixed-quote-nesting bypasses like `os.system('rm "x"')`. The
    scanner's loop now picks the LAST non-empty non-quote capture,
    working with both single-capture (old) and two-capture (new)
    shapes. Plus a fail-closed shell-out fallback that emits a
    dynamic detection when the payload contains a shell-out API
    token but no shell-out regex extracted a clean payload — the
    `SHELL_OUT_API_TOKENS` table is conservative: every
    unconditional shell-out call site is included; conditional ones
    (subprocess.* with `shell=True`) match only with the
    `shell=True` co-occurrence to avoid blocking legit argv-form
    `subprocess.run`.
  - **F4 P1** (chained-interpreter multi-level escape): pre-fix
    `python -c "import os; os.system('node -e \"require(\\\"fs
    \\\").rmSync(\\\".rea\\\", ...)\"')"` allowed because each
    layer accumulates a `\\\"` shell-escape level and the
    per-language path-quote regex rejects `(\\"` after the call
    paren. Fix: `looksLikeChainedInterpreter` heuristic — when a
    shell-out body itself contains a known interpreter binary head
    followed by an eval flag (`-c`/`-e`/`--eval`/`-pe`/`-ic`), emit
    a dynamic detection. Closes every multi-level chain we've
    observed without iterating unshellEscape (which would
    over-strip single-level `\\\"` literals).
  - **F5 P1/P3** (THREAT_MODEL trust-boundary honesty): §8.2 was
    overclaiming structural impossibility for the
    `node_modules/`-attacker case. Updated
    `protected-paths-bash-gate.sh` docstring + THREAT_MODEL §8.3 +
    `docs/architecture/bash-scanner.md` to clearly distinguish:
    (a) the realpath sandbox catches PATH-attacker, workspace-bin,
    symlink-out-of-project, and intra-project-without-pkg.json
    hijacks (structural); (b) it does NOT catch a forged
    `dist/cli/index.js` + matching `package.json` written directly
    into `node_modules/` — that's a package-tier supply-chain
    compromise (npm provenance scope), not a hook-tier defense.
  Total adversarial corpus rises to 8861 fixtures with the new
  Class M (assignment-side cmdsubst × every protected target ×
  every shape) plus round-5 PoC fixtures and quote-mixing variants.
- **codex round 6 against the round-5-fixed scanner**: 2 P0s in
  the same architectural class as round 5 — `WhileClause.Cond`
  and `ForClause.CStyleLoop.{Init,Cond,Post}` slots silently
  dropped by the per-Cmd-kind dispatcher. Pre-fix `while $(rm
  .rea/HALT); do :; done`, `until [[ -n $(rm .rea/HALT) ]]; do :;
  done`, `for ((i=$(rm .rea/HALT|wc -l); ...))` etc all bypassed
  every detector. The convergence ladder 34→14→9→8→5→2 made it
  clear the walker would never reach 0 with patches alone; it
  was structurally a denylist over AST shapes. Round 6 closes
  the bug class — see "Round-6 architectural refactor" below.

### Round-6 architectural refactor — deny-by-default `syntax.Walk()`

The walker is rewritten to use `mvdan-sh`'s built-in
`syntax.Walk(node, visit)` traversal as its spine. `syntax.Walk`
visits every field of every AST node exhaustively. The detector
dispatch fires when Walk reaches a `Stmt` (for redirect extraction
+ heredoc-shell-payload re-parse), a `CallExpr` (for per-utility
argv detection), or a `BinaryCmd` (for pipe-into-bare-shell
detection). Every other node kind — `IfClause`, `ForClause`,
`WhileClause`, `UntilClause`, `DeclClause`, `TestClause`,
`CaseClause`, `ArithmCmd`, `LetClause`, `SelectClause`, `FuncDecl`,
`Block`, `Subshell`, `TimeClause`, `NotCmd`, `CoprocClause`,
`CmdSubst`, `ProcSubst`, `ArithmExp` — is recursed into by Walk;
their inner Stmts and CallExprs reach the dispatcher naturally.

**This closes the bug class structurally.** A new `Cmd` type added
to mvdan-sh, or a new field on an existing type, is automatically
visited. There is no per-Cmd-kind dispatcher to update; field
omission is no longer a possible pattern.

Removed: `walkCmd` (per-Cmd-kind switch), `maybeWalkInnerStmt`,
`walkWordForSubstNodes`, `walkAssignsForSubstNodes`, `walkTestExpr`,
`isStmt`. Their entire purpose was to manually traverse fields the
previous walker dropped — `syntax.Walk()` visits all of them.

Round-6 PoCs (all BLOCK after refactor):

- `while $(rm .rea/HALT); do :; done`
- `until $(rm .rea/HALT); do :; done`
- `until [[ -n $(rm .rea/HALT) ]]; do :; done`
- `while [[ -n $(rm .rea/HALT) ]]; do :; done`
- `while true > .rea/HALT; do break; done`
- `while read x < <(rm .rea/HALT); do break; done`
- `while echo > .rea/HALT; do break; done`
- `for ((i=$(rm .rea/HALT|wc -l); i<3; i++)); do :; done`
- `for ((i=0; i<$(rm .rea/HALT|wc -l); i++)); do :; done`
- `for ((i=0; i<3; i+=$(rm .rea/HALT|wc -l))); do :; done`
- `if true; then until $(rm .rea/HALT); do :; done; fi`

Test corpus expansion: new Class N (loop-construct cmdsubst
regression class, 189 fixtures across positives + negatives
covering every loop construct × cond/init/post slot × cmdsubst
placement × protected target). Total adversarial corpus: 7050
fixtures (3709 positives + 3341 negatives). 9050 tests in the
full vitest suite remain passing.

### New CLI surface

- `rea hook scan-bash --mode protected|blocked` — parser-backed
  Bash-tier scanner. Reads Claude Code tool-input JSON from stdin,
  runs the AST walker against the protected-paths or blocked_paths
  policy, writes a verdict JSON to stdout, exits 0/2.

### New fail-closed semantics

- **Parse failure** → BLOCK with `parse_failure_reason: parser:
  <message>`. Pre-0.23.0 the segmenter silently allowed when its
  regex couldn't classify input. The new scanner refuses.
- **Dynamic target** → BLOCK. Glob (`*`, `?`, `[`, `{`) in redirect
  targets, `~/` tilde expansion, `$VAR`, backticks, `$(cmd)` all
  produce `dynamic: true` detections that the compositor blocks
  unconditionally.
- **Destructive operation against ancestor of protected file** → BLOCK
  (round 4 Finding 1). `rm -rf .rea`, `rmdir .rea`, `find .rea
  -delete`, `shutil.rmtree('.rea')`, `fs.rmSync('.rea',
  {recursive:true})`, `FileUtils.rm_rf('.rea')` etc all blocked via
  protected-ancestry matching.
- **Verdict JSON malformed under exit 0** → BLOCK. The shim
  re-verifies the JSON shape.
- **Symlink resolution** uses `lstatSync` + `readlinkSync` so
  dangling symlinks register as the link target, not the
  non-existent leaf. Codex round 1 F-2.
- **Directory-target semantics** for `cp -t`, `mv -t`, `install -t`,
  `ln -t`, `--target-directory=`. Codex round 1 F-7.
- **Pipe-into-bare-shell** → BLOCK (round 3 Finding 2). `<cmd> | bash`
  has unresolvable LHS output; refuse on uncertainty.
- **Eval with dynamic argv** → BLOCK (round 3 Finding 1). Any
  `$(...)`, backtick, or `$VAR` token in `eval`'s argv refuses
  unconditionally — no static-concat fallback.
- **mv source-side** → BLOCK (round 4 Finding 3). `mv FILE elsewhere`
  removes content at the source path; SOURCE positionals are emitted
  as destructive write detections.
- **CLI shim 2-tier sandboxed resolver** (round 4 Finding 2 + round
  5 F2). Bash shims no longer trust `command -v rea` or
  `node_modules/.bin/rea` symlink — both are workspace-attacker-
  controllable. Realpath sandbox check is now PRIMARY
  project-root containment + SECONDARY ancestor `package.json`
  walk-up.
- **Assignment-side cmdsubst** → BLOCK (round 5 F1). Every
  assignment / DeclClause / TestClause / ArithmCmd / LetClause /
  SelectClause / CaseClause.Word / here-string / procsubst-on-stdin
  shape walks embedded CmdSubst inner Stmts.
- **Mixed-quote interpreter shell-out** → BLOCK (round 5 F3+F4).
  Quote-aware shell-out regex variants + fail-closed fallback when
  shell-out API token present but extraction failed +
  chained-interpreter heuristic for multi-level chains.
- **Loop-construct cond/init/post cmdsubst** → BLOCK (round 6
  architectural refactor). Every WhileClause / UntilClause /
  ForClause / CStyleLoop variant × every CmdSubst placement ×
  every protected target is traversed by `syntax.Walk()` and
  dispatched at the inner CallExpr.

### Fixture corpus expansion

`__tests__/hooks/bash-tier-corpus.test.ts` grows from 134 to ≥185
fixtures. Every codex round 1 P0/P1 is a positive PoC; over-correction
negatives confirm legitimate usage still allows. The adversarial
generator corpus at `__tests__/hooks/bash-scanner/adversarial-
corpus.test.ts` adds 7050 cross-product fixtures spanning Classes
A–I plus round-3 additions J/K/C-ext/D-ext/B-ext plus round-4 Class
L (destructive primitives × directory ancestors) plus round-6
Class N (loop-construct cmdsubst). The `bash shim subprocess
sampling` describe block spawns the actual hook script against 100
deterministically-sampled fixtures so the JSON verifier and 2-tier
resolver are exercised end-to-end.

### What's deferred to 0.24.0

- Utility-dispatch hardening (helix-022 R2-14 family follow-up):
  wrapper-shell-exec list extension and busybox/toybox multiplexer
  detection — closed in this 0.23.0 release via Class Q + Class R.
- `git checkout REVISION PATH` and `git restore --source=REVISION PATH`
  without the POSIX `--` argv separator: when an attacker invokes
  `git checkout main .rea/HALT` (or `git restore --source=HEAD~1
  .rea/policy.yaml`), git's pre-`--` argv shape is ambiguous between
  "REVISION PATH" and "PATH...". The `detectGit` walker conservatively
  treats every positional after the subcommand as a potential
  destructive-overwrite target ONLY when `--` is present. Without
  `--`, the disambiguation requires a runtime ref-existence check
  that the static walker cannot perform. Documented accepted false
  negative since 0.22.0; the kill-switch invariants for protected
  files are still caught by the symlink-resolution layer at file-write
  time. Pin: 0.24.0 milestone for a comprehensive fix.
- WASM `sh-syntax` parser evaluation (replaces the deprecated
  `mvdan-sh@0.10.1`). The migration path: `parser.ts` is the single
  touch-point — swapping parsers changes one file.
- Filesystem-level glob enumeration in argv-based commands. Current
  fix is conservative redirect-only.
- `awk -f script-file` body scan. Currently refuses on uncertainty;
  future enhancement reads + scans the file.
- Opt-in `policy.review.cli_sha256` integrity check on the resolved
  bash-scanner CLI.

### Breaking changes

The bash shim CLI resolution surface is narrower:

- `rea` on PATH is no longer probed (round 4 #2). Consumers must
  install `@bookedsolid/rea` such that
  `node_modules/@bookedsolid/rea/dist/cli/index.js` is present.
- `node_modules/.bin/rea` symlink is no longer probed.
- `REA_NODE_CLI` env var was already removed in 0.23.0 codex round 2.
- `node_modules/@bookedsolid/rea` symlinks pointing OUT of the
  project root are now refused (round 5 F2). Tests using a tempdir
  as `CLAUDE_PROJECT_DIR` must stage the CLI INSIDE the tempdir
  (a tiny shim that re-execs the canonical CLI works) — see
  `__tests__/hooks/bash-tier-corpus.test.ts::stageReaCliInProjectDir`
  for the reference pattern.

### Documentation

- `docs/architecture/bash-scanner.md` — full design rationale,
  parser choice, AST node-types walked, taxonomy, fail-closed
  contract, how to add a detector. Round-3, round-4, round-5, and
  round-6 mitigations documented; the deny-by-default `syntax.Walk()`
  architecture replaces the explicit-dispatch description.
- `docs/migration/0.23.0.md` — consumer migration notes, runtime
  requirements, rollback path.
- `THREAT_MODEL.md` §8 — parser-backed scanner trust assumptions
  and bypass-class status (round-1 + round-2 + round-3 + round-4
  + round-5 + round-6 closures). §8.2 first bullet documents
  "walker field-omission bugs are structurally impossible" with
  the convergence-ladder rationale. §8.3 acknowledges the
  package-tier supply-chain residual and points operators at npm
  provenance / host-level integrity tooling for belt-and-braces.
- TSDoc on every exported scanner API.

### Audit emissions

`rea hook scan-bash` emits a `rea.hook.scan-bash` audit record per
invocation (mode, verdict, detected_form, hit_pattern,
command_preview). Best-effort — failure to write the audit entry
never changes the verdict.
