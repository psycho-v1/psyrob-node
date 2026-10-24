// Block templates for miners (DAG_SPEC.md section 6). A template is everything of the header except the nonce and the
// miner signature; the miner application searches nonces, signs each attempt with the miner wallet, and submits.

import { bytesToHex, fromHex, utf8 } from '../../common/bytes.js';
import { signingBytes, HEADER_VERSION } from '../../common/header.js';
import { keccak256 } from '../../common/crypto.js';
import { nextBaseFee } from './consensus.js';
import { bodyRoot, encodeBlock } from './block.js';
import { requiredVersion, OWN_VERSION } from './rules.js';
import { versionText } from './params.js';

/**
 * Build a template for `miner` (20 bytes) on the current virtual. Returns { header, txRaws, certs, id }.
 * The state roots are computed by accepting the virtual's mergeset exactly as validation will.
 */
export function buildTemplate(chain, mempool, miner, { certs = [], extra = 'psyrob-node 8.0' } = {}) {
  return chain.exclusive(async () => {
    const p = chain.p;
    const parents = chain.dag.templateParents().sort();
    const gd = chain.dag.ghostdag(parents);
    const sp = chain.dag.get(gd.selectedParent);
    const baseFee = nextBaseFee(sp.baseFee, sp.gasUsed, p);
    const timestamp = Math.max(chain.now(), chain.pastMedianTime(sp) + 1);
    chain.moveTo(sp.hash);
    const need = requiredVersion(chain.state);
    if (need > OWN_VERSION) throw new Error(`upgrade required: this network now needs node ${versionText(need)} or newer`);
    const header = {
      version: HEADER_VERSION, parents: parents.map((h) => fromHex('0x' + h)), timestamp, target: chain.expectedTarget(sp), blueScore: BigInt(gd.blueScore),
      blueWork: gd.blueWork, gasLimit: p.blockGasLimit, baseFee, miner, extra: utf8(extra).slice(0, 32), nonce: 0n, minerSig: new Uint8Array(65),
    };
    const pending = { header, txs: [], certs, hash: null };
    const res = await chain.acceptMergeset(pending, gd, sp, baseFee);
    header.stateRoot = chain.state.rootWith(res.view);
    header.receiptsRoot = res.receiptsRoot;
    header.acceptedTxRoot = res.acceptedTxRoot;
    header.gasUsed = res.gasUsed;
    // the block's own transactions run later (when a chain block accepts it); select them against the state after
    // this block's mergeset, so their nonces follow on
    const txs = mempool.select(res.view, baseFee, p.blockGasLimit, timestamp);
    const txRaws = txs.map((t) => t.raw);
    header.txRoot = bodyRoot(txRaws, certs);
    chain.moveTo(chain.tip.hash);
    // the id names the exact header: a hash of all signing bytes (miner, parents, roots, timestamp, ...). The first
    // 8 bytes alone, as before, were only RLP prefixes and a sliver of the first parent, so two miners' templates in
    // the same second shared an id, the later one replaced the earlier, and the earlier miner's solution was refused
    //
    return { header, txRaws, certs, id: bytesToHex(keccak256(signingBytes(header))).slice(0, 32) };
  });
}

/** JSON form for the miner (all binary fields as 0x hex). */
export function templateJson(t, params) {
  const h = t.header;
  return {
    id: t.id,
    signingBytes: '0x' + bytesToHex(signingBytes(h)),
    target: '0x' + h.target.toString(16),
    pow: { memoryKiB: params.pow.memoryKiB, iterations: params.pow.iterations },
    header: {
      version: h.version, parents: h.parents.map((x) => '0x' + bytesToHex(x)), timestamp: h.timestamp, target: '0x' + h.target.toString(16),
      blueScore: h.blueScore.toString(), blueWork: '0x' + h.blueWork.toString(16), stateRoot: '0x' + bytesToHex(h.stateRoot), txRoot: '0x' + bytesToHex(h.txRoot),
      receiptsRoot: '0x' + bytesToHex(h.receiptsRoot), acceptedTxRoot: '0x' + bytesToHex(h.acceptedTxRoot), gasLimit: h.gasLimit.toString(),
      gasUsed: h.gasUsed.toString(), baseFee: h.baseFee.toString(), miner: '0x' + bytesToHex(h.miner), extra: '0x' + bytesToHex(h.extra),
    },
    txCount: t.txRaws.length,
  };
}

/** Assemble a solved template into a raw block. */
export function solvedBlock(t, nonce, minerSig) {
  return encodeBlock({ ...t.header, nonce, minerSig }, t.txRaws, t.certs);
}
