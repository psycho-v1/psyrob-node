import test from 'node:test';
import assert from 'node:assert/strict';
import { testChain, key, mineOne, blockOn } from './helpers.js';

const M = Array.from({ length: 30 }, (_, i) => key(10 + i));

test('ghostdag: more than k parallel blocks -> at most k+1 blue in the mergeset, the rest red and unpaid', { timeout: 120_000 }, async () => {
  const t = await testChain({ params: { k: 3, mergesetLimit: 40 } });
  t.advance(10);
  await mineOne(t, M[0]);
  const base = t.chain.tip.hash;
  t.advance(10);
  const raws = [];
  for (let i = 1; i <= 7; i++) raws.push(await blockOn(t, [base], M[i]));
  for (const r of raws) await t.chain.addBlock(r);
  assert.equal(t.chain.dag.tips.size, 7);
  t.advance(200);
  const r = await mineOne(t, M[0]);
  const e = r.entry;
  assert.equal(e.mergesetBlues.length, 4); // k + 1 = selected parent + k blues
  assert.equal(e.mergesetReds.length, 3);
  for (const red of e.mergesetReds) assert.equal(t.chain.state.getAccount(t.chain.dag.get(red).header.miner).balance, 0n);
  for (const blue of e.mergesetBlues) assert.ok(t.chain.state.getAccount(t.chain.dag.get(blue).header.miner).balance > 0n);
});

test('reorganisation: a heavier side branch becomes the chain; state follows', { timeout: 120_000 }, async () => {
  const t = await testChain();
  t.advance(10);
  await mineOne(t, M[0]);
  const fork = t.chain.tip.hash;
  t.advance(10);
  // branch A: one block; branch B: two blocks (heavier), built without seeing A
  const a1 = await blockOn(t, [fork], M[1]);
  const b1 = await blockOn(t, [fork], M[2]);
  await t.chain.addBlock(b1);
  const b1h = t.chain.tip.hash;
  t.advance(10);
  const b2 = await blockOn(t, [b1h], M[2]);
  // a node that sees A first, then B's two blocks
  const u = await testChain();
  u.setTime(t.now());
  await u.chain.addBlock((await (async () => { const g = t.chain.dag.get(fork); return g.raw; })()));
  await u.chain.addBlock(a1);
  const aTip = u.chain.tip.hash;
  await u.chain.addBlock(b1);
  await u.chain.addBlock(b2);
  assert.notEqual(u.chain.tip.hash, aTip);
  assert.equal(u.chain.tip.chainHeight, 3);
  // the state equals that of the node that only ever saw branch B
  await t.chain.addBlock(b2);
  assert.equal(Buffer.from(u.chain.state.root()).toString('hex'), Buffer.from(t.chain.state.root()).toString('hex'));
});

test('a parent below the merge depth makes a block invalid', { timeout: 120_000 }, async () => {
  const t = await testChain({ params: { mergeDepth: 3, k: 18 } });
  t.advance(10);
  await mineOne(t, M[0]);
  const old = t.chain.tip.hash;
  t.advance(10);
  const side = await blockOn(t, [old], M[2]); // a parallel block built early
  for (let i = 0; i < 6; i++) { t.advance(10); await mineOne(t, M[0]); }
  const r = await t.chain.addBlock(side); // arrives late: valid on its own
  assert.equal(r.status, 'added');
  t.advance(10);
  const merge = await blockOn(t, [t.chain.tip.hash, r.hash], M[3]);
  await assert.rejects(t.chain.addBlock(merge), /merge depth/);
});

test('a final checkpoint cannot be reorganised away: a heavier branch that excludes it is refused (51 % protection)', { timeout: 120_000 }, async () => {
  const t = await testChain();
  t.advance(10);
  await mineOne(t, M[0]);
  const fork = t.chain.tip.hash;
  t.advance(10);
  const a1 = await blockOn(t, [fork], M[1]);
  const b1 = await blockOn(t, [fork], M[2]);
  await t.chain.addBlock(b1);
  t.advance(10);
  const b2 = await blockOn(t, [t.chain.tip.hash], M[2]);
  // a node that has branch A, and A's block is final (as a valid certificate would make it; certificate checks are
  // covered by flow.test.js)
  const u = await testChain();
  u.setTime(t.now());
  await u.chain.addBlock(t.chain.dag.get(fork).raw);
  await u.chain.addBlock(a1);
  const aTip = u.chain.tip.hash;
  u.chain.finalCheckpoint = { number: 1, hash: aTip };
  // branch B is heavier (two blocks) but does not contain the final block: refused, the node keeps branch A
  await assert.rejects(u.chain.addBlock(b1), /conflicts with a final checkpoint/);
  await u.chain.addBlock(b2); // its parent was refused: it can only wait as an orphan
  assert.equal(u.chain.tip.hash, aTip);
});
