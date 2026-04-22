/**
 * Refspec parsing. Two input shapes the gate must accept:
 *
 *   1. Git pre-push hook stdin — one line per refspec, fields:
 *        `<local_ref> <local_sha> <remote_ref> <remote_sha>`
 *      (https://git-scm.com/docs/githooks#_pre_push)
 *
 *   2. Claude-Code `Bash`-PreToolUse command string — parse `git push [remote]
 *      [refspec...]` out of the command, synthesize refspec records against
 *      the caller's HEAD/@{upstream}.
 *
 * Shape 1 is authoritative when present; shape 2 is a fallback for the
 * Claude-Code adapter (BUG-008 sniff). See design §3.2 for the adapter
 * split and §5.1 for the scenarios covered by unit tests.
 *
 * ## Defect J — mixed-push deletion guard
 *
 * A push like `git push origin safe:safe :main` contains both a push refspec
 * and a deletion refspec. The bash core has been burned twice by nesting the
 * deletion check inside the "no SOURCE_SHA resolved" fallback branch, which
 * lets the deletion slip through whenever a sibling refspec DID resolve.
 * This module exposes `hasDeletion()` as a separate predicate so the caller
 * can fail-closed on deletions up front, before any refspec-selection logic.
 */

import { ZERO_SHA } from './constants.js';
import {
  BlockedError,
  DeletionBlockedError,
  HeadRefspecBlockedError,
  InvalidDeleteRefspecError,
} from './errors.js';

const SHA_HEX_40 = /^[0-9a-f]{40}$/;

/**
 * One parsed refspec record. Either a push (local_sha != ZERO_SHA) or a
 * deletion (local_sha === ZERO_SHA). `source_is_head` flags the
 * argv-fallback case where no explicit source ref was named and the parser
 * substituted HEAD.
 */
export interface RefspecRecord {
  local_sha: string;
  remote_sha: string;
  local_ref: string;
  remote_ref: string;
  /** True when the parser had to fall back to HEAD for the source ref. */
  source_is_head: boolean;
  /** True when `local_sha === ZERO_SHA` (this refspec is a branch deletion). */
  is_deletion: boolean;
}

export interface ParseStdinResult {
  records: RefspecRecord[];
  /** The parser accepted at least one well-formed line from stdin. */
  matched: boolean;
}

/**
 * Parse the git pre-push stdin contract.
 *
 * Returns `{ records, matched: true }` when at least one refspec line
 * parsed cleanly; `{ records: [], matched: false }` otherwise.
 *
 * ## Bash-core parity (push-review-core.sh §45-69)
 *
 * The bash parser uses `read -r local_ref local_sha remote_ref remote_sha rest`
 * against each line, so:
 *   - Lines with fewer than the required fields leave some vars empty and
 *     the loop `continue`s via the `-z` check (line 54-56). Parser does NOT
 *     abort the overall parse — subsequent lines still get a chance.
 *   - Extra whitespace-separated fields collapse into `rest` and are
 *     silently dropped (line 53's `rest` capture absorbs everything past
 *     field four).
 *   - Only a 40-hex SHA failure on either sha triggers `return 1` (line
 *     57-59), aborting the whole parse — the caller falls through to argv.
 *   - If no lines accept (`accepted=0` at line 63-65), the parser also
 *     returns 1.
 *
 * We mirror that exactly. Codex pass-1 on phase 1 flagged an earlier
 * too-strict version that aborted on short/long lines and would have
 * starved the authoritative stdin path when consumer pre-push wrappers
 * emit extra trailing whitespace columns (e.g. a comment or a trailing
 * remote-url duplicate).
 *
 * Empty / whitespace-only lines are skipped silently.
 *
 * @param raw the full stdin bytes as a string
 */
export function parsePrepushStdin(raw: string): ParseStdinResult {
  const records: RefspecRecord[] = [];
  if (raw.length === 0) return { records, matched: false };

  const lines = raw.split('\n');
  let accepted = false;
  for (const line of lines) {
    if (line.trim().length === 0) continue;
    // bash `read -r a b c d rest` takes the first 4 whitespace-separated
    // tokens and rolls everything else into `rest` (which we ignore).
    const parts = line.trim().split(/\s+/);
    const local_ref = parts[0] ?? '';
    const local_sha = parts[1] ?? '';
    const remote_ref = parts[2] ?? '';
    const remote_sha = parts[3] ?? '';
    // Missing required fields: bash `continue`s silently. Do the same —
    // DO NOT abort the whole parse, so a later well-formed line can still
    // be accepted.
    if (
      local_ref.length === 0 ||
      local_sha.length === 0 ||
      remote_ref.length === 0 ||
      remote_sha.length === 0
    ) {
      continue;
    }
    // Invalid SHA on a line that otherwise has all 4 fields: bash
    // `return 1`s the whole parse so the caller falls through to the argv
    // fallback. Match that — return matched:false with no records.
    if (!SHA_HEX_40.test(local_sha) || !SHA_HEX_40.test(remote_sha)) {
      return { records: [], matched: false };
    }
    records.push({
      local_sha,
      remote_sha,
      local_ref,
      remote_ref,
      source_is_head: false,
      is_deletion: local_sha === ZERO_SHA,
    });
    accepted = true;
  }

  return { records, matched: accepted };
}

