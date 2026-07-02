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
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { parsePrePushStdin, runPushGate } from '../hooks/push-gate/index.js';
import { runBlockedScan, runProtectedScan, type Verdict } from '../hooks/bash-scanner/index.js';
import { checkHalt, formatHaltBanner } from '../hooks/_lib/halt-check.js';
import { runHookPrIssueLinkGate } from '../hooks/pr-issue-link-gate/index.js';
import { runHookSecurityDisclosureGate } from '../hooks/security-disclosure-gate/index.js';
import { runHookAttributionAdvisory } from '../hooks/attribution-advisory/index.js';
import { runHookEnvFileProtection } from '../hooks/env-file-protection/index.js';
import { runHookDependencyAuditGate } from '../hooks/dependency-audit-gate/index.js';
import { runHookChangesetSecurityGate } from '../hooks/changeset-security-gate/index.js';
import { runHookArchitectureReviewGate } from '../hooks/architecture-review-gate/index.js';
import { runHookDangerousBashInterceptor } from '../hooks/dangerous-bash-interceptor/index.js';
import { runHookLocalReviewGate } from '../hooks/local-review-gate/index.js';
import { runHookSecretScanner } from '../hooks/secret-scanner/index.js';
import { runHookBlockedPathsBashGate } from '../hooks/blocked-paths-bash-gate/index.js';
import { runHookProtectedPathsBashGate } from '../hooks/protected-paths-bash-gate/index.js';
import { runHookBlockedPathsEnforcer } from '../hooks/blocked-paths-enforcer/index.js';
import { runHookSettingsProtection } from '../hooks/settings-protection/index.js';
import { loadPolicy } from '../policy/loader.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../audit/append.js';
import {
  CODEX_REVIEW_TOOL_NAME,
  CODEX_REVIEW_SERVER_NAME,
  type CodexVerdict,
} from '../audit/codex-event.js';
import {
  DELEGATION_SIGNAL_TOOL_NAME,
  DELEGATION_SIGNAL_SERVER_NAME,
  DELEGATION_SIGNAL_SCHEMA_VERSION,
  DelegationSignalMetadataSchema,
  type DelegationSignalMetadata,
  type DelegationTool,
} from '../audit/delegation-event.js';
import {
  compileDefaultSecretPatterns,
  redactSecrets,
  type CompiledSecretPattern,
} from '../gateway/middleware/redact.js';
import {
  CodexNotInstalledError,
  CodexProtocolError,
  CodexSubprocessError,
  CodexTimeoutError,
  IRON_GATE_DEFAULT_MODEL,
  IRON_GATE_DEFAULT_REASONING,
  createRealGitExecutor,
  runCodexReview,
} from '../hooks/push-gate/codex-runner.js';
import { resolveBaseRef } from '../hooks/push-gate/base.js';
import { resolvePushGatePolicy } from '../hooks/push-gate/policy.js';
import { summarizeReview } from '../hooks/push-gate/findings.js';
import { runHookDelegationAdvisory } from './delegation-advisory.js';
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
/**
 * Passwd-derived absolute home directory for the `~/.rea` global-root
 * scanner gate. Uses `os.userInfo().homedir` (libuv `getpwuid_r`), NEVER
 * `$HOME` / `$XDG_*` — an agent can set those in-process, so an
 * env-derived root is exactly the redirect surface this gate closes.
 * Returns undefined on a passwd-lookup failure or a non-absolute home
 * (feature-absent parity, mirroring the shim-runtime's silent
 * "unavailable" — see `shim_global_entry_gate`).
 */
function passwdDerivedHome(): string | undefined {
  try {
    const home = os.userInfo().homedir;
    if (typeof home === 'string' && home.startsWith('/')) return home;
  } catch {
    /* no passwd entry → gate disabled */
  }
  return undefined;
}

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
  // 0.32.0: shared via `src/hooks/_lib/halt-check.ts` so the Phase 1
  // pilots and the codex-review hook below all emit the same banner
  // byte-for-byte and apply the same fail-closed read posture.
  const halt = checkHalt(reaRoot);
  if (halt.halted) {
    process.stderr.write(formatHaltBanner(halt.reason));
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

  // Passwd-derived home for the `~/.rea` global-root gate (safe-global-
  // CLI). Never `$HOME` / `$XDG_*` — an agent can move those in-process.
  // A passwd-lookup failure leaves it undefined → gate disabled
  // (feature-absent parity, mirroring the shim's silent "unavailable").
  const passwdHome = passwdDerivedHome();

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
          ...(passwdHome !== undefined ? { passwdHome } : {}),
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
 * `rea hook policy-get <dot.path>` — single source of truth for
 * policy-value reads from the bash-tier hooks. Round-30 F2 structural
 * fix.
 *
 * Pre-fix: `hooks/_lib/policy-read.sh::policy_nested_scalar` used a
 * regex/awk parser that ONLY handled block-form mappings. The TS loader
 * (`src/policy/loader.ts`) accepted inline-form mappings — `local_review:
 * { mode: off }` — but the bash reader missed them. Silent split-brain:
 * TS preflight saw `mode=off` (no-op), bash gate saw the field as unset
 * and fell through to the enforced default → refused the push.
 *
 * Fix: have the bash gate shell out HERE for nested reads. The TS
 * `yaml.parse()` call accepts both forms identically — single source of
 * truth, drift impossible by construction.
 *
 * Contract:
 *   - `key` is dot-separated: `review.local_review.mode`. Only
 *     scalar leaves are supported (objects/arrays print empty).
 *   - Output is the raw scalar VALUE on stdout (no trailing newline,
 *     no quoting). Booleans render as `true`/`false`. Numbers render
 *     as their JS string form.
 *   - Unknown / missing path → empty stdout, exit 0. The bash caller
 *     treats empty as "default applies".
 *   - Unparseable YAML → empty stdout, exit 1. Bash callers swallow
 *     the exit and treat as default (matches pre-fix posture: any read
 *     error returns empty rather than refusing the gate).
 */
export interface HookPolicyGetOptions {
  /** Dotted path; e.g. `review.local_review.mode`. */
  key: string;
  /**
   * When true, emit the resolved subtree as JSON instead of a scalar.
   * Object/array leaves print as their JSON form; scalars print as
   * JSON-encoded scalars (`"off"`, `42`, `true`, `null`). Missing
   * paths print `null`. Used by the bash hooks to read an entire
   * sub-object in one node-spawn (e.g. all `review.local_review.*`
   * fields at once) and parse client-side via jq.
   */
  json?: boolean;
  /** Override REA_ROOT. Production callers omit. */
  reaRoot?: string;
}

export async function runHookPolicyGet(options: HookPolicyGetOptions): Promise<void> {
  // 0.27.0+: validate the key shape so a malformed dot-path can't be
  // exploited by a misbehaving caller. Allow only POSIX identifier
  // segments separated by single dots; reject empty segments, slashes,
  // shell metacharacters, etc.
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(options.key)) {
    process.stderr.write(`rea hook policy-get: invalid key ${JSON.stringify(options.key)}\n`);
    process.exit(1);
  }

  const reaRoot = options.reaRoot ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
  const policyPath = path.join(reaRoot, '.rea', 'policy.yaml');
  const finishMissing = (): void => {
    if (options.json === true) process.stdout.write('null');
    process.exit(0);
  };
  if (!fs.existsSync(policyPath)) {
    finishMissing();
  }
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(policyPath, 'utf8');
    parsed = parseYaml(raw);
  } catch {
    // Unparseable YAML — emit empty / null and exit 1 so the bash caller
    // can distinguish "no value" from "actual parse failure" if it
    // wants to (the local-review-gate caller swallows exit codes).
    if (options.json === true) process.stdout.write('null');
    process.exit(1);
  }
  if (parsed === null || typeof parsed !== 'object') {
    finishMissing();
  }
  // Walk the dotted path. Bail (empty stdout / null) at any non-object
  // intermediate.
  const segments = options.key.split('.');
  let cursor: unknown = parsed;
  for (const seg of segments) {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
      finishMissing();
    }
    cursor = (cursor as Record<string, unknown>)[seg];
    if (cursor === undefined) {
      finishMissing();
    }
  }
  if (options.json === true) {
    // Emit JSON for scalar/object/array/null. Objects + arrays serialize
    // recursively. Bash callers parse via jq.
    process.stdout.write(JSON.stringify(cursor ?? null));
    process.exit(0);
  }
  // Scalar mode: only print scalar leaves. Objects/arrays print empty
  // (legacy behavior from initial F2 implementation).
  if (cursor === null) {
    process.exit(0);
  }
  if (typeof cursor === 'string') {
    process.stdout.write(cursor);
  } else if (typeof cursor === 'number' || typeof cursor === 'boolean') {
    process.stdout.write(String(cursor));
  }
  // Object/Array → no output (caller treats as unset).
  process.exit(0);
}

