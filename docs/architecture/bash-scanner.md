# Bash-tier scanner architecture (0.23.0+)

## What this document covers

The 0.23.0 release replaced the regex-and-segmenter pipeline that
backed `protected-paths-bash-gate.sh` and `blocked-paths-bash-gate.sh`
with a parser-backed AST walker living in `src/hooks/bash-scanner/`.
This document explains:

- Why the rewrite was necessary (helix-021 → helix-023 closed seven
  bypass classes against the bash pipeline; codex round 1 closed
  fifteen more against the parser-backed scanner itself)
- The parser library choice (`mvdan-sh@0.10.1`) and migration plan
- The AST node types we walk and the detected-write taxonomy
- How a parse failure becomes a fail-closed BLOCK
- How to add a new detector

If you are auditing a finding against the scanner or planning a new
detector, read this first.

**Cross-references:**

- [`THREAT_MODEL.md` §8](../THREAT_MODEL.md) — security claims,
  defense-in-depth enumeration, trust boundary.
- [`docs/migration/0.23.0.md`](../migration/0.23.0.md) — consumer-
  facing migration guide (runtime requirements, troubleshooting).
- [`docs/agents/bash-scanner-extension.md`](../agents/bash-scanner-extension.md)
  — AI-agent-focused walkthrough for adding detectors.
- [`docs/agents/troubleshooting.md`](../agents/troubleshooting.md) —
  debugging failed-hook symptoms.

## Why a parser

Pre-0.23.0, the gates split a Bash command string into "segments" via
shell metacharacter regex (`;`, `&&`, `||`, `|`, `&`), then ran a
matcher per-segment against a hand-curated list of write shapes
(`>`, `>>`, `cp`, `sed -i`, etc.).

That approach has three structural problems:

1. **Re-tokenization is impossible to do correctly in regex.** Bash
   tokenization rules are stateful (heredocs, quotes, parameter
   expansion); any segment-splitter can be tricked by an input that
   the rest of the gate misclassifies. helix-014/015/016/017 each
   landed a P1/P2 bypass on this surface.
2. **Detection rules drift.** The pre-0.23.0 hooks held more than 500
   lines of bash and 17+ regex rules. New attack surfaces (`bash -c`
   nesting, process substitution, `cp -t`, dynamic interpreter
   `-e` payloads) required adding a new rule per finding, and each
   addition introduced its own edge cases.
3. **The pre-fix segmenter could silently allow on parse failure.**
   When the regex couldn't classify input, the gate treated it as
   "no match" and allowed. That is the entire bug class this
   rewrite exists to close.

The 0.23.0 architecture: parse the input ONCE with a real Bash
parser, walk the AST, and apply per-utility detectors against
parser-produced argv trees. Every regex / heuristic that lived in the
old segmenter is replaced by a structural match. The argument grammar
is correct because the parser rebuilt it from shell tokenization
rules; we never re-tokenize a string.

## Parser: mvdan-sh@0.10.1

We use [mvdan-sh](https://www.npmjs.com/package/mvdan-sh) — the
GopherJS-compiled JS port of the upstream Go parser at
`mvdan.cc/sh/v3/syntax`.

**Why this parser:** complete coverage of POSIX + Bash extensions,
zero native dependencies, single-file footprint, accepts the same
inputs that `bash` itself does. The Go parser is one of the most
heavily tested Bash parsers in the ecosystem; the JS port preserves
the AST shape verbatim.

**Pinned version:** `0.10.1`. This is the last published version
before the upstream library was deprecated in favor of `sh-syntax`
(a WASM successor that is not yet feature-complete for our needs).
The deprecation note matters because:

- The Go-side parser has not changed shape, so structural fixes
  flow through.
- Parser-level bugs (we have not encountered any) would require us
  to either fork mvdan-sh or migrate to `sh-syntax`.
- The migration path is: `src/hooks/bash-scanner/parser.ts` is the
  ONLY file that knows about `mvdan-sh`. Everything downstream
  works against `BashFile` / `BashNode` from our local
  `src/hooks/bash-scanner/mvdan-sh.d.ts` shim. Swapping parsers
  changes one file.

**Migration tracking:** see `docs/migration/0.23.0.md` for the
deferred-to-0.24.0 list, which includes the WASM `sh-syntax` parser
evaluation.

## Pipeline

```
Bash command string                                    (stdin from Claude Code)
       │
       ▼
parseBashCommand(cmd)                                  parser.ts
       │
       ├─► ok=false  ─► parseFailureVerdict()  ─► BLOCK ✦ exit 2
       │
       ▼
walkForWrites(file): DetectedWrite[]                   walker.ts
       │
       ▼
scanForProtectedViolations(ctx, detections)            protected-scan.ts
or scanForBlockedViolations(ctx, detections)           blocked-scan.ts
       │
       ├─► Verdict { verdict: 'allow' }       ─► exit 0
       └─► Verdict { verdict: 'block', … }    ─► exit 2
```

The shim hooks at `hooks/protected-paths-bash-gate.sh` and
`hooks/blocked-paths-bash-gate.sh` are thin: they forward stdin to
`rea hook scan-bash --mode protected|blocked`, capture stdout, verify
the verdict JSON shape via `node -e`, and exit 0/2 accordingly.

### Verdict-JSON verification (codex round 1 F-3)

The shim does NOT trust the CLI exit code alone. After running the
CLI, the shim re-parses the verdict JSON via `node -e` to confirm:

1. it is valid JSON,
2. the top-level shape has `.verdict == "allow"|"block"`,
3. the verdict matches the exit code (allow→0, block→2).

If any check fails the shim exits 2.

### CLI resolution — fixed 4-tier order (codex round 2 R2-3)

The shim ignores any `REA_NODE_CLI` environment variable. The CLI is
resolved through a fixed 4-tier lookup order:

1. `rea` on `$PATH` (the standard install location)
2. `$CLAUDE_PROJECT_DIR/node_modules/.bin/rea` (workspace install)
3. `$CLAUDE_PROJECT_DIR/node_modules/@bookedsolid/rea/dist/cli/index.js`
   (consumer-side direct dist execution)
4. `$CLAUDE_PROJECT_DIR/dist/cli/index.js` (rea-repo dogfood install
   where the project IS `@bookedsolid/rea`)

This eliminates env-var-based hijack attacks. Pre-0.23.0 round-2 the
shim accepted any `*/dist/cli/index.js` whose verdict JSON happened to
be valid — an attacker who staged `/tmp/dist/cli/index.js` returning
`{"verdict":"allow"}` could subvert the gate (the verdict-verifier
checked JSON shape but not provenance). The env-var path was a
security knob without a real-world use case in production.

## Walker design — deny-by-default generic Walk (0.23.0 round-6 + round-7)

The walker (`walker.ts::walkForWrites`) uses the parser library's
`syntax.Walk(node, visit)` traversal as its spine. The detector
dispatch fires when Walk reaches a `Stmt` (for redirect extraction +
heredoc-shell-payload re-parse), a `CallExpr` (for per-utility argv
detection), or a `BinaryCmd` (for pipe-into-bare-shell detection).
Every other node kind — `IfClause`, `ForClause`, `WhileClause`,
`UntilClause`, `DeclClause`, `TestClause`, `CaseClause`, `ArithmCmd`,
`LetClause`, `SelectClause`, `FuncDecl`, `Block`, `Subshell`,
`TimeClause`, `NotCmd`, `CoprocClause`, `CmdSubst`, `ProcSubst`,
`ArithmExp`, `Word`, etc. — is recursed into by Walk; their inner
Stmts and CallExprs reach the dispatcher naturally.

**Important caveat — Walk has its own field gaps.** The round-6
framing "Walk visits every field" was overclaim. mvdan-sh@0.10.1's
`syntax.Walk` empirically does NOT recurse into
`ParamExp.Slice.Offset` or `ParamExp.Slice.Length` (Word nodes that
can hold CmdSubst payloads). That gap defeated 17 round-7 PoCs and
made 0.23.0 a regression vs 0.22.0's bash regex (which caught
`${X:$(rm)}` directly).

