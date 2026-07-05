/**
 * Hermetic tests for `rea trust` / `untrust` / `trust --list`.
 *
 * Every run injects a temp `home` (and, where a project path matters, an
 * explicit `path`/`cwd`) so the real `~/.rea/` is never touched.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readRegistry, registryPath, reaDir, type ProcReader } from './global-cli.js';
import { runTrust, runTrustList, runUntrust } from './trust.js';

// Injected ancestry readers: the REAL test-runner ancestry contains `claude`,
// so happy-path runs pass a benign reader; the bypass test injects a claude one.
const noClaude: ProcReader = () => null;
const claudeAncestor: ProcReader = () => ({ ppid: 1, comm: '/usr/local/bin/claude' });

let home: string;
let proj: string;
let logs: string[];
let errs: string[];
let outs: string[];
let savedCpd: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-trust-home-'));
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-trust-proj-'));
  logs = [];
  errs = [];
  outs = [];
  // Hermetic against the governed-session guard: the mutating commands refuse
  // when CLAUDE_PROJECT_DIR is set. Clear it so happy-path tests run "as a
  // human"; the governed tests set it explicitly.
  savedCpd = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    outs.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedCpd === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = savedCpd;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

describe('runTrust', () => {
  it('trusts a project: exit 0, prints [rea] Trusted, writes the realpath', () => {
    const code = runTrust({ procReader: noClaude, path: proj, home, cwd: proj });
    expect(code).toBe(0);
    expect(logs).toContain(`[rea] Trusted: ${fs.realpathSync(proj)}`);
    expect(readRegistry(home)).toEqual([fs.realpathSync(proj)]);
  });

  it('defaults the path to cwd when no arg is given', () => {
    const code = runTrust({ procReader: noClaude, home, cwd: proj });
    expect(code).toBe(0);
    expect(readRegistry(home)).toEqual([fs.realpathSync(proj)]);
  });

  it('is idempotent: second trust prints "Already trusted" and leaves bytes identical', () => {
    runTrust({ procReader: noClaude, path: proj, home, cwd: proj });
    const before = fs.readFileSync(registryPath(home));
    const code = runTrust({ procReader: noClaude, path: proj, home, cwd: proj });
    expect(code).toBe(0);
    expect(logs.some((l) => l === `[rea] Already trusted: ${fs.realpathSync(proj)}`)).toBe(true);
    const after = fs.readFileSync(registryPath(home));
    expect(after.equals(before)).toBe(true);
  });

  it('exit 2 with "path does not exist" for a nonexistent path', () => {
    const missing = path.join(proj, 'nope');
    const code = runTrust({ procReader: noClaude, path: missing, home, cwd: proj });
    expect(code).toBe(2);
    expect(errs.some((e) => e.includes(`path does not exist: ${missing}`))).toBe(true);
  });

  it('exit 2 with "not a directory" for a file path', () => {
    const file = path.join(proj, 'a-file');
    fs.writeFileSync(file, 'x', 'utf8');
    const code = runTrust({ procReader: noClaude, path: file, home, cwd: proj });
    expect(code).toBe(2);
    expect(errs.some((e) => e.includes(`not a directory: ${file}`))).toBe(true);
  });

  // P3 (codex): a project path whose realpath contains a control char (\r)
  // must be REFUSED (exit 2) BEFORE any success — writeRegistry would silently
  // drop it as malformed, so a "Trusted:" without persistence would be a lie.
  it.skipIf(process.platform === 'win32')(
    'exit 2, no "Trusted:", registry unchanged for a path containing a carriage return',
    () => {
      const crDir = path.join(proj, 'has\rcr');
      fs.mkdirSync(crDir);
      const code = runTrust({ procReader: noClaude, path: crDir, home, cwd: proj });
      expect(code).toBe(2);
      expect(errs.some((e) => e.includes('invalid path: contains control characters'))).toBe(true);
      expect(logs.some((l) => l.startsWith('[rea] Trusted:'))).toBe(false);
      // Nothing persisted — the registry file was never created.
      expect(fs.existsSync(registryPath(home))).toBe(false);
      expect(readRegistry(home)).toEqual([]);
    },
  );

  it('exit 1 with remediation when <home>/.rea is world-writable', () => {
    if (typeof process.getuid !== 'function') return; // POSIX-only
    fs.mkdirSync(reaDir(home), { recursive: true });
    fs.chmodSync(reaDir(home), 0o777);
    const code = runTrust({ procReader: noClaude, path: proj, home, cwd: proj });
    expect(code).toBe(1);
    expect(errs.some((e) => e.includes(`chmod 700 ${reaDir(home)}`))).toBe(true);
  });

  it('refuses under a governed agent session (CLAUDE_PROJECT_DIR set): exit 1, no write', () => {
    process.env.CLAUDE_PROJECT_DIR = '/some/agent/project';
    const code = runTrust({ procReader: noClaude, path: proj, home, cwd: proj });
    expect(code).toBe(1);
    expect(errs.some((e) => e.includes('This is a human action'))).toBe(true);
    expect(errs.some((e) => e.includes(reaDir(home)))).toBe(true);
    // No FS mutation: the registry file was never created.
    expect(fs.existsSync(registryPath(home))).toBe(false);
  });

  it('refuses the CLAUDE_PROJECT_DIR bypass: unset var BUT a claude ancestor → exit 1, no write', () => {
    // The exact bypass codex found: `CLAUDE_PROJECT_DIR= rea trust` clears the
    // var in the child, but a subprocess cannot clear its own ancestry.
    delete process.env.CLAUDE_PROJECT_DIR;
    const code = runTrust({ procReader: claudeAncestor, path: proj, home, cwd: proj });
    expect(code).toBe(1);
    expect(errs.some((e) => e.includes('a Claude Code process is an ancestor'))).toBe(true);
    expect(fs.existsSync(registryPath(home))).toBe(false);
  });

  // P2 (codex): an unsafe `trusted-projects` file must be REFUSED (exit 1)
  // BEFORE readRegistry reads through the tampered path. A symlink is the
  // clearest, most portable tamper primitive.
  it.skipIf(process.platform === 'win32')(
    'exit 1, no read-through / no clobber when the registry file is a symlink',
    () => {
      // Point the registry at an attacker-controlled file outside the root.
      const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-trust-decoy-'));
      const decoyReg = path.join(decoy, 'decoy-registry');
      fs.writeFileSync(decoyReg, `${fs.realpathSync(decoy)}\n`, 'utf8');
      try {
        fs.mkdirSync(reaDir(home), { recursive: true });
        fs.symlinkSync(decoyReg, registryPath(home));
        const code = runTrust({ procReader: noClaude, path: proj, home, cwd: proj });
        expect(code).toBe(1);
        expect(errs.some((e) => e.includes('is a symlink'))).toBe(true);
        // The symlink was NOT replaced (no atomic-rename clobber) and the decoy
        // was NOT read-through / rewritten with the new project.
        expect(fs.lstatSync(registryPath(home)).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(decoyReg, 'utf8')).toBe(`${fs.realpathSync(decoy)}\n`);
      } finally {
        fs.rmSync(decoy, { recursive: true, force: true });
      }
    },
  );

  // Bad-mode (0644) registry: group/other-accessible → refuse before read.
  it('exit 1 with remediation when the registry file is mode 0644', () => {
    if (typeof process.getuid !== 'function') return; // POSIX-only
    runTrust({ procReader: noClaude, path: proj, home, cwd: proj }); // seed a 0600 file
    const proj2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-trust-proj2-'));
    try {
      fs.chmodSync(registryPath(home), 0o644);
      const before = fs.readFileSync(registryPath(home));
      const code = runTrust({ procReader: noClaude, path: proj2, home, cwd: proj2 });
      expect(code).toBe(1);
      expect(errs.some((e) => e.includes('chmod 600'))).toBe(true);
      // No mutation: proj2 was NOT appended.
      expect(fs.readFileSync(registryPath(home)).equals(before)).toBe(true);
    } finally {
      fs.rmSync(proj2, { recursive: true, force: true });
    }
  });

  // Regression guard: the new registry-safety gate must NOT break the
  // first-trust bootstrap — an ABSENT registry is safe and must still write.
  it('still bootstraps first-trust when the registry is absent (guard allows absent)', () => {
    expect(fs.existsSync(registryPath(home))).toBe(false);
    const code = runTrust({ procReader: noClaude, path: proj, home, cwd: proj });
    expect(code).toBe(0);
    expect(fs.existsSync(registryPath(home))).toBe(true);
    expect(readRegistry(home)).toEqual([fs.realpathSync(proj)]);
  });
});

describe('runUntrust', () => {
  it('removes a trusted project: exit 0, prints [rea] Untrusted', () => {
    runTrust({ procReader: noClaude, path: proj, home, cwd: proj });
    const code = runUntrust({ procReader: noClaude, path: proj, home, cwd: proj });
    expect(code).toBe(0);
    expect(logs.some((l) => l === `[rea] Untrusted: ${fs.realpathSync(proj)}`)).toBe(true);
  });

  it('deletes the registry file when the last entry is removed', () => {
    runTrust({ procReader: noClaude, path: proj, home, cwd: proj });
    expect(fs.existsSync(registryPath(home))).toBe(true);
    const code = runUntrust({ procReader: noClaude, path: proj, home, cwd: proj });
    expect(code).toBe(0);
    expect(fs.existsSync(registryPath(home))).toBe(false);
    expect(logs.some((l) => l.includes('now empty; removed the registry file'))).toBe(true);
  });

  it('keeps other entries when removing one of several', () => {
    const proj2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-trust-proj2-'));
    try {
      runTrust({ procReader: noClaude, path: proj, home, cwd: proj });
      runTrust({ procReader: noClaude, path: proj2, home, cwd: proj2 });
      const code = runUntrust({ procReader: noClaude, path: proj, home, cwd: proj });
      expect(code).toBe(0);
      expect(readRegistry(home)).toEqual([fs.realpathSync(proj2)]);
    } finally {
      fs.rmSync(proj2, { recursive: true, force: true });
    }
  });

  it('idempotent: untrusting an untrusted project prints "Not trusted; nothing to remove"', () => {
    const code = runUntrust({ procReader: noClaude, path: proj, home, cwd: proj });
    expect(code).toBe(0);
    expect(logs.some((l) => l.startsWith('[rea] Not trusted; nothing to remove:'))).toBe(true);
    expect(fs.existsSync(registryPath(home))).toBe(false);
  });

  it('exit 1 when <home>/.rea is world-writable', () => {
    if (typeof process.getuid !== 'function') return; // POSIX-only
    fs.mkdirSync(reaDir(home), { recursive: true });
    fs.chmodSync(reaDir(home), 0o777);
    const code = runUntrust({ procReader: noClaude, path: proj, home, cwd: proj });
    expect(code).toBe(1);
  });

  it('refuses under a governed agent session: exit 1, does not remove the entry', () => {
    // Establish trust as a "human" first (guard cleared in beforeEach).
    runTrust({ procReader: noClaude, path: proj, home, cwd: proj });
    const before = fs.readFileSync(registryPath(home));
    process.env.CLAUDE_PROJECT_DIR = '/some/agent/project';
    const code = runUntrust({ procReader: noClaude, path: proj, home, cwd: proj });
    expect(code).toBe(1);
    expect(errs.some((e) => e.includes('This is a human action'))).toBe(true);
    // No FS mutation: the entry is still present, bytes unchanged.
    expect(fs.readFileSync(registryPath(home)).equals(before)).toBe(true);
  });

  // P2 (codex): symmetric with runTrust — refuse an unsafe registry BEFORE
  // readRegistry reads through the tampered path.
  it.skipIf(process.platform === 'win32')(
    'exit 1, no read-through / no clobber when the registry file is a symlink',
    () => {
      const decoy = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-untrust-decoy-'));
      const decoyReg = path.join(decoy, 'decoy-registry');
      fs.writeFileSync(decoyReg, `${fs.realpathSync(proj)}\n`, 'utf8');
      try {
        fs.mkdirSync(reaDir(home), { recursive: true });
        fs.symlinkSync(decoyReg, registryPath(home));
        const code = runUntrust({ procReader: noClaude, path: proj, home, cwd: proj });
        expect(code).toBe(1);
        expect(errs.some((e) => e.includes('is a symlink'))).toBe(true);
        // The symlink was NOT replaced and the decoy target was NOT rewritten.
        expect(fs.lstatSync(registryPath(home)).isSymbolicLink()).toBe(true);
        expect(fs.readFileSync(decoyReg, 'utf8')).toBe(`${fs.realpathSync(proj)}\n`);
      } finally {
        fs.rmSync(decoy, { recursive: true, force: true });
      }
    },
  );
});

describe('runTrustList', () => {
  it('prints "No trusted projects." when the registry is absent', () => {
    const code = runTrustList({ home });
    expect(code).toBe(0);
    expect(logs).toContain('[rea] No trusted projects.');
  });

  it('prints each member one per line to stdout', () => {
    const proj2 = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-trust-list2-'));
    try {
      runTrust({ procReader: noClaude, path: proj, home, cwd: proj });
      runTrust({ procReader: noClaude, path: proj2, home, cwd: proj2 });
      const code = runTrustList({ home });
      expect(code).toBe(0);
      const printed = outs.join('');
      expect(printed).toContain(`${fs.realpathSync(proj)}\n`);
      expect(printed).toContain(`${fs.realpathSync(proj2)}\n`);
    } finally {
      fs.rmSync(proj2, { recursive: true, force: true });
    }
  });

  it('exit 1 with remediation on a tampered (world-writable) root', () => {
    if (typeof process.getuid !== 'function') return; // POSIX-only
    fs.mkdirSync(reaDir(home), { recursive: true });
    fs.chmodSync(reaDir(home), 0o777);
    const code = runTrustList({ home });
    expect(code).toBe(1);
    expect(errs.some((e) => e.includes('chmod 700'))).toBe(true);
  });

  it('exit 1 on a tampered registry file (mode 0644)', () => {
    if (typeof process.getuid !== 'function') return; // POSIX-only
    runTrust({ procReader: noClaude, path: proj, home, cwd: proj });
    fs.chmodSync(registryPath(home), 0o644);
    const code = runTrustList({ home });
    expect(code).toBe(1);
    expect(errs.some((e) => e.includes('chmod 600'))).toBe(true);
  });

  it('is READ-ONLY and NOT guarded: still lists under a governed agent session', () => {
    runTrust({ procReader: noClaude, path: proj, home, cwd: proj }); // as a "human"
    process.env.CLAUDE_PROJECT_DIR = '/some/agent/project';
    const code = runTrustList({ home });
    expect(code).toBe(0);
    expect(outs.join('')).toContain(`${fs.realpathSync(proj)}\n`);
  });
});
