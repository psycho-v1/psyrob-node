// Lists every English text of the explorer that is translated, into node/src/i18n/keys.json (sorted). The list is
// the union of
//   - every T('…') in the server's page code, and every T('…') / L('…') and marked text in the browser scripts;
//   - the texts of the constant lists the pages translate (proposal kinds, states, roles, menus, guides, …);
//   - every text actually asked for while rendering every page of a small test chain (texts that reach T() through
//     helpers such as table headings, form labels and badges).
// Run it after changing explorer texts:  PSYROB_I18N_COLLECT=1 node scripts/i18n-keys.mjs
// node/test/i18n.test.js then checks that every language translates every listed text.

import fs from 'node:fs';
import path from 'node:path';

if (!process.env.PSYROB_I18N_COLLECT) { console.error('run with PSYROB_I18N_COLLECT=1'); process.exit(1); }
const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SERVER = ['node/src/explorer.js', 'node/src/explorer-pages.js', 'node/src/explorer-governance.js', 'node/src/charts.js'];

const { COLLECTED, FILLED, withLang } = await import('../node/src/i18n.js');
const { Explorer, clientKeysOf } = await import('../node/src/explorer.js');
const { testChain, key, mineOne } = await import('../node/test/helpers.js');
const { signTx } = await import('../node/src/tx.js');
const { ADDR } = await import('../node/src/params.js');
const { contract } = await import('../common/abicodec.js');
const { keccak256 } = await import('../common/crypto.js');
const { bytesToHex } = await import('../common/bytes.js');
const { artifacts } = await import('../node/src/genesis.js');
const { Rpc } = await import('../node/src/rpc.js');

