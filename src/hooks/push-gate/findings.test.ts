import { describe, expect, it } from 'vitest';
import { inferVerdict, parseFindings, summarizeReview } from './findings.js';

describe('parseFindings', () => {
  it('parses a single bulleted P1 finding with file:line location', () => {
    const text = `The patch is bad.

- [P1] Don't do the unsafe thing — src/bad.ts:42
  The body extends over
  multiple lines.
`;
    const findings = parseFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'P1',
      title: "Don't do the unsafe thing",
      file: 'src/bad.ts',
      line: 42,
    });
    expect(findings[0]?.body).toContain('multiple lines');
  });

  it('parses multiple findings of mixed severity', () => {
    const text = `Review comment:

- [P1] Critical issue — a.ts:1
  body A

- [P2] Significant concern — b.ts:20
  body B

- [P3] Nit — c.ts:5
  body C
`;
    const findings = parseFindings(text);
    expect(findings.map((f) => f.severity)).toEqual(['P1', 'P2', 'P3']);
    expect(findings.map((f) => f.file)).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('accepts a bare (non-bulleted) finding', () => {
    const text = `[P1] The thing — src/x.ts:9
  body
`;
    const findings = parseFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('P1');
  });

  it('accepts findings without a file:line location', () => {
    const text = `- [P2] High-level concern about the whole approach
  explanation
`;
    const findings = parseFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      severity: 'P2',
      title: 'High-level concern about the whole approach',
    });
    expect(findings[0]?.file).toBeUndefined();
  });

  it('ignores unknown severity markers (e.g. [P0], [P4])', () => {
    const text = `- [P4] Unknown severity — a.ts:1
- [P0] Also unknown — b.ts:1
- [P1] Real one — c.ts:1
`;
    const findings = parseFindings(text);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe('P1');
  });

  it('does NOT match severity markers inside the middle of a line', () => {
    const text = 'We found a [P1] issue inline, but this is prose not a marker.\n';
    const findings = parseFindings(text);
    expect(findings).toHaveLength(0);
  });

  it('returns an empty array for empty review text', () => {
    expect(parseFindings('')).toEqual([]);
    expect(parseFindings('The code looks good.\n\nNo findings.')).toEqual([]);
  });

  it('handles em-dash, double-dash, and single-dash separators', () => {
    const emDash = parseFindings('- [P1] Title — file.ts:1');
    const doubleDash = parseFindings('- [P1] Title -- file.ts:1');
    const singleDash = parseFindings('- [P1] Title - file.ts:1');
    expect(emDash[0]?.file).toBe('file.ts');
    expect(doubleDash[0]?.file).toBe('file.ts');
    expect(singleDash[0]?.file).toBe('file.ts');
  });

  it('preserves hyphens within a title (no whitespace around the dash)', () => {
    const findings = parseFindings('- [P1] pre-push hook broken — .husky/pre-push:1');
    expect(findings[0]?.title).toBe('pre-push hook broken');
    expect(findings[0]?.file).toBe('.husky/pre-push');
  });
});

describe('inferVerdict', () => {
  it('returns blocking when any P1 is present', () => {
    expect(
      inferVerdict([
        { severity: 'P3', title: 'a', body: 'a' },
        { severity: 'P1', title: 'b', body: 'b' },
      ]),
    ).toBe('blocking');
  });

  it('returns concerns when P2 is present but no P1', () => {
    expect(
      inferVerdict([
        { severity: 'P3', title: 'a', body: 'a' },
        { severity: 'P2', title: 'b', body: 'b' },
      ]),
    ).toBe('concerns');
  });

  it('returns pass when only P3 or empty', () => {
    expect(inferVerdict([{ severity: 'P3', title: 'nit', body: 'nit' }])).toBe('pass');
    expect(inferVerdict([])).toBe('pass');
  });
});

describe('summarizeReview', () => {
  it('wires parse + infer together', () => {
    const s = summarizeReview('- [P1] Broken thing — src/x.ts:1');
    expect(s.verdict).toBe('blocking');
    expect(s.findings).toHaveLength(1);
    expect(s.reviewText).toBe('- [P1] Broken thing — src/x.ts:1');
  });
});
