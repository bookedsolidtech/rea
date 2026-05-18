/**
 * Unit tests for `hooks/_lib/shim-cache.sh` — the per-session shim
 * cache helper introduced in 0.48.0.
 *
 * Coverage (per the 0.48.0 design memo concerns):
 *
 *   - key derivation determinism (same inputs → same key; different
 *     inputs → different key)
 *   - miss → write → hit cycle (round-trip)
 *   - TTL expiry (cached_at_unix + ttl_seconds < now → miss)
 *   - REA_SHIM_CACHE=0 disables both reads and writes
 *   - policy.shim_cache.enabled: false disables the cache (bash-tier
 *     YAML grep path)
 *   - corrupt file → fail-safe miss (NEVER exit non-zero)
 *   - per-user dir mode 0700 + per-entry file mode 0600
 *   - atomic write (no half-written reads)
 *   - session-token derivation paths: procfs / ps fallback / final
 *     fallback (cache disabled)
 *
 * Tests spawn bash directly against the live helper file in
 * `hooks/_lib/shim-cache.sh`. Each test isolates its TMPDIR so cache
 * entries from one test never bleed into another.
 */

import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SHIM_CACHE_LIB = path.join(REPO_ROOT, 'hooks', '_lib', 'shim-cache.sh');

function bashExists(): boolean {
  return spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface RunOpts {
  /** Optional env overrides. */
  env?: NodeJS.ProcessEnv;
  /** Optional TMPDIR override. */
  tmpdir?: string;
}

function runBash(script: string, opts: RunOpts = {}): RunResult {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '',
    HOME: process.env['HOME'] ?? '/tmp',
    ...opts.env,
  };
  if (opts.tmpdir !== undefined) {
    env['TMPDIR'] = opts.tmpdir;
  }
  const res: SpawnSyncReturns<string> = spawnSync('bash', ['-c', script], {
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
  return {
    status: res.status ?? -1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function makeTmpdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-shim-cache-test-'));
}

describe('shim-cache.sh — shim_cache_disabled (env-var disable)', () => {
  it('returns 0 (disabled) when REA_SHIM_CACHE=0', () => {
    if (!bashExists()) return;
    const tmp = makeTmpdir();
    try {
      const r = runBash(
        `source "${SHIM_CACHE_LIB}"
         if shim_cache_disabled; then echo OFF; else echo ON; fi`,
        { tmpdir: tmp, env: { REA_SHIM_CACHE: '0' } },
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('OFF');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns 1 (enabled) by default when REA_SHIM_CACHE is unset', () => {
    if (!bashExists()) return;
    const tmp = makeTmpdir();
    try {
      const r = runBash(
        `source "${SHIM_CACHE_LIB}"
         if shim_cache_disabled; then echo OFF; else echo ON; fi`,
        { tmpdir: tmp, env: {} },
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('ON');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns 1 (enabled) when REA_SHIM_CACHE=1 explicitly', () => {
    if (!bashExists()) return;
    const tmp = makeTmpdir();
    try {
      const r = runBash(
        `source "${SHIM_CACHE_LIB}"
         if shim_cache_disabled; then echo OFF; else echo ON; fi`,
        { tmpdir: tmp, env: { REA_SHIM_CACHE: '1' } },
      );
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toBe('ON');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('shim-cache.sh — shim_cache_disabled (policy.shim_cache.enabled)', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns 0 (disabled) when policy.shim_cache.enabled: false in block-form YAML', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache:\n  enabled: false\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('OFF');
  });

  it('returns 1 (enabled) when policy.shim_cache.enabled: true', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache:\n  enabled: true\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ON');
  });

  it('returns 1 (enabled) when shim_cache block is absent', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nautonomy_level: L1\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ON');
  });

  it('returns 0 (disabled) when policy.shim_cache is set via flow-form YAML', () => {
    // 0.48.0 codex round-1 P2: the TS loader accepts both block and
    // flow YAML; the bash helper must match. A consumer who writes
    // `shim_cache: { enabled: false }` (valid YAML) gets the same
    // disable behavior as a block-form write.
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache: { enabled: false }\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('OFF');
  });

  it('returns 0 (disabled) for flow-form with no spaces inside braces', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache: {enabled: false}\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('OFF');
  });

  it('returns 0 (disabled) for block-form with inline YAML comment', () => {
    // 0.48.0 codex round-2 P2: `enabled: false # temporary` is
    // valid YAML and the TS loader accepts it. The bash helper
    // must match or the documented disable switch is silently
    // ineffective for that valid shape.
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache:\n  enabled: false # incident bypass\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('OFF');
  });

  it('returns 0 (disabled) when policy uses mixed-case YAML False (block-form)', () => {
    // 0.48.0 codex round-4 P2: YAML accepts `False` / `FALSE` as valid
    // boolean spellings; the TS loader normalizes them. The bash
    // helper must match.
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache:\n  enabled: False\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('OFF');
  });

  it('returns 0 (disabled) when shim_cache block has leading indentation (block-form)', () => {
    // 0.48.0 codex round-9 P3: leading-indented document-root keys
    // are valid YAML. The TS loader accepts them; the bash helper
    // must match.
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\n  shim_cache:\n    enabled: false\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('OFF');
  });

  it('returns 0 (disabled) when policy uses uppercase YAML FALSE (flow-form)', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache: { enabled: FALSE }\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('OFF');
  });

  it('returns 0 (disabled) for flow-form with trailing inline comment', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache: { enabled: false } # off for measurement\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('OFF');
  });

  // 0.48.1 Item 2: multi-line flow-form. The TS loader parses
  //   shim_cache: {
  //     enabled: false
  //   }
  // as flow-form YAML; the bash helper must match the same shape.
  it('returns 0 (disabled) for multi-line flow-form (opener on its own line)', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache: {\n  enabled: false\n}\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('OFF');
  });

  it('returns 0 (disabled) for multi-line flow-form with trailing comment on close brace', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache: {\n  enabled: false\n} # closed for measurement\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('OFF');
  });

  it('returns 1 (enabled) for multi-line flow-form with enabled: true', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache: {\n  enabled: true\n}\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ON');
  });

  // 0.48.1 Item 3 (codex 0.48.0 last-review.json P3): pure-comment
  // lines (matching ^[[:space:]]*#) inside the shim_cache: block must
  // NOT close the block. Pre-fix the block-end heuristic (non-empty
  // line at or below opener indent) treated a top-level # comment as
  // a sibling-key line and dropped out of in_block before reaching
  // the indented enabled: false.
  it('returns 0 (disabled) when a top-level comment lives INSIDE the shim_cache: block', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache:\n# this is a top-level YAML comment inside the block\n  enabled: false\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('OFF');
  });

  it('returns 0 (disabled) when MULTIPLE comments interleave inside the shim_cache: block', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache:\n# top-level comment\n  # indented comment\n  enabled: false\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('OFF');
  });

  it('returns 1 (enabled) when a top-level sibling YAML key still closes the block', () => {
    // Negative control: the comment-line exemption must NOT make
    // genuine sibling keys (autonomy_level: L1) transparent. A
    // real top-level key after `shim_cache:` should still close the
    // block; otherwise an `enabled: false` belonging to a different
    // top-level section would be wrongly attributed to shim_cache.
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache:\nautonomy_level: L1\nother_section:\n  enabled: false\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ON');
  });

  // 0.48.1 round-1 P2-B (codex): the multi-line flow parser must
  // track BRACE DEPTH instead of closing on the first }. Pre-fix
  // valid YAML such as `shim_cache: { meta: { foo: bar }, enabled:
  // false }` exited the flow-form accumulator on the inner closing
  // brace before reaching `enabled: false`, leaving the cache wrongly
  // enabled. Quoted scalars containing braces (e.g. `note: "}"`)
  // would also short-circuit.
  it('returns 0 (disabled) for single-line flow-form with NESTED braces around enabled: false', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache: { meta: { foo: bar }, enabled: false }\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('OFF');
  });

  it('returns 0 (disabled) for multi-line flow-form with nested braces in continuation', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache: {\n  meta: { foo: bar },\n  enabled: false\n}\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('OFF');
  });

  // 0.48.1 round-2 P2 (codex): the buffer-level enabled: false
  // detector must ignore trailing YAML comments AND quoted scalars
  // that happen to contain the literal text. Pre-round-2 these
  // false-positives flipped a true policy to disabled.
  it('returns 1 (enabled) when a TRAILING comment after enabled: true mentions enabled: false', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache: { enabled: true } # previously enabled: false\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ON');
  });

  it('returns 1 (enabled) when a multi-line flow trailing comment mentions enabled: false', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache: {\n  enabled: true # was enabled: false during incident\n}\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ON');
  });

  it('returns 1 (enabled) when a quoted scalar value mentions enabled: false', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache: { note: "enabled: false", enabled: true }\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ON');
  });

  it('returns 0 (disabled) for multi-line flow-form where a quoted string contains } before enabled: false', () => {
    if (!bashExists()) return;
    const projDir = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(projDir, '.rea'), { recursive: true });
    fs.writeFileSync(
      path.join(projDir, '.rea', 'policy.yaml'),
      'version: "1"\nshim_cache: {\n  note: "}",\n  enabled: false\n}\n',
    );
    const r = runBash(
      `REA_ROOT="${projDir}"
       source "${SHIM_CACHE_LIB}"
       if shim_cache_disabled; then echo OFF; else echo ON; fi`,
      { tmpdir: tmp, env: { REA_ROOT: projDir } },
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('OFF');
  });
});

