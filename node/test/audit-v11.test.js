// Regression tests for the v11 security audit (BASE-F 2.0, 4 November 2026, commit 2789047). Each test reproduces the
// audit's proof of concept and fails on the code it was reported against.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { testChain, key, mineOne, blockOn } from './helpers.js';
import { Rpc, RpcError, SIM_LIMITS } from '../src/rpc.js';
import { State, encodeLeafForTest } from '../src/state.js';
import { merkleRootFromLeafHashes, leafHash } from '../../common/merkle.js';

const M = key(7);
// init code JUMPDEST PUSH1 0 JUMP: an endless loop, run as a contract creation (no contract has to exist)
const LOOP = '0x5b600056';

// ---------------------------------------------------------------- F-03: RPC work and the chain lock

test('F-03: eth_call loops do not delay block intake', async () => {
  const t = await testChain();
  t.advance(10); await mineOne(t, M);
  const rpc = new Rpc({ chain: t.chain, mempool: t.mempool, p2p: null, finality: null, node: null });
  t.advance(10);
  const raw = await blockOn(t, [t.chain.tip.hash], key(8));
  // the audit's PoC: five endless eth_calls (one client's heavy budget for a second), then a peer's block arrives.
  // At 2789047 intake waited ~5,000 ms behind them
  const calls = Array.from({ length: 5 }, () => rpc.handle('eth_call', [{ data: LOOP, gas: '0x989680' }]).catch((e) => e));
  const a = performance.now();
  await t.chain.addBlock(raw);
  const waited = performance.now() - a;
  const results = await Promise.all(calls);
  assert.ok(waited < 1500, `block intake waited ${Math.round(waited)} ms behind eth_calls`);
  for (const r of results) assert.ok(r instanceof RpcError, 'each endless call ends in an error');
});

test('F-03: simulations are bounded in time and number', async () => {
  const t = await testChain();
  t.advance(10); await mineOne(t, M);
  const rpc = new Rpc({ chain: t.chain, mempool: t.mempool, p2p: null, finality: null, node: null });
  const a = performance.now();
  await assert.rejects(rpc.handle('eth_estimateGas', [{ data: LOOP, gas: '0x989680' }]), /time limit|out of gas|failed/);
  assert.ok(performance.now() - a < SIM_LIMITS.deadlineMs + 1500, 'estimateGas stops near the deadline');
  // more callers than running + queued places: the rest are told the node is busy straight away
  const n = SIM_LIMITS.concurrent + SIM_LIMITS.queued + 3;
  const all = await Promise.all(Array.from({ length: n }, () => rpc.handle('eth_call', [{ data: LOOP }]).catch((e) => e)));
  const busy = all.filter((e) => e instanceof RpcError && e.code === -32005);
  assert.equal(busy.length, 3, 'calls beyond the queue are refused as busy');
  // gas above one block's limit is capped, not run
  assert.equal(rpc.parseCall({ data: '0x', gas: '0xffffffffff' }).gas, t.chain.p.blockGasLimit);
});

test('F-03: eth_call reads the state of the moment it started, even while blocks connect', async () => {
  const t = await testChain();
  t.advance(10); await mineOne(t, M);
  const s = new State();
  const k = 'a' + 'ab'.repeat(20);
  const v = s.view(); v.set(k, { balance: 5n }); s.commit(v);
  const snap = s.snapshot();
  const w = s.view(); w.set(k, { balance: 9n }); w.set('a' + 'cd'.repeat(20), { balance: 1n }); s.commit(w);
  assert.equal(snap.get(k).balance, 5n, 'the snapshot keeps the old value');
  assert.equal(snap.get('a' + 'cd'.repeat(20)), undefined, 'and does not see records added later');
  assert.equal(s.get(k).balance, 9n);
  snap.release();
  assert.equal(s.snapshots.size, 0, 'released snapshots are forgotten');
  assert.throws(() => snap.get(k), /after release/);
  // the chain-level helper releases its snapshot even when the read throws
  await assert.rejects(t.chain.readSnapshot(() => { throw new Error('boom'); }), /boom/);
  assert.equal(t.chain.state.snapshots.size, 0);
});