/**
 * `rea hook codex-review` — the canonical Bash-direct codex invocation
 * for marathon-mode review cycles (0.27.0+).
 *
 * The user directive is "codex should be invoked this way always to
 * minimize claude consumption of all the output. we just need the log
 * at the end." This command wraps `codex exec review --json --ephemeral`
 * with the same iron-gate model defaults the push-gate uses, tees the
 * raw JSONL stream to a tempfile so the caller can read the
 * un-summarized output directly, parses out the verdict + finding
 * count, writes a `codex.review` audit entry, and prints a single terse
 * status line to stderr. Stdout stays clean — when `--json` is set the
 * canonical JSON summary lands there for jq-style chaining.
 *
 * Distinct from `rea review`:
 *   - `rea review` writes a `rea.local_review` entry the local-review
 *     gate consults and prints human-readable output. Treated as the
 *     primary CLI surface for the local-first workflow.
 *   - `rea hook codex-review` writes a `codex.review` entry (the legacy
 *     gateway shape), keeps the raw JSONL on disk, and is intentionally
 *     terse. Designed for thin-shim invocation from agents and slash
 *     commands that DON'T need a Claude-paraphrased summary — the raw
 *     JSON IS the review.
 *
 * Exit-code contract (mirrors push-gate convention):
 *
 *   0 — pass verdict
 *   1 — concerns verdict
 *   2 — blocking verdict, codex error, or HALT active
 */
export interface HookCodexReviewOptions {
  base?: string;
  /**
   * Mirror of `--last-n-commits` on push-gate. When set, diff against
   * `HEAD~N` instead of running the upstream-resolution ladder. `--base`
   * always wins when both are set. Validated as a positive integer at
   * the commander layer.
   */
  lastNCommits?: number;
  /**
   * Emit a single JSON line on stdout instead of a stderr-only status
   * line. The JSON shape carries `verdict`, `finding_count`, `head_sha`,
   * `target`, `audit_hash`, `raw_path`, and `exit_code`.
   */
  json?: boolean;
  /**
   * Override REA_ROOT. Tests set this; the production caller relies on
   * `process.cwd()`.
   */
  reaRoot?: string;
  /**
   * Test seam — replaces the spawn of `codex exec review`. Same
   * contract as `runCodexReview`'s `spawnImpl`. When set, the codex-
   * availability probe is skipped (matches `runCodexReview` behavior).
   */
  spawnImpl?: Parameters<typeof runCodexReview>[0]['spawnImpl'];
  /**
   * Test seam — override the directory raw stdout is teed into. Default
   * is `os.tmpdir()`. Tests set this so they can read the file back.
   */
  rawStdoutDir?: string;
}

