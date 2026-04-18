import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Package root, resolved from the compiled CLI module location.
 * Compiled path: dist/cli/utils.js → package root is two levels up.
 */
export const PKG_ROOT = path.resolve(__dirname, '..', '..');

export function getPkgVersion(): string {
  try {
    const pkgPath = path.join(PKG_ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const REA_DIR = '.rea';
export const POLICY_FILE = 'policy.yaml';
export const REGISTRY_FILE = 'registry.yaml';
export const HALT_FILE = 'HALT';
export const AUDIT_FILE = 'audit.jsonl';

export function reaPath(baseDir: string, ...segments: string[]): string {
  return path.join(baseDir, REA_DIR, ...segments);
}

/**
 * Standard log prefix so users notice the transition from reagent → rea.
 */
export function log(message: string): void {
  console.log(`[rea] ${message}`);
}

export function warn(message: string): void {
  console.warn(`[rea] WARN: ${message}`);
}

export function err(message: string): void {
  console.error(`[rea] ERROR: ${message}`);
}

/**
 * Print a "policy missing — run init" message and exit 1.
 * Used by commands that require a policy file to operate.
 */
export function exitWithMissingPolicy(policyPath: string): never {
  err(`Policy file not found: ${policyPath}`);
  console.error('');
  console.error('  Run `npx rea init` to initialize REA in this directory.');
  console.error('');
  process.exit(1);
}
