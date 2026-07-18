/**
 * Node-binary port of `hooks/dangerous-bash-interceptor.sh`.
 *
 * 0.34.0 Phase 2 port #1 (tier-2 medium-complexity hooks with enforcer
 * logic). This is the agent-runaway gate — it refuses destructive Bash
 * commands before Claude Code dispatches them. Every refusal class in
 * the 414-LOC bash body must be preserved byte-for-byte; the bypass
 * corpus pinned across 0.13–0.27 demands it.
 *
 * Behavioral contract — preserves the bash hook byte-for-byte:
 *
 *   1. HALT check → exit 2 with the shared banner.
 *   2. Read stdin, extract `tool_input.command`. Non-Bash payloads or
 *      empty command → exit 0.
 *   3. Compute smart exclusion flags:
 *        - `CMD_IS_REBASE_SAFE` → segments that begin with
 *          `git rebase --abort|--continue` skip the H2 rebase advisory.
 *        - `CMD_IS_CLEAN_DRY` → segments that begin with
 *          `git clean -n|--dry-run` skip the H5 destructive-clean check.
 *   4. Run every HIGH check (H1–H17, M1) against the command. Each
 *      check returns 0..N matches; matches are accumulated into the
 *      violations table. The accumulator preserves the original bash
 *      hook's first-match-wins-per-check semantics — H1 fires once
 *      per command even if multiple push segments are unsafe.
 *   5. If any HIGH match → emit "BASH INTERCEPTED" banner + exit 2.
 *      Else if MEDIUM-only → emit "BASH ADVISORY" banner + exit 0.
 *      Else exit 0 silently.
 *
 * The pattern catalog is in `RULES` below. Each rule is a self-
 * contained closure with a stable identifier (`H1`, `H2`, …) so a
 * future rule addition lands as a one-line array push, not a rewrite.
 * Identifiers match the bash hook's `add_high "H<N>: …"` shape so
 * audit/log consumers grepping for `H12` continue to work.
 *
 * Key parity choices:
 *
 *   - Segment-anchored detection via `anySegmentStartsWith` (and
 *     `forEachSegment` for per-segment work). The bash 0.15.0 fix
 *     (segment-aware instead of full-command grep) is reproduced here.
 *   - Env-var-prefix shapes (H10 `HUSKY=0 git`, H15 `REA_BYPASS=…`,
 *     H16 alias/function defs) use `anySegmentRawMatches` since the
 *     prefix IS the signal — `stripSegmentPrefix` would eat it.
 *   - H12 (`curl|sh` pipe-RCE) scans the whole command via
 *     `quoteMaskedCmd` because pipe-RCE is a multi-segment property
 *     (`|` is the separator that joins curl to sh). The bash hook's
 *     `_rea_unwrap_nested_shells` is mirrored via `unwrapNestedShells`
 *     so inner payloads of `bash -c "curl … | sh"` are also scanned.
 *   - H17 (context-protection) reads
 *     `policy.context_protection.delegate_to_subagent` via the canonical
 *     YAML loader (matches the bash hook's 0.16.0 fix J.2).
 */

import type { Buffer } from 'node:buffer';
import { checkHaltRoots, formatHaltBanner } from '../_lib/halt-check.js';
import { resolveHookRoots } from '../../lib/worktree-roots.js';
import {
  parseHookPayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';
import {
  anySegmentStartsWith,
  anySegmentContains,
  anySegmentRawMatches,
  forEachSegment,
  quoteMaskedCmd,
  splitSegments,
  unwrapNestedShells,
} from '../_lib/segments.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../../audit/append.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';

export interface DangerousBashOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
}

export interface DangerousBashResult {
  exitCode: number;
  stderr: string;
  /** Test seam — violations the run accumulated, in catalog order. */
  violations: Violation[];
}

export interface Violation {
  severity: 'HIGH' | 'MEDIUM';
  /** Stable identifier (`H1`, `H10`, `M1`, …) — matches bash labels. */
  id: string;
  /** Banner headline. */
  label: string;
  /** Banner explanation paragraph. */
  detail: string;
  /** Suggested alternatives. */
  alternatives: string[];
}

const MAX_DISPLAY_CMD_LEN = 200;
function truncate(cmd: string): string {
  if (cmd.length <= MAX_DISPLAY_CMD_LEN) return cmd;
  return cmd.slice(0, MAX_DISPLAY_CMD_LEN) + '...';
}

/**
 * Rule descriptor + execution closure. The closure receives the raw
 * command + the active exclusion flags and returns 0..N violations
 * for that rule.
 */
