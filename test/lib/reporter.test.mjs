import assert from 'node:assert';
import { describe, it } from 'node:test';

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
} from '../../src/lib/reporter.mjs';

describe('reporter', () => {
  it('getBareCommand extracts the real tool name from npm exec', () => {
    assert.strictEqual(getBareCommand('npm', ['exec', '--', 'prettier']), 'prettier');
  });

  it('getBareCommand returns basename for direct command', () => {
    assert.strictEqual(getBareCommand('eslint', ['--fix', 'file.js']), 'eslint');
  });

  it('getBareCommand extracts from npx', () => {
    assert.strictEqual(getBareCommand('npx', ['tsc']), 'tsc');
  });

  it('getBareCommand extracts from python -m', () => {
    assert.strictEqual(getBareCommand('python', ['-m', 'pytest']), 'pytest');
    assert.strictEqual(getBareCommand('python3', ['-m', 'ruff']), 'ruff');
    assert.strictEqual(getBareCommand('python3.12', ['-m', 'pip']), 'pip');
    assert.strictEqual(getBareCommand('py', ['-m', 'black']), 'black');
  });

  it('getBareCommand extracts from python script invocation', () => {
    assert.strictEqual(getBareCommand('python', ['script.py']), 'script.py');
    assert.strictEqual(
      getBareCommand('python3', ['manage.py', 'runserver']),
      'manage.py',
    );
  });

  it('getBareCommand returns python basename when only flags', () => {
    assert.strictEqual(getBareCommand('python', ['-V']), 'python');
    assert.strictEqual(getBareCommand('python3', []), 'python3');
  });

  it('formatToolSuccess marks success', () => {
    const line = formatToolSuccess('js', 'prettier', 'src/foo.js', 'checked');
    assert.ok(line.includes('✅'));
    assert.ok(line.includes('prettier'));
  });

  it('formatToolFailure marks failure', () => {
    const line = formatToolFailure('js', 'eslint', { code: 1, killed: false }, 'err');
    assert.ok(line.includes('⚠️'));
    assert.ok(line.includes('exit code 1'));
  });

  it('formatBatchSuccess shows file count', () => {
    const line = formatBatchSuccess('semgrep', ['a.js', 'b.js']);
    assert.ok(line.includes('2 files'));
  });

  it('formatBatchSuccess uses singular for one file', () => {
    const line = formatBatchSuccess('semgrep', ['a.js']);
    assert.ok(line.includes('1 file'));
  });

  it('formatRunOnceSuccess shows triggered-by wording', () => {
    const line = formatRunOnceSuccess('svelte-check', ['a.svelte', 'b.svelte']);
    assert.ok(line.includes('✅'));
    assert.ok(line.includes('triggered by'));
    assert.ok(line.includes('2 files'));
  });

  it('formatRunOnceSuccess uses singular for one file', () => {
    const line = formatRunOnceSuccess('svelte-check', ['a.svelte']);
    assert.ok(line.includes('triggered by'));
    assert.ok(line.includes('1 file'));
  });

  it('formatBatchFailure includes finding lines when present', () => {
    const line = formatBatchFailure(
      'semgrep',
      { code: 1, killed: false },
      ['finding1', 'finding2'],
      'output',
    );
    assert.ok(line.includes('finding1'));
  });

  it('formatNotFound contains tool name', () => {
    const line = formatNotFound('go', 'gofmt');
    assert.ok(line.includes('gofmt'));
    assert.ok(line.includes('not found'));
  });

  it('formatError forwards message', () => {
    const line = formatError('js', new Error('boom'));
    assert.ok(line.includes('boom'));
  });

  it('assembleSummary joins sections', () => {
    const summary = assembleSummary('Header', ['warn1'], ['line1']);
    assert.ok(summary.startsWith('Header:'));
    assert.ok(summary.includes('warn1'));
    assert.ok(summary.includes('line1'));
  });
});
