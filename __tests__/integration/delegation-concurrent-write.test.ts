/**
 * Concurrent-writer integration test for `rea.delegation_signal`
 * (0.29.0).
 *
 * Sign-off condition #3 from data-architect: 10 hook-style writers +
 * 1 gateway-middleware-style write running in parallel against the
 * same `.rea/audit.jsonl` must produce a linear chain (every record's
 * `prev_hash` matches the previous record's `hash`).
 *
 * Both writers go through `appendAuditRecord` — the public helper
 * that owns the per-process queue + `proper-lockfile` cross-process
 * lock. The test is a guard against future regressions that try to
 * shortcut the helper (e.g. open-coded `fs.appendFile` from a new
 * code path) and break linearity.
 *
 * We also run `rea audit verify` over the resulting chain to assert
 * the integrity tooling agrees with our in-process check.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuditRecord } from '../../src/gateway/middleware/audit-types.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../../src/audit/append.js';
import {
  DELEGATION_SIGNAL_TOOL_NAME,
  DELEGATION_SIGNAL_SERVER_NAME,
  DELEGATION_SIGNAL_SCHEMA_VERSION,
  type DelegationSignalMetadata,
} from '../../src/audit/delegation-event.js';

const EMPTY_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

async function readAuditLines(baseDir: string): Promise<AuditRecord[]> {
  const file = path.join(baseDir, '.rea', 'audit.jsonl');
  const raw = await fs.readFile(file, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditRecord);
}

describe('delegation-signal — concurrent writer chain integrity', () => {
  let baseDir: string;
  beforeEach(async () => {
    baseDir = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), 'rea-deleg-concur-')),
    );
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('10 hook-style writers + 1 middleware write produce a linear chain', async () => {
    // Build 10 hook-style delegation-signal appends in parallel.
    const hookWrites = Array.from({ length: 10 }, (_, i) => {
      const m: DelegationSignalMetadata = {
        schema_version: DELEGATION_SIGNAL_SCHEMA_VERSION,
        delegation_tool: i % 2 === 0 ? 'Agent' : 'Skill',
        subagent_type: `agent-${i}`,
        session_id_observed: `session-${i}`,
        parent_subagent_type: null,
        invocation_description_sha256: crypto
          .createHash('sha256')
          .update(`prompt-${i}`)
          .digest('hex'),
      };
      return appendAuditRecord(baseDir, {
        tool_name: DELEGATION_SIGNAL_TOOL_NAME,
        server_name: DELEGATION_SIGNAL_SERVER_NAME,
        tier: Tier.Read,
        status: InvocationStatus.Allowed,
        session_id: `session-${i}`,
        metadata: m as unknown as Record<string, unknown>,
      });
    });

    // Plus one gateway-middleware-style write interleaved with the
    // hook writes. The gateway uses a different tool_name (a typical
    // middleware-tier event); the chain must remain linear regardless.
    const middlewareWrite = appendAuditRecord(baseDir, {
      tool_name: 'gateway.middleware.test',
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: { source: 'gateway-middleware-test' },
    });

    await Promise.all([...hookWrites, middlewareWrite]);

    const lines = await readAuditLines(baseDir);
    expect(lines).toHaveLength(11);

    // Linear chain check — every line's prev_hash must equal the
    // previous line's hash, in file order.
    for (let i = 1; i < lines.length; i++) {
      const prev = lines[i - 1]!;
      const cur = lines[i]!;
      expect(cur.prev_hash).toBe(prev.hash);
    }

    // The delegation records are observable in the chain. We don't
    // assert the exact interleaving order (it depends on lock
    // acquisition timing) — only that every record made it.
    const delegationCount = lines.filter(
      (r) => r.tool_name === DELEGATION_SIGNAL_TOOL_NAME,
    ).length;
    expect(delegationCount).toBe(10);
  });

  it('many concurrent delegation-signal-only writes keep the chain linear', async () => {
    // Pure delegation-signal stress: 25 parallel writes of the same
    // record class. This is the closest synthetic to the real-world
    // pattern (a session with rapid Agent/Skill dispatch).
    const writes = Array.from({ length: 25 }, (_, i) => {
      const m: DelegationSignalMetadata = {
        schema_version: DELEGATION_SIGNAL_SCHEMA_VERSION,
        delegation_tool: 'Agent',
        subagent_type: `agent-${i}`,
        session_id_observed: 'stress-session',
        parent_subagent_type: null,
        invocation_description_sha256: EMPTY_HASH,
      };
      return appendAuditRecord(baseDir, {
        tool_name: DELEGATION_SIGNAL_TOOL_NAME,
        server_name: DELEGATION_SIGNAL_SERVER_NAME,
        tier: Tier.Read,
        status: InvocationStatus.Allowed,
        session_id: 'stress-session',
        metadata: m as unknown as Record<string, unknown>,
      });
    });
    await Promise.all(writes);
    const lines = await readAuditLines(baseDir);
    expect(lines).toHaveLength(25);
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]!.prev_hash).toBe(lines[i - 1]!.hash);
    }
  });

  it('`rea audit verify` reports a clean chain after concurrent delegation writes', async () => {
    // Build the chain.
    const writes = Array.from({ length: 8 }, (_, i) => {
      const m: DelegationSignalMetadata = {
        schema_version: DELEGATION_SIGNAL_SCHEMA_VERSION,
        delegation_tool: 'Skill',
        subagent_type: `skill-${i}`,
        session_id_observed: 'verify-session',
        parent_subagent_type: null,
        invocation_description_sha256: EMPTY_HASH,
      };
      return appendAuditRecord(baseDir, {
        tool_name: DELEGATION_SIGNAL_TOOL_NAME,
        server_name: DELEGATION_SIGNAL_SERVER_NAME,
        tier: Tier.Read,
        status: InvocationStatus.Allowed,
        session_id: 'verify-session',
        metadata: m as unknown as Record<string, unknown>,
      });
    });
    await Promise.all(writes);

    // Spawn `node dist/cli/index.js audit verify`. The build artifact
    // is required because the test harness runs against `src/`; the
    // CLI binary uses the dist.
    const distCli = path.resolve(__dirname, '..', '..', 'dist', 'cli', 'index.js');
    // Skip if dist isn't built (e.g. running the test in isolation
    // pre-build). The CI gate always builds before tests.
    let distExists = true;
    try {
      await fs.access(distCli);
    } catch {
      distExists = false;
    }
    if (!distExists) return;
    const res = spawnSync('node', [distCli, 'audit', 'verify'], {
      cwd: baseDir,
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(res.status).toBe(0);
  });
});
