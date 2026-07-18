/**
 * Unit tests for `rea dash`. Every project is a hand-built temp dir with a
 * hand-written `.rea/tasks.jsonl`; the registry uses the injectable
 * `registryPath` seam. `runDash({ json: true })` returns the stable machine
 * schema on stdout, which we capture and assert against — no reliance on the
 * real `~/.rea/` or `process.cwd()`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isOlderVersion, runDash, scanForProjects, type DashJson } from './dash.js';
import { getPkgVersion } from './utils.js';
import { registerProject, loadRegistry } from '../registry/projects.js';
import type { TaskRecord } from '../tasks/types.js';

let tmp: string;
let registryPath: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-dash-')));
  registryPath = path.join(tmp, 'home', '.rea', 'registry.json');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function task(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
  const now = '2026-07-17T00:00:00.000Z';
  return {
    id,
    subject: `subject ${id}`,
    status: 'pending',
    active: false,
    created_at: now,
    updated_at: now,
    ...over,
  };
}

/** Build a project dir with a `.rea/tasks.jsonl` from the given records. */
function makeProject(name: string, tasks: TaskRecord[], opts: { policyVisible?: boolean } = {}): string {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, '.rea'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.rea', 'tasks.jsonl'),
    tasks.map((t) => JSON.stringify(t)).join('\n') + (tasks.length > 0 ? '\n' : ''),
    'utf8',
  );
  if (opts.policyVisible === false) {
    fs.writeFileSync(
      path.join(dir, '.rea', 'policy.yaml'),
      'version: "1"\ndashboard_visible: false\n',
      'utf8',
    );
  }
  return fs.realpathSync(dir);
}

/** Capture stdout across a runDash invocation and parse the emitted JSON. */
async function runJson(opts: Parameters<typeof runDash>[0]): Promise<DashJson> {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
    chunks.push(String(c));
    return true;
  });
  const code = await runDash({ ...opts, json: true, registryPath });
  spy.mockRestore();
  expect(code).toBe(0);
  return JSON.parse(chunks.join('')) as DashJson;
}

describe('isOlderVersion', () => {
  it('compares dotted semver cores', () => {
    expect(isOlderVersion('0.50.0', '0.51.0')).toBe(true);
    expect(isOlderVersion('0.51.0', '0.51.0')).toBe(false);
    expect(isOlderVersion('1.0.0', '0.51.0')).toBe(false);
    expect(isOlderVersion('0.51.0', '0.51.1')).toBe(true);
  });
  it('is false on unparseable versions (never a false stale flag)', () => {
    expect(isOlderVersion('unknown', '0.51.0')).toBe(false);
    expect(isOlderVersion('0.51.0', 'nope')).toBe(false);
  });
});

describe('runDash classification', () => {
  it('sorts tasks into awaiting / review / in-flight groups, naming projects', async () => {
    // Freeze near the tasks' `updated_at` (helper default 2026-07-17) so the
    // completed task is inside the review window regardless of the wall clock.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T12:00:00.000Z'));
    const proj = makeProject('acme', [
      task('T-0001', { status: 'pending', blocked_by: ['T-9999'] }), // awaiting (blocked)
      task('T-0002', { status: 'pending', requires_spec: true }), // awaiting (spec gap)
      task('T-0003', { status: 'completed', evidence: ['x'] }), // review (recent)
      task('T-0004', { status: 'in_progress' }), // in flight
      task('T-0005', { status: 'pending' }), // plain backlog — no group
    ]);
    await registerProject(proj, { name: 'acme', reaVersion: '0.51.0' }, registryPath);

    const dash = await runJson({});
    expect(dash.groups.awaiting.map((i) => i.task_id).sort()).toEqual(['T-0001', 'T-0002']);
    expect(dash.groups.review_queue.map((i) => i.task_id)).toEqual(['T-0003']);
    expect(dash.groups.in_flight.map((i) => i.task_id)).toEqual(['T-0004']);
    for (const i of [...dash.groups.awaiting, ...dash.groups.review_queue, ...dash.groups.in_flight]) {
      expect(i.project).toBe('acme');
    }
  });

  it('classifies a project with nothing actionable as idle', async () => {
    const proj = makeProject('quiet', [task('T-0001', { status: 'pending' })]); // plain backlog
    await registerProject(proj, { name: 'quiet', reaVersion: '0.51.0' }, registryPath);
    const dash = await runJson({});
    expect(dash.groups.idle.map((p) => p.project)).toEqual(['quiet']);
    expect(dash.groups.awaiting).toHaveLength(0);
  });

  it('flags a legacy .reagent/ directory as health debt', async () => {
    const proj = makeProject('legacy', []);
    fs.mkdirSync(path.join(proj, '.reagent'), { recursive: true });
    await registerProject(proj, { name: 'legacy', reaVersion: '0.51.0' }, registryPath);
    const dash = await runJson({});
    const flags = dash.groups.health_flags.filter((h) => h.project === 'legacy');
    expect(flags.some((h) => h.flag === 'reagent_dir')).toBe(true);
    // A project with a health flag is NOT idle.
    expect(dash.groups.idle.map((p) => p.project)).not.toContain('legacy');
  });

  it('flags a stale rea_version', async () => {
    const proj = makeProject('stale', []);
    await registerProject(proj, { name: 'stale', reaVersion: '0.1.0' }, registryPath);
    const dash = await runJson({});
    expect(dash.groups.health_flags.some((h) => h.flag === 'stale_version')).toBe(true);
  });

  it('surfaces a vanished registered path as missing (never dropped)', async () => {
    const proj = makeProject('here', []);
    await registerProject(proj, { name: 'here', reaVersion: '0.51.0' }, registryPath);
    fs.rmSync(proj, { recursive: true, force: true });
    const dash = await runJson({});
    expect(dash.missing.map((m) => m.project)).toEqual(['here']);
  });

  it('surfaces a directory with no .rea/ as deregistered', async () => {
    const proj = makeProject('rm-rea', []);
    await registerProject(proj, { name: 'rm-rea', reaVersion: '0.51.0' }, registryPath);
    fs.rmSync(path.join(proj, '.rea'), { recursive: true, force: true });
    const dash = await runJson({});
    expect(dash.deregistered.map((d) => d.project)).toEqual(['rm-rea']);
    expect(dash.groups.health_flags.some((h) => h.flag === 'deregistered')).toBe(true);
  });
});

