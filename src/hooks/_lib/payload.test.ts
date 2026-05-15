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
  parseWriteHookPayload,
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

describe('parseWriteHookPayload', () => {
  it('returns blank for empty string', () => {
    expect(parseWriteHookPayload('')).toEqual({
      toolName: '',
      filePath: '',
      content: '',
    });
  });

  it('throws MalformedPayloadError on bad JSON', () => {
    expect(() => parseWriteHookPayload('{not')).toThrow(MalformedPayloadError);
  });

  it('extracts Write content', () => {
    const r = parseWriteHookPayload(
      JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: '/a/b.md', content: 'hello' },
      }),
    );
    expect(r).toEqual({ toolName: 'Write', filePath: '/a/b.md', content: 'hello' });
  });

  it('extracts Edit new_string', () => {
    const r = parseWriteHookPayload(
      JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: '/a/b.md', new_string: 'updated' },
      }),
    );
    expect(r.content).toBe('updated');
  });

  it('extracts MultiEdit edits joined by \\n', () => {
    const r = parseWriteHookPayload(
      JSON.stringify({
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: '/a/b.md',
          edits: [
            { old_string: 'x', new_string: 'fragment1' },
            { old_string: 'y', new_string: 'fragment2' },
          ],
        },
      }),
    );
    expect(r.content).toBe('fragment1\nfragment2');
  });

  it('extracts NotebookEdit new_source', () => {
    const r = parseWriteHookPayload(
      JSON.stringify({
        tool_name: 'NotebookEdit',
        tool_input: { notebook_path: '/a/n.ipynb', new_source: 'cell body' },
      }),
    );
    expect(r).toEqual({
      toolName: 'NotebookEdit',
      filePath: '/a/n.ipynb',
      content: 'cell body',
    });
  });

  it('content priority: content > new_string > edits > new_source', () => {
    // When multiple fields are present, content wins. Mirrors the bash
    // helper's elif-cascade.
    const r = parseWriteHookPayload(
      JSON.stringify({
        tool_name: 'Write',
        tool_input: {
          file_path: '/a',
          content: 'WIN',
          new_string: 'lose',
          edits: [{ new_string: 'lose' }],
          new_source: 'lose',
        },
      }),
    );
    expect(r.content).toBe('WIN');
  });

  it('fails closed on non-string file_path', () => {
    expect(() =>
      parseWriteHookPayload(
        JSON.stringify({ tool_name: 'Write', tool_input: { file_path: 42 } }),
      ),
    ).toThrow(TypePayloadError);
  });

  it('handles MultiEdit fragments with non-string new_string defensively', () => {
    const r = parseWriteHookPayload(
      JSON.stringify({
        tool_name: 'MultiEdit',
        tool_input: {
          file_path: '/a',
          edits: [{ new_string: 'ok' }, { new_string: 42 }, { new_string: 'fine' }],
        },
      }),
    );
    // Non-string fragments collapse to '' rather than throwing —
    // matches bash payload-read.sh `// "" | tostring`.
    expect(r.content).toBe('ok\n\nfine');
  });
});