interface RuleContext {
  cmd: string;
  cmdIsRebaseSafe: boolean;
  cmdIsCleanDry: boolean;
  delegatePatterns: string[];
  /** H17: per-segment delegate-pattern hits with per-segment sanction. */
  delegateHits: DelegateSegmentHit[];
}

interface Rule {
  id: string;
  severity: 'HIGH' | 'MEDIUM';
  run: (ctx: RuleContext) => Violation[];
}

function escapeERE(pattern: string): string {
  return pattern.replace(/[\\.*^$()+?|{}[\]]/g, (m) => `\\${m}`);
}

// ── H17 context-protection helpers (0.54.x, bug H17 fix) ────────────
//
// The pre-fix H17 mandated delegation ("run this in a subagent") but the
// delegated subagent hit the same block — Claude Code fires PreToolUse
// in every agent context and the hook has no reliable "am I in a
// subagent?" signal (CLAUDE_PARENT_SUBAGENT's presence on a *Bash* call
// is unverifiable and, if ever set session-wide, would disable the gate
// entirely). The durable, verifiable fix is an explicit SANCTIONED-RUN
// marker plus matcher normalization so the mandated path is traversable
// and the raw-equivalent bypasses no longer leak.

/**
 * The sanctioned delegated-run marker. A delegate-listed command carried
 * as `REA_DELEGATED_RUN=1 <cmd>` is allowed through H17 AND recorded on
 * the audit chain — the coordinator gate stays intact (a bare command
 * is still blocked) while the delegated runner (disposable context) has
 * a real, auditable path. Detected from the RAW command text, because a
 * leading env-assignment is STRIPPED from `seg.head` by
 * `stripSegmentPrefix` — so `anySegmentStartsWith` would still fire if
 * we relied on head-form suppression.
 */
const DELEGATED_RUN_MARKER = 'REA_DELEGATED_RUN';

/**
 * True when the command (or the process env) carries the sanctioned
 * delegated-run marker with a non-empty value. Command form is the
 * reliable one: shell `export`s do NOT survive across separate Bash
 * tool calls, so an inline leading assignment is the only marker a
 * PreToolUse hook can see for the command it is gating.
 */
/** True when the process env carries a non-empty marker (a GLOBAL sanction). */
function envMarkerSet(): boolean {
  const env = process.env[DELEGATED_RUN_MARKER];
  return typeof env === 'string' && env.length > 0;
}

// Leading env-assignment block that includes REA_DELEGATED_RUN=<val>.
// Tolerates other simple leading assigns and quoted values.
const SEGMENT_MARKER_RE = new RegExp(
  `^\\s*(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\\S*)\\s+)*` +
    `${DELEGATED_RUN_MARKER}=(?:"[^"]*"|'[^']*'|\\S+)`,
);

/** True when THIS segment's raw text carries a leading marker assignment. */
function segmentHasMarker(rawSegment: string): boolean {
  return SEGMENT_MARKER_RE.test(rawSegment);
}

/**
 * Runner-prefix equivalence (bug H17 under-block leak). `pnpm vitest
 * run`, `pnpm exec vitest run`, `npx vitest run`,
 * `./node_modules/.bin/vitest run`, and `node_modules/.bin/vitest run`
 * all invoke the same binary — but the pre-fix matcher (LEADING_KEYWORDS
 * omits pnpm/npx/the .bin path) only caught the literal listed form.
 *
 * We EXPAND each policy pattern into its runner-equivalent forms and
 * match the command against those, rather than stripping the command
 * down to a bare token. That closes the leak WITHOUT over-blocking: a
 * bare shell builtin like `test -f foo` never carries a pnpm/npx/.bin
 * prefix, so it never matches an expanded `pnpm test` pattern (stripping
 * the pattern down to `test` WOULD have caught it — the trap avoided).
 */
// Only LOCAL script/binary runners — the ones that resolve the repo's
// OWN `node_modules/.bin` binary or `package.json` script. Round-1 P2:
// `pnpm dlx` / `yarn dlx` / bare `npx` are deliberately EXCLUDED — they
// download and run an ARBITRARY package, so `npx lint` is not the same
// program as the delegated `pnpm run lint` and treating them as
// equivalent would over-block ordinary coordinator commands. Round-1
// P2 also adds `pnpm run` / `yarn run` / `node --run` — the script
// forms of the listed `pnpm run <script>` entries, which were leaking.
const RUNNER_PREFIXES = [
  'pnpm ',
  'pnpm exec ',
  'pnpm run ',
  'yarn ',
  'yarn exec ',
  'yarn run ',
  'node --run ',
  './node_modules/.bin/',
  'node_modules/.bin/',
];

/**
 * Extract the "binary/script + args" tail by removing ONE known LOCAL
 * runner prefix. Kept in lockstep with `RUNNER_PREFIXES` — dlx/npx are
 * NOT stripped, so a policy pattern that literally names one only ever
 * matches that verbatim form (never a local-binary equivalent).
 */
