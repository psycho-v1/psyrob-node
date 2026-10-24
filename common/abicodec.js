// Full Solidity ABI encoding and decoding from the contracts' JSON ABI (genesis/artifacts.json): uintN, intN, address,
// bool, bytesN, bytes, string, T[], T[k] and tuples, nested. Used by the explorer, the pages (a copy is served to the
// browser) and the wallet. Selectors come from a keccak function passed in, so the browser copy needs no hashing.

const enc = new TextEncoder(), dec = new TextDecoder();

function hexToU8(h) { h = h.replace(/^0x/, ''); const o = new Uint8Array(h.length / 2); for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16); return o; }
function u8ToHex(b) { let s = '0x'; for (const x of b) s += x.toString(16).padStart(2, '0'); return s; }
function word(n) { if (n < 0n) n = (1n << 256n) + n; return hexToU8(n.toString(16).padStart(64, '0')); }
function cat(parts) { const n = parts.reduce((a, p) => a + p.length, 0); const o = new Uint8Array(n); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; }
const big = (b) => (b.length ? BigInt(u8ToHex(b)) : 0n);

/** Canonical type string of an ABI parameter (tuples expanded): used for signatures. */
export function typeString(p) {
  if (p.type.startsWith('tuple')) return '(' + p.components.map(typeString).join(',') + ')' + p.type.slice(5);
  return p.type;
}

export const signatureOf = (f) => `${f.name}(${f.inputs.map(typeString).join(',')})`;

function parse(p) {
  const m = /^(.*)\[(\d*)\]$/.exec(p.type);
  if (m) return { kind: 'array', len: m[2] === '' ? null : Number(m[2]), item: parse({ ...p, type: m[1] }) };
  if (p.type === 'tuple') return { kind: 'tuple', comps: p.components.map(parse), names: p.components.map((c) => c.name) };
  return { kind: 'atom', type: p.type };
}

function isDyn(t) {
  if (t.kind === 'atom') return t.type === 'string' || t.type === 'bytes';
  if (t.kind === 'array') return t.len === null || isDyn(t.item);
  return t.comps.some(isDyn);
}

function encAtom(type, v) {
  if (type === 'address') { const b = typeof v === 'string' ? hexToU8(v) : v; if (b.length !== 20) throw new Error('abi: bad address'); return cat([new Uint8Array(12), b]); }
  if (type === 'bool') return word(v ? 1n : 0n);
  if (/^u?int\d*$/.test(type)) return word(BigInt(v));
  if (/^bytes\d+$/.test(type)) { const b = typeof v === 'string' ? hexToU8(v) : v; const o = new Uint8Array(32); o.set(b.slice(0, 32)); return o; }
  throw new Error('abi: unsupported static type ' + type);
}

function encodeOne(t, v) {
  if (t.kind === 'atom') {
    if (t.type === 'string' || t.type === 'bytes') {
      const b = t.type === 'string' ? enc.encode(v) : typeof v === 'string' ? hexToU8(v) : v;
      const pad = new Uint8Array(Math.ceil(b.length / 32) * 32); pad.set(b);
      return cat([word(BigInt(b.length)), pad]);
    }
    return encAtom(t.type, v);
  }
  if (t.kind === 'array') {
    const items = encodeSeq(v.map(() => t.item), v);
    return t.len === null ? cat([word(BigInt(v.length)), items]) : items;
  }
  const vals = Array.isArray(v) ? v : t.names.map((n) => v[n]);
  return encodeSeq(t.comps, vals);
}

function encodeSeq(types, vals) {
  if (types.length !== vals.length) throw new Error('abi: wrong number of values');
  const heads = [], tails = [];
  let headLen = 0;
  for (const t of types) headLen += isDyn(t) ? 32 : staticSize(t);
  let off = headLen;
  types.forEach((t, i) => {
    const e = encodeOne(t, vals[i]);
    if (isDyn(t)) { heads.push(word(BigInt(off))); tails.push(e); off += e.length; } else heads.push(e);
  });
  return cat([...heads, ...tails]);
}

function staticSize(t) {
  if (t.kind === 'atom') return 32;
  if (t.kind === 'array') return t.len * staticSize(t.item);
  return t.comps.reduce((a, c) => a + staticSize(c), 0);
}

