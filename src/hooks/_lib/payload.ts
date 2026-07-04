/**
 * Shared stdin payload primitive for the Node-binary hook tier.
 *
 * 0.32.0 — extracts the `INPUT=$(cat) ; jq -r '.tool_input.command'`
 * pattern that every bash hook in `hooks/` repeats. The Node-binary
 * scan-bash already does this work in `runHookScanBash` (lines 225-258
 * of `src/cli/hook.ts`); the Phase 1 pilots landing in 0.32.0 need
 * the same primitive without copy-pasting the parsing + type-guard +
 * fail-closed-on-malformed-JSON dance into each new hook.
 *
 * The shape mirrors the bash hooks' contract verbatim:
 *
 *   - `tool_input.command` is the only field we read; bash hooks only
 *     ever ran `jq -r '.tool_input.command // ""'` against this payload.
 *   - `tool_name` is also surfaced because two bash hooks
 *     (`pr-issue-link-gate.sh` and `security-disclosure-gate.sh`)
 *     short-circuit when the tool isn't `Bash`.
 *
 * Failure modes:
 *
 *   - Empty stdin → `{ command: '', toolName: '' }`. The bash hooks
 *     allow on empty command (`[[ -z "$CMD" ]] && exit 0`); the Node
 *     port preserves this by returning empty strings rather than
 *     throwing.
 *   - Malformed JSON → throws `MalformedPayloadError`. The caller
 *     decides whether to fail-closed (block) or fail-open (allow);
 *     `runHookScanBash` chose fail-closed (block) and the Phase 1
 *     pilots match that posture for consistency.
 *   - `tool_input.command` is non-string → throws `TypePayloadError`.
 *     A crafted payload like `{"tool_input":{"command":["rm","-rf"]}}`
 *     would silently coerce to `''` if we used `String(c)`; that
 *     would translate into a free allow. Refuse instead.
 */

import { Buffer } from 'node:buffer';

/**
 * Result of parsing a Claude Code hook PreToolUse stdin payload.
 */
export interface HookPayload {
  /** `tool_name` from the payload, or `''` when absent. */
  toolName: string;
  /** `tool_input.command` from the payload, or `''` when absent. */
  command: string;
}

/**
 * Thrown when stdin contains content that is not valid JSON.
 *
 * Distinct error class so callers can `instanceof` discriminate without
 * leaning on string matching of the message.
 */
export class MalformedPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MalformedPayloadError';
  }
}

/**
 * Thrown when the JSON parses but `tool_input.command` is present and
 * has the wrong type (anything other than `string` / `undefined`).
 */
export class TypePayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TypePayloadError';
  }
}

interface RawPayload {
  tool_name?: unknown;
  tool_input?: {
    command?: unknown;
  } | null;
}

/**
 * Parse a Claude Code PreToolUse stdin payload. Pure function — no I/O.
 *
 * @param raw Bytes / string read from the hook's stdin (the `INPUT=$(cat)`
 *            equivalent).
 * @returns A normalized `HookPayload` with both fields always defined.
 * @throws MalformedPayloadError if the input is not parseable JSON.
 * @throws TypePayloadError if `tool_input.command` is present with a
 *         non-string type.
 */
export function parseHookPayload(raw: string | Buffer): HookPayload {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.trim().length === 0) {
    return { toolName: '', command: '' };
  }
  let parsed: RawPayload;
  try {
    parsed = JSON.parse(text) as RawPayload;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new MalformedPayloadError(
      `hook payload is not valid JSON: ${detail}`,
    );
  }
  if (parsed === null) {
    // Top-level `null` mirrors `jq -r '.tool_name // ""'` returning ``
    // — the bash hooks treated this as "no tool, allow on empty cmd".
    return { toolName: '', command: '' };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    // Top-level primitives (number, string, boolean) and arrays are
    // unambiguously malformed — Claude Code never emits these shapes.
    // Fail-closed so a crafted payload can't sneak past as a no-op.
    throw new MalformedPayloadError(
      `hook payload top-level is ${Array.isArray(parsed) ? 'array' : typeof parsed}, expected object`,
    );
  }
  const toolName = typeof parsed.tool_name === 'string' ? parsed.tool_name : '';
  const ti = parsed.tool_input;
  let command = '';
  if (ti !== undefined && ti !== null) {
    if (typeof ti !== 'object') {
      throw new TypePayloadError(
        `hook payload tool_input is ${typeof ti}, expected object`,
      );
    }
    const c = ti.command;
    if (c !== undefined && typeof c !== 'string') {
      throw new TypePayloadError(
        `hook payload tool_input.command is non-string (got ${typeof c}); expected string`,
      );
    }
    if (typeof c === 'string') command = c;
  }
  return { toolName, command };
}

