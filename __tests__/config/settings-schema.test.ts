/**
 * 0.30.0 Class M — `.claude/settings.json` zod schema tests.
 *
 * Covers:
 *   1. valid consumer customization (oss-minimal fixture) parses clean
 *   2. unknown top-level keys are rejected by strict parse
 *   3. empty matcher fails parse
 *   4. path traversal in `command` is flagged via `validateNoTraversal`
 *   5. malformed JSON is surfaced as a parse error (caller responsibility,
 *      not the schema's — we validate the schema accepts/refuses the
 *      parsed object, not raw JSON)
 *   6. the canonical `.claude/settings.json` from this very repo
 *      validates clean (regression pin — Class M itself MUST NOT
 *      break the dogfood install)
 *   7. removing `delegation-capture` from the canonical settings
 *      surfaces it via `findMissingReaHooks` (the 0.29.0 drift
 *      closure regression pin)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  expectedHookNames,
  validateNoTraversal,
  validateSettings,
  SettingsSchema,
  type Settings,
} from '../../src/config/settings-schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 'settings');
const REPO_ROOT = path.resolve(__dirname, '..', '..');

function loadFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'));
}

describe('SettingsSchema — valid shapes', () => {
  it('accepts the oss-minimal fixture as a valid consumer customization', () => {
    const result = validateSettings(loadFixture('oss-minimal.json'));
    expect(result.parsed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.traversalFindings).toEqual([]);
  });

  it('accepts an empty hooks object', () => {
    const result = validateSettings({ hooks: {} });
    expect(result.parsed).toBe(true);
  });

  it('accepts settings with only env keys', () => {
    const result = validateSettings({ env: { FOO: 'bar' } });
    expect(result.parsed).toBe(true);
  });

  it('canonical .claude/settings.json from this repo validates clean', () => {
    const settingsPath = path.join(REPO_ROOT, '.claude', 'settings.json');
    // This file is the dogfood install; if Class M ever breaks it, the
    // schema is wrong (and rea init would refuse to install on a
    // freshly-bootstrapped consumer too).
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const result = validateSettings(raw);
    expect(result.errors).toEqual([]);
    expect(result.parsed).toBe(true);
  });
});

describe('SettingsSchema — rejection cases', () => {
  it('PASSES unknown top-level keys with lenient (default) schema — round-4 P1 fix', () => {
    // Codex round 4 P1: the default schema is .passthrough() at the
    // top level so future Claude Code harness keys do not break
    // `rea upgrade` mid-version. Strict rejection now lives in
    // SettingsSchemaStrict for the `rea doctor --strict` CI gate.
    const result = validateSettings(loadFixture('invalid-unknown-key.json'));
    expect(result.parsed).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects an empty matcher string', () => {
    const result = validateSettings(loadFixture('invalid-empty-matcher.json'));
    expect(result.parsed).toBe(false);
    expect(result.errors.some((e) => /matcher must be a non-empty/.test(e))).toBe(true);
  });

  it('rejects hooks: { hooks: [] } (empty list — every matcher needs at least one)', () => {
    const result = validateSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [],
          },
        ],
      },
    });
    expect(result.parsed).toBe(false);
  });

  it('rejects an unknown hook event name', () => {
    const result = validateSettings({
      hooks: {
        WeirdEventName: [],
      },
    });
    expect(result.parsed).toBe(false);
  });

  it('rejects a hook entry without a `type: "command"` field', () => {
    const result = validateSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ command: '/foo' }],
          },
        ],
      },
    });
    expect(result.parsed).toBe(false);
  });

  it('rejects timeout > 600_000 ms (10 min ceiling)', () => {
    const result = validateSettings({
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '/foo', timeout: 600_001 }],
          },
        ],
      },
    });
    expect(result.parsed).toBe(false);
  });
});

describe('validateNoTraversal — path-traversal detection', () => {
  it('flags `..` segments after stripping $CLAUDE_PROJECT_DIR', () => {
    const settings = loadFixture('invalid-traversal.json') as unknown;
    // The traversal fixture is structurally valid — zod parse succeeds.
    const parsed = SettingsSchema.parse(settings);
    const findings = validateNoTraversal(parsed);
    expect(findings.length).toBe(1);
    expect(findings[0]?.reason).toContain('..');
  });

  it('does NOT flag `..` inside $CLAUDE_PROJECT_DIR when no segment ends up at .., e.g. node_modules', () => {
    const settings: Settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              {
                type: 'command',
                command: '"$CLAUDE_PROJECT_DIR"/node_modules/.bin/some-hook',
              },
            ],
          },
        ],
      },
    };
    expect(validateNoTraversal(settings)).toEqual([]);
  });

  it('also flags raw `..` outside any variable expansion', () => {
    const settings: Settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: '../etc/foo.sh' }],
          },
        ],
      },
    };
    expect(validateNoTraversal(settings).length).toBe(1);
  });
});

describe('findMissingReaHooks — cross-check against EXPECTED_HOOKS', () => {
  it('reports the full EXPECTED_HOOKS list as missing from an empty settings', () => {
    const result = validateSettings({ hooks: {} });
    expect(result.parsed).toBe(true);
    expect(result.missingReaHooks.length).toBeGreaterThan(0);
    // delegation-capture is in EXPECTED_HOOKS (0.29.0+) and must show
    // up missing here — regression pin for the 0.29.0 drift closure
    // (item C in the 0.30.0 charter).
    expect(result.missingReaHooks).toContain('delegation-capture.sh');
  });

  it('canonical .claude/settings.json from this repo has zero missing hooks (Class M dogfood pin)', () => {
    const settingsPath = path.join(REPO_ROOT, '.claude', 'settings.json');
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const result = validateSettings(raw);
    // If this assert ever fails, it means either:
    //   - someone added a hook to EXPECTED_HOOKS without registering it
    //     in `.claude/settings.json` (regression — the 0.29.0 drift
    //     closure pattern repeats)
    //   - OR someone removed a hook entry from `.claude/settings.json`
    //     without removing it from EXPECTED_HOOKS (likewise).
    // Both are bugs the maintainer should fix before merging.
    expect(result.missingReaHooks).toEqual([]);
  });

  it('explicitly flags delegation-capture.sh when it has been removed (regression pin for C)', () => {
    // Synthesize the canonical settings minus the Agent|Skill matcher
    // group. This is the EXACT drift state the 0.29.0 release left
    // in the dogfood install before 0.30.0 closed it; the schema check
    // must surface it loudly.
    const settingsPath = path.join(REPO_ROOT, '.claude', 'settings.json');
    const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as Settings;
    const stripped: Settings = {
      ...raw,
      hooks: {
        ...raw.hooks,
        PreToolUse: (raw.hooks?.PreToolUse ?? []).filter((g) => g.matcher !== 'Agent|Skill'),
      },
    };
    const result = validateSettings(stripped);
    expect(result.parsed).toBe(true);
    expect(result.missingReaHooks).toContain('delegation-capture.sh');
  });
});

describe('expectedHookNames — exported helper', () => {
  it('returns a sorted list including every default hook', () => {
    const names = expectedHookNames();
    expect(names).toContain('dangerous-bash-interceptor.sh');
    expect(names).toContain('delegation-capture.sh');
    expect(names).toContain('secret-scanner.sh');
    // sorted
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });
});
