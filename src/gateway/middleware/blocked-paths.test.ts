import { describe, expect, it } from 'vitest';
import { createBlockedPathsMiddleware } from './blocked-paths.js';
import type { InvocationContext } from './chain.js';
import { AutonomyLevel, InvocationStatus, type Policy } from '../../policy/types.js';

function stubPolicy(blocked: string[]): Policy {
  return {
    version: '1',
    profile: 'test',
    installed_by: 'test',
    installed_at: '2026-04-18',
    autonomy_level: AutonomyLevel.L1,
    max_autonomy_level: AutonomyLevel.L2,
    promotion_requires_human_approval: true,
    block_ai_attribution: true,
    blocked_paths: blocked,
    notification_channel: '',
  };
}

function freshCtx(args: Record<string, unknown>, tool = 'Write'): InvocationContext {
  return {
    tool_name: tool,
    server_name: 'local',
    arguments: args,
    session_id: 's',
    status: InvocationStatus.Allowed,
    start_time: Date.now(),
    metadata: {},
  };
}

async function run(mw: ReturnType<typeof createBlockedPathsMiddleware>, ctx: InvocationContext) {
  let nextCalled = false;
  await mw(ctx, async () => {
    nextCalled = true;
  });
  return nextCalled;
}

describe('blocked-paths middleware — core behavior', () => {
  it('denies when a path-shaped argument references a blocked path', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ file_path: '/project/.env' });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
    expect(ctx.error).toContain('.env');
  });

  it('always protects .rea/ regardless of policy', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy([]));
    const ctx = freshCtx({ file_path: '/project/.rea/policy.yaml' });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
    expect(ctx.error).toContain('.rea/');
  });

  it('normalizes URL-encoded path separators', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ file_path: '/project%2F.env' });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('allows unrelated paths through', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ file_path: '/project/src/index.ts' });
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
  });
});

describe('blocked-paths middleware — BUG-001 regression (content vs path)', () => {
  it('does not deny `content` that merely mentions .env or "environment"', async () => {
    // This is the exact failure helix's team hit: a 14KB note about GitHub
    // workflows containing the word "environment" was rejected because
    // `.env` was substring-matched inside `content`.
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env', '.env.*']));
    const ctx = freshCtx(
      {
        filename: 'Helix 3.0.0 Last Call Go-No-Go.md',
        folder: 'Projects/HELiX/Planning',
        content: [
          'This note discusses the GitHub Environment `npm-publish` and the',
          '.github/workflows/publish.yml pipeline. It mentions .env files in',
          'passing while describing environment-variable hygiene. The word',
          'environment appears several times in prose.',
        ].join(' '),
      },
      'create-note',
    );
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
  });

  it('does not deny `content` that literally contains the substring .env inside prose', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ content: 'Ops engineers should never commit .env to a repo.' });
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
  });

  it('does not false-match "environment" against a `.env` blocked pattern', async () => {
    // The regression: stripped-substring fallback turned `.env` → `env`, which
    // matched "environment". The new matcher is path-segment aware so "environment"
    // is never considered a path value (no slash, no leading dot).
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ description: 'environment variables and deployment' });
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
  });

  it('does not scan free-form `title` even if the title contains path-shape text', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ title: 'Working with .env files — best practices' });
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
  });

  it('still denies when the filename itself is .env', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ filename: '.env', folder: '/project' });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });
});

describe('blocked-paths middleware — glob patterns', () => {
  it('treats .env.* as a glob (not a literal asterisk) and denies .env.local', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env.*']));
    const ctx = freshCtx({ file_path: '/project/.env.local' });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
    expect(ctx.error).toContain('.env.*');
  });

  it('treats .env.* as a glob and denies .env.production', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env.*']));
    const ctx = freshCtx({ file_path: '/project/.env.production' });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('.env.* does NOT match plain .env (covered by the separate `.env` entry)', async () => {
    // This is the stricter glob semantics: `.env.*` requires SOMETHING after
    // the second dot. The policy should list both `.env` and `.env.*` if it
    // wants to cover plain `.env` as well (which `bst-internal` does).
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env.*']));
    const ctx = freshCtx({ file_path: '/project/.env' });
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
  });

  it('glob does not cross a path separator', async () => {
    // `.env.*` must not match `.env/foo` (a subdirectory named .env is a
    // different concern; policy should use a trailing-slash pattern for that).
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env.*']));
    const ctx = freshCtx({ file_path: '/project/.env/foo' });
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
  });

  it('trailing-slash pattern matches everything under the directory', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['secrets/']));
    const ctx = freshCtx({ file_path: '/app/secrets/db.json' });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('trailing-slash pattern matches the directory itself', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['secrets/']));
    const ctx = freshCtx({ folder: '/app/secrets' });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('escapes regex metacharacters in non-glob patterns', async () => {
    // A pattern like `some.dir` must match `some.dir` literally, NOT any
    // 8-char path with a `.` in the 5th slot.
    const mw = createBlockedPathsMiddleware(stubPolicy(['some.dir']));
    const allowedCtx = freshCtx({ file_path: '/project/someXdir' });
    const deniedCtx = freshCtx({ file_path: '/project/some.dir' });
    await run(mw, allowedCtx);
    await run(mw, deniedCtx);
    expect(allowedCtx.status).toBe(InvocationStatus.Allowed);
    expect(deniedCtx.status).toBe(InvocationStatus.Denied);
  });
});