/**
 * Return true iff any refspec in the list is a branch deletion (defect J).
 * Callers must check this before any refspec-selection pass; the bash core
 * pre-0.9.4 nested the check inside the "no SOURCE_SHA resolved" branch and
 * let mixed pushes bypass the gate.
 */
export function hasDeletion(records: RefspecRecord[]): boolean {
  return records.some((r) => r.is_deletion);
}

/**
 * A `ResolveHead` callback returns the SHA of a source ref, or `null` when
 * the ref is unknown. Injected here (rather than shelling out to `git`
 * directly) so `args.ts` stays pure and unit-testable without a git repo.
 * The real implementation lives in `diff.ts` / `base-resolve.ts`.
 */
export type ResolveHead = (ref: string) => string | null;

export interface ArgvFallbackDeps {
  /** Resolve a source ref (e.g. `feature/foo`) to a commit SHA, or null. */
  resolveHead: ResolveHead;
  /** Current HEAD SHA for bare `git push` with no explicit refspec. */
  headSha: string;
  /** `@{upstream}` short name (e.g. `origin/main`) or null. */
  upstream: string | null;
}

/**
 * Parse refspecs out of a `git push [remote] [refspec...]` command string.
 * Used only when stdin-parsing returned `matched: false` (Claude-Code
 * adapter path).
 *
 * Behavior mirrors the bash core's `pr_resolve_argv_refspecs` exactly:
 *   - Bare `git push` with no explicit refspec → synthesize a single record
 *     against `@{upstream}` (or `main` when no upstream), local_sha = HEAD.
 *   - `git push origin foo` → source=foo, dest=foo.
 *   - `git push origin src:dst` → source=src, dest=dst.
 *   - `git push origin :main` → deletion record.
 *   - `git push origin --delete main` → deletion record.
 *   - `git push origin HEAD:main` → resolves via `resolveHead('HEAD')`;
 *     the bash core rejects HEAD only when it lands on the DESTINATION
 *     side of the refspec (dst == 'HEAD'), not the source side. We match.
 *   - `git push origin HEAD` → HeadRefspecBlockedError (dst resolves to
 *     HEAD because src==dst when no colon is present).
 *
 * Throws `BlockedError` subclasses for operator-error conditions so the
 * caller can translate them to exit 2 + banner identical to the bash core.
 */
