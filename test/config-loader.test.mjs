import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  cleanPoshifier,
  commandsForPoshify,
  loadPoshifyConfig,
  mergeLayers,
  parsePoshifyItems,
} from '../src/config-loader.mjs';
import { _setAgentDir } from '../src/trust.mjs';

describe('config-loader', () => {
  it('cleanPoshifier requires a non-empty name', () => {
    assert.strictEqual(cleanPoshifier({}), undefined);
    assert.strictEqual(cleanPoshifier({ name: '' }), undefined);
    assert.strictEqual(cleanPoshifier({ name: '  ' }), undefined);
    assert.ok(cleanPoshifier({ name: 'go' }));
  });

  it('cleanPoshifier defaults anchors to .project', () => {
    const c = cleanPoshifier({ name: 'test' });
    assert.deepStrictEqual(c.anchors, ['.project']);
  });

  it('cleanPoshifier preserves explicit anchors', () => {
    const c = cleanPoshifier({ name: 'test', anchors: ['go.mod'] });
    assert.deepStrictEqual(c.anchors, ['go.mod']);
  });

  it('cleanPoshifier cleans empty anchors to .project', () => {
    const c = cleanPoshifier({ name: 'test', anchors: [] });
    assert.deepStrictEqual(c.anchors, ['.project']);
  });

  it('cleanPoshifier filters invalid commands', () => {
    const c = cleanPoshifier({
      name: 'test',
      tools: [{ cmd: 'valid' }, { cmd: '' }, { notCmd: 'x' }, null],
    });
    assert.strictEqual(c.tools.length, 1);
    assert.strictEqual(c.tools[0].cmd, 'valid');
  });

  it('cleanPoshifier sets default timeoutMs', () => {
    const c = cleanPoshifier({
      name: 'test',
      tools: [{ cmd: 'x' }],
    });
    assert.strictEqual(c.tools[0].timeoutMs, 15000);
  });

  it('cleanPoshifier respects explicit timeoutMs', () => {
    const c = cleanPoshifier({
      name: 'test',
      tools: [{ cmd: 'x', timeoutMs: 5000 }],
    });
    assert.strictEqual(c.tools[0].timeoutMs, 5000);
  });

  it('parsePoshifyItems reads poshifiers array', () => {
    const items = parsePoshifyItems({
      poshifiers: [{ name: 'a' }, { name: 'b' }],
    });
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].name, 'a');
  });

  it('parsePoshifyItems skips invalid entries', () => {
    const items = parsePoshifyItems({
      poshifiers: [{ name: 'a' }, null, { name: '' }, { nope: 1 }, 'string'],
    });
    assert.strictEqual(items.length, 1);
  });

  it('mergeLayers overrides by name preserving others', () => {
    const layers = [
      {
        items: [
          { name: 'go', tools: [{ cmd: 'a' }] },
          { name: 'py', tools: [{ cmd: 'b' }] },
        ],
      },
      {
        items: [{ name: 'go', tools: [{ cmd: 'c' }] }],
      },
    ];
    const merged = mergeLayers(layers);
    assert.strictEqual(merged.length, 2);
    const go = merged.find((i) => i.name === 'go');
    const py = merged.find((i) => i.name === 'py');
    assert.strictEqual(go.tools[0].cmd, 'c');
    assert.strictEqual(py.tools[0].cmd, 'b');
  });

  it('commandsForPoshify formats all sections', () => {
    const items = [
      {
        name: 'go',
        tools: [{ cmd: 'gofmt', args: ['-w', '{file}'] }],
        'audit-tools': [{ cmd: 'semgrep', args: ['--json'] }],
      },
    ];
    const out = commandsForPoshify(items);
    assert.ok(out.includes('gofmt -w {file}'));
    assert.ok(out.includes('semgrep --json'));
  });
});

describe('loadPoshifyConfig caching', () => {
  const tmpDirs = [];

  async function tmpDir() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-posher-cfg-'));
    tmpDirs.push(dir);
    return dir;
  }

  after(async () => {
    for (const dir of tmpDirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup failures */
      }
    }
  });

  function mockDeps() {
    return {
      validateAuditCommandForBatching: () => null,
      askTrust: async () => ({ trusted: false }),
    };
  }

  it('populates cache on first load and reuses it on second call', async () => {
    const agentDir = await tmpDir();
    _setAgentDir(agentDir);
    await fs.mkdir(path.join(agentDir, 'extensions', 'pi-posher'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(agentDir, 'extensions', 'pi-posher', 'poshifiers.json'),
      JSON.stringify({
        poshifiers: [{ name: 'cache-test', tools: [{ cmd: 'echo' }] }],
      }),
      'utf8',
    );

    const ctx = { cwd: agentDir, hasUI: false };
    const cache = { ready: false, value: undefined, cwd: undefined };
    const deps = mockDeps();

    const result1 = await loadPoshifyConfig(ctx, cache, deps);
    assert.strictEqual(cache.ready, true);
    assert.strictEqual(cache.cwd, agentDir);
    assert.ok(result1.items.some((i) => i.name === 'cache-test'));

    const result2 = await loadPoshifyConfig(ctx, cache, deps);
    assert.strictEqual(result2, result1);
  });

  it('reloads when cached cwd does not match current cwd', async () => {
    const agentDir = await tmpDir();
    _setAgentDir(agentDir);
    await fs.mkdir(path.join(agentDir, 'extensions', 'pi-posher'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(agentDir, 'extensions', 'pi-posher', 'poshifiers.json'),
      JSON.stringify({
        poshifiers: [{ name: 'reload-test', tools: [{ cmd: 'echo' }] }],
      }),
      'utf8',
    );

    const ctx = { cwd: agentDir, hasUI: false };
    const stale = { items: [], layers: [], warnings: [] };
    const cache = { ready: true, value: stale, cwd: '/other/path' };
    const deps = mockDeps();

    const result = await loadPoshifyConfig(ctx, cache, deps);
    assert.notStrictEqual(result, stale);
    assert.strictEqual(cache.cwd, agentDir);
    assert.ok(result.items.some((i) => i.name === 'reload-test'));
  });

  it('reloads when cache.ready is false', async () => {
    const agentDir = await tmpDir();
    _setAgentDir(agentDir);
    await fs.mkdir(path.join(agentDir, 'extensions', 'pi-posher'), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(agentDir, 'extensions', 'pi-posher', 'poshifiers.json'),
      JSON.stringify({
        poshifiers: [{ name: 'ready-test', tools: [{ cmd: 'echo' }] }],
      }),
      'utf8',
    );

    const ctx = { cwd: agentDir, hasUI: false };
    const cache = { ready: false, value: undefined, cwd: agentDir };
    const deps = mockDeps();

    const result = await loadPoshifyConfig(ctx, cache, deps);
    assert.strictEqual(cache.ready, true);
    assert.ok(result.items.some((i) => i.name === 'ready-test'));
  });
});
