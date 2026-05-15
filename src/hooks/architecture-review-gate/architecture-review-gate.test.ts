/**
 * Unit tests for `runArchitectureReviewGate`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runArchitectureReviewGate } from './index.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-arch-gate-'));
}
function rm(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

function writePolicy(root: string, body: string): void {
  fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
  fs.writeFileSync(path.join(root, '.rea', 'policy.yaml'), body);
}

function payload(filePath: string, toolName: string = 'Edit'): string {
  return JSON.stringify({
    tool_name: toolName,
    tool_input: { file_path: filePath },
  });
}

const POLICY_WITH_PATTERNS = `version: "1"
profile: "test"
installed_by: "test"
installed_at: "2026-05-15T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: false
blocked_paths: []
architecture_review:
  patterns:
    - src/gateway/
    - hooks/_lib/
    - src/policy/
`;

describe('runArchitectureReviewGate', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rm(root);
  });

  it('HALT exits 2', async () => {
    writePolicy(root, POLICY_WITH_PATTERNS);
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'frozen\n');
    const r = await runArchitectureReviewGate({
      reaRoot: root,
      stdinOverride: payload('src/gateway/foo.ts'),
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('REA HALT');
  });

  it('exits 0 silently when policy file is missing', async () => {
    const r = await runArchitectureReviewGate({
      reaRoot: root,
      stdinOverride: payload('src/gateway/foo.ts'),
    });
    expect(r.exitCode).toBe(0);
    expect(r.matched).toBeNull();
    expect(r.stderr).toBe('');
  });

  it('exits 0 silently when patterns are unset', async () => {
    writePolicy(
      root,
      `version: "1"\nprofile: "test"\ninstalled_by: "t"\ninstalled_at: "2026-05-15T00:00:00Z"\nautonomy_level: L1\nmax_autonomy_level: L2\npromotion_requires_human_approval: true\nblock_ai_attribution: false\nblocked_paths: []\n`,
    );
    const r = await runArchitectureReviewGate({
      reaRoot: root,
      stdinOverride: payload('src/gateway/foo.ts'),
    });
    expect(r.exitCode).toBe(0);
    expect(r.matched).toBeNull();
  });

  it('exits 0 silently when architecture_advisory: false', async () => {
    writePolicy(
      root,
      POLICY_WITH_PATTERNS + '\narchitecture_advisory: false\n',
    );
    const r = await runArchitectureReviewGate({
      reaRoot: root,
      stdinOverride: payload('src/gateway/foo.ts'),
    });
    expect(r.exitCode).toBe(0);
    expect(r.matched).toBeNull();
  });

  it('exits 0 on empty file_path', async () => {
    writePolicy(root, POLICY_WITH_PATTERNS);
    const r = await runArchitectureReviewGate({
      reaRoot: root,
      stdinOverride: JSON.stringify({ tool_name: 'Edit', tool_input: {} }),
    });
    expect(r.exitCode).toBe(0);
    expect(r.matched).toBeNull();
  });

  it('emits advisory when file matches first pattern', async () => {
    writePolicy(root, POLICY_WITH_PATTERNS);
    const r = await runArchitectureReviewGate({
      reaRoot: root,
      stdinOverride: payload('src/gateway/foo.ts'),
    });
    expect(r.exitCode).toBe(0);
    expect(r.matched).toBe('src/gateway/');
    expect(r.stderr).toContain('ARCHITECTURE ADVISORY');
    expect(r.stderr).toContain('src/gateway/foo.ts');
    expect(r.stderr).toContain('Category: src/gateway/');
  });

  it('emits advisory when file matches second pattern', async () => {
    writePolicy(root, POLICY_WITH_PATTERNS);
    const r = await runArchitectureReviewGate({
      reaRoot: root,
      stdinOverride: payload('hooks/_lib/segments.sh'),
    });
    expect(r.exitCode).toBe(0);
    expect(r.matched).toBe('hooks/_lib/');
  });

  it('no advisory when file does not match any pattern', async () => {
    writePolicy(root, POLICY_WITH_PATTERNS);
    const r = await runArchitectureReviewGate({
      reaRoot: root,
      stdinOverride: payload('README.md'),
    });
    expect(r.exitCode).toBe(0);
    expect(r.matched).toBeNull();
    expect(r.stderr).toBe('');
  });

  describe('path normalization', () => {
    it('strips leading reaRoot prefix from absolute paths', async () => {
      writePolicy(root, POLICY_WITH_PATTERNS);
      const r = await runArchitectureReviewGate({
        reaRoot: root,
        stdinOverride: payload(path.join(root, 'src/gateway/foo.ts')),
      });
      expect(r.exitCode).toBe(0);
      expect(r.matched).toBe('src/gateway/');
    });

    it('normalizes Windows backslash paths', async () => {
      writePolicy(root, POLICY_WITH_PATTERNS);
      const r = await runArchitectureReviewGate({
        reaRoot: root,
        stdinOverride: payload('src\\gateway\\foo.ts'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.matched).toBe('src/gateway/');
    });

    it('URL-decodes file_path values', async () => {
      writePolicy(root, POLICY_WITH_PATTERNS);
      const r = await runArchitectureReviewGate({
        reaRoot: root,
        stdinOverride: payload('src%2Fgateway%2Ffoo.ts'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.matched).toBe('src/gateway/');
    });

    // 2026-05-15 codex round-1 P3 fix: leading `./` chains must be
    // stripped so relative-from-cwd paths still match.
    it('strips a leading `./` from relative paths', async () => {
      writePolicy(root, POLICY_WITH_PATTERNS);
      const r = await runArchitectureReviewGate({
        reaRoot: root,
        stdinOverride: payload('./src/gateway/foo.ts'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.matched).toBe('src/gateway/');
    });

    it('strips chained `././` prefixes', async () => {
      writePolicy(root, POLICY_WITH_PATTERNS);
      const r = await runArchitectureReviewGate({
        reaRoot: root,
        stdinOverride: payload('././src/gateway/foo.ts'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.matched).toBe('src/gateway/');
    });
  });

  // 2026-05-15 codex round-1 P3 fix: legacy / non-strict policy.yaml
  // shapes MUST NOT silently disable the advisory.
  describe('legacy policy.yaml tolerance', () => {
    it('still loads patterns when policy has unknown legacy keys', async () => {
      // A legacy / future key the strict zod schema would reject.
      const body = `version: "1"
profile: "test"
installed_by: "test"
installed_at: "2026-05-15T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: false
blocked_paths: []
some_legacy_key: "old-config"
another_unknown_field:
  nested: true
architecture_review:
  patterns:
    - src/gateway/
`;
      writePolicy(root, body);
      const r = await runArchitectureReviewGate({
        reaRoot: root,
        stdinOverride: payload('src/gateway/foo.ts'),
      });
      // Pre-fix this silently returned [] because the zod loader threw
      // on `some_legacy_key`. Post-fix the permissive YAML reader picks
      // up patterns regardless.
      expect(r.exitCode).toBe(0);
      expect(r.matched).toBe('src/gateway/');
    });

    it('exits 0 with a stderr warning on unparseable YAML (NOT silent)', async () => {
      writePolicy(root, 'this: is: not: valid: yaml: [\n  unclosed');
      const r = await runArchitectureReviewGate({
        reaRoot: root,
        stdinOverride: payload('src/gateway/foo.ts'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.matched).toBeNull();
      // The user MUST see a hint that the policy file is broken —
      // mysterious silence is the bug we're fixing.
      expect(r.stderr).toContain('policy.yaml is unparseable');
    });

    it('tolerates patterns that are not a list (returns [])', async () => {
      const body = `version: "1"
profile: "test"
installed_by: "test"
installed_at: "2026-05-15T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: false
blocked_paths: []
architecture_review:
  patterns: "src/gateway/"
`;
      writePolicy(root, body);
      const r = await runArchitectureReviewGate({
        reaRoot: root,
        stdinOverride: payload('src/gateway/foo.ts'),
      });
      // Patterns isn't a list — skip silently (matches bash policy_list
      // behavior, which returns no lines for a scalar).
      expect(r.exitCode).toBe(0);
      expect(r.matched).toBeNull();
    });
  });

  it('NotebookEdit payload via notebook_path', async () => {
    writePolicy(root, POLICY_WITH_PATTERNS);
    const r = await runArchitectureReviewGate({
      reaRoot: root,
      stdinOverride: JSON.stringify({
        tool_name: 'NotebookEdit',
        tool_input: { notebook_path: 'src/policy/loader.ipynb' },
      }),
    });
    // The bash hook used jq's `.tool_input.file_path // empty` so
    // notebook_path was NOT fall-through-resolved. But the Write
    // payload parser maps notebook_path → filePath when file_path is
    // absent — so we match here.
    expect(r.exitCode).toBe(0);
    expect(r.matched).toBe('src/policy/');
  });

  it('advisory tier: silently exits 0 on malformed payload', async () => {
    writePolicy(root, POLICY_WITH_PATTERNS);
    const r = await runArchitectureReviewGate({
      reaRoot: root,
      stdinOverride: '{not json',
    });
    // Advisory: never refuse, mirrors bash hook's jq-coerce-to-empty.
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  });
});
