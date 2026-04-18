---
'@bookedsolid/rea': patch
---

Refresh `THREAT_MODEL.md` to 0.2.x.

Reflects the 0.2.0 MVP that shipped: gateway middleware chain, G3 ReDoS
worker-thread timeout, G4 HALT single-syscall atomicity, G11.1–G11.5
Codex resilience (escape hatch, pluggable reviewer, availability probe,
first-class no-Codex mode, reviewer telemetry), and G12 install manifest
+ upgrade command + drift detection. Adds three new attack-surface
sections — §5.11 downstream subprocess environment inheritance,
§5.12 regex denial-of-service, §5.13 installer path trust — and updates
the residual-risk table with 0.3.0 tracking pointers.

Doc-only; no runtime change.
