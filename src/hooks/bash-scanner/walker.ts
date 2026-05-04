/**
 * AST walker — given a parsed `BashFile`, yield every detected write
 * target with its form classification and source position.
 *
 * The walker is the closed surface this scanner is built around. Every
 * regex/heuristic the bash gates used (and there were many; see
 * `hooks/_lib/cmd-segments.sh` and `hooks/_lib/interpreter-scanner.sh`
 * pre-0.23.0) is replaced here by an AST-driven match. The argument
 * grammar is already correct because the parser rebuilt the tree from
 * shell tokenization rules; we never re-tokenize a string.
 *
 * Detection forms covered (matching `verdict.ts::DetectedForm`):
 *
 *   - `redirect`             — Stmt-level Redirs whose Op is a write
 *   - `cp_dest` / `cp_t_flag` — POSIX-cp tail destination, plus -t / --target-directory
 *   - `mv_dest` / `mv_t_flag` — same for mv
 *   - `tee_arg`              — every non-flag arg to tee
 *   - `sed_i`                — sed -i / -i'' /-iEXT trailing target
 *   - `dd_of`                — `of=` named arg
 *   - `truncate_arg`         — first non-flag arg
 *   - `install_dest` / `ln_dest` — last positional
 *   - `awk_inplace`          — awk/gawk -i inplace target
 *   - `ed_target` / `ex_target` — first non-flag positional
 *   - `find_exec_inner`      — recurse the inner -exec / -execdir / -ok cmd
 *   - `xargs_unresolvable`   — xargs is destination-via-stdin; refuse
 *   - `node_e_path`          — node -e payload string-scanned for fs.write*
 *   - `python_c_path`        — python -c payload scanned for open(...,'w'/'a')
 *   - `ruby_e_path`          — ruby -e File.write/.open(...'w')
 *   - `perl_e_path`          — perl -e open(FH,'>FILE')
 *   - `process_subst_inner`  — recurse `>(...)` / `<(...)` inner stmts
 *   - `nested_shell_inner`   — recurse bash -c / sh -c / zsh -c payloads
 *
 * Dynamic targets (containing $VAR, `cmd`, $(cmd), arithmetic, etc.)
 * are emitted with `dynamic: true`. The compositor refuses on dynamic
 * by default — fail-closed parity with the 0.21.2/0.22.0 sentinel
 * `__rea_unresolved_expansion__`. Process substitutions and nested
 * shells are NOT considered dynamic targets themselves; they're
 * recursed.
 */

import mvdanSh from 'mvdan-sh';
import type { BashFile, BashNode } from 'mvdan-sh';
import path from 'node:path';

const { syntax } = mvdanSh;
import type { DetectedForm, SourcePosition } from './verdict.js';
import { parseBashCommand } from './parser.js';

/**
 * Normalize a command head to its basename for dispatcher matching.
 *
 * Codex round 2 R2-14: pre-fix the dispatcher matched `cmdName` literally
 * via switch/case. Absolute / relative-path invocations like `/bin/bash`,
 * `/usr/bin/sed`, `/opt/homebrew/bin/python3`, `./bash`, `../bash`,
 * `bin/sh` slipped through every dispatcher case and fell to the
 * `default` branch which performs no detection. Result: any utility
 * invoked by absolute or relative path bypassed protected-write
 * detection entirely.
 *
 * The fix is a single basename normalization at the top of the dispatcher
 * (and inside nested-shell + recurseInnerArgv). path.posix.basename
 * gives us the trailing path segment regardless of whether the input
 * uses forward slashes; we additionally accept platform-native
 * backslashes by replacing them on the way in (the upstream parser
 * already normalizes most of these, but we are defensive).
 *
 * If the original cmdName contains a slash but its basename matches no
 * known dispatcher, we return the basename anyway — the dispatcher will
 * fall to the `default` branch as before, but at least common shapes
 * (`/usr/bin/cat`, `/opt/local/bin/ls`) reach the SAME detection path
 * as the bare-name form. There is no security gain to hard-rejecting
 * unknown absolute-path invocations: an attacker who can already write
 * the binary to attack-controlled paths has prior FS access; what we
 * defend here is the dispatch parity.
 */
function normalizeCmdHead(cmdName: string): string {
  if (cmdName.length === 0) return cmdName;
  // Replace backslashes with forward slashes so path.posix.basename
  // works on platform-native paths too. Mvdan typically emits POSIX
  // shape but we normalize defensively.
  const normalized = cmdName.replace(/\\/g, '/');
  if (!normalized.includes('/')) return normalized;
  return path.posix.basename(normalized);
}

/**
 * One detected write. The compositor pairs `path` against the policy
 * (protected or blocked) to decide allow/block.
 *
 * `dynamic: true` means the target's value depends on shell expansion
 * (`$VAR`, `$(cmd)`, backticks, arithmetic, brace expansion) we did not
 * fully resolve. Fail-closed semantics: the compositor always BLOCKS
 * dynamic targets. The detected_form on a dynamic emit is whatever
 * shape was in argv position.
 *
 * `isDirTarget: true` means the target is semantically a directory —
 * `cp -t DIR ...` / `cp --target-directory=DIR ...` / `install -t DIR
 * ...` / `mv -t DIR ...` / `ln -t DIR ...`. The matcher treats dir-
 * targets as `<DIR>/`-shaped: writes INTO that directory may hit any
 * file under it, so a protected file inside the dir matches even when
 * the input lacks a trailing slash. Codex round 1 F-7.
 *
 * `originSrc` is the bash source-substring for the offending node —
 * useful when the operator-facing error message wants to show
 * "Segment: ..." like the bash gates did. It is NOT guaranteed
 * verbatim from the input (the parser may normalize whitespace);
 * treat it as best-effort.
 */
export interface DetectedWrite {
  path: string;
  form: DetectedForm;
  position: SourcePosition;
  dynamic: boolean;
  /**
   * The target is a directory (the write semantics are "into this
   * directory"). Set on `cp -t`, `mv -t`, `install -t`, `ln -t`,
   * `--target-directory=`. False for ordinary file destinations.
   */
  isDirTarget?: boolean;
  /**
   * The detection is a destructive operation (recursive removal,
   * unlink, rmdir, find -delete, FileUtils.rm_rf, shutil.rmtree, etc).
   * Codex round 4 Finding 1: when set, a target that is an ANCESTOR
   * directory of any protected file matches via protected-ancestry —
   * `rm -rf .rea` is treated as a write to every file under .rea/.
   * Without this flag, the scanner only matches exact patterns or
   * dir-shape inputs (-t flags, trailing slash); plain `.rea` argv
   * positionals walked unchecked because they are neither.
   */
  isDestructive?: boolean;
  originSrc?: string;
}

/**
 * Walk the AST and return every detected write.
 *
 * 0.23.0 round-6 architectural refactor: deny-by-default generic
 * `syntax.Walk()` traversal. Pre-refactor the walker dispatched on
 * specific Cmd kinds (`case 'WhileClause':`, `case 'ForClause':`,
 * `case 'DeclClause':`, etc.) and manually traversed each kind's
 * specific fields. Any field NOT enumerated in the case branch was
 * silently dropped — that pattern produced six rounds of P0 bypasses
 * (DeclClause.Args round 5, CaseClause.Word round 5, WhileClause.Cond
 * round 6, ForClause.CStyleLoop.Init/Cond/Post round 6, etc).
 *
 * The round-6 design closes OUR-DISPATCH field-omission structurally.
 * We use `mvdan-sh`'s built-in `syntax.Walk(node, visit)` for
 * traversal — every Cmd kind's inner Stmts / CallExprs / BinaryCmds
 * reach our dispatcher when Walk descends into them. Our dispatch is
 * preserved (per-utility cp/mv/sed/find/etc.), but the TRAVERSAL is
 * no longer a denylist of OUR shapes. A new mvdan-sh Cmd type, or a
 * new field on an existing Cmd, automatically gets visited from our
 * side.
 *
 * 0.23.0 round-7 P0 closure: the round-6 framing "Walk visits every
 * field" was OVERCLAIM. mvdan-sh@0.10.1's `syntax.Walk` itself has
 * field gaps. Empirically verified (see `walk-probe-slice.mjs`):
 * `ParamExp.Slice.Offset` and `ParamExp.Slice.Length` (Word nodes)
 * are NOT recursed into by Walk. Pre-fix every `${X:$(...)}` /
 * `${X:0:$(...)}` / `${arr[@]:$(...)}` / `${@:$(...)}` form bypassed
 * every detector — a regression vs 0.22.0's bash regex.
 *
 * Round-7 fix: this function declares its visitor up front and
 * manually re-enters `syntax.Walk` on the missed Slice subtrees via
 * `recurseParamExpSlice` whenever the visitor sees a `ParamExp`. The
 * re-entry uses the SAME visitor, so nested forms (e.g.
 * `${X:${Y:$(rm)}}`) recurse to fixed point.
 *
 * Round-7 structural pin: the Class O exhaustiveness contract test
 * (`__tests__/hooks/bash-scanner/walker-exhaustiveness.contract.test.ts`)
 * names every (node-type, field) Word-bearing position mvdan-sh
 * populates and asserts the walker reaches each one. If
 * mvdan-sh@0.11.0+ adds a new node type or field that Walk skips,
 * that test fails CI before any runtime regression — the fix is
 * always a one-line manual recursion in the visit callback below.
 *
 * What this closes by construction:
 *   - WhileClause / UntilClause `.Cond` → visited (round 6)
 *   - ForClause `.CStyleLoop.{Init,Cond,Post}` → visited (round 6)
 *   - DeclClause `.Args[*].Value` → visited (round 5 redux)
 *   - CaseClause `.Word` and `.Items[*].Patterns` → visited (round 5 redux)
 *   - TestClause arbitrary nesting → visited
 *   - ArithmCmd / LetClause / SelectClause → visited
 *   - Stmt.Redirs[*].Word with embedded CmdSubst → visited
 *   - Function bodies, if/else branches, subshells → visited
 *   - Anything we add in mvdan-sh@0.11.0+ → reaches our dispatcher
 *     IF Walk visits it; if Walk skips it, Class O fails CI first
 *
 * What we still maintain explicitly (because they require argv-level
 * inspection or string-level re-parse):
 *   - CallExpr → detector dispatch on the command head
 *   - Stmt-level redirects (`>`, `>>`, etc.) → emit per redirect Op
 *   - BinaryCmd pipe-into-bare-shell detection
 *   - heredoc-into-shell payload re-parse
 *   - eval / trap / nested-shell payload re-parse
 *   - ParamExp.Slice.{Offset,Length} → manual Walk re-entry
 *     (round 7 P0 — Walk's own gap, NOT our dispatch gap)
 *
 * The walker NEVER throws on shape oddities — it gracefully ignores
 * nodes whose shape doesn't match what we expect. Parse-level failures
 * are upstream (the parser wrapper). Walker-level failures would be a
 * bug in this file; defensively continue.
 *
 * Performance: O(N) over AST nodes; allocation-light. `syntax.Walk`
 * is a pure-traversal pass that calls our visitor once per node.
 * Visited-node-set tracking is unnecessary because mvdan-sh's
 * tree is acyclic by construction (re-parsed payloads are separate
 * BashFile trees walked via fresh `walkForWrites` invocations).
 */
export function walkForWrites(file: BashFile): DetectedWrite[] {
  const out: DetectedWrite[] = [];
  // Defensive: a malformed `BashFile` (parser returned a node with no
  // `Stmts`) walks fine — `syntax.Walk` is null-tolerant. We keep the
  // pre-refactor early-return only for obvious nullish.
  if (!file) return out;
  try {
    // Round 7 P0 — `syntax.Walk` itself has field gaps in mvdan-sh@0.10.1.
    // Empirically verified: ParamExp.Slice.Offset and ParamExp.Slice.Length
    // (Word nodes) are NOT visited by Walk. That gap defeated the round-6
    // "Walk visits every field" claim and turned 0.23.0 into a regression
    // vs 0.22.0's bash regex which caught `${X:$(rm /tmp/x)}` directly.
    //
    // Fix: declare the visitor up front and manually re-enter Walk on the
    // missed subtrees when the visitor sees a ParamExp. This handles ALL
    // 17 round-7 PoCs because every `${X:OFFSET[:LEN]}` form (including
    // array variants `${arr[@]:N}`, `${@:N}`, `${*:N}`) routes through the
    // same Slice container. Other ParamExp sub-fields (Repl, Exp, Index)
    // ARE visited by Walk (verified in walk-probe-slice.mjs); only Slice
    // is broken.
    //
    // Class O exhaustiveness contract test
    // (`__tests__/hooks/bash-scanner/walker-exhaustiveness.contract.test.ts`)
    // pins this — any future mvdan-sh field gap fails the test before
    // runtime. If mvdan-sh@0.11.0+ adds a new node-with-Word-field that
    // Walk skips, the contract test surfaces it AND a one-line manual
    // recursion below closes the gap.
    const visit = (node: BashNode | null | undefined): boolean => {
      if (node === null || node === undefined) return true;
      const t = nodeType(node);
      switch (t) {
        case 'Stmt':
          // Stmt-level redirects (the `> .rea/HALT` form). Walk's
          // recursion will visit the redirect's inner Word too — but
          // those re-emits are guarded inside extractStmtRedirects to
          // ONLY fire on the redirect-op Word, not on every Word in the
          // Stmt. Redirect substitution recursion (`< <(rm)`) is
          // handled by Walk visiting the ProcSubst.Stmts directly.
          extractStmtRedirects(node, out);
          // Codex round 2 R2-12: heredoc-into-shell re-parse. Walk's
          // generic traversal visits the heredoc Word, but its Body
          // is a string-level re-parse, not an AST recurse. Keep this.
          extractHeredocShellPayloads(node, out);
          break;
        case 'CallExpr':
          walkCallExpr(node, out);
          break;
        case 'BinaryCmd':
          // Codex round 3 Finding 2 (P1): `<cmd> | bash` shape. Walk
          // visits both X and Y as Stmts naturally; the pipe-into-
          // shell detection has to fire on the BinaryCmd itself
          // because it inspects the operator and the RHS shape.
          detectPipeIntoBareShell(node, out);
          break;
        case 'ParamExp':
          // Walk-gap closure: re-enter Walk on Slice.Offset / Slice.Length.
          recurseParamExpSlice(node, visit);
          break;
        default:
          // Every other node kind (IfClause, ForClause, WhileClause,
          // DeclClause, TestClause, ArithmCmd, FuncDecl, Block,
          // Subshell, CaseClause, CmdSubst, ProcSubst, ArithmExp,
          // Word, Lit, etc.) is traversed by Walk. Their inner Stmts
          // and CallExprs will be visited when Walk reaches them, and
          // the detectors above fire then. No explicit per-kind
          // branch is needed — that's the structural closure.
          break;
      }
      return true; // keep descending
    };
    syntax.Walk(file, visit);
  } catch {
    // Pathological tree. Fail closed by the caller (an empty result
    // means no detections, which the compositor pairs with parse-fail
    // sentinels at a higher tier).
  }
  return out;
}

/**
 * Round 7 P0 — manual descent into ParamExp.Slice subtrees.
 *
 * mvdan-sh@0.10.1 `syntax.Walk` does not recurse into `ParamExp.Slice.Offset`
 * or `ParamExp.Slice.Length` (both are `Word` nodes, both can contain
 * `CmdSubst` payloads with arbitrary commands). The dispatcher therefore
 * never sees the inner CmdSubst, so detectors never fire. This was a P0
 * regression vs 0.22.0 where the bash regex caught `${X:$(rm)}` directly.
 *
 * Empirically verified missed positions (see `walk-probe-slice.mjs`):
 *   - `${X:$(...)}`            — Slice.Offset
 *   - `${X:0:$(...)}`          — Slice.Length
 *   - `${X: -$(...)}`          — Slice.Offset (with negative-offset shape)
 *   - `${X:($(...))}`          — Slice.Offset (parenthesized arith form)
 *   - `${@:$(...)}`            — Slice.Offset on positional-params
 *   - `${arr[@]:$(...)}`       — Slice.Offset on array variant
 *   - `${arr[*]:$(...):3}`     — Slice.Offset + Length on array variant
 *
 * Empirically verified Walk-visited (NO manual descent needed):
 *   - `${X:-$(...)}` `${X:=$(...)}` `${X:?$(...)}` `${X:+$(...)}` (Exp)
 *   - `${X#$(...)}` `${X##$(...)}` `${X%$(...)}` `${X%%$(...)}` (Exp)
 *   - `${X^$(...)}` `${X,$(...)}` `${X@Q$(...)}` (Exp case-modify)
 *   - `${X/$(...)/y}` `${X//y/$(...)}` (Repl pattern + replacement)
 *   - `${arr[$(...)]}` (Index)
 *
 * The Class O exhaustiveness contract test
 * (`__tests__/hooks/bash-scanner/walker-exhaustiveness.contract.test.ts`)
 * pins these positions: if a future mvdan-sh release introduces a new gap
 * (or closes the Slice gap), the contract test fails CI before any runtime
 * regression reaches consumers.
 */
function recurseParamExpSlice(
  paramExp: BashNode,
  visit: (node: BashNode | null | undefined) => boolean,
): void {
  // mvdan-sh exposes ParamExp.Slice via getter; on a non-slicing form (e.g.
  // `${X}`, `${X:-default}`) Slice is null and accessing it returns null /
  // undefined. Defensive check before subfield access.
  let slice: unknown;
  try {
    slice = paramExp['Slice'];
  } catch {
    // Some mvdan-sh versions panic from the Go runtime when accessing nil
    // pointer-typed fields via getter. Fail closed: skip — Walk has already
    // covered everything else in this ParamExp.
    return;
  }
  if (!slice || typeof slice !== 'object') return;
  const sliceNode = slice as BashNode;
  for (const fieldName of ['Offset', 'Length'] as const) {
    let sub: unknown;
    try {
      sub = sliceNode[fieldName];
    } catch {
      continue;
    }
    if (!sub || typeof sub !== 'object') continue;
    // Re-enter the SAME visitor through Walk so dispatchers fire AND
    // ParamExp encountered transitively re-recurses into its own Slice.
    // syntax.Walk on a Word node visits the Word + all its Parts (Lit,
    // DblQuoted, ParamExp, CmdSubst, etc.) — exactly the depth we need.
    try {
      syntax.Walk(sub as BashNode, visit);
    } catch {
      // pathological subtree; fail closed at caller
    }
  }
}

/**
 * Detect `sh <<EOF ... EOF` / `bash <<EOF ... EOF` / `bash < script.sh`
 * shapes and re-parse the inner content as bash. Codex round 2 R2-12.
 *
 * We look for:
 *   1. Stmt.Cmd is a CallExpr whose head (after stripEnvAndModifiers
 *      + basename normalization) is a known shell binary.
 *   2. Stmt.Redirs has an entry whose Op is a heredoc operator (Hdoc
 *      0x3a, DashHdoc 0x38) and whose Hdoc field contains the body.
 *      If yes, re-parse Hdoc as bash and walk.
 *
 * For `bash < FILE` (Op RdrIn 0x35), we cannot read the file
 * statically; the redirect target is a non-trivial path → emit dynamic
 * detection.
 */
function extractHeredocShellPayloads(stmt: BashNode, out: DetectedWrite[]): void {
  const cmd = stmt['Cmd'];
  if (!cmd || typeof cmd !== 'object') return;
  const t = nodeType(cmd as BashNode);
  if (t !== 'CallExpr') return;
  const args = asArray((cmd as BashNode)['Args']);
  if (args.length === 0) return;
  // Reconstruct argv to find the head, after env/sudo stripping.
  const argv: WordValue[] = [];
  for (const arg of args) {
    if (typeof arg !== 'object' || arg === null) continue;
    const v = wordToString(arg as BashNode);
    argv.push(v ?? { value: '', dynamic: true, position: { line: 0, col: 0 } });
  }
  if (argv.length === 0 || argv[0] === undefined) return;
  const stripped = stripEnvAndModifiers(argv);
  if (stripped.length === 0 || stripped[0] === undefined) return;
  const head = normalizeCmdHead(stripped[0].value);
  if (head !== 'bash' && head !== 'sh' && head !== 'zsh' && head !== 'dash' && head !== 'ksh') {
    return;
  }
  const redirs = asArray(stmt['Redirs']);
  for (const r of redirs) {
    if (typeof r !== 'object' || r === null) continue;
    const node = r as BashNode;
    const op = typeof node['Op'] === 'number' ? (node['Op'] as number) : -1;
    // Heredoc operators: 0x3d (Hdoc) and 0x3e (DashHdoc) per mvdan-sh
    // 0.10.1 (verified empirically: <<EOF emits 0x3d, <<-EOF emits 0x3e).
    // Pre-0.23.0 the bash gates used regex on the raw command which
    // caught these; the AST walker needs the canonical Op codes.
    if (op === 0x3d || op === 0x3e) {
      const hdoc = node['Hdoc'];
      if (hdoc && typeof hdoc === 'object') {
        // mvdan represents the heredoc body as a Word node. Reconstruct
        // the literal string and re-parse.
        const body = wordToString(hdoc as BashNode);
        if (body !== null && !body.dynamic) {
          const parsed = parseBashCommand(body.value);
          if (parsed.ok) {
            const innerWrites = walkForWrites(parsed.file);
            for (const d of innerWrites) {
              out.push(d);
            }
          } else {
            // Body failed to parse — refuse on uncertainty.
            out.push({
              path: '',
              form: 'nested_shell_inner',
              position: nodePosition(node),
              dynamic: true,
              originSrc: 'heredoc-into-shell payload failed to parse',
            });
          }
        } else if (body !== null && body.dynamic) {
          out.push({
            path: '',
            form: 'nested_shell_inner',
            position: nodePosition(node),
            dynamic: true,
            originSrc: 'heredoc-into-shell payload contains $-substitution',
          });
        }
      }
    }
    // mvdan-sh redirect operators (verified empirically against parser
    // 0.10.1):
    //   `<`        → 0x38 (RdrIn)
    //   `0<` etc.  → 0x38 (same; the N field carries the fd)
    //   `<<EOF`    → 0x3d (Hdoc)
    //   `<<-EOF`   → 0x3e (DashHdoc)
    //   `<<<`      → 0x3f (WordHdoc — here-string)
    // Codex round 4 Finding 7 update: `0x35` was the documented constant
    // but actual emit is 0x38; this branch keeps both for compatibility
    // across mvdan-sh versions.
    if (op === 0x35 || op === 0x38) {
      const word = node['Word'];
      if (word && typeof word === 'object') {
        const target = wordToString(word as BashNode);
        if (target !== null) {
          // Allow well-known empty/discard redirect targets:
          //   /dev/null — empty
          //   /dev/zero — null bytes (not a script)
          // These don't yield exploitable script content.
          // Also allow when the Word contains a ProcSubst (we walk its
          // body separately below; double-emitting dynamic on top of
          // that would over-block legitimate `bash <(echo ok)` shapes).
          const isWellKnownEmpty = target.value === '/dev/null' || target.value === '/dev/zero';
          // Detect ProcSubst inside the Word so we don't double-emit
          // dynamic for `bash 0< <(cmd)` (the procsubst-feeding-bash
          // emit fires at the Stmt-arg level below).
          const partsList = asArray((word as BashNode)['Parts']);
          let hasProcSubstInside = false;
          for (const p of partsList) {
            if (typeof p !== 'object' || p === null) continue;
            const tp = nodeType(p as BashNode);
            if (tp === 'ProcSubst' || tp === 'CmdSubst') {
              hasProcSubstInside = true;
              break;
            }
          }
          if (!isWellKnownEmpty && !hasProcSubstInside) {
            out.push({
              path: '',
              form: 'nested_shell_inner',
              position: nodePosition(node),
              dynamic: true,
              originSrc: `${head} < ${target.value} (file content not statically readable)`,
            });
          }
        }
        // 0.23.0 round-6: the ProcSubst body is traversed by the
        // top-level `syntax.Walk` — its inner Stmts/CallExprs visit
        // naturally. We retain the structural "bash reads procsubst as
        // script" emit because that's a fail-closed semantic decision,
        // not a recursion.
        if (
          (() => {
            const parts2 = asArray((word as BashNode)['Parts']);
            for (const p of parts2) {
              if (typeof p !== 'object' || p === null) continue;
              const tp = nodeType(p as BashNode);
              if (tp === 'ProcSubst' || tp === 'CmdSubst') return true;
            }
            return false;
          })()
        ) {
          out.push({
            path: '',
            form: 'nested_shell_inner',
            position: nodePosition(node),
            dynamic: true,
            originSrc: `${head} < <(...) — shell reads process-substituted script (refuse on uncertainty)`,
          });
        }
      }
    }
    // Codex round 4 Finding 7: here-string `bash <<< "cmd"`. mvdan-sh
    // emits this as op 0x3f (WordHdoc) per parser 0.10.1.
    if (op === 0x37 || op === 0x3f) {
      const word = node['Word'];
      if (word && typeof word === 'object') {
        const inner = wordToString(word as BashNode);
        if (inner !== null && !inner.dynamic) {
          const parsed = parseBashCommand(inner.value);
          if (parsed.ok) {
            const innerWrites = walkForWrites(parsed.file);
            for (const d of innerWrites) {
              out.push(d);
            }
          } else {
            out.push({
              path: '',
              form: 'nested_shell_inner',
              position: nodePosition(node),
              dynamic: true,
              originSrc: `${head} <<< (here-string failed to parse)`,
            });
          }
        } else if (inner !== null && inner.dynamic) {
          out.push({
            path: '',
            form: 'nested_shell_inner',
            position: nodePosition(node),
            dynamic: true,
            originSrc: `${head} <<< (here-string contains $-substitution)`,
          });
        }
      }
    }
  }
  // Codex round 4 Finding 7: `bash <(cmd)` — process-substitution as
  // the shell's argv. The ProcSubst is the FIRST positional arg (the
  // shell treats it as a script-file path). The shell will read the
  // FIFO content as a bash script — but we can't statically resolve
  // what `cmd` will print (it's a CHILD process emitting to stdout).
  // Refuse on uncertainty: emit a dynamic detection.
  //
  // 0.23.0 round-6: ProcSubst inner Stmts are now traversed by the
  // top-level `syntax.Walk` — no per-arg walkWordForSubstNodes needed.
  // We still inspect the Word's Parts here because the structural
  // "shell reads procsubst as script" emit needs to fire on the
  // outer shape, independent of inner-write detection.
  let sawProcSubstArg = false;
  for (const arg of args) {
    if (typeof arg !== 'object' || arg === null) continue;
    const argNode = arg as BashNode;
    // Inspect the Word's Parts for top-level ProcSubst.
    const partsList = asArray(argNode['Parts']);
    for (const p of partsList) {
      if (typeof p !== 'object' || p === null) continue;
      const tp = nodeType(p as BashNode);
      if (tp === 'ProcSubst' || tp === 'CmdSubst') {
        sawProcSubstArg = true;
        break;
      }
    }
  }
  if (sawProcSubstArg) {
    // `bash <(cmd)` / `bash <(cat scriptfile)` / `bash 0< <(cmd)`:
    // bash reads the FIFO/file as a script. We refuse on uncertainty
    // because we can't model what `cmd`'s stdout will be.
    out.push({
      path: '',
      form: 'nested_shell_inner',
      position:
        stmt['Pos'] && typeof stmt['Pos'] === 'function' ? nodePosition(stmt) : { line: 0, col: 0 },
      dynamic: true,
      originSrc: `${head} <(...) — shell reads a process-substituted script (refuse on uncertainty)`,
    });
  }
}

// 0.23.0 round-6 architectural refactor — `walkCmd` and
// `maybeWalkInnerStmt` removed. Per-Cmd-kind dispatch is no longer
// necessary because the deny-by-default `syntax.Walk()` traversal in
// `walkForWrites` visits every node of every kind exhaustively. Each
// inner Stmt / CallExpr / BinaryCmd is reached automatically as Walk
// descends, and the dispatchers fire there. See the docstring on
// `walkForWrites` for the structural-class closure rationale.

/**
 * Codex round 3 Finding 2 (P1): pipe-into-bare-shell detection.
 *
 * For `<cmd> | bash`, `<cmd> | sh`, `<cmd> | sudo bash`, `<cmd> |
 * /bin/bash`, etc. the bare shell on the RHS reads the LHS's stdout
 * AS ITS SCRIPT — `printf "rm -rf /" | bash` is a real attack shape.
 * We cannot statically resolve what LHS prints, so we refuse on
 * uncertainty.
 *
 * mvdan-sh's BinaryCmd op codes:
 *   0xa  &&    0xb  ||    0xc  |    0xd  |&
 *
 * Detection: op ∈ {0xc, 0xd} AND the RHS Stmt's Cmd is a CallExpr
 * whose head (after env/sudo/normalize) is a known shell binary AND
 * no `-c` cluster appears in argv. A `-c` shell IGNORES stdin for the
 * script (the script comes from argv) — those are NOT this attack.
 *
 * Pipeline chains: the AST is left-associative, so `a | b | c` parses
 * as `(a | b) | c` — one BinaryCmd whose X is itself a BinaryCmd.
 * Recursion through walkCmd visits each Y in turn, so `a | tee | bash`
 * fires when the outer BinaryCmd's Y is `bash`. The intermediate
 * `tee` element is a separate BinaryCmd that recurses normally.
 */
function detectPipeIntoBareShell(binaryCmd: BashNode, out: DetectedWrite[]): void {
  const op = typeof binaryCmd['Op'] === 'number' ? (binaryCmd['Op'] as number) : -1;
  // Pipe ops only — `&&` / `||` don't pipe stdout.
  if (op !== 0xc && op !== 0xd) return;
  const y = binaryCmd['Y'];
  if (!y || typeof y !== 'object') return;
  const yStmt = y as BashNode;
  if (nodeType(yStmt) !== 'Stmt') return;
  const yCmd = yStmt['Cmd'];
  if (!yCmd || typeof yCmd !== 'object') return;
  if (nodeType(yCmd as BashNode) !== 'CallExpr') return;
  const args = asArray((yCmd as BashNode)['Args']);
  if (args.length === 0) return;
  const argv: WordValue[] = [];
  for (const a of args) {
    if (typeof a !== 'object' || a === null) continue;
    const v = wordToString(a as BashNode);
    argv.push(v ?? { value: '', dynamic: true, position: { line: 0, col: 0 } });
  }
  if (argv.length === 0) return;
  const stripped = stripEnvAndModifiers(argv);
  if (stripped.length === 0 || stripped[0] === undefined) return;
  const head = normalizeCmdHead(stripped[0].value);
  const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash']);
  if (!SHELLS.has(head)) return;
  // If a `-c` cluster is present, the shell takes its script from argv,
  // not stdin — that path is handled by detectNestedShell. Skip here.
  for (let i = 1; i < stripped.length; i += 1) {
    const tok = stripped[i];
    if (tok === undefined) continue;
    const v = tok.value;
    if (v.startsWith('-') && !v.startsWith('--') && v.length >= 2 && v.slice(1).includes('c')) {
      return;
    }
    if (v === '--command' || v === '-c') return;
  }
  // Bare shell reads stdin — fail-closed.
  out.push({
    path: '',
    form: 'nested_shell_inner',
    position: stripped[0].position,
    dynamic: true,
    originSrc: `pipe into bare shell (${head} reads stdin as script)`,
  });
}

/**
 * Extract Stmt-level redirects. Op is a numeric code; we map the write
 * ops via a table. `<` (read), `<<` (heredoc-stdin), `<<<` (here-string-
 * stdin) are NOT writes. `>`, `>>`, `>|`, `&>`, `&>>`, `<>` (read+write
 * — yes, this is a write) all are.
 *
 * mvdan-sh exposes Op as a number; the values match the upstream Go
 * `RedirOperator` constants. We don't import them directly (the JS
 * binding doesn't expose the const map), so we encode the mapping
 * here. Tested against the parser's emitted ops in the fixture corpus.
 */
const REDIR_OP_NAMES: Record<number, DetectedForm> = {
  // Op codes verified empirically via `syntax.DebugPrint` against
  // mvdan-sh@0.10.1. Snapshot tests in walker.test.ts pin them so a
  // future parser-library bump can't silently re-number these.
  //
  //   0x36 = `>` (RdrOut). Also produced for fd-prefixed forms
  //          `1>file`, `2>file`, `9>file` — the fd is in node.N, not
  //          in the Op code, so a single mapping suffices.
  //   0x37 = `>>` (AppOut)
  //   0x39 = `<>` (RdrInOut — read+write; treat as write defensively)
  //   0x3c = `>|` (ClbOut, noclobber-override)
  //   0x40 = `&>` (RdrAll, both stdout+stderr)
  //   0x41 = `&>>` (AppAll, append both)
  //
  // `<` (RdrIn=0x35), `<<` (Hdoc=0x3d), `<<<` (HereStr=0x3b),
  // `<<-` (DashHdoc=0x3e) are reads — NOT in this map. Codex round 2
  // R2-12: heredoc bodies feeding bash/sh/zsh ARE re-parsed in
  // extractHeredocShellPayloads.
  0x36: 'redirect',
  0x37: 'redirect',
  0x39: 'redirect',
  0x3c: 'redirect',
  0x40: 'redirect',
  0x41: 'redirect',
};

function extractStmtRedirects(stmt: BashNode, out: DetectedWrite[]): void {
  const redirs = asArray(stmt['Redirs']);
  for (const r of redirs) {
    if (typeof r !== 'object' || r === null) continue;
    const node = r as BashNode;
    const op = typeof node['Op'] === 'number' ? (node['Op'] as number) : -1;
    const word = node['Word'];
    // 0.23.0 round-6: pre-refactor we manually walked the redirect
    // Word for embedded CmdSubst/ProcSubst (Codex round 5 F1). The
    // top-level `syntax.Walk` now visits the redirect's Word and
    // descends into ProcSubst/CmdSubst Stmts naturally — every
    // `cat <<< $(rm .rea/HALT)` / `read X < <(rm)` shape is reached
    // structurally.
    const form = REDIR_OP_NAMES[op];
    if (!form) continue;
    if (!word || typeof word !== 'object') continue;
    const path = wordToString(word as BashNode);
    if (path === null) continue;
    const position = nodePosition(node);
    out.push({
      path: path.value,
      form,
      position,
      dynamic: path.dynamic,
    });
  }
}

/**
 * Walk a CallExpr — the common command-with-args shape. This is where
 * cp/mv/sed/dd/tee/truncate/install/ln/awk/ed/ex/find/xargs/node/python/
 * ruby/perl detection lives. Each branch examines the parsed argv (a
 * list of Word nodes, each a sequence of WordParts) — we never
 * re-tokenize the original string.
 */
