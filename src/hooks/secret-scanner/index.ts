/**
 * Node-binary port of `hooks/secret-scanner.sh`.
 *
 * 0.34.0 Phase 2 port #3 (tier-2 medium-complexity hooks with enforcer
 * logic).
 *
 * Detects credential patterns in content about to be written via the
 * Write/Edit/MultiEdit/NotebookEdit Claude Code tools and blocks (exit
 * 2) when a HIGH-severity pattern matches a non-placeholder substring.
 * Last-resort pre-write guard — gitleaks (pre-commit) is the primary
 * gate; this hook stops the obvious credential-in-source-file shapes
 * before they ever touch disk.
 *
 * Behavioral contract preserves the bash hook byte-for-byte:
 *
 *   1. HALT check → exit 2 with shared banner.
 *   2. Read stdin via `parseWriteHookPayload`. Extracts `file_path` /
 *      `notebook_path` and the canonical content priority:
 *        content > new_string > edits[].new_string joined > new_source.
 *      Empty content → exit 0.
 *   3. Suffix-based file_path exclusion: `*.env.example` / `*.env.sample`
 *      pass through silently. Test files are NOT excluded — the
 *      placeholder filter handles legitimate test fixtures.
 *   4. Apply the bash hook's awk line filter:
 *        - Strip lines whose trimmed form starts with `#` (shell comment).
 *        - Strip lines where `process.env.VAR` is the RHS of an
 *          assignment (`= process.env.SOMETHING`).
 *        - Strip lines mentioning `os.environ[`.
 *      Anything left is the corpus the patterns run against.
 *   5. Run each of the 17 patterns (12 HIGH + 5 MEDIUM) against the
 *      filtered corpus. For each match:
 *        - Apply `isPlaceholder()` filter (matches the bash hook's
 *          `is_placeholder` shell function — placeholder forms like
 *          `<your_key>`, `your_api_key`, `example_token`,
 *          `aaaaaaa...`, etc. are dropped).
 *        - Truncate the matching substring at 60 chars for display.
 *        - Cap collected matches at 5 per pattern.
 *   6. If ANY HIGH match remains → exit 2 with the "SECRET DETECTED"
 *      banner. Else if MEDIUM matches → emit advisory + exit 0. No
 *      matches → exit 0.
 *
 * MultiEdit handling: `parseWriteHookPayload` joins every `edits[i].
 * new_string` with `\n`. This intentionally folds the fragments into
 * one corpus for scanning; the joined newline boundary preserves
 * line-anchored patterns. The bash counterpart used the same join
 * shape via `extract_write_content` in `_lib/payload-read.sh`.
 *
 * 0.14.0 hardening — type-guard against malformed payloads (non-string
 * `new_string`, non-array `edits`, etc.) lives in the shared
 * `parseWriteHookPayload`. Defensive coercion means a crafted
 * `{"edits":42}` payload doesn't throw at the boundary; it's treated as
 * missing.
 */

import type { Buffer } from 'node:buffer';
import path from 'node:path';
import { checkHalt, formatHaltBanner } from '../_lib/halt-check.js';
import {
  parseWriteHookPayload,
  MalformedPayloadError,
  TypePayloadError,
  readStdinWithTimeout,
} from '../_lib/payload.js';

export interface SecretScannerOptions {
  reaRoot?: string;
  stdinOverride?: string | Buffer;
  stderrWrite?: (s: string) => void;
}

export interface SecretScannerResult {
  exitCode: number;
  stderr: string;
  /**
   * Test seam — surfaces the matches the scanner accepted (post-
   * placeholder filter, post-truncation). Ordered HIGH first, then
   * MEDIUM. Useful for assertion-driven tests without grepping stderr.
   */
  matches: ScannerMatch[];
}

export interface ScannerMatch {
  severity: 'HIGH' | 'MEDIUM';
  label: string;
  snippet: string;
}

/**
 * Pattern descriptors. The bash hook used ERE strings via `grep -oE`;
 * the JS port uses native RegExp. Each pattern carries:
 *   - severity (HIGH = blocking; MEDIUM = advisory)
 *   - label   (banner display string)
 *   - regex   (compiled global; the `g` flag is required for matchAll)
 *
 * Pattern parity with the bash hook is line-by-line. Where the bash
 * hook used POSIX character classes (`[[:space:]]`) we use `\s`; where
 * it used `[A-Za-z0-9]` we keep that literal. Case-insensitive flags
 * are applied per-pattern to match the bash hook's `grep -oE` posture
 * — note that the bash `grep -oE` was case-SENSITIVE by default, so
 * unless a pattern explicitly used `[Aa][Ww][Ss]_…` style alternation
 * we keep the JS form case-sensitive too.
 */
