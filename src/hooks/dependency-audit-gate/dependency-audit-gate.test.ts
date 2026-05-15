/**
 * Unit tests for `runDependencyAuditGate`. Uses the `verifyPackage`
 * test seam so no live `npm view` is spawned.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  extractPackages,
  runDependencyAuditGate,
  __INTERNAL_INSTALL_PATTERN_FOR_TESTS,
  __INTERNAL_MAX_PACKAGES_FOR_TESTS,
} from './index.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-dep-audit-'));
}
function rm(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
function payload(cmd: string, toolName: string = 'Bash'): string {
  return JSON.stringify({ tool_name: toolName, tool_input: { command: cmd } });
}
const ALWAYS_OK = vi.fn(async (_: string) => true);
const ALWAYS_FAIL = vi.fn(async (_: string) => false);

describe('extractPackages', () => {
  it('returns [] for non-install commands', () => {
    expect(extractPackages('ls')).toEqual([]);
    expect(extractPackages('git status')).toEqual([]);
    expect(extractPackages('echo "npm install foo"')).toEqual([]);
  });

  it('extracts a single npm install package', () => {
    expect(extractPackages('npm install lodash')).toEqual(['lodash']);
    expect(extractPackages('npm i lodash')).toEqual(['lodash']);
    expect(extractPackages('pnpm add lodash')).toEqual(['lodash']);
    expect(extractPackages('yarn add lodash')).toEqual(['lodash']);
  });

  it('extracts multiple packages', () => {
    expect(extractPackages('npm install react react-dom')).toEqual([
      'react',
      'react-dom',
    ]);
  });

  it('strips trailing @version', () => {
    expect(extractPackages('npm install lodash@4.17.21')).toEqual(['lodash']);
    expect(extractPackages('pnpm add @types/node@latest')).toEqual([
      '@types/node',
    ]);
  });

  it('preserves leading-@ scope', () => {
    expect(extractPackages('npm install @bookedsolid/rea')).toEqual([
      '@bookedsolid/rea',
    ]);
  });

  it('skips flags', () => {
    expect(
      extractPackages('npm install --save-dev --silent typescript'),
    ).toEqual(['typescript']);
  });

  it('skips path installs', () => {
    expect(extractPackages('npm install ./local-pkg')).toEqual([]);
    expect(extractPackages('npm install /tmp/pkg')).toEqual([]);
    expect(extractPackages('npm install ../sibling')).toEqual([]);
  });

  it('skips shell metacharacters', () => {
    expect(extractPackages('npm install 2>&1')).toEqual([]);
    expect(extractPackages('npm install $VAR')).toEqual([]);
    expect(extractPackages('npm install `cmd`')).toEqual([]);
  });

  it('skips workspace/link/file/git+ protocols', () => {
    expect(extractPackages('pnpm add workspace:my-pkg')).toEqual([]);
    expect(extractPackages('npm install link:../sibling')).toEqual([]);
    expect(extractPackages('npm install file:./tar.tgz')).toEqual([]);
    expect(extractPackages('npm install git+https://...')).toEqual([]);
  });

  it('skips heredoc bodies / commit messages mentioning install', () => {
    // 0.15.0 fix: full-command grep was vulnerable to commit messages
    // containing `pnpm install`. Segment-anchored should reject.
    const cmd = `git commit -m "$(cat <<EOF
chore: bump pnpm install logic
EOF
)"`;
    expect(extractPackages(cmd)).toEqual([]);
  });

  it('handles env-var prefixes (helix-016 P2 fix)', () => {
    expect(extractPackages('CI=1 pnpm add lodash')).toEqual(['lodash']);
    expect(extractPackages('NODE_ENV=development npm install bar')).toEqual([
      'bar',
    ]);
  });

  it('handles `&` background-process splitter (helix-019 fix)', () => {
    expect(extractPackages('sleep 1 & pnpm add foo')).toEqual(['foo']);
  });

  it('handles nested && / || / ; chains', () => {
    expect(extractPackages('pnpm install && npm install lodash')).toEqual([
      'lodash',
    ]);
    expect(extractPackages('ls; pnpm add foo; ls')).toEqual(['foo']);
  });

  it('handles sudo/exec/time prefixes', () => {
    expect(extractPackages('sudo npm install -g typescript')).toEqual([
      'typescript',
    ]);
    expect(extractPackages('time pnpm add foo')).toEqual(['foo']);
  });
});

describe('runDependencyAuditGate', () => {
  let root: string;
  beforeEach(() => {
    root = makeRoot();
  });
  afterEach(() => {
    rm(root);
  });

  it('HALT short-circuits with exit 2', async () => {
    fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'frozen by test\n');
    const result = await runDependencyAuditGate({
      reaRoot: root,
      stdinOverride: payload('npm install lodash'),
      verifyPackage: ALWAYS_OK,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('REA HALT');
  });

  it('exits 2 on malformed JSON', async () => {
    const result = await runDependencyAuditGate({
      reaRoot: root,
      stdinOverride: '{not json',
      verifyPackage: ALWAYS_OK,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('dependency-audit-gate');
  });

  it('exits 0 on non-Bash tool', async () => {
    const result = await runDependencyAuditGate({
      reaRoot: root,
      stdinOverride: payload('npm install lodash', 'Write'),
      verifyPackage: ALWAYS_OK,
    });
    expect(result.exitCode).toBe(0);
    expect(ALWAYS_OK).not.toHaveBeenCalled();
  });

  it('exits 0 on empty command', async () => {
    const result = await runDependencyAuditGate({
      reaRoot: root,
      stdinOverride: payload(''),
      verifyPackage: ALWAYS_OK,
    });
    expect(result.exitCode).toBe(0);
  });

  it('exits 0 when command has no install', async () => {
    const result = await runDependencyAuditGate({
      reaRoot: root,
      stdinOverride: payload('ls'),
      verifyPackage: ALWAYS_OK,
    });
    expect(result.exitCode).toBe(0);
    expect(ALWAYS_OK).not.toHaveBeenCalled();
  });

  it('exits 0 when all packages verify', async () => {
    const verify = vi.fn(async (_: string) => true);
    const result = await runDependencyAuditGate({
      reaRoot: root,
      stdinOverride: payload('npm install lodash react'),
      verifyPackage: verify,
    });
    expect(result.exitCode).toBe(0);
    expect(result.checkedPackages).toEqual(['lodash', 'react']);
    expect(result.failedPackages).toEqual([]);
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('exits 2 when any package fails verification', async () => {
    const verify = vi.fn(async (pkg: string) => pkg !== 'nonexistent-xyz-abc');
    const result = await runDependencyAuditGate({
      reaRoot: root,
      stdinOverride: payload('npm install lodash nonexistent-xyz-abc'),
      verifyPackage: verify,
    });
    expect(result.exitCode).toBe(2);
    expect(result.failedPackages).toEqual(['nonexistent-xyz-abc']);
    expect(result.stderr).toContain('Package not found on npm registry');
    expect(result.stderr).toContain('- nonexistent-xyz-abc');
  });

  it('caps verifications at 5 packages per command', async () => {
    const verify = vi.fn(async (_: string) => true);
    const result = await runDependencyAuditGate({
      reaRoot: root,
      stdinOverride: payload('npm install a b c d e f g h'),
      verifyPackage: verify,
    });
    expect(result.exitCode).toBe(0);
    expect(verify).toHaveBeenCalledTimes(__INTERNAL_MAX_PACKAGES_FOR_TESTS);
    expect(result.checkedPackages).toHaveLength(5);
  });

  it('does not refuse commit messages mentioning install', async () => {
    const result = await runDependencyAuditGate({
      reaRoot: root,
      stdinOverride: payload(`git commit -m "bump pnpm install logic"`),
      verifyPackage: ALWAYS_FAIL,
    });
    expect(result.exitCode).toBe(0);
  });

  it('handles env-prefixed install', async () => {
    const verify = vi.fn(async (_: string) => true);
    const result = await runDependencyAuditGate({
      reaRoot: root,
      stdinOverride: payload('CI=1 pnpm add @scope/pkg'),
      verifyPackage: verify,
    });
    expect(result.exitCode).toBe(0);
    expect(verify).toHaveBeenCalledWith('@scope/pkg');
  });
});

describe('INSTALL_PATTERN regex', () => {
  it('matches the basic install forms', () => {
    const re = __INTERNAL_INSTALL_PATTERN_FOR_TESTS;
    expect(re.test('npm install pkg')).toBe(true);
    expect(re.test('npm i pkg')).toBe(true);
    expect(re.test('npm add pkg')).toBe(true);
    expect(re.test('pnpm add pkg')).toBe(true);
    expect(re.test('pnpm install pkg')).toBe(true);
    expect(re.test('pnpm i pkg')).toBe(true);
    expect(re.test('yarn add pkg')).toBe(true);
  });

  it('does not match `npm ci` / `npm install` (no args)', () => {
    const re = __INTERNAL_INSTALL_PATTERN_FOR_TESTS;
    expect(re.test('npm ci')).toBe(false);
    // `npm install` alone (no trailing space + token) does NOT match
    // because the pattern requires `\s+` after the verb. `npm install`
    // followed by nothing would just be a refresh; we only care about
    // commands with arguments.
    expect(re.test('npm install')).toBe(false);
  });
});
