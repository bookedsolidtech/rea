/**
 * Unit tests for `errors.ts`. Error classes are a stable API surface — the
 * CLI dispatch layer catches on class identity, and audit metadata embeds
 * `code` as a stable string. Regressions here break the shim contract.
 */

import { describe, expect, it } from 'vitest';
import {
  BlockedError,
  DeletionBlockedError,
  HeadRefspecBlockedError,
  InvalidDeleteRefspecError,
  NoBaseResolvableError,
  ReviewGateError,
} from './errors.js';

describe('ReviewGateError', () => {
  it('is an Error subclass', () => {
    const e = new ReviewGateError('PUSH_BLOCKED_DELETE', 'msg', 2);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(ReviewGateError);
    expect(e.code).toBe('PUSH_BLOCKED_DELETE');
    expect(e.message).toBe('msg');
    expect(e.exitCode).toBe(2);
  });

  it('carries details through to the caller', () => {
    const e = new ReviewGateError('PUSH_BLOCKED_HEAD_REFSPEC', 'msg', 2, { spec: 'HEAD:main' });
    expect(e.details).toEqual({ spec: 'HEAD:main' });
  });
});

describe('BlockedError', () => {
  it('exits with code 2 (parity with bash core)', () => {
    const e = new BlockedError('PUSH_BLOCKED_DELETE', 'blocked');
    expect(e.exitCode).toBe(2);
    expect(e).toBeInstanceOf(ReviewGateError);
  });
});

describe('DeletionBlockedError (defect J)', () => {
  it('has a stable code and exit 2', () => {
    const e = new DeletionBlockedError();
    expect(e.code).toBe('PUSH_BLOCKED_DELETE');
    expect(e.exitCode).toBe(2);
  });

  it('message mentions branch deletion + manual action', () => {
    const e = new DeletionBlockedError();
    expect(e.message).toContain('branch deletion');
    expect(e.message).toContain('manually');
  });
});

describe('HeadRefspecBlockedError', () => {
  it('carries the offending spec in details', () => {
    const e = new HeadRefspecBlockedError('HEAD:main');
    expect(e.details).toEqual({ spec: 'HEAD:main' });
    expect(e.message).toContain('HEAD:main');
  });
});

describe('InvalidDeleteRefspecError (bash-core parity §161-168)', () => {
  it('distinguishes the delete-mode HEAD error from the general HeadRefspecBlockedError', () => {
    const e = new InvalidDeleteRefspecError(':HEAD');
    expect(e).toBeInstanceOf(BlockedError);
    expect(e.code).toBe('PUSH_BLOCKED_HEAD_REFSPEC');
    expect(e.exitCode).toBe(2);
    expect(e.details).toMatchObject({ spec: ':HEAD', mode: 'delete' });
  });

  it('carries the offending spec in the message', () => {
    const e = new InvalidDeleteRefspecError(':');
    expect(e.message).toContain('--delete refspec resolves to HEAD or empty');
    expect(e.message).toContain('":"');
  });
});

describe('NoBaseResolvableError (defect N completion — phase 4)', () => {
  it('carries the source branch in details', () => {
    const e = new NoBaseResolvableError('feature/foo');
    expect(e.details).toEqual({ source: 'feature/foo' });
    expect(e.code).toBe('PUSH_BLOCKED_NO_BASE_RESOLVABLE');
    expect(e.exitCode).toBe(2);
  });

  it('message references the two recovery hints operators must run', () => {
    const e = new NoBaseResolvableError('feature/foo');
    expect(e.message).toContain('git branch --set-upstream-to');
    expect(e.message).toContain('git config branch.');
  });
});
