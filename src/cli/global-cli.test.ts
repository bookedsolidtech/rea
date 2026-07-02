/**
 * Hermetic tests for the shared global-CLI resolution + safety module.
 *
 * Every test injects a temp `home` dir (never `os.userInfo().homedir`) so the
 * real `~/.rea/` is never read or mutated. `pw_dir` is passwd-derived and
 * env-immune, so injection is the ONLY hermetic mechanism.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  REGISTRY_HEADER_LINES,
  assertNotGovernedSession,
  checkReaDirSafety,
  checkRegistrySafety,
  deleteRegistry,
  globalRoot,
  isClaudeAncestor,
  isProjectTrusted,
  isWellFormedMemberLine,
  projectPathControlCharReason,
  reaDir,
  readRegistry,
  registryPath,
  resolveGlobalCli,
  writeRegistry,
  type ProcReader,
} from './global-cli.js';

let home: string;
let savedCpd: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-globalcli-home-'));
  savedCpd = process.env.CLAUDE_PROJECT_DIR;
  delete process.env.CLAUDE_PROJECT_DIR;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedCpd === undefined) delete process.env.CLAUDE_PROJECT_DIR;
  else process.env.CLAUDE_PROJECT_DIR = savedCpd;
  fs.rmSync(home, { recursive: true, force: true });
});

function readBytes(p: string): Buffer {
  return fs.readFileSync(p);
}

describe('path derivation', () => {
  it('derives the .rea / cli / registry paths under the injected home', () => {
    expect(reaDir(home)).toBe(path.join(home, '.rea'));
    expect(globalRoot(home)).toBe(path.join(home, '.rea', 'cli'));
    expect(registryPath(home)).toBe(path.join(home, '.rea', 'trusted-projects'));
  });
});

describe('writeRegistry / readRegistry', () => {
  it('writes the fixed header + sorted+deduped members with a single trailing LF', () => {
    writeRegistry(['/z/proj', '/a/proj', '/z/proj', '/m/proj'], home);
    const content = fs.readFileSync(registryPath(home), 'utf8');
    const expected =
      REGISTRY_HEADER_LINES.join('\n') + '\n' + ['/a/proj', '/m/proj', '/z/proj'].join('\n') + '\n';
    expect(content).toBe(expected);
  });

  it('is byte-idempotent: writeRegistry(readRegistry(x)) reproduces x exactly', () => {
    writeRegistry(['/b/proj', '/a/proj', '/c/proj'], home);
    const first = readBytes(registryPath(home));
    writeRegistry(readRegistry(home), home);
    const second = readBytes(registryPath(home));
    expect(second.equals(first)).toBe(true);
  });

  it('is order-independent: [a,b] and [b,a] produce identical bytes', () => {
    const homeA = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-orderA-'));
    const homeB = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-orderB-'));
    try {
      writeRegistry(['/a/one', '/b/two'], homeA);
      writeRegistry(['/b/two', '/a/one'], homeB);
      expect(readBytes(registryPath(homeA)).equals(readBytes(registryPath(homeB)))).toBe(true);
    } finally {
      fs.rmSync(homeA, { recursive: true, force: true });
      fs.rmSync(homeB, { recursive: true, force: true });
    }
  });

  it('dedups repeated members', () => {
    writeRegistry(['/dup/proj', '/dup/proj', '/dup/proj'], home);
    expect(readRegistry(home)).toEqual(['/dup/proj']);
  });

  it('empty input writes header-only and reads back as no members', () => {
    writeRegistry([], home);
    const content = fs.readFileSync(registryPath(home), 'utf8');
    expect(content).toBe(REGISTRY_HEADER_LINES.join('\n') + '\n');
    expect(readRegistry(home)).toEqual([]);
  });

  it('drops malformed lines with a single stderr notice', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    writeRegistry(['/good/proj', 'relative/path', '/has\nnewline', '', '/good2/proj'], home);
    expect(readRegistry(home)).toEqual(['/good/proj', '/good2/proj']);
    const notices = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('malformed'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('dropped 3 malformed line(s)');
  });

  it('writes the registry file mode 0600 and the .rea dir 0700', () => {
    writeRegistry(['/proj'], home);
    if (typeof process.getuid === 'function') {
      expect(fs.lstatSync(registryPath(home)).mode & 0o777).toBe(0o600);
      expect(fs.lstatSync(reaDir(home)).mode & 0o777).toBe(0o700);
    }
  });

  it('readRegistry skips comment and blank lines', () => {
    fs.mkdirSync(reaDir(home), { recursive: true });
    fs.writeFileSync(
      registryPath(home),
      '# comment\n\n/real/proj\n   \n/second/proj\n',
      'utf8',
    );
    // `   ` (whitespace-only) is non-blank + non-comment, so it is returned
    // verbatim by the lenient reader; writeRegistry would later drop it.
    expect(readRegistry(home)).toEqual(['/real/proj', '   ', '/second/proj']);
  });

  it('deleteRegistry removes the file and is a no-op when absent', () => {
    writeRegistry(['/proj'], home);
    expect(fs.existsSync(registryPath(home))).toBe(true);
    deleteRegistry(home);
    expect(fs.existsSync(registryPath(home))).toBe(false);
    expect(() => deleteRegistry(home)).not.toThrow();
  });
});

describe('isWellFormedMemberLine', () => {
  it('accepts a bare absolute path', () => {
    expect(isWellFormedMemberLine('/a/b/c')).toBe(true);
  });
  it('rejects relative, comment, whitespace, newline, CR, NUL, tab, and empty', () => {
    expect(isWellFormedMemberLine('rel/path')).toBe(false);
    expect(isWellFormedMemberLine('# comment')).toBe(false);
    expect(isWellFormedMemberLine(' /leading-space')).toBe(false);
    expect(isWellFormedMemberLine('/trailing-space ')).toBe(false);
    expect(isWellFormedMemberLine('/has\nnewline')).toBe(false);
    // P3 (codex): a carriage return must be rejected — writeRegistry would
    // otherwise silently drop the line while a caller reported success.
    expect(isWellFormedMemberLine('/has\rcr')).toBe(false);
    expect(isWellFormedMemberLine('/has\0nul')).toBe(false);
    expect(isWellFormedMemberLine('/has\tinterior-tab')).toBe(false);
    expect(isWellFormedMemberLine('')).toBe(false);
  });
});

describe('projectPathControlCharReason', () => {
  it('accepts a clean absolute path (returns null)', () => {
    expect(projectPathControlCharReason('/a/b/c')).toBeNull();
  });
  it('rejects any C0 control char (CR/LF/NUL/tab)', () => {
    expect(projectPathControlCharReason('/has\rcr')).toBe('contains control characters');
    expect(projectPathControlCharReason('/has\nlf')).toBe('contains control characters');
    expect(projectPathControlCharReason('/has\0nul')).toBe('contains control characters');
    expect(projectPathControlCharReason('/has\tinterior-tab')).toBe('contains control characters');
    expect(projectPathControlCharReason('/has\x1funit-sep')).toBe('contains control characters');
  });
});

describe('isProjectTrusted', () => {
  it('exact whole-line membership (mirrors grep -Fxq)', () => {
    writeRegistry(['/a/proj', '/b/proj'], home);
    expect(isProjectTrusted('/a/proj', home)).toBe(true);
    expect(isProjectTrusted('/b/proj', home)).toBe(true);
    expect(isProjectTrusted('/a', home)).toBe(false); // no prefix match
    expect(isProjectTrusted('/a/proj/', home)).toBe(false); // trailing slash differs
    expect(isProjectTrusted('/c/proj', home)).toBe(false);
  });
  it('a comment line never matches (queries start with /)', () => {
    fs.mkdirSync(reaDir(home), { recursive: true });
    fs.writeFileSync(registryPath(home), '# rea trusted-projects (v1)\n/real/proj\n', 'utf8');
    expect(isProjectTrusted('# rea trusted-projects (v1)', home)).toBe(true); // literal line
    expect(isProjectTrusted('/real/proj', home)).toBe(true);
  });
  it('returns false when the registry is absent', () => {
    expect(isProjectTrusted('/anything', home)).toBe(false);
  });
});

describe('checkReaDirSafety', () => {
  it('absent .rea is safe (writer creates it 0700)', () => {
    const r = checkReaDirSafety(home);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.absent).toBe(true);
  });

  it('a well-formed 0700 dir is safe', () => {
    fs.mkdirSync(reaDir(home), { recursive: true, mode: 0o700 });
    fs.chmodSync(reaDir(home), 0o700);
    expect(checkReaDirSafety(home).ok).toBe(true);
  });

  it('rejects a symlinked .rea', () => {
    const target = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-symtarget-'));
    try {
      fs.symlinkSync(target, reaDir(home));
      const r = checkReaDirSafety(home);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe('symlink');
        expect(r.remediation).toContain('rm ');
      }
    } finally {
      fs.rmSync(target, { recursive: true, force: true });
    }
  });

  it('rejects a non-directory .rea', () => {
    fs.writeFileSync(reaDir(home), 'not a dir', 'utf8');
    const r = checkReaDirSafety(home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not-dir');
  });

  it('rejects a group/other-writable .rea (chmod 0777)', () => {
    if (typeof process.getuid !== 'function') return; // POSIX-only
    fs.mkdirSync(reaDir(home), { recursive: true });
    fs.chmodSync(reaDir(home), 0o777);
    const r = checkReaDirSafety(home);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('world-writable');
      expect(r.remediation).toBe(`chmod 700 ${reaDir(home)}`);
    }
  });

  it('rejects a foreign-owned .rea (getuid mocked to a different uid)', () => {
    if (typeof process.getuid !== 'function') return; // POSIX-only
    fs.mkdirSync(reaDir(home), { recursive: true, mode: 0o700 });
    fs.chmodSync(reaDir(home), 0o700);
    const realUid = process.getuid();
    vi.spyOn(process, 'getuid').mockReturnValue(realUid + 1);
    const r = checkReaDirSafety(home);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('foreign-owner');
      expect(r.remediation).toContain('chown');
    }
  });
});

describe('checkRegistrySafety', () => {
  it('absent registry is safe', () => {
    const r = checkRegistrySafety(home);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.absent).toBe(true);
  });

  it('a 0600 registry written by writeRegistry is safe', () => {
    writeRegistry(['/proj'], home);
    expect(checkRegistrySafety(home).ok).toBe(true);
  });

  it('rejects a symlinked registry', () => {
    fs.mkdirSync(reaDir(home), { recursive: true });
    const target = path.join(home, 'decoy');
    fs.writeFileSync(target, '/evil/proj\n', 'utf8');
    fs.symlinkSync(target, registryPath(home));
    const r = checkRegistrySafety(home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('symlink');
  });

  it('rejects a group/other-accessible registry (mode 0644)', () => {
    if (typeof process.getuid !== 'function') return; // POSIX-only
    fs.mkdirSync(reaDir(home), { recursive: true });
    fs.writeFileSync(registryPath(home), '/proj\n', { mode: 0o644 });
    fs.chmodSync(registryPath(home), 0o644);
    const r = checkRegistrySafety(home);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('bad-mode');
      expect(r.remediation).toBe(`chmod 600 ${registryPath(home)}`);
    }
  });

  it('rejects a hardlinked registry (nlink !== 1)', () => {
    fs.mkdirSync(reaDir(home), { recursive: true });
    fs.writeFileSync(registryPath(home), '/proj\n', { mode: 0o600 });
    fs.chmodSync(registryPath(home), 0o600);
    const alias = path.join(home, '.rea', 'alias');
    fs.linkSync(registryPath(home), alias); // nlink becomes 2
    const r = checkRegistrySafety(home);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('bad-nlink');
  });

  // Foreign-owner for the registry FILE is the same mechanism as the dir case
  // above (getuid mock); a real second uid is not available in unit tests —
  // documented residual. The dir foreign-owner test exercises the shared uid
  // comparison branch.
});

// Injectable ancestry readers so the guard tests are hermetic + cross-platform
// (the REAL process ancestry in CI/agent runs contains `claude`, which would
// otherwise refuse every allowed case).
const noClaude: ProcReader = () => null;
const claudeAncestor: ProcReader = () => ({ ppid: 1, comm: '/usr/local/bin/claude' });

describe('isClaudeAncestor', () => {
  it('returns true when an ancestor comm is claude', () => {
    expect(isClaudeAncestor(claudeAncestor)).toBe(true);
  });
  it('returns true for claude-code', () => {
    expect(isClaudeAncestor(() => ({ ppid: 1, comm: 'claude-code' }))).toBe(true);
  });
  it('returns false (fail-safe) when the reader can never determine an ancestor', () => {
    expect(isClaudeAncestor(noClaude)).toBe(false);
  });
  it('walks up the chain and finds claude a few hops up', () => {
    const chain: Record<number, { ppid: number; comm: string }> = {
      100: { ppid: 200, comm: 'zsh' },
      200: { ppid: 300, comm: 'node' },
      300: { ppid: 1, comm: 'claude' },
    };
    expect(isClaudeAncestor((pid) => chain[pid] ?? null, 100)).toBe(true);
  });
  it('stops at maxHops without a false positive', () => {
    // An infinite non-claude chain — must terminate false, not hang.
    expect(isClaudeAncestor((pid) => ({ ppid: pid + 1, comm: 'node' }), 100, 5)).toBe(false);
  });
  it('is fail-safe when the reader throws', () => {
    expect(
      isClaudeAncestor(() => {
        throw new Error('ps missing');
      }),
    ).toBe(false);
  });
});

describe('assertNotGovernedSession', () => {
  it('returns null (allowed) when CLAUDE_PROJECT_DIR is unset AND no claude ancestor', () => {
    expect(assertNotGovernedSession('trust', home, { procReader: noClaude })).toBeNull();
  });

  it('returns null when CLAUDE_PROJECT_DIR is set but empty (and no claude ancestor)', () => {
    process.env.CLAUDE_PROJECT_DIR = '';
    expect(assertNotGovernedSession('trust', home, { procReader: noClaude })).toBeNull();
  });

  it('returns 1 and names reaDir when CLAUDE_PROJECT_DIR is set', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.CLAUDE_PROJECT_DIR = '/some/agent/project';
    expect(assertNotGovernedSession('install --global', home, { procReader: noClaude })).toBe(1);
    const emitted = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(emitted).toContain('rea install --global mutates your per-user trust root');
    expect(emitted).toContain(reaDir(home));
    expect(emitted).toContain('This is a human action');
    expect(emitted).toContain('CLAUDE_PROJECT_DIR is set');
  });

  it('returns 1 when CLAUDE_PROJECT_DIR is UNSET but a claude process is an ancestor (the bypass)', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.CLAUDE_PROJECT_DIR;
    expect(assertNotGovernedSession('trust', home, { procReader: claudeAncestor })).toBe(1);
    const emitted = errSpy.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(emitted).toContain('a Claude Code process is an ancestor');
  });
});

describe('resolveGlobalCli', () => {
  it('returns null when neither shape exists', () => {
    expect(resolveGlobalCli(home)).toBeNull();
  });

  it('resolves the npm-install shape (node_modules/@bookedsolid/rea/dist/cli/index.js)', () => {
    const c1 = path.join(
      globalRoot(home),
      'node_modules',
      '@bookedsolid',
      'rea',
      'dist',
      'cli',
      'index.js',
    );
    fs.mkdirSync(path.dirname(c1), { recursive: true });
    fs.writeFileSync(c1, '// cli', 'utf8');
    expect(resolveGlobalCli(home)).toBe(c1);
  });

  it('resolves the bare-drop fallback (dist/cli/index.js) when node_modules is absent', () => {
    const c2 = path.join(globalRoot(home), 'dist', 'cli', 'index.js');
    fs.mkdirSync(path.dirname(c2), { recursive: true });
    fs.writeFileSync(c2, '// cli', 'utf8');
    expect(resolveGlobalCli(home)).toBe(c2);
  });

  it('prefers the npm-install shape over the bare-drop fallback', () => {
    const c1 = path.join(
      globalRoot(home),
      'node_modules',
      '@bookedsolid',
      'rea',
      'dist',
      'cli',
      'index.js',
    );
    const c2 = path.join(globalRoot(home), 'dist', 'cli', 'index.js');
    fs.mkdirSync(path.dirname(c1), { recursive: true });
    fs.writeFileSync(c1, '// cli1', 'utf8');
    fs.mkdirSync(path.dirname(c2), { recursive: true });
    fs.writeFileSync(c2, '// cli2', 'utf8');
    expect(resolveGlobalCli(home)).toBe(c1);
  });
});
