---
'@bookedsolid/rea': patch
---

fix(cli): harden pre-push fallback installer (G6 post-merge hardening)

Close four classification/write-path issues in the G6 pre-push fallback installer: existence-only skip bypass (doctor pass on foreign hooks), classify/write TOCTOU, substring `FALLBACK_MARKER` collision, and deterministic tmp-filename collisions.
