import path from 'node:path';

import { sha256 } from './lib/crypto.mjs';
import { normalizeRelativePath } from './lib/paths.mjs';

export function detectOutputFormat(args) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;
    const lower = arg.toLowerCase();
    if (lower === '--json') return 'json';
    if (lower === '--sarif') return 'sarif';
    if (
      lower.startsWith('--output-format=') ||
      lower.startsWith('--format=') ||
      lower.startsWith('--out-format=')
    ) {
      const val = lower.split('=')[1];
      if (val === 'json') return 'json';
      if (val === 'sarif') return 'sarif';
    }
    if (
      lower === '--output-format' ||
      lower === '--format' ||
      lower === '--out-format' ||
      lower === '-f' ||
      lower === '-o'
    ) {
      const next = args[i + 1];
      if (next) {
        const nextLower = next.toLowerCase();
        if (nextLower === 'json') return 'json';
        if (nextLower === 'sarif') return 'sarif';
      }
    }
  }
  return 'text';
}

export function parseSemgrepJson(stdout) {
  try {
    const data = JSON.parse(stdout);
    return (data.results || []).map((r) => ({
      tool: 'semgrep',
      rule: r.check_id || '',
      message: r.extra?.message || '',
      file: r.path || '',
      line: r.start?.line || 0,
      column: r.start?.col || 0,
      severity: r.extra?.severity || 'warning',
    }));
  } catch {
    return [];
  }
}

export function parseGenericLines(stdout, stderr) {
  const text = [stdout, stderr]
    .filter((s) => typeof s === 'string' && s.trim().length > 0)
    .join('\n');
  const results = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // file:line:col: message
    const m1 = line.match(/^(.+?):(\d+):(\d+):\s*(.+)$/);
    if (m1) {
      results.push({
        tool: '',
        rule: '',
        message: m1[4],
        file: m1[1],
        line: parseInt(m1[2], 10),
        column: parseInt(m1[3], 10),
      });
      continue;
    }
    // file(line,col): message
    const m2 = line.match(/^(.+?)\((\d+),(\d+)\):\s*(.+)$/);
    if (m2) {
      results.push({
        tool: '',
        rule: '',
        message: m2[4],
        file: m2[1],
        line: parseInt(m2[2], 10),
        column: parseInt(m2[3], 10),
      });
      continue;
    }
    // file:line: message
    const m3 = line.match(/^(.+?):(\d+):\s*(.+)$/);
    if (m3) {
      results.push({
        tool: '',
        rule: '',
        message: m3[3],
        file: m3[1],
        line: parseInt(m3[2], 10),
        column: 0,
      });
    }
  }
  return results;
}

function normalizeMessage(message) {
  return (message || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

export function hashFinding(tool, finding) {
  const parts = [tool, finding.rule || '', normalizeMessage(finding.message)];
  if (finding.file) parts.push(finding.file);
  if (finding.line) parts.push(String(finding.line));
  return sha256(parts.join('\n')).slice(0, 16);
}

export function formatCompact(finding) {
  const base = finding.root ?? process.cwd();
  let relFile = finding.file
    ? normalizeRelativePath(path.relative(base, finding.file))
    : '';
  // Fallback to basename if file is outside the project root
  if (relFile.startsWith('..')) {
    relFile = path.basename(finding.file);
  }
  const loc = finding.line ? `:${finding.line}` : '';
  return `${finding.tool || 'tool'}: ${finding.rule || 'finding'} — ${relFile}${loc} — ${finding.message}`;
}
