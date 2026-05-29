import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  colorizeLine,
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

  it('hasIssueOutput detects plain warning text', () => {
    assert.strictEqual(hasIssueOutput('1 warning found'), true);
    assert.strictEqual(hasIssueOutput('eslint: WARN deprecated'), true);
    assert.strictEqual(hasIssueOutput('no issues here'), false);
  });

  describe('colorizeLine', () => {
    const mockTheme = {
      fg: (key, text) => `[${key}:${text}]`,
    };

    it('highlights tool name after status emoji', () => {
      const line = '✅ js: prettier succeeded on src/foo.js';
      const result = colorizeLine(mockTheme, line);
      assert.ok(result.includes('[accent:js]'));
      assert.ok(result.includes('[accent:succeeded]'));
    });

    it('highlights bare command without colon', () => {
      const line = '✅ prettier succeeded (1 file: src/foo.js)';
      const result = colorizeLine(mockTheme, line);
      assert.ok(result.includes('[accent:prettier]'));
      assert.ok(result.includes('[accent:succeeded]'));
    });

    it('uses error accent for failure lines', () => {
      const line = '⚠️ js: eslint failed with exit code 1';
      const result = colorizeLine(mockTheme, line);
      assert.ok(result.includes('[error:js]'));
      assert.ok(result.includes('[error:failed]'));
    });

    it('uses error accent for ⚠️ failure lines', () => {
      const line = '⚠️ js: eslint failed with exit code 1';
      const result = colorizeLine(mockTheme, line);
      assert.ok(result.includes('[error:js]'));
      assert.ok(result.includes('[error:failed]'));
    });

    it('returns plain text when nothing to highlight', () => {
      const line = 'plain boring line';
      const result = colorizeLine(mockTheme, line);
      assert.strictEqual(result, '[toolOutput:plain boring line]');
    });

    it('renders info lines in muted theme', () => {
      const line = 'ℹ️ js: dedup note';
      const result = colorizeLine(mockTheme, line);
      assert.strictEqual(result, '[muted:ℹ️ js: dedup note]');
    });
  });
});