function delegateTail(normPattern: string): string {
  const runner =
    /^(?:pnpm\s+exec|pnpm\s+run|pnpm|yarn\s+exec|yarn\s+run|yarn|node\s+--run)\s+(.+)$/i.exec(
      normPattern,
    );
  if (runner && runner[1] !== undefined) return runner[1];
  const binPath = /^(?:\.\/)?node_modules\/\.bin\/(.+)$/.exec(normPattern);
  if (binPath && binPath[1] !== undefined) return binPath[1];
  return normPattern; // no runner prefix (e.g. a bare `git push`)
}

function expandRunnerEquivalents(pattern: string): string[] {
  const norm = pattern.trim().replace(/\s+/g, ' ');
  const tail = delegateTail(norm);
  const out = new Set<string>([norm]); // always match the listed form verbatim
  // Only RUNNER-PREFIXED equivalents — deliberately NOT the bare tail,
  // which would over-match unrelated `test`/`build` shell commands.
  for (const pre of RUNNER_PREFIXES) out.add(pre + tail);
  return [...out];
}

/**
 * Return the delegate pattern matching a single segment head
 * (whitespace-normalized, across every runner-equivalent form), or null.
 * Head-anchored with a trailing `(\s|$)` so a listed `pnpm vitest run`
 * catches every runner form while `pnpm vitest-foo` does not.
 */
function matchSegmentHead(head: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    if (pattern.trim().length === 0) continue;
    for (const variant of expandRunnerEquivalents(pattern)) {
      if (variant.length === 0) continue;
      const re = new RegExp(`^${escapeERE(variant)}(\\s|$)`, 'i');
      if (re.test(head)) return pattern;
    }
  }
  return null;
}

interface DelegateSegmentHit {
  /** The delegate pattern this segment matched. */
  pattern: string;
  /** True when THIS segment is sanctioned (env marker set, or its own
   *  leading `REA_DELEGATED_RUN=` assignment). */
  sanctioned: boolean;
  /** Where the sanction came from (only when `sanctioned`). */
  source?: 'env' | 'command_marker';
}

/**
 * Per-segment delegate analysis (round-1 P1). Sanction is tracked PER
 * SEGMENT, not per whole command: `pnpm test && REA_DELEGATED_RUN=1 pnpm
 * lint` must still block the unsanctioned `pnpm test` even though the
 * `pnpm lint` segment is sanctioned. The process-env marker is a global
 * sanction (applies to every segment); the command marker is scoped to
 * the segment that carries it.
 */
function analyzeDelegateSegments(
  cmd: string,
  patterns: readonly string[],
): DelegateSegmentHit[] {
  const envSanctioned = envMarkerSet();
  const hits: DelegateSegmentHit[] = [];
  for (const seg of splitSegments(cmd)) {
    const head = seg.head.trim().replace(/\s+/g, ' ');
    const pattern = matchSegmentHead(head, patterns);
    if (pattern === null) continue;
    if (envSanctioned) {
      hits.push({ pattern, sanctioned: true, source: 'env' });
    } else if (segmentHasMarker(seg.raw)) {
      hits.push({ pattern, sanctioned: true, source: 'command_marker' });
    } else {
      hits.push({ pattern, sanctioned: false });
    }
  }
  return hits;
}

// ── Rule catalog ────────────────────────────────────────────────────

