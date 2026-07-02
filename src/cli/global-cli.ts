/**
 * Shared resolution + safety module for the opt-in GLOBAL rea CLI tier.
 *
 * WHY THIS EXISTS
 * ---------------
 * Phase 1b landed the bash shim's global resolver in `hooks/_lib/shim-runtime.sh`
 * (`shim_global_entry_gate`, `shim_sandbox_check_global`): it resolves a
 * per-user rea CLI from `<pw_dir>/.rea/cli`, gated by a per-user allow-list
 * `<pw_dir>/.rea/trusted-projects`, and derives `pw_dir` from the PASSWORD
 * DATABASE (`os.userInfo().homedir`), NEVER from `$HOME`/`$XDG_*` — an agent can
 * set those in-process, so an env-derived root is the N3 redirect surface the
 * tier closes. A trust root an agent can move is not a trust root.
 *
 * This module is the TypeScript MIRROR of that bash logic, consumed by the
 * writer-side CLIs (`rea trust` / `rea untrust` / `rea install --global`) and by
 * `rea doctor` (Phase 3b). The bash shim is the pre-CLI authority; a parity test
 * binds this mirror to it (Phase 3b F1).
 *
 * TEST-ISOLATION CONTRACT
 * -----------------------
 * `pw_dir` is `os.userInfo().homedir` — passwd-derived and therefore ENV-IMMUNE
 * by design, so tests CANNOT redirect it with `$HOME`/`$XDG`. Every function that
 * touches the per-user root instead takes the home dir as a parameter that
 * DEFAULTS to `os.userInfo().homedir` at the call site. Production entrypoints
 * pass the default; tests inject a temp dir and stay hermetic without ever
 * mutating the real `~/.rea/`. NO CLI FLAG exposes this parameter — that would
 * re-introduce the env-redirect threat we are closing.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { err } from './utils.js';

/**
 * The passwd-derived home directory. Isolated in one helper so every default
 * parameter reads from the same source. Reads the password database via libuv
 * `getpwuid_r`, NOT the environment. Throws on a squashed/absent passwd entry —
 * the caller decides whether that is fatal (writer CLIs) or a silent
 * tier-unavailable (the shim already handles that side in bash).
 */
export function passwdHome(): string {
  return os.userInfo().homedir;
}

// ---------------------------------------------------------------------------
// Path derivation — passwd-rooted, never env-rooted
// ---------------------------------------------------------------------------

/** `<home>/.rea` — the per-user rea config root. */
export function reaDir(home: string = passwdHome()): string {
  return path.join(home, '.rea');
}

/** `<home>/.rea/cli` — where `npm install --prefix` drops the global CLI tree. */
export function globalRoot(home: string = passwdHome()): string {
  return path.join(reaDir(home), 'cli');
}

/** `<home>/.rea/trusted-projects` — the per-user global-CLI allow-list. */
export function registryPath(home: string = passwdHome()): string {
  return path.join(reaDir(home), 'trusted-projects');
}

// ---------------------------------------------------------------------------
// Governed-session mutation guard (codex design-gate P1-5)
// ---------------------------------------------------------------------------

/** One walked process's parent PID + command name. */
export interface ProcInfo {
  ppid: number;
  comm: string;
}

/** Reads a single pid's `{ ppid, comm }`, or `null` when it can't be read. */
export type ProcReader = (pid: number) => ProcInfo | null;

/**
 * Default process reader: Linux `/proc/<pid>/comm` + `/proc/<pid>/status`
 * (PPid), else macOS/BSD `ps -o ppid=,comm= -p <pid>`. Best-effort — any
 * failure returns `null` (which stops the walk fail-safe, never throwing).
 * Mirrors `hooks/_lib/shim-cache.sh`'s session-token ancestry walk.
 */
export function defaultProcReader(pid: number): ProcInfo | null {
  // Linux /proc fast path.
  try {
    const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/^PPid:\s*(\d+)/m);
    if (comm.length > 0) return { ppid: m ? Number(m[1]) : 0, comm };
  } catch {
    /* not Linux, or /proc unreadable — fall through to ps */
  }
  // macOS / BSD via ps.
  try {
    const r = spawnSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    if (r.status === 0 && typeof r.stdout === 'string') {
      const line = r.stdout.trim();
      const mm = line.match(/^(\d+)\s+(.*)$/);
      if (mm) return { ppid: Number(mm[1]), comm: (mm[2] ?? '').trim() };
      if (/^\d+$/.test(line)) return { ppid: Number(line), comm: '' };
    }
  } catch {
    /* ps missing / error — undeterminable */
  }
  return null;
}