describe('runDash task-store isolation (F1)', () => {
  it('isolates an unreadable task store to that project and flags it (dash still renders)', async () => {
    const good = makeProject('good', [task('T-0001', { status: 'in_progress' })]);
    // Model "exists but can't be read": put a DIRECTORY where tasks.jsonl
    // should be, so `fs.readFileSync` throws EISDIR — a non-ENOENT read failure
    // that `readTasks` re-throws (portable, unlike relying on chmod 000 as root).
    const badDir = path.join(tmp, 'bad');
    fs.mkdirSync(path.join(badDir, '.rea', 'tasks.jsonl'), { recursive: true });
    const bad = fs.realpathSync(badDir);
    await registerProject(good, { name: 'good', reaVersion: '0.51.0' }, registryPath);
    await registerProject(bad, { name: 'bad', reaVersion: '0.51.0' }, registryPath);

    const dash = await runJson({});
    // The other project still renders — one bad store does not abort the view.
    expect(dash.groups.in_flight.map((i) => i.task_id)).toEqual(['T-0001']);
    // The bad project is surfaced as a per-project health flag, not fatal.
    expect(
      dash.groups.health_flags.some((h) => h.project === 'bad' && h.flag === 'tasks_unreadable'),
    ).toBe(true);
    // A flagged project is NOT reported as idle.
    expect(dash.groups.idle.map((p) => p.project)).not.toContain('bad');
  });
});

describe('readProjectVersion manifest precedence (F2)', () => {
  it('prefers the on-disk manifest over a stale registry version for a present project', async () => {
    const proj = makeProject('upgraded', []);
    // Registry lags a completed upgrade (best-effort registry write left it old)…
    await registerProject(proj, { name: 'upgraded', reaVersion: '0.1.0' }, registryPath);
    // …but the local install-manifest is already current → no stale flag.
    fs.writeFileSync(
      path.join(proj, '.rea', 'install-manifest.json'),
      JSON.stringify({ version: getPkgVersion() }),
      'utf8',
    );
    const dash = await runJson({});
    expect(
      dash.groups.health_flags.some(
        (h) => h.project === 'upgraded' && h.flag === 'stale_version',
      ),
    ).toBe(false);
    // Manifest current + no tasks → the project reads as idle, not flagged.
    expect(dash.groups.idle.map((p) => p.project)).toContain('upgraded');
  });

  it('still flags stale_version when the on-disk manifest itself is old', async () => {
    const proj = makeProject('reallystale', []);
    await registerProject(proj, { name: 'reallystale', reaVersion: '0.51.0' }, registryPath);
    fs.writeFileSync(
      path.join(proj, '.rea', 'install-manifest.json'),
      JSON.stringify({ version: '0.1.0' }),
      'utf8',
    );
    const dash = await runJson({});
    expect(
      dash.groups.health_flags.some(
        (h) => h.project === 'reallystale' && h.flag === 'stale_version',
      ),
    ).toBe(true);
  });

  it('uses the registry version for a project missing on disk (no manifest to read)', async () => {
    const proj = makeProject('vanished', []);
    await registerProject(proj, { name: 'vanished', reaVersion: '0.42.0' }, registryPath);
    fs.rmSync(proj, { recursive: true, force: true });
    const dash = await runJson({});
    expect(dash.missing.map((m) => ({ project: m.project, rea_version: m.rea_version }))).toEqual([
      { project: 'vanished', rea_version: '0.42.0' },
    ]);
  });
});

