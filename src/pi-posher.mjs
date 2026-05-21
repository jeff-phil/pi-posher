import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { Box, Spacer, Text } from '@earendil-works/pi-tui';

// ── glob ──────────────────────────────────────────────────────────────

function normalizePathForGlob(input) {
  return input.replace(/\\/g, '/').replace(/^\.\//, '');
}

function escapeRegExpChar(char) {
  return /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
}

function globToRegExp(pattern) {
  const normalized = normalizePathForGlob(pattern);
  let source = '^';

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    const next = normalized[i + 1];

    if (char === '*') {
      if (next === '*') {
        const after = normalized[i + 2];
        if (after === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    source += escapeRegExpChar(char);
  }

  source += '$';
  return new RegExp(source);
}

function matchesGlob(pattern, relativePath) {
  const normalizedPath = normalizePathForGlob(relativePath);
  for (const expanded of expandBraces(pattern)) {
    if (globToRegExp(expanded).test(normalizedPath)) return true;
  }
  return false;
}

function expandBraces(pattern) {
  let depth = 0;
  let start = -1;
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        const prefix = pattern.slice(0, start);
        const suffix = pattern.slice(i + 1);
        const inner = pattern.slice(start + 1, i);
        const parts = splitBraceInner(inner);
        const results = [];
        for (const part of parts) {
          for (const expanded of expandBraces(prefix + part + suffix)) {
            results.push(expanded);
          }
        }
        return results;
      }
    }
  }
  return [pattern];
}

function splitBraceInner(inner) {
  const parts = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
    else if (char === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts;
}

function matchesAnyGlob(patterns, relativePath) {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => matchesGlob(pattern, relativePath));
}

function isPathIncluded(relativePath, include, exclude) {
  const normalizedPath = normalizePathForGlob(relativePath);
  const included =
    !include || include.length === 0 || matchesAnyGlob(include, normalizedPath);
  if (!included) return false;
  return !matchesAnyGlob(exclude, normalizedPath);
}

// ── template ──────────────────────────────────────────────────────────

const PLACEHOLDER_PATTERN =
  /\{(workspace|root|file|relFile|dir|relDir|config|configDir|name)\}/g;

function applyTemplate(input, values) {
  return input.replace(PLACEHOLDER_PATTERN, (_match, key) => values[key] ?? '');
}

function applyTemplateArray(inputs, values) {
  return (inputs ?? []).map((input) => applyTemplate(input, values));
}

function applyTemplateRecord(inputs, values) {
  if (!inputs) return undefined;
  const out = {};
  for (const [key, value] of Object.entries(inputs)) {
    out[key] = applyTemplate(value, values);
  }
  return out;
}

// ── output ────────────────────────────────────────────────────────────

const DEFAULT_OUTPUT_LIMIT = 4000;

