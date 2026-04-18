/**
 * Rotator tests (G1) — rotation boundary + hash-chain continuity.
 *
 * The marker record that seeds each fresh `audit.jsonl` is the subtlest part
 * of the rotation design: its `prev_hash` MUST equal the hash of the last
 * record in the rotated file, so that an operator verifying the chain via
 * `rea audit verify --since <rotated>` sees an unbroken walk across the
 * rotation boundary.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendAuditRecord } from '../../audit/append.js';
import type { AuditRecord } from '../middleware/audit-types.js';
import type { Policy } from '../../policy/types.js';
import {
  AutonomyLevel,
  InvocationStatus,
  Tier,
} from '../../policy/types.js';
import {
  DEFAULT_MAX_BYTES,
  ROTATION_TOOL_NAME,
  _effectiveThresholds,
  forceRotate,
  maybeRotate,
  performRotation,
  rotationFilename,
  shouldRotate,
} from './rotator.js';

function makePolicy(audit?: Policy['audit']): Policy {
  return {
    version: '1',
    profile: 'test',
    installed_by: 'test',
    installed_at: '2026-04-18T00:00:00Z',
    autonomy_level: AutonomyLevel.L1,
    max_autonomy_level: AutonomyLevel.L2,
    promotion_requires_human_approval: true,
    block_ai_attribution: true,
    blocked_paths: [],
    notification_channel: '',
    ...(audit !== undefined ? { audit } : {}),
  };
}

async function readLines(file: string): Promise<AuditRecord[]> {
  const raw = await fs.readFile(file, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as AuditRecord);
}

describe('rotator — thresholds and filename formatting', () => {
  it('effectiveThresholds returns undefined/undefined when policy omits audit.rotation', () => {
    expect(_effectiveThresholds(undefined)).toEqual({
      maxBytes: undefined,
      maxAgeMs: undefined,
    });
    expect(_effectiveThresholds(makePolicy())).toEqual({
      maxBytes: undefined,
      maxAgeMs: undefined,
    });
  });

  it('effectiveThresholds defaults when audit.rotation is an empty block', () => {
    const t = _effectiveThresholds(makePolicy({ rotation: {} }));
    expect(t.maxBytes).toBe(DEFAULT_MAX_BYTES);
    expect(t.maxAgeMs).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('effectiveThresholds honors operator-supplied knobs', () => {
    const t = _effectiveThresholds(
      makePolicy({ rotation: { max_bytes: 1024, max_age_days: 7 } }),
    );
    expect(t.maxBytes).toBe(1024);
    expect(t.maxAgeMs).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('rotationFilename emits zero-padded UTC components', () => {
    const name = rotationFilename(new Date('2026-01-02T03:04:05Z'));
    expect(name).toBe('audit-20260102-030405.jsonl');
  });
});

describe('rotator — shouldRotate decisions', () => {
  let baseDir: string;
  let auditFile: string;

  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-rotator-')));
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
    auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('returns false when both thresholds are undefined', async () => {
    await fs.writeFile(auditFile, 'x'.repeat(10 * 1024 * 1024) + '\n');
    const due = await shouldRotate(auditFile, {
      maxBytes: undefined,
      maxAgeMs: undefined,
    });
    expect(due).toBe(false);
  });

  it('returns false on a missing file', async () => {
    const due = await shouldRotate(auditFile, { maxBytes: 10, maxAgeMs: undefined });
    expect(due).toBe(false);
  });

  it('returns false on an empty file (rotating empty would anchor on genesis)', async () => {
    await fs.writeFile(auditFile, '');
    const due = await shouldRotate(auditFile, { maxBytes: 1, maxAgeMs: undefined });
    expect(due).toBe(false);
  });

  it('returns true when size crosses max_bytes', async () => {
    await fs.writeFile(auditFile, 'x'.repeat(2000) + '\n');
    const due = await shouldRotate(auditFile, { maxBytes: 1024, maxAgeMs: undefined });
    expect(due).toBe(true);
  });

  it('returns true when first-record timestamp is older than max_age_ms', async () => {
    const oldRec = { timestamp: '2020-01-01T00:00:00Z', ok: true };
    await fs.writeFile(auditFile, JSON.stringify(oldRec) + '\n');
    const due = await shouldRotate(
      auditFile,
      { maxBytes: undefined, maxAgeMs: 24 * 60 * 60 * 1000 },
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(due).toBe(true);
  });
});

describe('rotator — performRotation preserves hash-chain continuity', () => {
  let baseDir: string;
  let auditFile: string;

  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-rotator-')));
    auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('renames the current file and seeds a marker record whose prev_hash is the old tail', async () => {
    // Build a short chain first via the public helper.
    for (let i = 0; i < 5; i++) {
      await appendAuditRecord(baseDir, {
        tool_name: 'seed',
        server_name: 'unit',
        metadata: { i },
      });
    }
    const pre = await readLines(auditFile);
    expect(pre).toHaveLength(5);
    const oldTailHash = pre[pre.length - 1]!.hash;

    const now = new Date('2026-04-18T12:34:56Z');
    const result = await performRotation(auditFile, now);
    expect(result.rotated).toBe(true);

    const rotatedPath = result.rotatedTo!;
    expect(path.basename(rotatedPath)).toBe('audit-20260418-123456.jsonl');

    // Rotated file content equals the pre-rotation chain.
    const rotated = await readLines(rotatedPath);
    expect(rotated).toHaveLength(5);
    expect(rotated[rotated.length - 1]!.hash).toBe(oldTailHash);

    // Fresh audit.jsonl holds EXACTLY one marker record.
    const fresh = await readLines(auditFile);
    expect(fresh).toHaveLength(1);
    const marker = fresh[0]!;
    expect(marker.tool_name).toBe(ROTATION_TOOL_NAME);
    expect(marker.prev_hash).toBe(oldTailHash); // chain bridge
    expect(marker.metadata?.rotated_from).toBe(path.basename(rotatedPath));
    expect(marker.metadata?.rotated_at).toBe(now.toISOString());
    expect(marker.tier).toBe(Tier.Read);
    expect(marker.status).toBe(InvocationStatus.Allowed);
    expect(marker.autonomy_level).toBe('system');
    // Marker self-hash is consistent.
    expect(typeof marker.hash).toBe('string');
    expect(marker.hash).toHaveLength(64);
  });

  it('is a no-op when the audit file is empty', async () => {
    await fs.mkdir(path.dirname(auditFile), { recursive: true });
    await fs.writeFile(auditFile, '');
    const result = await performRotation(auditFile);
    expect(result.rotated).toBe(false);
    const dirEntries = await fs.readdir(path.dirname(auditFile));
    // No rotated-* file should have been created.
    expect(dirEntries.filter((n) => n.startsWith('audit-'))).toHaveLength(0);
  });

  it('is a no-op when the audit file does not exist', async () => {
    // Directory exists; file does not. performRotation also mkdir's, which is
    // harmless — still should not create a rotated file.
    await fs.mkdir(path.dirname(auditFile), { recursive: true });
    const result = await performRotation(auditFile);
    expect(result.rotated).toBe(false);
  });

  it('picks a collision-free filename for same-second rotations', async () => {
    // Seed two tiny chains and rotate them both in the same logical second.
    for (let i = 0; i < 2; i++) {
      await appendAuditRecord(baseDir, { tool_name: 'a', server_name: 'u' });
    }
    const when = new Date('2026-04-18T12:34:56Z');
    const first = await performRotation(auditFile, when);
    expect(first.rotated).toBe(true);

    for (let i = 0; i < 2; i++) {
      await appendAuditRecord(baseDir, { tool_name: 'b', server_name: 'u' });
    }
    const second = await performRotation(auditFile, when);
    expect(second.rotated).toBe(true);

    // Two distinct rotated files.
    expect(first.rotatedTo).not.toBe(second.rotatedTo);
    expect(path.basename(second.rotatedTo!)).toMatch(
      /^audit-20260418-123456(-\d+)?\.jsonl$/,
    );
  });
});

describe('rotator — maybeRotate integrates policy thresholds', () => {
  let baseDir: string;
  let auditFile: string;

  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-rotator-')));
    auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
    await fs.mkdir(path.dirname(auditFile), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('no-op when policy is undefined (back-compat)', async () => {
    await fs.writeFile(auditFile, 'x'.repeat(10_000) + '\n');
    const result = await maybeRotate(auditFile, undefined);
    expect(result.rotated).toBe(false);
  });

  it('no-op when policy has no audit.rotation block (back-compat)', async () => {
    await fs.writeFile(auditFile, 'x'.repeat(10_000) + '\n');
    const result = await maybeRotate(auditFile, makePolicy());
    expect(result.rotated).toBe(false);
  });

  it('rotates when size trigger fires with real appended records', async () => {
    const policy = makePolicy({ rotation: { max_bytes: 1024 } });

    // Write until the live file crosses the 1 KiB threshold, then invoke
    // maybeRotate and verify the marker chains correctly.
    for (let i = 0; i < 30; i++) {
      await appendAuditRecord(baseDir, {
        tool_name: 'seed',
        server_name: 'unit',
        metadata: { i, pad: 'x'.repeat(40) },
      });
    }
    const preStat = await fs.stat(auditFile);
    expect(preStat.size).toBeGreaterThan(1024);

    const preLines = await readLines(auditFile);
    const oldTailHash = preLines[preLines.length - 1]!.hash;

    const result = await maybeRotate(auditFile, policy);
    expect(result.rotated).toBe(true);

    const freshLines = await readLines(auditFile);
    expect(freshLines).toHaveLength(1);
    expect(freshLines[0]!.tool_name).toBe(ROTATION_TOOL_NAME);
    expect(freshLines[0]!.prev_hash).toBe(oldTailHash);
    expect(freshLines[0]!.metadata?.rotated_from).toBe(
      path.basename(result.rotatedTo!),
    );
  });
});

describe('rotator — forceRotate (CLI path)', () => {
  let baseDir: string;
  let auditFile: string;

  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-rotator-')));
    auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('rotates regardless of thresholds', async () => {
    await appendAuditRecord(baseDir, { tool_name: 'one', server_name: 'u' });
    const result = await forceRotate(auditFile);
    expect(result.rotated).toBe(true);
  });

  it('empty file is still a no-op (rotating genesis is meaningless)', async () => {
    await fs.mkdir(path.dirname(auditFile), { recursive: true });
    await fs.writeFile(auditFile, '');
    const result = await forceRotate(auditFile);
    expect(result.rotated).toBe(false);
  });
});
