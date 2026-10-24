// Node-side hardening: certificate quorum with NGO signatures, signing depth, the bounded orphan pool, cheap refusal
// of junk signatures and certificates, the randomness beacon onion, and the HTTP host, CORS and content-type checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { testChain, key, hex } from './helpers.js';
import { certQuorum, checkpointDigest, ORPHAN_SOURCE_COUNT, ORPHAN_MAX_BYTES } from '../src/consensus.js';
import { Finality, sig65, SIGN_DEPTH } from '../src/finality.js';
import { startHttp, DEFAULT_VHOSTS } from '../src/http.js';
import { Rpc } from '../src/rpc.js';
import { keccak256 } from '../../common/crypto.js';
import { bytesToHex, concat, bigintToFixed } from '../../common/bytes.js';
import { parseTx } from '../src/tx.js';
import { selector } from '../../common/abi.js';
import { ADDR } from '../src/params.js';

const addrs = (n, p) => Array.from({ length: n }, (_, i) => p + String(i).padStart(4, '0'));

test('a certificate needs 15 committee signatures including the required NGO signatures', () => {
  const ngo = new Set(addrs(6, 'n'));
  const miners = addrs(15, 'm');
  const rule = { ngo, ngoRequired: 4 };
  assert.equal(certQuorum(miners, rule), false, '15 miner signatures alone never finalise');
  assert.equal(certQuorum([...miners.slice(0, 12), ...addrs(3, 'n')], rule), false, '3 NGO signatures are not enough');
  assert.equal(certQuorum([...miners.slice(0, 11), ...addrs(4, 'n')], rule), true);
  assert.equal(certQuorum([...miners.slice(0, 10), ...addrs(4, 'n')], rule), false, 'still 15 in all');
  assert.equal(certQuorum(miners, { ngo: new Set(), ngoRequired: 0 }), true, 'a committee without NGO members');
  assert.equal(certQuorum(miners, { ngo: new Set(), ngoRequired: Infinity }), false, 'rule unreadable: never final');
});

test('members sign 30 chain blocks deep', () => {
  assert.equal(SIGN_DEPTH, 30);
});

test('the orphan pool is bounded per source and by bytes; a flooding source evicts its own orphans', async () => {
  const t = await testChain();
  const c = t.chain;
  const put = (h, source, length = 100) => c._storeOrphan(h, { raw: { length }, missing: new Set(['p']), source });
  for (let i = 0; i < 10; i++) put('good' + i, 'honest');
  for (let i = 0; i < ORPHAN_SOURCE_COUNT + 50; i++) put('bad' + i, 'flood');
  assert.equal(c.orphanUse.get('flood').count, ORPHAN_SOURCE_COUNT, 'the flooding source is held to its share');
  for (let i = 0; i < 10; i++) assert.ok(c.orphans.has('good' + i), 'honest orphans survive the flood');
  assert.ok(!c.orphans.has('bad0') && c.orphans.has('bad' + (ORPHAN_SOURCE_COUNT + 49)), 'the flood loses its oldest first');
  // bytes: large orphans from many sources stay under the total
  for (let i = 0; i < 8; i++) put('big' + i, 'src' + i, 15 * 1024 * 1024);
  assert.ok(c.orphanBytes <= ORPHAN_MAX_BYTES);
  let sum = 0;
  for (const o of c.orphans.values()) sum += o.raw.length;
  assert.equal(sum, c.orphanBytes, 'byte accounting matches the pool');
  for (let i = 0; i < 10; i++) assert.ok(c.orphans.has('good' + i), 'the source with the most bytes is evicted, not the small honest one');
  c._dropOrphan('good0');
  assert.equal(c.orphanUse.get('honest').count, 9);
});

/** A Finality instance over a stub chain whose checkpoint 100 is on our chain; peers record misbehaviour. */
function finalityStub() {
  const iv = 30;
  const h = 'aa'.repeat(32), root = new Uint8Array(32).fill(7);
  const cb = { hash: h, hashBytes: Uint8Array.from(Buffer.from(h, 'hex')), stateRoot: root, chainHeight: 100 * iv, header: { timestamp: 1 } };
  const chainIdx = [];
  chainIdx[100 * iv] = h;
  const chain = { p: { checkpointInterval: iv, chainId: 1337n }, finalCheckpoint: { number: 0 }, tip: { chainHeight: 100 * iv + 40, hash: 'tip' }, chain: chainIdx, dag: { get: (x) => (x === h ? cb : null), genesis: { header: { timestamp: 1_800_000_000 } } }, noteFinal: async () => false };
  const f = new Finality({ chain, p2p: null, store: null });
  let reads = 0;
  f.membersFor = async () => { reads++; return { epoch: 0, members: new Set([hex(key(1).addr)]), rule: { ngo: new Set(), ngoRequired: 0 } }; };
  const peer = { points: [], misbehave(p, why) { this.points.push([p, why]); } };
  return { f, cb, peer, reads: () => reads };
}