function walkCallExpr(callExpr: BashNode, out: DetectedWrite[]): void {
  const args = asArray(callExpr['Args']);
  // 0.23.0 round-6: pre-refactor we manually walked CallExpr.Assigns
  // and CallExpr.Args's embedded CmdSubst/ProcSubst to catch
  // `FOO=$(rm)`, `ARR=( $(rm) )`, `tee >(cat > .rea/HALT)`,
  // `echo $(printf x > .rea/HALT)`, and similar. Those traversals are
  // now handled by the top-level `syntax.Walk` — it visits Assign nodes
  // and arg-Word ProcSubst/CmdSubst children, descending into their
  // inner Stmts which fire the per-utility detectors naturally. We
  // only need to preserve the empty-argv early-return: a CallExpr
  // with zero Args (e.g., a plain `FOO=value` assignment with no
  // command head) has no argv-level write to dispatch on.
  if (args.length === 0) return;
  const argv: WordValue[] = [];
  for (const arg of args) {
    if (typeof arg !== 'object' || arg === null) continue;
    const v = wordToString(arg as BashNode);
    argv.push(v ?? { value: '', dynamic: true, position: { line: 0, col: 0 } });
  }
  if (argv.length === 0 || argv[0] === undefined) return;
  const head = argv[0].value;
  // Codex round 11 F11-5: parallel-without-`:::` reads inputs from
  // stdin. We detect parallel BEFORE stripEnvAndModifiers
  // synthesizes a template argv (which would erase the no-separator
  // signal). When parallel argv has no `:::`/`::::`/`:::+`/`::::+`
  // separator anywhere AND has at least one positional template
  // token, the per-input expansion is fed by stdin — we can't
  // statically resolve those inputs. Refuse on uncertainty.
  //
  // Walk the argv looking for the parallel head (after env/wrapper
  // strip is fine — we just normalize the basename of argv[0] when
  // it might be a wrapper like `nohup parallel`). We use a tighter
  // direct-head check first: if argv[0]'s basename is `parallel`
  // (covering `/usr/bin/parallel`, `./parallel`, etc.) we run the
  // stdin-detection. Wrapper-prefixed forms (`nohup parallel ...`)
  // are handled when the wrapper-strip later lands the synthetic
  // parallel argv back through walkCallExpr — too rare to special-
  // case here.
  const argvHeadName = normalizeCmdHead(argv[0].value);
  if (argvHeadName === 'parallel') {
    let hasSep = false;
    let hasPositional = false;
    for (let p = 1; p < argv.length; p += 1) {
      const tok = argv[p];
      if (tok === undefined) continue;
      const v = tok.value;
      if (v === ':::' || v === '::::' || v === ':::+' || v === '::::+') {
        hasSep = true;
        break;
      }
      if (!v.startsWith('-') && v !== '--') {
        hasPositional = true;
      }
    }
    if (!hasSep && hasPositional) {
      const pos = argv[0].position;
      out.push({
        path: '',
        form: 'parallel_stdin_unresolvable',
        position: pos,
        dynamic: true,
        isDestructive: true,
        originSrc: 'parallel without `:::` reads inputs from stdin (unresolvable)',
      });
    }
  }
  // Strip env-var prefixes (`FOO=bar cmd`) — mvdan exposes them via
  // CallExpr.Assigns, which we ignore (assignments don't write files).
  // For `command cmd`, `nohup cmd`, `time cmd`, `sudo cmd`, `env cmd`
  // we walk forward to the actual command head.
  const stripped = stripEnvAndModifiers(argv);
  if (stripped.length === 0 || stripped[0] === undefined) return;
  // Codex round 2 R2-14: normalize via basename so absolute / relative-
  // path invocations (`/bin/bash`, `./sed`, `/opt/homebrew/bin/python3`)
  // dispatch to the same case as the bare-name form. Pre-fix the literal
  // value was matched, silently bypassing every detector for any utility
  // invoked by path.
  const cmdName = normalizeCmdHead(stripped[0].value);

  // Dispatch on command name. Order matters only when one name is a
  // prefix of another (none here); otherwise it's a flat case map.
  switch (cmdName) {
    case 'cp':
      detectCpMv(stripped, 'cp', out);
      break;
    case 'mv':
      detectCpMv(stripped, 'mv', out);
      break;
    case 'sed':
      detectSedI(stripped, out);
      break;
    case 'dd':
      detectDdOf(stripped, out);
      break;
    case 'tee':
      detectTee(stripped, out);
      break;
    case 'truncate':
      detectTruncate(stripped, out);
      break;
    case 'install':
      detectInstall(stripped, out);
      break;
    case 'ln':
      detectLn(stripped, out);
      break;
    case 'awk':
    case 'gawk':
    case 'mawk':
    case 'nawk':
      detectAwkInplace(stripped, out);
      // Codex round 1 F-12: also scan the awk program source for
      // shell-out via system(...) / print > "FILE" patterns.
      detectAwkSource(stripped, out);
      break;
    case 'ed':
      detectEdEx(stripped, 'ed_target', out);
      break;
    case 'ex':
    case 'vi':
    case 'vim':
      // ex-mode is reachable via vi/vim too with `-e` or `-c "wq"`. Be
      // conservative; treat any vi/vim/ex with a positional target as
      // a potential write.
      detectEdEx(stripped, 'ex_target', out);
      break;
    case 'find':
      detectFind(stripped, out);
      break;
    case 'xargs':
      detectXargs(stripped, out, head);
      break;
    case 'node':
    case 'nodejs':
      // Codex round 1 F-8: node accepts `-e | --eval | -p | --print |
      // -pe` (and combinations like `-pe`). Pre-fix only -e was matched.
      detectInterpreterEval(stripped, NODE_EVAL_FLAGS, 'node_e_path', NODE_WRITE_PATTERNS, out);
      break;
    case 'python':
    case 'python2':
    case 'python3':
      detectInterpreterEval(
        stripped,
        PYTHON_EVAL_FLAGS,
        'python_c_path',
        PYTHON_WRITE_PATTERNS,
        out,
      );
      break;
    case 'ruby':
      detectInterpreterEval(stripped, RUBY_EVAL_FLAGS, 'ruby_e_path', RUBY_WRITE_PATTERNS, out);
      break;
    case 'perl':
      // Codex round 1 F-8: perl accepts -e and -E (the latter enables
      // current-feature bundle).
      detectInterpreterEval(stripped, PERL_EVAL_FLAGS, 'perl_e_path', PERL_WRITE_PATTERNS, out);
      break;
    // Codex round 11 F11-7: PHP. `php -r CODE` evaluates CODE; we
    // run the same eval-flag scanner with PHP-specific patterns.
    case 'php':
      detectInterpreterEval(stripped, PHP_EVAL_FLAGS, 'php_r_path', PHP_WRITE_PATTERNS, out);
      break;
    case 'bash':
    case 'sh':
    case 'zsh':
    case 'dash':
    case 'ksh':
    // Codex round 9 F2: busybox-provided shells (ash) and other
    // common Alpine / OpenWrt / OpenBSD-derived shells. All accept
    // `-c PAYLOAD` so detectNestedShell unwraps them uniformly.
    case 'ash':
    case 'mksh':
    case 'yash':
    case 'posh':
    case 'rc':
      detectNestedShell(stripped, out);
      break;
    // Codex round 1 F-20 / F-21: top-level destructive utilities. Each
    // takes one or more positional path args; we treat them as writes.
    // touch creates / updates; rm deletes; chmod/chown change metadata
    // — all are policy-relevant for protected paths.
    case 'rm':
      // Codex round 4 Finding 1: rm with -r/-R/-rf/--recursive is a
      // RECURSIVE delete. Flag every positional with isDestructive:true
      // so protected-ancestry matching catches `rm -rf .rea`.
      detectGenericPositionalWrites(stripped, out, {
        isDestructiveCmd: rmIsRecursive(stripped),
      });
      break;
    case 'rmdir':
      // rmdir always operates on a directory; its target IS a directory
      // and the operation is destructive (the dir is removed). Flag for
      // protected-ancestry. `rmdir .rea` removes the directory — and any
      // protected file at .rea/HALT goes with it (modulo POSIX rmdir
      // refusing non-empty dirs at runtime, but that is a runtime check
      // not a semantic permission).
      detectGenericPositionalWrites(stripped, out, { isDestructiveCmd: true });
      break;
    case 'touch':
    case 'mkdir':
    case 'chmod':
    case 'chown':
    case 'chgrp':
      detectGenericPositionalWrites(stripped, out);
      break;
    // Codex round 2 R2-7..R2-13: additional write-bearing utilities.
    case 'tar':
    // Codex round 11 F11-4: bsdtar (macOS native) shares tar's argv
    // grammar — same dispatcher.
    case 'bsdtar':
      detectTar(stripped, out);
      break;
    // Codex round 11 F11-4: archive extraction — unzip / 7z / gzip /
    // gunzip / pax dispatchers.
    case 'unzip':
      detectUnzip(stripped, out);
      break;
    case '7z':
    case '7za':
    case '7zr':
      detect7z(stripped, out);
      break;
    // Codex round 12 F12-5 (P0): zip CREATE direction.
    case 'zip':
      detectZip(stripped, out);
      break;
    case 'gzip':
      detectGzip(stripped, out, 'gzip');
      break;
    case 'gunzip':
      detectGzip(stripped, out, 'gunzip');
      break;
    case 'pax':
      detectPax(stripped, out);
      break;
    // Codex round 12 F12-6 (P1): cmake -E utility surface.
    case 'cmake':
      detectCmake(stripped, out);
      break;
    // Codex round 12 F12-7 (P1): mkfifo / mknod special-file create.
    case 'mkfifo':
      detectMkfifo(stripped, out);
      break;
    case 'mknod':
      detectMknod(stripped, out);
      break;
    case 'rsync':
      detectRsync(stripped, out);
      break;
    case 'curl':
      detectCurl(stripped, out);
      break;
    case 'wget':
      detectWget(stripped, out);
      break;
    case 'shred':
      detectShred(stripped, out);
      break;
    case 'eval':
      detectEval(stripped, out);
      break;
    case 'git':
      detectGit(stripped, out);
      break;
    // Codex round 4 Finding 7: misc utilities.
    case 'patch':
      detectPatch(stripped, out);
      break;
    case 'sort':
      detectSort(stripped, out);
      break;
    case 'shuf':
      detectShuf(stripped, out);
      break;
    case 'gpg':
    case 'gpg2':
      detectGpg(stripped, out);
      break;
    case 'split':
    case 'csplit':
      detectSplit(stripped, out);
      break;
    case 'trap':
      detectTrap(stripped, out);
      break;
    default:
      // Codex round 10 — structural wrapper-shell-exec guard.
      // For UNRECOGNIZED heads, look for the bypass shape
      // `<head> [...] <known-shell> -c PAYLOAD` and dispatch the
      // PAYLOAD through detectNestedShell. Closes the wrapper-class
      // bypass family (chronic, parallel, watch, script, dbus-launch,
      // and any future unknown wrapper that fork/execs a shell)
      // structurally rather than by per-wrapper enumeration.
      detectWrappedNestedShell(stripped, out);
      // Unknown command — no further detection. Stmt-level redirects
      // on this CallExpr's parent Stmt have already been handled.
      break;
  }
}

/**
 * Generic positional-write detector for utilities whose argv shape is
 * `<cmd> [flags...] FILE [FILE...]` and every non-flag positional is
 * a path being written / mutated. Used for `touch`, `rm`, `mkdir`,
 * `rmdir`, `chmod`, `chown`, `chgrp`.
 *
 * Codex round 1 F-20 / F-21. Conservative — we don't model each
 * command's specific value-bearing flags exhaustively; we skip any
 * argv token starting with `-` and emit the rest as redirect-form
 * detections. This may over-block a chmod whose mode happens to look
 * like `'foo'` (it doesn't — mode tokens never start with `-` in
 * sane invocations). False positives in this domain are acceptable;
 * a real attacker invoking `chmod 000 .rea/HALT` lands on the same
 * detection as `printf x > .rea/HALT`.
 */
function detectGenericPositionalWrites(
  argv: WordValue[],
  out: DetectedWrite[],
  opts?: { isDestructiveCmd?: boolean },
): void {
  const isDestructive = opts?.isDestructiveCmd === true;
  let i = 1;
  let endOfOpts = false;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    if (endOfOpts) {
      out.push({
        path: tok.value,
        form: 'redirect',
        position: tok.position,
        dynamic: tok.dynamic,
        ...(isDestructive ? { isDestructive: true } : {}),
      });
      i += 1;
      continue;
    }
    const v = tok.value;
    if (v === '--') {
      endOfOpts = true;
      i += 1;
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      // Flag — skip. We don't model value-bearing flags here; chmod /
      // chown / etc rarely have any in practice (the mode/owner is the
      // first positional). The only common value-bearing flag we'd want
      // to skip is `chmod --reference=FILE` — handled by leaving
      // value-bearing flags as flag-only (one token consumed, the next
      // gets emitted as a positional which is fine — `--reference=…`
      // is self-contained, and the "next positional" if it exists IS
      // a target path).
      i += 1;
      continue;
    }
    // chmod's first positional is MODE not a path. Skip a pure-numeric
    // or pure-alpha-mode token (e.g. `0644`, `u+x`, `a=rwx`).
    // Conservative: only skip when the token doesn't contain a `/` or
    // `.` — those would be path-like.
    if (i === 1 && /^[0-7]{3,4}$|^[ugoa]*[+\-=][rwxXstugo]+$|^[a-z]+:[a-z]+$/.test(v)) {
      i += 1;
      continue;
    }
    out.push({
      path: v,
      form: 'redirect',
      position: tok.position,
      dynamic: tok.dynamic,
      ...(isDestructive ? { isDestructive: true } : {}),
    });
    i += 1;
  }
}

/**
 * Codex round 4 Finding 1: detect whether an `rm` invocation is
 * recursive. Recursive rm against an ancestor of a protected path
 * removes the protected file, so we plumb isDestructive=true through
 * each positional emit. Flags accepted: `-r`, `-R`, `--recursive`,
 * `-rf`, `-fr`, `-Rf`, `-fR`, and any cluster containing `r` or `R`.
 */
function rmIsRecursive(argv: WordValue[]): boolean {
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;
    const v = tok.value;
    if (v === '--recursive') return true;
    // Cluster: -r, -R, -rf, -fR, -Rfv, etc. Long flags (`--foo`) are
    // skipped here; we already check `--recursive` above.
    if (v.startsWith('-') && !v.startsWith('--') && v.length > 1) {
      const cluster = v.slice(1);
      if (cluster.includes('r') || cluster.includes('R')) return true;
    }
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────
//  Codex round 2 R2-7..R2-13: extended utility detectors
// ─────────────────────────────────────────────────────────────────────

/**
 * tar detector. Codex round 2 R2-7. Most invocations write to (`-x`) or
 * read-from (`-c`) cwd; the `-C DIR` / `--directory=DIR` / `--directory
 * DIR` flag retargets where extraction lands. We treat any `-C DIR`
 * argument as a directory write target. Cwd-relative tar invocations
 * are NOT tracked — that requires a process-cwd model which the static
 * scanner doesn't have; the dispatcher's caller is expected to verify
 * the cwd separately if it cares.
 */
function detectTar(argv: WordValue[], out: DetectedWrite[]): void {
  // Codex round 3 Finding 3 (P1): the tar `C` short-flag CONSUMES the
  // next argv as the directory target, even when bundled in a cluster
  // like `-xzfC archive.tar.gz .rea/`. Pre-fix the cluster `-xzfC` was
  // walked as a generic `-flag` token and the next argv (which the C
  // flag would have consumed as the dir) was treated as a file
  // operand. Now: when a cluster contains C, we record the position
  // of C within the cluster, count how many value-bearing flags came
  // BEFORE C (`f` consumes argv too — same pattern), and consume that
  // many subsequent argv tokens as values, with the C-consumed argv
  // landing as our isDirTarget detection.
  //
  // Value-bearing tar short-flags whose argument is the NEXT argv
  // when the flag appears in a cluster:
  //   f  — archive file
  //   b  — block size
  //   F  — incremental info file
  //   K  — start at member NAME
  //   N  — only newer than DATE
  //   T  — files-from
  //   V  — volume label
  //   X  — exclude-from
  //   C  — change directory  (THIS is the security-relevant case)
  //
  // For non-cluster `-C DIR`, `-C/dir`, `--directory`, `--directory=`,
  // existing logic still applies.
  //
  // Codex round 11 F11-4: when the tar action is EXTRACT (`-x`,
  // `--extract`, `--get`), positional non-flag args are MEMBER NAMES
  // — these become file paths under the destination directory at
  // runtime. We emit each positional member as a write target. If
  // NO explicit positional members were supplied, the archive
  // contents are unknown to the scanner — emit a synthetic
  // `archive_extract_unresolvable` so the verdict layer refuses on
  // uncertainty. Action flags can be either standalone (`-x`) or
  // bundled in a cluster (`-xzf`).
  const VALUE_BEARING_CLUSTER_CHARS = new Set(['f', 'b', 'F', 'K', 'N', 'T', 'V', 'X', 'C']);

  // First pass: detect whether this invocation is an extract.
  let isExtract = false;
  // Codex round 12 F12-5 (P0): also detect CREATE-mode (`-c`/`--create`),
  // UPDATE-mode (`-u`/`--update`/`--append`), APPEND-mode (`-r`/`--append`).
  // All three write the archive at the `-f FILE` argument and were not
  // detected pre-fix — `tar -cf .rea/policy.yaml docs/` slipped past
  // because the only checked action was `-x` (extract). The OUTPUT
  // archive at FILE is the write target for CREATE/UPDATE/APPEND.
  let isCreateOrAppend = false;
  for (let s = 1; s < argv.length; s += 1) {
    const tok = argv[s];
    if (tok === undefined) continue;
    const v = tok.value;
    if (v === '--extract' || v === '--get') {
      isExtract = true;
      break;
    }
    if (v === '--create' || v === '--update' || v === '--append') {
      isCreateOrAppend = true;
      break;
    }
    // Long flag carrying x — unlikely; we bypass.
    if (v.startsWith('-') && !v.startsWith('--')) {
      // Cluster: any char being `x` is the extract action.
      if (v.includes('x')) {
        isExtract = true;
        break;
      }
      // Cluster: `c`/`u`/`r` chars indicate create/update/append.
      // Action chars are mutually exclusive in real tar usage, so
      // first-found wins. We must NOT match the lowercase `c` mid-
      // cluster as part of a long flag; this branch only runs on
      // single-dash forms (above check excludes --).
      if (v.includes('c') || v.includes('u') || v.includes('r')) {
        // Disambiguation: `r` is also part of certain non-action
        // strings. For tar specifically, the only action chars at this
        // dispatch level are c/x/t/u/r/A. We accept any of c/u/r as
        // signaling CREATE-or-APPEND mode. False positives here are
        // acceptable: emitting the -f target as a write when the user
        // ran `tar -tvf archive.tar` (test mode includes `t`, no
        // c/u/r) does NOT happen because we explicitly check for
        // c/u/r presence; `-tvf` won't trigger.
        isCreateOrAppend = true;
        break;
      }
    }
  }

  let i = 1;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    const v = tok.value;
    if (v === '--directory') {
      const next = argv[i + 1];
      if (next !== undefined) {
        out.push({
          path: next.value,
          form: 'redirect',
          position: next.position,
          dynamic: next.dynamic,
          isDirTarget: true,
        });
      }
      i += 2;
      continue;
    }
    if (v.startsWith('--directory=')) {
      out.push({
        path: v.slice('--directory='.length),
        form: 'redirect',
        position: tok.position,
        dynamic: tok.dynamic,
        isDirTarget: true,
      });
      i += 1;
      continue;
    }
    if (v === '-C') {
      const next = argv[i + 1];
      if (next !== undefined) {
        out.push({
          path: next.value,
          form: 'redirect',
          position: next.position,
          dynamic: next.dynamic,
          isDirTarget: true,
        });
      }
      i += 2;
      continue;
    }
    // Codex round 12 F12-5 (P0): standalone `-f FILE`, `--file FILE`,
    // and `--file=FILE` forms when in CREATE/UPDATE/APPEND mode.
    // Pre-fix only the cluster form (`-czf FILE`) reached the value-
    // bearing argv in the cluster pass; the standalone forms walked
    // straight past as bare flags.
    if (v === '-f' && isCreateOrAppend) {
      const next = argv[i + 1];
      if (next !== undefined) {
        out.push({
          path: next.value,
          form: 'archive_create_dest',
          position: next.position,
          dynamic: next.dynamic,
          isDestructive: true,
          originSrc: 'tar -f writes archive (create/update/append mode)',
        });
      }
      i += 2;
      continue;
    }
    if (v === '--file' && isCreateOrAppend) {
      const next = argv[i + 1];
      if (next !== undefined) {
        out.push({
          path: next.value,
          form: 'archive_create_dest',
          position: next.position,
          dynamic: next.dynamic,
          isDestructive: true,
          originSrc: 'tar --file writes archive (create/update/append mode)',
        });
      }
      i += 2;
      continue;
    }
    if (v.startsWith('--file=') && isCreateOrAppend) {
      out.push({
        path: v.slice('--file='.length),
        form: 'archive_create_dest',
        position: tok.position,
        dynamic: tok.dynamic,
        isDestructive: true,
        originSrc: 'tar --file= writes archive (create/update/append mode)',
      });
      i += 1;
      continue;
    }
    // Single-dash flag/cluster handling. tar accepts:
    //   - `-Cpath`: bundled C-with-value (when C is the FIRST char in
    //     the argv and the rest is the directory).
    //   - `-xzfC archive .rea/`: cluster where C consumes the NEXT
    //     un-consumed argv (post-codex round 3 Finding 3).
    //   - `-xzfCpath`: extremely rare; tar typically requires the
    //     value at the cluster end to be in a separate argv.
    if (v.startsWith('-') && !v.startsWith('--') && v.length > 1) {
      // Bundled `-Cdir` form: `-C` is the FIRST char and the next char
      // is NOT a known cluster flag char (i.e. the rest is a value).
      // `-C.rea` → bundled (`.` is not a tar flag).
      // `-Cf` would be ambiguous but treated as a cluster of two flags.
      if (v.charAt(1) === 'C' && v.length > 2) {
        const next = v.charAt(2);
        // If the second char is non-flag-shaped (path-shape: ., /, ~,
        // alphanum but unknown to tar — be conservative and accept
        // `.` and `/` as definite path indicators, otherwise treat as
        // cluster). Simpler heuristic: if any char in the rest is NOT
        // a value-bearing flag char that cluster-takes argv, it's a
        // path. Use the conservative path-indicator check.
        if (next === '.' || next === '/' || next === '~' || next === '-') {
          out.push({
            path: v.slice(2),
            form: 'redirect',
            position: tok.position,
            dynamic: tok.dynamic,
            isDirTarget: true,
          });
          i += 1;
          continue;
        }
        // Else: drop into cluster handling below.
      }
      // Cluster handling: walk every char; for each value-bearing flag,
      // register a pending value-consumer. Then consume subsequent argv
      // tokens for the registered values in order.
      const after = v.slice(1);
      const localPending: { ch: string; tok: WordValue }[] = [];
      let saw = false;
      for (let j = 0; j < after.length; j += 1) {
        const ch = after.charAt(j);
        if (VALUE_BEARING_CLUSTER_CHARS.has(ch)) {
          saw = true;
          localPending.push({ ch, tok });
        }
      }
      if (saw) {
        let k = i + 1;
        while (localPending.length > 0 && k < argv.length) {
          const valTok = argv[k];
          if (valTok === undefined) break;
          // Stop on flag-shaped — the value chain ended.
          if (valTok.value.startsWith('-')) break;
          const entry = localPending.shift();
          if (entry === undefined) break;
          if (entry.ch === 'C') {
            out.push({
              path: valTok.value,
              form: 'redirect',
              position: valTok.position,
              dynamic: valTok.dynamic,
              isDirTarget: true,
            });
          }
          // Codex round 12 F12-5 (P0): when CREATE/UPDATE/APPEND mode
          // and the cluster's `f` consumes a value token, that value
          // is the OUTPUT archive path — emit as archive_create_dest.
          // Pre-fix `tar -czf .rea/policy.yaml docs/` slipped past:
          // the cluster `f` consumed `.rea/policy.yaml` as a value but
          // no detection emitted (the only emit case was `C`).
          if (entry.ch === 'f' && isCreateOrAppend) {
            out.push({
              path: valTok.value,
              form: 'archive_create_dest',
              position: valTok.position,
              dynamic: valTok.dynamic,
              isDestructive: true,
              originSrc: 'tar create/update/append writes archive at -f target',
            });
          }
          k += 1;
        }
        // If a C remained unfulfilled, fail-closed.
        let stillHasC = false;
        for (const entry of localPending) {
          if (entry.ch === 'C') {
            stillHasC = true;
            break;
          }
        }
        if (stillHasC) {
          out.push({
            path: '',
            form: 'redirect',
            position: tok.position,
            dynamic: true,
            originSrc: `tar cluster ${v} declared C but no directory argv resolved`,
            isDirTarget: true,
          });
        }
        i = k;
        continue;
      }
      // Cluster with no value-bearing flags — skip.
      i += 1;
      continue;
    }
    i += 1;
  }
  // Codex round 11 F11-4: extract-mode positional member harvesting.
  // After flag walk, collect non-flag positionals; in extract mode each
  // positional is a member-name destination (relative to the chosen
  // -C dir or cwd). If extract mode AND no positional members exist,
  // emit synthetic archive_extract_unresolvable.
  if (isExtract) {
    let positionalMembers = 0;
    let i2 = 1;
    // Re-walk to find non-flag positionals (after the action flag and
    // any value-bearing flag arguments). The simplest pass: skip every
    // token whose value starts with `-` or that follows a value-
    // bearing flag (--file FILE, --directory DIR, etc.). Any remaining
    // positional is a member name.
    const VALUE_BEARING_LONG = new Set([
      '--file',
      '--directory',
      '--exclude-from',
      '--exclude',
      '--exclude-tag',
      '--exclude-tag-all',
      '--exclude-tag-under',
      '--files-from',
      '--blocking-factor',
      '--record-size',
      '--checkpoint',
      '--checkpoint-action',
      '--occurrence',
      '--owner',
      '--group',
      '--mode',
      '--mtime',
      '--atime-preserve',
      '--newer',
      '--newer-mtime',
      '--after-date',
      '--starting-file',
      '--volno-file',
      '--info-script',
      '--new-volume-script',
      '--listed-incremental',
      '--rmt-command',
      '--rsh-command',
      '--use-compress-program',
      '--label',
      '--strip-components',
      '--transform',
      '--xform',
      '--anchored',
      '--no-anchored',
      '--ignore-case',
      '--no-ignore-case',
      '--wildcards',
      '--no-wildcards',
      '--wildcards-match-slash',
      '--no-wildcards-match-slash',
    ]);
    while (i2 < argv.length) {
      const tok = argv[i2];
      if (tok === undefined) {
        i2 += 1;
        continue;
      }
      const v = tok.value;
      if (v === '--') {
        i2 += 1;
        // Everything after `--` is positional.
        while (i2 < argv.length) {
          const m = argv[i2];
          if (m !== undefined) {
            out.push({
              path: m.value,
              form: 'archive_member_dest',
              position: m.position,
              dynamic: m.dynamic,
              isDestructive: true,
              originSrc: 'tar -x extracts member to filesystem',
            });
            positionalMembers += 1;
          }
          i2 += 1;
        }
        break;
      }
      // Value-bearing long form `--flag VAL` (separate-arg).
      if (VALUE_BEARING_LONG.has(v)) {
        i2 += 2;
        continue;
      }
      // Long form `--flag=VAL` — self-contained.
      if (v.startsWith('--') && v.includes('=')) {
        i2 += 1;
        continue;
      }
      // Bare long flag.
      if (v.startsWith('--')) {
        i2 += 1;
        continue;
      }
      // Short flag / cluster (`-x`, `-xzf`, `-Cdir`).
      if (v.startsWith('-') && v.length > 1) {
        // If cluster contains a value-bearing char, walk past one
        // value token per char (matching the existing logic). Use
        // VALUE_BEARING_CLUSTER_CHARS local set.
        let consumesNext = 0;
        const after = v.slice(1);
        for (let cidx = 0; cidx < after.length; cidx += 1) {
          if (VALUE_BEARING_CLUSTER_CHARS.has(after.charAt(cidx))) {
            consumesNext += 1;
          }
        }
        // First-char-bundled `-Cdir` consumes 0 next tokens (value
        // is in same argv).
        if (
          (after.charAt(0) === 'C' || after.charAt(0) === 'f') &&
          after.length > 1 &&
          (after.charAt(1) === '/' ||
            after.charAt(1) === '.' ||
            after.charAt(1) === '~' ||
            after.charAt(1) === '-')
        ) {
          consumesNext = Math.max(0, consumesNext - 1);
        }
        i2 += 1 + consumesNext;
        continue;
      }
      // Non-flag positional. In extract mode this IS a member name.
      out.push({
        path: v,
        form: 'archive_member_dest',
        position: tok.position,
        dynamic: tok.dynamic,
        isDestructive: true,
        originSrc: 'tar -x extracts member to filesystem',
      });
      positionalMembers += 1;
      i2 += 1;
    }
    if (positionalMembers === 0) {
      // No explicit member list. Archive contents are runtime-resolved.
      // We only emit unresolvable when there is no -C destination
      // narrowing the extraction; with -C DIR, the existing isDirTarget
      // emit on DIR handles protected-ancestry. Without -C, members
      // land relative to cwd — refuse on uncertainty.
      let hasDestC = false;
      for (let s = 1; s < argv.length; s += 1) {
        const tok = argv[s];
        if (tok === undefined) continue;
        const v = tok.value;
        if (
          v === '-C' ||
          v === '--directory' ||
          v.startsWith('--directory=') ||
          (v.startsWith('-C') && v.length > 2 && (v.charAt(2) === '/' || v.charAt(2) === '.' || v.charAt(2) === '~'))
        ) {
          hasDestC = true;
          break;
        }
        // Cluster with C — also acts as dest.
        if (v.startsWith('-') && !v.startsWith('--') && v.includes('C')) {
          hasDestC = true;
          break;
        }
      }
      if (!hasDestC) {
        const pos = argv[0]?.position ?? { line: 0, col: 0 };
        out.push({
          path: '',
          form: 'archive_extract_unresolvable',
          position: pos,
          dynamic: true,
          isDestructive: true,
          originSrc: 'tar -x without -C destination or explicit member list (archive contents unknown)',
        });
      }
    }
  }
}

/**
 * Codex round 11 F11-4: unzip detector.
 *
 * `unzip [-flags] ARCHIVE [member...] [-d DEST]`. Members are
 * extracted under DEST (or cwd if no -d). Without explicit members,
 * the archive may contain protected paths — refuse on uncertainty.
 *
 * Flags handled: -d DEST (destination dir), -o (overwrite), -p
 * (write to stdout — does NOT overwrite filesystem; ALLOW unless
 * combined with redirect; we still emit dynamic because future
 * shell redirect of -p output to a protected path is a separate
 * concern handled by stmt-level redirect detection).
 */
function detectUnzip(argv: WordValue[], out: DetectedWrite[]): void {
  // Codex round 12 F12-9 (P2, true regression vs 0.22.0): unzip
  // read-only modes do NOT write to the filesystem. Early-return
  // ALLOW when any of `-p`/`-l`/`-t`/`-v`/`-Z` is present (mutually
  // exclusive with extract-to-filesystem). Pre-fix `unzip -p x.zip
  // .rea/HALT` (extract member to STDOUT) BLOCKED on the dynamic
  // unresolvable emit even though no filesystem write occurs.
  //   -p   extract member to stdout
  //   -l   list contents (no extract)
  //   -t   test integrity (no extract)
  //   -v   verbose list (no extract)
  //   -Z   zipinfo-style listing (no extract)
  //   -z   show archive comment only (no extract)
  for (let s = 1; s < argv.length; s += 1) {
    const tok = argv[s];
    if (tok === undefined) continue;
    const v = tok.value;
    if (v === '-p' || v === '-l' || v === '-t' || v === '-v' || v === '-Z' || v === '-z') {
      return;
    }
    // Cluster forms `-vp`, `-tv`, etc. — any read-only char in a
    // single-dash cluster is enough to switch off filesystem extract.
    if (v.startsWith('-') && !v.startsWith('--') && v.length > 1) {
      const cluster = v.slice(1);
      if (
        cluster.includes('p') ||
        cluster.includes('l') ||
        cluster.includes('t') ||
        cluster.includes('v') ||
        cluster.includes('Z') ||
        cluster.includes('z')
      ) {
        return;
      }
    }
  }
  // Find -d DEST and explicit positional members.
  let destDir: WordValue | null = null;
  let archiveSeen = false;
  const members: WordValue[] = [];
  let i = 1;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) {
      i += 1;
      continue;
    }
    const v = tok.value;
    if (v === '-d') {
      const next = argv[i + 1];
      if (next !== undefined) destDir = next;
      i += 2;
      continue;
    }
    // unzip's `-x EXCLUDE` introduces an exclude list — those tokens
    // are NOT members. We stop walking positionals when -x appears.
    if (v === '-x') {
      // Skip remainder; -x consumes positionals as exclusions.
      i = argv.length;
      break;
    }
    if (v.startsWith('-')) {
      i += 1;
      continue;
    }
    if (!archiveSeen) {
      archiveSeen = true;
      i += 1;
      continue;
    }
    members.push(tok);
    i += 1;
  }
  // -d DEST is itself a write-into-directory hint.
  if (destDir !== null) {
    out.push({
      path: destDir.value,
      form: 'archive_extract_dest',
      position: destDir.position,
      dynamic: destDir.dynamic,
      isDirTarget: true,
      isDestructive: true,
      originSrc: 'unzip -d destination directory',
    });
  }
  // Each explicit member becomes a path under DEST (or cwd).
  for (const m of members) {
    const memPath = destDir !== null ? `${destDir.value.replace(/\/+$/, '')}/${m.value}` : m.value;
    out.push({
      path: memPath,
      form: 'archive_member_dest',
      position: m.position,
      dynamic: destDir?.dynamic === true || m.dynamic,
      isDestructive: true,
      originSrc: 'unzip extracts member to filesystem',
    });
  }
  if (members.length === 0 && destDir === null) {
    // No explicit member list AND no destination — archive may
    // contain protected paths that materialize relative to cwd.
    // Refuse on uncertainty.
    const pos = argv[0]?.position ?? { line: 0, col: 0 };
    out.push({
      path: '',
      form: 'archive_extract_unresolvable',
      position: pos,
      dynamic: true,
      isDestructive: true,
      originSrc: 'unzip without `-d` destination or explicit member list',
    });
  }
}

/**
 * Codex round 11 F11-4: 7-Zip dispatcher.
 *
 * `7z x ARCHIVE [-o<DEST>] [members...]`. The `x` (or `e`)
 * subcommand extracts; `-o<DEST>` (joined, no space) is the
 * destination directory; positionals after archive are members.
 */
function detect7z(argv: WordValue[], out: DetectedWrite[]): void {
  const sub = argv[1];
  if (sub === undefined) return;
  const subVal = sub.value;
  // Action subcommands that write to filesystem: x (extract preserving
  // paths), e (extract flat). Read-only: l/t/i/h. Compress: a/u/d.
  //
  // Codex round 12 F12-5 (P0): the COMPRESS subcommands ALSO write —
  // they create or update the archive at the named ARCHIVE position.
  // Pre-fix only x/e reached this dispatcher (early-return on others)
  // so `7z a .rea/policy.yaml docs/` slipped past entirely. We now
  // handle compress mode separately: the first positional after the
  // subcommand is the archive output, which becomes the write target.
  if (subVal === 'a' || subVal === 'u' || subVal === 'd') {
    // Walk past flags to find the first positional — that's ARCHIVE.
    for (let i = 2; i < argv.length; i += 1) {
      const tok = argv[i];
      if (tok === undefined) continue;
      const v = tok.value;
      if (v.startsWith('-')) continue;
      out.push({
        path: v,
        form: 'archive_create_dest',
        position: tok.position,
        dynamic: tok.dynamic,
        isDestructive: true,
        originSrc: `7z ${subVal} writes archive at first positional`,
      });
      return;
    }
    return;
  }
  if (subVal !== 'x' && subVal !== 'e') return;
  let destDir: string | null = null;
  let destPos: SourcePosition | null = null;
  let destDyn = false;
  const members: WordValue[] = [];
  let archiveSeen = false;
  for (let i = 2; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;
    const v = tok.value;
    if (v.startsWith('-o')) {
      destDir = v.slice(2);
      destPos = tok.position;
      destDyn = tok.dynamic;
      continue;
    }
    if (v.startsWith('-')) continue;
    if (!archiveSeen) {
      archiveSeen = true;
      continue;
    }
    members.push(tok);
  }
  if (destDir !== null && destPos !== null) {
    out.push({
      path: destDir,
      form: 'archive_extract_dest',
      position: destPos,
      dynamic: destDyn,
      isDirTarget: true,
      isDestructive: true,
      originSrc: '7z -o destination directory',
    });
  }
  for (const m of members) {
    const memPath = destDir !== null ? `${destDir.replace(/\/+$/, '')}/${m.value}` : m.value;
    out.push({
      path: memPath,
      form: 'archive_member_dest',
      position: m.position,
      dynamic: destDyn || m.dynamic,
      isDestructive: true,
      originSrc: '7z extracts member',
    });
  }
  if (members.length === 0 && destDir === null) {
    const pos = argv[0]?.position ?? { line: 0, col: 0 };
    out.push({
      path: '',
      form: 'archive_extract_unresolvable',
      position: pos,
      dynamic: true,
      isDestructive: true,
      originSrc: '7z without -o destination or explicit member list',
    });
  }
}

