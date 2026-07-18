/**
 * User-global project registry — the discovery index behind `rea dash`.
 *
 * ## What this is
 *
 * A single per-user JSON file at `~/.rea/registry.json` that records every
 * rea-aware project on the machine. `rea init` / `rea upgrade` self-register
 * the project they just touched; `rea dash` reads this index to aggregate a
 * "needs-you-first" view WITHOUT walking the whole filesystem on every run.
 *
 * ## Trust posture (deliberately NOT the global-CLI trust root)
 *
 * This registry is a NON-security, read-mostly dashboard index. It can only
 * ever list projects — it never grants a capability, so unlike the global-CLI
 * `trusted-projects` allow-list (`src/cli/global-cli.ts`, passwd-rooted +
 * env-immune) it resolves its home via `os.homedir()`. That also gives a clean
 * test seam: every public function takes an optional `registryPath` that
 * defaults to `~/.rea/registry.json`, so tests inject a temp path and never
 * touch the real home dir (no `process.env.HOME` mutation).
 *
 * ## Corruption policy
 *
 * A MISSING file is the first-run empty state. An unparseable or
 * schema-invalid file is NOT silently reset — `loadRegistry` throws, matching
 * the fail-closed posture of the fingerprint store (`fingerprints-store.ts`).
 * Silently resetting would drop the operator's whole project index on a single
 * bad byte. Because dash is non-load-bearing, the throw is caught at the dash
 * boundary and surfaced as a dash-only failure.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { atomicReplaceFile } from '../cli/install/fs-safe.js';

export const REGISTRY_VERSION = '1';

/** One registered project. `dashboard_visible: false` withholds task titles in
 *  the dashboard (the project is still discovered + health-checked). */
const ProjectEntrySchema = z
  .object({
    name: z.string(),
    rea_version: z.string(),
    dashboard_visible: z.boolean().optional(),
    last_registered: z.string(),
  })
  .strict();

const RegistrySchema = z
  .object({
    version: z.literal(REGISTRY_VERSION),
    projects: z.record(z.string(), ProjectEntrySchema),
  })
  .strict();

export type ProjectEntry = z.infer<typeof ProjectEntrySchema>;
export type Registry = z.infer<typeof RegistrySchema>;

/** `~/.rea/registry.json` — the default registry location. */
export function defaultRegistryPath(): string {
  return path.join(os.homedir(), '.rea', 'registry.json');
}

/**
 * Load the registry. A missing file yields an empty registry (first run). An
 * unreadable, non-JSON, or schema-invalid file THROWS — never silently reset,
 * which would drop the operator's entire project index. Delete the file to
 * deliberately re-bootstrap.
 */
export function loadRegistry(registryPath: string = defaultRegistryPath()): Registry {
  let raw: string;
  try {
    raw = fs.readFileSync(registryPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { version: REGISTRY_VERSION, projects: {} };
    }
    throw new Error(
      `failed to read project registry at ${registryPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `project registry at ${registryPath} is not valid JSON — delete the file to re-bootstrap if this is intentional: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const result = RegistrySchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `project registry at ${registryPath} failed schema validation: ${result.error.message}`,
    );
  }
  return result.data;
}

export interface RegisterProjectInput {
  name: string;
  reaVersion: string;
}

/**
 * Upsert a project into the registry (atomic write). Best-effort by contract:
 * every caller (`rea init` / `rea upgrade` self-registration) wraps this in a
 * try/catch so a registry write failure NEVER fails the surrounding command.
 *
 * The project path is stored resolved-absolute so it is a stable key. A
 * pre-existing `dashboard_visible` flag is preserved across re-registration
 * (re-running init must not silently un-hide a project the operator hid).
 * Idempotent apart from the `last_registered` timestamp.
 */
export async function registerProject(
  projectDir: string,
  input: RegisterProjectInput,
  registryPath: string = defaultRegistryPath(),
): Promise<void> {
  const abs = path.resolve(projectDir);
  // loadRegistry may throw on a corrupt file — let it propagate to the
  // best-effort try/catch at the call site rather than clobbering a file we
  // could not parse (never silently reset).
  const registry = loadRegistry(registryPath);

  const existing = registry.projects[abs];
  registry.projects[abs] = {
    name: input.name,
    rea_version: input.reaVersion,
    last_registered: new Date().toISOString(),
    ...(existing?.dashboard_visible !== undefined
      ? { dashboard_visible: existing.dashboard_visible }
      : {}),
  };

  // Validate our own write up front — fail loud on a malformed record.
  RegistrySchema.parse(registry);
  const serialized = JSON.stringify(registry, null, 2) + '\n';
  await atomicReplaceFile(registryPath, serialized);
}

export type ReconcileState = 'present' | 'missing' | 'deregistered';

export interface ReconcileResult {
  /** The registered absolute project path (registry key). */
  path: string;
  entry: ProjectEntry;
  /**
   * - `present`      — the directory exists AND still has a `.rea/` dir.
   * - `deregistered` — the directory exists but `.rea/` is gone (rea removed).
   * - `missing`      — the path no longer exists (moved/deleted).
   */
  state: ReconcileState;
}

/**
 * Stat every registered path and classify it. NEVER drops an entry — a vanished
 * path surfaces as `missing`, a de-rea'd directory as `deregistered`. Results
 * are sorted by path for stable output. Pure read (no registry mutation) — use
 * `pruneMissing` to actually drop `missing` entries.
 */
export function reconcile(registry: Registry): ReconcileResult[] {
  const out: ReconcileResult[] = [];
  for (const [projectPath, entry] of Object.entries(registry.projects)) {
    out.push({ path: projectPath, entry, state: classifyPath(projectPath) });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

function classifyPath(projectPath: string): ReconcileState {
  let st: fs.Stats;
  try {
    st = fs.statSync(projectPath);
  } catch {
    return 'missing';
  }
  if (!st.isDirectory()) return 'missing';
  const reaDir = path.join(projectPath, '.rea');
  try {
    if (fs.statSync(reaDir).isDirectory()) return 'present';
  } catch {
    /* .rea absent → deregistered */
  }
  return 'deregistered';
}

/**
 * Drop every `missing` entry from the registry and atomically persist the
 * result. Returns the paths that were pruned. A registry WRITE (allowed — the
 * registry is outside every project's task store).
 */
export async function pruneMissing(registryPath: string = defaultRegistryPath()): Promise<string[]> {
  const registry = loadRegistry(registryPath);
  const pruned: string[] = [];
  for (const { path: p, state } of reconcile(registry)) {
    if (state === 'missing') {
      pruned.push(p);
      delete registry.projects[p];
    }
  }
  if (pruned.length > 0) {
    RegistrySchema.parse(registry);
    await atomicReplaceFile(registryPath, JSON.stringify(registry, null, 2) + '\n');
  }
  return pruned;
}

export { RegistrySchema, ProjectEntrySchema };
