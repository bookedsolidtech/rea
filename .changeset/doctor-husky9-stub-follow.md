---
'@bookedsolid/rea': patch
---

Fix `rea doctor` false-positive on husky 9 layouts.

When `core.hooksPath=.husky/_` (husky 9's default), git fires the
auto-generated stub at `.husky/_/<hookname>`, which sources `.husky/_/h`
and exec's the canonical `.husky/<hookname>`. The doctor probe was
classifying the stub directly — finding no rea marker and no
`rea hook push-gate` reference in the stub — and reporting governance
as inactive even though the hook git actually invokes carried the
governance body.

`classifyExistingHook` now detects the husky 9 stub shape (`. "${0%/*}/h"`
or `. "$(dirname -- "$0")/h"` as the only non-comment line) and follows
one level of indirection to the parent `.husky/<hookname>`, returning
the parent's classification. Stub-of-stub recursion is capped at one
hop. Non-stub paths take the existing classifier path unchanged — no
behavior change for vanilla git or `core.hooksPath=.husky` layouts.

Functional impact for consumers: cosmetic only. The push-gate already
ran correctly through the husky 9 indirection — only `rea doctor` was
misreporting.

New exports: `isHusky9Stub`, `resolveHusky9StubTarget`. Existing
`classifyExistingHook` signature gains an optional
`{ followHusky9Stub?: boolean }` argument with default `true`.

Reported by HELiXiR during the rea 0.13.0 evaluation.
