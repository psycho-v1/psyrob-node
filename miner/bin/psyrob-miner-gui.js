#!/usr/bin/env node
// PSYROB Miner with a dashboard. Double-click the program (or run it): it starts a small web page on this computer
// only (127.0.0.1) and opens it in the browser. There you create or import the miner wallet, choose the nodes (the
// public node, your own node on this PC or another one) and the number of threads, start or stop mining, and follow
// the hash rate, the blocks found and the node. The page has 11 languages, a dark and a light theme, and an optional
// app password that hides the dashboard until you sign in (mining keeps running while you are signed out). The wallet
// key is stored encrypted with your password (scrypt and AES-256-GCM) in the data folder, with owner-only access, and
// is never written to the log.
//
//   psyrob-miner [--port <n>] [--no-browser] [--home <folder>] [--self-test]
//
//   --port <n>      port of the control page (default: a free port)
//   --no-browser    do not open the browser (the address is printed)
//   --home <dir>    data folder (default: %APPDATA%\PSYROB Miner on Windows, ~/.local/share/psyrob-miner elsewhere)
//   --self-test     check Argon2d and the worker threads, then exit (no mining)
//
// Forgot the app password? Quit the miner and delete app.json in the data folder (the wallet keeps its own password).

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, timingSafeEqual, scryptSync } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Miner } from '../src/miner.js';
import { encryptKey, decryptKey } from '../src/wallet.js';
import { History } from '../src/stats.js';
import { page, LANG_CODES } from '../gui/page.js';
import { asset } from '../gui/assets.js';
import { availableImpls, selfTest } from '../../common/pow.js';
import { privateKeyToAddress } from '../../common/crypto.js';
import { bytesToHex } from '../../common/bytes.js';
import { NODE_VERSION, TESTNET_CHAIN_ID, TESTNET_NAME } from '../../node/src/params.js';

