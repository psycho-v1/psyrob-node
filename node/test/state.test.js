// State consistency: a block on a selected parent deeper than the finality depth is refused without touching the
// state; moveTo is all-or-nothing; transactions a reorganisation drops go back to the mempool; a miner registration
// stays in the tip state through reorganisations within the finality depth; gapped transactions cannot fill the pool.

import test from 'node:test';
import assert from 'node:assert/strict';
import { testChain, key, mineOne, blockOn, hex } from './helpers.js';
import { signTx } from '../src/tx.js';
import { ADDR } from '../src/params.js';
import { BlockError, StateUnavailable } from '../src/consensus.js';
import { contractCall } from '../src/evm.js';
import { contract } from '../../common/abicodec.js';
import { keccak256 } from '../../common/crypto.js';
import { artifacts } from '../src/genesis.js';

const A = key(1), B = key(2), C = key(3);
const MR = contract(artifacts().MinerRegistry.abi, keccak256);
const tipRootOk = (t) => t.chain.readAtTip(() => hex(t.chain.state.root()) === hex(t.chain.tip.stateRoot));
const registered = (t, who) => t.chain.readAtTip(async (view, ctx) => MR.decode('isRegistered', (await contractCall(view, t.params, ctx, { to: ADDR.minerRegistry, data: MR.encode('isRegistered', ['0x' + hex(who.addr)]), commit: false })).returnValue));
const nonceOf = (t, who) => t.chain.readAtTip((view) => view.getAccount(who.addr).nonce);

test('a block whose selected parent is deeper than the finality depth is refused and the state stays correct', async () => {
  const t = await testChain({ params: { finalityDepth: 20, mergeDepth: 5 } });
  for (let i = 0; i < 10; i++) { t.advance(10); await mineOne(t, A); }
  // built now, while block 10's state is still reachable; offered once it is far below the finality depth
  const oldParent = t.chain.tip.hash;
  t.advance(1);
  const deep = await blockOn(t, [oldParent], C);
  for (let i = 0; i < 95; i++) { t.advance(10); await mineOne(t, A); }
  assert.ok(t.chain.tip.chainHeight >= 100);
  assert.equal(t.chain.dag.get(oldParent).undo, null, 'the old records were pruned');

  await assert.rejects(t.chain.addBlock(deep), (e) => e instanceof BlockError && /below the finality depth/.test(e.message));
  assert.ok(await tipRootOk(t), 'the state still matches the tip after the refusal');

  // moveTo across pruned records throws before changing anything
  const before = t.chain.stateAt;
  await t.chain.exclusive(async () => assert.throws(() => t.chain.moveTo(oldParent), StateUnavailable));
  assert.equal(t.chain.stateAt, before);
  assert.ok(await tipRootOk(t));

  t.advance(10);
  assert.equal((await mineOne(t, A)).status, 'added', 'the chain keeps growing on a correct state');
});

test('a transfer dropped by a reorganisation is reported, leaves the index, and the mempool takes it back', async () => {
  const t = await testChain();
  for (let i = 0; i < 3; i++) { t.advance(10); await mineOne(t, A); }
  const base = t.chain.tip.hash;
  const n = await nonceOf(t, A);
  const tx = signTx({ nonce: n, to: B.addr, value: 1n, gasLimit: 21000, gasPrice: 2_000_000_000n }, A.sk, t.params);
  t.advance(10);
  const x1 = await blockOn(t, [base], A, { txRaws: [tx.raw] });
  await t.chain.addBlock(x1);
  t.advance(10);
  await t.chain.addBlock(await blockOn(t, [t.chain.tip.hash], A));
  assert.ok(t.chain.txIndex.has(hex(tx.hash)), 'accepted on the first branch');
  assert.equal(await nonceOf(t, A), n + 1n);

  // a heavier branch from the same base that does not merge the first one
  const mark = t.events.length;
  let y = base;
  for (let i = 0; i < 3; i++) { t.advance(10); y = (await t.chain.addBlock(await blockOn(t, [y], C))).hash; }
  assert.equal(t.chain.tip.hash, y, 'the heavier branch is the chain');
  const d = { lost: t.events.slice(mark).filter(([type]) => type === 'tip').flatMap(([, e]) => e.lost ?? []) };
  assert.ok(d.lost.some((x) => hex(x.hash) === hex(tx.hash)), 'the dropped transaction is reported');
  assert.ok(!t.chain.txIndex.has(hex(tx.hash)), 'and its receipt is no longer served');
  assert.equal(await nonceOf(t, A), n, 'the state no longer has it');

  // what the node does with it: back into the pool, and the next block accepts it again
  await t.chain.readAtTip((view, ctx) => { t.mempool.prune(view); for (const l of d.lost) t.mempool.add(l.raw, view, ctx.baseFee, ctx.timestamp); });
  assert.ok(t.mempool.get(hex(tx.hash)));
  t.advance(10); await mineOne(t, C);
  t.advance(10); await mineOne(t, C);
  assert.equal(await nonceOf(t, A), n + 1n, 'mined again');
});

