/**
 * `rea config set-key|get-key|unset-key|list` — turnkey management of
 * review-provider API keys in the managed credentials file.
 *
 * The key VALUE is read from a hidden prompt (interactive) or `--stdin` (CI) —
 * NEVER from argv, where it would leak into shell history, `ps`, and the audit
 * log. See `openrouter-key-source.ts` for the storage + security model.
 */

import type { Command } from 'commander';
import * as p from '@clack/prompts';
import { err } from './utils.js';
import {
  KeySourceError,
  credentialsPath,
  envVarFor,
  isSupportedProvider,
  maskKey,
  resolveProviderKey,
  setProviderKey,
  supportedProviders,
  unsetProviderKey,
} from './openrouter-key-source.js';

function unsupported(provider: string): void {
  err(`unsupported provider "${provider}". Supported: ${supportedProviders().join(', ')}`);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function envOverrideNote(provider: string): string | undefined {
  const envVar = envVarFor(provider);
  if (envVar === undefined) return undefined;
  const v = process.env[envVar];
  if (v !== undefined && v.length > 0) {
    return `  note: ${envVar} is set in this environment and OVERRIDES the stored key (env wins).`;
  }
  return undefined;
}

export async function runSetKey(provider: string, opts: { stdin?: boolean }): Promise<number> {
  if (!isSupportedProvider(provider)) {
    unsupported(provider);
    return 2;
  }

  let value: string;
  if (opts.stdin === true) {
    // Trim exactly one trailing newline (a `printf %s` pipe has none; an
    // `echo` pipe has one). Do NOT trim interior whitespace — a key is opaque.
    value = (await readStdin()).replace(/\r?\n$/, '');
  } else if (process.stdin.isTTY === true) {
    const entered = await p.password({
      message: `Paste the ${provider} API key (input hidden):`,
      validate: (v) => ((v ?? '').trim().length > 0 ? undefined : 'key cannot be empty'),
    });
    if (p.isCancel(entered)) {
      p.cancel('Aborted — no key stored.');
      return 1;
    }
    value = String(entered);
  } else {
    err(
      'no TTY for a masked prompt. Pipe the key via --stdin, e.g.:\n' +
        `  printf %s "$KEY" | rea config set-key ${provider} --stdin`,
    );
    return 2;
  }

  try {
    const { path: file } = setProviderKey(provider, value, process.env);
    process.stdout.write(
      `✓ stored ${provider} key (${maskKey(value.trim())}) → ${file} (mode 0600)\n`,
    );
    const note = envOverrideNote(provider);
    if (note !== undefined) process.stdout.write(`${note}\n`);
    return 0;
  } catch (e) {
    err(e instanceof KeySourceError ? e.message : String(e));
    return 1;
  }
}

export function runGetKey(provider: string): number {
  if (!isSupportedProvider(provider)) {
    unsupported(provider);
    return 2;
  }
  const r = resolveProviderKey(provider, process.env);
  if (r.source === 'none') {
    if (r.refusal !== undefined) {
      err(`${provider}: not usable — ${r.refusal}`);
    } else {
      process.stderr.write(`${provider}: not set. Set it: rea config set-key ${provider}\n`);
    }
    return 1;
  }
  const where = r.source === 'env' ? `env (${envVarFor(provider) ?? '?'})` : 'config file';
  process.stdout.write(`${provider}: set via ${where} (${maskKey(r.key ?? '')})\n`);
  return 0;
}

export function runUnsetKey(provider: string): number {
  if (!isSupportedProvider(provider)) {
    unsupported(provider);
    return 2;
  }
  try {
    const res = unsetProviderKey(provider, process.env);
    if (!res.removed) {
      process.stdout.write(`${provider}: nothing stored in the config file.\n`);
    } else {
      process.stdout.write(
        `✓ removed ${provider} key from the config file${res.fileDeleted ? ' (file now empty — deleted)' : ''}.\n`,
      );
    }
    // If the env var is ALSO set, the unset only cleared the file — the env
    // value still resolves. Say so plainly (different framing than set-key).
    const envVar = envVarFor(provider);
    if (envVar !== undefined && (process.env[envVar] ?? '').length > 0) {
      process.stdout.write(
        `  note: ${envVar} is still set in this environment (env overrides any stored key).\n`,
      );
    }
    return 0;
  } catch (e) {
    err(e instanceof KeySourceError ? e.message : String(e));
    return 1;
  }
}

export function runListKeys(): number {
  const rows = supportedProviders().map((prov) => {
    const r = resolveProviderKey(prov, process.env);
    let status: string;
    if (r.source === 'env') {
      status = `set via env (${envVarFor(prov) ?? '?'}) ${maskKey(r.key ?? '')}`;
    } else if (r.source === 'file') {
      status = `set via config file ${maskKey(r.key ?? '')}`;
    } else if (r.refusal !== undefined) {
      status = `REFUSED — ${r.refusal}`;
    } else {
      status = `not set — run: rea config set-key ${prov}`;
    }
    return `  ${prov.padEnd(12)} ${status}`;
  });

  process.stdout.write('rea managed credentials\n');
  const file = credentialsPath(process.env);
  if (file !== undefined) process.stdout.write(`  file: ${file}\n`);
  process.stdout.write(`${rows.join('\n')}\n`);
  return 0;
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Manage rea local configuration (managed credentials for review providers).');

  config
    .command('set-key <provider>')
    .description(
      'Store a review-provider API key in the managed credentials file ' +
        '(~/.config/rea/credentials, mode 0600). The value is read from a hidden ' +
        'prompt or --stdin — never from argv.',
    )
    .option('--stdin', 'read the key value from stdin (for CI / non-interactive use)')
    .action(async (provider: string, opts: { stdin?: boolean }) => {
      process.exitCode = await runSetKey(provider, {
        ...(opts.stdin === true ? { stdin: true } : {}),
      });
    });

  config
    .command('get-key <provider>')
    .description(
      'Report whether a provider key is set and its SOURCE (env / config file). ' +
        'Prints a masked fingerprint only — never the key.',
    )
    .action((provider: string) => {
      process.exitCode = runGetKey(provider);
    });

  config
    .command('unset-key <provider>')
    .description(
      'Remove a provider key from the managed credentials file. Does not affect environment variables.',
    )
    .action((provider: string) => {
      process.exitCode = runUnsetKey(provider);
    });

  config
    .command('list')
    .description(
      'List every review-provider key and where each resolves from (env wins over the config file).',
    )
    .action(() => {
      process.exitCode = runListKeys();
    });
}
