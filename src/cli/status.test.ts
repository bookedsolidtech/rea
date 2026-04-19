import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeStatusPayload } from './status.js';
import { invalidatePolicyCache } from '../policy/loader.js';

async function writeBasePolicy(baseDir: string): Promise<void> {
  const yaml = `version: "1"
profile: "minimal"
installed_by: "tester"
installed_at: "2026-04-18T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths:
  - ".env"
  - ".env.*"
notification_channel: ""
review:
  codex_required: false
`;
  await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
}

describe('rea status — computeStatusPayload', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-status-'));
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
    invalidatePolicyCache();
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('reports serve.running = false when no pidfile exists', async () => {
    await writeBasePolicy(baseDir);
    const payload = computeStatusPayload(baseDir);
    expect(payload.serve.running).toBe(false);
    expect(payload.serve.pid).toBeNull();
    expect(payload.serve.stale).toBe(false);
  });

  it('reports serve.running = true when pidfile points at a live pid', async () => {
    await writeBasePolicy(baseDir);
    // The current test process is guaranteed alive.
    await fs.writeFile(path.join(baseDir, '.rea', 'serve.pid'), String(process.pid), 'utf8');
    await fs.writeFile(
      path.join(baseDir, '.rea', 'serve.state.json'),
      JSON.stringify({
        session_id: 'test-session-1',
        started_at: '2026-04-18T12:00:00Z',
        metrics_port: 9464,
      }),
      'utf8',
    );

    const payload = computeStatusPayload(baseDir);
    expect(payload.serve.running).toBe(true);
    expect(payload.serve.pid).toBe(process.pid);
    expect(payload.serve.session_id).toBe('test-session-1');
    expect(payload.serve.metrics_port).toBe(9464);
  });

  it('reports stale = true when pidfile points at a dead pid', async () => {
    await writeBasePolicy(baseDir);
    // PID 1 on a container may be alive, but an astronomical PID is
    // overwhelmingly likely dead on every supported platform.
    const deadPid = 9_999_997;
    await fs.writeFile(path.join(baseDir, '.rea', 'serve.pid'), String(deadPid), 'utf8');

    const payload = computeStatusPayload(baseDir);
    expect(payload.serve.running).toBe(false);
    expect(payload.serve.pid).toBe(deadPid);
    expect(payload.serve.stale).toBe(true);
  });

  it('surfaces HALT state and reason in the policy summary', async () => {
    await writeBasePolicy(baseDir);
    await fs.writeFile(path.join(baseDir, '.rea', 'HALT'), 'security incident — halted\n', 'utf8');
    const payload = computeStatusPayload(baseDir);
    expect(payload.policy.halt_active).toBe(true);
    expect(payload.policy.halt_reason).toBe('security incident — halted');
  });

  it('summarizes the audit log with line count, last timestamp, and tail-hash smoke', async () => {
    await writeBasePolicy(baseDir);
    const ts = '2026-04-18T11:22:33.000Z';
    const validHash = 'f'.repeat(64);
    const record = {
      timestamp: ts,
      tool_name: 'ping',
      hash: validHash,
    };
    await fs.writeFile(
      path.join(baseDir, '.rea', 'audit.jsonl'),
      JSON.stringify(record) + '\n',
      'utf8',
    );

    const payload = computeStatusPayload(baseDir);
    expect(payload.audit.present).toBe(true);
    expect(payload.audit.lines).toBe(1);
    expect(payload.audit.last_timestamp).toBe(ts);
    expect(payload.audit.tail_hash_looks_valid).toBe(true);
  });

  it('gracefully handles a corrupt audit tail without throwing', async () => {
    await writeBasePolicy(baseDir);
    await fs.writeFile(path.join(baseDir, '.rea', 'audit.jsonl'), 'not-json-at-all\n', 'utf8');
    const payload = computeStatusPayload(baseDir);
    expect(payload.audit.lines).toBe(1);
    expect(payload.audit.last_timestamp).toBeNull();
    expect(payload.audit.tail_hash_looks_valid).toBe(false);
  });

  it('reflects review.codex_required = true when the profile demands it', async () => {
    // Overwrite with a codex-required policy.
    const yaml = `version: "1"
profile: "bst-internal"
installed_by: "tester"
installed_at: "2026-04-18T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths: []
notification_channel: ""
review:
  codex_required: true
`;
    await fs.writeFile(path.join(baseDir, '.rea', 'policy.yaml'), yaml, 'utf8');
    const payload = computeStatusPayload(baseDir);
    expect(payload.policy.codex_required).toBe(true);
  });
});
