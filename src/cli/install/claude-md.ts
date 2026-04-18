/**
 * Write or update a managed fragment inside the consumer's `CLAUDE.md`.
 *
 * The fragment is delimited by HTML-style comment markers so it's invisible in
 * rendered Markdown but machine-parseable:
 *
 *   <!-- rea:managed:start v=1 -->
 *   ...
 *   <!-- rea:managed:end -->
 *
 * On first install the block is appended at the end of `CLAUDE.md` (or the file
 * is created). On subsequent runs, everything between the markers is replaced.
 * Content outside the markers is NEVER touched — the consumer owns the rest
 * of `CLAUDE.md`.
 *
 * Fragment content:
 *   - Policy path
 *   - Active profile
 *   - Autonomy level and ceiling
 *   - Blocked-paths count (not the paths themselves — those are in the YAML)
 *   - A reminder that `/codex-review` is required on protected-path changes
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

export interface ClaudeMdFragmentInput {
  policyPath: string;
  profile: string;
  autonomyLevel: string;
  maxAutonomyLevel: string;
  blockedPathsCount: number;
  blockAiAttribution: boolean;
}

export const START_MARKER = '<!-- rea:managed:start v=1 -->';
export const END_MARKER = '<!-- rea:managed:end -->';

/**
 * Return the current managed-fragment substring (from START_MARKER to
 * END_MARKER inclusive) if present in `content`, else `null`. Shared with
 * `rea upgrade` so both sides use identical boundary semantics.
 */
export function extractFragment(content: string): string | null {
  const s = content.indexOf(START_MARKER);
  const e = content.indexOf(END_MARKER);
  if (s === -1 || e === -1 || e < s) return null;
  return content.slice(s, e + END_MARKER.length);
}

export function buildFragment(input: ClaudeMdFragmentInput): string {
  const lines = [
    START_MARKER,
    '',
    '## REA Governance (managed — do not edit this block)',
    '',
    `- **Policy**: \`${input.policyPath}\` — profile \`${input.profile}\``,
    `- **Autonomy**: \`${input.autonomyLevel}\` (ceiling \`${input.maxAutonomyLevel}\`)`,
    `- **Blocked paths**: ${input.blockedPathsCount} entries — see the policy file`,
    `- **block_ai_attribution**: \`${input.blockAiAttribution}\` (enforced by commit-msg hook)`,
    '',
    'Protected-path changes (`src/gateway/middleware/`, `hooks/`, `src/policy/`,',
    '`.github/workflows/`) require a `/codex-review` audit entry before push.',
    '',
    'Run `rea doctor` to verify the install. Run `rea check` to inspect state.',
    '',
    END_MARKER,
  ];
  return lines.join('\n');
}

/**
 * Write or replace the managed fragment inside `${targetDir}/CLAUDE.md`.
 * Returns the absolute path written and whether the file existed before.
 */
export async function writeClaudeMdFragment(
  targetDir: string,
  input: ClaudeMdFragmentInput,
): Promise<{ path: string; existed: boolean; replaced: boolean }> {
  const claudeMdPath = path.join(targetDir, 'CLAUDE.md');
  const fragment = buildFragment(input);

  if (!fs.existsSync(claudeMdPath)) {
    const seed = [
      `# CLAUDE.md — ${path.basename(targetDir)}`,
      '',
      'Project-level instructions for AI agents in this repository.',
      '',
      fragment,
      '',
    ].join('\n');
    await fsPromises.writeFile(claudeMdPath, seed, 'utf8');
    return { path: claudeMdPath, existed: false, replaced: false };
  }

  const existing = await fsPromises.readFile(claudeMdPath, 'utf8');
  const startIdx = existing.indexOf(START_MARKER);
  const endIdx = existing.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    // No markers — append the fragment to the end, preserving existing content.
    const trailer = existing.endsWith('\n') ? '' : '\n';
    const next = `${existing}${trailer}\n${fragment}\n`;
    await fsPromises.writeFile(claudeMdPath, next, 'utf8');
    return { path: claudeMdPath, existed: true, replaced: false };
  }

  const endLineIdx = endIdx + END_MARKER.length;
  const next = existing.slice(0, startIdx) + fragment + existing.slice(endLineIdx);
  await fsPromises.writeFile(claudeMdPath, next, 'utf8');
  return { path: claudeMdPath, existed: true, replaced: true };
}
