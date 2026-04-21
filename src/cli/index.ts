#!/usr/bin/env node

import { Command } from 'commander';
import { runAuditRecordCodexReview, runAuditRotate, runAuditVerify } from './audit.js';
import {
  parseCacheResult,
  runCacheCheck,
  runCacheClear,
  runCacheList,
  runCacheSet,
} from './cache.js';
import { runCheck } from './check.js';
import { runDoctor } from './doctor.js';
import { runFreeze, runUnfreeze } from './freeze.js';
import { runInit } from './init.js';
import { runServe } from './serve.js';
import { runStatus } from './status.js';
import { runUpgrade } from './upgrade.js';
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
    .action(async (opts: { dryRun?: boolean; yes?: boolean; force?: boolean }) => {
      await runUpgrade({
        dryRun: opts.dryRun,
        yes: opts.yes,
        force: opts.force,
      });
    });

  program
    .command('serve')
    .description('Start the MCP gateway — stdio server that proxies downstream MCPs declared in .rea/registry.yaml through the middleware chain.')
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

  const auditRecord = audit
    .command('record')
    .description('Emit a structured audit record (D).');

  auditRecord
    .command('codex-review')
    .description(
      'Append a codex.review audit entry the push-review cache gate recognizes. Optionally sets the review-cache in one atomic invocation.',
    )
    .requiredOption('--head-sha <sha>', 'git HEAD SHA the review covers')
    .requiredOption('--branch <branch>', 'feature branch under review')
    .requiredOption('--target <target>', 'base ref or SHA diffed against (e.g. main)')
    .requiredOption('--verdict <verdict>', 'one of: pass | concerns | blocking | error')
    .requiredOption('--finding-count <N>', 'non-negative integer finding count', (raw) => {
      const n = Number.parseInt(raw, 10);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`--finding-count must be a non-negative integer; got ${JSON.stringify(raw)}`);
      }
      return n;
    })
    .option('--summary <text>', 'one-sentence review summary (optional)')
    .option('--session-id <id>', 'session id to attribute (defaults to "external")')
    .option(
      '--also-set-cache',
      'atomically update .rea/review-cache.jsonl to reflect this verdict (recommended for post-review push flow)',
    )
    .action(
      async (opts: {
        headSha: string;
        branch: string;
        target: string;
        verdict: string;
        findingCount: number;
        summary?: string;
        sessionId?: string;
        alsoSetCache?: boolean;
      }) => {
        if (
          opts.verdict !== 'pass' &&
          opts.verdict !== 'concerns' &&
          opts.verdict !== 'blocking' &&
          opts.verdict !== 'error'
        ) {
          throw new Error(
            `--verdict must be one of pass|concerns|blocking|error; got ${JSON.stringify(opts.verdict)}`,
          );
        }
        await runAuditRecordCodexReview({
          headSha: opts.headSha,
          branch: opts.branch,
          target: opts.target,
          verdict: opts.verdict,
          findingCount: opts.findingCount,
          ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
          ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
          ...(opts.alsoSetCache === true ? { alsoSetCache: true } : {}),
        });
      },
    );

  const cache = program
    .command('cache')
    .description(
      'Review-cache operations — check/set/clear/list .rea/review-cache.jsonl (BUG-009). Used by hooks/push-review-gate.sh to skip re-review on a previously-approved diff.',
    );

  cache
    .command('check <sha>')
    .description(
      'Look up a cache entry. Emits JSON to stdout ONLY — hook contract. On hit: {hit,true,result,branch,base,recorded_at[,reason]}. On miss: {hit:false}. Never exits non-zero for normal miss.',
    )
    .requiredOption('--branch <branch>', 'feature branch being pushed')
    .requiredOption('--base <base>', 'base branch the feature targets')
    .action(async (sha: string, opts: { branch: string; base: string }) => {
      await runCacheCheck({ sha, branch: opts.branch, base: opts.base });
    });

  cache
    .command('set <sha> <result>')
    .description(
      'Record a review outcome. <result> accepts pass|fail (historical) or pass|concerns|blocking|error (Codex verdicts). concerns→pass, blocking|error→fail. Idempotent line-per-invocation; last write wins on (sha, branch, base).',
    )
    .requiredOption('--branch <branch>', 'feature branch being pushed')
    .requiredOption('--base <base>', 'base branch the feature targets')
    .option('--reason <text>', 'free-text context for this entry (recommended on fail)')
    .action(
      async (
        sha: string,
        rawResult: string,
        opts: { branch: string; base: string; reason?: string },
      ) => {
        const result = parseCacheResult(rawResult);
        await runCacheSet({
          sha,
          result,
          branch: opts.branch,
          base: opts.base,
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        });
      },
    );

  cache
    .command('clear <sha>')
    .description('Remove every cache entry matching <sha>. Dev convenience — prints the removed count.')
    .action(async (sha: string) => {
      await runCacheClear({ sha });
    });

  cache
    .command('list')
    .description('Print cache entries in file order. Filter with --branch.')
    .option('--branch <branch>', 'only list entries for this branch')
    .action(async (opts: { branch?: string }) => {
      await runCacheList({ ...(opts.branch !== undefined ? { branch: opts.branch } : {}) });
    });

  program
    .command('doctor')
    .description('Validate the install: policy parses, .rea/ layout, hooks, Codex plugin.')
    .option('--metrics', 'also print a 7-day summary of Codex telemetry (G11.5)')
    .option('--drift', 'report drift vs. the install manifest (read-only; does not mutate)')
    .action(async (opts: { metrics?: boolean; drift?: boolean }) => {
      await runDoctor({
        ...(opts.metrics === true ? { metrics: true } : {}),
        ...(opts.drift === true ? { drift: true } : {}),
      });
    });

  await program.parseAsync(process.argv);
}

main().catch((e: unknown) => {
  err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
