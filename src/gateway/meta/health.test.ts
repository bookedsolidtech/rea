import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createGateway } from '../server.js';
import { invalidatePolicyCache } from '../../policy/loader.js';
import { invalidateRegistryCache } from '../../registry/loader.js';
import { AutonomyLevel, InvocationStatus, Tier } from '../../policy/types.js';
import { __resetSessionForTests } from '../session.js';
import type { Policy } from '../../policy/types.js';
import type { Registry } from '../../registry/types.js';
import {
  META_HEALTH_TOOL_NAME,
  META_SERVER_NAME,
  META_TOOL_NAME,
  buildHealthSnapshot,
  metaHealthToolDescriptor,
} from './health.js';
import type { DownstreamHealth } from '../downstream-pool.js';

function basePolicy(): Policy {
  return {
    version: '1',
    profile: 'minimal',
    installed_by: 'tester',
    installed_at: '2026-04-19T00:00:00Z',
    autonomy_level: AutonomyLevel.L1,
    max_autonomy_level: AutonomyLevel.L2,
    promotion_requires_human_approval: true,
    block_ai_attribution: true,
    blocked_paths: ['.env', '.env.*'],
    notification_channel: '',
  };
}

function emptyRegistry(): Registry {
  return { version: '1', servers: [] };
}

function brokenRegistry(): Registry {
  // A registry entry that will refuse to spawn because the referenced env
  // var is not set. Used to prove health reports `connected: false` without
  // actually booting a child.
  return {
    version: '1',
    servers: [
      {
        name: 'brokencfg',
        command: 'node',
        args: ['-e', 'console.log("never reached")'],
        env: { BROKENCFG_TOKEN: '${REA_HEALTH_TEST_MISSING_VAR_XYZ}' },
        enabled: true,
      },
    ],
  };
}

async function writePolicy(baseDir: string, policy: Policy): Promise<void> {
  const yaml = `version: "1"
profile: ${JSON.stringify(policy.profile)}
installed_by: ${JSON.stringify(policy.installed_by)}
installed_at: ${JSON.stringify(policy.installed_at)}
autonomy_level: ${policy.autonomy_level}
max_autonomy_level: ${policy.max_autonomy_level}
promotion_requires_human_approval: ${policy.promotion_requires_human_approval}
block_ai_attribution: ${policy.block_ai_attribution}
blocked_paths:
${policy.blocked_paths.map((p) => `  - ${JSON.stringify(p)}`).join('\n')}
notification_channel: ${JSON.stringify(policy.notification_channel)}
`;
  await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
}

describe('__rea__health meta-tool — pure snapshot builder', () => {
  it('reports an empty downstreams array with zero summary counts', () => {
    const snap = buildHealthSnapshot({
      gatewayVersion: '0.5.1',
      startedAtMs: Date.now() - 1_000,
      policy: basePolicy(),
      downstreams: [],
      halt: false,
      haltReason: null,
    });

    expect(snap.summary.registered).toBe(0);
    expect(snap.summary.connected).toBe(0);
    expect(snap.summary.healthy).toBe(0);
    expect(snap.summary.total_tools).toBe(0);
    expect(snap.gateway.halt).toBe(false);
    expect(snap.gateway.version).toBe('0.5.1');
  });

  it('rolls up counts across a mixed fleet', () => {
    const ds: DownstreamHealth[] = [
      { name: 'ok', enabled: true, connected: true, healthy: true, last_error: null, tools_count: 11 },
      { name: 'flapping', enabled: true, connected: true, healthy: false, last_error: 'rc=1', tools_count: null },
      { name: 'dead', enabled: true, connected: false, healthy: false, last_error: 'boom', tools_count: null },
    ];
    const snap = buildHealthSnapshot({
      gatewayVersion: '0.5.1',
      startedAtMs: Date.now() - 5_000,
      policy: basePolicy(),
      downstreams: ds,
      halt: true,
      haltReason: 'smoke test',
    });
    expect(snap.summary.registered).toBe(3);
    expect(snap.summary.connected).toBe(2);
    expect(snap.summary.healthy).toBe(1);
    expect(snap.summary.total_tools).toBe(11);
    expect(snap.gateway.halt).toBe(true);
    expect(snap.gateway.halt_reason).toBe('smoke test');
  });

  it('computes non-negative uptime even under clock skew', () => {
    const now = 1_000_000;
    const future = now + 100_000; // startedAtMs after "now" — clock skew / mock
    const snap = buildHealthSnapshot({
      gatewayVersion: '0.5.1',
      startedAtMs: future,
      policy: basePolicy(),
      downstreams: [],
      halt: false,
      haltReason: null,
      nowMs: now,
    });
    expect(snap.gateway.uptime_s).toBeGreaterThanOrEqual(0);
  });
});