/**
 * Walk the parent-PID chain (bounded depth) looking for a `claude` /
 * `claude-code` ancestor. Returns `true` only on a POSITIVE match; `false` on
 * not-found OR any undeterminable step (fail-safe — an undeterminable walk
 * degrades the guard to the `CLAUDE_PROJECT_DIR` signal alone, it never weakens
 * to "allow" when ancestry says claude). A plain human terminal is not a claude
 * descendant → no false positive; a human using Claude Code's `!` shell IS a
 * descendant → correctly detected (trust is out-of-band).
 */
export function isClaudeAncestor(
  reader: ProcReader = defaultProcReader,
  startPid: number = typeof process.ppid === 'number' ? process.ppid : 0,
  maxHops = 12,
): boolean {
  let cur = startPid;
  for (let hops = 0; hops < maxHops && cur > 1; hops += 1) {
    let info: ProcInfo | null;
    try {
      info = reader(cur);
    } catch {
      return false; // fail-safe
    }
    if (info === null) return false;
    const base = path.basename(info.comm);
    if (base === 'claude' || base === 'claude-code') return true;
    const next = info.ppid;
    if (!Number.isInteger(next) || next <= 1 || next === cur) break;
    cur = next;
  }
  return false;
}

/**
 * Refuse a `~/.rea`-MUTATING command when running under a Claude Code agent
 * session. TWO independent signals, either of which triggers a refusal:
 *   1. `CLAUDE_PROJECT_DIR` is set + non-empty (rea's established "running under
 *      Claude Code" signal — the reaRoot source in `src/cli/hook.ts`, set for
 *      every agent Bash call).
 *   2. A `claude` / `claude-code` process is an ancestor (codex P1: signal (1)
 *      alone is bypassable — `CLAUDE_PROJECT_DIR= rea trust`,
 *      `env -u CLAUDE_PROJECT_DIR rea trust` clear the var in the child, which a
 *      subprocess CANNOT do for its own parent chain).
 *
 * The three mutating commands (`trust`, `untrust`, `install --global`) call this
 * FIRST. Trust must be established by a HUMAN in a plain shell OUTSIDE the agent
 * loop — the real dual-consent. The Write-tier scanner protects literal
 * `~/.rea` writes; this closes the INDIRECT `rea trust`-writes-there path the
 * scanner cannot see statically, AND which a bash command-string matcher cannot
 * catch either (`node <path>/dist/cli/index.js trust`, `npx --no-install …
 * trust`, wrapped shells all bypass a string matcher — the CLI is the only real
 * chokepoint).
 *
 * NO override env — the strictness IS the dual-consent. Read-only commands
 * (`trust --list`) are NOT guarded. Fail-safe: an undeterminable ancestry walk
 * falls back to the `CLAUDE_PROJECT_DIR` signal alone (never weakens).
 *
 * Returns the refusal exit code (`1`) after emitting to stderr when governed;
 * returns `null` when allowed. The `procReader` is injectable so tests stay
 * hermetic + cross-platform.
 */
