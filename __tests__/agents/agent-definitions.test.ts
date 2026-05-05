/**
 * Agent-definitions contract test (0.24.0 roster expansion, Class M-adjacent).
 *
 * The canonical roster lives at `agents/*.md` (mirrored byte-identically
 * to `.claude/agents/*.md` by `rea init` / `rea upgrade`; the dogfood
 * drift gate already pins that mirror).
 *
 * This test pins three additional invariants on the canonical surface:
 *
 *   1. Every `agents/*.md` parses cleanly: a `---` frontmatter block at
 *      file start, valid YAML inside, with required `name` and
 *      `description` fields. A typo in the frontmatter delimiter or a
 *      missing field would otherwise ship silently — the harness
 *      tolerates malformed agent files at load time.
 *
 *   2. Every agent file's `name:` matches its filename (sans `.md`).
 *      The Claude Code harness routes by `subagent_type: "<name>"`, so
 *      a name/filename mismatch silently disables routing for that
 *      agent (orchestrator delegations to it would fail to dispatch).
 *
 *   3. Every agent in `agents/` is referenced by name in
 *      `agents/rea-orchestrator.md`'s curated-roster section. Adding a
 *      new agent without updating the orchestrator's routing brief
 *      means orchestrator invocations will not know the agent exists.
 *      This test fails CI if a new file lands without the routing
 *      entry.
 *
 * Wave 1 (0.24.0) added 4 agents: principal-engineer,
 * principal-product-engineer, release-captain, security-architect.
 * Wave 2 (0.25.0, 4 architects) and Wave 3 (0.26.0, 5 specialists)
 * will extend the roster further. This test will flag every new
 * file the same way.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const ORCHESTRATOR_PATH = path.join(AGENTS_DIR, 'rea-orchestrator.md');

interface ParsedAgent {
  filename: string;
  basename: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Parse the leading `---\n…\n---\n` frontmatter block. Returns null if
 * the file has no frontmatter or the block is malformed. Intentionally
 * strict — silent acceptance of malformed frontmatter is exactly the
 * failure mode this test prevents.
 */
function parseFrontmatter(source: string): { fm: Record<string, unknown>; body: string } | null {
  if (!source.startsWith('---\n')) return null;
  const closeIdx = source.indexOf('\n---\n', 4);
  if (closeIdx === -1) return null;
  const yamlText = source.slice(4, closeIdx);
  const body = source.slice(closeIdx + 5);
  try {
    const fm = parseYaml(yamlText) as Record<string, unknown>;
    if (!fm || typeof fm !== 'object') return null;
    return { fm, body };
  } catch {
    return null;
  }
}

function loadAgents(): ParsedAgent[] {
  const entries = fs.readdirSync(AGENTS_DIR);
  const mdFiles = entries.filter((f) => f.endsWith('.md')).sort();
  return mdFiles.map((filename) => {
    const full = path.join(AGENTS_DIR, filename);
    const source = fs.readFileSync(full, 'utf8');
    const parsed = parseFrontmatter(source);
    if (!parsed) {
      throw new Error(
        `[agent-definitions] ${filename}: no parseable frontmatter — must start with '---\\n…\\n---\\n' and contain valid YAML`,
      );
    }
    return {
      filename,
      basename: filename.replace(/\.md$/, ''),
      frontmatter: parsed.fm,
      body: parsed.body,
    };
  });
}

describe('agent definitions contract', () => {
  const agents = loadAgents();

  it('discovers at least the Wave 2 expanded roster (17 agents)', () => {
    // Hard floor — additions are fine; deletions need an explicit
    // memory entry, so we enforce the lower bound. Bumped Wave 1 (14)
    // → Wave 2 (17, +3 architects). Will bump again at Wave 3 (22).
    expect(agents.length).toBeGreaterThanOrEqual(17);
  });

  it('every agent has required frontmatter fields', () => {
    for (const agent of agents) {
      const { name, description } = agent.frontmatter as { name?: unknown; description?: unknown };
      expect(typeof name, `${agent.filename}: name must be a string`).toBe('string');
      expect(typeof description, `${agent.filename}: description must be a string`).toBe('string');
      expect(
        (name as string).length,
        `${agent.filename}: name must be non-empty`,
      ).toBeGreaterThan(0);
      expect(
        (description as string).length,
        `${agent.filename}: description must be non-empty`,
      ).toBeGreaterThan(0);
    }
  });

  it("every agent's name matches its filename", () => {
    for (const agent of agents) {
      const name = agent.frontmatter.name as string;
      expect(
        name,
        `${agent.filename}: frontmatter name "${name}" must match filename "${agent.basename}"`,
      ).toBe(agent.basename);
    }
  });

  it('orchestrator routing brief mentions every other agent by name', () => {
    // The orchestrator does not list itself in its curated roster — it
    // IS the router. Every OTHER agent must be referenced by bolded
    // name (the form `**<name>** — purpose` used in both the curated-
    // roster and routing-tiers cheat-sheet sections).
    const orchestratorSource = fs.readFileSync(ORCHESTRATOR_PATH, 'utf8');
    const missing: string[] = [];
    for (const agent of agents) {
      if (agent.basename === 'rea-orchestrator') continue;
      const needle = `**${agent.basename}**`;
      if (!orchestratorSource.includes(needle)) {
        missing.push(agent.basename);
      }
    }
    expect(
      missing,
      `agents/rea-orchestrator.md curated roster must mention every non-orchestrator agent by bolded name. Missing: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  it('Wave 1 agents are present (regression pin)', () => {
    const names = new Set(agents.map((a) => a.basename));
    for (const required of [
      'principal-engineer',
      'principal-product-engineer',
      'release-captain',
      'security-architect',
    ]) {
      expect(names.has(required), `${required}.md must exist in agents/`).toBe(true);
    }
  });

  it('Wave 2 architects are present (regression pin)', () => {
    // 0.25.0 roster expansion — 3 architect agents added per the CTO
    // eval recommendation. data-architect owns persisted shape and
    // migrations, platform-architect owns the build/CI/publish
    // pipeline, devex-architect owns the consumer install / doctor /
    // error-string surface. Their absence indicates the roster was
    // shrunk without an explicit memory entry.
    const names = new Set(agents.map((a) => a.basename));
    for (const required of ['data-architect', 'platform-architect', 'devex-architect']) {
      expect(names.has(required), `${required}.md must exist in agents/`).toBe(true);
    }
  });
});
