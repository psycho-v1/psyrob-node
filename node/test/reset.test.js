// Data of another genesis: a node started on a data folder of another network moves the old blocks aside and starts
// from its own genesis; restarting on its own data keeps its blocks.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Node } from '../src/node.js';
import { blockOn, key } from './helpers.js';

test('a node on data of another genesis archives it and starts from its own genesis; its own data is replayed', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-reset-'));
  const genesis = (dev) => {
    const f = path.join(dir, `genesis-${dev}.json`);
    fs.writeFileSync(f, JSON.stringify({ config: { chainId: 1337, timestamp: Math.floor(Date.now() / 1000) - 600, target: '0x' + ((1n << 256n) / 4n).toString(16), devBeneficiary: '0x' + dev.repeat(20) }, params: { pow: { memoryKiB: 8, iterations: 1 } } }));
    return f;
  };
  const oldG = genesis('22'), newG = genesis('33');
  const port = 62600 + Math.floor(Math.random() * 300);
  const logs = [];
  const mk = (gf) => new Node({ genesisFile: gf, datadir: path.join(dir, 'data'), p2pHost: '127.0.0.1', p2pPort: port, seeds: [], httpHost: '127.0.0.1', httpPort: port + 1, log: (m) => logs.push(String(m)) });
  try {
    let n = await mk(oldG).start();
    const t = { chain: n.chain, now: () => Math.floor(Date.now() / 1000) };
    for (let i = 0; i < 3; i++) await n.submitBlock(await blockOn(t, [...n.chain.dag.tips], key(1)));
    assert.equal(n.chain.tip.chainHeight, 3);
    await n.stop();

    n = await mk(oldG).start();
    assert.equal(n.chain.tip.chainHeight, 3, 'its own blocks are replayed');
    await n.stop();

    n = await mk(newG).start();
    assert.equal(n.chain.tip.chainHeight, 0, 'the new network starts from its genesis');
    const moved = fs.readdirSync(path.join(dir, 'data')).filter((f) => f.startsWith('old-network-'));
    assert.equal(moved.length, 1);
    assert.ok(fs.statSync(path.join(dir, 'data', moved[0], 'blocks.dat')).size > 0, 'the old blocks are kept aside, not deleted');
    assert.ok(logs.some((l) => l.includes('belong to another genesis')));
    const t2 = { chain: n.chain, now: () => Math.floor(Date.now() / 1000) };
    await n.submitBlock(await blockOn(t2, [...n.chain.dag.tips], key(1)));
    await n.stop();

    n = await mk(newG).start();
    assert.equal(n.chain.tip.chainHeight, 1, 'and its new block is replayed after a restart');
    assert.equal(fs.readdirSync(path.join(dir, 'data')).filter((f) => f.startsWith('old-network-')).length, 1, 'nothing archived again');
    await n.stop();
  } finally {
    try { fs.rmSync(dir, { recursive: true }); } catch { /* temp */ }
  }
});
