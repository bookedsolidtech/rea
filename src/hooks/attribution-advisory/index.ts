/**
 * Node-binary port of `hooks/attribution-advisory.sh`.
 *
 * 0.32.0 Phase 1 Pilot #3 — opt-in policy-gated AI-attribution
 * detector for `git commit` / `gh pr create|edit` commands.
 *
 * Why pilot #3 (and not #1): pilot #1 was the smallest port surface
 * (no segments, no body-file resolution). Pilot #3 introduces the
 * FULL `splitSegments` + `anySegmentStartsWith` + `anySegmentMatches`
 * API surface. Pilot #2 (`security-disclosure-gate`) layers the
 * file-IO body-file resolver on top of this same segment primitive.
 *
 * Behavioral contract — preserves bash hook byte-for-byte:
 *
 *   1. HALT check → exit 2 with shared banner. (Same as pilot 1.)
 *   2. Read stdin payload. When `tool_input.command` is missing /
 *      empty, exit 0 silently.
 *   3. Read `<reaRoot>/.rea/policy.yaml` and check for the line
 *      `block_ai_attribution: true`. The bash original used `grep -qE
 *      '^block_ai_attribution:[[:space:]]*true'` against the file
 *      directly; the Node port preserves the EXACT same regex against
 *      the file contents. NOT a YAML parse — the bash hook ran before
 *      we had a CLI-mediated `policy-get` read, and consumers may
 *      authored the line in either block or inline form. Matching the
 *      regex behavior preserves all the edge cases the bash hook
 *      shipped with.
 *   4. Identify whether the command is RELEVANT — a `git commit` or
 *      `gh pr create|edit` invocation at the head of any segment.
 *      Uses `anySegmentStartsWith` (head-anchored, post-prefix-strip)
 *      so a quoted-body mention like `gh pr edit --body "ref: git
 *      commit earlier"` does NOT count as relevant.
 *   5. Scan for FIVE attribution-marker classes, each via
 *      `anySegmentMatches` so the match has to live in the same
 *      segment as the relevant command head:
 *        a. `Co-Authored-By:` with an AI vendor noreply@ domain
 *        b. `Co-Authored-By:` with a known AI tool name
 *        c. `Generated|Created|Built|… with|by <AI Tool>`
 *        d. Markdown-linked tool name (`[Claude Code](`)
 *        e. Robot-emoji + Generated marker
 *   6. Any match → exit 2 with the banner. No match → exit 0.
 *
 * Wider-net pattern choice: the bash hook used `[[:space:]]+` for
 * `\s+` equivalents. JS regex uses `\s+` which is broader (includes
 * vertical tab / form feed). For the ASCII payloads `gh` and `git`
 * actually accept, the behavior is identical.
 */

import type { Buffer } from 'node:buffer';
import fs from 'node:fs';
import path from 'node:path';
import { checkHalt, formatHaltBanner } from '../_lib/halt-check.js';
import {
  parseHookPayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';
import { anySegmentStartsWith, anySegmentMatches } from '../_lib/segments.js';

export interface AttributionAdvisoryOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
}

export interface AttributionAdvisoryResult {
  exitCode: number;
  stderr: string;
}

const RELEVANT_GH = 'gh\\s+pr\\s+(create|edit)';
const RELEVANT_GIT_COMMIT = 'git\\s+commit';

/**
 * `Co-Authored-By:` paired with a vendor `noreply@` domain that we
 * recognize as AI tooling. GitHub's per-user `users.noreply.github.com`
 * form is EXCLUDED — that's a legitimate human-collaborator credit.
 *
 * Mirrors the 0.18.0 helix-020 G4.B fix exactly: the catalog of
 * recognized AI vendor noreply domains is enumerated here verbatim
 * from the bash hook so adding/removing a vendor is a one-place edit.
 */
const NOREPLY_AI_DOMAINS = [
  'anthropic\\.com',
  'openai\\.com',
  'github-copilot',
  'github\\.com',
  'claude\\.ai',
  'chatgpt\\.com',
  'googlemail\\.com',
  'google\\.com',
  'cursor\\.com',
  'codeium\\.com',
  'tabnine\\.com',
  'amazon\\.com',
  'amazonaws\\.com',
  'amazon-q\\.amazonaws\\.com',
  'cody\\.dev',
  'sourcegraph\\.com',
  'mistral\\.ai',
  'xai-org',
  'x\\.ai',
  'inflection\\.ai',
  'perplexity\\.ai',
  'replit\\.com',
  'jetbrains\\.com',
  'bito\\.ai',
  'pieces\\.app',
  'phind\\.com',
  'you\\.com',
];

const PATTERN_NOREPLY_AI =
  `Co-Authored-By:.*noreply@(${NOREPLY_AI_DOMAINS.join('|')})`;

const PATTERN_COAUTH_AI_NAME =
  'Co-Authored-By:.*\\b(Claude|Sonnet|Opus|Haiku|Copilot|GPT|ChatGPT|Gemini|' +
  'Cursor|Codeium|Tabnine|Amazon Q|CodeWhisperer|Devin|Windsurf|Cline|' +
  'Aider|Anthropic|OpenAI|GitHub Copilot)\\b';

const PATTERN_GENERATED_WITH =
  '(Generated|Created|Built|Powered|Authored|Written|Produced)\\s+' +
  '(with|by)\\s+' +
  '(Claude|Copilot|GPT|ChatGPT|Gemini|Cursor|Codeium|Tabnine|CodeWhisperer|' +
  'Devin|Windsurf|Cline|Aider|AI|an? AI)\\b';

