#!/usr/bin/env node

import { Command } from 'commander';
import { runAuditRotate, runAuditVerify } from './audit.js';
import { registerAuditSpecialistsSubcommand } from './audit-specialists.js';
import { runCheck } from './check.js';
import { registerHookCommand } from './hook.js';
import { runDoctor } from './doctor.js';
import { runFreeze, runUnfreeze } from './freeze.js';
import { runInit } from './init.js';
import { registerPreflightCommand } from './preflight.js';
import { registerReviewCommand } from './review.js';
import { runServe } from './serve.js';
import { runStatus } from './status.js';
import { runTofuAccept, runTofuList } from './tofu.js';
import { runUpgrade } from './upgrade.js';
import { runUpgradeCheck } from './upgrade-check.js';
import { registerAuditSummaryCommand } from './audit-summary.js';
import { registerAuditByToolCommand } from './audit-by-tool.js';
import { registerAuditTimelineCommand } from './audit-timeline.js';
import { registerAuditTopBlocksCommand } from './audit-top-blocks.js';
import { registerVerifyClaimCommand } from './verify-claim.js';
import { registerConfigCommand } from './config-key.js';
import { registerTrustCommands } from './trust.js';
import { registerInstallCommand } from './install/global.js';
import { err, getPkgVersion } from './utils.js';

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('rea')
    .description('Agentic governance layer for Claude Code — policy, hooks, middleware, audit.')
    .version(getPkgVersion(), '-v, --version', 'print rea version');

  program
    .command('init')
    .description(
      'Interactive wizard — write .rea/policy.yaml, install .claude/, commit-msg hook, and CLAUDE.md fragment',
    )
    .option('-y, --yes', 'non-interactive mode — accept defaults, skip existing files')
    .option('--from-reagent', 'migrate from a .reagent/ directory if present')
    .option(
      '--profile <name>',
      'profile: minimal | client-engagement | bst-internal | bst-internal-no-codex | lit-wc | open-source | open-source-no-codex',
    )
    .option('--force', 'overwrite existing .claude/ artifacts and .rea/policy.yaml')
    .option(
      '--accept-dropped-fields',
      'allow reagent translation when drop-list fields are present (security-adjacent)',
    )
    // Commander's boolean-with-negation pair: `--codex` sets codex=true,
    // `--no-codex` sets codex=false. Leaving both unset produces
    // `opts.codex === undefined`, and runInit derives the value from the
    // profile name.
    .option('--codex', 'require Codex adversarial review (writes review.codex_required: true)')
    .option('--no-codex', 'disable Codex adversarial review (writes review.codex_required: false)')
    .action(
      async (opts: {
        yes?: boolean;
        fromReagent?: boolean;
        profile?: string;
        force?: boolean;
        acceptDroppedFields?: boolean;
        codex?: boolean;
      }) => {
        await runInit({
          yes: opts.yes,
          fromReagent: opts.fromReagent,
          profile: opts.profile,
          force: opts.force,
          acceptDroppedFields: opts.acceptDroppedFields,
          codex: opts.codex,
        });
      },
    );

  program
    .command('upgrade')
    .description(
      'Sync .claude/, .husky/, and managed fragments with this rea version. Prompts on drift; auto-updates unmodified files.',
    )
    .option('--dry-run', 'show what would change; write nothing')
    .option('-y, --yes', 'non-interactive — keep drifted files, skip removed-upstream')
    .option('--force', 'non-interactive — overwrite drift, delete removed-upstream')
    // 0.41.0 — `--check` is a non-interactive, structured preview that
    // emits unified diffs per modified file and exits 0 regardless of
    // what would change. Distinct from `--dry-run`, which rehearses the
    // FULL interactive flow with writes suppressed. Use `--check` in CI
    // to surface the changes a `rea upgrade` PR would produce; use
    // `--dry-run` locally to walk through the same prompts you'd see
    // during a real upgrade.
    .option('--check', '0.41.0 — preview-only mode: classify files, emit unified diffs, exit 0')
    .option('--json', '(with --check) emit a single JSON document instead of the text summary')
    .option('--no-diff', '(with --check) omit unified-diff bodies (counts + paths only)')
    .action(
      async (opts: {
        dryRun?: boolean;
        yes?: boolean;
        force?: boolean;
        check?: boolean;
        json?: boolean;
        diff?: boolean;
      }) => {
        if (opts.check === true) {
          await runUpgradeCheck({
            json: opts.json === true,
            noDiff: opts.diff === false,
          });
          return;
        }
        // Codex round-2 P1: `--json` / `--no-diff` are preview-only.
        // Before this PR they were unknown flags and commander rejected
        // them; now they exist on the command. Refuse them without
        // `--check` rather than silently performing a real upgrade —
        // a CI typo (`rea upgrade --json` without `--check`) must not
        // rewrite `.claude/` / `.husky/` / managed fragments.
        if (opts.json === true || opts.diff === false) {
          err('`--json` / `--no-diff` are preview-only flags; pass `--check` to use them.');
          process.exit(2);
        }
        await runUpgrade({
          dryRun: opts.dryRun,
          yes: opts.yes,
          force: opts.force,
        });
      },
    );

  program
    .command('serve')
    .description(
      'Start the MCP gateway — stdio server that proxies downstream MCPs declared in .rea/registry.yaml through the middleware chain.',
    )
    .action(async () => {
      await runServe();
    });

  program
    .command('freeze')
    .description('Write .rea/HALT to block agent operations. Requires --reason.')
    .requiredOption('--reason <text>', 'why you are freezing (stored in .rea/HALT)')
    .action((opts: { reason: string }) => {
      runFreeze({ reason: opts.reason });
    });

  program
    .command('unfreeze')
    .description('Remove .rea/HALT. Confirms interactively unless --yes is set.')
    .option('-y, --yes', 'skip confirmation prompt')
    .action(async (opts: { yes?: boolean }) => {
      await runUnfreeze({ yes: opts.yes });
    });

  program
    .command('check')
    .description('Read-only status — autonomy, HALT, profile, recent audit entries.')
    .action(() => {
      runCheck();
    });

  program
    .command('status')
    .description(
      'Running-process view — is `rea serve` live for this project? Session id, policy summary, audit stats. Use `rea check` for the on-disk view.',
    )
    .option('--json', 'emit JSON instead of the pretty table (composes with jq)')
    .action((opts: { json?: boolean }) => {
      runStatus({ json: opts.json });
    });

  const audit = program
    .command('audit')
    .description('Audit log operations — rotate and verify .rea/audit.jsonl (G1).');

  audit
    .command('rotate')
    .description('Force-rotate .rea/audit.jsonl now. Preserves hash-chain via a marker record.')
    .action(async () => {
      await runAuditRotate({});
    });

  audit
    .command('verify')
    .description('Re-hash the audit chain; exit 0 on clean, 1 on the first tampered record.')
    .option(
      '--since <file>',
      'verify starting at a rotated file (e.g. audit-YYYYMMDD-HHMMSS.jsonl), walking forward through the chain',
    )
    .action(async (opts: { since?: string }) => {
      await runAuditVerify({ ...(opts.since !== undefined ? { since: opts.since } : {}) });
    });

  // 0.29.0 — `rea audit specialists` reader for delegation-telemetry
  // records. Read-only; honors $CLAUDE_SESSION_ID for current-session
  // filtering. v1 omits --since / --session (deferred to 0.29.1).
  registerAuditSpecialistsSubcommand(audit);

  // 0.41.0 — `rea audit summary [--since=DUR] [--json]` high-level
  // overview reader. Counts events by tool_name, tier, session,
  // status; samples chain integrity. Tier-Read; never mutates.
  registerAuditSummaryCommand(audit);

  // 0.46.0 charter item 1 — `rea audit by-tool [--top=N] [--since=DUR]
  // [--json]`. Higher-fidelity tool_name distribution than `summary`
  // (which caps at 12 + `(other)`). Reads the same rotated-file walk.
  registerAuditByToolCommand(audit);

  // 0.46.0 charter item 2 — `rea audit timeline [--bucket=HOUR|DAY]
  // [--since=DUR] [--json]`. Time-bucketed event counts with inline
  // histogram. Useful for spotting activity spikes + cadence patterns.
  registerAuditTimelineCommand(audit);

  // 0.47.0 charter item 3 — `rea audit top-blocks [--limit=N]
  // [--since=DUR] [--json]`. Most-recent refusal events (denied/error).
  // The "why was that refused?" debugging lens.
  registerAuditTopBlocksCommand(audit);

  // Register `rea hook push-gate` — the stateless pre-push Codex gate
  // called by `.husky/pre-push` and `.git/hooks/pre-push`.
  registerHookCommand(program);

  // 0.26.0 local-first enforcement (CTO directive 2026-05-05). Two new
  // top-level CLIs: `rea review` writes `rea.local_review` audit entries;
  // `rea preflight` reads them and refuses pushes/commits without a
  // recent matching entry. The husky pre-push template + Bash-tier
  // `local-review-gate.sh` hook both delegate to `rea preflight --strict`.
  registerReviewCommand(program);
  registerPreflightCommand(program);

  // 0.28.0 — `rea verify-claim <claim-id>` replays recorded
  // security-claim PoC batteries against the CLI under test. The
  // centerpiece of 0.28.0 (4th structural pivot — claims as
  // machine-verifiable artifacts).
  registerVerifyClaimCommand(program);

  // 0.50.x — `rea config set-key|get-key|unset-key|list` manage review-provider
  // API keys in the managed credentials file (~/.config/rea/credentials, 0600).
  // The openrouter provider resolves its key env-first, then from this file.
  registerConfigCommand(program);

  // Phase 3a — the opt-in global rea CLI tier's writer surface. `rea trust` /
  // `rea untrust` / `rea trust --list` manage the per-user allow-list
  // (<home>/.rea/trusted-projects); `rea install --global` drops a real
  // per-user CLI at <home>/.rea/cli. Both derive the per-user root from the
  // password database (never $HOME/$XDG_*) — an env-redirectable trust root
  // would re-open the N3 surface the tier closes.
  registerTrustCommands(program);
  registerInstallCommand(program);

  const tofu = program
    .command('tofu')
    .description(
      'TOFU fingerprint operations (G7) — inspect and rebase `.rea/fingerprints.json` when a legitimate registry edit has triggered drift fail-close. Emits audit records.',
    );

  tofu
    .command('list')
    .description(
      'Print every server declared in `.rea/registry.yaml` with its current-vs-stored fingerprint verdict (first-seen | unchanged | drifted).',
    )
    .option('--json', 'emit JSON instead of the human-readable table')
    .action(async (opts: { json?: boolean }) => {
      await runTofuList({ ...(opts.json === true ? { json: true } : {}) });
    });

  tofu
    .command('accept <name>')
    .description(
      'Rebase the stored fingerprint for <name> to match the current canonical shape in `.rea/registry.yaml`. Use after a deliberate registry edit (vault added, command path renamed, env-key set changed). Emits a `tofu.drift_accepted_by_cli` audit record; next `rea serve` will classify as unchanged.',
    )
    .option(
      '--reason <text>',
      'free-text note captured in the audit record (recommended when accepting drift — explains WHY the canonical shape changed)',
    )
    .action(async (name: string, opts: { reason?: string }) => {
      await runTofuAccept({ name, ...(opts.reason !== undefined ? { reason: opts.reason } : {}) });
    });

  program
    .command('doctor')
    .description('Validate the install: policy parses, .rea/ layout, hooks, Codex plugin.')
    .option('--metrics', 'also print a 7-day summary of Codex telemetry (G11.5)')
    .option('--drift', 'report drift vs. the install manifest (read-only; does not mutate)')
    .option(
      '--smoke',
      'also run the delegation-signal round-trip: drives the real `.claude/hooks/delegation-capture.sh` shell hook end-to-end (writes a probe `rea.delegation_signal` audit record and verifies chain integrity)',
    )
    .option(
      '--strict',
      '0.30.0 Class M — promote settings.json schema warnings (zod parse failures, path traversal, missing rea hooks) to hard fail. Use in CI gates.',
    )
    .action(
      async (opts: { metrics?: boolean; drift?: boolean; smoke?: boolean; strict?: boolean }) => {
        await runDoctor({
          ...(opts.metrics === true ? { metrics: true } : {}),
          ...(opts.drift === true ? { drift: true } : {}),
          ...(opts.smoke === true ? { smoke: true } : {}),
          ...(opts.strict === true ? { strict: true } : {}),
        });
      },
    );

  await program.parseAsync(process.argv);
}

main().catch((e: unknown) => {
  err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
