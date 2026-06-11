# Parity catch-rate — codex vs gpt-oss-120b, on our own code

The load-bearing question for the OpenRouter lane: **can the cheap model (`gpt-oss-120b`, ~$0.36/mo) catch what the expensive one (Codex / gpt-5.4) catches?** If yes, Codex demotes from default gate to a metered escalation scalpel and routine review runs for pennies.

We have an unusually good way to answer it: the 16-round adversarial hardening of the OpenRouter provider produced a **ground-truth corpus of real defects Codex caught on our own code** — verdict-laundering, false-coverage, evidentiary exfiltration, backend-pin bypass, and more. This harness replays those defects through both reviewers and measures the catch-rate.

## How it works

`corpus.json` lists each known defect with a precise `anchor → replacement` edit that **reintroduces** it in source. For each case the runner:

1. reintroduces the defect,
2. runs `rea review --provider both` (Codex authoritative + gpt-oss shadow) over the working-tree diff,
3. records whether **each reviewer's verdict worsened vs a clean baseline** (a worsened verdict = the reviewer noticed the defect),
4. restores the file via `git checkout`.

It baselines both reviewers on the clean diff first, so "caught" means *verdict got worse than baseline* — not just "non-pass" (which avoids counting pre-existing nits).

## Run it

```bash
pnpm build                                   # the harness drives dist/

# the actual test (needs the gpt-oss key). Set it once, the turnkey way:
rea config set-key openrouter                 # masked prompt → ~/.config/rea/credentials (0600)
#   or, per-project / CI (env wins over the stored key):
#   export OPENROUTER_API_KEY=sk-or-...
node scripts/parity-catch-rate.mjs            # all cases
node scripts/parity-catch-rate.mjs --cases=verdict-laundering,diff-fail-open   # a subset

# without a key → only the Codex baseline runs (gpt-oss column shows `no-key`)
```

Output: per-case caught/missed for each reviewer, a catch-rate summary by severity, the list of defects **gpt-oss missed that Codex caught** (the decision-makers), and the gpt-oss spend for the run. Full JSON → `scripts/parity/last-run.json`.

> **Cost/time:** each case is one full `rea review` over the whole branch diff (the product's real behavior). Budget ~1 Codex + ~1 gpt-oss review per case; Codex spend is metered, gpt-oss is pennies. Use `--cases=` to run a subset.

## How a team extends it

Add an entry to `corpus.json`:

```json
{
  "id": "kebab-id",
  "round": 0,
  "severity": "P1|P2|P3",
  "class": "short label",
  "file": "src/.../file.ts",
  "anchor": "<a string that occurs EXACTLY once in file>",
  "replacement": "<the same region, edited to reintroduce the bug>",
  "description": "what a reviewer should flag"
}
```

The runner verifies each anchor occurs exactly once and reports `STALE-ANCHOR` (never silently skips) so the corpus stays honest as the code evolves. Good cases come straight from `git log` / the audit trail: any time Codex (or anyone) finds a real defect, capture it here as a reusable eval.

## Reading the result

- **gpt-oss matches Codex on the P1s** → the thesis holds; flip the routine gate to `provider: openrouter`, keep Codex as the escalation lane for protected paths + low-confidence verdicts.
- **gpt-oss misses P1s** → it does *not* suffice as a drop-in; keep Codex authoritative and use gpt-oss only where a miss is cheap (or in `provider: both` shadow mode for continued measurement).

Either way the number is honest and reproducible — that's the point.
