/**
 * Tests for `interpolateEnv` — the pure function backing registry env
 * interpolation. Every edge case enumerated in the 0.3.0 task spec lives
 * here so the behaviour can't regress silently when `downstream.ts`
 * consumes it.
 */

import { describe, it, expect } from 'vitest';
import { interpolateEnv, SECRET_NAME_HEURISTIC } from './interpolate.js';

describe('interpolateEnv', () => {
  it('returns identity when there are no placeholders', () => {
    const r = interpolateEnv(
      { LOG_LEVEL: 'info', REGION: 'us-east-1' },
      { UNRELATED: 'nope' },
    );
    expect(r.resolved).toEqual({ LOG_LEVEL: 'info', REGION: 'us-east-1' });
    expect(r.missing).toEqual([]);
    expect(r.secretKeys).toEqual([]);
  });

  it('resolves a single ${VAR} from processEnv', () => {
    const r = interpolateEnv(
      { BOT_TOKEN: '${DISCORD_BOT_TOKEN}' },
      { DISCORD_BOT_TOKEN: 'abc123' },
    );
    expect(r.resolved).toEqual({ BOT_TOKEN: 'abc123' });
    expect(r.missing).toEqual([]);
    // Secret name (both the key AND the referenced var) — flagged.
    expect(r.secretKeys).toEqual(['BOT_TOKEN']);
  });

  it('resolves multiple placeholders in the same value', () => {
    const r = interpolateEnv(
      { AUTH: 'Bearer ${A}-${B}' },
      { A: 'alpha', B: 'beta' },
    );
    expect(r.resolved.AUTH).toBe('Bearer alpha-beta');
    expect(r.missing).toEqual([]);
  });

  it('mixes literal keys and interpolated keys correctly', () => {
    const r = interpolateEnv(
      { LOG_LEVEL: 'info', TOKEN: '${X}' },
      { X: 'resolved' },
    );
    expect(r.resolved).toEqual({ LOG_LEVEL: 'info', TOKEN: 'resolved' });
  });

  it('returns missing vars without throwing; resolved keeps placeholder as canary', () => {
    const r = interpolateEnv(
      { BOT_TOKEN: '${DISCORD_BOT_TOKEN}' },
      {}, // no vars set
    );
    expect(r.missing).toEqual(['DISCORD_BOT_TOKEN']);
    // Placeholder preserved so the caller sees the template if they ignore `missing`.
    expect(r.resolved.BOT_TOKEN).toBe('${DISCORD_BOT_TOKEN}');
  });

  it('deduplicates and orders missing vars by first reference', () => {
    const r = interpolateEnv(
      { A: '${FOO}', B: '${BAR}-${FOO}' },
      {},
    );
    expect(r.missing).toEqual(['FOO', 'BAR']);
  });

  it('flags secret-named KEY even when the value is a literal', () => {
    const r = interpolateEnv(
      { SECRET_KEY: 'literal-value' },
      {},
    );
    expect(r.resolved.SECRET_KEY).toBe('literal-value');
    expect(r.secretKeys).toEqual(['SECRET_KEY']);
  });

  it('flags non-secret KEY whose VALUE references a secret-named var', () => {
    const r = interpolateEnv(
      { LOG_URL: 'http://example.com?t=${DISCORD_BOT_TOKEN}' },
      { DISCORD_BOT_TOKEN: 'abc' },
    );
    expect(r.resolved.LOG_URL).toBe('http://example.com?t=abc');
    // The KEY name is benign but the referenced VAR name matches the heuristic,
    // so the resolved entry is still secret-tagged.
    expect(r.secretKeys).toEqual(['LOG_URL']);
  });

  it('does NOT flag keys whose value has only non-secret references', () => {
    const r = interpolateEnv(
      { LOG_LEVEL: '${APP_LOG_LEVEL}' },
      { APP_LOG_LEVEL: 'debug' },
    );
    expect(r.resolved.LOG_LEVEL).toBe('debug');
    expect(r.secretKeys).toEqual([]);
  });

  it('rejects empty ${} at load time', () => {
    expect(() => interpolateEnv({ X: '${}' }, {})).toThrow(/empty \$\{\}/);
  });

  it('rejects var names with invalid characters (space)', () => {
    expect(() => interpolateEnv({ X: '${SPACE IN NAME}' }, {})).toThrow(
      /invalid var name/,
    );
  });

  it('rejects var names starting with a digit', () => {
    expect(() => interpolateEnv({ X: '${123STARTS_WITH_DIGIT}' }, {})).toThrow(
      /invalid var name/,
    );
  });

  it('rejects unterminated ${', () => {
    expect(() => interpolateEnv({ X: '${unterminated' }, {})).toThrow(
      /unterminated/,
    );
  });

  it('rejects unterminated ${ even when a later } appears far after', () => {
    // `indexOf('}', open+2)` will match the later brace — so an unterminated
    // open followed by stray close looks "balanced" to the naive check.
    // Document the expected behaviour: this is treated as a SINGLE placeholder,
    // which will then fail the VAR_NAME_RE check because of the `\n`/space inside.
    expect(() =>
      interpolateEnv({ X: '${oops\nlater}' }, {}),
    ).toThrow(/invalid var name/);
  });

  it('does NOT perform a second expansion pass (resolved value stays literal)', () => {
    // If FOO resolves to `${BAR}`, the inner `${BAR}` is a LITERAL in the
    // resolved output — we don't lookup BAR. This is a hard-coded security
    // choice (prevents a hostile env var's contents from triggering extra lookups).
    const r = interpolateEnv(
      { X: '${FOO}' },
      { FOO: '${BAR}', BAR: 'should-not-be-reached' },
    );
    expect(r.resolved.X).toBe('${BAR}');
  });

  it('unused var reference OK (no processEnv entry required for literals)', () => {
    const r = interpolateEnv({ X: 'literal' }, {});
    expect(r.resolved.X).toBe('literal');
    expect(r.missing).toEqual([]);
  });

  it('treats a processEnv value that is NOT a string as missing', () => {
    // NodeJS.ProcessEnv types values as `string | undefined` but at runtime
    // someone could write an unusual value — be defensive.
    const hostile = Object.create(null) as NodeJS.ProcessEnv;
    (hostile as Record<string, unknown>)['WEIRD'] = 42;
    const r = interpolateEnv({ X: '${WEIRD}' }, hostile);
    expect(r.missing).toEqual(['WEIRD']);
    expect(r.resolved.X).toBe('${WEIRD}');
  });

  it('exports SECRET_NAME_HEURISTIC matching the loader pattern', () => {
    // Spot check the exported regex matches the same tokens the loader rejects
    // in env_passthrough.
    expect(SECRET_NAME_HEURISTIC.test('GITHUB_TOKEN')).toBe(true);
    expect(SECRET_NAME_HEURISTIC.test('OPENAI_API_KEY')).toBe(true);
    expect(SECRET_NAME_HEURISTIC.test('CLIENT_SECRET')).toBe(true);
    expect(SECRET_NAME_HEURISTIC.test('DB_PASSWORD')).toBe(true);
    expect(SECRET_NAME_HEURISTIC.test('AWS_CREDENTIAL')).toBe(true);
    expect(SECRET_NAME_HEURISTIC.test('LOG_LEVEL')).toBe(false);
  });
});