test('a miner registration stays in the tip state through reorganisations within the finality depth', async () => {
  for (const mergesOldBranch of [true, false]) {
    const t = await testChain();
    for (let i = 0; i < 4; i++) { t.advance(10); await mineOne(t, A); }
    const base = t.chain.tip.hash;
    const reg = signTx({ nonce: await nonceOf(t, A), to: ADDR.minerRegistry, value: 0n, data: MR.encode('register', ['0x' + '00'.repeat(32)]), gasLimit: 200_000, gasPrice: 2_000_000_000n }, A.sk, t.params);
    t.advance(10);
    await t.chain.addBlock(await blockOn(t, [base], A, { txRaws: [reg.raw] }));
    t.advance(10); await mineOne(t, A);
    const oldTip = t.chain.tip.hash;
    assert.equal(await registered(t, A), true, 'registered on the first branch');

    // competing branch: three blocks by another miner; when mergesOldBranch, its last block also merges the first branch
    let y = base;
    for (let i = 0; i < 3; i++) {
      t.advance(10);
      const parents = mergesOldBranch && i === 2 ? [y, oldTip] : [y];
      y = (await t.chain.addBlock(await blockOn(t, parents, C))).hash;
    }
    if (!mergesOldBranch) assert.equal(t.chain.tip.hash, y, 'the competing branch became the chain');
    if (!mergesOldBranch) {
      const d = { lost: t.events.filter(([type]) => type === 'tip').flatMap(([, e]) => e.lost ?? []) };
      await t.chain.readAtTip((view, ctx) => { t.mempool.prune(view); for (const l of d.lost ?? []) { try { t.mempool.add(l.raw, view, ctx.baseFee, ctx.timestamp); } catch { /* invalid */ } } });
      t.advance(10); await mineOne(t, C);
      t.advance(10); await mineOne(t, C);
    }
    assert.equal(await registered(t, A), true, `still registered after the reorganisation (${mergesOldBranch ? 'old branch merged' : 'transaction mined again'})`);
    assert.ok(await tipRootOk(t));
  }
});

// ---------------------------------------------------------------- the mempool cannot be filled with gapped transactions

test('gapped transactions are queued, capped, expire, are not relayed, and never crowd out executable ones', async () => {
  const { Mempool } = await import('../src/mempool.js');
  const t = await testChain();
  for (let i = 0; i < 6; i++) { t.advance(10); await mineOne(t, i % 2 ? C : A); }
  t.advance(10); await mineOne(t, A);
  const mp = new Mempool(t.params, { maxTxs: 20, maxQueued: 8, maxQueuedPerSender: 4, queuedLifetime: 3600 });
  const now = 1_900_000_000;
  const send = (who, nonce, fee = 2_000_000_000n) => signTx({ nonce, to: B.addr, value: 1n, gasLimit: 21000, gasPrice: fee }, who.sk, t.params);
  const n = await nonceOf(t, A);
  const addAt = (tx, at = now) => t.chain.readAtTip((view, ctx) => mp.relayAfterAdd(tx.raw, view, ctx.baseFee, at));

  // nonces n+1 to n+4 wait behind the missing nonce n: queued, not relayed
  for (let i = 1; i <= 4; i++) assert.deepEqual(await addAt(send(A, n + BigInt(i))), [], 'queued: not relayed');
  assert.deepEqual(mp.counts(), { pending: 0, queued: 4 });
  await assert.rejects(addAt(send(A, n + 5n)), /nonce gap/, 'at most 4 queued per sender here');
  assert.equal((await t.chain.readAtTip((view, ctx) => mp.select(view, ctx.baseFee, t.params.blockGasLimit))).length, 0, 'nothing queued is mined');

  // filling the gap makes all of them executable and relays them together
  const relayed = await addAt(send(A, n));
  assert.equal(relayed.length, 5);
  assert.deepEqual(mp.counts(), { pending: 5, queued: 0 });

  // queued transactions expire; pending ones do not
  const m = await nonceOf(t, C);
  await addAt(send(C, m + 3n), now - 7200);
  await t.chain.readAtTip((view) => mp.prune(view, now));
  assert.deepEqual(mp.counts(), { pending: 5, queued: 0 }, 'the 2-hour-old queued transaction expired');

  // a full pool makes room for executable transactions by dropping queued ones first
  const small = new Mempool(t.params, { maxTxs: 3, maxQueued: 3, maxQueuedPerSender: 3 });
  const addSmall = (tx) => t.chain.readAtTip((view, ctx) => small.relayAfterAdd(tx.raw, view, ctx.baseFee, now));
  for (let i = 1; i <= 3; i++) await addSmall(send(C, m + BigInt(i)));
  assert.deepEqual(small.counts(), { pending: 0, queued: 3 });
  assert.equal((await addSmall(send(A, n))).length, 1, 'an executable transaction gets in although the pool was full of gapped ones');
  assert.equal(small.size, 3);
  assert.deepEqual(small.counts(), { pending: 1, queued: 2 });
});
