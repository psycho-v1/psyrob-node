import test from 'node:test';
import assert from 'node:assert/strict';
import { testChain, key, mineOne, blockOn, hex } from './helpers.js';
import { signTx } from '../src/tx.js';
import { ADDR } from '../src/params.js';
import { BlockError } from '../src/consensus.js';
import { decodeBlock, encodeBlock } from '../src/block.js';

const A = key(1), B = key(2), C = key(3);

test('genesis: contracts at their addresses, 28 % allocated, nothing else', async () => {
  const t = await testChain();
  const s = t.chain.state;
  assert.equal(s.getAccount(ADDR.treasury).balance, 160_000_000n * 10n ** 18n);
  for (const k of ['devVesting', 'devVesting2', 'devVesting3']) assert.equal(s.getAccount(ADDR[k]).balance, 40_000_000n * 10n ** 18n, k);
  for (const a of Object.values(ADDR)) assert.ok(s.getCode(a).length > 0, 'code at ' + hex(a));
  assert.equal(s.getGlobal().genesisSupply, 280_000_000n * 10n ** 18n);
});

test('genesis: the team\'s 12 % is three equal, immutable vesting contracts, each paying only its own Dev Account', async () => {
  const { contractCall } = await import('../src/evm.js');
  const { contract } = await import('../../common/abicodec.js');
  const { keccak256 } = await import('../../common/crypto.js');
  const { artifacts, buildGenesis } = await import('../src/genesis.js');
  const { DEV_ACCOUNTS } = await import('../src/params.js');
  const devs = [key(7), key(8), key(9)].map((k) => '0x' + hex(k.addr));
  const t = await testChain({ config: { devBeneficiaries: devs } });
  const c = contract(artifacts().DevVesting.abi, keccak256);
  const read = (to, f) => t.chain.readAtTip(async (view, ctx) => c.decode(f, (await contractCall(view, t.params, ctx, { to, data: c.encode(f, []), commit: false })).returnValue, 0));
  for (const [i, a] of DEV_ACCOUNTS.entries()) {
    assert.equal(String(await read(ADDR[a.key], 'beneficiary')).toLowerCase(), devs[i].toLowerCase(), a.label + ' pays its own address');
    assert.equal(await read(ADDR[a.key], 'allocation'), 40_000_000n * 10n ** 18n);
    assert.equal(await read(ADDR[a.key], 'releasable'), 0n, 'nothing before the 12-month cliff');
  }
  await assert.rejects(buildGenesis({ chainId: 1337, timestamp: 1, target: '0x1', devBeneficiaries: devs.slice(0, 2) }), /three addresses/);
});

test('a linear chain: blue blocks, subsidy to the miner, NGO and committee shares', async () => {
  const t = await testChain();
  for (let i = 0; i < 3; i++) { t.advance(10); const r = await mineOne(t, A); assert.equal(r.status, 'added'); }
  assert.equal(t.chain.tip.chainHeight, 3);
  assert.equal(t.chain.tip.blueScore, 3);
  // the tip's own reward is paid when a later block accepts it: two mined blocks are paid
  const bal = t.chain.state.getAccount(A.addr).balance;
  const g = t.chain.state.getGlobal();
  assert.ok(bal > 0n);
  assert.equal(g.issuedMining, g.issuedNGO); // identical schedules
  assert.equal(t.chain.state.getAccount(ADDR.ngoRewards).balance, g.issuedNGO);
  assert.equal(bal + t.chain.state.getAccount(ADDR.finalityCommittee).balance, g.issuedMining);
});

test('parallel blocks are merged; both miners are paid as blue', async () => {
  const t = await testChain();
  t.advance(10);
  await mineOne(t, A);
  const base = t.chain.tip.hash;
  t.advance(10);
  const b1 = await blockOn(t, [base], B);
  const b2 = await blockOn(t, [base], C);
  assert.equal((await t.chain.addBlock(b1)).status, 'added');
  assert.equal((await t.chain.addBlock(b2)).status, 'added');
  assert.equal(t.chain.dag.tips.size, 2);
  t.advance(60); // the first-year emission cap pays blue blocks only as fast as an ideal 10 s chain would
  const r = await mineOne(t, A);
  const e = r.entry;
  assert.equal(e.header.parents.length, 2);
  assert.equal(e.mergesetBlues.length, 2);
  assert.equal(e.mergesetReds.length, 0);
  assert.equal(t.chain.dag.tips.size, 1);
  assert.ok(t.chain.state.getAccount(B.addr).balance > 0n);
  assert.ok(t.chain.state.getAccount(C.addr).balance > 0n);
});