test('F-03: rotating miner addresses cannot rebuild templates without limit', async () => {
  const t = await testChain();
  t.advance(10); await mineOne(t, M);
  const rpc = new Rpc({ chain: t.chain, mempool: t.mempool, p2p: null, finality: null, node: null });
  let built = 0, busy = 0;
  for (let i = 0; i < 30; i++) {
    try { await rpc.handle('psy_getBlockTemplate', ['0x' + randomBytes(20).toString('hex')]); built++; } catch (e) { if (e.code === -32005) busy++; else throw e; }
  }
  assert.ok(built <= 12, `${built} templates built for fresh miner addresses in a burst`);
  assert.ok(busy >= 18);
  // the same miner and tips: answered from the cache, no build
  const addr = '0x' + randomBytes(20).toString('hex');
  rpc.buildBudget.tokens = 1;
  const one = await rpc.handle('psy_getBlockTemplate', [addr]);
  assert.deepEqual(await rpc.handle('psy_getBlockTemplate', [addr]), one);
});

// ---------------------------------------------------------------- F-01: state root cost

/** The state root exactly as 2789047 computed it: every record, sorted, hashed from scratch. */
function referenceRoot(state) {
  const sorted = [...state.data.keys()].sort();
  return merkleRootFromLeafHashes(sorted.map((k) => leafHash(encodeLeafForTest(k, state.data.get(k)))));
}

test('F-01: the incremental state root equals the full recomputation under random changes', () => {
  const s = new State();
  const rnd = (n) => Math.floor(Math.random() * n);
  const addrs = Array.from({ length: 60 }, () => randomBytes(20));
  const undos = [];
  for (let round = 0; round < 400; round++) {
    const v = s.view();
    const ops = 1 + rnd(12);
    for (let i = 0; i < ops; i++) {
      const a = addrs[rnd(addrs.length)];
      switch (rnd(6)) {
        case 0: v.setAccount(a, { balance: BigInt(rnd(5)) }); break; // 0 deletes an empty account
        case 1: v.setAccount(a, { nonce: BigInt(rnd(3)), balance: BigInt(1 + rnd(1e6)) }); break;
        case 2: v.setStorage(a, randomBytes(32).fill(rnd(4), 0, 31), BigInt(rnd(3))); break;
        case 3: v.setCode(a, rnd(2) ? randomBytes(1 + rnd(40)) : new Uint8Array(0)); break;
        case 4: v.clearStorage(a); break;
        default: v.setGlobal({ burned: BigInt(rnd(1e9)) });
      }
    }
    // sometimes a fresh, never-seen key (inserted anywhere in the order)
    if (rnd(3) === 0) v.setAccount(randomBytes(20), { balance: 1n });
    const undo = s.commit(v);
    undos.push(undo);
    // rootWith-style: commit, root, revert, as templates do
    if (rnd(4) === 0) { const w = s.view(); w.setAccount(randomBytes(20), { balance: 7n }); assert.deepEqual(s.rootWith(w), (() => { const u = s.commit(w); const r = referenceRoot(s); s.revert(u); return r; })()); }
    // sometimes undo the last few blocks (reorgs)
    if (rnd(5) === 0) for (let k = rnd(3); k > 0 && undos.length; k--) s.revert(undos.pop());
    // not every block asks for the root: changes pile up between roots too
    if (rnd(3) !== 0) assert.deepEqual(s.root(), referenceRoot(s), `round ${round}`);
  }
  assert.deepEqual(s.root(), referenceRoot(s));
  // and down to an empty state
  for (const u of undos.reverse()) s.revert(u);
  assert.deepEqual(s.root(), referenceRoot(s));
});

test('F-01: a block that changes existing records does not rehash the whole state', () => {
  const s = new State();
  const v = s.view();
  const addrs = Array.from({ length: 50_000 }, () => randomBytes(20));
  for (const a of addrs) v.setAccount(a, { balance: 1n });
  s.commit(v);
  s.root();
  // a typical block: some transfers between existing accounts and a reward to an existing miner
  const w = s.view();
  for (let i = 0; i < 40; i++) w.setAccount(addrs[i * 997 % addrs.length], { balance: 5n + BigInt(i) });
  s.commit(w);
  const r = s.root();
  assert.ok(s.rootStats().lastRehashed < 40 * 20, `rehashed ${s.rootStats().lastRehashed} nodes for 40 changed records`);
  assert.deepEqual(r, referenceRoot(s));
});
