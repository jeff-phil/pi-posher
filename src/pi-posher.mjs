import path from 'node:path';

import { keyHint } from '@earendil-works/pi-coding-agent';
import { Box, Spacer, Text } from '@earendil-works/pi-tui';

import { loadPoshifyConfig, readBundledDefaultsLayer } from './config-loader.mjs';
import {
  runInitByName,
  seedAllInitConfigs,
  seedPoshifyDefaults,
} from './init-seeder.mjs';
import { formatConfigHeader, hasIssueOutput } from './lib/output.mjs';
import { normalizeUnicodeSpaces, resolveAtPath, toAbsolutePath } from './lib/paths.mjs';
import { validateBatchCommand } from './lib/template.mjs';
import { formatCompact, hashFinding } from './parser.mjs';
import { getEventPath, runPoshify } from './poshify.mjs';
import { execute } from './runner.mjs';
import { askProjectConfigTrust, getExtensionDataDir } from './trust.mjs';

const COLLAPSED_LINE_LIMIT = 20;

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
  pi.registerMessageRenderer('pi-posher', (message, options, theme) => {
    const text = customMessageText(message.content, message.details);
    const { expanded } = options;
    let displayText = text;

    const hasIssues = hasIssueOutput(text);
    if (!expanded && typeof text === 'string') {
      const lines = text.split('\n');
      if (lines.length > COLLAPSED_LINE_LIMIT) {
        const shown = lines.slice(0, COLLAPSED_LINE_LIMIT);
        const hidden = lines.length - COLLAPSED_LINE_LIMIT;
        displayText =
          `${shown.join('\n')}\n` +
          `${theme.fg('muted', `... (${hidden} more lines,`)} ${keyHint('app.tools.expand', 'to expand')})`;
      }
    }

    const bgKey = hasIssues ? 'toolErrorBg' : 'toolSuccessBg';
    const box = new Box(1, 1, (value) => theme.bg(bgKey, value));
    box.addChild(new Text(theme.fg('toolTitle', theme.bold('poshify')), 0, 0));
    if (displayText.trim()) {
      box.addChild(new Spacer(1));
      box.addChild(new Text(theme.fg('toolOutput', displayText), 0, 0));
    }
    return box;
  });
}

function startPoshifySpinner(ctx, label, target) {
  if (!ctx.hasUI) return undefined;
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIndex = 0;
  const animationId = setInterval(() => {
    const frame = frames[frameIndex];
    ctx.ui.setWidget('poshify-loader', [
      ctx.ui.theme.fg('accent', '┏━━ Pi Poshify Tool ━━━━━━━━━━━━━━━━━━━━━'),
      `${ctx.ui.theme.fg('muted', '┃')} ${label}`,
      `${ctx.ui.theme.fg('muted', '┃')} Target: ${ctx.ui.theme.fg('dim', target === '.' ? '{current dir}' : target)}`,
      ctx.ui.theme.fg('accent', `┗━━ ${frame} Working...`),
    ]);
    frameIndex = (frameIndex + 1) % frames.length;
  }, 80);
  return animationId;
}

function stopPoshifySpinner(ctx, animationId) {
  if (animationId === undefined) return;
  clearInterval(animationId);
  if (ctx.hasUI) {
    ctx.ui.setWidget('poshify-loader', undefined);
  }
}

