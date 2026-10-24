// Minimal Solidity ABI encoding and decoding: the types the genesis builder and the tests need.
//
//   address, uint256, bool          one word
//   bytes, string                   dynamic (string as UTF-8)
//   address[], uint256[]            dynamic arrays of one-word items
//   ['tuple', [types]]              a static tuple of one-word items, encoded inline

import { keccak256 } from './crypto.js';
import { bigintToFixed, bytesToBigint, concat, utf8 } from './bytes.js';

export const selector = (signature) => keccak256(utf8(signature)).slice(0, 4);

const word = (n) => bigintToFixed(BigInt(n), 32);
const isDynamic = (t) => t === 'bytes' || t === 'string' || (typeof t === 'string' && t.endsWith('[]'));

function encodeWord(type, v) {
  if (type === 'address') {
    if (!(v instanceof Uint8Array) || v.length !== 20) throw new Error('abi: address must be 20 bytes');
    return concat(new Uint8Array(12), v);
  }
  if (type === 'uint256' || type === 'uint32' || type === 'uint16' || type === 'uint8') return word(v);
  if (type === 'bool') return word(v ? 1n : 0n);
  throw new Error('abi: unsupported type ' + type);
}

function encodeTail(type, v) {
  if (type === 'string') return encodeTail('bytes', utf8(v));
  if (type === 'bytes') {
    const padded = new Uint8Array(Math.ceil(v.length / 32) * 32);
    padded.set(v);
    return concat(word(v.length), padded);
  }
  const item = type.slice(0, -2);
  return concat(word(v.length), ...v.map((x) => encodeWord(item, x)));
}

/** ABI-encode `values` as the given parameter `types` (no selector). */
export function encode(types, values) {
  if (types.length !== values.length) throw new Error('abi: types and values differ in length');
  const heads = [], tails = [];
  let headSize = 0;
  for (const t of types) headSize += Array.isArray(t) ? 32 * t[1].length : 32;
  let offset = headSize;
  types.forEach((t, i) => {
    if (Array.isArray(t)) {
      t[1].forEach((it, j) => heads.push(encodeWord(it, values[i][j])));
    } else if (isDynamic(t)) {
      heads.push(word(offset));
      const tail = encodeTail(t, values[i]);
      tails.push(tail);
      offset += tail.length;
    } else {
      heads.push(encodeWord(t, values[i]));
    }
  });
  return concat(...heads, ...tails);
}

/** Calldata for `signature`, e.g. call('setModule(address,bool)', ['address', 'bool'], [a, true]). */
export const call = (signature, types = [], values = []) => concat(selector(signature), encode(types, values));

/** Decode a single return word. */
export function decodeWord(type, data, index = 0) {
  const w = data.subarray(32 * index, 32 * index + 32);
  if (w.length !== 32) throw new Error('abi: return data too short');
  if (type === 'address') return w.slice(12);
  if (type === 'bool') return bytesToBigint(w) !== 0n;
  return bytesToBigint(w);
}

/** Decode a returned address[] (a single dynamic return value). */
export function decodeAddressArray(data) {
  const offset = Number(bytesToBigint(data.subarray(0, 32)));
  const n = Number(bytesToBigint(data.subarray(offset, offset + 32)));
  return Array.from({ length: n }, (_, i) => data.slice(offset + 32 + 32 * i + 12, offset + 64 + 32 * i));
}

/** Decode a returned dynamic `bytes` (a single return value). */
export function decodeBytes(data) {
  const offset = Number(bytesToBigint(data.subarray(0, 32)));
  const n = Number(bytesToBigint(data.subarray(offset, offset + 32)));
  return data.slice(offset + 32, offset + 32 + n);
}

/** Decode a returned uint256[] (a single dynamic return value). */
export function decodeUintArray(data) {
  const offset = Number(bytesToBigint(data.subarray(0, 32)));
  const n = Number(bytesToBigint(data.subarray(offset, offset + 32)));
  return Array.from({ length: n }, (_, i) => bytesToBigint(data.subarray(offset + 32 + 32 * i, offset + 64 + 32 * i)));
}

/**
 * Decode ABI-encoded values (call arguments after the selector, or return data) of `types`:
 * addresses, uintN, bool, bytes32 (as bytes), bytes, string, T[] of one-word items, and static
 * tuples ['tuple', [types]]. Throws on data that is too short.
 */
export function decodeValues(types, data) {
  const at = (off) => {
    const w = data.subarray(off, off + 32);
    if (w.length !== 32) throw new Error('abi: data too short');
    return w;
  };
  const one = (t, w) => {
    if (t === 'address') return w.slice(12);
    if (t === 'bool') return bytesToBigint(w) !== 0n;
    if (t === 'bytes32') return w.slice();
    if (/^uint\d*$/.test(t)) return bytesToBigint(w);
    throw new Error('abi: unsupported type ' + t);
  };
  const out = [];
  let head = 0;
  for (const t of types) {
    if (Array.isArray(t) && t[0] === 'tuple') {
      out.push(t[1].map((x) => { const v = one(x, at(head)); head += 32; return v; }));
      continue;
    }
    if (!isDynamic(t)) { out.push(one(t, at(head))); head += 32; continue; }
    const off = Number(bytesToBigint(at(head)));
    head += 32;
    const n = Number(bytesToBigint(at(off)));
    if (t === 'bytes' || t === 'string') {
      if (off + 32 + n > data.length) throw new Error('abi: data too short');
      const b = data.slice(off + 32, off + 32 + n);
      out.push(t === 'string' ? new TextDecoder().decode(b) : b);
    } else {
      const item = t.slice(0, -2);
      if (n > 10_000) throw new Error('abi: array too long');
      out.push(Array.from({ length: n }, (_, i) => one(item, at(off + 32 + 32 * i))));
    }
  }
  return out;
}
