import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;
const PREFIX = 'scrypt';

/**
 * Hash de senha sem dependências nativas externas, usando scrypt da stdlib.
 * Formato: `scrypt$<saltHex>$<hashHex>`.
 */
export const hashPassword = (plain: string): string => {
  const salt = randomBytes(16);
  const derived = scryptSync(plain, salt, KEYLEN);
  return `${PREFIX}$${salt.toString('hex')}$${derived.toString('hex')}`;
};

export const verifyPassword = (plain: string, stored: string): boolean => {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== PREFIX) {
    return false;
  }

  const [, saltHex, hashHex] = parts;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = scryptSync(plain, salt, expected.length || KEYLEN);
  if (derived.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(derived, expected);
};