const RULES: ReadonlyArray<Rule> = [
  // ── H1: git push --force / force-push refspec ────────────────────
  {
    id: 'H1',
    severity: 'HIGH',
    run: (ctx) => {
      const out: Violation[] = [];
      let fired = false;
      forEachSegment(ctx.cmd, (_raw, head) => {
        if (fired) return;
        // Anchor on `^git push` (the prefix-stripped form). The bash
        // 0.15.0 P1 fix anchored on this so a quoted-mention inside
        // `echo "git push --force is bad"` does not trigger.
        if (!/^git\s+push(\s|$)/i.test(head)) return;
        // `--force-with-lease` is the safe form — skip.
        if (/--force-with-lease/i.test(head)) return;
        // Match any of:
        //   --force | --force=<value>
        //   -[A-Za-z]*f[A-Za-z]*  (flag-cluster containing `f`)
        //   ` +<refspec>`  (refspec-prefix force-push shorthand)
        if (
          /--force(\s|=|$)/i.test(head) ||
          /(^|\s)-[A-Za-z]*f[A-Za-z]*(\s|$)/.test(head) ||
          /\s\+[A-Za-z0-9_./-]/.test(head)
        ) {
          fired = true;
          out.push({
            severity: 'HIGH',
            id: 'H1',
            label: 'git push --force — force push detected',
            detail:
              "Force-pushing rewrites public history and breaks collaborators' local copies.",
            alternatives: [
              "Alt: Use 'git push --force-with-lease' — blocks if upstream has new commits you haven't pulled.",
            ],
          });
        }
      });
      return out;
    },
  },
  // ── H2: git rebase advisory (MEDIUM) ─────────────────────────────
  {
    id: 'H2',
    severity: 'MEDIUM',
    run: (ctx) => {
      if (ctx.cmdIsRebaseSafe) return [];
      if (!anySegmentStartsWith(ctx.cmd, 'git\\s+rebase(\\s|$)')) return [];
      return [
        {
          severity: 'MEDIUM',
          id: 'H2',
          label: 'git rebase — rewrites commit history (advisory)',
          detail:
            'Rebase changes commit SHAs. Safe on local feature branches; dangerous on shared/published branches.',
          alternatives: [
            "Alt: 'git merge origin/main' preserves history (creates merge commit).",
            "     'git rebase --abort' to cancel if in progress.",
          ],
        },
      ];
    },
  },
  // ── H3: git checkout -- . ────────────────────────────────────────
  {
    id: 'H3',
    severity: 'HIGH',
    run: (ctx) => {
      if (!anySegmentStartsWith(ctx.cmd, 'git\\s+checkout\\s+--\\s+\\.')) {
        return [];
      }
      return [
        {
          severity: 'HIGH',
          id: 'H3',
          label: 'git checkout -- . — discards all uncommitted changes',
          detail:
            'Overwrites working tree changes with HEAD. Uncommitted work is lost permanently.',
          alternatives: [
            "Alt: 'git stash' to temporarily shelve changes, 'git restore <file>' for individual files.",
          ],
        },
      ];
    },
  },
  // ── H4: git restore . ────────────────────────────────────────────
  {
    id: 'H4',
    severity: 'HIGH',
    run: (ctx) => {
      // Two forms: `git restore <flags> .` and `git restore .` (bare).
      if (
        !anySegmentStartsWith(ctx.cmd, 'git\\s+restore\\s+.*\\s\\.(\\s|$)') &&
        !anySegmentStartsWith(ctx.cmd, 'git\\s+restore\\s+\\.\\s*$')
      ) {
        return [];
      }
      return [
        {
          severity: 'HIGH',
          id: 'H4',
          label: 'git restore . — discards all uncommitted changes',
          detail:
            'Restores every tracked file to HEAD, permanently discarding all working tree modifications.',
          alternatives: [
            "Alt: 'git stash' to save changes temporarily, or restore individual files: 'git restore <file>'.",
          ],
        },
      ];
    },
  },
  // ── H5: git clean -f ─────────────────────────────────────────────
  {
    id: 'H5',
    severity: 'HIGH',
    run: (ctx) => {
      if (ctx.cmdIsCleanDry) return [];
      if (!anySegmentStartsWith(ctx.cmd, 'git\\s+clean\\s+-[a-zA-Z]*f')) {
        return [];
      }
      return [
        {
          severity: 'HIGH',
          id: 'H5',
          label: 'git clean -f — removes untracked files',
          detail:
            'Permanently deletes untracked files from the working tree. Cannot be undone via git.',
          alternatives: [
            "Alt: 'git clean -n' (dry-run) to preview what would be deleted before committing.",
          ],
        },
      ];
    },
  },
  // ── H6: DROP TABLE / DROP DATABASE via psql ─────────────────────
  {
    id: 'H6',
    severity: 'HIGH',
    run: (ctx) => {
      // Bash form: `(psql|pgcli)[^|&;]*DROP[[:space:]]+(TABLE|DATABASE|SCHEMA)`
      // The `[^|&;]*` keeps the match within a single shell segment.
      // We use `anySegmentContains` so the segment splitter already
      // bounds the match — and a literal `[^|&;]*` regex inside a
      // segment is still safe.
      if (
        !anySegmentContains(
          ctx.cmd,
          '(psql|pgcli)[^|&;]*DROP\\s+(TABLE|DATABASE|SCHEMA)',
        )
      ) {
        return [];
      }
      return [
        {
          severity: 'HIGH',
          id: 'H6',
          label: 'DROP TABLE/DATABASE via psql — destructive DDL',
          detail:
            'Running destructive DDL directly in psql bypasses migration pipeline safety checks.',
          alternatives: [
            "Alt: Use your project's migration tool. Never run DROP via ad-hoc psql.",
          ],
        },
      ];
    },
  },
  // ── H7: kill -9 with pgrep subshell ─────────────────────────────
  {
    id: 'H7',
    severity: 'HIGH',
    run: (ctx) => {
      if (!anySegmentStartsWith(ctx.cmd, 'kill\\s+-9\\s+(\\$\\(|`)')) return [];
      return [
        {
          severity: 'HIGH',
          id: 'H7',
          label: 'kill -9 with pgrep subshell — aggressive process termination',
          detail:
            'Sends SIGKILL to processes matched by name, which may kill unintended processes.',
          alternatives: ["Alt: 'kill -15 <pid>' (SIGTERM) for graceful shutdown."],
        },
      ];
    },
  },
  // ── H8: killall -9 ──────────────────────────────────────────────
  {
    id: 'H8',
    severity: 'HIGH',
    run: (ctx) => {
      if (!anySegmentStartsWith(ctx.cmd, 'killall\\s+-9\\s+\\S')) return [];
      return [
        {
          severity: 'HIGH',
          id: 'H8',
          label: 'killall -9 — SIGKILL all matching processes',
          detail:
            'Immediately terminates all processes with the given name without cleanup.',
          alternatives: [
            "Alt: 'killall -15 <name>' (SIGTERM) allows graceful shutdown.",
          ],
        },
      ];
    },
  },
  // ── H9: git commit --no-verify ──────────────────────────────────
  {
    id: 'H9',
    severity: 'HIGH',
    run: (ctx) => {
      if (!anySegmentStartsWith(ctx.cmd, 'git\\s+commit.*--no-verify')) return [];
      return [
        {
          severity: 'HIGH',
          id: 'H9',
          label: 'git commit --no-verify — skipping pre-commit hooks',
          detail:
            'Bypasses all pre-commit safety gates including secret scanning and linting.',
          alternatives: [
            'Alt: Fix the underlying hook failure rather than bypassing it.',
          ],
        },
      ];
    },
  },
  // ── H10: HUSKY=0 bypass ─────────────────────────────────────────
  {
    id: 'H10',
    severity: 'HIGH',
    run: (ctx) => {
      if (!anySegmentRawMatches(ctx.cmd, '^HUSKY=0\\s+git\\s+(commit|push|tag)')) {
        return [];
      }
      return [
        {
          severity: 'HIGH',
          id: 'H10',
          label: 'HUSKY=0 — bypasses all husky git hooks',
          detail:
            'Setting HUSKY=0 disables pre-commit, commit-msg, and pre-push safety gates without --no-verify.',
          alternatives: [
            'Alt: Fix the underlying hook failure rather than suppressing all hooks.',
          ],
        },
      ];
    },
  },
  // ── H11: rm -rf with broad targets ──────────────────────────────
  {
    id: 'H11',
    severity: 'HIGH',
    run: (ctx) => {
      // Target alternation — must end with whitespace or EOS so `.git/foo`
      // (legitimate .git/ cleanup) doesn't trigger. Mirrors the bash
      // 0.15.0 fix.
      const TARGETS = '(\\/|~\\/|\\.\\/\\*|\\*|\\.|src|dist|build|node_modules)(\\s|$)';
      const variants = [
        // -rf, -fr
        `rm\\s+-[a-zA-Z]*r[a-zA-Z]*f\\s+${TARGETS}`,
        `rm\\s+-[a-zA-Z]*f[a-zA-Z]*r\\s+${TARGETS}`,
        // split flags
        `rm\\s+-[a-zA-Z]*r\\s+-[a-zA-Z]*f\\s+${TARGETS}`,
        `rm\\s+-[a-zA-Z]*f\\s+-[a-zA-Z]*r\\s+${TARGETS}`,
        // long flags
        `rm\\s+--recursive\\s+--force\\s+${TARGETS}`,
        `rm\\s+--force\\s+--recursive\\s+${TARGETS}`,
      ];
      const hit = variants.some((p) => anySegmentStartsWith(ctx.cmd, p));
      if (!hit) return [];
      return [
        {
          severity: 'HIGH',
          id: 'H11',
          label: 'rm -rf with broad target — mass file deletion',
          detail: 'Permanently deletes files and directories. Cannot be undone.',
          alternatives: [
            "Alt: Move to a temp location first, or use 'rm -ri' for interactive deletion.",
          ],
        },
      ];
    },
  },
  // ── H12: curl/wget piped to shell ───────────────────────────────
  {
    id: 'H12',
    severity: 'HIGH',
    run: (ctx) => {
      // Pipe-RCE is fundamentally multi-segment. Scan the WHOLE command
      // (not split) via quoteMaskedCmd to skip quoted-mention false
      // positives, then iterate nested-shell payloads so
      // `zsh -c "curl … | sh"` also fires.
      const lines = unwrapNestedShells(ctx.cmd);
      const re = /(curl|wget)[^|]*\|\s*(sudo\s+)?(bash|sh|zsh|fish)/i;
      for (const line of lines) {
        if (line.length === 0) continue;
        const masked = quoteMaskedCmd(line);
        if (re.test(masked)) {
          return [
            {
              severity: 'HIGH',
              id: 'H12',
              label: 'curl/wget piped to shell — remote code execution',
              detail:
                'Executing remote scripts without inspection is a major supply chain risk.',
              alternatives: [
                'Alt: Download first, inspect the script, then execute: curl -o script.sh URL && cat script.sh && bash script.sh',
              ],
            },
          ];
        }
      }
      return [];
    },
  },
  // ── H13: git push --no-verify ───────────────────────────────────
  {
    id: 'H13',
    severity: 'HIGH',
    run: (ctx) => {
      if (!anySegmentStartsWith(ctx.cmd, 'git\\s+push.*--no-verify')) return [];
      return [
        {
          severity: 'HIGH',
          id: 'H13',
          label: 'git push --no-verify — skipping pre-push hooks',
          detail: 'Bypasses all pre-push safety gates including CI checks.',
          alternatives: [
            'Alt: Fix the underlying hook failure rather than bypassing it.',
          ],
        },
      ];
    },
  },
  // ── H14: git -c core.hooksPath ─────────────────────────────────
  {
    id: 'H14',
    severity: 'HIGH',
    run: (ctx) => {
      if (!anySegmentStartsWith(ctx.cmd, 'git\\s+-c\\s+core\\.hookspath')) {
        return [];
      }
      return [
        {
          severity: 'HIGH',
          id: 'H14',
          label: 'git -c core.hooksPath — overriding hooks directory',
          detail: 'Redirecting the hooks path can disable all safety hooks.',
          alternatives: [
            'Alt: Fix the underlying hook issue. Do not bypass the hooks directory.',
          ],
        },
      ];
    },
  },
  // ── H15: REA_BYPASS env var ─────────────────────────────────────
  {
    id: 'H15',
    severity: 'HIGH',
    run: (ctx) => {
      if (!anySegmentRawMatches(ctx.cmd, '^REA_BYPASS\\s*=')) return [];
      return [
        {
          severity: 'HIGH',
          id: 'H15',
          label: 'REA_BYPASS env var — unauthorized bypass attempt',
          detail:
            'Setting REA_BYPASS is not a supported escape mechanism and indicates a bypass attempt.',
          alternatives: ['Alt: If you need to override a gate, request human escalation.'],
        },
      ];
    },
  },
  // ── H16: alias/function with bypass strings ─────────────────────
  {
    id: 'H16',
    severity: 'HIGH',
    run: (ctx) => {
      if (
        !anySegmentRawMatches(
          ctx.cmd,
          '^(alias|function)\\s+[a-zA-Z_]+.*(--(no-verify|force)|HUSKY=0|core\\.hookspath)',
        )
      ) {
        return [];
      }
      return [
        {
          severity: 'HIGH',
          id: 'H16',
          label: 'Alias/function definition with bypass — circumventing safety gates',
          detail:
            'Defining aliases or functions that embed bypass flags defeats safety hooks.',
          alternatives: ['Alt: Do not wrap bypass patterns in aliases or functions.'],
        },
      ];
    },
  },
  // ── H17: context_protection delegate-to-subagent ────────────────
  {
    id: 'H17',
    severity: 'HIGH',
    run: (ctx) => {
      // Round-1 P1: block when ANY matching segment is UNSANCTIONED —
      // a sanctioned segment elsewhere in a compound command does not
      // excuse an unsanctioned delegate-listed segment running in the
      // coordinator. Sanctioned segments pass (and are audited by the
      // caller). The block copy names an actually-traversable path.
      const unsanctioned = ctx.delegateHits.find((h) => !h.sanctioned);
      if (unsanctioned === undefined) return [];
      const hit = unsanctioned.pattern;
      return [
        {
          severity: 'HIGH',
          id: 'H17',
          label: 'Context protection — command must run in a subagent',
          detail:
            'This command produces excessive output that will exhaust the coordinator context window. Run it in a DISPOSABLE context, not the coordinator.',
          alternatives: [
            `Alt: Delegate to a subagent: Agent(subagent_type: 'qa-engineer-automation', prompt: 'Run ${hit} and report only a pass/fail summary.')`,
            `Alt: If you ARE the delegated runner (disposable context), re-run as: REA_DELEGATED_RUN=1 ${hit} — this is allowed and recorded on the audit chain.`,
            'Alt: The context_protection.delegate_to_subagent list in .rea/policy.yaml defines these commands (all runner forms — pnpm/npx/exec/direct-binary — are covered).',
          ],
        },
      ];
    },
  },
  // ── M1: npm install --force ─────────────────────────────────────
  {
    id: 'M1',
    severity: 'MEDIUM',
    run: (ctx) => {
      if (!anySegmentContains(ctx.cmd, 'npm\\s+(install|i)\\s+.*--force')) {
        return [];
      }
      return [
        {
          severity: 'MEDIUM',
          id: 'M1',
          label: 'npm install --force — bypasses dependency resolution',
          detail:
            '--force skips conflict checks and can install incompatible package versions.',
          alternatives: [
            'Alt: Resolve the dependency conflict explicitly. Use --legacy-peer-deps if needed.',
          ],
        },
      ];
    },
  },
];

