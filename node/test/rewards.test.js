// Rewards in the explorer: block rewards, the committee and NGO pool shares and priority fees are credited by the node,
// not sent as transactions. The explorer lists them on the block, address and NGO pages (never on /txs), and the
// amounts it shows must add up to what the chain issued and to the balances.

import test from 'node:test';
import assert from 'node:assert/strict';
import { testChain, key, mineOne, blockOn } from './helpers.js';
import { signTx } from '../src/tx.js';
import { ADDR } from '../src/params.js';
import { keccak256 } from '../../common/crypto.js';
import { bytesToHex } from '../../common/bytes.js';
import { Explorer } from '../src/explorer.js';
import { Rpc } from '../src/rpc.js';

const PSY = 10n ** 18n;
const GWEI = 10n ** 9n;
const hex = (a) => '0x' + bytesToHex(a);

test('explorer rewards: block, address, NGO pool and transaction pages; amounts match issue and balances', { timeout: 300_000 }, async () => {
  const t = await testChain({ params: { poolCap: 360_000_000_000n * PSY, maxSupply: 10n ** 30n } });
  const a = key(1), b = key(2), c = key(3);
  const mine = async (who, n = 1) => { for (let i = 0; i < n; i++) { t.advance(10); await mineOne(t, who); await t.chain.readAtTip((v) => t.mempool.prune(v)); } };
  await mine(a, 6);
  // a parallel block by b on the tip's parent: merged blue by the next chain block, which pays its reward
  const parent = t.chain.dag.get(t.chain.tip.selectedParent);
  t.advance(5);
  const raw = await blockOn(t, [parent.hash], b);
  assert.equal((await t.chain.addBlock(raw)).status, 'added');
  await mine(a, 2);
  // a transfer with a 1 gwei priority fee: the fee goes to the miner of the block that holds it
  const tx = signTx({ type: 2, nonce: await t.chain.readAtTip((v) => v.getAccount(a.addr).nonce), to: c.addr, data: new Uint8Array(0), value: 5n * PSY, gasLimit: 21_000n, maxFee: 20n * GWEI, maxPriorityFee: GWEI }, a.sk, t.params);
  await t.chain.readAtTip((view, ctx) => t.mempool.add(tx.raw, view, ctx.baseFee));
  await mine(a, 2);

  const node = { chain: t.chain, params: t.params, mempool: t.mempool, p2p: null, finality: null, opts: { vhosts: ['*'] }, log: (m) => { throw new Error(m); } };
  node.rpc = new Rpc({ chain: t.chain, mempool: t.mempool, p2p: null, finality: null, node });
  const ex = new Explorer(node);
  const get = (p) => ex.route(p.split('?')[0], new URLSearchParams(p.split('?')[1] ?? ''));

  // ---- the amounts: over the whole chain they equal the issue of each pool and the balance of a miner that never spent
  const ch = t.chain;
  const rows = [];
  for (let h = 1; h <= ch.tip.chainHeight; h++) rows.push(...ex.rewardRows(ch.dag.get(ch.chain[h])));
  const sum = (f) => rows.filter(f).reduce((s, r) => s + r.amount, 0n);
  const s = ch.supply();
  assert.ok(s.issuedMining > 0n);
  assert.equal(sum((r) => r.kind === 'Block reward' || r.kind === 'Committee share'), s.issuedMining);
  assert.equal(sum((r) => r.kind === 'NGO pool share'), s.issuedNGO);
  assert.equal(sum((r) => r.to === bytesToHex(ADDR.ngoRewards)), s.issuedNGO);
  const bBal = await ch.readAtTip((v) => v.getAccount(b.addr).balance);
  assert.ok(bBal > 0n);
  assert.equal(sum((r) => r.to === bytesToHex(b.addr)), bBal, 'the parallel block\'s reward is shown and is all b has');
  const fees = rows.filter((r) => r.kind === 'Priority fees');
  assert.equal(fees.length, 1);
  assert.equal(fees[0].to, bytesToHex(a.addr));
  assert.equal(fees[0].amount, 21_000n * GWEI);

  // ---- block page: the parallel block says which chain block paid it; a chain block lists what it paid
  const bHash = [...ch.dag.blocks.values()].find((e) => e !== ch.dag.genesis && bytesToHex(e.header.miner) === bytesToHex(b.addr)).hash;
  const by = ex.mergedBy(ch.dag.get(bHash));
  assert.ok(by && by.blue);
  const pb = await get('/block/0x' + bHash);
  assert.match(pb, /<h2 class="mt-4">Rewards<\/h2>/);
  assert.match(pb, new RegExp(`paid by chain block <a href="/block/${by.cb.chainHeight}">`));
  const cb = await get('/block/' + by.cb.chainHeight);
  assert.match(cb, /Block reward/);
  assert.match(cb, /NGO pool share/);
  assert.match(cb, /Committee share/);
  assert.match(cb, /credited by the node|Credited by the node/);
  // the tip has not been merged by anything yet
  assert.match(await get('/block/' + ch.tip.chainHeight), /not paid yet/);

  // ---- address page: b's rewards are listed, separately from its (empty) transactions
  const ap = await get('/address/' + hex(b.addr));
  assert.match(ap, /Recent rewards/);
  assert.match(ap, /No transactions yet\./);
  assert.doesNotMatch(await get('/address/' + hex(c.addr)), /Recent rewards/, 'an address that only received a transfer has no rewards section');

  // ---- /txs lists the one real transaction and no rewards
  const txs = await get('/txs');
  assert.equal((txs.match(/<a href="\/tx\/0x/g) ?? []).length, 1);
  assert.doesNotMatch(txs, /Block reward|NGO pool share/);

  // ---- NGO pool section on /ngos
  const ngos = await get('/ngos');
  assert.match(ngos, /<h2 class="mt-4">NGO pool<\/h2>/);
  assert.match(ngos, /Latest income/);
  assert.match(ngos, /No NGO has claimed yet\./);

  // ---- a claim from the NGO pool shows as PSY moved inside the transaction
  const topic = '0x' + bytesToHex(keccak256(new TextEncoder().encode('Claimed(uint256,address,uint256)')));
  const ngo = '0x' + '42'.repeat(20);
  const receipt = { logs: [{ address: hex(ADDR.ngoRewards), topics: [topic, '0x' + (3n).toString(16).padStart(64, '0'), '0x' + '00'.repeat(12) + ngo.slice(2)], data: '0x' + (7n * PSY).toString(16).padStart(64, '0') }] };
  const it = ex.internalTransfers(receipt);
  assert.match(it, /PSY moved inside this transaction/);
  assert.match(it, new RegExp(`href="/address/${ngo}"`));
  assert.match(it, /7 PSY/);
  assert.match(it, /term 3/);
  assert.equal(ex.internalTransfers({ logs: [] }), '');
  // the same log from another contract is not a payout
  assert.equal(ex.internalTransfers({ logs: [{ ...receipt.logs[0], address: hex(ADDR.treasury) }] }), '');
});
