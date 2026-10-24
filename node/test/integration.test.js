// End to end on localhost: two nodes, the separate miner, P2P sync, a transaction sent to one node and accepted on
// both, the explorer pages, and a restart that replays the stored blocks. Chain 1337 with 8 KiB Argon2d.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Node } from '../src/node.js';
import { Miner } from '../../miner/src/miner.js';
import { privateKeyToAddress } from '../../common/crypto.js';
import { bytesToHex } from '../../common/bytes.js';
import { signTx } from '../src/tx.js';
import { makeParams } from '../src/params.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-it-'));
// ports above 61000: outside the system's range for outgoing connections (32768-60999); each test file has its own block
const port = 61000 + Math.floor(Math.random() * 300);
const quiet = process.env.IT_LOG ? (...a) => console.log(...a) : () => {};

const MINER_SK = Uint8Array.from(Buffer.from('11'.repeat(31) + '07', 'hex'));
const MINER = '0x' + bytesToHex(privateKeyToAddress(MINER_SK));

async function rpc(url, method, params = [], retry = true) {
  let r;
  try {
    r = await fetch(url + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  } catch (e) {
    if (retry) return rpc(url, method, params, false); // a pooled connection to a restarted server
    throw e;
  }
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}

async function until(fn, ms = 60_000, what = 'condition') {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(250);
  }
}

const genesisFile = path.join(dir, 'genesis.json');
fs.writeFileSync(genesisFile, JSON.stringify({
  config: { chainId: 1337, timestamp: Math.floor(Date.now() / 1000) - 600, target: '0x' + ((1n << 256n) / 3000n).toString(16), devBeneficiary: '0x' + '22'.repeat(20) },
  params: { pow: { memoryKiB: 8, iterations: 1 } },
}));

const mkNode = (name, p2pPort, httpPort, seeds = []) => new Node({
  genesisFile, datadir: path.join(dir, name), p2pHost: '127.0.0.1', p2pPort, seeds, httpHost: '127.0.0.1', httpPort, log: quiet,
});

let A, B, miner;
const urlA = `http://127.0.0.1:${port + 1}`, urlB = `http://127.0.0.1:${port + 3}`;

test('two nodes, the miner, sync, a transaction, the pages, a restart', { timeout: 300_000 }, async (t) => {
  A = await mkNode('a', port, port + 1).start();
  miner = new Miner({ url: urlA, key: MINER_SK, threads: 1, refreshSeconds: 5, log: quiet, impl: 'wasm-simd' });
  await miner.start();
  await until(async () => Number(await rpc(urlA, 'eth_blockNumber')) >= 6, 120_000, 'six chain blocks');
  assert.equal(await rpc(urlA, 'eth_chainId'), '0x539');

  await t.test('a second node finds the first through its seed and syncs', async () => {
    B = await mkNode('b', port + 2, port + 3, [`127.0.0.1:${port}`]).start();
    await until(async () => (await rpc(urlB, 'psy_dagInfo')).blueScore >= (await rpc(urlA, 'psy_dagInfo')).blueScore - 1 && (await rpc(urlB, 'psy_peers')).some((p) => p.ready), 90_000, 'B to sync');
    const peersA = await rpc(urlA, 'psy_peers');
    assert.ok(peersA.some((p) => p.ready && !p.outbound), 'A sees B as an inbound peer');
  });

  await t.test('a transfer sent to B is mined via A and visible on both', async () => {
    await until(async () => BigInt(await rpc(urlB, 'eth_getBalance', [MINER, 'latest'])) > 10n ** 18n, 60_000, 'miner balance on B');
    const p = makeParams({ chainId: 1337n });
    const nonce = BigInt(await rpc(urlB, 'eth_getTransactionCount', [MINER, 'pending']));
    const to = Uint8Array.from(Buffer.from('ab'.repeat(20), 'hex'));
    const tx = signTx({ type: 2, nonce, to, value: 10n ** 17n, gasLimit: 21000, maxFee: 10_000_000_000n, maxPriorityFee: 1_000_000_000n }, MINER_SK, p);
    const hash = await rpc(urlB, 'eth_sendRawTransaction', ['0x' + bytesToHex(tx.raw)]);
    await until(async () => (await rpc(urlA, 'eth_getTransactionReceipt', [hash])) && (await rpc(urlB, 'eth_getTransactionReceipt', [hash])), 90_000, 'receipt on both nodes');
    const r = await rpc(urlA, 'eth_getTransactionReceipt', [hash]);
    assert.equal(r.status, '0x1');
    assert.equal(await rpc(urlA, 'eth_getBalance', ['0x' + 'ab'.repeat(20), 'latest']), '0x' + (10n ** 17n).toString(16));
  });

  await t.test('explorer and participation pages render', async () => {
    for (const pth of ['/', '/dag', '/blocks', '/block/1', '/txs', '/emission', '/network', '/ngos', '/ngo-submit', '/attestation', '/election', '/governance', '/roles', '/treasury', '/committee', '/run-a-node', '/mine', '/wallet', '/about', `/address/${MINER}`]) {
      const res = await fetch(urlA + pth);
      const body = await res.text();
      assert.equal(res.status, 200, pth);
      assert.ok(!/spider/i.test(body), 'no "spider" on ' + pth);
      // the disclaimer "No presale" (testnet banner, supply note) is allowed; any other mention is not
      assert.ok(!/\bmoney\b|\bcurrency\b|presale|\bprice\b/i.test(body.replace(/gas price/gi, '').replace(/\bno presale\b/gi, '')), 'wording on ' + pth);
    }
    const range = await rpc(urlA, 'psy_getDagRange', [0, 5]);
    assert.ok(range.length >= 5);
    for (const b of range.slice(1)) {
      assert.ok(Array.isArray(b.parents) && b.parents.length >= 1);
      assert.equal(typeof b.blueScore, 'number');
      assert.ok(Array.isArray(b.mergesetBlues) && Array.isArray(b.mergesetReds));
      assert.ok(['blue', 'red', 'not merged yet'].includes(b.colour));
    }
    const blk = await rpc(urlA, 'eth_getBlockByNumber', ['0x2', false]);
    assert.ok(Array.isArray(blk.dagParents) && blk.blueScore && Array.isArray(blk.mergesetBlues));
    assert.match(await (await fetch(urlA + '/dag')).text(), /id="dag-graph"/);
    const map = await (await fetch(urlA + '/api/map')).json();
    assert.ok(map.blocks.length > 0);
    const abi = await (await fetch(urlA + '/api/abi')).json();
    assert.ok(abi.NGORegistry.selectors['mint(string,string,string,string,bytes32)']);
    const health = await (await fetch(urlA + '/health')).json();
    assert.equal(health.ok, true);
  });

  await miner.stop();
  const heightA = Number(await rpc(urlA, 'eth_blockNumber'));
  const tipA = (await rpc(urlA, 'psy_dagInfo')).tip;
  await B.stop();
  await A.stop();

  await t.test('a restarted node replays its stored blocks', async () => {
    A = await mkNode('a', port, port + 1).start();
    try {
      assert.equal(Number(await rpc(urlA, 'eth_blockNumber')), heightA);
      assert.equal((await rpc(urlA, 'psy_dagInfo')).tip, tipA);
    } finally {
      await A.stop();
    }
  });
});

test.after(async () => {
  for (const x of [miner, B, A]) await x?.stop().catch(() => {});
  try { fs.rmSync(dir, { recursive: true }); } catch { /* temp */ }
});
