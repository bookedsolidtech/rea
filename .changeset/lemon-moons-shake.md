---
'@bookedsolid/rea': minor
---

Fix the push-gate codex runner: restore model-ladder fallback and give a real diagnostic on a failed run.

Every install with `review.codex_required: true` and no explicit `review.codex_model` pin was unable to push. The runner threw on a non-zero codex exit **before** parsing stdout — and codex reports run failures as a JSON `error` event on stdout with stderr left empty. Two defects fell out of that single ordering:

- The operator's entire diagnostic was `codex exec review exited with code 1. stderr tail: ` with nothing after it. A model the account cannot reach was indistinguishable from a broken working tree.
- `CodexModelUnsupportedError` — the only error `IRON_GATE_MODEL_LADDER` falls through on — is classified after that throw, so it was never constructed and the ladder could not advance past its first rung.

Changes:

- `runCodexReview` now parses stdout before branching on the exit code, then classifies. A non-zero exit still always throws — never a review, never a pass — but the ladder can advance and the message carries codex's own error text.
- `CodexSubprocessError` gained a `stdoutTail` that is appended only when stderr is empty, so existing `stderr tail:` output is unchanged.
- Model-rejection detection moved to `isModelRejection()` (now exported) and widened: the previous pattern matched only the 400 "model is not supported" wording and missed the 404 "does not exist or you do not have access" wording entirely.
- `IRON_GATE_MODEL_LADDER` is now `gpt-6-astra → gpt-5.5 → gpt-5.4`. Both 5.x rungs are unreachable on a ChatGPT-auth Codex account; they are kept below astra because an API-key account may still resolve them, and a rejected rung costs ~2s with no review compute.

Upgrading is enough for installs that do not pin a model. **An install that pins `review.codex_model: gpt-5.5` (or `gpt-5.4`) must also change or remove that pin** — an explicit pin is authoritative and is never substituted, so it will now fail loudly with a readable reason instead of silently.