const keys = new Set();
const unq = (x) => x.replace(/\\(['\\])/g, '$1');
// 1. T('…') in the server code
for (const f of SERVER) for (const m of read(f).matchAll(/\bT\(\s*'((?:[^'\\\n]|\\.)*)'/g)) keys.add(unq(m[1]));
// 2. the constant lists and tables the pages pass to T()
const strings = (block) => [...block.matchAll(/'((?:[^'\\\n]|\\.)*)'/g)].map((m) => unq(m[1]));
for (const f of SERVER) {
  const s = read(f);
  for (const m of s.matchAll(/const (KIND|STATE|SUPPORT|MODES|NGO_STATUS|ROLE_NAMES|ACTION_KIND|ACTION_STATE|PLAN_STATE|BY) = \[([^\]]*)\]/g)) for (const x of strings(m[2])) keys.add(x);
  // the menus (paths and icon names left out) and the step-by-step guides
  for (const [start, end] of [['const NAV = [', '\n];'], ['const GUIDES = {', '\n};']]) {
    const i = s.indexOf(start);
    if (i >= 0) for (const x of strings(s.slice(i, s.indexOf(end, i)))) if (!x.startsWith('/') && !/^[a-z-]+$/.test(x)) keys.add(x);
  }
  for (const m of s.matchAll(/\bbadge\('((?:[^'\\\n]|\\.)*)'/g)) keys.add(unq(m[1]));
  for (const m of s.matchAll(/const PAUSABLE = \[([^]*?)\]\s*\n/g)) for (const x of strings(m[1])) keys.add(x);
  for (const m of s.matchAll(/kind: '([^']+)'/g)) keys.add(m[1]);
  // labels of [label, value] rows and table headings and empty texts (also on branches a test chain never reaches)
  for (const m of s.matchAll(/\[\s*'([A-Z][^'\\]{1,80})',/g)) keys.add(m[1]);
  for (const m of s.matchAll(/table\(\s*\[([^\]]*)\]/g)) for (const x of strings(m[1])) keys.add(x);
  for (const m of s.matchAll(/table\([^;]*?,\s*'([^']+)'\)/g)) keys.add(m[1]);
}
keys.add('Burn address');
for (const n of [1, 2, 3]) keys.add(`Dev Account ${n}`), keys.add(`Dev Account ${n} vesting`);
// 3. the browser scripts
for (const k of clientKeysOf(['app.js', 'register.js', 'pages.js', 'home-map.js'].map((f) => read('node/web/' + f)))) keys.add(k);

// 4. render every page of a test chain with some activity (as node/test/pages.test.js does)
const PSY = 10n ** 18n, A = artifacts(), hex = (a) => '0x' + bytesToHex(a);
const C = Object.fromEntries(['MinerRegistry', 'NGORegistry', 'VoteEscrow', 'Governor'].map((n) => [n, contract(A[n].abi, keccak256)]));
const TO = { MinerRegistry: ADDR.minerRegistry, NGORegistry: ADDR.ngoRegistry, VoteEscrow: ADDR.voteEscrow, Governor: ADDR.governor };
const t = await testChain({ params: { poolCap: 360_000_000_000n * PSY, maxSupply: 10n ** 30n } });
const nonces = new Map(), rich = key(1), ngo = key(2);
const mine = async (who, n = 1) => { for (let i = 0; i < n; i++) { t.advance(10); await mineOne(t, who); await t.chain.readAtTip((v) => t.mempool.prune(v)); } };
const send = async (from, to, data = new Uint8Array(0), value = 0n, gasLimit = 3_000_000n) => {
  const k = hex(from.addr), n = nonces.get(k) ?? (await t.chain.readAtTip((v) => v.getAccount(from.addr).nonce));
  nonces.set(k, n + 1n);
  const tx = signTx({ type: 2, nonce: n, to, data, value, gasLimit, maxFee: 20_000_000_000n, maxPriorityFee: 0n }, from.sk, t.params);
  await t.chain.readAtTip((view, ctx) => t.mempool.add(tx.raw, view, ctx.baseFee));
};
const call = (from, name, fn, args = [], value = 0n) => send(from, TO[name], C[name].encode(fn, args), value);
const mineTxs = async () => { for (let i = 0; i < 20 && t.mempool.size > 0; i++) await mine(rich); await mine(rich); };
await mine(rich, 12); await mine(ngo, 2);
await send(rich, ngo.addr, new Uint8Array(0), 1_000n * PSY, 21_000n); await mineTxs();
await call(ngo, 'MinerRegistry', 'register', ['0x' + '00'.repeat(32)]); await call(rich, 'MinerRegistry', 'register', ['0x' + '00'.repeat(32)]); await mineTxs();
await call(ngo, 'NGORegistry', 'mint', ['Example', 'NL', 'REG-1', 'https://example.org', hex(keccak256(new Uint8Array([1])))], 100n * PSY);
await call(rich, 'VoteEscrow', 'lock', [], 10_000n * PSY); await mineTxs();
await call(rich, 'Governor', 'propose', [0n, [hex(ADDR.minerRegistry)], [0n], ['0x' + bytesToHex(C.MinerRegistry.encode('declareOperator', ['0x' + 'ab'.repeat(32)]))], 'test']); await mineTxs();
await call(rich, 'Governor', 'vote', [0n, 1n]); await mineTxs();
await send(rich, ngo.addr, new Uint8Array(0), 1n, 21_000n);
const node = { chain: t.chain, params: t.params, mempool: t.mempool, p2p: null, finality: null, opts: { vhosts: ['*'] }, log: () => {} };
node.rpc = new Rpc({ chain: t.chain, mempool: t.mempool, p2p: null, finality: null, node });
const ex = new Explorer(node);
await ex.refreshMode(); await ex.refreshPause();
const routes = ['/', '/dag', '/blocks', '/block/1', '/block/0', '/txs', '/mempool', '/holders', '/emission', '/account', `/account?address=${hex(rich.addr)}`, '/account?address=x', `/address/${hex(rich.addr)}`, `/address/${hex(ngo.addr)}`,
  '/proposals', '/proposal/0', '/election-rounds', '/election-round/0', '/mining', '/committee', '/committee/0', '/developers', '/contracts', '/contract/Governor', '/run-a-node', '/ngos', `/ngo/${hex(ngo.addr)}`,
  '/ngo-submit', '/register/miner', '/register/ngo', '/attestation', '/election', '/governance', '/roles', '/treasury', '/upgrades', '/pause', '/metrics', '/network', '/mine', '/wallet', '/about', '/search?q=zzz', '/nope'];
for (const r of routes) await withLang('en', () => ex.route(r.split('?')[0], new URLSearchParams(r.split('?')[1] ?? '')).then((x) => x ?? ex.layout('Not found', '', '')));
await withLang('en', async () => { ex.layout('Error', '', ''); await ex.mapData(new URLSearchParams()); });
const skipped = [];
for (const k of COLLECTED) {
  // contract names, numbers and empty strings stay as they are in every language
  if (FILLED.has(k) || !k.trim() || /^[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+$/.test(k) || /^[\d\s.,#%:/–-]*$/.test(k) || /^0x[0-9a-fA-F…]*$/.test(k)) { skipped.push(k); continue; }
  keys.add(k);
}
// the same in every language: placeholders, units, product and contract names
const KEEP = new Set(['NL', 'true', '…', 'PSY', 'BNB', 'Gini', 'JSON-RPC', 'RPC', 'P2P', 'Windows', ...Object.keys(ex.c).filter((n) => !['Treasury', 'Attestation'].includes(n))]); // (these two are also words on the pages)
const list = [...keys].filter((k) => k.trim() && !KEEP.has(k) && !/^[A-Z][a-z]+(?:[A-Z][a-z0-9]*)+$/.test(k) && !/^[\d\s.,#%:/–-]*$/.test(k) && !/^0x[0-9a-fA-F…]*$/.test(k) && !/^[a-z]+(?:[A-Z][a-z]+)+$/.test(k)).sort();
fs.writeFileSync(path.join(ROOT, 'node/src/i18n/keys.json'), JSON.stringify(list, null, 0).replace(/","/g, '",\n"') + '\n');
console.log(`${list.length} texts, ${list.reduce((n, k) => n + k.split(/\s+/).length, 0)} words; skipped ${skipped.length} untranslatable`);
process.exit(0);
