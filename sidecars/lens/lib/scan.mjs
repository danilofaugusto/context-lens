import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export function redactHomePath(fullPath, home = homedir()) {
  if (!fullPath) return '';
  const normFull = String(fullPath).replace(/\\/g, '/');
  const normHome = String(home || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const caseInsensitive = /^[a-z]:\//i.test(normHome);
  const fullCmp = caseInsensitive ? normFull.toLowerCase() : normFull;
  const homeCmp = caseInsensitive ? normHome.toLowerCase() : normHome;
  if (normHome && fullCmp.startsWith(homeCmp)) {
    const rest = normFull.slice(normHome.length);
    if (rest === '' || rest.startsWith('/')) return '~' + rest;
  }
  return normFull;
}

export function parseJsonc(text) {
  const src = String(text || '');
  let noComments = '';
  for (let i = 0, inStr = false; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      noComments += ch;
      if (ch === '\\') noComments += src[++i] ?? '';
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      noComments += ch;
    } else if (ch === '/' && src[i + 1] === '/') {
      while (i + 1 < src.length && src[i + 1] !== '\n') i++;
    } else if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 1;
    } else {
      noComments += ch;
    }
  }
  let out = '';
  for (let i = 0, inStr = false; i < noComments.length; i++) {
    const ch = noComments[i];
    if (inStr) {
      out += ch;
      if (ch === '\\') out += noComments[++i] ?? '';
      else if (ch === '"') inStr = false;
    } else if (ch === '"') {
      inStr = true;
      out += ch;
    } else if (ch === ',' && /^\s*[}\]]/.test(noComments.slice(i + 1))) {
      // drop trailing comma
    } else {
      out += ch;
    }
  }
  return JSON.parse(out);
}

