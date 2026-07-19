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
  canonicalHooksFromFilesystem,
  canonicalInstalledHooks,
  detectTargetState,
  filesystemIgnoresModeBits,
  isModeLessFilesystem,
  postInstallVerify,
  runInit,
  type ResolvedConfig,
  type TargetState,
} from './init.js';
import { EXPECTED_HOOKS } from './doctor.js';
import { defaultDesiredHooks } from './install/settings-merge.js';
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

  // ── codex round-47 P2: `rea init` prunes MOVED-matcher hooks before merge ──
  //
  // `rea upgrade` prunes hooks that moved matchers before its additive merge,
  // but `rea init` did NOT. A repo installed at 0.50.x (billing-cap-halt under
  // PostToolUse/Bash) that later re-runs `rea init` at 0.51.x+ kept the stale
  // `Bash` registration AND gained the new `*` registration — so the hook fired
  // TWICE per Bash tool call (double-incrementing the turn-budget counter) and
  // the "init twice = byte-identical" invariant broke. The fix mirrors
  // upgrade.ts's prune-before-merge at the init merge site.
  it('round-47 P2: re-running rea init over a stale Bash billing-cap-halt registration collapses to exactly one `*` entry', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    // Seed a 0.50.x-shaped settings.json: billing-cap-halt registered under
    // the OLD PostToolUse/Bash matcher (pre round-24 move to `*`).
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    const stale = {
      hooks: {
        PostToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/billing-cap-halt.sh',
                timeout: 10000,
                statusMessage: 'Checking for billing-class spend errors...',
              },
            ],
          },
        ],
      },
    };
    await fs.writeFile(
      path.join(dir, '.claude', 'settings.json'),
      JSON.stringify(stale, null, 2) + '\n',
      'utf8',
    );

    await runInit({ yes: true, profile: 'minimal', codex: false });

    const parsed = JSON.parse(
      await fs.readFile(path.join(dir, '.claude', 'settings.json'), 'utf8'),
    ) as {
      hooks: { PostToolUse?: { matcher?: string; hooks?: { command?: string }[] }[] };
    };
    const postGroups = parsed.hooks.PostToolUse ?? [];
    const billingEntries = postGroups.flatMap((g) =>
      (g.hooks ?? [])
        .filter((h) => typeof h.command === 'string' && h.command.includes('billing-cap-halt.sh'))
        .map((h) => ({ matcher: g.matcher, command: h.command })),
    );
    // Exactly ONE billing-cap-halt registration…
    expect(billingEntries).toHaveLength(1);
    // …and it is under the NEW `*` matcher, with ZERO under `Bash`.
    expect(billingEntries[0]?.matcher).toBe('*');
    expect(billingEntries.filter((e) => e.matcher === 'Bash')).toHaveLength(0);

    // A second `rea init` is a no-op — byte-identical settings.json.
    const afterFirst = await fs.readFile(path.join(dir, '.claude', 'settings.json'), 'utf8');
    await new Promise((r) => setTimeout(r, 20));
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const afterSecond = await fs.readFile(path.join(dir, '.claude', 'settings.json'), 'utf8');
    expect(afterSecond).toBe(afterFirst);
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

// ──────────────────────────────────────────────────────────────────────
// 0.44.0 charter item 1 — install summary derives its hook listing
// from the canonical resolvers (EXPECTED_HOOKS + defaultDesiredHooks),
// not a hard-coded list. Adding a hook to either source must reflect
// automatically.
// ──────────────────────────────────────────────────────────────────────

