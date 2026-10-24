// Argon2d proof of work (DAG_SPEC.md section 3). Shared by the node (verification) and the miner (search).
//
//   powHash = Argon2d(password = header signing bytes, salt = "PSYROB-PoW", m = memoryKiB, t = iterations, p = 1, 32 bytes)
//   valid  <=>  uint256(powHash) <= target
//
// The network uses m = 32,768 KiB (32 MiB), t = 1. Tests and local devnets may use a smaller memory size; it is part of
// the chain parameters, so nodes with different values reject each other's blocks.
//
// Argon2d runs in the fastest implementation available: WebAssembly SIMD, plain WebAssembly (both built from the
// vendored reference code in third_party/argon2), then JavaScript (@noble/hashes). selfTest() checks the chosen one
// against fixed vectors; the node and the miner refuse to start on a mismatch.

import { argon2d } from '@noble/hashes/argon2.js';
import { bytesToBigint, bytesToHex, fromHex, utf8 } from './bytes.js';
import { createWasmArgon2, wasmAvailable } from './pow-wasm.js';
import { readResourceText } from './resources.js';

export const POW_SALT = utf8('PSYROB-PoW');
export const MAINNET_POW = Object.freeze({ memoryKiB: 32768, iterations: 1 });

const jsImpl = { name: 'js', hash: (pwd, salt, m, t) => argon2d(pwd, salt, { t, m, p: 1, dkLen: 32 }) };

export function availableImpls() {
  const out = [];
  for (const kind of ['simd', 'ref']) if (wasmAvailable(kind)) out.push('wasm-' + kind);
  return [...out, 'js'];
}

export function makeImpl(name) {
  if (name === 'js') return jsImpl;
  if (name === 'wasm-simd' || name === 'wasm-ref') return createWasmArgon2(name.slice(5));
  throw new Error('pow: unknown implementation ' + name);
}

let impl = null;
export function argon2Impl() {
  if (!impl) impl = makeImpl(process.env.PSY_POW_IMPL || availableImpls()[0]);
  return impl;
}

/** powHash of the header signing bytes under the chain's PoW settings ({ memoryKiB, iterations }). */
export function powHash(signing, pow = MAINNET_POW, im = argon2Impl()) {
  return im.hash(signing, POW_SALT, pow.memoryKiB, pow.iterations);
}

export const powValue = (signing, pow, im) => bytesToBigint(powHash(signing, pow, im));
export const checkPow = (signing, target, pow, im) => powValue(signing, pow, im) <= target;

/** Expected number of hashes for a target: 2^256 / (target + 1). Also the "work" of a block. */
export const workOf = (target) => (1n << 256n) / (target + 1n);

const VECTORS = JSON.parse(readResourceText('common/pow-vectors.json')).vectors;

/** Check implementations against the fixed Argon2d vectors (made with the JavaScript reference). Throws on mismatch. */
export function selfTest(names = [argon2Impl().name], { maxMemoryKiB = Infinity } = {}) {
  for (const name of names) {
    const im = name === argon2Impl().name ? argon2Impl() : makeImpl(name);
    for (const v of VECTORS) {
      if (v.m_kib > maxMemoryKiB) continue;
      const got = bytesToHex(im.hash(fromHex('0x' + v.pwd), fromHex('0x' + v.salt), v.m_kib, 1));
      if (got !== v.hash) throw new Error(`pow self-test failed: ${name} at ${v.m_kib} KiB gives ${got}, expected ${v.hash}`);
    }
  }
  return true;
}
