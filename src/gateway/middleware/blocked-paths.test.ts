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

  it('does NOT scan CONTENT_KEYS even when value looks path-shaped', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ message: '/home/user/.env' });
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
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
    // We do not require a specific allow/deny here — just that we neither
    // throw nor leave the ctx in an inconsistent state. The important property
    // is that decoding failure does not crash the middleware.
    await expect(run(mw, ctx)).resolves.toBeDefined();
  });

  it('ignores non-string arg values (numbers, booleans, null)', async () => {
    const mw = createBlockedPathsMiddleware(stubPolicy(['.env']));
    const ctx = freshCtx({ count: 5, enabled: true, meta: null, file_path: '/ok.ts' });
    const nextCalled = await run(mw, ctx);
    expect(nextCalled).toBe(true);
    expect(ctx.status).toBe(InvocationStatus.Allowed);
  });
});
