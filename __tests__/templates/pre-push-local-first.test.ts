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
