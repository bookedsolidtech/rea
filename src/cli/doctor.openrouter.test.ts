/**
 * T-DOC-01..03 + T-TEL-01 — doctor openrouter availability + spend (AC-8/AC-14).
 *
 * The KEY-LEAK guard is the load-bearing assertion: the doctor detail string
 * NEVER contains the key value. Spend is computed from a seeded metrics file,
 * not the network.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkOpenRouterAvailability,
  codexRequiredFromPolicy,
  openrouterConfiguredFromPolicy,
  openrouterMissingKeyFatal,
  runDoctor,
} from './doctor.js';
import { recordTelemetry, summarizeTelemetry } from '../gateway/observability/codex-telemetry.js';

const SENTINEL = 'sk-or-supersecret-DO-NOT-LEAK-1234567890';

describe('checkOpenRouterAvailability (AC-8)', () => {
  it('T-DOC-01: key present → pass, detail NEVER contains the key value', () => {
    const r = checkOpenRouterAvailability({ OPENROUTER_API_KEY: SENTINEL });
    expect(r.status).toBe('pass');
    expect(r.detail ?? '').not.toContain(SENTINEL);
    expect(r.detail ?? '').not.toContain(SENTINEL.slice(0, 8));
  });

  it('T-DOC-02: no key → warn, detail names the absence, echoes no value', () => {
    const r = checkOpenRouterAvailability({});
    expect(r.status).toBe('warn');
    expect(r.detail ?? '').toMatch(/OPENROUTER_API_KEY not set/);
    expect(r.detail ?? '').not.toContain(SENTINEL);
  });

  it('reachability unauthorized → fail (still no value)', () => {
    const r = checkOpenRouterAvailability({ OPENROUTER_API_KEY: SENTINEL }, 'unauthorized');
    expect(r.status).toBe('fail');
    expect(r.detail ?? '').not.toContain(SENTINEL);
  });

  it('reachability reachable → pass', () => {
    const r = checkOpenRouterAvailability({ OPENROUTER_API_KEY: SENTINEL }, 'reachable');
    expect(r.status).toBe('pass');
  });

  it('source label names env when the key comes from the environment', () => {
    const r = checkOpenRouterAvailability({ OPENROUTER_API_KEY: SENTINEL });
    expect(r.detail ?? '').toMatch(/key present \(env[;)]/);
  });

  it('no-key detail points at the turnkey command', () => {
    const r = checkOpenRouterAvailability({});
    expect(r.detail ?? '').toMatch(/rea config set-key openrouter/);
  });

  it('resolves a key from the managed credentials file → pass, source "config file"', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-doc-keysrc-'));
    try {
      const dir = path.join(home, 'rea');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'credentials'), `OPENROUTER_API_KEY=${SENTINEL}\n`, {
        mode: 0o600,
      });
      // No env key → resolver must fall through to the file.
      const r = checkOpenRouterAvailability({ XDG_CONFIG_HOME: home });
      expect(r.status).toBe('pass');
      expect(r.detail ?? '').toMatch(/key present \(config file[;)]/);
      expect(r.detail ?? '').not.toContain(SENTINEL);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('a world-readable creds file surfaces the refusal in the detail (not a silent pass)', () => {
    if (typeof process.getuid !== 'function') return; // POSIX-only gate
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-doc-refuse-'));
    try {
      const dir = path.join(home, 'rea');
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = path.join(dir, 'credentials');
      fs.writeFileSync(file, `OPENROUTER_API_KEY=${SENTINEL}\n`, { mode: 0o600 });
      fs.chmodSync(file, 0o644);
      const r = checkOpenRouterAvailability({ XDG_CONFIG_HOME: home });
      expect(r.status).toBe('warn');
      expect(r.detail ?? '').toMatch(/Refused:/);
      expect(r.detail ?? '').not.toContain(SENTINEL);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('per-provider spend summary (AC-14)', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-doc-or-'));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('T-DOC-03 / T-TEL-01: spend derives from the seeded metrics file (not the network)', async () => {
    // Seed two openrouter rows + one codex row.
    await recordTelemetry(tmpDir, {
      invocation_type: 'review',
      input_text: '',
      output_text: '',
      duration_ms: 100,
      exit_code: 0,
      provider: 'openrouter',
      model: 'openai/gpt-oss-120b',
      served_by: 'fireworks',
      usage: { input_tokens: 1000, output_tokens: 100, est_cost_usd: 0.001 },
    });
    await recordTelemetry(tmpDir, {
      invocation_type: 'review',
      input_text: '',
      output_text: '',
      duration_ms: 120,
      exit_code: 0,
      provider: 'openrouter',
      usage: { est_cost_usd: 0.002 },
    });
    const summary = await summarizeTelemetry(tmpDir);
    expect(summary.est_cost_usd_by_provider).toBeDefined();
    expect(summary.est_cost_usd_by_provider!.openrouter).toBeCloseTo(0.003, 6);
  });
});

describe('FIX F (codex round-3) — doctor openrouter check is CONDITIONAL on config', () => {
  let tmpDir: string;
  let prevCwd: string;

  const BASE = [
    'version: "0.50.0"',
    'profile: open-source-no-codex',
    'installed_by: t',
    'installed_at: "2026-06-08T00:00:00Z"',
    'autonomy_level: L1',
    'max_autonomy_level: L2',
    'promotion_requires_human_approval: true',
    'block_ai_attribution: true',
    'blocked_paths: []',
    'protected_paths_relax: []',
    'notification_channel: ""',
  ];

  function writePolicy(extra: string[]): void {
    fs.mkdirSync(path.join(tmpDir, '.rea'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.rea', 'policy.yaml'), [...BASE, ...extra].join('\n') + '\n');
  }

  let prevXdg: string | undefined;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-doc-f-'));
    prevCwd = process.cwd();
    // HERMETICITY: these tests drive `runDoctor`, which resolves the openrouter
    // key from the REAL `process.env` (env-first, then the managed credentials
    // file). Point XDG_CONFIG_HOME at an empty path so the resolver never reads
    // the developer's real `~/.config/rea/credentials` — otherwise a dev who has
    // actually run `rea config set-key openrouter` would fail the no-key asserts.
    prevXdg = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = path.join(tmpDir, 'empty-config');
  });
  afterEach(() => {
    process.chdir(prevCwd);
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('openrouterConfiguredFromPolicy: default codex → false', () => {
    writePolicy(['review:', '  local_review:', '    mode: enforced']);
    expect(openrouterConfiguredFromPolicy(tmpDir)).toBe(false);
  });

  it('openrouterConfiguredFromPolicy: provider openrouter → true', () => {
    writePolicy(['review:', '  provider: openrouter']);
    expect(openrouterConfiguredFromPolicy(tmpDir)).toBe(true);
  });

  it('openrouterConfiguredFromPolicy: provider both → true', () => {
    writePolicy(['review:', '  provider: both']);
    expect(openrouterConfiguredFromPolicy(tmpDir)).toBe(true);
  });

  it('openrouterConfiguredFromPolicy: providers.openrouter block (provider codex) → true', () => {
    writePolicy([
      'review:',
      '  provider: codex',
      '  providers:',
      '    openrouter:',
      '      model: "openai/gpt-oss-120b"',
    ]);
    expect(openrouterConfiguredFromPolicy(tmpDir)).toBe(true);
  });

  it('openrouterConfiguredFromPolicy: missing policy → false', () => {
    // No .rea/policy.yaml at all.
    expect(openrouterConfiguredFromPolicy(tmpDir)).toBe(false);
  });

  // FIX (round-11): a missing key is FATAL when openrouter is the ACTIVE lane
  // under enforced mode (rea review exits 2), only a WARN otherwise.
  it('openrouterMissingKeyFatal: provider openrouter + enforced (default) → true', () => {
    writePolicy(['review:', '  provider: openrouter']);
    expect(openrouterMissingKeyFatal(tmpDir)).toBe(true);
  });

  it('openrouterMissingKeyFatal: provider both + enforced → FALSE (round-12: codex is authoritative, OR is a shadow)', () => {
    writePolicy(['review:', '  provider: both']);
    expect(openrouterMissingKeyFatal(tmpDir)).toBe(false);
  });

  it('openrouterMissingKeyFatal: provider openrouter + mode off → false (review skips, not fatal)', () => {
    writePolicy(['review:', '  provider: openrouter', '  local_review:', '    mode: off']);
    expect(openrouterMissingKeyFatal(tmpDir)).toBe(false);
  });

  it('openrouterMissingKeyFatal: configured-but-inactive (provider codex + providers.openrouter) → false', () => {
    writePolicy([
      'review:',
      '  provider: codex',
      '  providers:',
      '    openrouter:',
      '      model: "openai/gpt-oss-120b"',
    ]);
    expect(openrouterMissingKeyFatal(tmpDir)).toBe(false);
  });

  // codex round-2 P2: `provider: both | codex` makes codex the AUTHORITATIVE
  // local-review lane, so the codex doctor checks MUST run regardless of
  // `codex_required` — otherwise doctor green-lights a config `rea review` can't run.
  it('codexRequiredFromPolicy: provider both + codex_required false → TRUE (codex is authoritative)', () => {
    writePolicy(['review:', '  provider: both', '  codex_required: false']);
    expect(codexRequiredFromPolicy(tmpDir)).toBe(true);
  });

  it('codexRequiredFromPolicy: provider codex + codex_required false → FALSE (documented opt-out preserved)', () => {
    // Scoped to `both`: explicit `provider: codex` keeps the codex-less escape
    // hatch — only `both` forces the check regardless of codex_required.
    writePolicy(['review:', '  provider: codex', '  codex_required: false']);
    expect(codexRequiredFromPolicy(tmpDir)).toBe(false);
  });

  it('codexRequiredFromPolicy: provider openrouter + codex_required false → FALSE (codex is only a fallback)', () => {
    writePolicy(['review:', '  provider: openrouter', '  codex_required: false']);
    expect(codexRequiredFromPolicy(tmpDir)).toBe(false);
  });

  it('codexRequiredFromPolicy: provider openrouter + codex_required true → TRUE (push-gate needs it)', () => {
    writePolicy(['review:', '  provider: openrouter', '  codex_required: true']);
    expect(codexRequiredFromPolicy(tmpDir)).toBe(true);
  });

  it('codexRequiredFromPolicy: provider both + codex_required true → TRUE', () => {
    writePolicy(['review:', '  provider: both', '  codex_required: true']);
    expect(codexRequiredFromPolicy(tmpDir)).toBe(true);
  });

  it('codexRequiredFromPolicy: provider both + local_review.mode off + codex_required false → FALSE (codex round-12 P2: opted out, review skips)', () => {
    writePolicy([
      'review:',
      '  provider: both',
      '  codex_required: false',
      '  local_review:',
      '    mode: off',
    ]);
    expect(codexRequiredFromPolicy(tmpDir)).toBe(false);
  });

  it('codexRequiredFromPolicy: provider both + mode off + codex_required true → TRUE (push-gate still needs codex)', () => {
    writePolicy([
      'review:',
      '  provider: both',
      '  codex_required: true',
      '  local_review:',
      '    mode: off',
    ]);
    expect(codexRequiredFromPolicy(tmpDir)).toBe(true);
  });

  it('checkOpenRouterAvailability: missingKeyFatal=true + no key → FAIL (not warn)', () => {
    const r = checkOpenRouterAvailability({}, 'unprobed', true);
    expect(r.status).toBe('fail');
    expect(r.detail).not.toContain('sk-'); // never echoes a key
  });

  it('checkOpenRouterAvailability: missingKeyFatal=false + no key → warn', () => {
    const r = checkOpenRouterAvailability({}, 'unprobed', false);
    expect(r.status).toBe('warn');
  });

  /** Drive runDoctor capturing console.log; returns the rendered lines. */
  async function captureDoctorLines(): Promise<string[]> {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      lines.push(a.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((): never => {
      throw new Error('__exit__');
    }) as never);
    try {
      await runDoctor();
    } catch (e) {
      if (!(e instanceof Error) || e.message !== '__exit__') throw e;
    }
    return lines;
  }

  it('default codex policy (no openrouter config) → doctor emits NO openrouter line', async () => {
    writePolicy(['review:', '  local_review:', '    mode: enforced']);
    process.chdir(tmpDir);
    const lines = await captureDoctorLines();
    const orLines = lines.filter((l) => l.includes('openrouter review provider'));
    expect(orLines).toEqual([]);
  });

  it('provider: openrouter + NO key → doctor emits an openrouter WARN line', async () => {
    writePolicy(['review:', '  provider: openrouter']);
    process.chdir(tmpDir);
    // Ensure no key is present for this assertion.
    const prevKey = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const lines = await captureDoctorLines();
      const orLine = lines.find((l) => l.includes('openrouter review provider'));
      expect(orLine).toBeDefined();
      // The warn detail names the missing key (no value).
      expect(orLine).toContain('OPENROUTER_API_KEY not set');
    } finally {
      if (prevKey !== undefined) process.env.OPENROUTER_API_KEY = prevKey;
    }
  });

  it('checkOpenRouterAvailability: configured + key present → pass (reachability check runs)', () => {
    // The conditional gate only decides WHETHER to run; the check itself
    // returns pass when the key is present (reachability probed separately).
    const r = checkOpenRouterAvailability({ OPENROUTER_API_KEY: 'sk-or-x' }, 'reachable');
    expect(r.status).toBe('pass');
  });
});
