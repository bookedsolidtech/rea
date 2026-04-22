/**
 * Integration test for Defect U (0.10.2): push-review-core.sh's Codex-review
 * jq scan must tolerate malformed lines in .rea/audit.jsonl.
 *
 * Before 0.10.2 the scan was:
 *
 *     jq -e --arg sha "$sha" '
 *         select(.tool_name == "codex.review" and .metadata.head_sha == $sha
 *                and (.metadata.verdict == "pass" or .metadata.verdict == "concerns")
 *                and (.emission_source == "rea-cli" or .emission_source == "codex-cli"))
 *       ' "$_audit" >/dev/null 2>&1
 *
 * jq parses the file as a single JSON stream. A single unparseable line
 * makes jq exit with status 2 BEFORE `select` runs against any record, so
 * every legitimate codex.review receipt past the corruption becomes
 * unreachable. One stray backslash sequence locks the push gate closed.
 *
 * After 0.10.2 the scan is:
 *
 *     jq -R --arg sha "$sha" '
 *         fromjson?
 *         | select(<same predicate>)
 *       ' "$_audit" 2>/dev/null | grep -q .
 *
 * `-R` takes each line as a raw string; `fromjson?` is the error-suppressing
 * parser. Malformed lines yield empty output instead of failing the pipeline.
 * The `select` filter runs against every successfully parsed record.
 *
 * This test exercises the exact pipeline against a .rea/audit.jsonl that
 * sandwiches a malformed line between two valid codex.review records with
 * different head_sha values. Both must be findable.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendCodexReviewAuditRecord, Tier, InvocationStatus } from '../../src/audit/append.js';

function jqExists(): boolean {
  const res = spawnSync('jq', ['--version'], { encoding: 'utf8' });
  return res.status === 0;
}

/**
 * Run the EXACT jq pipeline push-review-core.sh uses after defect U. Returns
 * true iff at least one audit line satisfies the Codex-review predicate for
 * the given head_sha. Matches the shell logic line-for-line:
 *
 *   - `-R` (raw input) + `fromjson?` (error-suppressing parse)
 *   - select on tool_name / head_sha / verdict / emission_source
 *   - downstream `grep -q .` turns "any output" into exit 0
 *
 * stderr is captured so jq's per-line parse errors don't pollute the test
 * runner's output — the hook pipes 2>/dev/null for the same reason.
 */
function runCodexOkScan(auditFile: string, headSha: string): boolean {
  const filter = `
    fromjson?
    | select(
        .tool_name == "codex.review"
        and .metadata.head_sha == $sha
        and (.metadata.verdict == "pass" or .metadata.verdict == "concerns")
        and (.emission_source == "rea-cli" or .emission_source == "codex-cli")
      )
  `;
  const jq = spawnSync('jq', ['-R', '--arg', 'sha', headSha, filter, auditFile], {
    encoding: 'utf8',
  });
  if (jq.status !== 0 && jq.status !== 1) {
    // jq-1 is "no matches" under -R (grep-q-equivalent); jq-0 is "matches
    // produced output". Anything else means the file couldn't be opened or
    // a filter syntax error — both are test setup bugs, not the predicate
    // behavior we're measuring.
    throw new Error(
      `jq exited with status ${jq.status ?? '?'}: stderr=${jq.stderr ?? ''}`,
    );
  }
  const stdout = jq.stdout ?? '';
  // `grep -q .` returns 0 iff at least one non-empty line was emitted. Match
  // that behavior in JS.
  return stdout.split('\n').some((l) => l.length > 0);
}

