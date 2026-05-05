/**
 * `rea verify-claim <claim-id>` — replay a recorded security-claim PoC
 * battery against the currently-installed (or in-tree dogfood) rea CLI.
 *
 * The centerpiece of 0.28.0 (4th structural pivot — claims as
 * machine-verifiable artifacts rather than prose-only release notes).
 *
 * Each claim lives at `data/claims/<id>.json` and lists 1..N PoCs.
 * Every PoC has a `type` that names the executor:
 *
 *   - `scan-bash` (primary): pipes `input` into
 *     `dist/cli/index.js hook scan-bash --mode <protected|blocked>` and
 *     compares the resulting verdict to `expected_verdict`.
 *   - `shellcheck` (helix-031 case): runs shellcheck on `target` and
 *     asserts the run is clean (no SC<code> warnings).
 *
 * Resolution order for the rea CLI under test:
 *
 *   - `--installed` → resolves to `<cwd>/node_modules/@bookedsolid/rea/dist/cli/index.js`.
 *     This is the canonical "verify against MY pinned rea" mode for
 *     consumers — tells them whether the version they actually have
 *     installed still rejects the PoCs the claim targets.
 *   - default → uses the same `dist/cli/index.js` that ships with the
 *     CLI itself (i.e. the rea repo's own dogfood). Resolved relative
 *     to the running script.
 *
 * Exit codes:
 *
 *   - 0 — every PoC matched the recorded `expected_verdict`.
 *   - 1 — at least one PoC mismatched (regression — investigate).
 *   - 2 — claim id is unknown / no JSON file at `data/claims/<id>.json`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { err } from './utils.js';

// ---------------------------------------------------------------------------
// Claim file shape (validated at load time)
// ---------------------------------------------------------------------------

export interface ScanBashPoC {
  id: string;
  type: 'scan-bash';
  input: string;
  mode: 'protected' | 'blocked';
  expected_verdict: 'allow' | 'block';
}

export interface ShellcheckPoC {
  id: string;
  type: 'shellcheck';
  target: string;
  expected_verdict: 'clean';
}

export type ClaimPoC = ScanBashPoC | ShellcheckPoC;

export interface Claim {
  id: string;
  title: string;
  introduced_in: string;
  closed_in: string;
  summary?: string;
  pocs: ClaimPoC[];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface VerifyClaimOptions {
  /** Resolve the CLI to `<cwd>/node_modules/@bookedsolid/rea/dist/cli/index.js`. */
  installed?: boolean;
  /** Emit a single JSON document on stdout. */
  json?: boolean;
  /**
   * Override the claim-file root. Production resolves this internally
   * (ships at `data/claims/` next to the package). Tests pass an
   * absolute path so they can stage fixtures.
   */
  claimsDir?: string;
  /**
   * Override the rea CLI under test. Wins over `installed`. Used by
   * tests to point at a stub binary. Production callers leave this
   * unset.
   */
  cliOverride?: string;
  /**
   * Override the working directory the `--installed` resolver uses.
   * Defaults to `process.cwd()`; tests pass a tmp dir.
   */
  cwd?: string;
}

export interface PoCResult {
  poc_id: string;
  type: ClaimPoC['type'];
  expected: string;
  actual: string;
  match: boolean;
  /** Empty on match; populated on mismatch with a one-line diagnostic. */
  detail: string;
}

export interface VerifyClaimResult {
  claim_id: string;
  cli: string;
  total: number;
  matched: number;
  mismatched: number;
  results: PoCResult[];
  exit_code: 0 | 1 | 2;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Resolve the directory holding the bundled claim JSON files. Walks up
 * from the running script (or from this file at dev time) looking for
 * a `data/claims/` sibling. Returns null when the directory cannot be
 * located — the caller falls back to whatever `claimsDir` override was
 * passed.
 */
export function resolveDefaultClaimsDir(): string | null {
  // The compiled CLI runs from `dist/cli/index.js` — walk up to the
  // package root, then look for `data/claims/`.
  const here = path.dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 8 && cur && cur !== path.dirname(cur); i += 1) {
    const cand = path.join(cur, 'data', 'claims');
    if (fs.existsSync(cand)) return cand;
    cur = path.dirname(cur);
  }
  return null;
}

/**
 * Load and validate a claim file. Throws on malformed JSON or shape
 * mismatch — `runVerifyClaim` translates the throw into exit-code 2 +
 * a stderr message.
 */
