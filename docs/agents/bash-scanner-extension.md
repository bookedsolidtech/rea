# Extending the Bash-Scanner — for AI Agents

> **Audience.** AI agents adding a new utility detector, recursion
> point, or corpus class to the parser-backed Bash-tier scanner.
> Architecture-level rationale lives in
> [`docs/architecture/bash-scanner.md`](../architecture/bash-scanner.md).
> This file is the focused recipe.
>
> **Prerequisite reading:**
>
> 1. [`docs/agents/README.md`](./README.md) — orientation
> 2. [`docs/architecture/bash-scanner.md`](../architecture/bash-scanner.md)
>    §"Walker design" + §"Detected-write taxonomy"

## When to extend

| Symptom | Extension type |
| ------- | -------------- |
| A bash command using utility `X` writes to a protected file but the scanner allows it | **Add a per-utility detector** |
| A protected file is reached through a parser-AST position the walker doesn't visit (Class O contract test fails) | **Add a walker recursion point** |
| A new bypass class emerges that doesn't fit existing fixture classes | **Add a new corpus class** |
| The user found a case the scanner over-corrects (allows-should, blocks-should) | **Add a negative fixture** to confirm boundary |

## Recipe 1 — Add a per-utility detector

Concrete example: hypothetically add `unzip -d DIR` (which extracts
a zip into DIR; if DIR is protected, the gate must block).

### Step 1 — Pick the form tag

Edit `src/hooks/bash-scanner/verdict.ts`. Add a new variant:

```ts
export type DetectedForm =
  | 'redirect'
  | 'cp_dest'
  | 'cp_t_flag'
  | /* ... existing forms ... */
  | 'unzip_d';                       // <- new
```

Form tags are an analytics taxonomy, not a security contract — the
shim doesn't branch on them. New forms are non-breaking for
consumers.

### Step 2 — Add the dispatch case

In `src/hooks/bash-scanner/walker.ts`, find `walkCallExpr` (the long
`switch (cmdName)` block). Add a case:

```ts
case 'unzip':
  detectUnzip(stripped, out);
  break;
```

`stripped` is `WordValue[]` — the argv with quoting stripped and
shell-level escapes collapsed. `out` is the accumulator the walker
appends `DetectedWrite` entries to.

### Step 3 — Write the `detect*` helper

Below the other `detect*` functions in `walker.ts`:

```ts
/**
 * `unzip -d DIR` extracts archive contents into DIR. When DIR
 * matches a protected pattern the gate must block. Any non-flag
 * positional after `-d` is the destination.
 *
 * Failure modes:
 *   - dynamic operand (`unzip -d $DEST`) → emit dynamic detection
 *   - missing operand (`unzip -d` at argv end) → no emit (parse-
 *     error class; bash itself would refuse)
 *
 * @param stripped - argv with quoting/escapes resolved.
 * @param out - detection accumulator.
 */
function detectUnzip(stripped: WordValue[], out: DetectedWrite[]): void {
  for (let i = 1; i < stripped.length; i += 1) {
    const tok = stripped[i];
    if (tok?.value === '-d') {
      const next = stripped[i + 1];
      if (next === undefined) return;
      out.push({
        path: next.value,
        form: 'unzip_d',
        position: next.position,
        ...(next.dynamic ? { dynamic: true } : {}),
        isDirTarget: true,
      });
      return;
    }
  }
}
```

Conventions:

- Use `tok?.value` (with optional chaining) — the strict TS config
  flags any unchecked indexed access.
- Spread `{ dynamic: true }` only when actually dynamic — the
  `exactOptionalPropertyTypes` rule rejects `dynamic: undefined`.
- Set `isDirTarget: true` for utilities that write INTO a directory
  (cp -t, mv -t, install -t, ln -t, unzip -d). The matcher then
  treats the path as `<DIR>/`-shaped so files under it match.

### Step 4 — Wire `recurseInnerArgv` (if applicable)

