/**
 * Cross-file audit-emission contract test (Class G, 0.19.0+).
 *
 * Three documents describe ONE contract: every codex review (interactive
 * via the agent OR via the pre-push runtime) emits an audit entry to
 * `.rea/audit.jsonl`.
 *
 *   1. `commands/codex-review.md` — slash-command flow, Step 3.
 *   2. `agents/codex-adversarial.md` — agent flow, Step 4 (Emit audit
 *      entry — REQUIRED).
 *   3. `src/hooks/push-gate/index.ts` — runtime, calls `safeAppend`
 *      with `EVT_REVIEWED` on every completed review.
 *
 * helixir flagged this contradiction across rounds 65/66/73 (rea
 * 0.13.0 → 0.17.0): the agent file said "REQUIRED", the slash command
 * said "optional", and the runtime always emitted. 0.18.0 reconciled
 * the two markdown documents to the runtime contract. THIS TEST
 * prevents future drift — if any of the three documents diverges from
 * the others, CI fails with a specific message naming the offender.
 *
 * The test parses each document for canonical signal phrases. It does
 * NOT enforce identical wording — only that each document declares
 * the same semantic obligation. New surfaces (e.g. a `rea audit
 * log` CLI subcommand) get added to the SOURCES list and validated
 * the same way.
 */

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

interface ContractSource {
  /** Human-readable label for failure messages. */
  label: string;
  /** Repo-relative path. */
  file: string;
  /** Canonical signal phrases — at least one MUST appear verbatim. */
  signals: readonly RegExp[];
  /** Phrases that must NOT appear (catch the prior contradiction). */
  antisignals?: readonly RegExp[];
}