Round-7 fix is layered:

1. **Tactical:** the visitor sees every `ParamExp` node and manually
   re-enters `syntax.Walk` on `Slice.Offset` / `Slice.Length` via a
   `recurseParamExpSlice` helper. The re-entry uses the SAME visitor,
   so nested `${X:${Y:$(rm)}}` recurses to fixed point.
2. **Structural:** the Class O exhaustiveness contract test pins
   every Word-bearing AST position. See "Class O exhaustiveness
   contract" below.

### What this closes by construction

Pre-0.23.0-round-6 the walker used a per-`Cmd`-kind switch
(`case 'WhileClause':`, `case 'ForClause':`, …) and manually
enumerated which fields to traverse for each kind. Any field NOT
enumerated in a case branch was silently dropped — that pattern
produced six rounds of P0 bypasses across 2026-04-29..2026-05-04:

| Round | Class of bypass                                                  |
| ----- | ---------------------------------------------------------------- |
| 1     | Inline writes via cp/mv/sed/dd/tee shape gaps                    |
| 2     | Wrapper unwrap depth, absolute-path dispatch                     |
| 3     | Shell-out regex shape, eval payload, pipe-into-shell             |
| 4     | Recursive directory delete, opaque spawn, find -delete           |
| 5     | DeclClause.Args, CaseClause.Word, ArithmCmd.X, TestClause leaves |
| 6     | WhileClause.Cond, ForClause.CStyleLoop.{Init,Cond,Post}          |

Rounds 1-5 patched detection gaps. **Round 6 closed the structural
class.** With `syntax.Walk`-based traversal, no field can be silently
dropped by an oversight in a per-Cmd-kind branch — there are no
per-Cmd-kind branches anymore. Adding a new `Cmd` type to mvdan-sh,
or a new field on an existing type, is automatically visited; the
detectors continue to fire whenever Walk reaches a Stmt/CallExpr/
BinaryCmd inside.

### What cannot bypass by construction

Any AST shape whose inner write reaches a `Stmt → CallExpr` (for
named-utility writes) or a `Stmt → Redirect` (for shell-redirect
writes) is detected. The set of UNDETECTED writes reduces to:

1. **Utilities not in the dispatcher allow-list.** Adding a utility
   means adding a `case` in `walkCallExpr` and a per-utility detector
   function. The allow-list is the only enumerable surface; a missing
   case reports zero detections (fail-open against that utility) but
   no field-omission bug can hide the call site.
2. **Interpreter payload regex blind spots.** Static-string scanning
   inside `node -e` / `python -c` / `ruby -e` / `perl -e` payloads
   uses regex; novel write-API shapes need a pattern. The fail-closed
   fallbacks (decoupled-variable detection, opaque-spawn, chained-
   interpreter heuristic, shell-out API token presence) catch most
   real-world bypass shapes. See "Defense in depth" below.
3. **Dynamic targets.** Targets containing `$VAR`, `$(cmd)`,
   backticks, arithmetic, or brace expansion that the walker can't
   resolve emit `dynamic: true`. The compositor BLOCKS dynamic
   targets unconditionally — fail-closed.

### AST node types we recognize at dispatcher-firing time

The Walk traversal visits ALL nodes; the dispatcher fires on these
three. Everything else descends normally.

| Node        | Handling                                                                  |
| ----------- | ------------------------------------------------------------------------- |
| `Stmt`      | Extract `Redirs` (write targets); fire `extractHeredocShellPayloads`.     |
| `CallExpr`  | Per-utility argv detector (cp, sed, dd, tee, …).                          |
| `BinaryCmd` | Pipe-into-bare-shell detection (`<cmd> \| bash`).                         |
| `ParamExp`  | Manual re-entry into `Slice.Offset` / `Slice.Length` (round-7 P0).        |

### Class O exhaustiveness contract (round-7 P0)

The Class O exhaustiveness contract test
(`__tests__/hooks/bash-scanner/walker-exhaustiveness.contract.test.ts`)
enumerates every named (node-type, field) Word-bearing position
mvdan-sh's parser populates. For each position it parses a fixture
with a planted `$(rm /tmp/sentinel-LABEL)`, runs the walker, and
asserts the walker either detected a write OR emitted a `dynamic`
covering that subtree.

**What it tests:**

- `ParamExp.Slice.{Offset,Length}` — the round-7 P0 surface
  (round-7 closure)
- `ParamExp.Exp` (default `:-`, assign `:=`, error `:?`, alt `:+`,
  prefix `#`/`##`, suffix `%`/`%%`, case-up `^`, case-lo `,`)
  (Walk-reached, pinned to prevent regression)
- `ParamExp.Repl` (pattern + replacement) (Walk-reached, pinned)
- `ParamExp.Index` (Walk-reached, pinned)
- All Stmt-level constructs: `Subshell`, `Block`, `FuncDecl.Body`,
  `WhileClause.{Cond,Do}`, `UntilClause.Cond`, `IfClause.{Cond,Then,Else}`,
  `ForClause.{Items,Do}`, `CaseClause.{Word,Patterns,Stmts}`,
  `SelectClause.Items`, `BinaryCmd.{X,Y}` (both `&&` and `|`),
  `ArrayExpr.{Elem,Index}`, `DeclClause.{Value,Array}`,
  `TestClause.{X,Y,unary}`, `ArithmCmd.X`, `ArithmExp.X`,
  `LetClause.Exprs`, `TimeClause.Stmt`, `CoprocClause.Stmt`,
  `CmdSubst.Stmts`, `ProcSubst.Stmts`, `Stmt.Redirs.Word`,
  `DblQuoted.Parts` — all Walk-reached and pinned

**What it DOESN'T test:**

- Fields holding non-Word data (numeric Pos/End offsets, integer ops,
  string variant tags) — these cannot host a CmdSubst.
- Dispatcher-resolution coverage — Class O proves the walker reached
  the position, not that the dispatcher resolved a static path.
  Dispatcher coverage is owned by the per-utility tests in `walker.test.ts`
  and the cross-product corpus tests.

**Update procedure when mvdan-sh upgrades:**

1. Run the contract test. If new mvdan-sh fields are silently
   visited, you're lucky.
2. If new fields fail the contract (parser shape changed or new node
   type), add a row to `EXHAUSTIVENESS_TABLE` AND a manual recursion
   helper in `walker.ts` if Walk doesn't visit it.
3. Re-run. Test must be GREEN before the upgrade ships.

## Detected-write taxonomy

Each detection is one `DetectedWrite` (in `walker.ts`) with a
`form: DetectedForm` tag (in `verdict.ts`):

