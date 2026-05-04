/**
 * 0.23.0 bash-scanner corpus — every PoC from helix-023 + discord-ops
 * Round 13 + every historical regression-positive from the 0.14.0 →
 * 0.22.0 cycle. The corpus is the contract: any future change to the
 * scanner that makes one of these flip silently is a hard regression.
 *
 * Run via `pnpm test`. The test invokes the scanner directly (no
 * subprocess shell-out) so it works on Alpine / GitHub Actions / any
 * CI without bash present in the matrix.
 */

import { describe, expect, it } from 'vitest';
import {
  runProtectedScan,
  runBlockedScan,
  type Verdict,
} from '../../../src/hooks/bash-scanner/index.js';

const REA_ROOT = process.cwd();

interface Fixture {
  cmd: string;
  expect: 'allow' | 'block';
  origin: string;
  notes?: string;
}

function p(cmd: string): Verdict {
  return runProtectedScan(
    {
      reaRoot: REA_ROOT,
      policy: { protected_paths_relax: [] },
      // No stderr in tests — keeps the suite output clean.
      stderr: () => {},
    },
    cmd,
  );
}

function b(
  cmd: string,
  blockedPaths: readonly string[] = ['.env', '.env.*', '.rea/HALT'],
): Verdict {
  return runBlockedScan({ reaRoot: REA_ROOT, blockedPaths }, cmd);
}

// ─────────────────────────────────────────────────────────────────────
//  helix-023: 6 active findings (all P1/P2 regressions in 0.22.0)
// ─────────────────────────────────────────────────────────────────────

const HELIX_023_PROTECTED: Fixture[] = [
  {
    cmd: 'node -e "fs.writeFileSync(\\".rea/HALT\\",\\"x\\")"',
    expect: 'block',
    origin: 'helix-023 F1',
    notes: 'backslash-escaped DQ around path — pre-0.23.0 regex consumed the backslash',
  },
  {
    cmd: "node -e \"require('fs').writeFileSync('.rea/HALT','x')\"",
    expect: 'block',
    origin: 'helix-023 F2a',
    notes: 'require-binding form — pre-0.23.0 regex required literal `fs.` prefix',
  },
  {
    cmd: "node -e \"let g=require('fs');g.writeFileSync('.rea/HALT','x')\"",
    expect: 'block',
    origin: 'helix-023 F2b',
    notes: 'rebound-fs binding — pre-0.23.0 regex required literal `fs.` prefix',
  },
  {
    cmd: 'tee >(cat > .rea/HALT) < /dev/null',
    expect: 'block',
    origin: 'helix-023 F3',
    notes: 'process substitution — pre-0.23.0 segmenter swallowed the inner redirect',
  },
  {
    cmd: 'awk -i inplace \'BEGIN{print "x"}\' .rea/HALT',
    expect: 'block',
    origin: 'helix-023 F4a',
  },
  {
    cmd: 'gawk -i inplace \'BEGIN{print "x"}\' .rea/HALT',
    expect: 'block',
    origin: 'helix-023 F4b',
  },
  {
    cmd: 'ex -s -c "1c|x" -c wq .rea/HALT',
    expect: 'block',
    origin: 'helix-023 F4c',
  },
  {
    cmd: 'ed .rea/HALT <<EOF\nw\nEOF',
    expect: 'block',
    origin: 'helix-023 F4d',
    notes: 'heredoc-driven',
  },
  {
    cmd: 'find . -maxdepth 1 -name notes -exec cp {} .rea/HALT \\;',
    expect: 'block',
    origin: 'helix-023 F5a',
  },
  {
    cmd: 'echo .rea/HALT | xargs touch',
    expect: 'block',
    origin: 'helix-023 F5b',
    notes: 'xargs-unresolvable — refused on uncertainty',
  },
  {
    cmd: 'cp srcfile .rea/HALT > /dev/null',
    expect: 'block',
    origin: 'helix-023 F6',
    notes: 'cp + redirect both — pre-0.23.0 if/elif short-circuited cp argv-walk',
  },
];

