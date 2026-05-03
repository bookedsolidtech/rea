#!/usr/bin/env node
/**
 * Canonical/dogfood drift check.
 *
 * The repo dogfoods its own install — `.claude/hooks/`, `.claude/agents/`,
 * `.claude/commands/` are byte-identical mirrors of `hooks/`, `agents/`,
 * `commands/` produced by `rea init`/`rea upgrade` against this repo.
 * Pre-0.14.1 there was no CI gate enforcing this invariant; multiple
 * Class-I drift bugs shipped (secret-scanner.sh missing the 0.14.0
 * MultiEdit fix, changeset-security-gate.sh missing the BSD-grep fix,
 * dependency-audit-gate.sh missing the `pnpm i` alias).
 *
 * This check fails CI on any drift between the canonical surface and
 * the dogfooded copy. Run as `pnpm test:dogfood`. Exit 0 on clean,
 * exit 1 on drift with a diff printed to stderr.
 *
 * Allowlist of files in `.claude/` that are NOT mirrors (they are
 * generated/managed differently): `.claude/settings.json`,
 * `.claude/settings.local.json`. Everything else under `.claude/hooks/`,
 * `.claude/agents/`, `.claude/commands/` must match canonical.
 */

import { execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * @typedef {{ canonical: string, dogfood: string }} Pair
 * @typedef {{ pair: Pair, ok: boolean, diff: string }} DriftResult
 */

const PAIRS = [
  { canonical: 'hooks', dogfood: '.claude/hooks' },
  { canonical: 'agents', dogfood: '.claude/agents' },
  { canonical: 'commands', dogfood: '.claude/commands' },
];

/** @param {Pair} pair @returns {DriftResult} */
function checkPair(pair) {
  const canonicalAbs = path.join(REPO_ROOT, pair.canonical);
  const dogfoodAbs = path.join(REPO_ROOT, pair.dogfood);

  if (!fs.existsSync(canonicalAbs)) {
    return { pair, ok: false, diff: `canonical missing: ${canonicalAbs}` };
  }
  if (!fs.existsSync(dogfoodAbs)) {
    return { pair, ok: false, diff: `dogfood missing: ${dogfoodAbs}` };
  }

  try {
    // BSD diff rejects -u and -q together. Use -rq for recursive brief
    // (which file pairs differ) — works on both BSD and GNU diff.
    execSync(`diff -rq "${canonicalAbs}" "${dogfoodAbs}"`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { pair, ok: true, diff: '' };
  } catch (e) {
    const out = e.stdout ?? '';
    const err = e.stderr ?? '';
    return { pair, ok: false, diff: `${out}\n${err}`.trim() };
  }
}

/**
 * 0.15.0 codex P0 fix: also validate that the dogfooded
 * `.claude/settings.json` registers every rea-owned hook from the
 * canonical `defaultDesiredHooks()`. Without this check, a new hook
 * can ship in `hooks/` AND get mirrored to `.claude/hooks/` (drift-
 * pair stays clean) but never appear in the dogfood `.claude/settings.json`
 * — meaning the harness doesn't fire it in the rea repo's own session,
 * and the rea repo dogfoods broken protection.
 *
 * The check enumerates every hook script referenced by the canonical
 * desired-hooks set and asserts each appears in the dogfood
 * settings.json under the right matcher group.
 */
function checkSettingsRegistration() {
  const settingsPath = path.join(REPO_ROOT, '.claude/settings.json');
  if (!fs.existsSync(settingsPath)) {
    return { ok: false, diff: `dogfood settings missing: ${settingsPath}` };
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  } catch (e) {
    return { ok: false, diff: `dogfood settings unparseable: ${e.message}` };
  }

  // Mirror of `defaultDesiredHooks()` in src/cli/install/settings-merge.ts.
  // Kept in sync by hand because importing the .ts at build-test time is
  // heavier than the value here. If `defaultDesiredHooks()` changes shape,
  // update both — and the `pnpm test:dogfood` failure surfaces it.
  const expected = {
    PreToolUse: {
      Bash: [
        'dangerous-bash-interceptor.sh',
        'env-file-protection.sh',
        'protected-paths-bash-gate.sh',
        'dependency-audit-gate.sh',
        'security-disclosure-gate.sh',
        'pr-issue-link-gate.sh',
        'attribution-advisory.sh',
      ],
      'Write|Edit|MultiEdit': [
        'secret-scanner.sh',
        'settings-protection.sh',
        'blocked-paths-enforcer.sh',
        'changeset-security-gate.sh',
      ],
    },
    PostToolUse: {
      'Write|Edit|MultiEdit': ['architecture-review-gate.sh'],
    },
  };

  const missing = [];
  for (const [event, byMatcher] of Object.entries(expected)) {
    const groups = data.hooks?.[event] ?? [];
    for (const [matcher, hookFiles] of Object.entries(byMatcher)) {
      const group = groups.find((g) => g.matcher === matcher);
      if (!group) {
        missing.push(`${event} :: matcher "${matcher}" — group not present in dogfood settings.json`);
        continue;
      }
      const registered = group.hooks.map((h) => h.command ?? '');
      for (const hookFile of hookFiles) {
        if (!registered.some((c) => c.includes(`/${hookFile}`))) {
          missing.push(`${event} :: matcher "${matcher}" — missing ${hookFile}`);
        }
      }
    }
  }

  if (missing.length > 0) {
    return {
      ok: false,
      diff: missing.join('\n  - '),
    };
  }
  return { ok: true, diff: '' };
}

function main() {
  const results = PAIRS.map(checkPair);
  let drifted = false;
  for (const r of results) {
    if (r.ok) {
      console.log(`[drift] OK — ${r.pair.canonical}/ ↔ ${r.pair.dogfood}/`);
    } else {
      drifted = true;
      console.error(`[drift] FAIL — ${r.pair.canonical}/ ↔ ${r.pair.dogfood}/`);
      console.error(r.diff);
      console.error('');
    }
  }
  // Settings.json registration check (0.15.0 codex P0 fix).
  const settingsRes = checkSettingsRegistration();
  if (settingsRes.ok) {
    console.log('[drift] OK — .claude/settings.json registers all canonical hooks');
  } else {
    drifted = true;
    console.error('[drift] FAIL — .claude/settings.json missing canonical hook registrations:');
    console.error('  - ' + settingsRes.diff);
    console.error('');
  }
  if (drifted) {
    console.error(
      '\n[drift] Run `cp -r <canonical>/* <dogfood>/` to sync hook files, or update canonical to match.\n' +
        '[drift] The dogfood under .claude/ MUST be byte-identical to canonical hooks/, agents/, commands/.\n' +
        '[drift] For .claude/settings.json: add the missing hook entry under the named matcher group.\n' +
        '[drift] If a file is intentionally only in dogfood (legacy carry-over), delete it.',
    );
    process.exit(1);
  }
  console.log('\n[drift] All canonical ↔ dogfood pairs clean.');
}

main();
