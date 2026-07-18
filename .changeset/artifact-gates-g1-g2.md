---
'@bookedsolid/rea': minor
---

feat(gates): Artifact Gates G1 (spec-gate) + G2 (verification-gate)

Two deterministic, model-judgment-free process gates that check a fresh
process artifact exists before something irreversible happens — the
push-review-gate pattern generalized. Both are shadow-first and
default-off (inert until a repo opts in via `policy.artifact_gates`),
and both FAIL INTO AN AUDIT ENTRY, never an interactive prompt (so
overnight autonomous runs survive `enforce`).

- **G2 verification-gate** (`rea hook verify-gate`, PreToolUse on
  Write/Edit to `.rea/tasks.jsonl`): refuses a write that transitions
  any task to `completed` with no `evidence`. off → silent; shadow →
  `rea.gate.g2.shadow` would-block audit, exit 0; enforce → `rea.gate.g2`
  deny, exit 2.
- **G1 spec-gate** (`rea gate spec-check`, commit-time): when the staged
  net diff exceeds `diff_lines`/`diff_files` OR the active task is
  `requires_spec`, the active task must reference a spec path that
  exists and is HEAD-committed. Below threshold → silent (the "just do
  it" branch). off/shadow/enforce as above (`rea.gate.g1[.shadow]`). A
  ready `.husky/pre-commit` installer ships (`installPreCommitHook`).

UNCERTAIN ≡ REFUSE at enforce only (git/tasks unreadable → refuse under
enforce, log+allow under shadow). Shadow audit tool names (`*.shadow`)
are excluded from every coverage accept-list.