export default async function piPosherExtension(pi) {
  /** @type {{ ready: boolean, value: { items: any[], layers: any[], warnings: string[] } | undefined, cwd: string | undefined }} */
  const configCache = { ready: false, value: undefined, cwd: undefined };

  // Collect files edited during a turn so turn_end can batch-run audit-tools.
  const turnEndAuditFiles = new Set();
  const seenAuditHashes = new Map(); // hash -> true, used as an ordered set for LRU eviction

  registerDiagnosticsRenderer(pi);

  // Eagerly seed global config on load (mid-session installs need this)
  await seedPoshifyDefaults();
  await seedAllInitConfigs(await readBundledDefaultsLayer());

  pi.on('session_start', async (_event, ctx) => {
    turnEndAuditFiles.clear();
    seenAuditHashes.clear();
    const configSeeded = await seedPoshifyDefaults();
    const initSeeded = await seedAllInitConfigs(await readBundledDefaultsLayer());
    if ((configSeeded || initSeeded) && ctx?.hasUI) {
      ctx.ui.notify(`Poshify defaults installed to ${getExtensionDataDir()}`, 'info');
    }

    try {
      await loadPoshifyConfig(ctx, configCache, {
        validateBatchCommand,
        askTrust: (opts) => askProjectConfigTrust({ ...opts, ctx }),
      });
    } catch (err) {
      // Trust prompt itself may throw "Cancelled" if the user hits Escape
      // during session_start. Gracefully ignore; cache stays un-ready
      // and a later load (e.g. explicit /poshify) will retry.
      if (err?.message === 'Cancelled') return;
      throw err;
    }
  });

  pi.registerCommand('poshify', {
    description:
      'Run configured tools on a file or directory (/poshify --help for more)',
    handler: async (args, ctx) => {
      const trimmed = normalizeUnicodeSpaces(args?.trim() || '');

      let config;
      try {
        config = await loadPoshifyConfig(ctx, configCache, {
          validateBatchCommand,
          askTrust: (opts) => askProjectConfigTrust({ ...opts, ctx }),
        });
      } catch (error) {
        if (error?.message === 'Cancelled') {
          const trustConfigPath = resolveAtPath(
            path.join('.pi', 'poshifiers.json'),
            ctx.cwd,
          );
          const displayPath = trustConfigPath
            ? path.basename(path.dirname(trustConfigPath)) + '/.pi/poshifiers.json'
            : 'project-local .pi/poshifiers.json';
          const trustSummary = `⚠️ User cancelled request to accept or reject \`${displayPath}\` file as trusted.`;
          pi.sendMessage(
            {
              customType: 'pi-posher',
              content: trustSummary,
              display: true,
              details: {
                path: ctx.cwd,
                summary: trustSummary,
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
        ` /poshify (file|dir)...       # Run configured tools for file(s) or directory(ies)`,
        ` /poshify --init <name>       # Install init configs for a poshifier type`,
        ` /poshify --fix [file|dir]... # Run configured fix-tools`,
        ` /poshify --audit [file|dir]... # Run tools & audit-tools for file(s) or directory(ies)`,
        ` /poshify --help              # Show this usage`,
        ...(availableInits.length > 0
          ? ['', 'Available --init names: ' + availableInits.join(', ')]
          : []),
      ].join('\n');

      if (trimmed === '' || trimmed === '--help') {
        const helpSummary = `${formatConfigHeader(config)}\n\n${usage}`;
        pi.sendMessage(
          {
            customType: 'pi-posher',
            content: helpSummary,
            display: true,
            details: {
              path: ctx.cwd,
              summary: helpSummary,
            },
          },
          { deliverAs: 'steer' },
        );
        return;
      }

      const tokens = trimmed.split(/\s+/).filter(Boolean);
      const hasInitFlag = tokens.some((t) => t === '--init' || t === '-init');
      const hasFixFlag = tokens.some((t) => t === '--fix' || t === '-fix');
      const hasAuditFlag = tokens.some((t) => t === '--audit' || t === '-audit');

      if (hasInitFlag) {
        const initIdx = tokens.findIndex((t) => t === '--init' || t === '-init');
        const initName = tokens.slice(initIdx + 1).find((t) => !t.startsWith('-'));
        if (!initName) {
          const initHelpSummary = `Usage: /poshify --init <name>\n\n${availableInits.length > 0 ? 'Available: ' + availableInits.join(', ') : 'No init setups configured.'}`;
          pi.sendMessage(
            {
              customType: 'pi-posher',
              content: initHelpSummary,
              display: true,
              details: {
                path: ctx.cwd,
                summary: initHelpSummary,
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
            const result = await runInitByName(ctx, poshifier, initName, execute);
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
          if (error?.message === 'Aborted' || error?.message === 'Cancelled') {
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
            content: summary,
            display: true,
            details: { path: ctx.cwd, summary },
          },
          { deliverAs: 'steer' },
        );
        return;
      }

      function targetsAfter(flagIdx) {
        const t = flagIdx >= 0 ? tokens.slice(flagIdx + 1) : tokens;
        return t.filter((tok) => !tok.startsWith('-'));
      }

      function formatSpinnerTargets(targets) {
        if (targets.length <= 2) return targets.join(', ');
        return `${targets.slice(0, 2).join(', ')} +${targets.length - 2} more`;
      }

      if (hasFixFlag) {
        const fixIdx = tokens.findIndex((t) => t === '--fix' || t === '-fix');
        const fixTargets = targetsAfter(fixIdx);
        if (fixTargets.length === 0) fixTargets.push('.');
        const fixSpinner = startPoshifySpinner(
          ctx,
          'Running fix...',
          formatSpinnerTargets(fixTargets),
        );
        let summary;
        try {
          const result = await runPoshify(ctx, {
            input: { paths: fixTargets },
            sections: ['fix-tools'],
            label: '--fix',
            cache: configCache,
          });
          summary = result.summary;
        } catch (error) {
          if (error?.message === 'Aborted' || error?.message === 'Cancelled') {
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
            content: summary,
            display: true,
            details: { path: fixTargets.join(', '), summary },
          },
          { deliverAs: 'steer' },
        );
        return;
      }

      if (hasAuditFlag) {
        const auditIdx = tokens.findIndex((t) => t === '--audit' || t === '-audit');
        const auditTargets = targetsAfter(auditIdx);
        if (auditTargets.length === 0) auditTargets.push('.');
        const auditSpinner = startPoshifySpinner(
          ctx,
          'Running tools + audit...',
          formatSpinnerTargets(auditTargets),
        );
        let summary;
        try {
          const result = await runPoshify(ctx, {
            input: { paths: auditTargets },
            sections: ['tools', 'audit-tools'],
            label: '--audit',
            cache: configCache,
          });
          summary = result.summary;
        } catch (error) {
          if (error?.message === 'Aborted' || error?.message === 'Cancelled') {
            summary = '  Audit cancelled';
          } else {
            summary = `  Audit error: ${error.message}`;
          }
        } finally {
          stopPoshifySpinner(ctx, auditSpinner);
        }
        const hasIssues = summary.includes('⚠️');
        const steerContent = hasIssues
          ? `Poshify audit found issues. Some may be auto-fixable with \`/poshify --fix\`, while others (audit findings) may require manual code changes.\n\n${summary}\n\nWhat would you like to do?`
          : '';
        const commandText = `/poshify --audit ${auditTargets.join(' ')}`;
        const displaySummary = hasIssues
          ? `💡 Issues found running: "${commandText}"  Let me know if you want me to fix them.\n\n${summary}`
          : summary;
        pi.sendMessage(
          {
            customType: 'pi-posher',
            content: steerContent,
            display: true,
            details: { path: auditTargets.join(', '), summary: displaySummary },
          },
          { deliverAs: 'steer' },
        );
        return;
      }

      const plainTargets = targetsAfter(-1);
      if (plainTargets.length === 0) {
        const helpSummary = `${formatConfigHeader(config)}\n\n${usage}`;
        pi.sendMessage(
          {
            customType: 'pi-posher',
            content: helpSummary,
            display: true,
            details: {
              path: ctx.cwd,
              summary: helpSummary,
            },
          },
          { deliverAs: 'steer' },
        );
        return;
      }

      const animationId = startPoshifySpinner(
        ctx,
        'Running tools...',
        formatSpinnerTargets(plainTargets),
      );

      let summary;
      try {
        const result = await runPoshify(ctx, {
          input: { paths: plainTargets },
          cache: configCache,
        });
        summary = result.summary;
      } catch (error) {
        if (error?.message === 'Aborted' || error?.message === 'Cancelled') {
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
            content: summary,
            display: true,
            details: { path: plainTargets.join(', '), summary },
          },
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
        'Run poshify (run configured tools, code quality, linters, formatters) on a specified file or directory',
      parameters: Type.Object({
        path: Type.String({
          description: 'File or directory path to run poshify on',
        }),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const { summary } = await runPoshify(ctx, {
          input: { path: resolveAtPath(params.path, ctx.cwd) },
          cache: configCache,
        });
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
    turnEndAuditFiles.add(absoluteFile);

    if (ctx.hasUI) {
      ctx.ui.setStatus('posher', `poshify: running ${path.basename(absoluteFile)}...`);
    }

    let summary;
    try {
      const result = await runPoshify(ctx, {
        input: { files: new Set([absoluteFile]) },
        cache: configCache,
      });
      summary = result.summary;
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
          content: summary,
          display: true,
          details: { path: ctx.cwd, summary },
        },
        { deliverAs: 'steer' },
      );
    }

    return undefined;
  });

  pi.on('turn_end', async (_event, ctx) => {
    if (turnEndAuditFiles.size === 0) return undefined;

    const files = new Set(turnEndAuditFiles);
    turnEndAuditFiles.clear();

    let auditResult;
    try {
      auditResult = await runPoshify(ctx, {
        input: { files },
        sections: ['audit-tools'],
        cache: configCache,
      });
    } catch (error) {
      auditResult = {
        summary: `  Poshify Audit error: ${error.message}`,
        findings: [],
      };
    }

    const { summary, findings } = auditResult;

    const newFindings = [];
    for (const f of findings) {
      const h = hashFinding(f.tool, f);
      if (!seenAuditHashes.has(h)) {
        newFindings.push(f);
      }
      // Re-insert to refresh insertion order (LRU)
      seenAuditHashes.delete(h);
      seenAuditHashes.set(h, true);
    }
    // Cap at 1000 entries (LRU eviction)
    while (seenAuditHashes.size > 1000) {
      const firstKey = seenAuditHashes.keys().next().value;
      seenAuditHashes.delete(firstKey);
    }

    const steerContent =
      newFindings.length > 0
        ? `⚠️ Audit: ${newFindings[0]?.tool || 'audit'} found ${newFindings.length} new finding${newFindings.length !== 1 ? 's' : ''}:\n${newFindings.map(formatCompact).join('\n')}`
        : findings.length > 0
          ? `⚠️ Audit: ${findings[0]?.tool || 'audit'} failed — all findings previously reported.\n\n${summary}`
          : summary
            ? `Audit results for files edited this turn:\n${summary}`
            : 'No audit output for files edited this turn.';

    pi.sendMessage(
      {
        customType: 'pi-posher',
        content: steerContent,
        display: true,
        details: { path: ctx.cwd, summary },
      },
      { deliverAs: 'steer' },
    );

    return undefined;
  });

  pi.on('context', async (event) => {
    return {
      messages: event.messages.filter((msg) => {
        if (msg.role !== 'custom' || msg.customType !== 'pi-posher') {
          return true;
        }
        const text =
          typeof msg.content === 'string'
            ? msg.content
            : (msg.content?.map((c) => c.text).join('') ?? '');
        return hasIssueOutput(text);
      }),
    };
  });
}
