import os from 'node:os';
import path from 'node:path';

// Lazy resolution — same pattern as trust.mjs to avoid hard peer-dep at
// import time. Only needed for tilde-shortening the global config path.
let _getAgentDirFn = undefined;
try {
  const mod = await import('@earendil-works/pi-coding-agent');
  _getAgentDirFn = mod.getAgentDir;
} catch {
  // Pi agent not available (tests / standalone)
}

const DEFAULT_OUTPUT_LIMIT = 4000;

export function truncateOutput(output, limit = DEFAULT_OUTPUT_LIMIT) {
  const normalized = output.trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit)}\n… output truncated (${normalized.length - limit} more characters)`;
}

export function commandOutput(result) {
  return truncateOutput(
    [result.stdout, result.stderr].filter((part) => part.trim().length > 0).join('\n'),
  );
}

export function hasIssueOutput(output) {
  return output.includes('⚠️');
}

export function formatConfigHeader(loaded) {
  const projectLayer = loaded.layers.find((l) => l.scope === 'project');
  if (projectLayer) return `Poshify (${projectLayer.path})`;
  const globalLayer = loaded.layers.find((l) => l.scope === 'global');
  if (globalLayer) {
    let displayPath = globalLayer.path;
    // Shorten the agent directory path for readability using the real
    // getAgentDir() (which may resolve to a non-default location via
    // env vars or config). Fall back to the standard path if the Pi
    // agent is not available.
    if (_getAgentDirFn) {
      try {
        const agentDir = _getAgentDirFn();
        const defaultAgentDir = path.join(os.homedir(), '.pi', 'agent');
        if (agentDir === defaultAgentDir && displayPath.startsWith(agentDir)) {
          displayPath = displayPath.replace(agentDir, '~/.pi/agent');
        }
      } catch {
        // getAgentDir() failed — use raw path
      }
    }
    return `Poshify (${displayPath})`;
  }
  return 'Poshify (built-in defaults)';
}
