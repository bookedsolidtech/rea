/**
 * Dim 1 — Invocation form generator. Each entry rewrites a bare command
 * head (e.g. `cp`) into one of the 15 documented invocation shapes:
 *
 *   - bare:       `cp`
 *   - absolute:   `/bin/cp`, `/usr/bin/cp`, `/usr/local/bin/cp`,
 *                 `/opt/homebrew/bin/cp`
 *   - relative:   `./cp`, `./bin/cp`
 *   - env wrap:   `env cp`, `/usr/bin/env cp`
 *   - sudo wrap:  `sudo cp`
 *   - misc wrap:  `nohup cp`, `time cp`, `exec cp`, `command cp`
 *   - stacked:    `env sudo cp`, `nohup env cp`
 *
 * The expectation is the SAME verdict regardless of invocation form —
 * basename normalization (`normalizeCmdHead` in `walker.ts`) plus
 * `stripEnvAndModifiers` should collapse all 15 forms to the same
 * dispatcher case.
 */

export interface InvocationForm {
  /** Slug for the test label. */
  id: string;
  /** Function: takes a command head + tail and produces the rewritten cmd. */
  apply: (head: string, tail: string) => string;
}

export const INVOCATION_FORMS: readonly InvocationForm[] = [
  { id: 'bare', apply: (h, t) => `${h} ${t}` },
  { id: 'abs-bin', apply: (h, t) => `/bin/${h} ${t}` },
  { id: 'abs-usrbin', apply: (h, t) => `/usr/bin/${h} ${t}` },
  { id: 'abs-usrlocal', apply: (h, t) => `/usr/local/bin/${h} ${t}` },
  { id: 'abs-homebrew', apply: (h, t) => `/opt/homebrew/bin/${h} ${t}` },
  { id: 'rel-dot', apply: (h, t) => `./${h} ${t}` },
  { id: 'rel-subdir', apply: (h, t) => `./bin/${h} ${t}` },
  { id: 'env', apply: (h, t) => `env ${h} ${t}` },
  { id: 'env-abs', apply: (h, t) => `/usr/bin/env ${h} ${t}` },
  { id: 'sudo', apply: (h, t) => `sudo ${h} ${t}` },
  { id: 'nohup', apply: (h, t) => `nohup ${h} ${t}` },
  { id: 'time', apply: (h, t) => `time ${h} ${t}` },
  { id: 'exec', apply: (h, t) => `exec ${h} ${t}` },
  { id: 'command', apply: (h, t) => `command ${h} ${t}` },
  { id: 'env-sudo-stack', apply: (h, t) => `env sudo ${h} ${t}` },
  { id: 'nohup-env-stack', apply: (h, t) => `nohup env ${h} ${t}` },
  // env with var-set in front of head — env normalizer should consume
  // the var assignment and resume at the head.
  { id: 'env-with-var', apply: (h, t) => `env FOO=bar ${h} ${t}` },
  // sudo with -u USER — sudo modifier-stripper consumes the flag pair.
  { id: 'sudo-u', apply: (h, t) => `sudo -u root ${h} ${t}` },
  // backslash-prefix to bypass shell aliasing
  { id: 'backslash-alias', apply: (h, t) => `\\${h} ${t}` },
];

/**
 * Forms that we expect the scanner to also dispatch through, used in
 * negative-corpus generation: the SAME 19 invocation shapes, paired
 * with a non-protected target, must all ALLOW.
 */
export const ALL_INVOCATION_FORMS: readonly InvocationForm[] = INVOCATION_FORMS;
