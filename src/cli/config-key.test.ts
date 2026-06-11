/**
 * Tests for the `rea config` command surface (run* functions, not the
 * commander wiring). Covers: --stdin ingestion, env-override notes, masked
 * output (never the key body), exit codes, and unsupported-provider handling.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { runGetKey, runListKeys, runSetKey, runUnsetKey } from './config-key.js';
import { resolveOpenRouterKey } from './openrouter-key-source.js';

const KEY = 'OPENROUTER_API_KEY';

let tmpHome: string;
let savedEnv: NodeJS.ProcessEnv;
let savedStdin: NodeJS.ReadStream;
let out: string[];
let errs: string[];

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'rea-configkey-'));
  savedEnv = process.env;
  // Hermetic env: point XDG at the throwaway dir, drop any real key.
  process.env = { XDG_CONFIG_HOME: tmpHome } as NodeJS.ProcessEnv;
  savedStdin = process.stdin;
  out = [];
  errs = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s: string | Uint8Array) => {
    out.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s: string | Uint8Array) => {
    errs.push(typeof s === 'string' ? s : Buffer.from(s).toString('utf8'));
    return true;
  });
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(' '));
  });
});

afterEach(() => {
  process.env = savedEnv;
  Object.defineProperty(process, 'stdin', { value: savedStdin, configurable: true });
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function feedStdin(data: string): void {
  const r = Readable.from([Buffer.from(data, 'utf8')]) as unknown as NodeJS.ReadStream;
  Object.defineProperty(process, 'stdin', { value: r, configurable: true });
}

function joined(arr: string[]): string {
  return arr.join('');
}

describe('runSetKey --stdin', () => {
  it('stores the piped key (one trailing newline stripped) and reports masked', async () => {
    feedStdin('sk-or-v1-SECRETBODY9999\n');
    const code = await runSetKey('openrouter', { stdin: true });
    expect(code).toBe(0);
    expect(resolveOpenRouterKey(process.env).key).toBe('sk-or-v1-SECRETBODY9999');
    const o = joined(out);
    expect(o).toContain('…9999'); // masked fingerprint
    expect(o).not.toContain('SECRETBODY'); // never the body
  });

  it('refuses an empty piped value (exit 1)', async () => {
    feedStdin('\n');
    const code = await runSetKey('openrouter', { stdin: true });
    expect(code).toBe(1);
    expect(joined(errs)).toMatch(/empty key/i);
  });

  it('warns that env OVERRIDES the stored key when the env var is also set', async () => {
    process.env[KEY] = 'sk-or-ENVWINS';
    feedStdin('sk-or-FILEKEY\n');
    const code = await runSetKey('openrouter', { stdin: true });
    expect(code).toBe(0);
    expect(joined(out)).toMatch(/OVERRIDES the stored key/i);
  });

  it('rejects an unsupported provider (exit 2)', async () => {
    const code = await runSetKey('nope', { stdin: true });
    expect(code).toBe(2);
    expect(joined(errs)).toMatch(/unsupported provider/i);
  });

  it('non-interactive without --stdin → exit 2 with --stdin guidance', async () => {
    // process.stdin from a piped Readable is not a TTY.
    feedStdin('');
    const code = await runSetKey('openrouter', {});
    expect(code).toBe(2);
    expect(joined(errs)).toMatch(/--stdin/);
  });
});

describe('runGetKey / runListKeys / runUnsetKey', () => {
  it('get-key not-set → exit 1, actionable message, no key', async () => {
    const code = runGetKey('openrouter');
    expect(code).toBe(1);
    expect(joined(errs)).toMatch(/not set/i);
  });

  it('get-key set-via-file → exit 0, masked, names the source', async () => {
    feedStdin('sk-or-v1-BODY4242\n');
    await runSetKey('openrouter', { stdin: true });
    out.length = 0;
    const code = runGetKey('openrouter');
    expect(code).toBe(0);
    const o = joined(out);
    expect(o).toMatch(/config file/);
    expect(o).toContain('…4242');
    expect(o).not.toContain('BODY4242');
  });

  it('get-key set-via-env → names env source', async () => {
    process.env[KEY] = 'sk-or-ENV7777';
    const code = runGetKey('openrouter');
    expect(code).toBe(0);
    expect(joined(out)).toMatch(/env \(OPENROUTER_API_KEY\)/);
  });

  it('list shows not-set guidance then set status', async () => {
    runListKeys();
    expect(joined(out)).toMatch(/not set — run: rea config set-key openrouter/);
    out.length = 0;
    feedStdin('sk-or-v1-LISTED8888\n');
    await runSetKey('openrouter', { stdin: true });
    out.length = 0;
    runListKeys();
    const o = joined(out);
    expect(o).toMatch(/set via config file/);
    expect(o).toContain('…8888');
    expect(o).not.toContain('LISTED8888');
  });

  it('unset-key removes the stored key', async () => {
    feedStdin('sk-or-GONE\n');
    await runSetKey('openrouter', { stdin: true });
    const code = runUnsetKey('openrouter');
    expect(code).toBe(0);
    expect(joined(out)).toMatch(/removed openrouter key/i);
    expect(resolveOpenRouterKey(process.env).source).toBe('none');
  });

  it('unset-key with nothing stored is a graceful no-op', () => {
    const code = runUnsetKey('openrouter');
    expect(code).toBe(0);
    expect(joined(out)).toMatch(/nothing stored/i);
  });
});
