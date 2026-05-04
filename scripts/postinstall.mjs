#!/usr/bin/env node
/**
 * G12 — postinstall version-drift nudge.
 *
 * Printed exactly once when a consumer's `@bookedsolid/rea` installed version
 * disagrees with the version recorded in their `.rea/install-manifest.json`.
 * The message points at `rea upgrade`. NEVER fails the install — this script
 * returns 0 under every code path.
 *
 * Silence rules:
 *   - Only runs when invoked from a consumer project (i.e. when this script
 *     lives inside `node_modules/@bookedsolid/rea/scripts/`). When running
 *     from the rea repo itself, the INIT_CWD/workspace check skips.
 *   - No output when CI (any common CI var set) — we don't want to spam build
 *     logs with governance reminders.
 *   - No output when a manifest does not exist (pre-G12 install) — `rea init`
 *     will write the first manifest; nothing to reconcile.
 *   - No output when versions match.
 *
 * Everything else is best-effort. Any error is swallowed.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const NOTE = (lines) => {
  process.stderr.write('\n');
  for (const line of lines) process.stderr.write(`rea: ${line}\n`);
  process.stderr.write('\n');
};

/** CI detection: check the union of vars that package managers and runners set.
 * `CI=true` covers GitHub Actions / CircleCI / Travis / GitLab / BuildKite /
 * Netlify / Vercel; the rest cover Jenkins, Buildkite agent, and npm's own
 * `npm_config_ci`. A conservative default: silent if any is set. */
function isCI() {
  const env = process.env;
  if (env.CI === 'true' || env.CI === '1') return true;
  if (env.CONTINUOUS_INTEGRATION === 'true' || env.CONTINUOUS_INTEGRATION === '1') return true;
  if (env.BUILD_NUMBER !== undefined && env.BUILD_NUMBER !== '') return true; // Jenkins
  if (env.RUN_ID !== undefined && env.RUN_ID !== '') return true;
  if (env.GITHUB_ACTIONS === 'true') return true;
  if (env.npm_config_ci === 'true') return true;
  return false;
}

/** Resolve this script's directory without relying on `new URL().pathname`,
 * which is broken on Windows (leading `/` + backslash decoding). */
function selfDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

/** Rea-repo self-detection. Any of these means we're running inside the rea
 * source tree (not a consumer install) and should be silent. */
function isOwnRepo(consumerRoot, selfPkgPath) {
  try {
    const consumerPkgPath = path.join(consumerRoot, 'package.json');
    if (fs.existsSync(consumerPkgPath)) {
      const consumerPkg = JSON.parse(fs.readFileSync(consumerPkgPath, 'utf8'));
      if (consumerPkg?.name === '@bookedsolid/rea') return true;
    }
  } catch {
    /* consumer package.json unreadable — fall through */
  }
  // If our own package.json lives directly under consumerRoot, the consumer
  // IS the rea repo (no node_modules nesting). This covers `pnpm install` at
  // the top of the rea repo where INIT_CWD and selfDir's parent match.
  try {
    const selfPkgDir = path.dirname(selfPkgPath);
    if (path.resolve(selfPkgDir) === path.resolve(consumerRoot)) return true;
  } catch {
    /* fall through */
  }
  return false;
}

try {
  if (isCI()) process.exit(0);

  // INIT_CWD is the directory where `npm/pnpm/yarn install` was invoked — i.e.
  // the consumer project root. If it's unset, npm is either very old or we're
  // running outside a package manager; either way, nothing to do.
  const consumerRoot = process.env.INIT_CWD;
  if (typeof consumerRoot !== 'string' || consumerRoot.length === 0) process.exit(0);

  // `fileURLToPath` handles Windows (`file:///C:/...`) correctly, unlike the
  // old `new URL(import.meta.url).pathname` which left a leading `/` on Win32.
  const selfPkgPath = path.join(selfDir(), '..', 'package.json');

  if (isOwnRepo(consumerRoot, selfPkgPath)) process.exit(0);

  const manifestPath = path.join(consumerRoot, '.rea', 'install-manifest.json');
  if (!fs.existsSync(manifestPath)) process.exit(0);

  let installedVersion = null;
  if (fs.existsSync(selfPkgPath)) {
    try {
      const selfPkg = JSON.parse(fs.readFileSync(selfPkgPath, 'utf8'));
      if (typeof selfPkg?.version === 'string') installedVersion = selfPkg.version;
    } catch {
      process.exit(0);
    }
  }
  if (installedVersion === null) process.exit(0);

  let manifestVersion = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (typeof manifest?.version === 'string') manifestVersion = manifest.version;
  } catch {
    process.exit(0);
  }
  if (manifestVersion === null) process.exit(0);

  if (manifestVersion === installedVersion) process.exit(0);

  // 0.18.1+ helixir #3: opt-in auto-upgrade. Pre-fix the drift was
  // detected and a "run rea upgrade" nudge printed, but consumers had
  // to run the upgrade by hand on every install. With
  // `REA_AUTO_UPGRADE=1` (or `--yes` semantics inferred from a
  // package.json field), the postinstall runs `rea upgrade --yes`
  // for them. Defaults to PRINT-ONLY for back-compat — silent
  // mutation of the consumer's `.claude/` / `.husky/` on every
  // install would surprise existing users.
  const autoUpgrade =
    process.env.REA_AUTO_UPGRADE === '1' ||
    process.env.REA_AUTO_UPGRADE === 'true';

  if (autoUpgrade) {
    // Best-effort: invoke `rea upgrade --yes`. Failures fall through to
    // the print path so the consumer still sees the drift advisory.
    try {
      const reaCli = path.join(consumerRoot, 'node_modules', '.bin', 'rea');
      if (fs.existsSync(reaCli)) {
        const { spawnSync } = await import('node:child_process');
        // 0.19.0 backend-engineer P2-1: 5-min wall-clock cap so a hung
        // upgrade falls through to print-only instead of hanging the
        // consumer's `npm install`. 0.19.0 code-reviewer P3-6:
        // Windows shim (.bin/rea.cmd) requires `shell: true` —
        // detect via process.platform.
        const res = spawnSync(reaCli, ['upgrade', '--yes'], {
          cwd: consumerRoot,
          stdio: 'inherit',
          env: process.env,
          timeout: 5 * 60 * 1000,
          shell: process.platform === 'win32',
        });
        if (res.status === 0) {
          NOTE([
            `@bookedsolid/rea: auto-upgraded from v${manifestVersion} to v${installedVersion}.`,
            `(REA_AUTO_UPGRADE=1; set REA_AUTO_UPGRADE=0 to opt out.)`,
          ]);
          process.exit(0);
        }
      }
    } catch {
      // Fall through to the manual-nudge path below.
    }
  }

  // Package-manager-agnostic nudge. Any of `npx rea upgrade`,
  // `pnpm exec rea upgrade`, or `yarn rea upgrade` works; recommending `npx`
  // covers the widest audience without privileging pnpm in error output.
  NOTE([
    `@bookedsolid/rea v${installedVersion} installed; manifest at v${manifestVersion}.`,
    `Run  \`npx rea upgrade\`  to sync .claude/, .husky/, and managed fragments.`,
    `(Or  \`npx rea doctor --drift\`  to preview without changes.)`,
    `(Set  \`REA_AUTO_UPGRADE=1\`  to auto-run upgrade on future installs.)`,
  ]);
} catch {
  // Any uncaught failure → silent success. Never break the consumer's install.
}

process.exit(0);