const DISCORD_OPS_R13: Fixture[] = [
  // R13 #1 — `$`-expansion fail-closed parity (was protected-only pre-0.23.0).
  {
    cmd: 'bash -c "echo > $TARGET"',
    expect: 'block',
    origin: 'R13 #1',
    notes: 'nested-shell with dynamic redirect target',
  },
  // R13 #2 — `cp -t` and friends.
  { cmd: 'cp -t .rea/ src', expect: 'block', origin: 'R13 #2a' },
  { cmd: 'cp --target-directory=.rea/ src', expect: 'block', origin: 'R13 #2b' },
  { cmd: 'cp --target-directory .rea/ src', expect: 'block', origin: 'R13 #2c' },
  { cmd: 'mv -t .rea/ src', expect: 'block', origin: 'R13 #2d' },
];

const DISCORD_OPS_R13_BLOCKED: Fixture[] = [
  // R13 #3: `-t` shapes against blocked-paths-bash-gate. `.env` from
  // default policy.
  { cmd: 'cp -t /tmp/ src && echo x > .env', expect: 'block', origin: 'R13 #3a' },
];

// ─────────────────────────────────────────────────────────────────────
//  Historical regression-positives — must still BLOCK
// ─────────────────────────────────────────────────────────────────────

const HISTORICAL_PROTECTED: Fixture[] = [
  // 0.15.0 BROAD_TARGETS / shell redirect kill-switch / truncate / tee
  { cmd: 'truncate -s 0 .rea/HALT', expect: 'block', origin: '0.15.0 truncate' },
  { cmd: 'tee .rea/HALT < /dev/null', expect: 'block', origin: '0.15.0 tee' },
  // 0.15.0 H1 unanchored / combined flags
  { cmd: 'cp -fR src .rea/HALT', expect: 'block', origin: '0.15.0 cp -fR' },
  // 0.16.0 `..` traversal
  { cmd: 'printf x > foo/../.rea/HALT', expect: 'block', origin: '0.16.0 dot-dot' },
  // 0.16.0 case-insensitive macOS
  { cmd: 'printf x > .REA/halt', expect: 'block', origin: '0.16.0 case-insensitive' },
  // 0.16.0 redirect variants
  { cmd: 'echo x >| .rea/HALT', expect: 'block', origin: '0.16.0 >|' },
  { cmd: 'echo x &> .rea/HALT', expect: 'block', origin: '0.16.0 &>' },
  { cmd: 'echo x &>> .rea/HALT', expect: 'block', origin: '0.16.0 &>>' },
  { cmd: 'echo x 2> .rea/HALT', expect: 'block', origin: '0.16.0 2>' },
  { cmd: 'echo x 1> .rea/HALT', expect: 'block', origin: '0.16.0 1>' },
  { cmd: 'echo x 9> .rea/HALT', expect: 'block', origin: '0.16.0 fd-prefix' },
  // 0.17.0 nested-shell unwrap
  { cmd: "bash -c 'printf x > .rea/HALT'", expect: 'block', origin: '0.17.0 nested-shell' },
  // 0.21.0 macOS /var ↔ /private/var symlink canonicalization — verified
  // implicitly by the resolveSymlinksWalkUp realpath logic.
  // 0.22.0 helix-022 #3 recursive nested-shell
  {
    cmd: 'bash -c "bash -c \\"printf x > .rea/HALT\\""',
    expect: 'block',
    origin: '0.22.0 nested-2',
  },
  {
    cmd: 'bash -c "bash -c \'bash -c \\"printf x > .rea/HALT\\"\'"',
    expect: 'block',
    origin: '0.22.0 nested-3',
  },
  // 0.22.0 #5 unresolved expansion
  { cmd: 'printf x > "$TARGET"', expect: 'block', origin: '0.22.0 expansion' },
  { cmd: 'printf x > `cat path`', expect: 'block', origin: '0.22.0 backtick-expansion' },
];