describe('runDash --rescan', () => {
  it('registers nested projects under home but NOT the home dir itself (round-38 P2)', async () => {
    // The test `registryPath` is `<tmp>/home/.rea/registry.json`, so `<tmp>/home`
    // IS the user-global home whose `~/.rea` holds the registry. A machine that
    // has run `rea init` has that `~/.rea` present; a rescan over home must NOT
    // register the home dir itself as a bogus project, while a real nested
    // project (`~/code/proj`) IS registered.
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.rea'), { recursive: true });
    const proj = path.join(home, 'code', 'proj');
    fs.mkdirSync(path.join(proj, '.rea'), { recursive: true });

    // The home's `~/.rea/tasks.jsonl` must never be read as a repo task store.
    const homeTasks = path.join(home, '.rea', 'tasks.jsonl');
    const readSpy = vi.spyOn(fs, 'readFileSync');

    const code = await runDash({ rescan: true, scanRoots: [home], registryPath });
    expect(code).toBe(0);

    const projects = Object.keys(loadRegistry(registryPath).projects);
    expect(projects).toContain(path.resolve(proj));
    expect(projects).not.toContain(path.resolve(home));

    expect(readSpy.mock.calls.some((c) => String(c[0]) === homeTasks)).toBe(false);
    readSpy.mockRestore();
  });
});

describe('runDash review-queue ageing', () => {
  // Frozen instant all cases are classified against (threaded via generated_at).
  const NOW = '2026-07-18T00:00:00.000Z';

  it('drops OLD completed tasks so the project returns to idle/healthy', async () => {
    // Only terminal history, all beyond the 7-day window → nothing needs you.
    const proj = makeProject('shipped', [
      task('T-0001', {
        status: 'completed',
        evidence: ['x'],
        updated_at: '2026-07-01T00:00:00.000Z', // 17 days old
      }),
      task('T-0002', {
        status: 'completed',
        evidence: ['y'],
        updated_at: '2026-07-10T00:00:00.000Z', // 8 days old — just outside
      }),
    ]);
    await registerProject(proj, { name: 'shipped', reaVersion: '0.51.0' }, registryPath);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const dash = await runJson({});

    expect(dash.groups.review_queue).toHaveLength(0);
    expect(dash.groups.idle.map((p) => p.project)).toEqual(['shipped']);
  });

  it('keeps a RECENTLY completed task in the review queue', async () => {
    const proj = makeProject('fresh', [
      task('T-0001', {
        status: 'completed',
        evidence: ['x'],
        updated_at: '2026-07-17T00:00:00.000Z', // 1 day old — inside the window
      }),
    ]);
    await registerProject(proj, { name: 'fresh', reaVersion: '0.51.0' }, registryPath);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const dash = await runJson({});

    expect(dash.groups.review_queue.map((i) => i.task_id)).toEqual(['T-0001']);
    // A project with a live review item is NOT idle.
    expect(dash.groups.idle.map((p) => p.project)).not.toContain('fresh');
  });

  it('never surfaces a cancelled task in review, even a fresh one', async () => {
    const proj = makeProject('abandoned', [
      task('T-0001', {
        status: 'cancelled',
        updated_at: '2026-07-17T23:00:00.000Z', // fresh but terminal-abandoned
      }),
    ]);
    await registerProject(proj, { name: 'abandoned', reaVersion: '0.51.0' }, registryPath);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    const dash = await runJson({});

    expect(dash.groups.review_queue).toHaveLength(0);
    // Cancelled is neither review nor in-flight, so the project reads as idle.
    expect(dash.groups.idle.map((p) => p.project)).toEqual(['abandoned']);
  });
});

