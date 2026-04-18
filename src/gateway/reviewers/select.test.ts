import { describe, expect, it, vi } from 'vitest';
import { AutonomyLevel } from '../../policy/types.js';
import type { Policy } from '../../policy/types.js';
import type { Registry } from '../../registry/types.js';
import {
  NoReviewerAvailableError,
  selectReviewer,
  type SelectorDeps,
} from './select.js';
import type { AdversarialReviewer, ReviewRequest, ReviewResult } from './types.js';

function basePolicy(overrides: Partial<Policy> = {}): Policy {
  return {
    version: '1',
    profile: 'test',
    installed_by: 'test',
    installed_at: '2026-04-18T00:00:00Z',
    autonomy_level: AutonomyLevel.L1,
    max_autonomy_level: AutonomyLevel.L2,
    promotion_requires_human_approval: true,
    block_ai_attribution: true,
    blocked_paths: [],
    notification_channel: '',
    ...overrides,
  };
}

function baseRegistry(overrides: Partial<Registry> = {}): Registry {
  return {
    version: '1',
    servers: [],
    ...overrides,
  };
}

function fakeReviewer(name: string, available: boolean): AdversarialReviewer {
  return {
    name,
    version: `${name}-v0`,
    isAvailable: vi.fn().mockResolvedValue(available),
    review: vi.fn().mockImplementation(async (_req: ReviewRequest): Promise<ReviewResult> => ({
      reviewer_name: name,
      reviewer_version: `${name}-v0`,
      verdict: 'pass',
      findings: [],
      summary: 'ok',
      degraded: false,
    })),
  };
}

function depsWith(codex: AdversarialReviewer, claudeSelf: AdversarialReviewer): SelectorDeps {
  return {
    makeCodex: () => codex,
    makeClaudeSelf: () => claudeSelf,
  };
}

