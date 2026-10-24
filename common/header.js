// PSYROB block header (DAG_SPEC.md section 3). Shared by the node and the miner.
//
// header = rlp([ version, parents, timestamp, target, blueScore, blueWork, stateRoot, txRoot, receiptsRoot,
//                acceptedTxRoot, gasLimit, gasUsed, baseFee, miner, extra, nonce, minerSig ])
//
// signing bytes = rlp of the same list with minerSig = empty string (the nonce is included)
// minerSig      = secp256k1 signature by `miner` over keccak256("PSYROB-miner-signature" ‖ signing bytes)
// powHash       = Argon2d(full header rlp, signature included, salt "PSYROB-PoW")       (pow.js)
// block hash    = keccak256(full header rlp)
//
// Because the proof of work covers the signature and the signature covers the nonce, every attempt needs a fresh
// signature by the miner wallet: work cannot be handed out to others without giving them the reward key.

import * as rlp from './rlp.js';
import { keccak256, recoverAddress, signDigest } from './crypto.js';
import { bytesToBigint, bigintToFixed, compare, concat, equals, utf8, bytesToHex } from './bytes.js';

export const HEADER_VERSION = 1;
export const MAX_PARENTS = 10;
const SIG_DOMAIN = utf8('PSYROB-miner-signature');
const EMPTY = new Uint8Array(0);

const FIELDS = ['version', 'parents', 'timestamp', 'target', 'blueScore', 'blueWork', 'stateRoot', 'txRoot', 'receiptsRoot',
  'acceptedTxRoot', 'gasLimit', 'gasUsed', 'baseFee', 'miner', 'extra', 'nonce', 'minerSig'];
const H32 = new Set(['stateRoot', 'txRoot', 'receiptsRoot', 'acceptedTxRoot']);

function encodeList(h, withSig) {
  return [
    rlp.int(h.version), h.parents.map((p) => p), rlp.int(h.timestamp), bigintToFixed(h.target, 32),
    rlp.int(h.blueScore), rlp.int(h.blueWork), h.stateRoot, h.txRoot, h.receiptsRoot, h.acceptedTxRoot,
    rlp.int(h.gasLimit), rlp.int(h.gasUsed), rlp.int(h.baseFee), h.miner, h.extra, bigintToFixed(h.nonce, 8),
    withSig ? h.minerSig : EMPTY,
  ];
}

/** RLP of the header without the miner signature: what the miner signs. */
export const signingBytes = (h) => rlp.encode(encodeList(h, false));
export const encodeHeader = (h) => rlp.encode(encodeList(h, true));
export const headerHash = (h) => keccak256(encodeHeader(h));
export const minerSigDigest = (signing) => keccak256(concat(SIG_DOMAIN, signing));

/** Sign the header in place with the miner key; returns the 65-byte signature (r ‖ s ‖ recovery). */
export function signHeader(h, sk, signing = signingBytes(h)) {
  const { r, s, recovery } = signDigest(minerSigDigest(signing), sk);
  h.minerSig = concat(bigintToFixed(r, 32), bigintToFixed(s, 32), Uint8Array.of(recovery));
  return h.minerSig;
}

/** Address recovered from the miner signature, or null if malformed. */
export function minerSigner(h, signing = signingBytes(h)) {
  if (h.minerSig.length !== 65 || h.minerSig[64] > 1) return null;
  try {
    return recoverAddress(minerSigDigest(signing), bytesToBigint(h.minerSig.subarray(0, 32)), bytesToBigint(h.minerSig.subarray(32, 64)), h.minerSig[64]);
  } catch { return null; }
}

/** Strict decode; throws on any malformed field. */
export function decodeHeader(raw) {
  const l = rlp.expectList(rlp.decode(raw), 'header', FIELDS.length);
  const int = (i, max = 32) => rlp.decodeInt(rlp.expectBytes(l[i], FIELDS[i]), max);
  const h = {
    version: Number(int(0, 1)),
    parents: rlp.expectList(l[1], 'parents').map((p) => { rlp.expectBytes(p, 'parent'); if (p.length !== 32) throw new Error('header: parent must be 32 bytes'); return p; }),
    timestamp: Number(int(2, 6)),
    target: bytesToBigint(fixed(l[3], 32, 'target')),
    blueScore: int(4, 8),
    blueWork: int(5, 32),
    stateRoot: fixed(l[6], 32, 'stateRoot'), txRoot: fixed(l[7], 32, 'txRoot'),
    receiptsRoot: fixed(l[8], 32, 'receiptsRoot'), acceptedTxRoot: fixed(l[9], 32, 'acceptedTxRoot'),
    gasLimit: int(10, 8), gasUsed: int(11, 8), baseFee: int(12, 32),
    miner: fixed(l[13], 20, 'miner'),
    extra: rlp.expectBytes(l[14], 'extra'),
    nonce: bytesToBigint(fixed(l[15], 8, 'nonce')),
    minerSig: rlp.expectBytes(l[16], 'minerSig'),
  };
  if (h.version !== HEADER_VERSION) throw new Error('header: version must be ' + HEADER_VERSION);
  if (h.parents.length < 1 || h.parents.length > MAX_PARENTS) throw new Error('header: 1 to 10 parents');
  for (let i = 1; i < h.parents.length; i++) if (compare(h.parents[i - 1], h.parents[i]) >= 0) throw new Error('header: parents must be sorted and distinct');
  if (h.extra.length > 32) throw new Error('header: extra longer than 32 bytes');
  if (h.minerSig.length !== 65) throw new Error('header: miner signature must be 65 bytes');
  if (!equals(encodeHeader(h), raw)) throw new Error('header: non-canonical encoding');
  return h;
}

function fixed(x, n, what) {
  rlp.expectBytes(x, what);
  if (x.length !== n) throw new Error(`header: ${what} must be ${n} bytes`);
  return x;
}

/** Genesis header: no parents; encoded with the same codec but a zero parent list is allowed only here. */
export function encodeGenesisHeader(h) { return rlp.encode(encodeList({ ...h, parents: [] }, true)); }
export function genesisHash(h) { return keccak256(encodeGenesisHeader(h)); }

export const sortParents = (ps) => [...ps].sort(compare);
export const hex = bytesToHex;
export { FIELDS as HEADER_FIELDS, H32 };