export async function runHookCodexReview(options: HookCodexReviewOptions): Promise<void> {
  const baseDir = options.reaRoot ?? process.cwd();

  // HALT check — uniform with the rest of the hook tree.
  // 0.32.0: shared via `src/hooks/_lib/halt-check.ts`.
  const halt = checkHalt(baseDir);
  if (halt.halted) {
    process.stderr.write(formatHaltBanner(halt.reason));
    process.exit(2);
  }

  // Resolve git context + base ref using the same primitives the push-
  // gate uses. Missing HEAD short-circuits with an explicit error rather
  // than silently coercing — `rea hook codex-review` is intended for
  // explicit invocation, not for the unborn-HEAD bootstrap path that
  // `rea review` handles.
  const git = createRealGitExecutor(baseDir);
  const headSha = git.headSha();
  if (headSha.length === 0) {
    process.stderr.write(
      'rea hook codex-review: could not resolve HEAD sha — is this a valid git repo with at least one commit?\n',
    );
    process.exit(2);
  }

  const resolved = await resolvePushGatePolicy(baseDir);
  const explicit = options.base !== undefined && options.base.length > 0 ? options.base : undefined;
  const lastN = options.lastNCommits;
  // Delegate base resolution to the shared resolver so shallow-clone /
  // short-history clamping matches `rea hook push-gate` behavior. The
  // resolver returns a fully-resolved SHA + source tag; on a branch
  // shorter than `lastN`, it clamps to the deepest ancestor (or the
  // empty-tree sentinel for orphan/single-commit history) instead of
  // refusing the review.
  const resolvedBase = resolveBaseRef(git, {
    ...(explicit !== undefined ? { explicit } : {}),
    ...(lastN !== undefined && lastN > 0 ? { lastNCommits: lastN } : {}),
  });
  const baseRef = resolvedBase.ref;
  const target = resolvedBase.ref;

  // Allocate the raw-stdout sink. We write to `${tmp}/rea-codex-<sha>.json`
  // where <sha> is a short hex token derived from headSha + a random
  // nonce so concurrent invocations on the same HEAD don't clobber each
  // other (rare in practice — agents queue serially — but cheap to
  // make safe).
  const tmpRoot = options.rawStdoutDir ?? os.tmpdir();
  const nonce = crypto.randomBytes(4).toString('hex');
  const rawPath = path.join(tmpRoot, `rea-codex-${headSha.slice(0, 12)}-${nonce}.json`);
  let rawStream: fs.WriteStream | null;
  try {
    // mode 0o600: review JSONL contains the unfiltered codex output for
    // the repo being scanned (file paths, code excerpts, finding text).
    // On shared workstations / CI runners other local users could read
    // a default-mode 0644 file. Owner-only is the right floor.
    rawStream = fs.createWriteStream(rawPath, { flags: 'w', mode: 0o600 });
    // createWriteStream() does not throw ENOENT/EACCES/ENOSPC
    // synchronously — it emits an `error` event later. Without a
    // listener, the unhandled stream error terminates the process. Fall
    // back to "no raw tee" instead so a logging failure can never crash
    // the review itself.
    rawStream.once('error', (err) => {
      process.stderr.write(
        `rea hook codex-review: raw-stdout sink at ${rawPath} failed: ${err.message}\n`,
      );
      rawStream = null;
    });
  } catch (e) {
    // Synchronous failures (rare — usually invalid path shape) fall
    // through the same way: the audit entry still gets written, we
    // just lose the raw JSON tee.
    process.stderr.write(
      `rea hook codex-review: could not open raw-stdout sink at ${rawPath}: ${
        e instanceof Error ? e.message : String(e)
      }\n`,
    );
    rawStream = null;
  }

  // Run codex. The runner enforces iron-gate defaults internally —
  // gpt-5.4 + high reasoning unless policy overrides — so we pass
  // policy-resolved values straight through. spawnImpl is forwarded to
  // the test seam.
  let reviewText = '';
  let durationSeconds = 0;
  let codexError: unknown;
  try {
    const result = await runCodexReview({
      baseRef,
      cwd: baseDir,
      timeoutMs: resolved.timeout_ms,
      env: process.env,
      ...(resolved.codex_model !== undefined ? { model: resolved.codex_model } : {}),
      ...(resolved.codex_reasoning_effort !== undefined
        ? { reasoningEffort: resolved.codex_reasoning_effort }
        : {}),
      ...(options.spawnImpl !== undefined ? { spawnImpl: options.spawnImpl } : {}),
      ...(rawStream !== null
        ? {
            rawStdoutSink: (chunk: Buffer): void => {
              // Defensive: swallow any write error (closed/destroyed
              // stream, EBADF, ENOSPC). The codex-runner already
              // wraps sink calls in try/catch so a sink failure must
              // never change the verdict — but throwing inside the
              // 'data' handler also triggers an uncaughtException via
              // the readable stream. Catch it here so it stays local.
              try {
                if (!rawStream!.writableEnded && !rawStream!.destroyed) {
                  rawStream!.write(chunk);
                }
              } catch {
                /* sink failure is non-fatal */
              }
            },
          }
        : {}),
    });
    reviewText = result.reviewText;
    durationSeconds = result.durationSeconds;
  } catch (e) {
    codexError = e;
  } finally {
    if (rawStream !== null) {
      // End the stream — best-effort. The file is on disk either way,
      // and the OS flushes pending writes when the FD closes.
      try {
        await new Promise<void>((resolve) => {
          rawStream!.end(() => resolve());
        });
      } catch {
        /* swallow */
      }
    }
  }

  // Translate the codex error (if any) into a verdict + audit-error
  // shape. This mirrors `rea review`'s classifyCodexError + the push-
  // gate's translation, but stays inline so this CLI is self-contained.
  if (codexError !== undefined) {
    const msg = codexError instanceof Error ? codexError.message : String(codexError);
    const kind =
      codexError instanceof CodexNotInstalledError
        ? 'not-installed'
        : codexError instanceof CodexTimeoutError
          ? 'timeout'
          : codexError instanceof CodexProtocolError
            ? 'protocol'
            : codexError instanceof CodexSubprocessError
              ? 'subprocess'
              : 'unknown';
    let auditHash = '';
    try {
      const record = await appendAuditRecord(baseDir, {
        tool_name: CODEX_REVIEW_TOOL_NAME,
        server_name: CODEX_REVIEW_SERVER_NAME,
        status: InvocationStatus.Error,
        tier: Tier.Read,
        metadata: {
          head_sha: headSha,
          target,
          finding_count: 0,
          verdict: 'error' as CodexVerdict,
          summary: `codex error (${kind}): ${msg}`,
          model: resolved.codex_model ?? IRON_GATE_DEFAULT_MODEL,
          reasoning_effort: resolved.codex_reasoning_effort ?? IRON_GATE_DEFAULT_REASONING,
          raw_path: rawPath,
          duration_seconds: durationSeconds,
        },
      });
      auditHash = record.hash;
    } catch (auditErr) {
      // Audit failure must NOT change the exit code, but we surface it.
      process.stderr.write(
        `rea hook codex-review: audit append failed: ${
          auditErr instanceof Error ? auditErr.message : String(auditErr)
        }\n`,
      );
    }
    process.stderr.write(
      `[codex-review] verdict=error kind=${kind} findings=0 audit=${auditHash.slice(0, 16)} raw=${rawPath}\n`,
    );
    process.stderr.write(`[codex-review] error: ${msg}\n`);
    if (options.json === true) {
      process.stdout.write(
        JSON.stringify({
          verdict: 'error',
          kind,
          finding_count: 0,
          head_sha: headSha,
          target,
          audit_hash: auditHash,
          raw_path: rawPath,
          exit_code: 2,
          message: msg,
        }) + '\n',
      );
    }
    process.exit(2);
  }

  // Codex exited cleanly — parse the review prose and translate to a
  // verdict + finding count.
  const summary = summarizeReview(reviewText);
  const verdict: CodexVerdict = summary.verdict;
  const findingCount = summary.findings.length;
  // First non-empty paragraph of the review text becomes the audit
  // summary line. Truncated to 240 chars so the audit log doesn't blow
  // up on multi-paragraph review prose.
  const summaryLine = (() => {
    const firstPara = reviewText
      .split(/\n{2,}/)
      .map((p) => p.trim())
      .find((p) => p.length > 0);
    if (firstPara === undefined) return '';
    const oneLine = firstPara.replace(/\s+/g, ' ');
    return oneLine.length > 240 ? oneLine.slice(0, 237) + '...' : oneLine;
  })();

  let auditHash = '';
  try {
    const record = await appendAuditRecord(baseDir, {
      tool_name: CODEX_REVIEW_TOOL_NAME,
      server_name: CODEX_REVIEW_SERVER_NAME,
      status: verdict === 'blocking' ? InvocationStatus.Denied : InvocationStatus.Allowed,
      tier: Tier.Read,
      metadata: {
        head_sha: headSha,
        target,
        finding_count: findingCount,
        verdict,
        ...(summaryLine.length > 0 ? { summary: summaryLine } : {}),
        model: resolved.codex_model ?? IRON_GATE_DEFAULT_MODEL,
        reasoning_effort: resolved.codex_reasoning_effort ?? IRON_GATE_DEFAULT_REASONING,
        raw_path: rawPath,
        duration_seconds: durationSeconds,
      },
    });
    auditHash = record.hash;
  } catch (auditErr) {
    process.stderr.write(
      `rea hook codex-review: audit append failed: ${
        auditErr instanceof Error ? auditErr.message : String(auditErr)
      }\n`,
    );
  }

  // Map verdict → exit code. Same as the push-gate's contract.
  const exitCode: 0 | 1 | 2 = verdict === 'blocking' ? 2 : verdict === 'concerns' ? 1 : 0;

  // Terse status line on stderr. The directive is "the codex JSON IS
  // the review" — agents read raw_path to act on findings, not this
  // line. The line exists so a human running this from a shell sees
  // the verdict at a glance.
  process.stderr.write(
    `[codex-review] verdict=${verdict} findings=${String(findingCount)} audit=${auditHash.slice(
      0,
      16,
    )} raw=${rawPath}\n`,
  );

  if (options.json === true) {
    process.stdout.write(
      JSON.stringify({
        verdict,
        finding_count: findingCount,
        head_sha: headSha,
        target,
        audit_hash: auditHash,
        raw_path: rawPath,
        exit_code: exitCode,
      }) + '\n',
    );
  }
  process.exit(exitCode);
}

