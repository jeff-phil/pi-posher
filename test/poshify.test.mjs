import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { runPoshify } from '../src/poshify.mjs';

describe('poshify integration', () => {
  const tmpDirs = [];

  async function makeProject(files) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-posher-'));
    tmpDirs.push(dir);
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content, 'utf8');
    }
    return dir;
  }

  after(async () => {
    for (const dir of tmpDirs) {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failures
      }
    }
  });

  function mockCtx(cwd) {
    const ac = new AbortController();
    return { cwd, signal: ac.signal, hasUI: false };
  }

  function cachedConfig(items, cwd) {
    return { ready: true, value: { items, layers: [], warnings: [] }, cwd };
  }

  it('runs a tool per-file with input.files (agent ops)', async () => {
    const dir = await makeProject({
      '.project': '',
      'src/index.js': 'const x = 1;\n',
    });
    const cache = cachedConfig(
      [
        {
          name: 'js',
          include: ['**/*.js'],
          exclude: [],
          anchors: ['.project'],
          tools: [
            {
              cmd: 'node',
              args: ['-e', 'console.log("ok")'],
              cwd: '{root}',
              timeoutMs: 5000,
            },
          ],
        },
      ],
      dir,
    );
    const result = await runPoshify(mockCtx(dir), {
      input: { files: new Set([path.join(dir, 'src', 'index.js')]) },
      cache,
    });
    assert.ok(result.summary.includes('✅ js:'));
    assert.ok(result.summary.includes('src/index.js'));
    assert.strictEqual(result.findings.length, 0);
  });

  it('batches tools with input.path (slash command)', async () => {
    const dir = await makeProject({
      '.project': '',
      'src/a.js': '',
      'src/b.js': '',
    });
    const cache = cachedConfig(
      [
        {
          name: 'js',
          include: ['**/*.js'],
          anchors: ['.project'],
          tools: [
            {
              cmd: 'node',
              args: ['-e', '0', '{files}'],
              cwd: '{root}',
              timeoutMs: 5000,
            },
          ],
        },
      ],
      dir,
    );
    const result = await runPoshify(mockCtx(dir), {
      input: { path: path.join(dir, 'src') },
      cache,
    });
    assert.ok(result.summary.includes('✅'));
    assert.ok(result.summary.includes('succeeded'));
    assert.ok(result.summary.includes('2 file'));
    assert.strictEqual(result.findings.length, 0);
  });

  it('reports not found for missing commands', async () => {
    const dir = await makeProject({
      '.project': '',
      'src/a.js': '',
    });
    const cache = cachedConfig(
      [
        {
          name: 'js',
          include: ['**/*.js'],
          anchors: ['.project'],
          tools: [
            {
              cmd: 'definitely-not-real-98765',
              args: [],
              cwd: '{root}',
              timeoutMs: 1000,
            },
          ],
        },
      ],
      dir,
    );
    const result = await runPoshify(mockCtx(dir), {
      input: { path: path.join(dir, 'src', 'a.js') },
      cache,
    });
    assert.ok(result.summary.includes('command not found'));
  });

  it('runs audit-tools in batch mode with {files}', async () => {
    const dir = await makeProject({
      '.project': '',
      'src/a.js': '',
      'src/b.js': '',
    });
    const cache = cachedConfig(
      [
        {
          name: 'js',
          include: ['**/*.js'],
          anchors: ['.project'],
          'audit-tools': [
            {
              cmd: 'node',
              args: ['-e', '0', '{files}'],
              cwd: '{root}',
              timeoutMs: 5000,
            },
          ],
        },
      ],
      dir,
    );
    const result = await runPoshify(mockCtx(dir), {
      input: { path: path.join(dir, 'src') },
      sections: ['audit-tools'],
      cache,
    });
    assert.ok(result.summary.includes('✅'));
    assert.ok(result.summary.includes('succeeded'));
    assert.ok(result.summary.includes('2 file'));
  });

  it('deduplicates project-scoped audit-tools without {files}', async () => {
    // A tool with no {files} and no {file} should run once per root, not once per file.
    // We verify by counting invocations — the summary should show the batched format
    // ("succeeded (N files: ...)") rather than N separate lines.
    const dir = await makeProject({
      '.project': '',
      'src/a.js': '',
      'src/b.js': '',
      'src/c.js': '',
    });
    const cache = cachedConfig(
      [
        {
          name: 'js',
          include: ['**/*.js'],
          anchors: ['.project'],
          'audit-tools': [
            {
              cmd: 'node',
              args: ['-e', 'process.exit(0)'],
              cwd: '{root}',
              timeoutMs: 5000,
            },
          ],
        },
      ],
      dir,
    );
    const result = await runPoshify(mockCtx(dir), {
      input: { path: path.join(dir, 'src') },
      sections: ['audit-tools'],
      cache,
    });
    // Should run once and report all 3 files in a single line
    assert.ok(result.summary.includes('3 file'));
    // Should NOT have 3 separate "node" success lines
    const successLines = result.summary.split('\n').filter((l) => l.includes('✅'));
    assert.strictEqual(successLines.length, 1);
  });

  it('skips files above maxFileSizeBytes', async () => {
    const dir = await makeProject({
      '.project': '',
      'big.js': 'x'.repeat(100),
    });
    const cache = cachedConfig(
      [
        {
          name: 'js',
          include: ['**/*.js'],
          anchors: ['.project'],
          maxFileSizeBytes: 10,
          tools: [{ cmd: 'node', args: ['-e', '0'], cwd: '{root}', timeoutMs: 1000 }],
        },
      ],
      dir,
    );
    const result = await runPoshify(mockCtx(dir), {
      input: { path: path.join(dir, 'big.js') },
      cache,
    });
    assert.ok(result.summary.includes('exceeds maxFileSizeBytes'));
  });

  it('returns header-only summary when no files match', async () => {
    const dir = await makeProject({ '.project': '', 'readme.txt': 'hi' });
    const cache = cachedConfig(
      [
        {
          name: 'js',
          include: ['**/*.js'],
          anchors: ['.project'],
          tools: [{ cmd: 'node', args: ['-e', '0'], cwd: '{root}', timeoutMs: 1000 }],
        },
      ],
      dir,
    );
    const result = await runPoshify(mockCtx(dir), {
      input: { path: path.join(dir, 'readme.txt') },
      cache,
    });
    assert.strictEqual(result.summary, 'Poshify (built-in defaults):');
  });

  it('reports tool failure exit code', async () => {
    const dir = await makeProject({
      '.project': '',
      'src/a.js': '',
    });
    const cache = cachedConfig(
      [
        {
          name: 'js',
          include: ['**/*.js'],
          anchors: ['.project'],
          tools: [
            {
              cmd: 'node',
              args: ['-e', 'process.exit(1)'],
              cwd: '{root}',
              timeoutMs: 1000,
            },
          ],
        },
      ],
      dir,
    );
    const result = await runPoshify(mockCtx(dir), {
      input: { path: path.join(dir, 'src', 'a.js') },
      cache,
    });
    assert.ok(result.summary.includes('⚠️'));
    assert.ok(result.summary.includes('failed with exit code 1'));
  });

  it('batches tools with multiple input.paths', async () => {
    const dir = await makeProject({
      '.project': '',
      'src/a.js': '',
      'lib/b.js': '',
    });
    const cache = cachedConfig(
      [
        {
          name: 'js',
          include: ['**/*.js'],
          anchors: ['.project'],
          tools: [
            {
              cmd: 'node',
              args: ['-e', '0', '{files}'],
              cwd: '{root}',
              timeoutMs: 5000,
            },
          ],
        },
      ],
      dir,
    );
    const result = await runPoshify(mockCtx(dir), {
      input: {
        paths: [path.join(dir, 'src', 'a.js'), path.join(dir, 'lib', 'b.js')],
      },
      cache,
    });
    assert.ok(result.summary.includes('✅'));
    assert.ok(result.summary.includes('succeeded'));
    assert.ok(result.summary.includes('2 file'));
    assert.strictEqual(result.findings.length, 0);
  });

  it('warns on missing paths but continues with valid ones', async () => {
    const dir = await makeProject({
      '.project': '',
      'src/a.js': '',
    });
    const cache = cachedConfig(
      [
        {
          name: 'js',
          include: ['**/*.js'],
          anchors: ['.project'],
          tools: [
            {
              cmd: 'node',
              args: ['-e', '0', '{files}'],
              cwd: '{root}',
              timeoutMs: 5000,
            },
          ],
        },
      ],
      dir,
    );
    const result = await runPoshify(mockCtx(dir), {
      input: {
        paths: [path.join(dir, 'src', 'a.js'), path.join(dir, 'missing.js')],
      },
      cache,
    });
    assert.ok(result.summary.includes('✅'));
    assert.ok(result.summary.includes('succeeded'));
    assert.ok(result.summary.includes('1 file'));
    assert.ok(result.warnings.some((w) => w.includes('Path not found')));
  });
});