/**
 * Result of a write-tier hook payload extraction. Covers all four
 * write-class tools (Write, Edit, MultiEdit, NotebookEdit).
 */
export interface WriteHookPayload {
  /** `tool_name` from the payload, or `''` when absent. */
  toolName: string;
  /**
   * `tool_input.file_path` (Write/Edit/MultiEdit) OR
   * `tool_input.notebook_path` (NotebookEdit), or `''` when absent.
   */
  filePath: string;
  /**
   * Concatenated content payload. Resolution order matches
   * `hooks/_lib/payload-read.sh::extract_write_content`:
   *
   *   1. `tool_input.content`                     (Write)
   *   2. `tool_input.new_string`                  (Edit)
   *   3. `tool_input.edits[].new_string` joined   (MultiEdit, `\n`)
   *   4. `tool_input.new_source`                  (NotebookEdit cell)
   *
   * Returns `''` when none of these are present. Defensive coercion:
   * a non-string `new_string`, non-array `edits`, or non-string
   * fragments fail closed (treated as missing) rather than throwing —
   * mirrors the bash hook's `.tool_input.new_string // ""` + the
   * type-guard branches added in 0.16.0.
   */
  content: string;
}

interface RawWritePayload {
  tool_name?: unknown;
  tool_input?: {
    file_path?: unknown;
    notebook_path?: unknown;
    content?: unknown;
    new_string?: unknown;
    new_source?: unknown;
    edits?: unknown;
  } | null;
}

/**
 * Parse a Claude Code Write/Edit/MultiEdit/NotebookEdit stdin payload.
 *
 * Same fail-closed posture as `parseHookPayload`: malformed JSON →
 * throws `MalformedPayloadError`; type-mismatched fields → throws
 * `TypePayloadError`. Callers fail-closed on these for blocking-tier
 * gates (changeset-security-gate refuses on uncertainty).
 */
export function parseWriteHookPayload(raw: string | Buffer): WriteHookPayload {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.trim().length === 0) {
    return { toolName: '', filePath: '', content: '' };
  }
  let parsed: RawWritePayload;
  try {
    parsed = JSON.parse(text) as RawWritePayload;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new MalformedPayloadError(
      `hook payload is not valid JSON: ${detail}`,
    );
  }
  if (parsed === null) {
    return { toolName: '', filePath: '', content: '' };
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MalformedPayloadError(
      `hook payload top-level is ${Array.isArray(parsed) ? 'array' : typeof parsed}, expected object`,
    );
  }
  const toolName = typeof parsed.tool_name === 'string' ? parsed.tool_name : '';
  const ti = parsed.tool_input;
  let filePath = '';
  let content = '';
  if (ti !== undefined && ti !== null) {
    if (typeof ti !== 'object') {
      throw new TypePayloadError(
        `hook payload tool_input is ${typeof ti}, expected object`,
      );
    }
    // file_path or notebook_path. Both are optional; either string or absent.
    if (ti.file_path !== undefined) {
      if (typeof ti.file_path !== 'string') {
        throw new TypePayloadError(
          `hook payload tool_input.file_path is ${typeof ti.file_path}, expected string`,
        );
      }
      filePath = ti.file_path;
    } else if (ti.notebook_path !== undefined) {
      if (typeof ti.notebook_path !== 'string') {
        throw new TypePayloadError(
          `hook payload tool_input.notebook_path is ${typeof ti.notebook_path}, expected string`,
        );
      }
      filePath = ti.notebook_path;
    }
    // Content extraction — same priority order as the bash hook.
    if (typeof ti.content === 'string' && ti.content.length > 0) {
      content = ti.content;
    } else if (typeof ti.new_string === 'string' && ti.new_string.length > 0) {
      content = ti.new_string;
    } else if (Array.isArray(ti.edits) && ti.edits.length > 0) {
      // Defensive: non-string `new_string` fragments collapse to ''
      // (matches the bash helper's `// ""` + `tostring`). The
      // concatenation order is bash hook's `join("\n")`.
      const parts: string[] = [];
      for (const edit of ti.edits as unknown[]) {
        if (edit === null || typeof edit !== 'object') continue;
        const e = edit as { new_string?: unknown };
        if (typeof e.new_string === 'string') {
          parts.push(e.new_string);
        } else {
          parts.push('');
        }
      }
      content = parts.join('\n');
    } else if (typeof ti.new_source === 'string' && ti.new_source.length > 0) {
      content = ti.new_source;
    }
  }
  return { toolName, filePath, content };
}

