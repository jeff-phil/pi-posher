import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { hasGlobMeta, matchesGlob } from './lib/glob.mjs';
import { commandOutput } from './lib/output.mjs';
import { normalizeRelativePath } from './lib/paths.mjs';
import { applyTemplate, applyTemplateArray } from './lib/template.mjs';
import {
  ensureUserConfigDir,
  getExtensionDataDir,
  getExtensionSourceDir,
  getInitConfigsDataDir,
  getInitConfigsDir,
} from './trust.mjs';

export async function seedPoshifyDefaults() {
  const configFile = path.join(getExtensionDataDir(), 'poshifiers.json');
  const defaultSource = path.join(getExtensionSourceDir(), 'poshifiers.json.default');
  if (!fsSync.existsSync(configFile) && fsSync.existsSync(defaultSource)) {
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.copyFile(defaultSource, configFile);
    return true;
  }
  return false;
}

export async function seedAllInitConfigs(defaultsLayer) {
  const initDataDir = getInitConfigsDataDir();
  const bundledDir = getInitConfigsDir();
  const bundledDirExists = fsSync.existsSync(bundledDir);

  if (!fsSync.existsSync(initDataDir)) {
    await fs.mkdir(initDataDir, { recursive: true });
  }

  const items = defaultsLayer?.items ?? [];
  if (items.length === 0) return false;

  if (!bundledDirExists) {
    return false;
  }

  let seeded = false;

  for (const item of items) {
    const initConfigs = item?.['init-setup']?.['init-configs'];
    if (!initConfigs || initConfigs.length === 0) continue;
    for (const entry of initConfigs) {
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

      if (needsSeed) {
        await seedInitFromBundled(bundledDir, initDataDir, entry, item.name);
        seeded = true;
      }
    }
  }

  return seeded;
}

// ── init helpers ──────────────────────────────────────────────────────

export function normalizeInitEntry(entry) {
  return entry.replace(/\/\*\*$/, '').replace(/\/$/, '');
}

export function stripNamePrefix(relPath, name) {
  const prefix = name + '/';
  if (relPath.startsWith(prefix)) return relPath.slice(prefix.length);
  return relPath;
}

export async function expandInitGlob(baseDir, pattern) {
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

export async function copyFileOrDir(src, dest, copied, skipped, cwd) {
  let stat;

  try {
    stat = await fs.stat(src);
  } catch (err) {
    if (err.code === 'ENOENT') {
      return;
    }
    throw err;
  }

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

export async function seedInitFromBundled(bundledDir, userDir, entry, name) {
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

export async function copyInitToProject(userDir, cwd, entry, name, copied, skipped) {
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

export async function runInitByName(ctx, poshifier, name, runner) {
  const cwd = ctx.cwd;
  const initSetup = poshifier?.['init-setup'];
  if (!initSetup) {
    throw new Error(`No init-setup defined for "${name}".`);
  }
  const configs = initSetup['init-configs'] ?? [];
  const tools = initSetup['init-tools'] ?? [];
  const bundledDir = getInitConfigsDir();
  const initDataDir = getInitConfigsDataDir();

  await ensureUserConfigDir();
  for (const entry of configs) {
    await seedInitFromBundled(bundledDir, initDataDir, entry, name);
  }

  const copied = [];
  const skipped = [];

  for (const entry of configs) {
    await copyInitToProject(initDataDir, cwd, entry, name, copied, skipped);
  }

  const toolResults = [];
  const baseValues = { name, root: cwd, workspace: cwd };
  for (const tool of tools) {
    const command = {
      id: `init-${name}`,
      cmd: applyTemplate(tool.cmd, baseValues),
      args: applyTemplateArray(tool.args, baseValues),
      cwd: applyTemplate(tool.cwd ?? cwd, baseValues),
      env: tool.env,
      timeoutMs: tool.timeoutMs,
    };
    const result = await runner(command, ctx.signal);
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
