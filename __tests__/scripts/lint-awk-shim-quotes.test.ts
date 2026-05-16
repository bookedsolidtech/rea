/**
 * 0.36.0 charter item 3 — tests for `scripts/lint-awk-shim-quotes.mjs`.
 *
 * The lint catches the 0.34.0 round-4 + round-6 bug class: a bash hook
 * embeds an `awk '<body>'` block whose body contains a comment line
 * with a BARE `'` (e.g. `# can't`). Bash terminates the single-quoted
 * argument at that quote, the rest of the awk body is reparsed as
 * bash, and the hook crashes at parse time. The 0.34.0 round-6
 * instance locked the entire repo (every Bash refused at hook parse
 * time because every hook sourced `_lib/cmd-segments.sh`, which
 * crashed at parse) — repair required out-of-session `git apply`.
 *
 * Two test postures:
 *
 *   1. Self-test against the real corpus — `hooks/*.sh` +
 *      `.claude/hooks/*.sh` (dogfood mirror) must pass cleanly.
 *      A regression that introduces a bare `'` in an awk comment
 *      anywhere in the shipped corpus turns this test red BEFORE
 *      the broken hook reaches a consumer.
 *
 *   2. Synthetic positive — a temp file with a known bare-`'` comment
 *      must produce the expected error output AND a non-zero exit.
 *      This pins the detector logic so a future refactor that
 *      accidentally fails-open trips immediately.
 */

import { describe, expect, it } from 'vitest';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const lintScript = path.join(repoRoot, 'scripts', 'lint-awk-shim-quotes.mjs');