// ---------------------------------------------------------------------------
// `rea hook delegation-signal` — 0.29.0 delegation-telemetry MVP
// ---------------------------------------------------------------------------

/**
 * Shape of the Claude Code PreToolUse hook payload for the two
 * delegation tools we care about. Defensive — every field is optional
 * because the payload is untrusted (a different harness, a future
 * Claude Code release, a misconfigured runner). The CLI extracts what
 * it recognizes and drops the rest.
 */
interface DelegationSignalStdinPayload {
  tool_name?: unknown;
  session_id?: unknown;
  hook_event_timestamp?: unknown;
  tool_input?: {
    subagent_type?: unknown;
    skill?: unknown;
    description?: unknown;
    prompt?: unknown;
    parent_subagent_type?: unknown;
  };
}

export interface HookDelegationSignalOptions {
  /**
   * Run the audit append in the background and return immediately. The
   * shell hook stub sets this so the worst-case latency of the
   * `Agent|Skill` PreToolUse hook stays in the tens-of-milliseconds
   * range even when the audit chain is under cross-process contention.
   */
  detach?: boolean;
  /**
   * Override REA_ROOT. Tests set this; the production caller relies on
   * `process.cwd()` or the `$CLAUDE_PROJECT_DIR` env var.
   */
  reaRoot?: string;
  /**
   * Lock-acquisition timeout in milliseconds. If `appendAuditRecord`
   * hasn't returned within this budget, the CLI exits 0 with a stderr
   * warning. The append is fire-and-forget at that point — we'd rather
   * drop a single signal than block Claude Code's tool dispatch on
   * audit-log contention. Default: 2000 ms.
   */
  lockTimeoutMs?: number;
}

/**
 * Cached default secret patterns for the redact path. Compiling the
 * regex set is non-trivial (it spawns a worker per pattern), so cache
 * across invocations. CLI process lifecycle is short enough that this
 * is effectively per-process.
 */
let _delegationSecretPatterns: CompiledSecretPattern[] | null = null;
function getDelegationSecretPatterns(): CompiledSecretPattern[] {
  if (_delegationSecretPatterns === null) {
    // Per-pattern timeout budget. The redact-safe wrapper runs each
    // regex in a worker thread, and the worker spawn itself takes
    // ~1ms on hot paths but 50–200ms cold. The spec asked for 50ms
    // but that value caused spurious timeouts in cold-process tests
    // (the very first PreToolUse hook invocation in a fresh shell)
    // and converted every input into the timeout sentinel, leaking
    // false-positive redactions. 250ms is generous enough to absorb
    // a cold worker spawn while still bounded enough that the
    // delegation-capture hook stays well under its 5s settings.json
    // timeout. The hook itself backgrounds the CLI call so this
    // budget never gates Claude Code's tool dispatch.
    _delegationSecretPatterns = compileDefaultSecretPatterns({ timeoutMs: 250 });
  }
  return _delegationSecretPatterns;
}

/**
 * Apply `redactSecrets` to a single string field. Returns the
 * (possibly redacted) string plus the list of pattern names that
 * fired. On timeout, returns `'[REDACTED: pattern timeout]'` (the
 * sentinel from redact.ts) and the timeout pattern name so the audit
 * envelope still records the redaction happened.
 *
 * Best-effort: any exception in the redact path returns the input
 * unchanged + an empty pattern list. The audit record is observational
 * — failing the whole signal because the redact timer threw would lose
 * the signal entirely.
 */
