# Security Policy

## Supported Versions

Security fixes land on the latest minor line. Older minors receive fixes only
when the issue is critical and a backport is tractable.

| Version | Supported                                   |
| ------- | ------------------------------------------- |
| 0.9.x   | Yes — active line                           |
| 0.8.x   | Critical fixes only, 30 days from 0.9.0     |
| 0.7.x   | No — superseded; upgrade recommended        |
| ≤ 0.6.x | No — superseded; upgrade recommended        |
| < 0.1   | No (pre-release)                            |

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Public issues expose vulnerabilities to attackers before users can patch. We follow coordinated disclosure — vulnerabilities are disclosed publicly only after a patch is released.

> Note: REA enforces this policy automatically. The `security-disclosure-gate` hook intercepts `gh issue create` commands containing security-sensitive keywords and blocks them with instructions to use private disclosure instead.

### Private Disclosure (preferred)

Email **security@bookedsolid.tech** with the details below. This is monitored and treated as confidential.

Alternatively, use [GitHub Security Advisories](https://github.com/bookedsolidtech/rea/security/advisories/new) to report privately. This creates a private discussion thread visible only to maintainers.

### What to include

- Description of the vulnerability and affected component
- Steps to reproduce (minimal PoC if possible)
- Potential impact and attack scenario
- Your suggested fix (optional but appreciated)

### Response timeline

| Step                      | Target                                |
| ------------------------- | ------------------------------------- |
| Acknowledgement           | Within 72 hours                       |
| Patch for critical issues | Within 7 days of confirmed report     |
| Public disclosure         | Within 90 days, or sooner if patched  |

## Scope

The following components are **in scope**:

- **Hook scripts** — all `.sh` files in `hooks/` and consumer-installed `.claude/hooks/`. REA ships shell scripts that execute on every Claude Code tool call with the full permissions of the user running Claude Code. Vulnerabilities in these scripts are treated as critical, equivalent to arbitrary code execution in the developer's environment.
- **CLI commands** — `rea init`, `rea freeze`, `rea unfreeze`, `rea serve`, `rea check`, `rea doctor`, and related entry points in `src/cli/`
- **MCP server and middleware chain** — policy enforcement, tier classification, blocked-path enforcement, secret redaction, audit logging, kill-switch, and injection detection layers
- **Policy loader** — `.rea/policy.yaml` parsing and schema validation; autonomy-ceiling enforcement
- **Prompt injection** — via proxied tool descriptions, tool names, or tool results
- **Tool name collision / shadowing** — native tool override via malicious downstream server config
- **Secret redaction gaps** — credential patterns not caught, encoding-based bypasses
- **Audit chain tampering** — hash chain bypass, log suppression techniques
- **Shell hook injection** — techniques to inject arbitrary commands through hook input parsing
- **HALT kill-switch bypass** — race conditions, symlink attacks, TOCTOU on `.rea/HALT`
- **Codex plugin integration** — review-gate bypass, audit entry suppression on Codex invocations

**Out of scope:**

- Vulnerabilities in Claude Code itself — report those to Anthropic
- Vulnerabilities in the Codex plugin itself — report those to OpenAI
- Bugs in the MCP protocol implementation — report those to the MCP maintainers or Anthropic
- Vulnerabilities in downstream MCP servers proxied through `.rea/registry.yaml` — report those to the respective project maintainers
- Social engineering
- Denial of service via resource exhaustion (unless it bypasses a security control)
- Issues requiring physical access to the machine

## Coordinated Disclosure

Once a patch is ready:

1. We release the patched version to npm
2. We publish a GitHub Security Advisory with full technical details
3. We credit the reporter (unless they prefer anonymity)

We ask reporters to wait for our patch before publishing their own writeup. Critical issues are patched within 7 days; other issues within a reasonable timeline based on complexity.

## Security Architecture

REA's security model is defense-in-depth across two independent layers:

**Gateway layer** (runtime, `rea serve`):

- Governance middleware chain — every tool call is audited, classified, and policy-checked
- Secret redaction on arguments (pre-execution) and results (post-execution)
- HALT kill switch — a single `.rea/HALT` file immediately blocks all tool calls
- Blocked path enforcement — `.rea/` and operator-defined paths are always protected

**Hook layer** (development-time, Claude Code hooks):

- 14 shell scripts ship in the hook layer. 12 are wired into Claude Code's
  `PreToolUse` / `PostToolUse` events via the default `.claude/settings.json`.
  Two are shipped but NOT registered by default: `commit-review-gate.sh`
  is a `PreToolUse: Bash` hook that matches `git commit` for operators who
  opt into commit-time review by adding a rule, and `push-review-gate-git.sh`
  is a native-git adapter that sources `hooks/_lib/push-review-core.sh`
  (the same shared core used by the Claude-Code push-review adapter),
  shipped for consumers who wire a wrapper-based `.husky/pre-push` that
  execs it directly. `rea init`'s default installer emits a standalone
  inline `.husky/pre-push` body rather than a wrapper; unifying the
  husky installer on the adapter is tracked as a follow-up
- `security-disclosure-gate` routes public security-keyword issue creation to private disclosure
- `settings-protection` prevents agents from modifying their own safety rails
- `dangerous-bash-interceptor` blocks categories of destructive shell commands
- `push-review-gate` and the shared-core adapter (`push-review-gate-git.sh` sourcing `hooks/_lib/push-review-core.sh`) anchor trust on the hook's own on-disk location via `BASH_SOURCE` rather than caller-controlled env vars; see `THREAT_MODEL.md §5.18`. The shipped inline `.husky/pre-push` body uses `git rev-parse --show-toplevel` to locate `REA_ROOT` — extending the script-anchor idiom to the inline path is tracked follow-up hardening

Both layers operate independently — compromising one does not disable the other.

## Security Design Notes

- No telemetry or network calls from the CLI or gateway (gateway only connects to operator-configured downstream servers)
- No `eval`, `Function()`, or dynamic `require` on policy-driven input
- Policy parsing is strict zod schema — unknown fields rejected, not ignored
- Path traversal protection on profile loading (regex + path containment check)
- CI publish pipeline includes gitleaks secret scanning, npm provenance attestation via OIDC, SBOM generation, and payload validation
- All shell hooks set fail-fast flags with explicit variable quoting (`set -euo pipefail`, or `set -uo pipefail` for hooks that consume stdin JSON where a single `jq`-path miss must not abort before the conditional branches run)
- Commits are signed and DCO-signed-off; `main` branch protection requires passing checks and review
- npm publish uses OIDC provenance; no long-lived NPM tokens in CI
