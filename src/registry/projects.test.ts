/**
 * Unit tests for the user-global project registry. Every function takes an
 * explicit `registryPath` seam, so tests drive it against `fs.mkdtempSync`
 * temp files — the real `~/.rea/registry.json` is never touched and
 * `process.env.HOME` is never mutated.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadRegistry,
  pruneMissing,
  reconcile,
  registerProject,
  REGISTRY_VERSION,
  type Registry,
} from './projects.js';

let tmp: string;
let registryPath: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-registry-')));
  registryPath = path.join(tmp, 'home', '.rea', 'registry.json');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Create a project dir with (or without) a `.rea/` child. */
function makeProject(name: string, withRea = true): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  if (withRea) fs.mkdirSync(path.join(dir, '.rea'), { recursive: true });
  return fs.realpathSync(dir);
}

describe('loadRegistry', () => {
  it('returns an empty registry when the file is missing', () => {
    const reg = loadRegistry(registryPath);
    expect(reg).toEqual({ version: REGISTRY_VERSION, projects: {} });
  });

  it('throws on malformed JSON (never silently resets)', () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, '{ not json', 'utf8');
    expect(() => loadRegistry(registryPath)).toThrow(/not valid JSON/);
  });

  it('throws on schema-invalid content (fail-closed)', () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify({ version: '2', projects: {} }), 'utf8');
    expect(() => loadRegistry(registryPath)).toThrow(/schema validation/);
  });

  it('rejects unknown top-level keys (strict schema)', () => {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(
      registryPath,
      JSON.stringify({ version: '1', projects: {}, sneaky: true }),
      'utf8',
    );
    expect(() => loadRegistry(registryPath)).toThrow(/schema validation/);
  });
});

describe('registerProject', () => {
  it('upserts an entry and creates the registry (atomic)', async () => {
    const proj = makeProject('alpha');
    await registerProject(proj, { name: 'alpha', reaVersion: '0.51.0' }, registryPath);

    const reg = loadRegistry(registryPath);
    expect(Object.keys(reg.projects)).toEqual([proj]);
    const entry = reg.projects[proj]!;
    expect(entry.name).toBe('alpha');
    expect(entry.rea_version).toBe('0.51.0');
    expect(typeof entry.last_registered).toBe('string');
    // Serialized JSON is valid + no tmp/bak files left behind.
    expect(fs.existsSync(`${registryPath}.tmp`)).toBe(false);
  });

  it('is idempotent on the project key (no duplicate entries)', async () => {
    const proj = makeProject('beta');
    await registerProject(proj, { name: 'beta', reaVersion: '0.50.0' }, registryPath);
    await registerProject(proj, { name: 'beta', reaVersion: '0.51.0' }, registryPath);
    const reg = loadRegistry(registryPath);
    expect(Object.keys(reg.projects)).toHaveLength(1);
    expect(reg.projects[proj]!.rea_version).toBe('0.51.0');
  });

  it('preserves a hand-set dashboard_visible flag across re-registration', async () => {
    const proj = makeProject('gamma');
    await registerProject(proj, { name: 'gamma', reaVersion: '0.50.0' }, registryPath);
    // Simulate an operator hiding the project by hand-editing the registry.
    const reg = loadRegistry(registryPath);
    reg.projects[proj]!.dashboard_visible = false;
    fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2) + '\n', 'utf8');

    await registerProject(proj, { name: 'gamma', reaVersion: '0.51.0' }, registryPath);
    const after = loadRegistry(registryPath);
    expect(after.projects[proj]!.dashboard_visible).toBe(false);
    expect(after.projects[proj]!.rea_version).toBe('0.51.0');
  });

  it('stores the resolved absolute path as the key', async () => {
    const proj = makeProject('delta');
    const relParent = path.join(proj, 'sub', '..');
    await registerProject(relParent, { name: 'delta', reaVersion: '0.51.0' }, registryPath);
    const reg = loadRegistry(registryPath);
    expect(Object.keys(reg.projects)).toEqual([proj]);
  });

  it('does NOT clobber a real rea_version with "unknown" (round-8 P2)', async () => {
    const proj = makeProject('epsilon');
    await registerProject(proj, { name: 'epsilon', reaVersion: '0.51.0' }, registryPath);
    // A --rescan-style re-register with no readable version must keep the real one.
    await registerProject(proj, { name: 'epsilon', reaVersion: 'unknown' }, registryPath);
    expect(loadRegistry(registryPath).projects[proj]!.rea_version).toBe('0.51.0');
  });

  it('canonicalizes the key — a symlinked spelling is the SAME entry (round-8 P3)', async () => {
    const proj = makeProject('zeta');
    const link = path.join(tmp, 'zeta-link');
    fs.symlinkSync(proj, link);
    await registerProject(proj, { name: 'zeta', reaVersion: '0.51.0' }, registryPath);
    await registerProject(link, { name: 'zeta', reaVersion: '0.51.0' }, registryPath);
    // One entry, keyed on the realpath — not two.
    expect(Object.keys(loadRegistry(registryPath).projects)).toEqual([proj]);
  });
});

describe('reconcile', () => {
  it('classifies present / deregistered / missing', () => {
    const present = makeProject('present', true);
    const dereg = makeProject('dereg', false); // dir exists, no .rea/
    const gone = path.join(tmp, 'gone'); // never created

    const registry: Registry = {
      version: '1',
      projects: {
        [present]: { name: 'present', rea_version: '0.51.0', last_registered: 'x' },
        [dereg]: { name: 'dereg', rea_version: '0.51.0', last_registered: 'x' },
        [gone]: { name: 'gone', rea_version: '0.51.0', last_registered: 'x' },
      },
    };

    const results = reconcile(registry);
    const byPath = Object.fromEntries(results.map((r) => [r.path, r.state]));
    expect(byPath[present]).toBe('present');
    expect(byPath[dereg]).toBe('deregistered');
    expect(byPath[gone]).toBe('missing');
    // Never drops an entry.
    expect(results).toHaveLength(3);
    // Sorted by path for stable output.
    expect([...results].map((r) => r.path)).toEqual([...results].map((r) => r.path).sort());
  });
});

describe('pruneMissing', () => {
  it('drops only missing entries and persists the result', async () => {
    const present = makeProject('present');
    const gone = path.join(tmp, 'vanished');
    const registry: Registry = {
      version: '1',
      projects: {
        [present]: { name: 'present', rea_version: '0.51.0', last_registered: 'x' },
        [gone]: { name: 'vanished', rea_version: '0.51.0', last_registered: 'x' },
      },
    };
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n', 'utf8');

    const pruned = await pruneMissing(registryPath);
    expect(pruned).toEqual([gone]);
    const after = loadRegistry(registryPath);
    expect(Object.keys(after.projects)).toEqual([present]);
  });

  it('is a no-op (no write) when nothing is missing', async () => {
    const present = makeProject('present');
    await registerProject(present, { name: 'present', reaVersion: '0.51.0' }, registryPath);
    const before = fs.statSync(registryPath).mtimeMs;
    const pruned = await pruneMissing(registryPath);
    expect(pruned).toEqual([]);
    // File untouched.
    expect(fs.statSync(registryPath).mtimeMs).toBe(before);
  });
});
