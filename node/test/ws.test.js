// P2P over WebSocket (ws.js): the client address behind the tunnel, the frame parser, and two nodes where the second
// reaches the first only through ws://127.0.0.1:<http port>/p2p (as public peers reach wss://rpc.psyrob.com/p2p).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Node } from '../src/node.js';
import { Miner } from '../../miner/src/miner.js';
import { clientIp, acceptWebSocket } from '../src/ws.js';

/** A port the OS reports free (tests run in parallel, so fixed or random ranges can collide). */
async function freePort() {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/** Start a node, retrying on a fresh port if another test took the chosen one meanwhile. mk(p2pPort, httpPort). */
async function startOnFreePorts(mk) {
  for (let i = 0; ; i++) {
    const ports = [await freePort(), await freePort()];
    try { return { node: await mk(...ports).start(), ports }; } catch (e) {
      if (e.code !== 'EADDRINUSE' || i >= 4) throw e;
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > end) throw new Error('timed out waiting for ' + what);
    await sleep(250);
  }
}

test('client address: CF-Connecting-IP only from the local tunnel, never from a remote client', () => {
  assert.equal(clientIp('127.0.0.1', { 'cf-connecting-ip': '203.0.113.9' }), '203.0.113.9');
  assert.equal(clientIp('::ffff:127.0.0.1', { 'cf-connecting-ip': '2001:db8::7' }), '2001:db8::7');
  assert.equal(clientIp('::1', { 'cf-connecting-ip': '198.51.100.1' }), '198.51.100.1');
  assert.equal(clientIp('198.51.100.20', { 'cf-connecting-ip': '203.0.113.9' }), '198.51.100.20'); // forged by a remote client
  assert.equal(clientIp('127.0.0.1', { 'cf-connecting-ip': 'not-an-ip' }), '127.0.0.1');
  assert.equal(clientIp('127.0.0.1', {}), '127.0.0.1');
});

// a raw client: handshake, then hand-made frames
function frame(op, payload, { fin = true, mask = true } = {}) {
  const len = payload.length;
  const head = len < 126 ? Buffer.from([(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | len])
    : Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | op, (mask ? 0x80 : 0) | 126]), Buffer.from([len >> 8, len & 255])]);
  if (!mask) return Buffer.concat([head, payload]);
  const m = randomBytes(4), p = Buffer.from(payload);
  for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3];
  return Buffer.concat([head, m, p]);
}

