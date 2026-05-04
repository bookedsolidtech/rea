/**
 * Unit tests for the AST walker. Exercises every `DetectedForm` case
 * + the dispatch table on Stmt-level Cmd kinds. The corpus tests
 * (`scanner-corpus.test.ts`) verify the integrated behavior; this file
 * is for branch coverage of `walker.ts` in isolation.
 */

import { describe, expect, it } from 'vitest';
import { parseBashCommand } from '../../../src/hooks/bash-scanner/parser.js';
import { walkForWrites } from '../../../src/hooks/bash-scanner/walker.js';
import type { DetectedForm } from '../../../src/hooks/bash-scanner/verdict.js';

function detect(cmd: string): { forms: DetectedForm[]; paths: string[]; dynamic: boolean[] } {
  const r = parseBashCommand(cmd);
  if (!r.ok) throw new Error(`parse failed: ${r.error}`);
  const writes = walkForWrites(r.file);
  return {
    forms: writes.map((w) => w.form),
    paths: writes.map((w) => w.path),
    dynamic: writes.map((w) => w.dynamic),
  };
}

describe('walker — Stmt-level redirects', () => {
  it('emits redirect for `>`', () => {
    const r = detect('echo x > out');
    expect(r.forms).toContain('redirect');
    expect(r.paths).toContain('out');
  });
  it('emits redirect for `>>`', () => {
    expect(detect('echo x >> out').forms).toContain('redirect');
  });
  it('emits redirect for `>|`', () => {
    expect(detect('echo x >| out').forms).toContain('redirect');
  });
  it('emits redirect for `&>`', () => {
    expect(detect('echo x &> out').forms).toContain('redirect');
  });
  it('emits redirect for `&>>`', () => {
    expect(detect('echo x &>> out').forms).toContain('redirect');
  });
  it('emits redirect for `<>`', () => {
    expect(detect('echo x <> out').forms).toContain('redirect');
  });
  it('emits redirect for fd-prefixed `2>`', () => {
    expect(detect('echo x 2> out').forms).toContain('redirect');
  });
  it('does NOT emit for `<` (read)', () => {
    const r = detect('cat < input');
    expect(r.forms).toEqual([]);
  });
  it('does NOT emit for here-doc `<<`', () => {
    const r = detect('cat <<EOF\nx\nEOF');
    expect(r.forms).toEqual([]);
  });
});

describe('walker — cp / mv', () => {
  it('emits cp_dest for tail-positional', () => {
    expect(detect('cp src dst').forms).toContain('cp_dest');
  });
  it('emits cp_t_flag for `-t DIR`', () => {
    const r = detect('cp -t target src');
    expect(r.forms).toContain('cp_t_flag');
    expect(r.paths).toContain('target');
  });
  it('emits cp_t_flag for `--target-directory=DIR`', () => {
    expect(detect('cp --target-directory=target src').forms).toContain('cp_t_flag');
  });
  it('emits cp_t_flag for long form with space', () => {
    expect(detect('cp --target-directory target src').forms).toContain('cp_t_flag');
  });
  it('emits mv_dest for tail-positional', () => {
    expect(detect('mv src dst').forms).toContain('mv_dest');
  });
  it('walks past --', () => {
    const r = detect('cp -- -src dst');
    expect(r.paths).toContain('dst');
  });
});

describe('walker — sed / dd / tee / truncate / install / ln', () => {
  it('sed -i', () => {
    expect(detect('sed -i "s/x/y/" file.txt').forms).toContain('sed_i');
  });
  it('sed -i with empty BSD extension', () => {
    expect(detect("sed -i '' 's/x/y/' file.txt").forms).toContain('sed_i');
  });
  it('sed without -i (no detection)', () => {
    expect(detect('sed "s/x/y/" file.txt').forms).toEqual([]);
  });
  it('dd of=', () => {
    expect(detect('dd of=output').forms).toContain('dd_of');
  });
  it('tee', () => {
    expect(detect('tee out1 out2').forms).toEqual(['tee_arg', 'tee_arg']);
  });
  it('truncate', () => {
    expect(detect('truncate -s 0 file').forms).toContain('truncate_arg');
  });
  it('install', () => {
    expect(detect('install -m 644 src dst').forms).toContain('install_dest');
  });
  it('ln -s', () => {
    expect(detect('ln -s src dst').forms).toContain('ln_dest');
  });
});

