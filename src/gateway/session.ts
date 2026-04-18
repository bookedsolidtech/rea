/**
 * Per-process session identifier. One `rea serve` invocation = one session_id.
 * Matches how Claude Code's long-running sessions work today. Revisit when we
 * add a streamable-HTTP transport that might serve multiple reconnecting
 * clients.
 */

import crypto from 'node:crypto';

let sessionId: string | null = null;

export function currentSessionId(): string {
  if (sessionId === null) sessionId = crypto.randomUUID();
  return sessionId;
}

/** Exposed for tests only — resets the module-level id. */
export function __resetSessionForTests(): void {
  sessionId = null;
}
