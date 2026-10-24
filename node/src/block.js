// Block encoding: rlp([headerRlp, [txRaw...], [cert...]]); the header field txRoot commits to the body:
//   txRoot = keccak256(rlp([[txRaw...], [cert...]]))
// cert = [checkpointNumber, chainBlockHash, stateRoot, epoch, [sig65...]]  (finality certificate, DAG_SPEC.md section 9)

import * as rlp from '../../common/rlp.js';
import { keccak256 } from '../../common/crypto.js';
import { decodeHeader, encodeHeader } from '../../common/header.js';

export const bodyRoot = (txRaws, certs) => keccak256(rlp.encode([txRaws, certs.map(encodeCert)]));

export function encodeCert(c) {
  return [rlp.int(c.number), c.chainBlock, c.stateRoot, rlp.int(c.epoch), c.sigs];
}

export function decodeCert(x) {
  const l = rlp.expectList(x, 'cert', 5);
  const list = rlp.expectList(l[4], 'cert sigs');
  if (list.length > 21) throw new Error('cert: at most 21 signatures (the committee size)');
  const sigs = list.map((s) => { rlp.expectBytes(s, 'sig'); if (s.length !== 65) throw new Error('cert: signature must be 65 bytes'); return s; });
  const h = rlp.expectBytes(l[1], 'cert block'), r = rlp.expectBytes(l[2], 'cert root');
  if (h.length !== 32 || r.length !== 32) throw new Error('cert: hash and root must be 32 bytes');
  return { number: Number(rlp.decodeInt(l[0], 6)), chainBlock: h, stateRoot: r, epoch: Number(rlp.decodeInt(l[3], 6)), sigs };
}

export function encodeBlock(header, txRaws, certs = []) {
  return rlp.encode([encodeHeader(header), txRaws, certs.map(encodeCert)]);
}

/** Decode a raw block: { headerRaw, header, txRaws, certs, hash }. Throws on malformed input. */
export function decodeBlock(raw) {
  const l = rlp.expectList(rlp.decode(raw), 'block', 3);
  const headerRaw = rlp.expectBytes(l[0], 'header');
  const header = decodeHeader(headerRaw);
  const txRaws = rlp.expectList(l[1], 'txs').map((t) => rlp.expectBytes(t, 'tx'));
  const certs = rlp.expectList(l[2], 'certs').map(decodeCert);
  return { headerRaw, header, txRaws, certs, hash: keccak256(headerRaw) };
}