export function parseFrontmatter(text) {
  const m = String(text || '').replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return { name: '', description: '' };
  const yaml = m[1];
  let name = '';
  let description = '';

  const nameMatch = yaml.match(/^name:[ \t]*(.*)$/m);
  if (nameMatch) {
    name = nameMatch[1].trim().replace(/^['"]|['"]$/g, '');
  }

  const descIndex = yaml.search(/^description:/m);
  if (descIndex !== -1) {
    const afterDesc = yaml.slice(descIndex).replace(/^description:[ \t]*/, '');
    const firstLineEnd = afterDesc.indexOf('\n');
    const firstLine = (firstLineEnd === -1 ? afterDesc : afterDesc.slice(0, firstLineEnd)).trim();
    if (/^[>|][+-]?\d?[+-]?$/.test(firstLine) || firstLine === '') {
      const rest = firstLineEnd === -1 ? '' : afterDesc.slice(firstLineEnd + 1);
      const lines = [];
      for (const line of rest.split(/\r?\n/)) {
        if (line.trim() === '') continue;
        if (/^\s+/.test(line)) {
          lines.push(line.trim());
        } else {
          break;
        }
      }
      description = lines.filter(Boolean).join(' ').trim();
    } else {
      description = firstLine.replace(/^['"]|['"]$/g, '');
    }
  }

  return { name, description };
}

export function getEnabledPlugins(configDir = join(homedir(), '.gemini', 'config')) {
  let pluginsConfig = {};
  const configFile = join(configDir, 'config.json');
  if (existsSync(configFile)) {
    try {
      const cfg = parseJsonc(readFileSync(configFile, 'utf8'));
      pluginsConfig = cfg.plugins || {};
    } catch {
      pluginsConfig = {};
    }
  }

  const pluginsDir = join(configDir, 'plugins');
  if (!existsSync(pluginsDir)) return [];

  const results = [];
  try {
    const entries = readdirSync(pluginsDir, { withFileTypes: true });
    for (const ent of entries) {
      if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
      const dir = ent.name;
      const manifestPath = join(pluginsDir, dir, 'plugin.json');
      if (!existsSync(manifestPath)) continue;

      let pluginJson = {};
      try {
        pluginJson = parseJsonc(readFileSync(manifestPath, 'utf8'));
      } catch {
        pluginJson = {};
      }

      let isEnabled = true;
      if (Object.hasOwn(pluginsConfig, dir) && pluginsConfig[dir] && typeof pluginsConfig[dir].enabled === 'boolean') {
        isEnabled = pluginsConfig[dir].enabled;
      } else if (typeof pluginJson.disabled === 'boolean') {
        isEnabled = !pluginJson.disabled;
      }

      if (isEnabled) {
        results.push({
          dir,
          name: pluginJson.name || dir,
          path: join(pluginsDir, dir)
        });
      }
    }
  } catch {
    // Return whatever was collected
  }

  return results;
}

export function scanRules(
  enabledPlugins,
  workspaceDirs = [],
  configDir = join(homedir(), '.gemini', 'config')
) {
  const rules = [];
  const seenPaths = new Set();

  function addRuleFile(filePath, labelPrefix) {
    if (!existsSync(filePath)) return;
    try {
      const fullPath = resolve(filePath);
      if (seenPaths.has(fullPath)) return;
      const st = statSync(fullPath);
      if (!st.isFile()) return;
      seenPaths.add(fullPath);
      rules.push({
        label: `${labelPrefix}: ${basename(fullPath)}`,
        hint: redactHomePath(fullPath),
        tokens: Math.ceil(st.size / 4)
      });
    } catch {}
  }

  // Standalone user rules (~/.gemini/GEMINI.md and ~/.gemini/config/rules/*.md)
  if (configDir) {
    addRuleFile(join(configDir, '..', 'GEMINI.md'), 'global');
    const globalRulesDir = join(configDir, 'rules');
    if (existsSync(globalRulesDir)) {
      try {
        for (const f of readdirSync(globalRulesDir, { withFileTypes: true })) {
          if (f.isFile() && f.name.endsWith('.md')) {
            addRuleFile(join(globalRulesDir, f.name), 'global');
          }
        }
      } catch {}
    }
  }

  for (const plugin of enabledPlugins || []) {
    const rulesDir = join(plugin.path, 'rules');
    if (!existsSync(rulesDir)) continue;
    try {
      const files = readdirSync(rulesDir, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.md')) continue;
        addRuleFile(join(rulesDir, f.name), plugin.name || plugin.dir);
      }
    } catch {}
  }

  for (const ws of workspaceDirs || []) {
    if (!ws) continue;
    addRuleFile(join(ws, 'AGENTS.md'), 'workspace');
    addRuleFile(join(ws, 'GEMINI.md'), 'workspace');
    const rulesSubdir = join(ws, '.agents', 'rules');
    if (existsSync(rulesSubdir)) {
      try {
        const rFiles = readdirSync(rulesSubdir, { withFileTypes: true });
        for (const rf of rFiles) {
          if (rf.isFile() && rf.name.endsWith('.md')) {
            addRuleFile(join(rulesSubdir, rf.name), 'workspace');
          }
        }
      } catch {}
    }
  }

  return rules;
}

export function scanSkills(
  enabledPlugins,
  builtinSkillsDir = join(homedir(), '.gemini', 'antigravity', 'builtin', 'skills'),
  configDir = join(homedir(), '.gemini', 'config')
) {
  const skills = [];
  const seenNames = new Set();

  function scanSkillsFolder(folderPath) {
    if (!existsSync(folderPath)) return;
    try {
      const entries = readdirSync(folderPath, { withFileTypes: true });
      for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const skillMd = join(folderPath, ent.name, 'SKILL.md');
        if (!existsSync(skillMd)) continue;

        try {
          const content = readFileSync(skillMd, 'utf8');
          const fm = parseFrontmatter(content);
          const name = fm.name || ent.name;
          if (seenNames.has(name)) continue;
          seenNames.add(name);

          const desc = fm.description || '';
          const fullPath = resolve(skillMd);
          const safePath = redactHomePath(fullPath);
          const tokens = Math.ceil((name.length + desc.length + fullPath.length + 30) / 4);
          skills.push({
            label: name,
            hint: desc || safePath,
            tokens
          });
        } catch {}
      }
    } catch {}
  }

  if (builtinSkillsDir && existsSync(builtinSkillsDir)) {
    scanSkillsFolder(builtinSkillsDir);
  }

  if (configDir) {
    scanSkillsFolder(join(configDir, 'skills'));
  }

  for (const plugin of enabledPlugins || []) {
    const pluginSkillsDir = join(plugin.path, 'skills');
    scanSkillsFolder(pluginSkillsDir);
  }

  skills.sort((a, b) => a.label.localeCompare(b.label));
  return skills;
}

export function scanAgents(enabledPlugins, configDir = join(homedir(), '.gemini', 'config')) {
  const agents = [];
  const seenNames = new Set();

  function scanAgentsFolder(folderPath, pluginName) {
    if (!existsSync(folderPath)) return;
    try {
      const files = readdirSync(folderPath, { withFileTypes: true });
      for (const f of files) {
        if (!f.isFile() || !f.name.endsWith('.md')) continue;
        const fullPath = resolve(join(folderPath, f.name));
        try {
          const content = readFileSync(fullPath, 'utf8');
          const fm = parseFrontmatter(content);
          const name = fm.name || basename(f.name, '.md');
          if (seenNames.has(name)) continue;
          seenNames.add(name);

          const desc = fm.description || '';
          const tokens = Math.ceil((name.length + desc.length + 6) / 4);
          agents.push({
            label: name,
            hint: pluginName || 'custom',
            tokens
          });
        } catch {}
      }
    } catch {}
  }

  if (configDir) {
    const globalAgentsDir = join(configDir, 'agents');
    scanAgentsFolder(globalAgentsDir, 'global');
  }

  for (const plugin of enabledPlugins || []) {
    const pluginAgentsDir = join(plugin.path, 'agents');
    scanAgentsFolder(pluginAgentsDir, plugin.name || plugin.dir);
  }

  agents.sort((a, b) => a.label.localeCompare(b.label));
  return agents;
}
