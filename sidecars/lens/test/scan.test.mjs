import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseFrontmatter,
  parseJsonc,
  redactHomePath,
  getEnabledPlugins,
  scanRules,
  scanSkills,
  scanAgents
} from '../lib/scan.mjs';

function createMockConfigEnv() {
  const root = mkdtempSync(join(tmpdir(), 'context-lens-test-'));
  const configDir = join(root, '.gemini', 'config');
  const builtinSkillsDir = join(root, '.gemini', 'antigravity', 'builtin', 'skills');

  mkdirSync(join(configDir, 'plugins', 'alpha-enabled', 'skills', 'alpha-skill'), { recursive: true });
  mkdirSync(join(configDir, 'plugins', 'alpha-enabled', 'rules'), { recursive: true });
  mkdirSync(join(configDir, 'plugins', 'alpha-enabled', 'agents'), { recursive: true });
  mkdirSync(join(configDir, 'plugins', 'beta-disabled', 'skills', 'beta-skill'), { recursive: true });
  mkdirSync(join(builtinSkillsDir, 'core-skill'), { recursive: true });

  // JSONC config with comments and trailing comma
  writeFileSync(join(configDir, 'config.json'), `{
    // test comment
    "plugins": {
      "alpha-enabled": { "enabled": true },
      "beta-disabled": { "enabled": false },
    }
  }`);

  writeFileSync(join(configDir, 'plugins', 'alpha-enabled', 'plugin.json'), JSON.stringify({
    name: 'alpha-enabled',
    description: 'Enabled test plugin'
  }));
  writeFileSync(join(configDir, 'plugins', 'alpha-enabled', 'rules', 'AGENTS.md'), '# Alpha Rules\nAlways test.');
  writeFileSync(join(configDir, 'plugins', 'alpha-enabled', 'skills', 'alpha-skill', 'SKILL.md'), `---
name: alpha-skill
description: Alpha skill description
---
# Alpha`);
  writeFileSync(join(configDir, 'plugins', 'alpha-enabled', 'agents', 'alpha-worker.md'), `---
name: alpha-worker
description: Alpha custom subagent
---
Prompt`);

  writeFileSync(join(configDir, 'plugins', 'beta-disabled', 'plugin.json'), JSON.stringify({
    name: 'beta-disabled',
    description: 'Disabled test plugin'
  }));
  writeFileSync(join(configDir, 'plugins', 'beta-disabled', 'skills', 'beta-skill', 'SKILL.md'), `---
name: beta-skill
description: Should not appear
---`);

  writeFileSync(join(builtinSkillsDir, 'core-skill', 'SKILL.md'), `---
name: core-skill
description: Builtin skill
---`);

  return { root, configDir, builtinSkillsDir };
}

test('parseFrontmatter extracts name and multiline/inline descriptions', () => {
  const md = `---
name: test-agent
description: >
  This is a multiline
  folded description for test.
---
# Body`;
  const fm = parseFrontmatter(md);
  assert.equal(fm.name, 'test-agent');
  assert.equal(fm.description, 'This is a multiline folded description for test.');

  const inline = parseFrontmatter('---\nname: "quick-skill"\ndescription: "A quick test skill."\n---');
  assert.equal(inline.name, 'quick-skill');
  assert.equal(inline.description, 'A quick test skill.');
});

test('parseJsonc strips comments and trailing commas', () => {
  const obj = parseJsonc('{\n  // comment\n  "name": "test-plugin",\n}');
  assert.equal(obj.name, 'test-plugin');
});

test('redactHomePath replaces home directory prefix with ~', () => {
  const redacted = redactHomePath('C:\\Users\\alice\\.gemini\\config\\rules\\AGENTS.md', 'C:\\Users\\alice');
  assert.equal(redacted, '~/.gemini/config/rules/AGENTS.md');
  assert.ok(!redacted.includes('alice'));
});

test('getEnabledPlugins, scanRules, scanSkills, and scanAgents work in isolated fixture on any PC', () => {
  const { root, configDir, builtinSkillsDir } = createMockConfigEnv();
  try {
    const plugins = getEnabledPlugins(configDir);
    const dirs = plugins.map(p => p.dir);
    assert.deepEqual(dirs, ['alpha-enabled']);

    const rules = scanRules(plugins, [], configDir);
    assert.equal(rules.length, 1);
    assert.equal(rules[0].label, 'alpha-enabled: AGENTS.md');

    const skills = scanSkills(plugins, builtinSkillsDir, configDir);
    const skillLabels = skills.map(s => s.label);
    assert.deepEqual(skillLabels, ['alpha-skill', 'core-skill']);

    const agents = scanAgents(plugins, configDir);
    assert.equal(agents.length, 1);
    assert.equal(agents[0].label, 'alpha-worker');
    assert.equal(agents[0].tokens, 10); // ceil((12 + 21 + 6) / 4)
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