describe('blocked-paths middleware — key-name routing', () => {
  it('scans PATH_LIKE_KEYS even when value does not look like a path', async () => {
    // A bare filename like `.env` is still path-shaped (dotfile rule), but a
    // PATH_LIKE_KEY should be scanned regardless of heuristic.
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ destination: '.env' });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('DOES scan CONTENT_KEYS when value is path-shaped (post-0.4.0 hardening)', async () => {
    // Post-merge Codex round-1 finding: the blanket CONTENT_KEYS skip-list let
    // real blocked-path writes addressed as `{message: "/home/user/.env"}`
    // bypass. Content-ish keys are now scanned when the value is path-shaped.
    // Prose values remain unscanned (see the separate BUG-001 regression
    // suite for `title`/`description` prose that stays allowed).
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ message: '/home/user/.env' });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('scans arrays of filenames under a PATH_LIKE_KEY', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ files: ['src/index.ts', '.env'] });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('scans nested PATH_LIKE_KEYS under an object', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ target: { path: '/project/.env' } });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('scans non-allowlisted keys when value looks path-shaped', async () => {
    // `config_file` is not in PATH_LIKE_KEYS, but the value looks like a path.
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ config_file: '/project/.env' });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });
});

describe('blocked-paths middleware — robustness', () => {
  it('handles circular references without looping', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const node: Record<string, unknown> = { file_path: '/project/src/index.ts' };
    node.self = node;
    const ctx = freshCtx(node);
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
  });

  it('tolerates malformed URL encoding', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ file_path: '/project/%E0%A4%A.env' });
    // Post-0.4.0 hardening: malformed %XX now fails closed rather than
    // silently falling back to undecoded content. The important property
    // is that the middleware does not crash and leaves ctx consistent.
    await expect(run(mw, ctx)).resolves.toBeDefined();
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('ignores non-string arg values (numbers, booleans, null)', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ count: 5, enabled: true, meta: null, file_path: '/ok.ts' });
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
  });
});

