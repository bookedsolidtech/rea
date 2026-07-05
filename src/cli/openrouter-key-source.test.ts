/**
 * Tests for the managed credential source.
 *
 * The load-bearing assertions are the FAIL-CLOSED security gates: a symlink, a
 * world/group-readable file, or a foreign-owned file must REFUSE (→ no key),
 * never silently feed a key into the audit-recorded review lane. The
 * env-FIRST precedence and the test-isolation contract (no HOME → no FS) are
 * the other two pillars.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  KeySourceError,
  credentialsDir,
  credentialsPath,
  envVarFor,
  isSupportedProvider,
  maskKey,
  resolveOpenRouterKey,
  resolveProviderKey,
  setProviderKey,
  supportedProviders,
  unsetProviderKey,
} from './openrouter-key-source.js';

const KEY = 'OPENROUTER_API_KEY';

let tmpHome: string;
/** An env bag pointing XDG_CONFIG_HOME at a throwaway dir (hermetic). */
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-keysrc-'));
  env = { XDG_CONFIG_HOME: tmpHome };
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function credFile(): string {
  return path.join(tmpHome, 'rea', 'credentials');
}

describe('path derivation + test-isolation contract', () => {
  it('XDG_CONFIG_HOME wins over HOME', () => {
    expect(credentialsDir({ XDG_CONFIG_HOME: '/x', HOME: '/home/u' })).toBe(path.join('/x', 'rea'));
    expect(credentialsPath({ XDG_CONFIG_HOME: '/x' })).toBe(path.join('/x', 'rea', 'credentials'));
  });

  it('falls back to $HOME/.config when XDG unset', () => {
    expect(credentialsDir({ HOME: '/home/u' })).toBe(path.join('/home/u', '.config', 'rea'));
  });

  it('returns undefined (no FS access) when NEITHER HOME nor XDG is present', () => {
    expect(credentialsDir({})).toBeUndefined();
    expect(credentialsPath({})).toBeUndefined();
    // The resolver must report none — and must NOT throw — on an empty env.
    expect(resolveOpenRouterKey({})).toEqual({ source: 'none' });
  });

  it('IGNORES a relative XDG_CONFIG_HOME / HOME (codex round-5 P2: never write the key into the CWD)', () => {
    // A relative config-home would resolve `rea/credentials` against the CWD —
    // in a repo session that places the secret inside the checkout.
    expect(credentialsDir({ XDG_CONFIG_HOME: 'relative/cfg' })).toBeUndefined();
    expect(credentialsDir({ HOME: 'relative/home' })).toBeUndefined();
    expect(credentialsDir({ XDG_CONFIG_HOME: 'rel', HOME: 'also/rel' })).toBeUndefined();
    // A relative XDG falls through to an ABSOLUTE HOME.
    expect(credentialsDir({ XDG_CONFIG_HOME: 'rel', HOME: '/abs/home' })).toBe(
      path.join('/abs/home', '.config', 'rea'),
    );
    // set-key must refuse rather than write into the CWD.
    expect(() => setProviderKey('openrouter', 'sk-or-x', { XDG_CONFIG_HOME: 'rel' })).toThrow(
      KeySourceError,
    );
  });
});

describe('resolveProviderKey — precedence', () => {
  it('env wins even when a file key exists (per-project / CI override)', () => {
    setProviderKey('openrouter', 'sk-or-FILEKEY', env);
    const r = resolveProviderKey('openrouter', { ...env, [KEY]: 'sk-or-ENVKEY' });
    expect(r.source).toBe('env');
    expect(r.key).toBe('sk-or-ENVKEY');
  });

  it('reads the file when env is absent', () => {
    setProviderKey('openrouter', 'sk-or-FILEKEY', env);
    const r = resolveOpenRouterKey(env);
    expect(r.source).toBe('file');
    expect(r.key).toBe('sk-or-FILEKEY');
  });

  it('codex round-18 P1: an explicit EMPTY env var DISABLES the lane (env-first), NOT a file fallback', () => {
    // An operator clearing `OPENROUTER_API_KEY=` for a one-off / CI run must
    // disable the external lane — the resolver must NOT silently re-enable it
    // from the managed file.
    setProviderKey('openrouter', 'sk-or-FILEKEY', env);
    const r = resolveProviderKey('openrouter', { ...env, [KEY]: '' });
    expect(r.source).toBe('none');
    expect(r.key).toBeUndefined();
  });

  it('an UNSET env var falls through to the managed file', () => {
    setProviderKey('openrouter', 'sk-or-FILEKEY', env);
    // env has no key at all (env var undefined, not empty) → file is used.
    const r = resolveProviderKey('openrouter', env);
    expect(r.source).toBe('file');
    expect(r.key).toBe('sk-or-FILEKEY');
  });

  it('none when neither env nor file has the key', () => {
    expect(resolveOpenRouterKey(env)).toEqual({ source: 'none' });
  });

  it('unknown provider → none (no throw)', () => {
    expect(resolveProviderKey('not-a-provider', { ...env, FOO: 'x' })).toEqual({ source: 'none' });
  });
});

