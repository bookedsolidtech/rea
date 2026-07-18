/**
 * G3 (review-gate) tri-state coverage-engine suite for `computePreflight`.
 *
 * `rea preflight` is the coverage engine the INSTALLED hooks call
 * (.husky/pre-push runs `rea preflight --strict`; the local-review-gate
 * Bash hook calls `computePreflight`). This suite proves the engine honors
 * the EFFECTIVE review mode — `artifact_gates.g3_review.mode` overrides the
 * legacy `review.local_review.mode` via the shared
 * `resolveEffectiveReviewMode` — so:
 *   - off     → clean pass,
 *   - shadow  → coverage-missing LOGS `rea.gate.g3.shadow` and does NOT refuse,
 *   - enforce → coverage-missing REFUSES (exit 2) and logs `rea.gate.g3`,
 * and a stale legacy `local_review.mode: off` no longer neuters an active G3.
 *
 * Real temp git repo + real `.rea/audit.jsonl`; no network, no model.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computePreflight, resolveEffectiveReviewMode } from './preflight.js';
import { invalidatePolicyCache } from '../policy/loader.js';

let tmpDir: string;

function gitc(args: string[]): void {
  execFileSync('git', args, { cwd: tmpDir, stdio: 'pipe' });
}

function writeFullPolicy(
  g3: 'off' | 'shadow' | 'enforce' | 'absent',
  localReviewMode: 'enforced' | 'off' = 'enforced',
): void {
  const lines = [
    'version: "0.54.0"',
    'profile: open-source-no-codex',
    'installed_by: t',
    'installed_at: "2026-07-18T00:00:00Z"',
    'autonomy_level: L1',
    'max_autonomy_level: L2',
    'promotion_requires_human_approval: true',
    'block_ai_attribution: true',
    'blocked_paths: []',
    'protected_paths_relax: []',
    'notification_channel: ""',
    'review:',
    '  local_review:',
    `    mode: ${localReviewMode}`,
    '    refuse_at: push',
  ];
  if (g3 !== 'absent') {
    lines.push('artifact_gates:', '  g3_review:', `    mode: ${g3}`);
  }
  lines.push('');
  fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.rea', 'policy.yaml'), lines.join('\n'));
  invalidatePolicyCache(tmpDir);
  invalidatePolicyCache();
}

function readAudit(): Array<Record<string, unknown>> {
  const p = path.join(tmpDir, '.rea', 'audit.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function auditHas(toolName: string): boolean {
  return readAudit().some((r) => r.tool_name === toolName);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-pf-g3-'));
  gitc(['init', '-q']);
  gitc(['config', 'user.email', 'pf@test.test']);
  gitc(['config', 'user.name', 'PF']);
  gitc(['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'export const x = 1;\n');
  gitc(['add', 'app.ts']);
  gitc(['commit', '-qm', 'baseline']);
  invalidatePolicyCache();
});

afterEach(() => {
  invalidatePolicyCache();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('resolveEffectiveReviewMode (shared precedence rule)', () => {
  it('g3 present is authoritative (any tier)', () => {
    expect(resolveEffectiveReviewMode('off', 'enforced')).toBe('off');
    expect(resolveEffectiveReviewMode('shadow', 'enforced')).toBe('shadow');
    expect(resolveEffectiveReviewMode('enforce', 'off')).toBe('enforce');
  });
  it('g3 absent → legacy drives (off → off, else → enforce)', () => {
    expect(resolveEffectiveReviewMode(undefined, 'off')).toBe('off');
    expect(resolveEffectiveReviewMode(undefined, 'enforced')).toBe('enforce');
    expect(resolveEffectiveReviewMode(undefined, undefined)).toBe('enforce');
  });
});

describe('computePreflight G3 effective-mode', () => {
  it('g3 off → clean pass (reason names g3), no gate audit', async () => {
    writeFullPolicy('off', 'enforced');
    const { outcome } = await computePreflight(tmpDir, { operation: 'push' });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.reason).toContain('artifact_gates.g3_review.mode is off');
    expect(auditHas('rea.gate.g3')).toBe(false);
    expect(auditHas('rea.gate.g3.shadow')).toBe(false);
  });

  it('g3 shadow, no coverage → clean (does NOT refuse) + logs rea.gate.g3.shadow', async () => {
    writeFullPolicy('shadow', 'enforced');
    const { outcome } = await computePreflight(tmpDir, { operation: 'push' });
    expect(outcome.exitCode).toBe(0);
    expect(auditHas('rea.gate.g3.shadow')).toBe(true);
    expect(auditHas('rea.gate.g3')).toBe(false);
    const rec = readAudit().find((r) => r.tool_name === 'rea.gate.g3.shadow')!;
    expect((rec.metadata as Record<string, unknown>).would_block).toBe(true);
  });

  it('g3 enforce, no coverage → REFUSE (exit 2) + logs rea.gate.g3 deny', async () => {
    writeFullPolicy('enforce', 'enforced');
    const { outcome } = await computePreflight(tmpDir, { operation: 'push' });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.status).toBe('refuse');
    expect(auditHas('rea.gate.g3')).toBe(true);
    expect(auditHas('rea.gate.g3.shadow')).toBe(false);
    const rec = readAudit().find((r) => r.tool_name === 'rea.gate.g3')!;
    expect(rec.status).toBe('denied');
  });

  it('UPGRADE PATH: g3 enforce + legacy local_review.mode OFF → still REFUSES (F2 fix)', async () => {
    writeFullPolicy('enforce', 'off');
    const { outcome } = await computePreflight(tmpDir, { operation: 'push' });
    // Pre-fix: preflight short-circuited on the legacy off-switch (exit 0),
    // silently bypassing an active G3. Now the effective mode governs.
    expect(outcome.exitCode).toBe(2);
    expect(auditHas('rea.gate.g3')).toBe(true);
  });

  it('g3 shadow + legacy enforced → shadow authoritative (exit 0, logs)', async () => {
    writeFullPolicy('shadow', 'enforced');
    const { outcome } = await computePreflight(tmpDir, { operation: 'push' });
    expect(outcome.exitCode).toBe(0);
    expect(auditHas('rea.gate.g3.shadow')).toBe(true);
  });

  it('LEGACY INVARIANT: g3 absent + legacy enforced, no coverage → refuse, NO gate audit', async () => {
    writeFullPolicy('absent', 'enforced');
    const { outcome } = await computePreflight(tmpDir, { operation: 'push' });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.reason).toContain('no recent local-review audit entry covers HEAD');
    expect(auditHas('rea.gate.g3')).toBe(false);
    expect(auditHas('rea.gate.g3.shadow')).toBe(false);
  });

  it('g3 absent + legacy off → clean (legacy off-switch), no gate audit', async () => {
    writeFullPolicy('absent', 'off');
    const { outcome } = await computePreflight(tmpDir, { operation: 'push' });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.reason).toContain('policy.review.local_review.mode is off');
    expect(auditHas('rea.gate.g3')).toBe(false);
  });

  it('HALT wins over an active g3 enforce (exit 2, no coverage probe)', async () => {
    writeFullPolicy('enforce', 'enforced');
    fs.writeFileSync(path.join(tmpDir, '.rea', 'HALT'), 'maintenance');
    const { outcome } = await computePreflight(tmpDir, { operation: 'push' });
    expect(outcome.exitCode).toBe(2);
    expect(outcome.reason).toContain('REA HALT');
    // HALT short-circuits before the mode resolution → no gate record.
    expect(auditHas('rea.gate.g3')).toBe(false);
  });
});

describe('computePreflight G3 malformed policy (strict-fail-to-enforced)', () => {
  function writeMalformedPolicy(localReviewMode: 'enforced' | 'off'): void {
    const lines = [
      'version: "0.54.0"',
      'profile: open-source-no-codex',
      'installed_by: t',
      'installed_at: "2026-07-18T00:00:00Z"',
      'autonomy_level: L1',
      'max_autonomy_level: L2',
      'promotion_requires_human_approval: true',
      'block_ai_attribution: true',
      'blocked_paths: []',
      'protected_paths_relax: []',
      'notification_channel: ""',
      'review:',
      '  local_review:',
      `    mode: ${localReviewMode}`,
      '    refuse_at: push',
      'artifact_gates:',
      '  g3_review:',
      '    mode: bogus',
      '',
    ];
    fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.rea', 'policy.yaml'), lines.join('\n'));
    invalidatePolicyCache(tmpDir);
    invalidatePolicyCache();
  }

  it('malformed g3_review.mode + legacy enforced → REFUSE (strict load fails to enforced)', async () => {
    writeMalformedPolicy('enforced');
    const { outcome } = await computePreflight(tmpDir, { operation: 'push' });
    expect(outcome.exitCode).toBe(2);
  });

  it('malformed g3_review.mode + legacy OFF → still REFUSE — the whole policy is rejected, so the legacy off-switch is lost (round-38 P2 convergence)', async () => {
    writeMalformedPolicy('off');
    const { outcome } = await computePreflight(tmpDir, { operation: 'push' });
    // This is what the tolerant Bash gate must MATCH: strict load fails the
    // entire policy, so `legacyMode` is undefined too → enforced default.
    expect(outcome.exitCode).toBe(2);
  });
});
