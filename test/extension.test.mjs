/**
 * NOTE: @earendil-works/pi-coding-agent and @earendil-works/pi-tui are
 * peerDependencies. If they are not present in node_modules, link them
 * from the global npm installation:
 *
 *   ln -s $PI_CODING_AGENT_DIR/npm/lib/node_modules/@earendil-works/pi-coding-agent \
 *         node_modules/@earendil-works/pi-coding-agent
 *   ln -s $PI_CODING_AGENT_DIR/npm/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-tui \
 *         node_modules/@earendil-works/pi-tui
 */
import assert from 'node:assert';
import { describe, it } from 'node:test';

import piPosherExtension from '../src/pi-posher.mjs';

function createMockPi() {
  const handlers = {};
  const commands = {};
  const tools = {};
  const messages = [];

  const pi = {
    on(event, handler) {
      handlers[event] = handlers[event] || [];
      handlers[event].push(handler);
    },
    registerCommand(name, opts) {
      commands[name] = opts;
    },
    registerTool(def) {
      tools[def.name] = def;
    },
    registerMessageRenderer(_type, _renderer) {
      // no-op
    },
    sendMessage(msg, opts) {
      messages.push({ msg, opts });
    },
    getHandlers() {
      return handlers;
    },
    getCommands() {
      return commands;
    },
    getTools() {
      return tools;
    },
    getMessages() {
      return messages;
    },
    clearMessages() {
      messages.length = 0;
    },
  };

  return pi;
}

function createMockCtx(options = {}) {
  const notifications = [];
  const statuses = [];
  const widgets = [];

  return {
    cwd: options.cwd ?? '/tmp',
    hasUI: options.hasUI ?? false,
    signal: options.signal,
    hasPendingMessages: options.hasPendingMessages,
    isIdle: options.isIdle,
    ui: {
      notify(text, level) {
        notifications.push({ text, level });
      },
      setStatus(id, text) {
        statuses.push({ id, text });
      },
      setWidget(id, content) {
        widgets.push({ id, content });
      },
      theme: {
        fg(_key, text) {
          return text;
        },
      },
    },
    getNotifications() {
      return notifications;
    },
    getStatuses() {
      return statuses;
    },
    getWidgets() {
      return widgets;
    },
  };
}

describe('extension streaming-aware behavior', () => {
  it('defers turn_end audit-tools when user has pending messages', async () => {
    const pi = createMockPi();
    await piPosherExtension(pi);

    const handlers = pi.getHandlers();
    const toolResultHandler = handlers.tool_result?.[0];
    const turnEndHandler = handlers.turn_end?.[0];
    assert.ok(toolResultHandler, 'tool_result handler should exist');
    assert.ok(turnEndHandler, 'turn_end handler should exist');

    // Seed turnEndAuditFiles via tool_result (no pending messages yet)
    const seedCtx = createMockCtx({
      cwd: '/tmp/test-defer',
      hasPendingMessages: () => false,
    });
    await toolResultHandler(
      {
        toolName: 'write',
        isError: false,
        input: { path: '/tmp/test-defer/src/main.js' },
        content: [],
      },
      seedCtx,
    );

    // turn_end with pending messages should defer and send nothing
    pi.clearMessages();
    const deferCtx = createMockCtx({
      cwd: '/tmp/test-defer',
      hasPendingMessages: () => true,
    });
    const deferResult = await turnEndHandler({}, deferCtx);
    assert.strictEqual(deferResult, undefined);
    assert.strictEqual(pi.getMessages().length, 0);

    // turn_end without pending messages should run audit and send a message
    const runCtx = createMockCtx({
      cwd: '/tmp/test-defer',
      hasPendingMessages: () => false,
    });
    const runResult = await turnEndHandler({}, runCtx);
    assert.strictEqual(runResult, undefined);
    assert.strictEqual(pi.getMessages().length, 1);
    assert.strictEqual(pi.getMessages()[0].opts.deliverAs, 'steer');
  });

  it('skips tool_result formatting when user has pending messages', async () => {
    const pi = createMockPi();
    await piPosherExtension(pi);

    const handlers = pi.getHandlers();
    const toolResultHandler = handlers.tool_result?.[0];
    assert.ok(toolResultHandler, 'tool_result handler should exist');

    const ctx = createMockCtx({
      cwd: '/tmp/test-skip',
      hasPendingMessages: () => true,
    });

    const result = await toolResultHandler(
      {
        toolName: 'write',
        isError: false,
        input: { path: '/tmp/test-skip/src/main.js' },
        content: [],
      },
      ctx,
    );

    assert.strictEqual(result, undefined);
    assert.strictEqual(pi.getMessages().length, 0);
    assert.strictEqual(ctx.getStatuses().length, 0);
  });

  it('/poshify --audit notifies when agent is busy', async () => {
    const pi = createMockPi();
    await piPosherExtension(pi);

    const command = pi.getCommands().poshify;
    assert.ok(command, 'poshify command should exist');

    const ctx = createMockCtx({
      cwd: '/tmp/test-busy',
      hasUI: true,
      isIdle: () => false,
    });

    // We do not await the full handler because it would call runPoshify;
    // instead we fire it and check the notification, then let it finish.
    const handlerPromise = command.handler('--audit .', ctx);

    // Poll deterministically for the async notification instead of a fixed sleep.
    let notify;
    for (let i = 0; i < 20; i += 1) {
      notify = ctx.getNotifications().find((n) => n.text.includes('Agent is busy'));
      if (notify) break;
      await new Promise((res) => setTimeout(res, 10));
    }

    assert.ok(notify, 'should notify that agent is busy');
    assert.strictEqual(notify.level, 'info');

    // Allow handler to complete so the test runner is not left with a dangling promise
    await handlerPromise;
  });
});
