/**
 * Managed credential source for review-provider API keys.
 *
 * WHY THIS EXISTS
 * ---------------
 * The openrouter review provider needs an `OPENROUTER_API_KEY`. Telling every
 * operator to hand-edit `~/.zshenv` is not a turnkey setup — it is brittle,
 * shell-specific, and invisible to `rea doctor`. This module gives rea a
 * first-class, governed place to keep that key: a flat `KEY=value` file at
 * `${XDG_CONFIG_HOME:-~/.config}/rea/credentials`, dir `0700`, file `0600`.
 *
 * SECURITY MODEL (security-architect, binding)
 * --------------------------------------------
 *   1. NO OS keychain. The keychain unlock prompt is a GUI modal; rea runs
 *      non-interactively (CI, agents, pre-push gate). A modal that blocks a
 *      governance gate makes the gate flaky — disqualifying. Managed file only.
 *   2. Precedence is ENV-FIRST, then file, then none. An environment variable
 *      always wins so a project / CI run can override the global default with a
 *      per-invocation key, and so existing `export OPENROUTER_API_KEY=…` setups
 *      keep working byte-for-byte.
 *   3. The reader is FAIL-CLOSED. A symlink, a non-regular file, group/other
 *      permissions, or foreign ownership all REFUSE the file (→ no key, with a
 *      reason). A refused file degrades the provider to "unavailable" (→ codex
 *      fallback or policy refusal) — it never silently mints trust.
 *   4. The VALUE never transits argv. Writers read it from stdin or a masked
 *      prompt (see `config-key.ts`); this module only takes it as a string.
 *
 * TEST-ISOLATION CONTRACT
 * -----------------------
 * The credentials directory is derived ONLY from the passed `env` bag
 * (`XDG_CONFIG_HOME` then `HOME`). A curated env with neither set resolves to
 * "no path" and the filesystem is never touched. Production always passes
 * `process.env` (which has `HOME`); unit tests pass minimal envs and stay
 * hermetic — they cannot read a developer's real `~/.config/rea/credentials`.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * codex round-19 P1: is `dir` inside the SAME git checkout as `cwd` (the repo
 * being worked on)? Used to REFUSE writing the managed credentials file into the
 * checkout (committable secret) when `XDG_CONFIG_HOME`/`HOME` is pointed inside
 * the repo (a CI/devcontainer isolation pattern). Dotfiles-as-git is NOT flagged
 * — it compares against `cwd`'s toplevel specifically, not any git repo. Never
 * throws; a non-git `cwd` (no toplevel) returns false.
 */
function isInsideReviewedCheckout(dir: string, cwd: string): boolean {
  const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  if (r.status !== 0 || typeof r.stdout !== 'string') return false;
  const top = r.stdout.trim();
  if (top.length === 0) return false;
  // realpath the NEAREST EXISTING ancestor then re-append the not-yet-created
  // suffix, so a first-time `set-key` (dir absent) still resolves symlinks like
  // macOS `/var`→`/private/var` consistently on both sides.
  const realResolve = (p: string): string => {
    let cur = path.resolve(p);
    const tail: string[] = [];
    for (;;) {
      try {
        return tail.length > 0 ? path.join(fs.realpathSync(cur), ...tail.reverse()) : fs.realpathSync(cur);
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return path.resolve(p);
        tail.push(path.basename(cur));
        cur = parent;
      }
    }
  };
  const topReal = realResolve(top);
  const dirReal = realResolve(dir);
  return dirReal === topReal || dirReal.startsWith(topReal + path.sep);
}

/** The canonical env var that carries the OpenRouter key. */
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';

/** Provider id → the env var that carries its key. Extend as lanes are added. */
const PROVIDER_ENV: Readonly<Record<string, string>> = {
  openrouter: OPENROUTER_KEY_ENV,
};

/** Where a resolved key came from. */
export type KeySource = 'env' | 'file' | 'none';

export interface ResolvedKey {
  /** The usable key — present iff `source !== 'none'`. */
  key?: string;
  source: KeySource;
  /**
   * Set when `source === 'none'` because a credentials file EXISTED but was
   * refused by the security gate (symlink / perms / owner). Surfaced by
   * `rea doctor` and `rea config list` so the operator can fix it.
   */
  refusal?: string;
}

/** Thrown by the mutating helpers (`setProviderKey` / `unsetProviderKey`). */
export class KeySourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeySourceError';
  }
}

export function isSupportedProvider(provider: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROVIDER_ENV, provider);
}

export function supportedProviders(): string[] {
  return Object.keys(PROVIDER_ENV);
}

/** The env var name that carries `provider`'s key, or undefined if unknown. */
export function envVarFor(provider: string): string | undefined {
  return PROVIDER_ENV[provider];
}