/**
 * Sentinel emitted when redaction is unable to make a definitive
 * decision (regex timeout, worker error). The redactor's invariant is
 * "never let a potentially secret-bearing string pass through
 * unredacted on failure" — that invariant MUST hold for the
 * delegation-signal path too. Falling back to the raw input on
 * timeout would silently leak a planted credential into
 * .rea/audit.jsonl. Codex round 2 P1 (2026-05-12).
 */
const REDACT_INDETERMINATE_SENTINEL = '[REDACTED: indeterminate]';

function redactField(value: string): { value: string; patterns: string[] } {
  try {
    const { output, redacted, timedOut } = redactSecrets(
      value,
      getDelegationSecretPatterns(),
    );
    // Timeout: the redactor's `[REDACTED: pattern timeout]` output
    // already says "I couldn't decide". Treat that as a full-field
    // redaction here too — under no circumstance let the raw input
    // through when the scanner failed to complete. This is the
    // fail-closed posture redact.ts itself takes; we mirror it.
    // The redactor's own telemetry separately records the timeout
    // (REDACT_TIMEOUT_METADATA_KEY), so observability isn't lost.
    if (timedOut) {
      return {
        value: REDACT_INDETERMINATE_SENTINEL,
        patterns: ['redact_timeout'],
      };
    }
    if (redacted.length === 0) return { value, patterns: [] };
    // The redact contract replaces matched substrings with `[REDACTED]`.
    // For a short identifier field like `subagent_type`, treat any hit
    // as a full-field redaction so a partial match doesn't leak the
    // surrounding context.
    return { value: output.includes('[REDACTED') ? '[REDACTED]' : output, patterns: redacted };
  } catch {
    // Synchronous redactor exception (extremely rare — the wrapper
    // catches its own errors). Fail closed: indeterminate sentinel.
    return {
      value: REDACT_INDETERMINATE_SENTINEL,
      patterns: ['redact_error'],
    };
  }
}

/**
 * The actual audit-write — wrapped so it can run inline (default) or
 * as a detached background tail call (`--detach`). Returns the
 * promise; the caller decides whether to await it.
 */
async function writeDelegationSignal(
  baseDir: string,
  metadata: DelegationSignalMetadata,
  redactedFields: string[],
  sessionId: string,
): Promise<void> {
  // Defense-in-depth: validate the metadata shape against the strict
  // zod schema before handing it off to `appendAuditRecord`. A future
  // refactor that introduces a field-name typo here would otherwise
  // silently land a malformed line in the chain.
  const parsed = DelegationSignalMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    process.stderr.write(
      `[rea] delegation-signal: metadata failed strict-mode validation: ${parsed.error.message}\n`,
    );
    return;
  }
  await appendAuditRecord(baseDir, {
    tool_name: DELEGATION_SIGNAL_TOOL_NAME,
    server_name: DELEGATION_SIGNAL_SERVER_NAME,
    tier: Tier.Read,
    status: InvocationStatus.Allowed,
    session_id: sessionId,
    ...(redactedFields.length > 0 ? { redacted_fields: redactedFields } : {}),
    metadata: parsed.data as unknown as Record<string, unknown>,
  });
}

/**
 * Read the hook stdin payload, redact + hash, and either await the
 * audit append OR fire-and-forget it (when `--detach` is set).
 *
 * Exit-code contract: ALWAYS exit 0. The delegation signal is
 * observational, not gating — failure to write the record must NOT
 * block Claude Code's tool dispatch. Errors are surfaced on stderr.
 */