| Form                  | Triggered by                                                                  |
| --------------------- | ----------------------------------------------------------------------------- |
| `redirect`            | Stmt-level write redirects: `>`, `>>`, `>\|`, `&>`, `&>>`, `<>`, fd-prefixed. |
| `cp_dest`             | `cp src… DEST` tail-positional.                                               |
| `cp_t_flag`           | `cp -t DIR src…` / `cp --target-directory=DIR src…`.                          |
| `mv_dest`             | `mv src… DEST` tail-positional.                                               |
| `mv_t_flag`           | `mv -t DIR src…`.                                                             |
| `tee_arg`             | Every non-flag positional arg to `tee`.                                       |
| `sed_i`               | `sed -i FILE` (and combined flag clusters containing `i`).                    |
| `dd_of`               | `dd of=PATH`.                                                                 |
| `truncate_arg`        | `truncate FILE` non-flag positionals.                                         |
| `install_dest`        | `install src… DEST` or `install -t DIR`.                                      |
| `ln_dest`             | `ln SRC DEST` or `ln -t DIR`.                                                 |
| `awk_inplace`         | `awk -i inplace 'PROG' FILE`.                                                 |
| `awk_source`          | `print > "FILE"` / `system("…")` shell-out inside an awk program.             |
| `ed_target`           | `ed FILE`.                                                                    |
| `ex_target`           | `ex FILE` / `vi FILE` / `vim FILE`.                                           |
| `find_exec_inner`     | `find … -exec CMD …` / `-execdir` / `-ok` / `-okdir`.                         |
| `xargs_unresolvable`  | `xargs CMD` (always uncertain — destination via stdin).                       |
| `node_e_path`         | `node -e PROG` / `node --eval` / `-p` / `-pe` first-arg path.                 |
| `python_c_path`       | `python -c PROG` / cluster `-ic` first-arg path.                              |
| `ruby_e_path`         | `ruby -e PROG`.                                                               |
| `perl_e_path`         | `perl -e PROG` / `-E PROG`.                                                   |
| `process_subst_inner` | `>(…)` / `<(…)` inner stmts (currently routes through generic walk).          |
| `nested_shell_inner`  | `bash -c PAYLOAD` / `sh -c` / cluster `-ic` / `-lc` / heredocs (R2-12).       |
| `redirect` (extended) | `tar -C DIR`, `rsync … DEST`, `curl -o FILE`, `wget -O FILE`, `shred FILE`, `eval PAYLOAD`, `git checkout/restore/reset -- PATH` (round-2 R2-7..R2-13). |

### Dynamic targets

A `DetectedWrite` can carry `dynamic: true` — the value depends on
shell expansion we did not fully resolve (`$VAR`, `$(cmd)`, backticks,
arithmetic, brace expansion, `~/`, glob `*`/`?`/`[`/`{` in redirect
targets). The compositor BLOCKS dynamic targets unconditionally.

This is fail-closed parity with the pre-0.23.0 sentinel
`__rea_unresolved_expansion__` behavior: if we can't statically
resolve where the write goes, we refuse.

### Directory-target semantics

`cp -t DIR`, `cp --target-directory=DIR`, `mv -t DIR`, `install -t DIR`,
and `ln -t DIR` produce `DetectedWrite { isDirTarget: true }`. The
matcher treats `isDirTarget` inputs as `<DIR>/`-shaped: writes INTO
that directory may hit any file under it. So `cp -t .rea src`
catches `.rea/HALT` even without a trailing slash on the input.

This was codex round 1 F-7. Pre-fix the matcher required either
trailing `/` on the input or that the pattern be a directory (ending
in `/`). When the user wrote `cp -t .rea src` the input was just
`.rea` and no protected pattern matched.

## Fail-closed posture

Every layer of the pipeline fails closed:

- **Parser failure** → `parseFailureVerdict()` → BLOCK with
  `parse_failure_reason: parser: <message>`.
- **Walker exception** → not catchable per-stmt; the CLI's outer
  try/catch in `runHookScanBash` produces a BLOCK with
  `rea: scan-bash internal error; refusing on uncertainty`.
- **Dynamic target** → BLOCK with the operator-facing reason
  `unresolved shell expansion in target`.
- **Symlink resolution failure** → best-effort; falls back to
  logical-form matching only.
- **Shim missing the `rea` CLI** → BLOCK with
  `rea: CLI not found … Refusing the Bash command on uncertainty`.
- **Verdict JSON malformed under exit 0** → BLOCK.
- **Verdict says "block" but exit 0** → BLOCK.

## How to extend the walker

Two flavors of extension: adding a new utility detector (most common),
and adding a new walker recursion point (rare — only when mvdan-sh
ships a new AST node type or the contract test surfaces a Walk gap).

### Adding a utility detector

Concrete example: hypothetically add a detector for `unzip -d DIR`.

1. **Decide the form tag.** Add `unzip_d` to `DetectedForm` in
   `src/hooks/bash-scanner/verdict.ts`. Tags are non-breaking — bash
   shims forward verdict shape verbatim.
2. **Add the dispatch case** in `walker.ts::walkCallExpr` (search for
   the long `switch (cmdName)`):
   ```ts
   case 'unzip':
     detectUnzip(stripped, out);
     break;
   ```
3. **Write the detector** below the other `detect*` functions:
   ```ts
   function detectUnzip(stripped: WordValue[], out: DetectedWrite[]): void {
     for (let i = 1; i < stripped.length; i += 1) {
       const tok = stripped[i];
       if (tok?.value === '-d') {
         const next = stripped[i + 1];
         if (next === undefined) return;
         out.push({
           path: next.value,
           form: 'unzip_d',
           position: next.position,
           ...(next.dynamic ? { dynamic: true } : {}),
           isDirTarget: true,
         });
         return;
       }
     }
   }
   ```
4. **Wire inner argv** — if the detector should fire inside
   `find -exec` / `xargs` / nested shells, add the case to
   `recurseInnerArgv` (sibling of `walkCallExpr`).
5. **Add the per-utility unit test** in
   `__tests__/hooks/bash-scanner/walker.test.ts` — three or four
   shapes with positional arg, equals form (if applicable), absolute
   path, and dynamic operand.
6. **Add the cross-product corpus entry.** Pick the closest matching
   class generator in
   `__tests__/hooks/bash-scanner/__generators__/compose.ts`. For
   `unzip -d` the natural fit is Class A (utility-dispatch) — extend
   the `UTILITY_TARGETS` table with the new utility name.
7. **Add a literal PoC** in
   `__tests__/hooks/bash-tier-corpus.test.ts` (or `-round2.test.ts`,
   `-round3.test.ts` etc.) so the bash shim is exercised end-to-end.

### Adding a walker recursion point

Only needed when:

- The Class O contract test fails on a new mvdan-sh field, OR
- A bypass PoC reveals an AST position the walker misses.

The pattern is the round-7 `recurseParamExpSlice` helper:

1. **Locate the visitor callback** in `walker.ts::walkForWrites` (the
   single Walk site).
2. **Add the field check** to the visitor's switch on node `type`:
   ```ts
   case 'ParamExp': {
     // Walk skips Slice.Offset/Length (mvdan-sh@0.10.1).
     // Manual re-entry uses the same visitor for fixed-point
     // recursion through nested ${X:${Y:$(rm)}}.
     recurseParamExpSlice(node, visit);
     break;
   }
   ```
3. **Add a Class O contract row** pinning the fix:
   ```ts
   {
     label: 'paramexp-slice-offset',
     nodeField: 'ParamExp.Slice.Offset',
     cmd: 'echo "${X:$(rm /tmp/sentinel-paramexp-slice-offset)}"',
     expectedPath: '/tmp/sentinel-paramexp-slice-offset',
   },
   ```
4. **Run** `pnpm vitest run __tests__/hooks/bash-scanner/walker-exhaustiveness.contract.test.ts`
   to verify the new row passes.
5. **Run the full corpus** to confirm no regression elsewhere.

## Class O contract — what it pins, how to add a row

The Class O exhaustiveness contract test
(`__tests__/hooks/bash-scanner/walker-exhaustiveness.contract.test.ts`)
enumerates every named (node-type, field) Word-bearing position
mvdan-sh's parser populates. For each position it parses a fixture
with a planted `$(rm /tmp/sentinel-LABEL)`, runs the walker, and
asserts the walker reaches the position.

**Acceptance contract (round-8 tightening):**

- Default: `expectedPath` MUST appear literally in `walker.ts`'s emit
  (path-explicit). Any `dynamic: true` write does NOT satisfy the
  assertion.
