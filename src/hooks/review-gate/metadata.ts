/**
 * OS / agent / repo identity collection for audit records.
 *
 * Closes defect M (0.9.4): the bash core's `jq --arg os_pid "$PID"` wrote
 * the pid as a JSON string; the audit consumer expected an integer, and the
 * schema had to tolerate both. The TS port emits pid/ppid as numbers from
 * day one (the JS runtime's `process.pid` is already a `number`), removing
 * the whole class of jq `--arg` vs `--argjson` confusion.
 *
 * ## Why capture this at all
 *
 * A skip-audit record (`REA_SKIP_PUSH_REVIEW` / `REA_SKIP_CODEX_REVIEW`) is
 * the one place the gate is voluntarily weakened. The actor field (from
 * `git config user.email`) is mutable — a process with write access to
 * `.git/config` can stamp any email it likes. Supplementing that with
 * non-forgeable host-level identity (uid, hostname, pid, ppid, tty, CI
 * flag) gives a forensic investigator something to cross-reference when
 * a skip record turns out to have been unauthorized.
 *
 * ## Determinism + testability
 *
 * Every collector is a plain function over `process` / `os` / `node:child_process`
 * so tests can stub the collector's inputs cleanly. The public API takes no
 * arguments (production use) and the helpers are exported for tests.
 */

import { hostname, userInfo } from 'node:os';
import { spawnSync } from 'node:child_process';

export interface OsIdentity {
  /** POSIX uid as a string (empty when not available — Windows). */
  uid: string;
  /** `whoami` output — username or empty string. */
  whoami: string;
  /** `hostname` output. */
  hostname: string;
  /** This process's pid — number, not string (defect M). */
  pid: number;
  /** Parent process's pid — number, not string (defect M). */
  ppid: number;
  /** `ps -o command= -p $PPID` output, capped at 512 bytes. */
  ppid_cmd: string;
  /** `tty` output or `"not-a-tty"`. */
  tty: string;
  /** `CI` env var value or empty string. */
  ci: string;
}

/**
 * Collect current-process OS identity. Every individual collector degrades
 * to an empty-string fallback on any exception — matching the bash core's
 * `id -u || echo ""`, `whoami || echo ""`, `hostname || echo ""` pattern
 * (push-review-core.sh §420-422, 426). Codex pass-1 on phase 1 flagged
 * the earlier implementation that called `userInfo()` and `hostname()`
 * outside any try/catch and could therefore throw on hosts with broken
 * NSS/passwd lookups, which would silently block the skip-audit path.
 */
export function collectOsIdentity(): OsIdentity {
  const { uid, whoami } = readUidAndWhoami();
  const host = readHostname();
  const pid = process.pid;
  const ppid = process.ppid;
  const ppid_cmd = readPpidCommand(ppid);
  const tty = readTty();
  const ci = process.env['CI'] ?? '';
  return { uid, whoami, hostname: host, pid, ppid, ppid_cmd, tty, ci };
}

/**
 * Read POSIX uid + whoami. Each field is collected INDEPENDENTLY so a
 * partial-lookup-failure (e.g. LDAP/NSS returns the uid but no passwd
 * entry) still yields one field rather than dropping both. Bash-core
 * parity (push-review-core.sh §420-421): `id -u` and `whoami` are two
 * separate invocations, each with its own `|| echo ""` fallback.
 *
 * Codex pass-2 on phase 1 flagged the prior single-`userInfo()` version:
 * a broken NSS lookup zeroed out both fields at once, weakening forensic
 * metadata on shared hosts. We now prefer the POSIX primitives
 * (`os.userInfo()` internally reads the passwd entry) but isolate the
 * failures so uid and whoami cannot both disappear together when only
 * one of them is actually unavailable.
 */
export function readUidAndWhoami(): { uid: string; whoami: string } {
  let uid = '';
  let whoami = '';
  try {
    // Node exposes the raw numeric uid via process.getuid() on POSIX —
    // this goes through the kernel, not through passwd. If it throws
    // (Windows), the fallback is '' and we still try whoami below.
    const getuid = (process as unknown as { getuid?: () => number }).getuid;
    if (typeof getuid === 'function') {
      const raw = getuid.call(process);
      if (typeof raw === 'number' && raw >= 0) uid = String(raw);
    }
  } catch {
    // swallow — uid stays ''
  }
  try {
    const info = userInfo({ encoding: 'utf8' });
    whoami = info.username ?? '';
    // If the kernel-uid probe above failed but userInfo() succeeded, use
    // its uid as a secondary source.
    if (uid.length === 0 && typeof info.uid === 'number' && info.uid >= 0) {
      uid = String(info.uid);
    }
  } catch {
    // swallow — whoami stays ''
  }
  return { uid, whoami };
}

/**
 * Read `hostname` via `os.hostname`. Returns an empty string on any error.
 * Exported for unit tests.
 */
export function readHostname(): string {
  try {
    return hostname();
  } catch {
    return '';
  }
}

/**
 * Read `ps -o command= -p <ppid>` safely. Returns the (truncated) command
 * or an empty string on any failure.
 *
 * Security: args are passed as an array, never interpolated into a shell
 * string. `ps` is the only executable spawned.
 */
export function readPpidCommand(ppid: number): string {
  if (!Number.isFinite(ppid) || ppid <= 0) return '';
  try {
    const result = spawnSync('ps', ['-o', 'command=', '-p', String(ppid)], {
      encoding: 'utf8',
      timeout: 2_000,
    });
    if (result.status !== 0) return '';
    const out = (result.stdout ?? '').replace(/\n+$/, '');
    return out.slice(0, 512);
  } catch {
    return '';
  }
}

/**
 * Return the actual controlling tty path (e.g. `/dev/ttys001`) when one
 * exists, or the literal string `not-a-tty` otherwise. Bash-core parity
 * (push-review-core.sh §426): `tty 2>/dev/null || echo "not-a-tty"`.
 *
 * Codex pass-1 on phase 1 flagged the earlier `/dev/tty` literal as a
 * parity regression — the audit consumer expects the real device path so
 * forensic tooling can distinguish tty1 from tty2 on the same host.
 *
 * Implementation: we shell out to `tty(1)` exactly as bash does. On
 * systems without `tty` (distroless, minimal Alpine without coreutils-
 * full) we degrade to `not-a-tty`.
 */
export function readTty(): string {
  try {
    const result = spawnSync('tty', [], {
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    if (result.status === 0) {
      const out = (result.stdout ?? '').replace(/\n+$/, '');
      if (out.length > 0) return out;
    }
  } catch {
    // fall through to the not-a-tty fallback
  }
  return 'not-a-tty';
}
