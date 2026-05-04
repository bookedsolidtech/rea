/**
 * Class M (long-tracked from 0.15.0 audit, 0.19.0 close): JSON-schema
 * validation for `.claude/settings.json` produced by `settings-merge.ts`.
 *
 * Anthropic's Claude Code documents the hook-config shape for
 * `.claude/settings.json`:
 *
 *   {
 *     "hooks": {
 *       "<EventName>": [
 *         {
 *           "matcher": "<glob-or-tool-list>",
 *           "hooks": [
 *             { "type": "command", "command": "<shell>", "timeout"?: <ms>,
 *               "statusMessage"?: "<short progress label>" }
 *           ]
 *         }
 *       ]
 *     }
 *   }
 *
 * This test asserts that every settings shape produced by rea's installer
 * conforms. Catches schema-drift in matcher group registrations,
 * misplaced fields (e.g. `command:` at the matcher level instead of
 * inside the inner `hooks[]` array), and unknown event names.
 *
 * The validator is intentionally CLOSED (`additionalProperties: false`)
 * so a typo like `"matchers"` (plural) fails loudly rather than being
 * silently ignored by Claude Code at runtime.
 */

import Ajv, { type JSONSchemaType } from 'ajv';
import { describe, expect, it } from 'vitest';

import { defaultDesiredHooks, mergeSettings } from '../../src/cli/install/settings-merge.js';

interface HookEntry {
  type: 'command';
  command: string;
  timeout?: number;
  statusMessage?: string;
}

interface MatcherGroup {
  matcher: string;
  hooks: HookEntry[];
}

interface HookConfigDocument {
  hooks?: {
    PreToolUse?: MatcherGroup[];
    PostToolUse?: MatcherGroup[];
    UserPromptSubmit?: MatcherGroup[];
    SessionStart?: MatcherGroup[];
    SessionEnd?: MatcherGroup[];
    Stop?: MatcherGroup[];
    SubagentStop?: MatcherGroup[];
    PreCompact?: MatcherGroup[];
    Notification?: MatcherGroup[];
  };
  // Other top-level Claude Code settings keys — we don't validate them
  // here, but we also don't reject them (a real settings.json has more).
  [key: string]: unknown;
}

const HookEntrySchema: JSONSchemaType<HookEntry> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    type: { type: 'string', const: 'command' },
    command: { type: 'string', minLength: 1 },
    timeout: { type: 'number', nullable: true, minimum: 1 },
    statusMessage: { type: 'string', nullable: true, minLength: 1 },
  },
  required: ['type', 'command'],
};

const MatcherGroupSchema: JSONSchemaType<MatcherGroup> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    matcher: { type: 'string', minLength: 1 },
    hooks: {
      type: 'array',
      items: HookEntrySchema,
      minItems: 1,
    },
  },
  required: ['matcher', 'hooks'],
};

// Each known event accepts an array of MatcherGroup. additionalProperties
// is FALSE on the `hooks` object so a typo like "PreToolUseE" surfaces.
const HookConfigSchema = {
  type: 'object',
  properties: {
    hooks: {
      type: 'object',
      additionalProperties: false,
      properties: {
        PreToolUse: { type: 'array', items: MatcherGroupSchema },
        PostToolUse: { type: 'array', items: MatcherGroupSchema },
        UserPromptSubmit: { type: 'array', items: MatcherGroupSchema },
        SessionStart: { type: 'array', items: MatcherGroupSchema },
        SessionEnd: { type: 'array', items: MatcherGroupSchema },
        Stop: { type: 'array', items: MatcherGroupSchema },
        SubagentStop: { type: 'array', items: MatcherGroupSchema },
        PreCompact: { type: 'array', items: MatcherGroupSchema },
        Notification: { type: 'array', items: MatcherGroupSchema },
      },
    },
  },
  // Top-level allows other Claude Code settings (theme, model, env, etc.)
  // through unchanged.
} as const;

// 0.19.0 code-reviewer P3-7: `strict: false` because the schema uses
// `nullable: true` (OpenAPI flavor) and ajv@8 in strict mode emits
// warnings for any non-standard keyword. The schema is pinned to JSON
// Schema 2019-09 + nullable; tests stay deterministic with strict
// mode off.
const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(HookConfigSchema);

function buildSettingsFromDefaults(): HookConfigDocument {
  // Empty starting settings → merge in rea's defaultDesiredHooks → returns
  // the merged document. This is the same call path `rea init` walks.
  return mergeSettings({}, defaultDesiredHooks()).merged as HookConfigDocument;
}

describe('Class M — .claude/settings.json conforms to Claude Code hook-config schema', () => {
  it('default rea install produces a schema-valid document', () => {
    const doc = buildSettingsFromDefaults();
    const ok = validate(doc);
    if (!ok) {
      const errs = (validate.errors ?? [])
        .map((e) => `  ${e.instancePath || '/'}: ${e.message}`)
        .join('\n');
      throw new Error(`settings.json failed schema validation:\n${errs}`);
    }
    expect(ok).toBe(true);
  });

  it('every PreToolUse group has a non-empty matcher and at least one hook', () => {
    const doc = buildSettingsFromDefaults();
    const groups = doc.hooks?.PreToolUse ?? [];
    expect(groups.length).toBeGreaterThan(0);
    for (const g of groups) {
      expect(g.matcher.length).toBeGreaterThan(0);
      expect(g.hooks.length).toBeGreaterThan(0);
      for (const h of g.hooks) {
        expect(h.type).toBe('command');
        expect(h.command.length).toBeGreaterThan(0);
      }
    }
  });

  it('rejects misnamed event keys (typo guard)', () => {
    const bad = {
      hooks: {
        PreToolUseE: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo x' }] }],
      },
    };
    expect(validate(bad)).toBe(false);
    expect(validate.errors?.some((e) => e.keyword === 'additionalProperties')).toBe(true);
  });

  it('rejects matcher group without hooks array', () => {
    const bad = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash' } as MatcherGroup],
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it('rejects hook entry missing command', () => {
    const bad = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command' } as HookEntry] },
        ],
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it('rejects unknown hook entry type (only `command` is allowed)', () => {
    const bad = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'shell', command: 'echo x' } as unknown as HookEntry],
          },
        ],
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it('rejects timeout <= 0', () => {
    const bad = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: 'echo x', timeout: 0 }],
          },
        ],
      },
    };
    expect(validate(bad)).toBe(false);
  });

  it('every shipped hook command path is non-empty and references .claude/hooks/', () => {
    const doc = buildSettingsFromDefaults();
    for (const ev of Object.values(doc.hooks ?? {})) {
      for (const g of ev as MatcherGroup[]) {
        for (const h of g.hooks) {
          expect(h.command).toMatch(/\.claude\/hooks\//);
        }
      }
    }
  });
});
