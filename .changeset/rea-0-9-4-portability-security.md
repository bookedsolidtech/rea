---
'@bookedsolid/rea': patch
---

[security] [portability] Close four hook defects surfaced by CodeRabbit review on HELiX PR #1506 (rea#61, #62, #63, #64):

- **J (CRITICAL security bypass, rea#61)** — mixed-push deletion guard in `push-review-core.sh` was nested inside the `[[ -z SOURCE_SHA || -z MERGE_BASE ]]` fallback. A mixed push such as `git push origin safe:safe :main` set `SOURCE_SHA` from the safe refspec and set only `HAS_DELETE=1` from the delete refspec — the nested deletion block never evaluated and the deletion passed the gate unchecked. The `HAS_DELETE` check is now hoisted above the fallback so any deletion in any refspec blocks the entire push.

- **K (MEDIUM user-facing render, rea#62)** — `LINE_COUNT` and `FILE_COUNT` in the `PUSH REVIEW GATE` banner used `grep -c ... 2>/dev/null || echo "0"`. When grep exited non-zero on a no-match it still printed its own `0` to stdout, and the `|| echo "0"` branch appended another, yielding `0\n0` interpolated into the banner. Replaced with `|| true` + `${VAR:-0}` default.

- **L (HIGH silent cache disarm, rea#63)** — `PUSH_SHA` was computed via `shasum -a 256 | cut -d' ' -f1 2>/dev/null || echo ""`. On Alpine, distroless, and most minimal Linux CI images `shasum` is not installed (only `sha256sum` is), so the pipeline failed and `|| echo ""` produced an empty `PUSH_SHA`. Combined with the silent cache-miss fallback (separate Defect F, scheduled 0.10.0), every push from such runners burned a full fresh codex review invisibly. Replaced with a portable `sha256sum → shasum → openssl` chain, hex-64 validation, and a visible WARN when no hasher is found. The openssl branch uses `awk '{print $NF}'` without `-r` to stay compatible with OpenSSL 1.1.x (Debian 11, Ubuntu 20.04, RHEL 8, Amazon Linux 2).

- **M (MEDIUM schema drift, rea#64)** — `SKIP_METADATA` used `jq --arg os_pid` / `--arg os_ppid`, which always produces string-typed fields. Downstream auditors querying `.metadata.os_identity.pid == 1234` (numeric) silently got zero matches. Switched to `--argjson` for `os_pid` / `os_ppid` (both come from bash internals `$$` / `$PPID`, guaranteed non-empty numeric). `os_uid` stays on `--arg` because `id -u 2>/dev/null || echo ""` can legitimately return empty.

Regression coverage: new `__tests__/hooks/push-review-gate-portability-security.test.ts` exercises all four defects (9 cases). Existing `push-review-gate-skip-push-review.test.ts` assertions for pid/ppid type flipped from `string` to `number` per M.