describe('selectReviewer', () => {
  describe('precedence', () => {
    it('env REA_REVIEWER wins over registry and policy', async () => {
      const codex = fakeReviewer('codex', true);
      const claude = fakeReviewer('claude-self', true);
      const result = await selectReviewer(
        basePolicy({ review: { codex_required: false } }),
        baseRegistry({ reviewer: 'codex' }),
        { REA_REVIEWER: 'claude-self' } as NodeJS.ProcessEnv,
        depsWith(codex, claude),
      );
      expect(result.reviewer.name).toBe('claude-self');
      expect(result.degraded).toBe(false);
      expect(result.reason).toBe('env:REA_REVIEWER');
    });

    it('registry.reviewer wins over policy', async () => {
      const codex = fakeReviewer('codex', true);
      const claude = fakeReviewer('claude-self', true);
      const result = await selectReviewer(
        basePolicy({ review: { codex_required: false } }),
        baseRegistry({ reviewer: 'codex' }),
        {} as NodeJS.ProcessEnv,
        depsWith(codex, claude),
      );
      expect(result.reviewer.name).toBe('codex');
      expect(result.degraded).toBe(false);
      expect(result.reason).toBe('registry.reviewer');
    });

    it('policy codex_required=false wins over default', async () => {
      const codex = fakeReviewer('codex', true); // Codex available but policy opts out
      const claude = fakeReviewer('claude-self', true);
      const result = await selectReviewer(
        basePolicy({ review: { codex_required: false } }),
        baseRegistry(),
        {} as NodeJS.ProcessEnv,
        depsWith(codex, claude),
      );
      expect(result.reviewer.name).toBe('claude-self');
      // First-class: NOT degraded.
      expect(result.degraded).toBe(false);
      expect(result.reason).toBe('policy.review.codex_required=false');
    });
  });

  describe('env override', () => {
    it('rejects unknown REA_REVIEWER values', async () => {
      const deps = depsWith(
        fakeReviewer('codex', true),
        fakeReviewer('claude-self', true),
      );
      await expect(
        selectReviewer(
          basePolicy(),
          baseRegistry(),
          { REA_REVIEWER: 'grok' } as NodeJS.ProcessEnv,
          deps,
        ),
      ).rejects.toThrow(/REA_REVIEWER=grok/);
    });

    it('empty REA_REVIEWER falls through to the default path', async () => {
      const codex = fakeReviewer('codex', true);
      const claude = fakeReviewer('claude-self', true);
      const result = await selectReviewer(
        basePolicy(),
        baseRegistry(),
        { REA_REVIEWER: '' } as NodeJS.ProcessEnv,
        depsWith(codex, claude),
      );
      expect(result.reason).toBe('default:codex-available');
    });

    it('REA_REVIEWER=codex is honored even without probing', async () => {
      // Codex "unavailable" but operator forced it — we still return Codex
      // and let its own error path surface the config issue.
      const codex = fakeReviewer('codex', false);
      const claude = fakeReviewer('claude-self', true);
      const result = await selectReviewer(
        basePolicy(),
        baseRegistry(),
        { REA_REVIEWER: 'codex' } as NodeJS.ProcessEnv,
        depsWith(codex, claude),
      );
      expect(result.reviewer.name).toBe('codex');
      expect(result.degraded).toBe(false);
      expect(codex.isAvailable).not.toHaveBeenCalled();
    });
  });

  describe('default path', () => {
    it('returns Codex with degraded=false when Codex is available', async () => {
      const codex = fakeReviewer('codex', true);
      const claude = fakeReviewer('claude-self', true);
      const result = await selectReviewer(
        basePolicy(),
        baseRegistry(),
        {} as NodeJS.ProcessEnv,
        depsWith(codex, claude),
      );
      expect(result.reviewer.name).toBe('codex');
      expect(result.degraded).toBe(false);
      expect(result.reason).toBe('default:codex-available');
      expect(claude.isAvailable).not.toHaveBeenCalled();
    });

    it('falls back to ClaudeSelfReviewer with degraded=true when Codex is unavailable', async () => {
      const codex = fakeReviewer('codex', false);
      const claude = fakeReviewer('claude-self', true);
      const result = await selectReviewer(
        basePolicy(),
        baseRegistry(),
        {} as NodeJS.ProcessEnv,
        depsWith(codex, claude),
      );
      expect(result.reviewer.name).toBe('claude-self');
      expect(result.degraded).toBe(true);
      expect(result.reason).toBe('default:codex-unavailable-fallback');
    });

    it('throws NoReviewerAvailableError when neither reviewer is available', async () => {
      const codex = fakeReviewer('codex', false);
      const claude = fakeReviewer('claude-self', false);
      await expect(
        selectReviewer(
          basePolicy(),
          baseRegistry(),
          {} as NodeJS.ProcessEnv,
          depsWith(codex, claude),
        ),
      ).rejects.toThrow(NoReviewerAvailableError);
    });

    it('NoReviewerAvailableError message mentions the escape hatch', async () => {
      const codex = fakeReviewer('codex', false);
      const claude = fakeReviewer('claude-self', false);
      await expect(
        selectReviewer(
          basePolicy(),
          baseRegistry(),
          {} as NodeJS.ProcessEnv,
          depsWith(codex, claude),
        ),
      ).rejects.toThrow(/REA_SKIP_CODEX_REVIEW/);
    });
  });

  describe('policy-first no-Codex mode', () => {
    it('returns ClaudeSelfReviewer with degraded=false when codex_required=false', async () => {
      const codex = fakeReviewer('codex', true);
      const claude = fakeReviewer('claude-self', true);
      const result = await selectReviewer(
        basePolicy({ review: { codex_required: false } }),
        baseRegistry(),
        {} as NodeJS.ProcessEnv,
        depsWith(codex, claude),
      );
      expect(result.reviewer.name).toBe('claude-self');
      expect(result.degraded).toBe(false);
    });

    it('codex_required=true behaves like the default (Codex preferred)', async () => {
      const codex = fakeReviewer('codex', true);
      const claude = fakeReviewer('claude-self', true);
      const result = await selectReviewer(
        basePolicy({ review: { codex_required: true } }),
        baseRegistry(),
        {} as NodeJS.ProcessEnv,
        depsWith(codex, claude),
      );
      expect(result.reviewer.name).toBe('codex');
      expect(result.reason).toBe('default:codex-available');
    });
  });
});
