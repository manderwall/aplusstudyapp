// Unit tests for crypto.mjs. Node 22+ exposes WebCrypto globally so these
// run without a DOM. Use a lower iteration count for test speed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  randomSaltB64, deriveKey, encryptJSON, decryptJSON, isEncryptedBlob,
  makeVerificationBlob, verifyPin,
} from '../crypto.mjs';

// 1k iterations for fast tests — production uses 310k
const ITERS = 1000;

test('randomSaltB64 returns 16-byte base64 salts that differ', () => {
  const a = randomSaltB64();
  const b = randomSaltB64();
  // 16 bytes → 24-char base64 (with padding)
  assert.equal(a.length, 24);
  assert.notEqual(a, b);
});

test('deriveKey: same PIN + salt → matching keys (round-trip)', async () => {
  const salt = randomSaltB64();
  const k1 = await deriveKey('1234', salt, ITERS);
  const k2 = await deriveKey('1234', salt, ITERS);
  const blob = await encryptJSON(k1, { hi: 'there' });
  const out = await decryptJSON(k2, blob);
  assert.deepEqual(out, { hi: 'there' });
});

test('deriveKey: different PIN → decrypt throws', async () => {
  const salt = randomSaltB64();
  const good = await deriveKey('1234', salt, ITERS);
  const bad = await deriveKey('9999', salt, ITERS);
  const blob = await encryptJSON(good, { secret: 42 });
  await assert.rejects(() => decryptJSON(bad, blob));
});

test('deriveKey: same PIN + different salt → different keys', async () => {
  const k1 = await deriveKey('1234', randomSaltB64(), ITERS);
  const k2 = await deriveKey('1234', randomSaltB64(), ITERS);
  const blob = await encryptJSON(k1, { a: 1 });
  await assert.rejects(() => decryptJSON(k2, blob));
});

test('deriveKey: empty PIN rejected', async () => {
  await assert.rejects(() => deriveKey('', randomSaltB64(), ITERS), /PIN required/);
});

test('encryptJSON: different IVs each call for same key/payload', async () => {
  const salt = randomSaltB64();
  const key = await deriveKey('1234', salt, ITERS);
  const a = await encryptJSON(key, { x: 1 });
  const b = await encryptJSON(key, { x: 1 });
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ct, b.ct);
});

test('encryptJSON roundtrips arrays, nested objects, unicode', async () => {
  const key = await deriveKey('pin-ü', randomSaltB64(), ITERS);
  const payload = {
    nums: [1, 2, 3],
    nested: { foo: 'bar', n: null },
    unicode: 'café • 🔒 • 日本語',
  };
  const blob = await encryptJSON(key, payload);
  const out = await decryptJSON(key, blob);
  assert.deepEqual(out, payload);
});

test('isEncryptedBlob recognizes valid blobs', async () => {
  const key = await deriveKey('1234', randomSaltB64(), ITERS);
  const blob = await encryptJSON(key, { hi: 1 });
  assert.equal(isEncryptedBlob(blob), true);
  assert.equal(isEncryptedBlob(null), false);
  assert.equal(isEncryptedBlob({}), false);
  assert.equal(isEncryptedBlob({ hi: 1 }), false);
  assert.equal(isEncryptedBlob([1, 2, 3]), false);
  // plain progress object shape from the app:
  assert.equal(isEncryptedBlob({ p1q3: { seen: 2, status: 'good' } }), false);
});

test('decryptJSON: unsupported blob version rejected', async () => {
  const key = await deriveKey('1234', randomSaltB64(), ITERS);
  await assert.rejects(
    () => decryptJSON(key, { v: 999, iv: 'AAAA', ct: 'AAAA' }),
    /Unsupported blob version/,
  );
});

test('verifyPin returns true for matching PIN, false otherwise', async () => {
  const salt = randomSaltB64();
  const realKey = await deriveKey('1234', salt, ITERS);
  const verification = await makeVerificationBlob(realKey);

  const rightAttempt = await deriveKey('1234', salt, ITERS);
  const wrongAttempt = await deriveKey('0000', salt, ITERS);

  assert.equal(await verifyPin(rightAttempt, verification), true);
  assert.equal(await verifyPin(wrongAttempt, verification), false);
});

test('verifyPin rejects tampered ciphertext', async () => {
  const key = await deriveKey('1234', randomSaltB64(), ITERS);
  const blob = await makeVerificationBlob(key);
  // Flip a byte of the ciphertext → GCM tag check fails
  const tampered = { ...blob, ct: blob.ct.slice(0, -2) + 'AA' };
  assert.equal(await verifyPin(key, tampered), false);
});
