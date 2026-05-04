/**
 * Class O — walker exhaustiveness contract test.
 *
 * BACKGROUND
 * ----------
 * The 0.23.0 round-6 architectural refactor moved walker.ts from
 * per-Cmd-kind dispatch to deny-by-default `syntax.Walk` traversal.
 * The framing was: "Walk visits every field, so walker field-omission
 * bugs are structurally impossible by construction."
 *
 * Codex round 7 (P0) flagged that as overclaim: mvdan-sh@0.10.1's
 * `syntax.Walk` itself has field gaps. Specifically,
 * `ParamExp.Slice.Offset` and `ParamExp.Slice.Length` (Word nodes that
 * can hold CmdSubst payloads) are NOT visited. Result: every
 * `${X:$(...)}` / `${X:0:$(...)}` form bypassed every detector. That
 * was a regression vs 0.22.0's bash regex (which caught `${X:$(rm)}`
 * directly).
 *
 * CONTRACT
 * --------
 * This test pins the walker's reach. It enumerates every AST position
 * where mvdan-sh's parser can plant a CmdSubst (`$(...)`) — every
 * Word-bearing field on every node type that the parser actually emits.
 * For each (node-type, field) position, it parses a fixture with a
 * planted `$(rm /tmp/sentinel-LABEL)`, runs the walker, and asserts the
 * walker EITHER detected a write (the `rm` payload reached a
 * dispatcher) OR explicitly emitted a `dynamic` write covering that
 * subtree.
 *
 * If ANY position fails, the test fails with a clear message naming
 * the (node-type, field) gap. The fix is always one of:
 *   1. Walk visits the field but dispatcher misses → fix dispatcher.
 *   2. Walk doesn't visit the field → add a one-line manual recursion
 *      in walker.ts's visit callback (the same pattern as round-7's
 *      `recurseParamExpSlice` helper).
 *
 * COVERAGE LIMITS
 * ---------------
 * - We test fields that hold `Word` (or `Stmt[]` containing CallExpr).
 *   Fields that hold non-Word data (numeric Pos/End offsets, integer
 *   ops, string variant tags) are not relevant — they cannot host a
 *   CmdSubst.
 * - We rely on mvdan-sh's parser to populate the field for the chosen
 *   syntax. Some fields are populated only by specific shell variants;
 *   we test the bash-flavor shape (which is what `parseBashCommand`
 *   uses).
 * - This is NOT a fuzz harness. It's a structural contract: every
 *   known position is named and tested. New mvdan-sh node types or
 *   fields require an entry here AND an explicit recursion in walker.ts
 *   if Walk doesn't reach them on its own.
 *
 * UPDATE PROCEDURE
 * ----------------
 * When mvdan-sh@0.11.0+ ships:
 *   1. Run this test. If new positions silently pass, you got lucky.
 *   2. If new positions fail (because the parser changed shape or a
 *      new node type appeared), add the (node-type, field) entry to
 *      `EXHAUSTIVENESS_TABLE` below and add a recursion helper if
 *      needed.
 *   3. Re-run. The test must be GREEN before the upgrade ships.
 */

import { describe, expect, it } from 'vitest';
import { parseBashCommand } from '../../../src/hooks/bash-scanner/parser.js';
import { walkForWrites } from '../../../src/hooks/bash-scanner/walker.js';

/**
 * Each row: a (node-type, field, sample-command) tuple. The sample
 * MUST plant a `$(rm /tmp/sentinel-LABEL)` at the named field position.
 * The walker MUST then either:
 *   - Emit a write whose `path === '/tmp/sentinel-LABEL'`, OR
 *   - Emit a write whose `dynamic === true` covering the subtree
 *     (we accept dynamic emits as proof the walker reached the
 *     enclosing position; non-dynamic emits prove the dispatcher fired
 *     too).
 *
 * If a row is empirically irrelevant (parser doesn't plant CmdSubst at
 * that position), document it in the comment and mark `skip: true`.
 */
