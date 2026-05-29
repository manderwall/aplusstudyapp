// WebCrypto helpers for at-rest encryption of progress/overrides/drawings.
// PIN → PBKDF2(SHA-256, 310k iters) → AES-GCM 256 key → encrypt/decrypt blobs.
// No plaintext PIN or derived key is ever persisted; the key lives in memory
// only for the current app session.

const PBKDF2_ITERATIONS = 310_000;  // OWASP 2023 baseline for SHA-256
const KEY_LENGTH_BITS = 256;
const SALT_BYTES = 16;
const IV_BYTES = 12;

const enc = new TextEncoder();
const dec = new TextDecoder();

function bufFromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64FromBuf(buf) {
  let bin = '';
  const bytes = new Uint8Array(buf);
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

export function randomSaltB64() {
  return b64FromBuf(crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

export async function deriveKey(pin, saltB64, iterations = PBKDF2_ITERATIONS) {
  if (typeof pin !== 'string' || pin.length === 0) throw new Error('PIN required');
  const baseKey = await crypto.subtle.importKey(
    'raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: bufFromB64(saltB64), iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: KEY_LENGTH_BITS },
    false, ['encrypt', 'decrypt'],
  );
}

// Returns { v, iv, ct } — all base64, safe to JSON-serialize into IndexedDB.
export async function encryptJSON(key, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const plaintext = enc.encode(JSON.stringify(obj));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  return { v: 1, iv: b64FromBuf(iv), ct: b64FromBuf(ct) };
}

// Throws if the key is wrong (AES-GCM tag mismatch) or the blob is malformed.
export async function decryptJSON(key, blob) {
  if (!isEncryptedBlob(blob)) throw new Error('Not an encrypted blob');
  if (blob.v !== 1) throw new Error(`Unsupported blob version ${blob.v}`);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bufFromB64(blob.iv) },
    key,
    bufFromB64(blob.ct),
  );
  return JSON.parse(dec.decode(plaintext));
}

export function isEncryptedBlob(x) {
  return !!x
    && typeof x === 'object'
    && !Array.isArray(x)
    && typeof x.v === 'number'
    && typeof x.iv === 'string'
    && typeof x.ct === 'string';
}

// Try to decrypt a known-plaintext verification blob. Used to check whether
// a PIN the user typed matches the PIN they set originally — without
// revealing any part of the real data if the PIN is wrong.
export async function verifyPin(key, verificationBlob) {
  try {
    const val = await decryptJSON(key, verificationBlob);
    return val === 'aplus-study-ok';
  } catch {
    return false;
  }
}

export async function makeVerificationBlob(key) {
  return encryptJSON(key, 'aplus-study-ok');
}

export const CRYPTO_DEFAULTS = Object.freeze({
  PBKDF2_ITERATIONS,
  KEY_LENGTH_BITS,
  SALT_BYTES,
  IV_BYTES,
});
