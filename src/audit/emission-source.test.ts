/**
 * `emission_source` — audit record provenance discriminator.
 *
 * The 0.11.0 stateless push-gate no longer consults `emission_source` to
 * decide pass/fail — Codex is re-run on every push, so there is no receipt
 * to verify. The field is retained in the hash chain for forensic analysis
 * ("which writer produced this line?") and to avoid a breaking
 * AuditRecord schema change.
 *
 * These tests pin down two remaining invariants:
 *
 *   1. The public `appendAuditRecord()` helper stamps `emission_source:
 *      "other"` on every record. `"rea-cli"` and `"codex-cli"` are NOT
 *      accepted as caller inputs (the field is not part of the public
 *      {@link AppendAuditInput} shape).
 *
 *   2. The hash chain includes `emission_source` in its computed hash, so
 *      the field cannot be altered post-hoc without breaking the chain.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendAuditRecord,
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

  it('stamps "other" even when the tool_name is codex.review — no caller can self-assert "rea-cli" through the public helper', async () => {
    const rec = await appendAuditRecord(baseDir, {
      tool_name: CODEX_REVIEW_TOOL_NAME,
      server_name: CODEX_REVIEW_SERVER_NAME,
      metadata: { head_sha: 'deadbeef', verdict: 'pass' },
    });
    expect(rec.tool_name).toBe('codex.review');
    expect(rec.emission_source).toBe('other');
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
