/**
 * Unit tests for the `rea dash --emit-moc` vault-MOC renderer (spec §4).
 *
 * The renderer is a pure `DashJson -> string`, so most tests build a synthetic
 * aggregated model directly and assert on the markdown. A second block drives
 * the model through `runDash` to prove the write-to-path path lands a file and
 * that emitting the MOC never mutates a project's `.rea/tasks.jsonl` (spec §5)
 * and honors the sensitive-project rule end-to-end (spec §6).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderMoc, mdInline } from './dash-moc.js';
import { runDash, type DashJson } from './dash.js';
import { registerProject } from '../registry/projects.js';
import type { TaskRecord } from '../tasks/types.js';

// ---------------------------------------------------------------------------
// Synthetic model builder
// ---------------------------------------------------------------------------

function model(over: Partial<DashJson> = {}): DashJson {
  return {
    version: '1',
    generated_at: '2026-07-18T00:00:00.000Z',
    mode: 'global',
    groups: { awaiting: [], review_queue: [], in_flight: [], health_flags: [], idle: [] },
    hidden: [],
    missing: [],
    deregistered: [],
    ...over,
  };
}

describe('renderMoc', () => {
  it('renders each non-sensitive project with its needs-you / active / blocked rollup', () => {
    const md = renderMoc(
      model({
        groups: {
          awaiting: [
            {
              project: 'acme',
              project_path: '/p/acme',
              task_id: 'T-0001',
              subject: 'ratify the spec',
              status: 'pending',
            },
          ],
          review_queue: [
            {
              project: 'acme',
              project_path: '/p/acme',
              task_id: 'T-0003',
              subject: 'sign off feature',
              status: 'completed',
            },
          ],
          in_flight: [
            {
              project: 'beta',
              project_path: '/p/beta',
              task_id: 'T-0004',
              subject: 'building the thing',
              status: 'in_progress',
            },
          ],
          health_flags: [
            {
              project: 'beta',
              project_path: '/p/beta',
              flag: 'reagent_dir',
              detail: 'legacy .reagent/ present — migration debt',
            },
          ],
          idle: [{ project: 'quiet', project_path: '/p/quiet', rea_version: '0.51.0' }],
        },
      }),
    );

    expect(md).toContain('## Awaiting ratification / parked blockers');
    expect(md).toContain('**[acme]** `T-0001` — ratify the spec');
    expect(md).toContain('## Review queue');
    expect(md).toContain('**[acme]** `T-0003` — sign off feature');
    expect(md).toContain('## In flight');
    expect(md).toContain('**[beta]** `T-0004` — building the thing');
    expect(md).toContain('## Health flags');
    expect(md).toContain('legacy .reagent/ present');
    expect(md).toContain('## Idle / healthy');
    expect(md).toContain('**[quiet]**');
    // Generated marker so the file is not hand-edited.
    expect(md).toMatch(/^---\n[\s\S]*do_not_edit: true/);
    expect(md).toContain('Do not hand-edit');
  });

  it('renders a sensitive project as an opaque count, never its task titles', () => {
    const md = renderMoc(
      model({
        hidden: [{ project: 'legal-vault', project_path: '/p/legal', item_count: 3 }],
      }),
    );
    expect(md).toContain('## Hidden projects');
    expect(md).toContain('**[legal-vault]** 3 items, hidden');
    // No title text can appear — the model carries only the count.
    expect(md).not.toContain('T-0');
  });

  it('is deterministic across two renders of the same model', () => {
    const m = model({
      groups: {
        awaiting: [
          {
            project: 'acme',
            project_path: '/p/acme',
            task_id: 'T-0001',
            subject: 'ratify the spec',
            status: 'pending',
          },
        ],
        review_queue: [],
        in_flight: [],
        health_flags: [],
        idle: [{ project: 'quiet', project_path: '/p/quiet', rea_version: '0.51.0' }],
      },
    });
    expect(renderMoc(m)).toBe(renderMoc(m));
  });

  it('renders a quiet system as a short calm block', () => {
    const md = renderMoc(
      model({ groups: { awaiting: [], review_queue: [], in_flight: [], health_flags: [], idle: [
        { project: 'calm', project_path: '/p/calm', rea_version: '0.51.0' },
      ] } }),
    );
    expect(md).toContain('All clear — 1 project idle.');
  });

  it('neutralizes wikilink / code-span injection from disk-sourced subjects', () => {
    expect(mdInline('[[evil embed]]')).toBe('[ [evil embed] ]');
    expect(mdInline('has `backticks`')).toBe('has \\`backticks\\`');
    expect(mdInline('a | b')).toBe('a \\| b');
    const md = renderMoc(
      model({
        groups: {
          awaiting: [],
          review_queue: [],
          in_flight: [
            {
              project: 'p',
              project_path: '/p',
              task_id: 'T-1',
              subject: '[[secret note]]',
              status: 'in_progress',
            },
          ],
          health_flags: [],
          idle: [],
        },
      }),
    );
    expect(md).not.toContain('[[secret note]]');
    expect(md).toContain('[ [secret note] ]');
  });
});

// ---------------------------------------------------------------------------
// End-to-end through runDash (write-to-path + read-only guarantee)
// ---------------------------------------------------------------------------

let tmp: string;
let registryPath: string;

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-dash-moc-')));
  registryPath = path.join(tmp, 'home', '.rea', 'registry.json');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function task(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
  const now = '2026-07-18T00:00:00.000Z';
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

describe('runDash --emit-moc', () => {
  it('writes the MOC to a given path and never mutates the task artifact', async () => {
    const proj = makeProject('acme', [task('T-0001', { status: 'in_progress' })]);
    await registerProject(proj, { name: 'acme', reaVersion: '0.51.0' }, registryPath);

    const tasksPath = path.join(proj, '.rea', 'tasks.jsonl');
    const before = fs.readFileSync(tasksPath, 'utf8');
    const beforeMtime = fs.statSync(tasksPath).mtimeMs;

    const out = path.join(tmp, 'Morning View.md');
    const code = await runDash({ registryPath, emitMoc: true, mocPath: out });
    expect(code).toBe(0);

    const md = fs.readFileSync(out, 'utf8');
    expect(md).toContain('# Morning View');
    expect(md).toContain('**[acme]** `T-0001`');

    // Read-only over task artifacts (spec §5).
    expect(fs.readFileSync(tasksPath, 'utf8')).toBe(before);
    expect(fs.statSync(tasksPath).mtimeMs).toBe(beforeMtime);
  });

  it('emits to stdout when no path is given', async () => {
    const proj = makeProject('acme', [task('T-0001', { status: 'in_progress' })]);
    await registerProject(proj, { name: 'acme', reaVersion: '0.51.0' }, registryPath);

    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      chunks.push(String(c));
      return true;
    });
    const code = await runDash({ registryPath, emitMoc: true });
    spy.mockRestore();
    expect(code).toBe(0);
    expect(chunks.join('')).toContain('# Morning View');
  });

  it('does NOT prepend the --prune log to stdout under --emit-moc (round-26 P2)', async () => {
    const present = makeProject('acme', [task('T-0001', { status: 'in_progress' })]);
    await registerProject(present, { name: 'acme', reaVersion: '0.51.0' }, registryPath);
    // A registered-but-now-missing project so --prune actually drops one.
    const gone = makeProject('gone', []);
    await registerProject(gone, { name: 'gone', reaVersion: '0.51.0' }, registryPath);
    fs.rmSync(gone, { recursive: true, force: true });

    const chunks: string[] = [];
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      chunks.push(String(c));
      return true;
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      chunks.push(a.map(String).join(' '));
    });
    const code = await runDash({ registryPath, emitMoc: true, prune: true });
    outSpy.mockRestore();
    logSpy.mockRestore();
    expect(code).toBe(0);
    const out = chunks.join('\n');
    expect(out).toContain('# Morning View'); // MOC still emitted
    expect(out).not.toMatch(/Pruned/); // …with no log line corrupting the vault file
  });

  it('errors cleanly when the target parent directory does not exist', async () => {
    const proj = makeProject('acme', [task('T-0001', { status: 'in_progress' })]);
    await registerProject(proj, { name: 'acme', reaVersion: '0.51.0' }, registryPath);

    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = path.join(tmp, 'no-such-dir', 'Morning View.md');
    const code = await runDash({ registryPath, emitMoc: true, mocPath: out });
    errSpy.mockRestore();
    expect(code).toBe(1);
    expect(fs.existsSync(out)).toBe(false);
  });

  it('honors sensitive-project visibility end-to-end (opaque count, no titles)', async () => {
    const proj = makeProject(
      'secret',
      [task('T-0001', { status: 'in_progress' }), task('T-0002', { status: 'completed', evidence: ['x'] })],
      { policyVisible: false },
    );
    await registerProject(proj, { name: 'secret', reaVersion: '0.51.0' }, registryPath);

    const out = path.join(tmp, 'MV.md');
    await runDash({ registryPath, emitMoc: true, mocPath: out });
    const md = fs.readFileSync(out, 'utf8');

    expect(md).toContain('**[secret]** 2 items, hidden');
    expect(md).not.toContain('subject T-0001');
    expect(md).not.toContain('T-0001');
    expect(md).not.toContain('T-0002');
  });

  it('produces a byte-identical file on re-emit (diff-friendly overwrite-in-place)', async () => {
    const proj = makeProject('acme', [task('T-0001', { status: 'in_progress' })]);
    await registerProject(proj, { name: 'acme', reaVersion: '0.51.0' }, registryPath);

    // Freeze the clock so generated_at (the only ambient input) is stable.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-18T12:00:00.000Z'));
    const out = path.join(tmp, 'MV.md');
    await runDash({ registryPath, emitMoc: true, mocPath: out });
    const first = fs.readFileSync(out, 'utf8');
    await runDash({ registryPath, emitMoc: true, mocPath: out });
    const second = fs.readFileSync(out, 'utf8');
    vi.useRealTimers();

    expect(second).toBe(first);
  });
});
