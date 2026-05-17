/**
 * Init flow tests focused on the G11.4 `--codex` / `--no-codex` plumbing.
 *
 * `runInit` uses `process.cwd()` internally (carried from the original
 * wizard), so these tests run in an isolated tmpdir per case, switching
 * `process.cwd()` only for the duration of the `runInit` call and
 * restoring it afterwards.
 *
 * We exercise the non-interactive path exclusively (`--yes`). The
 * interactive wizard is driven by `@clack/prompts` which we don't stub;
 * the non-interactive path is the production CI path and is the seam
 * with the new flag semantics.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutonomyLevel } from '../policy/types.js';
import {
  buildInstallSummary,
  detectTargetState,
  postInstallVerify,
  runInit,
  type ResolvedConfig,
  type TargetState,
} from './init.js';
import { FALLBACK_MARKER } from './install/pre-push.js';

const execFileAsync = promisify(execFile);

async function makeScratch(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-init-test-')));
}

async function readPolicy(dir: string): Promise<string> {
  return fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
}

describe('rea init — G11.4 codex flags', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('--yes --no-codex writes review.codex_required: false', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({
      yes: true,
      profile: 'minimal',
      codex: false,
    });

    const policy = await readPolicy(dir);
    expect(policy).toMatch(/review:\s*\n\s+codex_required:\s+false/);
    expect(policy).not.toMatch(/codex_required:\s+true/);
  });

  it('--yes --codex writes review.codex_required: true', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({
      yes: true,
      profile: 'minimal',
      codex: true,
    });

    const policy = await readPolicy(dir);
    expect(policy).toMatch(/review:\s*\n\s+codex_required:\s+true/);
  });

  it('--yes with no codex flag: default is derived from profile name', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    // Plain `minimal` profile → codex_required defaults to true.
    await runInit({ yes: true, profile: 'minimal' });

    const policy = await readPolicy(dir);
    expect(policy).toMatch(/codex_required:\s+true/);
  });

  it('--yes --profile bst-internal-no-codex defaults to codex_required: false', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'bst-internal-no-codex' });

    const policy = await readPolicy(dir);
    expect(policy).toMatch(/codex_required:\s+false/);
  });

  it('--yes --profile bst-internal-no-codex --codex overrides the profile default', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    // Explicit --codex wins over the profile default. Unusual but permitted:
    // the operator has picked a no-codex profile for its other settings but
    // wants to keep Codex review in the loop.
    await runInit({
      yes: true,
      profile: 'bst-internal-no-codex',
      codex: true,
    });

    const policy = await readPolicy(dir);
    expect(policy).toMatch(/codex_required:\s+true/);
  });

  it('--yes --profile open-source-no-codex defaults to codex_required: false', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'open-source-no-codex' });

    const policy = await readPolicy(dir);
    expect(policy).toMatch(/codex_required:\s+false/);
  });

  it('G6: installs fallback pre-push in a vanilla git repo', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.name', 't']);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    const prePushPath = path.join(dir, '.git', 'hooks', 'pre-push');
    const content = await fs.readFile(prePushPath, 'utf8');
    expect(content).toContain(FALLBACK_MARKER);
    expect(content).toContain('hook push-gate');

    const stat = await fs.stat(prePushPath);
    expect(stat.mode & 0o111).toBeGreaterThan(0);
  });

  it('G6: re-running init does not duplicate or corrupt the fallback', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.email', 't@example.com']);
    await execFileAsync('git', ['-C', dir, 'config', 'user.name', 't']);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    // Second invocation: --force so the policy overwrite path is taken.
    await runInit({ yes: true, profile: 'minimal', codex: false, force: true });

    // Still exactly one pre-push, still carries our marker, still executable.
    const hooksDir = path.join(dir, '.git', 'hooks');
    const entries = await fs.readdir(hooksDir);
    const prePushEntries = entries.filter((e) => e === 'pre-push');
    expect(prePushEntries).toEqual(['pre-push']);

    const content = await fs.readFile(path.join(hooksDir, 'pre-push'), 'utf8');
    expect(content).toContain(FALLBACK_MARKER);
  });

  it('written policy parses via the loader round-trip', async () => {
    // Smoke test: the field we emit must be accepted by the strict policy
    // loader. A typo in the YAML key would escape the other tests because
    // they read the raw string — this closes that gap.
    const { loadPolicy } = await import('../policy/loader.js');
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    const policy = loadPolicy(dir);
    expect(policy.review?.codex_required).toBe(false);
  });

  it('BUG-010: init scaffolds .gitignore entries for every .rea runtime artifact', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    const gi = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    expect(gi).toContain('.rea/fingerprints.json');
    expect(gi).toContain('.rea/last-review.json');
    expect(gi).toContain('.rea/audit.jsonl');
    expect(gi).toContain('.rea/audit-*.jsonl');
    expect(gi).toContain('.rea/HALT');
    expect(gi).toContain('.rea/metrics.jsonl');
    expect(gi).toContain('.rea/serve.pid');
    expect(gi).toContain('.rea/serve.state.json');
    // Marker present so re-running init recognizes its own block.
    expect(gi).toContain('# === rea managed');
  });

  it('BUG-010: re-running init is idempotent — no duplicate gitignore entries', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    const first = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');

    await runInit({ yes: true, profile: 'minimal', codex: false, force: true });
    const second = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');

    expect(second).toBe(first);
    // Exactly one managed block.
    const openMarkers = (second.match(/# === rea managed — do not edit between markers ===/g) ?? [])
      .length;
    const closeMarkers = (second.match(/# === end rea managed ===/g) ?? []).length;
    expect(openMarkers).toBe(1);
    expect(closeMarkers).toBe(1);
  });

  it('0.21.1 idempotency: re-running rea init preserves manually-edited autonomy_level', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    // First init — profile default L1.
    await runInit({ yes: true, profile: 'minimal', codex: false });
    let raw = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(raw).toMatch(/^autonomy_level:\s*L1\s*$/m);

    // Operator manually escalates to L2.
    raw = raw.replace(/^autonomy_level:\s*L1\s*$/m, 'autonomy_level: L2');
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), raw, 'utf8');

    // Re-init — must preserve L2.
    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(second).toMatch(/^autonomy_level:\s*L2\s*$/m);
  });

  it('0.21.1 idempotency: re-running rea init preserves manually-edited blocked_paths', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    let raw = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    // Operator adds .secrets to the blocked list.
    raw = raw.replace(/^blocked_paths:\s*\n((?:\s+-\s+.*\n)+)/m, (_m, body: string) => {
      return `blocked_paths:\n${body}  - ".secrets"\n`;
    });
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), raw, 'utf8');

    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(second).toMatch(/-\s+["']?\.secrets["']?/);
  });

  it('0.21.1 idempotency: re-running rea init preserves block_ai_attribution = false', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    let raw = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    raw = raw.replace(/^block_ai_attribution:\s*true\s*$/m, 'block_ai_attribution: false');
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), raw, 'utf8');

    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(second).toMatch(/^block_ai_attribution:\s*false\s*$/m);
  });

  it('0.17.0 idempotency: re-running rea init preserves installed_at in policy.yaml', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    const first = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    const firstStamp = first.match(/^installed_at:\s*"([^"]+)"/m)?.[1];
    expect(firstStamp).toBeDefined();

    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    const secondStamp = second.match(/^installed_at:\s*"([^"]+)"/m)?.[1];

    expect(secondStamp).toBe(firstStamp);
  });

  it('0.17.0 idempotency: re-running rea init preserves installed_at in install-manifest.json', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    const firstRaw = await fs.readFile(path.join(dir, '.rea', 'install-manifest.json'), 'utf8');
    const firstStamp = (JSON.parse(firstRaw) as { installed_at: string }).installed_at;

    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const secondRaw = await fs.readFile(path.join(dir, '.rea', 'install-manifest.json'), 'utf8');
    const secondStamp = (JSON.parse(secondRaw) as { installed_at: string }).installed_at;

    expect(secondStamp).toBe(firstStamp);
  });

  // ── round-27 F6: re-run preserves 0.26.0 local_review + commit_hygiene ──
  //
  // 0.21.1 made the older user-mutable knobs survive re-runs of `rea init`.
  // Round-27 F6 extends that contract to the 0.26.0 fields. Pre-fix, a team
  // opting out via `mode: off` got silently reverted on the next re-run,
  // defeating the off-switch documented as a FIRST-class concern.
  it('round-27 F6: re-running rea init preserves review.local_review.mode = off', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    let raw = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    // Operator opts out of local-review enforcement. Append a local_review
    // block under the existing review: block.
    raw = raw.replace(
      /^(review:\s*\n  codex_required:\s*(?:true|false)\s*\n)/m,
      '$1  local_review:\n    mode: off\n',
    );
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), raw, 'utf8');

    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(second).toMatch(/local_review:\s*\n\s+mode:\s*off/);
  });

  it('round-27 F6: re-running rea init preserves review.local_review.refuse_at = both', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    let raw = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    raw = raw.replace(
      /^(review:\s*\n  codex_required:\s*(?:true|false)\s*\n)/m,
      '$1  local_review:\n    refuse_at: both\n',
    );
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), raw, 'utf8');

    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(second).toMatch(/refuse_at:\s*both/);
  });

  it('round-27 F6: re-running rea init preserves commit_hygiene thresholds', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    let raw = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    // Append a commit_hygiene block at the bottom (top-level key).
    if (!raw.endsWith('\n')) raw += '\n';
    raw += 'commit_hygiene:\n  warn_at_commits: 3\n  refuse_at_commits: 10\n';
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), raw, 'utf8');

    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(second).toMatch(/commit_hygiene:/);
    expect(second).toMatch(/warn_at_commits:\s*3/);
    expect(second).toMatch(/refuse_at_commits:\s*10/);
  });

  // ── round-30 F3: inline-form preservation (structural fix) ───────────
  //
  // The round-28 F6 regex preservation only matched block-form scalars
  // (`^\s+mode:`, `^\s+warn_at_commits:`). Inline form
  // `local_review: { mode: off }` slipped through — values undefined →
  // writer skipped emission → the inline block vanished on re-run.
  // Round-trip lossy across the inline/block divergence.
  //
  // Round-30 F3 switches to YAML-parsed reads. Inline AND block forms
  // fold to the same object at the parser layer, so both are preserved
  // identically. The re-run may re-emit as block form (writer's choice)
  // — what matters is the VALUES survive.
  it('round-30 F3: re-running rea init preserves INLINE-form local_review block', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    let raw = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    // Replace the auto-generated review: block with INLINE form. Before
    // round-30 the regex preservation matched zero of these fields and
    // the inline block was silently dropped on re-init.
    raw = raw.replace(
      /^review:\s*\n  codex_required:\s*(?:true|false)\s*\n/m,
      'review:\n  codex_required: false\n  local_review: { mode: off, refuse_at: both }\n',
    );
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), raw, 'utf8');

    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    // Values must survive re-run. The writer re-emits as block form,
    // which is fine — the contract is "values not lost", not "format
    // round-trips".
    expect(second).toMatch(/local_review:/);
    expect(second).toMatch(/mode:\s*off/);
    expect(second).toMatch(/refuse_at:\s*both/);
  });

  it('round-30 F3: re-running rea init preserves INLINE-form commit_hygiene block', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    let raw = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    // Append top-level commit_hygiene as INLINE form.
    if (!raw.endsWith('\n')) raw += '\n';
    raw += 'commit_hygiene: { warn_at_commits: 7, refuse_at_commits: 21 }\n';
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), raw, 'utf8');

    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(second).toMatch(/commit_hygiene:/);
    expect(second).toMatch(/warn_at_commits:\s*7/);
    expect(second).toMatch(/refuse_at_commits:\s*21/);
  });

  it('round-30 F3: re-running rea init preserves MIXED inline review.local_review and block commit_hygiene', async () => {
    // Real-world manual edits sometimes mix forms — operators copy
    // examples from docs (block form) but write knobs by hand (inline
    // form). Both must survive a re-run.
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    let raw = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    raw = raw.replace(
      /^review:\s*\n  codex_required:\s*(?:true|false)\s*\n/m,
      'review:\n  codex_required: false\n  local_review: { mode: off }\n',
    );
    if (!raw.endsWith('\n')) raw += '\n';
    raw += 'commit_hygiene:\n  warn_at_commits: 2\n  refuse_at_commits: 8\n';
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), raw, 'utf8');

    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(second).toMatch(/mode:\s*off/);
    expect(second).toMatch(/warn_at_commits:\s*2/);
    expect(second).toMatch(/refuse_at_commits:\s*8/);
  });

  it('round-27 F6: re-running rea init does NOT add a local_review block when none was set', async () => {
    // Defaults case: a fresh init (no operator edits) must NOT emit
    // empty local_review / commit_hygiene blocks. The off-switch is
    // opt-in by writing the block; absence means "use the documented
    // 0.26.0 default (mode: enforced)".
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    const first = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(first).not.toMatch(/local_review:/);
    expect(first).not.toMatch(/commit_hygiene:/);

    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(second).not.toMatch(/local_review:/);
    expect(second).not.toMatch(/commit_hygiene:/);
  });

  it('BUG-010: init preserves existing .gitignore content when adding managed block', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    // Consumer has their own .gitignore before running rea init.
    const existing = ['node_modules', 'dist', '.env', ''].join('\n');
    await fs.writeFile(path.join(dir, '.gitignore'), existing, 'utf8');

    await runInit({ yes: true, profile: 'minimal', codex: false });

    const gi = await fs.readFile(path.join(dir, '.gitignore'), 'utf8');
    // Consumer lines preserved.
    expect(gi).toContain('node_modules');
    expect(gi).toContain('dist');
    expect(gi).toContain('.env');
    // Managed block appended after.
    expect(gi).toContain('# === rea managed');
    expect(gi).toContain('.rea/fingerprints.json');
    // Consumer content comes before the managed block.
    const userIdx = gi.indexOf('node_modules');
    const markerIdx = gi.indexOf('# === rea managed');
    expect(userIdx).toBeLessThan(markerIdx);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 0.43.0 — rea init clack UX polish
//
// The interactive wizard itself is driven by `@clack/prompts` and is
// hard to drive headlessly without stubbing the full prompt module.
// Instead we test the BEHAVIOR seams the wizard delegates to:
//   1. `buildInstallSummary` — pure function; assert content shape.
//   2. `postInstallVerify` — pure function; assert detection of common
//      partial-install shapes (missing policy, missing hooks, etc).
//   3. `--yes` path of `runInit` — must still skip the new
//      install-summary confirm gate (the gate is interactive-only).
// ──────────────────────────────────────────────────────────────────────

function fakeConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    profile: 'minimal',
    autonomyLevel: AutonomyLevel.L1,
    maxAutonomyLevel: AutonomyLevel.L2,
    blockAiAttribution: true,
    blockedPaths: ['.env', '.env.*'],
    notificationChannel: '',
    codexRequired: false,
    fromReagent: false,
    reagentPolicyPath: null,
    reagentNotices: [],
    ...overrides,
  };
}

const FAKE_BOTH: TargetState = { gitRepoPresent: true, huskyDirPresent: true };
const FAKE_GIT_ONLY: TargetState = { gitRepoPresent: true, huskyDirPresent: false };
const FAKE_HUSKY_ONLY: TargetState = { gitRepoPresent: false, huskyDirPresent: true };
const FAKE_NEITHER: TargetState = { gitRepoPresent: false, huskyDirPresent: false };

describe('0.43.0 — buildInstallSummary', () => {
  it('lists the policy file, the chosen profile, and the autonomy levels', () => {
    const summary = buildInstallSummary(
      '/scratch/proj',
      fakeConfig({
        profile: 'bst-internal',
        autonomyLevel: AutonomyLevel.L2,
        maxAutonomyLevel: AutonomyLevel.L3,
        codexRequired: true,
      }),
      false,
      FAKE_BOTH,
    );
    expect(summary).toContain('profile=bst-internal');
    expect(summary).toContain('autonomy=L2 (max=L3)');
    expect(summary).toContain('codex-review=on');
    expect(summary).toContain('attribution-block=on');
    expect(summary).toContain('/scratch/proj');
  });

  it('includes every artifact the install will touch', () => {
    const summary = buildInstallSummary('/p', fakeConfig(), false, FAKE_BOTH);
    // Spot-check: the operator should see every directory and every
    // hook surface explicitly before confirming.
    expect(summary).toContain('.rea/policy.yaml');
    expect(summary).toContain('.rea/registry.yaml');
    expect(summary).toContain('.rea/install-manifest.json');
    expect(summary).toContain('.claude/agents/');
    expect(summary).toContain('.claude/hooks/');
    expect(summary).toContain('.claude/commands/');
    expect(summary).toContain('.claude/settings.json');
    expect(summary).toContain('.husky/commit-msg');
    expect(summary).toContain('.husky/pre-push');
    expect(summary).toContain('.git/hooks/commit-msg');
    expect(summary).toContain('.git/hooks/pre-push');
    expect(summary).toContain('CLAUDE.md');
    expect(summary).toContain('.gitignore');
  });

  it('labels re-run mode and lists which fields are preserved', () => {
    const summary = buildInstallSummary('/p', fakeConfig(), true, FAKE_BOTH);
    expect(summary).toMatch(/Mode: Re-run/);
    expect(summary).toContain('autonomy_level');
    expect(summary).toContain('blocked_paths');
    expect(summary).toContain('review.codex_required');
    expect(summary).toContain('attribution.co_author');
  });

  it('omits the preserved-fields section on a fresh install', () => {
    const summary = buildInstallSummary('/p', fakeConfig(), false, FAKE_BOTH);
    expect(summary).toMatch(/Mode: Fresh install/);
    expect(summary).not.toMatch(/Re-run preserves/);
  });

  // 0.43.0 codex round-1 P3: the summary's hook listing must reflect
  // what the installer will ACTUALLY do given the target tree's
  // shape. Pre-fix the summary hard-coded `.husky/*` only, hiding
  // the `.git/hooks/*` writes from the most common install shape.
  it('codex round-1 P3: lists .git/hooks/* and skips .husky/* when only git is present', () => {
    const summary = buildInstallSummary('/p', fakeConfig(), false, FAKE_GIT_ONLY);
    expect(summary).toContain('.git/hooks/commit-msg');
    expect(summary).toContain('.git/hooks/prepare-commit-msg');
    expect(summary).toContain('.git/hooks/pre-push');
    // Husky mirrors must NOT be advertised when the tree lacks .husky/.
    expect(summary).not.toContain('.husky/commit-msg');
    expect(summary).toContain('no .husky/ directory detected');
  });

  it('codex round-1 P3: lists .husky/* and explains git skip when no git repo is present', () => {
    const summary = buildInstallSummary('/p', fakeConfig(), false, FAKE_HUSKY_ONLY);
    expect(summary).toContain('.husky/commit-msg');
    expect(summary).toContain('.husky/pre-push');
    expect(summary).not.toContain('.git/hooks/commit-msg');
    expect(summary).toContain('no .git/ directory detected');
  });

  it('codex round-1 P3: notes that BOTH git and husky writes will be skipped on a bare tree', () => {
    const summary = buildInstallSummary('/p', fakeConfig(), false, FAKE_NEITHER);
    expect(summary).toContain('no .git/ directory detected');
    expect(summary).toContain('no .husky/ directory detected');
    expect(summary).not.toContain('.git/hooks/commit-msg');
    expect(summary).not.toContain('.husky/commit-msg');
  });
});

describe('0.43.0 — detectTargetState', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('reports both git and husky absent on a bare tree', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    expect(detectTargetState(dir)).toEqual({ gitRepoPresent: false, huskyDirPresent: false });
  });

  it('reports gitRepoPresent: true after `git init`', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await execFileAsync('git', ['-C', dir, 'init', '--quiet']);
    const state = detectTargetState(dir);
    expect(state.gitRepoPresent).toBe(true);
    expect(state.huskyDirPresent).toBe(false);
  });

  it('reports huskyDirPresent: true when .husky/ exists', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await fs.mkdir(path.join(dir, '.husky'));
    const state = detectTargetState(dir);
    expect(state.gitRepoPresent).toBe(false);
    expect(state.huskyDirPresent).toBe(true);
  });
});

describe('0.43.0 — postInstallVerify', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('returns zero issues on a healthy install (full `rea init --yes` end-to-end)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    const issues = postInstallVerify(dir);
    expect(issues).toEqual([]);
  });

  it('reports a missing policy.yaml as an issue', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);

    // Bare directory with no install at all.
    const issues = postInstallVerify(dir);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.includes('policy.yaml missing'))).toBe(true);
  });

  it('reports a malformed policy.yaml as an issue with a parse error', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    await fs.mkdir(path.join(dir, '.rea'), { recursive: true });
    // Write deliberately invalid YAML.
    await fs.writeFile(
      path.join(dir, '.rea', 'policy.yaml'),
      'this: is: not: valid: yaml:\n  - [unclosed\n',
      'utf8',
    );

    const issues = postInstallVerify(dir);
    expect(issues.some((i) => i.includes('policy.yaml failed to parse'))).toBe(true);
  });

  it('reports a missing .claude/hooks directory as an issue', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    // Remove the hooks directory after install to simulate corruption.
    await fs.rm(path.join(dir, '.claude', 'hooks'), { recursive: true, force: true });

    const issues = postInstallVerify(dir);
    expect(issues.some((i) => i.includes('hooks/ directory missing'))).toBe(true);
  });

  it('reports a missing install-manifest.json as an issue (drift detection broken)', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    await fs.rm(path.join(dir, '.rea', 'install-manifest.json'), { force: true });

    const issues = postInstallVerify(dir);
    expect(issues.some((i) => i.includes('install-manifest.json missing'))).toBe(true);
  });
});

describe('0.43.0 codex round-1 P2 — `--yes` re-run honors the preservation contract advertised by the summary', () => {
  // The install-summary screen advertises these fields as preserved
  // across a re-run. The `--yes` path already implemented this; the
  // wizard now matches it (round-1 P2 fix). Tests below pin the
  // `--yes` shape — the wizard interactive prompts are hard to
  // drive headlessly, but they delegate to the same writer paths.
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('re-run preserves manually-edited notification_channel', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    let raw = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    // Operator sets a custom notification target.
    raw = raw.replace(
      /^notification_channel:.*$/m,
      'notification_channel: "#ops-rea"',
    );
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), raw, 'utf8');

    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(second).toMatch(/notification_channel:\s*"#ops-rea"/);
  });

  it('re-run preserves manually-edited review.codex_required when --codex flag absent', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    // First init: explicit codex: false.
    await runInit({ yes: true, profile: 'minimal', codex: false });
    let raw = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(raw).toMatch(/codex_required:\s*false/);

    // Operator manually flips to true.
    raw = raw.replace(/codex_required:\s*false/, 'codex_required: true');
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), raw, 'utf8');

    // Re-run WITHOUT --codex / --no-codex — must preserve the
    // operator's manual flip. (--force resets, so we use --yes only.)
    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal' });
    const second = await fs.readFile(path.join(dir, '.rea', 'policy.yaml'), 'utf8');
    expect(second).toMatch(/codex_required:\s*true/);
  });
});

describe('0.43.0 — runInit --yes path still bypasses the new confirm gate', () => {
  // The new install-summary confirm gate is interactive-only. The
  // non-interactive `--yes` path is the production CI path and must
  // NEVER block waiting for a confirm — that would deadlock every
  // automated install.
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('completes a full init without blocking on a confirm prompt', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    // If the confirm gate were not bypassed under `--yes`, this would
    // hang indefinitely waiting for stdin. The fact that it returns
    // proves the bypass.
    await runInit({ yes: true, profile: 'minimal', codex: false });

    // Sanity: install really did happen.
    expect(await fs.stat(path.join(dir, '.rea', 'policy.yaml'))).toBeDefined();
    expect(await fs.stat(path.join(dir, '.claude', 'settings.json'))).toBeDefined();
  });

  it('completes a re-run init under --force without blocking on confirms', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });
    // Second run under --force exercises the re-run path. Must also
    // bypass the confirm gate.
    await runInit({ yes: true, profile: 'minimal', codex: false, force: true });

    expect(await fs.stat(path.join(dir, '.rea', 'policy.yaml'))).toBeDefined();
  });
});
