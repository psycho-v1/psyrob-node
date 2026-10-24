// Stale tips: a block mined on an early chain while a node syncs stays a tip for ever. Templates leave out parents
// that validation would refuse ("parent below the merge depth"), so such a tip never stops mining.

import test from 'node:test';
import assert from 'node:assert/strict';
import { testChain, key, mineOne, blockOn } from './helpers.js';

const A = key(1), B = key(2);

test('a stale tip far below the merge depth does not stop mining', async () => {
  const t = await testChain({ params: { mergeDepth: 20 } });
  for (let i = 0; i < 3; i++) { t.advance(10); await mineOne(t, A); }
  // a side block on the early chain, delivered only after the chain has moved on by more than the merge depth
  t.advance(1);
  const stale = await blockOn(t, [t.chain.chain[1]], B);
  for (let i = 0; i < 30; i++) { t.advance(10); await mineOne(t, A); }
  await t.chain.addBlock(stale);
  assert.equal(t.chain.dag.tips.size, 2, 'the stale block is a second tip');
  const staleHash = [...t.chain.dag.tips].find((h) => h !== t.chain.tip.hash);
  assert.ok(t.chain.dag.get(staleHash).blueScore + 20 < t.chain.tip.blueScore, 'and it is below the merge depth');
  assert.ok(t.chain.dag.virtualParents().includes(staleHash), 'the virtual still lists it');
  assert.ok(!t.chain.dag.templateParents().includes(staleHash), 'templates leave it out');
  const before = t.chain.tip.chainHeight;
  for (let i = 0; i < 3; i++) { t.advance(10); await mineOne(t, A); }
  assert.equal(t.chain.tip.chainHeight, before + 3, 'blocks are accepted and the chain grows');
});

test('a side tip within the merge depth is still merged', async () => {
  const t = await testChain({ params: { mergeDepth: 20 } });
  for (let i = 0; i < 5; i++) { t.advance(10); await mineOne(t, A); }
  t.advance(1);
  await t.chain.addBlock(await blockOn(t, [t.chain.chain[4]], B));
  assert.equal(t.chain.dag.tips.size, 2);
  assert.equal(t.chain.dag.templateParents().length, 2, 'both tips are parents');
  t.advance(10);
  await mineOne(t, A);
  assert.equal(t.chain.dag.tips.size, 1, 'the next block merges the side tip');
});
