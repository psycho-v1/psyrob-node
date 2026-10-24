// A mining job: the node's template (JSON from psy_getBlockTemplate) turned back into a header object, and one attempt:
// set the nonce, sign with the miner key, hash the full header with Argon2d (common/header.js, common/pow.js).

import { encodeHeader, signHeader } from '../../common/header.js';
import { fromHex } from '../../common/bytes.js';
import { powValue } from '../../common/pow.js';

export function headerFromTemplate(t) {
  const h = t.header;
  return {
    version: h.version, parents: h.parents.map(fromHex), timestamp: h.timestamp, target: BigInt(h.target), blueScore: BigInt(h.blueScore),
    blueWork: BigInt(h.blueWork), stateRoot: fromHex(h.stateRoot), txRoot: fromHex(h.txRoot), receiptsRoot: fromHex(h.receiptsRoot),
    acceptedTxRoot: fromHex(h.acceptedTxRoot), gasLimit: BigInt(h.gasLimit), gasUsed: BigInt(h.gasUsed), baseFee: BigInt(h.baseFee),
    miner: fromHex(h.miner), extra: fromHex(h.extra), nonce: 0n, minerSig: new Uint8Array(65),
  };
}

/** One attempt. Returns { ok, value } where value is the Argon2d result as a number. */
export function attempt(header, nonce, sk, pow, impl) {
  header.nonce = nonce;
  signHeader(header, sk);
  const v = powValue(encodeHeader(header), pow, impl);
  return { ok: v <= header.target, value: v };
}
