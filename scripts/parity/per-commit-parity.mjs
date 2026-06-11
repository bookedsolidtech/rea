#!/usr/bin/env node
/**
 * Per-commit parity harness — codex vs gpt-oss-120b on the SAME single commit.
 *
 * For each commit C, this checks C out in a throwaway git worktree, then runs
 * `rea review` against just that commit's diff (`--base C^`) with EACH provider,
 * capturing the FULL findings (severity + title + body) from both sides. The
 * result is the raw material for a side-by-side quality comparison: did gpt-oss
 * catch the same real issues codex did, miss any, or add noise — per commit, on
 * real rea history.
 *
 * Single commits fit gpt-oss's context window (the commit-aware feature is for
 * RANGES that overflow), so this works without chunking — each commit is a
 * focused, in-window review.
 *
 * Requires OPENROUTER_API_KEY (env or `rea config set-key openrouter`) and the
 * codex CLI on PATH. Makes N real codex calls + N real gpt-oss calls — metered.
 *
 * Usage:
 *   node scripts/parity/per-commit-parity.mjs --last-n=5
 *   node scripts/parity/per-commit-parity.mjs --commits=<sha>,<sha>,<sha>
 *   node scripts/parity/per-commit-parity.mjs --last-n=6 --skip-merges
 *
 * Output: .rea/parity-dataset/per-commit/run-<ts>.json (full per-commit findings
 * from both providers) + a console summary.
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = execSync('git rev-parse --show-toplevel').toString().trim();
const REA = path.join(ROOT, 'dist', 'cli', 'index.js');
if (!fs.existsSync(REA)) {
  console.error('dist/ not built — run `pnpm build` first.');
  process.exit(2);
}

const arg = (name) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(`--${name}=`.length) : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);

// --- resolve the commit list -------------------------------------------------
let commits;
if (arg('commits')) {
  commits = arg('commits')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
} else {
  const n = Number(arg('last-n') ?? '5');
  const revArgs = ['rev-list', `--max-count=${n}`];
  if (flag('skip-merges')) revArgs.push('--no-merges');
  revArgs.push('HEAD');
  commits = execSync(`git ${revArgs.join(' ')}`).toString().trim().split('\n').filter(Boolean);
}
// oldest → newest for a readable report
commits = commits.reverse();

// codex round-9 P2: detect the key the SAME way the provider does — env-first,
// then the managed credentials file (`rea config set-key openrouter`). Checking
// `process.env` alone would skip the gpt-oss column for the documented
// file-backed credential flow. `rea config get-key` exits 0 iff a key resolves.
function reaKeyAvailable() {
  try {
    execFileSync('node', [REA, 'config', 'get-key', 'openrouter'], { stdio: 'pipe', env: process.env });
    return true;
  } catch {
    return false;
  }
}
const hasKey = reaKeyAvailable();
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

function shortSha(sha) {
  return sha.slice(0, 8);
}
function subjectOf(sha) {
  try {
    return execFileSync('git', ['show', '-s', '--format=%s', sha]).toString().trim();
  } catch {
    return '(unknown)';
  }
}
function parentOf(sha) {
  try {
    return execFileSync('git', ['rev-parse', `${sha}^`]).toString().trim();
  } catch {
    return EMPTY_TREE; // root commit
  }
}
function commitBytes(sha) {
  try {
    return execFileSync('git', ['show', sha, '--format=', '--no-ext-diff'], {
      maxBuffer: 256 * 1024 * 1024,
    }).length;
  } catch {
    return null;
  }
}

/** Run `rea review` for one provider inside a worktree; return the parsed last-review.json. */
function reviewCommit(worktree, provider, base) {
  const lrPath = path.join(worktree, '.rea', 'last-review.json');
  // codex round-15 P2: delete any prior snapshot BEFORE the run so a stale
  // last-review.json (e.g. codex's — codex runs first in this worktree) is
  // never misattributed to this provider when the run falls back or writes
  // nothing fresh. Without this, an openrouter→codex fallback would read codex's
  // own snapshot and the dataset would show false provider agreement.
  try {
    fs.rmSync(lrPath, { force: true });
  } catch {
    /* none */
  }
  const t0 = Date.now();
  let stdout = '';
  let exitCode = 0;
  try {
    stdout = execFileSync(
      'node',
      [REA, 'review', '--provider', provider, '--base', base, '--json', '--with-findings'],
      { cwd: worktree, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, env: process.env },
    );
  } catch (e) {
    exitCode = e.status ?? 1;
    stdout = (e.stdout || '').toString();
  }
  const ms = Date.now() - t0;
  // The authoritative findings land in <worktree>/.rea/last-review.json (now
  // guaranteed fresh — we deleted any prior snapshot above).
  let lastReview = null;
  try {
    lastReview = JSON.parse(fs.readFileSync(lrPath, 'utf8'));
  } catch {
    /* none written (skipped/error/refused) */
  }
  // gpt-oss cost from telemetry, if present.
  let cost;
  try {
    const lines = fs
      .readFileSync(path.join(worktree, '.rea', 'metrics.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const l of lines) {
      const row = JSON.parse(l);
      if (row.provider === provider && typeof row?.usage?.est_cost_usd === 'number') {
        cost = row.usage.est_cost_usd;
      } else if (row.provider === provider && typeof row.est_cost_usd === 'number') {
        cost = row.est_cost_usd;
      }
    }
  } catch {
    /* no telemetry */
  }
  let jsonStatus;
  try {
    const last = stdout.trim().split(/\r?\n/).filter(Boolean).pop();
    jsonStatus = JSON.parse(last);
  } catch {
    /* non-JSON */
  }
  // codex round-15 P2: the ACTUAL lane that served the review. If we asked for
  // openrouter but codex served it (path-guard refusal → fallback, malformed,
  // etc.), this is NOT a real gpt-oss result — flag it so the analysis excludes
  // it instead of recording a (codex) verdict as gpt-oss's.
  const actualProvider = jsonStatus?.provider ?? lastReview?.provider;
  const fellBack = actualProvider !== undefined && actualProvider !== provider;
  return {
    verdict: lastReview?.verdict ?? jsonStatus?.status ?? jsonStatus?.verdict ?? 'unknown',
    findings: Array.isArray(lastReview?.findings) ? lastReview.findings : [],
    exitCode,
    ms,
    ...(actualProvider !== undefined ? { actual_provider: actualProvider } : {}),
    ...(fellBack ? { fell_back: true } : {}),
    ...(cost !== undefined ? { est_cost_usd: cost } : {}),
  };
}

console.log(`\n=== Per-commit parity — codex vs gpt-oss-120b — ${commits.length} commits ===`);
if (!hasKey) {
  console.error('No OPENROUTER_API_KEY — gpt-oss side will be skipped. Set it first.');
}

const results = [];
for (const sha of commits) {
  const subject = subjectOf(sha);
  const base = parentOf(sha);
  const bytes = commitBytes(sha);
  process.stdout.write(`\n[${shortSha(sha)}] ${subject}  (${bytes ?? '?'} B)\n`);

  const wt = fs.mkdtempSync(path.join(os.tmpdir(), `rea-wt-${shortSha(sha)}-`));
  try {
    execFileSync('git', ['worktree', 'add', '--detach', '--force', wt, sha], { stdio: 'pipe' });
    // Use the worktree's OWN committed `.rea/policy.yaml` — do NOT copy the
    // current one in. Copying creates a `.rea/policy.yaml` working-tree change
    // that the review diff (`git diff HEAD`) would include, tripping the
    // path-guard (`blocked_paths:.rea/`) and falling the gpt-oss lane back to
    // codex — silently contaminating the parity data. The worktree at commit C
    // already has C's policy.yaml tracked + a clean tree, so the review diff is
    // exactly C^..C with no pollution. (rea's schema is additive, so the
    // historical policies parse under the current loader; if one didn't, the
    // review would refuse and we'd see it.)
    const codex = reviewCommit(wt, 'codex', base);
    process.stdout.write(
      `   codex   : ${codex.verdict}  (${codex.findings.length} findings, ${(codex.ms / 1000).toFixed(0)}s)\n`,
    );
    let openrouter = null;
    if (hasKey) {
      openrouter = reviewCommit(wt, 'openrouter', base);
      process.stdout.write(
        `   gpt-oss : ${openrouter.verdict}  (${openrouter.findings.length} findings, ${(openrouter.ms / 1000).toFixed(0)}s, $${(openrouter.est_cost_usd ?? 0).toFixed(5)})` +
          `${openrouter.fell_back ? `  ⚠️ FELL BACK to ${openrouter.actual_provider} — NOT a gpt-oss result` : ''}\n`,
      );
    }
    results.push({ sha, short: shortSha(sha), subject, base, bytes, codex, openrouter });
  } catch (e) {
    process.stdout.write(`   ERROR: ${e instanceof Error ? e.message : String(e)}\n`);
    results.push({ sha, short: shortSha(sha), subject, base, bytes, error: String(e) });
  } finally {
    try {
      execFileSync('git', ['worktree', 'remove', '--force', wt], { stdio: 'pipe' });
    } catch {
      fs.rmSync(wt, { recursive: true, force: true });
    }
  }
}

// --- persist + summarize -----------------------------------------------------
const outDir = path.join(ROOT, '.rea', 'parity-dataset', 'per-commit');
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const outPath = path.join(outDir, `run-${stamp}.json`);
fs.writeFileSync(outPath, JSON.stringify({ generated_at: stamp, commits: results }, null, 2));

console.log(`\n=== summary ===`);
console.log(`full per-commit findings written to: ${outPath}`);
console.log(`(feed this to the Obsidian quality-comparison generator.)`);