export function assertNotGovernedSession(
  cmdLabel: string,
  home: string = passwdHome(),
  deps: { procReader?: ProcReader } = {},
): number | null {
  const cpd = process.env.CLAUDE_PROJECT_DIR;
  const cpdSet = cpd !== undefined && cpd.length > 0;
  const ancestor = isClaudeAncestor(deps.procReader ?? defaultProcReader);
  if (cpdSet || ancestor) {
    const via = cpdSet
      ? 'CLAUDE_PROJECT_DIR is set'
      : 'a Claude Code process is an ancestor of this one';
    err(
      `rea ${cmdLabel} mutates your per-user trust root (${reaDir(home)}). ` +
        `This is a human action — run it in a plain shell OUTSIDE the agent session ` +
        `(detected an agent session: ${via}). Refusing.`,
    );
    return 1;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Registry file contract (design §6)
// ---------------------------------------------------------------------------

/**
 * Fixed advisory header (design §6): the first line is bound verbatim; the two
 * following `#` lines are advisory. Fixed content keeps the file byte-idempotent
 * (devex F3). The header is `grep -Fxq`-immune: realpath queries start with `/`
 * and never match a `#` line.
 */
export const REGISTRY_HEADER_LINES: readonly string[] = [
  '# rea trusted-projects (v1) — managed by rea trust/untrust',
  '# One absolute project realpath per line; membership is an exact whole-line match.',
  '# Managed automatically — edit via `rea trust` / `rea untrust`, not by hand.',
];

const REGISTRY_HEADER = `${REGISTRY_HEADER_LINES.join('\n')}\n`;

/**
 * Reject a project path that would corrupt the one-realpath-per-line registry
 * format or be silently dropped by {@link writeRegistry}. Any C0 control
 * character (`\x00`–`\x1f`: NUL, tab, LF, **CR**, …) breaks the whole-line
 * contract — a `\r` in particular is treated as malformed by
 * {@link isWellFormedMemberLine}, so a writer that skipped this check would
 * report success and then silently drop the entry.
 *
 * This is the SHARED rejection point every registry-writing entrypoint
 * (`rea trust`, `rea install --global --trust`) MUST consult BEFORE reporting
 * success. Returns a short human-readable reason on rejection, or `null` when
 * the path is safe to store.
 */
export function projectPathControlCharReason(realpath: string): string | null {
  // C0 control range \x00–\x1f (NUL, tab, LF, CR, …) — exactly what we reject.
  if (/[\x00-\x1f]/.test(realpath)) return 'contains control characters';
  return null;
}

/**
 * Is `line` a well-formed member line? A member = a bare absolute path with no
 * control characters (NUL / tab / LF / CR / …) and no surrounding whitespace (a
 * leading-space line would never `grep -Fxq`-match a trimmed query, so we treat
 * it as malformed). Comment/blank lines are NOT members (inert to the reader).
 * The control-character test is the shared {@link projectPathControlCharReason}
 * so the reader and the writer-side validators can never drift.
 */
export function isWellFormedMemberLine(line: string): boolean {
  if (typeof line !== 'string') return false;
  if (line.length === 0) return false;
  if (line.charAt(0) !== '/') return false; // absolute only; also excludes `#`
  if (projectPathControlCharReason(line) !== null) return false; // NUL/LF/CR/tab/…
  if (line.trim() !== line) return false; // no surrounding whitespace
  return true;
}

/**
 * Read the registry's MEMBER lines (design §6 reader). Skips `#`-prefixed and
 * blank lines; returns every remaining non-blank line verbatim (no trimming —
 * whole-line semantics mirror `grep -Fxq`). Absent/unreadable file → `[]`.
 *
 * This is a lenient read: it returns candidate lines as-stored (including any
 * malformed content a hand-edit introduced) so the writer can normalize + drop
 * them on the next rewrite. Use {@link isProjectTrusted} for a membership test.
 */
export function readRegistry(home: string = passwdHome()): string[] {
  let content: string;
  try {
    content = fs.readFileSync(registryPath(home), 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of content.split('\n')) {
    if (line.length === 0) continue; // blank
    if (line.charAt(0) === '#') continue; // comment
    out.push(line);
  }
  return out;
}

/**
 * Exact whole-line membership test (mirrors the shim's `grep -Fxq -- "$p"`).
 * `projRealpath` is expected to be an absolute realpath. A comment line can
 * never match because queries start with `/`.
 */
export function isProjectTrusted(projRealpath: string, home: string = passwdHome()): boolean {
  if (typeof projRealpath !== 'string' || projRealpath.length === 0) return false;
  let content: string;
  try {
    content = fs.readFileSync(registryPath(home), 'utf8');
  } catch {
    return false;
  }
  for (const line of content.split('\n')) {
    if (line === projRealpath) return true;
  }
  return false;
}

/**
 * Full-rewrite the registry (design §6 writer). NEVER appends. Normalizes the
 * given paths: drops malformed lines (with a single one-line stderr notice),
 * then dedups + sorts + joins with a single trailing LF after the fixed header.
 * Byte-idempotent: `writeRegistry(home, readRegistry(home))` reproduces the file
 * byte-for-byte for well-formed input.
 *
 * Atomicity: ensures `<home>/.rea` exists `0700`, writes the normalized content
 * to `<home>/.rea/.trusted-projects.tmp.<pid>` under `umask 077` + explicit
 * `chmod 0600`, then `rename()`s over the target. On failure the tmp file is
 * unlinked and the original is left intact.
 *
 * SAFETY: this helper does NOT gate on ownership/symlink/permissions — callers
 * MUST run {@link checkReaDirSafety} first and surface the remediation string.
 * It ensures the dir exists but refuses nothing.
 */
export function writeRegistry(paths: string[], home: string = passwdHome()): void {
  const dir = reaDir(home);
  const target = registryPath(home);

  // Normalize: drop malformed, dedup, sort. One aggregate stderr notice.
  const wellFormed: string[] = [];
  let dropped = 0;
  for (const p of paths) {
    if (isWellFormedMemberLine(p)) wellFormed.push(p);
    else dropped += 1;
  }
  if (dropped > 0) {
    process.stderr.write(
      `[rea] WARN: dropped ${dropped} malformed line(s) while rewriting the trusted-projects registry\n`,
    );
  }
  const normalized = [...new Set(wellFormed)].sort();
  const content =
    normalized.length > 0 ? `${REGISTRY_HEADER}${normalized.join('\n')}\n` : REGISTRY_HEADER;

  // Ensure the config root exists as a real 0700 dir. mkdir mode is masked by
  // the process umask on some platforms, so chmod explicitly (best-effort).
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    /* best-effort: some filesystems reject chmod; the 0600 file is the gate */
  }

  const tmp = path.join(dir, `.trusted-projects.tmp.${process.pid}`);
  const prevUmask = process.umask(0o077);
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    // writeFileSync's `mode` only applies on CREATE and is umask-masked; an
    // explicit chmod makes the file deterministically 0600.
    try {
      fs.chmodSync(tmp, 0o600);
    } catch {
      /* best-effort */
    }
    // rename replaces the destination PATH atomically (not a symlink target).
    fs.renameSync(tmp, target);
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw e;
  } finally {
    process.umask(prevUmask);
  }
}

/**
 * Delete the registry file (used when `trust`/`untrust` empties it). Missing
 * file is not an error. Does NOT touch the `<home>/.rea` dir.
 */
export function deleteRegistry(home: string = passwdHome()): void {
  fs.rmSync(registryPath(home), { force: true });
}

// ---------------------------------------------------------------------------
// Safety gates — mirror the shim A5.3a (dir) / A5.3b (file) walks
// ---------------------------------------------------------------------------

export type SafetyReason =
  | 'symlink'
  | 'not-dir'
  | 'not-file'
  | 'foreign-owner'
  | 'world-writable'
  | 'bad-mode'
  | 'bad-nlink';

export interface SafetyOk {
  ok: true;
  /** True when the path does not exist yet (a to-be-created target — safe). */
  absent: boolean;
}

export interface SafetyFail {
  ok: false;
  code: SafetyReason;
  /** Human-readable reason (no remediation verb). */
  reason: string;
  /** The exact shell command to fix it (design §9 remediation strings). */
  remediation: string;
}

export type SafetyResult = SafetyOk | SafetyFail;

/** POSIX uid check availability. On Windows `process.getuid` is undefined. */
function currentUid(): number | undefined {
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

/**
 * Validate `<home>/.rea` (mirrors shim A5.3a). Rejects a symlink, a non-dir, a
 * foreign owner, or a group/other-writable dir (`mode & 0o022`). An ABSENT dir
 * is safe (`{ ok: true, absent: true }`) — the writer creates it 0700. Never
 * lstats `<home>` or above (firmlinks / BSD `/home` symlinks legitimately live
 * there).
 */
export function checkReaDirSafety(home: string = passwdHome()): SafetyResult {
  const dir = reaDir(home);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return { ok: true, absent: true };
  }
  if (st.isSymbolicLink()) {
    return {
      ok: false,
      code: 'symlink',
      reason: `${dir} is a symlink — refusing (a symlink could redirect the global CLI outside the private root)`,
      remediation: `rm ${dir}`,
    };
  }
  if (!st.isDirectory()) {
    return {
      ok: false,
      code: 'not-dir',
      reason: `${dir} exists but is not a directory`,
      remediation: `rm ${dir}`,
    };
  }
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid) {
    return {
      ok: false,
      code: 'foreign-owner',
      reason: `${dir} is not owned by the current user (owner uid=${st.uid}) — refusing`,
      remediation: `chown ${uid} ${dir}`,
    };
  }
  if (uid !== undefined && (st.mode & 0o022) !== 0) {
    return {
      ok: false,
      code: 'world-writable',
      reason: `${dir} is group/other-writable (mode ${(st.mode & 0o777).toString(8)}) — refusing`,
      remediation: `chmod 700 ${dir}`,
    };
  }
  return { ok: true, absent: false };
}

