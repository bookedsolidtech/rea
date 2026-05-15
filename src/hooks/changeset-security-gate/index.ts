/**
 * Node-binary port of `hooks/changeset-security-gate.sh`.
 *
 * 0.33.0 Phase 1 port #3.
 *
 * Guards `.changeset/*.md` files against two failure modes:
 *
 *   1. SECURITY DISCLOSURE LEAK — a GHSA or CVE identifier in a
 *      changeset file becomes public via CHANGELOG.md when the
 *      release ships. Block the write.
 *   2. MISSING OR MALFORMED FRONTMATTER — a changeset without a
 *      proper frontmatter block is silently ignored by the
 *      changesets tool, wasting the release entry. Block the write.
 *
 * Behavioral contract preserves the bash hook byte-for-byte:
 *
 *   1. HALT check → exit 2 with shared banner.
 *   2. Tool filter: only `Write`, `Edit`, `MultiEdit`, `NotebookEdit`.
 *      Any other tool exits 0.
 *   3. File-path filter: only `.changeset/*.md` files. The
 *      `.changeset/README.md` companion is excluded (it's metadata
 *      for the changesets tool itself).
 *   4. Security disclosure scan on the resolved content. The
 *      ordered pattern list is reproduced verbatim. First match wins;
 *      emit the `MATCHED_PATTERN` placeholder.
 *   5. MultiEdit short-circuit for frontmatter: MultiEdit's
 *      `edits[].new_string` is a list of replacement FRAGMENTS, not
 *      a full file. Running frontmatter validation against the
 *      concatenated fragments would reject every legitimate edit.
 *      The bash hook added this exemption in 0.15.0; we mirror it.
 *      The disclosure scan still runs on the fragments because
 *      GHSA/CVE patterns match per-fragment without structural
 *      assumption.
 *   6. Frontmatter validation:
 *        a. Must start with `---`.
 *        b. Must contain at least one `<pkg>: (patch|minor|major)`
 *           entry inside the first `---`/`---` block. Accepts
 *           single-quoted, double-quoted, and unquoted package
 *           names — same explicit alternation form as the bash hook
 *           (0.15.0 codex round-1 P2-1 fix).
 *        c. Must have a non-empty description after the closing
 *           `---`.
 *
 * Block emissions use the Claude Code PreToolUse JSON-on-stdout
 * protocol via `emitJsonBlock`, mirroring `_lib/common.sh::json_output`
 * — JSON on stdout AND the human reason on stderr, exit 2.
 */

import type { Buffer } from 'node:buffer';
import { checkHalt, formatHaltBanner } from '../_lib/halt-check.js';
import {
  parseWriteHookPayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';

export interface ChangesetSecurityGateOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
  stdoutWrite?: (s: string) => void;
}

export interface ChangesetSecurityGateResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

/**
 * Tool names accepted by this gate. Mirrors the bash hook's
 * `[[ "$TOOL_NAME" != "Write" && ... ]]` chain.
 */
const ACCEPTED_TOOLS: ReadonlySet<string> = new Set([
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
]);

/**
 * Pattern list for the disclosure scan. Order matters — first match
 * wins, and the matched pattern string lands in the operator banner.
 */
const DISCLOSURE_PATTERNS: ReadonlyArray<RegExp> = [
  /GHSA-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}/,
  /CVE-[0-9]{4}-[0-9]+/,
];

/**
 * Source strings for the disclosure patterns — these are what the
 * bash hook emitted in its `MATCHED_PATTERN` placeholder so the
 * operator banner matches byte-for-byte.
 */
const DISCLOSURE_PATTERN_SOURCES: ReadonlyArray<string> = [
  'GHSA-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}-[0-9A-Za-z]{4}',
  'CVE-[0-9]{4}-[0-9]+',
];

/**
 * Frontmatter package-bump line. Accepts:
 *   - "@scope/name": patch
 *   - '@scope/name': minor
 *   -  @scope/name : major     (unquoted)
 * Mirrors the bash hook's explicit-alternation form (codex P2-1).
 */
const FRONTMATTER_BUMP_PATTERN =
  /^("[^"]+"|'[^']+'|[^"'\s]+): (patch|minor|major)/;

function emitJsonBlock(reason: string): { json: string; stderr: string } {
  const obj = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  return { json: JSON.stringify(obj) + '\n', stderr: reason + '\n' };
}

