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
const FAKE_SUPA_SR =
  'SUPA' + 'BASE_SERVICE_ROLE_KEY=eyJ' + 'A'.repeat(60);
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
