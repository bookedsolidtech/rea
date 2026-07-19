# Moving to the global `rea` CLI and keeping `.rea/` clean

This guide covers two related operator tasks that a `MIGRATING.md` reader
eventually hits:

1. **Switching from a project-local `@bookedsolid/rea` dependency to the
   per-user global `rea` CLI** — so a checkout is governed without carrying
   rea in its `package.json` / lockfile.
2. **`.rea/` hygiene** — which files rea writes are ephemeral runtime state
   that belongs in `.gitignore`, and which are durable governance config you
   commit.

It also answers the question that follows from both: *should I ever commit
`.rea/` to move state between machines?* (Short answer: almost never — and
this doc explains exactly what breaks if you do.)

This is a companion to [`MIGRATING.md`](./MIGRATING.md). That doc covers the
package rename (`@bookedsolid/reagent` → `@bookedsolid/rea`) and integrating
rea alongside prior husky tooling. This doc is strictly the local→global CLI
move and `.rea/` file hygiene — it does not repeat the rename steps.

---

## TL;DR

- **Global-first is the default install model (0.53.0).** `rea init` and
  `rea upgrade` no longer add `@bookedsolid/rea` to your `package.json`. A fresh
  `rea init` (without `--pin`) leaves the checkout dependency-free and lets the
  per-user global rea CLI tier govern it. You still install the global CLI once
  per-user (`rea install --global`) and `rea trust` the checkout — global-first
  changes only the *pin default*, not how the global tier is enabled.
- `--pin` is the explicit opt-in for a **hermetic local install**: it adds
  `@bookedsolid/rea` to `devDependencies` (the pre-0.53.0 behavior) so every
  clone resolves the CLI from `node_modules/` with no per-user global install.
- **In-project resolution still wins.** When a local install *is* present
  (`node_modules/@bookedsolid/rea` or `./dist/cli/index.js`), rea uses it and
  never consults the global tier. The global CLI resolution ladder (added in
  0.50.0) is unchanged.