/**
 * Validate `<home>/.rea/trusted-projects` (mirrors shim A5.3b). Rejects a
 * symlink, a non-regular file, a foreign owner, a group/other-ACCESSIBLE file
 * (`mode & 0o077`, the strict 0600 mask — NOT the 0o022 dir mask), or a
 * hardlinked file (`nlink !== 1`; a pre-existing in-project hardlink is a
 * same-uid mutation primitive — codex P2-7). An ABSENT registry is safe
 * (`{ ok: true, absent: true }`) — nothing is trusted yet.
 */
export function checkRegistrySafety(home: string = passwdHome()): SafetyResult {
  const reg = registryPath(home);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(reg);
  } catch {
    return { ok: true, absent: true };
  }
  if (st.isSymbolicLink()) {
    return {
      ok: false,
      code: 'symlink',
      reason: `${reg} is a symlink — refusing (a symlink could redirect the trust read)`,
      remediation: `rm ${reg}`,
    };
  }
  if (!st.isFile()) {
    return {
      ok: false,
      code: 'not-file',
      reason: `${reg} is not a regular file`,
      remediation: `rm ${reg}`,
    };
  }
  const uid = currentUid();
  if (uid !== undefined && st.uid !== uid) {
    return {
      ok: false,
      code: 'foreign-owner',
      reason: `${reg} is not owned by the current user (owner uid=${st.uid}) — refusing`,
      remediation: `chown ${uid} ${reg}`,
    };
  }
  if (uid !== undefined && (st.mode & 0o077) !== 0) {
    return {
      ok: false,
      code: 'bad-mode',
      reason: `${reg} is group/other-accessible (mode ${(st.mode & 0o777).toString(8)}) — refusing`,
      remediation: `chmod 600 ${reg}`,
    };
  }
  if (st.nlink !== 1) {
    return {
      ok: false,
      code: 'bad-nlink',
      reason: `${reg} has ${st.nlink} hard links — refusing (a hardlinked registry is a same-uid mutation primitive)`,
      remediation: `rm ${reg} (then re-run \`rea trust\`)`,
    };
  }
  return { ok: true, absent: false };
}