// ---------------------------------------------------------------------------
// Path derivation — env-bag-only (see TEST-ISOLATION CONTRACT above)
// ---------------------------------------------------------------------------

/**
 * The managed credentials directory: `$XDG_CONFIG_HOME/rea`, else
 * `$HOME/.config/rea`. Returns undefined when NEITHER var is present — OR is
 * present but NOT ABSOLUTE (codex round-5 P2): a relative `XDG_CONFIG_HOME` /
 * `HOME` would resolve `rea/credentials` against the CWD, and in a repo session
 * `rea config set-key` would write the API KEY into the checkout (committable),
 * with later reads silently sourcing from there. A relative value is IGNORED
 * (fall through to the next candidate, then to "no path") — never trusted.
 */
export function credentialsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0 && path.isAbsolute(xdg)) return path.join(xdg, 'rea');
  // codex round-18 P2: on native Windows shells `HOME` is commonly unset while
  // `USERPROFILE` is the only absolute home dir — fall back to it so the config
  // commands can locate the managed credentials file there too.
  const home = absHome(env);
  if (home !== undefined) return path.join(home, '.config', 'rea');
  return undefined;
}

/** The first ABSOLUTE home directory from `HOME`, else `USERPROFILE` (Windows). */
function absHome(env: NodeJS.ProcessEnv): string | undefined {
  const home = env.HOME;
  if (home !== undefined && home.length > 0 && path.isAbsolute(home)) return home;
  const userProfile = env.USERPROFILE;
  if (userProfile !== undefined && userProfile.length > 0 && path.isAbsolute(userProfile)) {
    return userProfile;
  }
  return undefined;
}

/** The managed credentials file path, or undefined if the dir can't be derived. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = credentialsDir(env);
  return dir === undefined ? undefined : path.join(dir, 'credentials');
}

/**
 * The TRUST ANCHOR the operator declared — `XDG_CONFIG_HOME` (if absolute) else
 * `HOME` (if absolute). The ancestor-symlink walk (codex round-6 P1) checks the
 * credentials dir up to AND INCLUDING this anchor, but NEVER above it: components
 * above the anchor (e.g. macOS `/var` → `/private/var`) are outside rea's control
 * and would false-refuse legitimate setups.
 */
function credentialsAnchor(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg !== undefined && xdg.length > 0 && path.isAbsolute(xdg)) return xdg;
  // HOME, then USERPROFILE (Windows) — matches credentialsDir's derivation.
  return absHome(env);
}

// ---------------------------------------------------------------------------
// File format
// ---------------------------------------------------------------------------

const HEADER = [
  '# rea managed credentials — DO NOT commit this file.',
  '# Written by `rea config set-key`. One KEY=value per line. Keep mode 0600.',
  '',
].join('\n');

function parseCredentials(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue; // no key, or `=value` with empty key
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k.length > 0) map.set(k, v);
  }
  return map;
}

function serializeCredentials(map: Map<string, string>): string {
  // Sorted for byte-stable, idempotent writes.
  const keys = [...map.keys()].sort();
  const body = keys.map((k) => `${k}=${map.get(k) ?? ''}`).join('\n');
  return body.length > 0 ? `${HEADER}${body}\n` : HEADER;
}

// ---------------------------------------------------------------------------
// Fail-closed reader
// ---------------------------------------------------------------------------

interface CredentialsFileRead {
  /** Parsed entries — present iff the file existed AND passed the security gate. */
  map?: Map<string, string>;
  /** Present iff the file existed but was REFUSED. */
  refusal?: string;
}

/**
 * Security-gate the managed directory (`…/rea`) AND its ancestors before
 * touching the file inside it (codex round-4 P2 + round-6 P1). lstat'ing only
 * the final `credentials` file — or only the `…/rea` dir — leaves a symlinked
 * directory able to redirect the read/write outside the private config root
 * (e.g. `~/.config` → a dotfiles git checkout), bypassing the 0700/0600
 * boundary and landing the key in a committable location. So we walk from `dir`
 * up to AND INCLUDING `anchor` (the declared XDG/HOME root), refusing a SYMLINK
 * at any level; full owner/perm/dir-type checks apply to the managed `dir`. We
 * never inspect components ABOVE the anchor (those would false-refuse, e.g.
 * macOS `/var`). An ABSENT component is NOT a refusal — the writer creates the
 * chain as real dirs. POSIX-only owner/perm checks.
 */
