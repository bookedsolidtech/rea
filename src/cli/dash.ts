/**
 * `rea dash [path]` — the GLOBAL, strictly READ-ONLY project dashboard.
 *
 * ## What it is
 *
 * A "needs-you-first" morning view that discovers every rea-aware project on
 * the machine (via the user-global registry `~/.rea/registry.json`) and folds
 * each project's `.rea/tasks.jsonl` into a small set of attention groups. It
 * READS artifacts and renders — it NEVER writes or mutates any project's task
 * state, and no gate/hook/spine depends on it. If it throws, that is a
 * dash-ONLY failure.
 *
 * The only writes it performs are to the user-global registry itself
 * (`--prune` drops vanished entries, `--rescan` registers newly-discovered
 * projects) — both explicitly allowed; the registry lives OUTSIDE every
 * project's task store.
 *
 * ## Groups (needs-you-first order)
 *
 *   1. Awaiting ratification / parked blockers — pending tasks with a
 *      `blocked_by`, or `requires_spec` without a `spec`. Leads.
 *   2. Review queue — RECENTLY completed tasks (proxy for "awaiting sign-off").
 *      Terminal work ages out after `REVIEW_WINDOW_MS`, so a project with only
 *      old completed history falls back to idle rather than nagging forever.
 *   3. In flight — `in_progress` tasks.
 *   4. Health flags — a live `.reagent/` dir (migration debt), or a registry
 *      `rea_version` older than this package (stale spine).
 *   5. Idle / healthy — projects with nothing pending, one collapsed line.
 *
 * ## Visibility
 *
 * A project marked `dashboard_visible: false` (registry entry OR its
 * `.rea/policy.yaml`) is still discovered + health-checked, but its task TITLES
 * are withheld — rendered as one opaque "N items, hidden" line. `--all`
 * overrides that only for present projects.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Command } from 'commander';
import { parse as parseYaml } from 'yaml';
import { readTasks } from '../tasks/store.js';
import { resolveLocalRoot } from '../lib/worktree-roots.js';
import type { TaskRecord } from '../tasks/types.js';
import {
  canonicalizeProjectPath,
  defaultRegistryPath,
  loadRegistry,
  pruneMissing,
  reconcile,
  registerProject,
  type ProjectEntry,
  type ReconcileState,
} from '../registry/projects.js';
import { err, getPkgVersion, log } from './utils.js';
import { renderMoc } from './dash-moc.js';

// ---------------------------------------------------------------------------
// Options + machine schema
// ---------------------------------------------------------------------------

export interface DashOptions {
  json?: boolean;
  rescan?: boolean;
  /** Roots for `--rescan`. Empty → default allowlist. */
  rescanRoots?: string[];
  prune?: boolean;
  all?: boolean;
  /**
   * Vault-MOC output mode (spec §4). When true, render the aggregated model as
   * an Obsidian MOC markdown document instead of the terminal / JSON view.
   * Takes precedence over `json`.
   */
  emitMoc?: boolean;
  /**
   * Destination for `--emit-moc`. Absent → write the MOC to stdout (composes
   * with shell redirection). Present → write the file there; the parent
   * directory must already exist or dash errors cleanly (it never mkdir's an
   * operator's vault tree).
   */
  mocPath?: string;
  /** Per-repo mode: dashboard for this project only. */
  path?: string;
  /** Test seam — defaults to `~/.rea/registry.json`. */
  registryPath?: string;
  /** Test seam — the default scan allowlist / homedir anchor. */
  scanRoots?: string[];
}

export type HealthFlagKind = 'reagent_dir' | 'stale_version' | 'deregistered';

export interface DashItem {
  project: string;
  project_path: string;
  task_id: string;
  subject: string;
  status: TaskRecord['status'];
}

export interface DashHealthFlag {
  project: string;
  project_path: string;
  flag: HealthFlagKind;
  detail: string;
}

export interface DashProjectSummary {
  project: string;
  project_path: string;
  rea_version: string;
}

export interface DashHiddenSummary {
  project: string;
  project_path: string;
  item_count: number;
}

