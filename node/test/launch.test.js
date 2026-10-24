// Launch with a genesis time in the future: the node runs and serves pages before the genesis time;
// a block mined too early is refused (a block may be at most 120 s ahead of the clock and must be later than the
// genesis), without harm; from 60 s before the genesis time (when psyrob-miner.service starts mining) blocks are
// accepted.

import test from 'node:test';
import assert from 'node:assert/strict';
import { testChain, key, mineOne } from './helpers.js';
import { Explorer } from '../src/explorer.js';
import { Rpc } from '../src/rpc.js';

test('a genesis time in the future: pages work, early blocks are refused, mining from genesis - 60 s works', { timeout: 120_000 }, async () => {
  const G = 1_800_000_000;
  const t = await testChain({ start: G });
  const m = key(3);
  t.setTime(G - 600); // ten minutes before the genesis time
  const node = { chain: t.chain, params: t.params, mempool: t.mempool, p2p: null, finality: null, opts: {}, log: () => {} };
  node.rpc = new Rpc({ chain: t.chain, mempool: t.mempool, p2p: null, finality: null, node });
  const ex = new Explorer(node);
  for (const p of ['/', '/mining', '/emission', '/network', '/election', '/committee']) {
    const html = await ex.route(p, new URLSearchParams());
    assert.ok(typeof html === 'string' && html.includes('</html>'), 'page ' + p + ' before the genesis time');
  }
  assert.equal(ex.miningData().window, 0);
  await assert.rejects(mineOne(t, m), /too far in the future/);
  assert.equal(t.chain.tip.chainHeight, 0);
  t.setTime(G - 60); // the miner unit waits until here
  const r = await mineOne(t, m);
  assert.equal(r.status, 'added');
  assert.equal(t.chain.tip.chainHeight, 1);
  assert.ok(t.chain.tip.header.timestamp > G);
  t.setTime(G + 30);
  assert.equal((await mineOne(t, m)).status, 'added');
});
