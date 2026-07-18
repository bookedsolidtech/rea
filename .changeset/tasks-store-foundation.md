---
'@bookedsolid/rea': minor
---

feat(tasks): `.rea/tasks.jsonl` task store + `rea tasks` CLI

The shared keystone for the Artifact Gates and `rea dash` features: a
local, deterministic, append-only JSONL task store at `.rea/tasks.jsonl`
(an already-governed, agent-writable path). Adds a strict zod
`TaskRecord` schema (id, subject, status, active, spec, requires_spec,
evidence, blocked_by, external_ref, timestamps), a synchronous store
library (`readTasks` folds to latest-record-per-id and tolerates
malformed lines; `appendTask` writes one line under a proper-lockfile
lock on `.rea/` with fsync, matching the audit store's discipline;
`activeTask`, `nextTaskId`), and a `rea tasks` CLI —
`add`/`start`/`activate`/`evidence`/`complete`/`list`/`show`.
`rea tasks complete` refuses when a task has no `evidence` (the G2
verification invariant at the CLI tier). Read-only for consumers; no
enforcement is wired yet.