export async function runHookDelegationSignal(
  options: HookDelegationSignalOptions,
): Promise<void> {
  const baseDir =
    options.reaRoot ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
  const lockTimeoutMs = options.lockTimeoutMs ?? 2000;

  // Read stdin. TTY → empty (no harness payload available, nothing to
  // emit — exit 0 silently). Timeout 1s; the hook shim feeds us a
  // small JSON blob that fully prints in milliseconds.
  const stdinRaw = process.stdin.isTTY ? '' : await readStdinWithTimeout(1_000);
  if (stdinRaw.length === 0) {
    process.exit(0);
  }

  let payload: DelegationSignalStdinPayload;
  try {
    payload = JSON.parse(stdinRaw) as DelegationSignalStdinPayload;
  } catch (e) {
    // Malformed payload — observational signal only, exit 0 silently
    // with stderr breadcrumb. Failing here would propagate to the hook
    // shim and risk blocking the underlying Agent/Skill dispatch.
    process.stderr.write(
      `[rea] delegation-signal: malformed stdin JSON (${
        e instanceof Error ? e.message : String(e)
      }), signal dropped\n`,
    );
    process.exit(0);
  }

  // Resolve which delegation tool fired. Anything else is a misfire at
  // the matcher layer (Claude Code routed a non-delegation tool to us)
  // — exit 0 silently.
  const rawToolName = typeof payload.tool_name === 'string' ? payload.tool_name : '';
  const delegationTool: DelegationTool | null =
    rawToolName === 'Agent' ? 'Agent' : rawToolName === 'Skill' ? 'Skill' : null;
  if (delegationTool === null) {
    process.exit(0);
  }

  // Extract the agent / skill name. Agent → tool_input.subagent_type;
  // Skill → tool_input.skill. Missing → emit a placeholder ('unknown')
  // so the chain still records the delegation event.
  const ti = payload.tool_input ?? {};
  let rawSubagentType = '';
  if (delegationTool === 'Agent' && typeof ti.subagent_type === 'string') {
    rawSubagentType = ti.subagent_type;
  } else if (delegationTool === 'Skill' && typeof ti.skill === 'string') {
    rawSubagentType = ti.skill;
  }
  if (rawSubagentType.length === 0) rawSubagentType = 'unknown';

  // Parent subagent — Claude Code surfaces this either as
  // `tool_input.parent_subagent_type` (when the dispatcher attaches
  // it to the payload) or as the `CLAUDE_PARENT_SUBAGENT` env var
  // (the alternate source the integrated spec calls out). Payload
  // wins when both are present — payload is closer to the originating
  // event and the env var can be stale across subprocess fan-out.
  // Codex round 4 P2 (2026-05-12): pre-fix the env-var source was
  // ignored and every nested delegation was recorded as null,
  // defeating the parent/child telemetry the field was added for.
  let rawParent: string | null = null;
  if (typeof ti.parent_subagent_type === 'string' && ti.parent_subagent_type.length > 0) {
    rawParent = ti.parent_subagent_type;
  } else {
    const envParent = process.env['CLAUDE_PARENT_SUBAGENT'];
    if (typeof envParent === 'string' && envParent.length > 0) {
      rawParent = envParent;
    }
  }

  // Description / prompt → SHA-256, never persisted in clear.
  // Agent dispatches the prompt under `description`; Skill under
  // `prompt`. When neither is present we hash the empty string so the
  // field is always present.
  const rawDescription =
    delegationTool === 'Agent' && typeof ti.description === 'string'
      ? ti.description
      : delegationTool === 'Skill' && typeof ti.prompt === 'string'
        ? ti.prompt
        : '';
  const descriptionHash = crypto.createHash('sha256').update(rawDescription).digest('hex');

  // Run subagent_type + parent_subagent_type through the redact path.
  // A planted credential string in either field is replaced with
  // [REDACTED] before landing in the audit log.
  const redactedFields: string[] = [];
  const sub = redactField(rawSubagentType);
  if (sub.patterns.length > 0) {
    redactedFields.push('metadata.subagent_type');
  }
  let parentValue: string | null = rawParent;
  if (rawParent !== null) {
    const parentRed = redactField(rawParent);
    parentValue = parentRed.value;
    if (parentRed.patterns.length > 0) {
      redactedFields.push('metadata.parent_subagent_type');
    }
  }

  const sessionIdObserved =
    typeof payload.session_id === 'string' && payload.session_id.length > 0
      ? payload.session_id
      : 'unknown';
  const hookEventTimestamp =
    typeof payload.hook_event_timestamp === 'string' && payload.hook_event_timestamp.length > 0
      ? payload.hook_event_timestamp
      : undefined;

  const metadata: DelegationSignalMetadata = {
    schema_version: DELEGATION_SIGNAL_SCHEMA_VERSION,
    delegation_tool: delegationTool,
    subagent_type: sub.value,
    session_id_observed: sessionIdObserved,
    parent_subagent_type: parentValue,
    invocation_description_sha256: descriptionHash,
    ...(hookEventTimestamp !== undefined ? { hook_event_timestamp: hookEventTimestamp } : {}),
  };

  // Audit envelope `session_id` carries the observed session so a
  // future reader can correlate without traversing metadata. (The
  // envelope value is duplicated in metadata.session_id_observed for
  // record-self-containment.)
  const writePromise = writeDelegationSignal(
    baseDir,
    metadata,
    redactedFields,
    sessionIdObserved,
  );

  // The audit append must complete BEFORE this CLI process exits.
  // Earlier iterations treated `--detach` as "fire-and-forget at the
  // CLI level", but Node terminates a process when the event loop has
  // no more sync work — and `appendAuditRecord()` is async filesystem
  // work that does NOT keep the process alive across `process.exit`.
  // The fire-and-forget concept lives one level UP, in the SHELL hook:
  // the .sh stub backgrounds this entire CLI invocation with `&` +
  // `disown` so Claude Code's tool dispatch is not blocked. From inside
  // the CLI we always wait for the append.
  //
  // Codex round 1 P1 (2026-05-12): the previous implementation called
  // `process.exit(0)` immediately after kicking off the promise under
  // `--detach`. Tests stubbed `process.exit` so the promise still ran
  // to completion in-test, masking the bug. In production every
  // Agent/Skill dispatch silently dropped its delegation record.
  //
  // `--detach` is RETAINED as a flag for backwards compat with the
  // shell hook stub's `--detach &` argv (and to document that the
  // shell hook is the backgrounding layer, not the CLI). Its only
  // remaining effect is the doc comment and an audit-append-failure
  // mode that NEVER emits to stderr (no parent shell is listening
  // when the CLI ran detached).
  const detached = options.detach === true;
  let timer: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      writePromise,
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), lockTimeoutMs);
        timer.unref?.();
      }).then((tag) => {
        if (tag === 'timeout') {
          if (!detached) {
            process.stderr.write(`[rea] delegation-signal: lock timeout, signal dropped\n`);
          }
          // Surface the eventual error so it doesn't escape as an
          // unhandled rejection after we've exited the await.
          writePromise.catch(() => {
            /* already reported via stderr */
          });
          return;
        }
      }),
    ]);
  } catch (e) {
    // Append failure (e.g. ENOSPC) — surface to stderr unless we ran
    // detached (no parent shell is listening).
    if (!detached) {
      process.stderr.write(
        `[rea] delegation-signal: audit append failed: ${
          e instanceof Error ? e.message : String(e)
        }\n`,
      );
    }
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
  process.exit(0);
}

