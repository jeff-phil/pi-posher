import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';
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

function formatConfigHeader(loaded) {
  const agentDir = getAgentDir();
  const defaultAgentDir = path.join(os.homedir(), '.pi', 'agent');
  const projectLayer = loaded.layers.find((l) => l.scope === 'project');
  if (projectLayer) return `Poshify (${projectLayer.path})`;
  const globalLayer = loaded.layers.find((l) => l.scope === 'global');
  if (globalLayer) {
    const displayPath =
      agentDir === defaultAgentDir && globalLayer.path.startsWith(agentDir)
        ? globalLayer.path.replace(agentDir, '~/.pi/agent')
        : globalLayer.path;
    return `Poshify (${displayPath})`;
  }
  return 'Poshify (built-in defaults)';
}

// ── trust ─────────────────────────────────────────────────────────────

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function getExtensionDataDir() {
  return path.join(getAgentDir(), 'extensions', 'pi-posher');
}

function getInitConfigsDir() {
  // Strategy 1: Use import.meta.url (works when loaded natively as ESM)
  try {
    if (typeof import.meta?.url === 'string') {
      const dir = path.dirname(new URL(import.meta.url).pathname);
      const candidate = path.join(dir, 'init-configs');
      if (fsSync.existsSync(candidate)) return candidate;
    }
  } catch {
    // import.meta may not be available in CJS/jiti context
  }

  const agentDir = getAgentDir();

  // Strategy 2: npm-installed package
  const npmCandidate = path.join(
    agentDir,
    'npm',
    'node_modules',
    'pi-posher',
    'src',
    'init-configs',
  );
  if (fsSync.existsSync(npmCandidate)) return npmCandidate;

  // Strategy 3: Search for init-configs directory by walking up from CWD
  // (handles local path packages where the project is a parent of CWD)
  let searchDir = process.cwd();
  for (let i = 0; i < 20; i += 1) {
    const candidate = path.join(searchDir, 'src', 'init-configs');
    if (
      fsSync.existsSync(candidate) &&
      fsSync.existsSync(path.join(searchDir, 'package.json'))
    ) {
      try {
        const pkg = JSON.parse(
          fsSync.readFileSync(path.join(searchDir, 'package.json'), 'utf8'),
        );
        if (pkg.name === 'pi-posher') return candidate;
      } catch {
        // ignore parse errors
      }
    }
    const parent = path.dirname(searchDir);
    if (parent === searchDir) break;
    searchDir = parent;
  }

  // Strategy 4: Check settings.json for local path references to pi-posher
  try {
    const settingsPath = path.join(agentDir, 'settings.json');
    if (fsSync.existsSync(settingsPath)) {
      const settings = JSON.parse(fsSync.readFileSync(settingsPath, 'utf8'));
      const packages = settings.packages ?? [];
      for (const pkg of packages) {
        const source = typeof pkg === 'string' ? pkg : pkg.source;
        if (!source || !source.includes('pi-posher')) continue;
        if (source.startsWith('npm:')) continue;
        // Resolve local path relative to agentDir
        const resolved = path.resolve(agentDir, source);
        const candidate = path.join(resolved, 'src', 'init-configs');
        if (fsSync.existsSync(candidate)) return candidate;
      }
    }
  } catch {
    // ignore settings parse errors
  }

  // Final fallback: return the npm path (even if it doesn't exist yet)
  return npmCandidate;
}

async function ensureUserConfigDir() {
  const userDir = getExtensionDataDir();
  if (!fsSync.existsSync(userDir)) {
    await fs.mkdir(userDir, { recursive: true });
  }
  return userDir;
}

// Get the directory containing the extension source files (where poshifiers.json.default lives)
function getExtensionSourceDir() {
  // The init-configs directory is at src/init-configs, so the source dir is its parent
  const initConfigsDir = getInitConfigsDir();
  if (initConfigsDir && fsSync.existsSync(initConfigsDir)) {
    return path.dirname(initConfigsDir);
  }
  // Fallback: try import.meta.url's parent
  try {
    if (typeof import.meta?.url === 'string') {
      const dir = path.dirname(new URL(import.meta.url).pathname);
      // Check if this is the src dir (has poshifiers.json.default)
      if (fsSync.existsSync(path.join(dir, 'poshifiers.json.default'))) return dir;
    }
  } catch {
    // ignore
  }
  return initConfigsDir ? path.dirname(initConfigsDir) : '';
}

function getInitConfigsDataDir() {
  return path.join(getExtensionDataDir(), 'init-configs');
}

