/**
 * Unit tests for `parsePostToolUsePayload` (0.51.0 — billing→HALT gate).
 *
 * The PostToolUse parser is distinct from `parseHookPayload` in that it
 * ALSO captures the tool's OUTPUT (`tool_response`), which is where a
 * billing-class signature almost always lands. These tests pin the
 * command + output extraction, the fail-closed posture on the command
 * field, and the LENIENT posture on the output field.
 */

import { describe, expect, it } from 'vitest';
import {
  parsePostToolUsePayload,
  MalformedPayloadError,
  TypePayloadError,
} from './payload.js';

describe('parsePostToolUsePayload', () => {
  it('empty stdin → all-empty', () => {
    const r = parsePostToolUsePayload('');
    expect(r).toEqual({ toolName: '', command: '', output: '' });
  });

  it('top-level null → all-empty (mirrors jq // "")', () => {
    const r = parsePostToolUsePayload('null');
    expect(r).toEqual({ toolName: '', command: '', output: '' });
  });

  it('extracts command + stdout/stderr from an object tool_response', () => {
    const raw = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'node tts.mjs' },
      tool_response: { stdout: 'ok', stderr: 'spending cap exceeded' },
    });
    const r = parsePostToolUsePayload(raw);
    expect(r.toolName).toBe('Bash');
    expect(r.command).toBe('node tts.mjs');
    expect(r.output).toContain('spending cap exceeded');
    expect(r.output).toContain('ok');
  });

  it('accepts a bare-string tool_response', () => {
    const raw = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'x' },
      tool_response: 'prepayment credits are depleted',
    });
    const r = parsePostToolUsePayload(raw);
    expect(r.output).toBe('prepayment credits are depleted');
  });

  it('joins recognized keys in stable order (stdout, stderr, output, content)', () => {
    const raw = JSON.stringify({
      tool_input: { command: 'c' },
      tool_response: { content: 'D', output: 'C', stderr: 'B', stdout: 'A' },
    });
    const r = parsePostToolUsePayload(raw);
    expect(r.output).toBe('A\nB\nC\nD');
  });

  it('missing tool_response → empty output, command still present', () => {
    const raw = JSON.stringify({ tool_input: { command: 'echo hi' } });
    const r = parsePostToolUsePayload(raw);
    expect(r.command).toBe('echo hi');
    expect(r.output).toBe('');
  });

  it('LENIENT on a non-string/object tool_response (number) → empty output, no throw', () => {
    const raw = JSON.stringify({ tool_input: { command: 'c' }, tool_response: 42 });
    const r = parsePostToolUsePayload(raw);
    expect(r.output).toBe('');
    expect(r.command).toBe('c');
  });

  it('LENIENT on an array tool_response → empty output, no throw', () => {
    const raw = JSON.stringify({ tool_input: { command: 'c' }, tool_response: ['a', 'b'] });
    const r = parsePostToolUsePayload(raw);
    expect(r.output).toBe('');
  });

  it('skips non-string leaves inside the tool_response object', () => {
    const raw = JSON.stringify({
      tool_input: { command: 'c' },
      tool_response: { stdout: 'keep', stderr: 99, output: null },
    });
    const r = parsePostToolUsePayload(raw);
    expect(r.output).toBe('keep');
  });

  it('FAIL-CLOSED: malformed JSON throws MalformedPayloadError', () => {
    expect(() => parsePostToolUsePayload('{not json')).toThrow(MalformedPayloadError);
  });

  it('FAIL-CLOSED: top-level array throws MalformedPayloadError', () => {
    expect(() => parsePostToolUsePayload('[1,2]')).toThrow(MalformedPayloadError);
  });

  it('FAIL-CLOSED: non-string command throws TypePayloadError', () => {
    const raw = JSON.stringify({ tool_input: { command: ['rm', '-rf'] } });
    expect(() => parsePostToolUsePayload(raw)).toThrow(TypePayloadError);
  });

  it('FAIL-CLOSED: non-object tool_input throws TypePayloadError', () => {
    const raw = JSON.stringify({ tool_input: 'oops' });
    expect(() => parsePostToolUsePayload(raw)).toThrow(TypePayloadError);
  });
});