describe('__rea__health meta-tool descriptor', () => {
  it('advertises a zero-argument input schema', () => {
    const d = metaHealthToolDescriptor();
    expect(d.name).toBe(META_HEALTH_TOOL_NAME);
    expect(d.inputSchema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    expect(d.description.length).toBeGreaterThan(20);
  });
});

describe('__rea__health through the gateway', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-health-'));
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
    invalidatePolicyCache();
    invalidateRegistryCache();
    __resetSessionForTests();
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('is listed in tools/list when zero downstreams are registered', async () => {
    const policy = basePolicy();
    await writePolicy(baseDir, policy);
    const handle = createGateway({ baseDir, policy, registry: emptyRegistry() });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await handle.start(serverSide);
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await client.connect(clientSide);

    const tools = await client.listTools();
    expect(tools.tools).toHaveLength(1);
    expect(tools.tools[0]!.name).toBe(META_HEALTH_TOOL_NAME);

    await client.close();
    await handle.stop();
  });

  it('is callable and returns a snapshot when all downstreams are unhealthy', async () => {
    const policy = basePolicy();
    await writePolicy(baseDir, policy);
    // Unhealthy downstream: the `${REA_HEALTH_TEST_MISSING_VAR_XYZ}` reference
    // is unset, so connect() refuses. connectAll() swallows the single failure
    // because there's exactly one server — total failure would throw.
    const handle = createGateway({ baseDir, policy, registry: brokenRegistry() });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await handle.start(serverSide);
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await client.connect(clientSide);

    const result = (await client.callTool({
      name: META_HEALTH_TOOL_NAME,
      arguments: {},
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };

    expect(result.isError).toBeFalsy();
    const snap = JSON.parse(result.content[0]!.text) as {
      summary: { registered: number; healthy: number; connected: number };
      downstreams: Array<{ name: string; healthy: boolean; connected: boolean; last_error: string | null }>;
      gateway: { halt: boolean };
      policy: { profile: string };
    };
    expect(snap.summary.registered).toBe(1);
    expect(snap.summary.healthy).toBe(0);
    expect(snap.summary.connected).toBe(0);
    expect(snap.downstreams[0]!.name).toBe('brokencfg');
    // BUG-011 (0.6.2): last_error is stripped to null by default — the
    // upstream error string can contain secrets or injection payloads.
    // Full text still flows to `rea doctor` (reads pool.healthSnapshot()
    // pre-sanitize) and into the meta-tool audit record
    // (`metadata.downstream_errors[].last_error`). Opt-in via
    // `gateway.health.expose_diagnostics: true` to get the redacted string
    // on the MCP wire itself (covered by health-sanitize.test.ts).
    expect(snap.downstreams[0]!.last_error).toBeNull();
    // Codex F1 regression: a dead downstream must report tools_count: null,
    // not a stale cached count from some prior successful listing.
    expect(snap.downstreams[0]!.tools_count).toBeNull();
    expect(snap.policy.profile).toBe('minimal');
    expect(snap.gateway.halt).toBe(false);

    await client.close();
    await handle.stop();
  });

  it('remains callable while HALT is active (bypasses kill-switch)', async () => {
    const policy = basePolicy();
    await writePolicy(baseDir, policy);
    await fs.writeFile(path.join(baseDir, '.rea', 'HALT'), 'snapshot diagnostic', 'utf8');

    const handle = createGateway({ baseDir, policy, registry: emptyRegistry() });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await handle.start(serverSide);
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await client.connect(clientSide);

    const result = (await client.callTool({
      name: META_HEALTH_TOOL_NAME,
      arguments: {},
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };

    expect(result.isError).toBeFalsy();
    const snap = JSON.parse(result.content[0]!.text) as {
      gateway: { halt: boolean; halt_reason: string | null };
    };
    expect(snap.gateway.halt).toBe(true);
    // BUG-011 (0.6.2): halt_reason is stripped to null by default. The
    // kill-switch bypass behavior (short-circuit still responds under HALT)
    // is what this test exists to prove — and it does, because
    // `gateway.halt: true` is still surfaced.
    expect(snap.gateway.halt_reason).toBeNull();

    await client.close();
    await handle.stop();
  });

  it('rejects unknown __rea__* names with a reserved-namespace error (Codex F4)', async () => {
    const policy = basePolicy();
    await writePolicy(baseDir, policy);
    const handle = createGateway({ baseDir, policy, registry: emptyRegistry() });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await handle.start(serverSide);
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await client.connect(clientSide);

    const result = (await client.callTool({
      name: '__rea__nonexistent',
      arguments: {},
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/reserved meta-namespace/);
    expect(result.content[0]!.text).toMatch(/__rea__health/);

    await client.close();
    await handle.stop();
  });

  it('snapshot still serves when appendAuditRecord fails (Codex F3)', async () => {
    // Simulate an audit write failure by making `.rea/` read-only BEFORE the
    // call. proper-lockfile / appendFile will fail; the handler must log a
    // warn and still return the snapshot. Without this test a future refactor
    // could silently flip the semantic from "serve anyway" to "fail the
    // diagnostic" — defeating the whole point of the tool.
    const policy = basePolicy();
    await writePolicy(baseDir, policy);
    const handle = createGateway({ baseDir, policy, registry: emptyRegistry() });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await handle.start(serverSide);
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await client.connect(clientSide);

    // Mark .rea/ read-only — subsequent appendAuditRecord will throw.
    // We restore perms in the try/finally so the tempdir cleanup succeeds.
    const reaDir = path.join(baseDir, '.rea');
    await fs.chmod(reaDir, 0o555);
    try {
      const result = (await client.callTool({
        name: META_HEALTH_TOOL_NAME,
        arguments: {},
      })) as { isError?: boolean; content: Array<{ type: string; text: string }> };

      expect(result.isError).toBeFalsy();
      const snap = JSON.parse(result.content[0]!.text) as { summary: { registered: number } };
      expect(snap.summary.registered).toBe(0);
    } finally {
      await fs.chmod(reaDir, 0o755);
    }

    await client.close();
    await handle.stop();
  });

  it('writes an audit record for each call (accountable short-circuit)', async () => {
    const policy = basePolicy();
    await writePolicy(baseDir, policy);
    const handle = createGateway({ baseDir, policy, registry: emptyRegistry() });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await handle.start(serverSide);
    const client = new Client({ name: 'test', version: '0' }, { capabilities: {} });
    await client.connect(clientSide);

    await client.callTool({ name: META_HEALTH_TOOL_NAME, arguments: {} });

    // The audit append is awaited inside the handler, so by the time callTool
    // resolves the line must be on disk.
    const auditRaw = await fs.readFile(path.join(baseDir, '.rea', 'audit.jsonl'), 'utf8');
    const lastLine = auditRaw.trim().split('\n').pop()!;
    const record = JSON.parse(lastLine) as {
      tool_name: string;
      server_name: string;
      status: string;
      tier: string;
      hash: string;
      prev_hash: string;
    };
    expect(record.tool_name).toBe(META_TOOL_NAME);
    expect(record.server_name).toBe(META_SERVER_NAME);
    expect(record.status).toBe(InvocationStatus.Allowed);
    expect(record.tier).toBe(Tier.Read);
    expect(record.hash).toHaveLength(64);

    await client.close();
    await handle.stop();
  });
});
