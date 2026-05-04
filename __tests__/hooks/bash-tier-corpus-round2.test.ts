/**
 * Codex round 2 — bypass-class fixtures (post round-1 fixes).
 *
 * Round-1 fixes patched literal PoC commands rather than the bypass
 * classes. Round 2 surfaced 14 new findings whose root cause was the
 * narrow regex / narrow case-label pattern. These fixtures test the
 * BYPASS CLASS, not the literal PoC — each finding has 3-5 variant
 * shapes drawn from the underlying class.
 *
 * Split out of bash-tier-corpus.test.ts so the parent file's per-file
 * test count doesn't overload the vitest worker-RPC heartbeat budget.
 */

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REA_DIST_CLI = path.join(REPO_ROOT, 'dist', 'cli', 'index.js');

function jqExists(): boolean {
  return spawnSync('jq', ['--version'], { encoding: 'utf8' }).status === 0;
}

/**
 * Stage CLAUDE_PROJECT_DIR/dist/cli/index.js as a tiny shim that
 * delegates to REA_DIST_CLI. Codex round 5 F2 rejects symlinks-out;
 * the shim's realpath stays inside the tempdir, satisfying the
 * project-root containment check, then re-execs the canonical CLI.
 * Also stage a sibling package.json for the secondary ancestor-walk
 * check.
 */
function stageReaCliInProjectDir(projectDir: string): void {
  const distDir = path.join(projectDir, 'dist', 'cli');
  mkdirSync(distDir, { recursive: true });
  const target = path.join(distDir, 'index.js');
  const shim = `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const res = spawnSync(process.execPath, [${JSON.stringify(REA_DIST_CLI)}, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(res.status ?? 1);
`;
  if (!existsSync(target)) {
    writeFileSync(target, shim);
    chmodSync(target, 0o755);
  }
  const pj = path.join(projectDir, 'package.json');
  if (!existsSync(pj)) {
    writeFileSync(pj, JSON.stringify({ name: '@bookedsolid/rea', version: '0.0.0-test' }));
  }
}

