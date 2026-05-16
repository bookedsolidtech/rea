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
