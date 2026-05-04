/**
 * Local type-shim for `mvdan-sh@0.10.1`.
 *
 * The package is a GopherJS transpilation of the upstream Go
 * `mvdan.cc/sh/v3/syntax` parser. Upstream has rich types; the JS
 * binding ships none. This shim covers ONLY the surface
 * `src/hooks/bash-scanner/parser.ts` exercises (parse + walk +
 * NodeType + the few node-property accesses we make).
 *
 * Anything not declared here lands as `unknown` — callers that reach
 * into deeper AST fields must defensively narrow first. That posture
 * is intentional: `walker.ts` is the only file that touches AST shape,
 * and the verdict-classifier post-processes its results.
 *
 * The deprecated-status of `mvdan-sh@0.10.x` does not affect this
 * shim — the parser library is functionally complete and frozen at
 * 0.10.1 (no further releases planned upstream, see issue 1145). We
 * pin the exact version in package.json so future ecosystem churn
 * cannot silently change behavior.
 */

declare module 'mvdan-sh' {
  /**
   * The library is published as CommonJS with a single top-level
   * `module.exports = { syntax }` shape. Under Node ESM (`type: module`)
   * the only ESM-spec-compliant access path is the default export
   * (named-exports synthesis cannot reach a non-statically-analyzable
   * field, and the JS source assigns `syntax` dynamically). Consumers
   * import the default and read `.syntax` from it.
   */
  export interface MvdanShModule {
    syntax: {
      NewParser: (...opts: unknown[]) => Parser;
      DebugPrint: (file: BashFile) => void;
      Walk: (node: BashNode, visit: (node: BashNode | null) => boolean) => void;
      NodeType: (node: BashNode | null | undefined) => string;
    };
  }

  const mvdanSh: MvdanShModule;
  export default mvdanSh;

  export interface Parser {
    Parse: (src: string, name: string) => BashFile;
  }

  /**
   * Every node in the GopherJS-transpiled tree shares an opaque shape.
   * Specific node types (CallExpr, Word, Lit, Redirect, ProcSubst,
   * CmdSubst, ParamExp, DblQuoted, SglQuoted, Stmt) are duck-typed via
   * `syntax.NodeType()` at runtime.
   */
  export interface BashNode {
    [key: string]: unknown;
  }

  /**
   * `*syntax.File` — the parser's top-level return value. We type the
   * one field we need (`Stmts`) and leave the rest opaque.
   */
  export interface BashFile extends BashNode {
    Stmts?: BashNode[];
  }
}