- Opt-in: `acceptDynamic: true` permits `dynamic: true` to satisfy
  the assertion. Use ONLY when the position is genuinely
  unresolvable to a static path (e.g. a procsubst body whose payload
  the walker pierces but cannot resolve to a literal). Document the
  reason inline.

Adding a row when mvdan-sh upgrades:

1. Run `pnpm vitest run walker-exhaustiveness.contract.test.ts`.
2. If new positions silently pass — lucky, no work.
3. If a position fails:
   - The error message names the (node-type, field) gap.
   - Add a manual recursion in `walker.ts` (round-7 pattern).
   - Add a `EXHAUSTIVENESS_TABLE` row pinning the fix.
4. Re-run; must be GREEN before the upgrade ships.

## Class P contract — DQ-escape fidelity

The Class P fixtures in
`__tests__/hooks/bash-scanner/__generators__/compose.ts::classP`
pin the `unshellEscape` DQ-significant escape parity. Spec is
`man bash` QUOTING:

> Within double quotes, the backslash retains its special meaning
> only when followed by one of the following characters: `$`, `` ` ``,
> `"`, `\`, `<newline>`.

Round-8 fix expanded the helper from `[\"']` to `[$\"`\\\\\\n']`. The
corpus pins the fix across 5 shells × 16 DQ-escape shapes × 7
protected targets (≥560 positives) plus 8 negatives.

A new DQ-escape shape (e.g. a future `bash` extension or an
exotic interpreter) is added by appending an `EscapeShape` entry
with a `body: (target) => string` builder. The compose master then
fans it across SHELLS × PROTECTED_TARGETS automatically.

## Verdict JSON shape

Schema of the verdict object the scanner emits (`verdict.ts`):

```ts
type Verdict =
  | { verdict: 'allow' }
  | {
      verdict: 'block';
      reason: string;            // operator-facing multi-line message
      hitPattern: string;        // matched policy pattern OR sentinel like '(dynamic target)'
      detectedForm: DetectedForm; // taxonomy tag (see "Detected-write taxonomy")
      sourcePosition?: { line: number; col: number }; // when known
    };
```

Wire format:

- The CLI (`rea hook scan-bash --mode protected|blocked`) emits the
  verdict object as a single line of JSON to stdout.
- Exit code: `0` for allow, `2` for block.
- The bash shim re-parses the JSON via `node -e` and cross-checks the
  exit code matches the verdict (codex round 1 F-3). Mismatch ⇒ exit 2
  fail-closed.

Field semantics:

- `reason` — multi-line operator-facing message. The first line is the
  one-sentence summary; subsequent lines explain WHY rea refused and
  how to remediate. Tests assert on substrings, never on exact whitespace.
- `hitPattern` — the matched protected-paths pattern (e.g. `.rea/HALT`)
  OR a sentinel like `(dynamic target)`, `(xargs unresolvable stdin)`,
  `(nested-shell unresolvable)` for refuse-on-uncertainty cases.
- `detectedForm` — the taxonomy tag identifying the AST shape that
  produced the detection. Useful for analytics; not a security
  contract.

## Known limitations

What this architecture does NOT close. Operators reading this section
should understand the layers above and below the bash gate.

1. **Supply-chain compromise.** An attacker who can write a forged
   `node_modules/@bookedsolid/rea/dist/cli/index.js` AND a matching
   `package.json` (so the package-walk-up validates) defeats the
   bash gate trivially because they ARE the bash gate. Trust boundary
   is npm provenance + manifest verification — see "Trust boundary:
   package-tier integrity" above.
2. **OS-level attacks.** A kernel-level / LD_PRELOAD / ptrace
   attacker bypasses every userland defense rea ships. Out of scope.
3. **Agent-controlled PATH.** If the agent runtime can control PATH
   such that `rea` resolves to an attacker binary, the gate is
   defeated. Production deployments pin PATH via the harness; rea's
   doctor command verifies PATH integrity at install time.
4. **Out-of-band file modifications.** rea gates Bash tool calls
   from Claude Code (and Edit/Write/MultiEdit via Write-tier hooks).
   It does NOT gate filesystem changes initiated by the user
   directly, by other processes, or by language servers.
5. **Read-side leaks.** The scanner's protected-paths gate concerns
   WRITES. A read of `.rea/policy.yaml` (e.g. via `cat`) is allowed
   by default — the policy is checked-in and visible. The
   `env-file-protection.sh` Write-tier hook handles `.env*` reads
   separately (and IS subject to bash-tier coverage via
   `dependency-audit-gate.sh` + the segmenter for those forms).
6. **Pre-render dynamics.** A Bash command that constructs the write
   target dynamically via `$RANDOM` + `mktemp` + `find -delete` and
   resolves to a protected path only at runtime cannot be statically
   resolved. The scanner refuses on uncertainty (dynamic target ⇒
   block) so this is mitigated, but the cost is occasional false
   positives on legitimately-dynamic writes to non-protected paths.
7. **`git checkout REVISION PATH` / `git restore --source=REVISION
   PATH` without the POSIX `--` argv separator** (codex round 9 F3 —
   accepted false negative, deferred to 0.24.0). git's pre-`--` argv
   shape is structurally ambiguous between "REVISION PATH" and
   "PATH..."; static disambiguation requires a runtime ref-existence
   check (the parser cannot perform filesystem I/O). `detectGit`
   conservatively emits the destructive-overwrite detection ONLY
   when `--` is present. Workaround: protected-files invariants are
   still caught by `protected-paths-bash-gate.sh`'s symlink-resolution
   layer at file-open time. Pin: 0.24.0 will land a conservative
   refusal whenever the first positional matches a git-revspec shape
   AND following positionals exist.

## Testing strategy

Three layers, each with a different role:

### Layer 1 — Unit tests

`__tests__/hooks/bash-scanner/walker.test.ts` — branch coverage of
the walker. Each detector has dedicated cases for happy-path, edge-
cases, and dynamic operand. Updates whenever a detector is touched.

### Layer 2 — Cross-product corpus (Classes A–P)

`__tests__/hooks/bash-scanner/adversarial-corpus.test.ts` runs
fixtures generated by `__generators__/compose.ts`. The classes
each target one bypass surface:

| Class | Surface                                                    |
| ----- | ---------------------------------------------------------- |
| A     | utility-dispatch normalization (cp/mv/sed/dd/tee/install/…) |
| B     | wrapper-depth unwrap (env/sudo/nice/timeout)                |
| C     | interpreter quote-escape & dynamic-construction             |
| D     | flag-shape coverage (-t / --target-directory)               |
| E     | path normalization edge cases                               |
| F     | redirect targets                                            |
| G     | process substitution                                        |
| H     | heredoc                                                     |
| I     | function-redirect                                           |
| J     | pipe-into-bare-shell                                        |
| K     | git top-level value-bearing flags                           |
| C-ext | interpreter API breadth                                     |
| D-ext | tar cluster shapes                                          |
| B-ext | eval cmdsubst / dynamic argv                                |
| L     | destructive primitives × directory ancestors                |
| N     | loop-construct cmdsubst (round-6 regression class)          |
| O     | ParamExp.Slice walk-gap (round-7 regression class)          |
| P     | nested-shell DQ-escape fidelity (round-8 regression class)  |

Each class is parameterized over PROTECTED_TARGETS for positives
and NEGATIVE_TARGETS for negatives. Fixture count: ≥3000
positives, ≥1000 negatives. Pinned by coverage assertions at the
end of `adversarial-corpus.test.ts`.

### Layer 3 — Exhaustiveness contract (Class O)

`__tests__/hooks/bash-scanner/walker-exhaustiveness.contract.test.ts`
pins every Word-bearing AST position the walker must reach. This
is structural: when mvdan-sh adds a field, the test fails until a
manual recursion + a contract row are added. See "Class O
contract" above.