The detector should also fire when the same utility appears inside:

- `find -exec unzip -d ... \;`
- `xargs unzip -d ...`
- `bash -c "unzip -d ..."` (re-parsed)

Find `recurseInnerArgv` in `walker.ts`. Add the same case:

```ts
case 'unzip':
  detectUnzip(stripped, out);
  break;
```

### Step 5 — Add a unit test

`__tests__/hooks/bash-scanner/walker.test.ts`. Pattern:

```ts
describe('detectUnzip', () => {
  it('emits unzip_d for -d DIR', () => {
    const r = parseBashCommand('unzip -d .rea archive.zip');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const writes = walkForWrites(r.file);
    expect(writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '.rea',
          form: 'unzip_d',
          isDirTarget: true,
        }),
      ]),
    );
  });

  it('emits dynamic for -d $VAR', () => {
    const r = parseBashCommand('unzip -d "$DEST" archive.zip');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const writes = walkForWrites(r.file);
    expect(writes.some((w) => w.form === 'unzip_d' && w.dynamic === true)).toBe(true);
  });

  it('emits nothing when -d is missing', () => {
    const r = parseBashCommand('unzip archive.zip');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const writes = walkForWrites(r.file);
    expect(writes.filter((w) => w.form === 'unzip_d')).toHaveLength(0);
  });
});
```

### Step 6 — Add fixture coverage

The scanner has 19 fixture classes (A–P, plus `-ext` and `-neg`
suffixes). Pick the closest match:

- **Class A — utility-dispatch normalization.** Cross-product over
  utilities × wrappers (env / sudo / nice / timeout). Add `unzip` to
  the utility list in `__tests__/hooks/bash-scanner/__generators__/path-shapes.ts`.
- **Class D — flag-shape coverage.** Exercises `-t` / `--target-directory`
  patterns. Mirror the same shapes for `-d` if the scanner needs to
  accept both forms.

Cross-product fixture generation is in
`__tests__/hooks/bash-scanner/__generators__/compose.ts`. Each class
function returns `GenerationResult { fixtures, skipped }`.

### Step 7 — Add a literal end-to-end PoC

`__tests__/hooks/bash-tier-corpus.test.ts` (or
`-round2.test.ts`/`-roundN.test.ts` for round-specific PoCs). Each
fixture spawns the actual `hooks/protected-paths-bash-gate.sh` with
fake stdin and asserts the verdict. Pattern:

```ts
{
  cmd: 'unzip -d .rea archive.zip',
  expect: 'block',
  rationale: 'unzip -d into protected directory',
},
```

Run `pnpm vitest run __tests__/hooks/bash-tier-corpus.test.ts` to
verify.

### Step 8 — Run the gates

```bash
pnpm lint
pnpm type-check
pnpm vitest run __tests__/hooks/bash-scanner/
pnpm vitest run __tests__/hooks/bash-tier-corpus.test.ts
pnpm build
```

All must pass.

## Recipe 2 — Add a walker recursion point

Only needed when:

- The Class O exhaustiveness contract test fails on a new mvdan-sh
  version, OR
