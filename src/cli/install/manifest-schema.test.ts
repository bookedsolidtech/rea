import { describe, expect, it } from 'vitest';
import { InstallManifestSchema, ManifestEntrySchema } from './manifest-schema.js';

const okEntry = (overrides: Record<string, unknown> = {}) => ({
  path: '.claude/hooks/secret-scanner.sh',
  sha256: 'a'.repeat(64),
  source: 'hook',
  mode: 0o755,
  ...overrides,
});

describe('ManifestEntrySchema — path validation', () => {
  it('accepts a plain relative path', () => {
    expect(() => ManifestEntrySchema.parse(okEntry())).not.toThrow();
  });

  it('accepts the two synthetic entries with `#`', () => {
    expect(() =>
      ManifestEntrySchema.parse(
        okEntry({ path: 'CLAUDE.md#rea:managed:v1', source: 'claude-md' }),
      ),
    ).not.toThrow();
    expect(() =>
      ManifestEntrySchema.parse(
        okEntry({
          path: '.claude/settings.json#rea:desired',
          source: 'settings',
        }),
      ),
    ).not.toThrow();
  });

  it('rejects absolute POSIX path', () => {
    expect(() =>
      ManifestEntrySchema.parse(okEntry({ path: '/etc/passwd' })),
    ).toThrow(/relative/);
  });

  it('rejects absolute Windows drive letter', () => {
    expect(() =>
      ManifestEntrySchema.parse(okEntry({ path: 'C:\\Windows\\System32' })),
    ).toThrow(/relative/);
  });

  it('rejects leading backslash (Windows UNC-style)', () => {
    expect(() =>
      ManifestEntrySchema.parse(okEntry({ path: '\\hosts\\c$\\boot.ini' })),
    ).toThrow(/relative/);
  });

  it('rejects `..` in POSIX form', () => {
    expect(() =>
      ManifestEntrySchema.parse(okEntry({ path: '../../../etc/shadow' })),
    ).toThrow(/relative/);
  });

  it('rejects `..` in Windows form', () => {
    expect(() =>
      ManifestEntrySchema.parse(okEntry({ path: 'foo\\..\\..\\etc' })),
    ).toThrow(/relative/);
  });

  it('rejects embedded NUL byte', () => {
    expect(() =>
      ManifestEntrySchema.parse(okEntry({ path: 'hooks/ok\x00.sh' })),
    ).toThrow(/control characters/);
  });

  it('rejects ANSI escape (terminal corruption vector)', () => {
    expect(() =>
      ManifestEntrySchema.parse(okEntry({ path: 'hooks/\x1b[31mred.sh' })),
    ).toThrow(/control characters/);
  });

  it('rejects DEL (0x7f)', () => {
    expect(() =>
      ManifestEntrySchema.parse(okEntry({ path: 'hooks/sneaky\x7f.sh' })),
    ).toThrow(/control characters/);
  });

  it('rejects unknown source kinds', () => {
    expect(() =>
      ManifestEntrySchema.parse(okEntry({ source: 'payload' })),
    ).toThrow();
  });

  it('rejects invalid sha256 shape (uppercase hex)', () => {
    expect(() =>
      ManifestEntrySchema.parse(okEntry({ sha256: 'A'.repeat(64) })),
    ).toThrow(/lowercase hex/);
  });

  it('rejects sha256 of wrong length', () => {
    expect(() =>
      ManifestEntrySchema.parse(okEntry({ sha256: 'a'.repeat(63) })),
    ).toThrow();
  });

  it('rejects unknown fields (strict schema)', () => {
    expect(() =>
      ManifestEntrySchema.parse({ ...okEntry(), rogue_field: true }),
    ).toThrow();
  });
});

describe('InstallManifestSchema — strict parse', () => {
  const ok = () => ({
    version: '0.2.0',
    profile: 'bst-internal',
    installed_at: '2026-04-18T00:00:00.000Z',
    files: [okEntry()],
  });

  it('accepts a minimal valid manifest', () => {
    expect(() => InstallManifestSchema.parse(ok())).not.toThrow();
  });

  it('accepts upgraded_at and bootstrap flags', () => {
    expect(() =>
      InstallManifestSchema.parse({
        ...ok(),
        upgraded_at: '2026-04-19T00:00:00.000Z',
        bootstrap: true,
      }),
    ).not.toThrow();
  });

  it('rejects unknown top-level fields', () => {
    expect(() =>
      InstallManifestSchema.parse({ ...ok(), reviewer_shadow: 'attacker' }),
    ).toThrow();
  });

  it('rejects empty version string', () => {
    expect(() =>
      InstallManifestSchema.parse({ ...ok(), version: '' }),
    ).toThrow();
  });

  it('propagates entry-level path rejection', () => {
    expect(() =>
      InstallManifestSchema.parse({
        ...ok(),
        files: [okEntry({ path: '../../../escape' })],
      }),
    ).toThrow(/relative/);
  });
});