- **Already have a pinned project?** Run `rea migrate --to-global` to strip the
  local dep, then your package manager's install to prune `node_modules`. `rea
  doctor` now flags a lingering local dep with the same recommendation.
- **`.rea/` is a mix of committed config and gitignored runtime state.** rea
  scaffolds a managed `.gitignore` block on `rea init` / `rea upgrade`. Only
  `.rea/policy.yaml` and `.rea/registry.yaml` (plus `.rea/install-manifest.json`)
  are meant to be committed; everything rea writes at runtime is ignored.
- **Do not commit `.rea/` to sync state across machines.** It carries a
  per-repository hash-chained audit log, machine-specific TOFU trust anchors,
  and the kill switch — committing any of those conflicts, leaks, or freezes
  every clone.

---

## Part 1 — Migrating from a project-local install to the global CLI

### What changes, and why

As of 0.53.0, **global-first is the default install model.** `rea init` and
`rea upgrade` no longer add `@bookedsolid/rea` to a project's `package.json` —
a fresh `rea init` (without `--pin`) leaves the checkout dependency-free and
lets the per-user global rea CLI tier govern it. The global CLI is installed
once per-user, outside any checkout, and each checkout you want governed is
explicitly "blessed" into a per-user trust registry.

A **project-local install** — `@bookedsolid/rea` in the repo's
`devDependencies`, resolving the CLI at
`node_modules/@bookedsolid/rea/dist/cli/index.js` — is now the opt-in path.
Pass `--pin` to `rea init` / `rea upgrade` when a team explicitly wants a
hermetic local install: the dependency lives in the shared manifest and every
clone resolves the CLI from `node_modules/` without needing a per-user global
install. Everything else in this guide applies to both models; where it
matters, the difference is called out.

### How rea resolves *which* CLI runs

Every hook shim resolves the CLI through a fixed, sandboxed ladder
(`hooks/_lib/shim-runtime.sh`). `PATH` is **intentionally never consulted** —
an agent-controlled `$PATH` could otherwise substitute a forged `rea` binary
for every gate. In order:

1. **In-project, active worktree** — `node_modules/@bookedsolid/rea/dist/cli/index.js`,
   then `dist/cli/index.js`, resolved from the enforcement root the session
   actually works in.
2. **In-project, primary checkout** — the same two shapes at
   `CLAUDE_PROJECT_DIR`, then at the repository's common root (for linked
   worktrees that don't carry their own `node_modules`/`dist`).
3. **Global tier** — consulted **only** when every in-project tier misses.

The invariant to internalize: **in-project always wins.** If any in-project
tier resolves a CLI, the global registry is never even read. This is why the
first migration step is to *remove the local dependency* — otherwise the
global CLI you install will simply never be reached.

### Trust posture: in-project vs global

The two tiers are not equivalent in trust, and the difference is deliberate:

- **In-project CLI** is sandbox-checked before it runs: its realpath must live
  inside the project directory, an ancestor `package.json` must declare
  `name: "@bookedsolid/rea"`, and (for the security-load-bearing gates) the
  realpath must end in `dist/cli/index.js`. Containment is anchored by the
  project directory itself.
- **Global CLI** lives *outside* any checkout (`<home>/.rea/cli`), so it
  cannot rely on project containment. It runs a **stricter** sandbox instead:
  a per-component `lstat` walk from the CLI up to `<home>/.rea` that rejects
  any symlink component, any foreign owner, any group/other-writable
  component, any device-number change, and requires the CLI and its
  `package.json` to be single-link files — plus an always-on
  `dist/cli/index.js` shape check. Its integrity therefore rests on
  **filesystem ownership of `<home>/.rea`**. `rea doctor` states this directly
  as a residual-risk line and recommends an in-project install for shared or
  CI checkouts.

Two consent gates bound the global tier:

- **Registry membership (enable-only).** A checkout is governed by the global
  CLI only if its realpath is listed in the per-user registry
  `<home>/.rea/trusted-projects` (a `0600`, owner-only file; the home
  directory is derived from the password database, never from `$HOME` /
  `$XDG_*`). The registry can only ever *enable* the tier.
- **Policy veto (restrict-only).** The checkout's own
  `.rea/policy.yaml` can set `runtime.allow_global_cli: false` to forbid the
  global tier even for a blessed checkout. This veto is read *after* the
  sandbox passes, through the validated CLI, and fails closed on any malformed
  policy shape.

The asymmetry is the whole design: the registry (human-established) can only
enable; a project's own policy can only further-restrict. Nothing an agent can
edit in-repo can *grant* the global tier authority it was not blessed with.

### Migrating an existing pinned project: `rea migrate --to-global`

If your checkout already carries a local `@bookedsolid/rea` dep — you installed
before 0.53.0, or you ran `rea init --pin` — `rea migrate --to-global` performs
the assisted removal:

```bash
rea migrate --to-global
# preview first with:  rea migrate --to-global --dry-run
```

Grounded in the command's behavior:

- It strips `@bookedsolid/rea` from **both** `dependencies` and
  `devDependencies` with a byte-minimal edit that preserves your existing key
  order, and drops a dep block entirely if rea was its only entry.
- **Idempotent and dogfood-safe.** A checkout with no local dep reports
  "already global-first — nothing to do"; a repo whose own `package.json` is
  named `@bookedsolid/rea` (rea dogfooding itself) is never touched.
- It edits **only `package.json`** — it never mutates `node_modules` or the
  lockfile directly. Instead it prints the prune follow-up for your detected
  package manager, which you must run so the local copy is actually gone:

  ```bash
  pnpm install     # or: npm install / yarn install
  ```

  It then reminds you to verify with `rea doctor` (which should report the
  global tier as the active resolver and no longer flag a local install) and,
  from a plain shell outside any agent session, to `rea trust` the checkout.

`rea doctor` surfaces the same recommendation on its own: a checkout that still
declares a local dep reports a non-fatal **`warn`** pointing at `rea migrate
--to-global` (see [Part 4](#part-4--verifying-with-rea-doctor)).

### `rea upgrade` under global-first

`rea upgrade` (0.53.0+) is **prompt-free by default.** It applies every
rea-managed change non-interactively — new files are written, unmodified files
are auto-updated, and files rea no longer ships are deleted. A file you have
hand-edited ("drifted" from the canonical version) is **reported and kept**,
never silently clobbered.

- `--interactive` restores the pre-0.53.0 per-file keep / overwrite / diff
  prompts for drifted and removed-upstream files (and the post-upgrade offer to
  strip a local dep).
- `--dry-run` previews everything and writes nothing (drift is shown as *kept*).
- `--force` overwrites drifted files and deletes removed-upstream entries with
  no prompt.
- `rea upgrade` does **not** self-pin by default; pass `--pin` for a hermetic
  local install. If a local dep is present and you did not pass `--pin`, the
  upgrade leaves your deps untouched and recommends `rea migrate --to-global`.

### Step-by-step

All commands below are copy-pasteable. Substitute your package manager as
needed.

**1. Remove the project-local dependency.**

The assisted path is `rea migrate --to-global` (see the previous section); it
strips the dep from `package.json` and prints the prune follow-up. Or do it by
hand:

```bash
npm uninstall @bookedsolid/rea
# or: pnpm remove @bookedsolid/rea
# or: yarn remove @bookedsolid/rea
```

Either way, run your package manager's install afterward so
`node_modules/@bookedsolid/rea` and the lockfile entry are gone and the
in-project tier no longer resolves. If a fresh `rea init` created the checkout
on 0.53.0+, there is no local dep to remove — skip to step 2.

**2. Install the global CLI once, per-user, from OUTSIDE any checkout.**

The installer refuses to place the CLI inside a git checkout (it would become
a committable artifact):

```bash
cd ~                    # anywhere outside a repo
rea install --global    # real npm install into <home>/.rea/cli
```

`rea install --global` accepts `--version <semver>` to pin a specific release
and `--force` to reinstall. It refuses to run under a governed agent session
(when `CLAUDE_PROJECT_DIR` is set) — blessing your machine is a human action.

**3. Trust the checkout, from a plain shell.**

```bash
cd /path/to/repo
rea trust               # bless the current checkout
# or, combined with step 2: rea install --global --trust .
```

`rea trust` (and `rea untrust`) likewise refuse under a governed agent
session. `rea trust --list` prints the current registry; `rea untrust`
removes a checkout.

**4. Verify.**

```bash
rea doctor
```

See [Part 4](#part-4--verifying-with-rea-doctor) for the exact rows to read.

> **Note on committing `.claude/` under global-first.** Whether you track
> `.claude/` (agents, commands, hooks, `settings.json`) or keep it gitignored
> is entirely the project's call — global-first supports both, and the same is
> true of the committed `.rea/` config files (see [Part 2](#part-2--rea-hygiene-what-to-gitignore-vs-keep)).
> Keep `.claude/` gitignored when rea governs only *your* clone and should
> leave no trace in the shared tree. **Track it** when the whole team runs rea:
> under global-first the committed hooks carry no `package.json` dependency, and
> each teammate's own per-user global CLI supplies the binary (so every
> teammate still runs `rea install --global` + `rea trust` once). `rea doctor`
> treats tracked hooks with no local pin as a healthy `pass`
> (see [Part 4](#part-4--verifying-with-rea-doctor)) — the pre-0.53.0 "tracked
> hooks need a pin" brick state no longer applies.

---

## Part 2 — `.rea/` hygiene: what to gitignore vs keep

On `rea init` / `rea upgrade`, rea scaffolds a **managed block** in your
repo's `.gitignore` (delimited by `# === rea managed …` markers). The block
is idempotent and reconciled on upgrade: rea backfills newly-added entries but
preserves any lines you add inside the block. Deleting a canonical entry is
*not* preserved — rea re-inserts it on the next run, because the ignore set is
rea's territory. To stop ignoring an artifact, configure rea rather than
editing the block.

