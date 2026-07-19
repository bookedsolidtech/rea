/**
 * 0.54.0 — worktree-state integration tests against REAL `git worktree
 * add` topologies (the plan's verification matrix). These are the
 * end-to-end proofs behind the multi-stream fix:
 *
 *   (i)   coverage audit entries land on the COMMON chain while
 *         last-review.json stays LOCAL to the worktree;
 *   (ii)  preflight coverage for a sha reviewed in one worktree
 *         satisfies the gate from another;
 *   (iii) a COMMON HALT freezes hooks running in a worktree, and a
 *         worktree-local legacy HALT still freezes its own stream;
 *   (iv)  concurrent audit appends from two worktrees serialize on ONE
 *         lock and keep the hash chain verifiable;
 *   (v)   the verdict cache is shared (sha-keyed reuse across streams);
 *   (vi)  an absolute-path Bash write from a worktree into the primary
 *         checkout's protected `.rea/` state is refused.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveReaRoots } from '../../src/lib/worktree-roots.js';
import { checkHaltRoots } from '../../src/hooks/_lib/halt-check.js';
import { appendAuditRecord, InvocationStatus, Tier } from '../../src/audit/append.js';
import { computeHash } from '../../src/audit/fs.js';
import type { AuditRecord } from '../../src/gateway/middleware/audit-types.js';
import { findRecentLocalReview } from '../../src/cli/preflight.js';
import { writeVerdict, lookupVerdict } from '../../src/hooks/push-gate/verdict-cache.js';
import { runProtectedScan, runBlockedScan } from '../../src/hooks/bash-scanner/index.js';
import { runBlockedPathsBashGate } from '../../src/hooks/blocked-paths-bash-gate/index.js';
import { runSettingsProtection } from '../../src/hooks/settings-protection/index.js';
import { runBlockedPathsEnforcer } from '../../src/hooks/blocked-paths-enforcer/index.js';

let scratch: string;
let repo: string;
let wtA: string;
let wtB: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rea-wtint-')));
  repo = path.join(scratch, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t');
  git(repo, 'config', 'user.name', 't');
  fs.mkdirSync(path.join(repo, '.rea'));
  fs.writeFileSync(
    path.join(repo, '.rea', 'policy.yaml'),
    'version: "1"\nprofile: "test"\ninstalled_by: "t"\nblocked_paths: []\n',
  );
  fs.writeFileSync(path.join(repo, 'README.md'), 'x\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'init', '--no-gpg-sign');
  wtA = path.join(scratch, 'wt-a');
  wtB = path.join(scratch, 'wt-b');
  git(repo, 'worktree', 'add', '-q', wtA, '-b', 'stream-a');
  git(repo, 'worktree', 'add', '-q', wtB, '-b', 'stream-b');
});
afterEach(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

describe('worktree-state integration (real git worktree add)', () => {
  it('(i)+(ii) coverage written from worktree A satisfies preflight lookup for worktree B', async () => {
    const rootsA = resolveReaRoots(wtA);
    expect(rootsA.commonRoot).toBe(repo);
    const headSha = git(wtA, 'rev-parse', 'HEAD');

    // Simulate what `rea review` does post-0.54.0: coverage entry to the
    // COMMON chain.
    await appendAuditRecord(rootsA.commonRoot, {
      tool_name: 'rea.local_review',
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: { head_sha: headSha, verdict: 'pass' },
    });

    // Both worktrees are at the same sha; the lookup from B's resolved
    // COMMON root finds A's entry.
    const rootsB = resolveReaRoots(wtB);
    const lookup = findRecentLocalReview(rootsB.commonRoot, headSha, 3600, new Date());
    expect(lookup.found).toBe(true);

    // And the audit file physically lives in the PRIMARY checkout only.
    expect(fs.existsSync(path.join(repo, '.rea', 'audit.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(wtA, '.rea', 'audit.jsonl'))).toBe(false);
  });

  it('(iii) COMMON HALT freezes worktree hooks; legacy LOCAL HALT still freezes its stream', async () => {
    const roots = resolveReaRoots(wtA);
    // Repo-wide freeze.
    fs.writeFileSync(path.join(repo, '.rea', 'HALT'), 'incident: freeze all streams');
    expect(checkHaltRoots(roots.localRoot, roots.commonRoot).halted).toBe(true);
    // A full hook honors it end-to-end (blocked-paths gate, exit 2).
    const r = await runBlockedPathsBashGate({
      reaRoot: wtA,
      stdinOverride: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo hi' } }),
    });
    expect(r.exitCode).toBe(2);
    fs.rmSync(path.join(repo, '.rea', 'HALT'));

    // Legacy per-worktree HALT (pre-0.54.0 file) still freezes A…
    fs.writeFileSync(path.join(wtA, '.rea', 'HALT'), 'legacy local freeze');
    expect(checkHaltRoots(resolveReaRoots(wtA).localRoot, repo).halted).toBe(true);
    // …but not B (local files are per-stream).
    expect(checkHaltRoots(resolveReaRoots(wtB).localRoot, repo).halted).toBe(false);
  });

  it('(iv) concurrent appends from two worktrees keep ONE verifiable chain', async () => {
    const commonA = resolveReaRoots(wtA).commonRoot;
    const commonB = resolveReaRoots(wtB).commonRoot;
    expect(commonA).toBe(commonB);
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        appendAuditRecord(i % 2 === 0 ? commonA : commonB, {
          tool_name: 'rea.test.concurrent',
          server_name: 'rea',
          tier: Tier.Read,
          status: InvocationStatus.Allowed,
          metadata: { i },
        }),
      ),
    );
    // Verify the hash chain by hand: every record's stored hash matches a
    // recompute, and prev_hash linkage is unbroken — the property that
    // breaks if two lock targets ever coexist.
    const lines = fs
      .readFileSync(path.join(repo, '.rea', 'audit.jsonl'), 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(12);
    let prev = '0'.repeat(64);
    for (const line of lines) {
      const rec = JSON.parse(line) as AuditRecord;
      expect(rec.prev_hash).toBe(prev);
      const { hash, ...rest } = rec;
      expect(computeHash(rest)).toBe(hash);
      prev = hash;
    }
  });

  it('(v) verdict cache is shared: a PASS cached from worktree A hits from worktree B', async () => {
    const headSha = git(wtA, 'rev-parse', 'HEAD');
    const commonA = resolveReaRoots(wtA).commonRoot;
    await writeVerdict(commonA, headSha, {
      verdict: 'pass',
      finding_count: 0,
      reviewed_at: new Date().toISOString(),
      model: 'gpt-5.5',
      reasoning_effort: 'high',
      ttl_ms: 60_000,
    });
    const commonB = resolveReaRoots(wtB).commonRoot;
    const hit = lookupVerdict(commonB, headSha);
    expect(hit.hit).toBe(true);
  });

  it('(vi) absolute-path write into the PRIMARY checkout\'s .rea/ from a worktree is refused', () => {
    const verdict = runProtectedScan(
      {
        reaRoot: wtA,
        commonRoot: repo,
        policy: { protected_paths_relax: [] },
        stderr: () => {},
      },
      `echo forged > ${repo}/.rea/HALT`,
    );
    expect(verdict.verdict).toBe('block');

    // …and the audit chain too.
    const verdict2 = runProtectedScan(
      {
        reaRoot: wtA,
        commonRoot: repo,
        policy: { protected_paths_relax: [] },
        stderr: () => {},
      },
      `cp /tmp/x ${repo}/.rea/last-review.cache.json`,
    );
    expect(verdict2.verdict).toBe('block');

    // …and the repo's SHARED audit chain + TOFU anchors (round-23 P1:
    // repository-wide enforcement state a sibling stream must not forge).
    for (const target of ['.rea/audit.jsonl', '.rea/fingerprints.json']) {
      const v = runProtectedScan(
        { reaRoot: wtA, commonRoot: repo, policy: { protected_paths_relax: [] }, stderr: () => {} },
        `echo forged > ${repo}/${target}`,
      );
      expect(v.verdict, target).toBe('block');
    }

    // Round-44 P1: a SAME-ROOT session IN the primary checkout (which
    // is the common root, with linked worktrees) must ALSO be blocked
    // from writing the now-shared audit chain / TOFU anchors — a plain
    // relative redirect, no cross-root path involved.
    for (const target of ['.rea/audit.jsonl', '.rea/fingerprints.json', '.rea.lock']) {
      const v = runProtectedScan(
        {
          reaRoot: repo,
          commonRoot: repo,
          siblingRoots: [wtA, wtB],
          policy: { protected_paths_relax: [] },
          stderr: () => {},
        },
        `echo forged > ${target}`,
      );
      expect(v.verdict, `same-root ${target}`).toBe('block');
    }

    // Ordinary out-of-repo absolute writes stay allowed (no scope creep).
    const verdict3 = runProtectedScan(
      { reaRoot: wtA, commonRoot: repo, policy: { protected_paths_relax: [] }, stderr: () => {} },
      'echo x > /tmp/unrelated.txt',
    );
    expect(verdict3.verdict).toBe('allow');
  });

  it('(vi-b) WRITE-tier absolute targets into the primary checkout are refused too (round-4)', async () => {
    // settings-protection: Write to the primary's HALT via absolute path.
    const sp = await runSettingsProtection({
      reaRoot: wtA,
      stdinOverride: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: path.join(repo, '.rea', 'HALT'), content: 'forged' },
      }),
    });
    expect(sp.exitCode).toBe(2);

    // blocked-paths-enforcer: policy blocks package.json; absolute write
    // into the PRIMARY checkout's copy from the worktree session refuses.
    fs.writeFileSync(
      path.join(wtA, '.rea', 'policy.yaml'),
      'version: "1"\nprofile: "test"\ninstalled_by: "t"\nblocked_paths:\n  - package.json\n',
    );
    const bp = await runBlockedPathsEnforcer({
      reaRoot: wtA,
      stdinOverride: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: path.join(repo, 'package.json'), content: '{}' },
      }),
    });
    expect(bp.exitCode).toBe(2);
  });

  it('(vi-c) worktree-local SYMLINK into the primary checkout is refused at every tier (round-5)', async () => {
    // shared -> <primary>/.rea, then write through it.
    const link = path.join(wtA, 'shared');
    fs.symlinkSync(path.join(repo, '.rea'), link);

    // Bash tier (protected scan): logical path is worktree-relative,
    // only the SYMLINK-resolved form reveals the primary target.
    const v = runProtectedScan(
      { reaRoot: wtA, commonRoot: repo, policy: { protected_paths_relax: [] }, stderr: () => {} },
      'echo forged > shared/HALT',
    );
    expect(v.verdict).toBe('block');

    // Write tier (settings-protection).
    const sp = await runSettingsProtection({
      reaRoot: wtA,
      stdinOverride: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: path.join(link, 'HALT'), content: 'forged' },
      }),
    });
    expect(sp.exitCode).toBe(2);

    // Bash tier (blocked scan) via a link at the repo root.
    const link2 = path.join(wtA, 'primary');
    fs.symlinkSync(repo, link2);
    const bv = runBlockedScan(
      { reaRoot: wtA, commonRoot: repo, blockedPaths: ['package.json'] },
      'echo x > primary/package.json',
    );
    expect(bv.verdict).toBe('block');
  });

  it('(vi-f) ALIASED cross-root path still trips protection (round-45)', async () => {
    // A symlink OUTSIDE both checkouts that points at the primary — the
    // payload addresses the primary through the alias. Lexically the
    // path is not a child of commonRoot, so cross-root detection must
    // realpath-canonicalize to catch it.
    const aliasPrimary = path.join(scratch, 'alias-to-primary');
    fs.symlinkSync(repo, aliasPrimary);

    // Bash tier: aliased write into the primary's shared HALT.
    const v = runProtectedScan(
      { reaRoot: wtA, commonRoot: repo, policy: { protected_paths_relax: [] }, stderr: () => {} },
      `echo forged > ${aliasPrimary}/.rea/HALT`,
    );
    expect(v.verdict).toBe('block');

    // …and the shared audit chain through the same alias.
    const v2 = runProtectedScan(
      { reaRoot: wtA, commonRoot: repo, policy: { protected_paths_relax: [] }, stderr: () => {} },
      `echo forged > ${aliasPrimary}/.rea/audit.jsonl`,
    );
    expect(v2.verdict).toBe('block');

    // Write tier: aliased Write into the primary's HALT.
    const sp = await runSettingsProtection({
      reaRoot: wtA,
      stdinOverride: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: path.join(aliasPrimary, '.rea', 'HALT'), content: 'forged' },
      }),
    });
    expect(sp.exitCode).toBe(2);

    // Blocked-scan tier (round-3 P2): a blocked_paths write into the
    // primary through the alias must also be caught (was skipped as
    // outside-root before canonical membership).
    const bv = runBlockedScan(
      { reaRoot: wtA, commonRoot: repo, blockedPaths: ['package.json'] },
      `echo x > ${aliasPrimary}/package.json`,
    );
    expect(bv.verdict).toBe('block');

    // Write/Edit tier (round-4 P1): blocked-paths-enforcer must
    // canonicalize the aliased absolute path too.
    fs.writeFileSync(
      path.join(repo, '.rea', 'policy.yaml'),
      'version: "1"\nprofile: "test"\ninstalled_by: "t"\nblocked_paths:\n  - package.json\n',
    );
    const bp = await runBlockedPathsEnforcer({
      reaRoot: wtA,
      stdinOverride: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: path.join(aliasPrimary, 'package.json'), content: '{}' },
      }),
    });
    expect(bp.exitCode).toBe(2);
  });

  it('(vi-e) REVERSE bridge: symlink in the PRIMARY checkout back into the worktree (round-17)', () => {
    // bridge -> <wtA>/.rea lives in the PRIMARY checkout. The logical
    // form is common-relative ("bridge/HALT" — no pattern hit); only
    // the symlink-resolved form reveals the LOCAL worktree's HALT.
    const bridge = path.join(repo, 'bridge');
    fs.symlinkSync(path.join(wtA, '.rea'), bridge);
    const v = runProtectedScan(
      { reaRoot: wtA, commonRoot: repo, policy: { protected_paths_relax: [] }, stderr: () => {} },
      `echo forged > ${repo}/bridge/HALT`,
    );
    expect(v.verdict).toBe('block');

    // Same class at the blocked-paths tier: a primary-checkout symlink
    // to the worktree root must not launder a local blocked_paths hit.
    const bridge2 = path.join(repo, 'bridge2');
    fs.symlinkSync(wtA, bridge2);
    const bv = runBlockedScan(
      { reaRoot: wtA, commonRoot: repo, blockedPaths: ['package.json'] },
      `cp /tmp/x ${repo}/bridge2/package.json`,
    );
    expect(bv.verdict).toBe('block');
  });

  it('(vi-g) same-repo symlink into .rea does not bypass shared-state protection (round-11 P1)', async () => {
    // `logs -> .rea` inside the worktree. A Write to `logs/audit.jsonl`
    // must be refused via the §6c symlink-resolution path (the same-root
    // directHit already carried the shared-state patterns; the symlink
    // path did not until round-11).
    fs.symlinkSync(path.join(wtA, '.rea'), path.join(wtA, 'logs'));
    for (const leaf of ['audit.jsonl', 'fingerprints.json']) {
      const sp = await runSettingsProtection({
        reaRoot: wtA,
        stdinOverride: JSON.stringify({
          tool_name: 'Write',
          tool_input: { file_path: path.join(wtA, 'logs', leaf), content: 'forged' },
        }),
      });
      expect(sp.exitCode, leaf).toBe(2);
    }
  });

  it('(vi-d) SIBLING worktree governed state is protected too (round-10 P1)', async () => {
    // Absolute Write into sibling B's policy from a session in A.
    const sp = await runSettingsProtection({
      reaRoot: wtA,
      stdinOverride: JSON.stringify({
        tool_name: 'Write',
        tool_input: { file_path: path.join(wtB, '.rea', 'policy.yaml'), content: 'forged' },
      }),
    });
    expect(sp.exitCode).toBe(2);

    // Bash tier: absolute redirect into sibling B's HALT.
    const v = runProtectedScan(
      {
        reaRoot: wtA,
        commonRoot: repo,
        siblingRoots: [wtB],
        policy: { protected_paths_relax: [] },
        stderr: () => {},
      },
      `echo forged > ${wtB}/.rea/HALT`,
    );
    expect(v.verdict).toBe('block');
  });

  it('(ii-b) PUSH coverage: clean-tree review of the sha covers a DIRTY sibling (round-10 P1b)', async () => {
    const headSha = git(wtA, 'rev-parse', 'HEAD');
    const pristine = git(wtA, 'rev-parse', 'HEAD^{tree}');
    // Worktree A reviewed the CLEAN tree of sha X.
    await appendAuditRecord(repo, {
      tool_name: 'rea.local_review',
      server_name: 'rea',
      tier: Tier.Read,
      status: InvocationStatus.Allowed,
      metadata: { head_sha: headSha, content_token: pristine, verdict: 'pass' },
    });
    // Worktree B is at the same sha with unrelated WIP (different token).
    const dirtyToken = 'f'.repeat(40);
    // PUSH gating: pristine fallback covers.
    const pushLookup = findRecentLocalReview(repo, headSha, 3600, new Date(), dirtyToken, pristine);
    expect(pushLookup.found).toBe(true);
    // COMMIT gating (no pristine token supplied): token mismatch stays
    // authoritative — the round-27 F3 defense is intact.
    const commitLookup = findRecentLocalReview(repo, headSha, 3600, new Date(), dirtyToken);
    expect(commitLookup.found).toBe(false);
  });
});