function truncateOutput(output, limit = DEFAULT_OUTPUT_LIMIT) {
  const normalized = output.trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}\n… output truncated (${normalized.length - limit} more characters)`;
}

function commandOutput(result) {
  return truncateOutput(
    [result.stdout, result.stderr].filter((part) => part.trim().length > 0).join('\n'),
  );
}

function formatWarnings(title, warnings) {
  if (warnings.length === 0) return '';
  return `${title}:\n\n${warnings.map((warning) => `⚠️ ${warning}`).join('\n')}`;
}

function formatCommandIssue(toolId, action, result) {
  const output = commandOutput(result);
  const suffix = result.killed ? ' (killed/timeout)' : '';
  if (!output)
    return `⚠️ ${toolId} ${action} failed with exit code ${result.code}${suffix}`;
  return `⚠️ ${toolId} ${action} failed with exit code ${result.code}${suffix}:\n${output}`;
}

function hasIssueOutput(output) {
  return output.includes('⚠️');
}

function joinSections(title, lines) {
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return '';
  return `${title}:\n\n${nonEmpty.join('\n')}`;
}

// ── trust ─────────────────────────────────────────────────────────────

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function getExtensionDataDir() {
  const agentDir =
    process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
  return path.join(agentDir, 'extensions', 'pi-posher');
}

function getInitConfigsDir() {
  const __dirname = path.dirname(new URL(import.meta.url).pathname);
  return path.join(__dirname, 'init-configs');
}

async function ensureUserConfigDir() {
  const userDir = getExtensionDataDir();
  if (!fsSync.existsSync(userDir)) {
    await fs.mkdir(userDir, { recursive: true });
  }
  return userDir;
}

async function ensureGlobalConfig(ctx) {
  const configFile = path.join(getExtensionDataDir(), 'poshifiers.json');
  const defaultSource = path.join(getInitConfigsDir(), 'poshifiers.json.default');
  if (!fsSync.existsSync(configFile) && fsSync.existsSync(defaultSource)) {
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.copyFile(defaultSource, configFile);
    if (ctx?.hasUI) {
      ctx.ui.notify(`Poshify defaults installed to ${getExtensionDataDir()}`, 'info');
    }
  }
}

async function readTrustStore(storePath) {
  try {
    const raw = await fs.readFile(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      version: 1,
      trustedHashes: Array.isArray(parsed.trustedHashes)
        ? parsed.trustedHashes.filter((item) => typeof item === 'string')
        : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError)
      return { version: 1, trustedHashes: [] };
    throw error;
  }
}

async function writeTrustStore(storePath, store) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

async function isHashTrusted(kind, hash) {
  const storePath = path.join(getExtensionDataDir(), 'trust', `${kind}.json`);
  const store = await readTrustStore(storePath);
  return store.trustedHashes.includes(hash);
}

async function rememberTrustedHash(kind, hash) {
  const storePath = path.join(getExtensionDataDir(), 'trust', `${kind}.json`);
  const store = await readTrustStore(storePath);
  if (!store.trustedHashes.includes(hash)) {
    store.trustedHashes.push(hash);
    await writeTrustStore(storePath, store);
  }
}

function formatCommandList(cmds) {
  const unique = [...new Set(cmds.filter(Boolean))];
  if (unique.length === 0) return '  (no commands declared)';
  return unique.map((cmd) => `  - ${cmd}`).join('\n');
}

async function askProjectConfigTrust(options) {
  if (await isHashTrusted(options.kind, options.hash))
    return { trusted: true, persist: true };

  if (!options.ctx.hasUI) {
    return {
      trusted: false,
      persist: false,
      reason: 'project-local config rejected in non-interactive mode',
    };
  }

  const title = [
    `Project-local ${options.kind} config wants to auto-run commands.`,
    '',
    `Config: ${options.configPath}`,
    `Hash: ${options.hash}`,
    '',
    'Commands:',
    formatCommandList(options.commands),
    '',
    'Trust this config?',
  ].join('\n');

  const choice = await options.ctx.ui.select(title, [
    'Trust once',
    'Trust always',
    'Reject',
  ]);
  if (choice === 'Trust once') return { trusted: true, persist: false };
  if (choice === 'Trust always') {
    await rememberTrustedHash(options.kind, options.hash);
    return { trusted: true, persist: true };
  }
  return {
    trusted: false,
    persist: false,
    reason: 'project-local config rejected by user',
  };
}

// ── paths ─────────────────────────────────────────────────────────────

function expandHome(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

function toAbsolutePath(inputPath, cwd) {
  const expanded = expandHome(inputPath);
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(cwd, expanded);
}

function normalizeRelativePath(inputPath) {
  const normalized = inputPath.split(path.sep).join('/');
  return normalized === '' ? '.' : normalized;
}

function markerExists(candidateDir, marker) {
  return fsSync.existsSync(path.resolve(candidateDir, marker));
}

function findProjectRoot(filePath, anchors, fallbackRoot) {
  const absoluteFile = toAbsolutePath(filePath, fallbackRoot);
  let dir =
    fsSync.existsSync(absoluteFile) && fsSync.statSync(absoluteFile).isDirectory()
      ? absoluteFile
      : path.dirname(absoluteFile);
  const markers = anchors?.filter(Boolean) ?? [];

  if (markers.length === 0) {
    return toAbsolutePath(fallbackRoot, process.cwd());
  }

  while (true) {
    if (markers.some((marker) => markerExists(dir, marker))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function findUp(startDir, relativeFile) {
  let dir = toAbsolutePath(startDir, process.cwd());
  while (true) {
    const candidate = path.join(dir, relativeFile);
    if (fsSync.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function resolveConfigPath(config, root, baseValues) {
  if (!config) return undefined;
  const templated = applyTemplate(config, baseValues);
  const expanded = expandHome(templated);
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(root, expanded);
}

function createPathPlaceholders(options) {
  const workspace = toAbsolutePath(options.workspace, process.cwd());
  const root = toAbsolutePath(options.root, workspace);
  const file = toAbsolutePath(options.file, root);
  const dir = path.dirname(file);
  const relFile = normalizeRelativePath(path.relative(root, file));
  const relDir = normalizeRelativePath(path.relative(root, dir));
  const config = options.config ? toAbsolutePath(options.config, root) : '';
  const configDir = config ? path.dirname(config) : '';

  return { workspace, root, file, relFile, dir, relDir, config, configDir };
}

function resolveExecutable(bin, root) {
  const expanded = expandHome(bin);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  if (expanded.includes('/') || expanded.includes('\\'))
    return path.resolve(root, expanded);
  return findExecutable(expanded) || expanded;
}

function resolveWorkingDirectory(cwd, root, values) {
  if (!cwd) return root;
  const templated = applyTemplate(cwd, values);
  const expanded = expandHome(templated);
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(root, expanded);
}

function resolveCommand(id, command, options) {
  const baseValues = createPathPlaceholders({
    workspace: options.workspace,
    root: options.root,
    file: options.file,
  });
  const configPath = resolveConfigPath(command.config, options.root, baseValues);
  const values = createPathPlaceholders({
    workspace: options.workspace,
    root: options.root,
    file: options.file,
    config: configPath,
  });

  return {
    id,
    cmd: resolveExecutable(applyTemplate(command.cmd, values), options.root),
    args: applyTemplateArray(command.args, values),
    cwd: resolveWorkingDirectory(command.cwd, options.root, values),
    env: applyTemplateRecord(command.env, values),
    timeoutMs: command.timeoutMs,
    configPath,
    placeholders: values,
  };
}

// ── runner ────────────────────────────────────────────────────────────

function isExecutable(filePath) {
  try {
    fsSync.accessSync(filePath, fsSync.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathCandidates(bin) {
  const pathEntries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';')
      : [''];
  const candidates = [];
  for (const entry of pathEntries) {
    for (const extension of extensions) {
      candidates.push(path.join(entry, `${bin}${extension}`));
    }
  }
  return candidates;
}

function findExecutable(bin) {
  if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\'))
    return isExecutable(bin) ? bin : undefined;
  return pathCandidates(bin).find(isExecutable);
}

function isExecutableAvailable(bin) {
  return !!findExecutable(bin);
}

function execDirect(command, args, options) {
  return new Promise((resolve) => {
    const proc = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env ? { ...process.env, ...options.env } : process.env,
    });
    let stdout = '';
    let stderr = '';
    let killed = false;
    let timeoutId;
    const killProcess = () => {
      if (!killed) {
        killed = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
      }
    };
    if (options.signal) {
      if (options.signal.aborted) killProcess();
      else options.signal.addEventListener('abort', killProcess, { once: true });
    }
    if (options.timeout && options.timeout > 0) {
      timeoutId = setTimeout(killProcess, options.timeout);
    }
    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (options.signal) options.signal.removeEventListener('abort', killProcess);
      resolve({ stdout, stderr, code: 1, killed });
    });
    proc.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (options.signal) options.signal.removeEventListener('abort', killProcess);
      resolve({ stdout, stderr, code: code ?? 0, killed });
    });
  });
}

async function runCommand(command, signal) {
  const startedAt = Date.now();
  const result = await execDirect(command.cmd, command.args, {
    cwd: command.cwd,
    timeout: command.timeoutMs,
    signal,
    env: command.env ? { ...process.env, ...command.env } : undefined,
  });
  return {
    id: command.id,
    cmd: command.cmd,
    args: command.args,
    cwd: command.cwd,
    ...result,
    durationMs: Date.now() - startedAt,
  };
}

// ── config ────────────────────────────────────────────────────────────

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

function cleanPoshifier(object) {
  if (typeof object.name !== 'string' || object.name.trim() === '') return undefined;
  const tools = cleanCommands(object.tools);
  const initSetup = cleanInitSetup(object);
  return {
    name: object.name,
    include: cleanStringArray(object.include),
    exclude: cleanStringArray(object.exclude),
    anchors: cleanStringArray(object.anchors),
    maxFileSizeBytes: cleanNumber(object.maxFileSizeBytes),
    tools,
    'init-setup': initSetup,
  };
}

function parsePoshifyItems(parsed) {
  const root = asObject(parsed);
  const poshifiers = Array.isArray(root?.poshifiers) ? root.poshifiers : [];
  const out = [];

  for (const item of poshifiers) {
    const object = asObject(item);
    if (!object) continue;
    const cleaned = cleanPoshifier(object);
    if (cleaned) out.push(cleaned);
  }

  return out;
}

async function readJsonLayer(options) {
  let raw;
  try {
    raw = await fs.readFile(options.filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }

  const parsed = JSON.parse(raw);
  return {
    scope: options.scope,
    path: options.filePath,
    dir: path.dirname(options.filePath),
    raw,
    hash: sha256(raw),
    items: options.parseItems(parsed),
  };
}

function mergeLayers(layers) {
  const byName = new Map();
  for (const layer of layers) {
    for (const item of layer.items) {
      byName.set(item.name, item);
    }
  }
  return [...byName.values()];
}

function commandsForPoshify(items) {
  return items.flatMap((item) =>
    item.tools.map((tool) => tool.cmd).filter((cmd) => !!cmd),
  );
}

async function loadPoshifyConfig(ctx) {
  const warnings = [];
  const layers = [];
  const globalPath = path.join(getExtensionDataDir(), 'poshifiers.json');

  try {
    const globalLayer = await readJsonLayer({
      scope: 'global',
      filePath: globalPath,
      parseItems: parsePoshifyItems,
    });
    if (globalLayer) layers.push(globalLayer);
  } catch (error) {
    warnings.push(`Failed to load global poshify config: ${error.message}`);
  }

  const projectPath = findUp(ctx.cwd, path.join('.pi', 'poshifiers.json'));
  if (projectPath) {
    try {
      const projectLayer = await readJsonLayer({
        scope: 'project',
        filePath: projectPath,
        parseItems: parsePoshifyItems,
      });
      if (projectLayer) {
        const decision = await askProjectConfigTrust({
          ctx,
          kind: 'poshify',
          configPath: projectLayer.path,
          hash: projectLayer.hash,
          commands: commandsForPoshify(projectLayer.items),
        });
        if (decision.trusted) layers.push(projectLayer);
        else
          warnings.push(
            `${projectLayer.path}: ${decision.reason ?? 'project-local config rejected'}`,
          );
      }
    } catch (error) {
      warnings.push(`Failed to load project poshify config: ${error.message}`);
    }
  }

  return { items: mergeLayers(layers), layers, warnings };
}

// ── extension entrypoint ──────────────────────────────────────────────

const DEFAULT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

function customMessageText(content, details) {
  const summary = details?.summary;
  if (typeof summary === 'string') return summary;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item?.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('\n');
}

function registerDiagnosticsRenderer(pi) {
  pi.registerMessageRenderer('pi-posher', (message, _options, theme) => {
    const text = customMessageText(message.content, message.details);
    const box = new Box(1, 1, (value) => theme.bg('toolSuccessBg', value));
    box.addChild(new Text(theme.fg('toolTitle', theme.bold('poshify')), 0, 0));
    if (text.trim()) {
      box.addChild(new Spacer(1));
      box.addChild(new Text(theme.fg('toolOutput', text), 0, 0));
    }
    return box;
  });
}

function getEventPath(input) {
  return typeof input.path === 'string' && input.path.trim() ? input.path : undefined;
}

async function fileSizeAllowed(file, limit) {
  const stat = await fs.stat(file);
  return stat.size <= limit;
}

async function hashFile(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

function couldMatchBeforeRoot(file, cwd, include, exclude) {
  const candidates = [
    ...new Set([normalizeRelativePath(path.relative(cwd, file)), path.basename(file)]),
  ];
  const included =
    !include ||
    include.length === 0 ||
    candidates.some((candidate) => matchesAnyGlob(include, candidate));
  if (!included) return false;
  return !candidates.some((candidate) => matchesAnyGlob(exclude, candidate));
}

async function matchTools(ctx, tools, file) {
  const warnings = [];
  const matches = [];

  for (const tool of tools) {
    if (!couldMatchBeforeRoot(file, ctx.cwd, tool.include, tool.exclude)) continue;

    const root = findProjectRoot(file, tool.anchors, ctx.cwd);
    if (!root) {
      warnings.push(
        `${tool.name}: anchors not found (${(tool.anchors ?? []).join(', ') || 'none'})`,
      );
      continue;
    }

    const relFile = normalizeRelativePath(path.relative(root, file));
    if (relFile.startsWith('..') || path.isAbsolute(relFile)) continue;
    if (!isPathIncluded(relFile, tool.include, tool.exclude)) continue;

    matches.push({ tool, root, relFile });
  }

  return { matches, warnings };
}

async function runPoshifierCommand(options, tool, commandIndex, root) {
  const command = resolveCommand(
    `${tool.name} ${commandIndex + 1}`,
    tool.tools[commandIndex],
    {
      workspace: options.workspace,
      root,
      file: options.file,
    },
  );

  if (!isExecutableAvailable(command.cmd)) {
    return {
      line: `⚠️ ${tool.name}: command not found: ${command.cmd}`,
      diagnostics: false,
    };
  }

  const before = await hashFile(options.file);
  const result = await runCommand(command, options.ctx.signal);

  if (result.code === 0) {
    const after = await hashFile(options.file);
    const relFile = command.placeholders.relFile;
    return {
      line:
        before === after
          ? `✅ ${tool.name}: ${command.cmd} checked ${relFile}`
          : `✅ ${tool.name}: ${command.cmd} modified ${relFile}`,
      diagnostics: false,
    };
  }

  return {
    line: formatCommandIssue(tool.name, command.cmd, result),
    diagnostics: true,
  };
}

async function runTool(options) {
  const { tool, root } = options.match;
  const maxFileSizeBytes = tool.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  if (!(await fileSizeAllowed(options.file, maxFileSizeBytes))) {
    return [
      `⚠️ ${tool.name}: skipped ${options.match.relFile}; file exceeds maxFileSizeBytes (${maxFileSizeBytes})`,
    ];
  }

  const lines = [];
  for (let i = 0; i < tool.tools.length; i += 1) {
    const result = await runPoshifierCommand(options, tool, i, root);
    if (result) lines.push(result.line);
  }

  return lines;
}

class PerFileQueue {
  queues = new Map();

  run(file, task) {
    const previous = this.queues.get(file) ?? Promise.resolve('');
    const next = previous.catch(() => '').then(task);
    const tracked = next.finally(() => {
      if (this.queues.get(file) === tracked) this.queues.delete(file);
    });
    this.queues.set(file, tracked);
    return next;
  }
}

async function buildPoshifySummary(ctx, inputPath) {
  const absoluteFile = toAbsolutePath(inputPath, ctx.cwd);
  const loaded = await loadPoshifyConfig(ctx);
  const warnings = [...loaded.warnings];
  const projectLayer = loaded.layers.find((layer) => layer.scope === 'project');
  const workspace = projectLayer ? path.dirname(projectLayer.dir) : ctx.cwd;

  if (loaded.items.length === 0) {
    return formatWarnings('Poshify', warnings);
  }

  const { matches, warnings: matchWarnings } = await matchTools(
    ctx,
    loaded.items,
    absoluteFile,
  );
  warnings.push(...matchWarnings);
  if (matches.length === 0) {
    return formatWarnings('Poshify', warnings);
  }

  const lines = [];
  for (const match of matches) {
    try {
      lines.push(...(await runTool({ ctx, match, file: absoluteFile, workspace })));
    } catch (error) {
      lines.push(`⚠️ ${match.tool.name}: ${error.message}`);
    }
  }

  return [formatWarnings('Poshify', warnings), joinSections('Poshify', lines)]
    .filter(Boolean)
    .join('\n\n');
}

async function* walkFiles(startDir, maxDepth = 10) {
  if (maxDepth <= 0) return;
  let entries;
  try {
    entries = await fs.readdir(startDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (
      entry.name === 'node_modules' ||
      entry.name === '.git' ||
      entry.name === 'vendor' ||
      entry.name === '.svelte-kit' ||
      entry.name === '.next' ||
      entry.name === 'dist' ||
      entry.name === 'build'
    )
      continue;
    const fullPath = path.join(startDir, entry.name);
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, maxDepth - 1);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

function checkAborted(signal) {
  if (signal?.aborted) throw new Error('Aborted');
}

async function runPoshifyBatch(ctx, inputPath) {
  const absolutePath = toAbsolutePath(inputPath, ctx.cwd);
  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch {
    return `⚠️ Path not found: ${inputPath}`;
  }

  const loaded = await loadPoshifyConfig(ctx);
  checkAborted(ctx.signal);
  const warnings = [...loaded.warnings];
  const projectLayer = loaded.layers.find((layer) => layer.scope === 'project');
  const workspace = projectLayer ? path.dirname(projectLayer.dir) : ctx.cwd;

  const files = [];
  if (stats.isDirectory()) {
    for await (const file of walkFiles(absolutePath)) {
      files.push(file);
    }
  } else {
    files.push(absolutePath);
  }

  checkAborted(ctx.signal);

  if (files.length === 0) {
    return `No files found in ${normalizeRelativePath(path.relative(ctx.cwd, absolutePath))}`;
  }

  const allLines = [];
  for (const file of files) {
    checkAborted(ctx.signal);
    const { matches, warnings: matchWarnings } = await matchTools(
      ctx,
      loaded.items,
      file,
    );
    warnings.push(...matchWarnings);
    for (const match of matches) {
      try {
        allLines.push(...(await runTool({ ctx, match, file, workspace })));
      } catch (error) {
        allLines.push(`⚠️ ${match.tool.name}: ${error.message}`);
      }
    }
  }

  return [formatWarnings('Poshify', warnings), joinSections('Poshify', allLines)]
    .filter(Boolean)
    .join('\n\n');
}

async function runInitByName(ctx, poshifier, name) {
  const cwd = ctx.cwd;
  const initSetup = poshifier?.['init-setup'];
  if (!initSetup) {
    throw new Error(`No init-setup defined for "${name}".`);
  }
  const configs = initSetup['init-configs'] ?? [];
  const tools = initSetup['init-tools'] ?? [];
  const bundledDir = getInitConfigsDir();
  const userDir = getExtensionDataDir();

  // Seed user-level init-configs from bundled templates if not present
  await ensureUserConfigDir();
  await fs.mkdir(path.join(userDir, name), { recursive: true });
  for (const relPath of configs) {
    const templated = relPath.replace(/\{name\}/g, name);
    const destUser = path.join(userDir, templated);
    const srcBundled = path.join(bundledDir, templated);
    if (!fsSync.existsSync(destUser) && fsSync.existsSync(srcBundled)) {
      const destParent = path.dirname(destUser);
      await fs.mkdir(destParent, { recursive: true });
      await fs.copyFile(srcBundled, destUser);
    }
  }

  const copied = [];
  const skipped = [];

  for (const relPath of configs) {
    const templated = relPath.replace(/\{name\}/g, name);
    const srcPath = path.join(userDir, templated);
    if (!fsSync.existsSync(srcPath)) {
      throw new Error(
        `Init config not found for "${name}": ${templated} (expected at ${srcPath})`,
      );
    }
    const fileName = path.basename(templated);
    const destPath = path.join(cwd, fileName);
    if (fsSync.existsSync(destPath)) {
      skipped.push(fileName);
      continue;
    }
    const destParent = path.dirname(destPath);
    await fs.mkdir(destParent, { recursive: true });
    await fs.copyFile(srcPath, destPath);
    copied.push(fileName);
  }

  // Run init-tools with name placeholder and root=cwd
  const baseValues = { name, root: cwd };
  for (const tool of tools) {
    const command = {
      ...tool,
      cmd: applyTemplate(tool.cmd, baseValues),
      args: applyTemplateArray(tool.args, baseValues),
      cwd: applyTemplate(tool.cwd ?? cwd, baseValues),
    };
    const result = await execDirect(command.cmd, command.args, {
      cwd: command.cwd,
      timeout: command.timeoutMs,
      signal: ctx.signal,
      env: command.env ? { ...process.env, ...command.env } : undefined,
    });
    if (result.code !== 0) {
      const output = commandOutput(result);
      const err = new Error(
        `Init tool "${command.cmd}" failed with exit code ${result.code}${result.killed ? ' (killed/timeout)' : ''}${output ? ':\n' + output : ''}`,
      );
      err.cause = result;
      throw err;
    }
  }

  return { copied, skipped, cwd };
}

async function hasEslintConfig(cwd) {
  const entries = await fs.readdir(cwd).catch(() => []);
  return entries.some((name) => /^eslint\.config\.([mc]?js|json)$/.test(name));
}

async function runEslintFix(ctx, targetPath) {
  if (!(await hasEslintConfig(ctx.cwd))) {
    return joinSections('Poshify', [`⚠️ No eslint.config.* file found in ${ctx.cwd}`]);
  }
  const absolutePath = resolveAtPath(targetPath, ctx.cwd);
  const result = await execDirect('npx', ['eslint', '--fix', absolutePath], {
    cwd: ctx.cwd,
    timeout: 120000,
    signal: ctx.signal,
  });
  const output = commandOutput(result);
  if (result.code === 0) {
    return joinSections('Poshify', [
      output
        ? `✅ ESLint --fix:\n${output}`
        : '✅ ESLint --fix completed with no issues.',
    ]);
  }
  return joinSections('Poshify', [
    `⚠️ ESLint --fix failed (exit ${result.code}${result.killed ? ' killed/timeout' : ''}):\n${output}`,
  ]);
}

function normalizeUnicodeSpaces(str) {
  return str.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
}

function resolveAtPath(input, cwd) {
  const raw = normalizeUnicodeSpaces(input?.trim() || '.');
  if (!raw.startsWith('@')) return toAbsolutePath(raw, cwd);
  const withAt = toAbsolutePath(raw, cwd);
  if (fsSync.existsSync(withAt)) return withAt;
  return toAbsolutePath(raw.slice(1), cwd);
}

export default async function piPosherExtension(pi) {
  const queue = new PerFileQueue();
  registerDiagnosticsRenderer(pi);

  pi.on('session_start', async (_event, ctx) => {
    await ensureGlobalConfig(ctx);
  });

  pi.registerCommand('poshify', {
    description:
      'Run configured tools on a file or directory (/poshify --help for more)',
    handler: async (args, ctx) => {
      const trimmed = normalizeUnicodeSpaces(args?.trim() || '');

      const config = await loadPoshifyConfig(ctx);
      const availableInits = config.items
        .filter((item) => item?.['init-setup'])
        .map((item) => item.name)
        .sort();

      const usage = [
        ` /poshify (file|dir)          # Run configured tools for file or directory`,
        ` /poshify --init <name>       # Install init configs for a poshifier type`,
        ` /poshify --fix [file|dir]    # Run ESLint --fix`,
        ` /poshify --help              # Show this usage`,
        ...(availableInits.length > 0
          ? ['', 'Available --init names: ' + availableInits.join(', ')]
          : []),
      ].join('\n');

      if (trimmed === '' || trimmed === '--help') {
        pi.sendMessage(
          {
            customType: 'pi-posher',
            content: '',
            display: true,
            details: { path: ctx.cwd, summary: usage },
          },
          { deliverAs: 'steer' },
        );
        return;
      }

      if (trimmed === '--init' || trimmed.startsWith('--init ')) {
        const initName = trimmed.slice(5).trim();
        if (!initName) {
          pi.sendMessage(
            {
              customType: 'pi-posher',
              content: '',
              display: true,
              details: {
                path: ctx.cwd,
                summary: `Usage: /poshify --init <name>\n\n${availableInits.length > 0 ? 'Available: ' + availableInits.join(', ') : 'No init setups configured.'}`,
              },
            },
            { deliverAs: 'steer' },
          );
          return;
        }
        const poshifier = config.items.find((item) => item.name === initName);
        let summary;
        try {
          if (!poshifier) {
            summary = `⚠️ No poshifier named "${initName}" found.${config.warnings.length > 0 ? '\n' + config.warnings.join('\n') : ''}`;
          } else if (!poshifier['init-setup']) {
            summary = `⚠️ Poshifier "${initName}" has no init-setup defined.`;
          } else {
            const result = await runInitByName(ctx, poshifier, initName);
            const parts = [];
            if (result.copied.length > 0)
              parts.push(`Copied: ${result.copied.join(', ')}`);
            if (result.skipped.length > 0)
              parts.push(`Skipped (already exist): ${result.skipped.join(', ')}`);
            if (result.copied.length === 0 && result.skipped.length === 0)
              parts.push('No files to copy.');
            summary = `${result.cwd}\n${parts.join('\n')}`;
            if (ctx.hasUI) {
              ctx.ui.notify(
                `Poshify init for "${initName}" installed to ${result.cwd}`,
                'info',
              );
            }
          }
        } catch (error) {
          summary = `⚠️ init failed: ${error.message}`;
        }

        pi.sendMessage(
          {
            customType: 'pi-posher',
            content: '',
            display: true,
            details: { path: ctx.cwd, summary },
          },
          { deliverAs: 'steer' },
        );
        return;
      }

      if (trimmed === '--fix' || trimmed.startsWith('--fix ')) {
        const fixTarget = trimmed.slice(5).trim() || '.';
        let summary;
        try {
          summary = await runEslintFix(ctx, fixTarget);
        } catch (error) {
          if (error.message === 'Aborted') {
            summary = '  ESLint fix interrupted';
          } else {
            summary = `  ESLint fix error: ${error.message}`;
          }
        }
        pi.sendMessage(
          {
            customType: 'pi-posher',
            content: '',
            display: true,
            details: { path: ctx.cwd, summary },
          },
          { deliverAs: 'steer' },
        );
        return;
      }

      const parts = trimmed.split(/\s+/).filter(Boolean);

      if (parts.includes('--fix')) {
        pi.sendMessage(
          {
            customType: 'pi-posher',
            content: '',
            display: true,
            details: {
              summary: 'Usage: /poshify --fix [file|dir]',
            },
          },
          { deliverAs: 'steer' },
        );
        return;
      }

      if (parts.includes('--init')) {
        pi.sendMessage(
          {
            customType: 'pi-posher',
            content: '',
            display: true,
            details: {
              summary: 'Usage: /poshify --init',
            },
          },
          { deliverAs: 'steer' },
        );
        return;
      }

      const targetPath = resolveAtPath(args, ctx.cwd);

      const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
      let frameIndex = 0;

      const animationId = setInterval(() => {
        // This is for the braille dot spinner
        const frame = frames[frameIndex];
        // Set the UI Widget (visible above the prompt)
        ctx.ui.setWidget('poshify-loader', [
          ctx.ui.theme.fg('accent', '┏━━ Pi Poshify Tool ━━━━━━━━━━━━━━━━━━━━━'),
          `${ctx.ui.theme.fg('muted', '┃')} Running tools...`,
          `${ctx.ui.theme.fg('muted', '┃')} Target: ${ctx.ui.theme.fg('dim', targetPath)}`,
          ctx.ui.theme.fg('accent', `┗━━ ${frame} Working...`),
        ]);
        frameIndex = (frameIndex + 1) % frames.length;
      }, 80); // 80ms is the standard speed for terminal spinners

      let summary;
      try {
        summary = await runPoshifyBatch(ctx, targetPath);
      } catch (error) {
        if (error.message === 'Aborted') {
          summary = '  Poshify interrupted';
        } else {
          summary = `  Poshify error: ${error.message}`;
        }
      } finally {
        // Important clear the interval
        clearInterval(animationId);
        // Remove the widget when finished
        ctx.ui.setWidget('poshify-loader', undefined);
      }

      if (summary && summary.trim()) {
        pi.sendMessage(
          {
            customType: 'pi-posher',
            content: '',
            display: true,
            details: { path: targetPath, summary },
          },
          // This tells llm to do something with output
          { deliverAs: 'steer' },
        );
      }
    },
  });

  let Type;
  try {
    const tb = await import('typebox');
    Type = tb.Type;
  } catch {
    // typebox not available — skip tool registration
  }

  if (Type) {
    pi.registerTool({
      name: 'run_poshify',
      label: 'Run Poshify',
      description: 'Run configured tools on a file or directory',
      promptSnippet:
        'Run poshify (run configured tools, code quality, linters, formaters) on a specified file or directory',
      parameters: Type.Object({
        path: Type.String({
          description: 'File or directory path to run poshify on',
        }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const summary = await runPoshifyBatch(ctx, resolveAtPath(params.path, ctx.cwd));
        return {
          content: [{ type: 'text', text: summary || 'No changes or issues found.' }],
          details: {},
        };
      },
    });
  }

  pi.on('tool_result', async (event, ctx) => {
    if (event.toolName !== 'write' && event.toolName !== 'edit') return undefined;
    if (event.isError) return undefined;

    const inputPath = getEventPath(event.input);
    if (!inputPath) return undefined;

    const absoluteFile = toAbsolutePath(inputPath, ctx.cwd);
    const summary = await queue.run(absoluteFile, () =>
      buildPoshifySummary(ctx, inputPath),
    );
    if (!summary.trim()) return undefined;

    if (hasIssueOutput(summary)) {
      pi.sendMessage(
        {
          customType: 'pi-posher',
          content: '',
          display: true,
          details: {
            path: absoluteFile,
            summary,
            toolCallId: event.toolCallId,
          },
        },
        { deliverAs: 'steer' },
      );
    }

    return {
      content: [...event.content, { type: 'text', text: summary }],
    };
  });
}
