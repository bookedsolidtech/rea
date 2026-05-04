/**
 * Tests for `rea audit verify` collect-all-errors mode (Defect T / 0.10.2).
 *
 * Before 0.10.2 `rea audit verify` aborted at the first unparseable line with
 * a one-shot `Cannot parse JSON at audit.jsonl line N` error and exit 1. A
 * single corrupt line blocked verification over every legitimate record that
 * followed — which in the defect-T incident meant a stray backslash-u
 * sequence on one line hid several clean hash-chain tails from the operator.
 *
 * 0.10.2 contract:
 *
 *   1. The command walks the entire file (and all `--since` rotated files).
 *   2. EVERY malformed line is reported with `audit.jsonl:LINE[:COL]  <msg>`.
 *   3. Chain verification runs over the parseable subset. A tamper on the
 *      parseable subset is still reported, alongside the parse failures.
 *   4. Exit code is 1 if there is ANY parse failure OR any chain failure.
 *   5. A fully clean file still reports "Audit chain verified" and exits 0.
 *
 * The test drives `runAuditVerify` in-process rather than shelling out —
 * that mirrors the `runAuditRecordCodexReview` test pattern and lets us
 * assert against captured stderr without worrying about CLI argv parsing.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAuditVerify } from '../../src/cli/audit.js';
import { appendAuditRecord } from '../../src/audit/append.js';

interface CapturedIo {
  stdout: string;
  stderr: string;
  restore: () => void;
}

function captureIo(): CapturedIo {
  const captured = { stdout: '', stderr: '' };
  const stdoutSpy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured.stdout += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
  const stderrSpy = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((chunk: string | Uint8Array): boolean => {
      captured.stderr += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    });
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    captured.stdout += args.map(String).join(' ') + '\n';
  });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    captured.stderr += args.map(String).join(' ') + '\n';
  });
  return {
    get stdout() {
      return captured.stdout;
    },
    get stderr() {
      return captured.stderr;
    },
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      logSpy.mockRestore();
      errSpy.mockRestore();
    },
  } as CapturedIo;
}

/**
 * Wrap runAuditVerify so a `process.exit(code)` turns into a thrown marker
 * we can assert on. The real handler calls `process.exit(1)` on any failure,
 * which would tear down the test runner if we let it through.
 */
async function runVerify(): Promise<{ exitCode: number | null }> {
  let exitCode: number | null = null;
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`__exit__${exitCode}`);
  }) as never);
  try {
    await runAuditVerify({});
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('__exit__')) throw e;
  } finally {
    exitSpy.mockRestore();
  }
  return { exitCode };
}

