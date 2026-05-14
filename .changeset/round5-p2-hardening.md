---
'@bookedsolid/rea': patch
---

fix(0.30.1): round-5 P2 hardening sweep — settings strict schema, doctor hooks-dir resolution, control-char name guard

Closes three of the four CONCERNS-level P2 findings from 0.30.0's codex
round 5. All are localized hardening fixes; no behavior change for the
golden path.

1. **`rea doctor --strict` now uses `SettingsSchemaStrict`.** The strict
   schema shipped in 0.30.0 but `validateSettings()` never accepted a
   selector, so `rea doctor --strict` silently ran the lenient
   (`.passthrough()`) schema and never failed on unknown top-level keys.
   `validateSettings(input, { strict: true })` now selects the strict
   schema; `checkSettingsSchema` passes the flag through.

2. **Doctor `resolveHooksDirSync` resolves worktrees/submodules.** The
   prior implementation checked `core.hooksPath` then fell straight to
   the literal `.git/hooks`. In linked worktrees and submodules `.git`
   is a pointer FILE, not a directory, so the literal path is wrong.
   The resolver now consults `git rev-parse --git-path hooks` between
   the `core.hooksPath` check and the literal fallback — same
   resolution the installer already uses.

3. **`attribution.co_author.name` rejects control characters.** The
   `name` value is written verbatim into a single-line
   `Co-Authored-By:` git trailer. A newline or carriage return would
   split the trailer and could inject arbitrary extra trailer lines.
   The zod schema now rejects any ASCII control character (0x00–0x1F
   plus DEL) in `name`. Non-ASCII letters (accents, etc.) are still
   accepted.

The fourth round-5 P2 ("fail closed when co_author config fails policy
validation") was investigated and **intentionally not changed**. An
initial revision fail-closed when `rea hook policy-get` exited non-zero
with a code other than 127 — but codex review showed that regressed the
supported stale-CLI / pre-`pnpm i` flow: an old `rea` that predates
`hook policy-get` exits non-zero exactly like an unparseable policy, and
the two are indistinguishable by exit code. `rea hook policy-get` is a
raw YAML reader (it does not run the zod loader), so there is no
validation verdict to key off of. The realistic invalid-config case —
`enabled: true` with an empty `name` or `email` — is already caught by
the hook's downstream `[ -z "$CO_NAME" ]` defense-in-depth guard, which
exits 0 without augmenting regardless of which reader produced the
values. The hook comment block documents this reasoning.

12 new tests across `__tests__/config/settings-schema.test.ts`,
`__tests__/policy/attribution-co-author.test.ts`,
`__tests__/integration/prepare-commit-msg-augmenter.test.ts` (including
a regression test that a stale `rea` CLI still augments via the python3
fallback), and `src/cli/doctor.test.ts`.