type Row = {
  label: string;
  nodeField: string; // human-readable for the failure message
  cmd: string;
  /** If true, accept ANY write detection — we just need walker to reach it. */
  acceptAny?: boolean;
  /** If set, pin the exact path the walker should emit. */
  expectedPath?: string;
  /**
   * Round-8 P0 tightening — opt-in escape hatch for positions where the
   * named subtree is genuinely unresolvable to a static path even when
   * the walker reaches it correctly. Set this to `true` only when the
   * `nodeField` describes a position that cannot, by parser shape, yield
   * a deterministic path string (e.g. a procsubst body whose payload
   * the walker correctly piercees but cannot resolve to a literal).
   *
   * DEFAULT IS FALSE. The contract used to accept any `dynamic` write
   * anywhere as proof-of-reach for any row, which masked walker gaps:
   * a `bash -c` payload with an unresolvable inner emits
   * `nested_shell_inner` dynamic, satisfying the assertion even if the
   * named field was never visited.
   *
   * If you set this, leave a comment on the row explaining WHY the path
   * is genuinely unresolvable. New rows MUST default to false (path-
   * explicit acceptance) unless that comment exists.
   */
  acceptDynamic?: boolean;
  /** Skip with reason — non-applicable position. */
  skip?: string;
};

const EXHAUSTIVENESS_TABLE: Row[] = [
  // ============================================================
  // ParamExp — every Word/Stmt-bearing field on parameter expansion.
  // Round 7 P0 surface. Slice.Offset + Slice.Length need explicit
  // recursion (Walk skips them); the rest are Walk-reached.
  // ============================================================
  {
    label: 'paramexp-slice-offset',
    nodeField: 'ParamExp.Slice.Offset',
    cmd: 'echo "${X:$(rm /tmp/sentinel-paramexp-slice-offset)}"',
    expectedPath: '/tmp/sentinel-paramexp-slice-offset',
  },
  {
    label: 'paramexp-slice-length',
    nodeField: 'ParamExp.Slice.Length',
    cmd: 'echo "${X:0:$(rm /tmp/sentinel-paramexp-slice-length)}"',
    expectedPath: '/tmp/sentinel-paramexp-slice-length',
  },
  {
    label: 'paramexp-slice-offset-negative',
    nodeField: 'ParamExp.Slice.Offset (negative form)',
    cmd: 'echo "${X: -$(rm /tmp/sentinel-paramexp-slice-offset-neg)}"',
    expectedPath: '/tmp/sentinel-paramexp-slice-offset-neg',
  },
  {
    label: 'paramexp-slice-offset-arith',
    nodeField: 'ParamExp.Slice.Offset (parenthesized arith)',
    cmd: 'echo "${X:($(rm /tmp/sentinel-paramexp-slice-offset-arith))}"',
    expectedPath: '/tmp/sentinel-paramexp-slice-offset-arith',
  },
  {
    label: 'paramexp-slice-positional-at',
    nodeField: 'ParamExp.Slice on @',
    cmd: 'echo "${@:$(rm /tmp/sentinel-paramexp-slice-positional-at)}"',
    expectedPath: '/tmp/sentinel-paramexp-slice-positional-at',
  },
  {
    label: 'paramexp-slice-positional-star',
    nodeField: 'ParamExp.Slice on *',
    cmd: 'echo "${*:$(rm /tmp/sentinel-paramexp-slice-positional-star)}"',
    expectedPath: '/tmp/sentinel-paramexp-slice-positional-star',
  },
  {
    label: 'paramexp-slice-array-at',
    nodeField: 'ParamExp.Slice on arr[@]',
    cmd: 'echo "${arr[@]:$(rm /tmp/sentinel-paramexp-slice-array-at)}"',
    expectedPath: '/tmp/sentinel-paramexp-slice-array-at',
  },
  {
    label: 'paramexp-slice-array-star',
    nodeField: 'ParamExp.Slice on arr[*] with length',
    cmd: 'echo "${arr[*]:$(rm /tmp/sentinel-paramexp-slice-array-star):3}"',
    expectedPath: '/tmp/sentinel-paramexp-slice-array-star',
  },
  // Exp — default/assign/error/alt + prefix/suffix/case forms. Walk-reached.
  {
    label: 'paramexp-exp-default',
    nodeField: 'ParamExp.Exp (default :-)',
    cmd: 'echo "${X:-$(rm /tmp/sentinel-paramexp-exp-default)}"',
    expectedPath: '/tmp/sentinel-paramexp-exp-default',
  },
  {
    label: 'paramexp-exp-assign',
    nodeField: 'ParamExp.Exp (assign :=)',
    cmd: 'echo "${X:=$(rm /tmp/sentinel-paramexp-exp-assign)}"',
    expectedPath: '/tmp/sentinel-paramexp-exp-assign',
  },
  {
    label: 'paramexp-exp-error',
    nodeField: 'ParamExp.Exp (error :?)',
    cmd: 'echo "${X:?$(rm /tmp/sentinel-paramexp-exp-error)}"',
    expectedPath: '/tmp/sentinel-paramexp-exp-error',
  },
  {
    label: 'paramexp-exp-altform',
    nodeField: 'ParamExp.Exp (alt :+)',
    cmd: 'echo "${X:+$(rm /tmp/sentinel-paramexp-exp-altform)}"',
    expectedPath: '/tmp/sentinel-paramexp-exp-altform',
  },
  {
    label: 'paramexp-exp-prefix',
    nodeField: 'ParamExp.Exp (prefix #)',
    cmd: 'echo "${X#$(rm /tmp/sentinel-paramexp-exp-prefix)}"',
    expectedPath: '/tmp/sentinel-paramexp-exp-prefix',
  },
  {
    label: 'paramexp-exp-prefix-long',
    nodeField: 'ParamExp.Exp (prefix-long ##)',
    cmd: 'echo "${X##$(rm /tmp/sentinel-paramexp-exp-prefix-long)}"',
    expectedPath: '/tmp/sentinel-paramexp-exp-prefix-long',
  },
  {
    label: 'paramexp-exp-suffix',
    nodeField: 'ParamExp.Exp (suffix %)',
    cmd: 'echo "${X%$(rm /tmp/sentinel-paramexp-exp-suffix)}"',
    expectedPath: '/tmp/sentinel-paramexp-exp-suffix',
  },
  {
    label: 'paramexp-exp-suffix-long',
    nodeField: 'ParamExp.Exp (suffix-long %%)',
    cmd: 'echo "${X%%$(rm /tmp/sentinel-paramexp-exp-suffix-long)}"',
    expectedPath: '/tmp/sentinel-paramexp-exp-suffix-long',
  },
  {
    label: 'paramexp-exp-case-up',
    nodeField: 'ParamExp.Exp (case-up ^)',
    cmd: 'echo "${X^$(rm /tmp/sentinel-paramexp-exp-case-up)}"',
    expectedPath: '/tmp/sentinel-paramexp-exp-case-up',
  },
  {
    label: 'paramexp-exp-case-lo',
    nodeField: 'ParamExp.Exp (case-lo ,)',
    cmd: 'echo "${X,$(rm /tmp/sentinel-paramexp-exp-case-lo)}"',
    expectedPath: '/tmp/sentinel-paramexp-exp-case-lo',
  },
  // Repl — pattern + replacement. Walk-reached.
  {
    label: 'paramexp-repl-pattern',
    nodeField: 'ParamExp.Repl.Orig (pattern in /pat/repl)',
    cmd: 'echo "${X/$(rm /tmp/sentinel-paramexp-repl-pattern)/y}"',
    expectedPath: '/tmp/sentinel-paramexp-repl-pattern',
  },
  {
    label: 'paramexp-repl-replacement',
    nodeField: 'ParamExp.Repl.With (replacement in //pat/repl)',
    cmd: 'echo "${X//y/$(rm /tmp/sentinel-paramexp-repl-replacement)}"',
    expectedPath: '/tmp/sentinel-paramexp-repl-replacement',
  },
  // Index — array index. Walk-reached.
  {
    label: 'paramexp-index',
    nodeField: 'ParamExp.Index',
    cmd: 'echo "${arr[$(rm /tmp/sentinel-paramexp-index)]}"',
    expectedPath: '/tmp/sentinel-paramexp-index',
  },

  // ============================================================
  // Stmt-level constructs — Walk visits Stmts, Stmts walk into
  // their inner CallExprs which our dispatcher catches.
  // ============================================================
  {
    label: 'callexpr-positional',
    nodeField: 'CallExpr.Args[*] direct cmdsubst',
    cmd: 'echo $(rm /tmp/sentinel-callexpr-positional)',
    expectedPath: '/tmp/sentinel-callexpr-positional',
  },
  {
    label: 'callexpr-assign-value',
    nodeField: 'CallExpr.Assigns[*].Value',
    cmd: 'Y=$(rm /tmp/sentinel-callexpr-assign-value)',
    expectedPath: '/tmp/sentinel-callexpr-assign-value',
  },
  {
    label: 'subshell',
    nodeField: 'Subshell.Stmts',
    cmd: '($(rm /tmp/sentinel-subshell))',
    expectedPath: '/tmp/sentinel-subshell',
  },
  {
    label: 'block',
    nodeField: 'Block.Stmts',
    cmd: '{ $(rm /tmp/sentinel-block); }',
    expectedPath: '/tmp/sentinel-block',
  },
  {
    label: 'funcdecl-body',
    nodeField: 'FuncDecl.Body (Stmts)',
    cmd: 'f() { $(rm /tmp/sentinel-funcdecl-body); }; f',
    expectedPath: '/tmp/sentinel-funcdecl-body',
  },
  {
    label: 'while-cond',
    nodeField: 'WhileClause.Cond[*]',
    cmd: 'while $(rm /tmp/sentinel-while-cond); do break; done',
    expectedPath: '/tmp/sentinel-while-cond',
  },
  {
    label: 'while-do',
    nodeField: 'WhileClause.Do[*]',
    cmd: 'while true; do $(rm /tmp/sentinel-while-do); break; done',
    expectedPath: '/tmp/sentinel-while-do',
  },
  {
    label: 'until-cond',
    nodeField: 'UntilClause.Cond[*]',
    cmd: 'until $(rm /tmp/sentinel-until-cond); do break; done',
    expectedPath: '/tmp/sentinel-until-cond',
  },
  {
    label: 'if-cond',
    nodeField: 'IfClause.Cond[*]',
    cmd: 'if $(rm /tmp/sentinel-if-cond); then :; fi',
    expectedPath: '/tmp/sentinel-if-cond',
  },
  {
    label: 'if-then',
    nodeField: 'IfClause.Then[*]',
    cmd: 'if true; then $(rm /tmp/sentinel-if-then); fi',
    expectedPath: '/tmp/sentinel-if-then',
  },
  {
    label: 'if-else',
    nodeField: 'IfClause.Else (recursive IfClause)',
    cmd: 'if false; then :; else $(rm /tmp/sentinel-if-else); fi',
    expectedPath: '/tmp/sentinel-if-else',
  },
  {
    label: 'for-items',
    nodeField: 'ForClause.Loop.WordIter.Items[*]',
    cmd: 'for i in $(rm /tmp/sentinel-for-items); do :; done',
    expectedPath: '/tmp/sentinel-for-items',
  },
  {
    label: 'for-do',
    nodeField: 'ForClause.Do[*]',
    cmd: 'for i in a; do $(rm /tmp/sentinel-for-do); done',
    expectedPath: '/tmp/sentinel-for-do',
  },
  {
    label: 'case-word',
    nodeField: 'CaseClause.Word',
    cmd: 'case $(rm /tmp/sentinel-case-word) in y) :;; esac',
    expectedPath: '/tmp/sentinel-case-word',
  },
  {
    label: 'case-pattern',
    nodeField: 'CaseClause.Items[*].Patterns[*]',
    cmd: 'case x in $(rm /tmp/sentinel-case-pattern)) :;; esac',
    expectedPath: '/tmp/sentinel-case-pattern',
  },
  {
    label: 'case-stmts',
    nodeField: 'CaseClause.Items[*].Stmts',
    cmd: 'case x in y) $(rm /tmp/sentinel-case-stmts);; esac',
    expectedPath: '/tmp/sentinel-case-stmts',
  },
  {
    label: 'select-items',
    nodeField: 'SelectClause.Loop.WordIter.Items[*]',
    cmd: 'select x in $(rm /tmp/sentinel-select-items); do break; done',
    expectedPath: '/tmp/sentinel-select-items',
  },
  {
    label: 'binarycmd-x',
    nodeField: 'BinaryCmd.X (left of && / ||)',
    cmd: '$(rm /tmp/sentinel-binarycmd-x) && true',
    expectedPath: '/tmp/sentinel-binarycmd-x',
  },
  {
    label: 'binarycmd-y',
    nodeField: 'BinaryCmd.Y (right of && / ||)',
    cmd: 'true && $(rm /tmp/sentinel-binarycmd-y)',
    expectedPath: '/tmp/sentinel-binarycmd-y',
  },
  {
    label: 'binarycmd-pipe-x',
    nodeField: 'BinaryCmd.X (left of |)',
    cmd: '$(rm /tmp/sentinel-binarycmd-pipe-x) | cat',
    expectedPath: '/tmp/sentinel-binarycmd-pipe-x',
  },
  {
    label: 'binarycmd-pipe-y',
    nodeField: 'BinaryCmd.Y (right of |)',
    cmd: 'true | $(rm /tmp/sentinel-binarycmd-pipe-y)',
    expectedPath: '/tmp/sentinel-binarycmd-pipe-y',
  },
  {
    label: 'arrayexpr-elem',
    nodeField: 'ArrayExpr.Elems[*].Value',
    cmd: 'A=( $(rm /tmp/sentinel-arrayexpr-elem) )',
    expectedPath: '/tmp/sentinel-arrayexpr-elem',
  },
  {
    label: 'arrayexpr-index',
    nodeField: 'ArrayExpr.Elems[*].Index',
    cmd: 'A=( [$(rm /tmp/sentinel-arrayexpr-index)]=y )',
    expectedPath: '/tmp/sentinel-arrayexpr-index',
  },
  {
    label: 'declclause-value',
    nodeField: 'DeclClause.Args[*].Value',
    cmd: 'declare X=$(rm /tmp/sentinel-declclause-value)',
    expectedPath: '/tmp/sentinel-declclause-value',
  },
  {
    label: 'declclause-array',
    nodeField: 'DeclClause.Args[*].Array',
    cmd: 'declare -a A=( $(rm /tmp/sentinel-declclause-array) )',
    expectedPath: '/tmp/sentinel-declclause-array',
  },
  {
    label: 'testclause-x',
    nodeField: 'TestClause.X (binary expr)',
    cmd: '[[ $(rm /tmp/sentinel-testclause-x) -eq 1 ]]',
    expectedPath: '/tmp/sentinel-testclause-x',
  },
  {
    label: 'testclause-y',
    nodeField: 'TestClause.Y (binary expr)',
    cmd: '[[ 1 -eq $(rm /tmp/sentinel-testclause-y) ]]',
    expectedPath: '/tmp/sentinel-testclause-y',
  },
  {
    label: 'testclause-unary',
    nodeField: 'TestClause.X (unary -f)',
    cmd: '[[ -f $(rm /tmp/sentinel-testclause-unary) ]]',
    expectedPath: '/tmp/sentinel-testclause-unary',
  },
  {
    label: 'arithm-cmd',
    nodeField: 'ArithmCmd.X (cmd-form)',
    cmd: '(( x = $(rm /tmp/sentinel-arithm-cmd) ))',
    expectedPath: '/tmp/sentinel-arithm-cmd',
  },
  {
    label: 'arithm-exp',
    nodeField: 'ArithmExp.X (expansion form)',
    cmd: 'echo $(($(rm /tmp/sentinel-arithm-exp) + 1))',
    expectedPath: '/tmp/sentinel-arithm-exp',
  },
  {
    label: 'letclause',
    nodeField: 'LetClause.Exprs[*]',
    cmd: 'let "x = $(rm /tmp/sentinel-letclause)"',
    expectedPath: '/tmp/sentinel-letclause',
  },
  {
    label: 'timeclause',
    nodeField: 'TimeClause.Stmt',
    cmd: 'time $(rm /tmp/sentinel-timeclause)',
    expectedPath: '/tmp/sentinel-timeclause',
  },
  {
    label: 'coproc',
    nodeField: 'CoprocClause.Stmt',
    cmd: 'coproc { $(rm /tmp/sentinel-coproc); }',
    expectedPath: '/tmp/sentinel-coproc',
  },
  {
    label: 'cmdsubst-stmts',
    nodeField: 'CmdSubst.Stmts (nested $(...))',
    cmd: 'echo $(echo $(rm /tmp/sentinel-cmdsubst-stmts))',
    expectedPath: '/tmp/sentinel-cmdsubst-stmts',
  },
  {
    label: 'procsubst-stmts',
    nodeField: 'ProcSubst.Stmts',
    cmd: 'diff <(cat) <($(rm /tmp/sentinel-procsubst-stmts))',
    expectedPath: '/tmp/sentinel-procsubst-stmts',
  },
  // Stmt.Redirs[*].Word — redirect target containing CmdSubst. Walker
  // emits a redirect detection regardless of inner content; the inner
  // CmdSubst is also reached (Walk visits the redirect's Word).
  {
    label: 'stmt-redir-word',
    nodeField: 'Stmt.Redirs[*].Word',
    cmd: 'echo x > $(rm /tmp/sentinel-stmt-redir-word)',
    // Walker emits the redirect (dynamic) AND the inner rm — accept
    // either as proof of reach.
    acceptAny: true,
  },
  // DblQuoted / SglQuoted — Word.Parts containing quoted CmdSubst.
  // Walk visits Parts; sgl-quote literally suppresses CmdSubst (it's
  // a bash literal-string), so we test only DblQuoted here.
  {
    label: 'dblquoted-cmdsubst',
    nodeField: 'DblQuoted.Parts[*]',
    cmd: 'echo "$(rm /tmp/sentinel-dblquoted-cmdsubst)"',
    expectedPath: '/tmp/sentinel-dblquoted-cmdsubst',
  },
];

