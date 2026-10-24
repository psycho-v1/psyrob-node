// Proof that PSYROB is a block DAG, not a linear chain (risk review Part 2).
//
// Simulation: six miners, each running its own full node (a Chain), find blocks as a Poisson process (one block per
// 10 s in total) and build each block on their own view of the DAG. Blocks reach the other nodes only after a network
// delay of 8 s. Every block is fully validated by every node (proof of work, GHOSTDAG values, state roots).

import test from 'node:test';
import assert from 'node:assert/strict';
import { testChain, key, mineOne, blockOn } from './helpers.js';
import { simulate, metrics } from './dagsim.js';
import { contractCall } from '../src/evm.js';
import { contract } from '../../common/abicodec.js';
import { keccak256 } from '../../common/crypto.js';
import { artifacts } from '../src/genesis.js';
import { ADDR } from '../src/params.js';
import { bytesToHex } from '../../common/bytes.js';

const MR = contract(artifacts().MinerRegistry.abi, keccak256);

test('six miners, 8 s network delay: real parallel blocks, all kept, all merged, all nodes agree', { timeout: 600_000 }, async () => {
  const { nodes, all, sent } = await simulate({ miners: 6, blocks: 120, delay: 8 });
  const c = nodes[0].t.chain;
  const m = metrics(c, all);
  console.log('# DAG metrics (6 miners, 8 s delay, 120 blocks):', JSON.stringify({ ...m, width: m.width.toFixed(2), multiParentShare: (100 * m.multiParentShare).toFixed(1) + ' %' }));
  // blocks reference several parents, and many of them
  assert.ok(m.multiParentShare > 0.2, 'share of blocks with 2+ parents');
  assert.ok(m.width > 1.2, 'DAG width (blocks per chain block)');
  // parallel blocks are all kept and merged: zero orphaned, none left unmerged below the tip
  assert.equal(m.orphaned, 0);
  assert.equal(m.unmerged, 0);
  assert.equal(m.blocks, all.length + 1);
  // every node holds the same DAG, the same chain and the same state
  for (const n of nodes) {
    assert.equal(n.t.chain.dag.blocks.size, c.dag.blocks.size);
    assert.equal(n.t.chain.tip.hash, c.tip.hash);
    assert.equal(bytesToHex(n.t.chain.state.root()), bytesToHex(c.state.root()));
  }
  // transactions from parallel blocks were executed: every sent transfer has a receipt, some from non-chain blocks
  let fromParallel = 0;
  for (const h of sent) {
    const loc = c.txIndex.get(h);
    assert.ok(loc, 'transaction accepted ' + h);
    const r = c.dag.get(loc.block).receipts[loc.index];
    assert.equal(r.status, 1);
    if (c.chain[c.dag.get(r.block).chainHeight] !== r.block) fromParallel++;
  }
  console.log(`# transactions: ${sent.length} sent through different miners, all accepted; ${fromParallel} were in parallel (non-chain) blocks`);
  assert.ok(fromParallel > 0, 'some transactions were carried by parallel blocks');
  // miners of parallel blocks are rewarded: MinerRegistry counts every blue block per miner, chain or parallel
  const blueBy = new Map();
  for (const [h, x] of c.acceptedBy) {
    if (x.colour !== 'blue') continue;
    const e = c.dag.get(h);
    if (e === c.dag.genesis) continue;
    const a = bytesToHex(e.header.miner);
    blueBy.set(a, (blueBy.get(a) ?? 0) + 1);
  }
  const parallelBlue = [...c.acceptedBy].filter(([h, x]) => x.colour === 'blue' && c.chain[c.dag.get(h).chainHeight] !== h).length;
  assert.ok(parallelBlue > 0);
  for (const n of nodes) {
    const a = bytesToHex(n.key.addr);
    const counted = await c.readAtTip(async (view, ctx) => MR.decode('minedTotal', (await contractCall(view, c.p, ctx, { to: ADDR.minerRegistry, data: MR.encode('minedTotal', ['0x' + a]), commit: false })).returnValue));
    assert.equal(counted, BigInt(blueBy.get(a) ?? 0), 'blue blocks recorded for miner ' + a);
    assert.ok(c.state.getAccount(n.key.addr).balance > 0n);
  }
  console.log(`# rewards: ${parallelBlue} blue blocks off the selected chain were rewarded like chain blocks`);
});

test('ordering is GHOSTDAG (most blue work), not longest chain: a longer linear private chain loses', { timeout: 120_000 }, async () => {
  const t = await testChain();
  const A = key(1), H = [key(2), key(3), key(4)], X = key(9);
  t.advance(10);
  await mineOne(t, A);
  const base = t.chain.tip.hash;
  // attacker: a private linear chain of 3 blocks on base (chain height +3, blue score +3)
  // build the private chain on a separate node that never sees the honest blocks
  const p = await testChain();
  p.setTime(t.now());
  await p.chain.addBlock(t.chain.dag.get(base).raw);
  const privRaws = [];
  for (let i = 0; i < 3; i++) { p.advance(10); const r = await mineOne(p, X); privRaws.push(p.chain.dag.get(r.hash).raw); }
  // honest: three parallel blocks on base, then one block merging them (chain height +2, blue score +4)
  t.setTime(p.now() - 30);
  const par = [];
  for (const h of H) par.push(await blockOn(t, [base], h));
  for (const r of par) await t.chain.addBlock(r);
  t.advance(10);
  const merge = await mineOne(t, A);
  assert.equal(merge.entry.parents.length, 3);
  const honestTip = t.chain.tip;
  // the attacker publishes its longer chain
  t.setTime(p.now());
  for (const r of privRaws) await t.chain.addBlock(r);
  const attackerTip = t.chain.dag.get(p.chain.tip.hash);
  assert.ok(attackerTip.chainHeight > honestTip.chainHeight, 'the private chain is longer');
  assert.ok(honestTip.blueWork > attackerTip.blueWork, 'the honest DAG has more blue work');
  assert.equal(t.chain.tip.hash, honestTip.hash, 'GHOSTDAG keeps the heavier DAG, not the longer chain');
});