export interface DashJson {
  version: '1';
  generated_at: string;
  mode: 'global' | 'repo';
  groups: {
    awaiting: DashItem[];
    review_queue: DashItem[];
    in_flight: DashItem[];
    health_flags: DashHealthFlag[];
    idle: DashProjectSummary[];
  };
  hidden: DashHiddenSummary[];
  missing: DashProjectSummary[];
  deregistered: DashProjectSummary[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip ASCII control codes before a disk-sourced field reaches the terminal. */
function clean(value: string): string {
  return value.replace(/[\x00-\x1f\x7f]/g, '?');
}

function emptyJson(mode: 'global' | 'repo'): DashJson {
  return {
    version: '1',
    generated_at: new Date().toISOString(),
    mode,
    groups: { awaiting: [], review_queue: [], in_flight: [], health_flags: [], idle: [] },
    hidden: [],
    missing: [],
    deregistered: [],
  };
}

/**
 * Derive a display name for a project directory: `package.json` `name`, else
 * the directory basename. Best-effort — never throws.
 */
export function deriveProjectName(projectDir: string): string {
  const pkgPath = path.join(projectDir, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: unknown };
    if (typeof pkg.name === 'string' && pkg.name.length > 0) return pkg.name;
  } catch {
    /* fall through to basename */
  }
  return path.basename(projectDir);
}

/**
 * Read a project's rea version. Prefers the registry entry (authoritative for
 * "when last registered"), falls back to the on-disk `.rea/install-manifest.json`
 * so per-repo mode works for a project not in the registry. `null` if unknown.
 */
function readProjectVersion(projectDir: string, entry: ProjectEntry | undefined): string | null {
  if (entry !== undefined) return entry.rea_version;
  const manifestPath = path.join(projectDir, '.rea', 'install-manifest.json');
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { version?: unknown };
    if (typeof m.version === 'string' && m.version.length > 0) return m.version;
  } catch {
    /* unknown */
  }
  return null;
}

/**
 * Read `dashboard_visible` from a project's `.rea/policy.yaml`. Returns the
 * boolean when explicitly set, else `undefined`. Best-effort raw YAML parse
 * (NOT the strict policy loader — dash must tolerate any policy shape).
 */
function readPolicyDashboardVisible(projectDir: string): boolean | undefined {
  const policyPath = path.join(projectDir, '.rea', 'policy.yaml');
  let parsed: unknown;
  try {
    parsed = parseYaml(fs.readFileSync(policyPath, 'utf8'));
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== 'object') return undefined;
  const v = (parsed as Record<string, unknown>)['dashboard_visible'];
  return typeof v === 'boolean' ? v : undefined;
}

/**
 * Is `candidate` strictly older than `current`? Compares dotted numeric
 * `major.minor.patch` segments; a prerelease/suffix on either side is dropped.
 * Unparseable → `false` (never a false "stale" flag on odd version strings).
 */
export function isOlderVersion(candidate: string, current: string): boolean {
  const parse = (v: string): number[] | null => {
    const core = v.trim().replace(/^v/, '').split(/[-+]/)[0] ?? '';
    const parts = core.split('.');
    const nums: number[] = [];
    for (const p of parts) {
      const n = Number.parseInt(p, 10);
      if (!Number.isInteger(n)) return null;
      nums.push(n);
    }
    return nums.length > 0 ? nums : null;
  };
  const a = parse(candidate);
  const b = parse(current);
  if (a === null || b === null) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    if (ai < bi) return true;
    if (ai > bi) return false;
  }
  return false;
}

/** A pending task that leads the "awaiting" group. */
function isAwaiting(t: TaskRecord): boolean {
  if (t.status !== 'pending') return false;
  const blocked = (t.blocked_by?.length ?? 0) > 0;
  const specGap = t.requires_spec === true && (t.spec === undefined || t.spec.length === 0);
  return blocked || specGap;
}

/**
 * How long a terminal task stays in the review bucket. The review queue surfaces
 * "completed work awaiting operator sign-off" (spec §3.2) — a task the operator
 * still needs to glance at, NOT the project's entire completed history. Without
 * an ageing window the bucket is monotonic: `.rea/tasks.jsonl` is append-only,
 * there is no reviewed/archived state and no CLI to un-complete a task, so after
 * the first completion a project could never fall back to idle/healthy and would
 * perpetually read as "needs you." A completed task is therefore review-worthy
 * only while its last update is within this window; older ones age out and the
 * project can return to calm. 7 days = a comfortable sign-off horizon.
 */