export interface SecretPatternDescriptor {
  severity: 'HIGH' | 'MEDIUM';
  label: string;
  regex: RegExp;
}

/**
 * The canonical pattern catalog. Order matters for the bash parity test
 * — matches are emitted in the order patterns are listed.
 *
 * NOTE: We do NOT call into `src/gateway/middleware/redact.ts`'s
 * `SECRET_PATTERNS` here even though the catalog overlaps. The bash
 * hook had its OWN extended catalog (12 HIGH + 5 MEDIUM, including
 * Stripe live/test keys, Supabase JWTs, database URLs) that's a
 * superset of the redact middleware's 12-pattern set. Folding the two
 * catalogs together is a deliberate non-goal of 0.34.0 — keep the
 * write-tier hook's coverage stable; revisit unification in a future
 * release once both sites are Node-binary.
 */
const SECRET_PATTERNS: ReadonlyArray<SecretPatternDescriptor> = [
  // ── HIGH severity (blocking) ─────────────────────────────────────
  {
    severity: 'HIGH',
    label: 'AWS Access Key ID',
    regex: /AKIA[0-9A-Z]{16}/g,
  },
  {
    severity: 'HIGH',
    label: 'AWS Secret Access Key',
    regex: /[Aa][Ww][Ss]_SECRET_ACCESS_KEY\s*=\s*[A-Za-z0-9/+]{40}/g,
  },
  {
    severity: 'HIGH',
    label: 'Private key block',
    regex: /-----BEGIN (RSA|EC|OPENSSH|PGP) PRIVATE KEY-----/g,
  },
  {
    severity: 'HIGH',
    label: 'Anthropic API key',
    regex: /sk-ant-api03-[A-Za-z0-9_-]{93}/g,
  },
  {
    severity: 'HIGH',
    label: 'Anthropic OAuth token',
    regex: /sk-ant-oat01-[A-Za-z0-9_-]{86}/g,
  },
  {
    severity: 'HIGH',
    label: 'GitHub classic Personal Access Token',
    regex: /gh[puors]_[A-Za-z0-9]{36}/g,
  },
  {
    severity: 'HIGH',
    label: 'GitHub fine-grained Personal Access Token',
    regex: /github_pat_[A-Za-z0-9_]{82}/g,
  },
  {
    severity: 'HIGH',
    label: 'Stripe live secret/restricted key',
    regex: /(sk|rk)_live_[A-Za-z0-9]{24,}/g,
  },
  {
    severity: 'HIGH',
    label: 'Stripe webhook signing secret',
    regex: /whsec_[A-Za-z0-9+/]{40,}/g,
  },
  {
    severity: 'HIGH',
    label: 'Generic secret assignment (double-quoted)',
    regex: /(SECRET|PASSWORD|PRIVATE_KEY|API_SECRET)\s*=\s*"[^"]{20,}"/g,
  },
  {
    severity: 'HIGH',
    label: 'Generic secret assignment (single-quoted)',
    regex: /(SECRET|PASSWORD|PRIVATE_KEY|API_SECRET)\s*=\s*'[^']{20,}'/g,
  },
  {
    severity: 'HIGH',
    label: 'Supabase service role key (JWT)',
    regex: /SUPABASE_SERVICE_ROLE_KEY\s*=\s*["']?eyJ[A-Za-z0-9._-]{50,}/g,
  },
  // ── MEDIUM severity (advisory) ───────────────────────────────────
  {
    severity: 'MEDIUM',
    label: '.env credential assignment',
    // Multiline `m` flag so `^` anchors at line start across the
    // joined corpus. The bash hook ran per-pattern against the
    // filtered file; per-line semantics match.
    regex:
      /^(ANTHROPIC_API_KEY|SUPABASE_SERVICE_ROLE_KEY|DATABASE_URL|STRIPE_SECRET)\s*=\s*\S+/gm,
  },
  {
    severity: 'MEDIUM',
    label: 'Stripe test API key (real credential, test env)',
    regex: /(sk|pk|rk)_test_[A-Za-z0-9]{24,}/g,
  },
  {
    severity: 'MEDIUM',
    label: 'Stripe live publishable key',
    regex: /pk_live_[A-Za-z0-9]{24,}/g,
  },
  {
    severity: 'MEDIUM',
    label: 'Hardcoded DB connection string with password',
    regex: /postgresql:\/\/[^:]+:[^@]{8,}@/g,
  },
  {
    severity: 'MEDIUM',
    label: 'Supabase anon key in non-client context',
    regex: /SUPABASE_ANON_KEY\s*=\s*["']?eyJ[A-Za-z0-9._-]{50,}/g,
  },
];

/**
 * Maximum length of the displayed match snippet. Mirrors the bash
 * hook's `${MATCH:0:60}...` slice + ellipsis.
 */
const MAX_SNIPPET_LEN = 60;

/**
 * Maximum number of matches collected per pattern. Mirrors the bash
 * hook's `head -5` on `MATCHES`. Bounds banner length on a pathological
 * input (e.g. a file with 100 AWS keys).
 */
const MAX_MATCHES_PER_PATTERN = 5;

/**
 * Filter content lines the same way the bash hook's awk preprocessor
 * does:
 *   - Strip lines whose leading-whitespace-stripped form starts with `#`.
 *   - Strip lines where `process.env.VAR` is the RHS of an assignment.
 *     The bash hook used two regexes (trailing-non-letter and
 *     `;,)` punctuation forms) — we cover both.
 *   - Strip lines mentioning `os.environ[`.
 *
 * Newline-preserving so multiline regex anchors (`^…$`) still work on
 * the filtered corpus.
 */
export function filterContent(content: string): string {
  if (content.length === 0) return '';
  const lines = content.split('\n');
  const kept: string[] = [];
  for (const line of lines) {
    const trimmed = line.replace(/^\s+/, '');
    // Shell-comment lines only.
    if (trimmed.startsWith('#')) continue;
    // `= process.env.VAR[^a-zA-Z]?$` — terminator or end-of-line.
    if (/=\s*process\.env\.[A-Z_]+[^a-zA-Z]?$/.test(trimmed)) continue;
    // `= process.env.VAR[;,)]` — followed by terminator punctuation.
    if (/=\s*process\.env\.[A-Z_]+\s*[;,)]/.test(trimmed)) continue;
    // Python-style `os.environ[`.
    if (/os\.environ\[/.test(trimmed)) continue;
    kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Bash `is_placeholder` parity. Returns true when the match is a known
 * placeholder shape and should NOT be counted as a real secret.
 *
 * Lowercased once at the top; all sub-checks operate on the lower form.
 */
export function isPlaceholder(match: string): boolean {
  const lower = match.toLowerCase();
  if (/<[a-z_]+>/.test(lower)) return true;
  if (/your_key_here/.test(lower)) return true;
  if (/your_api_key/.test(lower)) return true;
  if (/your_secret/.test(lower)) return true;
  if (/placeholder/.test(lower)) return true;
  if (/changeme/.test(lower)) return true;
  if (/insert.*here/.test(lower)) return true;
  // Prefix-pair placeholder compounds: `test_key`, `fake_api`, etc.
  if (/^(test|fake|mock|demo|example)_(key|token|secret|credential|api)$/.test(lower)) {
    return true;
  }
  // `test_<word>_key` form.
  if (/^test_[a-z_]+_key$/.test(lower)) return true;
  // Repeated-character dummy strings (8+ same char).
  if (/^(.)\1{7,}$/.test(lower)) return true;
  return false;
}

/**
 * Scan filtered content against every pattern in the catalog. Returns
 * the accepted matches in catalog order.
 */
export function scanContent(filtered: string): ScannerMatch[] {
  const accepted: ScannerMatch[] = [];
  if (filtered.length === 0) return accepted;
  for (const desc of SECRET_PATTERNS) {
    // Clone the regex so the lastIndex state doesn't leak across
    // patterns (esp. with the `g` flag which is sticky).
    const re = new RegExp(desc.regex.source, desc.regex.flags);
    let matches = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(filtered)) !== null) {
      const raw = m[0];
      // Zero-width match safeguard (every pattern in the catalog has
      // a positive lower bound, but defense-in-depth costs nothing).
      if (raw.length === 0) {
        re.lastIndex += 1;
        continue;
      }
      if (isPlaceholder(raw)) continue;
      const snippet =
        raw.length > MAX_SNIPPET_LEN ? raw.slice(0, MAX_SNIPPET_LEN) + '...' : raw;
      accepted.push({
        severity: desc.severity,
        label: desc.label,
        snippet,
      });
      matches += 1;
      if (matches >= MAX_MATCHES_PER_PATTERN) break;
    }
  }
  return accepted;
}

/**
 * Suffix-based file_path exclusion. `*.env.example` and `*.env.sample`
 * skip the scan entirely — those are documentation files that
 * intentionally carry placeholder credential shapes.
 *
 * Test files are NOT excluded. Real credentials in test fixtures must
 * still be caught; the placeholder filter handles legitimate dummy
 * keys.
 */
export function isExcludedSuffix(filePath: string): boolean {
  if (filePath.length === 0) return false;
  if (filePath.endsWith('.env.example')) return true;
  if (filePath.endsWith('.env.sample')) return true;
  return false;
}

function buildBlockBanner(filePath: string, matches: ScannerMatch[]): string {
  const basename = filePath.length > 0 ? path.basename(filePath) : 'unknown';
  const lines: string[] = [`SECRET DETECTED: Potential credential in ${basename}\n`];
  let count = 0;
  for (const m of matches) {
    count += 1;
    if (count > MAX_MATCHES_PER_PATTERN) break;
    lines.push(`  ${m.severity}: ${m.label} — '${m.snippet}'\n`);
  }
  lines.push('Block reason: Writing credentials to disk risks exposure via git history.\n');
  lines.push('Fix: Load credentials from environment variables — never hardcode secrets.\n');
  return lines.join('');
}

function buildAdvisoryBanner(filePath: string, matches: ScannerMatch[]): string {
  const basename = filePath.length > 0 ? path.basename(filePath) : 'unknown';
  const lines: string[] = [
    `SECRET-SCAN WARN: Low-confidence credential pattern in ${basename} (advisory — not blocking)\n`,
  ];
  for (const m of matches) {
    lines.push(`  ${m.severity}: ${m.label} — '${m.snippet}'\n`);
  }
  lines.push('Note: Heuristic match — may be a false positive. If real, load from environment.\n');
  return lines.join('');
}

/**
 * Pure executor. Returns `{ exitCode, stderr, matches }`; the CLI
 * wrapper translates them into `process.stderr.write` + `process.exit`.
 */
export async function runSecretScanner(
  options: SecretScannerOptions = {},
): Promise<SecretScannerResult> {
  const reaRoot =
    options.reaRoot ?? process.env['CLAUDE_PROJECT_DIR'] ?? process.cwd();
  let stderr = '';
  const writeStderr = (s: string): void => {
    stderr += s;
    if (options.stderrWrite) options.stderrWrite(s);
  };

  // 1. HALT check — fail-closed (exit 2).
  const halt = checkHalt(reaRoot);
  if (halt.halted) {
    writeStderr(formatHaltBanner(halt.reason));
    return { exitCode: 2, stderr, matches: [] };
  }

  // 2. Read + parse stdin via the write-tier payload helper.
  const stdinRaw =
    options.stdinOverride !== undefined
      ? options.stdinOverride
      : await readStdinWithTimeout(5_000);

  let filePath = '';
  let content = '';
  try {
    const payload = parseWriteHookPayload(stdinRaw);
    filePath = payload.filePath;
    content = payload.content;
  } catch (err) {
    if (err instanceof MalformedPayloadError || err instanceof TypePayloadError) {
      // Fail-closed on uncertainty. The bash hook ran with
      // `set -uo pipefail` and its awk/grep would have processed even
      // a malformed payload defensively — but a TypePayloadError
      // signals an outright protocol mismatch we should not silently
      // pass through.
      writeStderr(`secret-scanner: ${err.message} — refusing on uncertainty.\n`);
      return { exitCode: 2, stderr, matches: [] };
    }
    throw err;
  }

  // 3. Empty content → exit 0.
  if (content.length === 0) {
    return { exitCode: 0, stderr, matches: [] };
  }

  // 4. Suffix-based file exclusions.
  if (isExcludedSuffix(filePath)) {
    return { exitCode: 0, stderr, matches: [] };
  }

  // 5. Filter + scan.
  const filtered = filterContent(content);
  if (filtered.length === 0) {
    return { exitCode: 0, stderr, matches: [] };
  }
  const accepted = scanContent(filtered);

  if (accepted.length === 0) {
    return { exitCode: 0, stderr, matches: [] };
  }

  const highCount = accepted.filter((m) => m.severity === 'HIGH').length;

  if (highCount > 0) {
    writeStderr(buildBlockBanner(filePath, accepted));
    return { exitCode: 2, stderr, matches: accepted };
  }

  // Medium-only — advisory.
  writeStderr(buildAdvisoryBanner(filePath, accepted));
  return { exitCode: 0, stderr, matches: accepted };
}

/**
 * CLI entry point — `rea hook secret-scanner`.
 */
export async function runHookSecretScanner(
  options: SecretScannerOptions = {},
): Promise<void> {
  const result = await runSecretScanner({
    ...options,
    stderrWrite: (s) => process.stderr.write(s),
  });
  process.exit(result.exitCode);
}

// Internal exports for byte-fidelity / banner-drift tests.
export const __INTERNAL_FOR_TESTS = {
  SECRET_PATTERNS,
  MAX_SNIPPET_LEN,
  MAX_MATCHES_PER_PATTERN,
};
