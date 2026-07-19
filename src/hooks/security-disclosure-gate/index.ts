/**
 * Node-binary port of `hooks/security-disclosure-gate.sh`.
 *
 * 0.32.0 Phase 1 Pilot #2 — env-var-policy + body-file-resolver +
 * mode-aware redirect router for `gh issue create` commands that
 * mention vulnerability-class keywords.
 *
 * Why pilot #2 (and not #3): pilot #2 is the LARGEST of the three
 * (339 LOC bash) and exercises every primitive landed in Phase 0:
 *   - `checkHalt` (Phase 0)
 *   - `parseHookPayload` (Phase 0)
 *   - `splitSegments` / `anySegmentStartsWith` (Phase 0, used by
 *     pilot #3 first but in scope here for `gh issue create`)
 *   - File-IO resolver for `--body-file` / `-F` paths with `..`
 *     traversal refusal, ABSOLUTE-vs-relative resolution, 64 KiB cap.
 *   - Read of `REA_DISCLOSURE_MODE` env var with three-state semantics
 *     (`advisory` / `issues` / `disabled`).
 *
 * Behavioral contract — preserves bash hook byte-for-byte:
 *
 *   1. HALT check → exit 2 with shared banner.
 *   2. Read `REA_DISCLOSURE_MODE` env var. `disabled` → exit 0
 *      immediately (no scan at all).
 *   3. Read stdin. If `tool_name` isn't `Bash`, exit 0.
 *   4. Identify `gh issue create` segments via `anySegmentStartsWith`.
 *      Substring fallback when the segment splitter is unreachable is
 *      moot in Node — `splitSegments` is always in scope. (The bash
 *      hook had a fallback only because `cmd-segments.sh` might be
 *      absent in foreign installs.)
 *   5. Resolve `--body-file PATH` and `-F PATH` arguments. The
 *      resolver MUST match the bash quote-aware awk tokenizer for the
 *      shape `--body-file "path with spaces.md"` — we run our own
 *      quote-aware walker that yields each `--body-file` / `-F`
 *      value. Stdin form (`-`) is skipped. Paths whose CANONICAL form
 *      (after resolving `..` segments) escape REA_ROOT are REFUSED
 *      with exit 2 + advisory banner (matches the 0.17.0 helix-019 #1
 *      fix). Readable files contribute the first 64 KiB to the scan
 *      buffer; unreadable files print a warning and continue.
 *   6. Build `FULL_TEXT` = body-file contents + command text (both
 *      lowercased) and scan for SECURITY_PATTERNS (an ordered list of
 *      ERE patterns mirroring the bash array). First match wins;
 *      `MATCHED_PATTERN` becomes the body-banner placeholder.
 *   7. Route on mode:
 *        - `issues`   → block banner pointing to `gh issue create
 *                       --label 'security,internal' …` private form
 *        - `advisory` → block banner pointing to `gh api
 *                       repos/.../security-advisories` private form
 *      Both return exit 2.
 *
 * Out-of-scope vs. the bash hook (intentional simplifications):
 *
 *   - The bash hook emits `json_output "block" "..."` via
 *     `_lib/common.sh`. The JSON format is a Claude Code-specific
 *     wrapper that lets the hook present a structured block reason
 *     to the agent. In the Node tier, the canonical surface is `{
 *     hookSpecificOutput: { hookEventName: 'PreToolUse', ... } }`
 *     emitted on STDOUT with exit code 0; the legacy bash hook emits
 *     it on stdout. We preserve that exact shape via `emitJsonBlock`.
 *   - The bash hook's `require_jq` check is moot — Node parses JSON
 *     natively.
 */

import { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { checkHaltRoots, formatHaltBanner } from '../_lib/halt-check.js';
import { resolveHookRoots } from '../../lib/worktree-roots.js';
import {
  parseHookPayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';
import { anySegmentStartsWith } from '../_lib/segments.js';

export type DisclosureMode = 'advisory' | 'issues' | 'disabled';

export interface SecurityDisclosureGateOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
  stdoutWrite?: (s: string) => void;
  /** Override `REA_DISCLOSURE_MODE`. Production reads `process.env`. */
  disclosureModeOverride?: string;
  /**
   * Override `cwd()` for relative `--body-file` path resolution. The
   * bash hook uses `pwd` (the shell's cwd at hook-execution time).
   * Tests inject this so they don't have to `process.chdir`.
   */
  cwdOverride?: string;
}

export interface SecurityDisclosureGateResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

/**
 * Ordered list of ERE patterns that indicate a security finding when
 * present in a public issue. Order mirrors the bash array
 * `SECURITY_PATTERNS=(...)` so the `MATCHED_PATTERN` placeholder
 * picks the same first-match string the bash hook would have.
 */
const SECURITY_PATTERNS: ReadonlyArray<string> = [
  // Vulnerability classes
  'bypass',
  'exploit',
  'injection',
  'traversal',
  'exfiltrat',
  'escalat',
  'privilege',
  'rce',
  'remote.code.exec',
  'arbitrary.code',
  'code.execution',
  'zero.day',
  '0day',
  'CVE-',
  'CVSS',
  'GHSA-',
  // Reagent-specific sensitive terms
  'hook.bypass',
  'HALT.bypass',
  'redaction.bypass',
  'policy.bypass',
  'middleware.bypass',
  'skip.*gate',
  'evad',
  // Credential/secret exposure
  'secret.*leak',
  'credential.*leak',
  'token.*leak',
  'key.*expos',
  'expos.*secret',
  // Prompt injection
  'prompt.inject',
  'jailbreak',
  'jail.break',
];

const BODY_FILE_BYTE_CAP = 64 * 1024;

interface BodyFilePathToken {
  raw: string;
  /** True when the token is `-` (stdin form), which we skip. */
  isStdinForm: boolean;
}

/**
 * Quote-aware tokenizer that yields each `--body-file <PATH>` and
 * `-F <PATH>` argument from the raw command string. Mirrors the awk
 * walker in security-disclosure-gate.sh#_extract_body_file_paths,
 * including the 0.18.0 helix-020 G3.B `\<space>` plain-mode escape
 * fix.
 */
function extractBodyFilePaths(cmd: string): BodyFilePathToken[] {
  // First, tokenize the command string with quote/escape awareness
  // and yield tokens. Then walk tokens looking for `--body-file` /
  // `-F` (consume next), or `--body-file=PATH` / `-F=PATH` (use the
  // inline value).
  const tokens: string[] = [];
  let i = 0;
  const n = cmd.length;
  let tok = '';
  let mode: 'plain' | 'dquote' | 'squote' = 'plain';

  const flush = (): void => {
    if (tok.length > 0) {
      tokens.push(tok);
      tok = '';
    }
  };

  while (i < n) {
    const ch = cmd[i] as string;
    if (mode === 'plain') {
      if (ch === '\\' && i + 1 < n) {
        // Plain-mode `\X` → literal X. helix-020 G3.B fix.
        tok += cmd[i + 1];
        i += 2;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\n') {
        flush();
        i += 1;
        continue;
      }
      if (ch === '"') {
        mode = 'dquote';
        tok += ch;
        i += 1;
        continue;
      }
      if (ch === "'") {
        mode = 'squote';
        tok += ch;
        i += 1;
        continue;
      }
      tok += ch;
      i += 1;
      continue;
    }
    if (mode === 'dquote') {
      if (ch === '\\' && i + 1 < n) {
        // Preserve `\"` / `\\` literally inside the token; bash's
        // `awk` walker emits the escape sequence verbatim, and
        // strip_outer_quotes handles the outer pair.
        tok += ch + (cmd[i + 1] as string);
        i += 2;
        continue;
      }
      if (ch === '"') {
        mode = 'plain';
        tok += ch;
        i += 1;
        continue;
      }
      tok += ch;
      i += 1;
      continue;
    }
    // mode === 'squote'
    if (ch === "'") {
      mode = 'plain';
      tok += ch;
      i += 1;
      continue;
    }
    tok += ch;
    i += 1;
  }
  flush();

  /**
   * Strip a single outer pair of matching `"..."` or `'...'`.
   * Mirrors awk strip_outer_quotes.
   */
  const stripOuterQuotes = (s: string): string => {
    if (s.length < 2) return s;
    const first = s[0];
    const last = s[s.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1);
    }
    return s;
  };

  const out: BodyFilePathToken[] = [];
  let skipNext = false;
  for (const t of tokens) {
    if (skipNext) {
      skipNext = false;
      if (t === '-' || t === '') continue;
      const stripped = stripOuterQuotes(t);
      out.push({ raw: stripped, isStdinForm: false });
      continue;
    }
    if (t === '--body-file' || t === '-F') {
      skipNext = true;
      continue;
    }
    if (t.startsWith('--body-file=')) {
      const v = stripOuterQuotes(t.slice('--body-file='.length));
      if (v !== '' && v !== '-') out.push({ raw: v, isStdinForm: false });
      continue;
    }
    if (t.startsWith('-F=')) {
      const v = stripOuterQuotes(t.slice('-F='.length));
      if (v !== '' && v !== '-') out.push({ raw: v, isStdinForm: false });
      continue;
    }
  }
  return out;
}

