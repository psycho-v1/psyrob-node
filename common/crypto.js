// Hashing and secp256k1, via @noble/hashes and @noble/curves only.

import { keccak_256 } from '@noble/hashes/sha3.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
export const SECP256K1_HALF_N = SECP256K1_N >> 1n;

export const keccak256 = (data) => keccak_256(data);

export function randomPrivateKey() {
  return secp256k1.utils.randomSecretKey();
}

export function publicKeyToAddress(uncompressed65) {
  if (uncompressed65.length !== 65 || uncompressed65[0] !== 0x04) throw new Error('expected uncompressed public key');
  return keccak256(uncompressed65.subarray(1)).slice(12);
}

export function privateKeyToAddress(sk) {
  return publicKeyToAddress(secp256k1.getPublicKey(sk, false));
}

/** Sign a 32-byte digest. Always produces low-s signatures. */
export function signDigest(digest, sk) {
  if (digest.length !== 32) throw new Error('digest must be 32 bytes');
  const sig = secp256k1.Signature.fromBytes(
    secp256k1.sign(digest, sk, { prehash: false, lowS: true, format: 'recovered' }),
    'recovered',
  );
  return { r: sig.r, s: sig.s, recovery: sig.recovery };
}

/**
 * Recover the signer address. Rejects r/s out of range and high-s (malleable)
 * signatures before touching the curve.
 */
export function recoverAddress(digest, r, s, recovery) {
  if (digest.length !== 32) throw new Error('digest must be 32 bytes');
  if (r < 1n || r >= SECP256K1_N) throw new Error('signature r out of range');
  if (s < 1n || s > SECP256K1_HALF_N) throw new Error('signature s must be low (s <= n/2)');
  if (recovery !== 0 && recovery !== 1) throw new Error('invalid recovery id');
  const sig = new secp256k1.Signature(r, s, recovery);
  const pub = sig.recoverPublicKey(digest).toBytes(false);
  return publicKeyToAddress(pub);
}

/** 33-byte compressed public key of a private key (checkpoint seat keys). */
export function compressedPublicKey(sk) {
  return secp256k1.getPublicKey(sk, true);
}

/**
 * Recover the 33-byte compressed public key that signed `digest`. Same range and low-s checks
 * as recoverAddress.
 */
export function recoverCompressedKey(digest, r, s, recovery) {
  if (digest.length !== 32) throw new Error('digest must be 32 bytes');
  if (r < 1n || r >= SECP256K1_N) throw new Error('signature r out of range');
  if (s < 1n || s > SECP256K1_HALF_N) throw new Error('signature s must be low (s <= n/2)');
  if (recovery !== 0 && recovery !== 1) throw new Error('invalid recovery id');
  return new secp256k1.Signature(r, s, recovery).recoverPublicKey(digest).toBytes(true);
}
