import fs from 'node:fs/promises';
import path from 'node:path';

import ignore from 'ignore';

import { loadPoshifyConfig } from './config-loader.mjs';
import { isPathIncluded } from './lib/glob.mjs';
import { commandOutput, formatConfigHeader } from './lib/output.mjs';
import {
  findProjectRoot,
  normalizeRelativePath,
  resolveAtPath,
  resolveCommand,
} from './lib/paths.mjs';
import {
  assembleSummary,
  formatBatchFailure,
  formatBatchSuccess,
  formatError,
  formatNotFound,
  formatRunOnceSuccess,
  formatToolFailure,
  formatToolSuccess,
  getBareCommand,
} from './lib/reporter.mjs';
import { validateBatchCommand } from './lib/template.mjs';
import {
  detectOutputFormat,
  formatCompact,
  parseGenericLines,
  parseSemgrepJson,
} from './parser.mjs';
import { execute } from './runner.mjs';
import { askProjectConfigTrust } from './trust.mjs';

export const DEFAULT_MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024;

export function getEventPath(input) {
  if (!input || typeof input.path !== 'string') return undefined;
  return input.path.trim() ? input.path : undefined;
}

export function checkAborted(signal) {
  if (signal?.aborted) throw new Error('Aborted');
}

async function readFileContent(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}

async function loadGitignore(dir) {
  const sources = [];
  try {
    sources.push(await fs.readFile(path.join(dir, '.gitignore'), 'utf8'));
  } catch {
    /* no .gitignore */
  }
  try {
    sources.push(await fs.readFile(path.join(dir, '.ignore'), 'utf8'));
  } catch {
    /* no .ignore */
  }
  if (sources.length === 0) return null;
  return ignore().add(sources.join('\n'));
}

function isGitignored(absPath, ig, igRoot) {
  if (!ig || !igRoot) return false;
  const relPath = normalizeRelativePath(path.relative(igRoot, absPath));
  if (relPath.startsWith('..')) return false;
  return ig.ignores(relPath);
}

export async function matchTools(ctx, tools, file, ig, igRoot) {
  if (isGitignored(file, ig, igRoot)) return { matches: [], warnings: [] };

  const warnings = [];
  const matches = [];

  for (const tool of tools) {
    const root = await findProjectRoot(file, tool.anchors, ctx.cwd);
    if (!root) {
      const relToCwd = normalizeRelativePath(path.relative(ctx.cwd, file));
      if (isPathIncluded(relToCwd, tool.include, tool.exclude)) {
        warnings.push(
          `${tool.name}: anchors not found (${(tool.anchors ?? []).join(', ') || 'none'})`,
        );
      }
      continue;
    }

    const relFile = normalizeRelativePath(path.relative(root, file));
    if (relFile.startsWith('..') || path.isAbsolute(relFile)) continue;
    if (!isPathIncluded(relFile, tool.include, tool.exclude)) continue;

    matches.push({ tool, root, relFile });
  }

  return { matches, warnings };
}

export async function fileSizeAllowed(file, limit) {
  const stat = await fs.stat(file);
  return stat.size <= limit;
}

/**
 * Directory names that are always skipped during recursive walks,
 * even if not listed in .gitignore. These are non-source directories
 * that would never contain poshifiable files and are expensive to
 * traverse (node_modules alone can be tens of thousands of entries).
 *
 * Exposed so callers can inspect or extend the list if needed.
 */
export const WALK_SKIP_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv']);