/**
 * Codex round 12 F12-5 (P0): zip dispatcher (CREATE direction).
 *
 * `zip [flags] OUTPUT.zip [files...]` writes/overwrites OUTPUT.zip.
 * Pre-fix `zip .rea/policy.yaml docs/file` slipped past entirely (no
 * dispatcher case). zip's argv shape: the FIRST non-flag positional
 * IS the output archive name; all subsequent positionals are inputs.
 *
 * Flags considered "value-bearing" (consume next argv): -t, -tt, -o,
 * -m (with value), -du, -dd, -dc, -ds. Most zip flags are bare
 * toggles (-r, -q, -v, -y, -j, -k, -n EXT, -P PASSWORD, -e, -X, -z).
 *
 * For static analysis we keep it simple: skip any token that starts
 * with `-`. The first non-flag positional is the output archive.
 *
 * The few real value-bearing zip flags that take a non-flag value
 * could in theory shift the "first positional is the archive"
 * accounting, but in practice — and within the cumulative-discipline
 * fail-closed posture — over-blocking on `zip -P PASSWORD .rea/...`
 * (where PASSWORD looks like a path) is a tolerable false-positive.
 * Real attacks use the standard form `zip OUTPUT inputs...` which
 * we cleanly catch.
 */
function detectZip(argv: WordValue[], out: DetectedWrite[]): void {
  // Codex round 12 F12-9 (P2 parity): zip read-only flag set is
  // smaller than unzip's, but `-sf` (show files) and `-T` (test)
  // are read-only inspection modes. We keep zip strict: any non-flag
  // first positional becomes the archive output. Operators wanting
  // to inspect should use unzip -l (handled by detectUnzip's read-
  // only short-circuit).
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;
    const v = tok.value;
    // Skip flag-shaped tokens. We do NOT walk past value-bearing
    // flag values — see the docstring; over-block is acceptable.
    if (v.startsWith('-')) continue;
    out.push({
      path: v,
      form: 'archive_create_dest',
      position: tok.position,
      dynamic: tok.dynamic,
      isDestructive: true,
      originSrc: 'zip writes archive at first non-flag positional',
    });
    // Only the FIRST positional is the archive output; subsequent
    // positionals are input file/dir names — read-only.
    return;
  }
}

/**
 * Codex round 12 F12-6 (P1): cmake `-E` utility surface.
 *
 * cmake's `-E` mode is a portable POSIX-ish utility runner exposing
 * filesystem operations across platforms (notably on Windows where
 * cmake is part of the standard toolchain). The destructive subset
 * mirrors the unix utility set already covered in `walkCallExpr`:
 *
 *   cmake -E rm PATH...                 — like rm
 *   cmake -E remove PATH...             — like rm
 *   cmake -E rename SRC DEST            — like mv
 *   cmake -E copy SRC DEST              — like cp DEST
 *   cmake -E copy_if_different SRC DEST — like cp DEST
 *   cmake -E copy_directory SRC DEST    — DEST is the dir
 *   cmake -E copy_directory_if_different SRC DEST
 *   cmake -E touch PATH...              — like touch
 *   cmake -E remove_directory PATH...   — like rmdir (recursive)
 *   cmake -E create_symlink TARGET LINK — LINK is the write
 *   cmake -E create_hardlink TARGET LINK— LINK is the write
 *   cmake -E make_directory PATH...     — like mkdir -p
 *
 * Read-only subcommands (echo, sleep, capabilities, environment,
 * compare_files, sha256sum, time, etc.) cause a silent no-op return.
 * False positives on `cmake -E unknown_subcommand .rea/...` are
 * acceptable: any unrecognized subcommand whose argv shape includes
 * a path-like token in a position we'd treat as a write would have
 * to be a real cmake subcommand we hadn't enumerated; pre-empting
 * that with an over-block is preferable to silent skip.
 *
 * Cumulative parity (round 12 checklist):
 *  - basename normalization: handled by walkCallExpr / recurseInnerArgv.
 *  - wrapper-strip respect: handled by stripEnvAndModifiers upstream.
 *  - isDestructive: rm/remove/rename/touch/remove_directory carry it.
 *  - isDirTarget: copy_directory / remove_directory / make_directory.
 *  - source-side parity (F3): cmake -E rename emits BOTH SRC and DEST
 *    as destructive (like mv).
 *  - shell-out re-parse: cmake -E does NOT exec strings; not applicable.
 *  - dynamic detection: handled per-token via tok.dynamic propagation.
 */
function detectCmake(argv: WordValue[], out: DetectedWrite[]): void {
  // argv[0] is `cmake` (already normalized). cmake's utility mode
  // requires `-E` as the FIRST flag. Any other invocation (configure,
  // build, install) writes via build commands not directly visible
  // to the static scanner; we silently skip.
  if (argv.length < 3) return;
  const flag = argv[1];
  if (flag === undefined || flag.value !== '-E') return;
  const sub = argv[2];
  if (sub === undefined) return;
  const subVal = sub.value;

  // Collect non-flag positionals from argv[3..]. cmake -E doesn't use
  // flag-shaped tokens beyond the subcommand in destructive ops.
  const positionals: WordValue[] = [];
  for (let i = 3; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok.value.startsWith('-')) continue;
    positionals.push(tok);
  }
  if (positionals.length === 0) return;

  switch (subVal) {
    case 'rm':
    case 'remove': {
      // Variadic — every positional is a destructive write target.
      for (const p of positionals) {
        out.push({
          path: p.value,
          form: 'cmake_e_dest',
          position: p.position,
          dynamic: p.dynamic,
          isDestructive: true,
          originSrc: `cmake -E ${subVal} (file deletion)`,
        });
      }
      return;
    }
    case 'touch': {
      for (const p of positionals) {
        out.push({
          path: p.value,
          form: 'cmake_e_dest',
          position: p.position,
          dynamic: p.dynamic,
          originSrc: 'cmake -E touch (file create/update)',
        });
      }
      return;
    }
    case 'remove_directory': {
      for (const p of positionals) {
        out.push({
          path: p.value,
          form: 'cmake_e_dest',
          position: p.position,
          dynamic: p.dynamic,
          isDestructive: true,
          isDirTarget: true,
          originSrc: 'cmake -E remove_directory (recursive dir delete)',
        });
      }
      return;
    }
    case 'make_directory': {
      for (const p of positionals) {
        out.push({
          path: p.value,
          form: 'cmake_e_dest',
          position: p.position,
          dynamic: p.dynamic,
          isDirTarget: true,
          originSrc: 'cmake -E make_directory (mkdir -p)',
        });
      }
      return;
    }
    case 'rename': {
      // mv-shape: SRC + DEST. Round-4 F3 parity — emit BOTH as
      // destructive (SRC content is removed at original path).
      const src = positionals[0];
      const dest = positionals[1];
      if (src !== undefined) {
        out.push({
          path: src.value,
          form: 'cmake_e_dest',
          position: src.position,
          dynamic: src.dynamic,
          isDestructive: true,
          originSrc: 'cmake -E rename source-side (content removed at SRC)',
        });
      }
      if (dest !== undefined) {
        out.push({
          path: dest.value,
          form: 'cmake_e_dest',
          position: dest.position,
          dynamic: dest.dynamic,
          isDestructive: true,
          originSrc: 'cmake -E rename destination',
        });
      }
      return;
    }
    case 'copy':
    case 'copy_if_different': {
      // cp-shape: cmake -E copy SRC DEST. cmake-3.5+ accepts multiple
      // SRCs followed by a single DEST when DEST is a dir, but the
      // static scanner stays conservative: emit the LAST positional
      // as the DEST write target. False-positive on N-positional
      // copy is acceptable (the last positional IS the dest).
      const dest = positionals[positionals.length - 1];
      if (dest !== undefined) {
        out.push({
          path: dest.value,
          form: 'cmake_e_dest',
          position: dest.position,
          dynamic: dest.dynamic,
          originSrc: `cmake -E ${subVal} destination`,
        });
      }
      return;
    }
    case 'copy_directory':
    case 'copy_directory_if_different': {
      const dest = positionals[positionals.length - 1];
      if (dest !== undefined) {
        out.push({
          path: dest.value,
          form: 'cmake_e_dest',
          position: dest.position,
          dynamic: dest.dynamic,
          isDirTarget: true,
          originSrc: `cmake -E ${subVal} destination dir`,
        });
      }
      return;
    }
    case 'create_symlink':
    case 'create_hardlink': {
      // argv shape: cmake -E create_symlink TARGET LINK
      // LINK (the second positional) is the write — TARGET is read.
      const link = positionals[1];
      if (link !== undefined) {
        out.push({
          path: link.value,
          form: 'cmake_e_dest',
          position: link.position,
          dynamic: link.dynamic,
          originSrc: `cmake -E ${subVal} link path (created/overwritten)`,
        });
      }
      return;
    }
    default:
      // Read-only or out-of-scope subcommand; silent skip.
      return;
  }
}

/**
 * Codex round 12 F12-7 (P1): mkfifo dispatcher.
 *
 * `mkfifo [-m MODE] PATH...` creates a named FIFO at each PATH.
 * Pre-fix `mkfifo .rea/HALT` slipped past the dispatcher (no case)
 * even though it creates a special file at the protected path. We
 * treat each non-flag positional as a destructive write (an existing
 * file at PATH would not be overwritten — mkfifo errors instead —
 * but the operation is policy-relevant: it materializes a new file
 * inside a protected directory).
 */
function detectMkfifo(argv: WordValue[], out: DetectedWrite[]): void {
  // Skip flags. -m takes a value (the mode); skip both tokens.
  let i = 1;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) {
      i += 1;
      continue;
    }
    const v = tok.value;
    if (v === '--') {
      // Everything after `--` is positional.
      for (let k = i + 1; k < argv.length; k += 1) {
        const m = argv[k];
        if (m === undefined) continue;
        out.push({
          path: m.value,
          form: 'mkfifo_dest',
          position: m.position,
          dynamic: m.dynamic,
          isDestructive: true,
          originSrc: 'mkfifo creates named FIFO at PATH',
        });
      }
      return;
    }
    if (v === '-m' || v === '--mode') {
      i += 2;
      continue;
    }
    if (v.startsWith('--mode=')) {
      i += 1;
      continue;
    }
    if (v.startsWith('-')) {
      i += 1;
      continue;
    }
    // Bare positional — write target.
    out.push({
      path: v,
      form: 'mkfifo_dest',
      position: tok.position,
      dynamic: tok.dynamic,
      isDestructive: true,
      originSrc: 'mkfifo creates named FIFO at PATH',
    });
    i += 1;
  }
}

/**
 * Codex round 12 F12-7 (P1): mknod dispatcher.
 *
 * `mknod [-m MODE] NAME TYPE [MAJOR MINOR]` creates a special file
 * (block / character / FIFO) at NAME. Pre-fix `mknod .rea/HALT c 0 0`
 * slipped past entirely. argv shape: NAME is the FIRST non-flag
 * positional; everything after is type/major/minor parameters.
 */
function detectMknod(argv: WordValue[], out: DetectedWrite[]): void {
  let i = 1;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) {
      i += 1;
      continue;
    }
    const v = tok.value;
    if (v === '--') {
      const nameTok = argv[i + 1];
      if (nameTok !== undefined) {
        out.push({
          path: nameTok.value,
          form: 'mknod_dest',
          position: nameTok.position,
          dynamic: nameTok.dynamic,
          isDestructive: true,
          originSrc: 'mknod creates special file at NAME',
        });
      }
      return;
    }
    if (v === '-m' || v === '--mode') {
      i += 2;
      continue;
    }
    if (v.startsWith('--mode=')) {
      i += 1;
      continue;
    }
    if (v.startsWith('-')) {
      i += 1;
      continue;
    }
    // First bare positional is NAME — emit and stop. Subsequent
    // positionals are type/major/minor numerals, not paths.
    out.push({
      path: v,
      form: 'mknod_dest',
      position: tok.position,
      dynamic: tok.dynamic,
      isDestructive: true,
      originSrc: 'mknod creates special file at NAME',
    });
    return;
  }
}

/**
 * Codex round 11 F11-4: gzip / gunzip dispatcher.
 *
 * `gzip [-k] FILE` writes FILE.gz; `gunzip [-k] FILE.gz` writes FILE.
 * The output filename is derived from the input. If the input is a
 * protected path (or its derived output is), emit a write target.
 */
function detectGzip(argv: WordValue[], out: DetectedWrite[], head: 'gzip' | 'gunzip'): void {
  // Walk positionals after flags.
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;
    const v = tok.value;
    if (v === '--') {
      for (let k = i + 1; k < argv.length; k += 1) {
        const m = argv[k];
        if (m === undefined) continue;
        emitGzipWrite(m, head, out);
      }
      return;
    }
    if (v.startsWith('-')) continue;
    emitGzipWrite(tok, head, out);
  }
}

function emitGzipWrite(tok: WordValue, head: 'gzip' | 'gunzip', out: DetectedWrite[]): void {
  // gzip FILE → writes FILE.gz; gunzip FILE.gz → writes FILE
  // (strips .gz suffix). We emit BOTH the input and the derived
  // output as targets so the protected matcher catches either.
  out.push({
    path: tok.value,
    form: 'gzip_compress_dest',
    position: tok.position,
    dynamic: tok.dynamic,
    isDestructive: true,
    originSrc: `${head} input/output materialization`,
  });
  if (head === 'gzip') {
    out.push({
      path: `${tok.value}.gz`,
      form: 'gzip_compress_dest',
      position: tok.position,
      dynamic: tok.dynamic,
      originSrc: 'gzip writes derived .gz output',
    });
  } else {
    if (tok.value.endsWith('.gz')) {
      out.push({
        path: tok.value.slice(0, -3),
        form: 'gzip_compress_dest',
        position: tok.position,
        dynamic: tok.dynamic,
        isDestructive: true,
        originSrc: 'gunzip writes derived (.gz-stripped) output',
      });
    }
  }
}

/**
 * Codex round 11 F11-4: pax dispatcher.
 *
 * `pax -r [-s SUBST] [-f ARCHIVE]` reads (extracts) the archive.
 * `-s` substitution rules can rewrite member names — a re-parse
 * seam we cannot resolve statically. Emit dynamic on uncertainty
 * for any -r invocation.
 */
function detectPax(argv: WordValue[], out: DetectedWrite[]): void {
  let isRead = false;
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;
    const v = tok.value;
    // pax accepts cluster flags: `-rf ARCHIVE`, `-rwf ...`, etc. The
    // `r` (read/extract) char anywhere in a cluster signals extract.
    if (v.startsWith('-') && !v.startsWith('--') && v.length > 1) {
      if (v.includes('r')) {
        isRead = true;
        break;
      }
    } else if (v === '-r') {
      isRead = true;
      break;
    }
  }
  if (!isRead) return;
  const pos = argv[0]?.position ?? { line: 0, col: 0 };
  out.push({
    path: '',
    form: 'archive_extract_unresolvable',
    position: pos,
    dynamic: true,
    isDestructive: true,
    originSrc: 'pax -r extracts archive (member set unknown)',
  });
}

/**
 * rsync detector. Codex round 2 R2-8. Last positional is destination.
 * Skip flags (including value-bearing forms). rsync syntax:
 *   rsync [OPTIONS] SRC... DEST
 */
function detectRsync(argv: WordValue[], out: DetectedWrite[]): void {
  // Value-bearing rsync flags we must skip.
  const VALUE_BEARING = new Set([
    '-e',
    '--rsh',
    '-f',
    '--filter',
    '--include',
    '--exclude',
    '--include-from',
    '--exclude-from',
    '--files-from',
    '-T',
    '--temp-dir',
    '--partial-dir',
    '--log-file',
    '--password-file',
    '--port',
    '--sockopts',
    '--rsync-path',
    '-B',
    '--block-size',
    '--bwlimit',
    '--max-size',
    '--min-size',
    '--timeout',
    '--contimeout',
    '--modify-window',
    '--compare-dest',
    '--copy-dest',
    '--link-dest',
    '--chmod',
    '--usermap',
    '--groupmap',
    '--chown',
    '--protocol',
    '--out-format',
  ]);
  const positionals: WordValue[] = [];
  let i = 1;
  let endOfOpts = false;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    if (endOfOpts) {
      positionals.push(tok);
      i += 1;
      continue;
    }
    const v = tok.value;
    if (v === '--') {
      endOfOpts = true;
      i += 1;
      continue;
    }
    if (VALUE_BEARING.has(v)) {
      i += 2;
      continue;
    }
    // `--option=value` self-contained.
    if (v.startsWith('--') && v.includes('=')) {
      i += 1;
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      i += 1;
      continue;
    }
    positionals.push(tok);
    i += 1;
  }
  if (positionals.length >= 2) {
    const dest = positionals[positionals.length - 1];
    if (dest !== undefined) {
      out.push({
        path: dest.value,
        form: 'redirect',
        position: dest.position,
        dynamic: dest.dynamic,
        // rsync DEST that ends with `/` is a directory; we also tag as
        // directory if the original input ended with /. mvdan-sh
        // preserves the trailing slash.
        isDirTarget: dest.value.endsWith('/'),
      });
    }
  }
}

/**
 * curl detector. Codex round 2 R2-9. `-o FILE` / `--output FILE` writes
 * the response body to FILE. `-O` uses the URL's basename — dynamic
 * (we don't resolve URLs).
 */
function detectCurl(argv: WordValue[], out: DetectedWrite[]): void {
  let i = 1;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    const v = tok.value;
    if (v === '-o' || v === '--output') {
      const next = argv[i + 1];
      if (next !== undefined) {
        out.push({
          path: next.value,
          form: 'redirect',
          position: next.position,
          dynamic: next.dynamic,
        });
      }
      i += 2;
      continue;
    }
    if (v.startsWith('--output=')) {
      out.push({
        path: v.slice('--output='.length),
        form: 'redirect',
        position: tok.position,
        dynamic: tok.dynamic,
      });
      i += 1;
      continue;
    }
    // -oFILE joined.
    if (v.startsWith('-o') && v.length > 2 && !v.startsWith('--')) {
      out.push({
        path: v.slice(2),
        form: 'redirect',
        position: tok.position,
        dynamic: tok.dynamic,
      });
      i += 1;
      continue;
    }
    if (v === '-O' || v === '--remote-name') {
      // Dynamic — destination is URL's basename.
      out.push({
        path: '',
        form: 'redirect',
        position: tok.position,
        dynamic: true,
        originSrc: 'curl -O (destination derived from URL basename)',
      });
      i += 1;
      continue;
    }
    i += 1;
  }
}

/**
 * wget detector. Codex round 2 R2-9. `-O FILE` / `--output-document=FILE`
 * writes to FILE. `-O -` writes to stdout (allow). Without -O, wget uses
 * the URL's filename (dynamic).
 */
function detectWget(argv: WordValue[], out: DetectedWrite[]): void {
  let i = 1;
  let sawO = false;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    const v = tok.value;
    if (v === '-O' || v === '--output-document') {
      sawO = true;
      const next = argv[i + 1];
      if (next !== undefined) {
        // -O - is stdout (no write target).
        if (next.value === '-') {
          i += 2;
          continue;
        }
        out.push({
          path: next.value,
          form: 'redirect',
          position: next.position,
          dynamic: next.dynamic,
        });
      }
      i += 2;
      continue;
    }
    if (v.startsWith('--output-document=')) {
      sawO = true;
      const value = v.slice('--output-document='.length);
      if (value !== '-') {
        out.push({
          path: value,
          form: 'redirect',
          position: tok.position,
          dynamic: tok.dynamic,
        });
      }
      i += 1;
      continue;
    }
    // -OFILE joined.
    if (v.startsWith('-O') && v.length > 2 && !v.startsWith('--')) {
      sawO = true;
      const value = v.slice(2);
      if (value !== '-') {
        out.push({
          path: value,
          form: 'redirect',
          position: tok.position,
          dynamic: tok.dynamic,
        });
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  // When wget is invoked without -O, it derives the filename from URL —
  // dynamic. This is intentional defensive over-blocking.
  if (!sawO && argv.length > 1) {
    out.push({
      path: '',
      form: 'redirect',
      position: argv[0]?.position ?? { line: 0, col: 0 },
      dynamic: true,
      originSrc: 'wget without -O (destination derived from URL)',
    });
  }
}

/**
 * shred detector. Codex round 2 R2-10. Every non-flag positional is a
 * file being overwritten with random data (and optionally unlinked
 * with -u). Treat as redirect-form writes.
 */
function detectShred(argv: WordValue[], out: DetectedWrite[]): void {
  // Value-bearing flags.
  const VALUE_BEARING = new Set(['-n', '--iterations', '-s', '--size', '--random-source']);
  let i = 1;
  let endOfOpts = false;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    if (endOfOpts) {
      out.push({ path: tok.value, form: 'redirect', position: tok.position, dynamic: tok.dynamic });
      i += 1;
      continue;
    }
    const v = tok.value;
    if (v === '--') {
      endOfOpts = true;
      i += 1;
      continue;
    }
    if (VALUE_BEARING.has(v)) {
      i += 2;
      continue;
    }
    if (v.startsWith('--') && v.includes('=')) {
      i += 1;
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      i += 1;
      continue;
    }
    out.push({ path: v, form: 'redirect', position: tok.position, dynamic: tok.dynamic });
    i += 1;
  }
}

/**
 * eval detector. Codex round 2 R2-13. eval concatenates its argv tokens
 * with spaces and re-parses the result as a shell command. We
 * concatenate, re-parse, walk.
 */
function detectEval(argv: WordValue[], out: DetectedWrite[]): void {
  // Concatenate all tokens after "eval" — bash semantics: a single
  // command line composed by joining argv with spaces.
  //
  // Codex round 3 Finding 1 (P0): the dynamic check MUST come before
  // the empty-inner short-circuit. Pre-fix, `eval $(cmd)` produced an
  // empty `inner` (CmdSubst is unresolvable so wordToString returns
  // {value:'', dynamic:true}); the function returned without firing
  // any detection. Now: if any argv tok is dynamic, we ALWAYS emit a
  // dynamic detection regardless of the static-concat shape.
  const parts: string[] = [];
  let anyDynamic = false;
  let anyArg = false;
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;
    anyArg = true;
    if (tok.dynamic) anyDynamic = true;
    parts.push(tok.value);
  }
  if (!anyArg) return;
  if (anyDynamic) {
    // We can't fully resolve the eval payload — refuse on uncertainty.
    // This catches `eval $(cmd)`, `eval \`cmd\``, `eval $VAR`, and any
    // mixed static+dynamic shape (`eval echo $X`).
    out.push({
      path: '',
      form: 'redirect',
      position: argv[0]?.position ?? { line: 0, col: 0 },
      dynamic: true,
      originSrc: 'eval with dynamic argv (unresolvable target)',
    });
    return;
  }
  const inner = parts.join(' ');
  if (inner.length === 0) return;
  const parsed = parseBashCommand(inner);
  if (!parsed.ok) {
    out.push({
      path: '',
      form: 'redirect',
      position: argv[0]?.position ?? { line: 0, col: 0 },
      dynamic: true,
      originSrc: 'eval payload failed to parse — refusing on uncertainty',
    });
    return;
  }
  const innerWrites = walkForWrites(parsed.file);
  for (const d of innerWrites) {
    out.push({
      ...d,
      // Preserve the outer eval's position so error messages line up.
      position: argv[0]?.position ?? d.position,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Codex round 4 Finding 7: misc utilities (patch, sort, shuf, gpg,
//  split/csplit, trap)
// ─────────────────────────────────────────────────────────────────────

/**
 * patch detector. Codex round 4 Finding 7. `patch [-Nfu] FILE [< PATCH]`
 * applies a patch to FILE; FILE is the write target. We treat every
 * non-flag positional as a write target. Value-bearing flags handled:
 *   -i FILE / --input=FILE — input patch file (NOT the target).
 *   -o FILE / --output=FILE — output file (write target).
 *   -d DIR / --directory=DIR — base directory.
 *   -p NUM / --strip=NUM — strip count.
 *   -B PFX / -V METHOD / -z EXT / -F NUM — value-bearing.
 */
function detectPatch(argv: WordValue[], out: DetectedWrite[]): void {
  const VALUE_BEARING = new Set([
    '-i',
    '--input',
    '-d',
    '--directory',
    '-p',
    '--strip',
    '-B',
    '--prefix',
    '-V',
    '--version-control',
    '-z',
    '--suffix',
    '-F',
    '--fuzz',
    '-D',
    '--ifdef',
    '-Y',
    '--basename-prefix',
  ]);
  let i = 1;
  let endOfOpts = false;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    const v = tok.value;
    if (endOfOpts) {
      out.push({
        path: v,
        form: 'redirect',
        position: tok.position,
        dynamic: tok.dynamic,
      });
      i += 1;
      continue;
    }
    if (v === '--') {
      endOfOpts = true;
      i += 1;
      continue;
    }
    // -o FILE / --output=FILE — write target.
    if (v === '-o' || v === '--output') {
      const next = argv[i + 1];
      if (next !== undefined) {
        out.push({
          path: next.value,
          form: 'redirect',
          position: next.position,
          dynamic: next.dynamic,
        });
      }
      i += 2;
      continue;
    }
    if (v.startsWith('--output=')) {
      out.push({
        path: v.slice('--output='.length),
        form: 'redirect',
        position: tok.position,
        dynamic: tok.dynamic,
      });
      i += 1;
      continue;
    }
    if (VALUE_BEARING.has(v)) {
      i += 2;
      continue;
    }
    if (v.startsWith('--') && v.includes('=')) {
      i += 1;
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      i += 1;
      continue;
    }
    // Bare positional — patch target file.
    out.push({
      path: v,
      form: 'redirect',
      position: tok.position,
      dynamic: tok.dynamic,
    });
    i += 1;
  }
}

/**
 * sort detector. Codex round 4 Finding 7. `sort -o FILE` writes sorted
 * output to FILE. Conservative: only emit on the explicit -o / --output=
 * form (the default writes to stdout).
 */
function detectSort(argv: WordValue[], out: DetectedWrite[]): void {
  let i = 1;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    const v = tok.value;
    if (v === '-o' || v === '--output') {
      const next = argv[i + 1];
      if (next !== undefined) {
        out.push({
          path: next.value,
          form: 'redirect',
          position: next.position,
          dynamic: next.dynamic,
        });
      }
      i += 2;
      continue;
    }
    if (v.startsWith('--output=')) {
      out.push({
        path: v.slice('--output='.length),
        form: 'redirect',
        position: tok.position,
        dynamic: tok.dynamic,
      });
      i += 1;
      continue;
    }
    // -oFILE bundled.
    if (v.startsWith('-o') && v.length > 2 && !v.startsWith('--')) {
      out.push({
        path: v.slice(2),
        form: 'redirect',
        position: tok.position,
        dynamic: tok.dynamic,
      });
      i += 1;
      continue;
    }
    i += 1;
  }
}

/**
 * shuf detector. Codex round 4 Finding 7. Same shape as sort `-o FILE`.
 */
function detectShuf(argv: WordValue[], out: DetectedWrite[]): void {
  detectSort(argv, out);
}

/**
 * gpg detector. Codex round 4 Finding 7. `gpg --output FILE` /
 * `gpg -o FILE` writes the encrypted/decrypted/exported content to FILE.
 */
function detectGpg(argv: WordValue[], out: DetectedWrite[]): void {
  let i = 1;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    const v = tok.value;
    if (v === '-o' || v === '--output') {
      const next = argv[i + 1];
      if (next !== undefined) {
        out.push({
          path: next.value,
          form: 'redirect',
          position: next.position,
          dynamic: next.dynamic,
        });
      }
      i += 2;
      continue;
    }
    if (v.startsWith('--output=')) {
      out.push({
        path: v.slice('--output='.length),
        form: 'redirect',
        position: tok.position,
        dynamic: tok.dynamic,
      });
      i += 1;
      continue;
    }
    i += 1;
  }
}

/**
 * split / csplit detector. Codex round 4 Finding 7. `split [OPT]... [FILE
 * [PREFIX]]`. The PREFIX positional is the write-target prefix; output
 * files are PREFIX + suffix. We treat the prefix's parent directory as
 * a destructive write target so writing into a protected directory is
 * caught. If PREFIX is `.rea/HALT`, that's a literal write target.
 */
function detectSplit(argv: WordValue[], out: DetectedWrite[]): void {
  // split's positionals are FILE then PREFIX. We don't model the
  // distinction; we treat both positionals as potential write targets.
  // FILE is read-only in normal usage but a sufficiently weird invocation
  // could overlap; the over-block on FILE is safe because legitimate
  // usage always reads from FILE and writes to PREFIX.
  let i = 1;
  let endOfOpts = false;
  const positionals: WordValue[] = [];
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    const v = tok.value;
    if (endOfOpts) {
      positionals.push(tok);
      i += 1;
      continue;
    }
    if (v === '--') {
      endOfOpts = true;
      i += 1;
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      // Skip flag clusters — split's value-bearing flags are mostly
      // self-contained or use `=`. Common short clusters: -b, -l, -n.
      if (v === '-b' || v === '-l' || v === '-n' || v === '-a' || v === '-d') {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    positionals.push(tok);
    i += 1;
  }
  if (positionals.length >= 2) {
    // PREFIX (last positional) is the write target.
    const prefix = positionals[positionals.length - 1];
    if (prefix !== undefined) {
      out.push({
        path: prefix.value,
        form: 'redirect',
        position: prefix.position,
        dynamic: prefix.dynamic,
      });
    }
  } else if (positionals.length === 1) {
    // Single positional is FILE; default PREFIX is `x`. Default behavior
    // not policy-relevant unless cwd is protected — skip the over-block.
  }
}

/**
 * trap detector. Codex round 4 Finding 7. `trap "CMD" SIGNAL` — when a
 * signal fires, CMD is re-parsed as a shell command. Emit the inner
 * argv[1] as a re-parseable shell payload.
 */
function detectTrap(argv: WordValue[], out: DetectedWrite[]): void {
  // `trap` first arg is the command string; subsequent args are signal
  // names. `trap - SIGNAL` resets; `trap '' SIGNAL` ignores.
  if (argv.length < 2) return;
  const cmdTok = argv[1];
  if (cmdTok === undefined) return;
  if (cmdTok.dynamic) {
    out.push({
      path: '',
      form: 'redirect',
      position: cmdTok.position,
      dynamic: true,
      originSrc: 'trap with dynamic command (refuse on uncertainty)',
    });
    return;
  }
  // Empty / `-` reset values.
  if (cmdTok.value === '' || cmdTok.value === '-') return;
  const parsed = parseBashCommand(cmdTok.value);
  if (!parsed.ok) {
    out.push({
      path: '',
      form: 'redirect',
      position: cmdTok.position,
      dynamic: true,
      originSrc: 'trap command failed to parse',
    });
    return;
  }
  const innerWrites = walkForWrites(parsed.file);
  for (const d of innerWrites) {
    out.push({
      ...d,
      position: cmdTok.position,
    });
  }
}

/**
 * git subcommand detector. Codex round 2 R2-11. Several git subcommands
 * write file contents into the working tree from the index / a commit:
 *   - `git checkout -- PATH` — revert PATH from index/HEAD
 *   - `git checkout SOURCE -- PATH` — revert from SOURCE
 *   - `git restore -- PATH` / `git restore --source=REF -- PATH`
 *   - `git reset HEAD -- PATH` — index reset, CAN write
 *
 * Detection scope: when the subcommand is one of these AND the argv
 * contains `--` separator, every token after `--` is a path write.
 * Without `--`, branch-name vs path is ambiguous; we only fire on the
 * explicit `--` form.
 */
function detectGit(argv: WordValue[], out: DetectedWrite[]): void {
  // Codex round 3 Finding 4 (P1): git accepts TOP-LEVEL value-bearing
  // flags BEFORE the subcommand: `-C <dir>`, `-c <name>=<value>`,
  // `--exec-path[=<dir>]`, `--git-dir=<dir>`, `--work-tree=<dir>`,
  // `--namespace=<name>`, `--super-prefix=<dir>`, `--config-env=<n>=<e>`.
  // Pre-fix the loop assumed any non-flag argv was the subcommand. So
  // `git -C subdir checkout -- ../.rea/HALT` had `subdir` mis-classified
  // as the subcommand and detection failed.
  //
  // Walk past these top-level flags first.
  const TOP_LEVEL_VALUE_FLAGS = new Set(['-C', '-c']);
  // Long flags with value-via-equals (single argv).
  const TOP_LEVEL_LONG_PREFIXES = [
    '--exec-path=',
    '--git-dir=',
    '--work-tree=',
    '--namespace=',
    '--super-prefix=',
    '--config-env=',
  ];
  // Long flags that consume the NEXT argv (rare; most use `=`).
  const TOP_LEVEL_LONG_SPACE = new Set([
    '--exec-path',
    '--git-dir',
    '--work-tree',
    '--namespace',
    '--super-prefix',
    '--config-env',
  ]);
  // Boolean (no-value) top-level flags — just skip.
  const TOP_LEVEL_BOOLEAN = new Set([
    '--bare',
    '--no-replace-objects',
    '--literal-pathspecs',
    '--glob-pathspecs',
    '--noglob-pathspecs',
    '--icase-pathspecs',
    '--paginate',
    '-p',
    '--no-pager',
    '-P',
    '--no-optional-locks',
    '--version',
    '--help',
    '-h',
    '--html-path',
    '--man-path',
    '--info-path',
  ]);

  // Find the subcommand (first non-flag positional after the top-level
  // flag prefix).
  let subcmd: string | null = null;
  let subcmdIdx = -1;
  let i = 1;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) {
      i += 1;
      continue;
    }
    const v = tok.value;
    if (TOP_LEVEL_VALUE_FLAGS.has(v)) {
      i += 2;
      continue;
    }
    if (TOP_LEVEL_LONG_SPACE.has(v)) {
      i += 2;
      continue;
    }
    let matchedLong = false;
    for (const pfx of TOP_LEVEL_LONG_PREFIXES) {
      if (v.startsWith(pfx)) {
        matchedLong = true;
        break;
      }
    }
    if (matchedLong) {
      i += 1;
      continue;
    }
    if (TOP_LEVEL_BOOLEAN.has(v)) {
      i += 1;
      continue;
    }
    if (v.startsWith('-')) {
      // Unknown flag — skip conservatively. If it's a value-bearing
      // form we don't know, walk one token to avoid mis-classifying its
      // value as the subcommand. The cost is rare false-negatives on
      // exotic invocations; the security-relevant top-level flags are
      // the ones above.
      i += 1;
      continue;
    }
    subcmd = v;
    subcmdIdx = i;
    break;
  }
  if (subcmd === null) return;
  // Codex round 4 Finding 7: `git config --file FILE ...` writes to FILE
  // (set/unset/replace). Emit FILE as a write target.
  if (subcmd === 'config') {
    for (let k = subcmdIdx + 1; k < argv.length; k += 1) {
      const tok = argv[k];
      if (tok === undefined) continue;
      const v = tok.value;
      if (v === '--file' || v === '-f') {
        const next = argv[k + 1];
        if (next !== undefined) {
          out.push({
            path: next.value,
            form: 'redirect',
            position: next.position,
            dynamic: next.dynamic,
          });
        }
        return;
      }
      if (v.startsWith('--file=')) {
        out.push({
          path: v.slice('--file='.length),
          form: 'redirect',
          position: tok.position,
          dynamic: tok.dynamic,
        });
        return;
      }
    }
    return;
  }
  // Codex round 11 F11-2: `git rm` and `git mv` are destructive
  // disk-mutating subcommands. `git rm FILE` removes FILE from the
  // index AND the working tree (deletes from disk) UNLESS `--cached`
  // is present. `git mv SRC... DEST` moves files (the source is
  // unlinked from its old location).
  if (subcmd === 'rm') {
    // Walk argv after subcmdIdx; collect non-flag positionals AFTER
    // the `--` separator if any. Flags consumed: --cached (suppresses
    // disk delete), --force/-f, --quiet/-q, --dry-run/-n, --pathspec-
    // file-from FILE / --pathspec-from-file FILE (value-bearing),
    // --pathspec-file-nul (bare).
    let cached = false;
    let dashDash = -1;
    for (let k = subcmdIdx + 1; k < argv.length; k += 1) {
      const tok = argv[k];
      if (tok === undefined) continue;
      if (tok.value === '--') {
        dashDash = k;
        break;
      }
      if (tok.value === '--cached') cached = true;
    }
    if (cached) return;
    // Skip subcommand flags before the first positional.
    const VALUE_BEARING_RM_FLAGS = new Set(['--pathspec-file-from', '--pathspec-from-file']);
    let k = subcmdIdx + 1;
    if (dashDash >= 0) k = dashDash + 1;
    else {
      // No `--` separator — walk past flags greedily until first
      // non-flag positional.
      while (k < argv.length) {
        const tok = argv[k];
        if (tok === undefined) {
          k += 1;
          continue;
        }
        const v = tok.value;
        if (VALUE_BEARING_RM_FLAGS.has(v)) {
          k += 2;
          continue;
        }
        if (v.startsWith('--') && v.includes('=')) {
          k += 1;
          continue;
        }
        if (v.startsWith('-')) {
          k += 1;
          continue;
        }
        break;
      }
    }
    for (; k < argv.length; k += 1) {
      const tok = argv[k];
      if (tok === undefined) continue;
      // After `--` everything is a path; before `--` we already skipped
      // flags above.
      out.push({
        path: tok.value,
        form: 'git_rm_dest',
        position: tok.position,
        dynamic: tok.dynamic,
        isDestructive: true,
        originSrc: 'git rm (working-tree delete)',
      });
    }
    return;
  }
  if (subcmd === 'mv') {
    // `git mv SRC... DEST` — sources lose their old location; emit
    // sources as destructive writes. DEST is a write target too (the
    // moved content lands there) but the security concern is the
    // SOURCE removal.
    let dashDash = -1;
    for (let k = subcmdIdx + 1; k < argv.length; k += 1) {
      const tok = argv[k];
      if (tok === undefined) continue;
      if (tok.value === '--') {
        dashDash = k;
        break;
      }
    }
    let k = subcmdIdx + 1;
    if (dashDash >= 0) k = dashDash + 1;
    else {
      // Skip flags before positionals: -f/--force, -k, -n/--dry-run, -v.
      while (k < argv.length) {
        const tok = argv[k];
        if (tok === undefined) {
          k += 1;
          continue;
        }
        const v = tok.value;
        if (v.startsWith('-')) {
          k += 1;
          continue;
        }
        break;
      }
    }
    const positionals: WordValue[] = [];
    for (; k < argv.length; k += 1) {
      const tok = argv[k];
      if (tok === undefined) continue;
      positionals.push(tok);
    }
    if (positionals.length < 2) {
      // Malformed — emit any positional as destructive on uncertainty.
      for (const p of positionals) {
        out.push({
          path: p.value,
          form: 'git_mv_src',
          position: p.position,
          dynamic: p.dynamic,
          isDestructive: true,
          originSrc: 'git mv (source removal)',
        });
      }
      return;
    }
    // Last positional is DEST; prior are SOURCES.
    for (let s = 0; s < positionals.length - 1; s += 1) {
      const src = positionals[s];
      if (src === undefined) continue;
      out.push({
        path: src.value,
        form: 'git_mv_src',
        position: src.position,
        dynamic: src.dynamic,
        isDestructive: true,
        originSrc: 'git mv (source removed from working tree)',
      });
    }
    // DEST also receives the content — emit it as a write target.
    const dest = positionals[positionals.length - 1];
    if (dest !== undefined) {
      out.push({
        path: dest.value,
        form: 'redirect',
        position: dest.position,
        dynamic: dest.dynamic,
        originSrc: 'git mv destination',
      });
    }
    return;
  }
  // Codex round 11 F11-3: history-rewrite re-parse seams. Each of
  // these subcommands accepts a payload arg that git itself feeds
  // through /bin/sh -c at runtime (or equivalent shell). The payload
  // is a re-parse seam — we recurse via parseBashCommand.
  if (subcmd === 'filter-branch') {
    // Filters: --tree-filter, --index-filter, --msg-filter,
    // --env-filter, --commit-filter, --parent-filter,
    // --tag-name-filter. Each accepts the next argv as PAYLOAD, OR
    // the joined `=PAYLOAD` form.
    const FILTER_FLAGS = new Set([
      '--tree-filter',
      '--index-filter',
      '--msg-filter',
      '--env-filter',
      '--commit-filter',
      '--parent-filter',
      '--tag-name-filter',
    ]);
    for (let k = subcmdIdx + 1; k < argv.length; k += 1) {
      const tok = argv[k];
      if (tok === undefined) continue;
      const v = tok.value;
      if (FILTER_FLAGS.has(v)) {
        const payload = argv[k + 1];
        if (payload !== undefined) {
          recurseShellPayload(payload, 'git_filter_branch_inner', out);
        }
        k += 1;
        continue;
      }
      // Joined `--FILTER=PAYLOAD` form.
      for (const flag of FILTER_FLAGS) {
        if (v.startsWith(`${flag}=`)) {
          const payloadStr = v.slice(flag.length + 1);
          recurseShellPayload(
            { value: payloadStr, dynamic: tok.dynamic, position: tok.position },
            'git_filter_branch_inner',
            out,
          );
          break;
        }
      }
    }
    return;
  }
  if (subcmd === 'rebase') {
    // `git rebase --exec PAYLOAD ...`, `git rebase -x PAYLOAD ...`,
    // `git rebase --exec=PAYLOAD ...`, and `-i --exec PAYLOAD`.
    for (let k = subcmdIdx + 1; k < argv.length; k += 1) {
      const tok = argv[k];
      if (tok === undefined) continue;
      const v = tok.value;
      if (v === '--exec' || v === '-x') {
        const payload = argv[k + 1];
        if (payload !== undefined) {
          recurseShellPayload(payload, 'git_rebase_exec_inner', out);
        }
        k += 1;
        continue;
      }
      if (v.startsWith('--exec=')) {
        const payloadStr = v.slice('--exec='.length);
        recurseShellPayload(
          { value: payloadStr, dynamic: tok.dynamic, position: tok.position },
          'git_rebase_exec_inner',
          out,
        );
        continue;
      }
    }
    return;
  }
  if (subcmd === 'bisect') {
    // `git bisect run CMD ARGS...` — when the sub-subcommand is
    // `run`, treat the rest of argv as an inner command and dispatch
    // through recurseInnerArgv.
    const subSub = argv[subcmdIdx + 1];
    if (subSub === undefined || subSub.dynamic) return;
    if (subSub.value !== 'run') return;
    const inner = argv.slice(subcmdIdx + 2);
    if (inner.length > 0) {
      recurseInnerArgv(inner, 'git_bisect_run_inner', out);
    }
    return;
  }
  if (subcmd === 'commit') {
    // `git commit --template=PATH` / `git commit --template PATH`
    // creates / reads the commit-message PATH. While `git commit`'s
    // semantics for --template usually point to a TEMPLATE file
    // (read), prior workflows have been observed where the path is
    // also written; treat as a write target out of caution.
    for (let k = subcmdIdx + 1; k < argv.length; k += 1) {
      const tok = argv[k];
      if (tok === undefined) continue;
      const v = tok.value;
      if (v === '--template' || v === '-t' || v === '--cleanup') {
        const next = argv[k + 1];
        if (next !== undefined && v === '--template') {
          out.push({
            path: next.value,
            form: 'git_commit_template',
            position: next.position,
            dynamic: next.dynamic,
            originSrc: 'git commit --template (path materialization)',
          });
        }
        k += 1;
        continue;
      }
      if (v.startsWith('--template=')) {
        out.push({
          path: v.slice('--template='.length),
          form: 'git_commit_template',
          position: tok.position,
          dynamic: tok.dynamic,
          originSrc: 'git commit --template= (path materialization)',
        });
        continue;
      }
    }
    return;
  }
  const TRACKED = new Set(['checkout', 'restore', 'reset']);
  if (!TRACKED.has(subcmd)) return;
  // Find `--` separator.
  let dashDashIdx = -1;
  for (let i = subcmdIdx + 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok.value === '--') {
      dashDashIdx = i;
      break;
    }
  }
  if (dashDashIdx === -1) {
    // No `--` separator. Conservative: do NOT fire (branch/ref vs path
    // ambiguous). False negatives here are acceptable; the explicit-
    // `--` form catches the security-relevant invocations.
    return;
  }
  for (let i = dashDashIdx + 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;
    out.push({
      path: tok.value,
      form: 'redirect',
      position: tok.position,
      dynamic: tok.dynamic,
    });
  }
}

