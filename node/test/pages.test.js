// The read-only explorer pages (explorer-pages.js): a 200 for every route, 404 for unknown ids, pagination limits,
// escaping of chain and user data, the banners, the front-page radar, no external requests, and the RPC host redirect.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { testChain, key, mineOne } from './helpers.js';
import { signTx } from '../src/tx.js';
import { ADDR } from '../src/params.js';
import { contract } from '../../common/abicodec.js';
import { keccak256 } from '../../common/crypto.js';
import { bytesToHex } from '../../common/bytes.js';
import { artifacts } from '../src/genesis.js';
import { Explorer, HEADERS } from '../src/explorer.js';
import { Rpc } from '../src/rpc.js';
import { startHttp } from '../src/http.js';
import { Downloads } from '../src/downloads.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pageOf } from '../src/explorer-pages.js';

const A = artifacts();
const C = Object.fromEntries(['MinerRegistry', 'NGORegistry', 'VoteEscrow', 'Governor'].map((n) => [n, contract(A[n].abi, keccak256)]));
const TO = { MinerRegistry: ADDR.minerRegistry, NGORegistry: ADDR.ngoRegistry, VoteEscrow: ADDR.voteEscrow, Governor: ADDR.governor };
const PSY = 10n ** 18n;
const hex = (a) => '0x' + bytesToHex(a);
const EVIL = '<script>alert(1)</script>';
const EVIL_DESC = '<img src=x onerror=alert(2)> remove "quotes" & more';

