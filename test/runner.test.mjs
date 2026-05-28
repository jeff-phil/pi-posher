import assert from 'node:assert';
import { describe, it } from 'node:test';

import { execDirect } from '../src/runner.mjs';

describe('runner', () => {
  it('returns success for a quick command', async () => {
    const result = await execDirect('node', ['-e', 'console.log("hello")'], {
      timeout: 5000,
    });
    assert.strictEqual(result.code, 0);
    assert.strictEqual(result.stdout.trim(), 'hello');
    assert.strictEqual(result.error, undefined);
  });

  it('returns non-zero exit code without error flag', async () => {
    const result = await execDirect('node', ['-e', 'process.exit(2)'], {
      timeout: 5000,
    });
    assert.strictEqual(result.code, 2);
    assert.strictEqual(result.error, undefined);
  });

  it('kills command on timeout and sets killed', async () => {
    const start = Date.now();
    const result = await execDirect('node', ['-e', 'setTimeout(()=>{}, 10000)'], {
      timeout: 100,
    });
    const duration = Date.now() - start;
    assert.ok(result.killed, 'should be killed');
    assert.notStrictEqual(result.code, 0, 'killed process should not report code 0');
    assert.ok(duration < 1000, 'should timeout quickly');
  });

  it('distinguishes spawn failure with error flag', async () => {
    // A directory is not executable; spawning it produces an error event.
    const result = await execDirect(process.cwd(), [], { timeout: 5000 });
    assert.strictEqual(
      result.error,
      'spawn_failed',
      `expected spawn_failed, got ${result.error}`,
    );
  });
});
