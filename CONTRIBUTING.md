# Contributing to REA

Thanks for your interest. REA is a governance tool for Claude Code — contributions that preserve its minimal, security-first scope are welcome.

## Before you start

Read:

1. [README.md](./README.md) — what REA is
2. [README.md §Non-Goals](./README.md#non-goals) — what REA explicitly is not
3. [SECURITY.md](./SECURITY.md) — how to report vulnerabilities (not via GitHub issues)
4. [THREAT_MODEL.md](./THREAT_MODEL.md) — the assumptions you must not break

## Non-goals are non-negotiable

REA does not do: project management, Obsidian integration, account/OAuth management, Discord MCP tools, daemon supervision, hosted services, or large agent rosters. PRs adding these will be closed with a pointer to alternatives.

If you want one of those things, build a separate package that composes with REA.

## Developer Certificate of Origin (DCO)

All commits must be signed off — we use DCO, not a CLA:

```bash
git commit -s -m "fix: ..."
```

The `Signed-off-by:` line certifies you wrote the patch or have the right to contribute it under the project license. See [developercertificate.org](https://developercertificate.org/) for the full text.

CI rejects any commit without DCO sign-off.

## Development setup

```bash
git clone git@github.com:bookedsolidtech/rea.git
cd rea
pnpm install
pnpm test
pnpm build
```

Node 22+ required. pnpm 9+ required.

## Making changes

1. Create a feature branch from `main`
2. Write tests — unit tests for middleware changes, integration tests for end-to-end flows
3. Run `pnpm lint`, `pnpm type-check`, `pnpm test`, `pnpm build` locally
4. Add a changeset: `pnpm changeset` — describe what changed and why
5. Sign your commits (`-s`) and open a PR against `main`
6. Request review from `@himerus`

## Changesets

Every user-facing change needs a changeset. Run:

```bash
pnpm changeset
```

Pick the semver bump (major/minor/patch) and write one or two sentences explaining the change from a user's perspective. This feeds the CHANGELOG.

Docs-only or test-only changes can skip changesets — add the `@changesets/skip` label to the PR.

## Commit messages

- Use conventional commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`)
- Keep the subject ≤72 chars
- Explain the "why" in the body if non-obvious
- **No AI attribution.** REA does not accept commits with `Co-Authored-By: Claude`, `Generated with [tool]` footers, or similar. The commit-msg hook enforces this.

## Code style

- TypeScript strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`
- No `any` unless escape-hatching a third-party type hole (with a comment)
- No `eval`, `Function`, or dynamic `require` on runtime input
- Prettier for formatting (`pnpm format`)
- ESLint must pass with zero warnings (`pnpm lint`)

## Security-sensitive changes

Changes to these paths require extra review:

- `src/gateway/middleware/**`
- `src/policy/**`
- `hooks/**`
- `.github/workflows/**`

Tag `@himerus` and clearly explain the threat model impact. If the change alters a security boundary, update `THREAT_MODEL.md` in the same PR.

## Adding or modifying a hook

PreToolUse / PostToolUse hooks (the shell scripts under `hooks/`) have a specific four-file shape — executor + shim + dogfood mirror + parity baseline — and a set of conventions hardened across the 0.32.0–0.42.0 marathon (relevance pre-gate, sandbox check, 4-tier policy reader, `shim_run` API).

**Read [`docs/hook-playbook.md`](./docs/hook-playbook.md) first.** It documents the patterns, the fail-open vs blocking-tier decision, the relevance-keyword catalog rules, the dogfood-mirror bootstrap trick, and the awk-comment-quote class. Following it (plus skimming one existing hook) should get you to a correctly-shaped contribution without re-deriving the lessons.

## Reporting security issues

**Do not open a public issue.** See [SECURITY.md](./SECURITY.md) for private disclosure channels.

## Code of conduct

See [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md). Be kind, be technical, disagree well.