describe('walker — awk -i inplace', () => {
  it('detects -i inplace', () => {
    expect(detect("awk -i inplace 'PROG' f").forms).toContain('awk_inplace');
  });
  it('detects gawk -i inplace', () => {
    expect(detect("gawk -i inplace 'PROG' f").forms).toContain('awk_inplace');
  });
  it('does NOT detect awk without -i inplace', () => {
    expect(detect("awk 'PROG' f").forms).toEqual([]);
  });
  it('detects --inplace', () => {
    expect(detect("awk --inplace 'PROG' f").forms).toContain('awk_inplace');
  });
});

describe('walker — ed / ex', () => {
  it('emits ed_target', () => {
    expect(detect('ed file').forms).toContain('ed_target');
  });
  it('emits ex_target', () => {
    expect(detect('ex file').forms).toContain('ex_target');
  });
  it('skips -c VALUE', () => {
    const r = detect('ex -c "1c|x" -c wq file');
    expect(r.paths).toContain('file');
    expect(r.paths).not.toContain('1c|x');
  });
});

describe('walker — find -exec', () => {
  it('recurses inner cp', () => {
    const r = detect('find . -name x -exec cp {} dst \\;');
    expect(r.forms.some((f) => f === 'cp_dest' || f === 'find_exec_inner')).toBe(true);
  });
  it('handles + terminator', () => {
    const r = detect('find . -name x -exec cp {} dst +');
    expect(r.forms.length).toBeGreaterThan(0);
  });
});

describe('walker — xargs', () => {
  it('emits unresolvable on bare xargs', () => {
    expect(detect('xargs touch').forms).toContain('xargs_unresolvable');
  });
  it('still recurses inner argv', () => {
    const r = detect('xargs cp -t dst');
    expect(r.forms).toContain('xargs_unresolvable');
    // Inner cp -t was also detected.
    expect(r.forms).toContain('cp_t_flag');
  });
});

describe('walker — interpreter -e / -c', () => {
  it('node -e fs.writeFileSync', () => {
    const r = detect("node -e \"fs.writeFileSync('a','x')\"");
    expect(r.forms).toContain('node_e_path');
    expect(r.paths).toContain('a');
  });
  it('node -e require fs', () => {
    const r = detect("node -e \"require('fs').writeFileSync('a','x')\"");
    expect(r.forms).toContain('node_e_path');
  });
  it("python -c open(..., 'w')", () => {
    const r = detect("python -c \"open('a','w').write('x')\"");
    expect(r.forms).toContain('python_c_path');
  });
  it('ruby -e File.write', () => {
    const r = detect("ruby -e \"File.write('a','x')\"");
    expect(r.forms).toContain('ruby_e_path');
  });
  it("perl -e open(FH, '>...')", () => {
    const r = detect('perl -e "open(FH, \'>a\')"');
    expect(r.forms).toContain('perl_e_path');
  });
});

describe('walker — nested shell', () => {
  it("bash -c 'inner'", () => {
    expect(detect("bash -c 'printf x > out'").forms).toContain('redirect');
  });
  it("sh -c 'inner'", () => {
    expect(detect("sh -c 'printf x > out'").forms).toContain('redirect');
  });
  it('depth cap refuses past 8', () => {
    let cmd = 'printf x > out';
    for (let i = 0; i < 10; i += 1) {
      cmd = `bash -c '${cmd.replace(/'/g, "'\\''")}'`;
    }
    const r = detect(cmd);
    expect(r.forms).toContain('nested_shell_inner');
    expect(r.dynamic).toContain(true);
  });
  it('dynamic payload refuses', () => {
    const r = detect('bash -c "$PAYLOAD"');
    expect(r.forms).toContain('nested_shell_inner');
  });
});

