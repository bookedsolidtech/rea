import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createGateway } from './server.js';
import { invalidatePolicyCache } from '../policy/loader.js';
import { invalidateRegistryCache } from '../registry/loader.js';
import { AutonomyLevel, InvocationStatus, Tier } from '../policy/types.js';
import { __resetSessionForTests } from './session.js';
import type { Policy } from '../policy/types.js';
import type { Registry } from '../registry/types.js';

function basePolicy(): Policy {
  return {
    version: '1',
    profile: 'minimal',
    installed_by: 'tester',
    installed_at: '2026-04-18T00:00:00Z',
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

describe('gateway server smoke', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-gateway-'));
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
    invalidatePolicyCache();
    invalidateRegistryCache();
    __resetSessionForTests();
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('zero-server mode: listTools returns empty catalog', async () => {
    const policy = basePolicy();
    await writePolicy(baseDir, policy);
    const handle = createGateway({ baseDir, policy, registry: emptyRegistry() });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await handle.start(serverSide);

    const client = new Client(
      { name: 'rea-test-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientSide);

    const tools = await client.listTools();
    expect(tools.tools).toEqual([]);

    await client.close();
    await handle.stop();
  });

  it('zero-server mode: callTool returns isError (denied)', async () => {
    const policy = basePolicy();
    await writePolicy(baseDir, policy);
    const handle = createGateway({ baseDir, policy, registry: emptyRegistry() });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await handle.start(serverSide);

    const client = new Client(
      { name: 'rea-test-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientSide);

    const result = (await client.callTool({
      name: 'mock__ping',
      arguments: {},
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/No downstream servers/);

    // Audit line should exist and include a valid hash chain entry.
    const auditRaw = await fs.readFile(path.join(baseDir, '.rea', 'audit.jsonl'), 'utf8');
    const lines = auditRaw.trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const lastLine = lines[lines.length - 1]!;
    const record = JSON.parse(lastLine) as {
      tool_name: string;
      status: string;
      hash: string;
      prev_hash: string;
    };
    expect(record.tool_name).toBe('ping');
    expect(record.status).toBe(InvocationStatus.Denied);
    expect(record.hash).toHaveLength(64);
    expect(record.prev_hash).toHaveLength(64);

    await client.close();
    await handle.stop();
  });

  it('HALT present: callTool denied before policy check', async () => {
    const policy = basePolicy();
    await writePolicy(baseDir, policy);
    await fs.writeFile(path.join(baseDir, '.rea', 'HALT'), 'smoke test', 'utf8');

    const handle = createGateway({ baseDir, policy, registry: emptyRegistry() });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await handle.start(serverSide);

    const client = new Client(
      { name: 'rea-test-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientSide);

    const result = (await client.callTool({
      name: 'mock__ping',
      arguments: {},
    })) as { isError?: boolean; content: Array<{ type: string; text: string }> };

    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/Kill switch/);

    const auditRaw = await fs.readFile(path.join(baseDir, '.rea', 'audit.jsonl'), 'utf8');
    const lines = auditRaw.trim().split('\n');
    const record = JSON.parse(lines[lines.length - 1]!) as { status: string };
    expect(record.status).toBe(InvocationStatus.Denied);

    await client.close();
    await handle.stop();
  });

  it('tier is classified before middleware chain runs', async () => {
    // Sanity guard for the tier-derivation wiring — uses a read-ish tool name
    // so the policy middleware permits it under L1, but the downstream is
    // empty so terminal will still deny. We assert tier is Read in the audit.
    const policy = basePolicy();
    await writePolicy(baseDir, policy);
    const handle = createGateway({ baseDir, policy, registry: emptyRegistry() });

    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await handle.start(serverSide);

    const client = new Client(
      { name: 'rea-test-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientSide);

    await client.callTool({ name: 'mock__list_items', arguments: {} });

    const auditRaw = await fs.readFile(path.join(baseDir, '.rea', 'audit.jsonl'), 'utf8');
    const record = JSON.parse(auditRaw.trim().split('\n').pop()!) as { tier: string };
    expect(record.tier).toBe(Tier.Read);

    await client.close();
    await handle.stop();
  });
});
