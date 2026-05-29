import fs from 'node:fs/promises';
import path from 'node:path';

import { findUp } from './lib/paths.mjs';
import { getExtensionDataDir, getExtensionSourceDir, sha256 } from './trust.mjs';

// ── validation & cleaning ─────────────────────────────────────────────

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : undefined;
}

function cleanStringArray(value) {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item) => typeof item === 'string');
}

function cleanStringRecord(value) {
  const object = asObject(value);
  if (!object) return undefined;
  const out = {};
  for (const [key, recordValue] of Object.entries(object)) {
    if (typeof recordValue === 'string') out[key] = recordValue;
  }
  return out;
}

function cleanNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function cleanCommand(value) {
  const object = asObject(value);
  if (!object || typeof object.cmd !== 'string' || object.cmd.trim() === '')
    return undefined;
  const rawTimeout = cleanNumber(object.timeoutMs);
  return {
    cmd: object.cmd,
    args: cleanStringArray(object.args),
    cwd: typeof object.cwd === 'string' ? object.cwd : undefined,
    env: cleanStringRecord(object.env),
    config: typeof object.config === 'string' ? object.config : undefined,
    timeoutMs: rawTimeout ?? 15000,
  };
}

function cleanInitSetup(object) {
  if (!object || typeof object !== 'object') return undefined;
  const setup = asObject(object['init-setup']);
  if (!setup) return undefined;
  return {
    'init-configs': cleanStringArray(setup['init-configs']),
    'init-tools': cleanCommands(setup['init-tools']),
  };
}

function cleanCommands(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  for (const item of tools) {
    const cmd = cleanCommand(item);
    if (cmd) out.push(cmd);
  }
  return out;
}

export function cleanPoshifier(object) {
  if (typeof object.name !== 'string' || object.name.trim() === '') return undefined;
  const tools = cleanCommands(object.tools);
  const fixTools = cleanCommands(object['fix-tools']);
  const auditTools = cleanCommands(object['audit-tools']);
  const initSetup = cleanInitSetup(object);
  let anchors = cleanStringArray(object.anchors);
  if (!anchors || anchors.length === 0) anchors = ['.project'];
  return {
    name: object.name,
    include: cleanStringArray(object.include),
    exclude: cleanStringArray(object.exclude),
    anchors,
    maxFileSizeBytes: cleanNumber(object.maxFileSizeBytes),
    tools,
    'fix-tools': fixTools,
    'audit-tools': auditTools,
    'init-setup': initSetup,
  };
}

export function parsePoshifyItems(parsed, warnings = []) {
  const root = asObject(parsed);
  if (!Array.isArray(root?.poshifiers)) {
    warnings.push('missing or invalid "poshifiers" array');
    return [];
  }
  const out = [];

  for (let i = 0; i < root.poshifiers.length; i += 1) {
    const item = root.poshifiers[i];
    const object = asObject(item);
    if (!object) {
      warnings.push(`poshifiers[${i}]: not an object, skipped`);
      continue;
    }
    const cleaned = cleanPoshifier(object);
    if (cleaned) {
      out.push(cleaned);
    } else {
      const name = typeof object.name === 'string' ? `"${object.name}"` : '(unnamed)';
      warnings.push(`poshifiers[${i}] (${name}): missing required fields, skipped`);
    }
  }

  return out;
}