/**
 * Result of parsing a Claude Code PostToolUse stdin payload for a Bash
 * tool call. Unlike the PreToolUse parsers above, this one captures the
 * tool's OUTPUT (`tool_response`) — the billing→HALT gate (0.51.0) needs
 * it because a billing-class signature appears in a metered call's ERROR
 * output, not in the command text.
 *
 * The output is split by CHANNEL on purpose (codex 0.51.0 round-1 P1/P2):
 * a billing error is *error* output from a *failed* call. Scanning the
 * command text or a successful command's stdout would freeze the session
 * on entirely benign work — e.g. `cat THREAT_MODEL.md` or
 * `rg "spending cap" .`, both of which legitimately print the watched
 * phrases to stdout. So the caller scans `stderr` (the error channel,
 * always) plus `stdout` ONLY when `errored` is set, and NEVER the
 * command.
 */
export interface PostToolUsePayload {
  /** `tool_name` from the payload, or `''` when absent. */
  toolName: string;
  /**
   * `tool_input.command`, or `''` when absent. Retained for context /
   * banners; the billing gate deliberately does NOT scan it.
   */
  command: string;
  /**
   * The error channel — `tool_response.stderr`. Billing errors from a
   * metered endpoint surface here. Scanned unconditionally by the gate.
   * `''` when absent.
   */
  stderr: string;
  /**
   * The benign channel — `tool_response.stdout` (plus the `output` /
   * `content` fallback keys some harnesses use, and a bare-string
   * `tool_response`). A successful command's normal output. Parsed but
   * NOT scanned by the billing gate (round-4 P1: a command that fails for
   * an unrelated reason while printing benign matches to stdout — e.g.
   * `grep -R "spending cap" docs missing_dir` — must not freeze). Retained
   * for PR2, where a registered metered host justifies scanning it. `''`
   * when absent.
   */
  stdout: string;
  /**
   * True when `tool_response` carries an explicit FAILURE signal — an
   * `is_error`/`isError`/`error` flag, a non-zero numeric exit field
   * (`exit_code`/`exitCode`/`code`/`returncode`/`status`), or
   * `interrupted: true`. Parsed for PR2; the billing gate is stderr-only
   * and does not consult it. Absent/unknown shapes → `false`.
   */
  errored: boolean;
}

interface RawPostToolUsePayload {
  tool_name?: unknown;
  tool_input?: {
    command?: unknown;
  } | null;
  tool_response?: unknown;
}

/**
 * Benign (stdout-equivalent) object keys, in a fixed order. `stdout` is
 * the Bash shape; `output` / `content` are fallbacks some harnesses use.
 * `stderr` is handled separately (it is the error channel).
 */
const POST_TOOL_STDOUT_KEYS = ['stdout', 'output', 'content'] as const;

/** Numeric exit-status keys checked for a non-zero (failure) value. */
const POST_TOOL_EXIT_KEYS = ['exit_code', 'exitCode', 'code', 'returncode', 'status'] as const;

/**
 * Derive a FAILURE signal from a `tool_response` object. Conservative:
 * only explicit, unambiguous failure markers count. Absent → false.
 */
function toolResponseErrored(rec: Record<string, unknown>): boolean {
  if (rec['is_error'] === true || rec['isError'] === true) return true;
  const err = rec['error'];
  if (err === true || (typeof err === 'string' && err.length > 0)) return true;
  if (rec['interrupted'] === true) return true;
  for (const key of POST_TOOL_EXIT_KEYS) {
    const v = rec[key];
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) return true;
  }
  return false;
}

