---
'@bookedsolid/rea': minor
---

Wave 3 specialist agents + figma-dx-specialist + helix-031 shellcheck fix + codex-review invocation pattern.

Roster expansion 17 → 23. Adds five new specialists per the 2026-05-04 CTO
roster-eval — `ast-parser-specialist` (mvdan-sh grammar + AST-walker
patterns), `shell-scripting-specialist` (POSIX + bash 3.2 hook bodies, awk
portability), `adversarial-test-specialist` (bypass corpus + sibling-class
sweep), `mcp-protocol-specialist` (MCP server/client mechanics + matcher
semantics), `observability-specialist` (audit-log shape + SLSA provenance).
Also ships `figma-dx-specialist`, the upstream-of-engineering platform
expert for Figma's coding surfaces (Dev Mode, Code Connect, plugin/REST
APIs, Variables, DTCG export, Figma-as-MCP) — primary consumer is
`create-helix-app`'s Astro design-system scaffolds.

Wires the new agents into the `rea-orchestrator` routing brief, the
project CLAUDE.md delegation block, and the README.md curated-agents
table. Updates roster-count language across all three from 17 to 23.

Closes helix-031: shellcheck SC1078 false-positives in
`hooks/_lib/cmd-segments.sh` at the three awk-program regions whose
`'\''` escape patterns embed literal apostrophes (mvdan-sh quote-mask,
NUL-region stdin, ANSI-C mode-3 from helix-024 round-24 / helix-028).
Adds targeted `# shellcheck disable=SC1078` directives with rationale
inline; functional behavior unchanged. Unblocks consumer pre-push gates
that include rea-managed `.sh` files in their shellcheck sweep.

Plus: codex-review invocation pattern codified — `rea hook codex-review`
CLI added (thin Bash-direct invocation that tees raw JSONL to
`$TMPDIR/rea-codex-<sha>-<nonce>.json`, writes a `codex.review` audit
entry, exits 0/1/2 on pass/concerns/blocking with iron-gate model
defaults). `codex-adversarial` agent rewritten as a thin shim that
delegates to the new CLI and surfaces verdict + count + raw-path only —
no paraphrased findings, no interpretation. `/codex-review` slash
command documents the direct path as canonical with `--verbose` as the
opt-in wrapper-agent escape hatch. Closes the wrapper-Claude
3x-Opus-burn class for marathon-mode iteration cycles per the
2026-05-05 user directive ("the codex JSON IS the review"). New seam
in `runCodexReview` (`rawStdoutSink` callback) enables the tee without
duplicating spawn logic.
