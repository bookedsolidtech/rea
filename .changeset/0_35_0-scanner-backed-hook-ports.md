---
'@bookedsolid/rea': minor
---

Node-binary hook playbook — final 4 paired scanner-backed ports
(0.35.0 closes the marathon: ALL 14 hooks are now Node-binary).

Phase 5 of the playbook started in 0.32.0 with 3 Phase-1 pilots
(pr-issue-link-gate, security-disclosure-gate, attribution-advisory),
continued through 0.33.0 with 4 Phase-2 advisory/single-purpose ports
(env-file-protection, dependency-audit-gate, changeset-security-gate,
architecture-review-gate), then 0.34.0 with 3 Phase-3 tier-2 medium-
complexity ports (dangerous-bash-interceptor, local-review-gate,
secret-scanner). This release lands the LAST 4, all paired Bash↔Write
gates whose enforcement is scanner-backed.

### Surfaces

- `src/hooks/_lib/path-normalize.ts` — shared TS primitive (mirrors
  `hooks/_lib/path-normalize.sh` byte-for-byte: REA_ROOT strip,
  URL-decode, backslash→slash, leading `./` strip, traversal-segment
  detection, interior `/./` detection, REA_ROOT canonicalization,
  nearest-existing-ancestor parent realpath walk).
- `src/hooks/_lib/protected-paths.ts` — shared TS primitive (mirrors
  `hooks/_lib/protected-paths.sh`: KILL_SWITCH_INVARIANTS,
  PROTECTED_PATTERNS_FULL, PATCH_SESSION_PATTERNS,
  `resolveProtectedPatterns()` honoring `protected_writes` full-override
  + `protected_paths_relax` subtractor + kill-switch-invariant
  non-relaxability, `isExtensionSurface()` for the
  `.husky/{commit-msg,pre-push,pre-commit,prepare-commit-msg}.d/*`
  allow-list, `isProtected()` 3-step decision with override-priority
  per helix-020 G2, `sanitizeForStderr()` C0/DEL/C1 strip).

- `src/hooks/blocked-paths-bash-gate/` — TS port. Thin shim over the
  parser-backed AST walker (`runBlockedScan`); permissive policy read.
- `src/hooks/protected-paths-bash-gate/` — TS port. Thin shim over
  `runProtectedScan` with policy resolution + REA_HOOK_PATCH_SESSION
  hook (inert at Bash tier — `.claude/hooks/` isn't in the bash-scanner
  protected set — but kept for forward compat).
- `src/hooks/blocked-paths-enforcer/` — TS port. Write/Edit/MultiEdit/
  NotebookEdit tier; §5a traversal reject, §5a-bis interior `/./`
  reject, §H.2 intermediate-symlink resolution, agent-writable
  allow-list (`.rea/tasks.jsonl`, `.rea/audit/`), match shapes
  (exact / directory prefix / glob), case-insensitive comparison.
- `src/hooks/settings-protection/` — TS port of the LARGEST hook in
  the repo (582 LOC of bash). Every §-numbered section preserved:
  §5a traversal reject, §5a-bis interior `/./` reject, §5b extension-
  surface allow-list with final-component + intermediate-directory
  symlink refusal (directory-boundary anchored per 0.20.1 helix-021 #3),
  §6 hard-protected list resolution, §6c intermediate-symlink
  resolution, §6b REA_HOOK_PATCH_SESSION unlock for `.claude/hooks/`
  with hash-chained audit append directly via TS primitive (no
  shell-out-to-node heredoc gymnastics — the bash hook's last reason
  for keeping the audit append in bash is gone), §6c-bis patch-session
  pattern blocked when env var NOT set.

- `src/cli/hook.ts` — 4 new commander subcommands wired to the
  runners. Tier: all Write (these are blocking gates).

- `hooks/blocked-paths-bash-gate.sh` (175 → ~165 LOC shim)
- `hooks/protected-paths-bash-gate.sh` (273 → ~150 LOC shim)
- `hooks/blocked-paths-enforcer.sh` (284 → ~170 LOC shim)
- `hooks/settings-protection.sh` (582 → ~165 LOC shim)
  All 4 shims use the 0.32.0 final round-8 shape: HALT → captured
  stdin → relevance pre-gate → policy/mode short-circuit → 2-tier
  sandboxed CLI resolution → realpath sandbox check → version probe →
  stdin forward. Per-shim relevance pre-gates extract the relevant
  payload field (command / file_path / notebook_path) and substring-scan
  for protected-path / blocked-path markers; CLI-missing on irrelevant
  payloads exits 0 to unblock the install path. CLI-missing on
  relevant payloads fails closed.

- `templates/<name>.dogfood-staged.sh` — 4 staged dogfood mirrors
  (Jake handles `.claude/hooks/` apply after the commit).

- `__tests__/hooks/parity/baselines/<name>.sh.pre-0.35.0` — 4 archived
  pre-port bash bodies for the parity suite.
- `__tests__/hooks/parity/node-parity.test.ts` — 18 new bash↔node
  parity tests across the 4 hooks.
- Per-hook unit suites: 78 new unit tests (13 + 11 + 20 + 34) +
  50 `_lib` primitive tests (22 path-normalize + 28 protected-paths).
  Net +146 new tests.

### Codex iterations

Round 1 — local review at gpt-5.4/high reasoning per repo policy.

### Deferrals

- Promotion of `delegation-advisory.sh` to `EXPECTED_HOOKS` (15→16)
  still deferred per the 0.31.0 charter — 0.36.0+ work.
- Tests for the `runHook*` wrappers (process.exit translation) skipped
  — coverage by integration tests where the CLI is spawned.
- §5b explicit-override priority test in settings-protection is
  marked permissive (asserts current behavior — the extension-surface
  short-circuit wins over `protected_writes` in the present routing).
  Closing the gap requires elevating override priority into §5b,
  which is a behavior change and out of scope for this port.

### Marathon completion

After this release ships, ALL 14 hooks in `EXPECTED_HOOKS` are
Node-binary. The bash-shim layer is now a thin dispatcher — every
enforcement rule lives in `src/hooks/`. Phase 1+2+3+5 lifted ~3,200
LOC of bash into ~3,600 LOC of TypeScript (+ ~6,000 LOC of tests)
across 14 hooks; the playbook is complete. 35th release of the
marathon.