describe('runDash visibility', () => {
  it('withholds task titles for a policy-hidden project (opaque count)', async () => {
    // Completed task must stay recent so the opaque count is a stable 2.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-17T12:00:00.000Z'));
    const proj = makeProject(
      'secret',
      [task('T-0001', { status: 'completed', evidence: ['x'] }), task('T-0002', { status: 'in_progress' })],
      { policyVisible: false },
    );
    await registerProject(proj, { name: 'secret', reaVersion: '0.51.0' }, registryPath);
    const dash = await runJson({});
    expect(dash.groups.review_queue).toHaveLength(0);
    expect(dash.groups.in_flight).toHaveLength(0);
    expect(dash.hidden).toEqual([{ project: 'secret', project_path: proj, item_count: 2 }]);
  });

  it('withholds when the registry entry sets dashboard_visible:false', async () => {
    const proj = makeProject('reg-hidden', [task('T-0001', { status: 'in_progress' })]);
    await registerProject(proj, { name: 'reg-hidden', reaVersion: '0.51.0' }, registryPath);
    const reg = loadRegistry(registryPath);
    reg.projects[proj]!.dashboard_visible = false;
    fs.writeFileSync(registryPath, JSON.stringify(reg, null, 2) + '\n', 'utf8');

    const dash = await runJson({});
    expect(dash.hidden.map((h) => h.project)).toEqual(['reg-hidden']);
    expect(dash.groups.in_flight).toHaveLength(0);
  });

  it('--all reveals titles for a hidden present project', async () => {
    const proj = makeProject('secret', [task('T-0001', { status: 'in_progress' })], {
      policyVisible: false,
    });
    await registerProject(proj, { name: 'secret', reaVersion: '0.51.0' }, registryPath);
    const dash = await runJson({ all: true });
    expect(dash.hidden).toHaveLength(0);
    expect(dash.groups.in_flight.map((i) => i.task_id)).toEqual(['T-0001']);
  });
});

describe('runDash quiet + json shape', () => {
  it('renders a quiet system in a few calm lines (no attention items)', async () => {
    const proj = makeProject('calm', []);
    await registerProject(proj, { name: 'calm', reaVersion: '0.51.0' }, registryPath);
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => {
      logs.push(String(m));
    });
    const code = await runDash({ registryPath });
    logSpy.mockRestore();
    expect(code).toBe(0);
    // Idle project, no attention groups → short output.
    expect(logs.length).toBeLessThanOrEqual(4);
    expect(logs.join('\n')).toContain('calm');
  });

  it('emits the full stable schema keys even when empty', async () => {
    const dash = await runJson({});
    expect(dash.version).toBe('1');
    expect(dash.mode).toBe('global');
    expect(Object.keys(dash.groups).sort()).toEqual([
      'awaiting',
      'health_flags',
      'idle',
      'in_flight',
      'review_queue',
    ]);
    expect(dash).toHaveProperty('hidden');
    expect(dash).toHaveProperty('missing');
    expect(dash).toHaveProperty('deregistered');
  });
});

describe('runDash per-repo mode', () => {
  it('reports a single project without needing a registry entry', async () => {
    const proj = makeProject('solo', [task('T-0001', { status: 'in_progress' })]);
    const dash = await runJson({ path: proj });
    expect(dash.mode).toBe('repo');
    expect(dash.groups.in_flight.map((i) => i.task_id)).toEqual(['T-0001']);
  });
});

describe('scanForProjects', () => {
  it('discovers .rea/ project roots and skips node_modules', () => {
    const a = makeProject('svc-a', []);
    makeProject('svc-b', []);
    // A .rea/ buried in node_modules must be ignored.
    const nm = path.join(tmp, 'svc-a', 'node_modules', 'pkg');
    fs.mkdirSync(path.join(nm, '.rea'), { recursive: true });

    const found = scanForProjects([tmp]);
    expect(found).toContain(a);
    expect(found).toContain(path.join(tmp, 'svc-b'));
    expect(found).not.toContain(nm);
  });

  it('discovers a project under a HIDDEN parent dir (round-25 P2)', () => {
    // A rea project nested under `.worktrees/` (the common linked-worktree
    // layout) must still be found — the rescan no longer blanket-skips dotdirs.
    const wt = path.join(tmp, '.worktrees', 'stream-1');
    fs.mkdirSync(path.join(wt, '.rea'), { recursive: true });
    // …but a heavy hidden tree (SCAN_SKIP_DIRS) is still pruned.
    fs.mkdirSync(path.join(tmp, '.venv', 'proj', '.rea'), { recursive: true });

    const found = scanForProjects([tmp]);
    expect(found).toContain(path.resolve(wt));
    expect(found).not.toContain(path.join(tmp, '.venv', 'proj'));
  });

  it('excludes the user-global ~/.rea marker but keeps nested projects (round-38 P2)', () => {
    // Simulate a home dir that has run `rea init`: `~/.rea` is the registry /
    // global-state home (NOT a project), while `~/code/proj` is a real project.
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(home, '.rea'), { recursive: true });
    fs.writeFileSync(path.join(home, '.rea', 'registry.json'), '{"projects":{}}\n', 'utf8');
    const proj = path.join(home, 'code', 'proj');
    fs.mkdirSync(path.join(proj, '.rea'), { recursive: true });

    const found = scanForProjects([home], path.join(home, '.rea'));
    expect(found).toContain(path.resolve(proj));
    expect(found).not.toContain(path.resolve(home));

    // Without the exclusion the HOME dir WOULD be registered — proves the guard
    // is what suppresses the bogus entry, not some other filter.
    const unguarded = scanForProjects([home]);
    expect(unguarded).toContain(path.resolve(home));
  });
});
