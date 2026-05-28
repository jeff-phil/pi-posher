import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  copyFileOrDir,
  expandInitGlob,
  normalizeInitEntry,
  runInitByName,
  seedInitFromBundled,
} from '../src/init-seeder.mjs';
import { _setAgentDir } from '../src/trust.mjs';

describe('init-seeder', () => {
  const tmpDirs = [];

  async function tmpDir() {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-posher-init-'));
    tmpDirs.push(dir);
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

  describe('normalizeInitEntry', () => {
    it('strips trailing /** and /', () => {
      assert.strictEqual(normalizeInitEntry('foo/'), 'foo');
      assert.strictEqual(normalizeInitEntry('foo/**'), 'foo');
      assert.strictEqual(normalizeInitEntry('foo'), 'foo');
    });
  });

  describe('expandInitGlob', () => {
    it('matches files in a directory', async () => {
      const base = await tmpDir();
      await fs.writeFile(path.join(base, 'a.json'), '{}', 'utf8');
      await fs.writeFile(path.join(base, 'b.yaml'), '', 'utf8');
      const matches = await expandInitGlob(base, '*.json');
      assert.strictEqual(matches.length, 1);
      assert.strictEqual(matches[0], 'a.json');
    });

    it('returns empty array for missing directory', async () => {
      const base = await tmpDir();
      const matches = await expandInitGlob(base, 'missing/*.json');
      assert.deepStrictEqual(matches, []);
    });
  });

  describe('copyFileOrDir', () => {
    it('copies a file to a new destination', async () => {
      const base = await tmpDir();
      const src = path.join(base, 'src.txt');
      const dest = path.join(base, 'dest.txt');
      await fs.writeFile(src, 'hello', 'utf8');
      await copyFileOrDir(src, dest);
      const content = await fs.readFile(dest, 'utf8');
      assert.strictEqual(content, 'hello');
    });

    it('copies a directory recursively', async () => {
      const base = await tmpDir();
      const srcDir = path.join(base, 'src');
      const destDir = path.join(base, 'dest');
      await fs.mkdir(path.join(srcDir, 'sub'), { recursive: true });
      await fs.writeFile(path.join(srcDir, 'sub', 'file.txt'), 'data', 'utf8');
      await copyFileOrDir(srcDir, destDir);
      const content = await fs.readFile(path.join(destDir, 'sub', 'file.txt'), 'utf8');
      assert.strictEqual(content, 'data');
    });

    it('skips existing files', async () => {
      const base = await tmpDir();
      const src = path.join(base, 'src.txt');
      const dest = path.join(base, 'dest.txt');
      await fs.writeFile(src, 'new', 'utf8');
      await fs.writeFile(dest, 'old', 'utf8');
      const copied = [];
      const skipped = [];
      await copyFileOrDir(src, dest, copied, skipped, base);
      assert.deepStrictEqual(copied, []);
      assert.strictEqual(skipped.length, 1);
      assert.ok(skipped[0].includes('dest.txt'));
    });
  });

  describe('seedInitFromBundled', () => {
    it('copies a single file entry', async () => {
      const bundled = await tmpDir();
      const user = await tmpDir();
      await fs.writeFile(path.join(bundled, '.prettierrc'), '{}', 'utf8');
      await seedInitFromBundled(bundled, user, '.prettierrc', 'js');
      const content = await fs.readFile(path.join(user, '.prettierrc'), 'utf8');
      assert.strictEqual(content, '{}');
    });

    it('copies glob-matched files', async () => {
      const bundled = await tmpDir();
      const user = await tmpDir();
      await fs.writeFile(path.join(bundled, 'a.json'), '{}', 'utf8');
      await fs.writeFile(path.join(bundled, 'b.yaml'), '', 'utf8');
      await seedInitFromBundled(bundled, user, '*.json', 'js');
      const files = await fs.readdir(user);
      assert.deepStrictEqual(files.sort(), ['a.json']);
    });

    it('skips existing files silently', async () => {
      const bundled = await tmpDir();
      const user = await tmpDir();
      await fs.writeFile(path.join(bundled, 'x.txt'), 'new', 'utf8');
      await fs.writeFile(path.join(user, 'x.txt'), 'old', 'utf8');
      await seedInitFromBundled(bundled, user, 'x.txt', 'js');
      const content = await fs.readFile(path.join(user, 'x.txt'), 'utf8');
      assert.strictEqual(content, 'old');
    });
  });

  describe('runInitByName', { concurrency: false }, () => {
    it('copies configs and runs tools', async () => {
      const cwd = await tmpDir();
      _setAgentDir(cwd);

      const poshifier = {
        name: 'js',
        'init-setup': {
          'init-configs': ['.prettierrc'],
          'init-tools': [
            {
              cmd: 'node',
              args: ['-e', 'console.log("setup-done")'],
              cwd: '{root}',
              timeoutMs: 5000,
            },
          ],
        },
      };

      const ac = new AbortController();
      const ctx = { cwd, signal: ac.signal };
      const calls = [];
      const mockRunner = async (command) => {
        calls.push(command);
        return { code: 0, stdout: '', stderr: '', durationMs: 0, killed: false };
      };

      const result = await runInitByName(ctx, poshifier, 'js', mockRunner);
      assert.deepStrictEqual(result.copied, ['.prettierrc']);
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].cmd, 'node');
    });

    it('throws when init tool fails', async () => {
      const cwd = await tmpDir();
      _setAgentDir(cwd);

      const poshifier = {
        name: 'js',
        'init-setup': {
          'init-configs': ['.prettierrc'],
          'init-tools': [
            {
              cmd: 'node',
              args: ['-e', 'process.exit(1)'],
              cwd: '{root}',
              timeoutMs: 5000,
            },
          ],
        },
      };

      const ac = new AbortController();
      const ctx = { cwd, signal: ac.signal };
      const mockRunner = async (_command) => {
        return {
          code: 1,
          stdout: 'err',
          stderr: '',
          durationMs: 0,
          killed: false,
        };
      };

      await assert.rejects(async () => {
        await runInitByName(ctx, poshifier, 'js', mockRunner);
      });
    });
  });
});
