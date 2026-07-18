/**
 * Tests for `templates/pre-push.local-first.sh` — the minimal pre-push
 * body operators can drop in to replace the canonical husky body.
 *
 * Round-27 F5 fix: pre-fix the template body was a single
 * `exec rea preflight --strict` line, which assumed `rea` was on PATH.
 * Git hooks run with the user's interactive PATH MINUS
 * `node_modules/.bin`, so devDependency-only installs got
 * `rea: not found` on every push. The fix mirrors the same resolution
 * ladder used by `src/cli/install/pre-push.ts::BODY_TEMPLATE`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_PATH = path.join(REPO_ROOT, 'templates', 'pre-push.local-first.sh');

describe('templates/pre-push.local-first.sh — round-27 F5', () => {
  const cleanup: string[] = [];

  afterEach(() => {
    for (const d of cleanup.splice(0)) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  it('carries the same rea-CLI resolution ladder as BODY_TEMPLATE', () => {
    const body = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    // 1. node_modules/.bin/rea
    expect(body).toMatch(/node_modules\/\.bin\/rea/);
    // 2. dogfood dist
    expect(body).toMatch(/dist\/cli\/index\.js/);
    expect(body).toMatch(/@bookedsolid\/rea/);
    // 3. PATH-resolved
    expect(body).toMatch(/command -v rea/);
    // 4. npx --no-install
    expect(body).toMatch(/npx --no-install @bookedsolid\/rea/);
    // Always invokes preflight --strict at the end of every branch.
    const matches = body.match(/preflight --strict/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(4);
  });

  it('parses with bash -n (syntax check)', () => {
    const r = spawnSync('bash', ['-n', TEMPLATE_PATH], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  // Round-50/51 P1 — the shipped static template must carry the SAME
  // mode-aware no-preflight fix as the generated BODY_TEMPLATE. The two are
  // hand-synced (no shared generator); this asserts the template did not lag.
  it('carries the round-54 tri-state gate-MODE detector + enforce/shadow/off split', () => {
    const body = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    // The gate-MODE helper exists and reads the LOCAL policy via REA_ROOT.
    expect(body).toMatch(/_rea_review_gate_mode\(\) \{/);
    expect(body).toMatch(/_rea_pol="\$\{REA_ROOT\}\/\.rea\/policy\.yaml"/);
    expect(body).toMatch(/\[ -f "\$_rea_pol" \] \|\| \{ printf 'off'; return 0; \}/);
    expect(body).toMatch(/command -v awk >\/dev\/null 2>&1 \|\| \{ printf 'enforce'; return 0; \}/);
    // round-55: presence/precedence detection — g3_review present is
    // authoritative; local_review only consulted when g3 is absent.
    expect(body).toMatch(/if \(s ~ \/g3_review\[\^A-Za-z_\]\.\*mode:\/\) \{ g3p=1; g3v=classify\(s\) \}/);
    expect(body).toMatch(/else if \(s ~ \/local_review\[\^A-Za-z_\]\.\*mode:\/\) \{ lgp=1; lgv=classify\(s\) \}/);
    expect(body).toMatch(/if \(g3p\) print \(g3v=="" \? "enforce" : g3v\)/);
    expect(body).toMatch(/else if \(lgp\) print \(lgv=="off" \? "off" : "enforce"\)/);
    expect(body).toMatch(/else print "off"/);
    // Tri-state: unknown-command routed through the mode switch; enforce → rc 2
    // + CONFIG-ERROR; shadow → WARN + rc 0; unknown-option always allows.
    expect(body).toMatch(/\*"unknown command"\*\)/);
    expect(body).toMatch(/case "\$\(_rea_review_gate_mode\)" in/);
    expect(body).toMatch(/_pf_out=""; _pf_rc=2/);
    expect(body).toMatch(/CONFIG-ERROR/);
    expect(body).toMatch(/WARN — review gate \(shadow\) could not run/);
    expect(body).toMatch(/REA_SKIP_LOCAL_REVIEW/);
    expect(body).toMatch(/# Pure flag incompatibility on a preflight-capable CLI/);
    const innerCmd = body.indexOf('*"unknown command"*)');
    const innerOpt = body.lastIndexOf('*"unknown option"*)');
    expect(innerCmd).toBeGreaterThan(-1);
    expect(innerOpt).toBeGreaterThan(innerCmd);
  });

  // Exec-harness: drive the template against a too-old `rea` (no `preflight`
  // command) under different policies. Tri-state per mode.
  async function runTemplateWithPolicy(
    policy: string | null,
  ): Promise<{ code: number; stderr: string }> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-tmpl-p54-'));
    cleanup.push(root);
    spawnSync('git', ['-C', root, 'init', '-q']);
    const bin = path.join(root, 'node_modules', '.bin', 'rea');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    // A CLI with no `preflight` command at all → `unknown command`.
    fs.writeFileSync(
      bin,
      '#!/bin/sh\ncase "$1" in preflight) echo "error: unknown command \'preflight\'" >&2; exit 1 ;; esac\nexit 0\n',
      { mode: 0o755 },
    );
    if (policy !== null) {
      fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
      fs.writeFileSync(path.join(root, '.rea', 'policy.yaml'), policy);
    }
    const hook = path.join(root, 'pre-push');
    fs.copyFileSync(TEMPLATE_PATH, hook);
    fs.chmodSync(hook, 0o755);
    const r = spawnSync(hook, ['origin', 'git@example:r.git'], { cwd: root, encoding: 'utf8' });
    return { code: r.status ?? -1, stderr: r.stderr ?? '' };
  }

  it('FAIL CLOSED: too-old CLI + `local_review.mode: enforce` (block) → exit 2 + CONFIG-ERROR', async () => {
    const r = await runTemplateWithPolicy('review:\n  local_review:\n    mode: enforce\n');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('CONFIG-ERROR');
    expect(r.stderr).toContain('REA_SKIP_LOCAL_REVIEW');
  });

  it('FAIL CLOSED: too-old CLI + nested inline `review: { local_review: { mode: enforce } }` → exit 2', async () => {
    const r = await runTemplateWithPolicy('review: { local_review: { mode: enforce } }\n');
    expect(r.code).toBe(2);
  });

  it('round-54 WARN+ALLOW: too-old CLI + nested inline `artifact_gates: { g3_review: { mode: shadow } }` → exit 0 + WARN', async () => {
    const r = await runTemplateWithPolicy('artifact_gates: { g3_review: { mode: shadow } }\n');
    expect(r.code).toBe(0);
    expect(r.stderr).toContain('WARN — review gate (shadow) could not run');
    expect(r.stderr).not.toContain('CONFIG-ERROR');
  });

  // round-55: legacy `local_review` speaks only `off`/`enforced`; a non-`off`
  // legacy value (g3-only `shadow`) resolves to ENFORCE per precedence.
  it('round-55: too-old CLI + `local_review.mode: shadow` (invalid legacy vocab) → ENFORCE → FAIL CLOSED (exit 2)', async () => {
    const r = await runTemplateWithPolicy('review:\n  local_review:\n    mode: shadow\n');
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('CONFIG-ERROR');
  });

  it('FAIL OPEN: too-old CLI + `local_review.mode: off` → exit 0 silent', async () => {
    const r = await runTemplateWithPolicy('review:\n  local_review:\n    mode: off\n');
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('WARN');
  });

  it('FAIL OPEN: too-old CLI + policy ABSENT → exit 0', async () => {
    const r = await runTemplateWithPolicy(null);
    expect(r.code).toBe(0);
  });

  // round-55 P1 — presence/precedence (g3_review authoritative over legacy).
  it('round-55: g3_review.mode: off + stale legacy enforced → OFF → ALLOW (exit 0)', async () => {
    const r = await runTemplateWithPolicy(
      'artifact_gates:\n  g3_review:\n    mode: off\nreview:\n  local_review:\n    mode: enforced\n',
    );
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('CONFIG-ERROR');
  });

  it('round-55: g3_review.mode: enforce + legacy off → ENFORCE → FAIL CLOSED (exit 2)', async () => {
    const r = await runTemplateWithPolicy(
      'artifact_gates:\n  g3_review:\n    mode: enforce\nreview:\n  local_review:\n    mode: off\n',
    );
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('CONFIG-ERROR');
  });

  it('round-55: g3 absent + legacy enforced → ENFORCE → FAIL CLOSED (exit 2)', async () => {
    const r = await runTemplateWithPolicy('review:\n  local_review:\n    mode: enforced\n');
    expect(r.code).toBe(2);
  });

  it('round-55: both keys absent → OFF → ALLOW (documented divergence)', async () => {
    const r = await runTemplateWithPolicy('version: "0.54.0"\nprofile: bst-internal\n');
    expect(r.code).toBe(0);
    expect(r.stderr).not.toContain('WARN');
  });

  it('discovers node_modules/.bin/rea from a synthetic project root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-tmpl-f5-'));
    cleanup.push(root);
    // Lay down a fake ./node_modules/.bin/rea that exits 0 if invoked.
    const fakeBin = path.join(root, 'node_modules', '.bin', 'rea');
    fs.mkdirSync(path.dirname(fakeBin), { recursive: true });
    fs.writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(fakeBin, 0o755);
    // Sanity: the resolution check the template uses (`-x file`) finds it.
    const probe = spawnSync(
      'bash',
      ['-c', `[ -x "${fakeBin}" ] && echo found || echo missing`],
      { encoding: 'utf8' },
    );
    expect(probe.stdout.trim()).toBe('found');
  });
});
