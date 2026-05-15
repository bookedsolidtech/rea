/**
 * Unit tests for `src/hooks/_lib/payload.ts`.
 *
 * Coverage focus:
 *   - Empty / whitespace stdin → blank payload (matches bash hooks)
 *   - Top-level `null` → blank payload (mirrors `jq // ""` behavior)
 *   - Top-level non-object (`42`, `"str"`, `[]`) → MalformedPayloadError
 *   - Missing `tool_input` → blank command
 *   - `tool_input.command` non-string → TypePayloadError (no silent coerce)
 *   - Valid payload round-trips
 *   - Buffer input is decoded
 */

import { describe, it, expect } from 'vitest';
import {
  parseHookPayload,
  MalformedPayloadError,
  TypePayloadError,
} from './payload.js';

describe('parseHookPayload', () => {
  it('returns blank payload for empty string', () => {
    expect(parseHookPayload('')).toEqual({ toolName: '', command: '' });
  });

  it('returns blank payload for whitespace-only string', () => {
    expect(parseHookPayload('   \n\t  \n')).toEqual({
      toolName: '',
      command: '',
    });
  });

  it('returns blank payload for top-level null', () => {
    expect(parseHookPayload('null')).toEqual({ toolName: '', command: '' });
  });

  it('throws MalformedPayloadError for top-level number', () => {
    expect(() => parseHookPayload('42')).toThrow(MalformedPayloadError);
  });

  it('throws MalformedPayloadError for top-level string', () => {
    expect(() => parseHookPayload('"hello"')).toThrow(MalformedPayloadError);
  });

  it('throws MalformedPayloadError for top-level array', () => {
    expect(() => parseHookPayload('[1,2,3]')).toThrow(MalformedPayloadError);
  });

  it('throws MalformedPayloadError for non-JSON garbage', () => {
    expect(() => parseHookPayload('{not json')).toThrow(MalformedPayloadError);
  });

  it('extracts tool_name and tool_input.command from valid payload', () => {
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'gh pr create --title foo' },
    });
    expect(parseHookPayload(payload)).toEqual({
      toolName: 'Bash',
      command: 'gh pr create --title foo',
    });
  });

  it('returns blank command when tool_input is absent', () => {
    const payload = JSON.stringify({ tool_name: 'Bash' });
    expect(parseHookPayload(payload)).toEqual({
      toolName: 'Bash',
      command: '',
    });
  });

  it('returns blank command when tool_input is null', () => {
    const payload = JSON.stringify({ tool_name: 'Bash', tool_input: null });
    expect(parseHookPayload(payload)).toEqual({
      toolName: 'Bash',
      command: '',
    });
  });

  it('returns blank command when tool_input.command is absent', () => {
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { other: 'x' },
    });
    expect(parseHookPayload(payload)).toEqual({
      toolName: 'Bash',
      command: '',
    });
  });

  it('returns blank toolName when tool_name is absent', () => {
    const payload = JSON.stringify({ tool_input: { command: 'foo' } });
    expect(parseHookPayload(payload)).toEqual({
      toolName: '',
      command: 'foo',
    });
  });

  it('returns blank toolName when tool_name is non-string', () => {
    // Mirrors `jq -r '.tool_name // ""'` coercing non-string fields to ''.
    // This is the safe direction: a wrong-type tool_name shouldn't make
    // the hook misroute, just degrade to "we don't know what tool".
    const payload = JSON.stringify({
      tool_name: 42,
      tool_input: { command: 'foo' },
    });
    expect(parseHookPayload(payload)).toEqual({
      toolName: '',
      command: 'foo',
    });
  });

  it('throws TypePayloadError when tool_input.command is array', () => {
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: ['rm', '-rf'] },
    });
    expect(() => parseHookPayload(payload)).toThrow(TypePayloadError);
  });

  it('throws TypePayloadError when tool_input.command is number', () => {
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 42 },
    });
    expect(() => parseHookPayload(payload)).toThrow(TypePayloadError);
  });

  it('throws TypePayloadError when tool_input.command is object', () => {
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: { nested: 'x' } },
    });
    expect(() => parseHookPayload(payload)).toThrow(TypePayloadError);
  });

  it('throws TypePayloadError when tool_input is non-object scalar', () => {
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: 'string',
    });
    expect(() => parseHookPayload(payload)).toThrow(TypePayloadError);
  });

  it('decodes Buffer input as utf8', () => {
    const payload = Buffer.from(
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      }),
      'utf8',
    );
    expect(parseHookPayload(payload)).toEqual({
      toolName: 'Bash',
      command: 'echo hi',
    });
  });

  it('preserves the literal command bytes including newlines + quotes', () => {
    const cmd = 'git commit -m "line one\nline two\n  fixes #123"';
    const payload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: cmd },
    });
    expect(parseHookPayload(payload).command).toBe(cmd);
  });
});