describe('0.44.0 charter item 1 — canonicalInstalledHooks derives from real resolvers', () => {
  it('includes every entry in EXPECTED_HOOKS', () => {
    const hooks = canonicalInstalledHooks();
    for (const expected of EXPECTED_HOOKS) {
      expect(hooks).toContain(expected);
    }
  });

  it('includes every hook command basename registered by defaultDesiredHooks', () => {
    const hooks = canonicalInstalledHooks();
    for (const group of defaultDesiredHooks()) {
      for (const h of group.hooks) {
        const cmd = h.command;
        const slashIdx = cmd.lastIndexOf('/');
        const basename = slashIdx >= 0 ? cmd.slice(slashIdx + 1) : cmd;
        if (basename.endsWith('.sh')) expect(hooks).toContain(basename);
      }
    }
  });

  it('is the UNION of both sources (every desired-hooks basename + every EXPECTED_HOOKS entry)', () => {
    const hooks = canonicalInstalledHooks();
    const expected = new Set<string>(EXPECTED_HOOKS);
    for (const group of defaultDesiredHooks()) {
      for (const h of group.hooks) {
        const slashIdx = h.command.lastIndexOf('/');
        const basename = slashIdx >= 0 ? h.command.slice(slashIdx + 1) : h.command;
        if (basename.endsWith('.sh')) expected.add(basename);
      }
    }
    expect(new Set(hooks)).toEqual(expected);
  });

  it('returns sorted output (stable ordering for the summary)', () => {
    const hooks = canonicalInstalledHooks();
    const sorted = [...hooks].sort();
    expect(hooks).toEqual(sorted);
  });

  it('returns no duplicates even when both sources contain the same name', () => {
    const hooks = canonicalInstalledHooks();
    const seen = new Set<string>();
    for (const h of hooks) {
      expect(seen.has(h)).toBe(false);
      seen.add(h);
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
// 0.45.0 charter item 2 — canonicalInstalledHooks derives from the
// packaged hooks/ filesystem PRIMARILY, with the two source-code
// registries (EXPECTED_HOOKS + defaultDesiredHooks) as defensive
// fallbacks. The cross-check test asserts all three sources agree —
// drift between the FS and either source-code list fails the test
// loudly with a precise discrepancy report.
// ──────────────────────────────────────────────────────────────────────

describe('0.45.0 charter item 2 — three-way cross-check of canonical hook sources', () => {
  it('canonicalHooksFromFilesystem returns a non-empty sorted list when hooks/ exists', () => {
    const fromFs = canonicalHooksFromFilesystem();
    // In the repo and in the packaged tarball, hooks/ ships with
    // every shipped shim. A zero-length result means the FS read
    // failed silently — which the union below covers, but the
    // baseline should be non-empty in a healthy build.
    expect(fromFs.length).toBeGreaterThan(0);
    const sorted = [...fromFs].sort();
    expect(fromFs).toEqual(sorted);
    for (const name of fromFs) {
      expect(name.endsWith('.sh')).toBe(true);
    }
  });

  it('filesystem set equals EXPECTED_HOOKS exactly (drift detector)', () => {
    const fromFs = new Set(canonicalHooksFromFilesystem());
    const fromExpected = new Set(EXPECTED_HOOKS);
    const onlyFs = [...fromFs].filter((n) => !fromExpected.has(n));
    const onlyExpected = [...fromExpected].filter((n) => !fromFs.has(n));
    if (onlyFs.length > 0 || onlyExpected.length > 0) {
      throw new Error(
        `EXPECTED_HOOKS drifted from hooks/ filesystem:\n` +
          `  only in hooks/ FS: ${onlyFs.join(', ') || '(none)'}\n` +
          `  only in EXPECTED_HOOKS: ${onlyExpected.join(', ') || '(none)'}\n` +
          `Add the missing hooks to the source-code registry or remove ` +
          `them from hooks/ — they MUST agree.`,
      );
    }
    expect(fromFs).toEqual(fromExpected);
  });

  it('filesystem set equals defaultDesiredHooks basenames exactly (drift detector)', () => {
    const fromFs = new Set(canonicalHooksFromFilesystem());
    const fromDesired = new Set<string>();
    for (const group of defaultDesiredHooks()) {
      for (const h of group.hooks) {
        const slashIdx = h.command.lastIndexOf('/');
        const basename = slashIdx >= 0 ? h.command.slice(slashIdx + 1) : h.command;
        if (basename.endsWith('.sh')) fromDesired.add(basename);
      }
    }
    const onlyFs = [...fromFs].filter((n) => !fromDesired.has(n));
    const onlyDesired = [...fromDesired].filter((n) => !fromFs.has(n));
    if (onlyFs.length > 0 || onlyDesired.length > 0) {
      throw new Error(
        `defaultDesiredHooks drifted from hooks/ filesystem:\n` +
          `  only in hooks/ FS: ${onlyFs.join(', ') || '(none)'}\n` +
          `  only in defaultDesiredHooks: ${onlyDesired.join(', ') || '(none)'}\n` +
          `Register the missing hooks in settings-merge.ts or drop them ` +
          `from hooks/ — they MUST agree.`,
      );
    }
    expect(fromFs).toEqual(fromDesired);
  });

  it('all three sources produce identical sets (the canonical invariant)', () => {
    const fromFs = new Set(canonicalHooksFromFilesystem());
    const fromExpected = new Set(EXPECTED_HOOKS);
    const fromDesired = new Set<string>();
    for (const group of defaultDesiredHooks()) {
      for (const h of group.hooks) {
        const slashIdx = h.command.lastIndexOf('/');
        const basename = slashIdx >= 0 ? h.command.slice(slashIdx + 1) : h.command;
        if (basename.endsWith('.sh')) fromDesired.add(basename);
      }
    }
    expect(fromFs).toEqual(fromExpected);
    expect(fromFs).toEqual(fromDesired);
    expect(fromExpected).toEqual(fromDesired);
  });

  it('canonicalInstalledHooks reflects the filesystem when no drift exists', () => {
    // When the three sources agree, the union (canonicalInstalledHooks)
    // equals any one of them. This pins the invariant that the
    // fallback union doesn't introduce extra entries.
    const fromFs = new Set(canonicalHooksFromFilesystem());
    const merged = new Set(canonicalInstalledHooks());
    expect(merged).toEqual(fromFs);
  });
});

describe('0.44.0 charter item 1 — buildInstallSummary reflects the canonical hook count + names', () => {
  it('renders the hook count from canonicalInstalledHooks', () => {
    const summary = buildInstallSummary('/p', fakeConfig(), false, FAKE_BOTH);
    const expected = canonicalInstalledHooks();
    // The summary line for the hooks directory should report the
    // exact count, not a hard-coded one. Allowing the count to drift
    // is exactly the bug this fix targets.
    expect(summary).toContain(`${expected.length} hook scripts`);
  });

  it('lists every hook basename returned by canonicalInstalledHooks', () => {
    const summary = buildInstallSummary('/p', fakeConfig(), false, FAKE_BOTH);
    for (const name of canonicalInstalledHooks()) {
      expect(summary).toContain(name);
    }
  });

  it('does NOT contain hard-coded hook names not in the canonical list', () => {
    // Regression guard: if a future edit reintroduces a hard-coded
    // entry that ALSO drops the canonical derivation, this catches it
    // by ensuring the summary's hook section length matches what we
    // computed. We do this by counting lines that start with the
    // hook-indent (6 spaces + name + ".sh").
    const summary = buildInstallSummary('/p', fakeConfig(), false, FAKE_BOTH);
    const expected = canonicalInstalledHooks();
    const hookLines = summary
      .split('\n')
      .filter((l) => /^ {6}[A-Za-z0-9._-]+\.sh$/.test(l));
    expect(hookLines.length).toBe(expected.length);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 0.44.0 charter item 2 — exec-bit health check is Windows/WSL aware.
// On mode-less filesystems we skip the 0o111 check and verify file
// presence + non-empty content instead, with a one-liner advisory
// explaining the skip.
// ──────────────────────────────────────────────────────────────────────

describe('0.44.0 charter item 2 — isModeLessFilesystem detection', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('returns false on a normal Unix-mode directory with a real .sh present', async () => {
    if (process.platform === 'win32') return; // not applicable
    const dir = await makeScratch();
    cleanup.push(dir);
    const hooksDir = path.join(dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'sample.sh');
    await fs.writeFile(hookPath, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    expect(isModeLessFilesystem(hooksDir)).toBe(false);
  });

  it('returns true when ALL 0o777 bits are clear (simulated mode-less FS)', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeScratch();
    cleanup.push(dir);
    const hooksDir = path.join(dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'sample.sh');
    await fs.writeFile(hookPath, '#!/bin/bash\nexit 0\n');
    // Some POSIX systems refuse a chmod to 0; do a best-effort and
    // skip the assertion when the kernel won't honor it. (Linux
    // typically refuses chmod 000 from a non-root process; macOS
    // allows it.)
    try {
      await fs.chmod(hookPath, 0o000);
    } catch {
      return;
    }
    const stat = await fs.stat(hookPath);
    if ((stat.mode & 0o777) !== 0) return; // kernel didn't honor
    expect(isModeLessFilesystem(hooksDir)).toBe(true);
    // Restore so cleanup can remove the file.
    await fs.chmod(hookPath, 0o644).catch(() => {});
  });

  it('returns false when the hooks dir contains no .sh files (lets the existence check fire)', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeScratch();
    cleanup.push(dir);
    const hooksDir = path.join(dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    // Empty directory — no .sh files to sample.
    expect(isModeLessFilesystem(hooksDir)).toBe(false);
  });

  it('returns false when readdir throws (lets the caller surface the real error)', () => {
    // Non-existent path — readdir will throw ENOENT. We expect
    // isModeLessFilesystem to swallow the error and return false so
    // the caller's enumeration sees the real failure.
    expect(isModeLessFilesystem('/this/path/does/not/exist/anywhere')).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────────────
// 0.45.0 charter item 3 + codex round-1 P1 — broaden mode-less
// detection but DON'T mask broken Unix installs. Pre-0.45.0 only
// `0o000` triggered. Post-charter `0o777` and `0o644`/`0o666` also
// trigger — but the `0o644`/`0o666` branch MUST disambiguate "real
// mode-less mount" from "chmod-stripped Unix install" via an active
// write-then-stat probe (codex round-1 P1). Otherwise a broken copy
// regresses from a detected install failure to a false green.
// ──────────────────────────────────────────────────────────────────────

describe('0.45.0 charter item 3 + codex round-1 P1 — isModeLessFilesystem with active probe', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('returns TRUE for 0o000 (case a — unambiguous mode-less shape, no probe needed)', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeScratch();
    cleanup.push(dir);
    const hooksDir = path.join(dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'sample.sh');
    await fs.writeFile(hookPath, '#!/bin/bash\nexit 0\n');
    try {
      await fs.chmod(hookPath, 0o000);
    } catch {
      return;
    }
    const stat = await fs.stat(hookPath);
    if ((stat.mode & 0o777) !== 0) return; // kernel didn't honor
    expect(isModeLessFilesystem(hooksDir)).toBe(true);
    await fs.chmod(hookPath, 0o644).catch(() => {});
  });

  it('returns TRUE for 0o777 (case b — everything-exec, no mode info)', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeScratch();
    cleanup.push(dir);
    const hooksDir = path.join(dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'sample.sh');
    await fs.writeFile(hookPath, '#!/bin/bash\nexit 0\n', { mode: 0o777 });
    const stat = await fs.stat(hookPath);
    if ((stat.mode & 0o777) !== 0o777) return; // umask masked some bits
    expect(isModeLessFilesystem(hooksDir)).toBe(true);
  });

  it('returns FALSE for 0o755 (positive control — genuine Unix exec)', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeScratch();
    cleanup.push(dir);
    const hooksDir = path.join(dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'sample.sh');
    await fs.writeFile(hookPath, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
    const stat = await fs.stat(hookPath);
    if ((stat.mode & 0o777) !== 0o755) return; // umask normalization
    expect(isModeLessFilesystem(hooksDir)).toBe(false);
  });

  it('returns FALSE for 0o644 on a real Unix FS (codex round-1 P1 — probe disambiguates)', async () => {
    // Pre-fix the 0o644 branch unconditionally returned TRUE,
    // masking a chmod-stripped install. Post-fix the active probe
    // catches "real Unix FS preserves mode bits", so 0o644 on a
    // genuine FS returns FALSE — caller surfaces the real "zero
    // executable .sh files" error instead of an advisory.
    if (process.platform === 'win32') return;
    const dir = await makeScratch();
    cleanup.push(dir);
    const hooksDir = path.join(dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const hookPath = path.join(hooksDir, 'sample.sh');
    await fs.writeFile(hookPath, '#!/bin/bash\nexit 0\n', { mode: 0o644 });
    const stat = await fs.stat(hookPath);
    if ((stat.mode & 0o111) !== 0) return; // kernel added exec, skip
    // The active probe on a real Unix FS will succeed and return
    // false (mode bits preserved). isModeLessFilesystem therefore
    // returns false even though the sampled hook has no exec bits.
    expect(isModeLessFilesystem(hooksDir)).toBe(false);
  });
});

describe('0.45.0 codex round-1 P1 — filesystemIgnoresModeBits active probe', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('returns FALSE on a real Unix FS that preserves mode bits', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeScratch();
    cleanup.push(dir);
    const hooksDir = path.join(dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    expect(filesystemIgnoresModeBits(hooksDir)).toBe(false);
  });

  it('cleans up the probe file even on success', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeScratch();
    cleanup.push(dir);
    const hooksDir = path.join(dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    filesystemIgnoresModeBits(hooksDir);
    const entries = await fs.readdir(hooksDir);
    const probeLeftBehind = entries.filter((e) => e.includes('rea-modeless-probe'));
    expect(probeLeftBehind).toEqual([]);
  });

  it('returns FALSE conservatively when the probe write fails', () => {
    // Non-existent directory — writeFileSync inside will throw, the
    // helper should return false so the caller surfaces the real
    // failure rather than emit an advisory.
    expect(filesystemIgnoresModeBits('/this/does/not/exist/anywhere/rea-test')).toBe(false);
  });

  it('returns FALSE under restrictive umask (codex round-2 P2 — chmod bypasses umask)', async () => {
    // Pre-fix the probe used writeFileSync({ mode: 0o755 }) which is
    // filtered through process umask. Under `umask 0111` a real
    // Unix FS would stat the probe back as 0o644 and the helper
    // would falsely return true. Post-fix the explicit chmod after
    // create lands exactly the bits we asked for so umask doesn't
    // produce false positives.
    if (process.platform === 'win32') return;
    const dir = await makeScratch();
    cleanup.push(dir);
    const hooksDir = path.join(dir, '.claude', 'hooks');
    await fs.mkdir(hooksDir, { recursive: true });
    const originalUmask = process.umask(0o111); // strip exec bits
    try {
      expect(filesystemIgnoresModeBits(hooksDir)).toBe(false);
    } finally {
      process.umask(originalUmask);
    }
  });
});

describe('0.44.0 charter item 2 — postInstallVerify mode-less FS skip', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });

  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  it('runs the full exec-bit check on a mode-aware FS (no advisory line)', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    const issues = postInstallVerify(dir);
    // Healthy install on mode-aware FS — no issues AT ALL, including
    // no advisory lines.
    expect(issues).toEqual([]);
  });

  it('emits an advisory + skips exec-bit check when 0o777 bits are clear', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    // Simulate mode-less FS by chmod-ing every .sh file under
    // .claude/hooks to 0o000. The exec-bit check would normally
    // fail (zero executable .sh files), but the mode-less detector
    // should catch the FS shape and skip the check.
    const hooksDir = path.join(dir, '.claude', 'hooks');
    const entries = await fs.readdir(hooksDir);
    let restoreNeeded = false;
    for (const entry of entries) {
      if (!entry.endsWith('.sh')) continue;
      try {
        await fs.chmod(path.join(hooksDir, entry), 0o000);
        restoreNeeded = true;
      } catch {
        // best-effort
      }
    }
    // Verify the kernel honored the chmod (otherwise the simulation
    // can't run). Use the first .sh as a probe.
    const firstSh = entries.find((e) => e.endsWith('.sh'));
    if (firstSh === undefined) return;
    const probeStat = await fs.stat(path.join(hooksDir, firstSh));
    if ((probeStat.mode & 0o777) !== 0) return; // kernel didn't honor

    const issues = postInstallVerify(dir);

    // Expect: at least one advisory line, no "zero executable" error.
    expect(issues.some((i) => i.startsWith('advisory:'))).toBe(true);
    expect(issues.some((i) => i.includes('zero executable'))).toBe(false);

    // Restore mode so cleanup can remove files (some filesystems
    // refuse rm on 0o000 directories).
    if (restoreNeeded) {
      for (const entry of entries) {
        if (!entry.endsWith('.sh')) continue;
        await fs.chmod(path.join(hooksDir, entry), 0o644).catch(() => {});
      }
    }
  });

  it('still flags an empty .sh file when exec-bit check is skipped (verifies the substitute invariant)', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    // Truncate every .sh to zero bytes AND clear mode bits — the
    // mode-less branch should still catch the partial-copy failure
    // because the substitute invariant ("non-empty content") is what
    // we run instead of the exec-bit check.
    const hooksDir = path.join(dir, '.claude', 'hooks');
    const entries = await fs.readdir(hooksDir);
    let restoreNeeded = false;
    for (const entry of entries) {
      if (!entry.endsWith('.sh')) continue;
      const p = path.join(hooksDir, entry);
      await fs.writeFile(p, '');
      try {
        await fs.chmod(p, 0o000);
        restoreNeeded = true;
      } catch {
        // best-effort
      }
    }
    const firstSh = entries.find((e) => e.endsWith('.sh'));
    if (firstSh === undefined) return;
    const probeStat = await fs.stat(path.join(hooksDir, firstSh));
    if ((probeStat.mode & 0o777) !== 0) return; // kernel didn't honor

    const issues = postInstallVerify(dir);

    // 0.44.0 codex round-1 P2: the substitute invariant now lists the
    // EMPTY files explicitly (per-file rigor), not a count-only check.
    expect(issues.some((i) => i.includes('empty hook file'))).toBe(true);
    expect(issues.some((i) => i.startsWith('advisory:'))).toBe(true);

    if (restoreNeeded) {
      for (const entry of entries) {
        if (!entry.endsWith('.sh')) continue;
        await fs.chmod(path.join(hooksDir, entry), 0o644).catch(() => {});
      }
    }
  });

  // 0.44.0 codex round-1 P2 fix: on mode-less filesystems, the
  // substitute invariant MUST validate the full canonical hook set,
  // not just "at least one survivor". Pre-fix a partial copy that
  // left one non-empty .sh and dropped the rest would falsely report
  // "install looks healthy".
  it('codex round-1 P2: flags a partial copy on mode-less FS (some hooks missing, one survives)', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    const hooksDir = path.join(dir, '.claude', 'hooks');
    const entries = await fs.readdir(hooksDir);
    // Delete every .sh EXCEPT the first one — simulate the partial-
    // copy failure shape. The pre-fix substitute invariant (shCount > 0
    // && nonEmptyCount > 0) would pass on this; the post-fix per-file
    // check must flag the missing files by name.
    const firstSh = entries.find((e) => e.endsWith('.sh'));
    if (firstSh === undefined) return;
    let restoreCandidates: string[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.sh')) continue;
      if (entry === firstSh) continue;
      await fs.rm(path.join(hooksDir, entry), { force: true });
      restoreCandidates.push(entry);
    }
    // Now clear mode bits on the surviving file to trigger the
    // mode-less branch.
    let restoreNeeded = false;
    try {
      await fs.chmod(path.join(hooksDir, firstSh), 0o000);
      restoreNeeded = true;
    } catch {
      return;
    }
    const probeStat = await fs.stat(path.join(hooksDir, firstSh));
    if ((probeStat.mode & 0o777) !== 0) return;

    const issues = postInstallVerify(dir);

    // Must flag missing files, listing at least one of the canonical
    // hook names we deleted.
    expect(issues.some((i) => i.includes('missing') && i.includes('expected hook file'))).toBe(
      true,
    );
    // Should still emit the advisory line so the operator knows we
    // skipped the exec-bit check.
    expect(issues.some((i) => i.startsWith('advisory:'))).toBe(true);

    if (restoreNeeded) {
      await fs.chmod(path.join(hooksDir, firstSh), 0o644).catch(() => {});
    }
    // restoreCandidates not used for assertions — listed only to make
    // the failure-shape simulation traceable.
    void restoreCandidates;
  });

  it('codex round-1 P2: returns no issues on mode-less FS when ALL canonical hooks are present + non-empty', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    // Trigger the mode-less branch on a HEALTHY install (every
    // canonical hook present + non-empty, just mode bits cleared).
    // The advisory line should fire, but no missing/empty errors.
    const hooksDir = path.join(dir, '.claude', 'hooks');
    const entries = await fs.readdir(hooksDir);
    let restoreNeeded = false;
    for (const entry of entries) {
      if (!entry.endsWith('.sh')) continue;
      try {
        await fs.chmod(path.join(hooksDir, entry), 0o000);
        restoreNeeded = true;
      } catch {
        // best-effort
      }
    }
    const firstSh = entries.find((e) => e.endsWith('.sh'));
    if (firstSh === undefined) return;
    const probeStat = await fs.stat(path.join(hooksDir, firstSh));
    if ((probeStat.mode & 0o777) !== 0) return;

    const issues = postInstallVerify(dir);

    expect(issues.some((i) => i.startsWith('advisory:'))).toBe(true);
    expect(issues.some((i) => i.includes('expected hook file'))).toBe(false);
    expect(issues.some((i) => i.includes('empty hook file'))).toBe(false);

    if (restoreNeeded) {
      for (const entry of entries) {
        if (!entry.endsWith('.sh')) continue;
        await fs.chmod(path.join(hooksDir, entry), 0o644).catch(() => {});
      }
    }
  });

  it('advisory line names the FS class so operators can diagnose the skip', async () => {
    if (process.platform === 'win32') return;
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);

    await runInit({ yes: true, profile: 'minimal', codex: false });

    const hooksDir = path.join(dir, '.claude', 'hooks');
    const entries = await fs.readdir(hooksDir);
    let restoreNeeded = false;
    for (const entry of entries) {
      if (!entry.endsWith('.sh')) continue;
      try {
        await fs.chmod(path.join(hooksDir, entry), 0o000);
        restoreNeeded = true;
      } catch {
        // best-effort
      }
    }
    const firstSh = entries.find((e) => e.endsWith('.sh'));
    if (firstSh === undefined) return;
    const probeStat = await fs.stat(path.join(hooksDir, firstSh));
    if ((probeStat.mode & 0o777) !== 0) return;

    const issues = postInstallVerify(dir);
    const advisory = issues.find((i) => i.startsWith('advisory:'));
    expect(advisory).toBeDefined();
    // Operator-readable: explain WHY the check was skipped.
    expect(advisory).toMatch(/Windows|WSL|SMB|mode bits/);

    if (restoreNeeded) {
      for (const entry of entries) {
        if (!entry.endsWith('.sh')) continue;
        await fs.chmod(path.join(hooksDir, entry), 0o644).catch(() => {});
      }
    }
  });
});