const SOURCES: readonly ContractSource[] = [
  {
    label: 'commands/codex-review.md (slash command)',
    file: 'commands/codex-review.md',
    signals: [/## Step 3 — Verify audit entry — REQUIRED/, /MUST.{0,40}emit.{0,40}audit/i],
    antisignals: [
      // The pre-0.18.0 wording. If this returns, the test fails loudly.
      /audit emission is optional/i,
      /do NOT treat absence as failure/i,
    ],
  },
  {
    label: 'agents/codex-adversarial.md (agent)',
    file: 'agents/codex-adversarial.md',
    signals: [/Emit an? audit entry.{0,10}—.{0,10}REQUIRED/i, /always emits/i],
    antisignals: [/audit emission is optional/i],
  },
  {
    label: 'src/hooks/push-gate/index.ts (runtime)',
    file: 'src/hooks/push-gate/index.ts',
    signals: [
      /EVT_REVIEWED\s*=\s*['"]rea\.push_gate\.reviewed['"]/,
      /safeAppend\(\s*appendAuditFn,\s*deps\.baseDir,\s*EVT_REVIEWED/,
    ],
  },
];

function readSource(file: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

describe('cross-file audit-emission contract (Class G)', () => {
  for (const src of SOURCES) {
    describe(src.label, () => {
      const body = readSource(src.file);

      for (const signal of src.signals) {
        it(`must contain signal phrase ${signal}`, () => {
          expect(
            signal.test(body),
            `${src.file} is missing the canonical signal phrase ${signal}.\n` +
              `This contract is shared with the other audit-emission documents — see __tests__/contracts/audit-emission-contract.test.ts.`,
          ).toBe(true);
        });
      }

      for (const anti of src.antisignals ?? []) {
        it(`must NOT contain antisignal ${anti}`, () => {
          expect(
            anti.test(body),
            `${src.file} contains the antisignal ${anti}.\n` +
              `This phrasing was the helixir-flagged contradiction (rounds 65/66/73). It must not return.`,
          ).toBe(false);
        });
      }
    });
  }

  it('the canonical EVT_REVIEWED constant value is identical across runtime + docs', () => {
    const runtimeBody = readSource('src/hooks/push-gate/index.ts');
    const evtMatch = runtimeBody.match(/EVT_REVIEWED\s*=\s*['"]([^'"]+)['"]/);
    expect(evtMatch?.[1], 'EVT_REVIEWED const not found in runtime').toBeDefined();
    const evtValue = evtMatch![1]!;

    const slashCmd = readSource('commands/codex-review.md');
    const agentDoc = readSource('agents/codex-adversarial.md');
    expect(
      slashCmd.includes('EVT_REVIEWED') || slashCmd.includes(evtValue),
      `commands/codex-review.md does not reference the runtime EVT_REVIEWED (${evtValue}).`,
    ).toBe(true);
    expect(
      agentDoc.includes('EVT_REVIEWED') || agentDoc.includes(evtValue),
      `agents/codex-adversarial.md does not reference the runtime EVT_REVIEWED (${evtValue}).`,
    ).toBe(true);
  });

  it('runtime safeAppend call uses EVT_REVIEWED inside a successful review path (post-summarize)', () => {
    const body = readSource('src/hooks/push-gate/index.ts');
    // Locate the summarizeReview call — the success path BELOW it must
    // contain the safeAppend(EVT_REVIEWED) call. If a future refactor
    // moves the audit emission outside the review-completion path
    // (e.g. into a finally that fires even on codex error), the
    // contract changes and this test should be updated explicitly.
    const summarizeIdx = body.indexOf('summarizeReview(');
    expect(summarizeIdx, 'summarizeReview call not found').toBeGreaterThan(-1);
    const tail = body.slice(summarizeIdx);
    expect(
      /safeAppend\(\s*appendAuditFn,\s*deps\.baseDir,\s*EVT_REVIEWED/.test(tail),
      'EVT_REVIEWED safeAppend call not present in the post-summarize success path',
    ).toBe(true);
  });

  // 0.19.1 P3-3 (code-reviewer): the cache-hit path ALSO emits
  // EVT_REVIEWED with `cache_hit: true` metadata, so operators
  // grepping `rea.push_gate.reviewed` for verdict-stability dashboards
  // see every push including cached ones. Pinned here so a future
  // refactor that drops the dual-emit is loud.
  it('runtime cache-hit branch emits BOTH EVT_CACHE_HIT and EVT_REVIEWED', () => {
    const body = readSource('src/hooks/push-gate/index.ts');
    // Find the cache-hit branch entry. The branch starts with the
    // `if (cacheLookup.hit && cacheLookup.entry !== undefined)` check.
    const branchIdx = body.indexOf('cacheLookup.hit && cacheLookup.entry');
    expect(branchIdx, 'cache-hit branch not found').toBeGreaterThan(-1);
    // The full branch ends at the matching `};` closing the return —
    // approximate by reading the next ~80 lines, more than enough to
    // contain both emit calls.
    const branchEndIdx = body.indexOf('return {', branchIdx);
    expect(branchEndIdx, 'cache-hit return not found').toBeGreaterThan(-1);
    const branchBody = body.slice(branchIdx, branchEndIdx);
    expect(
      /safeAppend\(\s*appendAuditFn,\s*deps\.baseDir,\s*EVT_CACHE_HIT/.test(branchBody),
      'cache-hit branch missing EVT_CACHE_HIT emit',
    ).toBe(true);
    expect(
      /safeAppend\(\s*appendAuditFn,\s*deps\.baseDir,\s*EVT_REVIEWED/.test(branchBody),
      'cache-hit branch missing EVT_REVIEWED emit (operators grep this for verdict-stability dashboards)',
    ).toBe(true);
    // The `cache_hit: true` field is the discriminator that lets
    // operators filter cache hits OUT of dashboards if they want.
    expect(
      /cache_hit:\s*true/.test(branchBody),
      'cache-hit EVT_REVIEWED missing `cache_hit: true` discriminator field',
    ).toBe(true);
  });
});