/**
 * Re-parse a shell-payload string and dispatch via recurseInnerArgv.
 *
 * Used by codex round 11 F11-3 git history-rewrite seams
 * (filter-branch --tree-filter, rebase --exec, etc.) where the
 * payload is a string that git later feeds through /bin/sh -c. We
 * parse it via parseBashCommand and walk the resulting AST through
 * the visitor.
 *
 * Failure-mode: if the payload fails to parse (genuine syntax
 * error or interpolated vars), we emit a synthetic dynamic
 * detection so the verdict layer refuses on uncertainty.
 *
 * Depth is bounded by the same recursion cap detectNestedShell
 * uses, applied transitively via recurseInnerArgv → walkCallExpr →
 * visitor → parseBashCommand. Static analysis can't trace the cap
 * across re-parse seams without explicit threading, so we accept
 * the conservative bound: a nested-shell-inside-filter-branch
 * relies on detectNestedShell's own depth tracking.
 */
function recurseShellPayload(
  payload: WordValue,
  form: DetectedForm,
  out: DetectedWrite[],
): void {
  if (payload.dynamic) {
    // Payload contains $-substitution / cmd-substitution we can't
    // resolve. Emit synthetic dynamic detection at the payload
    // position.
    out.push({
      path: '',
      form,
      position: payload.position,
      dynamic: true,
      isDestructive: true,
      originSrc: 'git history-rewrite payload contains unresolved expansion',
    });
    return;
  }
  const parsed = parseBashCommand(payload.value);
  if (!parsed.ok) {
    // Parse failed — emit synthetic dynamic so the verdict layer
    // refuses on uncertainty.
    out.push({
      path: '',
      form,
      position: payload.position,
      dynamic: true,
      isDestructive: true,
      originSrc: `git history-rewrite payload failed to parse`,
    });
    return;
  }
  // Walk the parsed payload through the SAME walker used at top
  // level. walkForWrites runs the full visitor; any per-utility
  // detector (rm, cp, sed, redirects, nested shells, etc.) fires on
  // the inner payload as if it were a top-level command.
  const innerWrites = walkForWrites(parsed.file);
  for (const d of innerWrites) {
    // Tag the form with the seam name so operator-facing messages
    // identify the bypass path. The original detected_form is
    // preserved in `originSrc` for debugging.
    out.push({
      ...d,
      originSrc: `${form}: ${d.originSrc ?? d.form}`,
    });
  }
}

/**
 * Strip env-var-prefix-style modifiers and command wrappers. mvdan-sh
 * already extracts `FOO=bar` assignments into CallExpr.Assigns (we
 * don't see them in argv at all), but `env FOO=bar cmd`, `nohup cmd`,
 * `time cmd`, `sudo cmd`, `command cmd`, `\cmd`, `exec cmd` all show
 * up in argv. Walk past them so the detector dispatches on the real
 * head.
 *
 * Strict semantics: we strip ONLY one wrapper at a time and only if
 * the next token is not a flag. `sudo -u jake cp src dst` becomes
 * `cp src dst` after dropping `sudo -u jake`. We bail on unknown
 * flag-bearing wrappers to avoid mis-classifying the inner command.
 *
 * # Wrapper allow-list (codex round 9 F1)
 *
 * The wrappers below are allow-listed explicitly because they are
 * transparent process-launchers — they fork/exec the next argv as the
 * "real" command. If we did NOT strip them, the head-dispatch in
 * `walkCallExpr` would see the WRAPPER name (e.g. `nice`, `timeout`)
 * and miss the inner command. Each wrapper's argv consumption is
 * documented in TSDoc here so future contributors don't have to read
 * man pages to understand why a particular form is safe to strip.
 *
 * ## No-arg wrappers (consume head only)
 *
 *   - `nohup`, `time`, `command`, `exec`, `builtin` — original set
 *   - `nice` (when no `-n NUM`) — adjusts niceness; without `-n`
 *     defaults to +10. `nice -n 5 CMD` form handled below.
 *   - `unbuffer` — expect-script wrapper, `unbuffer CMD ARGS...`
 *   - `setsid` — runs CMD in new session; `setsid [-w] CMD`
 *   - `pkexec` — polkit; `pkexec [--user USER] CMD`
 *   - `firejail`, `bwrap`, `proot` — sandbox wrappers; the next argv
 *     IS the command they sandbox. Conservative refusal: when these
 *     carry their own flags we still strip-then-walk-past flags;
 *     they don't change the destination semantics of the inner write.
 *
 * ## One-arg wrappers (consume head + 1)
 *
 *   - `timeout DURATION CMD` — `timeout 5 bash -c …`
 *   - `chrt PRIORITY CMD` — `chrt 1 bash -c …`
 *   - `taskset MASK CMD` — `taskset 1 bash -c …` (CPU affinity)
 *   - `sg GROUP CMD` — `sg root -c "…"` form caught via su/newgrp
 *     handling below; bare `sg GROUP CMD` consumes group + CMD
 *   - `newgrp GROUP` — bare form starts a NEW shell as that group;
 *     `newgrp users CMD` is non-POSIX but seen on Linux. We treat
 *     it as a one-arg wrapper for safety
 *   - `cgexec CGROUP CMD`
 *   - `runuser USER CMD` — when no `-l/-c` flag
 *
 * ## Flag-prefixed wrappers
 *
 *   - `ionice` — `ionice [-c CLASS] [-n NUM] [-p PID] CMD`. Class/priority
 *     are value-bearing flags.
 *   - `stdbuf` — `stdbuf [-i MODE] [-o MODE] [-e MODE] CMD`. -i, -o, -e
 *     are value-bearing OR can be joined: `stdbuf -i0 CMD`.
 *   - `setpriv` — many flag forms (`--reuid`, `--regid`, `--clear-groups`,
 *     `--inh-caps`, `--ambient-caps`, etc.); we accept any flag and walk
 *     past, eating one extra token for value-bearing forms.
 *
 * ## Subcommand wrappers
 *
 *   - `systemd-run` — `systemd-run [--scope] [--user] [-p PROP=VAL] CMD`.
 *     Many flag forms; we strip flags greedily and resume on first
 *     non-flag positional.
 *   - `flatpak run APPID CMD` — flatpak run wraps an app then forwards
 *     remaining argv. We strip `flatpak run [flags] APPID` and the
 *     remainder is the inner command.
 *
 * ## Re-parse seams (refuse on uncertainty)
 *
 *   - `su [USER] [-c PAYLOAD]` — `su user -c "rm .rea/HALT"` re-parses
 *     PAYLOAD via /bin/sh. We synthesize a `sh` head so the nested-shell
 *     detector catches PAYLOAD.
 *   - `runuser [USER] -c PAYLOAD` — same pattern as su.
 *   - `pkexec --user USER CMD` — value-bearing flag handled.
 *   - `env -S "FRAGMENT"` — `-S` re-parses FRAGMENT as a shell argument
 *     list. This is a true re-parse seam; we refuse on uncertainty by
 *     bailing out (caller's dispatcher won't match the synthesized head).
 *
 * ## Negative cases (continue to ALLOW)
 *
 *   - `nice ls`, `timeout 5 echo hello` — ls/echo dispatch as their
 *     own utilities (or fall through to `default:` case which is no-op).
 *   - `env -i CMD` and `env VAR=value CMD` — already handled.
 *
 * The wrapper IS NOT the policy trigger. After we strip, the
 * `walkCallExpr` dispatcher decides whether the inner command is a
 * write to a protected path. So allow-listing a wrapper just enables
 * detection; it never synthesizes an attack the inner command did
 * not already represent.
 */