The authoritative ignore set is `REA_GITIGNORE_ENTRIES` in
`src/cli/install/gitignore.ts`. Everything in it is **local, mutable runtime
state** that would otherwise dirty your working tree the moment the gateway,
a hook, or a review runs.

### Ignored — runtime state (from `REA_GITIGNORE_ENTRIES`)

| Entry | What it is | Why ignored |
| --- | --- | --- |
| `.rea/audit.jsonl` | Hash-chained, append-only audit log | Per-machine forensic record; grows on every tool call |
| `.rea/audit-*.jsonl` | Rotated audit archives | Same; rotation output |
| `.rea/HALT` | Kill-switch marker (`rea freeze` writes it) | Ephemeral emergency-stop signal, not config |
| `.rea/metrics.jsonl` | Metrics stream | Per-run telemetry |
| `.rea/serve.pid` | `rea serve` pidfile | Process-local; meaningless off-host |
| `.rea/serve.state.json` | `rea serve` live-state snapshot | Runtime state, rewritten continuously |
| `.rea/fingerprints.json` | TOFU downstream-catalog fingerprints | Machine-specific trust anchors (see Part 3) |
| `.rea/last-review.json` | Push-gate's last Codex review dump | Per-run forensic snapshot |
| `.rea/tasks.jsonl` | `rea tasks` tracker store | Intended to stay per-checkout |
| `.rea/tasks.jsonl.lock` | Lock sidecar for the tracker | Transient lock |
| `.rea/turn-count.json`, `.rea/turn-count.*.json` | Per-session turn counters (spend governance) | Per-session runtime state |
| `.rea/turn-count*.lock` | Lock sidecars for the counters | Transient locks |
| `.rea/review-parity.json` | Side-by-side review parity report | Written on every run when parity is enabled |
| `.rea/parity-dataset/` | Per-commit parity research dataset | Local research output |
| `.rea/*.tmp`, `.rea/*.tmp.*` | Temp-file-then-rename sidecars | Atomic-write staging |
| `.rea/install-manifest.json.bak`, `.rea/install-manifest.json.tmp` | Atomic-replace sidecars for the install manifest | Staging artifacts |
| `.gitignore.rea-tmp-*` | This module's own crash-time temp files (repo root, **not** under `.rea/`) | Staging artifacts |
| `.rea.lock` | `proper-lockfile` sibling lock dir (**not** under `.rea/`) | Transient lock for the audit chain / cache |

