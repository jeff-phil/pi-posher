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
  return output.includes('⚠️') || /\b(warning|warn)\b/i.test(output);
}

/**
 * Apply theme highlights to a single line of poshify output.
 * Highlights tool names, "succeeded", and "failed" keywords.
 *
 * @param {{ fg: (key: string, text: string) => string }} theme
 * @param {string} line
 * @returns {string}
 */
export function colorizeLine(theme, line) {
  if (line.startsWith('ℹ️')) {
    return theme.fg('muted', line);
  }
  const base = (t) => theme.fg('toolOutput', t);
  const label = (t) => theme.fg(line.startsWith('⚠️') ? 'error' : 'accent', t);
  const highlights = [];

  // ✅/⚠️ toolName: …
  let m1;
  if (line.startsWith('✅') || line.startsWith('⚠️')) {
    m1 = line.match(/^(\S?)\s+([^\s:]+)(\s*:)/);
  }
  if (m1) {
    // m1[0] = "✅ toolName:"  m1[1] = "✅"  m1[2] = "toolName"  m1[3] = ":"
    // m1[1].length for emoji may be >1 (surrogate pairs), so locate the
    // tool name inside the matched string instead of counting characters.
    const toolStart = m1[0].indexOf(m1[2]);
    const startIdx = m1.index + toolStart;
    const endIdx = startIdx + m1[2].length;
    highlights.push({ start: startIdx, end: endIdx });
  }

  // ✅/⚠️ bareName succeeded/failed (no colon on line)
  if (!m1 && (line.startsWith('✅') || line.startsWith('⚠️'))) {
    const m2 = line.match(/^\S+\s+([^\s:]+)/);
    if (m2) {
      const start = m2[0].length - m2[1].length;
      const end = start + m2[1].length;
      highlights.push({ start, end });
    }
  }

  // succeeded
  const succRe = /\bsucceeded\b/g;
  let sm;
  while ((sm = succRe.exec(line)) !== null) {
    highlights.push({ start: sm.index, end: sm.index + sm[0].length });
  }

  // failed
  const failRe = /\bfailed\b/g;
  let fm;
  while ((fm = failRe.exec(line)) !== null) {
    highlights.push({ start: fm.index, end: fm.index + fm[0].length });
  }

  if (highlights.length === 0) return base(line);

  highlights.sort((a, b) => a.start - b.start);
  const merged = [highlights[0]];
  for (let i = 1; i < highlights.length; i++) {
    if (highlights[i].start <= merged[merged.length - 1].end) {
      merged[merged.length - 1].end = Math.max(
        merged[merged.length - 1].end,
        highlights[i].end,
      );
    } else {
      merged.push(highlights[i]);
    }
  }

  let result = '';
  let pos = 0;
  for (const h of merged) {
    if (h.start > pos) result += base(line.slice(pos, h.start));
    result += label(line.slice(h.start, h.end));
    pos = h.end;
  }
  if (pos < line.length) result += base(line.slice(pos));
  return result;
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