function decodeOne(t, data, pos) {
  if (t.kind === 'atom') {
    const w = data.subarray(pos, pos + 32);
    if (w.length < 32) throw new Error('abi: data too short');
    if (t.type === 'string' || t.type === 'bytes') {
      const off = Number(big(w)), len = Number(big(data.subarray(off, off + 32)));
      const b = data.slice(off + 32, off + 32 + len);
      return t.type === 'string' ? dec.decode(b) : u8ToHex(b);
    }
    if (t.type === 'address') return u8ToHex(w.slice(12));
    if (t.type === 'bool') return big(w) !== 0n;
    if (/^uint\d*$/.test(t.type)) return big(w);
    if (/^int\d*$/.test(t.type)) { const n = big(w); return n >> 255n ? n - (1n << 256n) : n; }
    if (/^bytes\d+$/.test(t.type)) return u8ToHex(w.slice(0, Number(t.type.slice(5))));
    throw new Error('abi: unsupported type ' + t.type);
  }
  return null;
}

function decodeAt(t, data, base, headPos) {
  // returns the value of type t whose head is at headPos, relative offsets from `base`
  if (isDyn(t) && !(t.kind === 'atom')) {
    const off = base + Number(big(data.subarray(headPos, headPos + 32)));
    return decodeBody(t, data, off);
  }
  if (t.kind === 'atom') {
    if (t.type === 'string' || t.type === 'bytes') {
      const off = base + Number(big(data.subarray(headPos, headPos + 32)));
      const len = Number(big(data.subarray(off, off + 32)));
      const b = data.slice(off + 32, off + 32 + len);
      return t.type === 'string' ? dec.decode(b) : u8ToHex(b);
    }
    return decodeOne(t, data, headPos);
  }
  return decodeBody(t, data, headPos);
}

function decodeBody(t, data, pos) {
  if (t.kind === 'array') {
    let n = t.len, start = pos;
    if (n === null) { n = Number(big(data.subarray(pos, pos + 32))); start = pos + 32; }
    const out = [];
    const step = isDyn(t.item) ? 32 : staticSize(t.item);
    for (let i = 0; i < n; i++) out.push(decodeAt(t.item, data, start, start + i * step));
    return out;
  }
  const out = {};
  let h = pos;
  t.comps.forEach((c, i) => { out[t.names[i] || i] = decodeAt(c, data, pos, h); h += isDyn(c) ? 32 : staticSize(c); });
  return out;
}

/** Encode values for ABI params (array of {type, components}). */
export function encodeParams(params, values) { return encodeSeq(params.map(parse), values); }

/** Decode return data for ABI params; returns an array (tuples as objects keyed by component name). */
export function decodeParams(params, data) {
  const types = params.map(parse);
  const out = [];
  let h = 0;
  for (const t of types) { out.push(decodeAt(t, data, 0, h)); h += isDyn(t) ? 32 : staticSize(t); }
  return out;
}

/** A contract helper from its JSON ABI: c.encode(name, args) -> calldata; c.decode(name, data) -> outputs. */
export function contract(abiJson, keccak) {
  const fns = new Map();
  for (const f of abiJson.filter((x) => x.type === 'function')) {
    const sig = signatureOf(f);
    const sel = keccak(enc.encode(sig)).slice(0, 4);
    if (!fns.has(f.name)) fns.set(f.name, []);
    fns.get(f.name).push({ f, sig, sel });
  }
  const pick = (name, n) => {
    const list = fns.get(name);
    if (!list) throw new Error('abi: no function ' + name);
    return (n === undefined ? list[0] : list.find((x) => x.f.inputs.length === n)) ?? list[0];
  };
  return {
    functions: fns,
    encode(name, args = []) { const x = pick(name, args.length); return cat([x.sel, encodeParams(x.f.inputs, args)]); },
    decode(name, data, n) { const x = pick(name, n); const o = decodeParams(x.f.outputs, data); return x.f.outputs.length === 1 ? o[0] : o; },
    selector(name, n) { return u8ToHex(pick(name, n).sel); },
  };
}

export { hexToU8, u8ToHex };