Two of these deliberately live **outside** `.rea/`: `.gitignore.rea-tmp-*`
(staged next to `.gitignore` at the repo root) and `.rea.lock` (a sibling
directory `proper-lockfile` uses to lock `.rea/`). Both are correct as written
in the source; don't "fix" them to a `.rea/`-relative path.

### Kept — durable governance config (NOT in the ignore set)

These files are **absent** from `REA_GITIGNORE_ENTRIES`, which means rea
intends them to be tracked and committed:

| File | What it is | Why committed |
| --- | --- | --- |
| `.rea/policy.yaml` | The governance policy — autonomy level, blocked paths, `block_ai_attribution`, review config, etc. | The whole point of rea; versioned **with the branch** so policy travels with the code it governs |
| `.rea/registry.yaml` | Declared MCP servers (the per-project server registry) | Project config; the schema the TOFU fingerprints are computed against |
| `.rea/install-manifest.json` | Record of what `rea init`/`rea upgrade` laid down (only its `.bak`/`.tmp` sidecars are ignored) | Tracks the install for drift/upgrade; the file itself is not in the ignore set |

The rule of thumb, stated by the audit/worktree model directly: **enforcement
and forensic state is local; declared configuration is committed.**
`policy.yaml` is explicitly per-branch — checking it in is what lets a policy
change ride the same PR as the code it constrains.