/**
 * Test the file path against the `.changeset/*.md` predicate. Mirrors
 * the bash hook's two grep calls:
 *   - must match `\.changeset/[^/]+\.md$`
 *   - must NOT match `\.changeset/README\.md$`
 */
function isChangesetFile(filePath: string): boolean {
  if (!/\.changeset\/[^/]+\.md$/.test(filePath)) return false;
  if (/\.changeset\/README\.md$/.test(filePath)) return false;
  return true;
}

/**
 * Find the first matching disclosure pattern. Returns the source
 * string (for the operator banner) or `null` when none match.
 */
function firstDisclosureMatch(content: string): string | null {
  for (let i = 0; i < DISCLOSURE_PATTERNS.length; i += 1) {
    const re = DISCLOSURE_PATTERNS[i];
    if (re !== undefined && re.test(content)) {
      return DISCLOSURE_PATTERN_SOURCES[i] ?? null;
    }
  }
  return null;
}

/**
 * Extract the frontmatter block (between the first `---` and the
 * second `---`). Returns the lines BETWEEN those delimiters, NOT
 * including the delimiters themselves. Mirrors the bash hook's
 * `awk '/^---/{count++; if(count==2){exit} next} count==1{print}'`.
 *
 * When the second `---` is missing the function returns whatever was
 * captured after the first `---`; the frontmatter validation regex
 * then fails for lack of a bump entry, exactly as bash awk would.
 */
function extractFrontmatter(content: string): string {
  const lines = content.split('\n');
  let dashCount = 0;
  const out: string[] = [];
  for (const line of lines) {
    if (/^---/.test(line)) {
      dashCount += 1;
      if (dashCount === 2) break;
      continue;
    }
    if (dashCount === 1) out.push(line);
  }
  return out.join('\n');
}

/**
 * Extract the first non-empty line AFTER the closing `---`. Mirrors
 * the bash hook's `awk 'BEGIN{count=0} /^---/{count++; next} count>=2{print}'
 * | grep -v '^[[:space:]]*$' | head -1`.
 */
function extractDescription(content: string): string {
  const lines = content.split('\n');
  let dashCount = 0;
  for (const line of lines) {
    if (/^---/.test(line)) {
      dashCount += 1;
      continue;
    }
    if (dashCount < 2) continue;
    if (line.trim().length === 0) continue;
    return line;
  }
  return '';
}

function buildDisclosureBanner(matched: string): string {
  return `CHANGESET SECURITY GATE: This changeset contains a security advisory identifier (matched: '${matched}').

Do NOT reference GHSA IDs or CVE numbers in changeset files before the advisory is published.
Changeset files are committed to git — this creates pre-disclosure in public history and CHANGELOG.

CORRECT approach for security fix changesets:
  Use vague language only — no identifiers, no vulnerability details.

  WRONG:  'fix(hooks): patch GHSA-3w3m-7gg4-f82g — symlink-guard now covers Edit tool'
  RIGHT:  'security: extend symlink protection to cover all write-capable tools'

  WRONG:  'security: fix CVE-2026-1234 prompt injection via tool descriptions'
  RIGHT:  'security: harden middleware chain against indirect instruction attacks'

After the release ships:
  1. Publish the GitHub Security Advisory (Security tab → Advisories → Publish)
  2. The GHSA becomes the detailed public disclosure document
  3. Optionally update CHANGELOG.md post-publish to add the GHSA reference`;
}

const MISSING_FRONTMATTER_BANNER = `CHANGESET FORMAT GATE: Missing frontmatter block.

Every changeset must start with a frontmatter block specifying which package to bump:

---
'@bookedsolid/rea': patch
---

Brief description of what changed and why (close #N if applicable).

Bump types: patch (bug fix/security), minor (new feature), major (breaking change)`;

const INVALID_FRONTMATTER_BANNER = `CHANGESET FORMAT GATE: Frontmatter does not contain a valid package bump entry.

The frontmatter must include at least one package/bump pair:

---
'@bookedsolid/rea': patch
---

Valid bump types: patch | minor | major`;

const MISSING_DESCRIPTION_BANNER = `CHANGESET FORMAT GATE: Missing description after frontmatter.

Add a meaningful description explaining what changed and why:

---
'@bookedsolid/rea': patch
---

fix(gateway): policy-loader now uses async I/O with 500ms TTL cache

Previously, loadPolicy used fs.readFileSync on every tool invocation, blocking
the event loop under concurrency. Closes #34.`;

