/**
 * Adversarial corpus — generator-driven cross-product fixtures.
 *
 * Why this exists: the literal-PoC corpus (`bash-tier-corpus.test.ts`,
 * `bash-tier-corpus-round2.test.ts`, `scanner-corpus.test.ts`) memorizes
 * the points codex / external reviewers already visited. Codex finds
 * NEW bypasses each round because it explores the parameter space.
 *
 * This file converts the corpus to ADVERSARIAL GENERATORS so we span
 * the parameter space ourselves. Every dimensional axis (invocation
 * form, wrapper depth, quote shape, flag shape, path normalization,
 * redirect form, process subst, heredoc, function-redirect) is sampled
 * via cross-product.
 *
 * Coverage assertion at the end pins the total fixture count: ≥3000
 * positives, ≥1000 negatives. If the count drops, our test surface has
 * shrunk silently.
 *
 * Performance: cases run through the scanner DIRECTLY (no subprocess)
 * to keep wall time within budget.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runProtectedScan, type Verdict } from '../../../src/hooks/bash-scanner/index.js';
import { composeAdversarialCorpus } from './__generators__/compose.js';

const REA_ROOT = process.cwd();

function p(cmd: string): Verdict {
  return runProtectedScan(
    {
      reaRoot: REA_ROOT,
      policy: { protected_paths_relax: [] },
      stderr: () => {},
    },
    cmd,
  );
}

const corpus = composeAdversarialCorpus();

// ─────────────────────────────────────────────────────────────────────
//  Class A — utility-dispatch normalization
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class A (utility × invocation form)', () => {
  const fixtures = corpus.byKlass['A'] ?? [];
  it.each(fixtures.map((f) => [f.label, f]))('%s', (_label, f) => {
    const v = p(f.cmd);
    if (v.verdict !== f.expect) {
      // Helpful diagnostic on failure.
      throw new Error(
        `[Class ${f.klass}] ${f.label}\n  cmd: ${f.cmd}\n  expect=${f.expect} got=${v.verdict}\n  rationale: ${f.rationale}`,
      );
    }
    expect(v.verdict).toBe(f.expect);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Class B — wrapper-depth unwrap
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class B (wrapper depth)', () => {
  const fixtures = [...(corpus.byKlass['B'] ?? [])];
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

// ─────────────────────────────────────────────────────────────────────
//  Class C — interpreter quote-escape & dynamic-construction
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class C (interpreter quote/escape)', () => {
  const fixtures = corpus.byKlass['C'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class D — flag-shape coverage (-t / --target-directory)
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class D (flag shapes)', () => {
  const fixtures = corpus.byKlass['D'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class E — path normalization edge cases
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class E (path normalization)', () => {
  const fixtures = corpus.byKlass['E'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class F — redirect operators × fd prefixes
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class F (redirect forms)', () => {
  const fixtures = corpus.byKlass['F'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class G — process substitution body
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class G (process substitution)', () => {
  const fixtures = corpus.byKlass['G'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class H — heredoc-into-shell
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class H (heredoc payload)', () => {
  const fixtures = corpus.byKlass['H'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class I — function-with-redirect
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class I (function/block-with-redirect)', () => {
  const fixtures = corpus.byKlass['I'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Codex round 3 additions: Classes J, K, C-ext, D-ext, B-ext
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class J (pipe-into-bare-shell)', () => {
  const fixtures = corpus.byKlass['J'] ?? [];
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

describe('adversarial corpus — Class K (git top-level value-bearing flags)', () => {
  const fixtures = corpus.byKlass['K'] ?? [];
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

describe('adversarial corpus — Class C-ext (interpreter API breadth)', () => {
  const fixtures = corpus.byKlass['C-ext'] ?? [];
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

describe('adversarial corpus — Class D-ext (tar cluster shapes)', () => {
  const fixtures = corpus.byKlass['D-ext'] ?? [];
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

describe('adversarial corpus — Class B-ext (eval cmdsubst / dynamic argv)', () => {
  const fixtures = corpus.byKlass['B-ext'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class L — destructive primitives × directory ancestors
//
//  Codex round 4 structural corpus extension. PROTECTED_TARGETS was
//  file-shaped only pre-fix, so the cross-product generators couldn't
//  produce `rm -rf .rea` shapes. Class L adds bare-directory ancestor
//  targets and exercises the destructive-primitive class against them
//  (rm/rmdir/find -delete/mv source-side/interpreter rm_rf etc).
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class L (destructive primitives × ancestors)', () => {
  const fixtures = corpus.byKlass['L'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class N — loop-construct cmdsubst (round-6 architectural-refactor
//  regression class).
//
//  Pre-0.23.0-round-6 the walker dispatched on Cmd kinds and manually
//  enumerated each kind's traversed fields. WhileClause / UntilClause
//  walked only `.Do`; ForClause walked `.Do` and `.Loop.Items` but NOT
//  `.CStyleLoop.{Init,Cond,Post}`. Cond-side cmdsubst, redirect-on-cond,
//  and arithmetic-for slots silently bypassed every detector — `while
//  $(rm); do :; done`, `until [[ -n $(rm) ]]; do :; done`, `for
//  ((i=$(rm); ...))` all slipped through. Round-6 closes the class
//  structurally via deny-by-default `syntax.Walk()`. This corpus pins
//  regression coverage so any future regression to per-Cmd-kind
//  dispatch reintroducing the gap fails immediately.
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class N (loop-construct cmdsubst — round 6)', () => {
  const fixtures = corpus.byKlass['N'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class O — ParamExp.Slice walk-gap (round-7 P0 regression class).
//
//  Pre-round-7 mvdan-sh's syntax.Walk did NOT visit ParamExp.Slice
//  Offset/Length fields, so every `${X:$(rm)}` / `${X:0:$(rm)}` form
//  silently bypassed every detector. Round-7 closed the gap with a
//  `recurseParamExpSlice` helper invoked from the visit callback.
//  This corpus pins regression coverage.
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class O (ParamExp.Slice walk-gap — round 7)', () => {
  const fixtures = corpus.byKlass['O'] ?? [];
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

describe('adversarial corpus — Class O-neg (ParamExp.Slice negatives)', () => {
  const fixtures = corpus.byKlass['O-neg'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class P — nested-shell DQ-escape fidelity (round-8 P0 regression
//  class).
//
//  Pre-round-8 `unshellEscape` collapsed only `\"` and `\'` from DQ
//  payloads. Bash spec says DQ also collapses `\$`, `\\`, `` \` ``,
//  and `\<newline>`. The walker re-parsed `bash -c "echo \"\$(rm
//  .rea/HALT)\""` seeing `\$` as a literal `$` (no CmdSubst child) —
//  ALLOW — while the real shell collapsed `\$` → `$`, evaluated the
//  CmdSubst, and deleted HALT. Verified end-to-end exploit.
//
//  Round-8 fix: expanded `unshellEscape`'s replace class to all five
//  DQ-significant escape characters. This corpus pins regression
//  coverage across every shell launcher × every DQ-escape shape ×
//  every protected target.
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class P (nested-shell DQ-escape — round 8)', () => {
  const fixtures = corpus.byKlass['P'] ?? [];
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

describe('adversarial corpus — Class P-neg (DQ-escape negatives)', () => {
  const fixtures = corpus.byKlass['P-neg'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class Q — wrapper-shell-exec bypass (codex round 9 F1)
//
//  Every transparent process-launching wrapper × every shell × every
//  protected target must BLOCK. The walker's stripEnvAndModifiers
//  allow-list extension closes the bypass class.
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class Q (wrapper-shell-exec — round 9 F1)', () => {
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

describe('adversarial corpus — Class Q-neg (wrapper-shell-exec negatives)', () => {
  const fixtures = corpus.byKlass['Q-neg'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class R — busybox/toybox multiplexer (codex round 9 F2)
//
//  The single-binary multiplexer dispatches to applets by argv[1].
//  walker.ts strips the multiplexer head + optional `--` separator
//  + abs-path forms, then re-dispatches the remaining argv.
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class R (busybox/toybox multiplexer — round 9 F2)', () => {
  const fixtures = corpus.byKlass['R'] ?? [];
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

describe('adversarial corpus — Class R-neg (busybox/toybox negatives)', () => {
  const fixtures = corpus.byKlass['R-neg'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class S — round-10 wrapper-class extensions (chronic, dbus-launch,
//  watch, script, parallel). See compose.ts for the full TSDoc.
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class S (wrapper extensions — round 10)', () => {
  const fixtures = corpus.byKlass['S'] ?? [];
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

describe('adversarial corpus — Class S-neg (wrapper extensions — negatives)', () => {
  const fixtures = corpus.byKlass['S-neg'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class T — structural wrapper-shell-exec guard verification with
//  synthetic-wrapper names (round 10).
//
//  The structural guard runs in walkCallExpr's `default:` case (head
//  not in the dispatcher's allow-list). It looks for the bypass shape
//  `<UNRECOGNIZED-HEAD> [...flags...] <KNOWN-SHELL> -c PAYLOAD` and
//  re-dispatches PAYLOAD through detectNestedShell. Class T verifies
//  this works regardless of whether the wrapper is enumerated.
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class T (structural wrapper-shell-exec guard — round 10)', () => {
  const fixtures = corpus.byKlass['T'] ?? [];
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

describe('adversarial corpus — Class T-neg (structural guard false-positive guards)', () => {
  const fixtures = corpus.byKlass['T-neg'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class U — codex round 11 closures: find -exec `{}` placeholder
//  (F11-1), git rm/mv & history-rewrite seams (F11-2/F11-3), archive
//  extraction (F11-4), parallel stdin (F11-5).
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class U (find/git/archive/parallel — round 11)', () => {
  const fixtures = corpus.byKlass['U'] ?? [];
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

describe('adversarial corpus — Class U-neg (round 11 negatives)', () => {
  const fixtures = corpus.byKlass['U-neg'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class V — codex round 11 wrappers + PHP closures (F11-6, F11-7).
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class V (wrappers + php — round 11)', () => {
  const fixtures = corpus.byKlass['V'] ?? [];
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

describe('adversarial corpus — Class V-neg (wrappers + php negatives)', () => {
  const fixtures = corpus.byKlass['V-neg'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Class W — codex round 12 closures (F12-1..F12-9):
//    F12-1 PHP rename SOURCE-side, F12-2 PHP rmdir destructive,
//    F12-3 PHP shell-out re-parse, F12-4 PHP -B/-E eval flags,
//    F12-5 archive CREATE direction (tar/zip/7z), F12-6 cmake -E,
//    F12-7 mkfifo/mknod, F12-8 find -fls/-fprint/-fprintf,
//    F12-9 unzip read-only flags negative regression.
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — Class W (round 12 closures)', () => {
  const fixtures = corpus.byKlass['W'] ?? [];
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

describe('adversarial corpus — Class W-neg (round 12 negatives)', () => {
  const fixtures = corpus.byKlass['W-neg'] ?? [];
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

// ─────────────────────────────────────────────────────────────────────
//  Coverage assertion — corpus size pins our test surface
// ─────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────
//  Codex round 3 Finding 9 (P2): Bash-shim subprocess sampling.
//
//  Catches drift between in-process scanner verdicts and what the
//  bash shim actually returns through the verifier+resolver chain.
//  All 6,201+ corpus cases run through `runProtectedScan` directly;
//  this block samples a deterministic subset and spawns the actual
//  hook script (`hooks/protected-paths-bash-gate.sh`) so the JSON
//  verifier, status cross-check, and 4-tier CLI resolver are also
//  exercised.
// ─────────────────────────────────────────────────────────────────────

describe('adversarial corpus — bash shim subprocess sampling', () => {
  const REPO_ROOT = path.resolve(__dirname, '../../..');
  const SHIM = path.join(REPO_ROOT, 'hooks/protected-paths-bash-gate.sh');
  const CLI_DIST = path.join(REPO_ROOT, 'dist/cli/index.js');

  // Skip the entire block if the dist isn't built — the shim resolves
  // its CLI through `dist/cli/index.js` (4-tier resolver tier 4), and
  // running the shim without it would degrade into the "rea CLI not
  // found" branch.  We want to test the HAPPY PATH, so we only run
  // when the dist is present. CI's pre-test build step (`pnpm build`
  // before `pnpm test:bash-syntax` etc.) ensures this is true.
  const shimReady = fs.existsSync(SHIM) && fs.existsSync(CLI_DIST);

  // Deterministic linear-congruential sampler with a fixed seed so
  // the chosen indices are reproducible across runs.
  function lcgSample<T>(arr: readonly T[], n: number, seed: number): T[] {
    if (arr.length === 0 || n <= 0) return [];
    const result: T[] = [];
    const seen = new Set<number>();
    let state = seed >>> 0;
    while (result.length < Math.min(n, arr.length)) {
      // Numerical Recipes constants.
      state = (state * 1664525 + 1013904223) >>> 0;
      const idx = state % arr.length;
      if (!seen.has(idx)) {
        seen.add(idx);
        const item = arr[idx];
        if (item !== undefined) result.push(item);
      }
    }
    return result;
  }

  // Sample 100 fixtures (50 positive + 50 negative if possible) drawn
  // from the union of every class. Sampling is deterministic — the
  // SEED below pins the chosen subset.
  const SEED = 0x42424242;
  const allFixtures = Object.values(corpus.byKlass).flat();
  const positives = allFixtures.filter((f) => f.expect === 'block');
  const negatives = allFixtures.filter((f) => f.expect === 'allow');
  const sampled = [
    ...lcgSample(positives, 50, SEED),
    ...lcgSample(negatives, 50, SEED ^ 0xa5a5a5a5),
  ];

  // The shim contract: stdin is Claude Code tool_input JSON. The fixture's
  // `cmd` becomes `tool_input.command`.
  function runShim(cmd: string): { exit: number; verdict: 'allow' | 'block' | null } {
    if (!shimReady) {
      return { exit: -1, verdict: null };
    }
    const stdinPayload = JSON.stringify({ tool_input: { command: cmd } });
    const child = spawnSync('bash', [SHIM], {
      input: stdinPayload,
      encoding: 'utf8',
      cwd: REPO_ROOT,
      env: { ...process.env, CLAUDE_PROJECT_DIR: REPO_ROOT },
      timeout: 30_000,
    });
    if (child.error) {
      throw new Error(`shim spawn error: ${child.error.message}`);
    }
    // The shim writes verdict JSON to stdout (alongside the stderr
    // operator-facing reason for block paths).
    let verdict: 'allow' | 'block' | null = null;
    const stdout = (child.stdout ?? '').trim();
    if (stdout.length > 0) {
      try {
        const parsed = JSON.parse(stdout);
        if (
          parsed &&
          typeof parsed === 'object' &&
          (parsed.verdict === 'allow' || parsed.verdict === 'block')
        ) {
          verdict = parsed.verdict;
        }
      } catch {
        // malformed — verdict stays null; the exit code still tells us
        // what the shim decided.
      }
    }
    return { exit: child.status ?? -1, verdict };
  }

  it.skipIf(!shimReady).each(sampled.map((f) => [f.label, f]))('%s', (_label, f) => {
    const inProcess = runProtectedScan(
      {
        reaRoot: REPO_ROOT,
        policy: { protected_paths_relax: [] },
        stderr: () => {},
      },
      f.cmd,
    );
    const sub = runShim(f.cmd);
    // 1. Exit code matches expected verdict (0=allow, 2=block).
    const expectedExit = f.expect === 'allow' ? 0 : 2;
    if (sub.exit !== expectedExit) {
      throw new Error(
        `[shim] ${f.label}\n  cmd: ${f.cmd}\n  expected exit=${expectedExit} got exit=${sub.exit}\n  in-process verdict=${inProcess.verdict}\n  shim verdict=${sub.verdict}`,
      );
    }
    // 2. Shim-reported verdict matches in-process verdict (drift detector).
    if (sub.verdict !== null && sub.verdict !== inProcess.verdict) {
      throw new Error(
        `[shim drift] ${f.label}\n  cmd: ${f.cmd}\n  in-process=${inProcess.verdict} shim=${sub.verdict}`,
      );
    }
    expect(sub.exit).toBe(expectedExit);
  });

  it('reports shim-readiness and sample size', () => {
    if (!shimReady) {
      console.log(
        `[shim subprocess sampling] SKIPPED — dist/cli/index.js or hooks/protected-paths-bash-gate.sh missing. Run \`pnpm build\` first.`,
      );
    } else {
      console.log(
        `[shim subprocess sampling] sampled ${sampled.length} of ${allFixtures.length} corpus fixtures (seed=0x${SEED.toString(16)})`,
      );
    }
    // Always assert a sane sample size so CI flags an unintentional shrink.
    expect(sampled.length).toBeGreaterThanOrEqual(2);
  });
});

describe('adversarial corpus — coverage', () => {
  it('generates at least 3000 positive fixtures (must-block)', () => {
    console.log(
      `\n[adversarial corpus] positives=${corpus.total.positive}  negatives=${corpus.total.negative}  skipped=${corpus.total.skipped}\n`,
    );
    expect(corpus.total.positive).toBeGreaterThanOrEqual(3000);
  });
  it('generates at least 1000 negative fixtures (must-allow)', () => {
    expect(corpus.total.negative).toBeGreaterThanOrEqual(1000);
  });
  it('emits per-class fixture counts', () => {
    for (const [k, fixtures] of Object.entries(corpus.byKlass)) {
      console.log(`  Class ${k}: ${fixtures.length} fixtures`);
    }
    // Ensure every documented class produced fixtures — a class going
    // empty is a regression in the generator.
    for (const k of [
      'A',
      'B',
      'C',
      'D',
      'E',
      'F',
      'G',
      'H',
      'I',
      'J',
      'K',
      'C-ext',
      'D-ext',
      'B-ext',
      // Codex round 4 + 0.23.0 round-6 corpus extensions.
      'L',
      'N',
      // Codex round 7 P0 — ParamExp.Slice walk-gap.
      'O',
      'O-neg',
      // Codex round 8 P0 — unshellEscape DQ-escape parity.
      'P',
      'P-neg',
      // Codex round 9 F1/F2 — wrapper-shell-exec + busybox/toybox.
      'Q',
      'Q-neg',
      'R',
      'R-neg',
      // Codex round 11 — find/git/archive/parallel + wrappers/php.
      'U',
      'U-neg',
      'V',
      'V-neg',
      // Codex round 12 — F12-1..F12-9 closures.
      'W',
      'W-neg',
    ]) {
      expect(corpus.byKlass[k]?.length ?? 0).toBeGreaterThan(0);
    }
  });
});
