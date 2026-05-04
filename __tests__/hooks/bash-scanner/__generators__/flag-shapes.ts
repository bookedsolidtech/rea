/**
 * Dim 4 — Flag-shape generator. Per-utility flag-bearing argv shapes
 * that the scanner must dispatch consistently.
 *
 * Specifically targets `-t` / `--target-directory` flag forms for cp,
 * mv, install, ln (helix-022 R2-4) and the equals/space variants.
 */

export interface FlagShape {
  id: string;
  /** Build a full argv that writes to `target`, structured according to
   *  this flag shape. The verb (cp/mv/install/ln) is supplied by the
   *  composer. */
  apply: (verb: string, target: string) => string;
}

/**
 * Flag shapes for utilities that accept `-t TARGET_DIR src...` and
 * `--target-directory=TARGET src...` forms (cp, mv, install). Each
 * exercises a different parsing path — short/long, equals/space,
 * cluster.
 */
export const TARGET_DIR_FLAG_SHAPES: readonly FlagShape[] = [
  // Tail-positional destination (no -t flag).
  { id: 'tail-pos', apply: (verb, target) => `${verb} src ${target}` },
  // -t with space.
  { id: 't-space', apply: (verb, target) => `${verb} -t ${target} src` },
  // -tDIR no-space (cluster). R2-4.
  { id: 't-cluster', apply: (verb, target) => `${verb} -t${target} src` },
  // --target-directory= equals.
  { id: 'long-eq', apply: (verb, target) => `${verb} --target-directory=${target} src` },
  // --target-directory space.
  { id: 'long-space', apply: (verb, target) => `${verb} --target-directory ${target} src` },
  // Trailing slash.
  { id: 't-space-slash', apply: (verb, target) => `${verb} -t ${target}/ src` },
  { id: 'long-eq-slash', apply: (verb, target) => `${verb} --target-directory=${target}/ src` },
  // With other flags before the target dir.
  { id: 't-with-flags', apply: (verb, target) => `${verb} -fR -t ${target} src` },
  {
    id: 'long-with-flags',
    apply: (verb, target) => `${verb} -fR --target-directory=${target} src`,
  },
  // -- separator.
  { id: 'doubledash', apply: (verb, target) => `${verb} -- src ${target}` },
];

/**
 * Outer-quote variants for an interpreter eval payload. Each variant
 * wraps a payload string in the canonical shell-quoting form.
 *
 *   - `sq` — outer `'<payload>'`. Use when the payload contains NO
 *     single quotes (single-quotes can't be escaped inside single).
 *   - `dq` — outer `"<payload>"` with `\$ \" \` \\\` escaped as needed.
 *     Use when payload contains single quotes.
 */
export interface InterpreterFlagShape {
  id: string;
  /** Build the full shell command. The payload is given AS-IS (the
   *  caller has already chosen a payload that's compatible with this
   *  outer-quote shape). */
  apply: (payload: string) => string;
  /** Quote style of the OUTER shell wrapper around the payload. */
  outerQuote: 'sq' | 'dq';
}

function dqEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

export const INTERPRETER_FLAG_SHAPES = {
  node: [
    { id: 'node-e-sq', apply: (p: string) => `node -e '${p}'`, outerQuote: 'sq' as const },
    { id: 'node-eval-sq', apply: (p: string) => `node --eval '${p}'`, outerQuote: 'sq' as const },
    { id: 'node-p-sq', apply: (p: string) => `node -p '${p}'`, outerQuote: 'sq' as const },
    { id: 'node-print-sq', apply: (p: string) => `node --print '${p}'`, outerQuote: 'sq' as const },
    { id: 'node-pe-cluster', apply: (p: string) => `node -pe '${p}'`, outerQuote: 'sq' as const },
    {
      id: 'node-e-dq',
      apply: (p: string) => `node -e "${dqEscape(p)}"`,
      outerQuote: 'dq' as const,
    },
    {
      id: 'node-eval-dq',
      apply: (p: string) => `node --eval "${dqEscape(p)}"`,
      outerQuote: 'dq' as const,
    },
  ] as readonly InterpreterFlagShape[],
  python: [
    { id: 'py-c-sq', apply: (p: string) => `python -c '${p}'`, outerQuote: 'sq' as const },
    { id: 'py3-c-sq', apply: (p: string) => `python3 -c '${p}'`, outerQuote: 'sq' as const },
    { id: 'py-ic', apply: (p: string) => `python -ic '${p}'`, outerQuote: 'sq' as const },
    {
      id: 'py-c-dq',
      apply: (p: string) => `python -c "${dqEscape(p)}"`,
      outerQuote: 'dq' as const,
    },
    {
      id: 'py3-c-dq',
      apply: (p: string) => `python3 -c "${dqEscape(p)}"`,
      outerQuote: 'dq' as const,
    },
  ] as readonly InterpreterFlagShape[],
  ruby: [
    { id: 'rb-e-sq', apply: (p: string) => `ruby -e '${p}'`, outerQuote: 'sq' as const },
    { id: 'rb-e-dq', apply: (p: string) => `ruby -e "${dqEscape(p)}"`, outerQuote: 'dq' as const },
  ] as readonly InterpreterFlagShape[],
  perl: [
    { id: 'pl-e-sq', apply: (p: string) => `perl -e '${p}'`, outerQuote: 'sq' as const },
    { id: 'pl-E-sq', apply: (p: string) => `perl -E '${p}'`, outerQuote: 'sq' as const },
    { id: 'pl-pe-cluster', apply: (p: string) => `perl -pe '${p}'`, outerQuote: 'sq' as const },
    { id: 'pl-e-dq', apply: (p: string) => `perl -e "${dqEscape(p)}"`, outerQuote: 'dq' as const },
  ] as readonly InterpreterFlagShape[],
} as const;
