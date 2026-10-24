// A new node syncing a long DAG with parallel blocks stays inside the seed's rate limits and is never banned: orphans
// do not re-request parents that are themselves waiting in the orphan pool.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Node } from '../src/node.js';
import { MSG } from '../src/p2p.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 600 s: 210 s alone and 244-257 s in the full suite on the 2-core public server, up to 560 s when the server
// is short of memory; the limit only catches a hang
test('a new node syncs 700+ DAG blocks from a seed without tripping its rate limits or being banned', { timeout: 600_000 }, async () => {
  const { blockOn, key } = await import('./helpers.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-syncburst-'));
  const steps = 600;
  const t0 = Math.floor(Date.now() / 1000) - 12 * (steps + 300);
  const gf = path.join(dir, 'genesis.json');
  fs.writeFileSync(gf, JSON.stringify({ config: { chainId: 1337, timestamp: t0, target: '0x' + ((1n << 256n) / 4n).toString(16), devBeneficiary: '0x' + '22'.repeat(20) }, params: { pow: { memoryKiB: 8, iterations: 1 } } }));
  const port = 63000 + Math.floor(Math.random() * 300);
  const logs = [[], []];
  const mk = (i, seeds) => new Node({ genesisFile: gf, datadir: path.join(dir, 'n' + i), p2pHost: '127.0.0.1', p2pPort: port + 2 * i, seeds, httpHost: '127.0.0.1', httpPort: port + 2 * i + 1, log: (m) => logs[i].push(String(m)) });
  const A = await mk(0, []).start();
  let B;
  try {
    // a chain with a pair of parallel blocks every fifth step, merged by the next block
    const t = { chain: A.chain, now: () => Math.floor(Date.now() / 1000) };
    let ts = t0;
    for (let i = 0; i < steps; i++) {
      ts += 12;
      if (i % 5 === 4) {
        const base = A.chain.tip.hash;
        const x = await blockOn(t, [base], key(2), { timestamp: ts }), y = await blockOn(t, [base], key(3), { timestamp: ts });
        await A.chain.addBlock(x);
        await A.chain.addBlock(y);
      } else {
        await A.chain.addBlock(await blockOn(t, [...A.chain.dag.tips], key(1), { timestamp: ts }));
      }
    }
    const total = A.chain.dag.blocks.size;
    assert.ok(total > 700);

    B = await mk(1, [`127.0.0.1:${port}`]).start();
    // a slow PC: 40 ms per block, so a 500-block batch takes longer than the 20 s a request normally stays due
    const handle = B.p2p.onBlock;
    B.p2p.onBlock = async (raw, peer) => { await sleep(40); return handle(raw, peer); };
    let getdata = 0; // GETDATA frames B sends
    const seen = new WeakSet();
    const wrap = () => { for (const p of B.p2p.peers) if (!seen.has(p)) { seen.add(p); const s = p.send.bind(p); p.send = (type, pl) => { if (type === MSG.GETDATA) getdata++; return s(type, pl); }; } };
    for (let i = 0; i < 480 && B.chain.dag.blocks.size < total; i++) { wrap(); await sleep(250); }

    const offences = logs[0].concat(logs[1]).filter((l) => /rate limit|\(\+\d+\)/.test(l));
    console.log(`# synced ${B.chain.dag.blocks.size}/${total} blocks with ${getdata} GETDATA messages; offences logged: ${offences.length}`);
    assert.deepEqual(offences.slice(0, 5), [], 'no peer misbehaved during an honest sync');
    assert.equal(A.p2p.bans.size + B.p2p.bans.size, 0, 'nobody was banned');
    assert.equal(B.chain.dag.blocks.size, total, 'every block synced');
    assert.equal(B.chain.tip.hash, A.chain.tip.hash);
    assert.equal(B.chain.orphans.size, 0, 'blocks arrived parents first');
    assert.ok(getdata < 60, 'GETDATA batched by the hundred, not one per orphan');
  } finally {
    await B?.stop().catch(() => {});
    await A.stop().catch(() => {});
    try { fs.rmSync(dir, { recursive: true }); } catch { /* temp */ }
  }
});

test('a banned client backs off and logs it, the seed logs the refusal once, and the client reconnects after the ban', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-banlog-'));
  const gf = path.join(dir, 'genesis.json');
  fs.writeFileSync(gf, JSON.stringify({ config: { chainId: 1337, timestamp: Math.floor(Date.now() / 1000) - 600, target: '0x' + ((1n << 256n) / 4n).toString(16), devBeneficiary: '0x' + '22'.repeat(20) }, params: { pow: { memoryKiB: 8, iterations: 1 } } }));
  const port = 63400 + Math.floor(Math.random() * 300);
  const logs = [[], []];
  const A = await new Node({ genesisFile: gf, datadir: path.join(dir, 'a'), p2pHost: '127.0.0.1', p2pPort: port, seeds: [], httpHost: '127.0.0.1', httpPort: port + 1, log: (m) => logs[0].push(String(m)) }).start();
  let B;
  try {
    A.p2p.ban('127.0.0.1', 'test');
    const seed = `ws://127.0.0.1:${port + 1}/p2p`;
    B = await new Node({ genesisFile: gf, datadir: path.join(dir, 'b'), p2pHost: '127.0.0.1', p2pPort: port + 2, seeds: [seed], httpHost: '127.0.0.1', httpPort: port + 3, log: (m) => logs[1].push(String(m)) }).start();
    for (let i = 0; i < 40 && !(B.p2p.wsRetry.get(seed)?.fails >= 2); i++) await sleep(250);
    await sleep(500);
    assert.ok(logs[1].some((l) => l === `p2p: connecting to ${seed}`), 'the client logs its first attempt');
    assert.ok(logs[1].some((l) => l.startsWith(`p2p: no handshake with ${seed} (attempt 1;`) && l.endsWith('retrying in 5 s')), 'and each early failure with its back-off');
    assert.equal(B.p2p.wsRetry.get(seed).fails, 2, 'one retry after 5 s, the next one 10 s later, not every 5 s');
    assert.equal(logs[0].filter((l) => l.startsWith('p2p: refused 127.0.0.1: banned until')).length, 1, 'the seed logs a refusal once per 10 minutes');
    A.p2p.bans.clear();
    for (let i = 0; i < 60 && !B.p2p.peers.size; i++) await sleep(250);
    for (let i = 0; i < 20 && ![...B.p2p.peers].some((p) => p.ready); i++) await sleep(250);
    assert.ok(logs[1].some((l) => l.startsWith(`p2p: connected to ${seed} (psyrob/`)), 'the client logs the handshake');
    for (let i = 0; i < 20 && !logs[0].some((l) => l.startsWith('p2p: inbound peer')); i++) await sleep(250);
    assert.ok(logs[0].some((l) => l.startsWith('p2p: inbound peer 127.0.0.1')), 'and so does the seed');
    assert.equal(B.p2p.wsRetry.get(seed).fails, 2);
  } finally {
    await B?.stop().catch(() => {});
    await A.stop().catch(() => {});
    try { fs.rmSync(dir, { recursive: true }); } catch { /* temp */ }
  }
});