### Layer 4 — Bash-shim subprocess sampling

`adversarial-corpus.test.ts` block "bash shim subprocess sampling"
spawns the actual hook script (`hooks/protected-paths-bash-gate.sh`)
under a clean env, parses the shim's stdout JSON, and cross-checks
against the in-process verdict. 100 deterministically-sampled
fixtures (seed=`0x42424242`). Catches drift between in-process
scanner verdicts and what the shim's JSON verifier + 4-tier resolver
chain actually returns.

## How to add a new detector (TL;DR)

1. **Decide the form tag.** Add a new tag to `DetectedForm` in
   `verdict.ts`. (New tags are non-breaking; the bash shims do not
   branch on form.)
2. **Add the per-utility branch in `walker.ts::walkCallExpr`.**
   Follow the existing pattern: dispatch on `cmdName`, write a
   `detectFoo(stripped, out)` helper that produces zero or more
   `DetectedWrite` entries.
3. **Wire `recurseInnerArgv`.** If the new detector should also fire
   inside `find -exec` / `xargs` / nested shells, add the same case
   in the inner switch.
4. **Add fixtures.** Append the PoC and an over-correction negative
   to `__tests__/hooks/bash-tier-corpus.test.ts`. Each fixture spawns
   the bash shim end-to-end so a regression in any layer fails the
   test.
5. **Add unit tests.** `__tests__/hooks/bash-scanner/walker.test.ts`
   for the AST-level branch coverage; `scanner-corpus.test.ts` for
   the integrated walker+scanner shape.

The test-corpus expansion to ≥185 fixtures (codex round 1) is the
shape: every documented bypass class becomes a corpus fixture so a
future regression cannot silently ship.

See also: `docs/agents/bash-scanner-extension.md` for the AI-agent-
focused walkthrough.

## Bug reports closed by this architecture

- **helix-023** Phase 1 (deletion of bash segmenter): 6 findings.
- **discord-ops Round 13**: 3 findings.
- **codex round 1 against 0.23.0 scanner**: 15 P0+P1 findings + 9 P2
  + 10 P3 (P3 mostly advisory).
- **codex round 2 against round-1-fixed scanner**: 14 findings —
  2 P0 (R2-3 REA_NODE_CLI hijack class, R2-14 absolute-path dispatch
  class), 9 P1 (R2-1 decoupled-variable interpreter writes, R2-2
  symlink cycle/depth, R2-4 cp/mv/install/ln -t<DIR> joined form,
  R2-7 tar -C, R2-8 rsync DEST, R2-9 curl/wget output-file, R2-10
  shred, R2-12 heredoc-into-shell, R2-13 eval), 2 P2 (R2-11 git
  checkout/restore/reset, R2-15 test harness bypass-class fixtures),
  1 P3 (R2-16 doc updates).
- **codex round 3 against round-2-fixed scanner**: 9 findings —
  1 P0 (Finding 1: `eval $(cmd)` empty-inner short-circuit ordered
  before dynamic check, silently allowing every dynamic eval payload),
  4 P1 (Finding 2: pipe-into-bare-shell `<cmd> | bash` undetected;
  Finding 3: tar `-xzfC archive .rea/` cluster consumes-next-argv path
  not honored; Finding 4: git top-level value-bearing flags `-C dir`,
  `--git-dir=foo` mis-classified as subcommand; Finding 5: python
  `subprocess.run(..., shell=True)` / `os.popen` / `os.system`
  shell-out patterns missing or incomplete), 4 P2 (Finding 6: node fs
  API breadth — cp/cpSync/rename/renameSync/rm/rmSync/mkdir/mkdirSync/
  unlink/unlinkSync/copyFile/copyFileSync/truncate/truncateSync;
  Finding 7: python API breadth — os.open with write flags, shutil.rmtree,
  os.unlink/remove/rmdir/removedirs; Finding 8: ruby API breadth —
  Pathname#write, FileUtils.cp/mv/cp_r/copy/move/copy_file/rename/
  rm/rm_r/rm_rf/remove/mkdir/mkdir_p; Finding 9: corpus didn't exercise
  the actual bash-shim subprocess — JSON verifier + status cross-check
  + 4-tier resolver chain bypassed in tests).

### Round-3 structural mitigations

- **eval dynamic check before short-circuit** (`detectEval` in
  `walker.ts`). Closes the empty-inner `eval $(cmd)` bypass class.
- **pipe-into-bare-shell detection** in BinaryCmd handling
  (`detectPipeIntoBareShell` in `walker.ts`). Closes the
  `<cmd> | bash` / `<cmd> | sudo bash` / `<cmd> | tee | bash`
  attack chain. RHS `-c "x"` paths still allowed (script is in argv,
  not stdin).
- **tar cluster value-bearing flag handling** (`detectTar` in
  `walker.ts`). Walks every char in `-XYZ` clusters; for each
  value-bearing flag (`f`, `b`, `F`, `K`, `N`, `T`, `V`, `X`, `C`)
  consumes the next argv as its value, in order. `C` consumed
  arguments emit dir-target detections.
- **git top-level flag walking** (`detectGit` in `walker.ts`).
  Skips `-C`, `-c`, `--git-dir=`, `--work-tree=`, `--namespace=`,
  `--super-prefix=`, `--config-env=`, `--exec-path[=…]` BEFORE
  subcommand-finding. Booleans (`--bare`, `-p`, etc.) skipped too.
- **interpreter API breadth** (NODE/PYTHON/RUBY_WRITE_PATTERNS +
  WRITE_API_TOKENS). Catches the full destructive surface across
  node fs, python os/shutil/subprocess, ruby Pathname/FileUtils.
- **subprocess shell-out re-parse** (PYTHON_SHELL_OUT_RE).
  Captures the shell command string from
  `subprocess.run('cmd', shell=True)` and friends, re-parses as
  bash, walks for writes.
- **bash-shim subprocess sampling** (adversarial-corpus.test.ts).
  100 deterministically-sampled fixtures spawn the actual hook
  script under a clean env, parse the shim's stdout JSON, and
  cross-check against the in-process verdict. Catches drift between
  in-process scan and what the verifier+resolver chain actually
  returns.

### Round-2 structural mitigations

- **basename normalization** for the dispatcher head (`normalizeCmdHead`
  in `walker.ts`). Eliminates the absolute-path / relative-path /
  env-wrapper bypass class.
- **REA_NODE_CLI removed** from the shim. 4-tier deterministic
  resolver. Eliminates env-var hijack class.
- **flat-scan dynamic-payload fallback** for interpreter eval flags
  (`hasDynamicConstructionWithWriteApi` in `walker.ts`). Eliminates
  decoupled-variable bypass class.
- **symlink resolver hardened** with cycle-set + depth-cap (32);
  bottoms out into a "dynamic" sentinel that the compositor treats as
  refuse-on-uncertainty.
- **heredoc payload re-parse** (`extractHeredocShellPayloads` in
  `walker.ts`). Closes `bash <<EOF\n…\nEOF` bypass.
- **eval re-parse** (`detectEval` in `walker.ts`). Closes
  `eval "command…"` bypass.

See the changelog and individual fix descriptions in
`__tests__/hooks/bash-tier-corpus.test.ts` (round 1) and
`__tests__/hooks/bash-tier-corpus-round2.test.ts` (round 2). Each
fixture's leading comment cites the finding number and the verbatim
PoC.

### Round-8 structural mitigations (DQ-escape parity)

