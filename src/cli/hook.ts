/**
 * `rea hook push-gate` — the CLI surface the husky `.husky/pre-push` stub
 * calls. Stateless pre-push Codex review.
 *
 * Exit-code contract:
 *
 *   0 — push proceeds (pass verdict, empty diff, disabled by policy, or
 *       REA_SKIP_PUSH_GATE waiver)
 *   1 — HALT kill-switch active; block push
 *   2 — blocked by verdict (blocking, or concerns when concerns_blocks=true
 *       and REA_ALLOW_CONCERNS not set), or by codex error (timeout, not
 *       installed, subprocess failure, protocol error)
 *
 * Invocation contract:
 *
 *   rea hook push-gate
 *   rea hook push-gate --base origin/main
 *   rea hook push-gate --base refs/remotes/upstream/main
 *
 * The husky stub does NOT parse the git pre-push stdin contract itself —
 * the 0.10.x bash gate did, to diff refspec-by-refspec; the 0.11.0 gate
 * diffs `HEAD` against the resolved base (upstream → origin/HEAD → …).
 * That is strictly less granular than refspec parsing, but Codex reviews
 * the whole diff anyway and pushing multiple branches simultaneously is
 * vanishingly rare in practice.
 *
 * A missing `.rea/policy.yaml` is treated as "defaults apply" —
 * `codex_required: true`, `concerns_blocks: true`. The gate still fires.
 * This matches the protective default established in 0.10.x.
 */

import type { Command } from 'commander';
import { parsePrePushStdin, runPushGate } from '../hooks/push-gate/index.js';
import { err } from './utils.js';

export interface HookPushGateOptions {
  base?: string;
}

/**
 * Public runner, exposed so integration tests and the commander binding can
 * share the same entry. Throws via `process.exit` rather than returning a
 * code — the commander handler is async but the convention across `src/cli/`
 * is to exit from the leaf (see `audit.ts`, `freeze.ts`). Keeping the
 * behavior consistent prevents commander from inferring its own default.
 */
export async function runHookPushGate(options: HookPushGateOptions): Promise<void> {
  const baseDir = process.cwd();
  const stderr = (line: string): void => {
    process.stderr.write(line);
  };
  // Git's pre-push contract sends one refspec per line on stdin. Read it
  // all upfront with a timeout guard so a misconfigured invocation
  // (stdin pipe never closed) doesn't hang the gate indefinitely. TTY
  // stdin short-circuits to empty — `rea hook push-gate` invoked from
  // a terminal has no refspec data.
  const refspecs = process.stdin.isTTY ? [] : parsePrePushStdin(await readStdinWithTimeout(5_000));
  try {
    const result = await runPushGate({
      baseDir,
      env: process.env,
      stderr,
      refspecs,
      ...(options.base !== undefined && options.base.length > 0 ? { explicitBase: options.base } : {}),
    });
    process.exit(result.exitCode);
  } catch (e) {
    // runPushGate() is written to catch and classify every expected error.
    // Reaching this handler means an unclassified throw — we fail closed
    // with exit 2 so a genuine bug never masquerades as a passing review.
    err(`push-gate internal error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}

/**
 * Read stdin to end with a timeout. Returns '' on timeout — the caller
 * then falls through to the upstream-resolver path instead of blocking
 * the gate on a pipe that may never close.
 *
 * Git ALWAYS closes stdin after sending refspecs, so the timeout is a
 * safety net for weird invocations (running the CLI from a script that
 * piped in nothing, a test that forgot to close the write end, etc.).
 */
async function readStdinWithTimeout(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let resolved = false;
    const finish = (): void => {
      if (resolved) return;
      resolved = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    process.stdin.on('data', (chunk) => {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

/**
 * Attach the `rea hook` subcommand tree to a commander Program. Single
 * subcommand today (`push-gate`); new hooks should land here rather than as
 * top-level commands so the CLI surface stays navigable.
 */
export function registerHookCommand(program: Command): void {
  const hook = program
    .command('hook')
    .description(
      'Pre-hook entry points for git (pre-push) and Claude Code. Called by `.husky/pre-push` and the optional `.git/hooks/pre-push` fallback.',
    );

  hook
    .command('push-gate')
    // Accept (and silently ignore) positional args. Git passes the
    // pre-push hook `<remote-name> <remote-url>` as $@; the husky stub
    // forwards them with `"$@"`. Those values aren't used by the gate
    // directly (base ref + refspecs come from stdin + git tree probes),
    // but commander without this option would reject the invocation.
    // Declared as a variadic positional so an arbitrary number of
    // trailing tokens are accepted.
    .argument('[gitArgs...]', 'positional args forwarded by git (remote name, URL); ignored')
    .description(
      'Run `codex exec review` against the current diff and block on blocking findings. Exits 0/1/2: pass/HALT/blocked. No cache — every push runs Codex afresh.',
    )
    .option(
      '--base <ref>',
      'explicit base ref to diff against (e.g. origin/main). Defaults to @{upstream} → origin/HEAD → main/master → empty-tree.',
    )
    .action(async (_gitArgs: string[], opts: { base?: string }) => {
      await runHookPushGate({ ...(opts.base !== undefined ? { base: opts.base } : {}) });
    });
}