export function resolveArgvRefspecs(cmd: string, deps: ArgvFallbackDeps): RefspecRecord[] {
  const segment = extractPushSegment(cmd);
  const tokens = tokenizePushSegment(segment);
  const specs: string[] = [];
  let seenPush = false;
  let remoteSeen = false;
  let deleteMode = false;

  for (const tok of tokens) {
    if (tok === 'git' || tok === 'push') {
      seenPush = true;
      continue;
    }
    if (tok === '--delete' || tok === '-d') {
      deleteMode = true;
      continue;
    }
    if (tok.startsWith('--delete=')) {
      // Bash-core parity (push-review-core.sh §108-112): `--delete=<ref>`
      // sets delete_mode AND inlines the ref into specs WITHOUT the
      // `__REA_DELETE__` sentinel. In the existing bash implementation
      // this produces a non-deletion refspec record — the `delete_mode`
      // flag only affects tokens that appear AFTER the flag, not the
      // inlined ref. Documented upstream as a pre-existing bash quirk;
      // phase 1's job is byte-for-byte bash parity, so we mirror it even
      // though it looks counter-intuitive. A follow-up may harden both
      // implementations together (design §11.1 phase 4 window).
      deleteMode = true;
      specs.push(tok.slice('--delete='.length));
      continue;
    }
    if (tok.startsWith('-')) continue;
    if (!seenPush) continue;
    if (!remoteSeen) {
      remoteSeen = true;
      continue;
    }
    if (deleteMode) {
      specs.push(`__REA_DELETE__${tok}`);
    } else {
      specs.push(tok);
    }
  }

  if (specs.length === 0) {
    // Bare `git push` — one record against @{upstream} or main.
    let dstRef = 'refs/heads/main';
    if (deps.upstream && deps.upstream.includes('/')) {
      const short = deps.upstream.slice(deps.upstream.indexOf('/') + 1);
      dstRef = `refs/heads/${short}`;
    }
    if (deps.headSha.length === 0) {
      throw new BlockedError(
        'PUSH_BLOCKED_SOURCE_UNRESOLVABLE',
        'could not resolve HEAD to a commit; aborting review-gate argv fallback.',
      );
    }
    return [
      {
        local_sha: deps.headSha,
        remote_sha: ZERO_SHA,
        local_ref: 'HEAD',
        remote_ref: dstRef,
        source_is_head: true,
        is_deletion: false,
      },
    ];
  }

  const records: RefspecRecord[] = [];
  for (const rawSpec of specs) {
    let spec = rawSpec;
    let isDelete = false;
    if (spec.startsWith('__REA_DELETE__')) {
      isDelete = true;
      spec = spec.slice('__REA_DELETE__'.length);
    }
    if (spec.startsWith('+')) spec = spec.slice(1);
    let src: string;
    let dst: string;
    if (spec.includes(':')) {
      src = spec.slice(0, spec.indexOf(':'));
      dst = spec.slice(spec.lastIndexOf(':') + 1);
    } else {
      src = spec;
      dst = spec;
    }
    if (dst.length === 0) {
      // `src:` with empty destination — the bash core treated this as a
      // deletion with dst = last component of spec. For safety, reject.
      dst = spec.split(':').pop() ?? '';
      src = '';
    }
    dst = stripRefsPrefix(dst);

    if (isDelete) {
      if (dst.length === 0 || dst === 'HEAD') {
        // Bash-core parity (push-review-core.sh §161-168): delete-mode
        // HEAD/empty destination uses a distinct operator banner —
        // "--delete refspec resolves to HEAD or empty" — rather than the
        // general "refspec resolves to HEAD" message, because the
        // remediation is different ("name the branch you meant to
        // delete", not "name the destination explicitly").
        throw new InvalidDeleteRefspecError(rawSpec);
      }
      records.push({
        local_sha: ZERO_SHA,
        remote_sha: ZERO_SHA,
        local_ref: '(delete)',
        remote_ref: `refs/heads/${dst}`,
        source_is_head: false,
        is_deletion: true,
      });
      continue;
    }

    if (dst === 'HEAD' || dst.length === 0) {
      throw new HeadRefspecBlockedError(rawSpec);
    }

    if (src.length === 0) {
      // `:main` — deletion.
      records.push({
        local_sha: ZERO_SHA,
        remote_sha: ZERO_SHA,
        local_ref: '(delete)',
        remote_ref: `refs/heads/${dst}`,
        source_is_head: false,
        is_deletion: true,
      });
      continue;
    }

    const resolved = deps.resolveHead(src);
    if (resolved === null || !SHA_HEX_40.test(resolved)) {
      throw new BlockedError(
        'PUSH_BLOCKED_SOURCE_UNRESOLVABLE',
        `could not resolve source ref ${JSON.stringify(src)} to a commit.`,
        { ref: src },
      );
    }
    records.push({
      local_sha: resolved,
      remote_sha: ZERO_SHA,
      local_ref: `refs/heads/${src}`,
      remote_ref: `refs/heads/${dst}`,
      source_is_head: false,
      is_deletion: false,
    });
  }

  // Deletion-first check (defect J): if ANY deletion resolved, the caller
  // will re-check via hasDeletion(). We do NOT throw here because the caller
  // may want to include push-side records in audit metadata before blocking.
  void DeletionBlockedError; // pulled so tree-shaking keeps the export chain.
  return records;
}

/**
 * Extract the `git push ...` segment from a command string, stopping at the
 * first shell separator (`;`, `&&`, `||`, `|`, `&`). Returns an empty
 * string when no `git push` is present — the caller bails out upstream.
 */
function extractPushSegment(cmd: string): string {
  const pushMatch = cmd.match(/git\s+push(?:\s|$)/);
  if (!pushMatch || pushMatch.index === undefined) return '';
  const tail = cmd.slice(pushMatch.index);
  const sepMatch = tail.match(/;|\|{1,2}|&{1,2}/);
  if (sepMatch && sepMatch.index !== undefined) {
    return tail.slice(0, sepMatch.index);
  }
  return tail;
}

/**
 * Split a `git push ...` segment into whitespace-separated tokens. This is
 * intentionally naive (no quote handling) — the bash core does the same
 * via `set -- $segment`, and preserving the bug-for-bug shape means we do
 * not silently start accepting quoted refspecs the bash core would have
 * rejected.
 */
function tokenizePushSegment(segment: string): string[] {
  return segment.split(/\s+/).filter((t) => t.length > 0);
}

/**
 * Strip `refs/heads/` or `refs/for/` prefixes so caller-facing code sees a
 * bare branch name. Exported for unit tests in `args.test.ts`.
 */
export function stripRefsPrefix(ref: string): string {
  if (ref.startsWith('refs/heads/')) return ref.slice('refs/heads/'.length);
  if (ref.startsWith('refs/for/')) return ref.slice('refs/for/'.length);
  return ref;
}
