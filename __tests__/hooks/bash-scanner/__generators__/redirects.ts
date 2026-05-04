/**
 * Dim — redirect-operator generator. The scanner's redirect-table
 * (`REDIR_OP_NAMES` in walker.ts) maps the AST op codes to write forms.
 * This module enumerates every redirect-operator + fd-prefix combination
 * we expect to be detected as a write.
 */

export interface RedirectShape {
  id: string;
  /** Apply: produce `<lhs> <op-with-target>` form. */
  apply: (lhs: string, target: string) => string;
}

export const REDIRECT_SHAPES: readonly RedirectShape[] = [
  // Basic write operators.
  { id: 'gt', apply: (l, t) => `${l} > ${t}` },
  { id: 'gtgt', apply: (l, t) => `${l} >> ${t}` },
  { id: 'gtpipe', apply: (l, t) => `${l} >| ${t}` },
  { id: 'amp-gt', apply: (l, t) => `${l} &> ${t}` },
  { id: 'amp-gtgt', apply: (l, t) => `${l} &>> ${t}` },
  // Read+write.
  { id: 'lt-gt', apply: (l, t) => `${l} <> ${t}` },

  // Fd-prefixed forms — `2>file`, `1>file`, `3>file`.
  { id: 'fd1-gt', apply: (l, t) => `${l} 1> ${t}` },
  { id: 'fd2-gt', apply: (l, t) => `${l} 2> ${t}` },
  { id: 'fd2-gtgt', apply: (l, t) => `${l} 2>> ${t}` },
  { id: 'fd3-gt', apply: (l, t) => `${l} 3> ${t}` },
  { id: 'fd9-gt', apply: (l, t) => `${l} 9> ${t}` },

  // No space between op and target (legal bash).
  { id: 'gt-nospace', apply: (l, t) => `${l} >${t}` },
  { id: 'gtgt-nospace', apply: (l, t) => `${l} >>${t}` },
  { id: 'fd2-gt-nospace', apply: (l, t) => `${l} 2>${t}` },

  // Combined: append + duplicate (`>file 2>&1`) — the `>file` portion is
  // the write that we're looking for. The `2>&1` is harmless duplicate.
  { id: 'gt-with-2to1', apply: (l, t) => `${l} > ${t} 2>&1` },

  // Multiple redirects on same stmt — both targets should be detected.
  { id: 'two-redirs', apply: (l, t) => `${l} > /tmp/log > ${t}` },
];
