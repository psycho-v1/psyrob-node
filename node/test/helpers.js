// Test helpers: a small devnet chain (chain 1337, 8 KiB Argon2d, easy target) and a miner that solves templates.

import { buildGenesis } from '../src/genesis.js';
import { Chain } from '../src/consensus.js';
import { Mempool } from '../src/mempool.js';
import { buildTemplate, solvedBlock } from '../src/template.js';
import { signHeader, signingBytes, encodeHeader, HEADER_VERSION } from '../../common/header.js';
import { checkPow } from '../../common/pow.js';
import { privateKeyToAddress } from '../../common/crypto.js';
import { bytesToHex, fromHex } from '../../common/bytes.js';
import { bodyRoot, encodeBlock } from '../src/block.js';
import { nextBaseFee } from '../src/consensus.js';

export const TEST_PARAMS = { chainId: 1337n, pow: { memoryKiB: 8, iterations: 1 }, targetSpacing: 10, k: 18 };
export const EASY_TARGET = (1n << 256n) / 4n;

export function key(n) {
  const sk = new Uint8Array(32);
  sk[31] = n;
  sk[0] = 0x11;
  return { sk, addr: privateKeyToAddress(sk) };
}

export async function testChain({ params = {}, start = 1_800_000_000, target = EASY_TARGET, config = {}, cold = null } = {}) {
  let clock = start;
  const g = await buildGenesis({ chainId: 1337, timestamp: start, target: '0x' + target.toString(16), devBeneficiary: '0x' + '22'.repeat(20), ...config }, { ...TEST_PARAMS, ...params });
  const events = [];
  const chain = new Chain(g.params, g, { now: () => clock, cold, onEvent: (t, d) => events.push([t, d]) });
  const mempool = new Mempool(g.params);
  return {
    chain, mempool, params: g.params, genesis: g, events,
    setTime: (t) => { clock = t; }, advance: (dt) => { clock += dt; return clock; }, now: () => clock,
  };
}

/** Solve a header in place (nonce search + miner signature). */
export function solve(header, sk, params) {
  for (let nonce = 0n; ; nonce++) {
    header.nonce = nonce;
    signHeader(header, sk);
    if (checkPow(encodeHeader(header), header.target, params.pow)) return header;
  }
}

/** Mine one block on the current virtual with `miner` and add it. Returns the add result. */
export async function mineOne(t, miner, opts = {}) {
  const tpl = await buildTemplate(t.chain, t.mempool, miner.addr, opts);
  solve(tpl.header, miner.sk, t.params);
  const raw = solvedBlock(tpl, tpl.header.nonce, tpl.header.minerSig);
  return t.chain.addBlock(raw);
}

/** Build (without adding) a block on explicit parents: used to create parallel blocks. */
export async function blockOn(t, parentsHex, miner, { txRaws = [], timestamp } = {}) {
  const chain = t.chain;
  return chain.exclusive(async () => {
    const parents = [...parentsHex].sort();
    const gd = chain.dag.ghostdag(parents);
    const sp = chain.dag.get(gd.selectedParent);
    const baseFee = nextBaseFee(sp.baseFee, sp.gasUsed, chain.p);
    const header = {
      version: HEADER_VERSION, parents: parents.map((h) => fromHex('0x' + h)), timestamp: timestamp ?? Math.max(chain.now(), chain.pastMedianTime(sp) + 1),
      target: chain.expectedTarget(sp), blueScore: BigInt(gd.blueScore), blueWork: gd.blueWork, gasLimit: chain.p.blockGasLimit, baseFee,
      miner: miner.addr, extra: new Uint8Array(0), nonce: 0n, minerSig: new Uint8Array(65),
    };
    chain.moveTo(sp.hash);
    const res = await chain.acceptMergeset({ header, txs: [], certs: [], hash: null }, gd, sp, baseFee);
    header.stateRoot = chain.state.rootWith(res.view);
    header.receiptsRoot = res.receiptsRoot;
    header.acceptedTxRoot = res.acceptedTxRoot;
    header.gasUsed = res.gasUsed;
    header.txRoot = bodyRoot(txRaws, []);
    chain.moveTo(chain.tip.hash);
    solve(header, miner.sk, chain.p);
    return encodeBlock(header, txRaws, []);
  });
}

export const hex = bytesToHex;
