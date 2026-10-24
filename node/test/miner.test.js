// The miner core (miner/src/miner.js) against a stand-in JSON-RPC node: templates are checked before anything is
// signed, a submission that fails for a passing reason is retried, a dead node fails over to the next, a node on
// another network is refused, and "still syncing" is waited out.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { testChain, key, mineOne, hex } from './helpers.js';
import { buildTemplate, templateJson } from '../src/template.js';
import { Miner, TransientError } from '../../miner/src/miner.js';

const A = key(1), B = key(2);

/** A fake node: `handler(method, params, n)` returns { result } | { error } | { status, body } (raw). */
async function fakeNode(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let s = '';
    for await (const c of req) s += c;
    const m = JSON.parse(s);
    calls.push(m.method);
    const r = await handler(m.method, m.params, calls.filter((x) => x === m.method).length);
    if (r.status) { res.writeHead(r.status, { 'Content-Type': 'text/html' }).end(r.body ?? '<html>busy</html>'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...r }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}

async function setup() {
  const t = await testChain();
  t.advance(10);
  await mineOne(t, A);
  const tpl = templateJson(await buildTemplate(t.chain, t.mempool, A.addr), t.params);
  const info = { chainId: '0x539', genesis: '0x' + hex(t.genesis.hash), tips: ['0x' + t.chain.tip.hash], chainHeight: t.chain.tip.chainHeight };
  return { t, tpl, info };
}

test('miner: a template that does not match its signing bytes, or names another miner, is never signed', async () => {
  const { tpl } = await setup();
  const m = new Miner({ url: 'http://127.0.0.1:9', key: A.sk });
  assert.ok(m.checkTemplate(tpl), 'a correct template passes');
  const forged = structuredClone(tpl);
  forged.header.stateRoot = '0x' + '11'.repeat(32);
  assert.throws(() => m.checkTemplate(forged), /do not match its signing bytes/);
  const other = new Miner({ url: 'http://127.0.0.1:9', key: B.sk });
  assert.throws(() => other.checkTemplate(tpl), /another miner address/);
  const heavy = structuredClone(tpl);
  heavy.pow = { memoryKiB: 1 << 30, iterations: 1 };
  assert.throws(() => m.checkTemplate(heavy), /unusual proof-of-work/);
  const pub = new Miner({ url: 'http://127.0.0.1:9', key: A.sk, expect: { chainId: 87870 } });
  assert.throws(() => pub.checkTemplate(tpl), /another network/, 'the public network needs 32 MiB, not a test setting');
});

test('miner: a web page or a busy node is a passing error; a submission is retried until it goes through', async () => {
  const { tpl, info } = await setup();
  const node = await fakeNode((method, params, n) => {
    if (method === 'psy_dagInfo') return { result: info };
    if (method === 'psy_getBlockTemplate') return { result: tpl };
    if (method === 'psy_submitBlock') return n === 1 ? { status: 502 } : n === 2 ? { error: { code: -32005, message: 'the node is busy checking blocks; try again shortly' } } : { result: { status: 'added', hash: '0x' + 'ab'.repeat(32) } };
    return { error: { code: -32601, message: 'no' } };
  });
  try {
    const m = new Miner({ url: node.url, key: A.sk, log: () => {} });
    // the first answer is a 502 web page: a passing error, not a crash on "Unexpected token <"
    await assert.rejects(m.rpc('psy_submitBlock', []), (e) => e instanceof TransientError && /web page/.test(e.message));
    m.job = { ...tpl, url: node.url };
    m.newJob = async () => {}; // the next template is not needed here
    await m.onWorker({ type: 'found', id: tpl.id, nonce: '0x1', sig: '0x' + '00'.repeat(65) });
    assert.equal(m.accepted, 1, 'accepted after a busy answer');
    assert.equal(node.calls.filter((c) => c === 'psy_submitBlock').length, 3, 'the page above, then busy, then added');
    await m.onWorker({ type: 'found', id: tpl.id, nonce: '0x2', sig: '0x' + '00'.repeat(65) });
    assert.equal(m.found, 1, 'a second solution for the same template is not sent');
  } finally { await node.close(); }
});

test('miner: a dead node fails over to the next; a node on another network is refused; a syncing node is waited out', async () => {
  const { tpl, info } = await setup();
  let syncing = true;
  const good = await fakeNode((method) => {
    if (method === 'psy_dagInfo') return { result: info };
    if (method === 'psy_getBlockTemplate') return syncing ? { error: { code: -32005, message: 'the node is still syncing (blue score 3 of about 900); mining starts when it has caught up' } } : { result: tpl };
    return { error: { code: -32601, message: 'no' } };
  });
  const wrong = await fakeNode((method) => (method === 'psy_dagInfo' ? { result: { ...info, genesis: '0x' + '99'.repeat(32) } } : { error: { code: -32601, message: 'no' } }));
  const lines = [];
  try {
    const m = new Miner({ urls: ['http://127.0.0.1:9', wrong.url, good.url], key: A.sk, threads: 1, expect: { chainId: 1337, genesis: info.genesis }, log: (...a) => lines.push(a.join(' ')) });
    await m.start();
    try {
      assert.equal(m.url, good.url, 'skipped the dead node and the node on another network');
      assert.ok(lines.some((l) => /still syncing/.test(l)), 'waits while the node syncs');
      assert.equal(m.job, null, 'no template yet');
      syncing = false;
      await m.newJob();
      assert.equal(m.job.id, tpl.id, 'mines once the node has caught up');
      assert.ok(lines.some((l) => /caught up/.test(l)));
    } finally { await m.stop(); }
    const strict = new Miner({ url: wrong.url, key: A.sk, expect: { chainId: 1337, genesis: info.genesis }, log: () => {} });
    await assert.rejects(strict.start(), /another network/);
  } finally { await good.close(); await wrong.close(); }
});
