// src/utils/crypto.ts
// AES-256-GCM authenticated encryption for credential fields stored in DB.
// Key must be 64 hex characters (32 bytes) set in ENCRYPTION_KEY env var.

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES  = 12;   // 96-bit IV for GCM
const TAG_BYTES = 16;   // 128-bit auth tag

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be 64 hex characters (32 bytes)');
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Encrypts a plaintext string.
 * Output format: `<iv_hex>:<tag_hex>:<ciphertext_hex>`
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv  = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypts a string produced by `encrypt()`.
 * Throws if the auth tag doesn't match (tampered data).
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const parts = ciphertext.split(':');
  if (parts.length !== 3) throw new Error('Invalid ciphertext format');

  const [ivHex, tagHex, dataHex] = parts;
  const iv      = Buffer.from(ivHex,  'hex');
  const tag     = Buffer.from(tagHex, 'hex');
  const data    = Buffer.from(dataHex,'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/**
 * Safely decrypt — returns null instead of throwing if decryption fails.
 * Use when showing "has credential" status without crashing.
 */
export function decryptSafe(ciphertext: string | null | undefined): string | null {
  if (!ciphertext) return null;
  try { return decrypt(ciphertext); } catch { return null; }
}

/**
 * Hash a token (refresh tokens, verify tokens) with SHA-256.
 * One-way — only the hash is stored; the raw token is never stored.
 */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time string comparison to prevent timing attacks.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
