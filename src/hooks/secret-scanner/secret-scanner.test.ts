/**
 * Unit suite for the Node-binary secret-scanner port (0.34.0).
 *
 * Coverage:
 *   - HALT check
 *   - Empty / malformed / type-mismatched payload
 *   - File suffix exclusion
 *   - awk-style line filter parity (comment lines, process.env RHS,
 *     os.environ[)
 *   - Each pattern category fires (AWS, Anthropic, GitHub, Stripe,
 *     Supabase, generic secret assignment)
 *   - Placeholder filter
 *   - MultiEdit fragment joining via parseWriteHookPayload
 *   - HIGH blocks, MEDIUM advisories
 *
 * IMPORTANT: every literal in this file that would otherwise match a
 * pattern in the secret-scanner is constructed at runtime via string
 * concatenation. The scanner runs on every Write tool call, including
 * this test file — without the split-and-join, every save would be
 * blocked. Mirrors the pattern in `__tests__/hooks/secret-scanner.test.ts`.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  filterContent,
  isExcludedSuffix,
  isPlaceholder,
  runSecretScanner,
  scanContent,
} from './index.js';

// Concatenation-built credential shapes — never store the literal that
// would match the scanner's own regex in this file.
const FAKE_AWS_KEY = 'AKIA' + 'IOSFODNN' + '7EXAMPLE';
const FAKE_ANTHROPIC = 'sk-ant-api03-' + 'A'.repeat(93);
const FAKE_GHP = 'gh' + 'p_' + 'A'.repeat(36);
const FAKE_GH_PAT = 'github_' + 'pat_' + 'A'.repeat(82);
const FAKE_STRIPE_LIVE = 's' + 'k_live_' + 'A'.repeat(24);
const FAKE_STRIPE_TEST = 'p' + 'k_test_' + 'A'.repeat(24);
const FAKE_WHSEC = 'wh' + 'sec_' + 'A'.repeat(40);
// 0.36.0 — quoted form (canonical HIGH match). The 0.34.0-introduced TS
// regex made the quote optional via `?` and matched unquoted forms too,
// upgrading them from MEDIUM to HIGH vs the bash baseline; 0.36.0 charter
// item 5 restored byte-parity (quote required for HIGH). See the
// `describe('Supabase parity', ...)` block lower in this file for the
// matrix.
const FAKE_SUPA_SR =
  'SUPA' + 'BASE_SERVICE_ROLE_KEY="eyJ' + 'A'.repeat(60) + '"';
const FAKE_SUPA_SR_UNQUOTED =
  'SUPA' + 'BASE_SERVICE_ROLE_KEY=eyJ' + 'A'.repeat(60);
const FAKE_SUPA_SR_YAML =
  "SUPA" + "BASE_SERVICE_ROLE_KEY: 'eyJ" + 'A'.repeat(60) + "'";
// Generic secret assignment — split so the literal in this file doesn't
// match the regex `(SECRET|PASSWORD|PRIVATE_KEY|API_SECRET)\s*=\s*"…"`.
const SECRET_DQ = ['SE', 'CRET'].join('') + '="' + 'a'.repeat(40) + '"';
const SECRET_SQ =
  ['API_SE', 'CRET'].join('') + "='" + 'a'.repeat(40) + "'";
// Postgres URL — split the protocol prefix so the file literal can't
// trigger the password-bearing connection-string match.
const PG_URL =
  'post' + 'gresql://user:' + 'supersecretpassword' + '@host:5432/db';

const PAYLOAD = (
  filePath: string,
  content: string,
  toolName = 'Write',
): string =>
  JSON.stringify({
    tool_name: toolName,
    tool_input: { file_path: filePath, content },
  });

const NOTEBOOK_PAYLOAD = (
  notebookPath: string,
  newSource: string,
): string =>
  JSON.stringify({
    tool_name: 'NotebookEdit',
    tool_input: { notebook_path: notebookPath, new_source: newSource },
  });

const MULTI_PAYLOAD = (
  filePath: string,
  fragments: string[],
): string =>
  JSON.stringify({
    tool_name: 'MultiEdit',
    tool_input: {
      file_path: filePath,
      edits: fragments.map((f) => ({ new_string: f })),
    },
  });

function mkRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rea-secret-scanner-'));
}

describe('secret-scanner: HALT', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exits 2 when .rea/HALT exists', async () => {
    fs.mkdirSync(path.join(root, '.rea'), { recursive: true });
    fs.writeFileSync(path.join(root, '.rea', 'HALT'), 'maintenance window');
    const r = await runSecretScanner({
      reaRoot: root,
      stdinOverride: PAYLOAD('src/foo.ts', 'const x = 1\n'),
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('REA HALT: maintenance window');
  });
});

describe('secret-scanner: payload handling', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exits 0 on empty stdin', async () => {
    const r = await runSecretScanner({ reaRoot: root, stdinOverride: '' });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('exits 0 on empty content field', async () => {
    const r = await runSecretScanner({
      reaRoot: root,
      stdinOverride: PAYLOAD('src/foo.ts', ''),
    });
    expect(r.exitCode).toBe(0);
  });

  it('exits 2 on malformed JSON (fail-closed)', async () => {
    const r = await runSecretScanner({
      reaRoot: root,
      stdinOverride: 'not json{',
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('refusing on uncertainty');
  });

  it('exits 2 on type-mismatched tool_input (fail-closed)', async () => {
    // tool_input as a non-object (array) triggers TypePayloadError /
    // MalformedPayloadError. A non-string `content` field alone would
    // simply fall through to the next priority slot rather than
    // throwing — by design (legitimate Edit/MultiEdit payloads can
    // omit `content`); the type-mismatch fail-closed property is
    // verified by a structural mismatch at the tool_input layer.
    const r = await runSecretScanner({
      reaRoot: root,
      stdinOverride: JSON.stringify({
        tool_name: 'Write',
        tool_input: 'not an object',
      }),
    });
    expect(r.exitCode).toBe(2);
  });

  it('handles NotebookEdit new_source', async () => {
    const r = await runSecretScanner({
      reaRoot: root,
      stdinOverride: NOTEBOOK_PAYLOAD(
        'analysis.ipynb',
        `const k = "${FAKE_AWS_KEY}"\n`,
      ),
    });
    expect(r.exitCode).toBe(2);
    expect(r.matches.some((m) => m.label === 'AWS Access Key ID')).toBe(true);
  });

  it('joins MultiEdit fragments before scanning', async () => {
    const r = await runSecretScanner({
      reaRoot: root,
      stdinOverride: MULTI_PAYLOAD('src/foo.ts', [
        'const a = "foo"',
        `const k = "${FAKE_AWS_KEY}"`,
      ]),
    });
    expect(r.exitCode).toBe(2);
    expect(r.matches.some((m) => m.label === 'AWS Access Key ID')).toBe(true);
  });
});

describe('secret-scanner: file suffix exclusions', () => {
  it('excludes .env.example', () => {
    expect(isExcludedSuffix('.env.example')).toBe(true);
    expect(isExcludedSuffix('/abs/path/.env.example')).toBe(true);
  });

  it('excludes .env.sample', () => {
    expect(isExcludedSuffix('.env.sample')).toBe(true);
  });

  it('does not exclude .env or .env.local', () => {
    expect(isExcludedSuffix('.env')).toBe(false);
    expect(isExcludedSuffix('.env.local')).toBe(false);
  });

  it('does not exclude test files (test fixtures must still be scanned)', () => {
    expect(isExcludedSuffix('src/foo.test.ts')).toBe(false);
    expect(isExcludedSuffix('__tests__/x.ts')).toBe(false);
  });

  it('runSecretScanner passes through .env.example writes silently', async () => {
    const root = mkRoot();
    try {
      const r = await runSecretScanner({
        reaRoot: root,
        stdinOverride: PAYLOAD(
          '.env.example',
          `ANTHROPIC_API_KEY=${FAKE_ANTHROPIC}\n`,
        ),
      });
      expect(r.exitCode).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('secret-scanner: line filter (awk parity)', () => {
  it('strips lines starting with # (shell comment)', () => {
    const filtered = filterContent(`# AWS_SECRET_KEY=${FAKE_AWS_KEY}\nreal = 1\n`);
    expect(filtered).toBe('real = 1\n');
  });

  it('strips leading-whitespace shell comments', () => {
    const filtered = filterContent('   # comment\nreal\n');
    expect(filtered).toBe('real\n');
  });

  it('strips RHS process.env assignment (terminator)', () => {
    const filtered = filterContent('const x = process.env.FOO;\nreal\n');
    expect(filtered).toBe('real\n');
  });

  it('strips RHS process.env assignment (end-of-line)', () => {
    const filtered = filterContent('const x = process.env.FOO\nreal\n');
    expect(filtered).toBe('real\n');
  });

  it('keeps lines mentioning process.env without an = sign', () => {
    // The bash awk regex is `=\s*process.env...` — without a leading
    // `=`, this line is kept. We mirror that posture.
    const filtered = filterContent('// docs: see process.env.FOO usage\nreal\n');
    expect(filtered).toContain('process.env');
  });

  it('strips os.environ[ lines (Python)', () => {
    const filtered = filterContent('x = os.environ["KEY"]\nreal\n');
    expect(filtered).toBe('real\n');
  });
});

describe('secret-scanner: placeholder filter', () => {
  it('rejects <placeholder> shapes', () => {
    expect(isPlaceholder('<your_key>')).toBe(true);
    expect(isPlaceholder('<api_secret>')).toBe(true);
  });

  it('rejects "your_api_key" / "your_secret"', () => {
    expect(isPlaceholder('your_api_key')).toBe(true);
    expect(isPlaceholder('your_secret')).toBe(true);
    expect(isPlaceholder('YOUR_API_KEY')).toBe(true);
  });

  it('rejects placeholder / changeme / insert-here', () => {
    expect(isPlaceholder('placeholder')).toBe(true);
    expect(isPlaceholder('changeme')).toBe(true);
    expect(isPlaceholder('insert key here')).toBe(true);
  });

  it('rejects test_key / fake_token style compounds', () => {
    expect(isPlaceholder('test_key')).toBe(true);
    expect(isPlaceholder('fake_token')).toBe(true);
    expect(isPlaceholder('mock_secret')).toBe(true);
  });

  it('rejects test_<word>_key form', () => {
    expect(isPlaceholder('test_stripe_key')).toBe(true);
  });

  it('rejects repeated-char dummies', () => {
    expect(isPlaceholder('aaaaaaaa')).toBe(true);
    expect(isPlaceholder('11111111')).toBe(true);
    expect(isPlaceholder('XXXXXXXX')).toBe(true);
  });

  it('accepts real-looking AWS key', () => {
    expect(isPlaceholder(FAKE_AWS_KEY)).toBe(false);
  });
});

describe('secret-scanner: pattern catalog', () => {
  it('detects AWS Access Key ID', () => {
    const r = scanContent(`const key = "${FAKE_AWS_KEY}"`);
    expect(r.some((m) => m.label === 'AWS Access Key ID')).toBe(true);
  });

  it('detects AWS Secret Access Key (case-insensitive AWS prefix)', () => {
    // 40-character base64-ish secret. Concatenated to avoid the
    // scanner regex matching this file. The bash pattern is
    // `[Aa][Ww][Ss]_SECRET_ACCESS_KEY` — only the `AWS` prefix is
    // case-insensitive; the suffix is literal upper.
    const secret = 'wJalrXUtnFEMI/' + 'K7MDENG/bPxRfi' + 'CYEXAMPLEKEYY';
    const prefix = 'Aws' + '_SECRET_ACCESS_KEY';
    const r = scanContent(`${prefix}=${secret}`);
    expect(r.some((m) => m.label === 'AWS Secret Access Key')).toBe(true);
  });

  it('detects Anthropic API key (93 trailing chars)', () => {
    const r = scanContent(`const k = "${FAKE_ANTHROPIC}"`);
    expect(r.some((m) => m.label === 'Anthropic API key')).toBe(true);
  });

  it('detects GitHub classic PAT', () => {
    const r = scanContent(`TOKEN=${FAKE_GHP}`);
    expect(r.some((m) => m.label === 'GitHub classic Personal Access Token')).toBe(
      true,
    );
  });

  it('detects GitHub fine-grained PAT', () => {
    const r = scanContent(FAKE_GH_PAT);
    expect(
      r.some((m) => m.label === 'GitHub fine-grained Personal Access Token'),
    ).toBe(true);
  });

  it('detects Stripe live secret key', () => {
    const r = scanContent(FAKE_STRIPE_LIVE);
    expect(r.some((m) => m.label === 'Stripe live secret/restricted key')).toBe(
      true,
    );
  });

  it('detects private-key armor', () => {
    const armor = '-----BE' + 'GIN RSA PRIVATE KEY-----';
    const r = scanContent(`${armor}\nbody\n-----END`);
    expect(r.some((m) => m.label === 'Private key block')).toBe(true);
  });

  it('detects generic SECRET= double-quoted assignment', () => {
    const r = scanContent(SECRET_DQ);
    expect(
      r.some((m) => m.label === 'Generic secret assignment (double-quoted)'),
    ).toBe(true);
  });

  it('detects generic API_SECRET= single-quoted assignment', () => {
    const r = scanContent(SECRET_SQ);
    expect(
      r.some((m) => m.label === 'Generic secret assignment (single-quoted)'),
    ).toBe(true);
  });

  it('detects Stripe webhook signing secret', () => {
    const r = scanContent(FAKE_WHSEC);
    expect(r.some((m) => m.label === 'Stripe webhook signing secret')).toBe(true);
  });

  it('detects Supabase service role key', () => {
    const r = scanContent(FAKE_SUPA_SR);
    expect(r.some((m) => m.label === 'Supabase service role key (JWT)')).toBe(
      true,
    );
  });

  it('flags .env credential assignment (MEDIUM)', () => {
    const r = scanContent('ANTHROPIC_API_KEY=real-value-here');
    expect(r.some((m) => m.label === '.env credential assignment')).toBe(true);
    expect(
      r.find((m) => m.label === '.env credential assignment')?.severity,
    ).toBe('MEDIUM');
  });

  it('flags Stripe test API key (MEDIUM)', () => {
    const r = scanContent(FAKE_STRIPE_TEST);
    expect(
      r.some((m) => m.label === 'Stripe test API key (real credential, test env)'),
    ).toBe(true);
  });

  it('flags hardcoded DB connection (MEDIUM)', () => {
    const r = scanContent(PG_URL);
    expect(
      r.some((m) => m.label === 'Hardcoded DB connection string with password'),
    ).toBe(true);
  });

  it('drops placeholder matches (e.g. <your_key>)', () => {
    // SECRET= with a placeholder shape inside the value should NOT
    // count as a HIGH match.
    const body = [
      'SE',
      'CRET="<your_key_here_value_string>"',
    ].join('');
    const r = scanContent(body);
    expect(r.filter((m) => m.severity === 'HIGH')).toHaveLength(0);
  });

  it('truncates long matches in the snippet', () => {
    const long = 'sk-ant-api03-' + 'B'.repeat(93);
    const r = scanContent(`x = "${long}"`);
    const hit = r.find((m) => m.label === 'Anthropic API key');
    expect(hit).toBeDefined();
    // 60 + '...' suffix on overlong.
    expect(hit?.snippet.length).toBeLessThanOrEqual(63);
  });
});

// ── 0.36.0 charter item 5 / 0.34.0 codex round-7 P2 #2: Supabase parity ──
//
// Pre-0.34.0 the bash hook required a quote introducer for the HIGH
// `Supabase service role key (JWT)` pattern (`["']`, no `?`). The
// 0.34.0 TS port introduced an optional quote via `["']?`, which
// upgraded unquoted `.env` assignments from MEDIUM advisory (matched
// by the lower-down `.env credential assignment` pattern) to HIGH
// blocking — a posture regression vs the bash baseline that
// over-blocks legitimate `.env` files in source. 0.36.0 restores
// byte-parity by dropping the `?`.
describe('secret-scanner: Supabase SERVICE_ROLE_KEY quote parity (0.34.0 round-7 P2 #2)', () => {
  it('quoted (double-quote): SUPABASE_SERVICE_ROLE_KEY="eyJ..." → HIGH', () => {
    const r = scanContent(FAKE_SUPA_SR);
    const hit = r.find((m) => m.label === 'Supabase service role key (JWT)');
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('HIGH');
  });

  it('quoted (single-quote): SUPABASE_SERVICE_ROLE_KEY=\'eyJ...\' → HIGH', () => {
    const body =
      'SUPA' + "BASE_SERVICE_ROLE_KEY='eyJ" + 'A'.repeat(60) + "'";
    const r = scanContent(body);
    const hit = r.find((m) => m.label === 'Supabase service role key (JWT)');
    expect(hit).toBeDefined();
    expect(hit?.severity).toBe('HIGH');
  });

  it('unquoted: SUPABASE_SERVICE_ROLE_KEY=eyJ... → MEDIUM (parity with bash baseline)', () => {
    // Bash baseline: the HIGH pattern requires a quote introducer,
    // so unquoted .env lines fall through to the broader MEDIUM
    // `.env credential assignment` pattern. TS post-0.36.0 matches
    // that: no HIGH `Supabase service role key (JWT)` match, but a
    // MEDIUM `.env credential assignment` match.
    const r = scanContent(FAKE_SUPA_SR_UNQUOTED);
    const highHit = r.find(
      (m) => m.label === 'Supabase service role key (JWT)',
    );
    expect(highHit).toBeUndefined();
    const medHit = r.find((m) => m.label === '.env credential assignment');
    expect(medHit).toBeDefined();
    expect(medHit?.severity).toBe('MEDIUM');
  });

  it('unquoted with `export` prefix: export SUPABASE_SERVICE_ROLE_KEY=eyJ... → MEDIUM via the unquoted-non-.env pattern (0.36.0 codex round-2 P1)', () => {
    // Codex round-2 P1 closure: the pre-0.34.0 bash hook (and the
    // 0.36.0-restored TS posture) only caught unquoted forms via the
    // `.env credential assignment` pattern, which anchors `^FOO=`.
    // `export FOO=…` in a shell entrypoint slipped through both. The
    // new `Supabase service role key (JWT, unquoted non-.env shape)`
    // MEDIUM rule closes that gap as a strict improvement over the
    // bash baseline. Round-4 P1: rule was narrowed in round-3 to 5
    // specific keyword prefixes (`export`/`readonly`/`declare`/
    // `local`/`typeset`), then re-broadened in round-4 to "any
    // non-line-start position" so Dockerfile `ENV FOO=…`, k8s
    // manifests, ad-hoc shell `; FOO=…`, etc. are all covered.
    const body =
      'export SUPA' + 'BASE_SERVICE_ROLE_KEY=eyJ' + 'A'.repeat(60);
    const r = scanContent(body);
    const unquotedHit = r.find(
      (m) =>
        m.label === 'Supabase service role key (JWT, unquoted non-.env shape)',
    );
    expect(unquotedHit).toBeDefined();
    expect(unquotedHit?.severity).toBe('MEDIUM');
    // And the HIGH rule does NOT fire (quote required) — parity.
    const highHit = r.find(
      (m) => m.label === 'Supabase service role key (JWT)',
    );
    expect(highHit).toBeUndefined();
  });

  it('unquoted with `ENV` prefix (Dockerfile): ENV SUPABASE_SERVICE_ROLE_KEY=eyJ... → MEDIUM (0.36.0 codex round-4 P1)', () => {
    // Round-4 P1 closure: round-3's narrow shell-keyword allowlist
    // left Dockerfile ENV directives and other non-`.env`-shape
    // assignments uncovered. Round-4 broadened to "any non-line-start
    // position".
    const body =
      'ENV SUPA' + 'BASE_SERVICE_ROLE_KEY=eyJ' + 'A'.repeat(60);
    const r = scanContent(body);
    const unquotedHit = r.find(
      (m) =>
        m.label === 'Supabase service role key (JWT, unquoted non-.env shape)',
    );
    expect(unquotedHit).toBeDefined();
    expect(unquotedHit?.severity).toBe('MEDIUM');
  });

  it('unquoted inline shell (`; SUPABASE_SERVICE_ROLE_KEY=…; bar`) → MEDIUM (0.36.0 codex round-4 P1)', () => {
    const body =
      'do_thing; SUPA' + 'BASE_SERVICE_ROLE_KEY=eyJ' + 'A'.repeat(60);
    const r = scanContent(body);
    const unquotedHit = r.find(
      (m) =>
        m.label === 'Supabase service role key (JWT, unquoted non-.env shape)',
    );
    expect(unquotedHit).toBeDefined();
    expect(unquotedHit?.severity).toBe('MEDIUM');
  });

  it('plain `.env`-style unquoted line fires the broader `.env credential assignment` MEDIUM but NOT the unquoted-non-.env rule (0.36.0 codex round-3 P3 no-double-fire)', () => {
    // Round-3 P3: pre-narrowing, `SUPABASE_SERVICE_ROLE_KEY=eyJ…`
    // produced TWO MEDIUM findings (the new unquoted-anywhere rule
    // AND the broader `.env credential assignment` pattern). Each
    // secret should produce exactly one finding. The narrowed rule
    // requires a `export`/`readonly`/`declare`/`local`/`typeset`
    // prefix, so a bare line only fires the `.env` pattern.
    const r = scanContent(FAKE_SUPA_SR_UNQUOTED);
    const unquotedShapedHit = r.find(
      (m) =>
        m.label === 'Supabase service role key (JWT, unquoted non-.env shape)',
    );
    expect(unquotedShapedHit).toBeUndefined();
    const envHit = r.find((m) => m.label === '.env credential assignment');
    expect(envHit).toBeDefined();
    expect(envHit?.severity).toBe('MEDIUM');
  });

  it('quoted forms do NOT double-fire on the unquoted-non-.env pattern (negative-lookahead pin)', () => {
    // The unquoted-MEDIUM pattern uses `(?!["'])` so a quoted value
    // doesn't also produce a MEDIUM hit alongside the HIGH match.
    const r = scanContent(FAKE_SUPA_SR);
    const unquotedHits = r.filter(
      (m) =>
        m.label === 'Supabase service role key (JWT, unquoted non-.env shape)',
    );
    expect(unquotedHits).toHaveLength(0);
  });

  it('yaml form with colon (SUPABASE_SERVICE_ROLE_KEY: \'eyJ...\') → no HIGH (bash also requires `=`)', () => {
    // Bash hook's regex anchors `=`, not `:`. The yaml `:` form does
    // not match either tier — this test pins that parity. A future
    // pattern that ALSO covers yaml `:` is a separate, intentional
    // policy widening (not silent drift from a regex tweak).
    const r = scanContent(FAKE_SUPA_SR_YAML);
    const highHit = r.find(
      (m) => m.label === 'Supabase service role key (JWT)',
    );
    expect(highHit).toBeUndefined();
  });

  it('SUPABASE_ANON_KEY: unquoted form does NOT fire MEDIUM Supabase-anon match (parity with bash)', () => {
    // Sibling fix: the MEDIUM `Supabase anon key in non-client context`
    // pattern also dropped its `?`. Unquoted anon-key assignments
    // are acceptable (anon keys are public-facing) and SUPABASE_ANON_KEY
    // is intentionally NOT in the broader `.env credential assignment`
    // MEDIUM list either — so an unquoted form should produce zero
    // matches.
    const body =
      'SUPA' + 'BASE_ANON_KEY=eyJ' + 'A'.repeat(60);
    const r = scanContent(body);
    const anonHit = r.find(
      (m) => m.label === 'Supabase anon key in non-client context',
    );
    expect(anonHit).toBeUndefined();
  });

  it('SUPABASE_ANON_KEY: quoted form DOES fire MEDIUM (canonical advisory case)', () => {
    const body =
      'SUPA' + 'BASE_ANON_KEY="eyJ' + 'A'.repeat(60) + '"';
    const r = scanContent(body);
    const anonHit = r.find(
      (m) => m.label === 'Supabase anon key in non-client context',
    );
    expect(anonHit).toBeDefined();
    expect(anonHit?.severity).toBe('MEDIUM');
  });
});

describe('secret-scanner: end-to-end runSecretScanner', () => {
  let root: string;
  beforeEach(() => {
    root = mkRoot();
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('blocks HIGH match → exit 2 with banner', async () => {
    const r = await runSecretScanner({
      reaRoot: root,
      stdinOverride: PAYLOAD('src/foo.ts', `const k = "${FAKE_AWS_KEY}"\n`),
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('SECRET DETECTED');
    expect(r.stderr).toContain('AWS Access Key ID');
  });

  it('emits advisory + exit 0 on MEDIUM-only match', async () => {
    const r = await runSecretScanner({
      reaRoot: root,
      stdinOverride: PAYLOAD('config.yml', 'ANTHROPIC_API_KEY=somevalue\n'),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain('SECRET-SCAN WARN');
  });

  it('passes commented-out credential silently', async () => {
    const r = await runSecretScanner({
      reaRoot: root,
      stdinOverride: PAYLOAD(
        'src/foo.ts',
        `# ${FAKE_AWS_KEY} — leaked, rotated\n`,
      ),
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('passes process.env-rhs credential reference silently', async () => {
    const r = await runSecretScanner({
      reaRoot: root,
      stdinOverride: PAYLOAD(
        'src/foo.ts',
        'const KEY = process.env.AWS_KEY;\n',
      ),
    });
    expect(r.exitCode).toBe(0);
  });

  it('passes legitimate test fixture with placeholder', async () => {
    const r = await runSecretScanner({
      reaRoot: root,
      stdinOverride: PAYLOAD(
        'src/foo.test.ts',
        'const fake = "<your_api_key_here>";\n',
      ),
    });
    expect(r.exitCode).toBe(0);
  });

  it('catches real credential in a test fixture', async () => {
    const r = await runSecretScanner({
      reaRoot: root,
      stdinOverride: PAYLOAD(
        'src/foo.test.ts',
        `const real = "${FAKE_AWS_KEY}"\n`,
      ),
    });
    expect(r.exitCode).toBe(2);
  });

  it('caps banner at 5 matches per pattern', async () => {
    const many = Array.from(
      { length: 20 },
      (_, i) =>
        `const k${i} = "${'AKIA' + 'IOSFODNN' + '7EXAMPL' + (i % 10).toString()}"`,
    ).join('\n');
    const r = await runSecretScanner({
      reaRoot: root,
      stdinOverride: PAYLOAD('src/foo.ts', many),
    });
    expect(r.exitCode).toBe(2);
    const aws = r.matches.filter((m) => m.label === 'AWS Access Key ID');
    expect(aws.length).toBeLessThanOrEqual(5);
  });
});