export function loadClaim(claimsDir: string, claimId: string): Claim {
  // Defensive: claim ids are constrained to a kebab-case shape so a
  // crafted argv can't escape the directory ('../../etc/passwd'). The
  // CLI argument is also passed verbatim to fs.readFileSync, so a
  // non-conforming id should hard-fail before any disk access.
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(claimId)) {
    throw new Error(
      `verify-claim: invalid claim id ${JSON.stringify(claimId)} ` +
        `(allowed: kebab-case [a-z0-9][a-z0-9._-]*)`,
    );
  }
  const file = path.join(claimsDir, `${claimId}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`verify-claim: unknown claim id ${JSON.stringify(claimId)} (expected ${file})`);
  }
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(
      `verify-claim: could not read ${file}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(
      `verify-claim: ${file} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return validateClaim(parsed, file);
}

function validateClaim(parsed: unknown, source: string): Claim {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`verify-claim: ${source} top-level must be an object`);
  }
  const obj = parsed as Record<string, unknown>;
  const id = obj.id;
  const title = obj.title;
  const introducedIn = obj.introduced_in;
  const closedIn = obj.closed_in;
  const summary = obj.summary;
  const pocs = obj.pocs;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`verify-claim: ${source} requires a non-empty string \`id\``);
  }
  if (typeof title !== 'string' || title.length === 0) {
    throw new Error(`verify-claim: ${source} requires a non-empty string \`title\``);
  }
  if (typeof introducedIn !== 'string' || introducedIn.length === 0) {
    throw new Error(`verify-claim: ${source} requires a non-empty string \`introduced_in\``);
  }
  if (typeof closedIn !== 'string' || closedIn.length === 0) {
    throw new Error(`verify-claim: ${source} requires a non-empty string \`closed_in\``);
  }
  if (!Array.isArray(pocs) || pocs.length === 0) {
    throw new Error(`verify-claim: ${source} requires a non-empty \`pocs\` array`);
  }
  const validatedPocs: ClaimPoC[] = pocs.map((p, idx) => validatePoC(p, source, idx));
  const claim: Claim = {
    id,
    title,
    introduced_in: introducedIn,
    closed_in: closedIn,
    pocs: validatedPocs,
  };
  if (typeof summary === 'string' && summary.length > 0) {
    claim.summary = summary;
  }
  return claim;
}

function validatePoC(parsed: unknown, source: string, index: number): ClaimPoC {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`verify-claim: ${source} pocs[${index}] must be an object`);
  }
  const obj = parsed as Record<string, unknown>;
  const id = obj.id;
  const type = obj.type;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error(`verify-claim: ${source} pocs[${index}].id must be a non-empty string`);
  }
  if (type === 'scan-bash') {
    const input = obj.input;
    const mode = obj.mode;
    const expected = obj.expected_verdict;
    if (typeof input !== 'string') {
      throw new Error(`verify-claim: ${source} pocs[${index}].input must be a string`);
    }
    if (mode !== 'protected' && mode !== 'blocked') {
      throw new Error(
        `verify-claim: ${source} pocs[${index}].mode must be 'protected' | 'blocked'`,
      );
    }
    if (expected !== 'allow' && expected !== 'block') {
      throw new Error(
        `verify-claim: ${source} pocs[${index}].expected_verdict must be 'allow' | 'block'`,
      );
    }
    return { id, type: 'scan-bash', input, mode, expected_verdict: expected };
  }
  if (type === 'shellcheck') {
    const target = obj.target;
    const expected = obj.expected_verdict;
    if (typeof target !== 'string' || target.length === 0) {
      throw new Error(
        `verify-claim: ${source} pocs[${index}].target must be a non-empty string`,
      );
    }
    if (expected !== 'clean') {
      throw new Error(
        `verify-claim: ${source} pocs[${index}].expected_verdict must be 'clean'`,
      );
    }
    return { id, type: 'shellcheck', target, expected_verdict: expected };
  }
  throw new Error(
    `verify-claim: ${source} pocs[${index}].type must be 'scan-bash' | 'shellcheck' (got ${JSON.stringify(type)})`,
  );
}

// ---------------------------------------------------------------------------
// Executors
// ---------------------------------------------------------------------------

/**
 * Resolve the rea CLI to invoke for `scan-bash` PoCs.
 *
 * Precedence: cliOverride > --installed > sibling dogfood dist/cli/index.js.
 *
 * Returns a pair `[command, args]` so the caller can do
 * `spawnSync(cmd, [...args, 'hook', 'scan-bash', ...])`. The shape
 * keeps node-vs-direct-binary differences localized to this resolver.
 */
