/**
 * CLI-level tests for `rea tofu` (defect S).
 *
 * Focus areas:
 *   1. `classifyRows` — pure classifier matches verdicts from the G7 primitive.
 *   2. `runTofuAccept` — rebases the stored fingerprint and emits an audit
 *       record on drift; no-op when stored already matches current.
 *   3. `runTofuAccept` — rejects unknown server names (process.exit(1)).
 *   4. `runTofuList` — emits JSON with classification rows when `--json` is set.
 *
 * Pattern matches `cache.test.ts`: mkdtemp + process.chdir + spy stdout/stderr.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fingerprintServer } from '../registry/fingerprint.js';
import { FINGERPRINT_STORE_VERSION, loadFingerprintStore } from '../registry/fingerprints-store.js';
import { invalidateRegistryCache } from '../registry/loader.js';
import type { RegistryServer } from '../registry/types.js';
import { classifyRows, runTofuAccept, runTofuList } from './tofu.js';

async function writeRegistry(baseDir: string, servers: RegistryServer[]): Promise<void> {
  const yamlLines: string[] = ['version: "1"', 'servers:'];
  for (const s of servers) {
    yamlLines.push(`  - name: ${s.name}`);
    yamlLines.push(`    command: ${s.command}`);
    yamlLines.push(`    args:`);
    for (const a of s.args ?? []) {
      yamlLines.push(`      - ${JSON.stringify(a)}`);
    }
    yamlLines.push(`    enabled: ${s.enabled !== false ? 'true' : 'false'}`);
  }
  yamlLines.push('');
  await fs.writeFile(path.join(baseDir, '.rea', 'registry.yaml'), yamlLines.join('\n'), 'utf8');
}

async function writeStore(baseDir: string, servers: Record<string, string>): Promise<void> {
  await fs.writeFile(
    path.join(baseDir, '.rea', 'fingerprints.json'),
    JSON.stringify({ version: FINGERPRINT_STORE_VERSION, servers }, null, 2) + '\n',
    'utf8',
  );
}

function server(name: string, overrides: Partial<RegistryServer> = {}): RegistryServer {
  return {
    name,
    command: 'node',
    args: ['-e', `"${name}"`],
    env: {},
    enabled: true,
    ...overrides,
  };
}

function captureIO(fn: () => Promise<void>): Promise<{
  stdout: string;
  stderr: string;
  logs: string[];
  errors: string[];
}> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const logs: string[] = [];
  const errors: string[] = [];

  const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  });

  return fn()
    .then(() => ({
      stdout: stdoutChunks.join(''),
      stderr: stderrChunks.join(''),
      logs,
      errors,
    }))
    .finally(() => {
      writeSpy.mockRestore();
      stderrSpy.mockRestore();
      logSpy.mockRestore();
      errSpy.mockRestore();
    });
}

describe('classifyRows', () => {
  it('flags unchanged, drifted, and first-seen verdicts in one pass', () => {
    const same = server('a');
    const altered = server('b', { args: ['-e', '"altered"'] });
    const fresh = server('c');
    const rows = classifyRows([same, altered, fresh], {
      a: fingerprintServer(same),
      b: fingerprintServer(server('b')),
    });
    const byName = Object.fromEntries(rows.map((r) => [r.name, r.verdict]));
    expect(byName).toEqual({
      a: 'unchanged',
      b: 'drifted',
      c: 'first-seen',
    });
  });
});

describe('rea tofu accept', () => {
  let baseDir: string;
  let previousCwd: string;

  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-tofu-cli-')));
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
    previousCwd = process.cwd();
    process.chdir(baseDir);
    invalidateRegistryCache();
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    invalidateRegistryCache();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('rebases stored fingerprint to current canonical on drift and records audit', async () => {
    const pristine = server('obsidian');
    const edited = server('obsidian', { args: ['-e', '"edited"'] });
    await writeRegistry(baseDir, [edited]);
    await writeStore(baseDir, { obsidian: fingerprintServer(pristine) });

    const { logs } = await captureIO(() =>
      runTofuAccept({ name: 'obsidian', reason: 'added vault path' }),
    );

    const store = await loadFingerprintStore(baseDir);
    expect(store.servers.obsidian).toBe(fingerprintServer(edited));
    expect(logs.join('\n')).toMatch(/tofu: accepted "obsidian"/);

    const auditPath = path.join(baseDir, '.rea', 'audit.jsonl');
    const auditRaw = await fs.readFile(auditPath, 'utf8');
    const auditLines = auditRaw.trim().split('\n');
    const lastEntry = JSON.parse(auditLines[auditLines.length - 1]!) as {
      tool_name: string;
      metadata: { event: string; server: string; reason: string };
    };
    expect(lastEntry.tool_name).toBe('rea.tofu');
    expect(lastEntry.metadata.event).toBe('tofu.drift_accepted_by_cli');
    expect(lastEntry.metadata.server).toBe('obsidian');
    expect(lastEntry.metadata.reason).toBe('added vault path');
  });

  it('records first-seen event when store has no prior entry', async () => {
    const s = server('discord-ops');
    await writeRegistry(baseDir, [s]);
    await writeStore(baseDir, {});

    await captureIO(() => runTofuAccept({ name: 'discord-ops' }));

    const store = await loadFingerprintStore(baseDir);
    expect(store.servers['discord-ops']).toBe(fingerprintServer(s));

    const auditRaw = await fs.readFile(path.join(baseDir, '.rea', 'audit.jsonl'), 'utf8');
    const last = JSON.parse(auditRaw.trim().split('\n').pop()!) as {
      metadata: { event: string; stored_fingerprint: string | null };
    };
    expect(last.metadata.event).toBe('tofu.first_seen_accepted_by_cli');
    expect(last.metadata.stored_fingerprint).toBeNull();
  });

  it('is a no-op when stored already matches current fingerprint', async () => {
    const s = server('obsidian');
    await writeRegistry(baseDir, [s]);
    await writeStore(baseDir, { obsidian: fingerprintServer(s) });

    const { logs } = await captureIO(() => runTofuAccept({ name: 'obsidian' }));
    expect(logs.join('\n')).toMatch(/already matches stored fingerprint/);

    const auditPath = path.join(baseDir, '.rea', 'audit.jsonl');
    await expect(fs.access(auditPath)).rejects.toThrow();
  });

  it('rejects unknown server names via process.exit(1)', async () => {
    await writeRegistry(baseDir, [server('obsidian')]);
    await writeStore(baseDir, {});

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);

    await expect(captureIO(() => runTofuAccept({ name: 'does-not-exist' }))).rejects.toThrow(
      /process\.exit\(1\)/,
    );

    exitSpy.mockRestore();
  });
});

describe('rea tofu list --json', () => {
  let baseDir: string;
  let previousCwd: string;

  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-tofu-list-')));
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
    previousCwd = process.cwd();
    process.chdir(baseDir);
    invalidateRegistryCache();
  });

  afterEach(async () => {
    process.chdir(previousCwd);
    invalidateRegistryCache();
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('prints every row with verdict + short fingerprints', async () => {
    const same = server('a');
    const drifted = server('b', { args: ['-e', '"changed"'] });
    await writeRegistry(baseDir, [same, drifted]);
    await writeStore(baseDir, {
      a: fingerprintServer(same),
      b: fingerprintServer(server('b')),
    });

    const { stdout } = await captureIO(() => runTofuList({ json: true }));
    const parsed = JSON.parse(stdout) as {
      servers: Array<{ name: string; verdict: string; current: string; stored: string | null }>;
    };
    expect(parsed.servers).toHaveLength(2);
    const byName = Object.fromEntries(parsed.servers.map((s) => [s.name, s.verdict]));
    expect(byName).toEqual({ a: 'unchanged', b: 'drifted' });
  });
});
