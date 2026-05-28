import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { sha256 as sha256 } from './lib/crypto.mjs';

// ── agent dir resolution (lazy to avoid hard peer-dep at import time) ──

let _agentDirOverride = undefined;
let _getAgentDirFn = undefined;

// Top-level await: resolve once at module load. If the Pi agent is not
// present (tests / standalone) the catch silently swallows the error and
// _getAgentDirFn stays undefined — callers must use _setAgentDir or
// accept that getAgentDir() will throw.
try {
  const mod = await import('@earendil-works/pi-coding-agent');
  _getAgentDirFn = mod.getAgentDir;
} catch {
  // Pi agent not available — _setAgentDir() must be used in tests
}

/**
 * Test-only hook to override the agent directory without requiring the
 * Pi agent runtime. Call `_setAgentDir('/path')` before tests; pass
 * `undefined` to restore normal behaviour.
 *
 * WARNING: This mutates shared module state. Tests that use it must run
 * with `{ concurrency: false }` and reset the override in `after` hooks
 * to avoid flakes when run concurrently with other tests that also use it.
 */
export function _setAgentDir(dir) {
  _agentDirOverride = dir;
}

function getAgentDir() {
  if (_agentDirOverride) return _agentDirOverride;
  if (_getAgentDirFn) return _getAgentDirFn();
  // Fallback for environments where the Pi agent package isn't resolvable
  // (e.g. missing node_modules symlink).
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent');
}

export function getExtensionDataDir() {
  return path.join(getAgentDir(), 'extensions', 'pi-posher');
}

// ── init-configs discovery ────────────────────────────────────────────

export function getInitConfigsDir() {
  // Strategy 1: Use import.meta.url (works when loaded natively as ESM)
  try {
    if (typeof import.meta?.url === 'string') {
      const dir = path.dirname(fileURLToPath(import.meta.url));
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

export function getExtensionSourceDir() {
  const initConfigsDir = getInitConfigsDir();
  if (initConfigsDir && fsSync.existsSync(initConfigsDir)) {
    return path.dirname(initConfigsDir);
  }
  try {
    if (typeof import.meta?.url === 'string') {
      const dir = path.dirname(fileURLToPath(import.meta.url));
      if (fsSync.existsSync(path.join(dir, 'poshifiers.json.default'))) return dir;
    }
  } catch {
    // ignore
  }
  return initConfigsDir ? path.dirname(initConfigsDir) : '';
}

export function getInitConfigsDataDir() {
  return path.join(getExtensionDataDir(), 'init-configs');
}

// ── trust store ───────────────────────────────────────────────────────

export async function ensureUserConfigDir() {
  const userDir = getExtensionDataDir();
  if (!fsSync.existsSync(userDir)) {
    await fs.mkdir(userDir, { recursive: true });
  }
  return userDir;
}

export async function readTrustStore(storePath) {
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

export async function writeTrustStore(storePath, store) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
}

export async function isHashTrusted(kind, hash) {
  const storePath = path.join(getExtensionDataDir(), 'trust', `${kind}.json`);
  const store = await readTrustStore(storePath);
  return store.trustedHashes.includes(hash);
}

export async function rememberTrustedHash(kind, hash) {
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

export async function askProjectConfigTrust(options) {
  const { ctx, kind, hash, configPath, commands, initConfigs, globalPath } = options;

  if (await isHashTrusted(kind, hash)) return { trusted: true, persist: true };

  if (!ctx.hasUI) {
    return {
      trusted: false,
      persist: false,
      reason: 'project-local config rejected in non-interactive mode',
    };
  }

  const lines = [
    `Project-local ${kind} config wants to auto-run commands.`,
    '',
    `Config: ${configPath}`,
    `Hash: ${hash}`,
    '',
    'Commands:',
    formatCommandList(commands),
  ];

  if (initConfigs && initConfigs.length > 0) {
    lines.push('');
    lines.push('Init configs (files copied to project on `--init`):');
    lines.push(...initConfigs.map((c) => `  - ${c}`));
  }

  lines.push('');
  lines.push('Trust this config?');

  const title = lines.join('\n');

  const agentDir = getAgentDir();
  const defaultAgentDir = path.join(os.homedir(), '.pi', 'agent');
  const displayGlobal = globalPath
    ? globalPath.startsWith(agentDir)
      ? agentDir === defaultAgentDir
        ? globalPath.replace(agentDir, '~/.pi/agent')
        : globalPath
      : globalPath
    : '';

  const globalConfigLine = displayGlobal
    ? `\n                     ${displayGlobal}`
    : '';

  const choice = await ctx.ui.select(title, [
    'Trust once    - use the project-local config for this session only',
    'Trust always  - always use the project-local config, and remember the file hash.',
    `Reject        - use the global config for this session:${globalConfigLine}`,
  ]);
  if (choice === undefined) throw new Error('Cancelled');
  if (choice.startsWith('Trust once')) return { trusted: true, persist: false };
  if (choice.startsWith('Trust always')) {
    await rememberTrustedHash(kind, hash);
    return { trusted: true, persist: true };
  }
  return {
    trusted: false,
    persist: false,
    reason: 'project-local config rejected by user',
  };
}
