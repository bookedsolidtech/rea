---
'@bookedsolid/rea': patch
---

fix(hooks): changeset-security-gate validates the resulting file for Edit, not the fragment

For a single `Edit`, the frontmatter-completeness check ran against the
`new_string` fragment rather than the post-edit file. A body-only edit
to an already-valid changeset — frontmatter untouched — was therefore
rejected as "missing frontmatter" (the fragment has none), training
agents to route around the gate with a full-file `Write`. The gate now
reconstructs the resulting document (applies `old_string` → `new_string`,
honoring `replace_all`, to the on-disk content) and validates that:
body edits pass, while an edit that deletes the bump entry is still
caught. When the result cannot be reconstructed (missing file,
`old_string` absent) the frontmatter check is skipped rather than
false-blocking. The GHSA/CVE disclosure scan continues to run on every
accepted tool's payload, including Edit fragments.
