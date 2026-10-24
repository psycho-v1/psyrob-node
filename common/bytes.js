// Byte, hex and integer helpers. Every parser here is strict: malformed input throws.

export const EMPTY = new Uint8Array(0);

const HEX_RE = /^[0-9a-fA-F]*$/;

export function bytesToHex(b) {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/** Hex string (no 0x) -> bytes. Requires even length and hex digits only. */
export function hexToBytes(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !HEX_RE.test(hex)) {
    throw new Error('invalid hex');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** '0x'-prefixed hex -> bytes. */
export function fromHex(s) {
  if (typeof s !== 'string' || !s.startsWith('0x')) throw new Error('hex must start with 0x');
  return hexToBytes(s.slice(2));
}

export const toHex = (b) => '0x' + bytesToHex(b);

export function concat(...parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function equals(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function compare(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

/** Big-endian bytes -> bigint (empty -> 0n). */
export function bytesToBigint(b) {
  let n = 0n;
  for (let i = 0; i < b.length; i++) n = (n << 8n) | BigInt(b[i]);
  return n;
}

/** bigint -> minimal big-endian bytes (0n -> empty), as RLP integers require. */
export function bigintToBytes(n) {
  if (typeof n !== 'bigint' || n < 0n) throw new Error('expected non-negative bigint');
  if (n === 0n) return EMPTY;
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return hexToBytes(hex);
}

/** bigint -> fixed-width big-endian bytes. Throws if it does not fit. */
export function bigintToFixed(n, width) {
  if (typeof n !== 'bigint' || n < 0n) throw new Error('expected non-negative bigint');
  if (n >> BigInt(width * 8) !== 0n) throw new Error(`integer does not fit in ${width} bytes`);
  return hexToBytes(n.toString(16).padStart(width * 2, '0'));
}

/** 0x-quantity (Ethereum JSON-RPC style, no leading zeros) -> bigint. */
const QUANTITY_RE = /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/;
export function parseQuantity(s, maxBits = 256) {
  if (typeof s !== 'string' || !QUANTITY_RE.test(s)) throw new Error('invalid quantity');
  const n = BigInt(s);
  if (n >> BigInt(maxBits) !== 0n) throw new Error('quantity too large');
  return n;
}

export const toQuantity = (n) => '0x' + BigInt(n).toString(16);

export function utf8(s) { return new TextEncoder().encode(s); }
