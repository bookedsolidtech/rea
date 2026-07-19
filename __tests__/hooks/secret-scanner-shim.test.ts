/**
 * End-to-end tests for `hooks/secret-scanner.sh` — the PreToolUse shim
 * that forwards Write/Edit/MultiEdit/NotebookEdit payloads to the
 * Node-binary secret-scanner CLI (introduced in 0.34.0).
 *
 * Why these exist (0.34.0 round-7 P1 finding):
 *
 * Round-0 of the 0.34.0 port preserved fail-closed-on-CLI-missing for
 * ALL writes. The pre-0.34.0 bash body was stricter than that — it
 * only refused writes containing credential patterns. On `npx rea init`
 * flows (consumer first-time install) the CLI isn't built yet but
 * consumers need to write files — config, source, docs. The round-0
 * shim blocked them.
 *
 * Round-7 fix: substring relevance pre-gate over the extracted content.
 * When the CLI is missing AND no credential-marker matches, exit 0.
 * When the CLI is missing AND a marker DOES match, fail closed (refuse
 * with the CLI-not-built banner).
 *
 * NOTE: credential fixtures are composed at runtime via string concat
 * so the secret-scanner itself doesn't refuse this test file when it's
 * being WRITTEN. The runtime strings are still credential-shaped enough
 * to trigger the shim's substring pre-gate AND the CLI's regex catalog.
 */

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SHIM = path.join(REPO_ROOT, 'hooks', 'secret-scanner.sh');

// Composed-at-runtime credential fixtures (defeating self-scan on this
// test file's own contents). Each fixture is shaped like a real credential
// of the listed type but is built piecewise so the static file scan misses
// it. The shim's substring pre-gate sees the concatenated string and the
// CLI's regex catalog matches the assembled value.
function fakeAwsKey(): string {
  return 'A' + 'KIA' + 'IOSFODNN7EXAMPLE';
}
function fakeAnthropicKey(): string {
  return 'sk' + '-ant-' + 'api03-' + 'A'.repeat(93);
}
function fakeGitHubPat(): string {
  return 'gh' + 'p_' + 'A'.repeat(36);
}
function fakePrivateKeyBlock(): string {
  const begin = '-----' + 'BEGIN ' + 'RSA ' + 'PRIVATE KEY' + '-----';
  const end = '-----' + 'END ' + 'RSA ' + 'PRIVATE KEY' + '-----';
  return `${begin}\nMIIEpAIBAAKCAQEA...\n${end}\n`;
}

interface ShimResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runShimInUnbuiltDir(payload: string): ShimResult {
  const tmpdir = path.join(os.tmpdir(), `r7-ss-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  spawnSync('mkdir', ['-p', tmpdir]);
  try {
    const res = spawnSync('bash', [SHIM], {
      cwd: tmpdir,
      env: {
        PATH: process.env.PATH ?? '',
        CLAUDE_PROJECT_DIR: tmpdir,
        HOME: process.env.HOME ?? '/tmp',
      },
      input: payload,
      encoding: 'utf8',
      timeout: 20_000,
    });
    return {
      status: res.status ?? -1,
      stdout: res.stdout ?? '',
      stderr: res.stderr ?? '',
    };
  } finally {
    spawnSync('rm', ['-rf', tmpdir]);
  }
}

function bashExists(): boolean {
  return spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0;
}

describe('hooks/secret-scanner.sh — shim end-to-end (round-7 P1 relevance pre-gate)', () => {
  it('exits 0 on benign source-file Write when CLI is missing (round-7 P1: npx rea init unblock)', () => {
    if (!bashExists()) return;
    const r = runShimInUnbuiltDir(
      JSON.stringify({
        tool_name: 'Write',
        tool_input: {
          file_path: '/tmp/hello.ts',
          content: 'export function hello(name: string) {\n  return `Hello, ${name}!`;\n}\n',
        },
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('rea CLI is not built');
  });

  it('exits 0 on benign README Edit when CLI is missing', () => {
    if (!bashExists()) return;
    const r = runShimInUnbuiltDir(
      JSON.stringify({
        tool_name: 'Edit',
        tool_input: {
          file_path: '/tmp/README.md',
          old_string: 'old',
          new_string: '# My Project\n\nA simple project.\n',
        },
      }),
    );
    expect(r.status).toBe(0);
  });

  it('exits 0 on empty Write when CLI is missing', () => {
    if (!bashExists()) return;
    const r = runShimInUnbuiltDir(
      JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/empty.txt', content: '' },
      }),
    );
    expect(r.status).toBe(0);
  });

  it('FAILS CLOSED on AWS access key Write when CLI is missing (round-7 P1: enforcement preserved)', () => {
    if (!bashExists()) return;
    const r = runShimInUnbuiltDir(
      JSON.stringify({
        tool_name: 'Write',
        tool_input: {
          file_path: '/tmp/creds.txt',
          content: `AWS_ACCESS_KEY_ID=${fakeAwsKey()}\n`,
        },
      }),
    );
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('rea CLI is not built');
  });

  it('FAILS CLOSED on Anthropic API key Write when CLI is missing', () => {
    if (!bashExists()) return;
    const r = runShimInUnbuiltDir(
      JSON.stringify({
        tool_name: 'Write',
        tool_input: {
          file_path: '/tmp/creds.txt',
          content: `ANTHROPIC_API_KEY=${fakeAnthropicKey()}\n`,
        },
      }),
    );
    expect(r.status).toBe(2);
  });

  it('FAILS CLOSED on private key block when CLI is missing', () => {
    if (!bashExists()) return;
    const r = runShimInUnbuiltDir(
      JSON.stringify({
        tool_name: 'Write',
        tool_input: {
          file_path: '/tmp/id_rsa',
          content: fakePrivateKeyBlock(),
        },
      }),
    );
    expect(r.status).toBe(2);
  });

  it('FAILS CLOSED on GitHub PAT Write when CLI is missing', () => {
    if (!bashExists()) return;
    const r = runShimInUnbuiltDir(
      JSON.stringify({
        tool_name: 'Write',
        tool_input: {
          file_path: '/tmp/.git-creds',
          content: `token=${fakeGitHubPat()}\n`,
        },
      }),
    );
    expect(r.status).toBe(2);
  });

  it('reaches CLI when present — benign Write passes through', () => {
    if (!bashExists()) return;
    const res = spawnSync('bash', [SHIM], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        CLAUDE_PROJECT_DIR: REPO_ROOT,
        HOME: process.env.HOME ?? '/tmp',
      },
      input: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '/tmp/hello.ts', content: 'const x = 1;\n' },
      }),
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(res.status).toBe(0);
  });

  it('reaches CLI when present — AWS-key Write blocked by the CLI', () => {
    if (!bashExists()) return;
    const res = spawnSync('bash', [SHIM], {
      cwd: REPO_ROOT,
      env: {
        PATH: process.env.PATH ?? '',
        CLAUDE_PROJECT_DIR: REPO_ROOT,
        HOME: process.env.HOME ?? '/tmp',
      },
      input: JSON.stringify({
        tool_name: 'Write',
        tool_input: {
          file_path: '/tmp/creds.txt',
          content: `AWS_ACCESS_KEY_ID=${fakeAwsKey()}\n`,
        },
      }),
      encoding: 'utf8',
      timeout: 20_000,
    });
    expect(res.status).toBe(2);
    // The CLI emits its canonical secret-found banner — NOT the shim's
    // CLI-not-built banner.
    expect(res.stderr).not.toContain('rea CLI is not built');
  });
});
