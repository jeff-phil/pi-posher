import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  createPathPlaceholders,
  findProjectRoot,
  isExecutableAvailable,
  normalizeRelativePath,
} from '../../src/lib/paths.mjs';

describe('paths', () => {
  it('normalizes relative paths with forward slashes', () => {
    assert.strictEqual(normalizeRelativePath('src/foo/bar'), 'src/foo/bar');
    assert.strictEqual(normalizeRelativePath('src/foo'), 'src/foo');
    assert.strictEqual(normalizeRelativePath(''), '.');
    if (process.platform === 'win32') {
      assert.strictEqual(normalizeRelativePath('src\\foo\\bar'), 'src/foo/bar');
    } else {
      assert.strictEqual(normalizeRelativePath('src\\foo'), 'src\\foo');
    }
  });

  it('creates path placeholders from options', () => {
    const p = createPathPlaceholders({
      workspace: '/workspace',
      root: '/workspace/project',
      file: '/workspace/project/src/index.js',
    });
    assert.strictEqual(p.workspace, '/workspace');
    assert.strictEqual(p.root, '/workspace/project');
    assert.strictEqual(p.file, '/workspace/project/src/index.js');
    assert.strictEqual(p.relFile, 'src/index.js');
    assert.strictEqual(p.relDir, 'src');
    assert.strictEqual(p.name, '');
    assert.strictEqual(p.config, '');
    assert.strictEqual(p.configDir, '');
  });

  it('finds project root by anchor file', async () => {
    const testFile = new URL(import.meta.url).pathname;
    const root = await findProjectRoot(testFile, ['package.json'], process.cwd());
    assert.ok(root);
    assert.ok(root.endsWith('pi-posher'));
  });

  it('findProjectRoot returns undefined when no anchor found', async () => {
    const root = await findProjectRoot(
      '/tmp/nonexistent/file.txt',
      ['nonexistent.marker'],
      '/tmp',
    );
    assert.strictEqual(root, undefined);
  });

  it('findProjectRoot falls back to cwd when anchors empty', async () => {
    const cwd = process.cwd();
    const root = await findProjectRoot('/tmp/foo.txt', [], cwd);
    assert.strictEqual(root, cwd);
  });

  it('detects known executables on PATH', () => {
    assert.strictEqual(isExecutableAvailable('node'), true);
    assert.strictEqual(
      isExecutableAvailable('definitely-not-a-real-binary-12345'),
      false,
    );
  });
});
