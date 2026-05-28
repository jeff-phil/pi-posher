import assert from 'node:assert';
import { describe, it } from 'node:test';

import { hasGlobMeta, isPathIncluded, matchesGlob } from '../../src/lib/glob.mjs';

describe('glob', () => {
  it('matches simple extension globs', () => {
    assert.strictEqual(matchesGlob('**/*.js', 'src/foo.js'), true);
    assert.strictEqual(matchesGlob('**/*.js', 'src/foo.ts'), false);
  });

  it('matches brace expansion', () => {
    assert.strictEqual(matchesGlob('**/*.{js,ts}', 'src/foo.ts'), true);
    assert.strictEqual(matchesGlob('**/*.{js,ts}', 'src/foo.py'), false);
  });

  it('respects directory boundaries with single star', () => {
    assert.strictEqual(matchesGlob('src/*.js', 'src/foo.js'), true);
    assert.strictEqual(matchesGlob('src/*.js', 'src/deep/foo.js'), false);
  });

  it('double star crosses directories', () => {
    assert.strictEqual(matchesGlob('src/**/*.js', 'src/deep/foo.js'), true);
    assert.strictEqual(matchesGlob('src/**/*.js', 'foo.js'), false);
  });

  it('isPathIncluded handles include and exclude', () => {
    assert.strictEqual(isPathIncluded('src/foo.js', ['**/*.js'], []), true);
    assert.strictEqual(
      isPathIncluded('src/foo.js', ['**/*.js'], ['**/node_modules/**']),
      true,
    );
    assert.strictEqual(
      isPathIncluded('node_modules/foo.js', ['**/*.js'], ['**/node_modules/**']),
      false,
    );
    assert.strictEqual(isPathIncluded('src/foo.ts', ['**/*.js'], []), false);
    assert.strictEqual(isPathIncluded('any.ts', [], []), true);
  });

  it('detects glob meta characters', () => {
    assert.strictEqual(hasGlobMeta('*.js'), true);
    assert.strictEqual(hasGlobMeta('file.js'), false);
    assert.strictEqual(hasGlobMeta('file?.js'), true);
    assert.strictEqual(hasGlobMeta('{a,b}'), true);
  });

  it('treats unmatched opening brace as literal', () => {
    // No closing `}` — the `{` is a literal character
    assert.strictEqual(matchesGlob('abc{def', 'abc{def'), true);
    assert.strictEqual(matchesGlob('abc{def', 'abcdef'), false);
  });

  it('treats empty braces as literal', () => {
    // `{}` is not a valid expansion — treated as literal characters
    assert.strictEqual(matchesGlob('foo{}bar', 'foo{}bar'), true);
    assert.strictEqual(matchesGlob('foo{}bar', 'foobar'), false);
  });
});
