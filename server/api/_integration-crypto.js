import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function key() {
  const raw = process.env.INTEGRATION_ENCRYPTION_KEY;
  if (!raw) throw new Error('Integration encryption key is not configured');
  const value = Buffer.from(raw, 'base64');
  if (value.length !== 32) throw new Error('Integration encryption key is invalid');
  return value;
}

export function encryptSecret(value) {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptSecret(payload) {
  const [ivRaw, tagRaw, ciphertextRaw] = String(payload || '').split('.');
  if (!ivRaw || !tagRaw || !ciphertextRaw) throw new Error('Stored integration credential is invalid');
  const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivRaw, 'base64'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ciphertextRaw, 'base64')), decipher.final()]).toString('utf8');
}