describe('rea init — 0.51.0 spend_governance emission (E1 seed)', () => {
  let prevCwd: string;
  const cleanup: string[] = [];

  beforeEach(() => {
    prevCwd = process.cwd();
  });
  afterEach(async () => {
    process.chdir(prevCwd);
    await Promise.all(cleanup.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
  });

  // The reflex ships ON in every profile; each profile pins the block
  // explicitly so .rea/policy.yaml documents it (activation itself is the
  // opt-out default). codex round-2 P1: the block was never emitted.
  for (const profile of ['minimal', 'open-source', 'bst-internal', 'client-engagement', 'lit-wc']) {
    it(`emits spend_governance enabled:true + warn for profile ${profile}`, async () => {
      const dir = await makeScratch();
      cleanup.push(dir);
      process.chdir(dir);
      await runInit({ yes: true, profile, codex: false });
      const policy = await readPolicy(dir);
      expect(policy).toMatch(/spend_governance:\s*\n\s+enabled:\s+true/);
      expect(policy).toMatch(/billing_error_response:\s+warn/);
    });
  }

  it('preserves an operator billing_error_response override (halt) across re-init', async () => {
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const orig = await readPolicy(dir);
    // Operator opts INTO halt (the seed default is warn); it must survive.
    await fs.writeFile(
      path.join(dir, '.rea', 'policy.yaml'),
      orig.replace(/billing_error_response:\s+warn/, 'billing_error_response: halt'),
      'utf8',
    );
    await runInit({ yes: true, profile: 'minimal', codex: false, force: true });
    const after = await readPolicy(dir);
    expect(after).toMatch(/billing_error_response:\s+halt/);
    expect(after).not.toMatch(/billing_error_response:\s+warn/);
  });

  it('round-trips a MODE-ONLY block (no enabled) across re-init (round-6 P2)', async () => {
    // A valid hand-written opt-out-default block: mode only, `enabled`
    // omitted (defaults true). Pre-fix, `rea init --force` dropped it
    // because the writer only emitted when `enabled` was defined. Use `halt`
    // as the mode so it is distinguishable from the emitted seed default.
    const dir = await makeScratch();
    cleanup.push(dir);
    process.chdir(dir);
    await runInit({ yes: true, profile: 'minimal', codex: false });
    const orig = await readPolicy(dir);
    // Replace the full block with a mode-only one (no enabled line).
    const modeOnly = orig.replace(
      /spend_governance:\s*\n\s+enabled:\s+true\n\s+billing_error_response:\s+warn/,
      'spend_governance:\n  billing_error_response: halt',
    );
    await fs.writeFile(path.join(dir, '.rea', 'policy.yaml'), modeOnly, 'utf8');
    await runInit({ yes: true, profile: 'minimal', codex: false, force: true });
    const after = await readPolicy(dir);
    // The mode-only override survives; it is NOT dropped or reset.
    expect(after).toMatch(/spend_governance:/);
    expect(after).toMatch(/billing_error_response:\s+halt/);
  });
});
