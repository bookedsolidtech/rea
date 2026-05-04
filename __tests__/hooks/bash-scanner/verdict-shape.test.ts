/**
 * Snapshot test for the `Verdict` JSON wire format. The bash shims at
 * `hooks/protected-paths-bash-gate.sh` and `hooks/blocked-paths-bash-gate.sh`
 * parse this exact shape with `jq`. Any breaking change here that
 * the shims don't survive is a major-version-worthy break.
 *
 * If a future change adds a new field, that's fine — extending the
 * shape is non-breaking. If a field is RENAMED or REMOVED the
 * snapshots flip and the maintainer must consciously update both
 * the shim AND the snapshot, which forces them to think about
 * downstream consumers.
 */

import { describe, expect, it } from 'vitest';
import { runProtectedScan, runBlockedScan } from '../../../src/hooks/bash-scanner/index.js';
import {
  allowVerdict,
  blockVerdict,
  parseFailureVerdict,
} from '../../../src/hooks/bash-scanner/index.js';

const REA_ROOT = process.cwd();

describe('Verdict shape — wire format snapshot', () => {
  it('allow shape', () => {
    const v = runProtectedScan(
      { reaRoot: REA_ROOT, policy: { protected_paths_relax: [] }, stderr: () => {} },
      'echo hello',
    );
    expect(v).toEqual({ verdict: 'allow' });
  });

  it('block shape — protected redirect', () => {
    const v = runProtectedScan(
      { reaRoot: REA_ROOT, policy: { protected_paths_relax: [] }, stderr: () => {} },
      'printf x > .rea/HALT',
    );
    expect(v.verdict).toBe('block');
    // All four explanation fields present.
    expect(v.reason).toBeTypeOf('string');
    expect(v.hit_pattern).toBe('.rea/HALT');
    expect(v.detected_form).toBe('redirect');
    expect(v.source_position).toEqual({ line: 1, col: 10 });
  });

  it('block shape — blocked-mode policy hit', () => {
    const v = runBlockedScan(
      { reaRoot: REA_ROOT, blockedPaths: ['.env', '.env.*'] },
      'echo x > .env',
    );
    expect(v.verdict).toBe('block');
    expect(v.hit_pattern).toBe('.env');
    expect(v.detected_form).toBe('redirect');
  });

  it('parse-failure shape', () => {
    const v = runProtectedScan(
      { reaRoot: REA_ROOT, policy: { protected_paths_relax: [] }, stderr: () => {} },
      'echo "unterminated',
    );
    expect(v.verdict).toBe('block');
    expect(v.parse_failure_reason).toBeDefined();
    expect(v.parse_failure_reason).toMatch(/^parser:/);
    expect(v.reason).toBe('rea: bash parser failed; refusing on uncertainty');
    // hit_pattern / detected_form / source_position are absent on
    // parse-failure verdicts.
    expect(v.hit_pattern).toBeUndefined();
    expect(v.detected_form).toBeUndefined();
    expect(v.source_position).toBeUndefined();
  });

  it('all DetectedForm tags are constructable via blockVerdict — codex round 1 F-32', () => {
    // Snapshot-locks the union by enumerating every member and
    // confirming blockVerdict accepts each one. If a future PR adds a
    // new DetectedForm without touching this list, TypeScript will
    // still accept it (the value type is parametric); but if a member
    // is REMOVED the const-array reference below stops type-checking.
    const allForms = [
      'redirect',
      'cp_dest',
      'cp_t_flag',
      'mv_dest',
      'mv_t_flag',
      'tee_arg',
      'sed_i',
      'dd_of',
      'truncate_arg',
      'install_dest',
      'ln_dest',
      'awk_inplace',
      'awk_source',
      'ed_target',
      'ex_target',
      'find_exec_inner',
      'find_exec_placeholder_unresolvable',
      'xargs_unresolvable',
      'parallel_stdin_unresolvable',
      'git_filter_branch_inner',
      'git_rebase_exec_inner',
      'git_bisect_run_inner',
      'git_commit_template',
      'git_rm_dest',
      'git_mv_src',
      'archive_extract_dest',
      'archive_extract_unresolvable',
      'archive_member_dest',
      // Codex round 12 F12-5/F12-6/F12-7: new forms.
      'archive_create_dest',
      'cmake_e_dest',
      'mkfifo_dest',
      'mknod_dest',
      'gzip_compress_dest',
      'node_e_path',
      'python_c_path',
      'ruby_e_path',
      'perl_e_path',
      'php_r_path',
      'process_subst_inner',
      'nested_shell_inner',
    ] as const;
    for (const form of allForms) {
      const v = blockVerdict({
        reason: 'r',
        hitPattern: 'p',
        detectedForm: form,
        sourcePosition: { line: 1, col: 1 },
      });
      expect(v.verdict).toBe('block');
      expect(v.detected_form).toBe(form);
    }
  });

  it('factory functions produce identical shapes', () => {
    expect(allowVerdict()).toEqual({ verdict: 'allow' });
    const block = blockVerdict({
      reason: 'r',
      hitPattern: 'p',
      detectedForm: 'redirect',
      sourcePosition: { line: 1, col: 1 },
    });
    expect(block).toEqual({
      verdict: 'block',
      reason: 'r',
      hit_pattern: 'p',
      detected_form: 'redirect',
      source_position: { line: 1, col: 1 },
    });
    const fail = parseFailureVerdict('boom');
    expect(fail).toEqual({
      verdict: 'block',
      reason: 'rea: bash parser failed; refusing on uncertainty',
      parse_failure_reason: 'parser: boom',
    });
  });
});