/**
 * Canonicalize a path by walking `..` segments. Mirrors the bash
 * resolver — pure-string, NO `fs.realpath` (we explicitly do NOT want
 * to follow symlinks here; the protected-paths gates do that
 * separately).
 */
function canonicalizePath(abs: string): string {
  const parts = abs.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '' || p === '.') continue;
    if (p === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(p);
  }
  return '/' + out.join('/');
}

/**
 * Resolve a `--body-file` path argument. Returns:
 *   - `{ kind: 'ok', resolved }` — readable path inside REA_ROOT (or
 *     absolute path WITHOUT `..` segments, matching the bash hook's
 *     posture of accepting `/tmp/...`, `/var/folders/...` etc.).
 *   - `{ kind: 'traversal', resolved }` — canonical form escapes
 *     REA_ROOT via `..` segments. Caller MUST exit 2.
 *   - `{ kind: 'unreadable' }` — file exists or might exist but is
 *     not readable; caller emits a warning and skips it.
 */
type ResolveResult =
  | { kind: 'ok'; resolved: string }
  | { kind: 'traversal'; resolved: string; raw: string }
  | { kind: 'unreadable'; raw: string };

function resolveBodyFile(
  bodyPath: string,
  reaRoot: string,
  cwd: string,
): ResolveResult {
  const isAbsolute = bodyPath.startsWith('/');
  const abs = isAbsolute ? bodyPath : path.join(cwd, bodyPath);
  // Detect traversal in the RAW path (matches the bash check `case
  // "/$raw_path/" in */../*) had_traversal=1 ;; esac`).
  const hadTraversal = `/${bodyPath}/`.includes('/../');
  let resolved = abs;
  if (hadTraversal) {
    resolved = canonicalizePath(abs);
    // Hard refusal if resolved escapes REA_ROOT.
    const reaRootCanonical = canonicalizePath(reaRoot);
    if (
      resolved !== reaRootCanonical &&
      !resolved.startsWith(reaRootCanonical + '/')
    ) {
      return { kind: 'traversal', resolved, raw: bodyPath };
    }
  }
  // Check readability.
  try {
    fs.accessSync(resolved, fs.constants.R_OK);
  } catch {
    return { kind: 'unreadable', raw: bodyPath };
  }
  // Final check — make sure it's a regular file (not a directory).
  try {
    const st = fs.statSync(resolved);
    if (!st.isFile()) return { kind: 'unreadable', raw: bodyPath };
  } catch {
    return { kind: 'unreadable', raw: bodyPath };
  }
  return { kind: 'ok', resolved };
}

