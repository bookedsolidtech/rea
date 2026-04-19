---
'@bookedsolid/rea': patch
---

fix(gateway/blocked-paths): eliminate content-substring false positives (BUG-001)

The blocked-paths middleware previously substring-matched policy patterns against every string value in the argument tree, including free-form `content` and `body` fields. A secondary fallback stripped the leading `.` from patterns like `.env`, which caused the naked substring `env` to match inside any string containing "environment" — breaking legitimate note creation on Helix (`obsidian__create-note` with 14 KB of prose that mentioned GitHub Environments and `.env` files in passing).

The matcher is now key-aware and path-segment aware:

- Arguments with a known path-like leaf key (`path`, `file_path`, `filename`, `folder`, `dir`, `src`, `dst`, `target`, …) are always scanned.
- Arguments with a content-like leaf key (`content`, `body`, `text`, `message`, `description`, `summary`, `title`, `query`, `prompt`, `comment`, …) are never scanned, regardless of how the value looks.
- Arguments with any other key are scanned only when the value looks like a filesystem path (contains a separator, starts with `~`, is a dotfile, or matches a Windows drive prefix).
- Pattern matching is strictly path-segment aware; `*` and `?` are single-segment globs (they do not cross `/`), and all other regex metacharacters in a pattern are escaped. Trailing `/` on a pattern means "this directory and everything under it".
- `.rea/` is still unconditionally enforced regardless of policy.

The policy file format is unchanged. Existing installs that list both `.env` and `.env.*` in `blocked_paths` continue to block every `.env` variant. If a policy previously relied on accidental substring matching (e.g., listing only `.env` and expecting `.env.local` to be blocked), add `.env.*` explicitly — this is how the `bst-internal` profile already works.
