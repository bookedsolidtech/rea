/**
 * Unit tests for the G2 Bash-tier verify-gate
 * (`rea hook verify-gate-bash-gate`).
 *
 * Two tiers of coverage:
 *
 *   1. Routing / mode: HALT, off (byte-identical), non-Bash, empty command,
 *      relevance pre-gate, malformed payload.
 *   2. Detection: reuses `runBlockedScan` — smoke every shell write form
 *      (redirect, tee, cp, mv) against `.rea/tasks.jsonl`, plus the
 *      sanctioned `rea tasks` CLI and a benign read as negatives. The
 *      exhaustive walker corpus lives under `src/hooks/bash-scanner/`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GateMode } from '../../policy/types.js';
import { runVerifyGateBashGate } from './index.js';

function payload(cmd: string, toolName = 'Bash'): string {
  return JSON.stringify({ tool_name: toolName, tool_input: { command: cmd } });
}

function writePolicy(root: string, g2Mode: GateMode | 'absent'): void {
  fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
  const gates = g2Mode === 'absent' ? '' : `artifact_gates:\n  g2_verify:\n    mode: ${g2Mode}\n`;
  const yaml = `version: "0.54.0"
profile: bst-internal
installed_by: test
installed_at: "2026-01-01T00:00:00Z"
autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
blocked_paths: []
${gates}`;
  fs.writeFileSync(path.join(root, '.rea', 'policy.yaml'), yaml);
}

describe('verify-gate-bash-gate (G2 Bash-tier)', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-g2bash-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('routing / mode', () => {
    it('HALT active → exit 2 with banner', async () => {
      writePolicy(root, 'enforce');
      fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'kill switch on\n');
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: payload('echo x > .rea/tasks.jsonl'),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain('REA HALT');
    });

    it('off → byte-identical allow even for a redirect to the store', async () => {
      writePolicy(root, 'off');
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: payload('echo x > .rea/tasks.jsonl'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.stderr).toBe('');
      expect(r.detected).toBe(false);
    });

    it('absent artifact_gates block → treated as off (exit 0)', async () => {
      writePolicy(root, 'absent');
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: payload('echo x > .rea/tasks.jsonl'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.mode).toBe('off');
    });

    it('no policy file at all → off (exit 0)', async () => {
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: payload('echo x > .rea/tasks.jsonl'),
      });
      expect(r.exitCode).toBe(0);
    });

    it('non-Bash tool under enforce → exit 0', async () => {
      writePolicy(root, 'enforce');
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: payload('echo x > .rea/tasks.jsonl', 'Write'),
      });
      expect(r.exitCode).toBe(0);
    });

    it('empty command under enforce → exit 0', async () => {
      writePolicy(root, 'enforce');
      const r = await runVerifyGateBashGate({ reaRoot: root, stdinOverride: payload('') });
      expect(r.exitCode).toBe(0);
    });

    it('irrelevant command under enforce → exit 0 (relevance skip)', async () => {
      writePolicy(root, 'enforce');
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: payload('ls -la && echo done > /tmp/other.log'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.detected).toBe(false);
    });

    it('malformed payload under enforce → exit 2 (UNCERTAIN ≡ REFUSE)', async () => {
      writePolicy(root, 'enforce');
      const r = await runVerifyGateBashGate({ reaRoot: root, stdinOverride: '{not-json' });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toMatch(/uncertainty/i);
    });

    it('malformed payload under off → exit 0 (byte-identical)', async () => {
      writePolicy(root, 'off');
      const r = await runVerifyGateBashGate({ reaRoot: root, stdinOverride: '{not-json' });
      expect(r.exitCode).toBe(0);
    });
  });

  describe('detection (enforce)', () => {
    beforeEach(() => writePolicy(root, 'enforce'));

    it('redirect `> .rea/tasks.jsonl` → exit 2, banner points to `rea tasks`', async () => {
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: payload('echo \'{"id":"t1","status":"completed"}\' > .rea/tasks.jsonl'),
      });
      expect(r.exitCode).toBe(2);
      expect(r.detected).toBe(true);
      expect(r.stderr).toContain('rea tasks');
      expect(r.stderr).toContain('ARTIFACT GATE G2');
    });

    it('append redirect `>> .rea/tasks.jsonl` → exit 2', async () => {
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: payload('printf x >> .rea/tasks.jsonl'),
      });
      expect(r.exitCode).toBe(2);
    });

    it('tee .rea/tasks.jsonl → exit 2', async () => {
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: payload('echo x | tee .rea/tasks.jsonl'),
      });
      expect(r.exitCode).toBe(2);
    });

    it('cp foo .rea/tasks.jsonl → exit 2', async () => {
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: payload('cp /tmp/foo .rea/tasks.jsonl'),
      });
      expect(r.exitCode).toBe(2);
    });

    it('mv foo .rea/tasks.jsonl → exit 2', async () => {
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: payload('mv /tmp/foo .rea/tasks.jsonl'),
      });
      expect(r.exitCode).toBe(2);
    });

    it('sanctioned `rea tasks complete` → exit 0 (no shell write target)', async () => {
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: payload('rea tasks complete t1 # writes .rea/tasks.jsonl internally'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.detected).toBe(false);
    });

    it('benign read `cat .rea/tasks.jsonl` → exit 0 (read, not write)', async () => {
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: payload('cat .rea/tasks.jsonl'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.detected).toBe(false);
    });

    it('redirect to an unrelated file naming the store in a comment → allow', async () => {
      // `> /tmp/tasks-jsonl.log` names neither `tasks.jsonl` path — but this
      // command has both substrings via the comment, exercising that the
      // SCANNER (not the relevance pre-gate) decides the actual match.
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: payload('echo x > /tmp/report.log # not the tasks jsonl store'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.detected).toBe(false);
    });
  });

  // Round-13 F3 — symlink ALIAS coverage (the keyword pre-filter's blind spot)
  // and the dynamic-target guard (no over-refusal of unrelated dynamic writes).
  describe('F3 — alias resolution + dynamic-target guard (enforce)', () => {
    beforeEach(() => writePolicy(root, 'enforce'));

    it.skipIf(process.platform === 'win32')(
      '`tee tasklog` where tasklog -> .rea/tasks.jsonl is blocked (no keyword)',
      async () => {
        const store = path.join(root, '.rea', 'tasks.jsonl');
        fs.writeFileSync(store, '');
        fs.symlinkSync(store, path.join(root, 'tasklog'));
        const r = await runVerifyGateBashGate({
          reaRoot: root,
          // Command text contains neither `tasks` nor `jsonl` — the old
          // keyword pre-filter would have skipped it entirely.
          stdinOverride: payload('echo x | tee tasklog'),
        });
        expect(r.exitCode).toBe(2);
        expect(r.detected).toBe(true);
        expect(r.stderr).toContain('rea tasks');
      },
    );

    it.skipIf(process.platform === 'win32')(
      '`cp foo tasklog` alias is blocked',
      async () => {
        const store = path.join(root, '.rea', 'tasks.jsonl');
        fs.writeFileSync(store, '');
        fs.symlinkSync(store, path.join(root, 'tasklog'));
        fs.writeFileSync(path.join(root, 'foo'), 'x');
        const r = await runVerifyGateBashGate({
          reaRoot: root,
          stdinOverride: payload('cp foo tasklog'),
        });
        expect(r.exitCode).toBe(2);
      },
    );

    it('a dynamic write target is NOT over-refused (unrelated `> $VAR`)', async () => {
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        // The scanner refuses-on-uncertainty for blocked_paths, but this gate
        // only treats a STATIC store match as a hit — so an unrelated dynamic
        // redirect is allowed, not blocked with a spurious "use rea tasks".
        stdinOverride: payload('echo x > "$SOME_UNSET_VAR"'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.detected).toBe(false);
    });

    it('a symlink alias to an UNRELATED file is allowed', async () => {
      const other = path.join(root, 'other.log');
      fs.writeFileSync(other, '');
      fs.symlinkSync(other, path.join(root, 'tasklog'));
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: payload('echo x > tasklog'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.detected).toBe(false);
    });
  });

  // Round-57 P1 — a Bash command run from a SUBDIRECTORY resolves a relative
  // redirect against its OWN cwd, not the repo root. The payload `cwd` must be
  // threaded into the scan so a subdir-relative store write is still caught.
  describe('P1 — subdirectory cwd-relative redirect (enforce)', () => {
    beforeEach(() => writePolicy(root, 'enforce'));

    it('`> ../../.rea/tasks.jsonl` from a subdir cwd → exit 2 (caught via payload cwd)', async () => {
      const sub = path.join(root, 'packages', 'foo');
      fs.mkdirSync(sub, { recursive: true });
      // From packages/foo, `../../.rea/tasks.jsonl` reaches the repo store. Joined
      // repo-root-relative it would land OUTSIDE the root (a miss); resolved
      // against the payload cwd it hits the store.
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: JSON.stringify({
          tool_name: 'Bash',
          cwd: sub,
          tool_input: { command: 'echo x > ../../.rea/tasks.jsonl' },
        }),
      });
      expect(r.exitCode).toBe(2);
      expect(r.detected).toBe(true);
      expect(r.stderr).toContain('rea tasks');
    });

    it('repo-root-relative `> .rea/tasks.jsonl` still caught when a differing cwd is present (no weakening)', async () => {
      const sub = path.join(root, 'packages', 'foo');
      fs.mkdirSync(sub, { recursive: true });
      // The reaRoot base is ALWAYS tried (base[0]), so a target expressed
      // repo-root-relative is still detected even with a differing cwd threaded.
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: JSON.stringify({
          tool_name: 'Bash',
          cwd: sub,
          tool_input: { command: 'echo x > .rea/tasks.jsonl' },
        }),
      });
      expect(r.exitCode).toBe(2);
      expect(r.detected).toBe(true);
    });
  });

  describe('shadow', () => {
    it('redirect to store → exit 0 but detected (would_block logged)', async () => {
      writePolicy(root, 'shadow');
      const r = await runVerifyGateBashGate({
        reaRoot: root,
        stdinOverride: payload('echo x > .rea/tasks.jsonl'),
      });
      expect(r.exitCode).toBe(0);
      expect(r.detected).toBe(true);
      // Shadow never emits the operator banner.
      expect(r.stderr).toBe('');
    });

    it.skipIf(process.platform === 'win32')(
      'alias `tee tasklog` under shadow → exit 0 but detected',
      async () => {
        writePolicy(root, 'shadow');
        const store = path.join(root, '.rea', 'tasks.jsonl');
        fs.writeFileSync(store, '');
        fs.symlinkSync(store, path.join(root, 'tasklog'));
        const r = await runVerifyGateBashGate({
          reaRoot: root,
          stdinOverride: payload('echo x | tee tasklog'),
        });
        expect(r.exitCode).toBe(0);
        expect(r.detected).toBe(true);
      },
    );
  });
});
