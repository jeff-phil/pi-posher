import assert from 'node:assert';
import { describe, it } from 'node:test';

import {
  detectOutputFormat,
  formatCompact,
  hashFinding,
  parseGenericLines,
  parseSemgrepJson,
} from '../src/parser.mjs';

describe('parser', () => {
  it('detects json output format from args', () => {
    assert.strictEqual(detectOutputFormat(['--json']), 'json');
    assert.strictEqual(detectOutputFormat(['--format', 'json']), 'json');
    assert.strictEqual(detectOutputFormat(['--output-format=sarif']), 'sarif');
    assert.strictEqual(detectOutputFormat(['-o', 'json']), 'json');
    assert.strictEqual(detectOutputFormat([]), 'text');
  });

  it('parses semgrep json output into findings', () => {
    const stdout = JSON.stringify({
      results: [
        {
          check_id: 'rule-1',
          path: 'src/foo.js',
          start: { line: 10, col: 5 },
          extra: { message: 'bad pattern', severity: 'ERROR' },
        },
      ],
    });
    const findings = parseSemgrepJson(stdout);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].tool, 'semgrep');
    assert.strictEqual(findings[0].rule, 'rule-1');
    assert.strictEqual(findings[0].line, 10);
    assert.strictEqual(findings[0].column, 5);
    assert.strictEqual(findings[0].severity, 'ERROR');
  });

  it('returns empty array for invalid semgrep json', () => {
    assert.deepStrictEqual(parseSemgrepJson('not json'), []);
    assert.deepStrictEqual(parseSemgrepJson(''), []);
  });

  it('parses file:line:col: message format', () => {
    const lines = 'src/foo.js:10:5: something went wrong\n';
    const findings = parseGenericLines(lines, '');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].file, 'src/foo.js');
    assert.strictEqual(findings[0].line, 10);
    assert.strictEqual(findings[0].column, 5);
    assert.strictEqual(findings[0].message, 'something went wrong');
  });

  it('parses file(line,col): message format', () => {
    const lines = 'src/foo.js(10,5): error here\n';
    const findings = parseGenericLines(lines, '');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].line, 10);
    assert.strictEqual(findings[0].column, 5);
  });

  it('parses file:line: message format', () => {
    const lines = 'src/foo.js:10: warn here\n';
    const findings = parseGenericLines(lines, '');
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].line, 10);
    assert.strictEqual(findings[0].column, 0);
  });

  it('combines stdout and stderr', () => {
    const findings = parseGenericLines('a:1:2: x\n', 'b:3:4: y\n');
    assert.strictEqual(findings.length, 2);
  });

  it('hashes findings consistently', () => {
    const h1 = hashFinding('semgrep', {
      rule: 'r1',
      message: 'msg',
      line: 5,
    });
    const h2 = hashFinding('semgrep', {
      rule: 'r1',
      message: 'msg',
      line: 5,
    });
    const h3 = hashFinding('semgrep', {
      rule: 'r2',
      message: 'msg',
      line: 5,
    });
    assert.strictEqual(h1, h2);
    assert.notStrictEqual(h1, h3);
    assert.strictEqual(h1.length, 16);
  });

  it('formats compact finding with relative path', () => {
    const f = {
      tool: 'semgrep',
      rule: 'r1',
      file: '/proj/src/foo.js',
      line: 10,
      message: 'bad',
      root: '/proj',
    };
    const s = formatCompact(f);
    assert.ok(s.includes('src/foo.js:10'));
    assert.ok(s.includes('semgrep'));
    assert.ok(s.includes('r1'));
  });

  it('formatCompact falls back to basename when file outside root', () => {
    const f = {
      tool: 't',
      rule: 'r',
      file: '/other/foo.js',
      line: 1,
      message: 'm',
      root: '/proj',
    };
    const s = formatCompact(f);
    assert.ok(s.includes('foo.js'));
  });
});