describe('push-review-core.sh Codex-review jq scan — defect U tolerance', () => {
  let baseDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-fromjson-U-'));
    baseDir = await fs.realpath(baseDir);
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('finds a valid codex.review record when the audit file has no corruption', async () => {
    if (!jqExists()) return;
    const sha = 'a'.repeat(40);
    await appendCodexReviewAuditRecord(baseDir, {
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: { head_sha: sha, target: 'main', verdict: 'pass', finding_count: 0 },
    });
    const auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
    expect(runCodexOkScan(auditFile, sha)).toBe(true);
  });

  it('finds BOTH valid codex.review records when a malformed line sits between them (defect U)', async () => {
    if (!jqExists()) return;
    const shaBefore = 'b'.repeat(40);
    const shaAfter = 'c'.repeat(40);

    // First valid record.
    await appendCodexReviewAuditRecord(baseDir, {
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: { head_sha: shaBefore, target: 'main', verdict: 'pass', finding_count: 0 },
    });
    // Second valid record — distinct head_sha, same canonical shape.
    await appendCodexReviewAuditRecord(baseDir, {
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: shaAfter,
        target: 'main',
        verdict: 'concerns',
        finding_count: 2,
      },
    });

    // Splice a malformed line BETWEEN the two records. Direct write is the
    // only way to simulate external corruption — defect T's self-check
    // prevents the helper from producing this shape.
    const auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
    const rawBytes = (await fs.readFile(auditFile, 'utf8'))
      .split('\n')
      .filter((l) => l.length > 0);
    expect(rawBytes).toHaveLength(2);
    // Classic "backslash-u followed by non-hex" — the exact failure shape
    // that triggered defect T/U in the field. jq on the whole-file stream
    // sees this as an unterminated escape and bails with status 2.
    const malformed = '{"tool_name":"codex.review","bogus":"\\uZZZZ"}';
    const corrupted = [rawBytes[0], malformed, rawBytes[1], ''].join('\n');
    await fs.writeFile(auditFile, corrupted);

    // Sanity: pre-0.10.2 pipeline (`jq -e '<filter>' file`) would bail on
    // this file. We don't assert the old behavior here — the test exists
    // to lock in the NEW behavior. Both head_shas must be findable.
    expect(runCodexOkScan(auditFile, shaBefore)).toBe(true);
    expect(runCodexOkScan(auditFile, shaAfter)).toBe(true);

    // And a nonexistent sha must still return false — tolerance for
    // malformed lines must not weaken the predicate into "anything passes".
    expect(runCodexOkScan(auditFile, 'd'.repeat(40))).toBe(false);
  });

  it('rejects forged records with emission_source="other" even past a malformed line', async () => {
    if (!jqExists()) return;
    // This locks the defect-P guarantee through the defect-U scan. An
    // attacker who hand-wrote a tool_name=codex.review line with
    // emission_source="other" into .rea/audit.jsonl must still fail the
    // predicate, even if a malformed line precedes it (which would
    // otherwise mask their forgery via the old whole-file parse).
    const legitSha = 'e'.repeat(40);
    const forgedSha = 'f'.repeat(40);
    await appendCodexReviewAuditRecord(baseDir, {
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: {
        head_sha: legitSha,
        target: 'main',
        verdict: 'pass',
        finding_count: 0,
      },
    });

    const auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
    const legitLine = (await fs.readFile(auditFile, 'utf8')).split('\n')[0]!;
    // A hand-rolled line that would satisfy every predicate clause EXCEPT
    // `.emission_source == "rea-cli" or "codex-cli"`. Attackers can stamp
    // "other" via the public appendAuditRecord() helper, so this is the
    // concrete shape the gate guards against.
    const forged = JSON.stringify({
      tool_name: 'codex.review',
      server_name: 'codex',
      emission_source: 'other',
      metadata: {
        head_sha: forgedSha,
        target: 'main',
        verdict: 'pass',
        finding_count: 0,
      },
    });
    const malformed = '{"tool_name":"codex.review","bogus":"\\uZZZZ"}';
    await fs.writeFile(auditFile, [legitLine, malformed, forged, ''].join('\n'));

    expect(runCodexOkScan(auditFile, legitSha)).toBe(true);
    expect(runCodexOkScan(auditFile, forgedSha)).toBe(false);
  });

  it('returns false when the file contains only malformed lines', async () => {
    if (!jqExists()) return;
    const auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
    await fs.writeFile(auditFile, ['{not json', '{"unterminated', ''].join('\n'));
    expect(runCodexOkScan(auditFile, 'z'.repeat(40))).toBe(false);
  });
});
