/**
 * Tests for the `rea.delegation_signal` event-shape module (0.29.0).
 *
 * Coverage targets:
 *   - schema_version literal is enforced on every parsed record.
 *   - strict-mode zod rejects unknown fields.
 *   - delegation_tool union is exactly Agent | Skill.
 *   - SHA-256 field-format guard rejects non-hex / wrong-length values.
 *   - Re-exports from `src/audit/append.ts` resolve correctly.
 */

import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DELEGATION_SIGNAL_TOOL_NAME,
  DELEGATION_SIGNAL_SERVER_NAME,
  DELEGATION_SIGNAL_SCHEMA_VERSION,
  DelegationSignalMetadataSchema,
} from '../../src/audit/delegation-event.js';
import * as appendReexports from '../../src/audit/append.js';

describe('delegation-event constants', () => {
  it('exposes the canonical tool_name literal', () => {
    expect(DELEGATION_SIGNAL_TOOL_NAME).toBe('rea.delegation_signal');
  });
  it('exposes the canonical server_name literal', () => {
    expect(DELEGATION_SIGNAL_SERVER_NAME).toBe('claude-code-hooks');
  });
  it('exposes schema_version literal 1', () => {
    expect(DELEGATION_SIGNAL_SCHEMA_VERSION).toBe(1);
  });
});

describe('DelegationSignalMetadataSchema — strict-mode parsing', () => {
  const validRecord = {
    schema_version: 1 as const,
    delegation_tool: 'Agent' as const,
    subagent_type: 'rea-orchestrator',
    session_id_observed: 'session-123',
    parent_subagent_type: null,
    invocation_description_sha256: crypto
      .createHash('sha256')
      .update('hello')
      .digest('hex'),
  };

  it('accepts a valid v1 record', () => {
    const r = DelegationSignalMetadataSchema.safeParse(validRecord);
    expect(r.success).toBe(true);
  });

  it('accepts a valid Skill record', () => {
    const r = DelegationSignalMetadataSchema.safeParse({
      ...validRecord,
      delegation_tool: 'Skill',
      subagent_type: 'deep-dive',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a valid record with parent_subagent_type set', () => {
    const r = DelegationSignalMetadataSchema.safeParse({
      ...validRecord,
      parent_subagent_type: 'rea-orchestrator',
    });
    expect(r.success).toBe(true);
  });

  it('accepts hook_event_timestamp when present', () => {
    const r = DelegationSignalMetadataSchema.safeParse({
      ...validRecord,
      hook_event_timestamp: '2026-05-12T21:30:00Z',
    });
    expect(r.success).toBe(true);
  });

  it('REJECTS schema_version other than 1', () => {
    const r = DelegationSignalMetadataSchema.safeParse({ ...validRecord, schema_version: 2 });
    expect(r.success).toBe(false);
  });

  it('REJECTS delegation_tool outside the Agent|Skill union', () => {
    const r = DelegationSignalMetadataSchema.safeParse({
      ...validRecord,
      delegation_tool: 'Task',
    });
    expect(r.success).toBe(false);
  });

  it('REJECTS Task (must be Agent|Skill — the tool was renamed)', () => {
    const r = DelegationSignalMetadataSchema.safeParse({
      ...validRecord,
      delegation_tool: 'TaskCreate',
    });
    expect(r.success).toBe(false);
  });

  it('REJECTS non-hex invocation_description_sha256', () => {
    const r = DelegationSignalMetadataSchema.safeParse({
      ...validRecord,
      invocation_description_sha256: 'not-a-sha-256-digest-just-an-error',
    });
    expect(r.success).toBe(false);
  });

  it('REJECTS wrong-length invocation_description_sha256', () => {
    const r = DelegationSignalMetadataSchema.safeParse({
      ...validRecord,
      // 32 hex chars (MD5 length, half a SHA-256).
      invocation_description_sha256: 'd41d8cd98f00b204e9800998ecf8427e',
    });
    expect(r.success).toBe(false);
  });

  it('REJECTS unknown fields under strict mode', () => {
    const r = DelegationSignalMetadataSchema.safeParse({
      ...validRecord,
      future_field: 'sneaky-v2-payload',
    });
    expect(r.success).toBe(false);
  });

  it('REJECTS missing subagent_type', () => {
    const incomplete: Record<string, unknown> = { ...validRecord };
    delete incomplete['subagent_type'];
    const r = DelegationSignalMetadataSchema.safeParse(incomplete);
    expect(r.success).toBe(false);
  });

  it('REJECTS parent_subagent_type with wrong type (number)', () => {
    const r = DelegationSignalMetadataSchema.safeParse({
      ...validRecord,
      parent_subagent_type: 42,
    });
    expect(r.success).toBe(false);
  });
});

describe('SHA-256 hashing of description — privacy invariant', () => {
  it('produces deterministic 64-char lowercase hex digest', () => {
    const sample = 'Plan the 0.30.0 release';
    const hash = crypto.createHash('sha256').update(sample).digest('hex');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Determinism: two hashes of the same string match.
    const hash2 = crypto.createHash('sha256').update(sample).digest('hex');
    expect(hash).toBe(hash2);
    // Schema accepts it.
    const r = DelegationSignalMetadataSchema.safeParse({
      schema_version: 1,
      delegation_tool: 'Agent',
      subagent_type: 'agent-x',
      session_id_observed: 's',
      parent_subagent_type: null,
      invocation_description_sha256: hash,
    });
    expect(r.success).toBe(true);
  });

  it('empty-string hash matches the well-known SHA-256 constant', () => {
    const hash = crypto.createHash('sha256').update('').digest('hex');
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

describe('src/audit/append.ts re-exports', () => {
  it('re-exports DELEGATION_SIGNAL_TOOL_NAME', () => {
    expect(appendReexports.DELEGATION_SIGNAL_TOOL_NAME).toBe('rea.delegation_signal');
  });
  it('re-exports DELEGATION_SIGNAL_SERVER_NAME', () => {
    expect(appendReexports.DELEGATION_SIGNAL_SERVER_NAME).toBe('claude-code-hooks');
  });
  it('re-exports DELEGATION_SIGNAL_SCHEMA_VERSION', () => {
    expect(appendReexports.DELEGATION_SIGNAL_SCHEMA_VERSION).toBe(1);
  });
  it('re-exports DelegationSignalMetadataSchema', () => {
    expect(typeof appendReexports.DelegationSignalMetadataSchema.safeParse).toBe('function');
  });
});
