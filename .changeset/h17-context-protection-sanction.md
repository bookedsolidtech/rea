---
'@bookedsolid/rea': minor
---

fix(hooks): H17 context-protection no longer blocks the delegation it mandates (bug H17)

The `context_protection.delegate_to_subagent` gate (H17 in
`dangerous-bash-interceptor`) told agents to "delegate to a subagent"
but the delegated subagent hit the exact same block — Claude Code fires
PreToolUse in every agent context and the hook had no reliable
"am I in a subagent?" signal, so the mandated remedy was impossible and
the field consequence was bypass-seeking (agents routed around the gate
via the raw binary). Two coupled fixes:

- **Sanctioned delegated-run marker (traversable path).** A
  delegate-listed command carried as `REA_DELEGATED_RUN=1 <cmd>` passes
  H17 **and is recorded on the hash-chained audit log**
  (`rea.context_protection` / `delegated_run_sanctioned`). The
  coordinator gate stays intact (a bare command is still blocked) while
  the delegated runner has a real, auditable path — the marker is a
  visible escape hatch (like `REA_SKIP_*`), detected from the command
  text because shell `export`s do not survive across separate Bash tool
  calls. An explicit `REA_DELEGATED_RUN` process-env value is also
  honored. The block copy now names this path instead of an impossible
  one.

- **Runner-equivalence normalization (closes the under-block leak).**
  The pre-fix matcher only caught the literal listed string, so
  `./node_modules/.bin/vitest run`, `node_modules/.bin/vitest run`,
  `pnpm exec vitest run`, `npx vitest run`, and whitespace variants all
  slipped through. Each policy pattern is now expanded into its
  runner-equivalent forms (pnpm / pnpm exec / npx / yarn / direct .bin
  path) before a head-anchored match. Expansion — rather than stripping
  the command to a bare token — deliberately avoids over-blocking: the
  `test` shell builtin and `pnpm test-utils` are unaffected by a
  `pnpm test` delegate entry.