function buildBlockBanner(violations: Violation[], cmdDisplay: string): string {
  const lines = ['BASH INTERCEPTED: Dangerous command blocked\n'];
  for (const v of violations) {
    lines.push(`  ${v.severity}: ${v.label}\n`);
    lines.push(`  Reason: ${v.detail}\n`);
    for (const alt of v.alternatives) {
      lines.push(`  ${alt}\n`);
    }
    lines.push('\n');
  }
  lines.push(`  BLOCKED COMMAND: ${cmdDisplay}\n`);
  return lines.join('');
}

function buildAdvisoryBanner(violations: Violation[], cmdDisplay: string): string {
  const lines = ['BASH ADVISORY: Potentially risky command (not blocked)\n'];
  for (const v of violations) {
    lines.push(`  ${v.severity}: ${v.label}\n`);
    lines.push(`  Note: ${v.detail}\n`);
    for (const alt of v.alternatives) {
      lines.push(`  ${alt}\n`);
    }
    lines.push('\n');
  }
  lines.push(`  COMMAND: ${cmdDisplay}\n`);
  return lines.join('');
}

/**
 * Load the `context_protection.delegate_to_subagent` patterns from
 * policy.yaml. Failure (missing file, unparseable YAML, missing key)
 * returns an empty list — same posture as the bash hook's
 * `policy_list "delegate_to_subagent"` which gracefully yields no
 * entries on missing/malformed policy.
 *
 * 2026-05-15 codex round-2 P2 fix: do NOT use `loadPolicy()`. The
 * strict zod schema rejects unknown keys (`zod.strict()`), which means
 * a partial / migrating policy.yaml with ANY legacy field anywhere in
 * the tree causes `loadPolicy()` to throw → the catch swallows it →
 * delegate list collapses to `[]` → H17 patterns silently disabled.
 *
 * Same class as the 0.33.0 round-1 P3 fix for architecture-review-gate.
 * Mirror that pattern: read the YAML directly via the canonical
 * permissive parser (`yaml.parse()`) and pull ONLY the
 * `context_protection.delegate_to_subagent` field. Unknown keys
 * ELSEWHERE in the policy are tolerated — only this subset matters
 * for H17.
 *
 * The bash hook's `policy_list "delegate_to_subagent"` reads the same
 * field via awk without any schema validation, so this aligns the
 * Node port with the bash hook's permissive posture.
 */
