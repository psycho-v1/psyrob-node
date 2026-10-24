// The miner's encrypted wallet file: the private key encrypted with AES-256-GCM under a key derived from the user's
// password with scrypt (N = 2^15, r = 8, p = 1). A key kept as plain hex in wallet.key (owner-only file) can be
// protected from the control page.
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { privateKeyToAddress } from '../../common/crypto.js';
import { bytesToHex } from '../../common/bytes.js';

const KDF = { N: 1 << 15, r: 8, p: 1 };
const MAXMEM = 64 * 1024 * 1024;

/** { version, kdf, N, r, p, salt, iv, tag, data, address } for a 32-byte key. */
export function encryptKey(key, password) {
  const salt = randomBytes(16), iv = randomBytes(12);
  const k = scryptSync(password, salt, 32, { ...KDF, maxmem: MAXMEM });
  const c = createCipheriv('aes-256-gcm', k, iv);
  const data = Buffer.concat([c.update(Buffer.from(key)), c.final()]);
  return { version: 1, kdf: 'scrypt', ...KDF, salt: salt.toString('hex'), iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('hex'), address: '0x' + bytesToHex(privateKeyToAddress(key)) };
}

/** The key, or throws "wrong password" (the GCM tag does not verify). */
export function decryptKey(w, password) {
  if (w?.kdf !== 'scrypt' || w.version !== 1) throw new Error('unknown wallet file format');
  const k = scryptSync(password, Buffer.from(w.salt, 'hex'), 32, { N: w.N, r: w.r, p: w.p, maxmem: MAXMEM });
  const d = createDecipheriv('aes-256-gcm', k, Buffer.from(w.iv, 'hex'));
  d.setAuthTag(Buffer.from(w.tag, 'hex'));
  try { return Uint8Array.from(Buffer.concat([d.update(Buffer.from(w.data, 'hex')), d.final()])); } catch { throw new Error('wrong password'); }
}