const PATTERN_MD_LINK =
  '\\[Claude Code\\]\\(|\\[GitHub Copilot\\]\\(|\\[ChatGPT\\]\\(|' +
  '\\[Gemini\\]\\(|\\[Cursor\\]\\(';

const PATTERN_EMOJI = '🤖.*[Gg]enerated';

const BLOCK_BANNER = [
  '\n',
  '═══════════════════════════════════════════════════════════════════\n',
  '  BLOCKED: AI attribution detected in command\n',
  '═══════════════════════════════════════════════════════════════════\n',
  '\n',
  '  Your command contains structural AI attribution markers.\n',
  '\n',
  '  What gets BLOCKED (structural attribution):\n',
  '    - Co-Authored-By with AI names or noreply@ emails\n',
  '    - "Generated with/by [AI Tool]" footer lines\n',
  '    - Markdown-linked tool names: [Claude Code](...)\n',
  '    - Emoji attribution: 🤖 Generated...\n',
  '\n',
  '  What is ALLOWED (legitimate references):\n',
  '    - "Fix Claude API integration"\n',
  '    - "Update OpenAI SDK version"\n',
  '    - "Add Copilot config"\n',
  '\n',
  '  Remove the attribution markers and rewrite the command.\n',
  '  To disable: set block_ai_attribution: false in .rea/policy.yaml\n',
  '═══════════════════════════════════════════════════════════════════\n',
  '\n',
].join('');

/**
 * Check whether the policy file enables `block_ai_attribution`. Same
 * grep posture as the bash hook (`grep -qE
 * '^block_ai_attribution:[[:space:]]*true' "$POLICY_FILE"`).
 *
 * Missing file → not enabled. Read errors → not enabled (the policy
 * itself becomes the gate's input; an unreadable policy can't say
 * "block", so the safe posture is to no-op like the bash hook does).
 */
function isAttributionBlockingEnabled(reaRoot: string): boolean {
  const policyFile = path.join(reaRoot, '.rea', 'policy.yaml');
  if (!fs.existsSync(policyFile)) return false;
  let content: string;
  try {
    content = fs.readFileSync(policyFile, 'utf8');
  } catch {
    return false;
  }
  // ERE: `^block_ai_attribution:[[:space:]]*true`. JS regex equiv:
  // `^block_ai_attribution:\s*true` with multiline anchor.
  return /^block_ai_attribution:\s*true/m.test(content);
}

/**
 * Pure executor — returns `{ exitCode, stderr }`.
 */
export async function runAttributionAdvisory(
  options: AttributionAdvisoryOptions = {},
): Promise<AttributionAdvisoryResult> {
  const reaRoot =
    options.reaRoot ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
  let stderr = '';
  const writeStderr = (s: string): void => {
    stderr += s;
    if (options.stderrWrite) options.stderrWrite(s);
  };

  // 1. HALT check.
  const halt = checkHalt(reaRoot);
  if (halt.halted) {
    writeStderr(formatHaltBanner(halt.reason));
    return { exitCode: 2, stderr };
  }

  // 2. Read stdin.
  const stdinRaw =
    options.stdinOverride !== undefined
      ? options.stdinOverride
      : await readStdinWithTimeout(5_000);

  let cmd = '';
  try {
    const payload = parseHookPayload(stdinRaw);
    cmd = payload.command;
  } catch (err) {
    if (err instanceof MalformedPayloadError || err instanceof TypePayloadError) {
      writeStderr(`attribution-advisory: ${err.message} — refusing on uncertainty.\n`);
      return { exitCode: 2, stderr };
    }
    throw err;
  }

  if (cmd.length === 0) {
    return { exitCode: 0, stderr };
  }

  // 3. Policy gate.
  if (!isAttributionBlockingEnabled(reaRoot)) {
    return { exitCode: 0, stderr };
  }

  // 4. Relevance gate — only act on `git commit` / `gh pr create|edit`.
  const isRelevant =
    anySegmentStartsWith(cmd, RELEVANT_GH) ||
    anySegmentStartsWith(cmd, RELEVANT_GIT_COMMIT);
  if (!isRelevant) {
    return { exitCode: 0, stderr };
  }

  // 5. Attribution scan.
  let found = false;
  if (anySegmentMatches(cmd, PATTERN_NOREPLY_AI)) found = true;
  if (!found && anySegmentMatches(cmd, PATTERN_COAUTH_AI_NAME)) found = true;
  if (!found && anySegmentMatches(cmd, PATTERN_GENERATED_WITH)) found = true;
  if (!found && anySegmentMatches(cmd, PATTERN_MD_LINK)) found = true;
  if (!found && anySegmentMatches(cmd, PATTERN_EMOJI)) found = true;

  if (found) {
    writeStderr(BLOCK_BANNER);
    return { exitCode: 2, stderr };
  }

  return { exitCode: 0, stderr };
}

/**
 * CLI entry — `rea hook attribution-advisory`.
 */
export async function runHookAttributionAdvisory(
  options: AttributionAdvisoryOptions = {},
): Promise<void> {
  const result = await runAttributionAdvisory({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}

// Internal exports for tests.
export const __INTERNAL_BLOCK_BANNER_FOR_TESTS = BLOCK_BANNER;
export const __INTERNAL_PATTERNS_FOR_TESTS = {
  PATTERN_NOREPLY_AI,
  PATTERN_COAUTH_AI_NAME,
  PATTERN_GENERATED_WITH,
  PATTERN_MD_LINK,
  PATTERN_EMOJI,
};
