// Real P2P network on localhost: five nodes, five separate miners, 2 s of added delay on every received block.
// Then a sixth node joins late and must sync the whole DAG, including tips no chain block has merged yet.
// Chain 1337 with 8 KiB Argon2d; nice 19 on two cores like every test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Node } from '../src/node.js';
import { Miner } from '../../miner/src/miner.js';
import { metrics } from './dagsim.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-dagnet-'));
const port = 61400 + Math.floor(Math.random() * 250);

test('five nodes, five miners, 2 s delay: a real block DAG with zero orphans; a late node syncs every block', { timeout: 300_000 }, async () => {
  const genesisFile = path.join(dir, 'genesis.json');
  fs.writeFileSync(genesisFile, JSON.stringify({
    config: { chainId: 1337, timestamp: Math.floor(Date.now() / 1000) - 600, target: '0x' + ((1n << 256n) / 4000n).toString(16), devBeneficiary: '0x' + '22'.repeat(20) },
    params: { pow: { memoryKiB: 8, iterations: 1 } },
  }));
  const nodes = [], miners = [];
  const mk = (i, seeds) => new Node({ genesisFile, datadir: path.join(dir, 'n' + i), p2pHost: '127.0.0.1', p2pPort: port + 2 * i, seeds, httpHost: '127.0.0.1', httpPort: port + 2 * i + 1, log: () => {}, p2pDelayMs: 2000 });
  try {
    for (let i = 0; i < 5; i++) nodes.push(await mk(i, i ? [`127.0.0.1:${port}`] : []).start());
    await sleep(3000);
    for (let i = 0; i < 5; i++) {
      const sk = Uint8Array.from(Buffer.from('3' + i + '11'.repeat(31), 'hex'));
      const m = new Miner({ url: `http://127.0.0.1:${port + 2 * i + 1}`, key: sk, threads: 1, refreshSeconds: 3, log: () => {}, impl: 'wasm-simd' });
      await m.start();
      miners.push(m);
    }
    const end = Date.now() + 60_000;
    while (Date.now() < end && nodes[0].chain.dag.blocks.size < 80) await sleep(1000);
    for (const m of miners) await m.stop();
    // let the delayed blocks arrive everywhere
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      const sizes = nodes.map((n) => n.chain.dag.blocks.size);
      if (sizes.every((x) => x === sizes[0])) break;
    }
    const sets = nodes.map((n) => new Set(n.chain.dag.blocks.keys()));
    const union = new Set(sets.flatMap((x) => [...x]));
    const produced = [...union].map((h) => ({ hash: h }));
    for (const s of sets) assert.equal(s.size, union.size, 'every node holds every block (zero orphaned or lost)');
    const m = metrics(nodes[0].chain, produced);
    console.log('# real network, 5 miners, 2 s delay:', JSON.stringify({ ...m, width: m.width.toFixed(2), multiParentShare: (100 * m.multiParentShare).toFixed(1) + ' %', tips: nodes[0].chain.dag.tips.size }));
    assert.ok(m.multiParentShare > 0.1, 'parallel blocks were produced and merged');
    assert.equal(m.orphaned, 0);
    // a late node syncs everything, including unmerged tips
    const late = await mk(5, [`127.0.0.1:${port}`]).start();
    nodes.push(late);
    for (let i = 0; i < 60 && late.chain.dag.blocks.size < union.size; i++) await sleep(1000);
    assert.equal(late.chain.dag.blocks.size, union.size, 'the late node synced every DAG block');
    assert.equal(late.chain.dag.tips.size, nodes[0].chain.dag.tips.size, 'including the unmerged tips');
    assert.equal(late.chain.tip.hash, nodes[0].chain.tip.hash);
    console.log(`# late node synced ${late.chain.dag.blocks.size} blocks and ${late.chain.dag.tips.size} tips`);
  } finally {
    for (const m of miners) await m.stop().catch(() => {});
    for (const n of nodes) await n.stop().catch(() => {});
    try { fs.rmSync(dir, { recursive: true }); } catch { /* temp */ }
  }
});

test('sync includes parallel tips that no chain block has merged yet', { timeout: 120_000 }, async () => {
  const { blockOn, key } = await import('./helpers.js');
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-tips-'));
  const gf = path.join(d2, 'genesis.json');
  fs.writeFileSync(gf, JSON.stringify({ config: { chainId: 1337, timestamp: Math.floor(Date.now() / 1000) - 600, target: '0x' + ((1n << 256n) / 4n).toString(16), devBeneficiary: '0x' + '22'.repeat(20) }, params: { pow: { memoryKiB: 8, iterations: 1 } } }));
  const p2 = port + 100;
  const mk = (i, seeds) => new Node({ genesisFile: gf, datadir: path.join(d2, 'n' + i), p2pHost: '127.0.0.1', p2pPort: p2 + 2 * i, seeds, httpHost: '127.0.0.1', httpPort: p2 + 2 * i + 1, log: () => {} });
  const A = await mk(0, []).start();
  let B;
  try {
    const t = { chain: A.chain, now: () => Math.floor(Date.now() / 1000) };
    await A.chain.addBlock(await blockOn(t, [A.chain.tip.hash], key(1)));
    const base = A.chain.tip.hash;
    const x = await blockOn(t, [base], key(2)), y = await blockOn(t, [base], key(3));
    await A.chain.addBlock(x);
    await A.chain.addBlock(y);
    assert.equal(A.chain.dag.tips.size, 2);
    B = await mk(1, [`127.0.0.1:${p2}`]).start();
    for (let i = 0; i < 30 && B.chain.dag.blocks.size < A.chain.dag.blocks.size; i++) await sleep(500);
    assert.equal(B.chain.dag.blocks.size, 4);
    assert.equal(B.chain.dag.tips.size, 2, 'both unmerged tips were synced');
  } finally {
    await B?.stop().catch(() => {});
    await A.stop().catch(() => {});
    try { fs.rmSync(d2, { recursive: true }); } catch { /* temp */ }
  }
});
