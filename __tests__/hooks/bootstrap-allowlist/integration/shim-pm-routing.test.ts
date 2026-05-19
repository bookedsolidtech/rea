/**
 * Bootstrap allowlist — shim PM-routing integration (P1-2 / codex round 2;
 * restructured under R5-P1 / codex round 5).
 *
 * # Why this test exists
 *
 * The corpus tests (`__tests__/hooks/bootstrap-allowlist/corpus.test.ts`)
 * exercise `bootstrap_allowlist_check` directly. They prove the helper's
 * logic is correct in isolation. The shim integration LAYER above the
 * helper is what these tests pin.
 *
 * # R5-P1 semantics
 *
 * The substring scan against `policy.blocked_paths` (or the protected-
 * path markers + `policy.protected_writes` for the protected-paths
 * shim) is DETERMINATIVE for refusal. The allowlist opens a gate
 * (auditable allow), it does NOT close one.
 *
 * Decision matrix (CLI-missing branch):
 *
 *   - No substring match + allowlist allow      → ALLOW + audit (exit 0)
 *   - No substring match + allowlist refuse     → ALLOW silent (no audit)
 *   - Substring match + allowlist allow         → ALLOW + audit (exit 0)
 *   - Substring match + allowlist refuse        → REFUSE banner (exit 2)
 *   - Substring match + non-PM (allowlist N/A)  → REFUSE banner (exit 2)
 *   - No substring match + non-PM               → ALLOW silent (no audit)
 *
 * Each test drives the FULL shim body via `child_process.spawn` against
 * a controlled fixture, exactly as Claude Code invokes the shim on a
 * PreToolUse Bash event. The shim runs with no `node_modules/
 * @bookedsolid/rea` (CLI-missing bootstrap state).
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const CANONICAL_SHIMS_DIR = path.join(REPO_ROOT, 'hooks');

let tmpDir: string;
let shimsDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-bsa-shim-'));
  // The shim sources its siblings via `$(dirname "$0")/_lib/...`. So we
  // need a hooks dir layout that matches the canonical one. Easiest: a
  // symlink to the repo's `hooks/` directory.
  shimsDir = path.join(tmpDir, 'hooks');
  await fs.symlink(CANONICAL_SHIMS_DIR, shimsDir);
  // .rea/ + .claude/ live under the project dir, NOT the hooks dir.
  await fs.mkdir(path.join(tmpDir, '.rea'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const POLICY_WITH_PACKAGE_JSON_BLOCKED = [
  'version: "1"',
  'profile: "bst-internal"',
  'installed_by: "rea@0.49.0"',
  'installed_at: "2026-05-19T00:00:00Z"',
  'autonomy_level: L1',
  'max_autonomy_level: L2',
  'promotion_requires_human_approval: true',
  'block_ai_attribution: false',
  'blocked_paths:',
  '  - .env',
  '  - package.json',
  'notification_channel: ""',
  '',
].join('\n');

const POLICY_NO_OVERLAPPING_BLOCKED_PATHS = [
  'version: "1"',
  'profile: "open-source"',
  'installed_by: "rea@0.49.0"',
  'installed_at: "2026-05-19T00:00:00Z"',
  'autonomy_level: L1',
  'max_autonomy_level: L2',
  'promotion_requires_human_approval: true',
  'block_ai_attribution: false',
  'blocked_paths:',
  '  - .env',
  '  - .env.*',
  'notification_channel: ""',
  '',
].join('\n');

async function writePolicy(yaml: string): Promise<void> {
  await fs.writeFile(path.join(tmpDir, '.rea', 'policy.yaml'), yaml, 'utf8');
}

async function writePkgJson(content: unknown): Promise<void> {
  const body =
    typeof content === 'string' ? content : JSON.stringify(content, null, 2) + '\n';
  await fs.writeFile(path.join(tmpDir, 'package.json'), body, 'utf8');
}

interface ShimResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

function spawnShim(
  shim: 'blocked-paths-bash-gate' | 'protected-paths-bash-gate',
  cmd: string,
): Promise<ShimResult> {
  return new Promise((resolve) => {
    const shimPath = path.join(shimsDir, `${shim}.sh`);
    const child = spawn('bash', [shimPath], {
      cwd: tmpDir,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? tmpDir,
        CLAUDE_PROJECT_DIR: tmpDir,
        REA_AUDIT_NO_ROTATE: '1',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: cmd },
    });
    child.stdin.write(payload);
    child.stdin.end();
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c: Buffer) => {
      stderr += c.toString('utf8');
    });
    child.on('close', (code) => {
      resolve({ exitCode: code, stdout, stderr });
    });
  });
}

async function readAuditEntries(): Promise<Record<string, unknown>[]> {
  const auditFile = path.join(tmpDir, '.rea', 'audit.jsonl');
  if (!fsSync.existsSync(auditFile)) return [];
  const raw = await fs.readFile(auditFile, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

async function hasBootstrapAllowEntry(): Promise<boolean> {
  const entries = await readAuditEntries();
  return entries.some((e) => e['tool_name'] === 'rea.bash.bootstrap_allow');
}

// =============================================================================
// R5-P1 (codex round 5) — canonical decision-matrix tests
// =============================================================================
//
// The new contract: the allowlist OPENS gates, never CLOSES them. Each
// test below pins one row of the decision matrix for both shims.

describe('shim PM-routing R5-P1 — blocked-paths-bash-gate.sh decision matrix', () => {
  it('R5.1 — No policy file + `pnpm install` → ALLOW silent (no audit)', async () => {
    // Fresh-clone repo with no rea policy. PM payload that doesn't
    // declare rea pre-condition. Pre-fix R5: refused. Post-fix R5:
    // exits 0 silently — the pre-port no-policy-no-match-allow
    // posture is preserved.
    await writePkgJson({ name: 'consumer' });
    // No .rea/policy.yaml on disk.

    const r = await spawnShim('blocked-paths-bash-gate', 'pnpm install');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(false);
  });

  it('R5.2 — No policy file + `pnpm add -D @bookedsolid/rea` + pkg DECLARES rea → ALLOW + audit', async () => {
    // No policy but the auditable bootstrap path applies because
    // the precondition holds. The audit event surfaces even on
    // fresh-clone repos with no policy.
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });

    const r = await spawnShim('blocked-paths-bash-gate', 'pnpm add -D @bookedsolid/rea');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(true);
  });

  it('R5.3 — No policy file + `pnpm add -D @bookedsolid/rea` + pkg does NOT declare → ALLOW silent', async () => {
    // PM payload + no policy + precondition fails. Pre-fix R5:
    // refused via banner. Post-fix R5: silent allow — the no-policy
    // posture takes precedence. The operator has not opted in to
    // rea governance, so the gate has no basis to refuse.
    await writePkgJson({ name: 'consumer' });

    const r = await spawnShim('blocked-paths-bash-gate', 'pnpm add -D @bookedsolid/rea');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(false);
  });

  it('R5.4 — Policy without overlapping blocked_paths + `pnpm install` → ALLOW silent', async () => {
    // Operator installed rea with the open-source profile (only
    // .env / .env.* in blocked_paths). `pnpm install` matches no
    // blocked path. Substring miss; allowlist precondition fails.
    // Outcome: silent allow — original no-match posture preserved.
    await writePkgJson({ name: 'consumer' });
    await writePolicy(POLICY_NO_OVERLAPPING_BLOCKED_PATHS);

    const r = await spawnShim('blocked-paths-bash-gate', 'pnpm install');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(false);
  });

  it('R5.5 — Policy without overlap + `pnpm install` + pkg declares rea → ALLOW + audit', async () => {
    // Same policy shape; pkg declares rea so the auditable bootstrap
    // path engages. The audit entry surfaces — useful for operators
    // who want a trail even when no substring match would otherwise
    // gate the call.
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(POLICY_NO_OVERLAPPING_BLOCKED_PATHS);

    const r = await spawnShim('blocked-paths-bash-gate', 'pnpm install');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(true);
  });

  it('R5.6 — Policy WITH overlap + non-PM command matches substring + pkg declares rea → REFUSE banner', async () => {
    // bst-internal-shape policy with `package.json` in blocked_paths.
    // Operator runs `cat package.json` — substring matches, argv0 is
    // not a PM, so the allowlist is not consulted (helper returns
    // exit 1). Substring match → banner+exit 2.
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);

    const r = await spawnShim('blocked-paths-bash-gate', 'cat package.json');
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toMatch(/blocked_paths refusal|CLI/i);
  });

  it('R5.7 — Policy WITH overlap + non-PM command matches substring + pkg does NOT declare → REFUSE banner', async () => {
    // Same shape as R5.6 but pkg.json doesn't declare rea. Outcome
    // is identical — the substring scan is what drives refusal.
    await writePkgJson({ name: 'consumer' });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);

    const r = await spawnShim('blocked-paths-bash-gate', 'cat package.json');
    expect(r.exitCode).toBe(2);
  });

  it('R5.8 — Empty repo (no policy + no package.json) + `pnpm install` → ALLOW silent', async () => {
    // The fresh-clone-pnpm-install posture this whole feature is
    // supposed to enable. Pre-R5, this case refused via banner
    // because the allowlist precondition (package.json declares
    // rea) failed. Post-R5, both refuse-fallthrough paths defer to
    // "no-match → allow" and the install proceeds silently.
    // No package.json, no policy file at all.

    const r = await spawnShim('blocked-paths-bash-gate', 'pnpm install');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(false);
  });
});

describe('shim PM-routing R5-P1 — protected-paths-bash-gate.sh decision matrix', () => {
  // Symmetric coverage on the protected-paths shim. Its substring
  // markers are different (`.claude/`, `.husky/`, `.rea/policy.yaml`,
  // etc.) but the decision matrix is identical.

  it('R5.P.1 — No policy + `pnpm install` → ALLOW silent', async () => {
    await writePkgJson({ name: 'consumer' });

    const r = await spawnShim('protected-paths-bash-gate', 'pnpm install');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(false);
  });

  it('R5.P.2 — No policy + `pnpm add -D @bookedsolid/rea` + declares rea → ALLOW + audit', async () => {
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });

    const r = await spawnShim('protected-paths-bash-gate', 'pnpm add -D @bookedsolid/rea');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(true);
  });

  it('R5.P.3 — No policy + `pnpm install` + no rea declaration → ALLOW silent', async () => {
    await writePkgJson({ name: 'consumer' });

    const r = await spawnShim('protected-paths-bash-gate', 'pnpm install');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(false);
  });

  it('R5.P.4 — `cat .claude/settings.json` + policy + no rea declaration → REFUSE banner', async () => {
    // protected-path substring marker matches. Non-PM. Banner fires.
    await writePkgJson({ name: 'consumer' });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);

    const r = await spawnShim('protected-paths-bash-gate', 'cat .claude/settings.json');
    expect(r.exitCode).toBe(2);
  });
});


// =============================================================================
// P1-2 (codex round 2) — auditable-allow path: the bootstrap allow MUST
// surface in the audit log when the precondition holds and the shape
// matches, regardless of substring match.
// =============================================================================

describe('shim PM-routing P1-2 — auditable bootstrap allow', () => {
  it('Case A — `pnpm add -D @bookedsolid/rea` + bst-internal policy + declares rea → ALLOW + audit', async () => {
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);

    const r = await spawnShim('blocked-paths-bash-gate', 'pnpm add -D @bookedsolid/rea');
    expect(r.exitCode).toBe(0);

    const entries = await readAuditEntries();
    const bootstrapAllow = entries.find((e) => e['tool_name'] === 'rea.bash.bootstrap_allow');
    expect(bootstrapAllow).toBeDefined();
    expect(bootstrapAllow!['tier']).toBe('write');
    expect(bootstrapAllow!['emission_source']).toBe('rea-cli');
  });

  it('Case B — vanilla `pnpm install` + bst-internal policy + declares rea → ALLOW + audit', async () => {
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);

    const r = await spawnShim('blocked-paths-bash-gate', 'pnpm install');
    expect(r.exitCode).toBe(0);

    const entries = await readAuditEntries();
    const bootstrapAllow = entries.find((e) => e['tool_name'] === 'rea.bash.bootstrap_allow');
    expect(bootstrapAllow).toBeDefined();
    const md = bootstrapAllow!['metadata'] as Record<string, unknown>;
    expect(md['pm']).toBe('pnpm');
    expect(md['argv_shape']).toBe('install');
  });

  it('Case C — `npm ci` + policy + declares rea → ALLOW + audit', async () => {
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);

    const r = await spawnShim('blocked-paths-bash-gate', 'npm ci');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(true);
  });

  it('Case D — protected-paths gate, same `pnpm add -D` shape → ALLOW + audit (shim parity)', async () => {
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);

    const r = await spawnShim('protected-paths-bash-gate', 'pnpm add -D @bookedsolid/rea');
    expect(r.exitCode).toBe(0);

    const entries = await readAuditEntries();
    const bootstrapAllow = entries.find((e) => e['tool_name'] === 'rea.bash.bootstrap_allow');
    expect(bootstrapAllow).toBeDefined();
    const md = bootstrapAllow!['metadata'] as Record<string, unknown>;
    expect(md['shim']).toBe('protected-paths-bash-gate');
  });
});

// =============================================================================
// Non-PM commands — substring scan is the ONLY mechanism
// =============================================================================

describe('shim PM-routing — non-PM commands (substring scan only)', () => {
  it('`git status` + any policy → ALLOW silent (no substring match)', async () => {
    await writePkgJson({ name: 'consumer' });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);

    const r = await spawnShim('blocked-paths-bash-gate', 'git status');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(false);
  });

  it('protected-paths gate + `git status` → ALLOW silent', async () => {
    await writePkgJson({ name: 'consumer' });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);

    const r = await spawnShim('protected-paths-bash-gate', 'git status');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(false);
  });
});

// =============================================================================
// R3-P1 (codex round 3) — whitespace bypass class. The argv[0]
// extraction must use `read -ra` (not `${cmd%% *}`) so leading
// whitespace and tab-separated payloads land in the PM branch.
// =============================================================================

describe('shim PM-routing R3-P1 — whitespace bypass class', () => {
  it('R3-P1.1 — leading space ` pnpm add -D @bookedsolid/rea` + declares rea → ALLOW + audit', async () => {
    // R3-P1 + R5-P1 interaction: PM payload + pkg declares rea →
    // auditable-allow path engages independent of substring match.
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);

    const r = await spawnShim('blocked-paths-bash-gate', ' pnpm add -D @bookedsolid/rea');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(true);
  });

  it('R3-P1.2 — leading tab `\\tpnpm add -D @bookedsolid/rea` + declares rea → ALLOW + audit', async () => {
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);

    const r = await spawnShim('blocked-paths-bash-gate', '\tpnpm add -D @bookedsolid/rea');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(true);
  });

  it('R3-P1.3 — tab separator `pnpm\\tadd -D @bookedsolid/rea` + declares rea → ALLOW + audit', async () => {
    // Headline R3-P1 case: `${cmd%% *}` returned the whole string
    // when separated by tab. `read -ra` correctly tokenises.
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);

    const r = await spawnShim('blocked-paths-bash-gate', 'pnpm\tadd -D @bookedsolid/rea');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(true);
  });

  it('R3-P1.5 — multi-space `pnpm   add   -D   @bookedsolid/rea` + declares rea → ALLOW + audit', async () => {
    // `read -ra` collapses internal whitespace runs.
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);

    const r = await spawnShim('blocked-paths-bash-gate', 'pnpm   add   -D   @bookedsolid/rea');
    expect(r.exitCode).toBe(0);
    const entries = await readAuditEntries();
    const allow = entries.find((e) => e['tool_name'] === 'rea.bash.bootstrap_allow');
    expect(allow).toBeDefined();
    const md = allow!['metadata'] as Record<string, unknown>;
    expect(md['argv_shape']).toBe('add-rea');
  });

  it('R3-P1.6 — leading space + protected-paths gate + declares rea → ALLOW + audit', async () => {
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);

    const r = await spawnShim('protected-paths-bash-gate', ' pnpm add -D @bookedsolid/rea');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(true);
  });
});

// =============================================================================
// R7-P1 (codex round 7) — audit-integrity fail-closed
// =============================================================================
//
// When `bootstrap_allowlist_check` cannot complete audit emission
// (corrupted audit tail, hasher missing, read-only `.rea/`, etc.) it
// emits `refuse-hard` on stdout. The shim caller MUST refuse via
// banner regardless of the substring scan — silently allowing a
// payload whose audit record could not be written would violate the
// "every bootstrap allow is auditable" invariant.
//
// Pre-R7, the helper collapsed `refuse-hard` into ordinary `refuse`
// and the R5-restructured shim let the no-substring-match cases
// silently allow. A corrupted audit chain went unenforced.

describe('shim R7-P1 — refuse-hard on audit-integrity failure', () => {
  /**
   * Plant a corrupted last line in `.rea/audit.jsonl` AFTER the
   * shim's normal initial setup. The shim will see the corruption
   * when it tries to extend the chain on the next allow.
   */
  async function corruptAuditTail(): Promise<void> {
    const auditFile = path.join(tmpDir, '.rea', 'audit.jsonl');
    // Seed a real well-formed record first so the corruption isn't
    // genesis-vs-corruption-ambiguous.
    await fs.writeFile(
      auditFile,
      JSON.stringify({
        timestamp: '2026-05-19T00:00:00.000Z',
        session_id: 'bash-tier',
        tool_name: 'rea.bash.bootstrap_allow',
        server_name: 'rea',
        tier: 'write',
        status: 'allowed',
        autonomy_level: 'unknown',
        duration_ms: 0,
        prev_hash:
          '0000000000000000000000000000000000000000000000000000000000000000',
        emission_source: 'rea-cli',
        hash: 'deadbeef000000000000000000000000000000000000000000000000000000ab',
      }) + '\n',
      'utf8',
    );
    // Append a partial unterminated line — the R4-P1 detector
    // flags this as corruption.
    await fs.appendFile(auditFile, '{"broken":\n', 'utf8');
  }

  it('R7.1 — corrupt audit tail + `pnpm install` + NO policy → REFUSE banner (not silent-allow)', async () => {
    // Headline case: no-policy fresh-clone repo, command would
    // ordinarily be silent-allow on no-substring-match — but the
    // audit chain is corrupt. Pre-R7 the shim exited 0 silently;
    // post-R7 the helper returns 2 (refuse-hard) and the shim
    // emits the banner.
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    // No policy.yaml — so substring scan path won't trigger.
    await corruptAuditTail();

    const r = await spawnShim('blocked-paths-bash-gate', 'pnpm install');
    expect(r.exitCode).toBe(2);
  });

  it('R7.2 — corrupt audit tail + `pnpm install` + bst-internal policy → REFUSE banner', async () => {
    // bst-internal repo, manifest-read shape, declares rea — pre-
    // R6-P1 path was silent-allow via no-substring-match; with R7-P1
    // the corrupt chain forces a banner refusal regardless.
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);
    await corruptAuditTail();

    const r = await spawnShim('blocked-paths-bash-gate', 'pnpm install');
    expect(r.exitCode).toBe(2);
  });

  it('R7.3 — corrupt audit tail + protected-paths gate + `pnpm install` → REFUSE banner', async () => {
    // Symmetric parity check: protected-paths shim also refuse-
    // hards on audit-integrity failure.
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);
    await corruptAuditTail();

    const r = await spawnShim('protected-paths-bash-gate', 'pnpm install');
    expect(r.exitCode).toBe(2);
  });

  it('R7.4 — corrupt audit tail + non-PM command → existing substring-scan path unaffected', async () => {
    // The corruption signal only fires through the PM-route helper.
    // A non-PM command never invokes the helper; the substring
    // scan is the only mechanism. Verify the non-PM path is
    // unchanged: no substring match means silent allow (even with
    // a corrupt audit chain — the chain is only consulted when an
    // allow would emit an audit record).
    await writePkgJson({ name: 'consumer' });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);
    await corruptAuditTail();

    const r = await spawnShim('blocked-paths-bash-gate', 'git status');
    expect(r.exitCode).toBe(0);
  });

  it('R7.5 — normal audit tail + `pnpm install` + no policy → existing silent-allow preserved', async () => {
    // Regression guard: an intact audit chain (or no audit file
    // at all) preserves the pre-R7 behavior. `pnpm install` under
    // no-policy with no rea decl is silent-allow; with a rea decl
    // it's audited-allow.
    await writePkgJson({ name: 'consumer' });
    // No policy.yaml. No audit file pre-existing.

    const r = await spawnShim('blocked-paths-bash-gate', 'pnpm install');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(false);
  });

  it('R7.6 — recovery: delete corrupt audit file → next allow proceeds', async () => {
    // Operator hits the refuse-hard, deletes/truncates the audit
    // file, retries — the next allow succeeds via the genesis path.
    await writePkgJson({
      name: 'consumer',
      devDependencies: { '@bookedsolid/rea': '^0.49.0' },
    });
    await writePolicy(POLICY_WITH_PACKAGE_JSON_BLOCKED);
    await corruptAuditTail();

    let r = await spawnShim('blocked-paths-bash-gate', 'pnpm install');
    expect(r.exitCode).toBe(2);

    // Operator repairs.
    await fs.rm(path.join(tmpDir, '.rea', 'audit.jsonl'));
    r = await spawnShim('blocked-paths-bash-gate', 'pnpm install');
    expect(r.exitCode).toBe(0);
    expect(await hasBootstrapAllowEntry()).toBe(true);
  });
});

