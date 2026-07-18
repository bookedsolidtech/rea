---
'@bookedsolid/rea': minor
---

`rea dash --emit-moc [path]` — the vault-MOC output mode (dash spec §4). Renders
the same aggregated global-dashboard model as a deterministic Markdown map-of-
content suitable for an Obsidian vault. No path → stdout; a path writes the file
(parent dir must exist — never mkdir's an operator's vault tree). Sensitive-project
visibility (§6) is honored upstream in the shared model: a non-visible project
contributes only an opaque item-count, never task titles, so a file written to a
shared vault carries exactly what the terminal view would. Read-only over task
artifacts (§5); disk-sourced subjects are neutralized against wikilink/embed
injection. Precedence: --emit-moc > --json > terminal.