function loadDelegatePatterns(reaRoot: string): string[] {
  const policyPath = path.join(reaRoot, '.rea', 'policy.yaml');
  let raw: string;
  try {
    raw = fs.readFileSync(policyPath, 'utf8');
  } catch {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return [];
  }
  const cp = (parsed as Record<string, unknown>)['context_protection'];
  if (cp === null || cp === undefined || typeof cp !== 'object' || Array.isArray(cp)) {
    return [];
  }
  const delegates = (cp as Record<string, unknown>)['delegate_to_subagent'];
  if (!Array.isArray(delegates)) return [];
  const out: string[] = [];
  for (const entry of delegates) {
    if (typeof entry === 'string' && entry.length > 0) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Pure executor. Returns `{ exitCode, stderr, violations }`; the CLI
 * wrapper translates them into `process.stderr.write` + `process.exit`.
 */
export async function runDangerousBashInterceptor(
  options: DangerousBashOptions = {},
): Promise<DangerousBashResult> {
  let stderr = '';
  const writeStderr = (s: string): void => {
    stderr += s;
    if (options.stderrWrite) options.stderrWrite(s);
  };

  // 2. Read + parse stdin.
  const stdinRaw =
    options.stdinOverride !== undefined
      ? options.stdinOverride
      : await readStdinWithTimeout(5_000);

  let toolName = '';
  let cmd = '';
  let payloadCwd = '';
  try {
    const payload = parseHookPayload(stdinRaw);
    payloadCwd = payload.cwd;
    toolName = payload.toolName;
    cmd = payload.command;
  } catch (err) {
    if (err instanceof MalformedPayloadError || err instanceof TypePayloadError) {
      writeStderr(
        `dangerous-bash-interceptor: ${err.message} — refusing on uncertainty.\n`,
      );
      return { exitCode: 2, stderr, violations: [] };
    }
    throw err;
  }

  // Roots + HALT (0.54.0 worktree state): the payload's `cwd` feeds the
  // resolution ladder, so stdin is parsed FIRST — a deliberate reorder.
  // Policy/path checks key off the LOCAL (worktree) root; audit and the
  // kill switch key off the COMMON (repository) root.
  const { localRoot: reaRoot, commonRoot } = resolveHookRoots(payloadCwd, options.reaRoot);
  // 1. HALT check.
  const halt = checkHaltRoots(reaRoot, commonRoot);
  if (halt.halted) {
    writeStderr(formatHaltBanner(halt.reason));
    return { exitCode: 2, stderr, violations: [] };
  }

  // 3. Non-Bash tool calls bypass — Claude Code's hook matcher
  //    already filters to Bash but defense-in-depth.
  if (toolName !== '' && toolName !== 'Bash') {
    return { exitCode: 0, stderr, violations: [] };
  }

  // 4. Empty command → allow.
  if (cmd.length === 0) {
    return { exitCode: 0, stderr, violations: [] };
  }

  // 5. Smart exclusion flags.
  const cmdIsRebaseSafe = anySegmentStartsWith(
    cmd,
    'git\\s+(rebase)\\s.*(--abort|--continue)',
  );
  const cmdIsCleanDry = anySegmentStartsWith(
    cmd,
    'git\\s+clean.*([ \\t]-n|--dry-run)',
  );

  // 6. Delegate patterns + sanctioned-run detection (bug H17).
  const delegatePatterns = loadDelegatePatterns(reaRoot);
  const delegateHits = analyzeDelegateSegments(cmd, delegatePatterns);

  // 7. Run every rule.
  const ctx: RuleContext = {
    cmd,
    cmdIsRebaseSafe,
    cmdIsCleanDry,
    delegatePatterns,
    delegateHits,
  };
  const violations: Violation[] = [];
  for (const rule of RULES) {
    violations.push(...rule.run(ctx));
  }
  const highs = violations.filter((v) => v.severity === 'HIGH');

  // H17: a sanctioned delegated run of a delegate-listed command passes
  // the gate but is RECORDED — the marker is a visible, audited escape
  // hatch (like REA_SKIP_*), so a coordinator forging it leaves a trail
  // on the hash chain. Round-1 P3: the record is written ONLY when the
  // invocation is actually ALLOWED (no HIGH violation) — a sanctioned
  // command another rule (H1/H11/…) still blocks never ran, so an
  // `Allowed` audit line for it would be a false record. Round-1 P1:
  // one record per unique sanctioned pattern (per-segment analysis).
  // Audit keys off the COMMON (repository) root.
  if (highs.length === 0) {
    const seen = new Set<string>();
    for (const hit of delegateHits) {
      if (!hit.sanctioned || seen.has(hit.pattern)) continue;
      seen.add(hit.pattern);
      try {
        await appendAuditRecord(commonRoot, {
          tool_name: 'rea.context_protection',
          server_name: 'rea',
          tier: Tier.Read,
          status: InvocationStatus.Allowed,
          metadata: {
            event: 'delegated_run_sanctioned',
            pattern: hit.pattern,
            sanction_source: hit.source ?? 'command_marker',
            command_preview: cmd.slice(0, 256),
          },
        });
      } catch (auditErr) {
        // Soft (MEDIUM) context gate — do NOT fail the run on an
        // audit-infra hiccup; surface it so the missing record is
        // visible, then allow (the coordinator gate is unaffected).
        writeStderr(
          `dangerous-bash-interceptor: H17 sanctioned-run audit append failed (${
            auditErr instanceof Error ? auditErr.message : String(auditErr)
          }); allowing the delegated run.\n`,
        );
      }
    }
  }

  if (violations.length === 0) {
    return { exitCode: 0, stderr, violations: [] };
  }

  const display = truncate(cmd);
  if (highs.length > 0) {
    writeStderr(buildBlockBanner(violations, display));
    return { exitCode: 2, stderr, violations };
  }
  writeStderr(buildAdvisoryBanner(violations, display));
  return { exitCode: 0, stderr, violations };
}

/**
 * CLI entry point — `rea hook dangerous-bash-interceptor`.
 */
export async function runHookDangerousBashInterceptor(
  options: DangerousBashOptions = {},
): Promise<void> {
  const result = await runDangerousBashInterceptor({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}

// Internal exports for byte-fidelity / rule-catalog tests.
export const __INTERNAL_FOR_TESTS = {
  RULES,
};
