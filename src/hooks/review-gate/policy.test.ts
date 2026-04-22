/**
 * Unit tests for `policy.ts`. Covers fail-closed (malformed policy →
 * codex_required=true), happy-path (review.codex_required: false loaded
 * cleanly), and the skip-env + legacy-bash kill-switch semantics.
 */

import { describe, expect, it, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isCiContext,
  isLegacyBashKillSwitchOn,
  readSkipEnv,
  resolveReviewPolicy,
} from './policy.js';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-policy-test-'));
}

function writePolicy(baseDir: string, yaml: string): void {
  const dir = path.join(baseDir, '.rea');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'policy.yaml'), yaml);
}

const MINIMAL_VALID_POLICY = `version: "1"
profile: "bst-internal"
installed_by: "rea@test"
installed_at: "2026-04-22T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths: []
`;

describe('resolveReviewPolicy', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const d of tempDirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
    tempDirs.length = 0;
  });

  it('returns codex_required=true when policy file is missing (fail-closed)', () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    const r = resolveReviewPolicy(dir);
    expect(r.codex_required).toBe(true);
    expect(r.policy).toBeNull();
    expect(r.warning).not.toBeNull();
  });

  it('returns codex_required=true for malformed YAML (fail-closed)', () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writePolicy(dir, 'this is not: valid: yaml: at all: :');
    const r = resolveReviewPolicy(dir);
    expect(r.codex_required).toBe(true);
    expect(r.warning).not.toBeNull();
  });

  it('returns codex_required=true for a valid policy with no review block', () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writePolicy(dir, MINIMAL_VALID_POLICY);
    const r = resolveReviewPolicy(dir);
    expect(r.codex_required).toBe(true);
    expect(r.policy).not.toBeNull();
    expect(r.warning).toBeNull();
  });

  it('returns codex_required=false when explicitly disabled in policy', () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writePolicy(dir, MINIMAL_VALID_POLICY + 'review:\n  codex_required: false\n');
    const r = resolveReviewPolicy(dir);
    expect(r.codex_required).toBe(false);
    expect(r.warning).toBeNull();
  });

  it('returns allow_skip_in_ci=true when explicitly enabled', () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writePolicy(dir, MINIMAL_VALID_POLICY + 'review:\n  allow_skip_in_ci: true\n');
    const r = resolveReviewPolicy(dir);
    expect(r.allow_skip_in_ci).toBe(true);
  });

  it('returns allow_skip_in_ci=false by default', () => {
    const dir = makeTempDir();
    tempDirs.push(dir);
    writePolicy(dir, MINIMAL_VALID_POLICY);
    const r = resolveReviewPolicy(dir);
    expect(r.allow_skip_in_ci).toBe(false);
  });
});

describe('readSkipEnv', () => {
  it('returns null for both fields when unset', () => {
    const r = readSkipEnv({});
    expect(r.push_review_reason).toBeNull();
    expect(r.codex_review_reason).toBeNull();
  });

  it('returns null when env vars are empty strings', () => {
    const r = readSkipEnv({
      REA_SKIP_PUSH_REVIEW: '',
      REA_SKIP_CODEX_REVIEW: '',
    });
    expect(r.push_review_reason).toBeNull();
    expect(r.codex_review_reason).toBeNull();
  });

  it('returns the value as the skip reason when set', () => {
    const r = readSkipEnv({
      REA_SKIP_PUSH_REVIEW: 'ci is broken',
      REA_SKIP_CODEX_REVIEW: 'codex is down',
    });
    expect(r.push_review_reason).toBe('ci is broken');
    expect(r.codex_review_reason).toBe('codex is down');
  });
});

describe('isCiContext', () => {
  it('is true when CI is set to a non-empty value', () => {
    expect(isCiContext({ CI: 'true' })).toBe(true);
    expect(isCiContext({ CI: '1' })).toBe(true);
  });

  it('is false when CI is unset', () => {
    expect(isCiContext({})).toBe(false);
  });

  it('is false when CI is the empty string', () => {
    expect(isCiContext({ CI: '' })).toBe(false);
  });
});

describe('isLegacyBashKillSwitchOn', () => {
  it('is true for non-empty non-"0" values', () => {
    expect(isLegacyBashKillSwitchOn({ REA_LEGACY_PUSH_REVIEW: '1' })).toBe(true);
    expect(isLegacyBashKillSwitchOn({ REA_LEGACY_PUSH_REVIEW: 'yes' })).toBe(true);
  });

  it('is false when unset', () => {
    expect(isLegacyBashKillSwitchOn({})).toBe(false);
  });

  it('is false when set to "0" (explicit disable)', () => {
    expect(isLegacyBashKillSwitchOn({ REA_LEGACY_PUSH_REVIEW: '0' })).toBe(false);
  });

  it('is false when empty string', () => {
    expect(isLegacyBashKillSwitchOn({ REA_LEGACY_PUSH_REVIEW: '' })).toBe(false);
  });
});
