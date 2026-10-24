// Domain-separated binary Merkle tree.
//
//   leaf  = keccak(0x00 || data)
//   node  = keccak(0x01 || left || right)
//   odd node at a level is promoted unchanged (never duplicated)
//   root  = keccak(0x02 || u64be(leafCount) || treeRoot)    (treeRoot = 32 zero bytes when empty)
//
// Separate leaf/node prefixes stop a 64-byte leaf from posing as an inner node, and
// promotion instead of duplication plus the committed leaf count removes the
// "duplicate last element gives the same root" ambiguity (cf. CVE-2012-2459).

import { keccak256 } from './crypto.js';
import { concat } from './bytes.js';

const LEAF = Uint8Array.of(0);
const NODE = Uint8Array.of(1);
const ROOT = Uint8Array.of(2);

export const leafHash = (data) => keccak256(concat(LEAF, data));

export function merkleRootFromLeafHashes(hashes) {
  let level = hashes;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? keccak256(concat(NODE, level[i], level[i + 1])) : level[i]);
    }
    level = next;
  }
  const tree = level.length ? level[0] : new Uint8Array(32);
  const count = new Uint8Array(8);
  new DataView(count.buffer).setBigUint64(0, BigInt(hashes.length));
  return keccak256(concat(ROOT, count, tree));
}

export const merkleRoot = (items) => merkleRootFromLeafHashes(items.map(leafHash));