describe('walker — env-var-prefix and modifier wrappers', () => {
  it('env FOO=bar passes through', () => {
    expect(detect('env FOO=bar cp src dst').forms).toContain('cp_dest');
  });
  it('nohup passes through', () => {
    expect(detect('nohup cp src dst').forms).toContain('cp_dest');
  });
  it('time wrapper passes through (TimeClause AST)', () => {
    expect(detect('time cp src dst').forms).toContain('cp_dest');
  });
  it('sudo passes through', () => {
    expect(detect('sudo cp src dst').forms).toContain('cp_dest');
  });
  it('sudo -u user passes through', () => {
    expect(detect('sudo -u root cp src dst').forms).toContain('cp_dest');
  });
});

describe('walker — process / cmd substitution', () => {
  it('recurses >( ... )', () => {
    expect(detect('tee >(cat > out) < /dev/null').forms).toContain('redirect');
  });
  it('recurses $( ... )', () => {
    expect(detect('echo $(printf x > out)').forms).toContain('redirect');
  });
  it('recurses backticks', () => {
    expect(detect('echo `printf x > out`').forms).toContain('redirect');
  });
});

describe('walker — control-flow inner Stmts', () => {
  it('walks Block { ... }', () => {
    expect(detect('{ printf x > out; }').forms).toContain('redirect');
  });
  it('walks subshell ( ... )', () => {
    expect(detect('( printf x > out )').forms).toContain('redirect');
  });
  it('walks BinaryCmd ( a && b )', () => {
    expect(detect('true && printf x > out').forms).toContain('redirect');
  });
  it('walks IfClause', () => {
    expect(detect('if true; then printf x > out; fi').forms).toContain('redirect');
  });
  it('walks ForClause', () => {
    expect(detect('for i in 1; do printf x > out; done').forms).toContain('redirect');
  });
  it('walks WhileClause', () => {
    expect(detect('while true; do printf x > out; break; done').forms).toContain('redirect');
  });
});

describe('walker — dynamic markers', () => {
  it('flags ParamExp inside DQ', () => {
    const r = detect('echo "$x" > out');
    expect(r.dynamic).toContain(false); // out is static
  });
  it('flags ParamExp redirect target', () => {
    const r = detect('printf x > "$TARGET"');
    expect(r.dynamic).toContain(true);
  });
  it('flags backtick command-substitution in target', () => {
    const r = detect('printf x > `cat path`');
    expect(r.dynamic).toContain(true);
  });
});

describe('walker — redir op codes pinned (codex round 1 F-33)', () => {
  // Pin the parser-emitted Op codes so a future mvdan-sh bump that
  // re-numbers RedirOperator values fails LOUDLY instead of silently
  // dropping our detections. The walker maps these via REDIR_OP_NAMES;
  // if the parser changes them under us, this snapshot flips.
  it('write-redirect ops emit redirect detections (full set)', () => {
    const writeForms = ['>', '>>', '>|', '&>', '&>>', '<>'];
    for (const op of writeForms) {
      const r = detect(`echo x ${op} target_${op.replace(/[^a-z]/gi, '')}`);
      expect(r.forms).toContain('redirect');
    }
  });
  it('read-redirect ops do NOT emit detections', () => {
    expect(detect('cat < src').forms).toEqual([]);
    expect(detect('cat <<EOF\nblob\nEOF').forms).toEqual([]);
    expect(detect('cat <<<inline').forms).toEqual([]);
  });
});

