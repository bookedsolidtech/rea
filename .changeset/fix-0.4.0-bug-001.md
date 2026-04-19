---
'@bookedsolid/rea': patch
---

fix(gateway/blocked-paths): restore absolute-path matching and close content-key + URL-escape bypasses

Address three post-merge Codex findings on BUG-001:
- **[critical]** Absolute `blocked_paths` entries (e.g. `/etc/passwd`) no longer matched after the content-substring narrowing — restored.
- **[high]** `CONTENT_KEYS` blanket skip on `name/value/label/tag/tags/title` let `{name: ".env"}` bypass — now only skipped when value is not path-shaped.
- **[high]** Malformed `%XX` URL-escape silently disabled decode, enabling `.rea/` trust-root bypass via `%2Erea%2F` — now fails closed on malformed escapes.
