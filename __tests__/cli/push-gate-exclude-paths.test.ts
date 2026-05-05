/**
 * 0.28.0 helix-029 — path-scoped finding filter for the push-gate.
 *
 * Tests:
 *   - Glob exclusion of `.claude/hooks/**` filters findings in those
 *     paths but keeps findings in helix-side code
 *   - Auto-exclude pulls paths from `.rea/install-manifest.json`
 *   - Combined globs + auto-exclude de-dupe correctly
 *   - Filter no-ops when `exclude_paths` is empty (back-compat)
 *   - Verdict recomputes from kept findings only (P1 in excluded
 *     paths becomes a pass when it's the only finding)
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filterFindingsByPath, type Finding } from '../../src/hooks/push-gate/findings.js';
import { resolvePushGatePolicy } from '../../src/hooks/push-gate/policy.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rea-helix-029-${prefix}-`));
}

function writePolicy(baseDir: string, body: string): void {
  const dir = path.join(baseDir, '.rea');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'policy.yaml'), body);
}

function writeManifest(baseDir: string, files: string[] | Record<string, unknown>): void {
  const dir = path.join(baseDir, '.rea');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'install-manifest.json'), JSON.stringify({ files }));
}

const MIN_POLICY_BASE = `
version: "1"
profile: "minimal"
installed_by: "test"
installed_at: "2026-01-01T00:00:00Z"
autonomy_level: "L1"
max_autonomy_level: "L2"
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths: []
notification_channel: ""
`;

describe('filterFindingsByPath — pure glob filter', () => {
  const findings: Finding[] = [
    { severity: 'P1', title: 'rea-managed bug', file: '.claude/hooks/foo.sh', body: '' },
    { severity: 'P2', title: 'helix code defect', file: 'src/components/Button.tsx', body: '' },
    { severity: 'P1', title: 'rea internal', file: '.rea/registry.yaml', body: '' },
    { severity: 'P3', title: 'no-file finding', body: '' },
  ];

  it('no-ops when globs is empty', () => {
    const r = filterFindingsByPath(findings, []);
    expect(r.kept).toEqual(findings);
    expect(r.excluded).toHaveLength(0);
    // Two P1s and one P2 in kept → blocking.
    expect(r.verdict).toBe('blocking');
  });

  it('excludes paths matching a `**`-style glob', () => {
    const r = filterFindingsByPath(findings, ['.claude/hooks/**']);
    expect(r.excluded).toHaveLength(1);
    expect(r.excluded[0]?.file).toBe('.claude/hooks/foo.sh');
    expect(r.kept).toHaveLength(3);
  });

  it('excludes paths matching multiple globs (auto-exclude composition)', () => {
    const r = filterFindingsByPath(findings, ['.claude/hooks/**', '.rea/**']);
    expect(r.excluded).toHaveLength(2);
    // The helix-side P2 + the no-file finding remain.
    expect(r.kept).toHaveLength(2);
    expect(r.kept.map((f) => f.severity).sort()).toEqual(['P2', 'P3']);
    // Verdict recomputes: P2 is now the highest → concerns.
    expect(r.verdict).toBe('concerns');
  });

  it('keeps findings without a `file` field (cannot be path-filtered)', () => {
    const r = filterFindingsByPath([{ severity: 'P1', title: 'no-path P1', body: '' }], [
      '.claude/**',
    ]);
    expect(r.kept).toHaveLength(1);
    expect(r.excluded).toHaveLength(0);
    expect(r.verdict).toBe('blocking');
  });

  it('verdict recomputes to pass when the only blocking finding is excluded', () => {
    const r = filterFindingsByPath(
      [{ severity: 'P1', title: 'sole P1', file: '.claude/hooks/x.sh', body: '' }],
      ['.claude/**'],
    );
    expect(r.kept).toHaveLength(0);
    expect(r.verdict).toBe('pass');
  });

  it('handles trailing-slash globs as directory matches', () => {
    const r = filterFindingsByPath(
      [{ severity: 'P1', title: 'in-dir', file: 'docs/internal/secret.md', body: '' }],
      ['docs/internal/'],
    );
    expect(r.excluded).toHaveLength(1);
  });

  it('escapes regex metacharacters in literal path segments', () => {
    const r = filterFindingsByPath(
      [
        { severity: 'P1', title: 'file with dot', file: 'some.path/file.ts', body: '' },
        { severity: 'P1', title: 'should NOT match', file: 'someApathBfile.ts', body: '' },
      ],
      ['some.path/file.ts'],
    );
    expect(r.excluded).toHaveLength(1);
    expect(r.excluded[0]?.file).toBe('some.path/file.ts');
  });

  it('normalizes Windows-style backslashes before matching', () => {
    const r = filterFindingsByPath(
      [{ severity: 'P1', title: 'win path', file: '.claude\\hooks\\foo.sh', body: '' }],
      ['.claude/hooks/**'],
    );
    expect(r.excluded).toHaveLength(1);
  });

  it('strips a leading ./ before matching', () => {
    const r = filterFindingsByPath(
      [{ severity: 'P1', title: 'rel path', file: './.rea/HALT', body: '' }],
      ['.rea/**'],
    );
    expect(r.excluded).toHaveLength(1);
  });
});

describe('resolvePushGatePolicy — exclude_paths resolution', () => {
  it('passes through when exclude_paths is unset', async () => {
    const dir = tmpDir('default');
    try {
      writePolicy(dir, MIN_POLICY_BASE);
      const r = await resolvePushGatePolicy(dir);
      expect(r.exclude_paths).toEqual([]);
      expect(r.auto_exclude_managed).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('resolves explicit exclude_paths from policy', async () => {
    const dir = tmpDir('explicit');
    try {
      writePolicy(
        dir,
        `${MIN_POLICY_BASE}
review:
  exclude_paths:
    - ".claude/hooks/**"
    - ".rea/**"
  auto_exclude_managed: false
`,
      );
      const r = await resolvePushGatePolicy(dir);
      expect(r.exclude_paths.sort()).toEqual(['.claude/hooks/**', '.rea/**']);
      expect(r.auto_exclude_managed).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('auto_exclude_managed defaults to true when exclude_paths is set', async () => {
    const dir = tmpDir('auto-default');
    try {
      writePolicy(
        dir,
        `${MIN_POLICY_BASE}
review:
  exclude_paths:
    - ".husky/**"
`,
      );
      writeManifest(dir, ['.claude/hooks/protected-paths-bash-gate.sh', '.rea/registry.yaml']);
      const r = await resolvePushGatePolicy(dir);
      expect(r.auto_exclude_managed).toBe(true);
      // Both the explicit glob AND the manifest paths are merged.
      expect(r.exclude_paths).toContain('.husky/**');
      expect(r.exclude_paths).toContain('.claude/hooks/protected-paths-bash-gate.sh');
      expect(r.exclude_paths).toContain('.rea/registry.yaml');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('auto_exclude_managed false explicitly opts out (only globs apply)', async () => {
    const dir = tmpDir('auto-off');
    try {
      writePolicy(
        dir,
        `${MIN_POLICY_BASE}
review:
  exclude_paths:
    - ".husky/**"
  auto_exclude_managed: false
`,
      );
      writeManifest(dir, ['.claude/hooks/x.sh']);
      const r = await resolvePushGatePolicy(dir);
      expect(r.auto_exclude_managed).toBe(false);
      expect(r.exclude_paths).toEqual(['.husky/**']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles object-form manifest (files: { path: { sha256 } })', async () => {
    const dir = tmpDir('manifest-obj');
    try {
      writePolicy(
        dir,
        `${MIN_POLICY_BASE}
review:
  exclude_paths:
    - "x"
`,
      );
      writeManifest(dir, {
        '.claude/hooks/foo.sh': { sha256: 'abc' },
        '.husky/pre-push': { sha256: 'def' },
      });
      const r = await resolvePushGatePolicy(dir);
      expect(r.exclude_paths).toContain('.claude/hooks/foo.sh');
      expect(r.exclude_paths).toContain('.husky/pre-push');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('degrades gracefully when manifest is malformed', async () => {
    const dir = tmpDir('manifest-bad');
    try {
      writePolicy(
        dir,
        `${MIN_POLICY_BASE}
review:
  exclude_paths:
    - "x"
`,
      );
      const reaDir = path.join(dir, '.rea');
      fs.mkdirSync(reaDir, { recursive: true });
      fs.writeFileSync(path.join(reaDir, 'install-manifest.json'), '{not valid json');
      const r = await resolvePushGatePolicy(dir);
      // Manifest parse failed → no manifest paths added; the explicit
      // glob remains.
      expect(r.exclude_paths).toEqual(['x']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('auto_exclude_managed reports false when exclude_paths is empty (no filter active)', async () => {
    const dir = tmpDir('auto-noop');
    try {
      writePolicy(
        dir,
        `${MIN_POLICY_BASE}
review:
  auto_exclude_managed: true
`,
      );
      writeManifest(dir, ['.claude/hooks/x.sh']);
      const r = await resolvePushGatePolicy(dir);
      // The principal redesign: auto-exclude is meaningful only when
      // the user signaled intent via exclude_paths. A bare
      // `auto_exclude_managed: true` without globs is still a no-op
      // — same as the legacy default.
      expect(r.auto_exclude_managed).toBe(false);
      expect(r.exclude_paths).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
