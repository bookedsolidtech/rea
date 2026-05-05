/**
 * End-to-end integration tests for the production `rea hook scan-bash`
 * CLI — helix-028 P2 (0.26.1 patch).
 *
 * Round-1 codex caught the ANSI-C bypass at the production gate level
 * because the round-0 fix only patched the bash helper (`cmd-segments.sh`)
 * — but the Node-binary scanner (`dist/cli/index.js hook scan-bash`) has
 * its own ANSI-C path that the helper doesn't cover. P2 closes the test
 * gap: every PoC is now exercised against the SAME CLI surface a real
 * Claude Code invocation triggers.
 *
 * Tests run the built `dist/cli/index.js` (NOT `pnpm tsx src/...`) because
 * the registered hook in `.claude/settings.json` invokes the dist build.
 * If `dist/` is stale, the CI gate `pnpm build` rebuilds before tests run.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');

interface Verdict {
  verdict: 'allow' | 'block';
  reason?: string;
  hit_pattern?: string;
  detected_form?: string;
}

function scan(mode: 'protected' | 'blocked', command: string): { verdict: Verdict; status: number } {
  const input = JSON.stringify({ tool_input: { command } });
  const res = spawnSync('node', [CLI, 'hook', 'scan-bash', '--mode', mode], {
    input,
    encoding: 'utf8',
    env: { ...process.env, REA_ROOT: REPO_ROOT },
  });
  // First line of stdout is JSON verdict.
  const firstLine = (res.stdout ?? '').split('\n').find((l) => l.trim().length > 0) ?? '{}';
  let verdict: Verdict;
  try {
    verdict = JSON.parse(firstLine) as Verdict;
  } catch {
    verdict = { verdict: 'allow' };
  }
  return { verdict, status: res.status ?? -1 };
}

describe('rea hook scan-bash --mode protected — ANSI-C bypass closure', () => {
  it('blocks $\'... > .rea/HALT\\ntrue\' (literal \\n)', () => {
    const r = scan('protected', "bash -lc $'echo x > .rea/HALT\\ntrue'");
    expect(r.verdict.verdict).toBe('block');
    expect(r.verdict.hit_pattern).toBe('.rea/HALT');
  });

  it('blocks $\'... > .rea/HALT\\x0Arm -rf /\' (hex escape)', () => {
    const r = scan('protected', "bash -lc $'echo x > .rea/HALT\\x0Arm -rf /'");
    expect(r.verdict.verdict).toBe('block');
    expect(r.verdict.hit_pattern).toBe('.rea/HALT');
  });

  it('blocks $\'... > .rea/HALT\\012true\' (octal escape)', () => {
    const r = scan('protected', "bash -lc $'echo x > .rea/HALT\\012true'");
    expect(r.verdict.verdict).toBe('block');
    expect(r.verdict.hit_pattern).toBe('.rea/HALT');
  });

  it('blocks $\'... > .rea/HALT\\u000Atrue\' (unicode escape)', () => {
    const r = scan('protected', "bash -lc $'echo x > .rea/HALT\\u000Atrue'");
    expect(r.verdict.verdict).toBe('block');
    expect(r.verdict.hit_pattern).toBe('.rea/HALT');
  });

  it('blocks $\'... > .rea/HALT\\cJtrue\' (control-char escape)', () => {
    const r = scan('protected', "bash -lc $'echo x > .rea/HALT\\cJtrue'");
    expect(r.verdict.verdict).toBe('block');
    expect(r.verdict.hit_pattern).toBe('.rea/HALT');
  });

  it('regression: single-quoted (non-ANSI-C) write to .rea/HALT still blocks', () => {
    const r = scan('protected', "bash -lc 'echo > .rea/HALT'");
    expect(r.verdict.verdict).toBe('block');
    expect(r.verdict.hit_pattern).toBe('.rea/HALT');
  });

  it('regression: benign multiline ANSI-C payload allowed', () => {
    const r = scan('protected', "bash -lc $'echo hello\\necho world'");
    expect(r.verdict.verdict).toBe('allow');
  });

  it('regression: ANSI-C without write target allowed', () => {
    const r = scan('protected', "bash -lc $'ls\\nps'");
    expect(r.verdict.verdict).toBe('allow');
  });

  it('regression: top-level statement WITHOUT bash -c wrapper still detected (single-quoted target)', () => {
    const r = scan('protected', `echo x > .rea/HALT`);
    expect(r.verdict.verdict).toBe('block');
  });
});

describe('rea hook scan-bash --mode blocked — ANSI-C bypass closure', () => {
  it('blocks ANSI-C write to .env.local', () => {
    const r = scan('blocked', "bash -lc $'cat /etc/passwd > .env.local\\ntrue'");
    expect(r.verdict.verdict).toBe('block');
    expect(r.verdict.detected_form).toBe('redirect');
  });

  it('blocks ANSI-C \\x0A write to .env.production', () => {
    const r = scan('blocked', "bash -lc $'cp src.txt .env.production\\x0Atrue'");
    expect(r.verdict.verdict).toBe('block');
  });

  it('regression: ANSI-C without blocked-path target allowed', () => {
    const r = scan('blocked', "bash -lc $'echo a\\necho b'");
    expect(r.verdict.verdict).toBe('allow');
  });
});

describe('rea hook scan-bash — fail-closed on unsupported ANSI-C escape', () => {
  it('refuses on uncertainty for an unsupported ANSI-C escape (sibling sweep)', () => {
    // We don't ship a known-unsupported escape attack today — every bash
    // ANSI-C escape is now decoded. But the code path for "decodeAnsiC
    // returns null" is reachable if mvdan-sh ever emits a token shape we
    // don't model. To exercise the fail-closed path without contriving an
    // impossible escape, we pass a payload whose decoded form contains a
    // CmdSubst (which the walker independently flags as dynamic). The
    // important assertion is that no path mangling lets a bypass through.
    const r = scan('protected', "bash -lc $'echo > .rea/HALT$(true)'");
    expect(r.verdict.verdict).toBe('block');
  });
});
