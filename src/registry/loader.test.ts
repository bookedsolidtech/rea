import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidateRegistryCache, loadRegistry, loadRegistryAsync } from './loader.js';

const EMPTY_REGISTRY = `version: "1"
servers: []
`;

const ONE_SERVER = `version: "1"
servers:
  - name: mock
    command: node
    args: ["-e", "console.log('hi')"]
    env:
      FOO: bar
`;

describe('registry loader', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-registry-'));
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
    invalidateRegistryCache();
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('parses empty server list', async () => {
    await fs.writeFile(path.join(baseDir, '.rea', 'registry.yaml'), EMPTY_REGISTRY, 'utf8');
    const r = loadRegistry(baseDir);
    expect(r.version).toBe('1');
    expect(r.servers).toEqual([]);
  });

  it('parses a single-server registry (sync)', async () => {
    await fs.writeFile(path.join(baseDir, '.rea', 'registry.yaml'), ONE_SERVER, 'utf8');
    const r = loadRegistry(baseDir);
    expect(r.servers).toHaveLength(1);
    const s = r.servers[0]!;
    expect(s.name).toBe('mock');
    expect(s.command).toBe('node');
    expect(s.args).toEqual(['-e', "console.log('hi')"]);
    expect(s.env).toEqual({ FOO: 'bar' });
    expect(s.enabled).toBe(true);
  });

  it('parses a single-server registry (async)', async () => {
    await fs.writeFile(path.join(baseDir, '.rea', 'registry.yaml'), ONE_SERVER, 'utf8');
    const r = await loadRegistryAsync(baseDir);
    expect(r.servers[0]?.name).toBe('mock');
  });

  it('rejects invalid server names', async () => {
    const bad = `version: "1"
servers:
  - name: NotAllowed
    command: node
`;
    await fs.writeFile(path.join(baseDir, '.rea', 'registry.yaml'), bad, 'utf8');
    expect(() => loadRegistry(baseDir)).toThrow(/Invalid registry schema/);
  });

  it('rejects unknown fields (strict schema)', async () => {
    const bad = `version: "1"
servers:
  - name: ok
    command: node
    mystery: true
`;
    await fs.writeFile(path.join(baseDir, '.rea', 'registry.yaml'), bad, 'utf8');
    expect(() => loadRegistry(baseDir)).toThrow(/Invalid registry schema/);
  });

  it('accepts empty file as empty registry', async () => {
    await fs.writeFile(path.join(baseDir, '.rea', 'registry.yaml'), '', 'utf8');
    const r = loadRegistry(baseDir);
    expect(r.servers).toEqual([]);
  });

  it('throws when file is missing', () => {
    expect(() => loadRegistry(baseDir)).toThrow(/Registry file not found/);
  });
});
