/**
 * ClaudeSelfReviewer — the runtime fallback for the adversarial reviewer
 * slot (G11.2).
 *
 * When Codex is unreachable (rate-limited, unauthenticated, CLI missing)
 * and the operator hasn't opted into a first-class no-Codex policy, we
 * still want SOMETHING pushing back on the diff before it lands. A fresh-
 * context Opus call with a review-only system prompt is not a cross-model
 * check — it's the same family reviewing its own output — so we label every
 * result `degraded: true` so the audit trail is honest about it.
 *
 * ## Design notes
 *
 * - One-shot, no conversation history. The SDK call is synchronous from
 *   our caller's perspective.
 * - We pin the model id in `version` so older audit entries stay
 *   reproducible when we bump the default.
 * - The model is prompted to return STRICT JSON matching `ReviewResult`.
 *   If parsing fails we return `verdict: 'error'` rather than guessing —
 *   the operator gets a clear signal that the fallback didn't work.
 * - Rate-limit / 5xx errors bubble up as `verdict: 'error'` with the raw
 *   message; callers can decide to retry, prompt the human, or abort.
 * - We cap the diff at 200KB and note the truncation in the summary. The
 *   inbound token budget for a big Opus call is much larger, but a 200KB
 *   diff is already a red flag on its own and we don't want to silently
 *   eat massive payloads.
 */

import Anthropic, { APIError } from '@anthropic-ai/sdk';
import type {
  AdversarialReviewer,
  ReviewFinding,
  ReviewRequest,
  ReviewResult,
  ReviewVerdict,
} from './types.js';

/** Pin the model id — audit entries reference this verbatim. */
const CLAUDE_MODEL_ID = 'claude-opus-4-7';

/** 200KB cap on the diff before we truncate and flag degraded. */
const DIFF_TRUNCATE_BYTES = 200 * 1024;

/** Bounded output so a runaway model can't exhaust our token budget. */
const MAX_OUTPUT_TOKENS = 4096;

/**
 * Thin shape of the one SDK method we call. Lets the tests swap in a fake
 * without pulling the full Anthropic client into the unit test. Shape
 * mirrors `client.messages.create` closely enough for our purposes.
 */
export interface MessagesCreateFn {
  (params: {
    model: string;
    max_tokens: number;
    system: string;
    messages: Array<{ role: 'user'; content: string }>;
  }): Promise<{
    content: Array<{ type: string; text?: string }>;
  }>;
}

/**
 * Constructor seams let tests inject a fake exec/SDK without stubbing the
 * module registry. Production callers use the defaults.
 */
export interface ClaudeSelfReviewerOptions {
  apiKey?: string;
  model?: string;
  create?: MessagesCreateFn;
}

const SYSTEM_PROMPT = `You are an adversarial code reviewer. A diff will be provided along with
commit metadata. Identify high-impact security, correctness, edge-case,
test-gap, api-design, or performance issues. Do not restate what the diff
does; surface what is wrong or risky.

Respond with STRICT JSON matching exactly this schema. Do not include
markdown fences, commentary, or any text outside the JSON object:

{
  "verdict": "pass" | "concerns" | "blocking" | "error",
  "summary": "one sentence",
  "findings": [
    {
      "category": "security" | "correctness" | "edge-case" | "test-gap" | "api-design" | "performance",
      "severity": "high" | "medium" | "low",
      "file": "relative/path",
      "line": 123,
      "issue": "short problem statement",
      "evidence": "optional quote from the diff",
      "suggested_fix": "optional one-line fix hint"
    }
  ]
}

Return an empty findings array for a clean pass. Use "blocking" only for
issues that must be fixed before merge.`;

function buildUserMessage(req: ReviewRequest, diffWasTruncated: boolean): string {
  const truncNote = diffWasTruncated
    ? '\n\nNOTE: The diff was truncated to 200KB. The review is necessarily partial.'
    : '';
  return [
    `Branch: ${req.branch}`,
    `Head SHA: ${req.head_sha}`,
    `Diffed against: ${req.target}`,
    '',
    '## Commit log',
    req.commit_log || '(empty)',
    '',
    '## Diff',
    req.diff || '(empty)',
    truncNote,
  ].join('\n');
}

/**
 * Safe parse — we don't want a malformed model response to crash the push
 * gate. Any parse failure or shape mismatch folds into an error verdict.
 */