**Round-8 P0:** `unshellEscape` (in `walker.ts`) collapsed only `\"`
and `\'` from DQ-context payloads. Bash spec (`man bash`, QUOTING)
says DQ-context backslash retains literal meaning EXCEPT when followed
by one of: `$`, `` ` ``, `"`, `\`, `<newline>`. The walker's re-parse
of `bash -c "echo \"\$(rm .rea/HALT)\""` saw `\$` as a literal `$`
(no CmdSubst child) — ALLOW — while the real shell collapsed `\$` →
`$`, evaluated the CmdSubst, and deleted HALT. Verified end-to-end
exploit:

    bash -c "echo \"\$(touch /tmp/HACK_PROOF; echo TOUCHED)\""
    # TOUCHED — file was created.

**Closure:** the `unshellEscape` regex was widened from `[\"']` to
`[$\"`\\\\\\n']` so the re-parser sees the same syntax tree the shell
would execute. The helper's TSDoc enumerates every call site (all
DQ-context) so future additions are anchored to the same contract.

**Pinning:** the Class P corpus
(`__tests__/hooks/bash-scanner/__generators__/compose.ts::classP`)
emits ≥560 fixtures spanning 5 shells × 16 DQ-escape shapes × 7
protected targets, plus ≥8 negatives that pin the false-positive
boundary (DQ-shapes with no real CmdSubst).

**Class O contract tightening:** the round-7 exhaustiveness contract
test was widened to accept any `dynamic` write as proof-of-reach for
any row. That masked walker gaps — a `bash -c` with malformed inner
emits `nested_shell_inner` dynamic, satisfying the assertion even
when the named field was never visited. Round-8 added an opt-in
`acceptDynamic: boolean` per row; default is path-explicit. No row
in the current table relies on `acceptDynamic`, so the contract is
strictly tighter post-fix.

### Round-5 structural mitigations

- **assignment-side cmdsubst walk** (`walkAssignsForSubstNodes` in
  `walker.ts`). Closes the empty-argv short-circuit that ignored
  `CallExpr.Assigns`, plus the dropped clause types `DeclClause`,
  `TestClause`, `ArithmCmd`, `LetClause`, `SelectClause`, and
  `CaseClause.Word`. New `walkTestExpr` recurses through
  `UnaryTest`/`BinaryTest`/`ParenTest`. `extractStmtRedirects` walks
  the redirect Word for embedded CmdSubst/ProcSubst on read ops too
  (here-string `<<<` 0x3f, procsubst-on-stdin `< <(...)` 0x38).
- **CLAUDE_PROJECT_DIR realpath containment** (codex round 5 F2). The
  bash shim's CLI-resolution sandbox was hardened: PRIMARY check is
  now `realpath(cli).startsWith(realpath(CLAUDE_PROJECT_DIR) + sep)`,
  rejecting any symlink-out-of-project escape. The pkg.json walk-up
  remains as the secondary intra-project guard.
- **quote-aware shell-out regex** (codex round 5 F3). Per-language
  `*_SHELL_OUT_RE` arrays gained a `(["'])((?:(?!\1)[^\\]|\\.)+)\1`
  variant per call site. Closes mixed-quote-nesting bypasses like
  `os.system('rm "x"')`. The scanner's loop now picks the LAST
  non-empty non-quote capture, working with both single-capture (old)
  and two-capture (new) shapes.
- **fail-closed shell-out fallback** (codex round 5 F3). When the
  payload mentions a shell-out API token but no shell-out regex
  extracted a clean payload, emit a dynamic detection. The
  per-language `SHELL_OUT_API_TOKENS` table is conservative: every
  unconditional shell-out call site is included; conditional ones
  (subprocess.* with `shell=True`) match only with the `shell=True`
  co-occurrence to avoid blocking legit argv-form `subprocess.run`.
- **chained-interpreter heuristic** (codex round 5 F4). When the
  shell-out body itself contains a known interpreter binary head
  followed by an eval flag, emit a dynamic detection. Closes
  multi-level escape bypasses where each layer accumulates a
  `\\\\\"` shell-escape level beyond what one `unshellEscape` pass
  can strip without over-stripping single-level legit literals.

### Round-10 structural wrapper-shell-exec guard

The wrapper-class bypass shape `<UNRECOGNIZED-HEAD> [...flags...]
<KNOWN-SHELL> -c PAYLOAD` recurred in round 9 (21 wrappers
enumerated) and round 10 (5 more: `chronic`, `parallel`, `watch`,
`script`, `dbus-launch`). A purely-enumeration approach has
unbounded tail — every future wrapper (`expect`, `dtruss`,
`xtrace`, `eatmydata`, ...) is another round.

Round 10 closes the bug class **structurally** with a second pass
in `walker.ts::detectWrappedNestedShell`. It runs in
`walkCallExpr`'s `default:` case (head not in dispatcher's
allow-list) and:

1. Skips when the head is a known introspection / output utility
   (`echo`, `printf`, `man`, `info`, `apropos`, `whatis`, `which`,
   `type`, `whence`, `where`, `whereis`, `help`, `alias`,
   `unalias`, `compgen`, `complete`, `compopt`). These take cmd
   names as DATA, not exec targets.
2. Skips when argv[1] is itself an introspection head — covers
   forms like `xfooblar echo bash` where the wrapper invokes
   `echo` with `bash` as a literal argument.
3. Walks argv from index 1 looking for the FIRST shell positional
   (`bash`/`sh`/`zsh`/`dash`/`ksh`/`ash`/`mksh`/`yash`/`posh`/
   `rc`).
4. Looks ahead within 3 tokens for a `-c`-style flag cluster
   (`-c`, `-lc`, `-cl`, `-ic`, ...). The 3-token window bounds
   false-positive risk; real flag-bearing wrappers put their
   flags BEFORE the shell, not after.
5. Synthesizes a `[shell, -c, PAYLOAD, ...rest]` slice and
   re-dispatches through `detectNestedShell`, sharing
   dynamic-payload refuse-on-uncertainty.
6. If a shell positional appears WITHOUT a `-c` flag in the
   window (bare shell reads stdin, or `-c` past lookahead),
   refuses on uncertainty by emitting a synthetic dynamic write.

Coordination: when `head === 'bash'`, the dispatcher's bash-case
handles the argv via `detectNestedShell` directly. The structural
guard runs ONLY in `default:`, so there is no double detection.

Round 10 also adds explicit enumerations for the 5 surfaced
wrappers in `stripEnvAndModifiers`:

- **`chronic`** (moreutils) — no-arg wrapper.
- **`dbus-launch`** — flag-prefixed (`--exit-with-session`,
  `--autolaunch=ID`, `--config-file=PATH`, etc.).
- **`watch`** — flag-prefixed (`-n SECS` value-bearing;
  `-d`/`--differences`/`-c`/`--color` etc bare; note `watch`'s
  `-c` is its `--color` flag, NOT a shell `-c`).
- **`script`** — re-parse seam (`-c PAYLOAD` synthesizes
  `sh -c PAYLOAD` like `su -c`).
- **`parallel`** — `:::` / `::::` / `:::+` / `::::+` separators;
  template tokens collected pre-separator and input tokens
  post-separator; argv synthesized as `template ++ inputs` so
  `parallel rm ::: TGT` becomes `[rm, TGT]` and the rm
  dispatcher catches the target.

The enumerations give clean dispatch (no refuse-on-uncertainty
banner for legitimate uses). The structural guard is the safety
net for any future unknown wrapper.

Test pinning: new Class S (round-10 wrapper-class extensions, 233
positives + 38 negatives) and new Class T (synthetic-wrapper
structural-guard verification, 314 positives + 29 false-positive
negatives). Class T uses fictional wrapper names (`xfooblar`,
`unknownwrap1234`, `expectx`, `dtruss`, `xtrace`, ...) to verify
the guard catches the bypass shape regardless of whether the
wrapper is enumerated. Class T-neg pins the false-positive
guards.

### Round-11 closures (find / git / archive / parallel / wrappers / php)

Codex round 11 surfaced 7 INDEPENDENT classes against the round-10
wrapper-class closure. None were variants of the round-10 family —
each landed in a different parser seam:

