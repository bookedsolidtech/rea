---
"@bookedsolid/rea": patch
---

chore: migrate npm publishing to Trusted Publishing (OIDC)

Removes the long-lived `NPM_TOKEN` dependency from the release workflow.
Authentication now federates a short-lived OIDC token to npm via the
trusted-publisher entry, in response to the npm Mini Shai-Hulud token
rotation event. Bumps the pinned pnpm to 9.15.9 (the version with
confirmed OIDC trusted-publishing support). Sigstore provenance and all
BUG-013 tarball-integrity verification gates are preserved.