// ─────────────────────────────────────────────────────────────────────
//  Negative fixtures — must NOT block (over-correction protection)
// ─────────────────────────────────────────────────────────────────────

const NEGATIVE_PROTECTED: Fixture[] = [
  {
    cmd: 'git commit -m "docs: mention bash -c npm install left-pad"',
    expect: 'allow',
    origin: 'NEG: literal bash mention in commit msg',
  },
  {
    cmd: 'git commit -m "fix: handle > redirect in foo()"',
    expect: 'allow',
    origin: 'NEG: literal > in commit msg',
  },
  {
    cmd: 'gh pr create --body-file path.md',
    expect: 'allow',
    origin: 'NEG: --body-file unprotected path',
  },
  {
    cmd: 'cat .env.sample',
    expect: 'allow',
    origin: 'NEG: read sample file (env-file-protection scope)',
  },
  {
    cmd: "find . -name '.rea/HALT-template'",
    expect: 'allow',
    origin: 'NEG: substring of protected pattern, no write',
  },
  {
    cmd: "echo \"fs.writeFileSync('.rea/HALT', 'x')\" > /tmp/note",
    expect: 'allow',
    origin: 'NEG: literal-string mention in echo body, target /tmp',
  },
  {
    cmd: 'cp .rea/HALT.txt /tmp/',
    expect: 'allow',
    origin: 'NEG: read FROM .rea, write TO /tmp',
  },
  {
    cmd: 'node -e "console.log(\\"hello\\")"',
    expect: 'allow',
    origin: 'NEG: node -e with no write methods',
  },
  {
    cmd: 'python -c "print(\\"hello\\")"',
    expect: 'allow',
    origin: 'NEG: python -c with no open-with-write',
  },
  {
    cmd: 'awk \'BEGIN{print "x"}\' file.txt',
    expect: 'allow',
    origin: 'NEG: awk without -i inplace',
  },
  {
    cmd: 'gh pr create --body "...code with backticks..."',
    expect: 'allow',
    origin: "NEG: backticks in PR body shouldn't fail-closed",
  },
];

// ─────────────────────────────────────────────────────────────────────
//  Parser-failure fixtures — must always BLOCK
// ─────────────────────────────────────────────────────────────────────

const PARSE_FAILURE: Fixture[] = [
  {
    cmd: 'echo "unterminated quote',
    expect: 'block',
    origin: 'parse-fail: unterminated DQ',
  },
  {
    cmd: 'echo `unterminated backtick',
    expect: 'block',
    origin: 'parse-fail: unterminated backtick',
  },
];

// ─────────────────────────────────────────────────────────────────────
//  Test runners
// ─────────────────────────────────────────────────────────────────────

describe('helix-023 — 11 active findings (protected-paths-bash-gate)', () => {
  for (const f of HELIX_023_PROTECTED) {
    it(`${f.origin}: ${f.notes ?? f.cmd.slice(0, 80)}`, () => {
      const v = p(f.cmd);
      expect(v.verdict).toBe(f.expect);
    });
  }
});

describe('discord-ops Round 13 — 5 protected, 1 blocked', () => {
  for (const f of DISCORD_OPS_R13) {
    it(`${f.origin}: ${f.notes ?? f.cmd.slice(0, 80)}`, () => {
      const v = p(f.cmd);
      expect(v.verdict).toBe(f.expect);
    });
  }
  for (const f of DISCORD_OPS_R13_BLOCKED) {
    it(`${f.origin} (blocked-mode): ${f.cmd.slice(0, 80)}`, () => {
      const v = b(f.cmd);
      expect(v.verdict).toBe(f.expect);
    });
  }
});

describe('historical regression-positives — must still block', () => {
  for (const f of HISTORICAL_PROTECTED) {
    it(`${f.origin}: ${f.notes ?? f.cmd.slice(0, 80)}`, () => {
      const v = p(f.cmd);
      expect(v.verdict).toBe(f.expect);
    });
  }
});