function stripEnvAndModifiers(argv: WordValue[]): WordValue[] {
  let i = 0;
  while (i < argv.length) {
    const head = argv[i];
    if (head === undefined) break;
    // Codex round 2 R2-14: normalize the wrapper name via basename so
    // `/usr/bin/env`, `/usr/bin/sudo`, `/bin/nohup`, `./env`, etc. strip
    // the same way as the bare names. Pre-fix `/usr/bin/env bash -c
    // 'printf x > .rea/HALT'` left `env` un-stripped (the literal head
    // was `/usr/bin/env`, not `env`), so the dispatcher saw `env` as the
    // head and the bash-payload was never re-parsed.
    const name = normalizeCmdHead(head.value);
    if (name === 'env') {
      // env [-i] [-u VAR] [-S FRAGMENT] [--] [VAR=val ...] CMD
      i += 1;
      let envBail = false;
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        if (next.dynamic) {
          // Dynamic env-var — bail out; we can't tell where the cmd
          // starts. Leave the slice intact for the caller.
          return argv.slice(i);
        }
        const v = next.value;
        if (v === '-i' || v === '--ignore-environment') {
          i += 1;
          continue;
        }
        if (v === '-u' || v === '--unset') {
          i += 2;
          continue;
        }
        // Codex round 11 F11-6: `env --chdir=DIR CMD` / `env -C DIR
        // CMD` (GNU coreutils 8.28+) changes working directory before
        // exec'ing CMD. The DIR is value-bearing; consume it and
        // continue scanning for the CMD head. We do NOT emit DIR as
        // a write target — chdir doesn't write. The strip just
        // walks past it.
        if (v === '-C' || v === '--chdir') {
          i += 2;
          continue;
        }
        if (v.startsWith('--chdir=')) {
          i += 1;
          continue;
        }
        // Codex round 9 F1: POSIX `--` separator ends env's option
        // processing; the next token is the command head. Pre-fix
        // `env -- bash -c "rm .rea/HALT"` left `--` in argv so the
        // dispatcher saw `--` as the head and missed the inner shell.
        if (v === '--') {
          i += 1;
          break;
        }
        // Codex round 9 F1: `-S FRAGMENT` and `--split-string=FRAGMENT`
        // re-parse FRAGMENT as a shell argument list (env(1) extension,
        // GNU coreutils 8.30+). FRAGMENT may itself contain `bash -c
        // PAYLOAD`. Static analysis of a re-parsed string is out of
        // scope (it's a re-parse seam). Refuse on uncertainty by
        // emitting a synthetic dynamic write — but stripEnvAndModifiers
        // only returns the slice; we signal refusal by returning a
        // single-element slice with a dynamic head whose value collides
        // with no dispatcher case. The cleanest path is to bail the
        // outer wrapper-strip loop and let the dispatcher fall through
        // to `default:` (no-op). That's a regression vs. the F1 PoC.
        // Better: treat -S as a re-parse seam and synthesize a `sh -c
        // FRAGMENT` argv so the nested-shell detector picks it up.
        if (v === '-S' || v === '--split-string') {
          const payload = argv[i + 1];
          if (payload === undefined) {
            envBail = true;
            break;
          }
          // Synthesize: `sh -c "<FRAGMENT>"` and dispatch through
          // detectNestedShell. We rewrite argv in place from index i
          // onward so the outer dispatcher sees `sh` as head.
          const pos = head.position;
          const synthSh: WordValue = { value: 'sh', dynamic: false, position: pos };
          const synthDashC: WordValue = { value: '-c', dynamic: false, position: pos };
          const newSlice = [synthSh, synthDashC, payload, ...argv.slice(i + 2)];
          return newSlice;
        }
        // Codex round 9 F1: joined form `-S<FRAGMENT>` (no separator).
        // Some shells/quoting collapse the literal flag and value into
        // a single argv token: `env -S"bash -c rm .rea/HALT"` becomes
        // `env`, `-Sbash -c rm .rea/HALT`. Detect by leading `-S`
        // longer than 2 chars.
        if (v.startsWith('-S') && v.length > 2) {
          const inline = v.slice(2);
          const pos = head.position;
          const synthSh: WordValue = { value: 'sh', dynamic: false, position: pos };
          const synthDashC: WordValue = { value: '-c', dynamic: false, position: pos };
          const synthPayload: WordValue = {
            value: inline,
            dynamic: next.dynamic,
            position: next.position,
          };
          return [synthSh, synthDashC, synthPayload, ...argv.slice(i + 1)];
        }
        if (v.startsWith('--split-string=')) {
          const inline = v.slice('--split-string='.length);
          const pos = head.position;
          const synthSh: WordValue = { value: 'sh', dynamic: false, position: pos };
          const synthDashC: WordValue = { value: '-c', dynamic: false, position: pos };
          const synthPayload: WordValue = {
            value: inline,
            dynamic: next.dynamic,
            position: next.position,
          };
          const newSlice = [synthSh, synthDashC, synthPayload, ...argv.slice(i + 1)];
          return newSlice;
        }
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) {
          i += 1;
          continue;
        }
        break;
      }
      if (envBail) return argv.slice(i);
      continue;
    }
    if (
      name === 'nohup' ||
      name === 'time' ||
      name === 'command' ||
      name === 'exec' ||
      name === 'builtin' ||
      // Codex round 11 F11-6: `fakeroot CMD` runs CMD with simulated
      // root credentials; transparent process-launcher with no flags.
      name === 'fakeroot'
    ) {
      i += 1;
      continue;
    }
    // Codex round 11 F11-6: `gtimeout` is the GNU coreutils alias
    // for `timeout` on macOS (Homebrew installs it as `gtimeout`).
    // It accepts the same DURATION + flag forms as `timeout` (handled
    // below in the one-arg-wrappers branch).
    // Codex round 11 F11-6: `flock` — `flock [-w SECS] [-u|-x|-s|-n]
    // LOCKFILE CMD ARGS...` and `flock LOCKFILE CMD ARGS...`. The
    // LOCKFILE is consumed before CMD. Greedy strip flags + LOCKFILE.
    if (name === 'flock') {
      i += 1;
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        if (next.dynamic) return argv.slice(i);
        const v = next.value;
        if (v === '--') {
          i += 1;
          break;
        }
        if (v === '-w' || v === '--timeout' || v === '-E' || v === '--conflict-exit-code') {
          i += 2;
          continue;
        }
        if (v.startsWith('--timeout=') || v.startsWith('--conflict-exit-code=')) {
          i += 1;
          continue;
        }
        if (
          v === '-u' ||
          v === '--unlock' ||
          v === '-x' ||
          v === '--exclusive' ||
          v === '-s' ||
          v === '--shared' ||
          v === '-n' ||
          v === '--nonblock' ||
          v === '-o' ||
          v === '--close' ||
          v === '-v' ||
          v === '--verbose' ||
          v === '-h' ||
          v === '--help' ||
          v === '-V' ||
          v === '--version'
        ) {
          i += 1;
          continue;
        }
        if (v.startsWith('-')) {
          i += 1;
          continue;
        }
        // First non-flag positional — the LOCKFILE. Consume it.
        i += 1;
        break;
      }
      continue;
    }
    // Codex round 11 F11-6: `unshare` — namespace wrapper. Many
    // bare flags (-r/-m/-p/-u/-i/-n/-U/-T/-C/-c) and value-bearing
    // forms (--map-user, --map-group, --setuid, --setgid, --propagation,
    // --setgroups, --keep-caps, --kill-child, --boottime, etc.).
    // Greedy strip until first non-flag positional — that's the CMD.
    if (name === 'unshare') {
      i += 1;
      const VALUE_BEARING_LONG = new Set([
        '--map-user',
        '--map-group',
        '--setuid',
        '--setgid',
        '--propagation',
        '--setgroups',
        '--mount-proc',
        '--root',
        '--wd',
        '--load-interp',
      ]);
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        if (next.dynamic) return argv.slice(i);
        const v = next.value;
        if (v === '--') {
          i += 1;
          break;
        }
        if (VALUE_BEARING_LONG.has(v)) {
          i += 2;
          continue;
        }
        if (v.startsWith('--') && v.includes('=')) {
          i += 1;
          continue;
        }
        if (v.startsWith('-')) {
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }
    if (name === 'sudo' || name === 'doas') {
      // sudo [-u USER] [-E] [-H] [-i] [-s] [--] CMD
      // Codex round 11 F11-6: `sudo -s -- "PAYLOAD"` invokes sudo's
      // shell mode; PAYLOAD is the literal argv after `--`. When `-s`
      // (or `-i`) is present AND the argv after `--` is a SINGLE
      // string positional, we synthesize `sh -c PAYLOAD` so the
      // nested-shell detector picks up the inner write.
      let sawShellMode = false;
      i += 1;
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        if (next.dynamic) return argv.slice(i);
        const v = next.value;
        if (v === '--') {
          i += 1;
          break;
        }
        if (v === '-s' || v === '-i') {
          sawShellMode = true;
          i += 1;
          continue;
        }
        if (v === '-u' || v === '-g' || v === '-p' || v === '-U') {
          i += 2;
          continue;
        }
        if (v.startsWith('-')) {
          // Cluster like `-su` / `-sH` / `-Es`. Detect shell-mode in
          // a cluster.
          if (v.length > 1 && (v.includes('s') || v.includes('i'))) {
            sawShellMode = true;
          }
          i += 1;
          continue;
        }
        break;
      }
      if (sawShellMode) {
        // After flag/`--` consumption, the remainder is the PAYLOAD.
        // If exactly one positional argv remains, treat it as the
        // shell command body. Otherwise (multiple args), join them
        // with spaces — sudo -s passes them to the shell as `sh -c
        // "$*"` semantically.
        const remainder = argv.slice(i);
        if (remainder.length === 1 && remainder[0] !== undefined) {
          const pos = head.position;
          const synthSh: WordValue = { value: 'sh', dynamic: false, position: pos };
          const synthDashC: WordValue = { value: '-c', dynamic: false, position: pos };
          return [synthSh, synthDashC, remainder[0]];
        }
        if (remainder.length > 1) {
          // Multiple post-flag positionals — sudo -s joins them.
          const joined = remainder.map((t) => t.value).join(' ');
          const isDyn = remainder.some((t) => t.dynamic);
          const pos = head.position;
          const synthSh: WordValue = { value: 'sh', dynamic: false, position: pos };
          const synthDashC: WordValue = { value: '-c', dynamic: false, position: pos };
          const synthPayload: WordValue = {
            value: joined,
            dynamic: isDyn,
            position: remainder[0]?.position ?? pos,
          };
          return [synthSh, synthDashC, synthPayload];
        }
      }
      continue;
    }
    // Codex round 9 F1: process-launching wrappers. See class TSDoc
    // above for the full table. Each branch consumes its specific
    // arity and continues the outer loop so multiple wrappers can
    // chain (e.g. `nice timeout 5 sudo bash -c PAYLOAD`).

    // No-arg wrappers (consume head only, then strip any leading flags).
    if (
      name === 'unbuffer' ||
      name === 'setsid' ||
      name === 'pkexec' ||
      name === 'firejail' ||
      name === 'bwrap' ||
      name === 'proot' ||
      name === 'numactl'
    ) {
      i += 1;
      // pkexec --user USER form: consume the value-bearing flag.
      if (name === 'pkexec') {
        while (i < argv.length) {
          const next = argv[i];
          if (next === undefined) break;
          if (next.dynamic) return argv.slice(i);
          const v = next.value;
          if (v === '--user' || v === '--disable-internal-agent') {
            // --user takes USER; --disable-internal-agent is bare.
            if (v === '--user') {
              i += 2;
            } else {
              i += 1;
            }
            continue;
          }
          if (v.startsWith('-')) {
            i += 1;
            continue;
          }
          break;
        }
      } else if (name === 'setsid') {
        // setsid [-c|--ctty] [-f|--fork] [-w|--wait] CMD — all bare flags.
        while (i < argv.length) {
          const next = argv[i];
          if (next === undefined) break;
          if (next.dynamic) return argv.slice(i);
          const v = next.value;
          if (v === '--') {
            i += 1;
            break;
          }
          if (v.startsWith('-')) {
            i += 1;
            continue;
          }
          break;
        }
      } else if (name === 'unbuffer' || name === 'firejail' || name === 'numactl') {
        // unbuffer: bare. firejail: many flags but none take a positional
        // CMD as their value. numactl: -N/-m/-C/-l value-bearing.
        // Conservative: strip any leading flag tokens; for numactl
        // accept value-bearing forms.
        while (i < argv.length) {
          const next = argv[i];
          if (next === undefined) break;
          if (next.dynamic) return argv.slice(i);
          const v = next.value;
          if (v === '--') {
            i += 1;
            break;
          }
          if (name === 'numactl' && (v === '-N' || v === '-m' || v === '-C' || v === '-p')) {
            i += 2;
            continue;
          }
          if (v.startsWith('-')) {
            i += 1;
            continue;
          }
          break;
        }
      } else if (name === 'bwrap' || name === 'proot') {
        // bwrap and proot have many `--bind SRC DEST`, `--ro-bind SRC DEST`
        // forms that consume TWO values per flag. We can't enumerate
        // exhaustively without overfitting; refuse on uncertainty by
        // bailing to default dispatch when a flag appears. The
        // protected-scan structural defenses catch the literal write
        // at the file-write layer regardless.
        // (No-op flag stripping — rely on caller's structural defense.)
      }
      continue;
    }

    // `nice`. Two forms:
    //   1. `nice CMD ARGS...`  (default niceness +10) — strip head only
    //   2. `nice -n NUM CMD`  — `-n NUM` is value-bearing flag
    if (name === 'nice') {
      i += 1;
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        if (next.dynamic) return argv.slice(i);
        const v = next.value;
        if (v === '-n' || v === '--adjustment') {
          i += 2;
          continue;
        }
        if (v.startsWith('--adjustment=')) {
          i += 1;
          continue;
        }
        // GNU `-NUM` shorthand (e.g. `nice -5 CMD`) — single token.
        if (/^-\d+$/.test(v)) {
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }

    // `ionice`. `ionice [-c CLASS] [-n NUM] [-p PID] [-t] CMD`.
    // -c, -n, -p are value-bearing; -t is bare. Long forms `--class`,
    // `--classdata`, `--pid`, `--ignore` follow same shape.
    if (name === 'ionice') {
      i += 1;
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        if (next.dynamic) return argv.slice(i);
        const v = next.value;
        if (v === '-c' || v === '-n' || v === '-p' || v === '-P' || v === '-u') {
          i += 2;
          continue;
        }
        if (v === '--class' || v === '--classdata' || v === '--pid' || v === '--uid') {
          i += 2;
          continue;
        }
        if (
          v.startsWith('--class=') ||
          v.startsWith('--classdata=') ||
          v.startsWith('--pid=') ||
          v.startsWith('--uid=')
        ) {
          i += 1;
          continue;
        }
        if (v === '-t' || v === '--ignore') {
          i += 1;
          continue;
        }
        if (v.startsWith('-')) {
          // Unknown flag — skip conservatively.
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }

    // `stdbuf -i MODE -o MODE -e MODE CMD`. Joined forms `-i0` `-oL`
    // `-e0` are also accepted (GNU coreutils accepts both).
    if (name === 'stdbuf') {
      i += 1;
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        if (next.dynamic) return argv.slice(i);
        const v = next.value;
        // Joined forms: `-i0`, `-iL`, `-oL`, `-e1024`.
        if (/^-[ioe].+$/.test(v)) {
          i += 1;
          continue;
        }
        // Long forms: `--input=MODE`, `--output=MODE`, `--error=MODE`.
        if (v.startsWith('--input=') || v.startsWith('--output=') || v.startsWith('--error=')) {
          i += 1;
          continue;
        }
        if (v === '--input' || v === '--output' || v === '--error') {
          i += 2;
          continue;
        }
        // Bare short forms: `-i MODE` `-o MODE` `-e MODE`.
        if (v === '-i' || v === '-o' || v === '-e') {
          i += 2;
          continue;
        }
        break;
      }
      continue;
    }

    // `setpriv` — many flag forms; greedy strip until first non-flag.
    // Flags are an explicit bare set vs value-bearing set. Any unknown
    // `--foo` form is treated as bare to avoid eating the inner CMD.
    if (name === 'setpriv') {
      i += 1;
      // Bare flags (consume one token).
      const setprivBare = new Set([
        '--clear-groups',
        '--no-new-privs',
        '--inh-caps',
        '--keep-groups',
        '--init-groups',
        '--keep-pdeathsig',
        '--reset-env',
        '--quiet',
        '--help',
        '--version',
      ]);
      // Value-bearing flags (consume two tokens unless `=value` form).
      const setprivValue = new Set([
        '--reuid',
        '--regid',
        '--groups',
        '--securebits',
        '--bounding-set',
        '--ambient-caps',
        '--inherit-caps',
        '--selinux-label',
        '--apparmor-profile',
        '--landlock-access',
        '--landlock-rule',
        '--pdeathsig',
        '--rlimit',
      ]);
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        if (next.dynamic) return argv.slice(i);
        const v = next.value;
        // Long flag with `=value` — self-contained.
        if (v.startsWith('--') && v.includes('=')) {
          i += 1;
          continue;
        }
        if (setprivBare.has(v)) {
          i += 1;
          continue;
        }
        if (setprivValue.has(v)) {
          i += 2;
          continue;
        }
        if (v.startsWith('--')) {
          // Unknown long flag — treat as bare. Conservative: an
          // unknown setpriv flag is more likely to be a feature flag
          // than a value-bearing one (most --reuid/--regid-style
          // flags are listed above). Eating the next token risks
          // consuming the inner CMD's head, which is the F1 bypass.
          i += 1;
          continue;
        }
        if (v.startsWith('-')) {
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }

    // One-arg wrappers (consume head + 1 positional, then resume).
    if (
      name === 'timeout' ||
      // Codex round 11 F11-6: GNU coreutils alias on macOS Homebrew.
      name === 'gtimeout' ||
      name === 'chrt' ||
      name === 'taskset' ||
      name === 'sg' ||
      name === 'newgrp' ||
      name === 'cgexec'
    ) {
      // `timeout` and `chrt` may have flags before the duration/priority:
      //   timeout [--preserve-status] [--foreground] [-k DUR] DURATION CMD
      //   chrt [-r] [-f] [-o] [-i] [-b] [-p] PRIO CMD  (or `chrt -p PRIO PID`)
      // Greedy strip flags until first non-flag positional, consume
      // ONE positional (the duration/priority/group/mask), then continue.
      i += 1;
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        if (next.dynamic) return argv.slice(i);
        const v = next.value;
        if (v === '--') {
          i += 1;
          break;
        }
        if (v.startsWith('-')) {
          // Value-bearing common flags.
          if (
            v === '-k' ||
            v === '--kill-after' ||
            v === '-s' ||
            v === '--signal' ||
            v === '-p' ||
            v === '--pid'
          ) {
            i += 2;
            continue;
          }
          if (v.startsWith('--kill-after=') || v.startsWith('--signal=')) {
            i += 1;
            continue;
          }
          // Bare flag.
          i += 1;
          continue;
        }
        // First non-flag positional — this is the duration/priority/
        // group/mask. Consume it and stop.
        i += 1;
        break;
      }
      continue;
    }

    // `runuser` — when no `-c PAYLOAD` flag, behaves like `su USER CMD`.
    // When `-c PAYLOAD` is present, it's a re-parse seam → synthesize sh.
    if (name === 'runuser' || name === 'su') {
      i += 1;
      // Greedy strip flags + USER positional. If we see `-c` or `-l`,
      // handle specially (re-parse seam).
      let cFound = false;
      let cPayloadIdx = -1;
      const localStart = i;
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        if (next.dynamic) return argv.slice(i);
        const v = next.value;
        if (v === '--') {
          i += 1;
          break;
        }
        if (v === '-c' || v === '--command') {
          cFound = true;
          cPayloadIdx = i + 1;
          break;
        }
        if (v.startsWith('--command=')) {
          // Synthesize sh -c PAYLOAD.
          const inline = v.slice('--command='.length);
          const pos = head.position;
          const synthSh: WordValue = { value: 'sh', dynamic: false, position: pos };
          const synthDashC: WordValue = { value: '-c', dynamic: false, position: pos };
          const synthPayload: WordValue = {
            value: inline,
            dynamic: next.dynamic,
            position: next.position,
          };
          return [synthSh, synthDashC, synthPayload, ...argv.slice(i + 1)];
        }
        if (v.startsWith('-')) {
          // -s SHELL, -g GROUP, -G GROUP, --user USER are value-bearing.
          if (
            v === '-s' ||
            v === '--shell' ||
            v === '-g' ||
            v === '--group' ||
            v === '-G' ||
            v === '--supp-group' ||
            v === '--user' ||
            v === '-w' ||
            v === '--whitelist-environment'
          ) {
            i += 2;
            continue;
          }
          if (
            v.startsWith('--shell=') ||
            v.startsWith('--group=') ||
            v.startsWith('--supp-group=') ||
            v.startsWith('--user=') ||
            v.startsWith('--whitelist-environment=')
          ) {
            i += 1;
            continue;
          }
          // Bare flag (-l, -m, -p, -P, --login, --preserve-environment).
          i += 1;
          continue;
        }
        // First non-flag positional — the USER. Consume it.
        i += 1;
        // After USER, may have -c PAYLOAD or just positional CMD.
        // Continue the loop to see what's next.
      }
      if (cFound && cPayloadIdx >= 0) {
        const payload = argv[cPayloadIdx];
        if (payload === undefined) {
          // `su user -c` with no payload — bail out.
          return argv.slice(localStart);
        }
        // Synthesize sh -c PAYLOAD so detectNestedShell handles it.
        const pos = head.position;
        const synthSh: WordValue = { value: 'sh', dynamic: false, position: pos };
        const synthDashC: WordValue = { value: '-c', dynamic: false, position: pos };
        return [synthSh, synthDashC, payload, ...argv.slice(cPayloadIdx + 1)];
      }
      continue;
    }

    // `systemd-run` — wraps a CMD in a transient unit. Many flags;
    // strip greedily until first non-flag positional.
    //   systemd-run [--scope] [--user] [-p PROP=VAL] [-u UNIT] [-d|--description] CMD
    if (name === 'systemd-run') {
      i += 1;
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        if (next.dynamic) return argv.slice(i);
        const v = next.value;
        if (v === '--') {
          i += 1;
          break;
        }
        if (v.startsWith('--') && v.includes('=')) {
          i += 1;
          continue;
        }
        if (v.startsWith('--')) {
          // Conservative: many systemd-run long flags take values.
          // Peek next token; if it doesn't start with '-' and looks
          // like a value, eat it.
          const peek = argv[i + 1];
          if (peek !== undefined && !peek.value.startsWith('-')) {
            // Heuristic: --scope, --user, --system, --pty, --pipe,
            // --remain-after-exit, --no-block, --shell, --collect,
            // --quiet, --send-sighup, --wait take NO value; everything
            // else (--unit, --description, --slice, --on-active,
            // --on-boot, --on-startup, --on-unit-active, --on-calendar,
            // --on-timezone-change, --working-directory, --uid, --gid,
            // --nice, --setenv, --property, --service-type,
            // --background) takes one.
            const bareFlags = new Set([
              '--scope',
              '--user',
              '--system',
              '--pty',
              '--pipe',
              '--remain-after-exit',
              '--no-block',
              '--shell',
              '--collect',
              '--quiet',
              '--send-sighup',
              '--wait',
              '--no-ask-password',
              '--no-pager',
              '--help',
              '--version',
            ]);
            if (bareFlags.has(v)) {
              i += 1;
            } else {
              i += 2;
            }
          } else {
            i += 1;
          }
          continue;
        }
        if (v === '-p' || v === '-u' || v === '-d') {
          i += 2;
          continue;
        }
        if (v.startsWith('-')) {
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }

    // `flatpak run [--flags] APPID CMD` — strip head + flags + APPID.
    if (name === 'flatpak') {
      // Need next token to be `run`. Other flatpak subcommands (e.g.
      // `flatpak install`, `flatpak update`) are not wrappers and
      // we should NOT strip them.
      const sub = argv[i + 1];
      if (sub === undefined || sub.dynamic || sub.value !== 'run') {
        // Not a wrapper invocation — leave alone for the dispatcher.
        break;
      }
      i += 2;
      // Strip flags + APPID. If the first non-flag positional is NOT a
      // well-formed reverse-DNS APPID and IS a known utility/shell head,
      // we conservatively treat the rest as the inner command and skip
      // APPID consumption — this catches the codex round 9 PoC
      // `flatpak run bash -c "rm .rea/HALT"` (no APPID, attacker
      // expects flatpak to behave as a transparent wrapper).
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        if (next.dynamic) return argv.slice(i);
        const v = next.value;
        if (v === '--') {
          i += 1;
          break;
        }
        if (v.startsWith('-')) {
          if (v.includes('=')) {
            i += 1;
            continue;
          }
          // Common flatpak run flags that take values: --branch,
          // --arch, --command, --runtime, --runtime-version, --filesystem,
          // --device, --share, --unshare, --talk-name, --own-name,
          // --no-talk-name, --system-talk-name, --persist, --env, --bind,
          // --user-bind, --readonly-bind, --tmpfs.
          const peek = argv[i + 1];
          if (peek !== undefined && !peek.value.startsWith('-')) {
            i += 2;
          } else {
            i += 1;
          }
          continue;
        }
        // First non-flag positional. If it looks like a reverse-DNS
        // APPID (org.example.App), consume it as APPID and continue.
        // If it's a known utility name (bash, sh, rm, cp, etc.), the
        // attacker is using flatpak as a transparent prefix without
        // a real APPID — treat THIS token as the head of the inner
        // command and stop wrapper-stripping. This is the round 9 F1
        // PoC behaviour.
        if (looksLikeFlatpakAppId(v)) {
          i += 1;
          continue;
        }
        // Stop here — `v` is the inner command head.
        break;
      }
      continue;
    }

    // Codex round 9 F2: busybox/toybox multiplexer.
    //
    // busybox and toybox are single-binary multiplexers that dispatch
    // to an applet based on argv[1]:
    //   `busybox rm FILE`   → calls the rm applet
    //   `busybox sh -c CMD` → calls the sh applet (sh -c re-parses)
    //   `busybox dd of=FILE` → dd applet with redirect-form destination
    //
    // We strip `busybox` (or `toybox`) + optional `--` + optional
    // applet flags, then continue the wrapper-strip loop so the inner
    // applet name lands in the head-dispatch switch.
    //
    // Defensive: if the next token is itself another multiplexer
    // (`busybox busybox rm FILE` is allowed by busybox), we refuse on
    // uncertainty by leaving the slice intact — the dispatcher's
    // default: case is no-op, but the protected-scan layer's
    // structural defense catches the literal redirect-form write at a
    // higher level. Practically this is a vanishingly rare construct;
    // the conservative bail is fine.
    if (name === 'busybox' || name === 'toybox') {
      const inner = argv[i + 1];
      if (inner === undefined) {
        // Bare `busybox` — nothing to dispatch on.
        i += 1;
        continue;
      }
      if (inner.dynamic) {
        // Dynamic applet name — refuse on uncertainty by emitting a
        // synthetic dynamic head so the dispatcher fails closed.
        // We keep the slice from `inner` onward; the verdict layer
        // sees a dynamic head and refuses.
        return argv.slice(i + 1);
      }
      const innerName = normalizeCmdHead(inner.value);
      // Refuse on nested multiplexer to avoid infinite recursion.
      if (innerName === 'busybox' || innerName === 'toybox') {
        // Treat the second multiplexer as the head, leaving the
        // remaining argv intact. The verdict layer sees `busybox`
        // (no dispatcher case) and the protected-scan structural
        // layer still catches stmt-level redirects.
        i += 1;
        continue;
      }
      // POSIX `--` separator: `busybox -- rm FILE` form.
      if (inner.value === '--') {
        i += 2;
        continue;
      }
      // Strip the multiplexer head; the inner applet now becomes
      // argv[0] for dispatch. The wrapper-strip loop continues so
      // multiple-layer wrappings (`busybox sudo bash -c …`) chain.
      i += 1;
      continue;
    }
    // Codex round 10 — 5 wrapper enumerations (chronic, dbus-launch,
    // watch, script, parallel). These are precise dispatchers; the
    // structural wrapper-shell-exec guard at `walkCallExpr`'s
    // `default:` case is the safety net for ANY unknown wrapper, but
    // explicit handling here lets these wrappers dispatch through
    // the regular bash-case (no refuse-on-uncertainty banner) and
    // gives operators clean errors that name the wrapper.

    // `chronic` (moreutils): no-arg wrapper, runs CMD and only emits
    // its output on failure. `chronic CMD ARGS...` — strip head only.
    if (name === 'chronic') {
      i += 1;
      continue;
    }

    // `dbus-launch`: spawns a session bus and exec's CMD with bus
    // env exported. Flag-prefixed wrapper.
    //   --exit-with-session            (bare)
    //   --exit-with-x11                (bare)
    //   --binary-syntax                (bare)
    //   --close-stderr                 (bare)
    //   --sh-syntax                    (bare; output format)
    //   --csh-syntax                   (bare; output format)
    //   --autolaunch=ID                (joined)
    //   --autolaunch ID                (separate-arg form)
    //   --config-file=PATH             (joined)
    //   --config-file PATH             (separate-arg form)
    if (name === 'dbus-launch') {
      i += 1;
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        if (next.dynamic) return argv.slice(i);
        const v = next.value;
        if (v === '--') {
          i += 1;
          break;
        }
        // Bare flags (consume one token).
        if (
          v === '--exit-with-session' ||
          v === '--exit-with-x11' ||
          v === '--binary-syntax' ||
          v === '--close-stderr' ||
          v === '--sh-syntax' ||
          v === '--csh-syntax' ||
          v === '--version' ||
          v === '--help'
        ) {
          i += 1;
          continue;
        }
        // Long flag with `=value` (joined) — self-contained.
        if (v.startsWith('--autolaunch=') || v.startsWith('--config-file=')) {
          i += 1;
          continue;
        }
        // Long flag with separate value.
        if (v === '--autolaunch' || v === '--config-file') {
          i += 2;
          continue;
        }
        if (v.startsWith('-')) {
          // Unknown flag — skip conservatively (one token).
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }

    // `watch`: runs CMD repeatedly. Flag-prefixed wrapper.
    //   -n SECS / --interval=SECS / --interval SECS  (value-bearing)
    //   -d / --differences[=permanent]               (bare or joined)
    //   -t / --no-title                              (bare)
    //   -b / --beep                                  (bare)
    //   -e / --errexit                               (bare)
    //   -g / --chgexit                               (bare)
    //   -c / --color                                 (bare; NOTE: this
    //     is `watch`'s `-c`, NOT the inner shell's `-c`. We MUST
    //     strip it as a watch-flag, not pass it through.)
    //   -x / --exec                                  (bare; affects
    //     how watch runs CMD — exec vs. shell)
    //   -p / --precise                               (bare)
    //   -w SECS / --no-wrap (note: -w / --no-wrap meaning varies by
    //     watch version; treat -w as bare)
    //   -h / --help / -v / --version                 (bare)
    if (name === 'watch') {
      i += 1;
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        if (next.dynamic) return argv.slice(i);
        const v = next.value;
        if (v === '--') {
          i += 1;
          break;
        }
        // Value-bearing short flags.
        if (v === '-n') {
          i += 2;
          continue;
        }
        // Joined long-form value: `--interval=SECS`.
        if (v.startsWith('--interval=') || v.startsWith('--differences=')) {
          i += 1;
          continue;
        }
        // Separate-arg long-form value.
        if (v === '--interval') {
          i += 2;
          continue;
        }
        // Bare short cluster flags. Be careful — `-c` here is watch's
        // `--color`, NOT a shell `-c PAYLOAD`. Watch always treats
        // `-c` as bare. Only known clusters listed (avoid stripping
        // the inner shell's first arg accidentally).
        if (/^-[ndtbegcxphvw]+$/.test(v)) {
          i += 1;
          continue;
        }
        // Long-form bare flags.
        if (
          v === '--differences' ||
          v === '--no-title' ||
          v === '--beep' ||
          v === '--errexit' ||
          v === '--chgexit' ||
          v === '--color' ||
          v === '--exec' ||
          v === '--precise' ||
          v === '--no-wrap' ||
          v === '--help' ||
          v === '--version'
        ) {
          i += 1;
          continue;
        }
        if (v.startsWith('-')) {
          // Unknown flag — skip conservatively.
          i += 1;
          continue;
        }
        break;
      }
      continue;
    }

    // `script` (util-linux + macOS): records a typescript of a
    // session. Re-parse seam — `script -c PAYLOAD [TYPESCRIPT-FILE]`
    // executes PAYLOAD via /bin/sh (mirrors `su -c PAYLOAD`).
    //
    // Flags:
    //   -c COMMAND / --command COMMAND   (value-bearing; re-parse seam)
    //   -a / --append                    (bare)
    //   -f / --flush                     (bare)
    //   -q / --quiet                     (bare)
    //   -t[FILE] / --timing[=FILE]       (bare or joined; util-linux)
    //   -T FILE  / --log-timing FILE     (value-bearing; util-linux 2.32+)
    //   -e / --return                    (bare; util-linux)
    //   -E auto|always|never / --echo …  (value-bearing)
    //   -B FILE / --log-io FILE          (value-bearing)
    //   -I FILE / --log-in FILE          (value-bearing)
    //   -O FILE / --log-out FILE         (value-bearing)
    //   -m advanced|classic              (value-bearing)
    //   -h / --help / -V / --version     (bare)
    //
    // When `-c PAYLOAD` is found, synthesize `sh -c PAYLOAD` so the
    // nested-shell detector picks up the inner write. The optional
    // [TYPESCRIPT-FILE] positional after PAYLOAD is dropped — it is
    // a write target for the typescript log, NOT a re-parse target;
    // matching it against protected paths is a separate concern
    // handled by detectGenericPositionalWrites if `script` were in
    // the dispatcher (it is not, intentionally).
    if (name === 'script') {
      let cFound = false;
      let cPayloadIdx = -1;
      let j = i + 1;
      while (j < argv.length) {
        const next = argv[j];
        if (next === undefined) break;
        if (next.dynamic) return argv.slice(j);
        const v = next.value;
        if (v === '--') {
          j += 1;
          break;
        }
        if (v === '-c' || v === '--command') {
          cFound = true;
          cPayloadIdx = j + 1;
          break;
        }
        if (v.startsWith('--command=')) {
          // Synthesize sh -c PAYLOAD.
          const inline = v.slice('--command='.length);
          const pos = head.position;
          const synthSh: WordValue = { value: 'sh', dynamic: false, position: pos };
          const synthDashC: WordValue = { value: '-c', dynamic: false, position: pos };
          const synthPayload: WordValue = {
            value: inline,
            dynamic: next.dynamic,
            position: next.position,
          };
          return [synthSh, synthDashC, synthPayload, ...argv.slice(j + 1)];
        }
        // Joined-form `-tFILE`, `--timing=FILE`.
        if (v.startsWith('--timing=')) {
          j += 1;
          continue;
        }
        if (v.startsWith('-t') && v.length > 2) {
          // -t<FILE> joined form.
          j += 1;
          continue;
        }
        // Bare `--timing` or `-t` with no joined value: util-linux
        // treats `-t` as a bare flag taking optional value via env.
        // Conservative: bare.
        if (v === '-t' || v === '--timing') {
          j += 1;
          continue;
        }
        // Value-bearing flags (separate-arg form).
        if (
          v === '-T' ||
          v === '--log-timing' ||
          v === '-E' ||
          v === '--echo' ||
          v === '-B' ||
          v === '--log-io' ||
          v === '-I' ||
          v === '--log-in' ||
          v === '-O' ||
          v === '--log-out' ||
          v === '-m'
        ) {
          j += 2;
          continue;
        }
        // Joined long-form value: `--log-timing=FILE`, etc.
        if (
          v.startsWith('--log-timing=') ||
          v.startsWith('--echo=') ||
          v.startsWith('--log-io=') ||
          v.startsWith('--log-in=') ||
          v.startsWith('--log-out=')
        ) {
          j += 1;
          continue;
        }
        // Bare flags / unknown short cluster.
        if (
          v === '-a' ||
          v === '--append' ||
          v === '-f' ||
          v === '--flush' ||
          v === '-q' ||
          v === '--quiet' ||
          v === '-e' ||
          v === '--return' ||
          v === '-h' ||
          v === '--help' ||
          v === '-V' ||
          v === '--version'
        ) {
          j += 1;
          continue;
        }
        if (v.startsWith('-')) {
          // Unknown flag — skip conservatively.
          j += 1;
          continue;
        }
        // First non-flag positional: the [TYPESCRIPT-FILE] argument.
        // Without `-c`, script just records to this file; there's
        // no inner command to dispatch. Bail out of the wrapper
        // strip — the caller's default: case will run the
        // structural guard (no shell positional present, so no-op).
        break;
      }
      if (cFound && cPayloadIdx >= 0) {
        const payload = argv[cPayloadIdx];
        if (payload === undefined) {
          // `script -c` with no payload — bail.
          return argv.slice(i);
        }
        // Synthesize `sh -c PAYLOAD` so detectNestedShell handles
        // the re-parse seam. Anything past PAYLOAD (the typescript
        // FILE) is dropped — see TSDoc above.
        const pos = head.position;
        const synthSh: WordValue = { value: 'sh', dynamic: false, position: pos };
        const synthDashC: WordValue = { value: '-c', dynamic: false, position: pos };
        return [synthSh, synthDashC, payload];
      }
      // No `-c`. `script TYPESCRIPT_FILE` records a session — no
      // inner command to dispatch. Bail to the default case.
      break;
    }

    // `parallel` (GNU parallel + moreutils parallel-ish): runs a
    // command line in parallel for each input. Re-parse seam — the
    // command-line-template (everything between flag-strip end and
    // the FIRST `:::` / `::::` / `:::+` / `::::+` separator) is
    // re-parsed as a shell command line.
    //
    // Common flag shapes (GNU parallel man):
    //   -j N / --jobs=N / --jobs N           (value-bearing)
    //   -k / --keep-order                    (bare)
    //   --no-run-if-empty / -r               (bare)
    //   --tag                                (bare)
    //   --linebuffer                         (bare)
    //   --line-buffer                        (bare)
    //   --halt SPEC / --halt=SPEC            (value-bearing)
    //   --joblog FILE / --joblog=FILE        (value-bearing)
    //   --results DIR / --results=DIR        (value-bearing)
    //   --record-env                         (bare)
    //   --env VAR / --env=VAR                (value-bearing)
    //   --bibtex                             (bare)
    //   ... many more; we use the same conservative rule as
    //   systemd-run: long-flag-with-`=` self-contained, long-flag
    //   without takes one VALUE token, short flags with `j/J/N`
    //   value-bearing; rest bare.
    //
    // Refuse on uncertainty: if the command-line-template contains
    // GNU parallel's positional-replacement placeholders (`{}`,
    // `{1}`, `{.}`, `{#}`, `{%}`, `{= ... =}`, ...), we cannot
    // statically resolve the per-input substitution. Synthesize the
    // template anyway via `sh -c "<template>"` so the nested-shell
    // detector at least catches the COMMAND IDENTITY (e.g. `rm
    // {}` → `sh -c "rm {}"` → walker sees `rm` head with one
    // positional `{}`, which is a literal string with `{` `}` —
    // protected matcher won't hit it but if the template contains
    // a literal protected path, that DOES hit). Acceptable
    // false-negative: GNU parallel `parallel rm ::: .rea/HALT` is
    // caught because the inner template includes `.rea/HALT`
    // literally (we don't resolve `{}`-substitution but we do see
    // every literal token).
    if (name === 'parallel') {
      i += 1;
      // Strip flags greedily until first non-flag token, OR until a
      // `:::`/`::::`/`:::+`/`::::+` separator (which means there is
      // no command template — `parallel ::: input` runs `echo input`
      // by default).
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        if (next.dynamic) return argv.slice(i);
        const v = next.value;
        if (v === '--') {
          i += 1;
          break;
        }
        // GNU parallel separators end the flag region.
        if (v === ':::' || v === '::::' || v === ':::+' || v === '::::+') {
          break;
        }
        // Joined long-form value.
        if (v.startsWith('--') && v.includes('=')) {
          i += 1;
          continue;
        }
        // Short value-bearing flags.
        if (v === '-j' || v === '-J' || v === '-N' || v === '-S' || v === '-X' || v === '-L') {
          i += 2;
          continue;
        }
        // Long-form value-bearing flags (separate-arg form). We
        // mirror systemd-run's approach: peek the next token; if it
        // doesn't start with `-` and is not a separator, treat as
        // value.
        if (v.startsWith('--')) {
          const peek = argv[i + 1];
          const bareLong = new Set([
            '--keep-order',
            '--no-run-if-empty',
            '--tag',
            '--linebuffer',
            '--line-buffer',
            '--bibtex',
            '--record-env',
            '--ungroup',
            '--group',
            '--quote',
            '--null',
            '--dry-run',
            '--verbose',
            '--bar',
            '--eta',
            '--progress',
            '--will-cite',
            '--help',
            '--version',
          ]);
          if (bareLong.has(v)) {
            i += 1;
            continue;
          }
          if (
            peek !== undefined &&
            !peek.value.startsWith('-') &&
            peek.value !== ':::' &&
            peek.value !== '::::' &&
            peek.value !== ':::+' &&
            peek.value !== '::::+'
          ) {
            i += 2;
          } else {
            i += 1;
          }
          continue;
        }
        if (v.startsWith('-')) {
          // Unknown short flag — skip conservatively.
          i += 1;
          continue;
        }
        // First non-flag, non-separator token — start of the command
        // template.
        break;
      }
      // From here, collect tokens until a separator OR end-of-argv.
      // These tokens form the command-line template.
      const templateStart = i;
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        const v = next.value;
        if (v === ':::' || v === '::::' || v === ':::+' || v === '::::+') {
          break;
        }
        i += 1;
      }
      const templateTokens = argv.slice(templateStart, i);
      if (templateTokens.length === 0) {
        // `parallel ::: input` form — no template, defaults to
        // `echo input`. Nothing to dispatch.
        break;
      }
      // Collect input tokens that follow `:::`, `::::`, `:::+`,
      // `::::+`. GNU parallel expands the template across each
      // input — so each input token is potentially substituted
      // into a `{}` placeholder OR (for templates without `{}`,
      // GNU parallel auto-appends) becomes a positional argument
      // to the template's head.
      //
      // Conservative static modeling: treat inputs as positional
      // args appended to the template. For `parallel rm ::: TGT`,
      // the synthesized argv `[rm, TGT]` runs through the rm
      // dispatcher and matches the target. For
      // `parallel bash -c "rm {}" ::: TGT`, the synthesized argv
      // is `[bash, -c, "rm {}", TGT]` — the bash dispatcher walks
      // `rm {}` (no protected hit) and the trailing TGT is bash's
      // `$0` not a write target. That is a known false-negative;
      // statically we can't substitute `{}`. The structural
      // wrapper-shell-exec guard does NOT save us here because
      // the dispatcher already matches on `bash` head. To close
      // this, future work could detect a `{}` placeholder in the
      // template and emit each input as a dynamic redirect-form
      // write. Bounded scope for round-10.
      //
      // Skip separator tokens themselves.
      const inputTokens: WordValue[] = [];
      while (i < argv.length) {
        const next = argv[i];
        if (next === undefined) break;
        const v = next.value;
        if (v === ':::' || v === '::::' || v === ':::+' || v === '::::+') {
          // Separator — skip and continue collecting; GNU parallel
          // allows `::: A B C ::: X Y Z` Cartesian-product forms.
          i += 1;
          continue;
        }
        inputTokens.push(next);
        i += 1;
      }
      // Synth = template ++ inputs. Reset i so we don't double-
      // consume; the wrapper-strip loop will continue from this
      // synthetic head (the template's first token).
      const synthArgv = [...templateTokens, ...inputTokens];
      // Replace argv from index 0 with the synthetic argv. We
      // return the slice; the caller's dispatcher walks it.
      return synthArgv;
    }

    // `\cp` (backslash-prefixed to bypass aliases) — strip the leading
    // backslash so detection works.
    if (name.startsWith('\\') && name.length > 1) {
      argv[i] = { ...head, value: name.slice(1) };
      continue;
    }
    break;
  }
  return argv.slice(i);
}

/**
 * Heuristic: does this token look like a reverse-DNS Flatpak APPID?
 *
 * Real APPIDs are reverse-DNS strings: `org.gnome.Calculator`,
 * `com.spotify.Client`, `io.github.somebody.SomeApp`. They contain at
 * least two dots and only `[A-Za-z0-9_-]` between them.
 *
 * If a token does NOT match this shape and IS a known shell / utility
 * head, the attacker is exploiting `flatpak run` as a transparent
 * wrapper without supplying a real APPID. We refuse to consume it and
 * dispatch the rest as the inner command — this catches codex round 9
 * F1 PoC `flatpak run bash -c "rm .rea/HALT"`.
 */
function looksLikeFlatpakAppId(token: string): boolean {
  // Must contain at least two dots and start/end with a non-dot.
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.-]*[A-Za-z0-9_]$/.test(token)) return false;
  const dotCount = (token.match(/\./g) ?? []).length;
  return dotCount >= 2;
}

// ─────────────────────────────────────────────────────────────────────
//  Per-command detectors
// ─────────────────────────────────────────────────────────────────────

/**
 * cp / mv detector. POSIX semantics:
 *   - last positional is destination (single or multi-source)
 *   - `-t TARGET_DIR src...` and `--target-directory=TARGET` → TARGET
 *     is destination
 *   - `--` ends option processing
 *
 * Flag-with-value (single-dash): `-t`, `-S`, `-T` (mv), `-Z`. We consume
 * the next token. Long flags `--option=value` are self-contained;
 * `--option value` shapes for cp/mv take values for `--target-directory`,
 * `--reply`, `--suffix`, `--backup`, `--reflink`. The rest are flag-only.
 *
 * We emit:
 *   - cp_t_flag / mv_t_flag for `-t` / `--target-directory` destination
 *   - cp_dest / mv_dest for the tail-positional destination
 *
 * Conservative over-blocking: when both forms are present (`cp -t DIR
 * --target-directory=DIR2 src`) the second wins per POSIX, but we emit
 * BOTH so the policy check fires on either match. Cost: a false-positive
 * if both targets are unprotected and DIFFER, which never happens in
 * real usage.
 */
function detectCpMv(argv: WordValue[], cmd: 'cp' | 'mv', out: DetectedWrite[]): void {
  const positionals: WordValue[] = [];
  const tFlagDest: WordValue[] = [];
  let i = 1;
  let endOfOpts = false;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    if (endOfOpts) {
      positionals.push(tok);
      i += 1;
      continue;
    }
    const v = tok.value;
    if (tok.dynamic) {
      // Dynamic token in flag position — we can't safely classify
      // it. Treat as a positional (fail-closed via dynamic flag).
      positionals.push(tok);
      i += 1;
      continue;
    }
    if (v === '--') {
      endOfOpts = true;
      i += 1;
      continue;
    }
    if (v.startsWith('--')) {
      // Long flag.
      if (v === '--target-directory' || v === '-target-directory') {
        const next = argv[i + 1];
        if (next !== undefined) tFlagDest.push(next);
        i += 2;
        continue;
      }
      if (v.startsWith('--target-directory=')) {
        const inline = v.slice('--target-directory='.length);
        tFlagDest.push({ value: inline, dynamic: tok.dynamic, position: tok.position });
        i += 1;
        continue;
      }
      // Long flags with values (cp/mv): --reply, --suffix, --backup,
      // --reflink. These take the next arg if not `=`-form.
      if (v === '--reply' || v === '--suffix' || v === '--backup' || v === '--reflink') {
        i += 2;
        continue;
      }
      // Otherwise long flag without value (`--force`, `--verbose`).
      i += 1;
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      // Short flag cluster. `-t TARGET` is the value-bearing case.
      // The cluster's last char determines if a value follows.
      //
      // Codex round 2 R2-4: also accept the no-space joined form
      // `-t.rea/` / `-tDIR` (the cluster "value" is everything AFTER the
      // leading -t, when the cluster STARTS with -t and is longer than
      // 2 chars). Pre-fix `cp -t.rea src` slipped past because the
      // dispatcher saw `-t.rea` as a flag cluster ending in `a`, fell
      // to the i+=1 bare-flag arm, and never emitted the destination.
      if (v.startsWith('-t') && v.length > 2) {
        tFlagDest.push({ value: v.slice(2), dynamic: tok.dynamic, position: tok.position });
        i += 1;
        continue;
      }
      const last = v.charAt(v.length - 1);
      if (last === 't') {
        const next = argv[i + 1];
        if (next !== undefined) tFlagDest.push(next);
        i += 2;
        continue;
      }
      // Codex round 1 F-5: -T (no-target-directory, treats DEST as
      // file even when DEST is an existing dir) takes NO value in
      // POSIX cp/mv. Pre-fix this was clustered with -S/-Z and skipped
      // the next token, so `cp -fT src .rea/HALT` ate `.rea/HALT` as
      // the bogus `-T value`. Drop -T from the value-bearing set.
      if (last === 'S' || last === 'Z') {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // Bare positional.
    positionals.push(tok);
    i += 1;
  }

  // Emit -t / --target-directory destinations.
  const tForm: DetectedForm = cmd === 'cp' ? 'cp_t_flag' : 'mv_t_flag';
  for (const dest of tFlagDest) {
    out.push({
      path: dest.value,
      form: tForm,
      position: dest.position,
      dynamic: dest.dynamic,
      // Codex round 1 F-7: -t / --target-directory targets are by
      // definition directories. The matcher uses isDirTarget to treat
      // protected children of the dir as a hit even without a trailing
      // slash. Pre-fix `cp --target-directory=.rea src` allowed.
      isDirTarget: true,
    });
  }

  // Emit tail-positional destination — only if there's no `-t` form
  // (POSIX: `-t` says "all positionals are SOURCES", no tail-dest).
  if (tFlagDest.length === 0 && positionals.length >= 2) {
    const dest = positionals[positionals.length - 1];
    if (dest !== undefined) {
      out.push({
        path: dest.value,
        form: cmd === 'cp' ? 'cp_dest' : 'mv_dest',
        position: dest.position,
        dynamic: dest.dynamic,
      });
    }
  }

  // Codex round 4 Finding 3: for `mv` ONLY, emit SOURCE positionals
  // as destructive write detections too. mv removes content from the
  // source path; if the source is a protected file, the operation
  // is semantically a destructive write to that path.
  // For `cp`, sources are read-only and don't need this treatment.
  if (cmd === 'mv') {
    // Sources are everything in `positionals` except the trailing dest
    // (when no -t flag is used) OR everything in `positionals` (when
    // -t is used). Either way, all leading positionals up to the
    // dest-or-end are sources.
    const sourceEnd =
      tFlagDest.length === 0 && positionals.length >= 2
        ? positionals.length - 1
        : positionals.length;
    for (let k = 0; k < sourceEnd; k += 1) {
      const src = positionals[k];
      if (src === undefined) continue;
      out.push({
        path: src.value,
        form: 'mv_dest',
        position: src.position,
        dynamic: src.dynamic,
        isDestructive: true,
        originSrc: 'mv source-side (content removed at original path)',
      });
    }
  }
}

/**
 * sed -i detector. POSIX-ish:
 *   - GNU: `sed -i SCRIPT FILE...` (no extension required for -i)
 *   - BSD: `sed -i '' SCRIPT FILE...` (extension is required, empty allowed)
 *   - Combined flag clusters: `-iE` (-i with extension E), `-ine`
 *     (-i + -n + -e), etc.
 *
 * We accept any flag cluster containing the letter `i`. Trailing
 * positionals are scanned: skip the script (first non-flag), all
 * remaining positionals are file targets.
 *
 * BSD-mode `-i ''` consumes the next arg as the extension; we conservatively
 * always treat the FIRST non-flag positional after `-i` as the script,
 * regardless of GNU/BSD distinction. False positive rate: zero in normal
 * usage (no one writes `sed -i ''` and then a non-script first positional).
 */
function detectSedI(argv: WordValue[], out: DetectedWrite[]): void {
  let inplace = false;
  // Codex round 1 F-6: track whether a script has already been consumed
  // via -e / -f / --expression / --file. When yes, ALL positionals are
  // file targets — there is no "first positional is script" slot to
  // skip. Pre-fix `sed -e '1d' -i .rea/HALT` skipped `.rea/HALT` as
  // the alleged script and emitted no target.
  let scriptConsumedViaFlag = false;
  const positionals: WordValue[] = [];
  let i = 1;
  let endOfOpts = false;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    if (endOfOpts) {
      positionals.push(tok);
      i += 1;
      continue;
    }
    const v = tok.value;
    if (v === '--') {
      endOfOpts = true;
      i += 1;
      continue;
    }
    if (v.startsWith('--')) {
      if (v === '--in-place' || v.startsWith('--in-place=')) {
        inplace = true;
        i += 1;
        continue;
      }
      // --expression / --file take a value; both are -e/-f equivalents.
      if (v === '--expression' || v === '--file') {
        scriptConsumedViaFlag = true;
        i += 2;
        continue;
      }
      if (v.startsWith('--expression=') || v.startsWith('--file=')) {
        scriptConsumedViaFlag = true;
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      // Short flag cluster.
      if (v.includes('i')) inplace = true;
      // -e / -f take a value (script / scriptfile).
      const last = v.charAt(v.length - 1);
      if (last === 'e' || last === 'f') {
        scriptConsumedViaFlag = true;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    positionals.push(tok);
    i += 1;
  }
  if (!inplace) return;
  // When a script was consumed via flag, every positional is a target.
  // Otherwise the first positional is the script (BSD `-i ''` edge: the
  // parser emits `''` as SglQuoted with empty Value, which wordToString
  // resolves to '' — we conservatively treat it as the script slot).
  const targets = scriptConsumedViaFlag ? positionals : positionals.slice(1);
  for (const t of targets) {
    out.push({
      path: t.value,
      form: 'sed_i',
      position: t.position,
      dynamic: t.dynamic,
    });
  }
}

/** dd of=PATH detector. */
function detectDdOf(argv: WordValue[], out: DetectedWrite[]): void {
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok.value.startsWith('of=')) {
      out.push({
        path: tok.value.slice(3),
        form: 'dd_of',
        position: tok.position,
        dynamic: tok.dynamic,
      });
    }
  }
}

/**
 * tee detector. Every non-flag positional is a write target.
 * Flags: `-a` / `--append`, `-i` / `--ignore-interrupts`, `-p`,
 * `--output-error[=...]`. None take a value.
 */
function detectTee(argv: WordValue[], out: DetectedWrite[]): void {
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok.value === '--') {
      // All remaining are positional.
      for (let j = i + 1; j < argv.length; j += 1) {
        const next = argv[j];
        if (next === undefined) continue;
        out.push({
          path: next.value,
          form: 'tee_arg',
          position: next.position,
          dynamic: next.dynamic,
        });
      }
      return;
    }
    if (tok.value.startsWith('-')) continue;
    out.push({ path: tok.value, form: 'tee_arg', position: tok.position, dynamic: tok.dynamic });
  }
}

/**
 * truncate detector. Skip flags, including value-bearing `-s SIZE` /
 * `--size=SIZE` / `-r REFFILE` / `--reference=REFFILE`. Every other
 * positional is a write target.
 */
function detectTruncate(argv: WordValue[], out: DetectedWrite[]): void {
  let i = 1;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    const v = tok.value;
    if (v === '--') {
      for (let j = i + 1; j < argv.length; j += 1) {
        const next = argv[j];
        if (next === undefined) continue;
        out.push({
          path: next.value,
          form: 'truncate_arg',
          position: next.position,
          dynamic: next.dynamic,
        });
      }
      return;
    }
    if (v === '-s' || v === '-r' || v === '--size' || v === '--reference') {
      i += 2;
      continue;
    }
    if (v.startsWith('--size=') || v.startsWith('--reference=')) {
      i += 1;
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      // Combined: `-s100`, `-c` (no-create), `-o` (size-relative-to-block).
      // -s combined with size value (`-s100`) — single token, no consume.
      if (v.startsWith('-s') && v.length > 2) {
        i += 1;
        continue;
      }
      if (v.startsWith('-r') && v.length > 2) {
        i += 1;
        continue;
      }
      i += 1;
      continue;
    }
    out.push({ path: v, form: 'truncate_arg', position: tok.position, dynamic: tok.dynamic });
    i += 1;
  }
}

/**
 * install detector. Last positional is destination (or destination-dir
 * for multi-source). Skip `-m MODE`, `-o OWNER`, `-g GROUP`, `-t DIR`,
 * `-D` (no-value).
 */
function detectInstall(argv: WordValue[], out: DetectedWrite[]): void {
  const positionals: WordValue[] = [];
  let tDest: WordValue | null = null;
  let i = 1;
  let endOfOpts = false;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    if (endOfOpts) {
      positionals.push(tok);
      i += 1;
      continue;
    }
    const v = tok.value;
    if (v === '--') {
      endOfOpts = true;
      i += 1;
      continue;
    }
    if (v === '-t' || v === '--target-directory') {
      const next = argv[i + 1];
      if (next !== undefined) tDest = next;
      i += 2;
      continue;
    }
    if (v.startsWith('--target-directory=')) {
      tDest = {
        value: v.slice('--target-directory='.length),
        dynamic: tok.dynamic,
        position: tok.position,
      };
      i += 1;
      continue;
    }
    // Codex round 2 R2-4: no-space joined form -tDIR.
    if (v.startsWith('-t') && v.length > 2 && !v.startsWith('--')) {
      tDest = { value: v.slice(2), dynamic: tok.dynamic, position: tok.position };
      i += 1;
      continue;
    }
    if (v === '-m' || v === '-o' || v === '-g' || v === '-S' || v === '-T') {
      i += 2;
      continue;
    }
    if (
      v.startsWith('--mode=') ||
      v.startsWith('--owner=') ||
      v.startsWith('--group=') ||
      v.startsWith('--suffix=')
    ) {
      i += 1;
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      i += 1;
      continue;
    }
    positionals.push(tok);
    i += 1;
  }
  if (tDest !== null) {
    out.push({
      path: tDest.value,
      form: 'install_dest',
      position: tDest.position,
      dynamic: tDest.dynamic,
      // Codex round 1 F-7: -t target is a directory.
      isDirTarget: true,
    });
    return;
  }
  if (positionals.length >= 2) {
    const dest = positionals[positionals.length - 1];
    if (dest !== undefined) {
      out.push({
        path: dest.value,
        form: 'install_dest',
        position: dest.position,
        dynamic: dest.dynamic,
      });
    }
  } else if (positionals.length === 1) {
    // `install -d DIR` creates DIR — that's a write. Single-positional
    // form.
    const dest = positionals[0];
    if (dest !== undefined) {
      out.push({
        path: dest.value,
        form: 'install_dest',
        position: dest.position,
        dynamic: dest.dynamic,
      });
    }
  }
}

