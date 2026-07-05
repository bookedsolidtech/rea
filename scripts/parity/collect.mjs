#!/usr/bin/env node
/**
 * Accumulate codex-vs-gpt-oss parity data points into `.rea/parity-dataset/`
 * (gitignored — local research data, not shipped). Two row kinds, both
 * measuring the two reviewers against rea's OWN evolving diff:
 *
 *   - `both-live`   — a `rea review --provider both` run. Reads
 *                     `.rea/review-parity.json` (verdict agreement, P1/P2
 *                     overlap, FP delta, latency, REAL gpt-oss cost) and
 *                     snapshots the full report under `reports/`.
 *   - `codex-round` — one convergence-loop codex round. Reads the codex hook
 *                     JSON (`{verdict, finding_count, audit_hash, head_sha}`).
 *
 * Each row is appended to `.rea/parity-dataset/runs.jsonl` (append-only). The
 * accumulated file is the "deep set": how codex and gpt-oss agree as the diff
 * converges from many-findings to clean.
 *
 * Usage:
 *   node scripts/parity/collect.mjs both-live [label]
 *   node scripts/parity/collect.mjs codex-round <round> <codex-json-path>
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = execSync('git rev-parse --show-toplevel').toString().trim();
const DS = path.join(ROOT, '.rea', 'parity-dataset');
fs.mkdirSync(path.join(DS, 'reports'), { recursive: true });

const ts = new Date().toISOString();
const sh = (cmd) => {
  try {
    return execSync(cmd, { maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
};
const headSha = (sh('git rev-parse HEAD')?.toString().trim()) ?? 'unknown';
const diffBytes = (() => {
  const a = sh('git diff main...HEAD --no-ext-diff');
  const b = sh('git diff HEAD --no-ext-diff');
  return a !== null && b !== null ? a.length + b.length : null;
})();

const kind = process.argv[2];
let row = { ts, kind, head_sha: headSha, diff_bytes: diffBytes };

if (kind === 'both-live') {
  const label = process.argv[3];
  const p = path.join(ROOT, '.rea', 'review-parity.json');
  if (!fs.existsSync(p)) {
    console.error('collect: no .rea/review-parity.json — did `rea review --provider both` run?');
    process.exit(1);
  }
  const r = JSON.parse(fs.readFileSync(p, 'utf8'));
  row = {
    ...row,
    ...(label ? { label } : {}),
    codex_verdict: r.codex_verdict,
    openrouter_verdict: r.openrouter_verdict,
    verdict_agreement: r.verdict_agreement,
    p1_overlap: r.p1_overlap,
    p2_overlap: r.p2_overlap,
    fp_delta: r.fp_delta,
    malformed: r.malformed,
    openrouter_unavailable: r.openrouter_unavailable ?? false,
    openrouter_timed_out: r.openrouter_timed_out ?? false,
    openrouter_est_cost_usd: r.openrouter_est_cost_usd,
    codex_latency_s: r.codex_latency_seconds,
    openrouter_latency_s: r.openrouter_latency_seconds,
  };
  const snap = path.join(DS, 'reports', `parity-${ts.replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(snap, JSON.stringify(r, null, 2));
} else if (kind === 'codex-round') {
  const round = Number(process.argv[3]);
  const jsonPath = process.argv[4];
  if (!jsonPath || !fs.existsSync(jsonPath)) {
    console.error('collect: codex-round needs <round> <codex-json-path>');
    process.exit(2);
  }
  const last = fs.readFileSync(jsonPath, 'utf8').trim().split('\n').filter(Boolean).pop();
  const r = JSON.parse(last);
  row = {
    ...row,
    round,
    codex_verdict: r.verdict,
    codex_findings: r.finding_count,
    audit_hash: r.audit_hash,
    ...(r.head_sha ? { codex_head_sha: r.head_sha } : {}),
  };
} else {
  console.error('usage: collect.mjs both-live [label] | codex-round <round> <json>');
  process.exit(2);
}

fs.appendFileSync(path.join(DS, 'runs.jsonl'), JSON.stringify(row) + '\n');
console.log('recorded:', JSON.stringify(row));