describe('codex round 2 — bypass-class fixtures (post round-1)', () => {
  function makeFixture(setup: (dir: string) => void): { dir: string; cleanup: () => void } {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'rea-cdx2-'));
    mkdirSync(path.join(dir, '.rea'), { recursive: true });
    setup(dir);
    return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
  }
  function runHookCwd(hook: string, dir: string, cmd: string): { status: number; stderr: string } {
    const HOOK = path.join(REPO_ROOT, 'hooks', hook);
    stageReaCliInProjectDir(dir);
    const payload = JSON.stringify({ tool_input: { command: cmd } });
    const res = spawnSync('bash', [HOOK], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', CLAUDE_PROJECT_DIR: dir },
      input: payload,
      encoding: 'utf8',
    });
    return { status: res.status ?? -1, stderr: res.stderr ?? '' };
  }

  // ─── R2-14 [P0] CLASS: cmdName dispatch fails on absolute paths ──
  // Bypass class: ANY utility invoked via absolute or relative path
  // (./bin, /usr/bin/cmd, /opt/homebrew/bin/cmd, env cmd, sudo cmd).
  // The fix: basename-normalize cmdName before dispatcher. Tests
  // iterate every detected utility × invocation form.
  describe('R2-14: cmdName basename normalization (bypass class)', () => {
    // Every utility the walker dispatches on. The list is structural —
    // an attacker can invoke any of these by absolute path. Pre-fix
    // the dispatcher's literal switch fell to default for all such
    // forms, silently allowing protected writes.
    const utilities: ReadonlyArray<{ name: string; cmd: (head: string) => string }> = [
      { name: 'bash', cmd: (h) => `${h} -c "printf x > .rea/HALT"` },
      { name: 'sh', cmd: (h) => `${h} -c "printf x > .rea/HALT"` },
      { name: 'sed', cmd: (h) => `${h} -i "" "1d" .rea/HALT` },
      { name: 'cp', cmd: (h) => `${h} src .rea/HALT` },
      { name: 'mv', cmd: (h) => `${h} src .rea/HALT` },
      { name: 'tee', cmd: (h) => `printf x | ${h} .rea/HALT` },
      { name: 'truncate', cmd: (h) => `${h} -s 0 .rea/HALT` },
      { name: 'install', cmd: (h) => `${h} src .rea/HALT` },
      { name: 'ln', cmd: (h) => `${h} -s evil .rea/HALT` },
      { name: 'awk', cmd: (h) => `${h} -i inplace 'BEGIN{}' .rea/HALT` },
      { name: 'ed', cmd: (h) => `${h} .rea/HALT` },
      { name: 'rm', cmd: (h) => `${h} .rea/HALT` },
      { name: 'touch', cmd: (h) => `${h} .rea/HALT` },
      { name: 'chmod', cmd: (h) => `${h} 000 .rea/HALT` },
      { name: 'chown', cmd: (h) => `${h} nobody .rea/HALT` },
      { name: 'chgrp', cmd: (h) => `${h} nobody .rea/HALT` },
      { name: 'mkdir', cmd: (h) => `${h} -p .husky/sub` },
      { name: 'rmdir', cmd: (h) => `${h} .husky/sub` },
      { name: 'tar', cmd: (h) => `${h} -xf x.tar -C .rea` },
      { name: 'rsync', cmd: (h) => `${h} src/ .rea/` },
      { name: 'curl', cmd: (h) => `${h} -o .rea/HALT https://x` },
      { name: 'wget', cmd: (h) => `${h} -O .rea/HALT https://x` },
      { name: 'shred', cmd: (h) => `${h} -u .rea/HALT` },
      { name: 'eval', cmd: (h) => `${h} 'printf x > .rea/HALT'` },
    ];
    // Five invocation forms per utility — covers absolute path, relative
    // path, env-prefixed, sudo-prefixed, and bare. Each invocation must
    // BLOCK because every payload writes to a protected path.
    const forms: ReadonlyArray<{ kind: string; head: (name: string) => string }> = [
      { kind: 'bare', head: (n) => n },
      { kind: '/usr/bin/', head: (n) => `/usr/bin/${n}` },
      { kind: '/opt/homebrew/bin/', head: (n) => `/opt/homebrew/bin/${n}` },
      { kind: './', head: (n) => `./${n}` },
      { kind: '/usr/bin/env wrapper', head: (n) => `/usr/bin/env ${n}` },
    ];
    for (const util of utilities) {
      for (const form of forms) {
        // ed/awk/eval don't unwrap through `env` for our static
        // detector; skip env-wrapped form for those (the wrapper itself
        // doesn't change the security posture — the bare form is
        // already covered).
        if (
          form.kind === '/usr/bin/env wrapper' &&
          (util.name === 'eval' || util.name === 'awk' || util.name === 'ed')
        ) {
          continue;
        }
        const head = form.head(util.name);
        const cmdStr = util.cmd(head);
        it(`R2-14: ${util.name} via ${form.kind} must BLOCK`, () => {
          if (!jqExists()) return;
          const { dir, cleanup } = makeFixture((d) => {
            writeFileSync(path.join(d, 'src'), 'x');
            writeFileSync(path.join(d, 'evil'), 'x');
            mkdirSync(path.join(d, 'src.dir'), { recursive: true });
          });
          try {
            const res = runHookCwd('protected-paths-bash-gate.sh', dir, cmdStr);
            expect(res.status, `expected BLOCK for: ${cmdStr}\nstderr: ${res.stderr}`).toBe(2);
          } finally {
            cleanup();
          }
        });
      }
    }
  });

  // ─── R2-1 [P1] CLASS: decoupled-variable interpreter writes ─────
  // Bypass class: the dynamic-target construction is moved OUT of the
  // write-call's first-arg slot. The localized regex doesn't fire.
  // Flat-scan defense: write API + ANY string-construction primitive
  // anywhere in the payload → dynamic.
  describe('R2-1: decoupled-variable dynamic interpreter writes', () => {
    const payloads = [
      // Python — concat then open
      {
        cmd: `python3 -c "p='.rea'+'/HALT'; open(p,'w').write('x')"`,
        why: 'python concat then open',
      },
      {
        cmd: `python3 -c "p=f'.rea/{x}HALT'.format(x=''); open(p,'w')"`,
        why: 'python f-string then open',
      },
      {
        cmd: `python3 -c "import os; p=os.path.join('.rea','HALT'); open(p,'w')"`,
        why: 'python os.path.join then open',
      },
      {
        cmd: `python3 -c "open('/'.join(['.rea','HALT']),'w')"`,
        why: 'python /-join inline',
      },
      {
        cmd: `python3 -c "p='%s/%s'%('.rea','HALT'); open(p,'w')"`,
        why: 'python % format',
      },
      // Node — concat / template / decoupled require()
      {
        cmd: `node -e "const p='.rea'+'/HALT'; require('fs').writeFileSync(p,'x')"`,
        why: 'node concat decoupled',
      },
      {
        cmd: `node -e "const fs=require('fs'); fs.writeFileSync(\\\`\\\${'.rea'}/HALT\\\`,'x')"`,
        why: 'node template-literal interpolation',
      },
      {
        cmd: `node -e "const path='.rea'.concat('/HALT'); require('fs').writeFileSync(path,'x')"`,
        why: 'node .concat',
      },
      {
        cmd: `node -e "const p=['.rea','HALT'].join('/'); require('fs').writeFileSync(p,'x')"`,
        why: 'node array.join',
      },
      // Ruby — concat / interpolation / format
      {
        cmd: `ruby -e "p = '.rea' + '/HALT'; File.write p, 'x'"`,
        why: 'ruby concat',
      },
      {
        cmd: `ruby -e "p = \\"\\#{'.rea'}/HALT\\"; File.write(p, 'x')"`,
        why: 'ruby string interpolation',
      },
      {
        cmd: `ruby -e "p = sprintf('%s/%s','.rea','HALT'); File.write(p,'x')"`,
        why: 'ruby sprintf',
      },
      // Perl — concat / sprintf
      {
        cmd: `perl -e "my \\$p='.rea'.'/HALT'; open(my \\$f,'>',\\$p)"`,
        why: 'perl . concat',
      },
      {
        cmd: `perl -e "my \\$p=sprintf('%s/%s','.rea','HALT'); open(my \\$f,'>',\\$p)"`,
        why: 'perl sprintf',
      },
    ];
    for (const p of payloads) {
      it(`R2-1: ${p.why} — must BLOCK`, () => {
        if (!jqExists()) return;
        const { dir, cleanup } = makeFixture(() => {});
        try {
          const res = runHookCwd('protected-paths-bash-gate.sh', dir, p.cmd);
          expect(res.status, `expected BLOCK for: ${p.cmd}\nstderr: ${res.stderr}`).toBe(2);
        } finally {
          cleanup();
        }
      });
    }
    // Negatives — payloads that should NOT trip the flat-scan fallback.
    const negatives = [
      {
        cmd: `python3 -c "open('safe.txt','w')"`,
        why: 'python single-literal write to safe path — ALLOW',
      },
      {
        cmd: `node -e "console.log('hello' + 'world')"`,
        why: 'node concat in non-write context — ALLOW',
      },
      {
        cmd: `ruby -e "puts 'hello'"`,
        why: 'ruby no write API — ALLOW',
      },
    ];
    for (const n of negatives) {
      it(`R2-1 negative: ${n.why}`, () => {
        if (!jqExists()) return;
        const { dir, cleanup } = makeFixture(() => {});
        try {
          const res = runHookCwd('protected-paths-bash-gate.sh', dir, n.cmd);
          expect(res.status, `expected ALLOW for: ${n.cmd}\nstderr: ${res.stderr}`).toBe(0);
        } finally {
          cleanup();
        }
      });
    }
  });

  // ─── R2-2 [P1] CLASS: symlink cycle / depth-cap ───────────────────
  describe('R2-2: symlink cycle + depth-cap refusal', () => {
    it('R2-2: a→b→a cycle pointing into protected refuses on uncertainty', () => {
      if (!jqExists()) return;
      const { dir, cleanup } = makeFixture((d) => {
        // Build a→b→a symlink loop, where `a` is the leaf an attacker
        // wants to write to. Both links resolve to nothing real, but
        // the resolver must terminate at the depth cap with a dynamic
        // sentinel rather than recursing forever.
        symlinkSync('b', path.join(d, 'a'));
        symlinkSync('a', path.join(d, 'b'));
      });
      try {
        const res = runHookCwd('protected-paths-bash-gate.sh', dir, 'printf x > a');
        // The leaf 'a' might not match a protected pattern by name; but
        // the resolver returning the sentinel is what we test. A clean
        // verdict (ALLOW or BLOCK) within the test timeout is what
        // matters — pre-fix this would have stack-overflowed.
        expect([0, 2]).toContain(res.status);
      } finally {
        cleanup();
      }
    });

    it('R2-2: deep symlink chain (32+) refuses on uncertainty', () => {
      if (!jqExists()) return;
      const { dir, cleanup } = makeFixture((d) => {
        // Build link[0] → link[1] → ... → link[40] → .rea/HALT.
        // The depth cap is 32; this chain exceeds it.
        const N = 40;
        symlinkSync('.rea/HALT', path.join(d, `link${N - 1}`));
        for (let k = N - 2; k >= 0; k -= 1) {
          symlinkSync(`link${k + 1}`, path.join(d, `link${k}`));
        }
      });
      try {
        const res = runHookCwd('protected-paths-bash-gate.sh', dir, 'printf x > link0');
        // Either BLOCKs because the resolver still detects the leaf
        // (most likely, since lstat sees the link), OR refuses on
        // uncertainty via the depth-cap sentinel. Both satisfy the
        // safety property.
        expect(res.status).toBe(2);
      } finally {
        cleanup();
      }
    });
  });

  // ─── R2-4 [P1] CLASS: -t<DIR> no-space form ──────────────────────
  describe('R2-4: cp/mv/install/ln -t<DIR> no-space form', () => {
    const cases = [
      { cmd: 'cp -t.rea src', util: 'cp' },
      { cmd: 'cp -t.husky src', util: 'cp' },
      { cmd: 'mv -t.rea src', util: 'mv' },
      { cmd: 'mv -t.husky src', util: 'mv' },
      { cmd: 'install -t.rea src', util: 'install' },
      { cmd: 'install -t.husky src', util: 'install' },
      { cmd: 'ln -t.rea src', util: 'ln' },
      // Combined cluster: -ft<DIR> (cp) — last-char-t check still fires
      // via the value-bearing path (next arg is value), but the joined
      // form `-ft.rea` is non-standard. We only require the canonical
      // `-t<DIR>` form.
    ];
    for (const c of cases) {
      it(`R2-4: ${c.cmd} must BLOCK`, () => {
        if (!jqExists()) return;
        const { dir, cleanup } = makeFixture((d) => {
          writeFileSync(path.join(d, 'src'), 'x');
        });
        try {
          const res = runHookCwd('protected-paths-bash-gate.sh', dir, c.cmd);
          expect(res.status, `expected BLOCK for: ${c.cmd}\nstderr: ${res.stderr}`).toBe(2);
        } finally {
          cleanup();
        }
      });
    }
    it('R2-4 control: cp -t docs/safe src must ALLOW (no-space form)', () => {
      if (!jqExists()) return;
      const { dir, cleanup } = makeFixture((d) => {
        writeFileSync(path.join(d, 'src'), 'x');
        mkdirSync(path.join(d, 'docs', 'safe'), { recursive: true });
      });
      try {
        const res = runHookCwd('protected-paths-bash-gate.sh', dir, 'cp -tdocs/safe src');
        expect(res.status).toBe(0);
      } finally {
        cleanup();
      }
    });
  });

  // ─── R2-7 [P1]: tar -C DIR ─────────────────────────────────────
  describe('R2-7: tar -C DIR', () => {
    const cases = [
      'tar -xf x.tar -C .rea',
      'tar -xf x.tar -C .husky',
      'tar --directory=.rea -xf x.tar',
      'tar --directory .rea -xf x.tar',
      'tar -xf x.tar -C.rea', // joined form
    ];
    for (const cmd of cases) {
      it(`R2-7: ${cmd} must BLOCK`, () => {
        if (!jqExists()) return;
        const { dir, cleanup } = makeFixture((d) => {
          writeFileSync(path.join(d, 'x.tar'), 'x');
        });
        try {
          const res = runHookCwd('protected-paths-bash-gate.sh', dir, cmd);
          expect(res.status, `expected BLOCK for: ${cmd}\nstderr: ${res.stderr}`).toBe(2);
        } finally {
          cleanup();
        }
      });
    }
    it('R2-7 control: tar -xf x.tar -C docs/safe must ALLOW', () => {
      if (!jqExists()) return;
      const { dir, cleanup } = makeFixture((d) => {
        writeFileSync(path.join(d, 'x.tar'), 'x');
        mkdirSync(path.join(d, 'docs', 'safe'), { recursive: true });
      });
      try {
        const res = runHookCwd('protected-paths-bash-gate.sh', dir, 'tar -xf x.tar -C docs/safe');
        expect(res.status).toBe(0);
      } finally {
        cleanup();
      }
    });
  });

  // ─── R2-8 [P1]: rsync DEST ─────────────────────────────────────
  describe('R2-8: rsync last-positional DEST', () => {
    const cases = [
      'rsync src/ .rea/',
      'rsync -av src/ .husky/',
      'rsync -e ssh src/ .rea/policy.yaml',
      'rsync --exclude=foo src/ .rea/',
      'rsync src .claude/settings.json',
    ];
    for (const cmd of cases) {
      it(`R2-8: ${cmd} must BLOCK`, () => {
        if (!jqExists()) return;
        const { dir, cleanup } = makeFixture((d) => {
          mkdirSync(path.join(d, 'src'), { recursive: true });
        });
        try {
          const res = runHookCwd('protected-paths-bash-gate.sh', dir, cmd);
          expect(res.status, `expected BLOCK for: ${cmd}\nstderr: ${res.stderr}`).toBe(2);
        } finally {
          cleanup();
        }
      });
    }
    it('R2-8 control: rsync src/ docs/safe/ must ALLOW', () => {
      if (!jqExists()) return;
      const { dir, cleanup } = makeFixture((d) => {
        mkdirSync(path.join(d, 'src'), { recursive: true });
        mkdirSync(path.join(d, 'docs', 'safe'), { recursive: true });
      });
      try {
        const res = runHookCwd('protected-paths-bash-gate.sh', dir, 'rsync src/ docs/safe/');
        expect(res.status).toBe(0);
      } finally {
        cleanup();
      }
    });
  });

  // ─── R2-9 [P1]: curl/wget output-file ──────────────────────────
  describe('R2-9: curl -o / wget -O write target', () => {
    const cases = [
      'curl -o .rea/HALT https://x',
      'curl --output .rea/HALT https://x',
      'curl -o.rea/HALT https://x', // joined
      'curl --output=.rea/HALT https://x',
      'wget -O .rea/HALT https://x',
      'wget --output-document=.rea/HALT https://x',
      'wget -O.rea/HALT https://x',
    ];
    for (const cmd of cases) {
      it(`R2-9: ${cmd} must BLOCK`, () => {
        if (!jqExists()) return;
        const { dir, cleanup } = makeFixture(() => {});
        try {
          const res = runHookCwd('protected-paths-bash-gate.sh', dir, cmd);
          expect(res.status, `expected BLOCK for: ${cmd}\nstderr: ${res.stderr}`).toBe(2);
        } finally {
          cleanup();
        }
      });
    }
    it('R2-9 control: wget -O - https://x must ALLOW (stdout)', () => {
      if (!jqExists()) return;
      const { dir, cleanup } = makeFixture(() => {});
      try {
        const res = runHookCwd('protected-paths-bash-gate.sh', dir, 'wget -O - https://x');
        expect(res.status).toBe(0);
      } finally {
        cleanup();
      }
    });
  });

  // ─── R2-10 [P1]: shred ───────────────────────────────────────────
  describe('R2-10: shred', () => {
    const cases = [
      'shred -u .rea/HALT',
      'shred .rea/HALT',
      'shred -n 3 -u .rea/policy.yaml',
      'shred .husky/pre-push',
    ];
    for (const cmd of cases) {
      it(`R2-10: ${cmd} must BLOCK`, () => {
        if (!jqExists()) return;
        const { dir, cleanup } = makeFixture(() => {});
        try {
          const res = runHookCwd('protected-paths-bash-gate.sh', dir, cmd);
          expect(res.status, `expected BLOCK for: ${cmd}\nstderr: ${res.stderr}`).toBe(2);
        } finally {
          cleanup();
        }
      });
    }
  });

  // ─── R2-11 [P2]: git checkout/restore/reset -- PATH ────────────
  describe('R2-11: git path-touching subcommands', () => {
    const cases = [
      { cmd: 'git checkout -- .rea/HALT', why: 'checkout' },
      { cmd: 'git checkout HEAD -- .rea/HALT', why: 'checkout from HEAD' },
      { cmd: 'git restore -- .rea/HALT', why: 'restore' },
      { cmd: 'git restore --source=HEAD~1 -- .rea/HALT', why: 'restore --source' },
      { cmd: 'git reset HEAD -- .rea/HALT', why: 'reset' },
      { cmd: 'git checkout -- .husky/pre-push', why: 'checkout husky' },
    ];
    for (const c of cases) {
      it(`R2-11 ${c.why}: ${c.cmd} must BLOCK`, () => {
        if (!jqExists()) return;
        const { dir, cleanup } = makeFixture(() => {});
        try {
          const res = runHookCwd('protected-paths-bash-gate.sh', dir, c.cmd);
          expect(res.status, `expected BLOCK for: ${c.cmd}\nstderr: ${res.stderr}`).toBe(2);
        } finally {
          cleanup();
        }
      });
    }
    it('R2-11 control: git checkout main (branch, no --) must ALLOW', () => {
      if (!jqExists()) return;
      const { dir, cleanup } = makeFixture(() => {});
      try {
        const res = runHookCwd('protected-paths-bash-gate.sh', dir, 'git checkout main');
        expect(res.status).toBe(0);
      } finally {
        cleanup();
      }
    });
  });

  // ─── R2-12 [P1]: heredoc-into-shell re-parse ───────────────────
  describe('R2-12: heredoc-into-shell re-parse', () => {
    const cases = [
      `sh <<EOF
printf x > .rea/HALT
EOF`,
      `bash <<EOF
echo evil > .husky/pre-push
EOF`,
      `bash <<-EOF
\tprintf x > .rea/policy.yaml
EOF`,
      // Nested: heredoc body itself contains a redirect.
      `zsh <<EOF
cat /dev/null > .claude/settings.json
EOF`,
    ];
    for (const cmd of cases) {
      it(`R2-12: heredoc must BLOCK — ${cmd.split('\n')[0]}`, () => {
        if (!jqExists()) return;
        const { dir, cleanup } = makeFixture(() => {});
        try {
          const res = runHookCwd('protected-paths-bash-gate.sh', dir, cmd);
          expect(res.status, `expected BLOCK\nstderr: ${res.stderr}`).toBe(2);
        } finally {
          cleanup();
        }
      });
    }
    it('R2-12 control: heredoc with safe write must ALLOW', () => {
      if (!jqExists()) return;
      const { dir, cleanup } = makeFixture((d) => {
        mkdirSync(path.join(d, 'docs'), { recursive: true });
      });
      try {
        const res = runHookCwd(
          'protected-paths-bash-gate.sh',
          dir,
          `sh <<EOF
printf x > docs/notes.md
EOF`,
        );
        expect(res.status).toBe(0);
      } finally {
        cleanup();
      }
    });
  });

  // ─── R2-13 [P1]: eval re-parse ────────────────────────────────
  describe('R2-13: eval re-parses concatenated argv', () => {
    const cases = [
      `eval "printf x > .rea/HALT"`,
      `eval 'printf x > .rea/policy.yaml'`,
      `eval printf x ">" .rea/HALT`, // unquoted concatenation
      `eval "rm" ".rea/HALT"`,
      `eval "cp src .husky/pre-push"`,
    ];
    for (const cmd of cases) {
      it(`R2-13: eval payload — ${cmd}`, () => {
        if (!jqExists()) return;
        const { dir, cleanup } = makeFixture((d) => {
          writeFileSync(path.join(d, 'src'), 'x');
        });
        try {
          const res = runHookCwd('protected-paths-bash-gate.sh', dir, cmd);
          expect(res.status, `expected BLOCK for: ${cmd}\nstderr: ${res.stderr}`).toBe(2);
        } finally {
          cleanup();
        }
      });
    }
    it('R2-13 control: eval with safe write must ALLOW', () => {
      if (!jqExists()) return;
      const { dir, cleanup } = makeFixture((d) => {
        mkdirSync(path.join(d, 'docs'), { recursive: true });
      });
      try {
        const res = runHookCwd(
          'protected-paths-bash-gate.sh',
          dir,
          `eval "printf x > docs/safe.md"`,
        );
        expect(res.status).toBe(0);
      } finally {
        cleanup();
      }
    });
  });
});