export async function readJsonLayer(options) {
  let raw;
  try {
    raw = await fs.readFile(options.filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }

  const parsed = JSON.parse(raw);
  const parseWarnings = [];
  const items = options.parseItems(parsed, parseWarnings);
  return {
    scope: options.scope,
    path: options.filePath,
    dir: path.dirname(options.filePath),
    raw,
    hash: sha256(raw),
    items,
    warnings: parseWarnings,
  };
}

// ── defaults ──────────────────────────────────────────────────────────

// Minimal fallback used when the bundled poshifiers.json.default is
// unavailable (e.g. CJS/jiti context). The seed file is expected to
// be present in normal operation.
const DEFAULT_POSHIFIERS = [{ name: 'json' }];

export async function readBundledDefaultsLayer() {
  const defaultSource = path.join(getExtensionSourceDir(), 'poshifiers.json.default');
  try {
    const raw = await fs.readFile(defaultSource, 'utf8');
    const parsed = JSON.parse(raw);
    const warnings = [];
    const items = parsePoshifyItems(parsed, warnings);
    return {
      scope: 'defaults',
      path: defaultSource,
      dir: path.dirname(defaultSource),
      raw,
      hash: sha256(raw),
      items,
      warnings,
    };
  } catch {
    // fall through to code defaults (ENOENT, SyntaxError, etc.)
  }

  return {
    scope: 'defaults',
    path: '<code-embedded>',
    dir: '',
    raw: '',
    hash: '',
    items: DEFAULT_POSHIFIERS.map((item) => cleanPoshifier(item)).filter(Boolean),
  };
}

export function mergeLayers(layers) {
  const byName = new Map();
  for (const layer of layers) {
    for (const item of layer.items) {
      byName.set(item.name, item);
    }
  }
  return [...byName.values()];
}

export function commandsForPoshifySection(items, section) {
  return items.flatMap((item) => {
    let cmds;
    if (section === 'init-tools') {
      cmds = item['init-setup']?.['init-tools'];
    } else {
      cmds = item[section];
    }
    if (!Array.isArray(cmds)) return [];
    return cmds
      .filter((tool) => typeof tool.cmd === 'string' && tool.cmd.trim() !== '')
      .map((tool) => {
        const args = (tool.args ?? []).join(' ');
        return args ? `${tool.cmd} ${args}` : tool.cmd;
      });
  });
}

export function commandsForPoshify(items) {
  const sections = [];
  const initTools = commandsForPoshifySection(items, 'init-tools');
  if (initTools.length > 0)
    sections.push(`init-tools:\n${initTools.map((c) => `  - ${c}`).join('\n')}`);
  const tools = commandsForPoshifySection(items, 'tools');
  if (tools.length > 0)
    sections.push(`tools:\n${tools.map((c) => `  - ${c}`).join('\n')}`);
  const fixTools = commandsForPoshifySection(items, 'fix-tools');
  if (fixTools.length > 0)
    sections.push(`fix-tools:\n${fixTools.map((c) => `  - ${c}`).join('\n')}`);
  const auditTools = commandsForPoshifySection(items, 'audit-tools');
  if (auditTools.length > 0)
    sections.push(`audit-tools:\n${auditTools.map((c) => `  - ${c}`).join('\n')}`);
  return sections.join('\n\n');
}

export function initConfigsForPoshify(items) {
  const configs = [];
  for (const item of items) {
    const initSetup = item['init-setup'];
    if (!initSetup) continue;
    const initConfigs = initSetup['init-configs'];
    if (!Array.isArray(initConfigs) || initConfigs.length === 0) continue;
    for (const config of initConfigs) {
      configs.push(`${item.name}: ${config}`);
    }
  }
  return configs;
}

// ── main loader ───────────────────────────────────────────────────────

export async function loadPoshifyConfig(ctx, cache, deps) {
  if (cache && cache.ready && cache.cwd === ctx.cwd) {
    return cache.value;
  }

  const { validateBatchCommand, askTrust } = deps;
  const warnings = [];
  const layers = [];
  const globalPath = path.join(getExtensionDataDir(), 'poshifiers.json');

  try {
    const globalLayer = await readJsonLayer({
      scope: 'global',
      filePath: globalPath,
      parseItems: parsePoshifyItems,
    });
    if (globalLayer) {
      layers.push(globalLayer);
      if (globalLayer.warnings?.length) warnings.push(...globalLayer.warnings);
    }
  } catch (error) {
    warnings.push(`Failed to load global poshify config: ${error.message}`);
  }

  if (layers.length === 0) {
    const defaultsLayer = await readBundledDefaultsLayer();
    if (defaultsLayer) layers.push(defaultsLayer);
  }

  const projectPath = await findUp(ctx.cwd, path.join('.pi', 'poshifiers.json'));
  if (projectPath) {
    try {
      const projectLayer = await readJsonLayer({
        scope: 'project',
        filePath: projectPath,
        parseItems: parsePoshifyItems,
      });
      if (projectLayer) {
        if (projectLayer.warnings?.length) warnings.push(...projectLayer.warnings);
        const decision = await askTrust({
          ctx,
          kind: 'poshify',
          configPath: projectLayer.path,
          hash: projectLayer.hash,
          commands: commandsForPoshify(projectLayer.items),
          initConfigs: initConfigsForPoshify(projectLayer.items),
          globalPath,
        });
        if (decision.trusted) layers.push(projectLayer);
        else
          warnings.push(
            `ℹ️ Project-level config rejected this session: ${projectLayer.path}`,
          );
      }
    } catch (error) {
      if (error.message === 'Cancelled') {
        warnings.push(`${projectPath}: project-local config rejected by user`);
      } else {
        warnings.push(`Failed to load project poshify config: ${error.message}`);
      }
    }
  }

  const result = { items: mergeLayers(layers), layers, warnings };

  for (const item of result.items) {
    for (const section of ['tools', 'fix-tools', 'audit-tools']) {
      const sectionTools = item[section] ?? [];
      for (const cmd of sectionTools) {
        const error = validateBatchCommand(cmd);
        if (error) {
          warnings.push(`${item.name}: ${error}`);
        }
      }
    }
  }

  if (cache) {
    cache.value = result;
    cache.ready = true;
    cache.cwd = ctx.cwd;
  }

  return result;
}