describe('regression-negatives — must NOT block', () => {
  for (const f of NEGATIVE_PROTECTED) {
    it(`${f.origin}: ${f.notes ?? f.cmd.slice(0, 80)}`, () => {
      const v = p(f.cmd);
      if (v.verdict !== f.expect) {
        // Surface the reason in the diff for fast triage.
        throw new Error(
          `expected ${f.expect}, got ${v.verdict}. reason: ${v.reason ?? '(none)'}\ncmd: ${f.cmd}`,
        );
      }
      expect(v.verdict).toBe(f.expect);
    });
  }
});

describe('parser-failure fail-closed contract', () => {
  for (const f of PARSE_FAILURE) {
    it(`${f.origin}: ${f.cmd.slice(0, 80)}`, () => {
      const v = p(f.cmd);
      expect(v.verdict).toBe('block');
      expect(v.parse_failure_reason).toBeDefined();
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
//  Blocked-mode coverage
// ─────────────────────────────────────────────────────────────────────

describe('blocked_paths — Bash-tier coverage parity', () => {
  it('blocks `echo x > .env`', () => {
    expect(b('echo x > .env').verdict).toBe('block');
  });
  it('blocks `cp src.txt .env`', () => {
    expect(b('cp src.txt .env').verdict).toBe('block');
  });
  it("blocks node -e fs.writeFileSync('.env', ...)", () => {
    expect(b("node -e \"fs.writeFileSync('.env','x')\"").verdict).toBe('block');
  });
  it("blocks `sed -i '' '1d' .env.production` via glob", () => {
    expect(b("sed -i '' '1d' .env.production").verdict).toBe('block');
  });
  it('blocks `echo x > .env.local` via glob', () => {
    expect(b('echo x > .env.local').verdict).toBe('block');
  });
  it('allows reads of .env (env-file-protection scope, not this hook)', () => {
    expect(b('cat .env').verdict).toBe('allow');
  });
  it('no-ops when blocked_paths is empty', () => {
    const v = runBlockedScan({ reaRoot: REA_ROOT, blockedPaths: [] }, 'echo x > .env');
    expect(v.verdict).toBe('allow');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Fuzz / property layer — generated fixtures
// ─────────────────────────────────────────────────────────────────────

describe('fuzz: detected-write shape × wrapper × quote → expected verdict', () => {
  /**
   * Each of these target-shapes WRITES to .rea/HALT. We wrap them in
   * every permutation of:
   *   - bash -c '...'   bash -c "..."
   *   - sudo (must NOT change verdict)
   *   - nohup, time, env (modifier wrappers)
   *
   * Every variant must BLOCK.
   */
  const TARGET_SHAPES = [
    'printf x > .rea/HALT',
    'printf x >> .rea/HALT',
    'printf x >| .rea/HALT',
    'echo x &> .rea/HALT',
    'cp src .rea/HALT',
    'mv src .rea/HALT',
    'tee .rea/HALT < /dev/null',
    'truncate -s 0 .rea/HALT',
    'install -m 644 src .rea/HALT',
    'ln -s src .rea/HALT',
    'sed -i "" "s/x/y/" .rea/HALT',
    'dd of=.rea/HALT',
  ];
  const WRAPPERS = [
    (s: string) => s,
    (s: string) => `sudo ${s}`,
    (s: string) => `nohup ${s}`,
    (s: string) => `time ${s}`,
    (s: string) => `env FOO=bar ${s}`,
    (s: string) => `bash -c '${s.replace(/'/g, "'\\''")}'`,
    (s: string) => `bash -c "${s.replace(/"/g, '\\"')}"`,
  ];

  for (const target of TARGET_SHAPES) {
    for (const wrap of WRAPPERS) {
      const wrapped = wrap(target);
      it(`BLOCK: ${wrapped.slice(0, 80)}`, () => {
        const v = p(wrapped);
        if (v.verdict !== 'block') {
          throw new Error(`expected block, got allow.\ncmd: ${wrapped}\nshape: ${target}`);
        }
        expect(v.verdict).toBe('block');
      });
    }
  }
});