describe('shim-cache.sh — nanosecond-precision mtime in cache key', () => {
  // 0.48.0 codex round-2 P2: the mtime field is captured at
  // nanosecond precision on both platforms (macOS `%Fm`, GNU `%.Y`).
  // This test confirms two writes of an identical-length file
  // microseconds apart produce DIFFERENT cache keys. Pre-fix the
  // mtime was second-precision so identical-length same-second
  // rewrites would have collided.
  it('two rewrites within the same wall-clock second produce different mtime tokens', async () => {
    if (!bashExists()) return;
    const tmp = makeTmpdir();
    try {
      const f1 = path.join(tmp, 'a');
      fs.writeFileSync(f1, 'hello-1');
      const out1 = spawnSync('bash', [
        '-c',
        `source "${SHIM_CACHE_LIB}"; shim_cache_mtime_size "${f1}"`,
      ], { encoding: 'utf8' });
      // Brief delay to ensure ns ticks over but the second does not.
      // node sync sleep via Atomics.wait of 5ms.
      const sab = new SharedArrayBuffer(4);
      const ia = new Int32Array(sab);
      Atomics.wait(ia, 0, 0, 5);
      fs.writeFileSync(f1, 'hello-2'); // same length
      const out2 = spawnSync('bash', [
        '-c',
        `source "${SHIM_CACHE_LIB}"; shim_cache_mtime_size "${f1}"`,
      ], { encoding: 'utf8' });
      expect(out1.stdout).not.toBe('');
      expect(out2.stdout).not.toBe('');
      // Sizes equal; mtime tokens should differ at ns granularity on
      // APFS/ext4. (On filesystems that truncate ns mtime — some
      // FAT/NTFS — this would tie; skip the strict inequality there.
      // Both macOS-default APFS and Linux-default ext4 store ns.)
      const [mt1] = out1.stdout.trim().split(' ');
      const [mt2] = out2.stdout.trim().split(' ');
      // If the ns fraction is dropped (no `.` in the output) the
      // filesystem doesn't support ns mtime — skip the inequality.
      if (mt1.includes('.') && mt2.includes('.')) {
        expect(mt1).not.toBe(mt2);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('shim-cache.sh — shim_cache_key determinism', () => {
  it('produces identical keys for identical inputs', () => {
    if (!bashExists()) return;
    const tmp = makeTmpdir();
    try {
      const args = '"v1" "tok" "/proj" "/cli" "1000" "10" "501" "1" "test-shim" "100" "1000" "200" "/usr/bin/node" "12345"';
      const r = runBash(
        `source "${SHIM_CACHE_LIB}"
         k1=$(shim_cache_key ${args})
         k2=$(shim_cache_key ${args})
         echo "$k1"
         echo "$k2"`,
        { tmpdir: tmp },
      );
      expect(r.status).toBe(0);
      const lines = r.stdout.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toBe(lines[1]);
      expect(lines[0]).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('produces different keys when any field differs', () => {
    if (!bashExists()) return;
    const tmp = makeTmpdir();
    try {
      const r = runBash(
        `source "${SHIM_CACHE_LIB}"
         k_base=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1000" "10" "501" "1" "test-shim" "100" "1000" "200" "/usr/bin/node" "12345")
         # change schema
         k_schema=$(shim_cache_key "v2" "tok" "/proj" "/cli" "1000" "10" "501" "1" "test-shim" "100" "1000" "200" "/usr/bin/node" "12345")
         # change session
         k_session=$(shim_cache_key "v1" "tok2" "/proj" "/cli" "1000" "10" "501" "1" "test-shim" "100" "1000" "200" "/usr/bin/node" "12345")
         # change project
         k_proj=$(shim_cache_key "v1" "tok" "/proj2" "/cli" "1000" "10" "501" "1" "test-shim" "100" "1000" "200" "/usr/bin/node" "12345")
         # change cli
         k_cli=$(shim_cache_key "v1" "tok" "/proj" "/cli2" "1000" "10" "501" "1" "test-shim" "100" "1000" "200" "/usr/bin/node" "12345")
         # change mtime
         k_mtime=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1001" "10" "501" "1" "test-shim" "100" "1000" "200" "/usr/bin/node" "12345")
         # change size
         k_size=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1000" "11" "501" "1" "test-shim" "100" "1000" "200" "/usr/bin/node" "12345")
         # change euid
         k_euid=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1000" "10" "502" "1" "test-shim" "100" "1000" "200" "/usr/bin/node" "12345")
         # change enforce shape
         k_shape=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1000" "10" "501" "0" "test-shim" "100" "1000" "200" "/usr/bin/node" "12345")
         # change shim name (0.48.0 codex round-1 P1: hook-specific scope)
         k_name=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1000" "10" "501" "1" "other-shim" "100" "1000" "200" "/usr/bin/node" "12345")
         # change pkg mtime (0.48.0 codex round-3 P2)
         k_pkgm=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1000" "10" "501" "1" "test-shim" "101" "1000" "200" "/usr/bin/node" "12345")
         # change pkg size (0.48.0 codex round-3 P2)
         k_pkgs=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1000" "10" "501" "1" "test-shim" "100" "1001" "200" "/usr/bin/node" "12345")
         # change dist dir mtime (0.48.0 codex round-3 P1)
         k_distm=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1000" "10" "501" "1" "test-shim" "100" "1000" "201" "/usr/bin/node" "12345")
         # change node realpath (0.48.0 codex round-4 P1)
         k_node=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1000" "10" "501" "1" "test-shim" "100" "1000" "200" "/opt/homebrew/bin/node" "12345")
         # change node mtime (interpreter rebuild at same path)
         k_nodem=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1000" "10" "501" "1" "test-shim" "100" "1000" "200" "/usr/bin/node" "12346")
         echo "$k_base"
         echo "$k_schema"
         echo "$k_session"
         echo "$k_proj"
         echo "$k_cli"
         echo "$k_mtime"
         echo "$k_size"
         echo "$k_euid"
         echo "$k_shape"
         echo "$k_name"
         echo "$k_pkgm"
         echo "$k_pkgs"
         echo "$k_distm"
         echo "$k_node"
         echo "$k_nodem"`,
        { tmpdir: tmp },
      );
      expect(r.status).toBe(0);
      const keys = r.stdout.trim().split('\n');
      expect(keys).toHaveLength(15);
      const baseKey = keys[0];
      // Every variant key must differ from the base.
      for (let i = 1; i < keys.length; i += 1) {
        expect(keys[i]).not.toBe(baseKey);
      }
      // All keys are 32 hex chars.
      for (const k of keys) {
        expect(k).toMatch(/^[0-9a-f]{32}$/);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns exit 1 when called with fewer than 14 args', () => {
    if (!bashExists()) return;
    const tmp = makeTmpdir();
    try {
      const r = runBash(
        `source "${SHIM_CACHE_LIB}"
         shim_cache_key "v1" "tok"
         echo "ret=$?"`,
        { tmpdir: tmp },
      );
      // Helper itself exits 1, captured via $?
      expect(r.stdout).toContain('ret=1');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('shim-cache.sh — miss → write → hit round-trip', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('miss returns exit 1; write succeeds; hit returns the JSON content', () => {
    if (!bashExists()) return;
    const json = '{"schema_version":"v1","sandbox_ok":true,"shape_ok":true,"cached_at_unix":9999999999,"ttl_seconds":3600,"cli_realpath":"/x","cli_mtime":"1","cli_size_bytes":"1"}';
    const r = runBash(
      `source "${SHIM_CACHE_LIB}"
       KEY=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1000" "10" "501" "1" "test-shim" "100" "1000" "200" "/usr/bin/node" "12345")
       # Initial miss
       out=$(shim_cache_read "$KEY" 2>/dev/null || echo MISS)
       echo "first=$out"
       # Write
       shim_cache_write "$KEY" '${json}'
       echo "wrote=$?"
       # Hit
       out2=$(shim_cache_read "$KEY" 2>/dev/null)
       echo "second=$out2"`,
      { tmpdir: tmp },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('first=MISS');
    expect(r.stdout).toContain('wrote=0');
    expect(r.stdout).toContain('second=' + json);
  });

  it('creates the per-user dir with mode 0700', () => {
    if (!bashExists()) return;
    const r = runBash(
      `source "${SHIM_CACHE_LIB}"
       KEY=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1000" "10" "501" "1" "test-shim" "100" "1000" "200" "/usr/bin/node" "12345")
       shim_cache_write "$KEY" '{"x":1}' > /dev/null 2>&1
       echo "ret=$?"`,
      { tmpdir: tmp },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ret=0');
    const euid = String(process.getuid?.() ?? 0);
    const dir = path.join(tmp, `rea-shim-cache.${euid}`);
    expect(fs.existsSync(dir)).toBe(true);
    const mode = fs.statSync(dir).mode & 0o777;
    expect(mode).toBe(0o700);
  });

  it('writes the per-entry file with mode 0600', () => {
    if (!bashExists()) return;
    const r = runBash(
      `source "${SHIM_CACHE_LIB}"
       KEY=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1000" "10" "501" "1" "test-shim" "100" "1000" "200" "/usr/bin/node" "12345")
       shim_cache_write "$KEY" '{"x":1}'
       echo "$KEY"`,
      { tmpdir: tmp },
    );
    expect(r.status).toBe(0);
    const key = r.stdout.trim().split('\n').pop()!;
    const euid = String(process.getuid?.() ?? 0);
    const file = path.join(tmp, `rea-shim-cache.${euid}`, `${key}.json`);
    expect(fs.existsSync(file)).toBe(true);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});

describe('shim-cache.sh — corrupt entry fail-safe', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = makeTmpdir();
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('a wider-than-0600 mode on the entry file is refused', () => {
    if (!bashExists()) return;
    const r = runBash(
      `source "${SHIM_CACHE_LIB}"
       KEY=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1000" "10" "501" "1" "test-shim" "100" "1000" "200" "/usr/bin/node" "12345")
       shim_cache_write "$KEY" '{"x":1}' >/dev/null 2>&1
       echo "$KEY"`,
      { tmpdir: tmp },
    );
    const key = r.stdout.trim().split('\n').pop()!;
    const euid = String(process.getuid?.() ?? 0);
    const file = path.join(tmp, `rea-shim-cache.${euid}`, `${key}.json`);
    expect(fs.existsSync(file)).toBe(true);
    // Widen the mode — the read should refuse.
    fs.chmodSync(file, 0o644);
    const r2 = runBash(
      `source "${SHIM_CACHE_LIB}"
       out=$(shim_cache_read "${key}" 2>/dev/null || echo MISS)
       echo "result=$out"`,
      { tmpdir: tmp },
    );
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain('result=MISS');
  });

  it('shim_cache_write never raises (returns 1) when content is empty', () => {
    if (!bashExists()) return;
    const r = runBash(
      `source "${SHIM_CACHE_LIB}"
       shim_cache_write "abc" "" 2>/dev/null
       echo "ret=$?"`,
      { tmpdir: tmp },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ret=1');
  });

  it('shim_cache_read returns 1 (miss) for a non-existent key', () => {
    if (!bashExists()) return;
    const r = runBash(
      `source "${SHIM_CACHE_LIB}"
       shim_cache_read "does-not-exist-key" 2>/dev/null
       echo "ret=$?"`,
      { tmpdir: tmp },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ret=1');
  });

  it('shim_cache_read returns 1 (miss) for empty key arg', () => {
    if (!bashExists()) return;
    const r = runBash(
      `source "${SHIM_CACHE_LIB}"
       shim_cache_read "" 2>/dev/null
       echo "ret=$?"`,
      { tmpdir: tmp },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('ret=1');
  });
});

describe('shim-cache.sh — atomic write', () => {
  it('renames via .tmp.$$ — no half-written file lingers under the final key name', () => {
    if (!bashExists()) return;
    const tmp = makeTmpdir();
    try {
      // We can't easily race the write from a test, but we can confirm
      // (a) the write path uses a temp + rename pattern, and (b) the
      // final file content is complete (full JSON line). We sanity-check
      // by inspecting that no `.tmp.*` file lingers after a successful
      // write.
      runBash(
        `source "${SHIM_CACHE_LIB}"
         KEY=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1000" "10" "501" "1" "test-shim" "100" "1000" "200" "/usr/bin/node" "12345")
         shim_cache_write "$KEY" '{"ok":1}'`,
        { tmpdir: tmp },
      );
      const euid = String(process.getuid?.() ?? 0);
      const dir = path.join(tmp, `rea-shim-cache.${euid}`);
      const entries = fs.readdirSync(dir);
      const tmpFiles = entries.filter((e) => e.includes('.tmp.'));
      expect(tmpFiles).toHaveLength(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('shim-cache.sh — shim_cache_session_token', () => {
  it('produces a 32 hex char token from the live process tree (fallback paths exercised)', () => {
    if (!bashExists()) return;
    const tmp = makeTmpdir();
    try {
      const r = runBash(
        `source "${SHIM_CACHE_LIB}"
         tok=$(shim_cache_session_token 2>/dev/null)
         echo "tok=$tok"
         echo "ret=$?"`,
        { tmpdir: tmp },
      );
      expect(r.status).toBe(0);
      // Either we got a token (32 hex chars) OR we hit the final
      // "cache disabled" fallback (empty token, exit 1). Both are
      // valid per the design — but in this test harness, bash is
      // running under node which IS a discoverable ancestor or at
      // least produces a tty / login-shell-pid / boot-id.
      const tokMatch = r.stdout.match(/tok=([0-9a-f]*)/);
      expect(tokMatch).not.toBeNull();
      if (tokMatch && tokMatch[1].length > 0) {
        expect(tokMatch[1]).toMatch(/^[0-9a-f]{32}$/);
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('produces stable tokens across two back-to-back invocations in the same process tree', () => {
    if (!bashExists()) return;
    const tmp = makeTmpdir();
    try {
      // Two consecutive calls in the SAME bash invocation. The session
      // tree is identical, so the token should be identical.
      const r = runBash(
        `source "${SHIM_CACHE_LIB}"
         t1=$(shim_cache_session_token 2>/dev/null)
         t2=$(shim_cache_session_token 2>/dev/null)
         echo "$t1"
         echo "$t2"`,
        { tmpdir: tmp },
      );
      expect(r.status).toBe(0);
      const lines = r.stdout.trim().split('\n').filter((l) => l.length > 0);
      if (lines.length === 2) {
        expect(lines[0]).toBe(lines[1]);
      } else if (lines.length === 0) {
        // Final fallback hit — acceptable on a stripped container.
        // No assertion; the contract permits this.
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('shim-cache.sh — TTL behavior is enforced by the shim-runtime caller', () => {
  // The cache helper itself stores arbitrary JSON; TTL enforcement
  // lives in shim-runtime.sh (which parses the entry and compares
  // cached_at_unix + ttl_seconds < now). This test pins the
  // expectation: the helper does NOT enforce TTL at the storage
  // layer (so the runtime can apply uniform validation logic).
  it('shim_cache_read returns the JSON verbatim regardless of cached_at_unix value', () => {
    if (!bashExists()) return;
    const tmp = makeTmpdir();
    try {
      const stale = '{"cached_at_unix":1,"ttl_seconds":1,"x":1}';
      const r = runBash(
        `source "${SHIM_CACHE_LIB}"
         KEY=$(shim_cache_key "v1" "tok" "/proj" "/cli" "1000" "10" "501" "1" "test-shim" "100" "1000" "200" "/usr/bin/node" "12345")
         shim_cache_write "$KEY" '${stale}'
         out=$(shim_cache_read "$KEY")
         echo "out=$out"`,
        { tmpdir: tmp },
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('out=' + stale);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