export async function* walkFiles(startDir, ig, igRoot, maxDepth = 25) {
  if (maxDepth <= 0) return;
  let entries;
  try {
    entries = await fs.readdir(startDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (WALK_SKIP_DIRS.has(entry.name)) continue;
    const fullPath = path.join(startDir, entry.name);
    if (isGitignored(fullPath, ig, igRoot)) continue;
    if (entry.isDirectory()) {
      yield* walkFiles(fullPath, ig, igRoot, maxDepth - 1);
    } else if (entry.isFile()) {
      yield fullPath;
    }
  }
}

async function resolveFiles(input, cwd, ig, igRoot) {
  if (input.files) {
    return { files: [...input.files], errors: [], absolutePaths: [] };
  }

  if (input.path) {
    const absolutePath = resolveAtPath(input.path, cwd);
    let stats;
    try {
      stats = await fs.stat(absolutePath);
    } catch {
      return {
        files: [],
        errors: [`⚠️ Path not found: ${input.path}`],
        absolutePaths: [absolutePath],
      };
    }

    const files = [];
    if (stats.isDirectory()) {
      for await (const file of walkFiles(absolutePath, ig, igRoot)) {
        files.push(file);
      }
    } else {
      files.push(absolutePath);
    }
    return { files, errors: [], absolutePaths: [absolutePath] };
  }

  if (input.paths && input.paths.length > 0) {
    const files = [];
    const errors = [];
    const absolutePaths = [];
    for (const p of input.paths) {
      const absolutePath = resolveAtPath(p, cwd);
      absolutePaths.push(absolutePath);
      let stats;
      try {
        stats = await fs.stat(absolutePath);
      } catch {
        errors.push(`⚠️ Path not found: ${p}`);
        continue;
      }
      if (stats.isDirectory()) {
        for await (const file of walkFiles(absolutePath, ig, igRoot)) {
          files.push(file);
        }
      } else {
        files.push(absolutePath);
      }
    }
    return { files, errors, absolutePaths };
  }

  return { files: [], errors: [], absolutePaths: [] };
}

async function runToolCommand(ctx, match, file, workspace, commandObj) {
  const command = resolveCommand(`${match.tool.name} cmd`, commandObj, {
    workspace,
    root: match.root,
    file,
    name: match.tool.name,
  });

  // In per-file mode, {files} expands to the single file path.
  command.args = command.args.flatMap((arg) =>
    arg === '{files}' ? [command.placeholders.file] : [arg],
  );

  const before = await readFileContent(file);
  const result = await execute(command, ctx.signal);
  const bareName = getBareCommand(command.cmd, command.args);

  if (result.error === 'not_found') {
    return { line: formatNotFound(match.tool.name, command.cmd), diagnostics: false };
  }

  if (result.code === 0) {
    const after = await readFileContent(file);
    const modified = before !== after;
    return {
      line: formatToolSuccess(
        match.tool.name,
        bareName,
        command.placeholders.relFile,
        modified ? 'modified' : 'checked',
      ),
      diagnostics: false,
    };
  }

  const output = commandOutput(result);
  return {
    line: formatToolFailure(match.tool.name, bareName, result, output),
    diagnostics: true,
  };
}

async function runFixCommand(ctx, match, file, workspace, commandObj) {
  const command = resolveCommand(`${match.tool.name} fix`, commandObj, {
    workspace,
    root: match.root,
    file,
    name: match.tool.name,
  });

  // In per-file mode, {files} expands to the single file path.
  command.args = command.args.flatMap((arg) =>
    arg === '{files}' ? [command.placeholders.file] : [arg],
  );

  const result = await execute(command, ctx.signal);
  const bareName = getBareCommand(command.cmd, command.args);

  if (result.error === 'not_found') {
    return { line: formatNotFound(match.tool.name, command.cmd), diagnostics: false };
  }

  if (result.code === 0) {
    const output = commandOutput(result);
    return {
      line: formatToolSuccess(
        match.tool.name,
        bareName,
        command.placeholders.relFile,
        'fixed',
        output,
      ),
      diagnostics: false,
    };
  }

  const output = commandOutput(result);
  return {
    line: formatToolFailure(match.tool.name, bareName, result, output),
    diagnostics: true,
  };
}

async function collectMatches(ctx, files, loadedItems, section, ig, igRoot) {
  const warnings = [];
  const skippedLines = [];
  const matches = [];

  for (const file of files) {
    checkAborted(ctx.signal);
    const { matches: fileMatches, warnings: matchWarnings } = await matchTools(
      ctx,
      loadedItems,
      file,
      ig,
      igRoot,
    );
    warnings.push(...matchWarnings);

    for (const match of fileMatches) {
      const sectionTools = match.tool[section];
      if (!sectionTools || sectionTools.length === 0) continue;

      const maxFileSizeBytes =
        match.tool.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
      let allowed;
      try {
        allowed = await fileSizeAllowed(file, maxFileSizeBytes);
      } catch {
        allowed = false;
      }
      if (!allowed) {
        skippedLines.push(
          `⚠️ ${match.tool.name}: skipped ${match.relFile}; file exceeds maxFileSizeBytes (${maxFileSizeBytes})`,
        );
        continue;
      }

      for (let i = 0; i < sectionTools.length; i += 1) {
        matches.push({ file, match, commandObj: sectionTools[i], toolIndex: i });
      }
    }
  }

  return { matches, warnings, skippedLines };
}

async function runSectionBatched(
  ctx,
  files,
  loadedItems,
  workspace,
  section,
  ig,
  igRoot,
) {
  const lines = [];
  const findings = [];
  const runOnceGroups = new Map();
  const batchGroups = new Map();

  const { matches, warnings, skippedLines } = await collectMatches(
    ctx,
    files,
    loadedItems,
    section,
    ig,
    igRoot,
  );
  lines.push(...skippedLines);

  for (const { file, match, commandObj, toolIndex } of matches) {
    const resolved = resolveCommand(
      `${match.tool.name} ${section}-${toolIndex}`,
      commandObj,
      {
        workspace,
        root: match.root,
        file,
        name: match.tool.name,
      },
    );

    const hasFiles = resolved.args.some((arg) => arg === '{files}');
    if (!hasFiles) {
      // Dedup key: JSON.stringify preserves key insertion order for
      // objects built from parsed config, so identical configs match.
      const onceKey = JSON.stringify({
        cmd: resolved.cmd,
        args: resolved.args,
        cwd: resolved.cwd,
        env: resolved.env,
      });

      if (!runOnceGroups.has(onceKey)) {
        runOnceGroups.set(onceKey, {
          command: resolved,
          files: [],
          toolName: match.tool.name,
        });
      }
      runOnceGroups.get(onceKey).files.push(file);
      continue;
    }

    const error = validateBatchCommand(commandObj);
    if (error) {
      lines.push(`⚠️ ${match.tool.name}: ${error}`);
      continue;
    }

    // Dedup key: JSON.stringify preserves key insertion order for
    // objects built from parsed config, so identical configs match.
    const batchKey = JSON.stringify({
      cmd: resolved.cmd,
      args: resolved.args,
      cwd: resolved.cwd,
      env: resolved.env,
    });

    if (!batchGroups.has(batchKey)) {
      batchGroups.set(batchKey, {
        command: resolved,
        files: [],
        toolName: match.tool.name,
      });
    }
    batchGroups.get(batchKey).files.push(file);
  }

  const BATCH_SIZE = 100;

  for (const { command, files: onceFiles, toolName } of runOnceGroups.values()) {
    for (let i = 0; i < onceFiles.length; i += BATCH_SIZE) {
      const chunk = onceFiles.slice(i, i + BATCH_SIZE);
      if (chunk.length === 0) continue;
      checkAborted(ctx.signal);

      const result = await execute(command, ctx.signal);
      const bareName = getBareCommand(command.cmd, command.args);

      if (result.error === 'not_found') {
        lines.push(formatNotFound(toolName, command.cmd));
        continue;
      }

      if (result.code === 0) {
        const relFiles = chunk.map((f) =>
          normalizeRelativePath(path.relative(command.placeholders.root, f)),
        );
        lines.push(formatRunOnceSuccess(bareName, relFiles));
      } else {
        const format = detectOutputFormat(command.args);
        let toolFindings;
        if (format === 'json') {
          toolFindings = parseSemgrepJson(result.stdout);
        } else {
          toolFindings = parseGenericLines(result.stdout, result.stderr);
        }
        for (const f of toolFindings) {
          f.tool = bareName;
          f.root = command.placeholders.root;
          findings.push(f);
        }
        const output = commandOutput(result);
        const findingLines =
          toolFindings.length > 0 ? toolFindings.map(formatCompact) : undefined;
        lines.push(formatBatchFailure(bareName, result, findingLines, output));
      }
    }
  }

  for (const { command, files: batchFiles, toolName } of batchGroups.values()) {
    for (let i = 0; i < batchFiles.length; i += BATCH_SIZE) {
      const chunk = batchFiles.slice(i, i + BATCH_SIZE);
      if (chunk.length === 0) continue;
      checkAborted(ctx.signal);

      const batchedCommand = {
        ...command,
        args: command.args.flatMap((arg) => (arg === '{files}' ? chunk : [arg])),
      };

      const result = await execute(batchedCommand, ctx.signal);
      const bareName = getBareCommand(command.cmd, command.args);

      if (result.error === 'not_found') {
        lines.push(formatNotFound(toolName ?? bareName, batchedCommand.cmd));
        continue;
      }

      if (result.code === 0) {
        const relFiles = chunk.map((f) =>
          normalizeRelativePath(path.relative(command.placeholders.root, f)),
        );
        lines.push(formatBatchSuccess(bareName, relFiles));
      } else {
        const format = detectOutputFormat(command.args);
        let toolFindings;
        if (format === 'json') {
          toolFindings = parseSemgrepJson(result.stdout);
        } else {
          toolFindings = parseGenericLines(result.stdout, result.stderr);
        }
        for (const f of toolFindings) {
          f.tool = bareName;
          f.root = command.placeholders.root;
          findings.push(f);
        }
        const output = commandOutput(result);
        const findingLines =
          toolFindings.length > 0 ? toolFindings.map(formatCompact) : undefined;
        lines.push(formatBatchFailure(bareName, result, findingLines, output));
      }
    }
  }

  return { lines, findings, warnings };
}

async function runPerFileSection(
  ctx,
  files,
  loadedItems,
  workspace,
  section,
  ig,
  igRoot,
) {
  const lines = [];

  const { matches, warnings, skippedLines } = await collectMatches(
    ctx,
    files,
    loadedItems,
    section,
    ig,
    igRoot,
  );
  lines.push(...skippedLines);

  for (const { file, match, commandObj } of matches) {
    try {
      if (section === 'fix-tools') {
        const result = await runFixCommand(ctx, match, file, workspace, commandObj);
        lines.push(result.line);
      } else {
        const result = await runToolCommand(ctx, match, file, workspace, commandObj);
        lines.push(result.line);
      }
    } catch (error) {
      lines.push(formatError(match.tool.name, error));
    }
  }

  return { lines, warnings };
}

function buildConfigDeps(ctx) {
  return {
    validateBatchCommand,
    askTrust: (opts) => askProjectConfigTrust({ ...opts, ctx }),
  };
}

/**
 * Run poshify tools for a set of files or a path.
 * @param {any} ctx
 * @param {{ input: { files?: Set<string>, path?: string, paths?: string[] }, sections?: string[], label?: string, cache?: object }} options
 * @returns {Promise<{summary: string, findings: any[], warnings: string[]}>}
 */
export async function runPoshify(ctx, options) {
  const sections = options.sections ?? ['tools'];
  const label = options.label;

  if (options.input?.files && options.input.files.size === 0) {
    return { summary: '', findings: [], warnings: [] };
  }

  const loaded = await loadPoshifyConfig(ctx, options.cache, buildConfigDeps(ctx));

  const warnings = [...loaded.warnings];
  const projectLayer = loaded.layers.find((layer) => layer.scope === 'project');
  const workspace = projectLayer ? path.dirname(projectLayer.dir) : ctx.cwd;

  const ig = await loadGitignore(ctx.cwd);
  const igRoot = ctx.cwd;

  let files;
  let pathErrors = [];
  if (options.input?.files) {
    const { files: resolvedFiles } = await resolveFiles(
      options.input,
      ctx.cwd,
      ig,
      igRoot,
    );
    files = resolvedFiles;
  } else if (options.input?.paths) {
    const { errors, files: resolvedFiles } = await resolveFiles(
      options.input,
      ctx.cwd,
      ig,
      igRoot,
    );
    files = resolvedFiles;
    pathErrors = errors;
    if (files.length === 0 && errors.length > 0) {
      const header = label ? `${formatConfigHeader(loaded)} ${label}` : undefined;
      const summary = header ? `${header}:\n${errors.join('\n')}` : errors.join('\n');
      return { summary, findings: [], warnings };
    }
  } else if (options.input?.path) {
    const {
      errors,
      files: resolvedFiles,
      absolutePaths,
    } = await resolveFiles(options.input, ctx.cwd, ig, igRoot);
    if (errors.length > 0) {
      const header = label ? `${formatConfigHeader(loaded)} ${label}` : undefined;
      const summary = header ? `${header}:\n${errors[0]}` : errors[0];
      return { summary, findings: [], warnings };
    }
    files = resolvedFiles;
    if (files.length === 0) {
      const relPath = normalizeRelativePath(path.relative(ctx.cwd, absolutePaths[0]));
      return { summary: `No files found in ${relPath}`, findings: [], warnings };
    }
  } else {
    return { summary: '', findings: [], warnings };
  }

  if (loaded.items.length === 0) {
    const header = label
      ? `${formatConfigHeader(loaded)} ${label}`
      : formatConfigHeader(loaded);
    const summary = assembleSummary(header, warnings, []);
    return { summary, findings: [], warnings };
  }

  const sectionLines = new Map();
  const allFindings = [];

  for (const section of sections) {
    checkAborted(ctx.signal);
    const isAgentOps = !!options.input?.files;
    const shouldBatch = section === 'audit-tools' || !isAgentOps;
    if (shouldBatch) {
      const {
        lines,
        findings,
        warnings: w,
      } = await runSectionBatched(
        ctx,
        files,
        loaded.items,
        workspace,
        section,
        ig,
        igRoot,
      );
      sectionLines.set(section, lines);
      allFindings.push(...findings);
      warnings.push(...w);
    } else {
      const { lines, warnings: w } = await runPerFileSection(
        ctx,
        files,
        loaded.items,
        workspace,
        section,
        ig,
        igRoot,
      );
      sectionLines.set(section, lines);
      warnings.push(...w);
    }
  }

  const header = label
    ? `${formatConfigHeader(loaded)} ${label}`
    : formatConfigHeader(loaded);

  const lines = [];
  const multiSection = sections.length > 1;
  const SECTION_LABELS = {
    tools: 'Tools',
    'fix-tools': 'Fix',
    'audit-tools': 'Audit',
  };

  for (const section of sections) {
    const sectionResult = sectionLines.get(section) || [];
    if (sectionResult.length === 0) continue;
    if (multiSection) {
      lines.push(`${SECTION_LABELS[section] ?? section}:\n${sectionResult.join('\n')}`);
    } else {
      lines.push(...sectionResult);
    }
  }

  const uniqueWarnings = [...new Set([...pathErrors, ...warnings])];
  const summary = assembleSummary(header, uniqueWarnings, lines);
  return { summary, findings: allFindings, warnings: uniqueWarnings };
}
