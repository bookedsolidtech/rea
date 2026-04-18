---
'@bookedsolid/rea': patch
---

Move `safe-regex` from devDependencies to dependencies.

`src/policy/loader.ts` imports `safe-regex` at runtime (the G3 ReDoS
load-time validation on user-supplied redact patterns), but the dep was
declared devOnly in 0.2.0. The published 0.2.0 tarball is unusable in
consumer projects — `node dist/cli/index.js` fails with
`ERR_MODULE_NOT_FOUND: Cannot find package 'safe-regex'`. This patch
restores a working install.