// ---------------------------------------------------------------------------
// Resolver — probe the two global CLI shapes (design §1)
// ---------------------------------------------------------------------------

/**
 * Probe the global CLI under `<home>/.rea/cli`: (1) the `npm install --prefix`
 * shape `node_modules/@bookedsolid/rea/dist/cli/index.js`, then (2) the
 * bare-drop fallback `dist/cli/index.js`. Returns the first existing candidate
 * path, or `null` when neither exists (not installed). Pure existence probe —
 * pair it with {@link checkGlobalCandidateSafety} to reproduce the shim's
 * A1–A4 sandbox before treating the candidate as the active tier.
 */
export function resolveGlobalCli(home: string = passwdHome()): string | null {
  const root = globalRoot(home);
  const c1 = path.join(root, 'node_modules', '@bookedsolid', 'rea', 'dist', 'cli', 'index.js');
  if (fs.existsSync(c1)) return c1;
  const c2 = path.join(root, 'dist', 'cli', 'index.js');
  if (fs.existsSync(c2)) return c2;
  return null;
}

/**
 * Read the `version` of the currently-installed global CLI from the
 * `package.json` beside whichever install shape {@link resolveGlobalCli}
 * matched: (1) `node_modules/@bookedsolid/rea/package.json` (npm-prefix shape),
 * then (2) `<gRoot>/package.json` (bare-drop). Best-effort (BOM-tolerant); a
 * leading UTF-8 BOM is stripped. Returns `null` when neither shape carries a
 * readable non-empty `version`. Used by `rea install --global` to decide
 * whether a requested `--version` differs from what is already on disk.
 */
