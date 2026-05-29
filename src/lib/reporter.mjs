import path from 'node:path';

const PYTHON_RE = /^python(\d+(\.\d+)?)?$/;

const WRAPPERS = [
  {
    match(argv) {
      return argv[0] === 'uv' && argv[1] === 'run';
    },
    startIndex: 2,
    flagsWithValue: new Set([
      '--with',
      '--python',
      '--project',
      '--env-file',
      '--index-url',
      '--extra-index-url',
    ]),
  },
  {
    match(argv) {
      return argv[0] === 'npm' && argv[1] === 'exec';
    },
    startIndex: 2,
    flagsWithValue: new Set([
      '--package',
      '-c',
      '--call',
      '--workspace',
      '--workspaces',
    ]),
  },
  {
    match(argv) {
      return argv[0] === 'npx';
    },
    startIndex: 1,
    flagsWithValue: new Set([
      '--package',
      '-p',
      '--cache',
      '--userconfig',
      '--registry',
    ]),
  },
  {
    match(argv) {
      return argv[0] === 'pnpm' && argv[1] === 'dlx';
    },
    startIndex: 2,
    flagsWithValue: new Set(['--package', '--config']),
  },
  {
    match(argv) {
      return argv[0] === 'bunx';
    },
    startIndex: 1,
    flagsWithValue: new Set(['--bun', '--package']),
  },
  {
    match(argv) {
      return PYTHON_RE.test(argv[0]) || argv[0] === 'py';
    },
    custom(argv) {
      let i = 1;
      while (i < argv.length) {
        const token = argv[i];
        if (token === '-m') {
          return argv[i + 1] ?? argv[0];
        }
        if (!token.startsWith('-')) {
          return token;
        }
        i += 1;
      }
      return argv[0];
    },
  },
];

function extractWrappedCommand(basename, args) {
  const argv = [basename, ...(args ?? [])];
  const wrapper = WRAPPERS.find((w) => w.match(argv));

  if (!wrapper) {
    // Not a recognized wrapper — return the basename as-is
    return basename;
  }

  if (wrapper.custom) {
    return wrapper.custom(argv) ?? basename;
  }

  let i = wrapper.startIndex;

  while (i < argv.length) {
    const token = argv[i];

    // Explicit separator
    if (token === '--') {
      i += 1;
      break;
    }

    // First non-flag = real command
    if (!token.startsWith('-')) {
      break;
    }

    // --flag=value
    if (token.includes('=')) {
      i += 1;
      continue;
    }

    // Flags consuming next arg
    if (wrapper.flagsWithValue.has(token)) {
      i += 2;
      continue;
    }

    // Boolean flag
    i += 1;
  }

  return argv[i] ?? basename;
}

export function getBareCommand(cmd, args) {
  const basename = path.basename(cmd);
  if (!args || args.length === 0) return basename;
  return extractWrappedCommand(basename, args);
}

export function formatToolSuccess(toolName, bareName, relFile, action, output) {
  const line = `✅ ${toolName}: ${bareName} ${action} ${relFile}`;
  if (action === 'fixed' && output) {
    return `${line}\n${output}`;
  }
  return line;
}

export function formatToolFailure(toolName, bareName, result, output) {
  const suffix = result.killed ? ' (killed/timeout)' : '';
  const base = `⚠️ ${toolName}: ${bareName} failed with exit code ${result.code}${suffix}`;
  if (output) return `${base}:\n${output}`;
  return base;
}

export function formatNotFound(toolName, cmd) {
  return `⚠️ ${toolName}: command not found: ${cmd}`;
}

export function formatBatchSuccess(bareName, relFiles) {
  const count = relFiles.length;
  const namesStr = relFiles.join(', ');
  return `✅ ${bareName} succeeded (${count} file${count !== 1 ? 's' : ''}: ${namesStr})`;
}

export function formatRunOnceSuccess(bareName, relFiles) {
  const count = relFiles.length;
  const namesStr = relFiles.join(', ');
  return `✅ ${bareName} succeeded (triggered by ${count} file${count !== 1 ? 's' : ''}: ${namesStr})`;
}

export function formatBatchFailure(bareName, result, findingLines, output, toolName) {
  const suffix = result.killed ? ' (killed/timeout)' : '';
  const prefix = toolName ? `${toolName}: ${bareName}` : bareName;
  const base = `⚠️ ${prefix} failed with exit code ${result.code}${suffix}`;
  if (findingLines && findingLines.length > 0) {
    return `${base}:\n${findingLines.join('\n')}`;
  }
  if (output) return `${base}:\n${output}`;
  return base;
}

export function formatError(toolName, error) {
  return `⚠️ ${toolName}: ${error.message}`;
}

export function assembleSummary(header, warnings, lines, notes) {
  const parts = [];
  if (warnings.length > 0) {
    parts.push(warnings.map((w) => (w.startsWith('ℹ️') ? w : `⚠️ ${w}`)).join('\n'));
  }
  if (lines.length > 0) {
    parts.push(lines.join('\n'));
  }
  if (notes && notes.length > 0) {
    parts.push(notes.join('\n'));
  }
  if (parts.length === 0) return `${header}:`;
  return `${header}:\n${parts.join('\n\n')}`;
}
