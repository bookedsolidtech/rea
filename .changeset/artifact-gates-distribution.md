---
'@bookedsolid/rea': minor
---

Artifact Gates distribution — the gates now actually enforce in installed repos.

- **G1 pre-commit wiring:** `rea init` and `rea upgrade` install `.husky/pre-commit`
  (via `installPreCommitHook`, mirroring pre-push idempotency + foreign-hook guard),
  so opting into `artifact_gates.g1_spec.mode` lays down the hook that runs
  `rea gate spec-check`. Previously the installer existed but was never invoked.
- **G2 Bash-tier gate:** new `verify-gate-bash-gate` hook closes the bypass where
  `echo x > .rea/tasks.jsonl` (or `tee`/`cp`/`mv`/`dd`/`sed -i`/nested-shell)
  skipped the editor-only G2 gate. It reuses the bash-scanner AST walker (no
  hand-rolled redirect parsing); under `g2_verify` shadow it logs
  `rea.gate.g2.shadow` (source: bash), under enforce it refuses (exit 2) and
  points to `rea tasks`, under off it is a byte-identical no-op. Registered as
  hook #19; dogfood `.claude/` + manifest synced; drift + byte-fidelity clean.
