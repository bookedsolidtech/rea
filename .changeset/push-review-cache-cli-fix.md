---
'@bookedsolid/rea': patch
---

fix(hooks): execute `node_modules/.bin/rea` directly instead of via `node`

The push-review-gate and commit-review-gate hooks previously resolved the rea
CLI with `node "${REA_ROOT}/node_modules/.bin/rea"`. That path is NOT a plain
JavaScript file — pnpm writes a POSIX shell-script shim there, and npm writes
a symlink whose target carries its own `#!/usr/bin/env node` shebang. Running
`node` on the shim parsed shell syntax as JavaScript and threw `SyntaxError`.
The caller's `|| echo '{"hit":false}'` fallback silently masked the error,
turning every push-review cache lookup into a miss — so a previously-approved
push always re-tripped the review-required gate and every push was blocked.

Two changes to the CLI-resolution ladder in `hooks/_lib/push-review-core.sh`
and `hooks/commit-review-gate.sh` (and their dogfood copies under
`.claude/hooks/`):

- `-f` → `-x`: require the shim to be executable before attempting to use it.
- Drop the `node` prefix on the shim branch. The shim handles `exec node` itself.

The dogfood fallback (`dist/cli/index.js`) keeps the `node` prefix because that
entry point IS a real JavaScript module.

Regression test added at `__tests__/hooks/push-review-gate-cli-invocation.test.ts`
covering three cases: pnpm-style shim, dogfood fallback, and a non-executable
shim that must fall through to the dist branch.
