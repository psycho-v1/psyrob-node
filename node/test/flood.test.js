// Block flooding and empty-block abuse (risk review Part 4).

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testChain, key, mineOne, blockOn, solve } from './helpers.js';
import { decodeBlock, encodeBlock, decodeCert, encodeCert } from '../src/block.js';
import { BlockError, nextBaseFee } from '../src/consensus.js';
import { signTx } from '../src/tx.js';
import { Node } from '../src/node.js';
import * as rlp from '../../common/rlp.js';
import { bytesToHex, fromHex } from '../../common/bytes.js';
import { asertNextTarget } from '../src/asert.js';
import { banKey } from '../src/p2p.js';

const A = key(1), B = key(2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Blocks at a constant hash rate `rate` (× the rate that gives 10 s at the genesis target): interval = 10 s × T / (T0 × rate). */
function asertRun({ rate, blocks, count }) {
  // count = 'all' (DAA score) or 'blue' (only every other block counts, as when half the flood is red)
  const T0 = (1n << 256n) / 1000n, p = { targetSpacing: 10, asertHalfLife: 900, powLimit: T0 * 16n };
  const anchor = { target: T0, parentTimestamp: -10, number: 0 };
  let t = 0, score = 0, target = T0, firstBack = null;
  for (let i = 1; i <= blocks; i++) {
    const interval = 10 * Number(T0 * 1000n / target) / 1000 / rate; // expected seconds at this target
    t += interval;
    score += count === 'all' ? 1 : (i % 2 ? 1 : 0);
    target = asertNextTarget(anchor, Math.floor(t), score, p);
    if (firstBack === null && i > 5 && 10 * Number(T0 * 1000n / target) / 1000 / rate >= 9) firstBack = { block: i, seconds: Math.round(t) };
  }
  return { finalInterval: 10 * Number(T0 * 1000n / target) / 1000 / rate, firstBack, difficultyFactor: Number(T0 * 1000n / target) / 1000 };
}

test('difficulty: a sudden 10x jump in block rate is absorbed; counting all blocks reacts, counting blue only would not see red floods', () => {
  const all = asertRun({ rate: 10, blocks: 2000, count: 'all' });
  const blueOnly = asertRun({ rate: 10, blocks: 2000, count: 'blue' });
  console.log('# 10x hash rate jump, DAA counts every block:', JSON.stringify(all));
  console.log('# same jump if half the blocks were red and only blue counted:', JSON.stringify(blueOnly));
  assert.ok(all.firstBack && all.firstBack.seconds < 3600, 'back to >= 9 s per block within an hour');
  assert.ok(all.finalInterval > 9.5 && all.finalInterval < 10.5);
  assert.ok(blueOnly.finalInterval < all.finalInterval, 'blue-only counting lets red floods run faster');
});

test('difficulty: a flood of parallel blocks raises the DAA score by every block, red ones included', async () => {
  const t = await testChain({ params: { k: 3, mergesetLimit: 40 } });
  t.advance(10);
  await mineOne(t, A);
  const base = t.chain.tip.hash;
  t.advance(10);
  for (let i = 0; i < 8; i++) await t.chain.addBlock(await blockOn(t, [base], key(20 + i)));
  t.advance(10);
  const r = await mineOne(t, A);
  const e = r.entry, sp = t.chain.dag.get(e.selectedParent);
  assert.equal(e.mergesetReds.length, 4); // k = 3: four of the eight flood blocks are red
  assert.equal(e.daaScore - sp.daaScore, 8); // the 7 newly merged flood blocks plus the block itself (the 8th is the selected parent)
  assert.equal(e.blueScore - sp.blueScore, 4 + 1 - 1); // blue score counts only blues (the selected parent is one of them)
  // the next block's target is lower (harder) than if only blue blocks counted
  const anchor = { target: t.genesis.header.target, parentTimestamp: t.chain.genesisTime - 10, number: 0 };
  const hard = t.chain.expectedTarget(e);
  const soft = asertNextTarget(anchor, e.header.timestamp, e.blueScore, { ...t.params, powLimit: t.chain.powLimit });
  assert.ok(hard < soft);
});

test('junk blocks are refused cheaply, in order of cost; Argon2d only runs for blocks that pass every cheap check', async () => {
  const t = await testChain({ params: { pow: { memoryKiB: 32768, iterations: 1 } }, target: (1n << 256n) / 32n });
  t.advance(10);
  const good = await blockOn(t, [t.chain.tip.hash], A);
  const b = decodeBlock(good);
  const time = async (raw) => { const s = performance.now(); let err; try { await t.chain.addBlock(raw); } catch (e) { err = e; } return { ms: performance.now() - s, err }; };
  // 1. an easier target than the difficulty rule allows: refused before any proof-of-work check
  const easy = { ...b.header, target: b.header.target * 2n };
  const r1 = await time(encodeBlock(solve(easy, A.sk, { pow: { memoryKiB: 8, iterations: 1 } }) && easy, b.txRaws, []));
  assert.match(r1.err.message, /wrong target/);
  // 2. a wrong body: refused before the signature and proof-of-work checks
  const r2 = await time(encodeBlock({ ...b.header, txRoot: new Uint8Array(32) }, b.txRaws, []));
  assert.match(r2.err.message, /body does not match/);
  // 3. correct fields but no valid proof of work: one 32 MiB Argon2d check, then refused (ban 100)
  let bad = null;
  for (let n = 0n; n < 50n && !bad; n++) {
    const h = { ...b.header, nonce: 1_000_000n + n };
    const { signHeader, encodeHeader } = await import('../../common/header.js');
    const { checkPow } = await import('../../common/pow.js');
    signHeader(h, A.sk);
    if (!checkPow(encodeHeader(h), h.target, t.params.pow)) bad = h;
  }
  const r3 = await time(encodeBlock(bad, b.txRaws, []));
  assert.match(r3.err.message, /proof of work/);
  assert.equal(r3.err.ban, 100);
  // 4. an orphan (unknown parents) claiming an implausibly easy target: refused without proof of work
  const orphan = { ...b.header, parents: [new Uint8Array(32).fill(7)], target: (1n << 256n) - 1n };
  const r4 = await time(encodeBlock(orphan, b.txRaws, []));
  assert.match(r4.err.message, /implausible target/);
  console.log(`# cost of refusing: wrong target ${r1.ms.toFixed(1)} ms, wrong body ${r2.ms.toFixed(1)} ms, bad proof of work ${r3.ms.toFixed(1)} ms (32 MiB Argon2d), implausible orphan ${r4.ms.toFixed(1)} ms`);
  assert.ok(r1.ms < r3.ms && r2.ms < r3.ms && r4.ms < r3.ms);
  // the real block still goes in
  assert.equal((await t.chain.addBlock(good)).status, 'added');
});

test('bloat limits: certificates carry at most 21 signatures; timestamps bounded both ways; at most 10 parents', async () => {
  const sig = new Uint8Array(65);
  const cert = { number: 1, chainBlock: new Uint8Array(32), stateRoot: new Uint8Array(32), epoch: 0, sigs: Array(22).fill(sig) };
  assert.throws(() => decodeCert(rlp.decode(rlp.encode(encodeCert(cert)))), /at most 21/);
  const t = await testChain();
  t.advance(10);
  await mineOne(t, A);
  const raw = await blockOn(t, [t.chain.tip.hash], B, { timestamp: t.now() + 1000 });
  await assert.rejects(t.chain.addBlock(raw), /future/);
  const past = await blockOn(t, [t.chain.tip.hash], B, { timestamp: t.chain.genesisTime });
  await assert.rejects(t.chain.addBlock(past), /past median time/);
  const { decodeHeader, encodeHeader, signHeader } = await import('../../common/header.js');
  const h = decodeBlock(await blockOn(t, [t.chain.tip.hash], B)).header;
  const many = { ...h, parents: Array.from({ length: 11 }, (_, i) => new Uint8Array(32).fill(i + 1)) };
  signHeader(many, B.sk);
  assert.throws(() => decodeHeader(encodeHeader(many)), /1 to 10 parents/);
});

// ---------------------------------------------------------------- censorship by empty blocks

async function censorshipRun({ miners = 10, censors = 3, blocks = 90, delay = 2, seed = 11 }) {
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const start = 1_800_000_000;
  const nodes = [];
  for (let i = 0; i < miners; i++) nodes.push({ t: await testChain({ start }), key: key(100 + i), censor: i < censors });
  const users = Array.from({ length: 6 }, (_, i) => key(150 + i));
  let now = start;
  const events = [];
  const exp = (m) => -Math.log(1 - rand()) * m;
  events.push({ at: now + exp(10), kind: 'find', node: Math.floor(rand() * miners) });
  const sent = new Map(); // tx hash -> sent time
  const nonces = new Map();
  let produced = 0;
  while (produced < blocks) {
    events.sort((a, b) => a.at - b.at);
    const ev = events.shift();
    now = ev.at;
    for (const n of nodes) n.t.setTime(Math.floor(now));
    if (ev.kind === 'deliver') { await nodes[ev.node].t.chain.addBlock(ev.raw); continue; }
    if (ev.kind === 'tx') {
      for (const n of nodes) if (!n.censor) { try { await n.t.chain.readAtTip((v, ctx) => n.t.mempool.add(ev.raw, v, ctx.baseFee)); } catch { /* not yet valid here */ } }
      continue;
    }
    const n = nodes[ev.node];
    const r = await mineOne(n.t, n.key);
    const raw = n.t.chain.dag.get(r.hash).raw;
    for (let j = 0; j < miners; j++) if (j !== ev.node) events.push({ at: now + delay * (0.75 + 0.5 * rand()), kind: 'deliver', node: j, raw });
    produced++;
    // after 20 blocks, the miners fund the users; then users send a transfer every ~5 s (to honest nodes; censors ignore them)
    if (produced === 20) {
      for (const u of users) {
        const m = nodes[nodes.length - 1];
        const nonce = nonces.get('m') ?? m.t.chain.state.getAccount(m.key.addr).nonce;
        nonces.set('m', nonce + 1n);
        const tx = signTx({ type: 2, nonce, to: u.addr, value: 10n ** 17n, gasLimit: 21000, maxFee: 10_000_000_000n, maxPriorityFee: 1n }, m.key.sk, m.t.params);
        events.push({ at: now + 0.1, kind: 'tx', raw: tx.raw });
      }
    }
    if (produced >= 30 && produced <= blocks - 20) {
      const u = users[produced % users.length];
      const nonce = nonces.get(u) ?? 0n;
      nonces.set(u, nonce + 1n);
      const tx = signTx({ type: 2, nonce, to: new Uint8Array(20).fill(0xaa), value: 1n, gasLimit: 21000, maxFee: 10_000_000_000n, maxPriorityFee: 1n }, u.sk, nodes[0].t.params);
      sent.set(bytesToHex(tx.hash), now + 0.2);
      events.push({ at: now + 0.2, kind: 'tx', raw: tx.raw });
    }
    events.push({ at: now + exp(10), kind: 'find', node: Math.floor(rand() * miners) });
  }
  for (const ev of events.sort((a, b) => a.at - b.at)) if (ev.kind === 'deliver') await nodes[ev.node].t.chain.addBlock(ev.raw);
  const c = nodes[miners - 1].t.chain;
  const delays = [];
  let missing = 0;
  for (const [h, at] of sent) {
    const loc = c.txIndex.get(h);
    if (!loc) { missing++; continue; }
    delays.push(c.dag.get(loc.block).header.timestamp - at);
  }
  delays.sort((a, b) => a - b);
  const mean = delays.reduce((a, b) => a + b, 0) / delays.length;
  return { sent: sent.size, confirmed: delays.length, missing, meanDelay: +mean.toFixed(1), p90: +delays[Math.floor(delays.length * 0.9)].toFixed(1) };
}

test('censorship: a miner with 30 % of the hash rate mining only empty blocks delays, but does not stop, transactions', { timeout: 900_000 }, async () => {
  const base = await censorshipRun({ censors: 0 });
  const att = await censorshipRun({ censors: 3 });
  console.log('# no censor:', JSON.stringify(base));
  console.log('# 30 % mining only empty blocks:', JSON.stringify(att));
  assert.equal(att.missing, 0, 'every transaction is confirmed');
  assert.ok(att.meanDelay < base.meanDelay * 2 + 10, 'the delay stays within a small multiple of the normal delay');
});

// ---------------------------------------------------------------- peers and floods on the real network stack

test('a peer sending an invalid block is disconnected; unsolicited floods are capped; a new node syncs after a flood', { timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-flood-'));
  const gf = path.join(dir, 'genesis.json');
  fs.writeFileSync(gf, JSON.stringify({ config: { chainId: 1337, timestamp: Math.floor(Date.now() / 1000) - 3600, target: '0x' + ((1n << 256n) / 4n).toString(16), devBeneficiary: '0x' + '22'.repeat(20) }, params: { pow: { memoryKiB: 8, iterations: 1 } } }));
  const port = 61800 + Math.floor(Math.random() * 300);
  const mk = (i, seeds) => new Node({ genesisFile: gf, datadir: path.join(dir, 'n' + i), p2pHost: '127.0.0.1', p2pPort: port + 2 * i, seeds, httpHost: '127.0.0.1', httpPort: port + 2 * i + 1, log: process.env.FLOOD_LOG ? (m) => console.log('NODE', m) : () => {} });
  const N = await mk(0, []).start();
  let L;
  try {
    // a raw peer: handshake, then an invalid block
    const hello = (sock) => {
      const p = N.params, t = N.chain.tip;
      const payload = rlp.encode([rlp.int(p.protocolVersion), rlp.int(p.chainId), N.chain.genesisHash, rlp.int(0), t.hashBytes, rlp.int(0), new Uint8Array(16).fill(9), new Uint8Array(0)]);
      sock.write(frame(1, payload));
    };
    const frame = (type, payload) => { const f = Buffer.alloc(9 + payload.length); f.writeUInt32BE(N.params.networkMagic, 0); f.writeUInt8(type, 4); f.writeUInt32BE(payload.length, 5); f.set(payload, 9); return f; };
    const connect = () => new Promise((res) => { const s = net.connect(port, '127.0.0.1', () => { hello(s); setTimeout(() => res(s), 300); }); s.on('error', () => {}); s.resume(); /* read and discard, so 'close' is delivered */ });
    const s1 = await connect();
    let closed = false;
    s1.on('close', () => { closed = true; });
    const t = { chain: N.chain, now: () => Math.floor(Date.now() / 1000) };
    const good = decodeBlock(await blockOn(t, [N.chain.tip.hash], A));
    s1.write(frame(8, encodeBlock({ ...good.header, stateRoot: new Uint8Array(32) }, good.txRaws, []))); // the miner signature no longer matches
    for (let i = 0; i < 40 && !closed; i++) await sleep(250);
    assert.ok(closed, 'the peer that sent an invalid block was disconnected');
    // the ban is by address: reconnecting with a new node ID is refused before any handshake
    assert.equal(N.p2p.banned('127.0.0.1'), true);
    const again = await new Promise((res) => { const s = net.connect(port, '127.0.0.1'); s.resume(); s.on('error', () => {}); s.on('close', () => res('closed')); setTimeout(() => res('open'), 2000); });
    assert.equal(again, 'closed', 'a banned address cannot come back with a new node ID');
    N.p2p.bans.clear(); // this test continues from the same address
    // a flood of 120 valid but unsolicited parallel blocks from one connection: at most the budget is checked at once
    const s2 = await connect();
    const flood = [];
    for (let i = 0; i < 120; i++) flood.push(await blockOn(t, [N.chain.tip.hash], key(30 + (i % 50))));
    for (const raw of flood) s2.write(frame(8, raw));
    await sleep(4000);
    const dropped = N.p2p.droppedUnsolicited ?? 0;
    console.log(`# unsolicited flood of 120 blocks over one connection: ${N.chain.dag.blocks.size - 1} checked and added, ${dropped} dropped by the peer's share`);
    assert.ok(dropped > 0, 'the budget dropped part of the flood');
    assert.equal(N.chain.dag.blocks.size - 1 + dropped, 120);
    // the node keeps working: a normal block still goes in, merging the flood
    await N.chain.addBlock(await blockOn(t, [...N.chain.dag.tips].slice(0, 10), A));
    // a new node syncs everything after the flood
    const t0 = Date.now();
    L = await mk(1, [`127.0.0.1:${port}`]).start();
    for (let i = 0; i < 60 && L.chain.dag.blocks.size < N.chain.dag.blocks.size; i++) await sleep(500);
    console.log(`# a new node synced ${L.chain.dag.blocks.size} blocks after the flood in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    assert.equal(L.chain.dag.blocks.size, N.chain.dag.blocks.size);
    s2.destroy();
  } finally {
    await L?.stop().catch(() => {});
    await N.stop().catch(() => {});
    try { fs.rmSync(dir, { recursive: true }); } catch { /* temp */ }
  }
});

export { nextBaseFee, BlockError, fromHex };

test('bans cover an IPv6 /64 and IPv4 addresses, never peer IDs', () => {
  assert.equal(banKey('2001:db8:1:2:aaaa::1'), banKey('2001:0db8:0001:0002:ffff:1:2:3'));
  assert.notEqual(banKey('2001:db8:1:3::1'), banKey('2001:db8:1:2::1'));
  assert.equal(banKey('::ffff:203.0.113.7'), '203.0.113.7');
});

test('fair share: four flooding connections cannot crowd out an honest peer\'s new block', { timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-share-'));
  const gf = path.join(dir, 'genesis.json');
  fs.writeFileSync(gf, JSON.stringify({ config: { chainId: 1337, timestamp: Math.floor(Date.now() / 1000) - 3600, target: '0x' + ((1n << 256n) / 4n).toString(16), devBeneficiary: '0x' + '22'.repeat(20) }, params: { pow: { memoryKiB: 8, iterations: 1 } } }));
  const port = 62200 + Math.floor(Math.random() * 300);
  const mk = (i, seeds) => new Node({ genesisFile: gf, datadir: path.join(dir, 'n' + i), p2pHost: '127.0.0.1', p2pPort: port + 2 * i, seeds, httpHost: '127.0.0.1', httpPort: port + 2 * i + 1, log: () => {} });
  const N = await mk(0, []).start();
  let H;
  const socks = [];
  try {
    H = await mk(1, [`127.0.0.1:${port}`]).start();
    for (let i = 0; i < 40 && ![...N.p2p.peers].some((p) => p.ready); i++) await sleep(250);
    const frame = (type, payload) => { const f = Buffer.alloc(9 + payload.length); f.writeUInt32BE(N.params.networkMagic, 0); f.writeUInt8(type, 4); f.writeUInt32BE(payload.length, 5); f.set(payload, 9); return f; };
    const t = { chain: N.chain, now: () => Math.floor(Date.now() / 1000) };
    const flood = [];
    for (let i = 0; i < 200; i++) flood.push(await blockOn(t, [N.chain.tip.hash], key(40 + (i % 50))));
    for (let c = 0; c < 4; c++) {
      const s = await new Promise((res) => { const s = net.connect(port, '127.0.0.1', () => {
        s.write(frame(1, rlp.encode([rlp.int(N.params.protocolVersion), rlp.int(N.params.chainId), N.chain.genesisHash, rlp.int(0), N.chain.tip.hashBytes, rlp.int(0), new Uint8Array(16).fill(c + 1), new Uint8Array(0)])));
        setTimeout(() => res(s), 300); }); s.resume(); s.on('error', () => {}); });
      socks.push(s);
    }
    const t0 = Date.now();
    for (let i = 0; i < flood.length; i++) socks[i % 4].write(frame(8, flood[i]));
    // meanwhile the honest node gets a new block and relays it (announce, then send on request)
    await sleep(300);
    const th = { chain: H.chain, now: () => Math.floor(Date.now() / 1000) };
    const honest = await blockOn(th, [H.chain.tip.hash], key(9));
    const r = await H.chain.addBlock(honest);
    let got = null;
    for (let i = 0; i < 40 && got === null; i++) { if (N.chain.dag.has(r.hash)) got = Date.now() - t0; else await sleep(250); }
    const secs = (Date.now() - t0) / 1000;
    const attackers = [...N.p2p.peers].filter((p) => !p.outbound && p.dropped);
    const checked = 200 - N.p2p.droppedUnsolicited;
    console.log(`# 4 flooding connections sent 200 unsolicited blocks: ${checked} checked, ${N.p2p.droppedUnsolicited} dropped; the honest block arrived after ${got} ms`);
    assert.ok(got !== null, 'the honest block was accepted during the flood');
    assert.ok(checked <= 4 * (4 + 2 * Math.ceil(secs)) + 4, 'each connection used only its own share');
    assert.ok(attackers.length >= 1);
  } finally {
    for (const s of socks) s.destroy();
    await H?.stop().catch(() => {});
    await N.stop().catch(() => {});
    try { fs.rmSync(dir, { recursive: true }); } catch { /* temp */ }
  }
});
