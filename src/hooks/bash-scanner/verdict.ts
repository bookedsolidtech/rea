/**
 * Verdict shape — the contract between the bash-shim hooks and the
 * `rea hook scan-bash` CLI.
 *
 * Stability: this JSON shape is part of the public hook protocol from
 * 0.23.0 onward. The shim hooks under `hooks/protected-paths-bash-gate.sh`
 * and `hooks/blocked-paths-bash-gate.sh` shell out to `rea hook scan-bash`
 * and parse this exact shape with `jq`. Any change here that the bash
 * shims don't survive is a breaking change — bump the major or stage
 * with a fallback shape.
 *
 * Snapshot tests in `__tests__/hooks/bash-scanner/verdict-shape.test.ts`
 * lock the wire format to keep this honest.
 */

/**
 * The form of write the walker detected. New shapes can land at the
 * end; the bash shims do not branch on these — they only forward the
 * verdict — so adding a new tag is non-breaking.
 *
 * Naming convention: `<utility>_<role>` for argv-driven detections,
 * `redirect` for shell I/O redirects (covers `>`, `>>`, `>|`, `&>`,
 * fd-prefixed variants), `nested_shell_inner` for unwrapped
 * `bash -c`/`sh -c` payloads.
 */
export type DetectedForm =
  | 'redirect'
  | 'cp_dest'
  | 'cp_t_flag'
  | 'mv_dest'
  | 'mv_t_flag'
  | 'tee_arg'
  | 'sed_i'
  | 'dd_of'
  | 'truncate_arg'
  | 'install_dest'
  | 'ln_dest'
  | 'awk_inplace'
  | 'awk_source'
  | 'ed_target'
  | 'ex_target'
  | 'find_exec_inner'
  | 'find_exec_placeholder_unresolvable'
  | 'xargs_unresolvable'
  | 'parallel_stdin_unresolvable'
  | 'git_filter_branch_inner'
  | 'git_rebase_exec_inner'
  | 'git_bisect_run_inner'
  | 'git_commit_template'
  | 'git_rm_dest'
  | 'git_mv_src'
  | 'archive_extract_dest'
  | 'archive_extract_unresolvable'
  | 'archive_member_dest'
  // Codex round 12 F12-5: archive CREATE direction. tar -cf / zip /
  // 7z a-u-d / cmake -E variants produce or overwrite the archive at
  // the named OUTPUT path. If OUTPUT is a protected path (e.g.
  // `tar -cf .rea/policy.yaml docs/`), the operation overwrites it.
  | 'archive_create_dest'
  | 'gzip_compress_dest'
  // Codex round 12 F12-6 / F12-7: cmake -E utility surface and
  // mkfifo/mknod special-file creates. These are write-class
  // primitives whose target argv is parsed by dedicated dispatchers.
  | 'cmake_e_dest'
  | 'mkfifo_dest'
  | 'mknod_dest'
  | 'node_e_path'
  | 'python_c_path'
  | 'ruby_e_path'
  | 'perl_e_path'
  | 'php_r_path'
  | 'process_subst_inner'
  | 'nested_shell_inner';

/**
 * Source position for a detected write. 1-indexed (matches the parser's
 * convention) so the operator-facing error message reads naturally.
 */
export interface SourcePosition {
  line: number;
  col: number;
}

/**
 * The single verdict the scanner returns to its caller. Allow paths
 * leave reason/hit_pattern/detected_form/source_position unset; block
 * paths set all four where determinable.
 *
 * `parse_failure_reason` is set ONLY when the parser itself rejected
 * the input — distinct from a successfully-parsed but policy-violating
 * command. Lets the operator-facing error tell the difference between
 * "you wrote bad bash" and "you tried to write to .rea/HALT".
 */
export interface Verdict {
  verdict: 'allow' | 'block';
  reason?: string;
  hit_pattern?: string;
  detected_form?: DetectedForm;
  source_position?: SourcePosition;
  /**
   * Set on parse-failure blocks only. Format: parser library's raw
   * error message verbatim, prefixed with "parser: ". Operators can
   * paste this into a bug report without further redaction.
   */
  parse_failure_reason?: string;
}

/** Construct a uniform allow verdict. */
export function allowVerdict(): Verdict {
  return { verdict: 'allow' };
}

/**
 * Construct a uniform block verdict for a successful-parse + policy
 * violation. All four explanation fields are required so the operator
 * gets actionable context.
 */
export function blockVerdict(args: {
  reason: string;
  hitPattern: string;
  detectedForm: DetectedForm;
  sourcePosition?: SourcePosition;
}): Verdict {
  return {
    verdict: 'block',
    reason: args.reason,
    hit_pattern: args.hitPattern,
    detected_form: args.detectedForm,
    ...(args.sourcePosition !== undefined ? { source_position: args.sourcePosition } : {}),
  };
}

/**
 * Construct a uniform block verdict for a parse-failure event. We
 * always block — the alternative is "scanner can't tell, assume safe"
 * which is the entire bug class this rewrite exists to close.
 *
 * `parserMessage` flows through to the operator. We DO NOT sanitize
 * it — the parser's messages are static (no user-controlled
 * interpolation in modern mvdan-sh) and including them helps debug
 * malformed payloads in the field.
 */
export function parseFailureVerdict(parserMessage: string): Verdict {
  return {
    verdict: 'block',
    reason: 'rea: bash parser failed; refusing on uncertainty',
    parse_failure_reason: `parser: ${parserMessage}`,
  };
}