test('junk checkpoint signatures are dropped cheaply or cost the peer points', async () => {
  const { f, cb, peer, reads } = finalityStub();
  const digest = checkpointDigest(1337n, 1_800_000_000, 100, cb.hashBytes, cb.stateRoot);
  // an old checkpoint (outside the window): dropped before any committee read
  await f.addCheckpointSig({ number: 3, chainBlock: cb.hashBytes, stateRoot: cb.stateRoot, epoch: 0, sig: sig65(digest, key(9).sk) }, peer);
  assert.equal(reads(), 0);
  assert.deepEqual(peer.points, []);
  // a signature by someone outside the committee: points
  await f.addCheckpointSig({ number: 100, chainBlock: cb.hashBytes, stateRoot: cb.stateRoot, epoch: 0, sig: sig65(digest, key(9).sk) }, peer);
  assert.equal(peer.points.length, 1);
  assert.match(peer.points[0][1], /non-member/);
  // an unrecoverable signature: points, no committee read
  const before = reads();
  await f.addCheckpointSig({ number: 100, chainBlock: cb.hashBytes, stateRoot: cb.stateRoot, epoch: 0, sig: new Uint8Array(65) }, peer);
  assert.equal(reads(), before);
  assert.equal(peer.points.length, 2);
  // a member's signature, twice: the second is dropped before the committee read
  const good = sig65(digest, key(1).sk);
  await f.addCheckpointSig({ number: 100, chainBlock: cb.hashBytes, stateRoot: cb.stateRoot, epoch: 0, sig: good }, peer);
  const r = reads();
  await f.addCheckpointSig({ number: 100, chainBlock: cb.hashBytes, stateRoot: cb.stateRoot, epoch: 0, sig: good }, peer);
  assert.equal(reads(), r);
  assert.equal(peer.points.length, 2);
});

test('a certificate with too few signatures, or one that does not verify, costs points', async () => {
  const { f, cb, peer } = finalityStub();
  await f.addCert({ number: 100, chainBlock: cb.hashBytes, stateRoot: cb.stateRoot, epoch: 0, sigs: [new Uint8Array(65)] }, peer);
  assert.match(peer.points[0][1], /too few signatures/);
  await f.addCert({ number: 100, chainBlock: cb.hashBytes, stateRoot: cb.stateRoot, epoch: 0, sigs: Array(15).fill(new Uint8Array(65)) }, peer);
  assert.match(peer.points[1][1], /does not verify/);
  // a certificate for a block that is not on our chain is not the peer's fault
  await f.addCert({ number: 100, chainBlock: new Uint8Array(32), stateRoot: cb.stateRoot, epoch: 0, sigs: Array(15).fill(new Uint8Array(65)) }, peer);
  assert.equal(peer.points.length, 2);
});

test('the beacon onion is a hash chain derived from the signer key', async () => {
  const t = await testChain();
  const f = new Finality({ chain: t.chain, p2p: null, store: null, signerKey: key(5).sk });
  const o = f.onion(0);
  assert.equal(o.layers.length, 4097);
  for (const i of [1, 2, 4096]) assert.equal(bytesToHex(keccak256(o.layers[i - 1])), bytesToHex(o.layers[i]));
  assert.equal(o.pos.get(bytesToHex(o.layers[4096])), 4096);
  const again = new Finality({ chain: t.chain, p2p: null, store: null, signerKey: key(5).sk }).onion(0);
  assert.equal(bytesToHex(again.layers[0]), bytesToHex(o.layers[0]), 'a restart regenerates the same onion');
  assert.notEqual(bytesToHex(f.onion(1).layers[0]), bytesToHex(o.layers[0]), 'each commitment uses a new onion');
  assert.notEqual(bytesToHex(new Finality({ chain: t.chain, p2p: null, store: null, signerKey: key(6).sk }).onion(0).layers[0]), bytesToHex(o.layers[0]));
});