describe('runAuditVerify — defect T collect-all-errors mode', () => {
  let baseDir: string;
  let previousCwd: string;
  let io: CapturedIo;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-verify-T-'));
    baseDir = await fs.realpath(baseDir);
    await fs.mkdir(path.join(baseDir, '.rea'), { recursive: true });
    previousCwd = process.cwd();
    process.chdir(baseDir);
    io = captureIo();
  });

  afterEach(async () => {
    io.restore();
    process.chdir(previousCwd);
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  it('reports every malformed line with line number and exits 1 (mixed valid + malformed)', async () => {
    // Emit two real records so the prev_hash chain has real entries.
    await appendAuditRecord(baseDir, { tool_name: 'real.one', server_name: 'unit' });
    await appendAuditRecord(baseDir, { tool_name: 'real.two', server_name: 'unit' });

    // Splice two malformed lines between the valid records and at the tail.
    // Direct write is the only way to simulate external corruption — the
    // public helper's defect-T self-check prevents the same shape from
    // reaching disk through it.
    const auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
    const original = await fs.readFile(auditFile, 'utf8');
    const [lineOne, lineTwo] = original.split('\n').filter((l) => l.length > 0);
    const corrupted = [lineOne, '{not-json-at-all', lineTwo, '{"incomplete":', ''].join('\n');
    await fs.writeFile(auditFile, corrupted);

    const { exitCode } = await runVerify();
    expect(exitCode).toBe(1);

    // Every malformed line is named, with its 1-based file line number.
    // File layout: 1=real.one, 2=malformed, 3=real.two, 4=malformed, 5=empty-trailing.
    // The trailing empty line is dropped by the leading \n-trim; line 2 and
    // line 4 are the two failures. (If the splitter kept a mid-file blank,
    // that would land here too — the verifier is explicit about it.)
    expect(io.stderr).toContain('2 unparseable line(s) detected');
    expect(io.stderr).toMatch(/audit\.jsonl:2\b/);
    expect(io.stderr).toMatch(/audit\.jsonl:4\b/);

    // The "verified … clean" success banner must NOT appear — any failure
    // class suppresses it.
    expect(io.stdout).not.toMatch(/Audit chain verified/);
  });

  it('chain-verifies the parseable subset and reports a tamper alongside parse failures', async () => {
    // Three real records, then corrupt a byte inside the SECOND record's
    // stored hash, and splice one malformed line AFTER the tamper. Both
    // failures must surface in a single run.
    await appendAuditRecord(baseDir, { tool_name: 'real.one', server_name: 'unit' });
    await appendAuditRecord(baseDir, { tool_name: 'real.two', server_name: 'unit' });
    await appendAuditRecord(baseDir, { tool_name: 'real.three', server_name: 'unit' });

    const auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
    const originalLines = (await fs.readFile(auditFile, 'utf8'))
      .split('\n')
      .filter((l) => l.length > 0);
    expect(originalLines).toHaveLength(3);

    // Corrupt the second record's hash. Any byte inside `"hash":"<sha256>"`
    // works; flipping the final hex character is the smallest possible
    // tamper.
    const tampered = originalLines[1]!.replace(/"hash":"([0-9a-f]+)"/, (_match, h: string) => {
      const flipped = h.slice(0, -1) + (h.endsWith('0') ? '1' : '0');
      return `"hash":"${flipped}"`;
    });
    expect(tampered).not.toBe(originalLines[1]);

    const corrupted = [
      originalLines[0],
      tampered,
      originalLines[2],
      '{"unterminated', // intentional parse failure at line 4
      '',
    ].join('\n');
    await fs.writeFile(auditFile, corrupted);

    const { exitCode } = await runVerify();
    expect(exitCode).toBe(1);

    // Parse failure block: one line reported.
    expect(io.stderr).toContain('1 unparseable line(s) detected');
    expect(io.stderr).toMatch(/audit\.jsonl:4\b/);

    // Chain tamper block: the tamper on line 2 surfaces as index 1 within
    // the parseable subset AND line 2 in the original file. The reason
    // names hash-vs-recomputed OR prev_hash-mismatch (either is acceptable —
    // flipping a stored hash breaks the self-hash check, but the tamper
    // also breaks the NEXT record's prev_hash anchor; either is the first
    // failure seen).
    expect(io.stderr).toContain('TAMPER DETECTED');
    expect(io.stderr).toMatch(/Record index:\s+\d+ \(0-based within parseable subset\)/);
    expect(io.stderr).toMatch(/File line:\s+\d+ \(1-based in audit\.jsonl\)/);
  });

  it('reports the ORIGINAL file line for a tamper that sits after a malformed line (concern 2)', async () => {
    // Regression case for Codex concern #2 on the T/U 0.10.2 pass: when a
    // malformed line appears BEFORE the tampered record, the parseable-
    // subset index diverges from the original file line number. Operators
    // jumping to the failure with an editor or `sed -n Np` need the file
    // line, not the subset index.
    //
    // Layout:
    //   file line 1: real.one   (valid, parseable-subset index 0)
    //   file line 2: MALFORMED  (parse failure)
    //   file line 3: real.two   (valid, parseable-subset index 1) — TAMPERED
    //   file line 4: real.three (valid, parseable-subset index 2)
    //
    // Without the recordLineMap fix, the chain failure would report
    // "Record index: 1" which is ambiguous — subset position 1 is file
    // line 3, not file line 1. With the fix we also print "File line: 3".
    await appendAuditRecord(baseDir, { tool_name: 'real.one', server_name: 'unit' });
    await appendAuditRecord(baseDir, { tool_name: 'real.two', server_name: 'unit' });
    await appendAuditRecord(baseDir, { tool_name: 'real.three', server_name: 'unit' });

    const auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
    const originalLines = (await fs.readFile(auditFile, 'utf8'))
      .split('\n')
      .filter((l) => l.length > 0);
    expect(originalLines).toHaveLength(3);

    // Tamper real.two (originalLines[1]).
    const tampered = originalLines[1]!.replace(
      /"hash":"([0-9a-f]+)"/,
      (_m, h: string) => `"hash":"${h.slice(0, -1)}${h.endsWith('0') ? '1' : '0'}"`,
    );
    expect(tampered).not.toBe(originalLines[1]);

    // Splice a malformed line BEFORE the tamper.
    const corrupted = [originalLines[0], '{not-json', tampered, originalLines[2], ''].join('\n');
    await fs.writeFile(auditFile, corrupted);

    const { exitCode } = await runVerify();
    expect(exitCode).toBe(1);

    // Parse failure on file line 2.
    expect(io.stderr).toMatch(/audit\.jsonl:2\b/);
    // Tamper: parseable-subset index 1 (zero-based among the 3 parseable
    // records), BUT original-file line 3. Both must appear.
    expect(io.stderr).toContain('TAMPER DETECTED');
    expect(io.stderr).toMatch(/Record index:\s+1\b/);
    expect(io.stderr).toMatch(/File line:\s+3\b/);
  });

  it('reports a clean file on exit 0 with no parse or chain findings', async () => {
    await appendAuditRecord(baseDir, { tool_name: 'real.one', server_name: 'unit' });
    await appendAuditRecord(baseDir, { tool_name: 'real.two', server_name: 'unit' });

    const { exitCode } = await runVerify();
    expect(exitCode).toBeNull();
    expect(io.stdout).toMatch(/Audit chain verified: 2 records/);
    expect(io.stderr).not.toContain('unparseable');
    expect(io.stderr).not.toContain('TAMPER');
  });

  it('treats mid-file empty lines as parse failures (distinct from record absence)', async () => {
    await appendAuditRecord(baseDir, { tool_name: 'real.one', server_name: 'unit' });
    await appendAuditRecord(baseDir, { tool_name: 'real.two', server_name: 'unit' });

    const auditFile = path.join(baseDir, '.rea', 'audit.jsonl');
    const originalLines = (await fs.readFile(auditFile, 'utf8'))
      .split('\n')
      .filter((l) => l.length > 0);
    // Splice an empty line between the two records.
    const corrupted = [originalLines[0], '', originalLines[1], ''].join('\n');
    await fs.writeFile(auditFile, corrupted);

    const { exitCode } = await runVerify();
    expect(exitCode).toBe(1);
    expect(io.stderr).toContain('1 unparseable line(s) detected');
    expect(io.stderr).toMatch(/audit\.jsonl:2\b/);
  });
});
