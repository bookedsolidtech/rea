---
'@bookedsolid/rea': minor
---

# 0.30.0 — attribution augmenter, Class M settings.json schema, 0.29.0 drift closure

## A — Attribution augmenter (`prepare-commit-msg`)

New husky `prepare-commit-msg` hook that appends a configurable
`Co-Authored-By: <name> <email>` trailer to every commit (or every
non-merge commit when `skip_merge: true`). Intended for contributors
whose enterprise git identity differs from their personal GitHub
identity — the trailer lets them roll their work onto their personal
contribution heatmap.

Configuration lives in `.rea/policy.yaml`:

```yaml
attribution:
  co_author:
    enabled: true
    name: 'Real Name'
    email: 'you@example.com'
    skip_merge: false
```

The augmenter ships disabled in every profile (`enabled: false`) — the
identity to roll commits onto is per-developer, so opt-in lives in
repo-local edits.

Surface:

- New husky body `.husky/prepare-commit-msg` (marker `# rea:prepare-commit-msg v1`).
- New policy schema `attribution.co_author.*` with cross-field zod
  refinement: `enabled: true` requires non-empty `name` AND `email`
  (fail-closed at policy load, not at hook fire time).
- Permissive email validation: `<local>@<host>.<tld>` shape.
- Idempotency: scans the message for a `Co-Authored-By:` line whose
  email matches (case-insensitive, line-anchored). Same email different
  name → leave alone (respect manual trailer authorship).
- Skip conditions: `REA_SKIP_ATTRIBUTION=1`, `.rea/HALT` present,
  missing message file, `enabled !== true`.
- Coexistence: `commit-msg`/`attribution-advisory.sh` still block AI
  noreply emails and AI assistant names. A human trailer
  `Co-Authored-By: Real Name <real@email.tld>` matches neither and is
  not blocked.
- New `rea init` / `rea upgrade` flow: installs the hook to
  `.git/hooks/prepare-commit-msg` AND `.husky/prepare-commit-msg`
  (when `.husky/` exists). Refuses to overwrite foreign hooks (matches
  the 0.13.2 pre-push prior art); `rea doctor` surfaces the conflict.
- New `rea doctor` check `prepare-commit-msg hook (attribution
  augmenter)` covering enabled/disabled × present/foreign matrix.

## B — Class M `.claude/settings.json` zod schema

Consumer-side validation for the Claude Code harness settings file.

- New `src/config/settings-schema.ts` exporting `SettingsSchema`,
  `HookEntrySchema`, `HookCommandSchema`, `validateSettings`,
  `validateNoTraversal`, `findMissingReaHooks`, `expectedHookNames`.
- Strict zod: unknown top-level keys, unknown hook event names,
  malformed hook entries (empty matcher, missing `type: "command"`,
  timeout > 600_000 ms ceiling) all fail closed.
- Path-traversal check outside the schema: `..` segments in any
  `command` value (after stripping `$CLAUDE_PROJECT_DIR`) flagged.
- `EXPECTED_HOOKS` and `defaultDesiredHooks()` now exported so the
  schema cross-checks every rea-shipped hook against the consumer's
  registrations.
- `rea doctor` default mode: warn on schema failure / traversal /
  missing rea hook.
- `rea doctor --strict` (new flag): hard fail on the same conditions.
  Use in CI gates.
- `rea upgrade`: validates the merged settings via non-strict schema
  BEFORE writing. Refuses the write (leaves consumer settings
  untouched) if the merged output would fail parse — same idempotency
  contract as 0.21.1.

## C — 0.29.0 drift closure

The 0.29.0 release added `delegation-capture.sh` to `EXPECTED_HOOKS`
(doctor.ts) but never registered the `Agent|Skill` matcher in this
repo's own `.claude/settings.json`. The dogfood install was stale —
this repo wasn't actually dogfooding delegation telemetry on itself.

This release adds the matcher to the canonical settings file. The
Class M schema's `findMissingReaHooks` test pin asserts the canonical
settings cleanly validates with zero missing rea hooks; rolling back
the `Agent|Skill` matcher would trip the regression pin on day one.

## Deferred to 0.31.0

- Node-binary port of 3 advisory hooks (`pr-issue-link-gate`,
  `security-disclosure-gate`, `attribution-advisory`)
- 4 shared TS primitives extraction (`halt-check.ts`, `segments.ts`,
  `payload.ts`, payload schema)
- Class G dist/package byte-fidelity test
- `.husky/prepare-commit-msg.d/*` extension surface (chained-fragment
  parity with commit-msg.d/pre-push.d)
- Audit-record schema migration safety (`timestamp >= installed_at`)

## Codex rounds

(local-first codex review pending — performed before push per the CTO
directive).