/**
 * ln detector. ln SRC DEST or ln -s SRC DEST or ln SRC1 SRC2 ... DESTDIR.
 * `-t TARGETDIR` available in GNU ln.
 *
 * The destination is what we care about — that's the path being
 * created. For symlink creation the symlink's name is the destination
 * (which is what gets written to disk).
 */
function detectLn(argv: WordValue[], out: DetectedWrite[]): void {
  const positionals: WordValue[] = [];
  let tDest: WordValue | null = null;
  let i = 1;
  let endOfOpts = false;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    if (endOfOpts) {
      positionals.push(tok);
      i += 1;
      continue;
    }
    const v = tok.value;
    if (v === '--') {
      endOfOpts = true;
      i += 1;
      continue;
    }
    if (v === '-t' || v === '--target-directory') {
      const next = argv[i + 1];
      if (next !== undefined) tDest = next;
      i += 2;
      continue;
    }
    if (v.startsWith('--target-directory=')) {
      tDest = {
        value: v.slice('--target-directory='.length),
        dynamic: tok.dynamic,
        position: tok.position,
      };
      i += 1;
      continue;
    }
    // Codex round 2 R2-4: no-space joined form -tDIR.
    if (v.startsWith('-t') && v.length > 2 && !v.startsWith('--')) {
      tDest = { value: v.slice(2), dynamic: tok.dynamic, position: tok.position };
      i += 1;
      continue;
    }
    if (v === '-S' || v === '--suffix') {
      i += 2;
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      i += 1;
      continue;
    }
    positionals.push(tok);
    i += 1;
  }
  if (tDest !== null) {
    out.push({
      path: tDest.value,
      form: 'ln_dest',
      position: tDest.position,
      dynamic: tDest.dynamic,
      // Codex round 1 F-7: -t target is a directory.
      isDirTarget: true,
    });
    return;
  }
  if (positionals.length >= 2) {
    const dest = positionals[positionals.length - 1];
    if (dest !== undefined) {
      out.push({
        path: dest.value,
        form: 'ln_dest',
        position: dest.position,
        dynamic: dest.dynamic,
      });
    }
  }
}

/**
 * awk -i inplace / gawk -i inplace detector. The "inplace" extension
 * is selected by `-i inplace` (separate args) or `-i'inplace'` /
 * `-iinplace` (joined). When active, the LAST positional non-flag arg
 * is the file being modified in place.
 *
 * GNU gawk syntax:
 *   gawk -i inplace 'PROG' FILE
 *   gawk -i inplace -- 'PROG' FILE
 *   gawk --inplace 'PROG' FILE  (some forks)
 *
 * If `-i` is followed by anything other than `inplace`, it's loading
 * a different extension; we don't treat that as a write.
 */
function detectAwkInplace(argv: WordValue[], out: DetectedWrite[]): void {
  let inplace = false;
  const positionals: WordValue[] = [];
  let i = 1;
  let endOfOpts = false;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    if (endOfOpts) {
      positionals.push(tok);
      i += 1;
      continue;
    }
    const v = tok.value;
    if (v === '--') {
      endOfOpts = true;
      i += 1;
      continue;
    }
    if (v === '--inplace' || v.startsWith('--inplace=')) {
      inplace = true;
      i += 1;
      continue;
    }
    if (v === '-i' || v === '--include') {
      const next = argv[i + 1];
      if (next !== undefined && next.value === 'inplace') inplace = true;
      i += 2;
      continue;
    }
    // Joined: `-iinplace` or `-i'inplace'`. mvdan strips the quotes,
    // so we see `-iinplace`.
    if (v.startsWith('-i') && v.slice(2) === 'inplace') {
      inplace = true;
      i += 1;
      continue;
    }
    if (
      v === '-f' ||
      v === '--file' ||
      v === '-v' ||
      v === '--assign' ||
      v === '-F' ||
      v === '--field-separator'
    ) {
      i += 2;
      continue;
    }
    if (
      v.startsWith('--file=') ||
      v.startsWith('--assign=') ||
      v.startsWith('--field-separator=')
    ) {
      i += 1;
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      i += 1;
      continue;
    }
    positionals.push(tok);
    i += 1;
  }
  if (!inplace) return;
  // First positional is the AWK script. Remaining positionals are
  // files. They will all be edited in place.
  for (let j = 1; j < positionals.length; j += 1) {
    const t = positionals[j];
    if (t === undefined) continue;
    out.push({ path: t.value, form: 'awk_inplace', position: t.position, dynamic: t.dynamic });
  }
}

/**
 * ed / ex detector. Conservative: ANY positional non-flag arg is
 * treated as a write target. ed and ex always edit in place when
 * given a file (the operator types `w` or `:wq` to commit; we can't
 * see stdin, so we refuse on the file argument).
 *
 * `vi`/`vim` hit this same path — they reach ex-mode via `:wq` too.
 * Conservative over-blocking is acceptable here: legitimate uses of
 * `ed .rea/HALT` are nonexistent.
 */
function detectEdEx(argv: WordValue[], form: DetectedForm, out: DetectedWrite[]): void {
  let i = 1;
  let endOfOpts = false;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    if (endOfOpts) {
      out.push({ path: tok.value, form, position: tok.position, dynamic: tok.dynamic });
      i += 1;
      continue;
    }
    const v = tok.value;
    if (v === '--') {
      endOfOpts = true;
      i += 1;
      continue;
    }
    // ex/vi `-c CMD` and `-S SCRIPT` take a value.
    if (v === '-c' || v === '-S' || v === '--cmd') {
      i += 2;
      continue;
    }
    if (v.startsWith('--cmd=')) {
      i += 1;
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      i += 1;
      continue;
    }
    out.push({ path: v, form, position: tok.position, dynamic: tok.dynamic });
    i += 1;
  }
}

/**
 * find detector. The interesting case is `-exec CMD ... \;` /
 * `-execdir CMD ... \;` / `-ok CMD ... \;` — the inner command
 * may be a write. Recurse the inner argv as if it were a new CallExpr.
 *
 * `find` itself never writes via its own argv. A bare `find` invocation
 * with no `-exec` is allow.
 */
function detectFind(argv: WordValue[], out: DetectedWrite[]): void {
  // Codex round 4 Finding 4: detect `-delete`. When present:
  //   - The find seed paths (positionals BEFORE the first predicate
  //     starting with `-`) are destructive write targets.
  //   - If a `-name PATTERN` predicate is present and the seed path is
  //     ambiguous (e.g. `find . -name HALT -delete`), we emit a
  //     dynamic detection because runtime expansion against `.` may hit
  //     a protected file. Refuse on uncertainty.
  // First pass: collect seed paths (positionals before any `-flag`).
  // The find spec: `find PATH... PREDICATES`. PREDICATES start with `-`.
  const seeds: WordValue[] = [];
  let predicatesStart = argv.length;
  for (let k = 1; k < argv.length; k += 1) {
    const tok = argv[k];
    if (tok === undefined) continue;
    if (tok.value.startsWith('-') || tok.value === '!' || tok.value === '(') {
      predicatesStart = k;
      break;
    }
    seeds.push(tok);
  }
  // Second pass: scan predicates for -delete / -exec / -name.
  let hasDelete = false;
  let hasNamePredicate = false;
  let i = predicatesStart;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) {
      i += 1;
      continue;
    }
    const v = tok.value;
    if (v === '-delete') {
      hasDelete = true;
      i += 1;
      continue;
    }
    if (v === '-name' || v === '-iname' || v === '-path' || v === '-ipath') {
      hasNamePredicate = true;
      i += 2;
      continue;
    }
    // Codex round 12 F12-8 (P1): find write-predicates. These three
    // predicates take a FILE argument and write to it for every match:
    //   -fls FILE          — write `ls -dils`-style record to FILE
    //   -fprint FILE       — write match path + newline to FILE
    //   -fprintf FILE FMT  — write formatted record to FILE
    // Pre-fix `find . -fls .rea/HALT` slipped past entirely (no
    // predicate match) because the find detector only knew -delete /
    // -exec / -name. Each one is a destructive write to FILE.
    if (v === '-fls' || v === '-fprint') {
      const next = argv[i + 1];
      if (next !== undefined) {
        out.push({
          path: next.value,
          form: 'redirect',
          position: next.position,
          dynamic: next.dynamic,
          isDestructive: true,
          originSrc: `find ${v} writes to FILE for every match`,
        });
      }
      i += 2;
      continue;
    }
    if (v === '-fprintf') {
      // `-fprintf FILE FORMAT` consumes TWO args.
      const fileTok = argv[i + 1];
      if (fileTok !== undefined) {
        out.push({
          path: fileTok.value,
          form: 'redirect',
          position: fileTok.position,
          dynamic: fileTok.dynamic,
          isDestructive: true,
          originSrc: 'find -fprintf writes formatted record to FILE',
        });
      }
      i += 3;
      continue;
    }
    if (v === '-exec' || v === '-execdir' || v === '-ok' || v === '-okdir') {
      // Collect tokens until `;` / `\;` / `+` terminator. The parser
      // emits `\;` as a literal `\;` (backslash preserved) — we accept
      // both shapes since either form lands here.
      const inner: WordValue[] = [];
      let j = i + 1;
      while (j < argv.length) {
        const t = argv[j];
        if (t === undefined) break;
        if (t.value === ';' || t.value === '\\;' || t.value === '+') break;
        inner.push(t);
        j += 1;
      }
      // Codex round 11 F11-1: scan inner argv for `{}` placeholder.
      // find substitutes the matched filename for every `{}` token at
      // RUNTIME — its value depends on the seed paths and the
      // -name/-path predicates evaluated against the live filesystem.
      // Even with explicit non-protected seeds, an attacker who can
      // place a file at a protected path (or who controls the
      // filesystem state at run time) chooses what `{}` resolves to.
      //
      // Static analysis cannot resolve `{}`, so we refuse on uncertainty
      // by emitting a synthetic dynamic detection at the find seed
      // position. The detection fires regardless of whatever
      // recurseInnerArgv produces from its own dispatch — the
      // `{}`-bearing position IS the unresolvable signal.
      //
      // Read-only inner heads (`cat {}`, `grep PAT {}`, `head {}`,
      // etc.) do not trigger this branch because they don't write.
      // We only refuse when the inner argv has BOTH a `{}` placeholder
      // AND the inner head is a write-class utility OR otherwise
      // unknown. Practically: rather than enumerate every read-only
      // utility, we let recurseInnerArgv's per-utility detector
      // decide whether the inner command writes. If it produces ANY
      // detection (from cp/mv/sed/rm/etc.), the `{}` makes that
      // detection's destination/source argv runtime-resolved → emit
      // the synthetic placeholder-unresolvable detection. If the
      // inner command is read-only (cat/grep/head), no detection is
      // produced and we ALLOW.
      //
      // To implement that without parsing argv twice, we collect the
      // walker output of recurseInnerArgv and only emit the
      // placeholder-unresolvable when:
      //   (a) the inner argv contains a `{}` literal, AND
      //   (b) the inner head is in the write-class allow-list (rm,
      //       cp, mv, sed, dd, tee, truncate, install, ln, awk,
      //       chmod, chown, chgrp, touch, mkdir, rmdir, gzip,
      //       gunzip, shred, perl/python/ruby/node/php interpreters,
      //       bash/sh re-parse seams, or unknown — we fall back to
      //       refuse-on-uncertainty for unknown heads with `{}`).
      const hasPlaceholder = inner.some((t) => /\{\}/.test(t.value));
      const innerOutBuf: DetectedWrite[] = [];
      if (inner.length > 0) {
        recurseInnerArgv(inner, 'find_exec_inner', innerOutBuf);
      }
      if (hasPlaceholder) {
        // Emit synthetic dynamic detection at the find seed position.
        // This BLOCKS regardless of what the inner detector produced.
        // We pick the position of the `{}` token (or the find head if
        // we can't find it) so operator-facing messages point at the
        // bypass shape directly.
        const pos =
          inner.find((t) => /\{\}/.test(t.value))?.position ??
          argv[0]?.position ?? { line: 0, col: 0 };
        // Heuristic for read-only inner: if no detection was produced
        // AND the inner head is in a small read-only allow-list,
        // skip the synthetic emit. The allow-list is intentionally
        // tight; we err on refuse-on-uncertainty for unknown heads.
        const innerStripped = stripEnvAndModifiers(inner);
        const innerHead =
          innerStripped[0] !== undefined ? normalizeCmdHead(innerStripped[0].value) : '';
        const READ_ONLY_INNER_HEADS = new Set([
          'cat',
          'grep',
          'egrep',
          'fgrep',
          'rgrep',
          'head',
          'tail',
          'wc',
          'less',
          'more',
          'file',
          'stat',
          'ls',
          'echo',
          'printf',
          'realpath',
          'basename',
          'dirname',
          'readlink',
          'md5sum',
          'sha1sum',
          'sha256sum',
          'sha512sum',
          'shasum',
          'cksum',
          'sum',
          'test',
          '[',
          'true',
          'false',
        ]);
        const innerIsKnownReadOnly =
          innerOutBuf.length === 0 && READ_ONLY_INNER_HEADS.has(innerHead);
        if (!innerIsKnownReadOnly) {
          out.push({
            path: '',
            form: 'find_exec_placeholder_unresolvable',
            position: pos,
            dynamic: true,
            isDestructive: true,
            originSrc: `find -exec with \`{}\` placeholder targets runtime-resolved paths (inner head: ${innerHead || 'unknown'})`,
          });
        }
      }
      // Always merge whatever the inner detector produced (literal
      // protected paths in the inner argv — e.g. `find . -exec rm
      // .rea/HALT \;` — must still BLOCK on the literal target even
      // when no placeholder exists).
      for (const d of innerOutBuf) out.push(d);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  // Codex round 4 Finding 4: emit destructive detections for -delete.
  if (hasDelete) {
    if (seeds.length === 0) {
      // `find -delete PREDICATE` (no seed). Refuse on uncertainty.
      const pos = argv[0]?.position ?? { line: 0, col: 0 };
      out.push({
        path: '',
        form: 'redirect',
        position: pos,
        dynamic: true,
        isDestructive: true,
        originSrc: 'find -delete with no seed path (target unresolvable)',
      });
      return;
    }
    for (const seed of seeds) {
      // Each seed becomes a destructive target. If a -name predicate
      // narrows the match dynamically (`find . -name HALT -delete`),
      // we still emit the seed as destructive — protected-ancestry then
      // catches `.` which contains `.rea/HALT`. The over-block on a
      // benign seed-with-narrow-name is acceptable; find -delete is
      // destructive and rare in legitimate code.
      out.push({
        path: seed.value,
        form: 'redirect',
        position: seed.position,
        dynamic: seed.dynamic || hasNamePredicate,
        isDestructive: true,
        originSrc: hasNamePredicate
          ? 'find with -name + -delete (matched paths runtime-resolved)'
          : 'find -delete on seed path',
      });
    }
  }
}

/**
 * xargs detector. xargs reads input from stdin and treats each token
 * as an argument to the inner command. The inner command's
 * destination (for cp/mv) might be a positional in xargs's argv, OR
 * it might come from stdin — which we cannot statically resolve.
 *
 * Spec: refuse on uncertainty. Emit an `xargs_unresolvable` detection
 * with path="" and dynamic=true so the compositor refuses with a
 * "destination via stdin can't be statically resolved" reason.
 *
 * Exception: if the inner command's argv already has a known-bad
 * destination (e.g. `xargs cp -t .rea/`), the recursive walk catches
 * it. So we ALSO recurse the inner argv even though we know the path
 * is unreliable.
 */
function detectXargs(argv: WordValue[], out: DetectedWrite[], _head: string): void {
  let i = 1;
  // Skip xargs flags.
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    const v = tok.value;
    if (v === '--') {
      i += 1;
      break;
    }
    // Value-bearing flags.
    if (
      v === '-I' ||
      v === '-i' ||
      v === '-n' ||
      v === '-L' ||
      v === '-P' ||
      v === '-s' ||
      v === '-E' ||
      v === '-d' ||
      v === '-a' ||
      v === '--replace' ||
      v === '--max-args' ||
      v === '--max-lines' ||
      v === '--max-procs' ||
      v === '--max-chars' ||
      v === '--eof' ||
      v === '--delimiter' ||
      v === '--arg-file'
    ) {
      i += 2;
      continue;
    }
    if (
      v.startsWith('--replace=') ||
      v.startsWith('--max-args=') ||
      v.startsWith('--max-lines=') ||
      v.startsWith('--max-procs=') ||
      v.startsWith('--max-chars=') ||
      v.startsWith('--eof=') ||
      v.startsWith('--delimiter=') ||
      v.startsWith('--arg-file=')
    ) {
      i += 1;
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      i += 1;
      continue;
    }
    break;
  }
  // Remaining argv is the inner command.
  const inner = argv.slice(i);
  if (inner.length === 0) {
    // Bare `xargs`. Emit unresolvable — we don't know what command is
    // being driven.
    const pos = argv[0]?.position ?? { line: 0, col: 0 };
    out.push({
      path: '',
      form: 'xargs_unresolvable',
      position: pos,
      dynamic: true,
    });
    return;
  }
  // Recurse the inner argv. If the inner command is a write whose dest
  // is a static argv positional, we'll catch it. If the dest is from
  // stdin, we refuse.
  recurseInnerArgv(inner, 'xargs_unresolvable', out);
  // Always emit the unresolvable-stdin sentinel — even if the inner
  // walk found a destination, xargs MIGHT inject more args from stdin.
  // Conservative refusal: any xargs invocation is treated as
  // potentially-unresolvable.
  const pos = argv[0]?.position ?? { line: 0, col: 0 };
  out.push({
    path: '',
    form: 'xargs_unresolvable',
    position: pos,
    dynamic: true,
  });
}

/**
 * Recurse an inner argv (from -exec, xargs, etc.) as if it were a
 * fresh CallExpr. We synthesize a minimal fake-argv-walk dispatching
 * to the same per-command detectors.
 *
 * `wrapForm` is the form-tag applied if the inner detection itself
 * is unresolvable (e.g. xargs's stdin source). When the inner walk
 * detects a real write, that write's own form survives.
 */
function recurseInnerArgv(inner: WordValue[], wrapForm: DetectedForm, out: DetectedWrite[]): void {
  const innerOut: DetectedWrite[] = [];
  // Synthesize a CallExpr-like dispatch by re-running stripEnvAndModifiers
  // and the head-name switch from walkCallExpr.
  const stripped = stripEnvAndModifiers(inner);
  if (stripped.length === 0 || stripped[0] === undefined) return;
  // Codex round 2 R2-14: see walkCallExpr — same basename normalization
  // applies to inner-argv dispatch (find -exec /bin/bash -c …, xargs
  // /usr/bin/sed -i …).
  const head = normalizeCmdHead(stripped[0].value);
  switch (head) {
    case 'cp':
      detectCpMv(stripped, 'cp', innerOut);
      break;
    case 'mv':
      detectCpMv(stripped, 'mv', innerOut);
      break;
    case 'sed':
      detectSedI(stripped, innerOut);
      break;
    case 'dd':
      detectDdOf(stripped, innerOut);
      break;
    case 'tee':
      detectTee(stripped, innerOut);
      break;
    case 'truncate':
      detectTruncate(stripped, innerOut);
      break;
    case 'install':
      detectInstall(stripped, innerOut);
      break;
    case 'ln':
      detectLn(stripped, innerOut);
      break;
    case 'awk':
    case 'gawk':
    case 'mawk':
    case 'nawk':
      detectAwkInplace(stripped, innerOut);
      detectAwkSource(stripped, innerOut);
      break;
    case 'ed':
      detectEdEx(stripped, 'ed_target', innerOut);
      break;
    case 'ex':
    case 'vi':
    case 'vim':
      detectEdEx(stripped, 'ex_target', innerOut);
      break;
    case 'find':
      detectFind(stripped, innerOut);
      break;
    case 'node':
    case 'nodejs':
      detectInterpreterEval(
        stripped,
        NODE_EVAL_FLAGS,
        'node_e_path',
        NODE_WRITE_PATTERNS,
        innerOut,
      );
      break;
    case 'python':
    case 'python2':
    case 'python3':
      detectInterpreterEval(
        stripped,
        PYTHON_EVAL_FLAGS,
        'python_c_path',
        PYTHON_WRITE_PATTERNS,
        innerOut,
      );
      break;
    case 'ruby':
      detectInterpreterEval(
        stripped,
        RUBY_EVAL_FLAGS,
        'ruby_e_path',
        RUBY_WRITE_PATTERNS,
        innerOut,
      );
      break;
    case 'perl':
      detectInterpreterEval(
        stripped,
        PERL_EVAL_FLAGS,
        'perl_e_path',
        PERL_WRITE_PATTERNS,
        innerOut,
      );
      break;
    // Codex round 11 F11-7: PHP. Same eval-flag scanner, PHP patterns.
    case 'php':
      detectInterpreterEval(stripped, PHP_EVAL_FLAGS, 'php_r_path', PHP_WRITE_PATTERNS, innerOut);
      break;
    case 'bash':
    case 'sh':
    case 'zsh':
    case 'dash':
    case 'ksh':
    // Codex round 9 F2: busybox/Alpine/OpenWrt shells (parity with
    // walkCallExpr). Inner-argv dispatch from xargs/find -exec must
    // recognize the same set.
    case 'ash':
    case 'mksh':
    case 'yash':
    case 'posh':
    case 'rc':
      // Codex round 1 F-4: `find . -exec bash -c '…' {} \;` was not
      // unwrapping the inner shell payload. Pre-fix the find detector
      // recursed once into the -exec argv but only matched flat utility
      // shapes; routing the `bash` head through detectNestedShell here
      // re-parses the payload and walks it (with the same depth cap).
      detectNestedShell(stripped, innerOut);
      break;
    case 'touch':
    case 'mkdir':
    case 'chmod':
    case 'chown':
    case 'chgrp': {
      // Per spec helix-023 F5b, `xargs touch` should refuse on stdin
      // unresolvability — already emitted by detectXargs. For
      // direct `touch FILE` outside xargs, the command writes to FILE
      // (creates / updates). Codex round 1 F-21: rm/chmod/chown
      // included here for defense in depth.
      detectGenericPositionalWrites(stripped, innerOut);
      // Re-tag the wrapper form if the caller (xargs/find -exec)
      // wanted a specific tag.
      if (wrapForm !== 'redirect') {
        for (const d of innerOut) {
          if (d.form === 'redirect') d.form = wrapForm;
        }
      }
      break;
    }
    case 'rm': {
      // Codex round 4 Finding 1: recursive rm flags propagate through
      // -exec / xargs.
      detectGenericPositionalWrites(stripped, innerOut, {
        isDestructiveCmd: rmIsRecursive(stripped),
      });
      // Re-tag the wrapper form if the caller (xargs/find -exec)
      // wanted a specific tag.
      if (wrapForm !== 'redirect') {
        for (const d of innerOut) {
          if (d.form === 'redirect') d.form = wrapForm;
        }
      }
      break;
    }
    case 'rmdir': {
      // Codex round 4 Finding 1: rmdir is always destructive against
      // its (directory) target.
      detectGenericPositionalWrites(stripped, innerOut, { isDestructiveCmd: true });
      if (wrapForm !== 'redirect') {
        for (const d of innerOut) {
          if (d.form === 'redirect') d.form = wrapForm;
        }
      }
      break;
    }
    // Codex round 2 R2-7..R2-13: same dispatchers as walkCallExpr.
    case 'tar':
    case 'bsdtar':
      detectTar(stripped, innerOut);
      break;
    // Codex round 11 F11-4: archive extraction parity in inner-argv.
    case 'unzip':
      detectUnzip(stripped, innerOut);
      break;
    case '7z':
    case '7za':
    case '7zr':
      detect7z(stripped, innerOut);
      break;
    // Codex round 12 F12-5 (P0): zip parity in inner-argv.
    case 'zip':
      detectZip(stripped, innerOut);
      break;
    case 'gzip':
      detectGzip(stripped, innerOut, 'gzip');
      break;
    case 'gunzip':
      detectGzip(stripped, innerOut, 'gunzip');
      break;
    case 'pax':
      detectPax(stripped, innerOut);
      break;
    // Codex round 12 F12-6 / F12-7 parity in inner-argv (find -exec /
    // xargs / nested-shell composition must reach the same dispatchers).
    case 'cmake':
      detectCmake(stripped, innerOut);
      break;
    case 'mkfifo':
      detectMkfifo(stripped, innerOut);
      break;
    case 'mknod':
      detectMknod(stripped, innerOut);
      break;
    case 'rsync':
      detectRsync(stripped, innerOut);
      break;
    case 'curl':
      detectCurl(stripped, innerOut);
      break;
    case 'wget':
      detectWget(stripped, innerOut);
      break;
    case 'shred':
      detectShred(stripped, innerOut);
      break;
    case 'eval':
      detectEval(stripped, innerOut);
      break;
    case 'patch':
      detectPatch(stripped, innerOut);
      break;
    case 'sort':
      detectSort(stripped, innerOut);
      break;
    case 'shuf':
      detectShuf(stripped, innerOut);
      break;
    case 'gpg':
    case 'gpg2':
      detectGpg(stripped, innerOut);
      break;
    case 'split':
    case 'csplit':
      detectSplit(stripped, innerOut);
      break;
    case 'trap':
      detectTrap(stripped, innerOut);
      break;
    case 'git':
      detectGit(stripped, innerOut);
      break;
    default:
      break;
  }
  // Merge inner detections into the parent output.
  for (const d of innerOut) {
    out.push(d);
  }
}

/**
 * Interpreter eval-flag payload scanner. Accepts multiple eval-flag
 * forms (each triggers source-arg consumption + pattern scanning):
 *
 *   - exact long forms (`--eval`, `--print`)
 *   - exact short forms (`-e`, `-c`, `-p`)
 *   - short-flag clusters whose LAST char is one of the cluster-eligible
 *     short forms (`-pe`, `-Ee`, `-ic`); the trailing char selects the
 *     payload-bearing flag and the next argv is the source
 *
 * Each pattern matches a write call; the captured group is the target
 * path.
 *
 * This is pattern-matching against a string, but the string is the
 * extracted JS / Python / Ruby / Perl source — we can't avoid that
 * without embedding language parsers, which is out of scope. The
 * shapes we match are syntactic and stable; an attacker who wants to
 * write to .rea/HALT via `node -e` pretty much has to write something
 * recognizable as a write, modulo creative obfuscation. For real
 * defense in depth, the attacker also has to bypass settings-protection
 * and the audit trail.
 *
 * Importantly: we PRE-NORMALIZE the source by stripping shell
 * escape sequences `\"` → `"` and `\'` → `'`. This is the helix-023
 * Finding 1 fix: pre-fix, `node -e "fs.writeFileSync(\".rea/HALT\",\"x\")"`
 * had a parser-extracted source of `fs.writeFileSync(\".rea/HALT\",\"x\")`
 * (the shell already consumed the outer DQ but kept the backslashes
 * intact in the literal value). We pre-strip those backslashes before
 * the regex runs.
 */
interface EvalFlagSet {
  /** Exact match against the whole argv token (e.g. `-e`, `--eval`). */
  exactLong: readonly string[];
  /**
   * Single chars accepted as the LAST character of a short-flag
   * cluster. e.g. node accepts `e`, `p` so `-pe` and `-e` and `-p`
   * all qualify. The presence of the char anywhere in the cluster
   * additionally counts (covers `-Ee`, `-pe`, `-ie`).
   */
  shortChars: readonly string[];
}

function detectInterpreterEval(
  argv: WordValue[],
  flagSet: EvalFlagSet,
  form: DetectedForm,
  patterns: RegExp[],
  out: DetectedWrite[],
): void {
  let i = 1;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    const v = tok.value;
    let isEvalFlag = false;
    if (flagSet.exactLong.includes(v)) {
      isEvalFlag = true;
    } else if (v.startsWith('-') && !v.startsWith('--') && v.length >= 2) {
      // Short-flag cluster (`-pe`, `-Ee`, `-ic`, `-c`). When the cluster
      // contains any short-char from the eval set, treat the next arg
      // as the source. Codex round 1 F-13 (bash -ic) and F-8 (node -p,
      // perl -E, etc.).
      const cluster = v.slice(1);
      for (const c of flagSet.shortChars) {
        if (cluster.includes(c)) {
          isEvalFlag = true;
          break;
        }
      }
    }
    if (isEvalFlag) {
      const next = argv[i + 1];
      if (next === undefined) break;
      const source = unshellEscape(next.value);
      scanInterpreterSource(source, next, form, patterns, out);
      i += 2;
      continue;
    }
    i += 1;
  }
}

/**
 * Apply each per-language pattern set to a source string, emitting
 * detections for every matched write. Extracted from
 * detectInterpreterEval so the awk-source scanner can share the loop.
 *
 * The function ALSO checks dynamic-write patterns (codex round 1 F-10
 * / F-11 — concat / f-string / `%` / template-literal-with-${} first
 * args) and shell-out patterns (F-12 — qx / system / backtick), and
 * re-parses captured inner-shell commands as bash for the F-12 case.
 *
 * Codex round 2 R2-1: a STRUCTURAL flat-scan fallback runs after the
 * localized regex patterns. The localized patterns require the dynamic
 * construction to happen INSIDE the write-call's first-arg position
 * (`open('a'+'b','w')`). They do NOT fire when the dynamic construction
 * is decoupled into a prior statement (`p='a'+'b'; open(p,'w')`). The
 * flat-scan asks a coarser question: "does the payload contain BOTH a
 * write API AND any string-construction primitive?" If yes, refuse on
 * uncertainty. False positives on legit decoupled writes are acceptable
 * — defense in depth against an attacker who decouples to bypass the
 * localized regex.
 */
function scanInterpreterSource(
  source: string,
  next: WordValue,
  form: DetectedForm,
  patterns: RegExp[],
  out: DetectedWrite[],
): void {
  // 1. Static path patterns — first capture is path.
  // Codex round 4 Finding 1+6: when the matched substring contains a
  // destructive API token, plumb isDestructive:true so protected-
  // ancestry matching catches `rm_rf .rea`, `rmtree('.rea')`,
  // `Path('.rea').rmdir()` etc.
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const captured = m[1];
      if (typeof captured === 'string' && captured.length > 0) {
        const matched = m[0];
        const destructive = isMatchedDestructive(matched);
        out.push({
          path: captured,
          form,
          position: next.position,
          dynamic: next.dynamic,
          originSrc: matched,
          ...(destructive ? { isDestructive: true } : {}),
        });
      }
    }
  }
  // 2. Dynamic-first-arg patterns — emit dynamic detections so the
  //    compositor refuses on uncertainty.
  const dynamicPatterns = pickDynamicPatternsFor(form);
  for (const re of dynamicPatterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      out.push({
        path: '',
        form,
        position: next.position,
        dynamic: true,
        originSrc: m[0],
      });
    }
  }
  // 2b. Codex round 2 R2-1: flat-scan fallback for decoupled-variable
  //     writes. If the payload contains BOTH a write API AND any
  //     string-construction primitive (concat / interpolation / .join /
  //     .format / % / sprintf / template-literal), emit a dynamic
  //     detection. Pre-fix `p='.rea'+'/HALT'; open(p,'w')` slipped
  //     past every localized regex.
  const lang = languageFor(form);
  if (lang !== null && hasDynamicConstructionWithWriteApi(source, lang)) {
    out.push({
      path: '',
      form,
      position: next.position,
      dynamic: true,
      originSrc: 'decoupled-variable write (write API + dynamic construction in payload)',
    });
  }
  // 3a. Codex round 4 Finding 5: opaque-spawn APIs — emit dynamic
  //     when the API is invoked at all, regardless of how its argv is
  //     constructed.
  const opaquePatterns = pickOpaqueSpawnPatternsFor(form);
  for (const re of opaquePatterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      out.push({
        path: '',
        form,
        position: next.position,
        dynamic: true,
        originSrc: m[0],
      });
    }
  }
  // 3. Shell-out patterns — capture inner shell, re-parse, walk.
  const shellOutPatterns = pickShellOutPatternsFor(form);
  let anyShellOutExtracted = false;
  for (const re of shellOutPatterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      // Codex round 5 F3 (P1): quote-aware variants use 2 capture groups
      // (group 1 = quote char, group 2 = body via backref). Pick the
      // LAST non-empty capture so both shapes work without per-pattern
      // tagging.
      let innerCmd: string | undefined = undefined;
      for (let g = m.length - 1; g >= 1; g -= 1) {
        const cand = m[g];
        if (typeof cand === 'string' && cand.length > 0 && cand !== '"' && cand !== "'") {
          innerCmd = cand;
          break;
        }
      }
      if (typeof innerCmd === 'string' && innerCmd.length > 0) {
        anyShellOutExtracted = true;
        // Codex round 5 F4 (P1): chained-interpreter detection. When
        // the extracted shell-out body itself is a nested interpreter
        // invocation (`bash → python → node` etc.), each layer
        // accumulates one level of `\\\\\"` shell-escape in its argv;
        // by the time the inner-most write call is reachable the
        // localized regex patterns can no longer recognize the path-
        // quote shape because two `\` precede the `"`. Iterating
        // unshellEscape over-strips and breaks single-level cases. We
        // refuse on uncertainty: if the body contains any interpreter
        // eval flag (`-c`/-e`/`--eval`/`-pe`/`-ic`) AND the body
        // contains any write-API token from any language, emit a
        // dynamic detection. The compositor blocks dynamic, closing
        // every multi-level chain.
        if (looksLikeChainedInterpreter(innerCmd)) {
          out.push({
            path: '',
            form,
            position: next.position,
            dynamic: true,
            originSrc:
              'shell-out body contains nested interpreter eval flag — refusing on uncertainty',
          });
        }
        // Re-parse the inner shell command and walk it. We reuse the
        // top-level walkForWrites entry — this gives us full coverage
        // (redirects, cp dest, sed -i, etc.) for free.
        const parsed = parseBashCommand(innerCmd);
        if (parsed.ok) {
          const innerWrites = walkForWrites(parsed.file);
          for (const d of innerWrites) {
            out.push({
              ...d,
              // Position is the outer interpreter's; the inner write
              // has no usable independent line/col.
              position: next.position,
              originSrc: m[0],
            });
          }
        } else {
          // Inner parse failed — refuse on uncertainty.
          out.push({
            path: '',
            form,
            position: next.position,
            dynamic: true,
            originSrc: m[0],
          });
        }
      }
    }
  }
  // 4. Codex round 5 F3+F4 (P1) — fail-closed shell-out fallback.
  //
  // If the payload contains a shell-out API token (`os.system`,
  // `subprocess.run` with `shell=True`, `Kernel.system`, `child_process`,
  // `execSync`, `qx`, `system`, `exec`, etc.) but NO shell-out regex
  // captured a clean payload, the payload is using a quote shape the
  // regexes don't recognize — typically mixed-quote nesting like
  //   python -c "import os; os.system('rm \".rea/HALT\"')"
  //   ruby -e "Kernel.system('rm \".rea/HALT\"')"
  //   node -e `require('child_process').execSync(\`rm '.rea/HALT'\`)`
  //   python -c "import subprocess; subprocess.run('rm \".rea/HALT\"', shell=True)"
  // The existing regexes use `["']([^"']+)["']` which rejects strings
  // whose body contains the alternate quote char. We refuse on
  // uncertainty: we know the payload is shelling out, just not what it
  // says — that's enough to BLOCK.
  //
  // False-positive risk: a payload that legitimately calls a shell-out
  // API but uses cross-quote nesting where the inner string is benign.
  // Those payloads are rare in practice; conversely, every quote-
  // mixing exfil payload trips this layer. Defense in depth.
  const shellOutTokens = SHELL_OUT_API_TOKENS[lang ?? 'node'] ?? [];
  if (lang !== null && !anyShellOutExtracted) {
    let tokenHit: string | null = null;
    for (const tok of shellOutTokens) {
      if (typeof tok === 'string') {
        if (source.includes(tok)) {
          tokenHit = tok;
          break;
        }
      } else if (tok.test(source)) {
        tokenHit = tok.source;
        break;
      }
    }
    if (tokenHit !== null) {
      out.push({
        path: '',
        form,
        position: next.position,
        dynamic: true,
        originSrc:
          'shell-out API present (' +
          tokenHit +
          ') but inner command not statically extractable — refusing on uncertainty',
      });
    }
  }
}