const VERSION = NODE_VERSION;
const CHAIN_ID = Number(TESTNET_CHAIN_ID);
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);
const NODE_URL = /^https?:\/\/[^\s<>"']+$/;

async function runSelfTest() {
  try {
    const impls = availableImpls();
    selfTest(impls, { maxMemoryKiB: 4096 });
    const impl = await Miner.checkWorker(impls[0]);
    console.log(`self-test passed: Argon2d (${impls.join(', ')}) and worker threads (${impl})`);
    process.exit(0);
  } catch (e) {
    console.error('self-test FAILED: ' + e.message);
    process.exit(1);
  }
}

if (flag('self-test')) runSelfTest();
else main();

function main() {
  // ---- data folder, settings and wallet
  const HOME = path.resolve(opt('home', process.env.PSYROB_MINER_HOME || (process.platform === 'win32'
    ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'PSYROB Miner')
    : path.join(os.homedir(), '.local', 'share', 'psyrob-miner'))));
  fs.mkdirSync(HOME, { recursive: true, mode: 0o700 });
  const LEGACY = path.join(HOME, 'wallet.key'); // a plain, unencrypted key file
  const WALLET = path.join(HOME, 'wallet.json'); // encrypted
  const CONF = path.join(HOME, 'settings.json');
  const APP = path.join(HOME, 'app.json'); // the app password (a scrypt hash), when one is set
  const cpus = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
  // default: half the logical processors, which is the physical cores on most PCs: more
  // threads than physical cores add little, and a node on the same PC needs a core of its own
  let settings = { nodes: ['https://rpc.psyrob.com'], threads: Math.max(1, Math.floor(cpus / 2)), genesis: null,
    lang: null, theme: 'dark', autoStart: false, autoLockMinutes: 0, explorer: 'https://explorer.psyrob.com' };
  try {
    const saved = JSON.parse(fs.readFileSync(CONF, 'utf8'));
    settings = { ...settings, ...saved };
    if (saved.node && !saved.nodes) settings.nodes = [saved.node]; // a settings file with a single node
    delete settings.node;
  } catch { /* first start */ }
  const saveSettings = () => fs.writeFileSync(CONF, JSON.stringify(settings, null, 1), { mode: 0o600 });

  let unlocked = null; // the key, after the password was given (memory only)
  const readLegacy = () => {
    try { const h = fs.readFileSync(LEGACY, 'utf8').trim().replace(/^0x/, ''); return /^[0-9a-fA-F]{64}$/.test(h) ? Uint8Array.from(Buffer.from(h, 'hex')) : null; } catch { return null; }
  };
  const readWallet = () => { try { return JSON.parse(fs.readFileSync(WALLET, 'utf8')); } catch { return null; } };
  const addressOf = (k) => '0x' + bytesToHex(privateKeyToAddress(k));
  /** none | locked | unlocked | unprotected (a plain, unencrypted wallet.key) */
  const walletState = () => (readWallet() ? (unlocked ? 'unlocked' : 'locked') : readLegacy() ? 'unprotected' : 'none');
  const currentKey = () => (readWallet() ? unlocked : readLegacy());
  const walletAddress = () => readWallet()?.address ?? (readLegacy() ? addressOf(readLegacy()) : null);
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const checkPassword = (p) => { if (typeof p !== 'string' || p.length < 8) throw fail(400, 'choose a password of at least 8 characters'); };
  function writeWallet(k, password) {
    if (fs.existsSync(WALLET)) throw fail(409, 'a wallet exists already');
    fs.writeFileSync(WALLET, JSON.stringify(encryptKey(k, password), null, 1), { mode: 0o600, flag: 'wx' }); // never overwrites
    unlocked = k;
  }
  /** Replace a file in one step (a new file renamed over the old one): a crash leaves the old or the new one. */
  function replaceFile(file, text) {
    const tmp = file + '.new';
    fs.writeFileSync(tmp, text, { mode: 0o600 });
    fs.renameSync(tmp, file);
  }

  // ---- the app password: it only hides the dashboard; the wallet keeps its own password
  const APP_KDF = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
  const readApp = () => { try { const j = JSON.parse(fs.readFileSync(APP, 'utf8')); return j?.kdf === 'scrypt' ? j : null; } catch { return null; } };
  const appHash = (pw, a) => scryptSync(String(pw), Buffer.from(a.salt, 'hex'), 32, { N: a.N, r: a.r, p: a.p, maxmem: APP_KDF.maxmem });
  const sessions = new Set(); // signed-in pages (memory only: a restart signs everybody out)
  let loginFails = 0, loginBlockedUntil = 0;
  function appPasswordOk(pw) {
    const a = readApp();
    if (!a) return true;
    if (Date.now() < loginBlockedUntil) throw fail(429, 'too many wrong passwords; wait 30 seconds');
    if (timingSafeEqual(appHash(pw, a), Buffer.from(a.hash, 'hex'))) { loginFails = 0; return true; }
    if (++loginFails >= 5) { loginFails = 0; loginBlockedUntil = Date.now() + 30_000; }
    return false;
  }
  function newSession() { const s = randomBytes(18).toString('hex'); sessions.add(s); return s; }
  const sessionOk = (s) => typeof s === 'string' && sessions.has(s);

  // ---- mining
  const logs = [];
  const log = (...a) => { const line = `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`; logs.push(line); if (logs.length > 500) logs.shift(); console.log(line); };
  let miner = null, startedAt = 0;
  let chain = { height: null, blueScore: null, balance: null, error: null, otherGenesis: null, syncing: false, targetSpacing: 10, tips: null, peers: null, version: null };
  const history = new History(path.join(HOME, 'stats.json'));

  async function rpc(method, params = [], nodes = settings.nodes) {
    let lastError;
    for (const node of nodes) {
      try {
        const r = await fetch(node, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(15_000) });
        const text = await r.text();
        let j;
        try { j = JSON.parse(text); } catch { throw new Error(`${node} answered with a web page (HTTP ${r.status}), not JSON-RPC`); }
        if (j.error) throw new Error(j.error.message);
        return j.result;
      } catch (e) { lastError = e; }
    }
    throw lastError ?? new Error('no node set');
  }
  async function refreshChain() {
    try {
      const a = walletAddress();
      const [info, bal] = await Promise.all([rpc('psy_dagInfo'), a ? rpc('eth_getBalance', [a, 'latest']) : null]);
      if (Number(info.chainId) !== CHAIN_ID) throw new Error(`the node is on chain ${Number(info.chainId)}, not ${CHAIN_ID} (${TESTNET_NAME})`);
      // the network this miner mines on is remembered; a node on another genesis is refused until accepted here
      if (!settings.genesis) { settings.genesis = info.genesis; saveSettings(); }
      const other = String(info.genesis).toLowerCase() !== String(settings.genesis).toLowerCase() ? info.genesis : null;
      const [syncing, peers, version] = await Promise.all([rpc('eth_syncing').catch(() => false), rpc('net_peerCount').catch(() => null), rpc('web3_clientVersion').catch(() => null)]);
      chain = { height: info.chainHeight, blueScore: info.blueScore, balance: bal, error: other ? 'the node runs another network than the one this miner mines on (it may have been reset)' : null,
        otherGenesis: other, syncing: !!syncing, targetSpacing: info.targetSpacing ?? 10, tips: info.tips?.length ?? null, peers: peers === null ? null : Number(peers), version };
    } catch (e) { chain = { ...chain, error: e.message }; }
  }
  setInterval(refreshChain, 15_000).unref();
  refreshChain();
  setInterval(() => history.sample(miner), 5_000).unref();
  setInterval(() => history.save(), 300_000).unref();

  async function startMining() {
    const k = currentKey();
    if (!k) throw new Error(walletState() === 'locked' ? 'unlock the wallet with its password first' : 'create or import a wallet first');
    if (miner) return;
    const m = new Miner({ urls: settings.nodes, key: k, threads: settings.threads, expect: { chainId: CHAIN_ID, genesis: settings.genesis }, log: (...a) => log(...a.map(String)) });
    miner = m;
    startedAt = Date.now();
    try { await m.start(); } catch (e) { miner = null; await m.stop().catch(() => {}); throw e; }
  }
  async function stopMining() {
    if (!miner) return;
    const m = miner; miner = null;
    history.sample(m); // the last counts of this run
    history.sample(null);
    await m.stop();
    log('mining stopped');
  }
  /** "Start mining when the wallet is unlocked" (an unprotected wallet: at once). */
  const autoStart = () => { if (settings.autoStart && !miner && currentKey()) startMining().catch((e) => log('auto start: ' + e.message)); };
  autoStart();

  /** What the dashboard shows about mining: rates, threads, the current job and estimates. */
  function miningState() {
    const secs = miner ? (Date.now() - startedAt) / 1000 : 0;
    const live = history.live.slice(-12).filter((p) => p.rate > 0);
    const rate = miner && secs > 0 ? miner.attempts / secs : 0;
    const rateNow = live.length ? live.reduce((s, p) => s + p.rate, 0) / live.length : rate;
    const job = miner?.job;
    let est = null;
    if (job) {
      const work = Number((1n << 256n) / (BigInt(job.header.target) + 1n)); // attempts per block, on average
      est = { attemptsPerBlock: work, networkRate: work / (chain.targetSpacing || 10), secondsPerBlock: rateNow > 0 ? work / rateNow : null };
    }
    return {
      mining: !!miner, uptime: secs, rate, rateNow, found: miner?.found ?? 0, accepted: miner?.accepted ?? 0, rejected: miner?.rejected ?? 0, node: miner?.url ?? null,
      latencyMs: miner?.latencyMs ?? null, waiting: !!miner?.waitingSince, impl: miner?.impl ?? availableImpls()[0],
      threads: miner ? miner.threadAttempts.map((n) => (secs > 0 ? n / secs : 0)) : [],
      job: job ? { blueScore: Number(job.header.blueScore), parents: job.header.parents.length, target: job.header.target, ageSeconds: (Date.now() - miner.jobAt) / 1000, memoryKiB: job.pow?.memoryKiB, iterations: job.pow?.iterations } : null,
      estimate: est,
    };
  }

  /** Test a node without changing the settings: answers, network, height, sync state and round trip. */
  async function testNode(url) {
    const t0 = Date.now();
    const info = await rpc('psy_dagInfo', [], [url]);
    const latencyMs = Date.now() - t0;
    const [syncing, version, peers] = await Promise.all([rpc('eth_syncing', [], [url]).catch(() => false), rpc('web3_clientVersion', [], [url]).catch(() => null), rpc('net_peerCount', [], [url]).catch(() => null)]);
    const chainOk = Number(info.chainId) === CHAIN_ID;
    const genesisOk = chainOk && (!settings.genesis || String(info.genesis).toLowerCase() === String(settings.genesis).toLowerCase());
    return { url, latencyMs, chainId: Number(info.chainId), chainOk, genesisOk, height: info.chainHeight, blueScore: info.blueScore, syncing: !!syncing, version, peers: peers === null ? null : Number(peers) };
  }

  // ---- the control page (this computer only)
  const TOKEN = randomBytes(18).toString('hex');
  const tokenOk = (t) => typeof t === 'string' && t.length === TOKEN.length && timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    const host = String(req.headers.host || '');
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }); res.end(body); };
    const json = (code, x) => send(code, JSON.stringify(x));
    // only this computer, under its own name (no DNS rebinding), and only with the token from the address bar
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, '{"error":"wrong host"}');
    const url = new URL(req.url, 'http://x');
    try {
      // the PSYROB fonts, icons and logo (public files, no token needed)
      const a = req.method === 'GET' && asset(url.pathname);
      if (a) { res.writeHead(200, { 'Content-Type': a[1], 'Cache-Control': 'max-age=86400', 'X-Content-Type-Options': 'nosniff' }); return res.end(a[0]); }
      if (req.method === 'GET' && url.pathname === '/') return tokenOk(url.searchParams.get('t')) ? send(200, page({ lang: settings.lang, theme: settings.theme }), 'text/html; charset=utf-8') : send(403, 'Open the address printed by PSYROB Miner.', 'text/plain');
      if (!tokenOk(req.headers['x-token'])) return send(403, '{"error":"token"}');
      let body = {};
      if (req.method === 'POST') { let s = ''; for await (const c of req) { s += c; if (s.length > 10_000) return send(413, '{}'); } body = s ? JSON.parse(s) : {}; }

      // ---- signing in (only these answer while the app password is set and the page is signed out)
      const appSet = !!readApp();
      const signedIn = !appSet || sessionOk(req.headers['x-session']);
      if (url.pathname === '/api/app') return json(200, { version: VERSION, network: TESTNET_NAME, protected: appSet, signedIn, lang: settings.lang, theme: settings.theme, autoLockMinutes: settings.autoLockMinutes });
      if (url.pathname === '/api/app/login' && req.method === 'POST') {
        if (!appSet) return json(200, { session: null });
        if (!appPasswordOk(body.password)) return send(400, '{"error":"wrong password"}');
        return json(200, { session: newSession() });
      }
      if (url.pathname === '/api/app/logout' && req.method === 'POST') { sessions.delete(req.headers['x-session']); return send(200, '{"ok":true}'); }
      if (!signedIn) return send(401, '{"error":"signed out"}');

      if (url.pathname === '/api/state') {
        const m = miningState();
        return json(200, { version: VERSION, network: TESTNET_NAME, chainId: CHAIN_ID, address: walletAddress(), wallet: walletState(), settings, cpus, ...m,
          chain, logs: logs.slice(-200), home: HOME, totals: history.totals, live: history.live, blocks: history.blocks.slice(-50).concat((miner?.blocks ?? []).filter((b) => b.status === 'pending')), appProtected: appSet });
      }
      if (url.pathname === '/api/history') return json(200, history.range(String(url.searchParams.get('range') ?? '1h')));
      if (req.method !== 'POST') return send(405, '{}');
      const state = walletState();
      if (url.pathname === '/api/wallet/new') {
        if (state !== 'none') return send(409, '{"error":"a wallet exists already"}');
        checkPassword(body.password);
        const n = randomBytes(32); writeWallet(n, body.password); log('new wallet ' + addressOf(n)); autoStart(); return json(200, { address: addressOf(n) });
      }
      if (url.pathname === '/api/wallet/import') {
        if (state !== 'none') return send(409, '{"error":"a wallet exists already"}');
        const h = String(body.key ?? '').trim().replace(/^0x/, '');
        if (!/^[0-9a-fA-F]{64}$/.test(h)) return send(400, '{"error":"a private key is 64 hex characters"}');
        checkPassword(body.password);
        const n = Uint8Array.from(Buffer.from(h, 'hex')); writeWallet(n, body.password); log('wallet imported ' + addressOf(n)); autoStart(); return json(200, { address: addressOf(n) });
      }
      if (url.pathname === '/api/wallet/unlock') {
        const w = readWallet();
        if (!w) return send(400, '{"error":"no encrypted wallet"}');
        try { unlocked = decryptKey(w, String(body.password ?? '')); } catch { return send(400, '{"error":"wrong password"}'); }
        autoStart();
        return json(200, { address: w.address });
      }
      if (url.pathname === '/api/wallet/lock') {
        if (miner) return send(409, '{"error":"stop mining first"}');
        unlocked = null;
        return send(200, '{"ok":true}');
      }
      if (url.pathname === '/api/wallet/password') {
        const w = readWallet();
        if (!w) return send(400, '{"error":"no encrypted wallet"}');
        let k;
        try { k = decryptKey(w, String(body.current ?? '')); } catch { return send(400, '{"error":"wrong password"}'); }
        checkPassword(body.next);
        replaceFile(WALLET, JSON.stringify(encryptKey(k, body.next), null, 1));
        log('wallet password changed');
        return send(200, '{"ok":true}');
      }
      if (url.pathname === '/api/wallet/protect') {
        const k = readLegacy();
        if (!k || readWallet()) return send(400, '{"error":"nothing to protect"}');
        checkPassword(body.password);
        writeWallet(k, body.password);
        fs.writeFileSync(LEGACY, '0'.repeat(64) + '\n');
        fs.unlinkSync(LEGACY);
        log('wallet protected with a password ' + addressOf(k));
        return json(200, { address: addressOf(k) });
      }
      if (url.pathname === '/api/wallet/reveal') {
        const k = currentKey();
        if (!k || body.confirm !== 'I will keep it secret') return send(400, '{"error":"confirm first"}');
        if (readWallet()) { try { decryptKey(readWallet(), String(body.password ?? '')); } catch { return send(400, '{"error":"wrong password"}'); } }
        return json(200, { key: '0x' + bytesToHex(k) });
      }
      if (url.pathname === '/api/app/password') {
        // set (no password yet), change (the current one), or remove (the current one and an empty new one)
        if (appSet && !appPasswordOk(body.current)) return send(400, '{"error":"wrong password"}');
        sessions.clear();
        if (body.next === '' && appSet) { fs.unlinkSync(APP); log('app password removed'); return json(200, { session: null }); }
        checkPassword(body.next);
        const salt = randomBytes(16).toString('hex'), a = { kdf: 'scrypt', N: APP_KDF.N, r: APP_KDF.r, p: APP_KDF.p, salt };
        replaceFile(APP, JSON.stringify({ ...a, hash: appHash(body.next, a).toString('hex') }));
        log(appSet ? 'app password changed' : 'app password set');
        return json(200, { session: newSession() });
      }
      if (url.pathname === '/api/settings') {
        if (miner) return send(409, '{"error":"stop mining first"}');
        const list = (Array.isArray(body.nodes) ? body.nodes : String(body.nodes ?? body.node ?? settings.nodes.join('\n')).split(/\s+/)).map((s) => String(s).trim().replace(/\/$/, '')).filter(Boolean);
        if (!list.length || list.length > 8 || !list.every((n) => NODE_URL.test(n))) return send(400, '{"error":"each node address starts with https:// or http:// (one per line, at most 8)"}');
        settings = { ...settings, nodes: [...new Set(list)], threads: Math.max(1, Math.min(cpus, Number(body.threads ?? settings.threads) || 1)) }; saveSettings(); refreshChain(); return json(200, settings);
      }
      if (url.pathname === '/api/prefs') {
        // page preferences: can change while mining
        const p = {};
        if ('lang' in body) { if (body.lang !== null && !LANG_CODES.includes(body.lang)) return send(400, '{"error":"unknown language"}'); p.lang = body.lang; }
        if ('theme' in body) { if (!['system', 'dark', 'light'].includes(body.theme)) return send(400, '{"error":"unknown theme"}'); p.theme = body.theme; }
        if ('autoStart' in body) p.autoStart = !!body.autoStart;
        if ('autoLockMinutes' in body) { const n = Number(body.autoLockMinutes); if (![0, 5, 15, 30, 60].includes(n)) return send(400, '{"error":"auto log out: 0, 5, 15, 30 or 60 minutes"}'); p.autoLockMinutes = n; }
        if ('explorer' in body) { const e = String(body.explorer).trim().replace(/\/$/, ''); if (!/^https?:\/\/[^\s<>"'/]+$/.test(e)) return send(400, '{"error":"the explorer address starts with https:// or http://"}'); p.explorer = e; }
        settings = { ...settings, ...p }; saveSettings(); return json(200, settings);
      }
      if (url.pathname === '/api/nodes/test') {
        const u = String(body.url ?? '').trim().replace(/\/$/, '');
        if (!NODE_URL.test(u)) return send(400, '{"error":"a node address starts with https:// or http://"}');
        try { return json(200, { ok: true, ...(await testNode(u)) }); } catch (e) { return json(200, { ok: false, url: u, error: e.message }); }
      }
      if (url.pathname === '/api/network/accept') {
        // the network was reset (new genesis): mine on the node's network from now on
        if (miner) return send(409, '{"error":"stop mining first"}');
        if (!chain.otherGenesis) return send(400, '{"error":"no other network to accept"}');
        settings.genesis = chain.otherGenesis; saveSettings(); log('now mining on the network with genesis ' + settings.genesis); await refreshChain();
        return send(200, '{"ok":true}');
      }
      if (url.pathname === '/api/start') { await startMining(); return send(200, '{"ok":true}'); }
      if (url.pathname === '/api/stop') { await stopMining(); return send(200, '{"ok":true}'); }
      if (url.pathname === '/api/quit') { send(200, '{"ok":true}'); await stopMining(); history.save(); setTimeout(() => process.exit(0), 200); return; }
      return send(404, '{}');
    } catch (e) { return send([400, 409, 429].includes(e.code) ? e.code : 500, JSON.stringify({ error: e.message })); }
  });

  server.listen(Number(opt('port', 0)), '127.0.0.1', () => {
    const address = `http://127.0.0.1:${server.address().port}/?t=${TOKEN}`;
    console.log(`PSYROB Miner ${VERSION} (${TESTNET_NAME}) is running. Control page (this computer only):\n  ${address}\nData folder: ${HOME}\nClose this window, or press Quit on the page, to stop.`);
    if (!flag('no-browser')) {
      const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', address]] : process.platform === 'darwin' ? ['open', [address]] : ['xdg-open', [address]];
      try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* open it by hand */ }
    }
  });
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { await stopMining().catch(() => {}); history.save(); process.exit(0); });
}
