/**
 * Defect P regression — emission_source discriminator for audit records.
 *
 * These tests pin down the three invariants that close the
 * `appendAuditRecord()` forgery surface:
 *
 *   1. The public `appendAuditRecord()` helper stamps `emission_source:
 *      "other"` on every record. External consumers cannot self-assert
 *      "rea-cli" through this entry point (the field is NOT part of the
 *      public AppendAuditInput shape).
 *
 *   2. The dedicated `appendCodexReviewAuditRecord()` helper stamps
 *      `"rea-cli"` and forces the canonical tool_name / server_name so
 *      callers cannot route a generic record through the codex-certification
 *      path by accident or on purpose.
 *
 *   3. The hash chain includes `emission_source` in its computed hash, so
 *      the field cannot be altered post-hoc without breaking the chain.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendAuditRecord,
  appendCodexReviewAuditRecord,
  CODEX_REVIEW_SERVER_NAME,
  CODEX_REVIEW_TOOL_NAME,
  type AuditRecord,
} from './append.js';
import { computeHash } from './fs.js';

describe('emission_source — public appendAuditRecord stamps "other"', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-emission-src-')));
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('stamps emission_source: "other" on every record written through the public helper', async () => {
    const rec = await appendAuditRecord(baseDir, {
      tool_name: 'helix.plan',
      server_name: 'helix',
    });
    expect(rec.emission_source).toBe('other');

    const raw = await fs.readFile(path.join(baseDir, '.rea', 'audit.jsonl'), 'utf8');
    const parsed = JSON.parse(raw.trim()) as AuditRecord;
    expect(parsed.emission_source).toBe('other');
  });

  it('stamps "other" even when the tool_name is codex.review — forgery through the generic helper is visible to the gate', async () => {
    const rec = await appendAuditRecord(baseDir, {
      tool_name: CODEX_REVIEW_TOOL_NAME,
      server_name: CODEX_REVIEW_SERVER_NAME,
      metadata: { head_sha: 'deadbeef', verdict: 'pass' },
    });
    expect(rec.tool_name).toBe('codex.review');
    expect(rec.emission_source).toBe('other');
  });
});

describe('emission_source — appendCodexReviewAuditRecord stamps "rea-cli"', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-emission-codex-')));
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('stamps "rea-cli" and the canonical tool_name/server_name — the helper does not accept caller overrides', async () => {
    const rec = await appendCodexReviewAuditRecord(baseDir, {
      metadata: { head_sha: 'cafef00d', verdict: 'pass' },
    });
    expect(rec.emission_source).toBe('rea-cli');
    expect(rec.tool_name).toBe('codex.review');
    expect(rec.server_name).toBe('codex');
  });

  it('persists emission_source: "rea-cli" to disk so the jq gate predicate matches', async () => {
    await appendCodexReviewAuditRecord(baseDir, {
      metadata: { head_sha: 'abc', verdict: 'pass' },
    });
    const raw = await fs.readFile(path.join(baseDir, '.rea', 'audit.jsonl'), 'utf8');
    const parsed = JSON.parse(raw.trim()) as AuditRecord;
    expect(parsed.emission_source).toBe('rea-cli');
    expect(parsed.tool_name).toBe(CODEX_REVIEW_TOOL_NAME);
  });
});

describe('emission_source — hash chain integrity', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'rea-emission-hash-')));
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('includes emission_source in the computed hash — flipping the field breaks the chain', async () => {
    const record = await appendAuditRecord(baseDir, {
      tool_name: 'any',
      server_name: 'unit',
    });
    const { hash: _hash, ...baseFields } = record;
    void _hash;
    expect(computeHash(baseFields)).toBe(record.hash);
    // Flipping emission_source MUST produce a different hash — i.e. the field
    // is part of the hashed recordBase, not an afterthought.
    const forged = { ...baseFields, emission_source: 'rea-cli' as const };
    expect(computeHash(forged)).not.toBe(record.hash);
  });
});
