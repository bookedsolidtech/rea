---
'@bookedsolid/rea': patch
---

Ship `MIGRATING.md` in the npm tarball.

The 0.13.2 release added `MIGRATING.md` at the repo root and `rea
doctor`'s foreign-hook fail message references it ("See `MIGRATING.md`
for a worked example"). The doc was missing from `package.json#files`,
so consumers running `npm i @bookedsolid/rea` got the doctor reference
but no local copy of the file. They had to land on GitHub to read it.

Adds `MIGRATING.md` to the `files` allowlist alongside `README.md`,
`SECURITY.md`, and `THREAT_MODEL.md`. Now the migration guide ships
with every install — `cat node_modules/@bookedsolid/rea/MIGRATING.md`
works.
