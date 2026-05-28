import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { readTrustStore, sha256, writeTrustStore } from '../src/trust.mjs';

describe('trust', () => {
  it('sha256 produces a 64-char hex digest', () => {
    const h = sha256('hello');
    assert.strictEqual(typeof h, 'string');
    assert.strictEqual(h.length, 64);
    assert.match(h, /^[a-f0-9]+$/);
  });

  it('sha256 is deterministic', () => {
    assert.strictEqual(sha256('same'), sha256('same'));
    assert.notStrictEqual(sha256('a'), sha256('b'));
  });

  it('readTrustStore returns default for missing file', async () => {
    const nonExistent = path.join(os.tmpdir(), `pi-posher-trust-${Date.now()}.json`);
    const store = await readTrustStore(nonExistent);
    assert.deepStrictEqual(store, { version: 1, trustedHashes: [] });
  });

  it('writeTrustStore round-trips', async () => {
    const tmp = path.join(os.tmpdir(), `pi-posher-trust-${Date.now()}.json`);
    await writeTrustStore(tmp, { version: 1, trustedHashes: ['abc123'] });
    const store = await readTrustStore(tmp);
    assert.deepStrictEqual(store, { version: 1, trustedHashes: ['abc123'] });
    await fs.unlink(tmp);
  });

  it('readTrustStore filters non-string hashes', async () => {
    const tmp = path.join(os.tmpdir(), `pi-posher-trust-${Date.now()}.json`);
    await fs.writeFile(
      tmp,
      JSON.stringify({ version: 1, trustedHashes: ['ok', 123, null] }),
      'utf8',
    );
    const store = await readTrustStore(tmp);
    assert.deepStrictEqual(store.trustedHashes, ['ok']);
    await fs.unlink(tmp);
  });

  it('readTrustStore handles malformed json', async () => {
    const tmp = path.join(os.tmpdir(), `pi-posher-trust-${Date.now()}.json`);
    await fs.writeFile(tmp, 'not json', 'utf8');
    const store = await readTrustStore(tmp);
    assert.deepStrictEqual(store, { version: 1, trustedHashes: [] });
    await fs.unlink(tmp);
  });
});
