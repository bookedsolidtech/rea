/**
 * Unit tests for `args.ts`. Focus: stdin-parse cases (12 scenarios per
 * design §5.1) + argv-fallback semantics + defect J mixed-push deletion
 * detection.
 */

import { describe, expect, it } from 'vitest';
import {
  parsePrepushStdin,
  hasDeletion,
  resolveArgvRefspecs,
  stripRefsPrefix,
  type RefspecRecord,
} from './args.js';
import { BlockedError, HeadRefspecBlockedError, InvalidDeleteRefspecError } from './errors.js';
import { ZERO_SHA } from './constants.js';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const SHA_C = 'c'.repeat(40);

describe('parsePrepushStdin', () => {
  it('returns matched:false on empty input', () => {
    const r = parsePrepushStdin('');
    expect(r.matched).toBe(false);
    expect(r.records).toEqual([]);
  });

  it('parses a single well-formed line', () => {
    const line = `refs/heads/feature ${SHA_A} refs/heads/main ${SHA_B}\n`;
    const r = parsePrepushStdin(line);
    expect(r.matched).toBe(true);
    expect(r.records).toHaveLength(1);
    const rec = r.records[0] as RefspecRecord;
    expect(rec.local_sha).toBe(SHA_A);
    expect(rec.remote_sha).toBe(SHA_B);
    expect(rec.local_ref).toBe('refs/heads/feature');
    expect(rec.remote_ref).toBe('refs/heads/main');
    expect(rec.is_deletion).toBe(false);
  });

  it('parses multiple refspecs', () => {
    const stdin =
      `refs/heads/a ${SHA_A} refs/heads/a ${SHA_B}\n` +
      `refs/heads/b ${SHA_C} refs/heads/b ${ZERO_SHA}\n`;
    const r = parsePrepushStdin(stdin);
    expect(r.matched).toBe(true);
    expect(r.records).toHaveLength(2);
  });

  it('flags is_deletion when local_sha === ZERO_SHA (defect J)', () => {
    const line = `(delete) ${ZERO_SHA} refs/heads/main ${SHA_A}\n`;
    const r = parsePrepushStdin(line);
    expect(r.matched).toBe(true);
    expect(r.records[0]?.is_deletion).toBe(true);
  });

  it('skips blank lines but accepts surrounding valid lines', () => {
    const stdin = `\n\nrefs/heads/a ${SHA_A} refs/heads/main ${SHA_B}\n\n`;
    const r = parsePrepushStdin(stdin);
    expect(r.matched).toBe(true);
    expect(r.records).toHaveLength(1);
  });

  it('skips a short line silently and accepts a following well-formed line (bash parity)', () => {
    // Codex pass-1 regression guard: bash core at line 54-56 does NOT abort
    // the whole parse on a missing-field line — it `continue`s and keeps
    // trying subsequent lines. Mirror that so a consumer pre-push wrapper
    // emitting a comment or short line alongside a real refspec still
    // stays on the authoritative stdin path.
    const stdin = `incomplete line\n` + `refs/heads/a ${SHA_A} refs/heads/main ${SHA_B}\n`;
    const r = parsePrepushStdin(stdin);
    expect(r.matched).toBe(true);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]?.local_sha).toBe(SHA_A);
  });

  it('ignores trailing extra fields on a 4+N line (bash parity via `rest`)', () => {
    // Codex pass-1 regression guard: bash `read -r a b c d rest` rolls
    // everything past field-4 into `rest` and drops it. A 5-field line is
    // still a valid refspec — parse it and move on.
    const stdin = `refs/heads/a ${SHA_A} refs/heads/b ${SHA_B} extra trailing junk\n`;
    const r = parsePrepushStdin(stdin);
    expect(r.matched).toBe(true);
    expect(r.records).toHaveLength(1);
    expect(r.records[0]?.local_sha).toBe(SHA_A);
    expect(r.records[0]?.remote_sha).toBe(SHA_B);
  });

  it('returns matched:false when ALL lines are incomplete', () => {
    const r = parsePrepushStdin(`incomplete\nalso incomplete\n`);
    expect(r.matched).toBe(false);
    expect(r.records).toEqual([]);
  });

  it('returns matched:false when local_sha is not 40-hex', () => {
    const r = parsePrepushStdin(`refs/heads/a notasha refs/heads/b ${SHA_B}\n`);
    expect(r.matched).toBe(false);
  });

  it('returns matched:false when remote_sha is not 40-hex', () => {
    const r = parsePrepushStdin(`refs/heads/a ${SHA_A} refs/heads/b 1234\n`);
    expect(r.matched).toBe(false);
  });

  it('rejects uppercase hex (git emits lowercase only)', () => {
    const r = parsePrepushStdin(`refs/heads/a ${SHA_A.toUpperCase()} refs/heads/b ${SHA_B}\n`);
    expect(r.matched).toBe(false);
  });

  it('handles tag refspec shape (refs/tags/...)', () => {
    const r = parsePrepushStdin(`refs/tags/v1 ${SHA_A} refs/tags/v1 ${ZERO_SHA}\n`);
    expect(r.matched).toBe(true);
    expect(r.records[0]?.local_ref).toBe('refs/tags/v1');
  });

  it('handles force-push (remote_sha differs from local_sha)', () => {
    const r = parsePrepushStdin(`refs/heads/f ${SHA_A} refs/heads/f ${SHA_B}\n`);
    expect(r.matched).toBe(true);
    expect(r.records[0]?.local_sha).toBe(SHA_A);
    expect(r.records[0]?.remote_sha).toBe(SHA_B);
  });
});

