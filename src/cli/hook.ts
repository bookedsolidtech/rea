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

import fs from 'node:fs';
import path from 'node:path';
import type { Command } from 'commander';
import { parsePrePushStdin, runPushGate } from '../hooks/push-gate/index.js';
import { runBlockedScan, runProtectedScan, type Verdict } from '../hooks/bash-scanner/index.js';
import { loadPolicy } from '../policy/loader.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../audit/append.js';
import { err } from './utils.js';

export interface HookPushGateOptions {
  base?: string;
  /**
   * Diff against `HEAD~N` instead of running the upstream ladder. Mirrors
   * `policy.review.last_n_commits`; the CLI flag wins when both are set.
   * `--base` always wins over both. Validated as a positive integer; the
   * CLI rejects non-numeric input before reaching `runPushGate`.
   */
  lastNCommits?: number;
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
      ...(options.base !== undefined && options.base.length > 0
        ? { explicitBase: options.base }
        : {}),
      ...(options.lastNCommits !== undefined ? { lastNCommits: options.lastNCommits } : {}),
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
 * `rea hook scan-bash --mode protected|blocked` — invoked by the bash
 * shim hooks at `hooks/protected-paths-bash-gate.sh` and
 * `hooks/blocked-paths-bash-gate.sh` (since 0.23.0). Reads the Claude
 * Code tool-input JSON from stdin, extracts `.tool_input.command`,
 * runs the parser-backed scanner, and writes a verdict JSON to stdout.
 *
 * Exit-code contract (parsed by the bash shim via `jq`):
 *   0 — allow (verdict.verdict == "allow")
 *   2 — block (verdict.verdict == "block")
 *   1 — runtime error (HALT active, missing args, internal exception)
 *
 * The verdict shape on stdout is `Verdict` (see `verdict.ts`); the
 * bash shim only reads `.verdict` and `.reason`. Other fields are for
 * structured-logging consumers in tests + audit middleware.
 *
 * HALT is checked HERE (not in the bash shim) so we have a single
 * source of truth — the shim is intentionally as dumb as possible.
 */
export interface HookScanBashOptions {
  mode: 'protected' | 'blocked';
  /**
   * Override REA_ROOT. Useful in tests; the production shim doesn't
   * pass this — it relies on `process.cwd()` matching CLAUDE_PROJECT_DIR.
   */
  reaRoot?: string;
}

interface ScanBashStdinPayload {
  tool_input?: {
    command?: unknown;
  };
}

/**
 * The non-async entry the commander binding hits. Reads stdin (with
 * a timeout — same pattern as runHookPushGate), executes the scan,
 * writes the verdict JSON, exits with the appropriate code.
 */
export async function runHookScanBash(options: HookScanBashOptions): Promise<void> {
  const reaRoot = options.reaRoot ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();

  // HALT check — uniform with the bash hooks. We exit 2 (block) so
  // the shim refuses the command in the same way settings-protection
  // and the bash gates do.
  const haltPath = path.join(reaRoot, '.rea', 'HALT');
  if (fs.existsSync(haltPath)) {
    let reason = 'Reason unknown';
    try {
      const content = fs.readFileSync(haltPath, 'utf8');
      reason = content.slice(0, 1024).trim() || reason;
    } catch {
      /* leave default */
    }
    process.stderr.write(
      `REA HALT: ${reason}\nAll agent operations suspended. Run: rea unfreeze\n`,
    );
    const haltVerdict: Verdict = {
      verdict: 'block',
      reason: 'rea HALT active',
    };
    process.stdout.write(JSON.stringify(haltVerdict) + '\n');
    process.exit(2);
  }

  const stdinRaw = process.stdin.isTTY ? '' : await readStdinWithTimeout(5_000);
  let cmd = '';
  if (stdinRaw.length > 0) {
    try {
      const parsed: ScanBashStdinPayload = JSON.parse(stdinRaw);
      const c = parsed.tool_input?.command;
      // Codex round 1 F-31: tool_input.command MUST be a string. A
      // crafted payload with `command: ["rm", "-rf"]` or `command: 42`
      // would pre-fix silently fall through to "allow on empty cmd".
      // Refuse on type mismatch.
      if (c !== undefined && typeof c !== 'string') {
        const wrong: Verdict = {
          verdict: 'block',
          reason:
            'rea: scan-bash received a non-string `tool_input.command` field; refusing on uncertainty',
        };
        process.stdout.write(JSON.stringify(wrong) + '\n');
        process.stderr.write(wrong.reason + '\n');
        process.exit(2);
      }
      if (typeof c === 'string') cmd = c;
    } catch {
      // Malformed JSON on stdin → fail closed. The bash shim only
      // forwards what Claude Code sends, so this should never happen
      // in production; treating it as block prevents a crafted payload
      // from getting an allow.
      const malformed: Verdict = {
        verdict: 'block',
        reason: 'rea: scan-bash received malformed JSON on stdin; refusing on uncertainty',
      };
      process.stdout.write(JSON.stringify(malformed) + '\n');
      process.exit(2);
    }
  }
  // Empty command → allow. Matches the bash gates' `[[ -z "$CMD" ]] && exit 0`.
  if (cmd.length === 0) {
    process.stdout.write(JSON.stringify({ verdict: 'allow' }) + '\n');
    process.exit(0);
  }

  // Load policy. A missing policy file is treated as "no governance" —
  // we allow on missing-policy so dev environments without a fully-
  // initialized rea directory don't hard-block. The bash shim
  // pre-0.23.0 had the same posture.
  let blockedPaths: readonly string[] = [];
  let protectedWrites: string[] | undefined;
  let protectedRelax: string[] = [];
  try {
    const policy = loadPolicy(reaRoot);
    blockedPaths = policy.blocked_paths;
    protectedWrites = policy.protected_writes;
    protectedRelax = policy.protected_paths_relax ?? [];
  } catch {
    // Policy missing or invalid. Continue with defaults — the historical
    // protected list is hardcoded; blocked_paths becomes an empty no-op.
  }

  let verdict: Verdict;
  try {
    if (options.mode === 'protected') {
      verdict = runProtectedScan(
        {
          reaRoot,
          policy: {
            ...(protectedWrites !== undefined ? { protected_writes: protectedWrites } : {}),
            protected_paths_relax: protectedRelax,
          },
          stderr: (line) => process.stderr.write(line),
        },
        cmd,
      );
    } else {
      verdict = runBlockedScan({ reaRoot, blockedPaths }, cmd);
    }
  } catch (e) {
    // Any exception in the scanner is a bug; fail closed.
    const reason = e instanceof Error ? e.message : String(e);
    verdict = {
      verdict: 'block',
      reason: `rea: scan-bash internal error; refusing on uncertainty: ${reason}`,
    };
  }

  // Codex round 1 F-26: emit an audit record so the gateway audit log
  // captures every scan-bash invocation. Best-effort — failure to
  // write an audit entry must NOT change the verdict.
  try {
    await appendAuditRecord(reaRoot, {
      tool_name: 'rea.hook.scan-bash',
      server_name: 'rea',
      tier: Tier.Read,
      status: verdict.verdict === 'allow' ? InvocationStatus.Allowed : InvocationStatus.Denied,
      metadata: {
        mode: options.mode,
        verdict: verdict.verdict,
        ...(verdict.detected_form !== undefined ? { detected_form: verdict.detected_form } : {}),
        ...(verdict.hit_pattern !== undefined ? { hit_pattern: verdict.hit_pattern } : {}),
        // Truncate the command to avoid blowing the audit log on very
        // long inputs.
        command_preview: cmd.slice(0, 256),
      },
    });
  } catch {
    /* best-effort */
  }

  // Write verdict JSON to stdout.
  process.stdout.write(JSON.stringify(verdict) + '\n');
  if (verdict.verdict === 'block') {
    if (typeof verdict.reason === 'string' && verdict.reason.length > 0) {
      process.stderr.write(verdict.reason + '\n');
    }
    process.exit(2);
  }
  process.exit(0);
}

/**
 * Attach the `rea hook` subcommand tree to a commander Program. Two
 * subcommands today: `push-gate` and `scan-bash`. New hooks should land
 * here rather than as top-level commands so the CLI surface stays
 * navigable.
 */
export function registerHookCommand(program: Command): void {
  const hook = program
    .command('hook')
    .description(
      'Pre-hook entry points for git (pre-push) and Claude Code. Called by `.husky/pre-push`, the optional `.git/hooks/pre-push` fallback, and the bash-shim Claude Code hooks at `.claude/hooks/{protected,blocked}-paths-bash-gate.sh`.',
    );

  hook
    .command('scan-bash')
    .description(
      'Parser-backed bash-tier scanner. Reads Claude Code tool-input JSON from stdin, runs the AST walker against the protected-paths or blocked_paths policy, and writes a verdict JSON to stdout. Exit 0 on allow, 2 on block.',
    )
    .option(
      '--mode <protected|blocked>',
      'which policy to enforce: `protected` for the hardcoded + protected_writes list, `blocked` for the policy.blocked_paths list',
      (raw: string): 'protected' | 'blocked' => {
        if (raw !== 'protected' && raw !== 'blocked') {
          throw new Error(`--mode must be "protected" or "blocked", got ${JSON.stringify(raw)}`);
        }
        return raw;
      },
      'protected',
    )
    .action(async (opts: { mode: 'protected' | 'blocked' }) => {
      await runHookScanBash({ mode: opts.mode });
    });

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
    .option(
      '--last-n-commits <n>',
      'narrow review to the last N commits (diff against HEAD~N). Useful for large feature branches. Loses to --base when both are set; mirrors policy.review.last_n_commits.',
      (raw: string): number => {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(
            `--last-n-commits must be a positive integer, got ${JSON.stringify(raw)}`,
          );
        }
        return n;
      },
    )
    .action(async (_gitArgs: string[], opts: { base?: string; lastNCommits?: number }) => {
      await runHookPushGate({
        ...(opts.base !== undefined ? { base: opts.base } : {}),
        ...(opts.lastNCommits !== undefined ? { lastNCommits: opts.lastNCommits } : {}),
      });
    });
}
