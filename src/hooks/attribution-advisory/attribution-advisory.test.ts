/**
 * Unit tests for `src/hooks/attribution-advisory/index.ts`.
 *
 * Coverage focus:
 *   - HALT → exit 2 with banner.
 *   - No policy.yaml → no-op (exit 0).
 *   - block_ai_attribution: false → no-op.
 *   - block_ai_attribution: true + irrelevant command → no-op.
 *   - block_ai_attribution: true + relevant command + clean → no-op.
 *   - Each of the 5 attribution patterns blocks when present.
 *   - Negative cases (helix-020 G4 fix carry-forwards):
 *       - `<user>@users.noreply.github.com` is ALLOWED (not AI noreply).
 *       - Markdown text `support [Claude Code] hook output` is ALLOWED
 *         (not the link form `[Claude Code](url)`).
 *       - `gh pr edit --body "ref: gh pr create earlier"` is ALLOWED
 *         (substring inside body, not the command head).
 *   - Malformed payload → exit 2 (fail-closed).
 *   - Empty command → exit 0 silently.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAttributionAdvisory } from './index.js';

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-attr-adv-test-'));
}

function writePolicy(root: string, content: string): void {
  fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
  fs.writeFileSync(path.join(root, '.rea', 'policy.yaml'), content);
}

function payload(cmd: string, toolName = 'Bash'): string {
  return JSON.stringify({ tool_name: toolName, tool_input: { command: cmd } });
}

describe('runAttributionAdvisory', () => {
  let root: string;

  beforeEach(() => {
    root = mkRoot();
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exits 2 with HALT banner when .rea/HALT is present', async () => {
    fs.mkdirSync(path.join(root, '.rea'));
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'frozen');
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: payload('git commit -m "x"'),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('REA HALT: frozen');
  });

  it('exits 0 when policy.yaml is missing', async () => {
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: payload('git commit -m "Co-Authored-By: Claude <noreply@anthropic.com>"'),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('exits 0 when block_ai_attribution is false', async () => {
    writePolicy(root, 'block_ai_attribution: false\n');
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: payload('git commit -m "Co-Authored-By: Claude <noreply@anthropic.com>"'),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  });

  it('exits 0 when command is irrelevant (not git commit / gh pr create|edit)', async () => {
    writePolicy(root, 'block_ai_attribution: true\n');
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: payload('echo "Co-Authored-By: Claude <noreply@anthropic.com>"'),
    });
    expect(result.exitCode).toBe(0);
  });

  it('exits 0 when command is relevant but contains no attribution', async () => {
    writePolicy(root, 'block_ai_attribution: true\n');
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: payload('git commit -m "feat: clean message"'),
    });
    expect(result.exitCode).toBe(0);
  });

  it('blocks Co-Authored-By with AI vendor noreply (anthropic.com)', async () => {
    writePolicy(root, 'block_ai_attribution: true\n');
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: payload(
        'git commit -m "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"',
      ),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('BLOCKED: AI attribution detected');
  });

  it('blocks Co-Authored-By with AI vendor noreply (openai.com)', async () => {
    writePolicy(root, 'block_ai_attribution: true\n');
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: payload(
        'gh pr create --body "Co-Authored-By: GPT <noreply@openai.com>"',
      ),
    });
    expect(result.exitCode).toBe(2);
  });

  it('blocks Co-Authored-By with AI tool name (Claude)', async () => {
    writePolicy(root, 'block_ai_attribution: true\n');
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: payload(
        'git commit -m "x\n\nCo-Authored-By: Claude <user@example.com>"',
      ),
    });
    expect(result.exitCode).toBe(2);
  });

  it('blocks Generated with Claude footer', async () => {
    writePolicy(root, 'block_ai_attribution: true\n');
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: payload(
        'git commit -m "x\n\nGenerated with Claude Code"',
      ),
    });
    expect(result.exitCode).toBe(2);
  });

  it('blocks markdown-linked attribution', async () => {
    writePolicy(root, 'block_ai_attribution: true\n');
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: payload(
        'git commit -m "x\n\n[Claude Code](https://claude.com/code)"',
      ),
    });
    expect(result.exitCode).toBe(2);
  });

  it('blocks robot-emoji + Generated attribution', async () => {
    writePolicy(root, 'block_ai_attribution: true\n');
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: payload('git commit -m "x\n\n🤖 Generated with magic"'),
    });
    expect(result.exitCode).toBe(2);
  });

  it('allows GitHub per-user noreply form (human collaborator)', async () => {
    // helix-020 G4.B fix — `<user>@users.noreply.github.com` is a
    // legitimate human collaborator credit and MUST NOT trigger.
    writePolicy(root, 'block_ai_attribution: true\n');
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: payload(
        'git commit -m "x\n\nCo-Authored-By: Real Human <12345+real@users.noreply.github.com>"',
      ),
    });
    expect(result.exitCode).toBe(0);
  });

  it('allows non-link markdown mention of Claude Code', async () => {
    // helix-017 P3 #4 carry-forward: bracketed mention without `(` after
    // the `]` is NOT a markdown link — should not trigger.
    writePolicy(root, 'block_ai_attribution: true\n');
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: payload(
        'gh pr edit --body "support [Claude Code] hook output gracefully"',
      ),
    });
    expect(result.exitCode).toBe(0);
  });

  it('allows substring `gh pr create` inside a `gh pr edit --body`', async () => {
    // helix-020 G4.A fix: relevance is head-anchored, so the quoted-body
    // substring shouldn't make the command relevant.
    writePolicy(root, 'block_ai_attribution: true\n');
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: payload(
        'gh pr edit --body "tracked: gh pr create earlier in the run"',
      ),
    });
    // Relevant because `gh pr edit` matches `gh\s+pr\s+(create|edit)`.
    // But there's no attribution marker in the body either — should
    // exit 0 cleanly.
    expect(result.exitCode).toBe(0);
  });

  it('exits 2 (fail-closed) on malformed JSON stdin', async () => {
    writePolicy(root, 'block_ai_attribution: true\n');
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: '{not json',
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('refusing on uncertainty');
  });

  it('exits 0 for empty stdin', async () => {
    writePolicy(root, 'block_ai_attribution: true\n');
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: '',
    });
    expect(result.exitCode).toBe(0);
  });

  it('blocks despite quoted env-prefix bypass attempt (codex round 1 P1)', async () => {
    writePolicy(root, 'block_ai_attribution: true\n');
    // Pre-fix the segment matcher's relevance check missed
    // `REA_SKIP="urgent" git commit …` because the quoted env-prefix
    // left `git commit` invisible to the head-anchored regex.
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: payload(
        `REA_SKIP="urgent fix" git commit -m "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"`,
      ),
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('BLOCKED: AI attribution');
  });

  it('matches policy when YAML has whitespace before the colon-value', async () => {
    // ERE matches `^block_ai_attribution:\s*true` — `:  true` works.
    writePolicy(root, 'block_ai_attribution:   true\n');
    const result = await runAttributionAdvisory({
      reaRoot: root,
      stdinOverride: payload(
        'git commit -m "x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"',
      ),
    });
    expect(result.exitCode).toBe(2);
  });
});