async function seedPoshifyDefaults() {
  const configFile = path.join(getExtensionDataDir(), 'poshifiers.json');
  // poshifiers.json.default is in the source dir (e.g. src/), NOT in init-configs/
  const defaultSource = path.join(getExtensionSourceDir(), 'poshifiers.json.default');
  if (!fsSync.existsSync(configFile) && fsSync.existsSync(defaultSource)) {
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.copyFile(defaultSource, configFile);
    return true;
  }
  return false;
}

async function seedAllInitConfigs() {
  const initDataDir = getInitConfigsDataDir();
  const bundledDir = getInitConfigsDir();
  const bundledDirExists = fsSync.existsSync(bundledDir);

  // Ensure init-configs data dir exists before seeding
  if (!fsSync.existsSync(initDataDir)) {
    await fs.mkdir(initDataDir, { recursive: true });
  }

  // Get items from the bundled defaults layer (includes code-embedded fallback)
  const defaultsLayer = readBundledDefaultsLayer();
  const items = defaultsLayer?.items ?? [];
  if (items.length === 0) return false;

  // Can only seed init-configs files if the bundled dir exists on disk
  if (!bundledDirExists) {
    return false;
  }

  let seeded = false;

  for (const item of items) {
    const initConfigs = item?.['init-setup']?.['init-configs'];
    if (!initConfigs || initConfigs.length === 0) continue;
    for (const entry of initConfigs) {
      // Check if this entry needs seeding before calling seedInitFromBundled
      const templated = normalizeInitEntry(entry.replace(/\{name\}/g, item.name));
      let needsSeed = false;
      if (hasGlobMeta(templated)) {
        const matches = await expandInitGlob(bundledDir, templated);
        for (const matched of matches) {
          if (!fsSync.existsSync(path.join(initDataDir, matched))) {
            needsSeed = true;
            break;
          }
        }
      } else if (!fsSync.existsSync(path.join(initDataDir, templated))) {
        needsSeed = true;
      }

      await seedInitFromBundled(bundledDir, initDataDir, entry, item.name);
      if (needsSeed) seeded = true;
    }
  }

  return seeded;
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
  if (typeof cmds === 'string') {
    return cmds || '  (no commands declared)';
  }
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

  const agentDir = getAgentDir();
  const defaultAgentDir = path.join(os.homedir(), '.pi', 'agent');
  const displayGlobal = options.globalPath
    ? options.globalPath.startsWith(agentDir)
      ? agentDir === defaultAgentDir
        ? options.globalPath.replace(agentDir, '~/.pi/agent')
        : options.globalPath
      : options.globalPath
    : '';

  const globalConfigLine = displayGlobal
    ? `\n                     ${displayGlobal}`
    : '';

  const choice = await options.ctx.ui.select(title, [
    'Trust once    - use the project-local config for this session only',
    'Trust always  - always use the project-local config, and remember the file hash.',
    `Reject        - use the global config for this session:${globalConfigLine}`,
  ]);
  if (choice === undefined) throw new Error('Cancelled');
  if (choice.startsWith('Trust once')) return { trusted: true, persist: false };
  if (choice.startsWith('Trust always')) {
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

  return {
    workspace,
    root,
    file,
    relFile,
    dir,
    relDir,
    config,
    configDir,
    name: options.name ?? '',
  };
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
  const fixTools = cleanCommands(object['fix-tools']);
  const initSetup = cleanInitSetup(object);
  return {
    name: object.name,
    include: cleanStringArray(object.include),
    exclude: cleanStringArray(object.exclude),
    anchors: cleanStringArray(object.anchors),
    maxFileSizeBytes: cleanNumber(object.maxFileSizeBytes),
    tools,
    'fix-tools': fixTools,
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

const DEFAULT_POSHIFIERS = [
  {
    name: 'go',
    include: ['**/*.go'],
    exclude: ['vendor/**'],
    anchors: ['go.mod'],
    tools: [
      { cmd: 'gofmt', args: ['-w', '{file}'], cwd: '{root}', timeoutMs: 25000 },
      {
        cmd: 'golangci-lint',
        args: ['run', '--new-from-rev=HEAD', '--timeout=25s', './{relDir}'],
        cwd: '{root}',
        timeoutMs: 30000,
      },
    ],
  },
  {
    name: 'python',
    include: ['**/*.py'],
    anchors: ['pyproject.toml', 'ruff.toml'],
    tools: [
      {
        cmd: 'uv',
        args: ['run', 'ruff', 'format', '{file}'],
        cwd: '{root}',
        timeoutMs: 25000,
      },
      {
        cmd: 'uv',
        args: ['run', 'ruff', 'check', '{file}'],
        cwd: '{root}',
        timeoutMs: 30000,
      },
    ],
    'fix-tools': [
      {
        cmd: 'uv',
        args: ['run', 'ruff', 'check', '--fix', '{file}'],
        cwd: '{root}',
        timeoutMs: 30000,
      },
    ],
  },
  {
    name: 'javascript',
    include: ['**/*.{js,jsx,mjs,cjs}'],
    exclude: ['node_modules/**', 'dist/**', '.next/**', '.svelte-kit/**', 'build/**'],
    anchors: ['package.json'],
    'init-setup': {
      'init-configs': [
        '.prettierrc',
        '.prettierignore',
        'eslint.config.mjs',
        'eslint-js.mjs',
      ],
      'init-tools': [
        {
          cmd: 'npm',
          args: [
            'install',
            '--save-dev',
            'prettier',
            'eslint',
            'eslint-config-prettier',
            'eslint-plugin-simple-import-sort',
            'eslint-plugin-unused-imports',
            'eslint-plugin-security',
            'eslint-plugin-no-unsanitized',
            'globals',
            '@eslint/js',
          ],
          cwd: '{root}',
          timeoutMs: 120000,
        },
      ],
    },
    tools: [
      {
        cmd: 'npm',
        args: ['exec', '--', 'prettier', '--write', '{file}'],
        cwd: '{root}',
        timeoutMs: 25000,
      },
      {
        cmd: 'npm',
        args: ['exec', '--', 'eslint', '--cache', '{file}'],
        cwd: '{root}',
        timeoutMs: 30000,
      },
    ],
    'fix-tools': [
      {
        cmd: 'npm',
        args: ['exec', '--', 'eslint', '--fix', '--cache', '{file}'],
        cwd: '{root}',
        timeoutMs: 120000,
      },
    ],
  },
  {
    name: 'typescript',
    include: ['**/*.{ts,tsx,mts,cts}'],
    exclude: ['node_modules/**', 'dist/**', '.next/**', '.svelte-kit/**', 'build/**'],
    anchors: ['package.json', 'tsconfig.json'],
    'init-setup': {
      'init-configs': [
        '.prettierrc',
        '.prettierignore',
        'eslint.config.mjs',
        'eslint-ts.mjs',
      ],
      'init-tools': [
        {
          cmd: 'npm',
          args: [
            'install',
            '--save-dev',
            'prettier',
            'eslint',
            'eslint-config-prettier',
            'eslint-plugin-simple-import-sort',
            'eslint-plugin-unused-imports',
            'eslint-plugin-security',
            'eslint-plugin-no-unsanitized',
            'globals',
            'typescript-eslint',
            'typescript',
          ],
          cwd: '{root}',
          timeoutMs: 120000,
        },
      ],
    },
    tools: [
      {
        cmd: 'npm',
        args: ['exec', '--', 'prettier', '--write', '{file}'],
        cwd: '{root}',
        timeoutMs: 25000,
      },
      {
        cmd: 'npm',
        args: ['exec', '--', 'eslint', '--cache', '{file}'],
        cwd: '{root}',
        timeoutMs: 30000,
      },
    ],
    'fix-tools': [
      {
        cmd: 'npm',
        args: ['exec', '--', 'eslint', '--fix', '--cache', '{file}'],
        cwd: '{root}',
        timeoutMs: 120000,
      },
    ],
  },
  {
    name: 'svelte',
    include: ['**/*.svelte'],
    exclude: ['node_modules/**', 'dist/**', '.next/**', '.svelte-kit/**', 'build/**'],
    anchors: ['package.json', 'svelte.config.js', 'svelte.config.ts'],
    'init-setup': {
      'init-configs': [
        '.prettierrc',
        '.prettierignore',
        'eslint.config.mjs',
        'eslint-svelte.mjs',
      ],
      'init-tools': [
        {
          cmd: 'npm',
          args: [
            'install',
            '--save-dev',
            'prettier',
            'eslint',
            'eslint-config-prettier',
            'eslint-plugin-simple-import-sort',
            'eslint-plugin-unused-imports',
            'eslint-plugin-security',
            'eslint-plugin-no-unsanitized',
            'globals',
            '@eslint/js',
            'eslint-plugin-svelte',
            'svelte',
            'typescript-eslint',
            'typescript',
          ],
          cwd: '{root}',
          timeoutMs: 120000,
        },
      ],
    },
    tools: [
      {
        cmd: 'npm',
        args: ['exec', '--', 'prettier', '--write', '{file}'],
        cwd: '{root}',
        timeoutMs: 25000,
      },
      {
        cmd: 'npm',
        args: ['exec', '--', 'eslint', '--cache', '{file}'],
        cwd: '{root}',
        timeoutMs: 30000,
      },
    ],
    'fix-tools': [
      {
        cmd: 'npm',
        args: ['exec', '--', 'eslint', '--fix', '--cache', '{file}'],
        cwd: '{root}',
        timeoutMs: 120000,
      },
    ],
  },
  {
    name: 'json',
    include: ['**/*.json'],
    exclude: ['node_modules/**', 'package-lock.json'],
    anchors: ['package.json'],
    'init-setup': {
      'init-configs': ['.prettierrc', '.prettierignore'],
      'init-tools': [
        {
          cmd: 'npm',
          args: ['install', '--save-dev', 'prettier', 'node-jq'],
          cwd: '{root}',
          timeoutMs: 120000,
        },
      ],
    },
    tools: [
      {
        cmd: 'npm',
        args: ['exec', '--', 'prettier', '--write', '{file}'],
        cwd: '{root}',
        timeoutMs: 15000,
      },
      {
        cmd: 'npm',
        args: ['exec', '--', 'node-jq', '-e', '"empty"', '{file}'],
        cwd: '{root}',
        timeoutMs: 15000,
      },
    ],
  },
  {
    name: 'yaml',
    include: ['**/*.{yaml,yml}'],
    exclude: ['node_modules/**'],
    anchors: ['package.json'],
    'init-setup': {
      'init-configs': ['.prettierrc', '.prettierignore'],
      'init-tools': [
        {
          cmd: 'npm',
          args: ['install', '--save-dev', 'prettier', 'yaml-lint'],
          cwd: '{root}',
          timeoutMs: 120000,
        },
      ],
    },
    tools: [
      {
        cmd: 'npm',
        args: ['exec', '--', 'prettier', '--write', '{file}'],
        cwd: '{root}',
        timeoutMs: 15000,
      },
      {
        cmd: 'npm',
        args: ['exec', '--', 'yaml-lint', '{file}'],
        cwd: '{root}',
        timeoutMs: 15000,
      },
    ],
  },
  {
    name: 'markdown',
    include: ['**/*.md'],
    exclude: ['node_modules/**'],
    anchors: ['package.json'],
    'init-setup': {
      'init-configs': ['.prettierrc', '.markdownlint.json'],
      'init-tools': [
        {
          cmd: 'npm',
          args: ['install', '--save-dev', 'prettier', 'markdownlint-cli'],
          cwd: '{root}',
          timeoutMs: 120000,
        },
      ],
    },
    tools: [
      {
        cmd: 'npm',
        args: ['exec', '--', 'prettier', '--write', '{file}'],
        cwd: '{root}',
        timeoutMs: 15000,
      },
      {
        cmd: 'npm',
        args: ['exec', '--', 'markdownlint', '{file}'],
        cwd: '{root}',
        timeoutMs: 15000,
      },
    ],
    'fix-tools': [
      {
        cmd: 'npm',
        args: ['exec', '--', 'markdownlint', '--fix', '{file}'],
        cwd: '{root}',
        timeoutMs: 15000,
      },
    ],
  },
];

function readBundledDefaultsLayer() {
  // First try reading from the bundled poshifiers.json.default file
  // Note: poshifiers.json.default is in the source dir (src/), NOT in init-configs/
  const defaultSource = path.join(getExtensionSourceDir(), 'poshifiers.json.default');
  try {
    if (fsSync.existsSync(defaultSource)) {
      const raw = fsSync.readFileSync(defaultSource, 'utf8');
      const parsed = JSON.parse(raw);
      return {
        scope: 'defaults',
        path: defaultSource,
        dir: path.dirname(defaultSource),
        raw,
        hash: sha256(raw),
        items: parsePoshifyItems(parsed),
      };
    }
  } catch {
    // fall through to code defaults
  }

  // Ultimate fallback: code-embedded defaults (pi-tool-display pattern)
  return {
    scope: 'defaults',
    path: '<code-embedded>',
    dir: '',
    raw: '',
    hash: '',
    items: DEFAULT_POSHIFIERS.map((item) => cleanPoshifier(item)).filter(Boolean),
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

function commandsForPoshifySection(items, section) {
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

function commandsForPoshify(items) {
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
  return sections.join('\n\n');
}

async function loadPoshifyConfig(ctx, cache) {
  if (cache && cache.ready) {
    return cache.value;
  }

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

  if (layers.length === 0) {
    const defaultsLayer = readBundledDefaultsLayer();
    if (defaultsLayer) layers.push(defaultsLayer);
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

  if (cache) {
    cache.value = result;
    cache.ready = true;
  }

  return result;
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
    const bgKey = hasIssueOutput(text) ? 'toolErrorBg' : 'toolSuccessBg';
    const box = new Box(1, 1, (value) => theme.bg(bgKey, value));
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

function commandDisplayName(cmd, args) {
  const basename = path.basename(cmd);
  if (basename === 'npx' && args?.length > 0) {
    return `npx ${args[0]}`;
  }
  if (basename === 'uv' && args?.[0] === 'run' && args?.length > 1) {
    return `uv run ${args[1]}`;
  }
  if (
    basename === 'npm' &&
    args?.[0] === 'exec' &&
    args?.[1] === '--' &&
    args?.length > 2
  ) {
    return `npm exec ${args[2]}`;
  }
  return cmd;
}

async function readFileContent(file) {
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
      name: tool.name,
    },
  );

  if (!isExecutableAvailable(command.cmd)) {
    return {
      line: `⚠️ ${tool.name}: command not found: ${command.cmd}`,
      diagnostics: false,
    };
  }

  const before = await readFileContent(options.file);
  const result = await runCommand(command, options.ctx.signal);

  if (result.code === 0) {
    const after = await readFileContent(options.file);
    const relFile = command.placeholders.relFile;
    const displayName = commandDisplayName(command.cmd, command.args);
    return {
      line:
        before === after
          ? `✅ ${tool.name}: ${displayName} checked ${relFile}`
          : `✅ ${tool.name}: ${displayName} modified ${relFile}`,
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

async function runPoshifyForFileSet(ctx, files, cache) {
  if (files.size === 0) return '';

  const loaded = await loadPoshifyConfig(ctx, cache);
  const warnings = [...loaded.warnings];
  const projectLayer = loaded.layers.find((layer) => layer.scope === 'project');
  const workspace = projectLayer ? path.dirname(projectLayer.dir) : ctx.cwd;

  if (loaded.items.length === 0) {
    const header = formatConfigHeader(loaded);
    const parts =
      warnings.length > 0
        ? [warnings.map((w) => (w.startsWith('ℹ️') ? w : `⚠️ ${w}`)).join('\n')]
        : [];
    if (parts.length === 0) return `${header}:`;
    return `${header}:\n${parts.join('\n\n')}`;
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

  const header = formatConfigHeader(loaded);
  const parts = [];
  if (warnings.length > 0)
    parts.push(warnings.map((w) => (w.startsWith('ℹ️') ? w : `⚠️ ${w}`)).join('\n'));
  if (allLines.length > 0) parts.push(allLines.join('\n'));
  if (parts.length === 0) return `${header}:`;
  return `${header}:\n${parts.join('\n\n')}`;
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

async function runPoshifyBatch(ctx, inputPath, cache) {
  const absolutePath = toAbsolutePath(inputPath, ctx.cwd);
  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch {
    return `⚠️ Path not found: ${inputPath}`;
  }

  const loaded = await loadPoshifyConfig(ctx, cache);
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

  const header = formatConfigHeader(loaded);
  const parts = [];
  if (warnings.length > 0)
    parts.push(warnings.map((w) => (w.startsWith('ℹ️') ? w : `⚠️ ${w}`)).join('\n'));
  if (allLines.length > 0) parts.push(allLines.join('\n'));
  if (parts.length === 0) return `${header}:`;
  return `${header}:\n${parts.join('\n\n')}`;
}

function normalizeInitEntry(entry) {
  // Treat trailing /** and trailing / as directory references
  return entry.replace(/\/\*\*$/, '').replace(/\/$/, '');
}

function stripNamePrefix(relPath, name) {
  const prefix = name + '/';
  if (relPath.startsWith(prefix)) return relPath.slice(prefix.length);
  return relPath;
}

function hasGlobMeta(pattern) {
  return pattern.includes('*') || pattern.includes('?') || pattern.includes('{');
}

async function expandInitGlob(baseDir, pattern) {
  const results = [];
  const dirPart = path.dirname(pattern);
  const baseName = path.basename(pattern);
  const baseDirAbs = path.join(baseDir, dirPart);
  if (!fsSync.existsSync(baseDirAbs)) return [];
  const entries = await fs.readdir(baseDirAbs, { withFileTypes: true });
  for (const entry of entries) {
    if (matchesGlob(baseName, entry.name)) {
      results.push(path.join(dirPart, entry.name));
    }
  }
  return results;
}

async function copyFileOrDir(src, dest, copied, skipped, cwd) {
  const stat = fsSync.statSync(src);
  if (stat.isDirectory()) {
    if (fsSync.existsSync(dest) && !fsSync.statSync(dest).isDirectory()) {
      throw new Error(
        `Cannot copy directory ${src} to ${dest} — destination exists as a file`,
      );
    }
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      await copyFileOrDir(
        path.join(src, entry.name),
        path.join(dest, entry.name),
        copied,
        skipped,
        cwd,
      );
    }
  } else {
    const rel = cwd ? normalizeRelativePath(path.relative(cwd, dest)) : dest;
    if (fsSync.existsSync(dest)) {
      if (skipped) skipped.push(rel);
    } else {
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.copyFile(src, dest);
      if (copied) copied.push(rel);
    }
  }
}

async function seedInitFromBundled(bundledDir, userDir, entry, name) {
  const templated = normalizeInitEntry(entry.replace(/\{name\}/g, name));
  if (hasGlobMeta(templated)) {
    const matches = await expandInitGlob(bundledDir, templated);
    for (const matched of matches) {
      const destUser = path.join(userDir, matched);
      if (fsSync.existsSync(destUser)) continue;
      const srcBundled = path.join(bundledDir, matched);
      if (fsSync.existsSync(srcBundled)) {
        const destParent = path.dirname(destUser);
        await fs.mkdir(destParent, { recursive: true });
        await copyFileOrDir(srcBundled, destUser);
      }
    }
    return;
  }
  const destUser = path.join(userDir, templated);
  const srcBundled = path.join(bundledDir, templated);
  if (!fsSync.existsSync(destUser) && fsSync.existsSync(srcBundled)) {
    await copyFileOrDir(srcBundled, destUser);
  }
}

async function copyInitToProject(userDir, cwd, entry, name, copied, skipped) {
  const templated = normalizeInitEntry(entry.replace(/\{name\}/g, name));

  if (hasGlobMeta(templated)) {
    const matches = await expandInitGlob(userDir, templated);
    if (matches.length === 0) {
      throw new Error(`Init config glob matched nothing for "${name}": ${templated}`);
    }
    for (const matched of matches) {
      const destRel = stripNamePrefix(matched, name);
      await copyFileOrDir(
        path.join(userDir, matched),
        path.join(cwd, destRel),
        copied,
        skipped,
        cwd,
      );
    }
    return;
  }

  const srcPath = path.join(userDir, templated);
  if (!fsSync.existsSync(srcPath)) {
    throw new Error(
      `Init config not found for "${name}": ${templated} (expected at ${srcPath})`,
    );
  }
  const destRel = stripNamePrefix(templated, name);
  const destPath = path.join(cwd, destRel);
  await copyFileOrDir(srcPath, destPath, copied, skipped, cwd);
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
  const initDataDir = getInitConfigsDataDir();

  // Seed user-level init-configs from bundled templates if not present
  await ensureUserConfigDir();
  for (const entry of configs) {
    await seedInitFromBundled(bundledDir, initDataDir, entry, name);
  }

  const copied = [];
  const skipped = [];

  for (const entry of configs) {
    await copyInitToProject(initDataDir, cwd, entry, name, copied, skipped);
  }

  // Run init-tools with name placeholder and root=cwd
  const toolResults = [];
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
    const output = commandOutput(result);
    if (result.code !== 0) {
      const err = new Error(
        `Init tool "${command.cmd}" failed with exit code ${result.code}${result.killed ? ' (killed/timeout)' : ''}${output ? ':\n' + output : ''}`,
      );
      err.cause = result;
      throw err;
    }
    toolResults.push({ cmd: command.cmd, args: command.args, output });
  }

  return { copied, skipped, toolResults, cwd };
}

async function runFixers(ctx, inputPath, cache) {
  const absolutePath = resolveAtPath(inputPath, ctx.cwd);
  const loaded = await loadPoshifyConfig(ctx, cache);
  const warnings = [...loaded.warnings];
  const projectLayer = loaded.layers.find((layer) => layer.scope === 'project');
  const workspace = projectLayer ? path.dirname(projectLayer.dir) : ctx.cwd;

  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch {
    const header = `${formatConfigHeader(loaded)} --fix`;
    return `${header}:\n⚠️ Path not found: ${inputPath}`;
  }

  const files = [];
  if (stats.isDirectory()) {
    for await (const file of walkFiles(absolutePath)) {
      files.push(file);
    }
  } else {
    files.push(absolutePath);
  }

  const allLines = [];
  for (const file of files) {
    const { matches, warnings: matchWarnings } = await matchTools(
      ctx,
      loaded.items,
      file,
    );
    warnings.push(...matchWarnings);
    for (const match of matches) {
      const fixTools = match.tool['fix-tools'];
      if (!fixTools || fixTools.length === 0) continue;
      const maxFileSizeBytes =
        match.tool.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
      if (!(await fileSizeAllowed(file, maxFileSizeBytes))) {
        allLines.push(
          `⚠️ ${match.tool.name}: skipped ${file}; file exceeds maxFileSizeBytes (${maxFileSizeBytes})`,
        );
        continue;
      }
      for (let i = 0; i < fixTools.length; i += 1) {
        const fixTool = fixTools[i];
        const command = resolveCommand(`${match.tool.name} fix-${i + 1}`, fixTool, {
          workspace,
          root: match.root,
          file,
          name: match.tool.name,
        });
        if (!isExecutableAvailable(command.cmd)) {
          allLines.push(`⚠️ ${match.tool.name}: command not found: ${command.cmd}`);
          continue;
        }
        const result = await runCommand(command, ctx.signal);
        const displayName = commandDisplayName(command.cmd, command.args);
        const relFile = command.placeholders.relFile;
        if (result.code === 0) {
          const output = commandOutput(result);
          allLines.push(
            output
              ? `✅ ${match.tool.name}: ${displayName} fixed ${relFile}\n${output}`
              : `✅ ${match.tool.name}: ${displayName} fixed ${relFile}`,
          );
        } else {
          allLines.push(formatCommandIssue(match.tool.name, displayName, result));
        }
      }
    }
  }

  const header = `${formatConfigHeader(loaded)} --fix`;
  const parts = [];
  if (warnings.length > 0) parts.push(warnings.map((w) => `⚠️ ${w}`).join('\n'));
  if (allLines.length > 0) parts.push(allLines.join('\n'));
  if (parts.length === 0) return `${header}:`;
  return `${header}:\n\n${parts.join('\n\n')}`;
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
  /** @type {{ ready: boolean, value: { items: any[], layers: any[], warnings: string[] } | undefined }} */
  const configCache = { ready: false, value: undefined };

  registerDiagnosticsRenderer(pi);

  // Eagerly seed global config on load (mid-session installs need this)
  await seedPoshifyDefaults();
  await seedAllInitConfigs();

  pi.on('session_start', async (_event, ctx) => {
    const configSeeded = await seedPoshifyDefaults();
    const initSeeded = await seedAllInitConfigs();
    if ((configSeeded || initSeeded) && ctx?.hasUI) {
      ctx.ui.notify(`Poshify defaults installed to ${getExtensionDataDir()}`, 'info');
    }

    // Warm the cache while TUI is idle; avoids flickering trust dialog
    // during streaming tool results.
    try {
      await loadPoshifyConfig(ctx, configCache);
    } catch {
      // Trust prompt itself may throw "Cancelled" if the user hits Escape
      // during session_start. Gracefully ignore; cache stays un-ready
      // and a later load (e.g. explicit /poshify) will retry.
    }
  });

  function startPoshifySpinner(ctx, label, target) {
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let frameIndex = 0;
    const animationId = setInterval(() => {
      const frame = frames[frameIndex];
      ctx.ui.setWidget('poshify-loader', [
        ctx.ui.theme.fg('accent', '┏━━ Pi Poshify Tool ━━━━━━━━━━━━━━━━━━━━━'),
        `${ctx.ui.theme.fg('muted', '┃')} ${label}`,
        `${ctx.ui.theme.fg('muted', '┃')} Target: ${ctx.ui.theme.fg('dim', target)}`,
        ctx.ui.theme.fg('accent', `┗━━ ${frame} Working...`),
      ]);
      frameIndex = (frameIndex + 1) % frames.length;
    }, 80);
    return animationId;
  }

  function stopPoshifySpinner(ctx, animationId) {
    clearInterval(animationId);
    ctx.ui.setWidget('poshify-loader', undefined);
  }

  pi.registerCommand('poshify', {
    description:
      'Run configured tools on a file or directory (/poshify --help for more)',
    handler: async (args, ctx) => {
      const trimmed = normalizeUnicodeSpaces(args?.trim() || '');

      let config;
      try {
        config = await loadPoshifyConfig(ctx, configCache);
      } catch (error) {
        if (error.message === 'Cancelled') {
          const trustConfigPath = findUp(ctx.cwd, path.join('.pi', 'poshifiers.json'));
          const displayPath = trustConfigPath
            ? path.basename(path.dirname(trustConfigPath)) + '/.pi/poshifiers.json'
            : 'project-local .pi/poshifiers.json';
          pi.sendMessage(
            {
              customType: 'pi-posher',
              content: '',
              display: true,
              details: {
                path: ctx.cwd,
                summary: `⚠️ User cancelled request to accept or reject \`${displayPath}\` file as trusted.`,
              },
            },
            { deliverAs: 'steer' },
          );
          return;
        }
        throw error;
      }
      const availableInits = config.items
        .filter((item) => item?.['init-setup'])
        .map((item) => item.name)
        .sort();

      const usage = [
        ` /poshify (file|dir)          # Run configured tools for file or directory`,
        ` /poshify --init <name>       # Install init configs for a poshifier type`,
        ` /poshify --fix [file|dir]    # Run configured fix-tools`,
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
            details: {
              path: ctx.cwd,
              summary: `${formatConfigHeader(config)}\n\n${usage}`,
            },
          },
          { deliverAs: 'steer' },
        );
        return;
      }

      // Tokenize the input for robust flag parsing
      const tokens = trimmed.split(/\s+/).filter(Boolean);
      const hasInitFlag = tokens.some((t) => t === '--init' || t === '-init');
      const hasFixFlag = tokens.some((t) => t === '--fix' || t === '-fix');

      if (hasInitFlag) {
        // Find the name after the --init flag
        const initIdx = tokens.findIndex((t) => t === '--init' || t === '-init');
        const initName = tokens.slice(initIdx + 1).find((t) => !t.startsWith('-'));
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
        const initSpinner = poshifier?.['init-setup']
          ? startPoshifySpinner(ctx, `Installing ${initName} tools...`, ctx.cwd)
          : undefined;
        try {
          if (!poshifier) {
            summary = `${formatConfigHeader(config)}\n\n⚠️ No poshifier named "${initName}" found.${config.warnings.length > 0 ? '\n' + config.warnings.join('\n') : ''}`;
          } else if (!poshifier['init-setup']) {
            summary = `${formatConfigHeader(config)}\n\n⚠️ Poshifier "${initName}" has no init-setup defined.`;
          } else {
            const result = await runInitByName(ctx, poshifier, initName);
            const fileParts = [];
            if (result.copied.length > 0)
              fileParts.push(`Copied: ${result.copied.join(', ')}`);
            if (result.skipped.length > 0)
              fileParts.push(
                `Skipped copying (already exist): ${result.skipped.join(', ')}`,
              );
            if (result.copied.length === 0 && result.skipped.length === 0)
              fileParts.push('No config files to copy.');
            const toolParts = [];
            for (const tr of result.toolResults ?? []) {
              const cmdLine = tr.args?.length
                ? `${tr.cmd} ${tr.args.join(' ')}`
                : tr.cmd;
              toolParts.push(
                tr.output ? `✅ ${cmdLine}\n${tr.output}` : `✅ ${cmdLine}`,
              );
            }
            const sections = [
              `${formatConfigHeader(config)}\n\n${fileParts.join('\n')}`,
            ];
            if (toolParts.length > 0) sections.push(toolParts.join('\n'));
            summary = `${result.cwd}\n${sections.join('\n\n')}`;
            if (ctx.hasUI) {
              ctx.ui.notify(
                `Poshify init for "${initName}" installed to ${result.cwd}`,
                'info',
              );
            }
          }
        } catch (error) {
          if (error.message === 'Aborted' || error.message === 'Cancelled') {
            summary = '  Init cancelled';
          } else {
            summary = `⚠️ init failed: ${error.message}`;
          }
        } finally {
          if (initSpinner) stopPoshifySpinner(ctx, initSpinner);
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

      if (hasFixFlag) {
        const fixIdx = tokens.findIndex((t) => t === '--fix' || t === '-fix');
        const fixTarget =
          tokens.slice(fixIdx + 1).find((t) => !t.startsWith('-')) || '.';
        const fixSpinner = startPoshifySpinner(ctx, 'Running fix...', fixTarget);
        let summary;
        try {
          summary = await runFixers(ctx, fixTarget, configCache);
        } catch (error) {
          if (error.message === 'Aborted' || error.message === 'Cancelled') {
            summary = '  Fix cancelled';
          } else {
            summary = `  Fix error: ${error.message}`;
          }
        } finally {
          stopPoshifySpinner(ctx, fixSpinner);
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

      const targetPath = resolveAtPath(trimmed, ctx.cwd);

      const animationId = startPoshifySpinner(ctx, 'Running tools...', targetPath);

      let summary;
      try {
        summary = await runPoshifyBatch(ctx, targetPath, configCache);
      } catch (error) {
        if (error.message === 'Aborted' || error.message === 'Cancelled') {
          summary = '  Poshify cancelled';
        } else {
          summary = `  Poshify error: ${error.message}`;
        }
      } finally {
        stopPoshifySpinner(ctx, animationId);
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
        const summary = await runPoshifyBatch(
          ctx,
          resolveAtPath(params.path, ctx.cwd),
          configCache,
        );
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

    if (ctx.hasUI) {
      ctx.ui.setStatus('posher', `poshify: running ${path.basename(absoluteFile)}...`);
    }

    let summary;
    try {
      summary = await runPoshifyForFileSet(ctx, new Set([absoluteFile]), configCache);
    } catch (error) {
      summary = `  Poshify error: ${error.message}`;
    }

    if (ctx.hasUI) {
      ctx.ui.setStatus('posher', undefined);
    }

    if (summary && summary.trim()) {
      pi.sendMessage(
        {
          customType: 'pi-posher',
          content: '',
          display: true,
          details: { path: ctx.cwd, summary },
        },
        { deliverAs: 'steer' },
      );
    }

    return undefined;
  });
}
