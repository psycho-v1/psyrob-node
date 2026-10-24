// The node binary: --no-default-seeds keeps a dry-run node away from the public seed in genesis/seeds.txt.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

test('--no-default-seeds: the node dials nobody (genesis/seeds.txt lists the public node)', { timeout: 60_000 }, async () => {
  assert.match(fs.readFileSync(new URL('../../genesis/seeds.txt', import.meta.url), 'utf8'), /^wss:\/\/rpc\.psyrob\.com\/p2p$/m);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-cli-'));
  const genesis = path.join(dir, 'genesis.json');
  fs.writeFileSync(genesis, JSON.stringify({ config: { chainId: 1337, timestamp: Math.floor(Date.now() / 1000), target: '0x' + ((1n << 256n) / 3000n).toString(16), devBeneficiary: '0x' + '22'.repeat(20) }, params: { pow: { memoryKiB: 8, iterations: 1 } } }));
  const http = await freePort();
  const child = spawn(process.execPath, [new URL('../bin/psyrob-node.js', import.meta.url).pathname, '--genesis', genesis, '--datadir', path.join(dir, 'data'),
    '--no-listen', '--no-default-seeds', '--http-host', '127.0.0.1', '--http-port', String(http)], { stdio: 'ignore' });
  try {
    let peers = null;
    for (let i = 0; i < 60 && peers === null; i++) {
      await new Promise((r) => setTimeout(r, 250));
      try {
        const r = await fetch(`http://127.0.0.1:${http}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'psy_peers', params: [] }) });
        peers = (await r.json()).result;
      } catch { /* not up yet */ }
    }
    await new Promise((r) => setTimeout(r, 6_000)); // past the first maintain() round
    const r = await fetch(`http://127.0.0.1:${http}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'psy_peers', params: [] }) });
    assert.deepEqual((await r.json()).result, []);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.once('exit', r));
    fs.rmSync(path.join(dir, 'data'), { recursive: true, force: false });
    fs.rmSync(genesis);
    fs.rmdirSync(dir);
  }
});

test('miner --expect-address: refuses a key that belongs to another address, never prints the key', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-mk-'));
  const key = path.join(dir, 'miner.key');
  const hex = '11'.repeat(31) + '0a';
  fs.writeFileSync(key, hex + '\n', { mode: 0o600 });
  const { privateKeyToAddress } = await import('../../common/crypto.js');
  const right = '0x' + Buffer.from(privateKeyToAddress(Buffer.from(hex, 'hex'))).toString('hex');
  const run = (expect) => new Promise((resolve) => {
    const c = spawn(process.execPath, [new URL('../../miner/bin/psyrob-miner.js', import.meta.url).pathname, '--key', key, '--node', 'http://127.0.0.1:9', '--expect-address', expect]);
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => c.kill('SIGTERM'), 10_000); // the right key gets past the check and keeps trying the node (10 s: under a loaded test run the wrong key's exit took over 3 s)
    c.once('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
  try {
    const bad = await run('0x' + '00'.repeat(20));
    assert.equal(bad.code, 2);
    assert.match(bad.out, /refusing to mine/);
    assert.ok(!bad.out.includes(hex), 'the key is never printed');
    const good = await run(right.toUpperCase().replace('0X', '0x'));
    assert.doesNotMatch(good.out, /refusing to mine/);
    assert.ok(!good.out.includes(hex));
  } finally {
    fs.rmSync(key);
    fs.rmdirSync(dir);
  }
});
