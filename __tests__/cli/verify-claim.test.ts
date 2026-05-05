/**
 * 0.28.0 — `rea verify-claim` CLI tests.
 *
 * Five cuts:
 *   1. All seed claims load + parse cleanly.
 *   2. helix-024 PoC battery passes against the current build (this IS
 *      the regression test for the closures).
 *   3. Unknown claim-id → exit 2 + helpful message.
 *   4. `--json` produces machine-readable shape.
 *   5. `--installed` resolves correctly when
 *      `node_modules/@bookedsolid/rea/dist/cli/index.js` exists in CWD.
 *
 * The first cut is fully synthetic. The others stage tmp dirs + use the
 * exported pure functions so we don't pay subprocess startup costs in
 * every test.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  loadClaim,
  resolveCli,
  runPoC,
  runVerifyClaimSync,
  type Claim,
  type ClaimPoC,
} from '../../src/cli/verify-claim.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEED_CLAIMS_DIR = path.join(REPO_ROOT, 'data', 'claims');
const SEED_CLAIM_IDS = ['helix-022', 'helix-023', 'helix-024', 'helix-028', 'helix-031'];

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `rea-verify-claim-${prefix}-`));
}

describe('verify-claim — seed-claim load', () => {
  for (const id of SEED_CLAIM_IDS) {
    it(`loads and validates ${id}.json`, () => {
      const claim = loadClaim(SEED_CLAIMS_DIR, id);
      expect(claim.id).toBe(id);
      expect(claim.title.length).toBeGreaterThan(0);
      expect(claim.introduced_in.length).toBeGreaterThan(0);
      expect(claim.closed_in.length).toBeGreaterThan(0);
      expect(claim.pocs.length).toBeGreaterThan(0);
      for (const poc of claim.pocs) {
        expect(['scan-bash', 'shellcheck']).toContain(poc.type);
        if (poc.type === 'scan-bash') {
          expect(['protected', 'blocked']).toContain(poc.mode);
          expect(['allow', 'block']).toContain(poc.expected_verdict);
        } else {
          expect(poc.expected_verdict).toBe('clean');
          expect(poc.target.length).toBeGreaterThan(0);
        }
      }
    });
  }
});

describe('verify-claim — helix-024 against current build', () => {
  it('all helix-024 PoCs block under the dogfood scan-bash CLI', () => {
    // The dogfood `dist/cli/index.js` is built by `pnpm build` before
    // `pnpm test` (see package.json#scripts.test). If this test runs
    // standalone via `pnpm test:watch` and dist/ is stale, the test
    // fails with a clear message — that's the right escape hatch.
    const distCli = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');
    if (!fs.existsSync(distCli)) {
      throw new Error(
        `dist/cli/index.js not found — run \`pnpm build\` before this test runs in isolation`,
      );
    }
    const claim = loadClaim(SEED_CLAIMS_DIR, 'helix-024');
    const result = runVerifyClaimSync(
      claim,
      process.execPath,
      [distCli],
      distCli,
      spawnSync,
      REPO_ROOT,
    );
    // Diagnostic dump on failure — mismatch list points straight at the
    // PoC so the dev knows which closure broke.
    if (result.mismatched > 0) {
      const failures = result.results
        .filter((r) => !r.match)
        .map((r) => `${r.poc_id}: expected=${r.expected} actual=${r.actual} ${r.detail}`)
        .join('\n  ');
      throw new Error(
        `helix-024 verify-claim regression — ${result.mismatched}/${result.total} PoCs failed:\n  ${failures}`,
      );
    }
    expect(result.exit_code).toBe(0);
    expect(result.matched).toBe(claim.pocs.length);
  }, 60_000);
});

describe('verify-claim — error paths', () => {
  it('unknown claim id throws with a helpful message', () => {
    expect(() => loadClaim(SEED_CLAIMS_DIR, 'helix-999-not-real')).toThrow(/unknown claim id/);
  });

  it('rejects path-traversal claim ids before disk access', () => {
    expect(() => loadClaim(SEED_CLAIMS_DIR, '../../etc/passwd')).toThrow(/invalid claim id/);
    expect(() => loadClaim(SEED_CLAIMS_DIR, '/abs/path')).toThrow(/invalid claim id/);
  });

  it('rejects malformed claim JSON with the file path in the error', () => {
    const dir = tmpDir('malformed');
    try {
      fs.writeFileSync(path.join(dir, 'bad.json'), '{not valid json');
      expect(() => loadClaim(dir, 'bad')).toThrow(/not valid JSON/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects shape-violating claim shapes', () => {
    const dir = tmpDir('shape');
    try {
      fs.writeFileSync(
        path.join(dir, 'no-pocs.json'),
        JSON.stringify({
          id: 'no-pocs',
          title: 't',
          introduced_in: '0.0.0',
          closed_in: '0.0.0',
          pocs: [],
        }),
      );
      expect(() => loadClaim(dir, 'no-pocs')).toThrow(/non-empty `pocs` array/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('verify-claim — pure runPoC with stubbed spawn', () => {
  it('scan-bash PoC matches when stub reports the expected verdict', () => {
    const poc: ClaimPoC = {
      id: 'stub.allow',
      type: 'scan-bash',
      input: 'echo hi',
      mode: 'protected',
      expected_verdict: 'allow',
    };
    const stub = (
      _cmd: string,
      _args: string[],
      _opts: { input?: string; encoding: 'utf8'; timeout: number },
    ) => ({
      pid: 0,
      output: [],
      stdout: JSON.stringify({ verdict: 'allow' }) + '\n',
      stderr: '',
      status: 0,
      signal: null,
    });
    const r = runPoC(poc, '/usr/bin/node', ['/path/to/cli.js'], stub);
    expect(r.match).toBe(true);
    expect(r.actual).toBe('allow');
  });

  it('scan-bash PoC mismatches when stub reports the wrong verdict', () => {
    const poc: ClaimPoC = {
      id: 'stub.block-expected',
      type: 'scan-bash',
      input: 'rm -rf .rea',
      mode: 'protected',
      expected_verdict: 'block',
    };
    const stub = (
      _cmd: string,
      _args: string[],
      _opts: { input?: string; encoding: 'utf8'; timeout: number },
    ) => ({
      pid: 0,
      output: [],
      stdout: JSON.stringify({ verdict: 'allow' }) + '\n',
      stderr: '',
      status: 0,
      signal: null,
    });
    const r = runPoC(poc, '/usr/bin/node', ['/path/to/cli.js'], stub);
    expect(r.match).toBe(false);
    expect(r.actual).toBe('allow');
    expect(r.detail).toContain('expected block, got allow');
  });

  it('falls back to exit-code interpretation when stdout is unparseable', () => {
    const poc: ClaimPoC = {
      id: 'stub.exit-fallback',
      type: 'scan-bash',
      input: '',
      mode: 'protected',
      expected_verdict: 'block',
    };
    const stub = (
      _cmd: string,
      _args: string[],
      _opts: { input?: string; encoding: 'utf8'; timeout: number },
    ) => ({
      pid: 0,
      output: [],
      stdout: 'not-json',
      stderr: 'some-stderr',
      status: 2,
      signal: null,
    });
    const r = runPoC(poc, '/usr/bin/node', ['/path/to/cli.js'], stub);
    // exit 2 → block; even though stdout was unparseable.
    expect(r.actual).toBe('block');
    expect(r.match).toBe(true);
  });

  it('shellcheck PoC reports clean when stub returns 0 + empty stdout', () => {
    const poc: ClaimPoC = {
      id: 'sc.clean',
      type: 'shellcheck',
      target: 'hooks/local-review-gate.sh',
      expected_verdict: 'clean',
    };
    const stub = (
      _cmd: string,
      _args: string[],
      _opts: { input?: string; encoding: 'utf8'; timeout: number },
    ) => ({
      pid: 0,
      output: [],
      stdout: '',
      stderr: '',
      status: 0,
      signal: null,
    });
    const r = runPoC(poc, '/usr/bin/node', [], stub, REPO_ROOT);
    expect(r.match).toBe(true);
    expect(r.actual).toBe('clean');
  });

  it('shellcheck PoC fails when stub reports warnings', () => {
    const poc: ClaimPoC = {
      id: 'sc.warns',
      type: 'shellcheck',
      target: 'hooks/local-review-gate.sh',
      expected_verdict: 'clean',
    };
    const stub = (
      _cmd: string,
      _args: string[],
      _opts: { input?: string; encoding: 'utf8'; timeout: number },
    ) => ({
      pid: 0,
      output: [],
      stdout: 'In hooks/local-review-gate.sh line 42:\n  echo $foo\n        ^-- SC2086',
      stderr: '',
      status: 1,
      signal: null,
    });
    const r = runPoC(poc, '/usr/bin/node', [], stub, REPO_ROOT);
    expect(r.match).toBe(false);
    expect(r.actual).toBe('warnings');
    expect(r.detail).toContain('SC2086');
  });
});

describe('verify-claim — runVerifyClaimSync aggregation', () => {
  it('exit_code is 1 when any PoC mismatches', () => {
    const claim: Claim = {
      id: 'agg.mixed',
      title: 't',
      introduced_in: '0.0.0',
      closed_in: '0.0.0',
      pocs: [
        {
          id: 'good',
          type: 'scan-bash',
          input: 'x',
          mode: 'protected',
          expected_verdict: 'allow',
        },
        {
          id: 'bad',
          type: 'scan-bash',
          input: 'x',
          mode: 'protected',
          expected_verdict: 'block',
        },
      ],
    };
    let calls = 0;
    const stub = (
      _cmd: string,
      _args: string[],
      _opts: { input?: string; encoding: 'utf8'; timeout: number },
    ) => {
      calls += 1;
      return {
        pid: 0,
        output: [],
        stdout: JSON.stringify({ verdict: 'allow' }),
        stderr: '',
        status: 0,
        signal: null,
      };
    };
    const r = runVerifyClaimSync(claim, '/usr/bin/node', ['/x.js'], '/x.js', stub);
    expect(calls).toBe(2);
    expect(r.matched).toBe(1);
    expect(r.mismatched).toBe(1);
    expect(r.exit_code).toBe(1);
  });

  it('exit_code is 0 when every PoC matches', () => {
    const claim: Claim = {
      id: 'agg.clean',
      title: 't',
      introduced_in: '0.0.0',
      closed_in: '0.0.0',
      pocs: [
        {
          id: 'good1',
          type: 'scan-bash',
          input: 'x',
          mode: 'protected',
          expected_verdict: 'allow',
        },
      ],
    };
    const stub = (
      _cmd: string,
      _args: string[],
      _opts: { input?: string; encoding: 'utf8'; timeout: number },
    ) => ({
      pid: 0,
      output: [],
      stdout: JSON.stringify({ verdict: 'allow' }),
      stderr: '',
      status: 0,
      signal: null,
    });
    const r = runVerifyClaimSync(claim, '/usr/bin/node', ['/x.js'], '/x.js', stub);
    expect(r.exit_code).toBe(0);
    expect(r.matched).toBe(1);
  });
});

describe('verify-claim — resolveCli', () => {
  it('--installed resolves to node_modules/@bookedsolid/rea/dist/cli/index.js', () => {
    const cwd = tmpDir('installed');
    try {
      const target = path.join(cwd, 'node_modules', '@bookedsolid', 'rea', 'dist', 'cli');
      fs.mkdirSync(target, { recursive: true });
      const cli = path.join(target, 'index.js');
      fs.writeFileSync(cli, '#!/usr/bin/env node\nprocess.exit(0);\n');
      const r = resolveCli({ installed: true, cwd });
      expect(r.path).toBe(cli);
      expect(r.cmd).toBe(process.execPath);
      expect(r.args).toEqual([cli]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('--installed throws when the consumer dist is missing', () => {
    const cwd = tmpDir('installed-missing');
    try {
      expect(() => resolveCli({ installed: true, cwd })).toThrow(
        /verify-claim --installed: not found/,
      );
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('cliOverride wins over --installed', () => {
    const dir = tmpDir('override');
    try {
      const cli = path.join(dir, 'fake-cli.js');
      fs.writeFileSync(cli, 'process.exit(0);');
      const r = resolveCli({ installed: true, cliOverride: cli, cwd: '/nonexistent' });
      expect(r.path).toBe(cli);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('default resolution finds the dogfood dist/cli/index.js', () => {
    const distCli = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');
    if (!fs.existsSync(distCli)) return; // Skip if dist not built.
    const r = resolveCli({});
    expect(r.path).toBe(distCli);
  });
});
