import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  commandOutput,
  hasIssueOutput,
  truncateOutput,
} from '../../src/lib/output.mjs';

describe('output', () => {
  it('truncates long output', () => {
    const long = 'a'.repeat(5000);
    const result = truncateOutput(long, 100);
    assert.ok(result.length < long.length);
    assert.ok(result.includes('… output truncated'));
  });

  it('does not truncate short output', () => {
    const short = 'hello world';
    assert.strictEqual(truncateOutput(short, 100), 'hello world');
  });

  it('commandOutput combines stdout and stderr', () => {
    const result = commandOutput({ stdout: 'out', stderr: 'err' });
    assert.ok(result.includes('out'));
    assert.ok(result.includes('err'));
  });

  it('hasIssueOutput detects warning emoji', () => {
    assert.strictEqual(hasIssueOutput('⚠️ something'), true);
    assert.strictEqual(hasIssueOutput('all good'), false);
  });
});