describe('FAIL-CLOSED security gate', () => {
  it('a SYMLINK credentials file is refused (→ none + reason), never followed', () => {
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-evil-'));
    const target = path.join(realDir, 'attacker-creds');
    fs.writeFileSync(target, `${KEY}=sk-or-ATTACKER\n`, { mode: 0o600 });
    fs.mkdirSync(path.join(tmpHome, 'rea'), { recursive: true, mode: 0o700 });
    fs.symlinkSync(target, credFile());

    const r = resolveOpenRouterKey(env);
    expect(r.source).toBe('none');
    expect(r.key).toBeUndefined();
    expect(r.refusal).toMatch(/symlink/i);

    fs.rmSync(realDir, { recursive: true, force: true });
  });

  it.runIf(typeof process.getuid === 'function')(
    'a GROUP/OTHER-readable credentials file is refused',
    () => {
      setProviderKey('openrouter', 'sk-or-FILEKEY', env);
      fs.chmodSync(credFile(), 0o644);
      const r = resolveOpenRouterKey(env);
      expect(r.source).toBe('none');
      expect(r.refusal).toMatch(/group\/other-accessible|chmod 600/i);
    },
  );

  it('a non-regular-file credentials path is refused', () => {
    // Make `credentials` a directory.
    fs.mkdirSync(credFile(), { recursive: true, mode: 0o700 });
    const r = resolveOpenRouterKey(env);
    expect(r.source).toBe('none');
    expect(r.refusal).toMatch(/not a regular file/i);
  });

  it('a SYMLINKED parent directory is refused on read AND write (codex round-4 P2)', () => {
    // Stage a real dir with a valid key, then replace `…/rea` with a symlink to
    // it. lstat'ing only the file would follow the link; the dir gate must not.
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-realcfg-'));
    fs.writeFileSync(path.join(realDir, 'credentials'), `${KEY}=sk-or-THROUGHLINK\n`, {
      mode: 0o600,
    });
    fs.symlinkSync(realDir, path.join(tmpHome, 'rea'));

    // READ: refused, no key leaks through the link.
    const r = resolveOpenRouterKey(env);
    expect(r.source).toBe('none');
    expect(r.key).toBeUndefined();
    expect(r.refusal).toMatch(/directory is a symlink/i);

    // WRITE: refused — never writes the key through the symlinked dir.
    expect(() => setProviderKey('openrouter', 'sk-or-new', env)).toThrow(/directory is a symlink/i);

    fs.rmSync(realDir, { recursive: true, force: true });
  });

  it.runIf(typeof process.getuid === 'function')(
    'a group/other-WRITABLE parent directory is refused',
    () => {
      setProviderKey('openrouter', 'sk-or-x', env);
      fs.chmodSync(path.join(tmpHome, 'rea'), 0o777);
      const r = resolveOpenRouterKey(env);
      expect(r.source).toBe('none');
      expect(r.refusal).toMatch(/directory is group\/other-writable|chmod 700/i);
    },
  );

  it('a symlinked ANCESTOR (e.g. ~/.config) is refused, not just the rea dir (codex round-6 P1)', () => {
    // Use the HOME derivation so there is an intermediate `.config` ancestor
    // between the managed `…/rea` dir and the HOME anchor.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-home-'));
    const dotfiles = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-dotfiles-'));
    try {
      // ~/.config → a dotfiles checkout; a real key sits at .config/rea/credentials.
      fs.symlinkSync(dotfiles, path.join(home, '.config'));
      fs.mkdirSync(path.join(dotfiles, 'rea'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dotfiles, 'rea', 'credentials'), `${KEY}=sk-or-VIALINK\n`, {
        mode: 0o600,
      });

      const homeEnv = { HOME: home }; // no XDG → HOME/.config/rea derivation

      // READ: the symlinked `.config` ANCESTOR is refused — the key never
      // resolves through the redirected path.
      const r = resolveOpenRouterKey(homeEnv);
      expect(r.source).toBe('none');
      expect(r.key).toBeUndefined();
      expect(r.refusal).toMatch(/ANCESTOR is a symlink/i);

      // WRITE: refused — never writes the key through the symlinked ancestor.
      expect(() => setProviderKey('openrouter', 'sk-or-new', homeEnv)).toThrow(
        /ANCESTOR is a symlink/i,
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(dotfiles, { recursive: true, force: true });
    }
  });
});

describe('setProviderKey — write path', () => {
  it.runIf(typeof process.getuid === 'function')(
    'creates the file 0600 and the dir 0700',
    () => {
      setProviderKey('openrouter', 'sk-or-x', env);
      const fileMode = fs.statSync(credFile()).mode & 0o777;
      const dirMode = fs.statSync(path.join(tmpHome, 'rea')).mode & 0o777;
      expect(fileMode).toBe(0o600);
      expect(dirMode).toBe(0o700);
    },
  );

  it('is idempotent — same value twice produces byte-identical file', () => {
    setProviderKey('openrouter', 'sk-or-x', env);
    const a = fs.readFileSync(credFile(), 'utf8');
    setProviderKey('openrouter', 'sk-or-x', env);
    const b = fs.readFileSync(credFile(), 'utf8');
    expect(b).toBe(a);
  });

  it('trims surrounding whitespace from the stored value', () => {
    setProviderKey('openrouter', '  sk-or-trimmed\n', env);
    expect(resolveOpenRouterKey(env).key).toBe('sk-or-trimmed');
  });

  it('refuses an empty / whitespace-only key', () => {
    expect(() => setProviderKey('openrouter', '   ', env)).toThrow(KeySourceError);
  });

  it('refuses an unsupported provider', () => {
    expect(() => setProviderKey('nope', 'x', env)).toThrow(KeySourceError);
  });

  it('throws when no config dir can be derived', () => {
    expect(() => setProviderKey('openrouter', 'x', {})).toThrow(KeySourceError);
  });

  it('codex round-19 P1: refuses to write the key INSIDE the current git checkout (committable secret)', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-repo-'));
    execFileSync('git', ['init', '-q'], { cwd: repo });
    const prevCwd = process.cwd();
    try {
      process.chdir(repo);
      // XDG points INSIDE the checkout → the key would be committable → refuse.
      const repoEnv = { XDG_CONFIG_HOME: path.join(repo, '.config') };
      expect(() => setProviderKey('openrouter', 'sk-or-secret', repoEnv)).toThrow(
        /INSIDE the current git checkout/i,
      );
    } finally {
      process.chdir(prevCwd);
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('codex round-19 P1: a config root OUTSIDE the current checkout (e.g. dotfiles repo) is allowed', () => {
    // `env` (XDG_CONFIG_HOME = tmpHome under os.tmpdir()) is NOT under the test
    // process cwd's repo, so the dotfiles-safe check does not refuse it.
    expect(() => setProviderKey('openrouter', 'sk-or-x', env)).not.toThrow();
  });

  it('overwriting refuses a pre-existing tampered (world-readable) file', () => {
    setProviderKey('openrouter', 'sk-or-x', env);
    if (typeof process.getuid === 'function') {
      fs.chmodSync(credFile(), 0o644);
      expect(() => setProviderKey('openrouter', 'sk-or-y', env)).toThrow(/refused/i);
    }
  });
});

describe('unsetProviderKey', () => {
  it('removes a stored key and deletes the now-empty file', () => {
    setProviderKey('openrouter', 'sk-or-x', env);
    const res = unsetProviderKey('openrouter', env);
    expect(res.removed).toBe(true);
    expect(res.fileDeleted).toBe(true);
    expect(fs.existsSync(credFile())).toBe(false);
    expect(resolveOpenRouterKey(env).source).toBe('none');
  });

  it('is a no-op (removed=false) when nothing is stored', () => {
    const res = unsetProviderKey('openrouter', env);
    expect(res.removed).toBe(false);
    expect(res.fileDeleted).toBe(false);
  });

  it.runIf(typeof process.getuid === 'function')(
    'leaves a rewritten multi-key file at 0600 (codex round-5 P2)',
    () => {
      // Seed a file with TWO keys so unset takes the rewrite (not delete) branch.
      const dir = path.join(tmpHome, 'rea');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, 'credentials');
      fs.writeFileSync(file, `${KEY}=sk-or-x\nOTHER_TOKEN=keepme\n`, { mode: 0o600 });

      const res = unsetProviderKey('openrouter', env);
      expect(res.removed).toBe(true);
      expect(res.fileDeleted).toBe(false);
      // The rewritten file must remain 0600 (not 0644 under umask) so the
      // remaining secret stays private AND the perm gate doesn't refuse it next time.
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(file, 'utf8')).toContain('OTHER_TOKEN=keepme');
    },
  );
});

describe('maskKey + provider registry helpers', () => {
  it('maskKey reveals only the last 4 chars, never the body', () => {
    expect(maskKey('sk-or-v1-abcd1234')).toBe('…1234');
    expect(maskKey('sk-or-v1-abcd1234')).not.toContain('abcd');
    expect(maskKey('xy')).toBe('••••');
  });

  it('registry helpers', () => {
    expect(isSupportedProvider('openrouter')).toBe(true);
    expect(isSupportedProvider('codex')).toBe(false);
    expect(supportedProviders()).toContain('openrouter');
    expect(envVarFor('openrouter')).toBe(KEY);
    expect(envVarFor('codex')).toBeUndefined();
  });
});
