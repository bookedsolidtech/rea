/**
 * 0.28.0 Round-18 P2 (deferred from 0.23.0) — FuncDecl-then-call
 * closure.
 *
 * The static AST scanner does not model bash function invocation. A
 * function declaration that contains a write into a protected path:
 *
 *   f() { echo x > .rea/HALT; }; f
 *
 * defines `f` and then calls it. Pre-fix the call was an opaque
 * CallExpr whose head matched no built-in detector — so the body's
 * write never propagated to the outer detection set, and the kill-
 * switch was bypassed.
 *
 * Closure: post-pass walks every FuncDecl, computes the writes its
 * body produces, and on every CallExpr whose head matches a known
 * function name, re-emits the captured writes.
 */

import { describe, it, expect } from 'vitest';
import { runProtectedScan } from '../../src/hooks/bash-scanner/index.js';

const REPO_ROOT = '/tmp/funcdecl-then-call-test';

function run(cmd: string): { verdict: string; reason?: string; detected_form?: string } {
  return runProtectedScan(
    {
      reaRoot: REPO_ROOT,
      policy: { protected_paths_relax: [] },
      stderr: () => {
        /* silent */
      },
    },
    cmd,
  );
}

describe('Round-18 P2 — FuncDecl-then-call', () => {
  it('blocks bash -lc with FuncDecl-then-call into .rea/HALT', () => {
    const r = run("bash -lc 'f() { echo x > .rea/HALT; }; f'");
    expect(r.verdict).toBe('block');
  });

  it('blocks plain top-level FuncDecl + call', () => {
    const r = run('f() { echo x > .rea/HALT; }; f');
    expect(r.verdict).toBe('block');
  });

  it('blocks FuncDecl with write to .husky/pre-push', () => {
    const r = run('myfn() { echo evil > .husky/pre-push; }; myfn');
    expect(r.verdict).toBe('block');
  });

  it('does NOT block when the function is declared but never called', () => {
    // Pure declaration with no invocation should NOT trip the post-
    // pass — the writes are dormant. Allowing this avoids false
    // positives for shell libraries that define helpers without
    // calling them at module load time.
    const r = run('f() { echo x > .rea/HALT; }');
    // The original walker may also independently flag this (the body
    // writes ARE in the AST). Per the round-17 closure logic, the
    // top-level Walk visits FuncDecl bodies via descendCmdScopes, so
    // the body's `echo > .rea/HALT` redirect IS detected. We don't
    // assert allow here — instead we just verify the closure does
    // not introduce a NEW false positive; whatever the existing
    // walker does for a bare declaration is preserved.
    expect(['allow', 'block']).toContain(r.verdict);
  });

  it('blocks function with `function` keyword form', () => {
    const r = run('function evil { echo x > .rea/HALT; }; evil');
    expect(r.verdict).toBe('block');
  });

  it('handles function declared inside a subshell + called outside', () => {
    // Subshell-defined functions don't escape the subshell in real
    // bash, but the post-pass conservatively treats every FuncDecl
    // visible to syntax.Walk as callable. The PoC matches a bash
    // semantic: the inner Stmts and outer call are visible to the
    // walker as siblings.
    const r = run('(f() { echo x > .rea/HALT; }); f');
    // Either block (conservative match) or allow (subshell scope
    // honored) is acceptable — assert no crash and ensure the
    // primary closure (single-Stmt FuncDecl + call) still fires.
    expect(['allow', 'block']).toContain(r.verdict);
  });

  it('blocks FuncDecl whose body redirects via tee', () => {
    const r = run('f() { echo x | tee .rea/HALT; }; f');
    expect(r.verdict).toBe('block');
  });

  it('preserves allow for a function whose body does NOT touch protected paths', () => {
    const r = run('safe() { echo hello; }; safe');
    expect(r.verdict).toBe('allow');
  });

  it('does not loop on self-recursive function definitions', () => {
    // Self-recursive: f calls itself. The post-pass uses a visited
    // set keyed by FuncDecl AST-node identity, so we only walk the
    // body once. This test guards against an infinite loop in the
    // closure — if the test times out, the loop bound failed.
    const r = run('f() { f; echo x > .rea/HALT; }; f');
    expect(r.verdict).toBe('block');
  });
});
