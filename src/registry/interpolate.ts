/**
 * Environment-variable interpolation for the registry's explicit `env:` map.
 *
 * Supports a deliberately minimal syntax — ONLY `${VAR}` (curly-brace form)
 * in env VALUES (keys are never interpolated). This keeps the surface area
 * small enough to reason about:
 *
 *   - No bare `$VAR` form (ambiguous with shell semantics).
 *   - No default syntax (`${VAR:-fallback}`) — 0.3.0 ships without it.
 *   - No command substitution (`$(cmd)`) — never.
 *   - No recursive expansion. If `${FOO}` resolves to a string that itself
 *     contains `${BAR}`, the inner text is treated as a literal. This is
 *     intentional to prevent a malicious env var contents from triggering
 *     a second round of lookups.
 *
 * Var names follow POSIX identifier rules: `^[A-Za-z_][A-Za-z0-9_]*$`.
 * Anything else inside `${...}` is a syntax error.
 *
 * Secret tagging: if either the env KEY OR any referenced `${VAR}` NAME
 * matches the secret-name heuristic (TOKEN/KEY/SECRET/PASSWORD/CREDENTIAL),
 * the resolved entry's key is added to `secretKeys`. Callers use this to
 * gate logging / redaction decisions. The resolved VALUE never flows into
 * audit records on its own — downstream.ts passes it straight to the child
 * transport — but `secretKeys` is exported so a future telemetry path can
 * make the right call without re-deriving the heuristic.
 */

/**
 * Regex used to flag env keys and interpolated var names that look like
 * secrets. Kept in sync with the same pattern in `registry/loader.ts`.
 */
export const SECRET_NAME_HEURISTIC = /(TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)/i;

/** POSIX identifier — matches legal env var names. */
const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Matches `${...}` with ANY inner content (including empty / illegal). The
 * inner content is re-validated against VAR_NAME_RE so we can emit a clear
 * error message per-occurrence.
 *
 * Note: the regex is non-greedy and bounded by `}`, so an unterminated
 * `${foo` will NOT match here — callers detect unterminated braces by
 * scanning for a literal `${` with no matching `}` after replacement.
 */
const PLACEHOLDER_RE = /\$\{([^}]*)\}/g;

export interface InterpolateResult {
  /** Env map with every `${VAR}` resolved against `processEnv`. */
  resolved: Record<string, string>;
  /**
   * Names of env vars referenced by the template but absent from
   * `processEnv` (or present but not a string). Empty when every
   * reference was satisfied. Deduplicated, in first-seen order.
   */
  missing: string[];
  /**
   * Env KEYS in `resolved` that should be treated as secret-bearing —
   * either because the key name itself matches the heuristic, or
   * because one of the `${VAR}` names referenced in its value did.
   * Callers MUST NOT log the resolved value of these keys.
   */
  secretKeys: string[];
}

/**
 * Interpolate `${VAR}` placeholders in every value of `rawEnv` against
 * `processEnv`. Pure function — no I/O, no mutation of inputs.
 *
 * Throws on malformed syntax (unterminated brace, empty name, illegal
 * identifier chars). Malformed templates are a LOAD-TIME problem, not a
 * runtime one, so the throw bubbles up to the registry loader / server
 * spawn path where it can be reported with file + key context.
 */
export function interpolateEnv(
  rawEnv: Record<string, string>,
  processEnv: NodeJS.ProcessEnv,
): InterpolateResult {
  const resolved: Record<string, string> = {};
  const missingSet = new Set<string>();
  const missing: string[] = [];
  const secretKeys: string[] = [];

  for (const [key, template] of Object.entries(rawEnv)) {
    validateNoUnterminatedBrace(key, template);

    const referencedSecretName = { seen: false };
    let anyMissing = false;

    const replaced = template.replace(PLACEHOLDER_RE, (_match, inner: string) => {
      if (inner.length === 0) {
        throw new Error(
          `registry env value for "${key}" contains empty \${} placeholder — expected \${VAR}`,
        );
      }
      if (!VAR_NAME_RE.test(inner)) {
        throw new Error(
          `registry env value for "${key}" references invalid var name "${inner}" — ` +
            'expected POSIX identifier matching /^[A-Za-z_][A-Za-z0-9_]*$/',
        );
      }
      if (SECRET_NAME_HEURISTIC.test(inner)) {
        referencedSecretName.seen = true;
      }
      const v = processEnv[inner];
      if (typeof v !== 'string') {
        if (!missingSet.has(inner)) {
          missingSet.add(inner);
          missing.push(inner);
        }
        anyMissing = true;
        // Return the original placeholder so tests can see the unresolved
        // template if they inspect resolved[key]. Callers MUST consult
        // `missing` and refuse to start the server — they should not ship
        // this value to a child process.
        return `\${${inner}}`;
      }
      return v;
    });

    // A key is secret-bearing when either (a) its name matches the heuristic
    // or (b) any `${VAR}` it references does. This matches the redact-by-default
    // contract documented in the PR body: the template is auditable, the
    // runtime value is not.
    if (SECRET_NAME_HEURISTIC.test(key) || referencedSecretName.seen) {
      secretKeys.push(key);
    }

    // Record resolved value regardless of missing — downstream caller uses
    // `missing` as the sole signal for "refuse to start". If the caller
    // chooses to proceed, the unresolved placeholder is a loud canary.
    void anyMissing;
    resolved[key] = replaced;
  }

  return { resolved, missing, secretKeys };
}

/**
 * Scan for a literal `${` that has no matching `}` after it. The main
 * replace pass uses a regex that REQUIRES `}`, so unterminated opens
 * would be silently kept as literals without this pre-check — which
 * would ship a raw `${...` string to the child, nearly always a bug.
 */
function validateNoUnterminatedBrace(key: string, template: string): void {
  let i = 0;
  while (i < template.length) {
    const open = template.indexOf('${', i);
    if (open === -1) return;
    const close = template.indexOf('}', open + 2);
    if (close === -1) {
      throw new Error(
        `registry env value for "${key}" contains unterminated \${ — add a closing } or escape the literal`,
      );
    }
    i = close + 1;
  }
}
