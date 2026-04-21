import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeStatusPayload, sanitizeForTerminal } from './status.js';
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

  it('bounded memory: summarizes a multi-megabyte audit without loading it all', async () => {
    await writeBasePolicy(baseDir);

    // Build a ~6 MB synthetic audit by writing many padded JSONL records.
    // The last record is the only one that needs to parse — every other line
    // is just noise. The stream-counter must report the correct line count
    // regardless of size, and the tail-window read must still find the final
    // record's timestamp + hash.
    const auditPath = path.join(baseDir, '.rea', 'audit.jsonl');
    const fh = await fs.open(auditPath, 'w');
    try {
      const filler = 'x'.repeat(512);
      // ~12000 lines of filler at ~512 bytes each ≈ 6 MB. Keep each line
      // as valid JSON-ish so a broken parse on an intermediate line doesn't
      // hide a real bug.
      for (let i = 0; i < 12_000; i++) {
        await fh.write(`{"n":${i},"pad":"${filler}"}\n`);
      }
      // Final record is the one summarizeAudit reports from.
      const validHash = 'a'.repeat(64);
      await fh.write(
        JSON.stringify({
          timestamp: '2026-04-18T23:59:59.999Z',
          tool_name: 'final',
          hash: validHash,
        }) + '\n',
      );
    } finally {
      await fh.close();
    }

    const before = process.memoryUsage().heapUsed;
    const payload = computeStatusPayload(baseDir);
    const afterUsed = process.memoryUsage().heapUsed;

    expect(payload.audit.present).toBe(true);
    expect(payload.audit.lines).toBe(12_001);
    expect(payload.audit.last_timestamp).toBe('2026-04-18T23:59:59.999Z');
    expect(payload.audit.tail_hash_looks_valid).toBe(true);

    // Defense-in-depth assertion: the streaming read must not have doubled
    // heap with the full file. A generous 50 MB bound catches a regression
    // to `readFileSync` without being flaky on a busy CI runner.
    expect(afterUsed - before).toBeLessThan(50 * 1024 * 1024);
  });

  it('parses the 0.9.0 downstreams block from serve.state.json', async () => {
    await writeBasePolicy(baseDir);
    await fs.writeFile(path.join(baseDir, '.rea', 'serve.pid'), String(process.pid), 'utf8');
    await fs.writeFile(
      path.join(baseDir, '.rea', 'serve.state.json'),
      JSON.stringify({
        session_id: 'test-session-9',
        started_at: '2026-04-20T12:00:00Z',
        metrics_port: 9464,
        downstreams: [
          {
            name: 'helixir',
            connected: false,
            healthy: false,
            circuit_state: 'open',
            retry_at: '2026-04-20T12:05:00Z',
            last_error: 'connection closed',
            tools_count: null,
            open_transitions: 4,
            session_blocker_emitted: true,
          },
          {
            name: 'obsidian',
            connected: true,
            healthy: true,
            circuit_state: 'closed',
            retry_at: null,
            last_error: null,
            tools_count: 12,
            open_transitions: 0,
            session_blocker_emitted: false,
          },
        ],
      }),
      'utf8',
    );

    const payload = computeStatusPayload(baseDir);
    expect(payload.serve.downstreams).not.toBeNull();
    const ds = payload.serve.downstreams!;
    expect(ds).toHaveLength(2);
    const helixir = ds.find((d) => d.name === 'helixir');
    const obsidian = ds.find((d) => d.name === 'obsidian');
    expect(helixir?.circuit_state).toBe('open');
    expect(helixir?.retry_at).toBe('2026-04-20T12:05:00Z');
    expect(helixir?.session_blocker_emitted).toBe(true);
    expect(helixir?.open_transitions).toBe(4);
    expect(obsidian?.circuit_state).toBe('closed');
    expect(obsidian?.tools_count).toBe(12);
  });

  it('treats a missing downstreams field as null (legacy state file)', async () => {
    await writeBasePolicy(baseDir);
    await fs.writeFile(path.join(baseDir, '.rea', 'serve.pid'), String(process.pid), 'utf8');
    // Legacy pre-0.9.0 state file shape — no downstreams key.
    await fs.writeFile(
      path.join(baseDir, '.rea', 'serve.state.json'),
      JSON.stringify({
        session_id: 'legacy',
        started_at: '2026-04-18T00:00:00Z',
        metrics_port: null,
      }),
      'utf8',
    );

    const payload = computeStatusPayload(baseDir);
    expect(payload.serve.downstreams).toBeNull();
  });

  it('skips malformed downstream entries but keeps the valid ones', async () => {
    await writeBasePolicy(baseDir);
    await fs.writeFile(path.join(baseDir, '.rea', 'serve.pid'), String(process.pid), 'utf8');
    await fs.writeFile(
      path.join(baseDir, '.rea', 'serve.state.json'),
      JSON.stringify({
        session_id: 'mixed',
        started_at: '2026-04-20T12:00:00Z',
        metrics_port: null,
        downstreams: [
          { name: 'good', connected: true, healthy: true, circuit_state: 'closed' },
          { not_a_name: 'whatever' },
          null,
          'garbage',
          { name: '', circuit_state: 'closed' },
        ],
      }),
      'utf8',
    );

    const payload = computeStatusPayload(baseDir);
    const ds = payload.serve.downstreams!;
    expect(ds).toHaveLength(1);
    expect(ds[0]?.name).toBe('good');
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

describe('sanitizeForTerminal — ANSI/OSC escape injection defense', () => {
  it('strips the ESC (0x1B) byte that initiates ANSI CSI / OSC sequences', () => {
    // Typical CSI red-text escape. `\x1b[31m` must not reach the operator's
    // terminal — it would flip their text red and (with OSC 8) be clickable.
    const input = 'benign\x1b[31mred\x1b[0m';
    const out = sanitizeForTerminal(input);
    expect(out).not.toContain('\x1b');
    expect(out).toBe('benign?[31mred?[0m');
  });

  it('strips the OSC 8 hyperlink sequence (ESC + ] and ST)', () => {
    // OSC 8 spoofs clickable URLs in modern terminals (iTerm2, kitty).
    // ESC ] 8 ; ; https://evil/ ESC \\ label ESC ] 8 ; ; ESC \\
    const input = '\x1b]8;;https://evil/\x07label\x1b]8;;\x07';
    const out = sanitizeForTerminal(input);
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('\x07');
  });

  it('strips every C0 control byte (0x00-0x1F) including CR, LF, TAB, BEL', () => {
    // Feed an exhaustive C0 run + DEL. All must be replaced with `?` — a
    // surviving CR could rewind the cursor; a surviving BEL could ring the
    // terminal; a surviving TAB could realign a fake prompt on re-render.
    let input = '';
    for (let b = 0; b <= 0x1f; b++) input += String.fromCharCode(b);
    input += '\x7f';
    const out = sanitizeForTerminal(input);
    for (let b = 0; b <= 0x1f; b++) {
      expect(out).not.toContain(String.fromCharCode(b));
    }
    expect(out).not.toContain('\x7f');
  });

  it('preserves printable ASCII verbatim', () => {
    const input = 'profile=bst-internal autonomy=L1';
    expect(sanitizeForTerminal(input)).toBe(input);
  });

  it('preserves high-bit bytes (UTF-8 multi-byte) — non-C0 text is untouched', () => {
    const input = 'session — abc-äöü-123';
    expect(sanitizeForTerminal(input)).toBe(input);
  });
});

describe('printPretty — base_dir sanitization', () => {
  it('sanitizeForTerminal replaces ESC bytes in a base_dir-shaped path with ?', () => {
    // A directory named with an ANSI red-text escape sequence must not reach
    // the operator's terminal verbatim. Simulate what printPretty does:
    // apply sanitizeForTerminal to a base_dir containing ESC bytes.
    const maliciousPath = '/home/user/\x1b[31mevil\x1b[0m-project';
    const sanitized = sanitizeForTerminal(maliciousPath);
    expect(sanitized).not.toContain('\x1b');
    expect(sanitized).toBe('/home/user/?[31mevil?[0m-project');
  });
});

describe('summarizeAudit — terminal-safe output via computeStatusPayload', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-status-ansi-'));
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
    invalidatePolicyCache();
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('returns HALT reason with control chars intact in the payload (sanitization is pretty-print only)', async () => {
    // computeStatusPayload MUST NOT sanitize — JSON consumers expect fidelity.
    // Sanitization is the responsibility of printPretty (exercised via
    // sanitizeForTerminal above). Here we lock in that the payload itself
    // carries the raw value.
    await fs.writeFile(
      path.join(baseDir, '.rea', 'policy.yaml'),
      `version: "1"
profile: "minimal"
installed_by: "tester"
installed_at: "2026-04-18T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths: []
notification_channel: ""
review:
  codex_required: false
`,
      'utf8',
    );
    const halt = 'malicious\x1b[31mred';
    await fs.writeFile(path.join(baseDir, '.rea', 'HALT'), halt, 'utf8');

    const payload = computeStatusPayload(baseDir);
    expect(payload.policy.halt_active).toBe(true);
    // Payload preserves the raw ESC — consumers using JSON mode get a
    // JSON.stringify-escaped `\u001b` and can render safely themselves.
    expect(payload.policy.halt_reason).toContain('\x1b[31m');
    // The sanitizer would map it to `?[31mred` — verify that's what would
    // actually reach a pretty-mode TTY.
    expect(sanitizeForTerminal(payload.policy.halt_reason ?? '')).toBe('malicious?[31mred');
  });
});