function checkCredentialsDirSafety(dir: string, anchor: string | undefined): string | undefined {
  let cur = dir;
  for (;;) {
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(cur);
    } catch {
      st = undefined; // absent — created later as a real dir by the writer
    }
    if (st !== undefined) {
      if (st.isSymbolicLink()) {
        return cur === dir
          ? `credentials directory is a symlink — refusing (could redirect reads/writes outside ~/.config/rea): ${cur}`
          : `credentials directory ANCESTOR is a symlink — refusing (could redirect the key outside the private config root): ${cur}`;
      }
      if (cur === dir) {
        if (!st.isDirectory()) return `credentials directory path is not a directory: ${dir}`;
        if (typeof process.getuid === 'function') {
          if (st.uid !== process.getuid()) {
            return `credentials directory is not owned by the current user — refusing: ${dir}`;
          }
          if ((st.mode & 0o022) !== 0) {
            return `credentials directory is group/other-writable (mode ${(st.mode & 0o777).toString(8)}) — run: chmod 700 ${dir}`;
          }
        }
      }
    }
    if (anchor === undefined || cur === anchor) break;
    const parent = path.dirname(cur);
    if (parent === cur) break; // fs root reached defensively
    cur = parent;
  }
  return undefined;
}

/**
 * Read + security-gate the credentials file. Absent file → `{}` (no map, no
 * refusal). A symlinked PARENT DIR or ANCESTOR (up to `anchor`), a symlinked
 * file, non-regular file, group/other permissions, or foreign ownership →
 * `{ refusal }`. Otherwise `{ map }`.
 */
function readCredentialsFile(file: string, anchor: string | undefined): CredentialsFileRead {
  const dirRefusal = checkCredentialsDirSafety(path.dirname(file), anchor);
  if (dirRefusal !== undefined) return { refusal: dirRefusal };

  let st: fs.Stats;
  try {
    st = fs.lstatSync(file);
  } catch {
    return {}; // absent
  }
  if (st.isSymbolicLink()) {
    return {
      refusal: `credentials file is a symlink — refusing (a symlink could redirect the read outside ~/.config/rea): ${file}`,
    };
  }
  if (!st.isFile()) {
    return { refusal: `credentials path is not a regular file: ${file}` };
  }
  // POSIX-only perm/owner gate — `getuid` is undefined on Windows, where mode
  // bits are not meaningful; there we accept the file on existence alone.
  if (typeof process.getuid === 'function') {
    if ((st.mode & 0o077) !== 0) {
      return {
        refusal: `credentials file is group/other-accessible (mode ${(st.mode & 0o777).toString(8)}) — run: chmod 600 ${file}`,
      };
    }
    if (st.uid !== process.getuid()) {
      return { refusal: `credentials file is not owned by the current user — refusing: ${file}` };
    }
  }
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return { refusal: `credentials file could not be read: ${file}` };
  }
  return { map: parseCredentials(content) };
}

// ---------------------------------------------------------------------------
// Resolution (read path — used by the provider, doctor, and the CLI)
// ---------------------------------------------------------------------------