/**
 * Codex round 5 F3+F4 (P1): per-language shell-out API tokens. The
 * presence of any token in an interpreter payload triggers a fail-
 * closed dynamic detection IFF no shell-out regex above extracted a
 * payload — meaning the attacker is using a quote shape the regexes
 * don't model.
 *
 * Strings match as substring; RegExp values match anywhere in the
 * source. Be conservative: every shell-out / spawn API gets a token.
 */
const SHELL_OUT_API_TOKENS: Record<InterpreterLang, ReadonlyArray<string | RegExp>> = {
  node: [
    'execSync',
    'execFileSync',
    'spawnSync',
    'child_process',
    // `.exec(`, `.spawn(`, `.execFile(`, `.fork(` — the call-site shape.
    /\.\s*exec\s*\(/,
    /\.\s*spawn\s*\(/,
    /\.\s*execFile\s*\(/,
    /\.\s*fork\s*\(/,
    // Bare imports — `require('child_process')` was already a substring
    // hit; `import` form is also relevant.
    /from\s+["']child_process["']/,
  ],
  python: [
    // Unconditional shell-out APIs — every invocation runs a shell.
    'os.system',
    'os.popen',
    'pty.spawn',
    'pty.fork',
    'commands.getoutput',
    'commands.getstatusoutput',
    'os.execv',
    'os.execvp',
    // subprocess.* + shell=True is the canonical Python shell-out. The
    // `shell=True` token must co-occur with the subprocess.* call to
    // signal shell-out. argv-form subprocess.* is structurally
    // safe (Python doesn't shell-interpret the argv list); we don't
    // want to fire on legit `subprocess.run(['printf', 'x'])` calls
    // (which the round-5 corpus exercises with non-protected targets).
    /subprocess\.(?:run|call|check_call|check_output|Popen)\s*\([^)]*shell\s*=\s*True/,
  ],
  ruby: [
    // Unconditional string-form shell-out call sites — every entry
    // takes a single string argument that ruby passes to /bin/sh.
    'Kernel.system',
    'Kernel.exec',
    'Kernel.spawn',
    'IO.popen',
    'PTY.spawn',
    'Open3.capture2',
    'Open3.capture3',
    'Open3.popen2',
    'Open3.popen3',
    'Open3.capture2e',
    'Open3.popen2e',
    'Open3.pipeline',
    // Bare `system(...)` / `exec(...)` / `spawn(...)` at module level —
    // anchored on word boundary to skip identifiers like `mysystem`.
    /(?:^|[\s;(])system\s*\(?\s*["']/,
    /(?:^|[\s;(])exec\s*\(?\s*["']/,
    /(?:^|[\s;(])spawn\s*\(?\s*["']/,
    // `cmd` backtick form — when the regex didn't capture, presence of
    // a backtick pair near a word boundary still signals shell-out.
    /`[^`]*`/,
    /%x\s*[{(]/,
  ],
  perl: [
    /\bsystem\s*\(?\s*["']/,
    /\bexec\s*\(?\s*["']/,
    'qx(',
    'qx{',
    /`[^`]*`/,
    // `open(F, '|cmd')` / `open(F, 'cmd|')` — pipe-open shorthand.
    /open\s*\([^,]+,\s*["'][^"']*[|]/,
    /open\s*\([^,)]+,\s*["'][|+\-]/,
    'IPC::Open',
  ],
};

function pickDynamicPatternsFor(form: DetectedForm): readonly RegExp[] {
  switch (form) {
    case 'node_e_path':
      return NODE_DYNAMIC_WRITE_PATTERNS;
    case 'python_c_path':
      return PYTHON_DYNAMIC_WRITE_PATTERNS;
    case 'ruby_e_path':
      return RUBY_DYNAMIC_WRITE_PATTERNS;
    default:
      return [];
  }
}

/**
 * Map a DetectedForm to its language identifier for the flat-scan
 * decoupled-variable detector (codex round 2 R2-1).
 */
type InterpreterLang = 'node' | 'python' | 'ruby' | 'perl';
function languageFor(form: DetectedForm): InterpreterLang | null {
  switch (form) {
    case 'node_e_path':
      return 'node';
    case 'python_c_path':
      return 'python';
    case 'ruby_e_path':
      return 'ruby';
    case 'perl_e_path':
      return 'perl';
    default:
      return null;
  }
}

/**
 * Per-language write-API tokens. Match these as a SUBSTRING anywhere
 * in the payload — we only ask "does the payload reference a write
 * API". Coupled with `hasStringConstruction` it answers "is the
 * payload doing dynamic-construction-then-write".
 */
const WRITE_API_TOKENS: Record<InterpreterLang, readonly string[]> = {
  node: [
    'writeFileSync',
    'writeFile',
    'appendFileSync',
    'appendFile',
    'createWriteStream',
    'openSync',
    // .open( with mode is a write — but bare `.open(` is also `fs.open(...)`
    // for reads. We accept the false-positive risk; flat-scan is the
    // imprecise-but-safe layer.
    '.open(',
    'promises.writeFile',
    'promises.appendFile',
    // Codex round 3 Finding 6 (P2): fs API breadth.
    'cpSync',
    '.cp(',
    'renameSync',
    '.rename(',
    'copyFile',
    'copyFileSync',
    'rmSync',
    '.rm(',
    'unlinkSync',
    '.unlink(',
    'mkdirSync',
    '.mkdir(',
    'rmdirSync',
    '.rmdir(',
    'truncateSync',
    '.truncate(',
  ],
  python: [
    'open(',
    '.write_text',
    '.write_bytes',
    'shutil.copy',
    'shutil.move',
    'os.rename',
    'os.replace',
    // Codex round 3 Finding 7 (P2): API breadth.
    'os.open(',
    'shutil.rmtree',
    'os.unlink',
    'os.remove',
    'os.rmdir',
    'os.removedirs',
    // Codex round 3 Finding 5 (P1): subprocess shell-out is a write
    // surface when shell=True (we treat any subprocess.* in the payload
    // as a potential write API for flat-scan purposes).
    'subprocess.run',
    'subprocess.call',
    'subprocess.check_call',
    'subprocess.check_output',
    'subprocess.Popen',
    'os.system(',
    'os.popen(',
  ],
  ruby: [
    'File.write',
    'File.binwrite',
    'File.open',
    'IO.write',
    'IO.binwrite',
    'FileUtils.cp',
    'FileUtils.mv',
    // Codex round 3 Finding 8 (P2): API breadth.
    'FileUtils.cp_r',
    'FileUtils.copy',
    'FileUtils.move',
    'FileUtils.copy_file',
    'FileUtils.rename',
    'FileUtils.rm',
    'FileUtils.rm_r',
    'FileUtils.rm_rf',
    'FileUtils.remove',
    'FileUtils.remove_file',
    'FileUtils.remove_dir',
    'FileUtils.mkdir',
    'FileUtils.mkdir_p',
    'Pathname',
  ],
  perl: [
    // perl `open(FH, ">FILE")` is the canonical write; the localized
    // regex covers it. For decoupled-variable, we look for the bare
    // write-mode quoted token.
    'open(',
    'open ',
    // qx() and backticks are shell-out, separate concern.
  ],
};

/**
 * Per-language string-construction primitives. Match as a SUBSTRING
 * anywhere in the payload. We deliberately OVER-match: any payload
 * doing string concat / interpolation / formatting near a write API
 * is treated as a dynamic-target write.
 */
const STRING_CONSTRUCTION_TOKENS: Record<InterpreterLang, readonly RegExp[]> = {
  // Node: `+` between strings, template literal `${...}`, .concat(),
  // .replace(), Buffer.from() with concat-shape.
  node: [
    /['"`][^'"`]*['"`]\s*\+/, // 'a' +  or  "a" +
    /\+\s*['"`]/, //  + 'a'
    /`[^`]*\$\{/, // template literal interpolation
    /\.concat\s*\(/,
    /\[\s*['"`][^'"`]*['"`]\s*,\s*['"`]/, // ['a','b'].join
    /\.\s*join\s*\(/,
    /\.\s*replace\s*\(/,
    /String\s*\.\s*raw/,
    /String\s*\(/,
  ],
  python: [
    /['"][^'"]*['"]\s*\+/, // 'a' + ...
    /\+\s*['"]/, //  + 'a'
    /\bf['"]/, // f-string  f'...
    /\bf\s*['"]/, // f '...
    /['"][^'"]*\{[^}]*\}[^'"]*['"]\s*\.\s*format/, // .format(
    /['"][^'"]*\{[^}]*\}[^'"]*['"]\s*%/, // mixed
    /['"][^'"]*%[sdrf]/, // % formatting
    /\.\s*format\s*\(/,
    /\.\s*join\s*\(/,
    /\.\s*replace\s*\(/,
    /os\s*\.\s*path\s*\.\s*join/,
    /pathlib\s*\.\s*Path/,
    /Path\s*\(/,
  ],
  ruby: [
    /['"][^'"]*['"]\s*\+/,
    /\+\s*['"]/,
    /['"][^'"]*#\{/, // string interpolation "#{x}"
    /\.\s*format\s*[(\s]/,
    /\.\s*sub\s*\(/,
    /\.\s*gsub\s*\(/,
    /\.\s*replace\s*\(/,
    /\.\s*join\s*[(\s]/,
    /sprintf\s*\(/,
    /['"][^'"]*%[sdrf]/, // % formatting
    /['"]\s*%\s*/, // string % sub
    /File\s*\.\s*join\s*\(/,
  ],
  perl: [
    /['"][^'"]*['"]\s*\.\s*['"]/, // perl string concat with `.`
    /\.\s*['"]/, // . " or . '
    /['"][^'"]*\$[A-Za-z_]/, // "$VAR" interpolation
    /['"][^'"]*@\{?[A-Za-z_]/, // "@arr"
    /sprintf\s*\(/,
    /join\s*\(/,
    /\bs\/[^/]+\/[^/]+\//, // s/// substitution that may construct paths
  ],
};

function hasDynamicConstructionWithWriteApi(source: string, lang: InterpreterLang): boolean {
  // Cheap pre-check: does the payload mention any write API?
  const apis = WRITE_API_TOKENS[lang];
  let writesPresent = false;
  for (const tok of apis) {
    if (source.includes(tok)) {
      writesPresent = true;
      break;
    }
  }
  if (!writesPresent) return false;
  // Now: does the payload contain ANY string-construction primitive?
  const ctors = STRING_CONSTRUCTION_TOKENS[lang];
  for (const re of ctors) {
    if (re.test(source)) return true;
  }
  return false;
}

/**
 * Codex round 4 Finding 5: per-language patterns whose mere presence
 * forces a dynamic detection (refuse on uncertainty), without trying
 * to capture the inner shell payload. Use for APIs whose argv shape
 * is too varied to reliably extract the command string but whose
 * semantic IS shell-out / spawn-arbitrary (`os.spawnv`, `os.spawnvp`,
 * `os.execv`, etc.). Pattern's groups are unused.
 */
const PYTHON_OPAQUE_SPAWN_RE: RegExp[] = [
  /\bos\s*\.\s*(?:spawnv|spawnvp|spawnvpe|spawnve|spawnle|spawnlp|spawnlpe|execv|execvp|execvpe|execve|execle|execlp|execlpe|execl)\b/g,
  /\bpty\s*\.\s*fork\s*\(/g,
];

function pickOpaqueSpawnPatternsFor(form: DetectedForm): readonly RegExp[] {
  switch (form) {
    case 'python_c_path':
      return PYTHON_OPAQUE_SPAWN_RE;
    default:
      return [];
  }
}

/**
 * Codex round 4 Finding 1 + Finding 6: per-substring destructive-API
 * recognition for interpreter-tier writes. When the regex `match[0]`
 * substring contains any of these tokens, we flag the emitted detection
 * as destructive so protected-ancestry matching catches writes against
 * directory targets that hold protected files.
 *
 * This list is defense in depth — every recognized destructive call
 * also has its captured path emitted. Without isDestructive=true,
 * `shutil.rmtree('.rea')` produces a write target `.rea` that the
 * matcher does NOT match against `.rea/HALT` (because `.rea` is neither
 * dir-shaped via input nor walker-flagged isDirTarget). With the flag
 * set, the protected-ancestry path in `matchPatterns` catches it.
 */
const DESTRUCTIVE_API_TOKENS: readonly string[] = [
  // node fs
  'rmSync',
  'rmdirSync',
  'unlinkSync',
  // python shutil/os
  'shutil.rmtree',
  'os.removedirs',
  'os.rmdir',
  'os.unlink',
  'os.remove',
  // python pathlib — token that appears in matched substring `.rmdir`
  // / `.unlink` / `.touch` (touch creates a file at the given path —
  // policy-relevant, but not technically "destructive" in the remove
  // sense; we still treat it as ancestor-affecting because creating a
  // file inside a nonexistent dir would create the dir, which can
  // overwrite a protected pattern).
  '.rmdir',
  '.unlink',
  '.touch',
  '.rm(',
  // ruby FileUtils
  'FileUtils.rm',
  'FileUtils.remove',
  // ruby File
  'File.delete',
  'File.unlink',
  'File.rmdir',
  // perl
  'unlink',
  // Codex round 12 F12-1 + F12-2: PHP destructive-API tokens. The
  // match[0] substring of the F12-1 rename-SRC regex begins with
  // `rename(` — we need that token in the list so isMatchedDestructive
  // returns true and protected-ancestry catches `rename('.rea/HALT', …)`.
  // Likewise F12-2 rmdir match[0] begins with `rmdir(` (no leading dot)
  // — distinct from the python pathlib `.rmdir` token already present.
  // (`unlink` is already in the list above as a perl-scoped token; the
  // substring match catches PHP `unlink(` too.)
  'rename(',
  'rmdir(',
];

function isMatchedDestructive(matched: string): boolean {
  for (const tok of DESTRUCTIVE_API_TOKENS) {
    if (matched.includes(tok)) return true;
  }
  return false;
}

function pickShellOutPatternsFor(form: DetectedForm): readonly RegExp[] {
  switch (form) {
    case 'node_e_path':
      return NODE_SHELL_OUT_RE;
    case 'python_c_path':
      return PYTHON_SHELL_OUT_RE;
    case 'ruby_e_path':
      return RUBY_SHELL_OUT_RE;
    case 'perl_e_path':
      return PERL_SHELL_OUT_RE;
    case 'php_r_path':
      // Codex round 12 F12-3 (P0): PHP shell-out re-parse.
      return PHP_SHELL_OUT_RE;
    case 'awk_source':
      return AWK_SHELL_OUT_RE;
    default:
      return [];
  }
}

/**
 * AWK source scanner. Awk programs commonly shell out via `system(...)`
 * and write to files via `print > "FILE"` / `print >> "FILE"`. Both
 * shapes are covered:
 *   - system(...) — re-parse the inner shell command and walk.
 *   - print >|>> "FILE" — direct path target.
 * Codex round 1 F-12 / F-19.
 */
function detectAwkSource(argv: WordValue[], out: DetectedWrite[]): void {
  // The awk PROGRAM is one of:
  //   - the FIRST non-flag positional after stripping `-i inplace`,
  //     `-v var=val`, `-F sep`, `-f scriptfile`.
  //   - the `-e PROG` value (gawk extension).
  // We scan the FIRST positional (if not preceded by -f) AND any -e
  // payload.
  let i = 1;
  let scriptConsumed = false;
  while (i < argv.length) {
    const tok = argv[i];
    if (tok === undefined) break;
    const v = tok.value;
    if (v === '--') {
      i += 1;
      break;
    }
    // -f SCRIPT_FILE — script is in a file, not visible to us. The
    // file's content might contain `system(…)`; we cannot statically
    // scan it. Codex round 1 F-19: we conservatively emit a dynamic
    // detection so the compositor refuses on uncertainty.
    if (v === '-f' || v === '--file') {
      out.push({
        path: '',
        form: 'awk_source',
        position: tok.position,
        dynamic: true,
        originSrc: 'awk -f script-file (script body unscanned)',
      });
      // Skip the script-file token so we don't treat it as the
      // program.
      scriptConsumed = true;
      i += 2;
      continue;
    }
    if (v.startsWith('--file=')) {
      out.push({
        path: '',
        form: 'awk_source',
        position: tok.position,
        dynamic: true,
        originSrc: 'awk --file=script-file (script body unscanned)',
      });
      scriptConsumed = true;
      i += 1;
      continue;
    }
    if (
      v === '-v' ||
      v === '--assign' ||
      v === '-F' ||
      v === '--field-separator' ||
      v === '-i' ||
      v === '--include'
    ) {
      i += 2;
      continue;
    }
    if (
      v.startsWith('--assign=') ||
      v.startsWith('--field-separator=') ||
      v.startsWith('--include=')
    ) {
      i += 1;
      continue;
    }
    if (v === '-e' || v === '--source') {
      // gawk extension: `-e PROG`. The value is awk source.
      const next = argv[i + 1];
      if (next !== undefined) {
        const source = unshellEscape(next.value);
        scanAwkProgram(source, next, out);
      }
      i += 2;
      scriptConsumed = true;
      continue;
    }
    if (v.startsWith('-') && v.length > 1) {
      i += 1;
      continue;
    }
    // First bare positional. If we already saw -f / -e the program
    // came from there; this is a data file. Otherwise this IS the
    // program.
    if (!scriptConsumed) {
      const source = unshellEscape(tok.value);
      scanAwkProgram(source, tok, out);
      scriptConsumed = true;
    }
    i += 1;
  }
}

function scanAwkProgram(source: string, next: WordValue, out: DetectedWrite[]): void {
  // print >|>> "FILE" — capture the path arg.
  AWK_PRINT_REDIR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = AWK_PRINT_REDIR_RE.exec(source)) !== null) {
    const captured = m[1];
    if (typeof captured === 'string' && captured.length > 0) {
      out.push({
        path: captured,
        form: 'awk_source',
        position: next.position,
        dynamic: next.dynamic,
        originSrc: m[0],
      });
    }
  }
  // system(...) shell-out and pipe-to-cmd.
  scanInterpreterSource(source, next, 'awk_source', [], out);
}

const AWK_PRINT_REDIR_RE = /print[bf]?\s+[^;}\n>]*>\s*>?\s*"([^"]+)"/g;
const AWK_SHELL_OUT_RE: RegExp[] = [
  // system("cmd") — value-bearing.
  /system\s*\(\s*"([^"]+)"\s*\)/g,
  /system\s*\(\s*'([^']+)'\s*\)/g,
  // print "…" | "cmd" — pipe to shell. Capture the cmd arg.
  /print[bf]?\s+[^;}\n|]*\|\s*"([^"]+)"/g,
];

const NODE_EVAL_FLAGS: EvalFlagSet = {
  exactLong: ['--eval', '--print'],
  // node short-flag eval / print: -e, -p. Cluster `-pe` is valid.
  shortChars: ['e', 'p'],
};
const PYTHON_EVAL_FLAGS: EvalFlagSet = {
  exactLong: [],
  // python short-flag: -c. `-ic` (interactive + command) is valid.
  shortChars: ['c'],
};
const RUBY_EVAL_FLAGS: EvalFlagSet = {
  exactLong: [],
  // ruby short-flag: -e. Cluster `-rfoo -e` is rare; we still match -e.
  shortChars: ['e'],
};
const PERL_EVAL_FLAGS: EvalFlagSet = {
  exactLong: [],
  // perl: -e (legacy) and -E (modern). Treat as a cluster char so
  // `-E` and `-Ee` and `-pe` all qualify (perl `-pe` is `perl -p -e
  // PROG`).
  shortChars: ['e', 'E'],
};
// Codex round 11 F11-7: PHP. `php -r CODE` evaluates CODE.
// Cluster `-rl`, `-rf`, etc. are not standard, but `-r` is the only
// eval flag (PHP also accepts `--run` since 5.x).
//
// Codex round 12 F12-4 (P0): PHP additionally supports two more
// CODE-bearing flags overlooked in round 11:
//   -B BEGIN_CODE  / --process-begin BEGIN_CODE  — run before stdin
//   -E END_CODE    / --process-end END_CODE      — run after stdin
// Both take a string of PHP source as their value just like -r.
// Pre-fix `php -B "unlink('.rea/HALT');"` slipped past the eval-flag
// scanner because the dispatcher only recognized -r/--run. We add B
// and E to the cluster shortChars (both are case-sensitive; PHP's
// -e/-r carry different meanings, but uppercase B/E are unambiguous)
// and the long forms to exactLong.
const PHP_EVAL_FLAGS: EvalFlagSet = {
  exactLong: ['--run', '--process-begin', '--process-end'],
  // php short-flag eval: -r, -B, -E. Note: PHP's lowercase -e is
  // "extended info" (a profiling flag), NOT eval; we deliberately
  // exclude it here to avoid false-positive mid-cluster matches.
  shortChars: ['r', 'B', 'E'],
};

/**
 * Strip shell-level backslash-escapes from an extracted string. mvdan
 * keeps the literal backslashes inside DblQuoted parts; the helpers
 * downstream (regex write-call detectors AND the bash re-parser used by
 * the nested-shell-inner path) need the form an actual shell would see
 * after collapsing DQ escape sequences.
 *
 * Bash spec (man bash, QUOTING):
 *
 *     Within double quotes, the backslash retains its special meaning
 *     only when followed by one of the following characters:
 *       $   `   "   \   <newline>
 *     A double quote may be escaped within double quotes by preceding it
 *     with a backslash.
 *
 * We strip backslash before any of those five characters. Pre-fix this
 * helper only collapsed `\"` and `\'`; round-8 P0 was a verified
 * end-to-end exploit:
 *
 *     bash -c "echo \"\$(touch /tmp/HACK_PROOF)\""
 *     # The real shell collapses `\$` → `$`, evaluates the CmdSubst,
 *     # creates the file. The walker's re-parse of the inner payload
 *     # saw `\$` as a literal `$` (no CmdSubst child), no detector
 *     # fired, ALLOW. The same shape against `.rea/HALT` bypassed the
 *     # protected-paths gate.
 *
 * The fix collapses all five DQ-escape sequences so the re-parser sees
 * the same syntax tree the shell would execute.
 *
 * `\'` is included for caller compatibility — some legacy call sites
 * pass strings extracted from contexts where SQ-style escaping is also
 * possible to encounter. Bash inside SQ does NOT process `\'` (SQ is
 * absolute), so this is a no-op when those payloads contain literal
 * `\'`. It is preserved as a permissive fallback.
 *
 * **Call sites (all DQ-context payloads):**
 *   - `walker.ts:3278` — `scanInterpreterEvalSource` (bash/python/perl
 *     `-c`/`-e` extracted as a child of a DQ part)
 *   - `walker.ts:3970` — `scanAwkArgv` `-e PROG` argument
 *   - `walker.ts:3985` — `scanAwkArgv` first bare positional (awk
 *     program text)
 *   - `walker.ts:4402` — `detectNestedShell` `-c PAYLOAD` re-parse
 *
 * **Not for SQ context.** Inside single quotes bash performs no escape
 * processing; calling this helper on a SQ-extracted payload is harmless
 * (literal `\'` cannot appear inside SQ in real shell input — the
 * tokenizer terminates the SQ at the first un-escaped quote) but
 * conceptually inappropriate. New call sites must be DQ-context.
 *
 * @param s - DQ-context payload as it appears in the AST (literal
 *   backslashes preserved by mvdan-sh).
 * @returns The same payload with the five DQ-significant backslash
 *   escapes collapsed.
 *
 * @example
 *   unshellEscape('echo \\"\\$(rm .rea/HALT)\\"')
 *   // → 'echo "$(rm .rea/HALT)"'
 *   //   The walker re-parses this and sees a CmdSubst child, so the
 *   //   protected-paths gate fires.
 */
function unshellEscape(s: string): string {
  // Bash DQ-significant escape set: $ ` " \ <newline>. We also keep `'`
  // for caller compatibility (legacy SQ-tolerant call sites). The class
  // is written as [$"`\\\n'] inside the regex.
  return s.replace(/\\([$"`\\\n'])/g, '$1');
}

/**
 * Codex round 5 F4 (P1): chained-interpreter heuristic. When a shell-
 * out body itself looks like another interpreter invocation that takes
 * an inline-eval payload, the multi-level escape semantics break the
 * localized write-call regex (each layer accumulates one level of
 * `\\\\\"` shell escape; one pass of unshellEscape can't strip all
 * layers without over-stripping single-level `\\\\\"` literals). This
 * helper detects the chained shape so the caller can fail-closed.
 *
 * Match shape: a known interpreter binary head (bash/sh/zsh/dash/ksh/
 * python/python3/ruby/perl/node/awk) followed somewhere by an eval
 * flag (`-c`, `-e`, `--eval`, `-pe`, `-ic`, etc.) — combined as a
 * regex over the raw body. Bypass attackers who use `node -e ...` or
 * `python -c ...` chained underneath an outer shell-out call site are
 * caught here even when the inner-quote shape eludes the path-quote
 * regex.
 *
 * False-positive risk: a payload that legitimately invokes a nested
 * interpreter without any write target. The cost is limited because
 * this fires only when the OUTER call was a shell-out API (already
 * suspicious) AND the body contains a chained interpreter (very rare
 * in non-malicious payloads). Defense in depth.
 */
const CHAINED_INTERPRETER_RE =
  /(?:^|[\s;|&(`])(?:bash|sh|zsh|dash|ksh|ash|python|python2|python3|ruby|perl|node|nodejs|awk|gawk|mawk|nawk)\b[^"']*?(?:\s)(?:-c|-e|-E|-pe|-ic|-lic|--eval|--exec)\b/;
function looksLikeChainedInterpreter(s: string): boolean {
  return CHAINED_INTERPRETER_RE.test(s);
}

// Per-language write-call patterns. Each pattern's first capture group
// is the path. The patterns are deliberately permissive — we OVER-match.
//
// Helix-023 Finding 2: `require('fs').writeFileSync(...)` and
// `let g=require('fs');g.writeFileSync(...)` need coverage.
//
// Strategy: catch `.<writeMethod>(` whether prefixed by `fs.` or any
// other identifier. The cost is a false-positive on totally-unrelated
// writeFileSync methods (e.g. some mock library), but that's a UX
// concern, not a security one.

// Per-language write-call patterns. Each pattern's first capture group
// is the path. The patterns are deliberately permissive — we OVER-match.
//
// Quote class: `["'`]` (double, single, AND backtick) — codex round 1
// F-9: ``node -e "fs.writeFileSync(`.rea/HALT`,'x')"`` was bypassing
// because backtick was missing from the quote class. We can't see the
// distinction between a static template literal and a string literal
// in regex, so we accept both shapes. (The dynamic-template-literal
// case `` `${x}` `` gets caught by DYNAMIC_FIRSTARG below.)
//
// SHELL_OUT_RE pattern: per F-12, perl/awk shell-out via qx() / system()
// re-parses the inner shell command. We treat the captured inner as a
// new bash source and run the parser against it via parseAndWalkInline.
//
// DYNAMIC_FIRSTARG_RE: per F-10/F-11, conservatively flag any
// "open-style" call whose first arg is non-trivial (concat, f-string,
// `%` formatting, computed-property, template literal with ${}, etc.)
// — we EMIT a dynamic detection so the compositor refuses on
// uncertainty. False positives on legit dynamic open() calls are
// preferable to bypassing real attacks.

const NODE_WRITE_PATTERNS: RegExp[] = [
  // Any `.writeFileSync(...)` / `.writeFile(...)` / `.appendFileSync(...)`
  // / `.appendFile(...)` / `.createWriteStream(...)` / `.open(...)` whose
  // first arg is a string literal — DOUBLE QUOTE / SINGLE QUOTE / BACKTICK.
  // Codex round 1 F-9 (backtick).
  // F-17: tolerate whitespace and computed-property access between the
  // identifier and the method (e.g. `fs . writeFileSync (`, `fs['writeFileSync']('PATH')`).
  /(?:\.|\[\s*['"])\s*(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream)\s*['"]?\s*\]?\s*\(\s*['"`]([^'"`]+)['"`]/g,
  // Open / openSync / promises.writeFile etc — modes are 'w' | 'a' |
  // 'wx' | 'r+' | 'w+' | 'a+'. Same quote class.
  /(?:\.|\[\s*['"])\s*(?:openSync|open|promises\.writeFile|promises\.appendFile)\s*['"]?\s*\]?\s*\(\s*['"`]([^'"`]+)['"`]\s*,\s*['"`]?(?:[wa]\+?|wx\+?|r\+|a\+)/g,
  // Codex round 3 Finding 6 (P2): fs.cp / fs.cpSync / fs.rename /
  // fs.renameSync — DESTINATION is the SECOND arg.
  /(?:\.|\[\s*['"])\s*(?:cp|cpSync|rename|renameSync|copyFile|copyFileSync)\s*['"]?\s*\]?\s*\(\s*['"`][^'"`]+['"`]\s*,\s*['"`]([^'"`]+)['"`]/g,
  // Codex round 3 Finding 6 (P2): fs.rm/rmSync/mkdir/mkdirSync/unlink/
  // unlinkSync/rmdir/rmdirSync — single-arg PATH is the target.
  /(?:\.|\[\s*['"])\s*(?:rm|rmSync|mkdir|mkdirSync|unlink|unlinkSync|rmdir|rmdirSync|truncate|truncateSync)\s*['"]?\s*\]?\s*\(\s*['"`]([^'"`]+)['"`]/g,
  // Codex round 3 Finding 6 supplemental: bare-`fs.cp(` form via
  // destructured `const {cp} = require('fs')`. Match `cp(SRC, DEST,...)`
  // when the call is preceded by whitespace/start so we don't false-match
  // arbitrary `cp` identifiers — best-effort, conservative on FN.
  /(?:^|[\s;{(=>])(?:cp|cpSync|rename|renameSync|copyFile|copyFileSync)\s*\(\s*['"`][^'"`]+['"`]\s*,\s*['"`]([^'"`]+)['"`]/g,
  /(?:^|[\s;{(=>])(?:rm|rmSync|mkdir|mkdirSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(\s*['"`]([^'"`]+)['"`]/g,
];

const PYTHON_WRITE_PATTERNS: RegExp[] = [
  // open(PATH, 'w' | 'a' | 'wb' | 'ab' | ...) — match the path arg
  // (group 1) only when followed by a comma + a write mode literal.
  /open\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][wa][b+]?['"]/g,
  // Path(...).write_text() / .write_bytes() — pathlib forms.
  /Path\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*write_(?:text|bytes)/g,
  // shutil.copy / shutil.move / os.rename — the SECOND arg is the
  // destination, which is the write target.
  /(?:shutil\.copy(?:2|file)?|shutil\.move|os\.rename)\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/g,
  // Codex round 3 Finding 7 (P2): os.open with O_WRONLY/O_RDWR/O_APPEND/
  // O_CREAT/O_TRUNC — POSIX-level open with a write flag.
  /os\.open\s*\(\s*['"]([^'"]+)['"]\s*,\s*[^)]*O_(?:WRONLY|RDWR|APPEND|CREAT|TRUNC)/g,
  // Codex round 3 Finding 7 (P2): shutil.rmtree(PATH) — recursive delete.
  /shutil\.rmtree\s*\(\s*['"]([^'"]+)['"]/g,
  // Codex round 3 Finding 5 (P1) supplemental: subprocess.* with argv
  // list AND stdout=open(PATH, 'w'|'a'). The argv form doesn't shell-out
  // but the redirect TARGET is a write. Capture the PATH.
  /subprocess\.(?:run|call|check_call|check_output|Popen)\s*\([^)]*stdout\s*=\s*open\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][wa][b+]?['"]/g,
  // Codex round 3 Finding 6 supplemental for python: os.unlink/remove,
  // os.rmdir, os.removedirs — single-arg destructive.
  /os\.(?:unlink|remove|rmdir|removedirs)\s*\(\s*['"]([^'"]+)['"]/g,
  // Codex round 4 Finding 6: Pathlib forms.
  // Path('FILE').touch() — creates file.
  // Path('FILE').unlink() — deletes file.
  // Path('DIR').rmdir()  — deletes empty dir.
  // Path('FILE').rename('OTHER') / replace('OTHER') — destination capture.
  /Path\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*(?:touch|unlink|rmdir)/g,
  // Path('SRC').rename('DEST') / .replace('DEST') — second arg is dest.
  /Path\s*\(\s*['"][^'"]+['"]\s*\)\s*\.\s*(?:rename|replace)\s*\(\s*['"]([^'"]+)['"]/g,
];

const RUBY_WRITE_PATTERNS: RegExp[] = [
  // File.write(PATH, ...) — parens form, with quote class.
  // Codex round 1 F-11: also accept parens-less `File.write 'PATH', 'X'`
  // (Ruby idiom). Match either `(` or whitespace before the path arg.
  /File\s*\.\s*(?:write|binwrite|open)\s*[(\s]\s*['"]([^'"]+)['"](?:\s*,\s*['"][wa][b+]?['"])?/g,
  /IO\s*\.\s*(?:write|binwrite)\s*[(\s]\s*['"]([^'"]+)['"]/g,
  // Codex round 3 Finding 8 (P2): Pathname#write — `Pathname.new(PATH).write(...)`.
  /Pathname\s*\.\s*new\s*\(\s*['"]([^'"]+)['"]\s*\)\s*\.\s*(?:write|binwrite|open)/g,
  // Codex round 3 Finding 8 (P2): FileUtils.cp/mv/cp_r/copy/move/copy_file/rename
  // — the SECOND arg is the destination.
  /FileUtils\s*\.\s*(?:cp|mv|cp_r|copy|move|copy_file|rename|cp_lr|install)\s*[(\s]\s*['"][^'"]*['"]\s*,\s*['"]([^'"]+)['"]/g,
  // Codex round 3 Finding 8 supplemental: FileUtils.rm/rm_r/rm_rf/remove/
  // remove_file/remove_dir/mkdir/mkdir_p — single-arg destructive.
  /FileUtils\s*\.\s*(?:rm|rm_r|rm_rf|remove|remove_file|remove_dir|mkdir|mkdir_p|touch)\s*[(\s]\s*['"]([^'"]+)['"]/g,
  // Codex round 4 Finding 6: Ruby File-class destructive forms.
  // File.delete / File.unlink / File.rmdir — single arg destructive.
  /File\s*\.\s*(?:delete|unlink|rmdir)\s*\(\s*['"]([^'"]+)['"]/g,
  // File.rename(SRC, DEST) — DEST is the captured destination write.
  /File\s*\.\s*rename\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/g,
  // Bare `open('FILE', 'w')` (no module prefix). Anchor with not-dot
  // and not-word so `IO.open` and `File.open` don't double-match.
  /(?:^|[^.\w])open\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][wa][b+]?['"]/g,
];

const PERL_WRITE_PATTERNS: RegExp[] = [
  // open(FH, '>FILE') / open(FH, '>>FILE') / open(FH, '>:utf8', 'FILE')
  // — capture the trailing filename.
  /open\s*\([^,)]+,\s*["'][>+]+(?::[^"']*)?["']\s*,\s*["']([^"']+)["']/g,
  /open\s*\([^,)]+,\s*["'][>+]+\s*([^"']+)["']/g,
  // Codex round 4 Finding 6: perl `unlink "FILE"` / `unlink("FILE")` —
  // bare unlink (no module prefix). Anchor on word-break to skip
  // accidental matches inside identifiers.
  /(?:^|[^.\w])unlink\s*\(?\s*["']([^"']+)["']/g,
  // perl `rename "SRC", "DEST"` — DEST is the captured destination.
  /(?:^|[^.\w])rename\s*\(?\s*["'][^"']+["']\s*,\s*["']([^"']+)["']/g,
];

// Codex round 11 F11-7: PHP write-call patterns. PHP's `php -r CODE`
// path takes a single string of PHP source. Catch the canonical
// filesystem-mutation API surface:
//   - unlink('PATH')                  — delete file
//   - file_put_contents('PATH', ...)  — create / overwrite file
//   - rename('SRC', 'DEST')           — move (DEST is the write)
//   - copy('SRC', 'DEST')             — copy (DEST is the write)
//   - move_uploaded_file('SRC','DEST')— move (DEST is the write)
//   - fopen('PATH', 'w' | 'a' | 'x' | 'c' | 'w+' | 'a+' | 'x+' | 'c+')
//   - mkdir('PATH'), rmdir('PATH'), touch('PATH')
//   - chmod('PATH', ...), chown('PATH', ...), chgrp('PATH', ...)
//   - symlink(SRC, DEST), link(SRC, DEST) — DEST is the write
//
// Codex round 12 F12-1 + F12-2 (P0): two splits applied for parity
// with previously-applied cumulative discipline:
//
//   - F12-1: `rename(SRC, DEST)` is mv-shaped. Round-4 F3 established
//     that mv-shape source-side is ALSO destructive (the file is
//     removed at SRC). Pre-fix `rename` was bundled with `copy` /
//     `move_uploaded_file` / `symlink` / `link`, which are ALL
//     destination-only writes — only the second arg was emitted.
//     `php -r "rename('.rea/HALT','.rea/HALT.bak');"` slipped past:
//     the SRC `.rea/HALT` was never emitted. We split rename out and
//     emit BOTH SRC (isDestructive: true via the matched-destructive
//     token list) AND DEST.
//
//   - F12-2: `rmdir(PATH)` is destructive (the directory is removed).
//     Pre-fix it was bundled with `mkdir` / `touch` (non-destructive
//     creates), so the matched-destructive token did not catch the
//     emitted PATH and protected-ancestry never matched against
//     `.rea/HALT` under `.rea/`. Split rmdir out so its captured PATH
//     carries isDestructive: true through the DESTRUCTIVE_API_TOKENS
//     list (we already include `rmdir` and `.rmdir` there, but the
//     PHP-form token must be recognized inside the captured `rmdir(`
//     substring; see DESTRUCTIVE_API_TOKENS additions below).
const PHP_WRITE_PATTERNS: RegExp[] = [
  // unlink('PATH')
  /unlink\s*\(\s*['"]([^'"]+)['"]/g,
  // file_put_contents('PATH', ...)
  /file_put_contents\s*\(\s*['"]([^'"]+)['"]/g,
  // F12-1: rename SOURCE — first arg is destructive (file removed).
  /rename\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][^'"]+['"]/g,
  // F12-1: rename DEST (second arg). Split out from the merged
  // multi-API regex so the SRC variant above can fire independently.
  /rename\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/g,
  // copy / move_uploaded_file / symlink / link — DEST is the SECOND
  // arg only (SRC is read-only or refers to an existing pathname
  // whose own writeability isn't a policy concern here).
  /(?:copy|move_uploaded_file|symlink|link)\s*\(\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/g,
  // fopen('PATH', 'w'|'a'|'x'|'c'|'w+'|'a+'|'x+'|'c+'|'wb'|'ab'|'xb'|'cb'…)
  /fopen\s*\(\s*['"]([^'"]+)['"]\s*,\s*['"][wxac][b+]?\+?['"]/g,
  // F12-2: rmdir — DESTRUCTIVE (directory removed). Split from the
  // mkdir/touch grouping so the captured substring contains the
  // standalone `rmdir(` token, which DESTRUCTIVE_API_TOKENS recognizes
  // and plumbs isDestructive: true through to the emitted detection.
  /rmdir\s*\(\s*['"]([^'"]+)['"]/g,
  // mkdir / touch — single-arg path. Non-destructive create / update;
  // policy-relevant for protected paths but not protected-ancestry-
  // expanding.
  /(?:mkdir|touch)\s*\(\s*['"]([^'"]+)['"]/g,
  // chmod / chown / chgrp — first arg is path.
  /(?:chmod|chown|chgrp)\s*\(\s*['"]([^'"]+)['"]/g,
];

// Patterns that signal a write whose first arg is dynamically-built
// — `open('.rea/' + 'HALT', 'w')`, `open(f'.rea/{x}', 'w')`,
// `open('.rea/%s' % 'HALT', 'w')`, ``fs.writeFileSync(`${a}/${b}`, …)``.
// When any match fires we emit a `dynamic: true` detection — the
// compositor blocks dynamic targets unconditionally. Codex round 1
// F-10 (python concat / f-string / `%`).
const PYTHON_DYNAMIC_WRITE_PATTERNS: readonly RegExp[] = [
  // f-string first arg.
  /open\s*\(\s*[fbru]+\s*['"][^'"]*\{[^}]*\}[^'"]*['"]\s*,\s*['"][wa][b+]?['"]/g,
  // string concat first arg.
  /open\s*\(\s*['"][^'"]*['"]\s*\+/g,
  // `%` formatting first arg.
  /open\s*\(\s*['"][^'"]*%[sdrf][^'"]*['"]\s*%\s*/g,
  // .format(...) first arg.
  /open\s*\(\s*['"][^'"]*['"]\s*\.\s*format\s*\(/g,
];
const NODE_DYNAMIC_WRITE_PATTERNS: readonly RegExp[] = [
  // Template literal with ${} expansion in first arg.
  /(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|openSync|open)\s*\(\s*`[^`]*\$\{/g,
  // Concat in first arg.
  /(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|openSync|open)\s*\(\s*['"][^'"]*['"]\s*\+/g,
];
const RUBY_DYNAMIC_WRITE_PATTERNS: readonly RegExp[] = [
  // String interpolation `"#{x}"` in first arg.
  /File\s*\.\s*(?:write|binwrite|open)\s*[(\s]\s*"[^"]*#\{/g,
];

// Shell-out patterns that capture the inner shell command for re-parse.
// Codex round 1 F-12 (perl qx, awk system, awk print).
// Each pattern's group 1 is the inner shell source; we re-parse it as
// bash and walk for writes. False positives are limited to legit qx()
// calls whose payloads happen to look like writes — fine for security.
const PERL_SHELL_OUT_RE: RegExp[] = [
  // qx(...) or qx{...} — backtick-equivalent.
  /qx\s*[({]\s*([^)}]+)\s*[)}]/g,
  // backtick `cmd`.
  /`([^`]+)`/g,
  // `system "cmd"` / `system 'cmd'` — single-arg shell form.
  /system\s*\(?\s*["']([^"']+)["']\s*\)?/g,
  // Codex round 4 Finding 5: perl exec("cmd") — like system but does
  // not return; canonical shell-out.
  /\bexec\s*\(\s*["']([^"']+)["']\s*\)/g,
  // perl `open(F, "|-", "cmd")` (pipe-open with explicit args form).
  // The third arg is the command. Capture it.
  /\bopen\s*\([^,]+,\s*["'][|+\-]+["']\s*,\s*["']([^"']+)["']/g,
  // perl `open(F, "| cmd")` / `open(F, "cmd |")` — pipe-open shorthand.
  /\bopen\s*\([^,]+,\s*["']\s*[|]\s*([^"']+?)["']/g,
  /\bopen\s*\([^,]+,\s*["']([^"']+?)\s*[|]\s*["']/g,
  // Codex round 5 F3 (P1): quote-aware variants.
  /\bsystem\s*\(?\s*(["'])((?:(?!\1)[^\\]|\\.)+)\1\s*\)?/g,
  /\bexec\s*\(\s*(["'])((?:(?!\1)[^\\]|\\.)+)\1\s*\)/g,
];
const RUBY_SHELL_OUT_RE: RegExp[] = [
  // `cmd` backtick form.
  /`([^`]+)`/g,
  // %x{cmd} / %x(cmd).
  /%x\s*[{(]\s*([^})]+)\s*[})]/g,
  // system 'cmd' / system "cmd" — single-arg. Anchor with start-of-
  // word boundary OR Kernel. so `Kernel.system("cmd")` is captured.
  /(?:^|[\s;])system\s*\(?\s*["']([^"']+)["']\s*\)?/g,
  // Codex round 4 Finding 5: Kernel.system / Kernel.exec / Kernel.spawn /
  // Kernel.`(cmd)` — explicit module-method calls.
  /Kernel\s*\.\s*(?:system|exec|spawn)\s*\(\s*["']([^"']+)["']/g,
  // Kernel.exec / Kernel.spawn — same shape, also raw bare form.
  /(?:Kernel\s*\.\s*)?(?:exec|spawn)\s*\(?\s*["']([^"']+)["']\s*\)?/g,
  // Codex round 4 Finding 5: Open3 module — capture3 / popen3 / pipeline.
  // First positional is the command string when invoked with a single
  // string arg; argv-form is structurally fine (we don't shell-out then).
  /Open3\s*\.\s*(?:capture[23]?|popen[23]?|capture2e|popen2e|pipeline\w*)\s*\(\s*["']([^"']+)["']/g,
  // Codex round 4 Finding 5: IO.popen("cmd") — popen with shell string.
  /IO\s*\.\s*popen\s*\(\s*["']([^"']+)["']/g,
  // Codex round 5 F3 (P1): quote-aware variants for mixed-quote nesting.
  // The outer host quote opens; the body may contain the OTHER quote
  // unescaped. Backref `\1` matches the same opener. The body skips
  // the same-quote char and consumes escape sequences (`\\.`) literally.
  // Examples:
  //   Kernel.system('rm "foo"')   — body `rm "foo"` — outer is SQ.
  //   Kernel.system("rm 'foo'")   — body `rm 'foo'` — outer is DQ.
  /Kernel\s*\.\s*(?:system|exec|spawn)\s*\(\s*(["'])((?:(?!\1)[^\\]|\\.)+)\1/g,
  /(?:Kernel\s*\.\s*)?(?:exec|spawn)\s*\(?\s*(["'])((?:(?!\1)[^\\]|\\.)+)\1/g,
  /(?:^|[\s;])system\s*\(?\s*(["'])((?:(?!\1)[^\\]|\\.)+)\1/g,
  /Open3\s*\.\s*(?:capture[23]?|popen[23]?|capture2e|popen2e|pipeline\w*)\s*\(\s*(["'])((?:(?!\1)[^\\]|\\.)+)\1/g,
  /IO\s*\.\s*popen\s*\(\s*(["'])((?:(?!\1)[^\\]|\\.)+)\1/g,
];
const PYTHON_SHELL_OUT_RE: RegExp[] = [
  // os.system('cmd').
  /os\.system\s*\(\s*["']([^"']+)["']\s*\)/g,
  // os.popen('cmd', 'w' | 'r') — popen returns a file object; with mode
  // 'w' the calling code WRITES to it, but the cmd itself is a shell
  // string. Re-parse the captured cmd.
  /os\.popen\s*\(\s*["']([^"']+)["']/g,
  // Codex round 4 Finding 5: pty.spawn(["bash","-c","cmd"]) — pty
  // module shell-out form.
  /pty\s*\.\s*spawn\s*\(\s*\[\s*["'](?:bash|sh|zsh|dash|ksh)["']\s*,\s*["']-c["']\s*,\s*["']([^"']+)["']/g,
  // Codex round 3 Finding 5 (P1): subprocess.* with shell=True is the
  // canonical Python shell-out. The COMMAND is the first arg as a
  // string; re-parse it. This catches:
  //   subprocess.run('cmd', shell=True)
  //   subprocess.call('cmd', shell=True)
  //   subprocess.check_call('cmd', shell=True)
  //   subprocess.check_output('cmd', shell=True)
  //   subprocess.Popen('cmd', shell=True)
  // We require shell=True ANYWHERE in the call (between first arg and
  // closing paren) — otherwise the first arg is an argv list and isn't
  // re-parseable as shell. Pattern: capture string, then look ahead for
  // shell=True before a closing `)`.
  /subprocess\.(?:run|call|check_call|check_output|Popen)\s*\(\s*["']([^"']+)["'][^)]*shell\s*=\s*True/g,
  // Codex round 5 F3 (P1): quote-aware variants for mixed-quote nesting.
  //   os.system('rm "foo"')   /  os.system("rm 'foo'")
  //   subprocess.run('rm "foo"', shell=True) etc.
  /os\.system\s*\(\s*(["'])((?:(?!\1)[^\\]|\\.)+)\1\s*\)/g,
  /os\.popen\s*\(\s*(["'])((?:(?!\1)[^\\]|\\.)+)\1/g,
  /subprocess\.(?:run|call|check_call|check_output|Popen)\s*\(\s*(["'])((?:(?!\1)[^\\]|\\.)+)\1[^)]*shell\s*=\s*True/g,
];
const NODE_SHELL_OUT_RE: RegExp[] = [
  // require('child_process').execSync('cmd') / .exec('cmd') / .spawnSync.
  /(?:execSync|exec|spawnSync|spawn)\s*\(\s*['"`]([^'"`]+)['"`]/g,
  // Codex round 4 Finding 5: spawn / spawnSync / execFile / execFileSync
  // with shell argv form: `spawn("bash", ["-c", "cmd"])`. Capture the
  // shell-payload string (third inner element).
  /(?:spawnSync|spawn|execFile|execFileSync)\s*\(\s*['"](?:bash|sh|zsh|dash|ksh)['"]\s*,\s*\[\s*['"]-c['"]\s*,\s*['"`]([^'"`]+)['"`]/g,
  // Codex round 4 Finding 5: child_process.fork('bash', [...]) — rare
  // but canonical. Treat the shell-payload form the same.
  /fork\s*\(\s*['"](?:bash|sh|zsh)['"]\s*,\s*\[\s*['"]-c['"]\s*,\s*['"`]([^'"`]+)['"`]/g,
  // Codex round 5 F3 (P1): quote-aware variants for mixed-quote nesting.
  //   execSync(`rm '.rea/HALT'`) (host-backtick + inner-SQ)
  //   execSync('rm ".rea/HALT"') (host-SQ + inner-DQ)
  //   execSync("rm '.rea/HALT'") (host-DQ + inner-SQ)
  // Backref `\1` matches the same opener.
  /(?:execSync|exec|spawnSync|spawn)\s*\(\s*(['"`])((?:(?!\1)[^\\]|\\.)+)\1/g,
];

// Codex round 12 F12-3 (P0): PHP shell-out patterns. Mirrors the
// shape of PERL_SHELL_OUT_RE / PYTHON_SHELL_OUT_RE / RUBY_SHELL_OUT_RE.
// Pre-fix `php -r 'system("rm .rea/HALT");'` slipped past entirely —
// the PHP eval-flag scanner had no shell-out pattern table, so the
// captured-substring re-parse seam never fired and the `rm` never
// reached the bash walker.
//
// Captured shell payload (group 1) is re-parsed by parseBashCommand
// and walked via `recurseInnerArgv`-like dispatch in
// `scanInterpreterSource`. Group 1 is the inner shell command.
//
// The regex shape uses the same quote-aware backref pattern as the
// round-5 F3 (P1) variants for the other languages: outer host quote
// opens, inner body may contain the OTHER quote unescaped, backref
// `\1` matches the same opener.
const PHP_SHELL_OUT_RE: RegExp[] = [
  // system("cmd") / system('cmd')
  /\bsystem\s*\(\s*(["'])((?:(?!\1)[^\\]|\\.)+)\1/g,
  // exec("cmd") — single-arg shell form (PHP exec captures stdout but
  // still execs cmd via /bin/sh).
  /\bexec\s*\(\s*(["'])((?:(?!\1)[^\\]|\\.)+)\1/g,
  // shell_exec("cmd")
  /\bshell_exec\s*\(\s*(["'])((?:(?!\1)[^\\]|\\.)+)\1/g,
  // passthru("cmd")
  /\bpassthru\s*\(\s*(["'])((?:(?!\1)[^\\]|\\.)+)\1/g,
  // popen("cmd", "r"|"w") — first arg is the shell command.
  /\bpopen\s*\(\s*(["'])((?:(?!\1)[^\\]|\\.)+)\1/g,
  // proc_open("cmd", $descriptors, $pipes) — first arg is the
  // command. proc_open accepts an array form too (no shell exec) but
  // a string-form is canonical shell-out.
  /\bproc_open\s*\(\s*(["'])((?:(?!\1)[^\\]|\\.)+)\1/g,
  // Backtick operator — PHP backtick `cmd` is shell_exec(cmd).
  /`([^`]+)`/g,
];

/**
 * Codex round 10 — structural wrapper-shell-exec guard.
 *
 * Closes the wrapper-class bypass STRUCTURALLY rather than by
 * enumerating every wrapper one at a time. Runs in the `default:`
 * case of `walkCallExpr`, i.e. only when the head (after
 * `stripEnvAndModifiers` + `normalizeCmdHead`) is NOT in the
 * dispatcher's known-utility allow-list.
 *
 * The bypass shape is:
 *
 *   `<UNRECOGNIZED-HEAD> [...flags...] <KNOWN-SHELL> -c PAYLOAD`
 *
 * For example: `chronic bash -c "rm .rea/HALT"`,
 * `parallel sh -c "rm {}" ::: target`,
 * `dbus-launch --exit-with-session bash -c "rm .rea/HALT"`,
 * or a hypothetical future wrapper `xfooblar bash -c PAYLOAD`. The
 * wrapper itself is transparent — it forks/execs the shell — but
 * `stripEnvAndModifiers` only strips wrappers in its explicit
 * allow-list. Without enumeration, the head-dispatch falls through
 * to `default:` and the inner `bash -c PAYLOAD` is never re-parsed.
 *
 * Round 9's mitigation enumerated 21 wrappers; round 10 surfaced 5
 * more (chronic, parallel, watch, script, dbus-launch). The
 * enumeration approach has unbounded tail — every future wrapper
 * (`expect`, `dtruss`, `xtrace`, `eatmydata`, ...) is another
 * round. This guard closes the class regardless of the wrapper's
 * identity by doing a SECOND structural pass:
 *
 *   1. If head is a known introspection / output utility (echo,
 *      printf, man, which, type, ...), DO NOT fire — those take
 *      command names as DATA, not as exec targets. False positive
 *      otherwise: `echo bash -c hello` would block.
 *   2. Walk argv looking for the FIRST token whose
 *      `normalizeCmdHead` value is a known POSIX/extended shell
 *      (bash/sh/zsh/dash/ksh/ash/mksh/yash/posh/rc).
 *   3. If found, look ahead up to 3 tokens for a `-c`-style flag
 *      cluster (`-c`, `-lc`, `-cl`, `-ic`, ...). The 3-token window
 *      bounds false-positive risk: real wrappers' flags don't sit
 *      between the shell name and `-c`. Real flag-bearing wrappers
 *      put their flags BEFORE the shell, not after.
 *   4. If `-c`-style flag found within window, the next argv token
 *      is the PAYLOAD — synthesize a `[shell, -c, PAYLOAD, ...]`
 *      slice and dispatch through `detectNestedShell` (which
 *      handles dynamic-payload refuse-on-uncertainty already).
 *   5. If shell token is present but NO `-c`-style flag follows,
 *      the bare shell reads from stdin — refuse on uncertainty by
 *      emitting a synthetic dynamic write at the shell-token
 *      position. Bypasses we'd miss include shell-implicit-stdin
 *      forms `<wrapper> bash` (rare but possible — a daemon that
 *      pipes a script in and execs `bash`); failing closed here is
 *      cheap.
 *
 * Coordination with the head-is-shell path: when `head === 'bash'`
 * (etc.), the existing dispatcher case directly calls
 * `detectNestedShell(stripped, out)`. The structural guard runs
 * ONLY in `default:` (unrecognized head), so there is no double
 * detection.
 *
 * False-positive negatives accepted:
 *   - `bash --some-pre-flag -c PAYLOAD` (head IS bash → dispatcher
 *     handles it; the structural guard never fires)
 *   - `chronic bash --some-flag -c PAYLOAD` — `bash` at idx 1, but
 *     `-c` at idx 3 (window=2 tokens after shell). Within our
 *     3-token window. PASS.
 *   - `chronic bash -- -c PAYLOAD` — `bash` at idx 1, `--` at idx
 *     2, `-c` at idx 3. Caught.
 *
 * False-positive avoidance:
 *   - `man bash`, `which bash`, `whatis bash`, `apropos bash`:
 *     introspection — early return.
 *   - `echo bash`, `printf "bash"`: text output — early return.
 *   - `type bash`, `command -v bash`: shell builtin probes — early
 *     return.
 *   - `help bash` (bash builtin): early return.
 *   - `alias bash=sh`: alias definition — early return on `alias`
 *     head.
 *
 * Note: `command bash -c PAYLOAD` is NOT caught here because
 * `command` is already stripped by `stripEnvAndModifiers` (the
 * inner `bash` becomes the head). That goes through the
 * dispatcher's `bash` case directly.
 */

/**
 * Heads that take other-command names as DATA, not as exec
 * targets. Skip the structural guard when the head is one of
 * these. The list is deliberately small — every entry needs
 * justification, since adding a head here is a defense-disabling
 * step.
 *
 * Entries (basename-normalized via `normalizeCmdHead` at lookup
 * time):
 *   - `echo`, `printf`: output utilities
 *   - `man`, `info`, `apropos`, `whatis`: manuals
 *   - `which`, `type`, `whence`, `where`, `whereis`: path lookup
 *     (note: `command -v X` has head `command`, which is already
 *     stripped by `stripEnvAndModifiers`; no entry needed here)
 *   - `help`: bash builtin help
 *   - `alias`, `unalias`: alias definitions take cmd-name strings
 *     as VALUE
 *   - `compgen`, `complete`, `compopt`: bash completion utilities
 */
const STRUCTURAL_GUARD_INTROSPECTION_HEADS: ReadonlySet<string> = new Set([
  'echo',
  'printf',
  'man',
  'info',
  'apropos',
  'whatis',
  'which',
  'type',
  'whence',
  'where',
  'whereis',
  'help',
  'alias',
  'unalias',
  'compgen',
  'complete',
  'compopt',
]);

/**
 * Known POSIX + extended shells the structural guard recognizes
 * as the "shell positional" inside an unrecognized-wrapper argv.
 * Mirrors the dispatcher's bash-case set so the guard catches the
 * same shells `detectNestedShell` would handle.
 */
const STRUCTURAL_GUARD_KNOWN_SHELLS: ReadonlySet<string> = new Set([
  'bash',
  'sh',
  'zsh',
  'dash',
  'ksh',
  'ash',
  'mksh',
  'yash',
  'posh',
  'rc',
]);

/**
 * Maximum number of argv tokens to scan after a shell positional
 * looking for a `-c`-style flag. Bounds false-positive risk: real
 * wrappers don't put their flags BETWEEN the shell name and the
 * shell's own `-c` flag. Three is comfortable for `bash --rcfile
 * F -c P` (3-token gap) without admitting genuinely unrelated
 * shapes.
 */
const STRUCTURAL_GUARD_LOOKAHEAD = 3;

/**
 * Codex round 10 — structural wrapper-shell-exec guard. See class
 * TSDoc above. Runs in `walkCallExpr`'s `default:` case (head not
 * dispatched). Synthesizes a `[shell, -c, PAYLOAD, ...]` slice and
 * delegates to `detectNestedShell` so dynamic-payload refusal is
 * shared.
 *
 * Returns true if it emitted a detection (so the caller can decide
 * to skip further fallback work). Currently the dispatcher's
 * `default:` does no further work, so the boolean is informational.
 */
function detectWrappedNestedShell(argv: WordValue[], out: DetectedWrite[]): boolean {
  if (argv.length < 2) return false;
  const head = argv[0];
  if (head === undefined) return false;
  // False-positive guard: introspection/output heads take other
  // command names as DATA, not as exec targets. Skip the guard.
  const headName = normalizeCmdHead(head.value);
  if (STRUCTURAL_GUARD_INTROSPECTION_HEADS.has(headName)) return false;
  // If the head is itself a known shell, the dispatcher's bash-case
  // already handled this argv via `detectNestedShell`. Don't
  // double-detect.
  if (STRUCTURAL_GUARD_KNOWN_SHELLS.has(headName)) return false;
  // Secondary false-positive guard: when argv[1] is an introspection
  // head, the entire argv likely represents introspection-with-data
  // (`xfooblar echo bash`, `xfooblar printf "%s\n" bash`,
  // `xfooblar man bash`). Without this guard, the shell-token at
  // argv[2]+ would trip the dynamic-refuse path. Real wrappers
  // forking/exec'ing a shell put the SHELL FIRST in their post-flag
  // argv, not after an introspection utility.
  const arg1 = argv[1];
  if (arg1 !== undefined && !arg1.dynamic) {
    const arg1Name = normalizeCmdHead(arg1.value);
    if (STRUCTURAL_GUARD_INTROSPECTION_HEADS.has(arg1Name)) return false;
  }

  // Walk argv from index 1 looking for the FIRST shell positional.
  // We stop at the first match so we don't double-emit on
  // pathological forms like `chronic bash sh -c PAYLOAD`.
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;
    if (tok.dynamic) {
      // A dynamic token in the wrapper-flag region — we cannot
      // statically resolve where the inner command starts. Don't
      // fire (the dispatcher's existing dynamic handling already
      // refuses elsewhere when relevant). Conservative skip.
      continue;
    }
    const tokName = normalizeCmdHead(tok.value);
    if (!STRUCTURAL_GUARD_KNOWN_SHELLS.has(tokName)) continue;

    // Found a shell positional at index i. Look ahead within window
    // for a `-c`-style flag cluster. The cluster regex matches the
    // same shape `detectNestedShellInner` accepts: starts with a
    // single dash, length >= 2, contains the letter `c`, NOT `--`-
    // prefixed.
    const windowEnd = Math.min(i + 1 + STRUCTURAL_GUARD_LOOKAHEAD, argv.length);
    let dashCIdx = -1;
    for (let j = i + 1; j < windowEnd; j += 1) {
      const ftok = argv[j];
      if (ftok === undefined) continue;
      if (ftok.dynamic) {
        // Dynamic flag region — refuse on uncertainty. We don't
        // know if it's `-c` or something else. Treat as found-but-
        // unresolvable and emit dynamic.
        out.push({
          path: '',
          form: 'nested_shell_inner',
          position: ftok.position,
          dynamic: true,
        });
        return true;
      }
      const fv = ftok.value;
      // Skip `--` POSIX option-end marker — bash accepts `bash -- -c
      // PAYLOAD` as a malformed but real shape; we accept it so
      // attackers can't insert a `--` to dodge us.
      if (fv === '--') continue;
      const isClusterWithC =
        fv.startsWith('-') && !fv.startsWith('--') && fv.length >= 2 && fv.slice(1).includes('c');
      if (isClusterWithC) {
        dashCIdx = j;
        break;
      }
    }

    if (dashCIdx < 0) {
      // Shell positional without `-c` flag in the window. Two
      // sub-cases:
      //   a) Bare shell reads stdin (`<wrapper> bash`): refuse on
      //      uncertainty — we cannot resolve stdin statically.
      //   b) Shell with `-c` past the lookahead window: also
      //      refuse — out-of-window means our static analysis
      //      can't be confident.
      // Either way, fail closed by emitting a dynamic write at the
      // shell-token position. The compositor's blocker treats
      // dynamic targets as blocking under protected-mode policy.
      out.push({
        path: '',
        form: 'nested_shell_inner',
        position: tok.position,
        dynamic: true,
      });
      return true;
    }

    // Synthesize a `[shell, -c, PAYLOAD, ...rest]` argv and
    // dispatch through detectNestedShell. Pre-fix the synthesis
    // here we keep the ORIGINAL `-c` token (so `-lc`, `-ic`, etc.
    // all flow through the same payload-extraction logic in
    // detectNestedShellInner). Anything between the shell and
    // `-c` (--rcfile etc.) is dropped from the synthesized argv;
    // it never affects payload semantics.
    const shellTok: WordValue = {
      value: tokName, // basename-normalized so detectNestedShell sees `bash` not `/bin/bash`
      dynamic: false,
      position: tok.position,
    };
    const dashCTok = argv[dashCIdx];
    if (dashCTok === undefined) return false;
    const synth: WordValue[] = [shellTok, dashCTok, ...argv.slice(dashCIdx + 1)];
    detectNestedShell(synth, out);
    return true;
  }

  return false;
}

/**
 * Nested shell `bash -c PAYLOAD` / `sh -c PAYLOAD` detector.
 * Re-parse the payload and walk it. Recursive — payload can itself
 * contain `bash -c ...`, which gets unwrapped to fixed point with
 * a depth cap of 8 (helix-022 #3).
 *
 * Honors `CURRENT_NESTED_DEPTH` so re-entries from `walkInnerWithDepth`
 * count toward the cap.
 */
function detectNestedShell(argv: WordValue[], out: DetectedWrite[]): void {
  detectNestedShellInner(argv, out, CURRENT_NESTED_DEPTH);
}

const NESTED_SHELL_DEPTH_CAP = 8;

function detectNestedShellInner(argv: WordValue[], out: DetectedWrite[], depth: number): void {
  if (depth >= NESTED_SHELL_DEPTH_CAP) {
    // Past depth cap — refuse on uncertainty by emitting a synthetic
    // dynamic detection. The compositor blocks this with a clear
    // reason.
    const pos = argv[0]?.position ?? { line: 0, col: 0 };
    out.push({
      path: '',
      form: 'nested_shell_inner',
      position: pos,
      dynamic: true,
    });
    return;
  }
  // Find -c / -lc payload. Codex round 1 F-13: any short-flag cluster
  // containing `c` (single dash, multi-char) takes the next argv as
  // the payload — `bash -ic`, `bash -lic`, `bash -cl`, `bash -cli`,
  // `sh -ic`, etc.
  for (let i = 1; i < argv.length; i += 1) {
    const tok = argv[i];
    if (tok === undefined) continue;
    const v = tok.value;
    const isClusterWithC =
      v.startsWith('-') && !v.startsWith('--') && v.length >= 2 && v.slice(1).includes('c');
    if (isClusterWithC) {
      const payload = argv[i + 1];
      if (payload === undefined) return;
      if (payload.dynamic) {
        // Payload is a $VAR / `cmd` — refuse on uncertainty.
        out.push({
          path: '',
          form: 'nested_shell_inner',
          position: payload.position,
          dynamic: true,
        });
        return;
      }
      // Pre-strip shell-level escapes — when the outer DQ surrounded
      // the payload, escape sequences `\"` `\\` `\$` `\`` `\\n` are
      // collapsed by the shell before bash sees the inner. mvdan
      // preserves the literal in the AST, so we collapse here before
      // re-parsing. This is the helix-022 #3 nested-shell unwrap fix.
      const innerSource = unshellEscape(payload.value);
      const inner = parseBashCommand(innerSource);
      if (!inner.ok) {
        // Inner parse failed. Treat as unresolvable — refuse.
        out.push({
          path: '',
          form: 'nested_shell_inner',
          position: payload.position,
          dynamic: true,
        });
        return;
      }
      // Walk the inner file. Note that nested-bash can itself contain
      // bash -c, which goes back through detectNestedShell — but with
      // its own depth-tracking we'd lose that. Pass the depth through.
      walkInnerWithDepth(inner.file, out, depth + 1);
      return;
    }
  }
}

function walkInnerWithDepth(file: BashFile, out: DetectedWrite[], depth: number): void {
  // Walk the inner file with a depth-aware variant. We do this by
  // running the standard walk and then re-walking nested-shell ops
  // with an incremented depth — but the std walk already calls
  // detectNestedShellInner, which threads depth via the recursive call.
  // To pass depth through we set a module-level counter; given the
  // single-threaded JS execution model this is safe.
  CURRENT_NESTED_DEPTH = depth;
  try {
    const inner = walkForWrites(file);
    for (const d of inner) out.push(d);
  } finally {
    CURRENT_NESTED_DEPTH = 0;
  }
}

let CURRENT_NESTED_DEPTH = 0;

// 0.23.0 round-6: removed `walkWordForSubstNodes`,
// `walkAssignsForSubstNodes`, `walkTestExpr`. Their entire purpose was
// to manually traverse fields the previous walker dropped — Word.Parts
// embedded ProcSubst/CmdSubst, Assign.Value/Index/Array.Elems[*],
// TestClause UnaryTest/BinaryTest tree leaves. The deny-by-default
// `syntax.Walk()` in `walkForWrites` visits every one of those fields
// exhaustively, so the helpers became dead code. Removing them is the
// structural-class closure: nothing in this file recursively
// re-implements Walk's traversal, so a missed field can no longer
// silently bypass detection.

// ─────────────────────────────────────────────────────────────────────
//  AST helpers
// ─────────────────────────────────────────────────────────────────────

interface WordValue {
  /** The reconstructed string value, with literal parts concatenated. */
  value: string;
  /** True if any part is dynamic ($VAR, `cmd`, $(cmd), etc.). */
  dynamic: boolean;
  position: SourcePosition;
}

/**
 * Reconstruct a Word's string value, marking dynamic if any non-literal
 * WordPart appears (ParamExp, CmdSubst, ArithmExp, ProcSubst, etc.).
 *
 * SglQuoted's Value is the literal content (single quotes block all
 * expansion). DblQuoted has its own Parts list — we recurse into those
 * and concatenate.
 */
function wordToString(word: BashNode): WordValue | null {
  const parts = asArray(word['Parts']);
  if (parts.length === 0) return null;
  let value = '';
  let dynamic = false;
  let firstPos: SourcePosition | null = null;
  for (const p of parts) {
    if (typeof p !== 'object' || p === null) continue;
    const part = p as BashNode;
    if (firstPos === null) {
      firstPos = nodePosition(part);
    }
    const t = nodeType(part);
    switch (t) {
      case 'Lit':
        value += stringifyField(part['Value']);
        break;
      case 'SglQuoted':
        value += stringifyField(part['Value']);
        break;
      case 'DblQuoted': {
        const innerParts = asArray(part['Parts']);
        for (const ip of innerParts) {
          if (typeof ip !== 'object' || ip === null) continue;
          const inner = ip as BashNode;
          const it = nodeType(inner);
          if (it === 'Lit') {
            value += stringifyField(inner['Value']);
          } else {
            // ParamExp / CmdSubst / ArithmExp inside DQ — dynamic.
            dynamic = true;
          }
        }
        break;
      }
      // Nested process substitution as a Word part is dynamic.
      case 'ProcSubst':
      case 'CmdSubst':
      case 'ParamExp':
      case 'ArithmExp':
      case 'ExtGlob':
      case 'BraceExp':
        dynamic = true;
        break;
      default:
        // Unknown part type — be conservative.
        dynamic = true;
        break;
    }
  }
  return { value, dynamic, position: firstPos ?? { line: 0, col: 0 } };
}

function stringifyField(v: unknown): string {
  if (typeof v === 'string') return v;
  return '';
}

function asArray(v: unknown): readonly BashNode[] {
  if (Array.isArray(v)) {
    return v as BashNode[];
  }
  return [];
}

function nodeType(node: BashNode | null | undefined): string {
  if (node === null || node === undefined) return '';
  try {
    return syntax.NodeType(node);
  } catch {
    return '';
  }
}

// 0.23.0 round-6: `isStmt` removed. Pre-refactor it guarded
// `walkStmts` against non-Stmt entries; the new `syntax.Walk()` spine
// in `walkForWrites` switches on `nodeType(...)` directly so the
// dedicated narrowing helper is no longer used.

/**
 * Extract a 1-indexed line/col from a node's `Pos()` field. mvdan-sh
 * exposes positions as objects with `Line()` and `Col()` methods (Go-
 * style).
 */
function nodePosition(node: BashNode): SourcePosition {
  // Go-style: node has a method or field `Pos`.
  const posField = node['Pos'];
  let posObj: unknown = null;
  if (typeof posField === 'function') {
    try {
      posObj = (posField as () => unknown).call(node);
    } catch {
      posObj = null;
    }
  } else if (posField !== undefined) {
    posObj = posField;
  }
  if (posObj && typeof posObj === 'object') {
    const lineFn = (posObj as Record<string, unknown>)['Line'];
    const colFn = (posObj as Record<string, unknown>)['Col'];
    let line = 0;
    let col = 0;
    if (typeof lineFn === 'function') {
      try {
        const l = (lineFn as () => unknown).call(posObj);
        if (typeof l === 'number') line = l;
      } catch {
        /* ignore */
      }
    } else if (typeof lineFn === 'number') {
      line = lineFn;
    }
    if (typeof colFn === 'function') {
      try {
        const c = (colFn as () => unknown).call(posObj);
        if (typeof c === 'number') col = c;
      } catch {
        /* ignore */
      }
    } else if (typeof colFn === 'number') {
      col = colFn;
    }
    return { line, col };
  }
  return { line: 0, col: 0 };
}