function readBodyFileChunk(p: string): string {
  // Read up to BODY_FILE_BYTE_CAP bytes. Lowercase to match the
  // bash hook's `tr '[:upper:]' '[:lower:]'`.
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(BODY_FILE_BYTE_CAP);
      const bytesRead = fs.readSync(fd, buf, 0, BODY_FILE_BYTE_CAP, 0);
      return buf.slice(0, bytesRead).toString('utf8').toLowerCase();
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function normalizeDisclosureMode(raw: string | undefined): DisclosureMode {
  if (raw === 'issues') return 'issues';
  if (raw === 'disabled') return 'disabled';
  // Default and unrecognized → 'advisory'. Mirrors the bash hook's
  // default and silent-default-on-bogus posture.
  return 'advisory';
}

function emitTraversalRefusal(rawPath: string, resolved: string): string {
  return [
    'SECURITY DISCLOSURE GATE: --body-file path traversal escapes project root\n',
    '\n',
    `  Path:     ${rawPath}\n`,
    `  Resolved: ${resolved}\n`,
    '\n',
    '  Rule: --body-file paths whose canonical form uses `..` segments to\n',
    '        escape REA_ROOT are refused. Move the file inside the project\n',
    '        tree, or paste the body inline via --body.\n',
  ].join('');
}

function emitBlockJsonAndStderr(reason: string): { json: string; stderr: string } {
  // Claude Code PreToolUse hook block format. Mirrors `json_output
  // "block" "..."` in _lib/common.sh — which printed `message` to
  // stderr before exiting 2. 0.32.0 codex round 2 P2: restore the
  // stderr banner so hook runners that only surface stderr (the
  // pre-0.32.0 bash hook contract, plus any non-Claude-Code wrapper
  // that ignores the JSON-on-stdout protocol) still get the
  // remediation text. Newline terminator matches `printf '%s\n'`.
  const obj = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
  return { json: JSON.stringify(obj) + '\n', stderr: reason + '\n' };
}

function buildIssuesModeReason(matched: string): string {
  return `SECURITY DISCLOSURE GATE: This issue appears to describe a security finding (matched: '${matched}').

This project is configured for PRIVATE disclosure (REA_DISCLOSURE_MODE=issues).

CORRECT PATH for security findings in this private repo:
  Use: gh issue create --label 'security,internal' --title '...' --body '...'

The 'security' and 'internal' labels keep this off public project boards and
mark it for maintainer-only triage. Do NOT use the public issue queue without
these labels for security findings.

If this is NOT a security finding, rephrase the title/body to avoid triggering
security patterns, then retry.`;
}

function buildAdvisoryModeReason(matched: string, mode: DisclosureMode): string {
  return `SECURITY DISCLOSURE GATE: This issue appears to describe a security vulnerability (matched: '${matched}'). Do NOT create a public GitHub issue for security vulnerabilities.

CORRECT DISCLOSURE PATH:
1. Use GitHub Security Advisories (private):
   gh api repos/{owner}/{repo}/security-advisories --method POST --input - <<'JSON'
   { "summary": "...", "description": "...", "severity": "medium|high|critical",
     "vulnerabilities": [{"package": {"name": "@pkg", "ecosystem": "npm"}}] }
   JSON
2. Or navigate to: Security tab → Advisories → 'Report a vulnerability'
3. Or email security@bookedsolid.tech (see SECURITY.md)

The finding will be publicly disclosed AFTER a patch is released (coordinated disclosure).

WHY: Public issues expose vulnerabilities before users can patch. This is enforced by the
security-disclosure-gate hook (REA_DISCLOSURE_MODE=${mode}).

If this is NOT a security vulnerability, rephrase the issue to avoid triggering
security patterns, then retry.`;
}

/**
 * Pure executor.
 */
export async function runSecurityDisclosureGate(
  options: SecurityDisclosureGateOptions = {},
): Promise<SecurityDisclosureGateResult> {
  const cwd = options.cwdOverride ?? process.cwd();
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

  // 2. Disclosure mode. (Round-21 P2: the disabled-mode early return
  // moved BELOW the HALT probe — a frozen repository denies this hook
  // regardless of REA_DISCLOSURE_MODE, matching the pre-0.54.0 order.)
  const rawMode =
    options.disclosureModeOverride ?? process.env['REA_DISCLOSURE_MODE'];
  const mode = normalizeDisclosureMode(rawMode);

  // 3. Stdin.
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
        `security-disclosure-gate: ${err.message} — refusing on uncertainty.\n`,
      );
      return { exitCode: 2, stderr, stdout };
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
    return { exitCode: 2, stderr, stdout };
  }

  if (mode === 'disabled') {
    return { exitCode: 0, stderr, stdout };
  }

  if (toolName !== '' && toolName !== 'Bash') {
    return { exitCode: 0, stderr, stdout };
  }
  if (cmd.length === 0) {
    return { exitCode: 0, stderr, stdout };
  }

  // 4. Only intercept `gh issue create` (head-anchored).
  if (!anySegmentStartsWith(cmd, 'gh\\s+issue\\s+create')) {
    return { exitCode: 0, stderr, stdout };
  }

  // 5. Body-file resolution.
  const bodyTokens = extractBodyFilePaths(cmd);
  let bodyFileText = '';
  for (const tok of bodyTokens) {
    if (tok.isStdinForm) continue;
    const r = resolveBodyFile(tok.raw, reaRoot, cwd);
    if (r.kind === 'traversal') {
      writeStderr(emitTraversalRefusal(r.raw, r.resolved));
      return { exitCode: 2, stderr, stdout };
    }
    if (r.kind === 'unreadable') {
      writeStderr(
        `security-disclosure-gate: --body-file ${r.raw} unreadable; skipping body scan\n`,
      );
      continue;
    }
    const chunk = readBodyFileChunk(r.resolved);
    if (chunk.length > 0) bodyFileText += '\n' + chunk;
  }

  // 6. Pattern scan.
  const fullText = bodyFileText + '\n' + cmd.toLowerCase();
  let matched = '';
  for (const p of SECURITY_PATTERNS) {
    const re = new RegExp(p, 'i');
    if (re.test(fullText)) {
      matched = p;
      break;
    }
  }
  if (matched === '') {
    return { exitCode: 0, stderr, stdout };
  }

  // 7. Mode-aware routing.
  const reason =
    mode === 'issues'
      ? buildIssuesModeReason(matched)
      : buildAdvisoryModeReason(matched, mode);
  const blockOutput = emitBlockJsonAndStderr(reason);
  writeStdout(blockOutput.json);
  // 0.32.0 codex round 2 P2: also emit the remediation banner to
  // stderr so hook runners that only surface stderr (legacy bash
  // hook contract, non-Claude-Code wrappers) still see the
  // operator-facing reason text. Claude Code itself prefers the
  // JSON on stdout but tolerates duplicate stderr.
  if (blockOutput.stderr.length > 0) writeStderr(blockOutput.stderr);
  return { exitCode: 2, stderr, stdout };
}

/**
 * CLI entry — `rea hook security-disclosure-gate`.
 */
export async function runHookSecurityDisclosureGate(
  options: SecurityDisclosureGateOptions = {},
): Promise<void> {
  const result = await runSecurityDisclosureGate({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
    stdoutWrite: (s) => process.stdout.write(s),
  });
  process.exit(result.exitCode);
}

// Internal exports for tests.
export const __INTERNAL_SECURITY_PATTERNS_FOR_TESTS = SECURITY_PATTERNS;
