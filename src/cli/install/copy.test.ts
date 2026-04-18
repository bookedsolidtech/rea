import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyArtifacts } from './copy.js';

describe('copyArtifacts', () => {
  let targetDir: string;

  beforeEach(async () => {
    targetDir = await fs.mkdtemp(path.join(os.tmpdir(), 'rea-copy-'));
  });

  afterEach(async () => {
    await fs.rm(targetDir, { recursive: true, force: true });
  });

  it('copies hooks/commands/agents into .claude/ and chmods hooks executable', async () => {
    const result = await copyArtifacts(targetDir, { force: false, yes: true });
    expect(result.copied.length).toBeGreaterThan(0);
    expect(result.overwritten).toHaveLength(0);

    // Hooks must be executable.
    const hookPath = path.join(targetDir, '.claude', 'hooks', 'dangerous-bash-interceptor.sh');
    const stat = await fs.stat(hookPath);
    expect(stat.mode & 0o111).toBeGreaterThan(0);

    // Agents must be present.
    const agent = path.join(targetDir, '.claude', 'agents', 'rea-orchestrator.md');
    expect((await fs.stat(agent)).isFile()).toBe(true);
  });

  it('skips existing files under --yes (no silent overwrite)', async () => {
    // First copy.
    await copyArtifacts(targetDir, { force: false, yes: true });
    // Mutate one file — simulates a consumer edit.
    const hookPath = path.join(targetDir, '.claude', 'hooks', 'dangerous-bash-interceptor.sh');
    await fs.writeFile(hookPath, '# user edit\n', 'utf8');

    const result = await copyArtifacts(targetDir, { force: false, yes: true });
    expect(result.copied).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);

    // User edit must still be intact.
    const content = await fs.readFile(hookPath, 'utf8');
    expect(content).toBe('# user edit\n');
  });

  it('--force overwrites existing files', async () => {
    await copyArtifacts(targetDir, { force: false, yes: true });
    const hookPath = path.join(targetDir, '.claude', 'hooks', 'dangerous-bash-interceptor.sh');
    await fs.writeFile(hookPath, '# user edit\n', 'utf8');

    const result = await copyArtifacts(targetDir, { force: true, yes: true });
    expect(result.overwritten.length).toBeGreaterThan(0);

    // User edit must NOT be intact under --force.
    const content = await fs.readFile(hookPath, 'utf8');
    expect(content).not.toBe('# user edit\n');
  });
});