export function installedGlobalCliVersion(home: string = passwdHome()): string | null {
  const root = globalRoot(home);
  const candidates = [
    path.join(root, 'node_modules', '@bookedsolid', 'rea', 'package.json'),
    path.join(root, 'package.json'),
  ];
  for (const p of candidates) {
    let raw: string;
    try {
      raw = fs.readFileSync(p, 'utf8');
    } catch {
      continue;
    }
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1); // strip UTF-8 BOM
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const v = (parsed as Record<string, unknown>)['version'];
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return null;
}

/** Result of the `rea hook policy-get` capability probe. */
export interface GlobalCliCapability {
  ok: boolean;
  stderr?: string;
}

/**
 * Prove a resolved global CLI implements `rea hook policy-get` — the subcommand
 * the global-tier shim invokes for the `allow_global_cli` veto read
 * (`shim_run` step 4-global-veto). Spawns `node <cliPath> hook policy-get
 * --help`; a non-zero exit means the CLI predates the `hook policy-get`
 * subcommand (~0.26.0) and the shim would fall back to no-CLI at the veto step.
 *
 * This is the ONE shared implementation consumed by both `rea install --global`
 * (as the post-install backstop) and `rea doctor` (the global-tier floor), so
 * the two surfaces never drift. Signature-compatible with install's injectable
 * `probeCapability` dep — tests inject a fake to stay hermetic; NO CLI flag
 * exposes it.
 */
