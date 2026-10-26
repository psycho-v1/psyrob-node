// Node limits: psy_getDagRange bounds, RPC filter limits, running mempool counts, sync detection for block templates,
// the cold store for old block data, the proof-of-work worker, and the stand-in server that answers while the node
// replays its blocks.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testChain, key, mineOne, blockOn, hex } from './helpers.js';
import { Rpc, RpcError } from '../src/rpc.js';
import { Mempool } from '../src/mempool.js';
import { Store } from '../src/store.js';
import { P2P, MSG } from '../src/p2p.js';
import { decodeBlock } from '../src/block.js';
import { startingServer } from '../src/node.js';
import { signTx } from '../src/tx.js';
import { makeParams } from '../src/params.js';
import { KECCAK_EMPTY } from '../src/state.js';
import { bytesToHex } from '../../common/bytes.js';

const A = key(1), B = key(2);

test('psy_getDagRange returns promptly for huge, infinite, negative and reversed ranges', async () => {
  const t = await testChain();
  for (let i = 0; i < 5; i++) { t.advance(10); await mineOne(t, A); }
  const rpc = new Rpc({ chain: t.chain, mempool: t.mempool });
  const call = (...a) => rpc.methods.psy_getDagRange.call(rpc, ...a);
  assert.ok(call(0, 500).length >= 6, 'a normal range');
  assert.ok(call('0x0', '0x5').length >= 6, 'hex quantities');
  const t0 = Date.now();
  assert.deepEqual(call(Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER), [], 'start near 2^53: nothing, at once');
  assert.deepEqual(call(1_000_000, 2_000_000), [], 'beyond the tip: nothing');
  assert.deepEqual(call(5, 1), [], 'reversed');
  for (const bad of [['9007199254740993', '9007199254741491'], ['Infinity', 'Infinity'], [-1, 5], [1.5, 3], ['abc', 'def'], [null, 3]]) {
    assert.throws(() => call(...bad), (e) => e instanceof RpcError && e.code === -32602, `refused: ${JSON.stringify(bad)}`);
  }
  assert.ok(Date.now() - t0 < 1000, 'every call returned promptly');
  assert.throws(() => [...t.chain.dag.blocksInBlueScoreRange(2 ** 53, 2 ** 53 + 10)], /safe integers/, 'the DAG walk itself refuses unsafe bounds');
});

test('RPC limits: eth_getLogs refuses oversized address and topic filters', async () => {
  const t = await testChain();
  t.advance(10); await mineOne(t, A);
  const rpc = new Rpc({ chain: t.chain, mempool: t.mempool });
  const logs = (f) => rpc.methods.eth_getLogs.call(rpc, f);
  const addr = '0x' + '11'.repeat(20), topic = '0x' + '22'.repeat(32);
  assert.deepEqual(logs({ address: Array(100).fill(addr) }), []);
  assert.throws(() => logs({ address: Array(101).fill(addr) }), /at most 100 addresses/);
  assert.throws(() => logs({ topics: [null, null, null, null, null] }), /at most 4 topic/);
  assert.throws(() => logs({ topics: [Array(101).fill(topic)] }), /at most 100 alternatives/);
});

test('mempool pending/queued counts stay exact without walking the pool', () => {
  const p = makeParams({ chainId: 1337n });
  const accounts = new Map();
  const view = { getAccount: (a) => accounts.get(bytesToHex(a)) ?? { nonce: 0n, balance: 0n, codeHash: KECCAK_EMPTY }, getStorage: () => 0n };
  const mp = new Mempool(p);
  const keys = [A, B, key(3)];
  for (const k of keys) accounts.set(bytesToHex(k.addr), { nonce: 0n, balance: 10n ** 24n, codeHash: KECCAK_EMPTY });
  const slow = () => { let q = 0; for (const s of mp.bySender.keys()) q += mp.split(s).queued.length; return { pending: mp.size - q, queued: q }; };
  // gaps first (queued), then the missing nonces (promote), then a block takes some (prune)
  for (const k of keys) for (const n of [3n, 5n, 2n]) mp.add(signTx({ nonce: n, to: B.addr, gasLimit: 21000, gasPrice: p.minBaseFee }, k.sk, p).raw, view, p.minBaseFee);
  assert.deepEqual(mp.counts(), slow());
  assert.equal(mp.counts().queued, 9);
  for (const k of keys) for (const n of [0n, 1n]) mp.add(signTx({ nonce: n, to: B.addr, gasLimit: 21000, gasPrice: p.minBaseFee }, k.sk, p).raw, view, p.minBaseFee);
  assert.deepEqual(mp.counts(), slow());
  assert.equal(mp.counts().queued, 3, 'nonce 5 stays behind the gap at 4');
  accounts.get(bytesToHex(A.addr)).nonce = 3n;
  mp.prune(view);
  assert.deepEqual(mp.counts(), slow());
  assert.equal(mp.size, 12);
});