test('explorer pages: every route, 404s, pagination, escaping, banners, radar, no CDN, RPC host redirect', { timeout: 300_000 }, async () => {
  const t = await testChain({ params: { poolCap: 360_000_000_000n * PSY, maxSupply: 10n ** 30n } });
  const nonces = new Map();
  const rich = key(1), ngo = key(2);
  const mine = async (who, n = 1) => { for (let i = 0; i < n; i++) { t.advance(10); await mineOne(t, who); await t.chain.readAtTip((v) => t.mempool.prune(v)); } };
  const send = async (from, to, data = new Uint8Array(0), value = 0n, gasLimit = 3_000_000n) => {
    const k = hex(from.addr);
    const n = nonces.get(k) ?? (await t.chain.readAtTip((v) => v.getAccount(from.addr).nonce));
    nonces.set(k, n + 1n);
    const tx = signTx({ type: 2, nonce: n, to, data, value, gasLimit, maxFee: 20_000_000_000n, maxPriorityFee: 0n }, from.sk, t.params);
    await t.chain.readAtTip((view, ctx) => t.mempool.add(tx.raw, view, ctx.baseFee));
    return tx;
  };
  const call = (from, name, fn, args = [], value = 0n) => send(from, TO[name], C[name].encode(fn, args), value);
  const mineTxs = async () => { for (let i = 0; i < 20 && t.mempool.size > 0; i++) await mine(rich); await mine(rich); };

  await mine(rich, 12);
  await mine(ngo, 2);
  await send(rich, ngo.addr, new Uint8Array(0), 1_000n * PSY, 21_000n);
  await mineTxs();
  await call(ngo, 'MinerRegistry', 'register', ['0x' + '00'.repeat(32)]);
  await call(rich, 'MinerRegistry', 'register', ['0x' + '00'.repeat(32)]);
  await mineTxs();
  await call(ngo, 'NGORegistry', 'mint', [EVIL, 'NL', 'REG-1', 'javascript:alert(3)', hex(keccak256(new Uint8Array([1])))], 100n * PSY);
  await call(rich, 'VoteEscrow', 'lock', [], 10_000n * PSY);
  await mineTxs();
  const declare = C.MinerRegistry.encode('declareOperator', ['0x' + 'ab'.repeat(32)]);
  await call(rich, 'Governor', 'propose', [0n, [hex(ADDR.minerRegistry)], [0n], ['0x' + bytesToHex(declare)], EVIL_DESC]);
  await mineTxs();
  await call(rich, 'Governor', 'vote', [0n, 1n]);
  await mineTxs();
  // one transaction left pending for the mempool page
  await send(rich, ngo.addr, new Uint8Array(0), 1n, 21_000n);

  const node = { chain: t.chain, params: t.params, mempool: t.mempool, p2p: null, finality: null, opts: { vhosts: ['*'] }, log: (m) => { throw new Error(m); } };
  node.rpc = new Rpc({ chain: t.chain, mempool: t.mempool, p2p: null, finality: null, node });
  const ex = new Explorer(node);
  const get = (p) => ex.route(p.split('?')[0], new URLSearchParams(p.split('?')[1] ?? ''));

  // ---- every new route answers, with the testnet banner, the four main menus and no external requests
  const routes = ['/', '/proposals', '/proposal/0', '/election-rounds', '/election-round/0', '/account', `/account?address=${hex(rich.addr)}`, '/account?address=nonsense',
    '/mining', '/mempool', '/holders', '/committee', '/committee/0', '/developers', '/contracts', '/contract/Governor', '/contract/Params', '/run-a-node', `/ngo/${hex(ngo.addr)}`,
    '/ngos', '/attestation', '/election', '/governance', '/treasury', '/metrics', '/register/miner', '/register/ngo'];
  for (const r of routes) {
    const html = await get(r);
    assert.ok(typeof html === 'string' && html.includes('</html>'), 'page ' + r);
    assert.ok(html.includes('Test network. No presale. Wallet loss is permanent.'), 'banner on ' + r);
    for (const menu of ['Explorer', 'Governance', 'Network', 'Developers']) assert.ok(html.includes(`<span>${menu}</span>`), `menu ${menu} on ${r}`);
    assert.doesNotMatch(html, /jsdelivr|googleapis|gstatic|unpkg|cdnjs/, 'no external request on ' + r);
    assert.doesNotMatch(html, /spider/i, 'no "spider" on ' + r);
    assert.doesNotMatch(html.replace(/gas price/gi, '').replace(/\bno presale\b/gi, ''), /\bmoney\b|\bcurrency\b|presale|\bprice\b/i, 'wording on ' + r);
    assert.doesNotMatch(html, /Interim mode\./, 'no Interim banner in Bootstrap on ' + r);
  }
  // ---- registration pages: the owner's texts, the testnet note, the wallet panel, links from the menu and Attestation
  const note = 'This is the PSYROB public testnet. Tokens and registrations on this network have no real-world value and will be reset when we launch a new version.';
  const minerPage = await get('/register/miner'), ngoPage = await get('/register/ngo');
  for (const [html, title, button] of [[minerPage, 'Register your miner', 'Register miner'], [ngoPage, 'Register a miner for your NGO', 'Register NGO miner']]) {
    assert.ok(html.includes(note), 'testnet note on ' + title);
    assert.ok(html.includes(`<h1>${title}</h1>`), title);
    assert.ok(html.includes(`>${button}</button>`), 'button ' + button);
    assert.ok(html.includes('<script type="module" src="/register.js"></script>'));
    assert.ok(html.includes('id="reg-connect"') && html.includes('aria-live="polite"'), 'wallet panel with a status area');
    assert.ok(html.includes('What the words on this page mean'), 'terms explained before use');
  }
  for (const line of ['Registration is free and only takes a few minutes.', 'Click “Register miner”.', 'You may vouch for up to 10 NGOs. Each NGO needs 5 different registered miners to become attested.',
    'Wait a few minutes and refresh. Blue blocks can take a short time to appear.', 'No. Registration is permanent on this testnet.']) assert.ok(minerPage.includes(line), 'miner page text: ' + line);
  for (const line of ['You can register one miner address for your organisation.', 'You should be the person authorised to act for the NGO.', 'Enter the name of the NGO and a short description (optional but recommended).',
    'No. One miner address per NGO on this testnet.', 'You must mine at least one blue block before you can register.']) assert.ok(ngoPage.includes(line), 'NGO page text: ' + line);
  assert.ok(ngoPage.includes('id="reg-name"') && ngoPage.includes('maxlength="80"') && ngoPage.includes('id="reg-description"'));
  assert.ok(minerPage.includes('href="/attestation"'), 'the miner page leads to Attestation');
  const front = await get('/');
  assert.ok(front.includes('href="/register/miner"') && front.includes('href="/register/ngo"'), 'both pages in the main menu');
  const attestation = await get('/attestation');
  assert.ok(attestation.includes('href="/register/miner"') && attestation.includes('href="/register/ngo"'), 'both pages linked from Attestation');
  assert.match(HEADERS['Content-Security-Policy'], /script-src 'self';/);
  assert.doesNotMatch(HEADERS['Content-Security-Policy'], /https:/);

  // ---- 404 for unknown or malformed ids
  for (const r of ['/proposal/1', '/proposal/999999', '/proposal/abc', '/proposal/-1', '/election-round/99', '/election-round/x', '/committee/999999', '/committee/1e3',
    '/contract/Nope', '/contract/__proto__', '/contract/constructor', '/contract/toString']) assert.equal(await get(r), null, '404 for ' + r);

  // ---- escaping: the NGO name and the proposal description are hostile
  for (const r of [`/ngo/${hex(ngo.addr)}`, '/ngos', '/proposals', '/proposal/0']) {
    const html = await get(r);
    assert.ok(!html.includes(EVIL) && !html.includes('<img src=x'), 'unescaped data on ' + r);
  }
  assert.ok((await get('/ngos')).includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  const prop = await get('/proposal/0');
  assert.ok(prop.includes('&lt;img src=x onerror=alert(2)&gt; remove &quot;quotes&quot; &amp; more'));
  assert.match(prop, /MinerRegistry\.declareOperator/); // the action is decoded
  assert.match(prop, /Ordinary tier: 5 % of the locked PSY/);
  assert.match(prop, new RegExp(hex(rich.addr).slice(0, 10)), 'the voter is listed');
  const badAcct = await get('/account?address=%3Cscript%3E');
  assert.ok(!badAcct.includes('<script>') || !/value="<script>/.test(badAcct));
  assert.ok(badAcct.includes('value="&lt;script&gt;"'));

  // ---- pagination limits
  const q = (s) => new URLSearchParams(s);
  assert.equal(pageOf(q('page=0')), 1);
  assert.equal(pageOf(q('page=-3')), 1);
  assert.equal(pageOf(q('page=abc')), 1);
  assert.equal(pageOf(q('page=1000000000')), 1);
  assert.equal(pageOf(q('page=7'), 3), 3);
  for (const r of ['/proposals?page=999999', '/holders?page=-1', '/mempool?page=abc', '/election-rounds?page=5', '/proposal/0?page=99']) {
    const html = await get(r);
    assert.ok(html.includes('</html>'), r);
  }
  const holders = await get('/holders');
  assert.ok((holders.match(/<tr><td>\d/g) ?? []).length <= 50, 'at most 50 holders per page');
  assert.match(holders, /system: Treasury/);
  assert.match(await get('/mempool'), /1 pending/);

  // ---- the front page radar: eight real figures between 0 and 1
  const radar = await ex.radarData();
  assert.deepEqual(radar.map((x) => x.axis), ['PACE', 'BLUE', 'MINERS', 'GAS', 'BURN', 'LOCKED', 'NGOS', 'FINALITY']);
  for (const x of radar) assert.ok(x.value >= 0 && x.value <= 1 && typeof x.text === 'string', x.axis);
  const home = await get('/');
  assert.match(home, /Network health/);
  // the requested texts, charts and guides
  assert.match(home, /<h1>PSYROB<\/h1>/);
  assert.match(home, /PSYROB is a CPU-mined DAG consensus network that uses the Argon2d algorithm/);
  assert.doesNotMatch(home, /anything signed with an old key could be replayed/);
  assert.match(await get('/dag'), /<h1>Multi-Parent Consensus<\/h1>/);
  assert.match(await get('/blocks'), /<h1>The Selected Chain<\/h1>/);
  assert.doesNotMatch(await get('/network'), /Replay warning/);
  assert.doesNotMatch(await get('/run-a-node'), /Keep the miner off/);
  assert.doesNotMatch(await get('/about'), /research notes and audit are in the repository/);
  assert.match(await get('/wallet'), /Never reuse a key that was used on any other network/, 'the replay warning stays on the explorer');
  for (const r of ['/emission', '/mining', '/metrics', '/committee']) assert.match(await get(r), /<svg class="chart"/, 'charts on ' + r);
  for (const r of ['/governance', '/proposals', '/election', '/election-rounds', '/attestation', '/ngo-submit', '/roles', '/treasury', '/committee']) assert.match(await get(r), /New here\? How this page works/, 'guide on ' + r);
  assert.doesNotMatch(await get('/proposal/0'), /New here\?/, 'no guide on detail pages');
  assert.match(home, /Mining pool \(36 %\)/);
  assert.match(home, /Community\/Treasury \(16 %\)/);
  const map = await ex.mapData(new URLSearchParams());
  assert.equal(map.radar.length, 8);
  assert.equal(map.stats.length, (await ex.stats()).length);

  // ---- the Interim banner appears only in Interim mode
  ex.modeNow = { tip: t.chain.tip.hash, mode: 2 };
  assert.match(ex.layout('x', '<p>x</p>', '/'), /Interim mode\.<\/strong>.*may only decide attestation challenges/);
  ex.modeNow = { tip: t.chain.tip.hash, mode: 1 };
  assert.doesNotMatch(ex.layout('x', '<p>x</p>', '/'), /Interim mode\./);

  // ---- RPC host: browsers go to the explorer; /health and /api stay
  const server = await startHttp({ node, host: '127.0.0.1', port: 0 });
  try {
    const port = server.address().port;
    const req = (path, host) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path, headers: { Host: host } }, (res) => { res.resume(); resolve({ code: res.statusCode, loc: res.headers.location }); }).on('error', reject);
    });
    assert.deepEqual(await req('/blocks?page=2', 'rpc.psyrob.com'), { code: 302, loc: 'https://explorer.psyrob.com/blocks?page=2' });
    assert.equal((await req('/health', 'rpc.psyrob.com')).code, 200);
    assert.equal((await req('/api/mining', 'rpc.psyrob.com')).code, 200);
    assert.equal((await req('/', 'explorer.psyrob.com')).code, 200);
    assert.equal((await req('/vendor/bootstrap.min.css', 'explorer.psyrob.com')).code, 200);
    assert.equal((await req('/vendor/fonts/barlow-condensed-latin-600-normal.woff2', 'explorer.psyrob.com')).code, 200);
    assert.equal((await req('/proposal/424242', 'explorer.psyrob.com')).code, 404);
    // rate limits follow the real client behind the tunnel (CF-Connecting-IP on a loopback connection), so one busy
    // client cannot use up everyone's budget
    const cf = (path, ip) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path, headers: { Host: 'explorer.psyrob.com', 'CF-Connecting-IP': ip } }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject);
    });
    const codes = [];
    for (let i = 0; i < 80; i++) codes.push(await cf('/api/mining', '203.0.113.50'));
    assert.ok(codes.includes(429), 'one client is limited');
    assert.equal(await cf('/api/mining', '198.51.100.7'), 200, 'another client still gets an answer');

    // ---- downloads: served by this node from its own folder (never GitHub), listed files only, per-client limit
    const dl = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-dl-'));
    const exe = 'psyrob-miner-10.0.0-windows-x64.exe', deb = 'psyrob-miner_10.0.0_amd64.deb';
    fs.writeFileSync(path.join(dl, exe), Buffer.alloc(300_000, 7));
    fs.writeFileSync(path.join(dl, deb), Buffer.alloc(1000, 9));
    fs.writeFileSync(path.join(dl, 'unlisted.bin'), 'x');
    fs.writeFileSync(path.join(dl, 'SHA256SUMS.txt'), 'aa  ' + exe + '\n');
    fs.writeFileSync(path.join(dl, 'manifest.json'), JSON.stringify({ version: '10.0.0', built: '2026-10-11T00:00:00Z', files: [
      { name: exe, os: 'Windows', program: 'miner', bytes: 300_000, sha256: 'aa' }, { name: deb, os: 'Linux', program: 'miner', bytes: 1000, sha256: 'bb' }] }));
    const fetchRaw = (p, ip, method = 'GET') => new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: 'explorer.psyrob.com', 'CF-Connecting-IP': ip } }, (res) => {
        const parts = []; res.on('data', (d) => parts.push(d)); res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
      });
      r.on('error', reject); r.end();
    });
    try {
      server.explorer.downloads = new Downloads(dl, { perHour: 2 });
      server.explorer.cache.clear();
      const page = (await fetchRaw('/run-a-node', '192.0.2.1')).body.toString();
      assert.match(page, new RegExp(`href="/downloads/${exe}"`));
      assert.match(page, new RegExp(`href="/downloads/${deb}"`));
      assert.match(page, /href="\/downloads\/SHA256SUMS\.txt"/);
      assert.doesNotMatch(page, /github|git clone|npm ci/i, 'no GitHub or source install on the download page');
      const got = await fetchRaw('/downloads/' + exe, '192.0.2.2');
      assert.equal(got.code, 200);
      assert.equal(got.headers['content-disposition'], `attachment; filename="${exe}"`);
      assert.equal(Number(got.headers['content-length']), 300_000);
      assert.ok(got.body.equals(Buffer.alloc(300_000, 7)), 'the whole file, streamed');
      assert.equal((await fetchRaw('/downloads/' + exe, '192.0.2.2', 'HEAD')).code, 200);
      assert.equal((await fetchRaw('/downloads/SHA256SUMS.txt', '192.0.2.2')).code, 200);
      for (const bad of ['/downloads/unlisted.bin', '/downloads/../package.json', '/downloads/%2e%2e%2fpackage.json', '/downloads/', '/downloads/manifest.json/x']) assert.equal((await fetchRaw(bad, '192.0.2.3')).code, 404, bad);
      assert.equal((await fetchRaw('/downloads/' + deb, '192.0.2.2')).code, 200);
      assert.equal((await fetchRaw('/downloads/' + deb, '192.0.2.2')).code, 429, 'hourly limit per client');
      assert.equal((await fetchRaw('/downloads/' + deb, '192.0.2.9')).code, 200, 'another client still downloads');
      // a node without packages points to the public download page instead
      server.explorer.downloads = new Downloads(null);
      server.explorer.cache.clear();
      assert.match((await fetchRaw('/run-a-node', '192.0.2.1')).body.toString(), /explorer\.psyrob\.com\/run-a-node/);
    } finally {
      for (const f of fs.readdirSync(dl)) fs.unlinkSync(path.join(dl, f));
      fs.rmdirSync(dl);
    }
  } finally {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});
