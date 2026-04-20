# Patch to apply to THREAT_MODEL.md — BUG-012 (0.6.2)

## Why a draft and not a direct edit

`THREAT_MODEL.md` is in `.rea/policy.yaml → blocked_paths`. The
`blocked-paths-enforcer.sh` hook rightly refused the agent's write. Jake
needs to apply this patch by hand (or temporarily relax the block).

## Where to insert

Insert the new `### 5.2a` section **between** the existing `### 5.2 Hook Bypass`
section and `### 5.3 Policy Tampering`. The current file structure is:

```
### 5.2 Hook Bypass
...
**Residual risk:** A sufficiently privileged local process ... outside of audit log review.

---

### 5.3 Policy Tampering
```

## New content to insert

(insert after the `---` separator that follows §5.2's residual risk, and before `### 5.3`)

```markdown
### 5.2a `CLAUDE_PROJECT_DIR` as advisory-only signal (BUG-012, 0.6.2)

**Threat:** The `push-review-gate.sh` and `commit-review-gate.sh` hooks need to know the rea repository root so that (a) cross-repo invocations from consumer repositories short-circuit cleanly, and (b) HALT / policy enforcement always evaluates the correct policy file. Prior to 0.6.2, the guard read the root from the `CLAUDE_PROJECT_DIR` environment variable. That variable is caller-controlled — any process invoking the hook (or any shell that has it exported in the environment) can set it to a foreign path, which the guard would then treat as rea. The result: HALT is silently bypassed, the cross-repo short-circuit fires on the wrong comparison, and policy is read from a directory the caller chose.

**Mitigations:**

- The hooks now derive `REA_ROOT` from their own on-disk location using `BASH_SOURCE[0]` + `pwd -P`. Install topology is fixed: hooks live at `<root>/.claude/hooks/<name>.sh`, so `REA_ROOT` is two levels up from `SCRIPT_DIR`. This anchor is forge-resistant — a caller cannot relocate the hook file without filesystem write access to the rea install, which is already protected by `settings-protection.sh` and `blocked-paths` enforcement.
- `CLAUDE_PROJECT_DIR` is retained only as an advisory signal. When set and the realpath differs from the script-derived `REA_ROOT`, the hook emits a stderr advisory (`rea-hook: ignoring CLAUDE_PROJECT_DIR=... — anchoring to script location`) and continues using the script-derived value. It is never compared for short-circuit, never used to select the policy file, and never used to locate HALT.
- The cross-repo guard now compares `git rev-parse --git-common-dir` on both sides (not path prefixes). Mixed state (one side git, one non-git) fails **closed** — the gate runs — rather than falling through to path-prefix. Only the both-non-git case still uses path-prefix, matching the documented 0.5.1 non-git escape hatch.

**Residual risk:** If a local attacker has write access to the rea install directory they can move or replace the hook file, which would change `SCRIPT_DIR` and therefore `REA_ROOT`. This is equivalent to tampering with any other hook contents (`settings-protection.sh` already addresses it) and lies outside the `CLAUDE_PROJECT_DIR` threat class. Ref: `__tests__/hooks/push-review-gate-cross-repo.test.ts` "BUG-012: foreign CLAUDE_PROJECT_DIR does NOT bypass HALT".

---
```