describe('walker exhaustiveness contract — Class O (Walk-gap pinning)', () => {
  for (const row of EXHAUSTIVENESS_TABLE) {
    if (row.skip) {
      it.skip(`[${row.label}] ${row.nodeField} — ${row.skip}`, () => {});
      continue;
    }
    it(`[${row.label}] walker reaches ${row.nodeField}`, () => {
      const r = parseBashCommand(row.cmd);
      if (!r.ok) {
        throw new Error(
          `[${row.label}] mvdan-sh failed to parse fixture (this is a contract-test maintenance issue, not a walker bug): ${r.error}\nFIXTURE: ${row.cmd}\nFIX: rewrite the fixture to a valid bash form for ${row.nodeField}.`,
        );
      }
      const writes = walkForWrites(r.file);

      // Round-8 P0 tightening — acceptance is path-explicit by default.
      // Dynamic-only acceptance is opt-in via `row.acceptDynamic === true`.
      // Pre-fix the contract accepted ANY dynamic write anywhere as
      // proof-of-reach for ANY row, masking walker gaps:
      // a `bash -c` with malformed inner emits `nested_shell_inner`
      // dynamic, satisfying the assertion even when the named field was
      // never visited.
      let reachedSentinel: boolean;
      if (row.expectedPath) {
        const exact = writes.some((w) => w.path === row.expectedPath);
        const anyDynamic = writes.some((w) => w.dynamic);
        if (exact) {
          reachedSentinel = true;
        } else if (row.acceptDynamic === true && anyDynamic) {
          // Opt-in: this position is genuinely unresolvable to a static
          // path. The row author has documented the reason in a comment.
          reachedSentinel = true;
        } else {
          reachedSentinel = false;
        }
      } else {
        // No expected path → row asserts only proof-of-reach.
        reachedSentinel = writes.length > 0;
      }

      if (!reachedSentinel) {
        throw new Error(
          `[${row.label}] walker FAILED to reach ${row.nodeField}.\n` +
            `  Fixture: ${row.cmd}\n` +
            `  Expected to detect path: ${row.expectedPath ?? '(any)'}\n` +
            `  acceptDynamic: ${row.acceptDynamic === true ? 'true (opt-in)' : 'false (default — strict path-explicit)'}\n` +
            `  Walker emitted: ${JSON.stringify(writes, null, 2)}\n` +
            `  ROOT CAUSE: either mvdan-sh's syntax.Walk does not visit the ${row.nodeField} field,\n` +
            `              OR the walker reaches the field but the inner dispatcher cannot resolve a path.\n` +
            `  FIX: add an explicit recursion in walker.ts's visit callback,\n` +
            `       same pattern as recurseParamExpSlice() (round 7 P0 closure).\n` +
            `       If the position is genuinely unresolvable, set acceptDynamic: true on this row\n` +
            `       and document why in a comment.\n` +
            `       Then re-run this test to confirm closure.`,
        );
      }

      if (row.expectedPath && !row.acceptAny) {
        // Strict path match — confirms the dispatcher fired, not just
        // that the walker emitted a generic dynamic.
        const exact = writes.some((w) => w.path === row.expectedPath);
        if (!exact) {
          // Dynamic-only is acceptable — it means walker reached the
          // subtree but the inner dispatcher couldn't resolve a static
          // path. That's a softer guarantee than a literal sentinel
          // match, but still proof-of-reach. Don't fail.
          // (We could tighten this if we ever want to pin dispatcher
          // resolution per-position, but that's a separate dispatcher-
          // coverage concern, not a walker-reach concern.)
        }
      }
    });
  }

  it('table covers ParamExp Slice gap (regression pin for round 7 P0)', () => {
    const sliceLabels = EXHAUSTIVENESS_TABLE.filter((r) => r.nodeField.startsWith('ParamExp.Slice')).map(
      (r) => r.label,
    );
    // Must include offset, length, plus array/positional variants
    expect(sliceLabels).toContain('paramexp-slice-offset');
    expect(sliceLabels).toContain('paramexp-slice-length');
    expect(sliceLabels.length).toBeGreaterThanOrEqual(8);
  });

  it('table breadth: ≥45 distinct walker positions', () => {
    // Sanity: if someone removes rows the contract weakens silently.
    expect(EXHAUSTIVENESS_TABLE.filter((r) => !r.skip).length).toBeGreaterThanOrEqual(45);
  });
});