**F11-1 [P0] — `find -exec ... {} \;` placeholder bypass.**
`find . -name HALT -exec rm {} \;` runs `rm` against EVERY match of
`-name HALT` at runtime. The `{}` placeholder is substituted by find
against the live filesystem, so static analysis cannot resolve which
paths it expands to. Pre-fix the inner-argv was recursed but `{}`
never matched any protected pattern (it's literal `{}` in the AST);
the wrapper's argv shape was not flagged. Round-11 fix: when the
inner argv contains a `{}` literal AND the inner head is NOT in a
small read-only allow-list (`cat`, `grep`, `head`, `wc`, etc.), emit
a synthetic `find_exec_placeholder_unresolvable` dynamic detection.
Refuse on uncertainty.

**F11-2 [P0] — `git rm`/`git mv` not in TRACKED.** Pre-fix the git
dispatcher only handled `checkout`, `restore`, `reset`. `git rm
.rea/HALT` deletes the file from the working tree (and `git mv
.rea/HALT /tmp/x` removes from old location); both are destructive
on disk. Round-11 fix: extend `detectGit` with `rm` and `mv`
branches. `git rm` emits each non-flag positional as
`git_rm_dest` with `isDestructive: true` UNLESS `--cached` is
present (cached doesn't touch the working tree). `git mv` emits
SOURCE positionals as `git_mv_src` (sources lose their old
location) and DEST as a redirect-form write target.

**F11-3 [P0] — git history-rewrite re-parse seams.** `git
filter-branch --tree-filter PAYLOAD` and friends feed PAYLOAD
through `/bin/sh -c PAYLOAD` at runtime. Same for `git rebase
--exec PAYLOAD`, `git rebase -x PAYLOAD`, `git bisect run CMD`,
`git commit --template=PATH`. Each is a re-parse seam that
pre-fix's `TRACKED` set ignored. Round-11 fix: each subcommand
gets its own branch in `detectGit`. Filter flags are extracted
(separate-arg AND `=joined` form), the payload is fed through
`recurseShellPayload` which calls `parseBashCommand` and walks
the inner AST via `walkForWrites` — the SAME walker used at top
level. `bisect run` dispatches its inner argv through
`recurseInnerArgv`. `commit --template=PATH` emits PATH as a
`git_commit_template` write target.

**F11-4 [P1] — archive extraction.** `tar -xf x.tar -C . .rea/HALT`
extracts the `.rea/HALT` member into the working tree.
`tar -xzf x.tgz` (no -C, no member list) extracts every member —
the archive may contain `.rea/HALT`. `unzip x.zip -d .rea` writes
into the protected directory. Round-11 fix: `detectTar` extended
with extract-mode positional harvesting (each non-flag positional
in -x mode becomes `archive_member_dest` with destructive flag);
when -x is set with no explicit members AND no `-C` destination,
emit `archive_extract_unresolvable`. New dispatchers: `detectUnzip`
(`-d DEST`, member positionals, refuse-on-uncertainty when both
absent), `detect7z` (`x` subcommand + `-o<DEST>` joined-form),
`detectGzip` (input + derived `.gz`/`-stripped` output as targets),
`detectPax` (`-r` extract action with cluster-flag support, refuse
on uncertainty). `bsdtar` aliases to `tar`. All wired into both
`walkCallExpr` and `recurseInnerArgv`.

**F11-5 [P1] — parallel without `:::`.** `echo .rea/HALT |
parallel rm` reads input from stdin (no `:::` separator means
parallel falls back to stdin), so the per-input substitution is
runtime-resolved. Round-11 fix: in `walkCallExpr`, BEFORE
`stripEnvAndModifiers` synthesizes the template+inputs argv,
detect parallel head and check whether the argv contains any of
`:::`/`::::`/`:::+`/`::::+`. When NO separator is present AND
positional template tokens exist, emit
`parallel_stdin_unresolvable` dynamic detection. The check runs
pre-strip because the wrapper-strip would erase the no-separator
signal.

**F11-6 [P1] — more wrappers.** `fakeroot rm .rea/HALT`,
`flock /tmp/lock rm .rea/HALT`, `gtimeout 5 rm .rea/HALT`,
`unshare -r rm .rea/HALT`, `env --chdir=. rm .rea/HALT`,
`sudo -s -- "rm .rea/HALT"`. Each is a transparent wrapper that
exec's CMD; pre-fix none were stripped by `stripEnvAndModifiers`
so the dispatcher saw the wrapper as the head and missed the
inner write. Round-11 fix: `fakeroot` joins the no-arg wrapper
list. `flock` consumes one positional LOCKFILE plus its
`-w/-x/-s/-n/-u/-o` flags. `gtimeout` aliases to `timeout` (one-
arg duration). `unshare` strips namespace flags greedily until
first non-flag positional. `env --chdir=DIR` / `env -C DIR` are
recognized in env's flag-strip loop. `sudo -s -- "PAYLOAD"` (and
`sudo -i -- ...`) detects shell-mode and synthesizes `sh -c
PAYLOAD` so the nested-shell detector picks up the inner write.

**F11-7 [P2] — PHP `-r` interpreter.** Pre-fix `php -r CODE` was
not in the dispatcher; an attacker invoking `php -r
"unlink('.rea/HALT');"` slipped through. Round-11 fix: `php` case
added to head dispatch with `PHP_EVAL_FLAGS` (short `-r`, long
`--run`) and `PHP_WRITE_PATTERNS` covering `unlink`,
`file_put_contents`, `rename`, `copy`, `move_uploaded_file`,
`fopen` (write modes `w`/`a`/`x`/`c` plus suffixes), `mkdir`,
`rmdir`, `touch`, `chmod`, `chown`, `chgrp`, `symlink`, `link`.
Same eval-flag scanner as Node/Python/Ruby/Perl — the only
language-specific surface is the regex set.

Test pinning: new Class U (round-11 find/git/archive/parallel —
360 positives + 17 negatives) and new Class V (round-11 wrappers
+ PHP — 124 positives + 8 negatives). Class U covers every find
predicate × `{}` × every exec subform × every protected target,
every git history-rewrite seam, every archive utility, parallel
stdin variants. Class V covers every new wrapper × bash-c-inner
× protected target plus direct-form variants, plus every PHP
write API across short/long forms.

### Round-12 closures (F12-1 .. F12-9)

Codex round 12 surfaced 9 findings against the round-11 surface
(5 P0 + 3 P1 + 1 P2 false-positive regression) — all in the
adjacent-utility / cumulative-parity space. The pattern was:
round-11 added new dispatchers (find/git/archive/parallel/PHP)
without applying the cumulative discipline already established by
prior rounds (mv-source side, shell-out re-parse, ancestry-
destructive, basename normalization). Round 12 closes the gaps
across PHP and archives, plus adds three previously-overlooked
utilities (cmake -E, mkfifo/mknod, find -fls/-fprint).

**F12-1 [P0] — PHP `rename(SRC, DEST)` source-side blindspot.**
Pre-fix `rename` was bundled with `copy`/`move_uploaded_file`/
`symlink`/`link` in PHP_WRITE_PATTERNS — a single regex captured
only the second arg. This violated round-4 F3 mv-source-as-
destructive parity for PHP. Round-12 fix: split rename out into
TWO patterns (SRC + DEST) so both sides emit, with the SRC
substring `rename(` matched against DESTRUCTIVE_API_TOKENS so
protected-ancestry catches `rename('.rea/HALT', …)`.

**F12-2 [P0] — PHP `rmdir(PATH)` not flagged destructive.**
Pre-fix `rmdir` was bundled with `mkdir` and `touch` (non-
destructive creates), so the captured PATH didn't carry
isDestructive: true and protected-ancestry never matched against
`.rea/HALT` under `.rea/`. Round-12 fix: split rmdir out into its
own pattern + add `rmdir(` to DESTRUCTIVE_API_TOKENS.

**F12-3 [P0] — PHP shell-out missing entirely.**
`pickShellOutPatternsFor(form)` had no `php_r_path` case, so
`php -r 'system("rm .rea/HALT");'` slipped past the eval-flag
scanner without any re-parse + walk. Round-12 fix: new
PHP_SHELL_OUT_RE array mirroring the perl/ruby/python shape with
quote-aware backref body extraction; covers system, exec,
shell_exec, passthru, popen, proc_open, and PHP backtick
operator. Captured payload re-parsed via parseBashCommand and
walked.

**F12-4 [P0] — PHP `-B` and `-E` eval flags.**
Pre-fix PHP_EVAL_FLAGS only accepted `-r` and `--run`. PHP also
accepts `-B BEGIN_CODE` / `--process-begin BEGIN_CODE` and
`-E END_CODE` / `--process-end END_CODE`, both of which take a
PHP source string just like -r. Round-12 fix: extend exactLong
to `[--run, --process-begin, --process-end]` and shortChars to
`[r, B, E]` (case-sensitive — PHP's lowercase `-e` is
"extended info", not eval).

**F12-5 [P0] — Archive CREATE direction missing.**
Pre-fix only archive EXTRACT was detected. CREATE-mode tar/zip/
7z silently allowed overwriting protected paths as the OUTPUT
archive: `tar -cf .rea/policy.yaml docs/`, `zip .rea/policy.yaml
docs/file`, `7z a .rea/policy.yaml docs/`. Round-12 fix:
- detectTar gains an `isCreateOrAppend` first-pass detection
  (looks for `--create`/`--update`/`--append` long forms or
  c/u/r chars in single-dash clusters) and emits the `-f FILE` /
  `--file FILE` / `--file=FILE` / cluster-`f` value as
  `archive_create_dest` when in CREATE mode.
- detect7z gains an explicit a/u/d (compress) branch that emits
  the first non-flag positional after the subcommand as the
  archive output write target.
- New `detectZip` dispatcher: zip's argv shape is `zip [flags]
  OUTPUT.zip [files...]` — first non-flag positional is the
  archive output. Read-only flag side-effects are out of scope
  (zip doesn't have unzip's stdout-extract mode).

**F12-6 [P1] — cmake `-E` utility surface.**
cmake's `-E` mode is a portable POSIX-ish utility runner exposing
filesystem ops. Pre-fix `cmake -E rm .rea/HALT` (and rename, copy,
copy_if_different, copy_directory, touch, remove_directory,
create_symlink, create_hardlink, make_directory) all slipped past
— no dispatcher case. Round-12 fix: new `detectCmake` dispatcher
with per-subcommand argv shapes (cp-shape last-positional for
copy, mv-shape SRC+DEST for rename, variadic for rm/remove/touch/
remove_directory/make_directory, second-positional for create_*).
Read-only subcommands (echo, sleep, etc.) silent-skip.

**F12-7 [P1] — mkfifo / mknod.**
`mkfifo .rea/HALT` and `mknod .rea/HALT c 0 0` create special
files at the protected path. Pre-fix neither dispatcher existed.
Round-12 fix: new `detectMkfifo` (variadic positionals after
flag-strip including -m/--mode value-bearing) and `detectMknod`
(NAME is the FIRST bare positional; subsequent positionals are
type/major/minor numerals).

**F12-8 [P1] — find write-predicates `-fls` / `-fprint` /
`-fprintf`.** Pre-fix detectFind only knew -delete / -exec /
-name. Round-12 fix: scan for -fls FILE / -fprint FILE / -fprintf
FILE FORMAT predicates and emit FILE as a destructive write
target. -fprintf consumes TWO args (FILE + FORMAT).

**F12-9 [P2 false-positive regression] — unzip read-only flags
over-block.** TRUE REGRESSION vs 0.22.0: `unzip -p` (extract to
stdout) and `unzip -l/-Z/-t/-v/-z` (list/test/verbose/comment-
only) don't write to filesystem but the round-11 detectUnzip
emitted a `archive_extract_unresolvable` dynamic detection in
all of them. Round-12 fix: early-return ALLOW from detectUnzip
when any of `-p`/`-l`/`-t`/`-v`/`-z`/`-Z` is present (or any
cluster containing those chars). The existing F11-4 fixture
`unzip -p x.zip .rea/HALT` (which previously expected BLOCK)
moved to the U-neg corpus per the regression-fix correction.

Test pinning: new Class W (191 fixtures: 173 positives across all
9 round-12 closures × every protected target, plus 18 negatives
covering the F12-9 regression fix and the cmake / mkfifo / mknod
read-only / safe-target negatives). Composition tests cover
wrapper + new dispatcher (`nice cmake -E rm`, `sudo mkfifo`,
`bash -c "cmake -E rm"`, `bash -c "tar -cf"`).

### Trust boundary: package-tier integrity

The bash shim's CLI-resolution sandbox (round 4 #2 + round 5 F2)
defeats node_modules-symlink-out, workspace-bin hijack, and
intra-project hijack via forged `package.json` walk-up. It does NOT
defeat an attacker who can write a forged
`node_modules/@bookedsolid/rea/dist/cli/index.js` *together with* a
matching forged `package.json` directly inside the project's
`node_modules/`. Such an attacker has already compromised the
package install pipeline; at that level any other dependency the
agent imports is also forgeable, so hook-tier defense is past — the
trust boundary is the package-tier integrity check (npm provenance
+ manifest verification), not the bash gate.

Operators who want belt-and-braces protection BEYOND the structural
sandbox can opt-in via host-level integrity tooling (Tripwire, OS
filesystem integrity monitors) on the canonical
`node_modules/@bookedsolid/rea/dist/cli/index.js` path. A future
minor may add a `policy.review.cli_sha256: <hex>` policy key that
the shim verifies before exec; defaults to unset.

## Files

| File                                       | Purpose                                          |
| ------------------------------------------ | ------------------------------------------------ |
| `src/hooks/bash-scanner/parser.ts`         | mvdan-sh wrapper (single touch-point for parser) |
| `src/hooks/bash-scanner/walker.ts`         | AST walker → `DetectedWrite[]`                   |
| `src/hooks/bash-scanner/verdict.ts`        | Wire-format Verdict shape                        |
| `src/hooks/bash-scanner/protected-scan.ts` | Protected-paths policy composition               |
| `src/hooks/bash-scanner/blocked-scan.ts`   | blocked_paths policy composition                 |
| `src/hooks/bash-scanner/parse-fail-closed.ts` | Parse-failure verdict factory                 |
| `src/hooks/bash-scanner/index.ts`          | Public surface (`runProtectedScan`, etc.)        |
| `src/cli/hook.ts::runHookScanBash`         | CLI entry, stdin parse, verdict emission         |
| `hooks/protected-paths-bash-gate.sh`       | Shim — forwards to CLI, verifies verdict         |
| `hooks/blocked-paths-bash-gate.sh`         | Shim — forwards to CLI, verifies verdict         |
| `__tests__/hooks/bash-tier-corpus.test.ts` | Round 1 end-to-end fixture corpus (≥185 entries)         |
| `__tests__/hooks/bash-tier-corpus-round2.test.ts` | Round 2 bypass-class fixtures (≥186 entries)         |
| `__tests__/hooks/bash-scanner/walker.test.ts` | Unit tests, branch coverage                   |
| `__tests__/hooks/bash-scanner/scanner-corpus.test.ts` | Walker+scanner integrated tests       |
| `__tests__/hooks/bash-scanner/verdict-shape.test.ts`  | Wire-format snapshot                  |
