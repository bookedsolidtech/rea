/**
 * Dim 3 — Quote/escape shape generator. Produces the variant forms a
 * literal path token can take inside a bash command. The scanner's
 * `normalizeTarget` (`protected-scan.ts`) and `wordToString` (`walker.ts`)
 * are responsible for collapsing these to the same canonical form.
 *
 * Bypass class: F-15 (backslash-escapes), F-16 (ANSI-C $'...'), F-17
 * (whitespace), F-23 (URL-encoded paths).
 */

export interface QuoteShape {
  id: string;
  /** Wrap a raw path string in this quote/escape form. The result must
   *  parse to the same canonical path under bash word-splitting +
   *  quote-stripping. */
  apply: (path: string) => string;
  /** Some shapes are valid only in specific positions. Currently we use
   *  this as a hint for the composer; bash-redirect tokens DO accept all
   *  of these, but interpreters embed paths inside their own argument
   *  string and have their own quote rules. */
  context: 'shell-token' | 'js-string' | 'py-string' | 'rb-string' | 'pl-string';
}

export const SHELL_TOKEN_QUOTES: readonly QuoteShape[] = [
  { id: 'bare', apply: (p) => p, context: 'shell-token' },
  { id: 'sq', apply: (p) => `'${p}'`, context: 'shell-token' },
  { id: 'dq', apply: (p) => `"${p}"`, context: 'shell-token' },
  // Backslash-escape leading dot: `\.rea/HALT`. F-15.
  { id: 'bs-dot', apply: (p) => `\\${p}`, context: 'shell-token' },
  // Random backslash mid-path: `.r\ea/HALT`. F-15.
  {
    id: 'bs-mid',
    apply: (p) => {
      // Insert a backslash before a non-special middle char if available.
      if (p.length < 4) return `\\${p}`;
      return p.slice(0, 2) + '\\' + p.slice(2);
    },
    context: 'shell-token',
  },
  // Backslash on every char (extreme): `\.\r\e\a\/\H\A\L\T`.
  // Bash strips one level; the canonical form is the original path.
  {
    id: 'bs-all',
    apply: (p) =>
      p
        .split('')
        .map((c) => `\\${c}`)
        .join(''),
    context: 'shell-token',
  },
  // Mixed: 'a'".rea/HALT" — adjacent string-literal concatenation
  // (bash glues these into one token at parse time).
  { id: 'mixed-adj', apply: (p) => `''"${p}"`, context: 'shell-token' },
  // Trailing slash variant — protected list has both file and dir patterns.
  // Don't add to a path that already ends with `/`.
  { id: 'trailing-slash', apply: (p) => (p.endsWith('/') ? p : `${p}/`), context: 'shell-token' },
  // Multiple slashes: `.rea//HALT` — collapses to `.rea/HALT`.
  { id: 'double-slash', apply: (p) => p.replace(/\//, '//'), context: 'shell-token' },
  // Triple slashes.
  { id: 'triple-slash', apply: (p) => p.replace(/\//, '///'), context: 'shell-token' },
  // Leading `./`: `./.rea/HALT` — normalizer strips it.
  { id: 'leading-dotslash', apply: (p) => `./${p}`, context: 'shell-token' },
  // Leading `././` (double).
  { id: 'leading-dotslash2', apply: (p) => `./.${'/'}${p}`, context: 'shell-token' },
];

/**
 * JavaScript string-literal shapes for embedding inside `node -e` payloads.
 * Each wraps a JS string with its quote style. Backticks include template
 * literal forms (static and dynamic).
 */
export const JS_STRING_SHAPES: readonly QuoteShape[] = [
  { id: 'js-sq', apply: (p) => `'${p}'`, context: 'js-string' },
  { id: 'js-dq', apply: (p) => `"${p}"`, context: 'js-string' },
  // Backtick template literal — F-9.
  { id: 'js-tmpl', apply: (p) => `\`${p}\``, context: 'js-string' },
  // Concatenation: '.rea' + '/HALT'.
  {
    id: 'js-concat',
    apply: (p) => {
      const idx = p.indexOf('/');
      if (idx < 1) return `'${p}'`;
      return `'${p.slice(0, idx)}' + '${p.slice(idx)}'`;
    },
    context: 'js-string',
  },
  // Computed via .concat method.
  {
    id: 'js-concat-method',
    apply: (p) => {
      const idx = p.indexOf('/');
      if (idx < 1) return `'${p}'`;
      return `'${p.slice(0, idx)}'.concat('${p.slice(idx)}')`;
    },
    context: 'js-string',
  },
];

export const PY_STRING_SHAPES: readonly QuoteShape[] = [
  { id: 'py-sq', apply: (p) => `'${p}'`, context: 'py-string' },
  { id: 'py-dq', apply: (p) => `"${p}"`, context: 'py-string' },
  // f-string interpolation: f'.rea/{tail}' — F-10.
  {
    id: 'py-fstring-static',
    apply: (p) => {
      const idx = p.indexOf('/');
      if (idx < 1) return `f'${p}'`;
      return `f'${p.slice(0, idx)}/{"${p.slice(idx + 1)}"}'`;
    },
    context: 'py-string',
  },
  // % formatting.
  {
    id: 'py-percent',
    apply: (p) => {
      const idx = p.indexOf('/');
      if (idx < 1) return `'${p}'`;
      return `'${p.slice(0, idx)}/%s' % '${p.slice(idx + 1)}'`;
    },
    context: 'py-string',
  },
  // .format()
  {
    id: 'py-format',
    apply: (p) => {
      const idx = p.indexOf('/');
      if (idx < 1) return `'${p}'`;
      return `'${p.slice(0, idx)}/{}'.format('${p.slice(idx + 1)}')`;
    },
    context: 'py-string',
  },
  // String concat
  {
    id: 'py-concat',
    apply: (p) => {
      const idx = p.indexOf('/');
      if (idx < 1) return `'${p}'`;
      return `'${p.slice(0, idx)}' + '${p.slice(idx)}'`;
    },
    context: 'py-string',
  },
  // os.path.join
  {
    id: 'py-osjoin',
    apply: (p) => {
      const idx = p.indexOf('/');
      if (idx < 1) return `'${p}'`;
      return `os.path.join('${p.slice(0, idx)}', '${p.slice(idx + 1)}')`;
    },
    context: 'py-string',
  },
];

export const RB_STRING_SHAPES: readonly QuoteShape[] = [
  { id: 'rb-sq', apply: (p) => `'${p}'`, context: 'rb-string' },
  { id: 'rb-dq', apply: (p) => `"${p}"`, context: 'rb-string' },
  // Ruby string interpolation: "#{var}".
  {
    id: 'rb-interp',
    apply: (p) => {
      const idx = p.indexOf('/');
      if (idx < 1) return `"${p}"`;
      return `"${p.slice(0, idx)}/#{'${p.slice(idx + 1)}'}"`;
    },
    context: 'rb-string',
  },
  // Concat
  {
    id: 'rb-concat',
    apply: (p) => {
      const idx = p.indexOf('/');
      if (idx < 1) return `'${p}'`;
      return `'${p.slice(0, idx)}' + '${p.slice(idx)}'`;
    },
    context: 'rb-string',
  },
  // %s formatting
  {
    id: 'rb-format',
    apply: (p) => {
      const idx = p.indexOf('/');
      if (idx < 1) return `'${p}'`;
      return `format('${p.slice(0, idx)}/%s', '${p.slice(idx + 1)}')`;
    },
    context: 'rb-string',
  },
];

export const PL_STRING_SHAPES: readonly QuoteShape[] = [
  { id: 'pl-sq', apply: (p) => `'${p}'`, context: 'pl-string' },
  { id: 'pl-dq', apply: (p) => `"${p}"`, context: 'pl-string' },
  // sprintf
  {
    id: 'pl-sprintf',
    apply: (p) => {
      const idx = p.indexOf('/');
      if (idx < 1) return `'${p}'`;
      return `sprintf('${p.slice(0, idx)}/%s', '${p.slice(idx + 1)}')`;
    },
    context: 'pl-string',
  },
  // Concat (`.` operator).
  {
    id: 'pl-concat',
    apply: (p) => {
      const idx = p.indexOf('/');
      if (idx < 1) return `'${p}'`;
      return `'${p.slice(0, idx)}' . '${p.slice(idx)}'`;
    },
    context: 'pl-string',
  },
];
