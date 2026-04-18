#!/usr/bin/env node

import { Command } from 'commander';
import { runCheck } from './check.js';
import { runDoctor } from './doctor.js';
import { runFreeze, runUnfreeze } from './freeze.js';
import { runInit } from './init.js';
import { runServe } from './serve.js';
import { err, getPkgVersion } from './utils.js';

async function main(): Promise<void> {
  const program = new Command();

  program
    .name('rea')
    .description('Agentic governance layer for Claude Code — policy, hooks, middleware, audit.')
    .version(getPkgVersion(), '-v, --version', 'print rea version');

  program
    .command('init')
    .description('Interactive wizard — write .rea/policy.yaml and .rea/registry.yaml')
    .option('-y, --yes', 'non-interactive mode — accept defaults for all prompts')
    .option('--from-reagent', 'migrate from a .reagent/ directory if present')
    .option(
      '--profile <name>',
      'profile: minimal | client-engagement | bst-internal | lit-wc | open-source',
    )
    .action(async (opts: { yes?: boolean; fromReagent?: boolean; profile?: string }) => {
      await runInit({
        yes: opts.yes,
        fromReagent: opts.fromReagent,
        profile: opts.profile,
      });
    });

  program
    .command('serve')
    .description('Start the MCP gateway (stub — prints status, verifies policy loads).')
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
    .command('doctor')
    .description('Validate the install: policy parses, .rea/ layout, hooks, Codex plugin.')
    .action(() => {
      runDoctor();
    });

  await program.parseAsync(process.argv);
}

main().catch((e: unknown) => {
  err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