> Note: `.rea/policy.yaml` and `.rea/registry.yaml` are also protected against
> agent edits by rea's own hooks — that protection is independent of git and
> unrelated to whether they are tracked.

---

## Part 3 — Should a (private) project commit `.rea/` to move state between machines?

Occasionally an operator wants to transfer rea state to another machine (a
second workstation, a CI runner) by committing `.rea/` wholesale. It is worth
being honest about the one legitimate pull and the several concrete risks.

### The legitimate use case (and why you probably don't need it)

The only durable things you'd want on another machine are the **config** files
— `policy.yaml`, `registry.yaml`, `install-manifest.json` — and those are
**already committed by default** (they're not in the ignore set). So the
config already travels through git without committing anything currently
ignored. There is no config you need to un-ignore to govern the same repo on a
second machine; `rea init` / `rea upgrade` on the other machine regenerates
all runtime state locally.

### The risks of committing the ignored runtime state

Each risk below is grounded in rea's state model
([`THREAT_MODEL.md`](./THREAT_MODEL.md) §10, §5.7, §5.20):

- **`audit.jsonl` — a single per-repository hash chain that will fork and
  conflict.** The audit log is one SHA-256 hash chain per repository (in a
  worktree setup it lives in the primary checkout's `.rea/`). Each record
  embeds the previous record's hash; deleting or modifying any record breaks
  the chain and is *designed* to be detectable as tampering. Commit it and two
  machines each append to their own copy — the histories diverge, a merge
  produces a chain that fails `rea audit verify`, and there is no meaningful
  way to merge two hash chains (the threat model calls out that no
  auto-migration exists precisely because merging chains isn't possible). You
  also leak every local tool call, path, and actor identity into shared git
  history permanently.

- **`HALT` — commit it and you freeze everyone who pulls.** `.rea/HALT` is the
  kill switch: while it exists, every middleware and hook refuses all governed
  tool calls until an explicit `rea unfreeze`. It is one kill switch per
  repository. If it's committed, every clone that pulls the commit is frozen —
  a self-inflicted denial of service across the team, clearable only by each
  puller (or a follow-up commit removing it).

- **`fingerprints.json` — machine-specific TOFU trust anchors.** On first
  connect, rea records a fingerprint of each MCP server's canonicalized config
  and refuses to route to a downstream whose fingerprint later drifts (a hard
  fail). These are Trust-On-First-Use anchors established on *this* machine.
  Commit them and another machine either imports a trust decision its operator
  never made, or trips a drift hard-fail against its own legitimately-different
  environment. Re-pinning is a local action (clear the file); it is not
  something to carry in history.

- **Machine-local process state is meaningless off-host.** `serve.pid` /
  `serve.state.json` describe a process on the machine that wrote them; a pid
  from another host is at best noise. Lock sidecars (`.rea.lock`,
  `tasks.jsonl.lock`, `turn-count*.lock`) committed from one machine can leave
  another machine contending with a stale lock. `metrics.jsonl`,
  `last-review.json`, `review-parity.json`, and the turn counters are per-run
  forensic/telemetry snapshots with no cross-machine meaning.

The balanced read: committing `.rea/` buys you nothing the default-committed
config files don't already give you, and it risks a forked audit chain, a
leaked forensic log, imported-or-broken TOFU trust, and — with `HALT` — a
frozen team. Keep the ignore block intact; let each machine regenerate its own
runtime state.

---

## Part 4 — Verifying with `rea doctor`

Run `rea doctor` from inside the checkout after any of the above. For the
global-tier migration, three rows matter:

```text
[pass] global rea CLI installed        v<version> at <home>/.rea/cli/node_modules/@bookedsolid/rea/dist/cli/index.js
[pass] global rea CLI active tier      global — this checkout is trusted (in the global-CLI trust registry <home>/.rea/trusted-projects); hooks run <realpath>
[info] global rea CLI residual risk    integrity relies on filesystem ownership of <home>/.rea; prefer in-project install for shared or CI checkouts
```

Reading them:

- If the active-tier row is a **`warn`**, the checkout is not blessed yet — the
  hooks fail closed here until you `rea trust` it.
- If an in-project `rea` still resolves, the active tier reports
  **`in-project`** (global present, unused) — the in-project tier always wins,
  so re-check that you actually removed the local dependency in step 1.
- If the checkout's policy sets `runtime.allow_global_cli: false`, doctor
  reports the veto rather than an active global tier.

One more row, the **`rea CLI resolution model (global-first)`** check, reports
the install posture directly:

- **`pass` — no local `@bookedsolid/rea` pin.** The global-first default; the
  global tier governs (the rows above show the active resolver).
- **`warn` — local install detected** (`dependencies` / `devDependencies` set
  to a version range). Non-fatal; it recommends `rea migrate --to-global` to
  strip the dep. A pinned checkout is still fully governed — the warn is a
  nudge toward the default model, not an error.

This inverts the pre-0.53.0 behavior, where a *missing* pin failed as a
"brick state." Under global-first, a missing local pin is the healthy state;
whether a CLI actually resolves is the global-tier rows' job, not this row's.

`rea doctor` is also the verification step for `.rea/` hygiene generally — it
surfaces policy/registry parse status, hook install state, and (for the
trust registry) the distinction between `<home>/.rea/trusted-projects` (the
global-CLI allow-list) and `.rea/registry.yaml` (the per-project MCP TOFU
store), which are unrelated files.

---

## Part 5 — Troubleshooting

**`rea doctor` reports `[warn] global rea CLI active tier … not trusted`.**
The checkout isn't in the registry. From a plain shell (not a governed agent
session), run `rea trust` in the checkout. Confirm with `rea trust --list`.

**Global CLI installed but doctor shows the active tier as `in-project`.**
An in-project CLI still resolves, so the global tier is never consulted.
Confirm `@bookedsolid/rea` is gone from `package.json` and that
`node_modules/@bookedsolid/rea` and `./dist/cli/index.js` are both absent.

**`rea install --global` or `rea trust` refuses with a "governed agent
session" message.** These are human-only actions and refuse when
`CLAUDE_PROJECT_DIR` is set. Run them from a plain terminal, not from inside
an agent session.

**`rea doctor` reports `[warn] rea CLI resolution model (global-first) … local
@bookedsolid/rea install detected`.** Expected when a checkout still carries a
local dep — this is the migrate nudge, not an error. Run `rea migrate
--to-global` (then your package manager's install) to adopt the default, or
keep the local dep deliberately if you want a hermetic install. Under 0.53.0
the inverse — no local pin — is a **`pass`**: global-first no longer treats a
missing dep as a brick state (the pre-0.53.0 detector failed on exactly that
case). The real "no CLI resolves at all" case is caught by the global-tier
rows, not this one.

**`fingerprints.json` shows up as untracked after starting `rea serve`.**
Your `.gitignore` predates the managed block. Run `rea upgrade` (or `rea init`)
— it backfills missing entries into the managed block without disturbing your
own lines.

**A committed `.rea/HALT` froze a clone.** Remove the file and run
`rea unfreeze`, then ensure `.rea/HALT` is inside your `.gitignore` managed
block (it is by default) and that the freeze wasn't committed from another
machine.

---

## See also

- [`MIGRATING.md`](./MIGRATING.md) — package rename (`reagent` → `rea`) and
  integrating rea with prior husky tooling.
- [`README.md`](./README.md) — the "Global install" section for the
  shared-repo scenario and the full CLI reference.
- [`THREAT_MODEL.md`](./THREAT_MODEL.md) — §10 (worktree state topology),
  §5.7 (HALT semantics), §5.20 (registry TOFU pinning), and the audit
  hash-chain guarantees.