export function probeGlobalCliCapability(cliPath: string): GlobalCliCapability {
  const r = spawnSync('node', [cliPath, 'hook', 'policy-get', '--help'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (r.status === 0) return { ok: true };
  return { ok: false, stderr: (r.stderr ?? '').toString().trim() };
}

// ---------------------------------------------------------------------------
// Candidate sandbox — mirror of the shim's A1–A4 (shim_sandbox_check_global)
// ---------------------------------------------------------------------------

export type GlobalCandidateFailCode =
  | 'symlink'
  | 'perm'
  | 'hardlink'
  | 'escapes-root'
  | 'shape'
  | 'no-rea-pkg'
  | 'unavailable';

export interface GlobalCandidateOk {
  ok: true;
  /** `realpath(candidate)` — the validated path the shim would execute. */
  realpath: string;
}

export interface GlobalCandidateFail {
  ok: false;
  code: GlobalCandidateFailCode;
  /** Human-readable reason (no remediation verb). */
  reason: string;
}

export type GlobalCandidateSafety = GlobalCandidateOk | GlobalCandidateFail;

/**
 * Reproduce the bash shim's A1–A4 candidate sandbox (`shim_sandbox_check_global`
 * in `hooks/_lib/shim-runtime.sh`) over a resolved global CLI candidate. This is
 * the missing half of {@link resolveGlobalCli}: existence alone is NOT enough to
 * treat a candidate as runnable — the shim ALSO refuses a hostile/malformed tree
 * (blessed-but-hostile), and `rea doctor` must refuse identically or it would
 * claim `global` for a candidate the shim falls back from.
 *
 * Evaluation order mirrors the shim (cheapest/most-decisive first):
 *   - A2  per-component `lstat` walk from the candidate UP TO AND INCLUDING
 *         `<home>/.rea` (= `dirname(gRoot)`; STOP there — never lstat the home
 *         dir or above, where firmlinks / BSD `/home` symlinks legitimately
 *         live). Reject ANY symlink component, foreign owner, group/other-write
 *         (`mode & 0o022`), or a device-number change vs `gRoot` (mount/bind
 *         aliasing). The candidate `index.js` itself must have `nlink === 1`.
 *   - A1  `realpath(candidate)` contained in `realpath(gRoot)`.
 *   - A4  realpath ends in `dist/cli/index.js` (ALWAYS-on for the global tier).
 *   - A3  an ancestor `package.json` (≤20 hops) has `name === "@bookedsolid/rea"`
 *         AND that `package.json` has `nlink === 1`.
 *
 * `unavailable` (an `lstat`/`realpath` that threw — ENOENT / automount) is
 * surfaced as a fail here because doctor treats "sandbox did not confirm safe"
 * the same as "not the active tier": the shim likewise does NOT set the global
 * CLI in that case. Callers map ANY `ok:false` to "global tier NOT active".
 */
export function checkGlobalCandidateSafety(
  candidate: string,
  gRoot: string,
  home: string = passwdHome(),
): GlobalCandidateSafety {
  const uid = currentUid();
  // Walk stops at <home>/.rea (= dirname(gRoot)); never lstat home or above.
  const stopDir = reaDir(home);
  const sep = path.sep;

  // Capture gRoot's device number for the mount/bind aliasing check (A2).
  let gRootDev: number;
  try {
    gRootDev = fs.lstatSync(gRoot).dev;
  } catch {
    return { ok: false, code: 'unavailable', reason: `${gRoot} is not accessible` };
  }

  // A2 — per-component lstat walk: candidate UP TO AND INCLUDING stopDir.
  let comp = candidate;
  let first = true;
  let guard = 0;
  for (;;) {
    guard += 1;
    if (guard > 128) {
      return { ok: false, code: 'perm', reason: `pathological path depth resolving ${candidate}` };
    }
    let st: fs.Stats;
    try {
      st = fs.lstatSync(comp);
    } catch {
      return { ok: false, code: 'unavailable', reason: `${comp} is not accessible` };
    }
    if (st.isSymbolicLink()) {
      return {
        ok: false,
        code: 'symlink',
        reason: `${comp} is a symlink — refusing (a symlink component could redirect the global CLI)`,
      };
    }
    if (uid !== undefined && st.uid !== uid) {
      return {
        ok: false,
        code: 'perm',
        reason: `${comp} is not owned by the current user (owner uid=${st.uid})`,
      };
    }
    if (uid !== undefined && (st.mode & 0o022) !== 0) {
      return {
        ok: false,
        code: 'perm',
        reason: `${comp} is group/other-writable (mode ${(st.mode & 0o777).toString(8)})`,
      };
    }
    if (st.dev !== gRootDev) {
      return {
        ok: false,
        code: 'perm',
        reason: `${comp} is on a different filesystem than ${gRoot} (mount/bind aliasing)`,
      };
    }
    if (first) {
      if (st.nlink !== 1) {
        return {
          ok: false,
          code: 'hardlink',
          reason: `${candidate} has ${st.nlink} hard links — refusing`,
        };
      }
      first = false;
    }
    if (comp === stopDir) break;
    const parent = path.dirname(comp);
    if (parent === comp) break; // reached fs root without hitting stopDir
    comp = parent;
  }

  // A1 — realpath containment.
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return { ok: false, code: 'unavailable', reason: `realpath failed for ${candidate}` };
  }
  try {
    realRoot = fs.realpathSync(gRoot);
  } catch {
    return { ok: false, code: 'unavailable', reason: `realpath failed for ${gRoot}` };
  }
  const rootSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
  if (!(real === realRoot || real.startsWith(rootSep))) {
    return { ok: false, code: 'escapes-root', reason: `${real} escapes ${realRoot}` };
  }

  // A4 — dist/cli/index.js shape (ALWAYS-on for the global tier).
  const endWith = path.join('dist', 'cli', 'index.js');
  if (!(real.endsWith(sep + endWith) || real === sep + endWith)) {
    return { ok: false, code: 'shape', reason: `${real} does not end in ${endWith}` };
  }

  // A3 — ancestor package.json name @bookedsolid/rea + nlink === 1.
  let cur = path.dirname(path.dirname(path.dirname(real)));
  let pkg = '';
  for (let i = 0; i < 20 && cur && cur !== path.dirname(cur); i += 1) {
    const pj = path.join(cur, 'package.json');
    if (fs.existsSync(pj)) {
      try {
        const data = JSON.parse(fs.readFileSync(pj, 'utf8')) as { name?: unknown };
        if (data && data.name === '@bookedsolid/rea') {
          pkg = pj;
          break;
        }
      } catch {
        // keep walking — a malformed package.json on the path is not fatal
      }
    }
    cur = path.dirname(cur);
  }
  if (pkg === '') {
    return {
      ok: false,
      code: 'no-rea-pkg',
      reason: `no ancestor package.json declaring @bookedsolid/rea above ${real}`,
    };
  }
  let ps: fs.Stats;
  try {
    ps = fs.lstatSync(pkg);
  } catch {
    return { ok: false, code: 'no-rea-pkg', reason: `${pkg} is not accessible` };
  }
  if (ps.nlink !== 1) {
    return { ok: false, code: 'hardlink', reason: `${pkg} has ${ps.nlink} hard links — refusing` };
  }

  return { ok: true, realpath: real };
}
