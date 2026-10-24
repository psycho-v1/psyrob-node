// Strict, canonical RLP. The decoder rejects every non-canonical form, so for any
// accepted input `encode(decode(x))` is byte-identical to `x`. That property is what
// makes transaction and block hashes unambiguous (no malleability through encoding).

import { bigintToBytes, bytesToBigint, concat } from './bytes.js';

const MAX_DEPTH = 16;

function encodeLength(len, offset) {
  if (len < 56) return Uint8Array.of(offset + len);
  const lenBytes = bigintToBytes(BigInt(len));
  return concat(Uint8Array.of(offset + 55 + lenBytes.length), lenBytes);
}

/** Encode a Uint8Array or a (nested) array of them. Integers must be converted by the caller via `int()`. */
export function encode(input) {
  if (input instanceof Uint8Array) {
    if (input.length === 1 && input[0] < 0x80) return input.slice();
    return concat(encodeLength(input.length, 0x80), input);
  }
  if (Array.isArray(input)) {
    const body = concat(...input.map(encode));
    return concat(encodeLength(body.length, 0xc0), body);
  }
  throw new TypeError('rlp.encode: expected Uint8Array or Array');
}

/** Canonical RLP integer encoding (minimal big-endian, zero = empty string). */
export const int = (n) => bigintToBytes(BigInt(n));

function readLength(buf, pos, lenOfLen, end) {
  if (lenOfLen > 4) throw new Error('rlp: length too large');
  if (pos + lenOfLen > end) throw new Error('rlp: truncated length');
  if (buf[pos] === 0) throw new Error('rlp: non-canonical length (leading zero)');
  let len = 0;
  for (let i = 0; i < lenOfLen; i++) len = len * 256 + buf[pos + i];
  if (len < 56) throw new Error('rlp: non-canonical length (long form for short item)');
  return len;
}

function decodeItem(buf, pos, end, depth) {
  if (depth > MAX_DEPTH) throw new Error('rlp: nesting too deep');
  if (pos >= end) throw new Error('rlp: unexpected end');
  const b = buf[pos];
  if (b < 0x80) return { item: buf.slice(pos, pos + 1), next: pos + 1 };
  if (b <= 0xb7) {
    const len = b - 0x80;
    const start = pos + 1;
    if (start + len > end) throw new Error('rlp: truncated string');
    if (len === 1 && buf[start] < 0x80) throw new Error('rlp: non-canonical single byte');
    return { item: buf.slice(start, start + len), next: start + len };
  }
  if (b <= 0xbf) {
    const lenOfLen = b - 0xb7;
    const len = readLength(buf, pos + 1, lenOfLen, end);
    const start = pos + 1 + lenOfLen;
    if (start + len > end) throw new Error('rlp: truncated string');
    return { item: buf.slice(start, start + len), next: start + len };
  }
  let len, start;
  if (b <= 0xf7) {
    len = b - 0xc0;
    start = pos + 1;
  } else {
    const lenOfLen = b - 0xf7;
    len = readLength(buf, pos + 1, lenOfLen, end);
    start = pos + 1 + lenOfLen;
  }
  const listEnd = start + len;
  if (listEnd > end) throw new Error('rlp: truncated list');
  const items = [];
  let p = start;
  while (p < listEnd) {
    const r = decodeItem(buf, p, listEnd, depth + 1);
    items.push(r.item);
    p = r.next;
  }
  return { item: items, next: listEnd };
}

/** Decode exactly one RLP item; trailing bytes are an error. */
export function decode(buf) {
  if (!(buf instanceof Uint8Array)) throw new TypeError('rlp.decode: expected Uint8Array');
  const { item, next } = decodeItem(buf, 0, buf.length, 0);
  if (next !== buf.length) throw new Error('rlp: trailing bytes');
  return item;
}

/** Decode a canonical RLP integer: no leading zeros, at most `maxBytes` bytes. */
export function decodeInt(b, maxBytes = 32) {
  if (!(b instanceof Uint8Array)) throw new Error('rlp: integer must be a string, not a list');
  if (b.length > maxBytes) throw new Error('rlp: integer too large');
  if (b.length > 0 && b[0] === 0) throw new Error('rlp: non-canonical integer (leading zero)');
  return bytesToBigint(b);
}

export function expectBytes(x, what = 'item') {
  if (!(x instanceof Uint8Array)) throw new Error(`rlp: ${what} must be a string`);
  return x;
}

export function expectList(x, what = 'item', length) {
  if (!Array.isArray(x)) throw new Error(`rlp: ${what} must be a list`);
  if (length !== undefined && x.length !== length) throw new Error(`rlp: ${what} must have ${length} items`);
  return x;
}