- A bypass PoC reveals an AST position the walker misses (e.g. a
  field on a `Cmd` type that `syntax.Walk` doesn't visit).

The pattern is the round-7 `recurseParamExpSlice` helper.

### Step 1 — Locate the visitor in `walker.ts`

Find `walkForWrites`. The visitor callback is declared up-front (so
recursion helpers can reference it). The `syntax.Walk(file, visit)`
call drives traversal; `visit` switches on `nodeType(node)`.

### Step 2 — Add the field check

Inside the visitor's switch:

```ts
case 'ParamExp': {
  // Walk skips Slice.Offset/Length (mvdan-sh@0.10.1).
  // Manual re-entry uses the SAME visitor for fixed-point
  // recursion through nested `${X:${Y:$(rm)}}`.
  recurseParamExpSlice(node, visit);
  break;
}
```

The `// Walk skips ...` comment is mandatory: it cites the parser
version, the field name, and the round number. Future agents
inheriting this file need that context.

### Step 3 — Write the recursion helper

Bottom of `walker.ts`:

```ts
/**
 * Round-7 P0: mvdan-sh@0.10.1's `syntax.Walk` does NOT visit
 * `ParamExp.Slice.Offset` or `ParamExp.Slice.Length`. These are
 * Word fields that can hold CmdSubst payloads (e.g. `${X:$(rm)}`).
 * We re-enter Walk on them manually with the SAME visitor so any
 * inner CmdSubst / CallExpr reaches the dispatcher.
 *
 * The same-visitor recursion ensures nested forms like
 * `${X:${Y:$(rm)}}` recurse to fixed point without extra
 * bookkeeping.
 *
 * @param node - the ParamExp node the outer Walk visited.
 * @param visit - the SAME visitor closure used by `walkForWrites`.
 */
function recurseParamExpSlice(node: BashNode, visit: (n: BashNode) => boolean): void {
  const slice = (node as any).Slice;
  if (!slice) return;
  if (slice.Offset) syntax.Walk(slice.Offset, visit);
  if (slice.Length) syntax.Walk(slice.Length, visit);
}
```

The cast through `any` is appropriate here — mvdan-sh's TS shim
doesn't fully type the `Slice` field. The Class O contract test
ensures we never silently regress.

### Step 4 — Add a Class O contract row

`__tests__/hooks/bash-scanner/walker-exhaustiveness.contract.test.ts`,
inside `EXHAUSTIVENESS_TABLE`:

```ts
{
  label: 'paramexp-slice-offset',
  nodeField: 'ParamExp.Slice.Offset',
  cmd: 'echo "${X:$(rm /tmp/sentinel-paramexp-slice-offset)}"',
  expectedPath: '/tmp/sentinel-paramexp-slice-offset',
},
```

The `nodeField` is human-readable for the failure message. `cmd` is
a fixture with a planted `$(rm /tmp/sentinel-LABEL)` at the position
under test. `expectedPath` is the literal sentinel path the walker
must surface.

**`acceptDynamic` opt-in (round-8 tightening):** the contract
defaults to path-explicit acceptance — `dynamic: true` writes do NOT
satisfy the assertion. If the position is genuinely unresolvable to
a static path (e.g. a procsubst body whose payload the walker
correctly pierces but cannot resolve to a literal), set
`acceptDynamic: true` on the row AND leave a comment explaining why.
No row in the current table relies on `acceptDynamic`.

### Step 5 — Run the contract test

```bash
pnpm vitest run __tests__/hooks/bash-scanner/walker-exhaustiveness.contract.test.ts
```

Must be GREEN before merge. The error message names the
(node-type, field) gap if the walker still can't reach it.

## Recipe 3 — Add a corpus class

A new "Class" is a parameterized fixture generator that exercises
one bypass surface across the cross-product.

### Pick the class letter

The next free letter (Q, R, ... at time of writing). A and B are
broad utility-dispatch / wrapper-depth classes; C through P are
focused on one bypass surface each.

### Class anatomy

In `__tests__/hooks/bash-scanner/__generators__/compose.ts`:

```ts
function classQ(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  // Define your axes — typically 2-4 of:
  //   SHELLS × PROTECTED_TARGETS × NEGATIVE_TARGETS × shape variants
  for (const target of PROTECTED_TARGETS) {
    for (const shape of MY_SHAPES) {
      fixtures.push({
        cmd: shape.build(target),
        expect: 'block',
        klass: 'Q',
        label: `${shape.id}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `Class Q — <one-sentence why this should block>`,
      });
    }
    // Negatives — same shape against non-protected targets.
    for (const neg of NEGATIVE_TARGETS) {
      fixtures.push({
        cmd: shape.build(neg),
        expect: 'allow',
        klass: 'Q-neg',
        label: `${shape.id}-${neg.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `Class Q negative — same shape against non-protected target`,
      });
    }
  }

  return { fixtures, skipped: [] };
}
```

### Wire into the master compose

```ts
const classes: Array<[string, () => GenerationResult]> = [
  // ... existing classes ...
  ['Q', classQ],
];

const splitMap: Record<string, string[]> = {
  // ... existing splits ...
  Q: ['Q-neg'],
};
```

The `splitMap` entry tells the bucket-router to peel `Q-neg`-tagged
fixtures into their own bucket. The runner picks them up under
`describe('adversarial corpus — Class Q-neg ...')`.

### Add the runner

In `__tests__/hooks/bash-scanner/adversarial-corpus.test.ts`:

```ts
describe('adversarial corpus — Class Q (<short description>)', () => {
  const fixtures = corpus.byKlass['Q'] ?? [];
  it.each(fixtures.map((f) => [f.label, f]))('%s', (_label, f) => {
    const v = p(f.cmd);
    if (v.verdict !== f.expect) {
      throw new Error(
        `[Class ${f.klass}] ${f.label}\n  cmd: ${f.cmd}\n  expect=${f.expect} got=${v.verdict}\n  rationale: ${f.rationale}`,
      );
    }
    expect(v.verdict).toBe(f.expect);
  });
});

describe('adversarial corpus — Class Q-neg (<negatives>)', () => {
  const fixtures = corpus.byKlass['Q-neg'] ?? [];
  it.each(fixtures.map((f) => [f.label, f]))('%s', (_label, f) => {
    const v = p(f.cmd);
    if (v.verdict !== f.expect) {
      throw new Error(/* ... */);
    }
    expect(v.verdict).toBe(f.expect);
  });
});
```

### Update the architecture doc

`docs/architecture/bash-scanner.md` has a class table and a
`bug reports closed` section. Add Q to both. Cross-link any round
number this class closes.

## Anti-patterns — what NOT to do

1. **Do NOT add a `case` in `walkCmd`.** That function was removed in
   round 6. Walker dispatch is `syntax.Walk`-based; per-`Cmd`-kind
   branches are no longer a possible pattern. If you find yourself
   wanting to switch on `cmdKind`, you're in the wrong layer —
   detection is per-`CallExpr` (which Walk delivers).

2. **Do NOT widen `unshellEscape` without updating the TSDoc.** The
   TSDoc enumerates every call site. Round 8 fix expanded the
   replace class from `[\"']` to `[$\"`\\\\\\n']` to cover all 5
   bash DQ-significant escape characters. Future expansions need the
   same audit + TSDoc refresh.

3. **Do NOT regex-match the raw command string.** Use the parsed
   AST. Regex over arbitrary bash is what 0.23.0 set out to delete.
   Per-utility detectors do regex over interpreter `-e` payloads —
   that's a different layer, scoped to interpreter-internal write
   APIs.

4. **Do NOT store dispatch state across `Walk` invocations.** The
   visitor is invoked per-node; persistent state would couple
   detectors. Append to `out: DetectedWrite[]` and let the
   compositor reason globally.

5. **Do NOT skip the contract test row when adding a recursion
   point.** The Class O contract is the structural pin — without a
   row, a future mvdan-sh upgrade can silently regress.

6. **Do NOT use `acceptDynamic: true` to make a failing contract
   row pass.** That defeats the point of the round-8 tightening.
   Use it ONLY when the named position is genuinely unresolvable —
   and document why inline.

## Cross-references

- [`docs/architecture/bash-scanner.md`](../architecture/bash-scanner.md) — full architecture
- [`docs/agents/troubleshooting.md`](./troubleshooting.md) — debug
  symptoms
- [`docs/agents/README.md`](./README.md) — agent entry point
- `src/hooks/bash-scanner/walker.ts` — the walker source
- `src/hooks/bash-scanner/verdict.ts` — form taxonomy
- `__tests__/hooks/bash-scanner/__generators__/compose.ts` — class
  generator pattern
