import { createCipheriv, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

export const FIREBASE_SCRYPT_ALGORITHM = 'firebase-scrypt';
const KEY_LENGTH = 32;
const IV = Buffer.alloc(16);

const asBuffer = (value, encoding = 'base64') => {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value !== 'string' || !value) throw new Error('invalid-firebase-scrypt-value');
  return Buffer.from(value, encoding);
};
const scrypt = (password, salt, keyLength, options) => new Promise((resolve, reject) => {
  scryptCallback(password, salt, keyLength, options, (error, key) => error ? reject(error) : resolve(key));
});

export function normalizeFirebaseScryptConfig(config) {
  const memoryCost = Number(config?.memCost ?? config?.memoryCost);
  const rounds = Number(config?.rounds);
  const signerKey = asBuffer(config?.signerKey);
  const saltSeparator = asBuffer(config?.saltSeparator);
  if (!Number.isSafeInteger(memoryCost) || memoryCost < 1 || memoryCost > 30) throw new Error('invalid-firebase-scrypt-memory-cost');
  if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 1000000) throw new Error('invalid-firebase-scrypt-rounds');
  if (!signerKey.length || !saltSeparator.length) throw new Error('invalid-firebase-scrypt-config');
  return { memoryCost, rounds, signerKey, saltSeparator };
}

export async function firebaseScryptHash(password, salt, config) {
  if (typeof password !== 'string') throw new Error('invalid-password');
  const c = normalizeFirebaseScryptConfig(config);
  const derivedKey = await scrypt(password, Buffer.concat([asBuffer(salt), c.saltSeparator]), KEY_LENGTH, {
    N: 2 ** c.memoryCost, r: c.rounds, p: 1, maxmem: Math.max(32 * 1024 * 1024, 128 * (2 ** c.memoryCost) * c.rounds + 1024)
  });
  const cipher = createCipheriv('aes-256-ctr', derivedKey, IV);
  return Buffer.concat([cipher.update(c.signerKey), cipher.final()]).toString('base64');
}

export async function verifyFirebaseScrypt(password, credential, config) {
  try {
    if (typeof password !== 'string' || !credential || credential.algorithm !== FIREBASE_SCRYPT_ALGORITHM) return false;
    const expected = asBuffer(credential.hash);
    const actual = Buffer.from(await firebaseScryptHash(password, credential.salt, config), 'base64');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch { return false; }
}