function parseModelJson(raw: string): ReviewResult | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      error: `unparseable JSON from model: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { error: 'model response was not a JSON object' };
  }

  const obj = parsed as Record<string, unknown>;
  const verdict = obj['verdict'];
  const summary = obj['summary'];
  const findings = obj['findings'];

  const validVerdicts: readonly ReviewVerdict[] = ['pass', 'concerns', 'blocking', 'error'];
  if (typeof verdict !== 'string' || !validVerdicts.includes(verdict as ReviewVerdict)) {
    return { error: `invalid verdict: ${String(verdict)}` };
  }
  if (typeof summary !== 'string') {
    return { error: 'missing or non-string summary' };
  }
  if (!Array.isArray(findings)) {
    return { error: 'missing or non-array findings' };
  }

  // Findings get shallow validation — we pass each through a narrow guard
  // and drop any entries that can't be coerced. A noisy model is better
  // handled by discarding junk than by erroring the whole review.
  const cleanFindings: ReviewFinding[] = [];
  for (const f of findings) {
    const finding = toReviewFinding(f);
    if (finding !== undefined) cleanFindings.push(finding);
  }

  return {
    reviewer_name: 'claude-self',
    reviewer_version: CLAUDE_MODEL_ID,
    verdict: verdict as ReviewVerdict,
    findings: cleanFindings,
    summary,
    // Always true for this reviewer — same-model is structurally degraded.
    // Callers that compose results should keep this value, not overwrite it.
    degraded: true,
  };
}

function toReviewFinding(input: unknown): ReviewFinding | undefined {
  if (typeof input !== 'object' || input === null) return undefined;
  const o = input as Record<string, unknown>;
  const validCategories: ReadonlyArray<ReviewFinding['category']> = [
    'security',
    'correctness',
    'edge-case',
    'test-gap',
    'api-design',
    'performance',
  ];
  const validSeverities: ReadonlyArray<ReviewFinding['severity']> = ['high', 'medium', 'low'];
  if (typeof o['category'] !== 'string' || !validCategories.includes(o['category'] as ReviewFinding['category'])) {
    return undefined;
  }
  if (typeof o['severity'] !== 'string' || !validSeverities.includes(o['severity'] as ReviewFinding['severity'])) {
    return undefined;
  }
  if (typeof o['file'] !== 'string') return undefined;
  if (typeof o['issue'] !== 'string') return undefined;

  const out: ReviewFinding = {
    category: o['category'] as ReviewFinding['category'],
    severity: o['severity'] as ReviewFinding['severity'],
    file: o['file'],
    issue: o['issue'],
  };
  if (typeof o['line'] === 'number') out.line = o['line'];
  if (typeof o['start_line'] === 'number') out.start_line = o['start_line'];
  if (typeof o['evidence'] === 'string') out.evidence = o['evidence'];
  if (typeof o['suggested_fix'] === 'string') out.suggested_fix = o['suggested_fix'];
  return out;
}

function errorResult(message: string, summary: string, degradedNote: string): ReviewResult {
  return {
    reviewer_name: 'claude-self',
    reviewer_version: CLAUDE_MODEL_ID,
    verdict: 'error',
    findings: [],
    summary: `${summary}${degradedNote}`,
    degraded: true,
    error: message,
  };
}

export class ClaudeSelfReviewer implements AdversarialReviewer {
  readonly name = 'claude-self';
  readonly version: string;

  private readonly apiKey: string | undefined;
  private readonly createFn: MessagesCreateFn | undefined;

  constructor(opts: ClaudeSelfReviewerOptions = {}) {
    this.version = opts.model ?? CLAUDE_MODEL_ID;
    this.apiKey = opts.apiKey ?? process.env['ANTHROPIC_API_KEY'];
    this.createFn = opts.create;
  }

  /**
   * Cheap check. We don't actually ping the API — the selector only needs
   * to know whether we CAN try. If the key is bogus we'll find out in
   * `review()` and surface it as `verdict: 'error'`.
   */
  async isAvailable(): Promise<boolean> {
    // When a test injects `create`, treat the reviewer as available so we
    // don't need to juggle fake env in every test.
    if (this.createFn !== undefined) return true;
    return this.apiKey !== undefined && this.apiKey.length > 0;
  }

  async review(req: ReviewRequest): Promise<ReviewResult> {
    const create = this.getCreateFn();
    if (create === undefined) {
      return errorResult(
        'ANTHROPIC_API_KEY not set',
        'claude-self fallback unavailable: no API key',
        '',
      );
    }

    const diffBytes = Buffer.byteLength(req.diff, 'utf8');
    const truncated = diffBytes > DIFF_TRUNCATE_BYTES;
    const effectiveDiff = truncated
      ? req.diff.slice(0, DIFF_TRUNCATE_BYTES)
      : req.diff;

    let response: Awaited<ReturnType<MessagesCreateFn>>;
    try {
      response = await create({
        model: this.version,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: buildUserMessage({ ...req, diff: effectiveDiff }, truncated),
          },
        ],
      });
    } catch (err) {
      // Rate-limits, 5xx, network errors all land here. Surface the raw
      // message so operators can act on it; the caller decides whether
      // to retry or abort.
      const message = err instanceof APIError ? `API ${err.status ?? '?'}: ${err.message}` : err instanceof Error ? err.message : String(err);
      return errorResult(message, 'claude-self review failed', '');
    }

    const text = response.content
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('');

    const parsed = parseModelJson(text);
    if ('error' in parsed) {
      return errorResult(parsed.error, 'claude-self produced unparseable output', '');
    }

    if (truncated) {
      parsed.summary = `[diff truncated to 200KB] ${parsed.summary}`;
    }
    // Defense in depth — parseModelJson should always set degraded=true
    // for this reviewer, but this reviewer is the canonical authority on
    // that flag so re-pin it.
    parsed.degraded = true;
    return parsed;
  }

  /**
   * Resolve the create() closure lazily so we only build the real client
   * when there's an API key and nothing was injected.
   */
  private getCreateFn(): MessagesCreateFn | undefined {
    if (this.createFn !== undefined) return this.createFn;
    if (this.apiKey === undefined || this.apiKey.length === 0) return undefined;
    const client = new Anthropic({ apiKey: this.apiKey });
    return async (params) => {
      const res = await client.messages.create(params);
      return {
        content: res.content.map((block) =>
          block.type === 'text' ? { type: 'text', text: block.text } : { type: block.type },
        ),
      };
    };
  }
}
