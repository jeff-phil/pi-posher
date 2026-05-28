import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { applyTemplate, applyTemplateArray, applyTemplateRecord } from './template.mjs';

export function expandHome(input) {
  if (input === '~') return os.homedir();
  if (input.startsWith('~/')) return path.join(os.homedir(), input.slice(2));
  return input;
}

export function toAbsolutePath(inputPath, cwd) {
  const expanded = expandHome(inputPath);
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(cwd, expanded);
}

export function normalizeRelativePath(inputPath) {
  const normalized = inputPath.split(path.sep).join('/');
  return normalized === '' ? '.' : normalized;
}

export async function markerExists(candidateDir, marker) {
  try {
    await fs.access(path.resolve(candidateDir, marker));
    return true;
  } catch {
    return false;
  }
}

export async function findProjectRoot(filePath, anchors, fallbackRoot) {
  const absoluteFile = toAbsolutePath(filePath, fallbackRoot);
  let stat;
  try {
    stat = await fs.stat(absoluteFile);
  } catch {
    /* not found */
  }
  let dir = stat?.isDirectory() ? absoluteFile : path.dirname(absoluteFile);
  const markers = anchors?.filter(Boolean) ?? [];

  if (markers.length === 0) {
    return toAbsolutePath(fallbackRoot, fallbackRoot);
  }

  while (true) {
    const results = await Promise.all(markers.map((m) => markerExists(dir, m)));
    if (results.some(Boolean)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export async function findUp(startDir, relativeFile) {
  let dir = toAbsolutePath(startDir, process.cwd());
  while (true) {
    const candidate = path.join(dir, relativeFile);
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* not found */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function resolveConfigPath(config, root, baseValues) {
  if (!config) return undefined;
  const templated = applyTemplate(config, baseValues);
  const expanded = expandHome(templated);
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(root, expanded);
}

export function createPathPlaceholders(options) {
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

export function findExecutable(bin) {
  if (path.isAbsolute(bin) || bin.includes('/') || bin.includes('\\'))
    return isExecutable(bin) ? bin : undefined;
  return pathCandidates(bin).find(isExecutable);
}

export function isExecutableAvailable(bin) {
  return !!findExecutable(bin);
}

export function resolveExecutable(bin, root) {
  const expanded = expandHome(bin);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  if (expanded.includes('/') || expanded.includes('\\'))
    return path.resolve(root, expanded);
  return findExecutable(expanded) || expanded;
}

export function resolveWorkingDirectory(cwd, root, values) {
  if (!cwd) return root;
  const templated = applyTemplate(cwd, values);
  const expanded = expandHome(templated);
  return path.isAbsolute(expanded)
    ? path.normalize(expanded)
    : path.resolve(root, expanded);
}

export function resolveCommand(id, command, options) {
  const baseValues = createPathPlaceholders({
    workspace: options.workspace,
    root: options.root,
    file: options.file,
    name: options.name,
  });
  const configPath = resolveConfigPath(command.config, options.root, baseValues);
  const values = createPathPlaceholders({
    workspace: options.workspace,
    root: options.root,
    file: options.file,
    config: configPath,
    name: options.name,
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

export function normalizeUnicodeSpaces(str) {
  return str.replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ');
}

export function resolveAtPath(input, cwd) {
  const raw = normalizeUnicodeSpaces(input?.trim() || '.');
  if (!raw.startsWith('@')) return toAbsolutePath(raw, cwd);
  const withAt = toAbsolutePath(raw, cwd);
  if (fsSync.existsSync(withAt)) return withAt;
  return toAbsolutePath(raw.slice(1), cwd);
}
