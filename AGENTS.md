# AGENTS.md — canonical agent onboarding for `@bookedsolid/rea`

This file is the entry point for agents (autonomous or human-driven) working
in a repository that has `@bookedsolid/rea` installed. It answers the five
questions every agent needs to answer BEFORE touching anything:

1. What safety layer is running?
2. What am I allowed to do right now?
3. How do I push code without getting blocked?
4. What do I do when a hook refuses me?
5. Where do I look when something goes wrong?

---

## 1. Read these first — every session

### `.rea/policy.yaml`

Current autonomy level, max ceiling, blocked paths, and attribution policy.
Read on every session start. Do not attempt operations above the current
`autonomy_level`. Do not write to any path in `blocked_paths`.

### `.rea/HALT` (if it exists)

A present `.rea/HALT` means the session is **frozen**. The middleware chain
and every hook will refuse to proceed. Do not try to work around it — read
the reason in the file and report to the operator.

### `CLAUDE.md`

Project-level rules. The non-negotiable list at the top is enforced by
hooks and cannot be overridden by any agent instruction.

---

## 2. Know your autonomy level

| Level | Typical permission |
| ----- | ------------------ |
| L0    | Read-only. `rea check`, `rea status`, `rea doctor`, read files. |
| L1    | Read + write. Edit code. Run `rea cache set`, `rea audit record codex-review`. |
| L2    | Read + write + privileged mutations (scoped per-project). |
| L3    | All tiers. Destructive operations like `rea freeze` allowed. |

REA's own CLI is classified per-subcommand (Defect E / rea#78): `rea cache
check`, `rea audit record codex-review`, `rea doctor`, and `rea status` are
all **Read** tier and are allowed at every autonomy level, including L0.
The push-review gate's remediation steps intentionally stay within L1
permissions.

---

## 3. The push workflow — the one path that actually works

When `git push` is blocked by `push-review-gate.sh` you'll see one of:

- **"REVIEW REQUIRED"** — no Codex audit for this diff yet.
- **"CACHE CHECK FAILED"** on stderr — the CLI errored; check the diagnostic
  that follows (Defect F surfaces this instead of silently treating it as
  a miss).

Either way, the canonical one-command remediation is:

```bash
rea audit record codex-review \
  --head-sha "$(git rev-parse HEAD)" \
  --branch   "$(git rev-parse --abbrev-ref HEAD)" \
  --target   main \
  --verdict  pass \
  --finding-count 0 \
  --summary  "no findings" \
  --also-set-cache
```

`--also-set-cache` writes the audit record AND the review-cache entry in one
invocation (two sequential writes in-process — not a two-phase commit, but
tight enough that crash windows are vanishingly small in practice). Without
it, the audit record lands but the cache stays cold — the next `git push`
pays for a re-review even though the audit trail already shows the review
happened.

The command is Read-tier. It works at L1 without further escalation. Do not
wrap it in `!`-bash; that dodges the audit surface and breaks the gate's
trust model.

For the full SDK alternative (when embedding in a TypeScript tool), see the
README's "Agent push workflow" section.

---

## 4. When a hook blocks you

### Tier mismatch (`Autonomy level L1 does not allow destructive-tier tools`)

The operation requires a higher autonomy level than you have. DO NOT attempt
to escalate silently. Tell the operator what you were trying and why.

If the message shows `Bash (<subcommand>)`, the subcommand is the actionable
signal — not "Bash". (Defect E improved the deny message so operators can
see which Bash call tripped the gate.)

### Blocked path

The file is in `blocked_paths` or is a protected default (`.rea/`,
`.husky/`, etc.). Ask the operator — they either update policy or edit the
file themselves. `.rea/policy.yaml` and `.rea/HALT` are ALWAYS protected,
regardless of `blocked_paths`.

The dot-anchored matcher (Defect H / rea#79) means `.rea/` does NOT match
any random folder named `rea`. Project folders like `Projects/rea/Bug
Reports` are correctly allowed.

### Settings / hook file edit needed

If an upstream CodeRabbit / Codex finding on a hook script MUST be applied
in-session (rare — it's almost always a human task), the operator can set:

```bash
export REA_HOOK_PATCH_SESSION="applying PR #NNNN finding"
```

This allows edits under the runtime hook directory `.claude/hooks/` for that
shell. Every allowed edit emits a `hooks.patch.session` audit record
(routed through REA's hash-chained `appendAuditRecord`, not a bare jq
append — the hook refuses the edit if the audit chain cannot be extended).
The session boundary IS the expiry — a new shell requires a fresh opt-in.
`.rea/policy.yaml`, `.rea/HALT`, and `.claude/settings.json` remain
protected regardless, and any path containing a `..` segment is rejected
outright so traversal cannot smuggle a runtime edit into a policy file.

The source-of-truth `hooks/` directory is editable by default (it is the
authoring surface; `rea init` is what copies it into `.claude/hooks/` to
take effect). Operators who want to gate source edits can add `hooks/` to
`blocked_paths` in `.rea/policy.yaml`.

Do not set this env var yourself. It's an operator-declared posture.

---

## 5. Where to look when something is off

| Symptom | First check |
| ------- | ----------- |
| "Every push is blocked" | `rea doctor` — verifies the install and reports the first broken invariant. |
| "Cache check seems broken" | `tail -20 .rea/audit.jsonl` — look for recent `codex.review` entries. Then `rea cache list`. |
| "Something changed that I didn't change" | `rea audit verify` — confirms the audit hash chain is intact. |
| "Gateway seems down" | `rea status` — running-process view including downstream health. |

---

## 6. Rules of the road

- **Never** use `--no-verify`, `--no-gpg-sign`, or any flag that bypasses
  git hooks.
- **Never** commit AI attribution. The commit-msg hook will reject it.
- **Never** write to `.rea/policy.yaml` or `.rea/HALT` yourself.
- **Always** sign off commits with `git commit -s` (DCO).
- **Always** run `pnpm lint && pnpm type-check && pnpm test && pnpm build`
  before declaring work done.
- **Always** read `.rea/HALT` before starting work in any session.

---

## 7. Further reading

- `README.md` — install, quick-start, policy-file reference
- `THREAT_MODEL.md` — trust boundaries, mitigations, residual risks
- `SECURITY.md` — disclosure policy
- `CONTRIBUTING.md` — contributor guide + DCO
