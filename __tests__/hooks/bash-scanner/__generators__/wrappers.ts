/**
 * Dim 2 — Wrapper depth generator. Each entry wraps an inner shell
 * payload in a shell invocation (or other recursive container the
 * scanner should unwrap). The expectation is the scanner walks INTO
 * the inner payload and applies the same write-detection rules.
 *
 * Bypass class: nested-shell unwrap (helix-017 / round-2 R2-12).
 */

export interface WrapperForm {
  /** Slug for the test label. */
  id: string;
  /** Wrap an inner bash payload. Caller supplies an inner cmd that
   *  itself is a single-statement shell command. The wrapper takes
   *  responsibility for any quoting needed to embed it. */
  apply: (inner: string) => string;
  /** Whether the wrapper introduces a level of bash quoting. Used by
   *  the composer to skip wrappers whose embedded inner can't be
   *  expressed (e.g. heredoc bodies that include the heredoc
   *  delimiter). */
  introducesQuoting: 'single' | 'double' | 'heredoc' | 'none';
}

/**
 * Quote-escape an inner payload so it's safe inside a single-quoted
 * outer wrapper. Bash single quotes can't contain a single quote even
 * with backslash; the canonical workaround is `'\''` (close, escaped
 * literal, reopen).
 */
function escapeForSingleQuotes(s: string): string {
  return s.replace(/'/g, `'\\''`);
}

/**
 * Quote-escape an inner payload for a double-quoted outer wrapper.
 * We escape `"`, `$`, `` ` ``, and `\` so the inner is preserved
 * literally inside `bash -c "…"`.
 */
function escapeForDoubleQuotes(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\$/g, '\\$').replace(/`/g, '\\`');
}

export const WRAPPER_FORMS: readonly WrapperForm[] = [
  // Direct — no wrapping. Establishes a baseline for the cross product.
  { id: 'direct', apply: (inner) => inner, introducesQuoting: 'none' },

  // 1-level wrappers using single-quoted inner.
  {
    id: 'bash-c-sq',
    apply: (inner) => `bash -c '${escapeForSingleQuotes(inner)}'`,
    introducesQuoting: 'single',
  },
  {
    id: 'sh-c-sq',
    apply: (inner) => `sh -c '${escapeForSingleQuotes(inner)}'`,
    introducesQuoting: 'single',
  },
  {
    id: 'zsh-c-sq',
    apply: (inner) => `zsh -c '${escapeForSingleQuotes(inner)}'`,
    introducesQuoting: 'single',
  },
  {
    id: 'dash-c-sq',
    apply: (inner) => `dash -c '${escapeForSingleQuotes(inner)}'`,
    introducesQuoting: 'single',
  },
  {
    id: 'ksh-c-sq',
    apply: (inner) => `ksh -c '${escapeForSingleQuotes(inner)}'`,
    introducesQuoting: 'single',
  },

  // 1-level wrappers using double-quoted inner.
  {
    id: 'bash-c-dq',
    apply: (inner) => `bash -c "${escapeForDoubleQuotes(inner)}"`,
    introducesQuoting: 'double',
  },
  {
    id: 'sh-c-dq',
    apply: (inner) => `sh -c "${escapeForDoubleQuotes(inner)}"`,
    introducesQuoting: 'double',
  },

  // Cluster flag variants. `bash -lc '...'`, `bash -ic '...'`, `bash -xc '...'`
  // — login/interactive/xtrace flags clustered with -c. The dispatcher
  // should treat these the same as -c.
  {
    id: 'bash-lc',
    apply: (inner) => `bash -lc '${escapeForSingleQuotes(inner)}'`,
    introducesQuoting: 'single',
  },
  {
    id: 'bash-ic',
    apply: (inner) => `bash -ic '${escapeForSingleQuotes(inner)}'`,
    introducesQuoting: 'single',
  },
  {
    id: 'bash-xc',
    apply: (inner) => `bash -xc '${escapeForSingleQuotes(inner)}'`,
    introducesQuoting: 'single',
  },
  {
    id: 'bash-lic',
    apply: (inner) => `bash -lic '${escapeForSingleQuotes(inner)}'`,
    introducesQuoting: 'single',
  },

  // 2-level mixed: outer bash -c "sh -c '<inner>'"
  {
    id: 'bash-sh-2level',
    apply: (inner) => `bash -c "sh -c '${escapeForSingleQuotes(escapeForDoubleQuotes(inner))}'"`,
    introducesQuoting: 'double',
  },

  // 3-level deep: bash -lc "bash -c \"sh -c '<inner>'\""
  {
    id: 'bash-bash-sh-3level',
    apply: (inner) => {
      const lvl1 = `sh -c '${escapeForSingleQuotes(inner)}'`;
      const lvl2 = `bash -c "${escapeForDoubleQuotes(lvl1)}"`;
      const lvl3 = `bash -lc "${escapeForDoubleQuotes(lvl2)}"`;
      return lvl3;
    },
    introducesQuoting: 'double',
  },

  // Heredoc into shell. `bash <<EOF\n<inner>\nEOF`. The inner sees its
  // payload literally — with one caveat: the inner cannot contain a
  // line consisting solely of the EOF delimiter. We use REA_END as a
  // delimiter to make collisions astronomically unlikely.
  {
    id: 'bash-heredoc',
    apply: (inner) => `bash <<REA_END\n${inner}\nREA_END`,
    introducesQuoting: 'heredoc',
  },
  {
    id: 'sh-heredoc',
    apply: (inner) => `sh <<REA_END\n${inner}\nREA_END`,
    introducesQuoting: 'heredoc',
  },

  // Process substitution. `bash <(echo '<inner>')`. The scanner
  // recurses both the inner echo and any process-subst body.
  // NOTE: bash <(...) reads from a temp file, runs the FILE as a
  // script. We model that here as cat <(echo INNER) | bash to keep
  // the actual write detection happening through bash -c instead;
  // the parser sees process subst as a CmdSubst-like node but we
  // already cover that elsewhere via process_subst_inner. Keep the
  // form available for completeness.
  // (Disabled via composer filter — we cover process subst in Class G.)

  // eval — passes its arg as a shell command. The scanner should
  // re-parse the eval payload like a nested shell.
  {
    id: 'eval-sq',
    apply: (inner) => `eval '${escapeForSingleQuotes(inner)}'`,
    introducesQuoting: 'single',
  },
  {
    id: 'eval-dq',
    apply: (inner) => `eval "${escapeForDoubleQuotes(inner)}"`,
    introducesQuoting: 'double',
  },
];

/**
 * Subset of wrappers safe to nest 4 levels deep without combinatoric
 * blow-up of escape-quoting bugs. Used in the depth-4 case generator.
 */
export const DEPTH4_WRAPPERS: readonly WrapperForm[] = [
  WRAPPER_FORMS.find((w) => w.id === 'bash-c-sq')!,
  WRAPPER_FORMS.find((w) => w.id === 'sh-c-sq')!,
  WRAPPER_FORMS.find((w) => w.id === 'eval-sq')!,
];