describe('blocked-paths middleware — 0.4.0 Codex round-1 regressions', () => {
  // Finding 1 (critical, verified): absolute blocked_paths matching regression.
  describe('absolute-path blocked_paths matching', () => {
    it('blocks write when blocked_paths has /etc/passwd and file_path is /etc/passwd', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['/etc/passwd']));
      const ctx = freshCtx({ file_path: '/etc/passwd' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
      expect(ctx.error).toContain('/etc/passwd');
    });

    it('blocks when absolute pattern matches a path-shaped `path` argument', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['/etc/passwd']));
      const ctx = freshCtx({ path: '/etc/passwd' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });

    it('blocks subdirectory writes under an absolute dir pattern /var/log/', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['/var/log/']));
      const ctx = freshCtx({ file_path: '/var/log/auth.log' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });

    it('allows non-absolute paths that happen to contain the same basename', async () => {
      // /etc/passwd is anchored at root — /project/etc/passwd must not match.
      const mw = createBlockedPathsMiddleware(stubPolicy(['/etc/passwd']));
      const ctx = freshCtx({ file_path: '/project/etc/passwd' });
      const nextCalled = await run(mw, ctx);
      expect(nextCalled).toBe(true);
      expect(ctx.status).toBe(InvocationStatus.Allowed);
    });

    it('absolute pattern does not match a relative basename occurrence', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['/etc/passwd']));
      const ctx = freshCtx({ file_path: 'etc/passwd' });
      const nextCalled = await run(mw, ctx);
      expect(nextCalled).toBe(true);
      expect(ctx.status).toBe(InvocationStatus.Allowed);
    });
  });

  // Finding 2 (high, verified): CONTENT_KEYS blanket skip-list false negatives.
  describe('CONTENT_KEYS: path-shape still wins over key name', () => {
    it('blocks {name: ".env"} even though `name` is a content-ish key', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
      const ctx = freshCtx({ name: '.env' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });

    it('blocks {value: "/etc/hosts"} under an absolute blocked entry', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['/etc/hosts']));
      const ctx = freshCtx({ value: '/etc/hosts' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });

    it('blocks path-shaped value under `tag` key', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
      const ctx = freshCtx({ tag: '/project/.env' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });

    it('blocks path-shaped value under `title` key', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
      const ctx = freshCtx({ title: '/app/.env' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });

    it('still skips prose values under content-ish keys (no path shape)', async () => {
      // Regression guard: BUG-001 fix must stay in place. Prose under a
      // content-ish key is never a path value, so it stays unscanned.
      const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
      const ctx = freshCtx({
        title: 'Working with .env files — best practices',
        description: 'environment variables and deployment notes',
      });
      const nextCalled = await run(mw, ctx);
      expect(nextCalled).toBe(true);
      expect(ctx.status).toBe(InvocationStatus.Allowed);
    });
  });

  // Finding 3 (high, verified, pre-existing): malformed URL-escape bypass.
  describe('URL-escape decode — .rea/ trust-root', () => {
    it('blocks `.rea/` via fully URL-encoded input (%2Erea%2Ffoo)', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy([]));
      const ctx = freshCtx({ file_path: '%2Erea%2Ffoo' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
      expect(ctx.error).toContain('.rea/');
    });

    it('blocks `.rea/` via mixed-encoded input (.%72ea/foo)', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy([]));
      const ctx = freshCtx({ file_path: '.%72ea/foo' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
      expect(ctx.error).toContain('.rea/');
    });

    it('fails closed on malformed %XX escape in a path-shaped value', async () => {
      // `.rea%ZZ/foo` has a lone `%` not followed by two hex digits.
      // Before this fix, decodeURIComponent threw, normalizePath swallowed,
      // and segments split to `.rea%zz` + `foo` — bypassing `.rea/`.
      // After this fix, the malformed escape is detected and request denied.
      const mw = createBlockedPathsMiddleware(stubPolicy([]));
      const ctx = freshCtx({ file_path: '.rea%ZZ/foo' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
      expect(ctx.error).toMatch(/malformed URL-escape/i);
    });

    it('fails closed on structurally-valid but utf-8-invalid escape', async () => {
      // %E0%A4%A is a truncated multi-byte UTF-8 sequence — decodeURIComponent
      // throws URIError. Previously silently passed through.
      const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
      const ctx = freshCtx({ file_path: '/project/%E0%A4%A.env' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });

    it('allows well-formed %-containing inputs unrelated to blocked paths', async () => {
      // %20 decodes to a space which is not path-shaped — skipped entirely.
      // A well-formed encoded path that does NOT match blocked patterns.
      const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
      const ctx = freshCtx({ file_path: '/project/src/index%2Ets' });
      const nextCalled = await run(mw, ctx);
      expect(nextCalled).toBe(true);
      expect(ctx.status).toBe(InvocationStatus.Allowed);
    });
  });
});

describe('blocked-paths middleware — Codex round-2 security findings', () => {
  // Finding 1 (HIGH): double-encoded path separator bypass.
  // %252F → first decodeURIComponent → %2F → second pass → /
  // Without the second decode pass, .rea%252Ffoo splits as ['.rea%2ffoo']
  // and never matches the '.rea/' pattern.
  describe('Finding 1 — double-encoding bypass (%252F)', () => {
    it('blocks .rea/ referenced via double-encoded separator (%252F)', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy([]));
      const ctx = freshCtx({ file_path: '.rea%252Ffoo' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });

    it('blocks .env referenced via double-encoded separator (%252F)', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
      const ctx = freshCtx({ file_path: '/project%252F.env' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });
  });

  // Finding 2 (MEDIUM): null-byte prefix evasion.
  // %00.gitignore → normalizePath decodes to \x00.gitignore → strip C0 → .gitignore
  // Without C0 stripping, the segment '\x00.gitignore' !== '.gitignore'.
  describe('Finding 2 — null-byte prefix evasion', () => {
    it('blocks .rea/ when referenced with a null-byte prefix (%00.rea/foo)', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy([]));
      const ctx = freshCtx({ file_path: '%00.rea/foo' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });

    it('blocks .env when value has null-byte prefix (%00.env)', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
      const ctx = freshCtx({ file_path: '%00.env' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });
  });

  // Finding 3 (MEDIUM): file:// URI scheme bypasses absolute patterns.
  // file:///etc/passwd → path.posix.normalize → file:/etc/passwd → segs[0]='file:'
  // Absolute pattern /etc/passwd never matched because 'file:' !== 'etc'.
  describe('Finding 3 — file:// URI scheme bypass', () => {
    it('blocks /etc/passwd when referenced as file:///etc/passwd', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['/etc/passwd']));
      const ctx = freshCtx({ file_path: 'file:///etc/passwd' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });

    it('blocks .rea/ when referenced as file:///project/.rea/policy.yaml', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy([]));
      const ctx = freshCtx({ file_path: 'file:///project/.rea/policy.yaml' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });
  });

  // Finding 4 (MEDIUM): intentional fail-closed behavior for bare % in paths.
  // /builds/50%complete/ contains `%co` where 'c' is hex but 'o' is not —
  // hasMalformedEscape returns true and the request is denied. This is
  // intentional: structurally ambiguous percent sequences are treated as hostile.
  // Callers that need a literal `%` must encode it as `%25`.
  describe('Finding 4 — intentional fail-closed on bare % (documented behavior)', () => {
    it('denies /builds/50%complete/ as a malformed URL-escape (intentional fail-closed)', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy([]));
      const ctx = freshCtx({ file_path: '/builds/50%complete/' });
      await run(mw, ctx);
      // Intentional: `%co` is not a valid %XX sequence (o is not hex).
      // This is known and accepted fail-closed behavior — not a false positive
      // to be fixed. Callers must percent-encode literal `%` as `%25`.
      expect(ctx.status).toBe(InvocationStatus.Denied);
      expect(ctx.error).toMatch(/malformed URL-escape/i);
    });

    it('allows /builds/50%25complete/ (correctly percent-encoded literal %)', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy([]));
      const ctx = freshCtx({ file_path: '/builds/50%25complete/' });
      const nextCalled = await run(mw, ctx);
      expect(nextCalled).toBe(true);
      expect(ctx.status).toBe(InvocationStatus.Allowed);
    });
  });
});

describe('blocked-paths middleware — Finding 1 round-3 — deeper encoding', () => {
  // GPT-5.4 Codex adversarial review finding: the two-pass logic closed
  // double-encoding (%252F) but not triple-encoding (%25252F) or deeper.
  // The iterative decode-until-stable loop (no cap) closes all depths.

  it('blocks .rea/ via triple-encoded separator (%25252F)', async () => {
    // .rea%25252Ffoo → first pass → .rea%252Ffoo → second pass → .rea%2Ffoo
    // → third pass → .rea/foo → matches .rea/ pattern
    const mw = createBlockedPathsMiddleware(stubPolicy([]));
    const ctx = freshCtx({ file_path: '.rea%25252Ffoo' });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('blocks .rea/ via quad-encoded separator (%2525252F)', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy([]));
    const ctx = freshCtx({ file_path: '.rea%2525252Ffoo' });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('blocks /etc/passwd when referenced as file://localhost/etc/passwd', async () => {
    // GPT-5.4 finding: file://localhost/etc/passwd was not stripped by the
    // triple-slash-only regex; authority `localhost` remained and foiled the
    // absolute-path pattern match. The new regex strips all authority forms.
    const mw = createBlockedPathsMiddleware(stubPolicy(['/etc/passwd']));
    const ctx = freshCtx({ file_path: 'file://localhost/etc/passwd' });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });

  it('blocks /etc/passwd when referenced as file:/etc/passwd (single-slash form)', async () => {
    // single-slash URI form was entirely unmatched by the triple-slash-only
    // regex, leaving the raw `file:/etc/passwd` value which does not match
    // the absolute pattern `/etc/passwd`.
    const mw = createBlockedPathsMiddleware(stubPolicy(['/etc/passwd']));
    const ctx = freshCtx({ file_path: 'file:/etc/passwd' });
    await run(mw, ctx);
    expect(ctx.status).toBe(InvocationStatus.Denied);
  });
});

describe('blocked-paths middleware — GPT-5.4 Codex round-4 security findings', () => {
  // Finding 1 [critical]: decode cap bypassable at depth 6+
  // The 5-pass cap meant .rea%25252525252Ffoo (6 encode levels) emerged as
  // .rea%2ffoo after 5 passes. The loop is now cap-free + hasDeepEncodedSeparator
  // catches any remaining %2f/%5c after the stable loop exits.
  describe('Finding 1 — depth-6+ encode bypass (no-cap loop + hasDeepEncodedSeparator)', () => {
    it('blocks .rea/ via 6-level encoded separator', async () => {
      // 6 encode levels: .rea%25252525252Ffoo
      // Previously: 5 passes → .rea%2ffoo → missed
      // Now: stable loop decodes fully → .rea/foo → Denied
      const mw = createBlockedPathsMiddleware(stubPolicy([]));
      const ctx = freshCtx({ file_path: '.rea%25252525252Ffoo' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });

    it('blocks .env via 6-level encoded separator', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
      const ctx = freshCtx({ file_path: '/project%25252525252F.env' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });

    it('blocks .rea/ via double-encoded separator in path component (%252f)', async () => {
      // .rea%252ffoo → pass 1 → .rea%2ffoo → pass 2 → .rea/foo → stable.
      // normalizePath fully decodes → segments ['.rea', 'foo'] → matches .rea/.
      // hasDeepEncodedSeparator provides defense-in-depth for residual %2f
      // that would survive a catch-early exit from the decode loop.
      const mw = createBlockedPathsMiddleware(stubPolicy([]));
      const ctx = freshCtx({ file_path: '.rea%252ffoo' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });
  });

  // Finding 2 [high]: file: URIs with query/fragment bypass exact blocked paths
  // file:///etc/passwd#x → after scheme strip → /etc/passwd#x →
  // posix.normalize keeps # in last segment → 'passwd#x' !== 'passwd'
  describe('Finding 2 — file: URI query/fragment bypass', () => {
    it('blocks /etc/passwd referenced as file:///etc/passwd#fragment', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['/etc/passwd']));
      const ctx = freshCtx({ file_path: 'file:///etc/passwd#fragment' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });

    it('blocks .env referenced as file:///project/.env?dl=1', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
      const ctx = freshCtx({ file_path: 'file:///project/.env?dl=1' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });

    it('blocks .env referenced as file:///project/.env?dl=1#section', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
      const ctx = freshCtx({ file_path: 'file:///project/.env?dl=1#section' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });

    it('blocks .rea/ referenced as file:///project/.rea/policy.yaml#top', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy([]));
      const ctx = freshCtx({ file_path: 'file:///project/.rea/policy.yaml#top' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });
  });

  // Finding 3 [medium]: non-file schemes collapsed to local paths → false positives
  // http://example.com/etc/passwd previously → /etc/passwd → Denied (wrong).
  // Now normalizePath returns '' for non-file schemes → Allowed (correct).
  describe('Finding 3 — non-file schemes are not local paths (false positive fix)', () => {
    it('allows http://example.com/etc/passwd — remote URL, not a local path', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['/etc/passwd']));
      const ctx = freshCtx({ url: 'http://example.com/etc/passwd' });
      const nextCalled = await run(mw, ctx);
      expect(nextCalled).toBe(true);
      expect(ctx.status).toBe(InvocationStatus.Allowed);
    });

    it('allows https://evil.com/.rea/policy.yaml — remote URL', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy([]));
      const ctx = freshCtx({ url: 'https://evil.com/.rea/policy.yaml' });
      const nextCalled = await run(mw, ctx);
      expect(nextCalled).toBe(true);
      expect(ctx.status).toBe(InvocationStatus.Allowed);
    });

    it('allows ftp://server/etc/passwd — remote URL', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['/etc/passwd']));
      const ctx = freshCtx({ url: 'ftp://server/etc/passwd' });
      const nextCalled = await run(mw, ctx);
      expect(nextCalled).toBe(true);
      expect(ctx.status).toBe(InvocationStatus.Allowed);
    });

    it('still denies file:///etc/passwd — local file URI', async () => {
      const mw = createBlockedPathsMiddleware(stubPolicy(['/etc/passwd']));
      const ctx = freshCtx({ url: 'file:///etc/passwd' });
      await run(mw, ctx);
      expect(ctx.status).toBe(InvocationStatus.Denied);
    });
  });
});