describe('walker — codex round 1 detector unit coverage', () => {
  // F-1: FuncDecl-Body-redirect + Stmt-case dispatch.
  it('F-1: function decl with attached redirect emits redirect detection', () => {
    const r = detect('f() { echo evil; } > .rea/HALT && f');
    expect(r.forms).toContain('redirect');
    expect(r.paths).toContain('.rea/HALT');
  });

  // F-4: find -exec bash -c re-parse.
  it('F-4: find -exec bash -c PAYLOAD re-parses inner', () => {
    const r = detect(`find . -name x -exec bash -c 'printf y > .rea/HALT' {} \\;`);
    expect(r.paths).toContain('.rea/HALT');
  });

  // F-5: cp -fT no longer eats next token as value.
  it('F-5: cp -fT src DEST emits cp_dest for DEST', () => {
    const r = detect('cp -fT src .rea/HALT');
    expect(r.forms).toContain('cp_dest');
    expect(r.paths).toContain('.rea/HALT');
  });

  // F-6: sed -e SCRIPT -i FILE.
  it('F-6: sed -e SCRIPT -i FILE emits sed_i for FILE', () => {
    const r = detect(`sed -e '1d' -i .rea/HALT`);
    expect(r.forms).toContain('sed_i');
    expect(r.paths).toContain('.rea/HALT');
  });

  // F-7: cp -t / --target-directory= → isDirTarget true.
  it('F-7: cp -t DIR src emits cp_t_flag with isDirTarget=true', () => {
    const r = parseBashCommand('cp -t .rea src');
    if (!r.ok) throw new Error('parse failed');
    const writes = walkForWrites(r.file);
    const tFlag = writes.find((w) => w.form === 'cp_t_flag');
    expect(tFlag?.path).toBe('.rea');
    expect(tFlag?.isDirTarget).toBe(true);
  });

  // F-8: node --eval / -p / -pe.
  it('F-8: node --eval extracts write target', () => {
    const r = detect(`node --eval "require('fs').writeFileSync('.rea/HALT','x')"`);
    expect(r.paths).toContain('.rea/HALT');
  });

  it('F-8: node -pe extracts write target via cluster', () => {
    const r = detect(`node -pe "require('fs').writeFileSync('.rea/HALT','x')"`);
    expect(r.paths).toContain('.rea/HALT');
  });

  it('F-8: perl -E extracts write target', () => {
    // We use single-quoted to avoid shell-eval of $fh.
    const r = detect(`perl -E 'open(my $fh,">",".rea/HALT")'`);
    expect(r.paths).toContain('.rea/HALT');
  });

  // F-9: backtick literal target.
  it('F-9: node -e backtick template literal target captured', () => {
    const r = detect('node -e \'require("fs").writeFileSync(`.rea/HALT`,"x")\'');
    expect(r.paths).toContain('.rea/HALT');
  });

  // F-10: python dynamic open() flagged.
  it('F-10: python -c open(concat) emits dynamic detection', () => {
    const r = detect(`python -c "open('.rea/'+'HALT','w').write('x')"`);
    expect(r.dynamic).toContain(true);
  });

  // F-11: ruby parens-less.
  it('F-11: ruby -e File.write parens-less captured', () => {
    const r = detect(`ruby -e "File.write '.rea/HALT', 'x'"`);
    expect(r.paths).toContain('.rea/HALT');
  });

  // F-12: perl qx() / awk system() shell-out re-parse.
  it('F-12: perl -e qx(...) re-parses inner shell', () => {
    const r = detect(`perl -e "qx(printf x > .rea/HALT)"`);
    expect(r.paths).toContain('.rea/HALT');
  });

  it('F-12: awk system() re-parses inner shell', () => {
    const r = detect(`awk 'BEGIN{system("printf x > .rea/HALT")}' /dev/null`);
    expect(r.paths).toContain('.rea/HALT');
  });

  it('F-12: awk print > "FILE" captures path', () => {
    const r = detect(`gawk 'BEGIN{print "x" > ".rea/HALT"}' /dev/null`);
    expect(r.paths).toContain('.rea/HALT');
  });

  // F-13: bash -ic cluster.
  it('F-13: bash -ic PAYLOAD re-parses inner', () => {
    const r = detect(`bash -ic 'printf x > .rea/HALT'`);
    expect(r.paths).toContain('.rea/HALT');
  });

  it('F-13: bash -lic PAYLOAD re-parses inner', () => {
    const r = detect(`bash -lic 'printf x > .rea/HALT'`);
    expect(r.paths).toContain('.rea/HALT');
  });

  // F-19: awk -f script-file → dynamic.
  it('F-19: awk -f script-file emits dynamic awk_source', () => {
    const r = parseBashCommand('awk -f /tmp/evil.awk /dev/null');
    if (!r.ok) throw new Error('parse failed');
    const writes = walkForWrites(r.file);
    const dyn = writes.find((w) => w.form === 'awk_source' && w.dynamic);
    expect(dyn).toBeDefined();
  });

  // F-20 / F-21: top-level destructive utilities.
  it('F-20: touch FILE emits redirect', () => {
    const r = detect('touch .rea/HALT');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('F-21: rm FILE emits redirect', () => {
    const r = detect('rm .rea/policy.yaml');
    expect(r.paths).toContain('.rea/policy.yaml');
  });

  it('F-21: chmod 000 FILE emits redirect (mode skipped)', () => {
    const r = detect('chmod 000 .rea/HALT');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('F-21: chmod u+x FILE emits redirect (alpha-mode skipped)', () => {
    const r = detect('chmod u+x .rea/HALT');
    expect(r.paths).toContain('.rea/HALT');
  });

  // F-22: nested find -exec find -exec.
  it('F-22: find -exec find -exec rm FILE recurses two levels', () => {
    const r = detect('find . -name x -exec find . -name y -exec rm .rea/HALT \\; \\;');
    expect(r.paths).toContain('.rea/HALT');
  });
});

describe('walker — control-flow recursion', () => {
  it('for-loop body redirects detected', () => {
    const r = detect('for f in a b; do printf x > .rea/HALT; done');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('while-loop body redirects detected', () => {
    const r = detect('while true; do printf x > .rea/HALT; done');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('until-loop body redirects detected', () => {
    const r = detect('until false; do printf x > .rea/HALT; done');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('case-statement body redirects detected', () => {
    const r = detect('case x in a) printf x > .rea/HALT;; *) ;; esac');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('if/then/else body redirects detected (then branch)', () => {
    const r = detect('if true; then printf x > .rea/HALT; fi');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('if/then/else body redirects detected (else branch)', () => {
    const r = detect('if false; then echo y; else printf x > .rea/HALT; fi');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('subshell body redirects detected', () => {
    const r = detect('(printf x > .rea/HALT)');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('block body redirects detected', () => {
    const r = detect('{ printf x > .rea/HALT; }');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('time-clause inner cmd recursed', () => {
    const r = detect('time printf x > .rea/HALT');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('not-cmd inner stmt recursed', () => {
    const r = detect('! printf x > .rea/HALT');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('binary-cmd both sides walked', () => {
    const r = detect('echo a > out_a && echo b > out_b');
    expect(r.paths).toContain('out_a');
    expect(r.paths).toContain('out_b');
  });

  it('process-substitution >(...) inner recursed', () => {
    const r = detect('tee >(cat > .rea/HALT)');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('command-substitution $(...) inner recursed', () => {
    const r = detect('echo $(printf x > .rea/HALT)');
    expect(r.paths).toContain('.rea/HALT');
  });
});

describe('walker — sudo/env/nohup wrapper stripping', () => {
  it('sudo cp protected → detected', () => {
    const r = detect('sudo cp src .rea/HALT');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('env FOO=bar cp → detected', () => {
    const r = detect('env FOO=bar cp src .rea/HALT');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('nohup cp → detected', () => {
    const r = detect('nohup cp src .rea/HALT');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('command cp → detected', () => {
    const r = detect('command cp src .rea/HALT');
    expect(r.paths).toContain('.rea/HALT');
  });

  it('backslash-cmd \\cp → detected', () => {
    const r = detect('\\cp src .rea/HALT');
    expect(r.paths).toContain('.rea/HALT');
  });
});

describe('walker — empty / no-detection inputs', () => {
  it('empty input → zero detections', () => {
    expect(detect('').forms).toEqual([]);
  });
  it('whitespace-only → zero', () => {
    expect(detect('  \t  ').forms).toEqual([]);
  });
  it('plain echo → zero', () => {
    expect(detect('echo hello world').forms).toEqual([]);
  });
  it('git command → zero', () => {
    expect(detect('git status').forms).toEqual([]);
  });
});