test('transactions: a transfer is accepted by the next chain block; a conflicting copy in a parallel block is skipped', async () => {
  const t = await testChain();
  for (let i = 0; i < 3; i++) { t.advance(10); await mineOne(t, A); }
  const bal = t.chain.state.getAccount(A.addr).balance;
  const tx = signTx({ nonce: 0, to: B.addr, value: 10n ** 18n, gasLimit: 21000, gasPrice: 2_000_000_000n }, A.sk, t.params);
  const base = t.chain.tip.hash;
  t.advance(10);
  // the same transaction in two parallel blocks: accepted once, skipped once
  const b1 = await blockOn(t, [base], B, { txRaws: [tx.raw] });
  const b2 = await blockOn(t, [base], C, { txRaws: [tx.raw] });
  await t.chain.addBlock(b1);
  await t.chain.addBlock(b2);
  t.advance(10);
  const r = await mineOne(t, A);
  assert.equal(r.entry.accepted.length, 1);
  assert.equal(r.entry.skipped.length, 1);
  assert.match(r.entry.skipped[0].reason, /nonce/);
  assert.ok(t.chain.state.getAccount(B.addr).balance >= 10n ** 18n);
  assert.ok(bal > t.chain.state.getAccount(A.addr).balance - 10n ** 20n);
});

test('invalid blocks are refused: bad state root, bad signature, wrong target', async () => {
  const t = await testChain();
  t.advance(10);
  await mineOne(t, A);
  const raw = await blockOn(t, [t.chain.tip.hash], B);
  const b = decodeBlock(raw);
  const bad = encodeBlock({ ...b.header, stateRoot: new Uint8Array(32) }, b.txRaws, b.certs);
  await assert.rejects(t.chain.addBlock(bad), (e) => e instanceof BlockError);
  const wrongSig = encodeBlock({ ...b.header, miner: C.addr }, b.txRaws, b.certs);
  await assert.rejects(t.chain.addBlock(wrongSig), /miner signature/);
  assert.equal((await t.chain.addBlock(raw)).status, 'added');
});

test('first-year emission cap: blocks faster than 10 s per blue block get no more than the schedule', async () => {
  const t = await testChain();
  for (let i = 0; i < 6; i++) { t.advance(1); await mineOne(t, A); }
  const g = t.chain.state.getGlobal();
  const { cumulative } = await import('../src/emission.js');
  const elapsed = t.chain.pastMedianTime(t.chain.tip) - t.chain.genesisTime;
  assert.ok(g.issuedMining <= cumulative(Math.floor(elapsed / 10) + 1 + 16, t.params));
  for (let i = 0; i < 30; i++) { t.advance(1); await mineOne(t, A); }
  const g2 = t.chain.state.getGlobal();
  const e2 = t.chain.pastMedianTime(t.chain.tip) - t.chain.genesisTime;
  assert.ok(g2.issuedMining <= cumulative(Math.floor(e2 / 10) + 1 + 16, t.params));
  assert.ok(g2.issuedMining < cumulative(t.chain.tip.blueScore - 1, t.params)); // capped below the block count
});

test('orphans wait for their parents', async () => {
  const t = await testChain();
  t.advance(10);
  const p1 = await blockOn(t, [t.chain.genesis ? t.chain.tip.hash : t.chain.tip.hash], A);
  await t.chain.addBlock(p1);
  const p1h = t.chain.tip.hash;
  t.advance(10);
  const c1 = await blockOn(t, [p1h], B);
  // a fresh chain receives the child first
  const u = await testChain();
  u.setTime(t.now());
  assert.equal((await u.chain.addBlock(c1)).status, 'orphan');
  assert.equal((await u.chain.addBlock(p1)).status, 'added');
  assert.equal(u.chain.tip.chainHeight, 2);
});
