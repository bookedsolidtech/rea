/**
 * Unit tests for `parsePostToolUsePayload` (0.51.0 — billing→HALT gate).
 *
 * The parser splits `tool_response` into the `stderr` (error) and
 * `stdout` (benign) channels plus an `errored` failure flag, so the gate
 * can scan only the error surface. These tests pin channel extraction,
 * the failure-flag derivation, the fail-closed posture on the command
 * field, and the LENIENT posture on output.
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
    expect(r).toEqual({ toolName: '', command: '', stderr: '', stdout: '', errored: false });
  });

  it('top-level null → all-empty', () => {
    const r = parsePostToolUsePayload('null');
    expect(r).toEqual({ toolName: '', command: '', stderr: '', stdout: '', errored: false });
  });

  it('splits stdout and stderr into separate channels', () => {
    const raw = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'node tts.mjs' },
      tool_response: { stdout: 'ok', stderr: 'spending cap exceeded' },
    });
    const r = parsePostToolUsePayload(raw);
    expect(r.toolName).toBe('Bash');
    expect(r.command).toBe('node tts.mjs');
    expect(r.stderr).toBe('spending cap exceeded');
    expect(r.stdout).toBe('ok');
  });

  it('treats a bare-string tool_response as the benign stdout channel', () => {
    const raw = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'x' },
      tool_response: 'prepayment credits are depleted',
    });
    const r = parsePostToolUsePayload(raw);
    expect(r.stdout).toBe('prepayment credits are depleted');
    expect(r.stderr).toBe('');
    expect(r.errored).toBe(false);
  });

  it('joins stdout/output/content into the benign channel (stable order)', () => {
    const raw = JSON.stringify({
      tool_input: { command: 'c' },
      tool_response: { content: 'C', output: 'B', stdout: 'A' },
    });
    const r = parsePostToolUsePayload(raw);
    expect(r.stdout).toBe('A\nB\nC');
  });

  it('derives errored=true from is_error', () => {
    const raw = JSON.stringify({
      tool_input: { command: 'c' },
      tool_response: { stdout: '', stderr: 'boom', is_error: true },
    });
    expect(parsePostToolUsePayload(raw).errored).toBe(true);
  });

  it('derives errored=true from a non-zero numeric exit field', () => {
    for (const key of ['exit_code', 'exitCode', 'code', 'returncode', 'status']) {
      const raw = JSON.stringify({ tool_input: { command: 'c' }, tool_response: { [key]: 9 } });
      expect(parsePostToolUsePayload(raw).errored).toBe(true);
    }
  });

  it('exit field of 0 is NOT errored', () => {
    const raw = JSON.stringify({ tool_input: { command: 'c' }, tool_response: { exit_code: 0 } });
    expect(parsePostToolUsePayload(raw).errored).toBe(false);
  });

  it('derives errored=true from interrupted / string error', () => {
    expect(
      parsePostToolUsePayload(
        JSON.stringify({ tool_input: {}, tool_response: { interrupted: true } }),
      ).errored,
    ).toBe(true);
    expect(
      parsePostToolUsePayload(
        JSON.stringify({ tool_input: {}, tool_response: { error: 'nope' } }),
      ).errored,
    ).toBe(true);
  });

  it('missing tool_response → empty channels, command still present', () => {
    const raw = JSON.stringify({ tool_input: { command: 'echo hi' } });
    const r = parsePostToolUsePayload(raw);
    expect(r.command).toBe('echo hi');
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('');
    expect(r.errored).toBe(false);
  });

  it('LENIENT on a number/array tool_response → empty channels, no throw', () => {
    expect(
      parsePostToolUsePayload(JSON.stringify({ tool_input: { command: 'c' }, tool_response: 42 })),
    ).toMatchObject({ stderr: '', stdout: '', errored: false });
    expect(
      parsePostToolUsePayload(
        JSON.stringify({ tool_input: { command: 'c' }, tool_response: ['a'] }),
      ),
    ).toMatchObject({ stderr: '', stdout: '', errored: false });
  });

  it('skips non-string leaves inside the tool_response object', () => {
    const raw = JSON.stringify({
      tool_input: { command: 'c' },
      tool_response: { stdout: 'keep', stderr: 99, output: null },
    });
    const r = parsePostToolUsePayload(raw);
    expect(r.stdout).toBe('keep');
    expect(r.stderr).toBe('');
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
