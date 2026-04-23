import { describe, expect, it } from 'vitest';
import {
  CodexProtocolError,
  parseCodexJsonl,
} from './codex-runner.js';

describe('parseCodexJsonl', () => {
  it('extracts a single agent_message text from a minimal stream', () => {
    const stream = [
      JSON.stringify({ type: 'thread.started', thread_id: 'x' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: '1', type: 'agent_message', text: 'Looks good.' },
      }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    const r = parseCodexJsonl(stream);
    expect(r.reviewText).toBe('Looks good.');
    expect(r.eventCount).toBe(4);
  });

  it('concatenates multiple agent_message items across turns', () => {
    const stream = [
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'First message.' } }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Second message.' },
      }),
    ].join('\n');
    const r = parseCodexJsonl(stream);
    expect(r.reviewText).toContain('First message.');
    expect(r.reviewText).toContain('Second message.');
    // Separator should be a blank line for readability.
    expect(r.reviewText).toBe('First message.\n\nSecond message.');
  });

  it('ignores command_execution and other non-agent_message items', () => {
    const stream = [
      JSON.stringify({
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'git diff',
          aggregated_output: 'diff text',
          exit_code: 0,
          status: 'completed',
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'The final review.' },
      }),
    ].join('\n');
    const r = parseCodexJsonl(stream);
    expect(r.reviewText).toBe('The final review.');
  });

  it('tolerates non-JSON lines (skips them silently)', () => {
    const stream = [
      'Warning: some shell noise bleeding onto stdout',
      JSON.stringify({
        type: 'item.completed',
        item: { type: 'agent_message', text: 'Review text' },
      }),
    ].join('\n');
    const r = parseCodexJsonl(stream);
    expect(r.reviewText).toBe('Review text');
    expect(r.eventCount).toBe(1);
  });

  it('returns empty reviewText when only lifecycle events present (e.g. empty diff)', () => {
    const stream = [
      JSON.stringify({ type: 'thread.started' }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({ type: 'turn.completed' }),
    ].join('\n');
    const r = parseCodexJsonl(stream);
    expect(r.reviewText).toBe('');
    expect(r.eventCount).toBe(3);
  });

  it('throws CodexProtocolError when stdout is all-non-JSON and non-empty', () => {
    expect(() => parseCodexJsonl('zsh: command not found: codex\nexit 127\n')).toThrow(
      CodexProtocolError,
    );
  });

  it('returns empty result for truly empty stdout (no error)', () => {
    const r = parseCodexJsonl('');
    expect(r.reviewText).toBe('');
    expect(r.eventCount).toBe(0);
  });
});
