/**
 * Unit tests for `rea serve` breadcrumb race safety (G5 blocker fix #2).
 *
 * Two overlapping `rea serve` invocations share the same `.rea/serve.pid` and
 * `.rea/serve.state.json`. Without ownership-aware cleanup, the first
 * instance's SIGTERM path would unlink breadcrumbs that a later instance had
 * just written, blinding `rea status` to the live gateway.
 *
 * These tests exercise the exported `__TEST_INTERNALS` helpers directly,
 * which is the cleanest boundary — starting two real MCP gateways in a unit
 * test would be heavy and flaky.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { __TEST_INTERNALS } from './serve.js';

const { writeFileAtomic, writePidfile, writeStateFile, cleanupPidIfOwned, cleanupStateIfOwned } =
  __TEST_INTERNALS;

describe('serve — writeFileAtomic', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rea-serve-atomic-'));
  });

  afterEach(async () => {
    await fsp.rm(baseDir, { recursive: true, force: true });
  });

  it('writes the target file with the expected contents', () => {
    const target = path.join(baseDir, 'file.txt');
    writeFileAtomic(target, 'hello\n');
    expect(fs.readFileSync(target, 'utf8')).toBe('hello\n');
  });

  it('leaves no temp files behind after a successful write', () => {
    const target = path.join(baseDir, 'file.txt');
    writeFileAtomic(target, 'x');
    const entries = fs.readdirSync(baseDir);
    // Every leftover temp file matches the `.<base>.<pid>.<ns>.tmp` pattern.
    const leaks = entries.filter((name) => /^\.file\.txt\.\d+\.\d+\.tmp$/.test(name));
    expect(leaks).toEqual([]);
  });

  it('overwrites an existing file atomically', () => {
    const target = path.join(baseDir, 'file.txt');
    writeFileAtomic(target, 'v1');
    writeFileAtomic(target, 'v2');
    expect(fs.readFileSync(target, 'utf8')).toBe('v2');
  });

  it('writes with permission mode 0o600 (owner read/write only)', () => {
    const target = path.join(baseDir, 'secrets.txt');
    writeFileAtomic(target, 'creds');
    const stat = fs.statSync(target);
    // Mask off file-type bits to get permission bits only.
    const perm = stat.mode & 0o777;
    expect(perm).toBe(0o600);
  });
});

describe('serve — cleanupPidIfOwned', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rea-serve-pid-'));
    await fsp.mkdir(path.join(baseDir, '.rea'), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(baseDir, { recursive: true, force: true });
  });

  it('unlinks the pidfile when it carries the current process pid', () => {
    const pidPath = writePidfile(baseDir);
    expect(fs.existsSync(pidPath)).toBe(true);
    cleanupPidIfOwned(pidPath);
    expect(fs.existsSync(pidPath)).toBe(false);
  });

  it('leaves the pidfile alone when a sibling has rewritten it with a different pid', () => {
    // Simulate: we wrote our pid, then a sibling overwrote with their own.
    // On our SIGTERM we must NOT unlink — the sibling's `rea status` users
    // should still see "running".
    const pidPath = writePidfile(baseDir);
    const siblingPid = process.pid + 1; // arbitrary different value
    fs.writeFileSync(pidPath, String(siblingPid), 'utf8');
    cleanupPidIfOwned(pidPath);
    expect(fs.existsSync(pidPath)).toBe(true);
    expect(fs.readFileSync(pidPath, 'utf8').trim()).toBe(String(siblingPid));
  });

  it('treats a malformed pidfile as "not mine" and leaves it alone', () => {
    const pidPath = path.join(baseDir, '.rea', 'serve.pid');
    fs.writeFileSync(pidPath, 'not-a-number\n', 'utf8');
    cleanupPidIfOwned(pidPath);
    expect(fs.existsSync(pidPath)).toBe(true);
  });

  it('is a no-op when the pidfile is missing', () => {
    const pidPath = path.join(baseDir, '.rea', 'serve.pid');
    expect(() => cleanupPidIfOwned(pidPath)).not.toThrow();
  });
});

describe('serve — cleanupStateIfOwned', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rea-serve-state-'));
    await fsp.mkdir(path.join(baseDir, '.rea'), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(baseDir, { recursive: true, force: true });
  });

  it('unlinks the state file when session_id matches', () => {
    const statePath = writeStateFile(baseDir, {
      session_id: 'sess-a',
      started_at: '2026-04-18T12:00:00Z',
      metrics_port: null,
    });
    cleanupStateIfOwned(statePath, 'sess-a');
    expect(fs.existsSync(statePath)).toBe(false);
  });

  it('leaves the state file alone when a sibling session has rewritten it', () => {
    // Instance A writes session_id=sess-a, instance B overwrites with sess-b.
    // Instance A's SIGTERM path must NOT unlink — `rea status` should still
    // surface B's session.
    const statePath = writeStateFile(baseDir, {
      session_id: 'sess-a',
      started_at: '2026-04-18T12:00:00Z',
      metrics_port: null,
    });
    // Overwrite atomically, as the serve-entry code does.
    writeFileAtomic(
      statePath,
      JSON.stringify({
        session_id: 'sess-b',
        started_at: '2026-04-18T12:00:05Z',
        metrics_port: 9464,
      }) + '\n',
    );

    cleanupStateIfOwned(statePath, 'sess-a');
    expect(fs.existsSync(statePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as { session_id: string };
    expect(parsed.session_id).toBe('sess-b');
  });

  it('treats a corrupt state file as "not mine" and leaves it alone', () => {
    const statePath = path.join(baseDir, '.rea', 'serve.state.json');
    fs.writeFileSync(statePath, '{ not: valid json', 'utf8');
    cleanupStateIfOwned(statePath, 'sess-a');
    expect(fs.existsSync(statePath)).toBe(true);
  });

  it('is a no-op when the state file is missing', () => {
    const statePath = path.join(baseDir, '.rea', 'serve.state.json');
    expect(() => cleanupStateIfOwned(statePath, 'sess-a')).not.toThrow();
  });
});

describe('serve — overlapping instance race (integration of the helpers)', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'rea-serve-race-'));
    await fsp.mkdir(path.join(baseDir, '.rea'), { recursive: true });
  });

  afterEach(async () => {
    await fsp.rm(baseDir, { recursive: true, force: true });
  });

  it("instance A's shutdown does NOT blow away instance B's breadcrumbs", () => {
    // Step 1: Instance A starts — pid=process.pid, session=sess-a.
    const pidPath = writePidfile(baseDir);
    const statePath = writeStateFile(baseDir, {
      session_id: 'sess-a',
      started_at: '2026-04-18T12:00:00Z',
      metrics_port: null,
    });

    // Step 2: Instance B races in and overwrites both breadcrumbs.
    //   - A different pid to simulate the sibling
    //   - A different session id
    const bPid = process.pid + 77; // must be a process we aren't currently
    fs.writeFileSync(pidPath, String(bPid), 'utf8');
    writeFileAtomic(
      statePath,
      JSON.stringify({
        session_id: 'sess-b',
        started_at: '2026-04-18T12:00:05Z',
        metrics_port: 9464,
      }) + '\n',
    );

    // Step 3: Instance A receives SIGTERM and runs ownership-aware cleanup.
    cleanupPidIfOwned(pidPath);
    cleanupStateIfOwned(statePath, 'sess-a');

    // Step 4: Instance B's breadcrumbs must survive.
    expect(fs.existsSync(pidPath)).toBe(true);
    expect(fs.readFileSync(pidPath, 'utf8').trim()).toBe(String(bPid));
    expect(fs.existsSync(statePath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      session_id: string;
      metrics_port: number | null;
    };
    expect(parsed.session_id).toBe('sess-b');
    expect(parsed.metrics_port).toBe(9464);
  });
});