export const REVIEW_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Does a completed task still belong in the review queue? True only while it was
 * updated within `REVIEW_WINDOW_MS` of `nowMs`. `nowMs` is threaded from the
 * model's `generated_at` stamp (not a raw `Date.now()`) so the classifier is
 * deterministic and test-freezable. Only `completed` qualifies — `cancelled` is
 * terminal but is abandoned work, never sign-off work, so it never surfaces here.
 * An unparseable/future `updated_at` yields NaN/negative deltas: NaN drops out
 * (never a false "recent" flag), a future stamp is treated as recent.
 */
function isRecentReview(t: TaskRecord, nowMs: number): boolean {
  if (t.status !== 'completed') return false;
  const updatedMs = Date.parse(t.updated_at);
  return nowMs - updatedMs <= REVIEW_WINDOW_MS;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

interface ProjectClassification {
  awaiting: TaskRecord[];
  review: TaskRecord[];
  inFlight: TaskRecord[];
  health: { flag: HealthFlagKind; detail: string }[];
}

function classifyProject(
  projectDir: string,
  entry: ProjectEntry | undefined,
  nowMs: number,
): ProjectClassification {
  const tasks = readTasks(projectDir);
  const awaiting = tasks.filter(isAwaiting);
  const review = tasks.filter((t) => isRecentReview(t, nowMs));
  const inFlight = tasks.filter((t) => t.status === 'in_progress');

  const health: { flag: HealthFlagKind; detail: string }[] = [];
  // Legacy `.reagent/` migration debt.
  try {
    if (fs.statSync(path.join(projectDir, '.reagent')).isDirectory()) {
      health.push({ flag: 'reagent_dir', detail: 'legacy .reagent/ present — migration debt' });
    }
  } catch {
    /* no .reagent — fine */
  }
  // Stale spine: registered/installed version older than this package.
  const version = readProjectVersion(projectDir, entry);
  const current = getPkgVersion();
  if (version !== null && isOlderVersion(version, current)) {
    health.push({
      flag: 'stale_version',
      detail: `rea ${version} < ${current} — run \`rea upgrade\``,
    });
  }
  return { awaiting, review, inFlight, health };
}

/**
 * Resolve whether a project's task titles are visible. Hidden when the registry
 * entry OR the project's `.rea/policy.yaml` sets `dashboard_visible: false`.
 * `--all` reveals titles for present projects (never changes health checks).
 */
function resolveVisible(
  projectDir: string,
  entry: ProjectEntry | undefined,
  all: boolean,
): boolean {
  if (all) return true;
  if (entry?.dashboard_visible === false) return false;
  if (readPolicyDashboardVisible(projectDir) === false) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface ProjectTarget {
  projectDir: string;
  entry: ProjectEntry | undefined;
  state: ReconcileState;
}

function buildJson(targets: ProjectTarget[], mode: 'global' | 'repo', all: boolean): DashJson {
  const out = emptyJson(mode);
  // Single clock reference for terminal-task ageing, reused from the model's
  // own `generated_at` stamp so every project is classified against one instant
  // and tests can freeze it (fake timers flow through `emptyJson`'s `new Date`).
  const nowMs = Date.parse(out.generated_at);

  for (const { projectDir, entry, state } of targets) {
    const name = entry?.name ?? deriveProjectName(projectDir);
    const version = readProjectVersion(projectDir, entry) ?? 'unknown';

    if (state === 'missing') {
      out.missing.push({ project: name, project_path: projectDir, rea_version: version });
      continue;
    }
    if (state === 'deregistered') {
      out.deregistered.push({ project: name, project_path: projectDir, rea_version: version });
      out.groups.health_flags.push({
        project: name,
        project_path: projectDir,
        flag: 'deregistered',
        detail: '.rea/ directory is gone — rea uninstalled or moved',
      });
      continue;
    }

    // Present project — classify + emit.
    const c = classifyProject(projectDir, entry, nowMs);
    for (const h of c.health) {
      out.groups.health_flags.push({
        project: name,
        project_path: projectDir,
        flag: h.flag,
        detail: h.detail,
      });
    }

    const itemCount = c.awaiting.length + c.review.length + c.inFlight.length;
    const visible = resolveVisible(projectDir, entry, all);

    if (!visible) {
      if (itemCount > 0) {
        out.hidden.push({ project: name, project_path: projectDir, item_count: itemCount });
      } else if (c.health.length === 0) {
        out.groups.idle.push({ project: name, project_path: projectDir, rea_version: version });
      }
      continue;
    }

    const toItem = (t: TaskRecord): DashItem => ({
      project: name,
      project_path: projectDir,
      task_id: t.id,
      subject: clean(t.subject),
      status: t.status,
    });
    for (const t of c.awaiting) out.groups.awaiting.push(toItem(t));
    for (const t of c.review) out.groups.review_queue.push(toItem(t));
    for (const t of c.inFlight) out.groups.in_flight.push(toItem(t));

    if (itemCount === 0 && c.health.length === 0) {
      out.groups.idle.push({ project: name, project_path: projectDir, rea_version: version });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Deep filesystem sweep (`--rescan`, opt-in only)
// ---------------------------------------------------------------------------

const SCAN_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  '.cache',
  // Heavy hidden dirs that never contain a rea project — skipped explicitly
  // now that the rescan traverses dot-directories generally (round-25 P2), so
  // a project under `.worktrees/`/`.claude/worktrees/`/`.src/` IS discovered
  // while these large trees are still pruned.
  '.venv',
  '.tox',
  '.terraform',
  '.gradle',
  '.idea',
  '.vscode',
  '.next',
  '.nuxt',
  '.turbo',
  '.pnpm-store',
  '.yarn',
]);
const SCAN_MAX_DEPTH = 5;

/**
 * Bounded breadth sweep for `.rea/` directories under `roots`. Skips
 * `node_modules`/.git/etc, caps depth, follows no symlinks. Returns absolute
 * project dirs (the PARENT of each discovered `.rea/`). Kept OUT of the no-arg
 * hot path — invoked only by `--rescan`.
 */
export function scanForProjects(roots: string[]): string[] {
  const found = new Set<string>();
  const seen = new Set<string>();

  const walk = (dir: string, depth: number): void => {
    if (depth > SCAN_MAX_DEPTH) return;
    let real: string;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // A `.rea/` child marks this dir as a project root.
    if (entries.some((e) => e.name === '.rea' && (e.isDirectory() || e.isSymbolicLink()))) {
      try {
        if (fs.statSync(path.join(dir, '.rea')).isDirectory()) found.add(path.resolve(dir));
      } catch {
        /* skip */
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      // The `.rea/` marker dir itself never nests a project — skip it. But do
      // NOT blanket-skip every dot-directory (round-25 P2): a rea project under
      // a hidden parent like `.worktrees/` or `.claude/worktrees/` (the common
      // linked-worktree layout) must still be discovered. Heavy hidden trees
      // are pruned explicitly via SCAN_SKIP_DIRS.
      if (e.name === '.rea') continue;
      if (SCAN_SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  };

  for (const root of roots) walk(root, 0);
  return [...found];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHuman(dash: DashJson): void {
  const lines: string[] = [];
  const g = dash.groups;

  if (g.awaiting.length > 0) {
    lines.push('Awaiting ratification / parked blockers:');
    for (const i of g.awaiting) lines.push(`  ! [${i.project}] ${i.task_id}  ${i.subject}`);
    lines.push('');
  }
  if (g.review_queue.length > 0) {
    lines.push('Review queue (awaiting sign-off):');
    for (const i of g.review_queue) lines.push(`  ✓ [${i.project}] ${i.task_id}  ${i.subject}`);
    lines.push('');
  }
  if (g.in_flight.length > 0) {
    lines.push('In flight:');
    for (const i of g.in_flight) lines.push(`  → [${i.project}] ${i.task_id}  ${i.subject}`);
    lines.push('');
  }
  if (dash.hidden.length > 0) {
    lines.push('Hidden projects:');
    for (const h of dash.hidden) {
      lines.push(`  · [${h.project}] ${h.item_count} item${h.item_count === 1 ? '' : 's'}, hidden`);
    }
    lines.push('');
  }
  if (g.health_flags.length > 0) {
    lines.push('Health flags:');
    for (const h of g.health_flags) lines.push(`  ⚠ [${h.project}] ${h.detail}`);
    lines.push('');
  }
  if (dash.deregistered.length > 0) {
    lines.push('Deregistered (path present, .rea/ gone):');
    for (const d of dash.deregistered) lines.push(`  ? [${d.project}] ${d.project_path}`);
    lines.push('');
  }
  if (dash.missing.length > 0) {
    lines.push('Missing (registered path is gone — `rea dash --prune` to drop):');
    for (const m of dash.missing) lines.push(`  ✗ [${m.project}] ${m.project_path}`);
    lines.push('');
  }

  const attentionCount =
    g.awaiting.length +
    g.review_queue.length +
    g.in_flight.length +
    g.health_flags.length +
    dash.hidden.length +
    dash.missing.length +
    dash.deregistered.length;

  if (attentionCount === 0) {
    // Quiet system — a few calm lines.
    if (g.idle.length === 0) {
      log('No rea projects registered yet. Run `rea init` in a project, or `rea dash --rescan`.');
      return;
    }
    log(`All clear — ${g.idle.length} project${g.idle.length === 1 ? '' : 's'} idle:`);
    for (const p of g.idle) console.log(`  · ${p.project}`);
    return;
  }

  for (const line of lines) console.log(line);
  if (g.idle.length > 0) {
    console.log(`Idle / healthy (${g.idle.length}):`);
    for (const p of g.idle) console.log(`  · ${p.project}`);
  }
}

// ---------------------------------------------------------------------------
// Output dispatch
// ---------------------------------------------------------------------------

/**
 * Emit the built model in the requested mode. Precedence: `--emit-moc` (vault
 * MOC) > `--json` > terminal. Returns a process exit code (0 ok, 1 = a
 * write-target error under `--emit-moc <path>`). Writing the MOC is derived
 * output — it never touches any project's task store; only the caller's own
 * chosen path is written.
 */
function emitOutput(dash: DashJson, opts: DashOptions): number {
  if (opts.emitMoc === true) {
    const markdown = renderMoc(dash);
    if (opts.mocPath === undefined) {
      // Default: stdout, so it composes with shell redirection.
      process.stdout.write(markdown);
      return 0;
    }
    const target = path.resolve(opts.mocPath);
    const parent = path.dirname(target);
    try {
      if (!fs.statSync(parent).isDirectory()) {
        err(`--emit-moc target parent is not a directory: ${parent}`);
        return 1;
      }
    } catch {
      err(`--emit-moc target directory does not exist: ${parent}`);
      return 1;
    }
    try {
      fs.writeFileSync(target, markdown, 'utf8');
    } catch (e) {
      err(`failed to write MOC to ${target}: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
    log(`Wrote morning-view MOC to ${target}`);
    return 0;
  }
  if (opts.json === true) {
    process.stdout.write(JSON.stringify(dash, null, 2) + '\n');
    return 0;
  }
  renderHuman(dash);
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the dashboard. Returns a process exit code (0 = ok, 1 = dash-only
 * failure — never propagates to a gate). Synchronous work apart from the
 * optional registry writes (`--prune` / `--rescan`).
 */
export async function runDash(opts: DashOptions = {}): Promise<number> {
  const registryPath = opts.registryPath ?? defaultRegistryPath();
  const all = opts.all === true;

  // Per-repo mode — single project, registry not required.
  if (opts.path !== undefined) {
    // Round-9 P2: resolve to the checkout ROOT (git toplevel → nearest
    // .rea walk → verbatim) and canonicalize, so `rea dash .` from a
    // subdirectory (or a symlinked path) points at the project's real
    // root — otherwise the registry lookup misses and the project is
    // mis-reported as `deregistered`.
    const projectDir = canonicalizeProjectPath(resolveLocalRoot(path.resolve(opts.path)));
    let entry: ProjectEntry | undefined;
    try {
      entry = loadRegistry(registryPath).projects[projectDir];
    } catch {
      entry = undefined; // a corrupt global registry must not block per-repo view
    }
    let state: ReconcileState = 'present';
    try {
      if (!fs.statSync(projectDir).isDirectory()) state = 'missing';
      else if (!fs.existsSync(path.join(projectDir, '.rea'))) state = 'deregistered';
    } catch {
      state = 'missing';
    }
    const dash = buildJson([{ projectDir, entry, state }], 'repo', all);
    return emitOutput(dash, opts);
  }

  // Global mode.
  // Opt-in deep sweep: register any newly-discovered project first.
  if (opts.rescan === true) {
    const roots =
      opts.rescanRoots && opts.rescanRoots.length > 0
        ? opts.rescanRoots.map((r) => path.resolve(r))
        : defaultScanRoots(opts.scanRoots);
    const discovered = scanForProjects(roots);
    for (const dir of discovered) {
      try {
        // Round-8 P2: read the REAL version from the project's
        // install-manifest during the sweep instead of clobbering with
        // 'unknown' (registerProject additionally preserves an existing
        // recorded version when this resolves to 'unknown').
        const reaVersion = readProjectVersion(dir, undefined) ?? 'unknown';
        await registerProject(dir, { name: deriveProjectName(dir), reaVersion }, registryPath);
      } catch {
        /* best-effort — one bad project must not abort the sweep */
      }
    }
  }

  // Opt-in prune: drop vanished entries.
  if (opts.prune === true) {
    try {
      const pruned = await pruneMissing(registryPath);
      // stdout must carry ONLY data when it's being consumed as data — `--json`
      // OR `--emit-moc` streaming to stdout (no mocPath). Otherwise
      // `rea dash --emit-moc --prune > Morning.md` prepends a log line before the
      // MOC frontmatter (round-26 P2).
      const stdoutIsData =
        opts.json === true || (opts.emitMoc === true && opts.mocPath === undefined);
      if (!stdoutIsData && pruned.length > 0) {
        log(`Pruned ${pruned.length} missing project${pruned.length === 1 ? '' : 's'}.`);
      }
    } catch (e) {
      err(`prune failed: ${e instanceof Error ? e.message : String(e)}`);
      return 1;
    }
  }

  let reconciled;
  try {
    reconciled = reconcile(loadRegistry(registryPath));
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return 1;
  }

  const targets: ProjectTarget[] = reconciled.map((r) => ({
    projectDir: r.path,
    entry: r.entry,
    state: r.state,
  }));
  const dash = buildJson(targets, 'global', all);
  return emitOutput(dash, opts);
}

/** Default `--rescan` allowlist: `/Volumes/Development` + the user's home. */
function defaultScanRoots(injected?: string[]): string[] {
  if (injected && injected.length > 0) return injected;
  const roots = ['/Volumes/Development', os.homedir()];
  return roots.filter((r) => {
    try {
      return fs.statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
}

/** Register `rea dash [path]` on the root program. */
export function registerDashCommand(program: Command): void {
  program
    .command('dash [path]')
    .description(
      'Global, read-only "needs-you-first" dashboard across every rea-aware project. ' +
        'Pass a path (or `.`) for a single-project view.',
    )
    .option('--json', 'emit the stable machine schema instead of the rendered view')
    .option('--rescan [roots...]', 'deep filesystem sweep for .rea/ projects, then reconcile the registry')
    .option('--prune', 'drop registry entries whose path has vanished (a registry write)')
    .option('--all', 'reveal task titles for present projects marked dashboard_visible: false')
    .option(
      '--emit-moc [path]',
      'render the dashboard as an Obsidian vault MOC (markdown). No path → stdout; ' +
        'a path writes there (parent dir must exist). Overwrite-in-place, generated — do not hand-edit.',
    )
    .action(
      async (
        pathArg: string | undefined,
        cliOpts: {
          json?: boolean;
          rescan?: boolean | string[];
          prune?: boolean;
          all?: boolean;
          emitMoc?: boolean | string;
        },
      ) => {
        const rescan = cliOpts.rescan !== undefined && cliOpts.rescan !== false;
        const rescanRoots = Array.isArray(cliOpts.rescan) ? cliOpts.rescan : [];
        const emitMoc = cliOpts.emitMoc !== undefined && cliOpts.emitMoc !== false;
        const mocPath = typeof cliOpts.emitMoc === 'string' ? cliOpts.emitMoc : undefined;
        const code = await runDash({
          ...(pathArg !== undefined ? { path: pathArg } : {}),
          ...(cliOpts.json !== undefined ? { json: cliOpts.json } : {}),
          ...(rescan ? { rescan: true } : {}),
          ...(rescanRoots.length > 0 ? { rescanRoots } : {}),
          ...(cliOpts.prune !== undefined ? { prune: cliOpts.prune } : {}),
          ...(cliOpts.all !== undefined ? { all: cliOpts.all } : {}),
          ...(emitMoc ? { emitMoc: true } : {}),
          ...(mocPath !== undefined ? { mocPath } : {}),
        });
        if (code !== 0) process.exit(code);
      },
    );
}