describe('lint-awk-shim-quotes — real corpus (`hooks/` + `.claude/hooks/`)', () => {
  it('passes on the current shipped hook corpus (regression pin)', () => {
    // Run from the repo root so the script's relative dir-scan works
    // exactly as it would in `pnpm lint`. `execFileSync` throws on
    // non-zero exit — that throw IS the failure mode we're guarding
    // against.
    let result: string;
    try {
      result = execFileSync('node', [lintScript], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      throw new Error(
        `lint failed on shipped corpus (exit ${err.status ?? '?'})\n` +
          `stderr:\n${err.stderr ?? ''}\nstdout:\n${err.stdout ?? ''}`,
      );
    }
    // Quiet success — no findings means no stdout.
    expect(result).toBe('');
  });
});

describe('lint-awk-shim-quotes — synthetic bare-quote fixture', () => {
  it('flags a comment with a bare `\'` and exits non-zero', async () => {
    // Build a temp repo skeleton that the lint script will scan:
    //   <tmp>/hooks/broken.sh — contains the bug class.
    // The script scans `hooks/`, `hooks/_lib/`, `.claude/hooks/`, and
    // `.claude/hooks/_lib/` relative to repo root. We hand-build a
    // scratch repo with a `hooks/` directory and point the script
    // there via a wrapped invocation that overrides `cwd`.
    const dir = mkdtempSync(path.join(tmpdir(), 'rea-lint-awk-'));
    try {
      const hooksDir = path.join(dir, 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      const broken = path.join(hooksDir, 'broken.sh');
      // Multi-line awk with a comment that has a BARE apostrophe.
      // Pre-0.34.0-round-4-fix: this is exactly the shape that broke
      // the marathon. Lint must flag it.
      writeFileSync(
        broken,
        [
          "#!/bin/bash",
          "set -euo pipefail",
          "echo 'hello' | awk '",
          "  # this comment can't have a bare quote",
          "  { print $1 }",
          "'",
          '',
        ].join('\n'),
      );
      // We have to copy the script into the scratch repo so its
      // `path.resolve(here, '..')` resolves to the scratch repo, not
      // the real one.
      const scratchScriptsDir = path.join(dir, 'scripts');
      mkdirSync(scratchScriptsDir, { recursive: true });
      // Symlink-friendly: copy the script bytes verbatim.
      const scriptBytes = execFileSync('cat', [lintScript], {
        encoding: 'utf8',
      });
      const scratchScript = path.join(scratchScriptsDir, 'lint-awk-shim-quotes.mjs');
      writeFileSync(scratchScript, scriptBytes);

      let exitCode: number | null = 0;
      let stderr = '';
      try {
        await execFileAsync('node', [scratchScript], { cwd: dir });
      } catch (e) {
        const err = e as { code: number | null; stderr: string };
        exitCode = err.code;
        stderr = err.stderr;
      }
      expect(exitCode).toBe(1);
      // Detail must name the file, the line, and the regression class.
      expect(stderr).toContain('broken.sh');
      expect(stderr).toContain('0.34.0 round-4 + round-6');
      expect(stderr).toMatch(/apostrophe-in-word|BARE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a bare `\'` inside an `awk -v key=val \'...\'` block (0.36.0 codex round-1 P2)', async () => {
    // Pre-fix the opener regex was `/\bawk\s+'\s*$/`, which only
    // matched bare `awk '` openers and missed `awk -v ... '` shapes
    // — the exact shape that ships in `hooks/local-review-gate.sh`
    // and `hooks/_lib/policy-read.sh`. A bare-quote bug introduced
    // into one of those blocks would have shipped silently.
    // Post-fix the opener accepts any args between `awk` and the
    // trailing `'`. Pin that with a synthetic file.
    const dir = mkdtempSync(path.join(tmpdir(), 'rea-lint-awk-v-'));
    try {
      const hooksDir = path.join(dir, 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(
        path.join(hooksDir, 'broken-v.sh'),
        [
          "#!/bin/bash",
          // Realistic shape: piped into awk -v with a trailing open
          // quote, then a multi-line body with a bare-` ' ` comment.
          'echo "x;y" | awk -v trigger="^foo" \'',
          "  # this comment can't have a bare quote",
          "  { print $1 }",
          "'",
          '',
        ].join('\n'),
      );
      const scratchScriptsDir = path.join(dir, 'scripts');
      mkdirSync(scratchScriptsDir, { recursive: true });
      const scriptBytes = execFileSync('cat', [lintScript], {
        encoding: 'utf8',
      });
      const scratchScript = path.join(scratchScriptsDir, 'lint-awk-shim-quotes.mjs');
      writeFileSync(scratchScript, scriptBytes);

      let exitCode: number | null = 0;
      let stderr = '';
      try {
        await execFileAsync('node', [scratchScript], { cwd: dir });
      } catch (e) {
        const err = e as { code: number | null; stderr: string };
        exitCode = err.code;
        stderr = err.stderr;
      }
      expect(exitCode).toBe(1);
      expect(stderr).toContain('broken-v.sh');
      expect(stderr).toMatch(/apostrophe-in-word|BARE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a bare `\'` in awk CODE (not just comments) (0.36.0 codex round-2 P2 #1)', async () => {
    // Pre-fix the bare-quote check ran only on comment lines
    // (`stripped.startsWith('#')`). A code line like
    // `BEGIN { print "can't" }` parse-fails the same way — bash
    // doesn't know awk grammar, the `'` byte is a quote-terminator
    // regardless of whether it appears in an awk string literal,
    // regex, or comment.
    const dir = mkdtempSync(path.join(tmpdir(), 'rea-lint-awk-code-'));
    try {
      const hooksDir = path.join(dir, 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(
        path.join(hooksDir, 'broken-code.sh'),
        [
          "#!/bin/bash",
          "echo hi | awk '",
          // Code line (not a comment) with a bare `'` in an awk
          // string literal. Bash terminates here at runtime.
          '  BEGIN { print "can\'t" }',
          "'",
          '',
        ].join('\n'),
      );
      const scratchScriptsDir = path.join(dir, 'scripts');
      mkdirSync(scratchScriptsDir, { recursive: true });
      const scriptBytes = execFileSync('cat', [lintScript], {
        encoding: 'utf8',
      });
      const scratchScript = path.join(scratchScriptsDir, 'lint-awk-shim-quotes.mjs');
      writeFileSync(scratchScript, scriptBytes);

      let exitCode: number | null = 0;
      let stderr = '';
      try {
        await execFileAsync('node', [scratchScript], { cwd: dir });
      } catch (e) {
        const err = e as { code: number | null; stderr: string };
        exitCode = err.code;
        stderr = err.stderr;
      }
      expect(exitCode).toBe(1);
      expect(stderr).toContain('broken-code.sh');
      // Detail must classify the line as `code` (not `comment`) so
      // a developer reading the lint output knows it's not just an
      // awk-comment-only check.
      expect(stderr).toMatch(/code line contains an apostrophe-in-word/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles `awk -v key="can\'t" \'` opener with `\'` in an earlier arg (0.36.0 codex round-2 P2 #2)', async () => {
    // Pre-fix the opener regex `/\bawk\b[^\n']*'\s*$/` skipped any
    // line where an earlier `-v key="..."` value contained a `'`.
    // Bash itself is fine with that (the `'` is inside a `"..."`
    // arg). Lint now matches `awk` keyword + line ending in `'`,
    // dropping the no-`'` restriction.
    const dir = mkdtempSync(path.join(tmpdir(), 'rea-lint-awk-arg-'));
    try {
      const hooksDir = path.join(dir, 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(
        path.join(hooksDir, 'broken-arg.sh'),
        [
          "#!/bin/bash",
          // -v arg has a `'` inside a double-quoted value. Bash
          // accepts it (DQ context). The trailing `'` is the awk
          // body open.
          'echo x | awk -v msg="can\'t" \'',
          // Bare `'` in the body — the bug class.
          "  # can't have a bare apostrophe in a comment",
          "  { print msg }",
          "'",
          '',
        ].join('\n'),
      );
      const scratchScriptsDir = path.join(dir, 'scripts');
      mkdirSync(scratchScriptsDir, { recursive: true });
      const scriptBytes = execFileSync('cat', [lintScript], {
        encoding: 'utf8',
      });
      const scratchScript = path.join(scratchScriptsDir, 'lint-awk-shim-quotes.mjs');
      writeFileSync(scratchScript, scriptBytes);

      let exitCode: number | null = 0;
      let stderr = '';
      try {
        await execFileAsync('node', [scratchScript], { cwd: dir });
      } catch (e) {
        const err = e as { code: number | null; stderr: string };
        exitCode = err.code;
        stderr = err.stderr;
      }
      expect(exitCode).toBe(1);
      expect(stderr).toContain('broken-arg.sh');
      expect(stderr).toMatch(/apostrophe-in-word|BARE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT flip into awk-block state on a shell-comment line mentioning awk (0.36.0 codex round-3 P2 #1)', async () => {
    // Pre-fix `inAwkBlock` would flip true on any line containing
    // the word `awk` ending in `'` — including prose like
    // `# Example: awk '...'`. The next comment with an apostrophe
    // (e.g. `# this isn't fine`) would then false-positive. Round-3
    // adds a shell-comment skip BEFORE the opener heuristic runs.
    const dir = mkdtempSync(path.join(tmpdir(), 'rea-lint-awk-prose-'));
    try {
      const hooksDir = path.join(dir, 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(
        path.join(hooksDir, 'prose.sh'),
        [
          '#!/bin/bash',
          // Shell comment mentioning awk + ending in `'`. Pre-fix
          // would have flipped inAwkBlock here.
          "# Example: awk 'BEGIN { print }'",
          // Another shell comment with a bare apostrophe — pre-fix
          // would have flagged it as an awk-body bare-`'`. Post-fix
          // the inAwkBlock flip didn't happen, so this line is
          // outside-block and the lint stays quiet.
          "# this isn't an awk body — just a comment",
          'echo hello',
          '',
        ].join('\n'),
      );
      const scratchScriptsDir = path.join(dir, 'scripts');
      mkdirSync(scratchScriptsDir, { recursive: true });
      const scriptBytes = execFileSync('cat', [lintScript], {
        encoding: 'utf8',
      });
      const scratchScript = path.join(scratchScriptsDir, 'lint-awk-shim-quotes.mjs');
      writeFileSync(scratchScript, scriptBytes);
      // Lint should pass — no findings.
      const out = execFileSync('node', [scratchScript], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(out).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('detects `awk \'BEGIN { ... }` opener with body starting on the same line (0.36.0 codex round-3 P2 #2)', async () => {
    // Pre-fix the opener required `'` at EOL. The
    // `awk 'BEGIN { ... }` shape (body starts on opener line,
    // continues on subsequent lines) was silently skipped — a real
    // multiline awk style outside the lint's coverage. Round-3
    // switched to odd-quote-count detection: a line with one
    // unclosed `'` after stripping benign forms opens a multi-line
    // block regardless of where the `'` appears.
    const dir = mkdtempSync(path.join(tmpdir(), 'rea-lint-awk-inline-'));
    try {
      const hooksDir = path.join(dir, 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(
        path.join(hooksDir, 'inline-opener.sh'),
        [
          '#!/bin/bash',
          // Opener with body content on same line — pre-fix MISSED.
          "echo hi | awk 'BEGIN { x = 1",
          // Bare-`'` bug on a subsequent line — must trigger.
          "  # can't have a bare apostrophe here",
          "}'",
          '',
        ].join('\n'),
      );
      const scratchScriptsDir = path.join(dir, 'scripts');
      mkdirSync(scratchScriptsDir, { recursive: true });
      const scriptBytes = execFileSync('cat', [lintScript], {
        encoding: 'utf8',
      });
      const scratchScript = path.join(scratchScriptsDir, 'lint-awk-shim-quotes.mjs');
      writeFileSync(scratchScript, scriptBytes);

      let exitCode: number | null = 0;
      let stderr = '';
      try {
        await execFileAsync('node', [scratchScript], { cwd: dir });
      } catch (e) {
        const err = e as { code: number | null; stderr: string };
        exitCode = err.code;
        stderr = err.stderr;
      }
      expect(exitCode).toBe(1);
      expect(stderr).toContain('inline-opener.sh');
      expect(stderr).toMatch(/apostrophe-in-word|BARE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does NOT flag the canonical `\'\\\'\'` escape sequence in a comment (false-positive pin)', async () => {
    // The rea hooks frequently document the bash quote-escape idiom
    // `'\''` inside awk comments. Stripping those before the bare-`'`
    // check is what keeps the real corpus quiet. Pin that filter with
    // a synthetic file so a future refactor that drops the strip
    // doesn't silently start flagging every documented escape.
    const dir = mkdtempSync(path.join(tmpdir(), 'rea-lint-awk-fp-'));
    try {
      const hooksDir = path.join(dir, 'hooks');
      mkdirSync(hooksDir, { recursive: true });
      writeFileSync(
        path.join(hooksDir, 'clean.sh'),
        [
          "#!/bin/bash",
          "echo hi | awk '",
          // Comment documents the escape idiom — canonical idiom.
          "  # injects a literal quote: '\\''",
          "  { print $1 }",
          "'",
          '',
        ].join('\n'),
      );
      const scratchScriptsDir = path.join(dir, 'scripts');
      mkdirSync(scratchScriptsDir, { recursive: true });
      const scriptBytes = execFileSync('cat', [lintScript], {
        encoding: 'utf8',
      });
      const scratchScript = path.join(scratchScriptsDir, 'lint-awk-shim-quotes.mjs');
      writeFileSync(scratchScript, scriptBytes);
      // Lint should pass — no findings.
      const out = execFileSync('node', [scratchScript], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(out).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