export async function runChangesetSecurityGate(
  options: ChangesetSecurityGateOptions = {},
): Promise<ChangesetSecurityGateResult> {
  const reaRoot =
    options.reaRoot ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
  let stderr = '';
  let stdout = '';
  const writeStderr = (s: string): void => {
    stderr += s;
    if (options.stderrWrite) options.stderrWrite(s);
  };
  const writeStdout = (s: string): void => {
    stdout += s;
    if (options.stdoutWrite) options.stdoutWrite(s);
  };

  // 1. HALT.
  const halt = checkHalt(reaRoot);
  if (halt.halted) {
    writeStderr(formatHaltBanner(halt.reason));
    return { exitCode: 2, stderr, stdout };
  }

  // 2. Stdin.
  const stdinRaw =
    options.stdinOverride !== undefined
      ? options.stdinOverride
      : await readStdinWithTimeout(5_000);

  let toolName = '';
  let filePath = '';
  let content = '';
  try {
    const payload = parseWriteHookPayload(stdinRaw);
    toolName = payload.toolName;
    filePath = payload.filePath;
    content = payload.content;
  } catch (err) {
    if (err instanceof MalformedPayloadError || err instanceof TypePayloadError) {
      writeStderr(
        `changeset-security-gate: ${err.message} — refusing on uncertainty.\n`,
      );
      return { exitCode: 2, stderr, stdout };
    }
    throw err;
  }

  // 3. Tool filter.
  if (toolName !== '' && !ACCEPTED_TOOLS.has(toolName)) {
    return { exitCode: 0, stderr, stdout };
  }

  // 4. Path filter.
  if (filePath.length === 0 || !isChangesetFile(filePath)) {
    return { exitCode: 0, stderr, stdout };
  }

  // 5. Disclosure scan (runs for ALL accepted tools incl. MultiEdit).
  const matched = firstDisclosureMatch(content);
  if (matched !== null) {
    const out = emitJsonBlock(buildDisclosureBanner(matched));
    writeStdout(out.json);
    writeStderr(out.stderr);
    return { exitCode: 2, stderr, stdout };
  }

  // 6. MultiEdit short-circuit for frontmatter validation. The bash
  //    hook exits 0 here — the disclosure scan above is the only
  //    enforcement for fragment-style writes.
  if (toolName === 'MultiEdit') {
    return { exitCode: 0, stderr, stdout };
  }

  // 7. Frontmatter validation.
  const firstLine = content.split('\n', 1)[0] ?? '';
  if (!/^---/.test(firstLine)) {
    const out = emitJsonBlock(MISSING_FRONTMATTER_BANNER);
    writeStdout(out.json);
    writeStderr(out.stderr);
    return { exitCode: 2, stderr, stdout };
  }

  const frontmatter = extractFrontmatter(content);
  let hasBump = false;
  for (const line of frontmatter.split('\n')) {
    if (FRONTMATTER_BUMP_PATTERN.test(line)) {
      hasBump = true;
      break;
    }
  }
  if (!hasBump) {
    const out = emitJsonBlock(INVALID_FRONTMATTER_BANNER);
    writeStdout(out.json);
    writeStderr(out.stderr);
    return { exitCode: 2, stderr, stdout };
  }

  const description = extractDescription(content);
  if (description.length === 0) {
    const out = emitJsonBlock(MISSING_DESCRIPTION_BANNER);
    writeStdout(out.json);
    writeStderr(out.stderr);
    return { exitCode: 2, stderr, stdout };
  }

  return { exitCode: 0, stderr, stdout };
}

/**
 * CLI entry — `rea hook changeset-security-gate`.
 */
export async function runHookChangesetSecurityGate(
  options: ChangesetSecurityGateOptions = {},
): Promise<void> {
  const result = await runChangesetSecurityGate({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
    stdoutWrite: (s) => process.stdout.write(s),
  });
  process.exit(result.exitCode);
}

export const __INTERNAL_DISCLOSURE_PATTERNS_FOR_TESTS = DISCLOSURE_PATTERN_SOURCES;
export const __INTERNAL_FRONTMATTER_PATTERN_FOR_TESTS = FRONTMATTER_BUMP_PATTERN;
export const __INTERNAL_BANNERS_FOR_TESTS = {
  MISSING_FRONTMATTER_BANNER,
  INVALID_FRONTMATTER_BANNER,
  MISSING_DESCRIPTION_BANNER,
};