export function resolveCli(opts: VerifyClaimOptions): { cmd: string; args: string[]; path: string } {
  if (opts.cliOverride !== undefined && opts.cliOverride.length > 0) {
    const abs = path.resolve(opts.cliOverride);
    return { cmd: process.execPath, args: [abs], path: abs };
  }
  if (opts.installed === true) {
    const cwd = opts.cwd ?? process.cwd();
    const installed = path.join(cwd, 'node_modules', '@bookedsolid', 'rea', 'dist', 'cli', 'index.js');
    if (!fs.existsSync(installed)) {
      throw new Error(
        `verify-claim --installed: not found at ${installed}. ` +
          `Install @bookedsolid/rea in the current project.`,
      );
    }
    return { cmd: process.execPath, args: [installed], path: installed };
  }
  // Default: walk up from this file to find the dogfood dist/cli/index.js.
  const here = path.dirname(fileURLToPath(import.meta.url));
  let cur = here;
  for (let i = 0; i < 8 && cur && cur !== path.dirname(cur); i += 1) {
    const cand = path.join(cur, 'dist', 'cli', 'index.js');
    if (fs.existsSync(cand)) {
      return { cmd: process.execPath, args: [cand], path: cand };
    }
    cur = path.dirname(cur);
  }
  throw new Error(
    'verify-claim: could not locate dist/cli/index.js. Run `pnpm build` or pass --installed.',
  );
}

interface SpawnImpl {
  (
    cmd: string,
    args: string[],
    options: { input?: string; encoding: 'utf8'; timeout: number },
  ): SpawnSyncReturns<string>;
}

/**
 * Run a single PoC against the resolved CLI. Pure function — no global
 * state, all dependencies threaded through `cliCmd` / `cliArgs` / `spawn`.
 * Tests substitute `spawn` with a fake.
 */
export function runPoC(
  poc: ClaimPoC,
  cliCmd: string,
  cliArgs: string[],
  spawn: SpawnImpl = spawnSync,
  cwd: string = process.cwd(),
): PoCResult {
  if (poc.type === 'scan-bash') {
    const args = [...cliArgs, 'hook', 'scan-bash', '--mode', poc.mode];
    const result = spawn(cliCmd, args, { input: poc.input, encoding: 'utf8', timeout: 30_000 });
    let actual: 'allow' | 'block' | 'error' = 'error';
    let detail = '';
    if (result.error) {
      detail = `spawn error: ${result.error.message}`;
    } else {
      // CLI contract: exit 0 = allow, 2 = block, 1 = error. Stdout
      // carries the verdict JSON. Prefer the JSON shape (richer, but
      // exit code is the floor).
      const stdout = result.stdout ?? '';
      try {
        const parsed = JSON.parse(stdout.trim()) as { verdict?: unknown; reason?: unknown };
        if (parsed.verdict === 'allow' || parsed.verdict === 'block') {
          actual = parsed.verdict;
        } else {
          detail = `verdict JSON missing valid \`verdict\` field; stdout=${stdout.slice(0, 200)}`;
        }
      } catch {
        if (result.status === 0) {
          actual = 'allow';
        } else if (result.status === 2) {
          actual = 'block';
        } else {
          detail = `unparseable stdout; exit=${result.status} stdout=${stdout.slice(0, 200)} stderr=${(result.stderr ?? '').slice(0, 200)}`;
        }
      }
    }
    const match = actual === poc.expected_verdict;
    return {
      poc_id: poc.id,
      type: 'scan-bash',
      expected: poc.expected_verdict,
      actual,
      match,
      detail: match ? '' : detail.length > 0 ? detail : `expected ${poc.expected_verdict}, got ${actual}`,
    };
  }
  // shellcheck
  const target = path.isAbsolute(poc.target) ? poc.target : path.join(cwd, poc.target);
  // -S error excludes warnings/info; but the claim contract is "no SC<code>
  // warnings" — keep severity at the default (warning) so SC1078 surfaces.
  // We allow stderr to be non-empty (shellcheck prints debug noise on
  // some versions) — only the exit code + stdout-line count matters.
  const result = spawn('shellcheck', [target], { encoding: 'utf8', timeout: 30_000 });
  if (result.error !== undefined) {
    // shellcheck not installed or otherwise broken. Treat as
    // "indeterminate" — we can't refute the claim without the tool, so
    // the safer posture is to FAIL the verification so a missing
    // shellcheck doesn't silently bless every claim.
    return {
      poc_id: poc.id,
      type: 'shellcheck',
      expected: 'clean',
      actual: 'error',
      match: false,
      detail: `shellcheck unavailable: ${result.error.message}`,
    };
  }
  const clean = result.status === 0 && (result.stdout ?? '').trim().length === 0;
  return {
    poc_id: poc.id,
    type: 'shellcheck',
    expected: 'clean',
    actual: clean ? 'clean' : 'warnings',
    match: clean,
    detail: clean
      ? ''
      : `shellcheck exit=${result.status}; output=${(result.stdout ?? '').slice(0, 400)}`,
  };
}