/** Resolve any supported provider's key with env-first precedence. */
export function resolveProviderKey(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedKey {
  const envVar = envVarFor(provider);
  if (envVar === undefined) return { source: 'none' };

  // codex round-18 P1: env-first precedence means any DEFINED env var is
  // AUTHORITATIVE — including an explicit empty `OPENROUTER_API_KEY=`, which a
  // one-off run or CI job uses to DISABLE the external lane. We must NOT fall
  // through to the managed file in that case (which would silently re-enable the
  // lane and could send diffs off-machine despite the operator clearing the var).
  const direct = env[envVar];
  if (direct !== undefined) {
    return direct.length > 0 ? { key: direct, source: 'env' } : { source: 'none' };
  }

  const file = credentialsPath(env);
  if (file === undefined) return { source: 'none' };

  const read = readCredentialsFile(file, credentialsAnchor(env));
  if (read.refusal !== undefined) return { source: 'none', refusal: read.refusal };
  const value = read.map?.get(envVar);
  if (value !== undefined && value.length > 0) return { key: value, source: 'file' };
  return { source: 'none' };
}

/** Resolve the OpenRouter key (env-first → managed file → none). */
export function resolveOpenRouterKey(env: NodeJS.ProcessEnv = process.env): ResolvedKey {
  return resolveProviderKey('openrouter', env);
}

// ---------------------------------------------------------------------------
// Mutation (write path — used only by `rea config set-key|unset-key`)
// ---------------------------------------------------------------------------

export interface WriteResult {
  path: string;
}

/**
 * Persist a provider key to the managed credentials file. Creates the dir
 * `0700` and writes the file `0600` via atomic temp+rename, preserving any
 * other providers' keys already present (idempotent set). Refuses to write over
 * a credentials file that fails the security gate.
 */
export function setProviderKey(
  provider: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): WriteResult {
  const envVar = envVarFor(provider);
  if (envVar === undefined) throw new KeySourceError(`unsupported provider: ${provider}`);

  const trimmed = value.trim();
  if (trimmed.length === 0) throw new KeySourceError('refusing to store an empty key');

  const dir = credentialsDir(env);
  if (dir === undefined) {
    throw new KeySourceError('cannot determine config dir — HOME / XDG_CONFIG_HOME are unset');
  }
  const file = path.join(dir, 'credentials');
  const anchor = credentialsAnchor(env);

  // codex round-19 P1: refuse a config root INSIDE the current git checkout —
  // an absolute `XDG_CONFIG_HOME`/`HOME` pointed into the repo would write the
  // API key into a committable path (neither ignored nor protected). Fail closed.
  if (isInsideReviewedCheckout(dir, process.cwd())) {
    throw new KeySourceError(
      `refusing to store the key at ${file} — it is INSIDE the current git checkout ` +
        `(the secret would be committable). Point XDG_CONFIG_HOME/HOME at a config ` +
        `root OUTSIDE the repo (e.g. ~/.config), or unset it.`,
    );
  }

  // codex round-4 P2 + round-6 P1: refuse a tampered dir OR a symlinked ANCESTOR
  // BEFORE mkdir/write — never create or write the key through a symlinked
  // directory chain. An absent dir passes (we create it 0700 just below).
  const dirRefusal = checkCredentialsDirSafety(dir, anchor);
  if (dirRefusal !== undefined) throw new KeySourceError(dirRefusal);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best-effort: some filesystems reject chmod; the 0o600 file is the real gate */
  }

  // Merge with the existing file rather than overwriting blind. A tampered
  // (symlink/perms/owner) file is refused, not clobbered.
  const existing = readCredentialsFile(file, anchor);
  if (existing.refusal !== undefined) {
    throw new KeySourceError(`existing credentials file refused: ${existing.refusal}. Remove it and retry.`);
  }
  const map = existing.map ?? new Map<string, string>();
  map.set(envVar, trimmed);

  const tmp = path.join(dir, `.credentials.tmp-${process.pid}`);
  fs.writeFileSync(tmp, serializeCredentials(map), { mode: 0o600 });
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* best-effort */
  }
  // rename replaces the destination PATH (not a symlink's target), atomically.
  // codex round-18 P2 (assessed, no change): Node's `fs.renameSync` OVERWRITES an
  // existing destination on ALL platforms — on Windows libuv uses `MoveFileEx`
  // with `MOVEFILE_REPLACE_EXISTING`, unlike the raw Win32 `rename()`. So key
  // ROTATION (overwriting an existing credentials file) works cross-platform; a
  // non-atomic rm+rename fallback would only re-introduce a crash window.
  fs.renameSync(tmp, file);
  return { path: file };
}

export interface UnsetResult {
  path?: string;
  /** True if a key was actually removed. */
  removed: boolean;
  /** True if removing the last key emptied — and so deleted — the file. */
  fileDeleted: boolean;
}

/** Remove a provider key from the managed file. Leaves env vars untouched. */
export function unsetProviderKey(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
): UnsetResult {
  const envVar = envVarFor(provider);
  if (envVar === undefined) throw new KeySourceError(`unsupported provider: ${provider}`);

  const dir = credentialsDir(env);
  if (dir === undefined) return { removed: false, fileDeleted: false };
  const file = path.join(dir, 'credentials');

  const existing = readCredentialsFile(file, credentialsAnchor(env));
  if (existing.refusal !== undefined) {
    throw new KeySourceError(`credentials file refused: ${existing.refusal}`);
  }
  if (existing.map === undefined || !existing.map.has(envVar)) {
    return { path: file, removed: false, fileDeleted: false };
  }

  existing.map.delete(envVar);
  if (existing.map.size === 0) {
    fs.rmSync(file, { force: true });
    return { path: file, removed: true, fileDeleted: true };
  }
  const tmp = path.join(dir, `.credentials.tmp-${process.pid}`);
  fs.writeFileSync(tmp, serializeCredentials(existing.map), { mode: 0o600 });
  // codex round-5 P2: writeFileSync's `mode` only applies on CREATE and is
  // umask-masked — an explicit chmod makes the rewritten file deterministically
  // 0600 (matching setProviderKey), so a remaining key is never left exposed
  // and never refused by readCredentialsFile's perm gate on the next command.
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* best-effort */
  }
  fs.renameSync(tmp, file);
  return { path: file, removed: true, fileDeleted: false };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** A display-safe fingerprint — last 4 chars only, never the body. */
export function maskKey(key: string): string {
  if (key.length <= 4) return '••••';
  return `…${key.slice(-4)}`;
}
