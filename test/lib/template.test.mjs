import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  applyTemplate,
  applyTemplateArray,
  validateBatchCommand,
} from '../../src/lib/template.mjs';

describe('template', () => {
  it('replaces placeholders', () => {
    const result = applyTemplate('hello {name}', { name: 'world' });
    assert.strictEqual(result, 'hello world');
  });

  it('leaves unknown placeholders intact', () => {
    const result = applyTemplate('hello {unknown}', { name: 'world' });
    assert.strictEqual(result, 'hello {unknown}');
  });

  it('applies template to array', () => {
    const result = applyTemplateArray(['{name}', '{file}'], {
      name: 'js',
      file: 'src/foo.js',
    });
    assert.deepStrictEqual(result, ['js', 'src/foo.js']);
  });

  it('validates batching when {files} mixed with per-file placeholders', () => {
    const cmd = { cmd: 'tool', args: ['{files}', '{file}'] };
    assert.ok(validateBatchCommand(cmd));
  });

  it('flags {relFile} alongside {files}', () => {
    const cmd = { cmd: 'tool', args: ['{files}'], cwd: '{relFile}' };
    assert.ok(validateBatchCommand(cmd));
  });

  it('allows batching when only {files} is used', () => {
    const cmd = { cmd: 'tool', args: ['{files}'] };
    assert.strictEqual(validateBatchCommand(cmd), null);
  });

  it('allows non-batch commands without {files}', () => {
    const cmd = { cmd: 'tool', args: ['{file}'] };
    assert.strictEqual(validateBatchCommand(cmd), null);
  });
});