describe('hasDeletion (defect J)', () => {
  it('returns true when any record is a deletion', () => {
    const recs: RefspecRecord[] = [
      {
        local_sha: SHA_A,
        remote_sha: SHA_B,
        local_ref: 'refs/heads/safe',
        remote_ref: 'refs/heads/safe',
        source_is_head: false,
        is_deletion: false,
      },
      {
        local_sha: ZERO_SHA,
        remote_sha: SHA_C,
        local_ref: '(delete)',
        remote_ref: 'refs/heads/main',
        source_is_head: false,
        is_deletion: true,
      },
    ];
    expect(hasDeletion(recs)).toBe(true);
  });

  it('returns false when every record is a push', () => {
    const recs: RefspecRecord[] = [
      {
        local_sha: SHA_A,
        remote_sha: SHA_B,
        local_ref: 'refs/heads/a',
        remote_ref: 'refs/heads/a',
        source_is_head: false,
        is_deletion: false,
      },
    ];
    expect(hasDeletion(recs)).toBe(false);
  });

  it('returns false on empty input', () => {
    expect(hasDeletion([])).toBe(false);
  });
});

describe('resolveArgvRefspecs — fallback from Claude-Code adapter', () => {
  const deps = (map: Record<string, string> = {}) => ({
    resolveHead: (ref: string) => map[ref] ?? null,
    headSha: SHA_A,
    upstream: 'origin/main' as string | null,
  });

  it('returns a single HEAD-origin record for bare `git push`', () => {
    const r = resolveArgvRefspecs('git push', deps());
    expect(r).toHaveLength(1);
    expect(r[0]?.local_sha).toBe(SHA_A);
    expect(r[0]?.source_is_head).toBe(true);
    expect(r[0]?.remote_ref).toBe('refs/heads/main');
  });

  it('falls back to main when upstream is null', () => {
    const r = resolveArgvRefspecs('git push', {
      ...deps(),
      upstream: null,
    });
    expect(r[0]?.remote_ref).toBe('refs/heads/main');
  });

  it('respects a non-main upstream', () => {
    const r = resolveArgvRefspecs('git push', {
      ...deps(),
      upstream: 'origin/dev',
    });
    expect(r[0]?.remote_ref).toBe('refs/heads/dev');
  });

  it('parses `git push origin feature`', () => {
    const r = resolveArgvRefspecs('git push origin feature', deps({ feature: SHA_B }));
    expect(r).toHaveLength(1);
    expect(r[0]?.local_sha).toBe(SHA_B);
    expect(r[0]?.local_ref).toBe('refs/heads/feature');
    expect(r[0]?.remote_ref).toBe('refs/heads/feature');
  });

  it('parses `git push origin src:dst`', () => {
    const r = resolveArgvRefspecs('git push origin feature:main', deps({ feature: SHA_B }));
    expect(r[0]?.local_ref).toBe('refs/heads/feature');
    expect(r[0]?.remote_ref).toBe('refs/heads/main');
  });

  it('strips the + from a force-push refspec', () => {
    const r = resolveArgvRefspecs('git push origin +feature:main', deps({ feature: SHA_B }));
    expect(r[0]?.local_ref).toBe('refs/heads/feature');
  });

  it('treats `:main` as a deletion', () => {
    const r = resolveArgvRefspecs('git push origin :main', deps());
    expect(r).toHaveLength(1);
    expect(r[0]?.is_deletion).toBe(true);
    expect(r[0]?.remote_ref).toBe('refs/heads/main');
  });

  it('treats `--delete main` as a deletion', () => {
    const r = resolveArgvRefspecs('git push origin --delete main', deps());
    expect(r).toHaveLength(1);
    expect(r[0]?.is_deletion).toBe(true);
  });

  it('parses `--delete=main` as a NON-deletion refspec (bash-core parity)', () => {
    // Codex pass-1 on phase 1 flagged the earlier "deletion marker" behavior
    // as a divergence from the live bash core (push-review-core.sh
    // §108-112). Bash inlines the bare ref into specs without the deletion
    // sentinel, so `--delete=main` resolves as an ordinary push refspec.
    // Preserve that quirk exactly — phase 4 may harden both gates
    // together in a later change.
    const r = resolveArgvRefspecs('git push origin --delete=main', deps({ main: SHA_B }));
    expect(r).toHaveLength(1);
    expect(r[0]?.is_deletion).toBe(false);
    expect(r[0]?.local_sha).toBe(SHA_B);
    expect(r[0]?.remote_ref).toBe('refs/heads/main');
  });

  it('rejects `--delete HEAD` with the delete-specific error (bash-core parity §161-168)', () => {
    // Codex pass-2 parity fix: the delete-mode HEAD/empty-dst path emits a
    // distinct banner ("--delete refspec resolves to HEAD or empty") vs.
    // the generic HEAD error. Throw the specific subclass so the CLI
    // shim can dispatch the right operator message.
    expect(() => resolveArgvRefspecs('git push origin --delete HEAD', deps())).toThrow(
      InvalidDeleteRefspecError,
    );
  });

  it('rejects `origin HEAD` (bare HEAD as refspec → dst=HEAD) as HeadRefspecBlockedError', () => {
    // Bash-core parity: `git push origin HEAD` resolves with src=dst=HEAD.
    // The bash core rejects on `dst == HEAD`; we match that.
    expect(() => resolveArgvRefspecs('git push origin HEAD', deps())).toThrow(
      HeadRefspecBlockedError,
    );
  });

  it('resolves `HEAD:main` via resolveHead callback (bash-core parity)', () => {
    // Bash-core behavior: src=HEAD, dst=main. The bash `git rev-parse HEAD^{commit}`
    // resolves cleanly; the gate does not separately reject HEAD as source.
    // We mirror that — the caller's resolveHead is authoritative.
    const r = resolveArgvRefspecs('git push origin HEAD:main', deps({ HEAD: SHA_B }));
    expect(r).toHaveLength(1);
    expect(r[0]?.local_sha).toBe(SHA_B);
    expect(r[0]?.remote_ref).toBe('refs/heads/main');
  });

  it('rejects unresolvable source ref', () => {
    expect(() => resolveArgvRefspecs('git push origin nosuchbranch', deps())).toThrow(BlockedError);
  });

  it('handles mixed push (defect J): safe + deletion in one command', () => {
    const r = resolveArgvRefspecs('git push origin safe:safe :main', deps({ safe: SHA_B }));
    expect(r).toHaveLength(2);
    expect(hasDeletion(r)).toBe(true);
    // The safe refspec resolves normally.
    const safe = r.find((rec) => rec.is_deletion === false);
    expect(safe?.local_sha).toBe(SHA_B);
  });

  it('stops parsing at a shell separator (defense in depth)', () => {
    // The bash core uses `awk` to chop at `;&|`. We mirror that: anything
    // after the first `;` or `&&` is ignored.
    const r = resolveArgvRefspecs('git push origin feature && rm -rf /', deps({ feature: SHA_B }));
    expect(r).toHaveLength(1);
    expect(r[0]?.local_sha).toBe(SHA_B);
  });

  it('returns an empty array when no `git push` present', () => {
    const r = resolveArgvRefspecs('git status', deps());
    // No push segment → bare-push synthesis still fires (the bash core
    // behaves the same; the caller upstream should have filtered non-push
    // commands before calling this).
    expect(r).toHaveLength(1);
    expect(r[0]?.source_is_head).toBe(true);
  });

  it('throws BlockedError when bare push has empty HEAD sha', () => {
    expect(() =>
      resolveArgvRefspecs('git push', {
        resolveHead: () => null,
        headSha: '',
        upstream: null,
      }),
    ).toThrow(BlockedError);
  });
});

describe('stripRefsPrefix', () => {
  it('strips refs/heads/', () => {
    expect(stripRefsPrefix('refs/heads/main')).toBe('main');
  });
  it('strips refs/for/ (gerrit-style)', () => {
    expect(stripRefsPrefix('refs/for/main')).toBe('main');
  });
  it('leaves bare names unchanged', () => {
    expect(stripRefsPrefix('main')).toBe('main');
  });
  it('leaves refs/tags/ unchanged', () => {
    expect(stripRefsPrefix('refs/tags/v1')).toBe('refs/tags/v1');
  });
});