test('sync detection: a stale tip and a peer still delivering means syncing; a peer that only claims a high score does not', async () => {
  const t = await testChain({ start: Math.floor(Date.now() / 1000) - 3600 });
  t.advance(10); await mineOne(t, A);
  const p2p = new P2P({ params: t.params, chain: t.chain, mempool: t.mempool, genesisHash: t.genesis.hash, listenPort: null, seeds: [] });
  const peer = { ready: true, kind: 'outbound', blueScore: t.chain.tip.blueScore + 500, syncMore: true };
  p2p.peers.add(peer);
  assert.deepEqual(p2p.syncing(), { blueScore: t.chain.tip.blueScore, target: t.chain.tip.blueScore + 500 });
  peer.syncMore = false;
  assert.equal(p2p.syncing(), null, 'not delivering any more: the node may mine again (a halted network can restart)');
  peer.syncMore = true;
  // a fresh tip: never syncing, whatever a peer claims
  t.setTime(Math.floor(Date.now() / 1000));
  t.advance(10); await mineOne(t, A);
  assert.equal(p2p.syncing(), null);
  // templates are refused while syncing
  t.setTime(Math.floor(Date.now() / 1000) - 7200);
  const rpc = new Rpc({ chain: t.chain, mempool: t.mempool, p2p: { syncing: () => ({ blueScore: 3, target: 900 }) } });
  await assert.rejects(rpc.methods.psy_getBlockTemplate.call(rpc, '0x' + hex(A.addr)), (e) => e.code === -32005 && /still syncing/.test(e.message));
  assert.deepEqual(rpc.methods.eth_syncing.call(rpc), { startingBlock: '0x0', currentBlock: '0x3', highestBlock: '0x384' });
});

test('sync batches: the next batch is asked for when the last one is in, whatever else is requested from the peer', async () => {
  const t = await testChain();
  t.advance(10);
  const raw = await blockOn(t, [t.chain.tip.hash], A);
  const x = bytesToHex(decodeBlock(raw).hash);
  const p2p = new P2P({ params: t.params, chain: t.chain, mempool: t.mempool, genesisHash: t.genesis.hash, listenPort: null, seeds: [], onBlock: (r) => t.chain.addBlock(r) });
  const fake = () => ({ ready: true, kind: 'full', outbound: true, blueScore: 9000, syncMore: true, inQueue: 1, socket: { destroyed: false }, known: new Set(), sent: [], sendRlp(type) { this.sent.push(type); } });
  // the batch's last block arrives while an announced tip block (an orphan whose parents are far away) is still due
  const peer = fake();
  p2p.peers.add(peer);
  peer.batch = new Set([x]);
  p2p.markRequested(x, peer);
  p2p.markRequested('ab'.repeat(32), peer);
  await p2p.onBlockMsg(peer, raw);
  assert.deepEqual(peer.sent, [MSG.GETCHAIN], 'the next batch is asked for at once (v10.0.1 waited, and stalled every 1,000 blocks)');
  assert.equal(peer.syncMore, false);
  // stall recovery: a batch block that never came, other requests still due, nothing new for 15 s
  p2p.peers.delete(peer);
  const stalled = fake(), lost = 'cd'.repeat(32), ago = Date.now() - 20_000;
  p2p.peers.add(stalled);
  stalled.batch = new Set([lost]);
  stalled.batchAt = stalled.chainAskedAt = p2p.lastProgress = ago;
  p2p.markRequested(lost, stalled);
  p2p.markRequested('ef'.repeat(32), stalled);
  p2p.resync();
  assert.deepEqual(stalled.sent, [MSG.GETCHAIN], 'asked again from our tip');
  assert.equal(p2p.recentlyRequested(lost), false, 'and the lost block may be requested again');
  // a batch still arriving is left alone
  stalled.sent = [];
  stalled.batch = new Set([lost]);
  stalled.batchAt = Date.now();
  stalled.chainAskedAt = ago;
  p2p.resync();
  assert.deepEqual(stalled.sent, []);
});

