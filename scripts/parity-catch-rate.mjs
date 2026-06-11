#!/usr/bin/env node
/**
 * Parity catch-rate — codex (gpt-5.4) vs gpt-oss-120b on OUR OWN code.
 *
 * The 16-round hardening of the openrouter provider produced a ground-truth
 * corpus of real defects codex caught (scripts/parity/corpus.json). This
 * harness measures whether the CHEAP model would have caught them too — the
 * load-bearing question for "demote codex to a metered scalpel".
 *
 * For each corpus case it: (1) reintroduces the defect by a precise
 * anchor→replacement edit in source, (2) runs `rea review --provider both`
 * (codex authoritative + gpt-oss shadow) over the working-tree diff, (3) records
 * whether EACH reviewer's verdict WORSENED vs a clean baseline, (4) restores the
 * file via `git checkout`. A worsened verdict = the reviewer noticed the defect.
 *
 * Requires OPENROUTER_API_KEY for the gpt-oss side (see scripts/parity/README.md).
 * Without it, only the codex baseline runs (gpt-oss column shows `no-key`).
 *
 * Usage:
 *   node scripts/parity-catch-rate.mjs                 # all cases
 *   node scripts/parity-catch-rate.mjs --cases=verdict-laundering,diff-fail-open
 *
 * NOTE: each case runs ONE full `rea review` over the whole branch diff (that is
 * the product's real behavior and how codex found these). Budget ~1 codex +
 * ~1 gpt-oss review per case. Codex spend is metered; gpt-oss is pennies.
 */
import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = execSync('git rev-parse --show-toplevel').toString().trim();
process.chdir(ROOT);
const REA = path.join(ROOT, 'dist', 'cli', 'index.js');
if (!fs.existsSync(REA)) {
  console.error('dist/ not built — run `pnpm build` first.');
  process.exit(2);
}
const corpus = JSON.parse(fs.readFileSync('scripts/parity/corpus.json', 'utf8'));

// SAFETY (codex P1): this harness MUTATES each corpus source file (inserts a
// known defect) and then restores it with `git checkout -- <file>`. If a target
// file has uncommitted changes, that restore — including the pre-emptive
// restore() below the baseline — would DISCARD the developer's WIP. Refuse to
// run when any file we will touch is dirty; the harness is designed to run on a
// clean checkout of those files. WIP elsewhere in the tree is fine.
const targetFiles = [...new Set(corpus.cases.map((c) => c.file))];
const dirty = execFileSync('git', ['status', '--porcelain', '--', ...targetFiles], {
  encoding: 'utf8',
}).trim();
if (dirty.length > 0) {
  console.error('Refusing to run: the parity harness inserts a defect into each corpus file');
  console.error('and restores it with `git checkout -- <file>`, which would DISCARD your');
  console.error('uncommitted changes in:');
  for (const line of dirty.split(/\r?\n/)) console.error(`  ${line}`);
  console.error('\nCommit or stash these changes first, then re-run.');
  process.exit(2);
}

// codex round-9 P2: detect the key the SAME way the provider resolves it —
// env-first, then the managed credentials file (`rea config set-key openrouter`).
// A plain `process.env` check skips the gpt-oss column for the file-backed flow.
// `rea config get-key` exits 0 iff a key resolves (env OR file).
function reaKeyAvailable() {
  try {
    execFileSync('node', [REA, 'config', 'get-key', 'openrouter'], { stdio: 'pipe', env: process.env });
    return true;
  } catch {
    return false;
  }
}
const hasKey = reaKeyAvailable();
const mode = hasKey ? 'both' : 'codex';
const onlyArg = process.argv.find((a) => a.startsWith('--cases='));
const only = onlyArg ? onlyArg.slice('--cases='.length).split(',') : null;

// codex round-15 P2: `error` is NOT a verdict rank — a provider FAILURE
// (timeout / auth / invalid-policy / malformed) is not a caught defect. It is
// excluded from RANK (→ rank 0 via the `?? 0` fallback) AND guarded explicitly
// in the catch logic, so a transient failure on a mutated case never inflates
// the catch rate.
const RANK = { pass: 0, concerns: 1, blocking: 2 };
const rank = (v) => RANK[v] ?? 0;
const isError = (v) => v === 'error' || v === 'unknown';

function restore(file) {
  try { execFileSync('git', ['checkout', '--', file], { stdio: 'pipe' }); } catch { /* best effort */ }
}