/**
 * Parse a Claude Code PostToolUse stdin payload for a Bash tool call,
 * capturing `tool_input.command` plus the `tool_response` split into the
 * `stderr` (error) and `stdout` (benign) channels and an `errored` flag.
 *
 * Fail-closed posture mirrors `parseHookPayload`:
 *   - malformed JSON → throws `MalformedPayloadError`
 *   - `tool_input.command` present with a non-string type → throws
 *     `TypePayloadError`.
 *
 * The channel extraction is deliberately LENIENT (never throws on a weird
 * `tool_response` shape): vendor output is untrusted and highly variable,
 * and the billing gate must not fail its whole evaluation because an
 * output field had an unexpected type. A shape we don't recognize yields
 * empty channels + `errored: false`.
 */
export function parsePostToolUsePayload(raw: string | Buffer): PostToolUsePayload {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  const empty: PostToolUsePayload = {
    toolName: '',
    command: '',
    stderr: '',
    stdout: '',
    errored: false,
  };
  if (text.trim().length === 0) {
    return empty;
  }
  let parsed: RawPostToolUsePayload;
  try {
    parsed = JSON.parse(text) as RawPostToolUsePayload;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new MalformedPayloadError(`hook payload is not valid JSON: ${detail}`);
  }
  if (parsed === null) {
    return empty;
  }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MalformedPayloadError(
      `hook payload top-level is ${Array.isArray(parsed) ? 'array' : typeof parsed}, expected object`,
    );
  }
  const toolName = typeof parsed.tool_name === 'string' ? parsed.tool_name : '';

  // Command — same type-strict extraction as parseHookPayload.
  const ti = parsed.tool_input;
  let command = '';
  if (ti !== undefined && ti !== null) {
    if (typeof ti !== 'object') {
      throw new TypePayloadError(
        `hook payload tool_input is ${typeof ti}, expected object`,
      );
    }
    const c = ti.command;
    if (c !== undefined && typeof c !== 'string') {
      throw new TypePayloadError(
        `hook payload tool_input.command is non-string (got ${typeof c}); expected string`,
      );
    }
    if (typeof c === 'string') command = c;
  }

  // Channels — lenient. A bare-string tool_response is treated as the
  // BENIGN (stdout) channel: it carries no error signal, so it must not
  // be scanned as if it were an error.
  let stderr = '';
  let stdout = '';
  let errored = false;
  const tr = parsed.tool_response;
  if (typeof tr === 'string') {
    stdout = tr;
  } else if (tr !== null && typeof tr === 'object' && !Array.isArray(tr)) {
    const rec = tr as Record<string, unknown>;
    if (typeof rec['stderr'] === 'string') stderr = rec['stderr'] as string;
    const parts: string[] = [];
    for (const key of POST_TOOL_STDOUT_KEYS) {
      const v = rec[key];
      if (typeof v === 'string' && v.length > 0) parts.push(v);
    }
    stdout = parts.join('\n');
    errored = toolResponseErrored(rec);
  }

  return { toolName, command, stderr, stdout, errored };
}

/**
 * Read all of stdin into a string with a soft byte cap and a hard
 * timeout. Mirrors the `readStdinWithTimeout` helper in
 * `src/cli/hook.ts` (which scans a fixed timeout but no byte cap).
 *
 * The cap (default 1 MiB) defends against a misbehaving caller piping
 * an unbounded payload — we'd otherwise sit in the read loop forever
 * even if the caller eventually closed stdin.
 *
 * @param timeoutMs How long to wait for stdin to close before resolving
 *                  with whatever we have. Default 5_000 ms.
 * @param maxBytes Soft cap on total bytes accepted. Default 1 MiB.
 *                 Once reached, additional chunks are dropped silently
 *                 (the caller still gets a parseable string back).
 */
export function readStdinWithTimeout(
  timeoutMs = 5_000,
  maxBytes = 1024 * 1024,
): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let buf = '';
    let bytesRead = 0;
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      try {
        process.stdin.removeAllListeners('data');
        process.stdin.removeAllListeners('end');
        process.stdin.removeAllListeners('error');
      } catch {
        /* best effort */
      }
      resolve(buf);
    };
    const timer = setTimeout(finish, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      const chunkBytes = Buffer.byteLength(chunk, 'utf8');
      if (bytesRead + chunkBytes > maxBytes) {
        // Truncate to the cap; further chunks are dropped silently.
        const remaining = Math.max(0, maxBytes - bytesRead);
        if (remaining > 0) {
          buf += chunk.slice(0, remaining);
          bytesRead = maxBytes;
        }
        finish();
        return;
      }
      buf += chunk;
      bytesRead += chunkBytes;
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}