test('cold store: old blocks leave memory and are read back on demand; new blocks still connect', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psy-cold-'));
  const store = new Store(dir);
  try {
    const t = await testChain({ params: { finalityDepth: 20, mergeDepth: 5 }, cold: store });
    for (let i = 0; i < 3; i++) { t.advance(10); await mineOne(t, A); }
    const tx = signTx({ nonce: 0n, to: B.addr, value: 7n, gasLimit: 21000, gasPrice: 2_000_000_000n }, A.sk, t.params);
    await t.chain.readAtTip((view, ctx) => t.mempool.add(tx.raw, view, ctx.baseFee, ctx.timestamp));
    for (let i = 0; i < 2; i++) { t.advance(10); await mineOne(t, A); }
    const loc = t.chain.txIndex.get(hex(tx.hash));
    assert.ok(loc, 'the transfer was accepted');
    const early = t.chain.dag.get(t.chain.chain[2]);
    const rawBefore = hex(early.raw), receiptsBefore = JSON.stringify(t.chain.dag.get(loc.block ?? t.chain.chain[5])?.receipts ?? [], (k, v) => (typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? hex(v) : v));
    for (let i = 0; i < 140; i++) { t.advance(10); await mineOne(t, A); }
    const frozen = t.chain.dag.get(early.hash);
    assert.ok(frozen.coldAt !== undefined, 'the early block was moved to the cold store');
    assert.equal(frozen.blueAnticone, null, 'its GHOSTDAG working data is gone');
    assert.ok(!Object.hasOwn(frozen, 'raw') && !Object.hasOwn(frozen, 'receipts'), 'raw and receipts are read on demand');
    assert.equal(hex(frozen.raw), rawBefore, 'and read back the same bytes');
    assert.equal(hex(frozen.hashBytes), early.hash, 'hash bytes rebuilt');
    assert.equal(hex(frozen.stateRoot), hex(early.stateRoot), 'state root from the cold record');
    for (const k of ['timestamp', 'target', 'miner', 'blueScore']) assert.deepEqual(frozen.header[k], early.header[k], 'header.' + k + ' kept');
    for (const k of ['parents', 'stateRoot', 'minerSig', 'nonce']) assert.deepEqual(frozen.header[k], early.header[k], 'header.' + k + ' read back');
    assert.equal(frozen.chainHeight, early.chainHeight);
    assert.deepEqual([...frozen.children], [...early.children]);
    const rpc = new Rpc({ chain: t.chain, mempool: t.mempool });
    const r = rpc.methods.eth_getTransactionReceipt.call(rpc, '0x' + hex(tx.hash));
    assert.equal(r.status, '0x1', 'an old receipt is still served');
    assert.ok(rpc.methods.eth_getBlockByNumber.call(rpc, '0x2', true), 'an old block is still served');
    assert.ok(receiptsBefore.length > 2);
    t.advance(10);
    assert.equal((await mineOne(t, A)).status, 'added', 'the chain keeps growing');
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('starting: while blocks are replayed, /health answers 503 with the progress and pages say the node is starting', async () => {
  const t = await testChain();
  const node = { startup: { replayed: 250, of: 1000 } };
  const server = await startingServer(node, t.genesis, { httpPort: 0, httpHost: '127.0.0.1' });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const h = await fetch(base + '/health');
    assert.equal(h.status, 503);
    const j = await h.json();
    assert.equal(j.starting, true);
    assert.equal(j.replayed, 250);
    assert.equal(j.genesis, '0x' + hex(t.genesis.hash));
    const page = await fetch(base + '/');
    assert.match(await page.text(), /250 of 1,000 \(25 %\)/);
    const rpcRes = await fetch(base + '/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await rpcRes.json()).error.code, -32005, 'JSON-RPC gets a JSON error, never HTML');
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('peer blocks are proof-of-work checked in a worker thread, with the same answer as the main thread', async () => {
  const { PowPool } = await import('../src/powpool.js');
  const { checkPow } = await import('../../common/pow.js');
  const { decodeBlock } = await import('../src/block.js');
  const t = await testChain();
  t.advance(10);
  await mineOne(t, A);
  const b = decodeBlock(t.chain.tip.raw);
  const pool = new PowPool({ pow: t.params.pow });
  try {
    assert.ok(pool.worker, 'the worker started');
    assert.equal(await pool.check(b.headerRaw, b.header.target), true, 'a solved header passes');
    assert.equal(await pool.check(b.headerRaw, 0n), checkPow(b.headerRaw, 0n, t.params.pow), 'an impossible target fails the same way');
    const many = await Promise.all(Array.from({ length: 20 }, () => pool.check(b.headerRaw, b.header.target)));
    assert.ok(many.every(Boolean), 'many checks in a row');
  } finally {
    pool.close();
  }
});
