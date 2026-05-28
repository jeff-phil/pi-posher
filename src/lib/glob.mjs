export function normalizePathForGlob(input) {
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
  // nosemgrep
  return new RegExp(source);
}

export function matchesGlob(pattern, relativePath) {
  const normalizedPath = normalizePathForGlob(relativePath);
  for (const expanded of expandBraces(pattern)) {
    if (globToRegExp(expanded).test(normalizedPath)) return true;
  }
  return false;
}

/**
 * Expand brace expressions like `{a,b,c}` into separate patterns.
 *
 * Unmatched opening braces (no closing `}`) are treated as literal
 * characters — the pattern is returned as-is, which matches typical
 * glob semantics (bash, minimatch, etc.).
 *
 * @param {string} pattern
 * @returns {string[]}
 */
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
        // Empty brace group (e.g. `{}`) is not a valid expansion —
        // treat the whole thing as a literal.
        if (inner.length === 0) break;
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
  // No matching closing `}` found — treat the opening `{` as literal.
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

export function matchesAnyGlob(patterns, relativePath) {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((pattern) => matchesGlob(pattern, relativePath));
}

export function isPathIncluded(relativePath, include, exclude) {
  const normalizedPath = normalizePathForGlob(relativePath);
  const included =
    !include || include.length === 0 || matchesAnyGlob(include, normalizedPath);
  if (!included) return false;
  return !matchesAnyGlob(exclude, normalizedPath);
}

export function hasGlobMeta(pattern) {
  return pattern.includes('*') || pattern.includes('?') || pattern.includes('{');
}