/**
 * Attach the `rea hook` subcommand tree to a commander Program.
 *
 * Subcommands:
 *   - `push-gate`           — stateless pre-push Codex review (called by husky).
 *   - `scan-bash`           — parser-backed bash-tier scanner (called by Claude
 *                             Code shim hooks).
 *   - `policy-get`          — single-source-of-truth policy reader for bash hooks.
 *   - `codex-review`        — thin Bash-direct codex invocation (0.27.0+) for
 *                             marathon-mode review cycles.
 *   - `delegation-signal`   — 0.29.0 delegation-telemetry MVP. Reads a Claude
 *                             Code PreToolUse hook payload for `Agent` / `Skill`
 *                             and emits a `rea.delegation_signal` audit record.
 *   - `delegation-advisory` — 0.31.0 delegation nudge. Reads a Claude Code
 *                             PostToolUse hook payload for the write-class
 *                             tools, maintains a per-session counter, and emits
 *                             a one-time stderr advisory when the session
 *                             crosses `policy.delegation_advisory.threshold`
 *                             without dispatching a curated specialist.
 *
 * New hooks should land here rather than as top-level commands so the
 * CLI surface stays navigable.
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

  hook
    .command('codex-review')
    .description(
      'Run `codex exec review --json --ephemeral` directly against the working tree, tee raw JSONL to a tempfile, write a `codex.review` audit entry, and emit a terse status line on stderr. Exits 0/1/2: pass/concerns/blocking. The canonical Bash-direct codex invocation (0.27.0+) — minimizes Claude consumption of codex output by NOT paraphrasing findings into prose.',
    )
    .option(
      '--base <ref>',
      'explicit base ref to diff against (default: @{upstream} → origin/HEAD → main/master)',
    )
    .option(
      '--last-n-commits <n>',
      'narrow review to the last N commits (diff against HEAD~N). Loses to --base when both are set.',
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
    .option(
      '--json',
      'emit a single-line JSON result on stdout (in addition to the stderr status line)',
    )
    .action(async (opts: { base?: string; lastNCommits?: number; json?: boolean }) => {
      await runHookCodexReview({
        ...(opts.base !== undefined ? { base: opts.base } : {}),
        ...(opts.lastNCommits !== undefined ? { lastNCommits: opts.lastNCommits } : {}),
        ...(opts.json === true ? { json: true } : {}),
      });
    });

  hook
    .command('delegation-signal')
    .description(
      'Read a Claude Code PreToolUse hook payload for `Agent` or `Skill` from stdin and emit a `rea.delegation_signal` audit record (0.29.0+). Observational telemetry only — exit ALWAYS 0; failure to write the record never blocks tool dispatch. The hook shim at `.claude/hooks/delegation-capture.sh` invokes this with `--detach` so the Agent/Skill call proceeds without waiting on the audit lock.',
    )
    .option(
      '--detach',
      'fire the audit append in the background and return immediately. Set by the shell hook stub so worst-case latency stays low under lock contention.',
    )
    .option(
      '--lock-timeout-ms <n>',
      'milliseconds to wait for the audit-chain lock before dropping the signal. Default 2000.',
      (raw: string): number => {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) {
          throw new Error(
            `--lock-timeout-ms must be a positive integer, got ${JSON.stringify(raw)}`,
          );
        }
        return n;
      },
    )
    .action(async (opts: { detach?: boolean; lockTimeoutMs?: number }) => {
      await runHookDelegationSignal({
        ...(opts.detach === true ? { detach: true } : {}),
        ...(opts.lockTimeoutMs !== undefined ? { lockTimeoutMs: opts.lockTimeoutMs } : {}),
      });
    });

  hook
    .command('delegation-advisory')
    .description(
      'Read a Claude Code PostToolUse hook payload for a write-class tool (Bash/Edit/Write/MultiEdit/NotebookEdit) from stdin, bump a per-session write-class counter, and emit a one-time stderr advisory when the session crosses `policy.delegation_advisory.threshold` without dispatching a curated specialist (0.31.0+). Advisory only — exit ALWAYS 0 except HALT (exit 2). Disabled unless `policy.delegation_advisory.enabled: true`. The hook shim at `.claude/hooks/delegation-advisory.sh` invokes this.',
    )
    .action(async () => {
      await runHookDelegationAdvisory();
    });

  hook
    .command('pr-issue-link-gate')
    .description(
      'Node-binary port of `hooks/pr-issue-link-gate.sh` (0.32.0). Reads a Claude Code PreToolUse Bash payload from stdin; when the command is `gh pr create` without a `closes/fixes/resolves #N` reference, prints an advisory banner to stderr. ALWAYS exits 0 except HALT (exit 2) or malformed payload (exit 2, fail-closed). The bash shim at `hooks/pr-issue-link-gate.sh` invokes this.',
    )
    .action(async () => {
      await runHookPrIssueLinkGate();
    });

  hook
    .command('security-disclosure-gate')
    .description(
      'Node-binary port of `hooks/security-disclosure-gate.sh` (0.32.0). Reads a Claude Code PreToolUse Bash payload from stdin; when the command is `gh issue create` AND title/body/body-file contents match a SECURITY_PATTERNS keyword, emits a deny JSON on stdout and exits 2. Routing depends on REA_DISCLOSURE_MODE: advisory (default, redirect to GHSA), issues (private repo, redirect to labeled issue), disabled (pass through).',
    )
    .action(async () => {
      await runHookSecurityDisclosureGate();
    });

  hook
    .command('attribution-advisory')
    .description(
      'Node-binary port of `hooks/attribution-advisory.sh` (0.32.0). Opt-in via policy.yaml `block_ai_attribution: true`. Reads a Claude Code PreToolUse Bash payload from stdin; when the command is `git commit` or `gh pr create|edit` AND contains structural AI attribution markers (Co-Authored-By with vendor noreply, AI tool names, "Generated with [X]", markdown-linked tools, 🤖 Generated), exits 2 with banner. Otherwise exits 0.',
    )
    .action(async () => {
      await runHookAttributionAdvisory();
    });

  hook
    .command('env-file-protection')
    .description(
      'Node-binary port of `hooks/env-file-protection.sh` (0.33.0). Reads a Claude Code PreToolUse Bash payload from stdin; when the command sources, cps, or reads a `.env*`/`.envrc` file via text-reading utilities (cat/head/tail/grep/sed/awk/etc.), exits 2 with banner. Same-segment co-occurrence required for the utility-vs-filename match so multi-segment commands do not false-positive.',
    )
    .action(async () => {
      await runHookEnvFileProtection();
    });

  hook
    .command('dependency-audit-gate')
    .description(
      'Node-binary port of `hooks/dependency-audit-gate.sh` (0.33.0). Reads a Claude Code PreToolUse Bash payload from stdin; when the command is `(npm|pnpm|yarn) (install|i|add) <pkg>`, verifies each named package exists on the npm registry via `npm view <pkg> name` (5s timeout, capped at 5 packages/command). Exit 2 with multi-line banner on any missing package, otherwise exit 0.',
    )
    .action(async () => {
      await runHookDependencyAuditGate();
    });

  hook
    .command('changeset-security-gate')
    .description(
      'Node-binary port of `hooks/changeset-security-gate.sh` (0.33.0). Reads a Claude Code PreToolUse Write/Edit/MultiEdit/NotebookEdit payload from stdin; for writes targeting `.changeset/*.md`, blocks GHSA/CVE pre-disclosure and validates frontmatter (`---`-delimited block with `<pkg>: (patch|minor|major)` + non-empty description). MultiEdit short-circuits frontmatter validation because fragments are not full files. Block emissions use the Claude Code JSON-on-stdout protocol.',
    )
    .action(async () => {
      await runHookChangesetSecurityGate();
    });

  hook
    .command('architecture-review-gate')
    .description(
      'Node-binary port of `hooks/architecture-review-gate.sh` (0.33.0). PostToolUse Write/Edit advisory. Reads `policy.architecture_review.patterns` and prints an advisory banner to stderr when the just-written file matches a configured prefix. ALWAYS exits 0 unless HALT (exit 2). Path normalization handles Windows backslashes + URL-encoding; empty/unset patterns short-circuit silently.',
    )
    .action(async () => {
      await runHookArchitectureReviewGate();
    });

  hook
    .command('dangerous-bash-interceptor')
    .description(
      'Node-binary port of `hooks/dangerous-bash-interceptor.sh` (0.34.0). PreToolUse Bash gate that blocks destructive commands. Catalog of 17 HIGH (H1-H17) + 1 MEDIUM (M1) rules: force-push, --no-verify, HUSKY=0, rm -rf broad targets, curl|sh pipe-RCE, REA_BYPASS, alias/function-with-bypass, psql DROP, context_protection delegate enforcement. Exit 2 on HIGH match, 0 on MEDIUM-only advisory or pass-through.',
    )
    .action(async () => {
      await runHookDangerousBashInterceptor();
    });

  hook
    .command('local-review-gate')
    .description(
      'Node-binary port of `hooks/local-review-gate.sh` (0.34.0). PreToolUse Bash gate refusing `git push` (and optionally `git commit`) until a recent `rea.local_review` audit entry covers HEAD. Honors `policy.review.local_review.{mode=off|enforced, refuse_at=push|commit|both, bypass_env_var}`. Mode=off short-circuits silently; bypass var (default REA_SKIP_LOCAL_REVIEW) accepts process-env (global) or per-segment inline `VAR="<reason>" git push` shapes. CTO directive 2026-05-05 enforcement.',
    )
    .action(async () => {
      await runHookLocalReviewGate();
    });

  hook
    .command('secret-scanner')
    .description(
      'Node-binary port of `hooks/secret-scanner.sh` (0.34.0). PreToolUse Write/Edit/MultiEdit/NotebookEdit pre-write credential gate. Catalog of 12 HIGH + 5 MEDIUM patterns (AWS, Anthropic, GitHub, Stripe live/test, Supabase JWT, generic SECRET=, private-key armor, DB connection strings). awk-style line filter strips shell comments and `process.env.VAR` RHS assignments; `is_placeholder` filter drops `<your_key>`/`test_token`/`aaaaaaa` shapes. HIGH match → exit 2; MEDIUM-only → exit 0 with advisory. Suffix-excludes `.env.example`/`.env.sample`.',
    )
    .action(async () => {
      await runHookSecretScanner();
    });

  hook
    .command('blocked-paths-bash-gate')
    .description(
      'Node-binary port of `hooks/blocked-paths-bash-gate.sh` (0.35.0). PreToolUse Bash gate refusing shell writes to `policy.blocked_paths` entries. Calls the AST-backed `runBlockedScan` directly (no shim→CLI→scanner subprocess hop). Permissive policy read — partial/migrating policy.yaml does NOT collapse the blocked_paths list. Empty list → no-op. Verdict `block` → exit 2; `allow` → exit 0.',
    )
    .action(async () => {
      await runHookBlockedPathsBashGate();
    });

  hook
    .command('protected-paths-bash-gate')
    .description(
      'Node-binary port of `hooks/protected-paths-bash-gate.sh` (0.35.0). PreToolUse Bash gate refusing shell-redirect/cp/mv/install/etc. to protected paths (.claude/settings.json, .claude/hooks/*, .husky/*, .rea/policy.yaml, .rea/HALT). Honors `policy.protected_writes` (full override) + `policy.protected_paths_relax` (subtractor). REA_HOOK_PATCH_SESSION relaxes .claude/hooks/ for the session.',
    )
    .action(async () => {
      await runHookProtectedPathsBashGate();
    });

  hook
    .command('blocked-paths-enforcer')
    .description(
      'Node-binary port of `hooks/blocked-paths-enforcer.sh` (0.35.0). PreToolUse Write/Edit/MultiEdit/NotebookEdit gate refusing writes to `policy.blocked_paths` entries. §5a path-traversal reject + §5a-bis interior `/./` reject + §H.2 intermediate-symlink resolution. Agent-writable allow-list (.rea/tasks.jsonl, .rea/audit/) short-circuits before policy match.',
    )
    .action(async () => {
      await runHookBlockedPathsEnforcer();
    });

  hook
    .command('settings-protection')
    .description(
      'Node-binary port of `hooks/settings-protection.sh` (0.35.0, the LARGEST hook in the repo at 582 LOC of bash). PreToolUse Write/Edit/MultiEdit/NotebookEdit gate protecting .claude/settings.json, .claude/hooks/*, .husky/*, .rea/policy.yaml, .rea/HALT, .rea/last-review.{json,cache.json}. Honors `protected_writes` (full override) + `protected_paths_relax` (subtractor, kill-switch invariants non-relaxable). §5b extension-surface allow-list for .husky/{commit-msg,pre-push,pre-commit,prepare-commit-msg}.d/* with final-component and intermediate-directory symlink refusal. §6c intermediate-symlink resolution. §6b REA_HOOK_PATCH_SESSION unlock for .claude/hooks/ with hash-chained audit append (fail-closed on append failure).',
    )
    .action(async () => {
      await runHookSettingsProtection();
    });

  hook
    .command('policy-get')
    .description(
      'Read a value from `.rea/policy.yaml` via the canonical YAML parser. Used by bash-tier hooks (`hooks/_lib/policy-read.sh::policy_nested_scalar`) so inline AND block YAML forms agree at a single source of truth. Default scalar mode: prints raw value or empty. With `--json`: emits JSON (scalar or object/array; missing path → `null`). Unparseable YAML → empty / null, exit 1.',
    )
    .argument(
      '<key>',
      'dotted path, e.g. `review.local_review.mode`. POSIX-identifier segments only.',
    )
    .option(
      '--json',
      'emit JSON instead of a scalar — supports object/array leaves. Bash callers can then parse with jq.',
    )
    .action(async (key: string, opts: { json?: boolean }) => {
      await runHookPolicyGet({ key, ...(opts.json === true ? { json: true } : {}) });
    });
}