/**
 * Run all PoCs in a claim. Pure — exposed so tests can drive without
 * spawning processes if they substitute `spawn`.
 */
export function runVerifyClaimSync(
  claim: Claim,
  cliCmd: string,
  cliArgs: string[],
  cliPath: string,
  spawn: SpawnImpl = spawnSync,
  cwd: string = process.cwd(),
): VerifyClaimResult {
  const results: PoCResult[] = [];
  let matched = 0;
  let mismatched = 0;
  for (const poc of claim.pocs) {
    const r = runPoC(poc, cliCmd, cliArgs, spawn, cwd);
    results.push(r);
    if (r.match) matched += 1;
    else mismatched += 1;
  }
  return {
    claim_id: claim.id,
    cli: cliPath,
    total: claim.pocs.length,
    matched,
    mismatched,
    results,
    exit_code: mismatched > 0 ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export async function runVerifyClaim(claimId: string, opts: VerifyClaimOptions): Promise<void> {
  const claimsDir = opts.claimsDir ?? resolveDefaultClaimsDir();
  if (claimsDir === null) {
    err(
      'verify-claim: could not locate data/claims/ directory. ' +
        'This is a bug in the install or a stripped tarball.',
    );
    process.exit(2);
  }
  let claim: Claim;
  try {
    claim = loadClaim(claimsDir, claimId);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  let resolved: { cmd: string; args: string[]; path: string };
  try {
    resolved = resolveCli(opts);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }

  const result = runVerifyClaimSync(
    claim,
    resolved.cmd,
    resolved.args,
    resolved.path,
    spawnSync,
    opts.cwd ?? process.cwd(),
  );

  if (opts.json === true) {
    process.stdout.write(JSON.stringify(result) + '\n');
  } else {
    // Human-readable summary on stderr — keeps stdout clean for jq pipes
    // (consistent with `rea status`, `rea hook codex-review`).
    process.stderr.write(`[verify-claim] ${claim.id} — ${claim.title}\n`);
    process.stderr.write(`[verify-claim] cli=${resolved.path}\n`);
    process.stderr.write(`[verify-claim] introduced_in=${claim.introduced_in} closed_in=${claim.closed_in}\n`);
    for (const r of result.results) {
      const tag = r.match ? 'PASS' : 'FAIL';
      process.stderr.write(
        `[verify-claim]   ${tag}  ${r.poc_id}  expected=${r.expected} actual=${r.actual}` +
          (r.detail.length > 0 ? `  (${r.detail})` : '') +
          '\n',
      );
    }
    process.stderr.write(
      `[verify-claim] ${result.matched}/${result.total} PoCs matched (mismatched=${result.mismatched})\n`,
    );
  }

  process.exit(result.exit_code);
}

/**
 * Attach `rea verify-claim <claim-id>` to the commander program.
 */
export function registerVerifyClaimCommand(program: Command): void {
  program
    .command('verify-claim')
    .description(
      'Replay a recorded security-claim PoC battery against the rea CLI under test. ' +
        'Each claim at `data/claims/<id>.json` lists 1..N PoCs (scan-bash inputs or ' +
        'shellcheck targets) with expected verdicts. Exit 0 = all matched, 1 = mismatch, ' +
        '2 = unknown claim id.',
    )
    .argument('<claim-id>', 'claim identifier (kebab-case; corresponds to data/claims/<id>.json)')
    .option(
      '--installed',
      'verify against `node_modules/@bookedsolid/rea/dist/cli/index.js` ' +
        'in the current working directory (consumer-pinned version) ' +
        'instead of the dogfood build',
    )
    .option('--json', 'emit a single-line JSON result on stdout')
    .action(async (claimId: string, opts: { installed?: boolean; json?: boolean }) => {
      await runVerifyClaim(claimId, {
        ...(opts.installed === true ? { installed: true } : {}),
        ...(opts.json === true ? { json: true } : {}),
      });
    });
}