test('a committee node commits its onion, then reveals the next layer for each open round', async () => {
  const t = await testChain();
  const sent = [];
  const mempool = { bySender: new Map(), add: (raw) => { sent.push(parseTx(raw, t.params)); return sent.at(-1); } };
  const f = new Finality({ chain: t.chain, p2p: null, store: null, mempool, signerKey: key(5).sk });
  const o = f.onion(0);
  const zero = '00'.repeat(32);
  let st = { bonded: true, layer: zero, commits: 0, open: [], nonce: 4n, baseFee: t.params.minBaseFee, height: 100 };
  f.beaconState = async () => st;
  await f.beaconTick();
  assert.equal(sent.length, 1);
  assert.equal(bytesToHex(sent[0].to), bytesToHex(ADDR.finalityCommittee));
  assert.equal(sent[0].nonce, 4n);
  assert.equal(bytesToHex(sent[0].data), bytesToHex(concat(selector('commitBeacon(bytes32)'), o.layers[4096])));
  await f.beaconTick();
  assert.equal(sent.length, 1, 'no second commit while the first is pending');
  // committed (index 0); two rounds open: reveal layers 4095 and 4094, in order, with consecutive nonces
  st = { ...st, layer: bytesToHex(o.layers[4096]), commits: 1, open: [7, 8], nonce: 5n, height: 101 };
  await f.beaconTick();
  assert.equal(sent.length, 3);
  assert.equal(bytesToHex(sent[1].data), bytesToHex(concat(selector('revealBeacon(uint256,bytes32)'), bigintToFixed(7n, 32), o.layers[4095])));
  assert.equal(bytesToHex(sent[2].data), bytesToHex(concat(selector('revealBeacon(uint256,bytes32)'), bigintToFixed(8n, 32), o.layers[4094])));
  assert.deepEqual([sent[1].nonce, sent[2].nonce], [5n, 6n]);
  // never re-commit while a reveal is owed
  st = { ...st, layer: bytesToHex(o.layers[1]), open: [9], height: 200 };
  await f.beaconTick();
  assert.equal(bytesToHex(sent.at(-1).data), bytesToHex(concat(selector('revealBeacon(uint256,bytes32)'), bigintToFixed(9n, 32), o.layers[0])));
});

test('Host check on by default, CORS opt-in, JSON-RPC needs application/json, peer methods for local callers only', async () => {
  const t = await testChain();
  const mk = (opts) => {
    const node = { chain: t.chain, params: t.params, mempool: t.mempool, p2p: { peers: new Set(), info: () => [{ addr: '198.51.100.1' }], addrman: { info: () => ({}) } }, finality: null, opts, log: () => {} };
    node.rpc = new Rpc({ chain: t.chain, mempool: t.mempool, p2p: node.p2p, finality: null, node });
    return node;
  };
  const request = (port, { method = 'GET', path = '/health', headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: data }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
  const rpc = (method) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] });

  assert.deepEqual(DEFAULT_VHOSTS, ['localhost', '127.0.0.1', '::1']);
  const s1 = await startHttp({ node: mk({}), host: '127.0.0.1', port: 0 });
  try {
    const port = s1.address().port;
    assert.equal((await request(port, { headers: { Host: 'evil.example' } })).code, 403, 'DNS rebinding: unknown Host refused');
    const ok = await request(port, { headers: { Host: 'localhost', Origin: 'https://evil.example' } });
    assert.equal(ok.code, 200);
    assert.equal(ok.headers['access-control-allow-origin'], undefined, 'no CORS unless configured');
    const plain = await request(port, { method: 'POST', path: '/rpc', headers: { Host: '127.0.0.1', 'Content-Type': 'text/plain' }, body: rpc('eth_blockNumber') });
    assert.equal(plain.code, 415, 'a form-style POST from another site is refused');
    const local = await request(port, { method: 'POST', path: '/rpc', headers: { Host: '127.0.0.1', 'Content-Type': 'application/json' }, body: rpc('psy_peers') });
    assert.ok(JSON.parse(local.body).result, 'local callers see peers');
    const remote = await request(port, { method: 'POST', path: '/rpc', headers: { Host: '127.0.0.1', 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.9' }, body: rpc('psy_peers') });
    assert.equal(JSON.parse(remote.body).error.code, -32601, 'callers through the tunnel do not');
    const pub = await request(port, { method: 'POST', path: '/rpc', headers: { Host: '127.0.0.1', 'Content-Type': 'application/json; charset=utf-8', 'CF-Connecting-IP': '203.0.113.9' }, body: rpc('eth_blockNumber') });
    assert.equal(JSON.parse(pub.body).result, '0x0', 'public methods stay public');
  } finally { s1.close(); }

  const s2 = await startHttp({ node: mk({ vhosts: ['rpc.psyrob.com', 'localhost'], cors: ['*'] }), host: '127.0.0.1', port: 0 });
  try {
    const port = s2.address().port;
    const r = await request(port, { method: 'POST', path: '/rpc', headers: { Host: 'rpc.psyrob.com', 'Content-Type': 'application/json', Origin: 'https://wallet.example' }, body: rpc('eth_chainId') });
    assert.equal(r.headers['access-control-allow-origin'], '*', 'the public node opts in to CORS');
    assert.equal((await request(port, { headers: { Host: '127.0.0.1' } })).code, 403, 'only the listed hosts');
  } finally { s2.close(); }
});
