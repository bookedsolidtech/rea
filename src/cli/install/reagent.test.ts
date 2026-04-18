import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AutonomyLevel } from '../../policy/types.js';
import { ReagentDroppedFieldsError, translateReagentPolicy } from './reagent.js';

const SAFE_REAGENT = `autonomy_level: L1
max_autonomy_level: L2
promotion_requires_human_approval: true
block_ai_attribution: true
blocked_paths:
  - ".env"
  - ".env.*"
`;

const DROP_REAGENT = `autonomy_level: L1
max_autonomy_level: L2
push_review:
  enabled: true
security:
  required: true
`;

describe('translateReagentPolicy', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-reagent-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('translates safe fields cleanly', async () => {
    const p = path.join(dir, 'policy.yaml');
    await fs.writeFile(p, SAFE_REAGENT, 'utf8');
    const r = translateReagentPolicy(p, {
      profileCeiling: AutonomyLevel.L2,
      acceptDropped: false,
    });
    expect(r.translated.autonomy_level).toBe(AutonomyLevel.L1);
    expect(r.translated.max_autonomy_level).toBe(AutonomyLevel.L2);
    expect(r.translated.blocked_paths).toContain('.env');
    expect(r.droppedFields).toEqual([]);
  });

  it('refuses drop-list fields without --accept-dropped-fields', async () => {
    const p = path.join(dir, 'policy.yaml');
    await fs.writeFile(p, DROP_REAGENT, 'utf8');
    expect(() =>
      translateReagentPolicy(p, {
        profileCeiling: AutonomyLevel.L2,
        acceptDropped: false,
      }),
    ).toThrow(ReagentDroppedFieldsError);
  });

  it('accepts drop-list fields with --accept-dropped-fields and records notices', async () => {
    const p = path.join(dir, 'policy.yaml');
    await fs.writeFile(p, DROP_REAGENT, 'utf8');
    const r = translateReagentPolicy(p, {
      profileCeiling: AutonomyLevel.L2,
      acceptDropped: true,
    });
    expect(r.droppedFields).toEqual(expect.arrayContaining(['push_review', 'security']));
    expect(r.notices.some((n) => n.includes('push_review'))).toBe(true);
    expect(r.translated.autonomy_level).toBe(AutonomyLevel.L1);
  });

  it('clamps max_autonomy_level to profile ceiling', async () => {
    const p = path.join(dir, 'policy.yaml');
    await fs.writeFile(p, 'autonomy_level: L1\nmax_autonomy_level: L3\n', 'utf8');
    const r = translateReagentPolicy(p, {
      profileCeiling: AutonomyLevel.L2,
      acceptDropped: false,
    });
    expect(r.translated.max_autonomy_level).toBe(AutonomyLevel.L2);
    expect(r.clampedAutonomy).toBe(true);
    expect(r.notices.some((n) => n.includes('clamping max_autonomy_level'))).toBe(true);
  });

  it('clamps autonomy_level if it now exceeds the clamped ceiling', async () => {
    const p = path.join(dir, 'policy.yaml');
    await fs.writeFile(p, 'autonomy_level: L3\nmax_autonomy_level: L3\n', 'utf8');
    const r = translateReagentPolicy(p, {
      profileCeiling: AutonomyLevel.L1,
      acceptDropped: false,
    });
    expect(r.translated.max_autonomy_level).toBe(AutonomyLevel.L1);
    expect(r.translated.autonomy_level).toBe(AutonomyLevel.L1);
  });
});