async function rawServer() {
  const got = [];
  const server = http.createServer();
  got.sockets = [];
  server.on('upgrade', (req, socket, head) => {
    got.sockets.push(socket);
    const ws = acceptWebSocket(req, socket, head, '127.0.0.1');
    if (!ws) return;
    got.ws = ws;
    ws.on('data', (d) => got.push(Buffer.from(d)));
    ws.on('close', () => { got.closed = true; });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { server, got, port: server.address().port };
}

const clients = [];
async function rawClient(port) {
  const s = net.connect(port, '127.0.0.1');
  clients.push(s);
  await new Promise((r) => s.once('connect', r));
  const key = randomBytes(16).toString('base64');
  s.write(`GET /p2p HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  const resp = await new Promise((r) => s.once('data', (d) => r(d.toString())));
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  assert.match(resp, /^HTTP\/1\.1 101/);
  assert.ok(resp.includes(`Sec-WebSocket-Accept: ${accept}`));
  const recv = [];
  s.on('data', (d) => recv.push(d));
  s.closedP = new Promise((r) => s.once('close', r));
  return { s, recv };
}

test('frames: binary and fragmented messages arrive whole; ping is answered; text, unmasked and oversize frames close', async () => {
  const { server, got, port } = await rawServer();
  try {
    let { s, recv } = await rawClient(port);
    s.write(frame(2, Buffer.from('hello')));
    s.write(Buffer.concat([frame(2, Buffer.from('ab'), { fin: false }), frame(9, Buffer.from('pi')), frame(0, Buffer.from('cd'))]));
    await until(() => got.length >= 2 && recv.length, 5000, 'messages and pong');
    assert.deepEqual(got.map(String), ['hello', 'abcd']);
    assert.deepEqual([...Buffer.concat(recv)], [0x8a, 2, ...Buffer.from('pi')]); // the pong carries the ping's payload
    // server -> client: an unmasked binary frame
    recv.length = 0;
    got.ws.write(new Uint8Array([1, 2, 3]));
    await until(() => recv.length, 5000, 'server frame');
    assert.deepEqual([...Buffer.concat(recv)], [0x82, 3, 1, 2, 3]);
    for (const bad of [frame(1, Buffer.from('text')), frame(2, Buffer.from('x'), { mask: false }), Buffer.from([0x82, 0xff, 0, 0, 0, 0, 0x7f, 0, 0, 0])]) {
      got.closed = false;
      ({ s } = await rawClient(port));
      s.write(bad);
      await s.closedP;
      assert.ok(got.closed);
    }
  } finally {
    for (const c of clients) c.destroy();
    for (const c of got.sockets) c.destroy();
    server.close();
  }
});

test('a node reaches another only over WebSocket at /p2p and syncs; a ban hits the Cloudflare client address, not 127.0.0.1', { timeout: 300_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-ws-'));

  const genesisFile = path.join(dir, 'genesis.json');
  fs.writeFileSync(genesisFile, JSON.stringify({
    config: { chainId: 1337, timestamp: Math.floor(Date.now() / 1000) - 600, target: '0x' + ((1n << 256n) / 3000n).toString(16), devBeneficiary: '0x' + '22'.repeat(20) },
    params: { pow: { memoryKiB: 8, iterations: 1 } },
  }));
  const quiet = () => {};
  // A lists its own public WebSocket address as a seed (as the public node does through genesis/seeds.txt)
  const { node: A, ports: [, hA] } = await startOnFreePorts((pA, h) => new Node({ genesisFile, datadir: path.join(dir, 'a'), p2pHost: '127.0.0.1', p2pPort: pA, seeds: [`ws://127.0.0.1:${h}/p2p`], httpHost: '127.0.0.1', httpPort: h, log: quiet }));
  const urlA = `http://127.0.0.1:${hA}`;
  const miner = new Miner({ url: urlA, key: Uint8Array.from(Buffer.from('11'.repeat(31) + '09', 'hex')), threads: 1, refreshSeconds: 5, log: quiet, impl: 'wasm-simd' });
  let B;
  try {
    await miner.start();
    await until(() => A.chain.tip.chainHeight >= 5, 120_000, 'five blocks on A');
    // the self-dial handshake may finish after the first blocks: wait for it
    await until(() => A.p2p.wsSeeds.length === 0, 15_000, 'A to drop its own WebSocket seed');
    assert.deepEqual(A.p2p.wsSeeds, [], 'a node that reaches itself through its own seed drops that seed instead of redialling');
    // B: no P2P listener, its only seed is A's WebSocket endpoint on the HTTP port
    ({ node: B } = await startOnFreePorts((_p, h) => new Node({ genesisFile, datadir: path.join(dir, 'b'), p2pHost: '127.0.0.1', p2pPort: 0, seeds: [`ws://127.0.0.1:${hA}/p2p`], httpHost: '127.0.0.1', httpPort: h, log: quiet })));
    await until(() => B.chain.tip.blueScore >= A.chain.tip.blueScore - 1 && B.chain.tip.chainHeight >= 5, 90_000, 'B to sync over WebSocket');
    const pa = A.p2p.info(), pb = B.p2p.info();
    assert.ok(pa.some((p) => p.ready && !p.outbound && p.transport === 'ws'), 'A sees B as an inbound WebSocket peer');
    assert.ok(pb.some((p) => p.ready && p.outbound && p.transport === 'ws' && p.id === `ws://127.0.0.1:${hA}/p2p`));
    assert.equal(B.p2p.addrman.size, 0, 'the WebSocket seed is not put into the TCP address manager');
    // new blocks keep arriving over the WebSocket link
    const h = A.chain.tip.chainHeight;
    await until(() => B.chain.tip.chainHeight >= h + 2, 90_000, 'two more blocks on B');

    // a peer arriving through the tunnel (loopback + CF-Connecting-IP) that sends junk is banned by its own address
    const { s } = await (async () => {
      const sock = net.connect(hA, '127.0.0.1');
      clients.push(sock);
      await new Promise((r) => sock.once('connect', r));
      sock.write(`GET /p2p HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nCF-Connecting-IP: 203.0.113.9\r\n\r\n`);
      await new Promise((r) => sock.once('data', r));
      sock.closedP = new Promise((r) => sock.once('close', r));
      return { s: sock };
    })();
    s.write(frame(2, Buffer.alloc(16, 0xee))); // wrong network magic
    await s.closedP;
    assert.ok(A.p2p.banned('203.0.113.9'));
    assert.ok(!A.p2p.banned('127.0.0.1'), 'the tunnel address itself is never banned for one client');
    assert.ok(A.p2p.info().some((p) => p.ready && p.transport === 'ws'), 'B stays connected');
  } finally {
    await miner.stop?.();
    await B?.stop();
    await A.stop();
    // cleanup never hides the test's own error
    for (const sub of ['a', 'b']) if (fs.existsSync(path.join(dir, sub))) fs.rmSync(path.join(dir, sub), { recursive: true });
    if (fs.existsSync(genesisFile)) fs.rmSync(genesisFile);
    try { fs.rmdirSync(dir); } catch { /* not empty: leave it */ }
  }
});