/** Run `rea review` over the current working tree; return { codexVerdict, orVerdict, cost, ms }. */
function runReview() {
  // codex round-15 P3: `.rea/review-parity.json` is rewritten ONLY on a
  // successful `--provider both` run. Delete it first so a case that exits
  // early (refusal, error) can NEVER reuse the previous case's openrouter
  // verdict/cost — a stale read would corrupt the dataset with another diff's data.
  try {
    fs.rmSync(path.join(ROOT, '.rea', 'review-parity.json'), { force: true });
  } catch {
    /* none */
  }
  const t0 = Date.now();
  let out = '';
  try {
    out = execFileSync(
      'node',
      [REA, 'review', '--provider', mode, '--json', '--with-findings', '--strict-fail-on', 'concerns'],
      { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
    );
  } catch (e) {
    out = (e.stdout || '').toString();
  }
  const ms = Date.now() - t0;
  let codex = {};
  try { codex = JSON.parse(out.trim().split(/\r?\n/).filter(Boolean).pop()); } catch { /* leave {} */ }
  let parity = null;
  try { parity = JSON.parse(fs.readFileSync(path.join(ROOT, '.rea', 'review-parity.json'), 'utf8')); } catch { /* none */ }
  return {
    codexVerdict: codex.status || codex.verdict || 'unknown',
    orVerdict: hasKey ? (parity?.openrouter_verdict ?? 'unknown') : 'no-key',
    cost: parity?.openrouter_est_cost_usd,
    ms,
  };
}

console.log(`\n=== Parity catch-rate — mode: ${mode}${hasKey ? '' : ' (NO KEY — gpt-oss skipped)'} ===`);
console.log('Baselining both reviewers on the clean diff …');
// Restore any case files first (in case a prior run left a break behind).
for (const c of corpus.cases) restore(c.file);
const base = runReview();
console.log(`  baseline: codex=${base.codexVerdict}  gpt-oss=${base.orVerdict}  (${(base.ms / 1000).toFixed(0)}s)\n`);

const results = [];
for (const c of corpus.cases) {
  if (only && !only.includes(c.id)) continue;
  const src = fs.readFileSync(c.file, 'utf8');
  const matches = src.split(c.anchor).length - 1;
  if (matches !== 1) {
    results.push({ ...c, status: `STALE-ANCHOR (${matches} matches — update corpus)` });
    console.log(`  [skip] ${c.id}: STALE ANCHOR (${matches} matches in ${c.file})`);
    continue;
  }
  fs.writeFileSync(c.file, src.replace(c.anchor, c.replacement));
  try {
    process.stdout.write(`  [run ] ${c.id} (${c.severity}) … `);
    const r = runReview();
    // A defect is "caught" only when the reviewer's verdict WORSENED to a real
    // verdict (concerns/blocking) — never when the reviewer errored out.
    const codexCaught = !isError(r.codexVerdict) && rank(r.codexVerdict) > rank(base.codexVerdict);
    const orCaught = hasKey
      ? !isError(r.orVerdict) && rank(r.orVerdict) > rank(base.orVerdict)
      : null;
    results.push({ ...c, codexVerdict: r.codexVerdict, codexCaught, orVerdict: r.orVerdict, orCaught, cost: r.cost, ms: r.ms });
    console.log(`codex=${r.codexVerdict}${codexCaught ? ' ✓caught' : ' ✗missed'}  gpt-oss=${r.orVerdict}${orCaught === null ? '' : orCaught ? ' ✓caught' : ' ✗MISSED'}  (${(r.ms / 1000).toFixed(0)}s)`);
  } finally {
    restore(c.file);
  }
}

// --- Summary -----------------------------------------------------------------
const scored = results.filter((r) => r.codexCaught !== undefined);
const bySev = (sev) => scored.filter((r) => r.severity === sev);
const rate = (arr, key) => {
  const n = arr.filter((r) => r[key] !== null).length;
  const hit = arr.filter((r) => r[key] === true).length;
  return n ? `${hit}/${n} (${Math.round((100 * hit) / n)}%)` : '—';
};
console.log('\n=== SUMMARY ===');
for (const sev of ['P1', 'P2', 'P3']) {
  const arr = bySev(sev);
  if (!arr.length) continue;
  console.log(`  ${sev}: codex ${rate(arr, 'codexCaught')}   gpt-oss ${rate(arr, 'orCaught')}`);
}
console.log(`  ALL: codex ${rate(scored, 'codexCaught')}   gpt-oss ${rate(scored, 'orCaught')}`);
const misses = scored.filter((r) => r.orCaught === false);
if (hasKey && misses.length) {
  console.log(`\n  gpt-oss MISSED (codex caught, gpt-oss did not):`);
  for (const m of misses) console.log(`    - [${m.severity}] ${m.id}: ${m.description}`);
}
const totalCost = scored.reduce((s, r) => s + (Number(r.cost) || 0), 0);
if (hasKey) console.log(`\n  gpt-oss spend this run: ~$${totalCost.toFixed(4)}`);

const report = { generatedBy: 'parity-catch-rate', mode, baseline: base, results };
fs.writeFileSync('scripts/parity/last-run.json', JSON.stringify(report, null, 2) + '\n');
console.log('\n  full report → scripts/parity/last-run.json');
console.log(hasKey ? '' : '\n  NOTE: set OPENROUTER_API_KEY and re-run for the gpt-oss column (the actual test).');
// Always leave the tree clean.
for (const c of corpus.cases) restore(c.file);
