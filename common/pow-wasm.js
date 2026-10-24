// Argon2d in WebAssembly, built from the vendored reference implementation (scripts/build-pow.mjs):
// argon2-simd.wasm (optimised code on WebAssembly SIMD) and argon2-ref.wasm (reference code). The files
// are committed; their SHA-256 is in native/ARTIFACTS.sha256 and checked by test/pow-impl.test.js.

import { readResource } from './resources.js';
import { getRandomValues } from 'node:crypto';

const files = { simd: 'argon2-simd.wasm', ref: 'argon2-ref.wasm' };
const modules = new Map();

/** True if this runtime can compile the module (`simd` needs WebAssembly SIMD). */
export function wasmAvailable(kind) {
  try { return WebAssembly.validate(readResource('common/pow-wasm/' + files[kind])); } catch { return false; }
}

/**
 * A new instance: { name, hash(password, salt, memoryKiB, iterations) -> Uint8Array(32) }. Synchronous.
 * Each instance keeps its own memory; Argon2's working memory is reused between calls.
 */
export function createWasmArgon2(kind) {
  if (!modules.has(kind)) modules.set(kind, new WebAssembly.Module(readResource('common/pow-wasm/' + files[kind])));
  let mem;
  // The C library's start-up code imports random_get; hashing never calls it.
  const inst = new WebAssembly.Instance(modules.get(kind), { wasi_snapshot_preview1: { random_get: (ptr, len) => { getRandomValues(new Uint8Array(mem.buffer, ptr, len)); return 0; } } });
  const x = inst.exports;
  mem = x.memory;
  x._initialize();
  let cap = 0, pwdPtr = 0;
  const saltPtr = x.psy_alloc(256), outPtr = x.psy_alloc(32);
  return {
    name: 'wasm-' + kind,
    hash(password, salt, memoryKiB, iterations) {
      if (salt.length > 256) throw new Error('pow-wasm: salt too long');
      if (password.length > cap) { if (pwdPtr) x.psy_free(pwdPtr); cap = Math.max(512, password.length); pwdPtr = x.psy_alloc(cap); }
      new Uint8Array(mem.buffer).set(password, pwdPtr);
      new Uint8Array(mem.buffer).set(salt, saltPtr);
      const rc = x.psy_argon2d(pwdPtr, password.length, saltPtr, salt.length, memoryKiB, iterations, outPtr);
      if (rc !== 0) throw new Error('pow-wasm: argon2 error ' + rc);
      return new Uint8Array(mem.buffer).slice(outPtr, outPtr + 32);
    },
  };
}
