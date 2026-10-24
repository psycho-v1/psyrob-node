// Transactions (DAG_SPEC.md section 5): legacy with EIP-155 signatures, and EIP-1559 (type 2).
//
// legacy: rlp([nonce, gasPrice, gasLimit, to, value, data, v, r, s]), digest keccak(rlp([..6 fields, chainId, 0, 0])),
//         v = chainId * 2 + 35 + recovery. Pre-EIP-155 signatures are refused.
// type 2: 0x02 || rlp([chainId, nonce, maxPriorityFee, maxFee, gasLimit, to, value, data, accessList, yParity, r, s]),
//         digest keccak(0x02 || rlp([..first 9 fields])). Access lists must be empty (accepted only as []).
//
// Parsing is strict (canonical RLP, canonical integers, low s). Every parsed transaction carries the fee fields used
// by execution: maxFee and maxPriorityFee (for legacy both are gasPrice).

import * as rlp from '../../common/rlp.js';
import { keccak256, recoverAddress, signDigest } from '../../common/crypto.js';
import { bytesToHex, concat, equals } from '../../common/bytes.js';

const U64 = 8;
const U256 = 32;
const EMPTY = new Uint8Array(0);

function legacyPayload(f, chainId) {
  return rlp.encode([rlp.int(f.nonce), rlp.int(f.gasPrice), rlp.int(f.gasLimit), f.to, rlp.int(f.value), f.data, rlp.int(chainId), EMPTY, EMPTY]);
}
function legacySigned(f, v, r, s) {
  return rlp.encode([rlp.int(f.nonce), rlp.int(f.gasPrice), rlp.int(f.gasLimit), f.to, rlp.int(f.value), f.data, rlp.int(v), rlp.int(r), rlp.int(s)]);
}
function t2Fields(f, chainId) {
  return [rlp.int(chainId), rlp.int(f.nonce), rlp.int(f.maxPriorityFee), rlp.int(f.maxFee), rlp.int(f.gasLimit), f.to, rlp.int(f.value), f.data, []];
}
const t2Payload = (f, chainId) => concat(Uint8Array.of(2), rlp.encode(t2Fields(f, chainId)));
const t2Signed = (f, chainId, y, r, s) => concat(Uint8Array.of(2), rlp.encode([...t2Fields(f, chainId), rlp.int(y), rlp.int(r), rlp.int(s)]));

function checkTo(to) {
  if (to.length !== 20 && to.length !== 0) throw new Error('tx: `to` must be 20 bytes, or empty for contract creation');
}

/** Parse and validate a raw transaction for chain `params.chainId`. Throws on any deviation. */
export function parseTx(raw, params) {
  if (!(raw instanceof Uint8Array) || raw.length === 0) throw new Error('tx: empty');
  if (raw.length > params.maxTxBytes) throw new Error('tx: too large');
  if (raw[0] === 2) return parseType2(raw, params);
  if (raw[0] < 0xc0) throw new Error('tx: unsupported transaction type ' + raw[0]);
  const l = rlp.expectList(rlp.decode(raw), 'tx', 9);
  for (let i = 0; i < 9; i++) rlp.expectBytes(l[i], 'tx field ' + i);
  const f = {
    nonce: rlp.decodeInt(l[0], U64), gasPrice: rlp.decodeInt(l[1], U256), gasLimit: rlp.decodeInt(l[2], U64),
    to: l[3], value: rlp.decodeInt(l[4], U256), data: l[5],
  };
  checkTo(f.to);
  const v = rlp.decodeInt(l[6], U64), r = rlp.decodeInt(l[7], U256), s = rlp.decodeInt(l[8], U256);
  const base = params.chainId * 2n + 35n;
  if (v !== base && v !== base + 1n) throw new Error('tx: v must be EIP-155 for chain ' + params.chainId);
  if (!equals(legacySigned(f, v, r, s), raw)) throw new Error('tx: non-canonical encoding');
  const from = recoverAddress(keccak256(legacyPayload(f, params.chainId)), r, s, Number(v - base));
  return Object.freeze({ type: 0, ...f, maxFee: f.gasPrice, maxPriorityFee: f.gasPrice, v, r, s, from, hash: keccak256(raw), raw: raw.slice() });
}

function parseType2(raw, params) {
  const l = rlp.expectList(rlp.decode(raw.subarray(1)), 'tx', 12);
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11]) rlp.expectBytes(l[i], 'tx field ' + i);
  rlp.expectList(l[8], 'accessList');
  if (l[8].length !== 0) throw new Error('tx: access lists are not supported');
  const chainId = rlp.decodeInt(l[0], U64);
  if (chainId !== params.chainId) throw new Error('tx: wrong chain id ' + chainId);
  const f = {
    nonce: rlp.decodeInt(l[1], U64), maxPriorityFee: rlp.decodeInt(l[2], U256), maxFee: rlp.decodeInt(l[3], U256),
    gasLimit: rlp.decodeInt(l[4], U64), to: l[5], value: rlp.decodeInt(l[6], U256), data: l[7],
  };
  checkTo(f.to);
  if (f.maxPriorityFee > f.maxFee) throw new Error('tx: max priority fee above max fee');
  const y = rlp.decodeInt(l[9], 1), r = rlp.decodeInt(l[10], U256), s = rlp.decodeInt(l[11], U256);
  if (y > 1n) throw new Error('tx: bad y parity');
  if (!equals(t2Signed(f, chainId, y, r, s), raw)) throw new Error('tx: non-canonical encoding');
  const from = recoverAddress(keccak256(t2Payload(f, chainId)), r, s, Number(y));
  return Object.freeze({ type: 2, ...f, gasPrice: f.maxFee, v: y, r, s, from, hash: keccak256(raw), raw: raw.slice() });
}

/** Price per gas the sender pays at `baseFee`: legacy gasPrice; type 2 min(maxFee, baseFee + maxPriorityFee). */
export const effectiveGasPrice = (tx, baseFee) => (tx.type === 2 ? (tx.maxFee < baseFee + tx.maxPriorityFee ? tx.maxFee : baseFee + tx.maxPriorityFee) : tx.gasPrice);

/** Build and sign. `fields.type` 2 gives an EIP-1559 transaction. Returns the parsed transaction. */
export function signTx(fields, sk, params) {
  const f = {
    nonce: BigInt(fields.nonce ?? 0), gasLimit: BigInt(fields.gasLimit ?? 21000), to: fields.to ?? EMPTY,
    value: BigInt(fields.value ?? 0), data: fields.data ?? EMPTY,
  };
  if (fields.type === 2) {
    f.maxFee = BigInt(fields.maxFee ?? params.minBaseFee * 2n);
    f.maxPriorityFee = BigInt(fields.maxPriorityFee ?? 0);
    const { r, s, recovery } = signDigest(keccak256(t2Payload(f, params.chainId)), sk);
    return parseTx(t2Signed(f, params.chainId, BigInt(recovery), r, s), params);
  }
  f.gasPrice = BigInt(fields.gasPrice ?? params.minBaseFee);
  const { r, s, recovery } = signDigest(keccak256(legacyPayload(f, params.chainId)), sk);
  return parseTx(legacySigned(f, params.chainId * 2n + 35n + BigInt(recovery), r, s), params);
}

export const txHex = (tx) => '0x' + bytesToHex(tx.hash);
