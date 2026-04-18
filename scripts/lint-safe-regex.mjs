#!/usr/bin/env node
// G3 — Static ReDoS lint.
//
// Every default pattern built into rea's middleware is passed through
// `safe-regex`. Any pattern flagged as unsafe fails the build.
//
// Run as part of `pnpm lint` (wired in package.json#scripts), BEFORE eslint —
// a bad regex is a security defect and must short-circuit the pipeline.
//
// This script reads the compiled `dist/**` output rather than importing the TS
// source directly: `lint` runs in CI after `build`, so `dist/` is authoritative.
// If `dist/` does not exist, we exit non-zero with a build hint.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import safeRegex from 'safe-regex';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const distRoot = path.join(repoRoot, 'dist');

if (!existsSync(distRoot)) {
  console.error('[lint:regex] dist/ not found — run `pnpm build` first.');
  process.exit(2);
}

const redactModulePath = path.join(distRoot, 'gateway', 'middleware', 'redact.js');
const injectionModulePath = path.join(distRoot, 'gateway', 'middleware', 'injection.js');

if (!existsSync(redactModulePath) || !existsSync(injectionModulePath)) {
  console.error(
    '[lint:regex] Expected dist outputs not found:\n' +
      `  - ${redactModulePath}\n` +
      `  - ${injectionModulePath}\n` +
      'Run `pnpm build` first.',
  );
  process.exit(2);
}

const redact = await import(redactModulePath);
const injection = await import(injectionModulePath);

const offenders = [];

// Check every SECRET_PATTERN.
for (const { name, pattern } of redact.SECRET_PATTERNS) {
  if (!safeRegex(pattern)) {
    offenders.push({ layer: 'redact.SECRET_PATTERNS', name, pattern: pattern.toString() });
  }
}

// Check injection regex constants.
const injectionPatterns = [
  { name: 'INJECTION_BASE64_PATTERN', pattern: injection.INJECTION_BASE64_PATTERN },
  { name: 'INJECTION_BASE64_SHAPE', pattern: injection.INJECTION_BASE64_SHAPE },
];
for (const { name, pattern } of injectionPatterns) {
  if (!safeRegex(pattern)) {
    offenders.push({ layer: 'injection', name, pattern: pattern.toString() });
  }
}

if (offenders.length > 0) {
  console.error('[lint:regex] UNSAFE REGEX DETECTED:');
  for (const o of offenders) {
    console.error(`  - ${o.layer} / ${o.name}: ${o.pattern}`);
  }
  console.error(
    '\nSafe-regex flagged these patterns as potentially ReDoS-vulnerable. Rewrite them with' +
      ' bounded quantifiers / no nested repetition / no disjoint alternation, then re-run.',
  );
  process.exit(1);
}

console.log(
  `[lint:regex] OK — ${redact.SECRET_PATTERNS.length} redact patterns, ${injectionPatterns.length} injection patterns cleared.`,
);
