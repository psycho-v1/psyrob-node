#!/usr/bin/env node
// PSYROB Miner with a control page. Double-click the program (or run it): it starts a small web page on this computer
// only (127.0.0.1) and opens it in the browser. There you create or import the miner wallet, choose the nodes and the
// number of threads, and start or stop mining. The wallet key is stored encrypted with your password (scrypt and
// AES-256-GCM) in the data folder, with owner-only access, and is never written to the log.
//
//   psyrob-miner [--port <n>] [--no-browser] [--home <folder>] [--self-test]
//
//   --port <n>      port of the control page (default: a free port)
//   --no-browser    do not open the browser (the address is printed)
//   --home <dir>    data folder (default: %APPDATA%\PSYROB Miner on Windows, ~/.local/share/psyrob-miner elsewhere)
//   --self-test     check Argon2d and the worker threads, then exit (no mining)

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { Miner } from '../src/miner.js';
import { encryptKey, decryptKey } from '../src/wallet.js';
import { availableImpls, selfTest } from '../../common/pow.js';
import { privateKeyToAddress } from '../../common/crypto.js';
import { bytesToHex } from '../../common/bytes.js';
import { NODE_VERSION, TESTNET_CHAIN_ID, TESTNET_NAME } from '../../node/src/params.js';

const VERSION = NODE_VERSION;
const CHAIN_ID = Number(TESTNET_CHAIN_ID);
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);

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
  const cpus = Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
  // default: half the logical processors, which is the physical cores on most PCs: more
  // threads than physical cores add little, and a node on the same PC needs a core of its own
  let settings = { nodes: ['https://rpc.psyrob.com'], threads: Math.max(1, Math.floor(cpus / 2)), genesis: null };
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
  const checkPassword = (p) => { if (typeof p !== 'string' || p.length < 8) throw Object.assign(new Error('choose a password of at least 8 characters'), { code: 400 }); };
  function writeWallet(k, password) {
    if (fs.existsSync(WALLET)) throw Object.assign(new Error('a wallet exists already'), { code: 409 });
    fs.writeFileSync(WALLET, JSON.stringify(encryptKey(k, password), null, 1), { mode: 0o600, flag: 'wx' }); // never overwrites
    unlocked = k;
  }

  // ---- mining
  const logs = [];
  const log = (...a) => { const line = `${new Date().toISOString().slice(11, 19)} ${a.join(' ')}`; logs.push(line); if (logs.length > 200) logs.shift(); console.log(line); };
  let miner = null, startedAt = 0, chain = { height: null, balance: null, error: null, otherGenesis: null, syncing: false };

  async function rpc(method, params = []) {
    let lastError;
    for (const node of settings.nodes) {
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
      const syncing = await rpc('eth_syncing').catch(() => false);
      chain = { height: info.chainHeight, balance: bal, error: other ? 'the node runs another network than the one this miner mines on (it may have been reset)' : null, otherGenesis: other, syncing: !!syncing };
    } catch (e) { chain = { ...chain, error: e.message }; }
  }
  setInterval(refreshChain, 15_000).unref();
  refreshChain();

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
    await m.stop();
    log('mining stopped');
  }

  // ---- the control page (this computer only)
  const TOKEN = randomBytes(18).toString('hex');
  const tokenOk = (t) => typeof t === 'string' && t.length === TOKEN.length && timingSafeEqual(Buffer.from(t), Buffer.from(TOKEN));
  const server = http.createServer(async (req, res) => {
    const port = server.address().port;
    const host = String(req.headers.host || '');
    const send = (code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" }); res.end(body); };
    // only this computer, under its own name (no DNS rebinding), and only with the token from the address bar
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(403, '{"error":"wrong host"}');
    const url = new URL(req.url, 'http://x');
    try {
      if (req.method === 'GET' && url.pathname === '/') return tokenOk(url.searchParams.get('t')) ? send(200, page(), 'text/html; charset=utf-8') : send(403, 'Open the address printed by PSYROB Miner.', 'text/plain');
      if (!tokenOk(req.headers['x-token'])) return send(403, '{"error":"token"}');
      let body = {};
      if (req.method === 'POST') { let s = ''; for await (const c of req) { s += c; if (s.length > 10_000) return send(413, '{}'); } body = s ? JSON.parse(s) : {}; }
      if (url.pathname === '/api/state') {
        const secs = miner ? (Date.now() - startedAt) / 1000 : 0;
        return send(200, JSON.stringify({ version: VERSION, network: TESTNET_NAME, chainId: CHAIN_ID, address: walletAddress(), wallet: walletState(), settings, cpus, mining: !!miner,
          rate: miner && secs > 0 ? miner.attempts / secs : 0, found: miner?.found ?? 0, accepted: miner?.accepted ?? 0, node: miner?.url ?? null, chain, logs: logs.slice(-40), home: HOME }));
      }
      if (req.method !== 'POST') return send(405, '{}');
      const state = walletState();
      if (url.pathname === '/api/wallet/new') {
        if (state !== 'none') return send(409, '{"error":"a wallet exists already"}');
        checkPassword(body.password);
        const n = randomBytes(32); writeWallet(n, body.password); log('new wallet ' + addressOf(n)); return send(200, JSON.stringify({ address: addressOf(n) }));
      }
      if (url.pathname === '/api/wallet/import') {
        if (state !== 'none') return send(409, '{"error":"a wallet exists already"}');
        const h = String(body.key ?? '').trim().replace(/^0x/, '');
        if (!/^[0-9a-fA-F]{64}$/.test(h)) return send(400, '{"error":"a private key is 64 hex characters"}');
        checkPassword(body.password);
        const n = Uint8Array.from(Buffer.from(h, 'hex')); writeWallet(n, body.password); log('wallet imported ' + addressOf(n)); return send(200, JSON.stringify({ address: addressOf(n) }));
      }
      if (url.pathname === '/api/wallet/unlock') {
        const w = readWallet();
        if (!w) return send(400, '{"error":"no encrypted wallet"}');
        try { unlocked = decryptKey(w, String(body.password ?? '')); } catch { return send(400, '{"error":"wrong password"}'); }
        return send(200, JSON.stringify({ address: w.address }));
      }
      if (url.pathname === '/api/wallet/protect') {
        // a plain wallet.key: encrypt it, then overwrite and remove the plain file
        const k = readLegacy();
        if (!k || readWallet()) return send(400, '{"error":"nothing to protect"}');
        checkPassword(body.password);
        writeWallet(k, body.password);
        fs.writeFileSync(LEGACY, '0'.repeat(64) + '\n');
        fs.unlinkSync(LEGACY);
        log('wallet protected with a password ' + addressOf(k));
        return send(200, JSON.stringify({ address: addressOf(k) }));
      }
      if (url.pathname === '/api/wallet/reveal') {
        const k = currentKey();
        if (!k || body.confirm !== 'I will keep it secret') return send(400, '{"error":"confirm first"}');
        if (readWallet()) { try { decryptKey(readWallet(), String(body.password ?? '')); } catch { return send(400, '{"error":"wrong password"}'); } }
        return send(200, JSON.stringify({ key: '0x' + bytesToHex(k) }));
      }
      if (url.pathname === '/api/settings') {
        if (miner) return send(409, '{"error":"stop mining first"}');
        const list = (Array.isArray(body.nodes) ? body.nodes : String(body.nodes ?? body.node ?? settings.nodes.join('\n')).split(/\s+/)).map((s) => String(s).trim()).filter(Boolean);
        if (!list.length || list.length > 8 || !list.every((n) => /^https?:\/\/[^\s<>"']+$/.test(n))) return send(400, '{"error":"each node address starts with https:// or http:// (one per line, at most 8)"}');
        settings = { ...settings, nodes: list, threads: Math.max(1, Math.min(cpus, Number(body.threads) || 1)) }; saveSettings(); refreshChain(); return send(200, JSON.stringify(settings));
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
      if (url.pathname === '/api/quit') { send(200, '{"ok":true}'); await stopMining(); setTimeout(() => process.exit(0), 200); return; }
      return send(404, '{}');
    } catch (e) { return send(e.code === 400 || e.code === 409 ? e.code : 500, JSON.stringify({ error: e.message })); }
  });

  server.listen(Number(opt('port', 0)), '127.0.0.1', () => {
    const address = `http://127.0.0.1:${server.address().port}/?t=${TOKEN}`;
    console.log(`PSYROB Miner ${VERSION} (${TESTNET_NAME}) is running. Control page (this computer only):\n  ${address}\nData folder: ${HOME}\nClose this window, or press Quit on the page, to stop.`);
    if (!flag('no-browser')) {
      const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', address]] : process.platform === 'darwin' ? ['open', [address]] : ['xdg-open', [address]];
      try { spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref(); } catch { /* open it by hand */ }
    }
  });
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { await stopMining().catch(() => {}); process.exit(0); });

  function page() {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PSYROB Miner</title><style>
  :root{--bg:#071014;--ink:#e7f4f2;--mute:#8aa8a6;--line:#1c3336;--cyan:#3ee0d6;--panel:#0c181c;--field:#081216}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,sans-serif}
  header{border-bottom:1px solid var(--line);padding:14px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}header b{letter-spacing:.22em}.test{background:var(--cyan);color:#06201e;font-size:12px;padding:3px 7px;letter-spacing:.12em}
  main{max-width:980px;margin:auto;padding:20px 16px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
  .panel{background:var(--panel);border:1px solid var(--line);padding:16px;min-width:0}h2{font-size:15px;letter-spacing:.12em;text-transform:uppercase;color:var(--mute);margin:0 0 10px}
  .big{font-size:34px;font-weight:600}.muted{color:var(--mute)}code{color:var(--cyan);word-break:break-all}
  button{background:transparent;color:var(--cyan);border:1px solid var(--line);padding:9px 14px;font:inherit;cursor:pointer;letter-spacing:.06em}button.primary{background:var(--cyan);color:#06201e;border-color:var(--cyan)}
  button:disabled{opacity:.4;cursor:default}input,select,textarea{background:var(--field);color:var(--ink);border:1px solid var(--line);padding:8px;font:inherit;width:100%}label{display:block;margin:8px 0 4px;color:var(--mute);font-size:14px}
  .warn{border:1px solid #6b5a2a;background:#151208;color:#e8d9a8;padding:10px 12px;margin:10px 0}.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
  pre{background:var(--field);border:1px solid var(--line);padding:10px;max-height:220px;overflow:auto;font-size:13px;margin:0;white-space:pre-wrap;word-break:break-word}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:var(--mute);margin-right:6px}.on .dot{background:var(--cyan);animation:p 1.6s infinite}@keyframes p{50%{opacity:.3}}
  </style></head><body><header><b>PSYROB</b> MINER <span class="test" id="net">TESTNET</span><span class="muted" style="margin-left:auto" id="ver"></span></header><main>
  <div class="grid">
  <section class="panel" id="status"><h2>Status</h2><div class="big"><span class="dot"></span><span id="state">…</span></div><p class="muted" id="rate"></p><div class="row"><button class="primary" id="start">Start mining</button><button id="stop">Stop</button></div></section>
  <section class="panel"><h2>Wallet</h2><div id="wallet"></div></section>
  <section class="panel"><h2>Network</h2><p>Chain height: <b id="height">–</b><br>Balance: <b id="balance">–</b> PSY</p><p class="muted" id="neterr"></p><div id="accept"></div></section>
  </div>
  <div class="grid" style="margin-top:14px">
  <section class="panel"><h2>Settings</h2><label for="nodes">Nodes (JSON-RPC), one per line: the first that answers is used, the next ones are the fallback</label><textarea id="nodes" rows="3"></textarea>
  <label for="threads">Threads (each uses one CPU core and 32 MiB)</label><select id="threads"></select>
  <p class="muted">Tip: use at most as many threads as your PC has physical cores (often half the number shown here). If a PSYROB node runs on this PC too, leave one core free for it.</p>
  <div class="row"><button id="save">Save</button></div><p class="muted" id="saved"></p></section>
  <section class="panel"><h2>Log</h2><pre id="log"></pre></section>
  </div>
  <p class="muted" style="margin-top:14px">Data folder: <code id="home"></code>. <button id="quit">Quit PSYROB Miner</button></p>
  </main><script>
  const T=new URLSearchParams(location.search).get('t');const $=(i)=>document.getElementById(i);
  async function api(p,b){const r=await fetch(p,{method:b===undefined?'GET':'POST',headers:{'X-Token':T,'Content-Type':'application/json'},body:b===undefined?undefined:JSON.stringify(b)});const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j}
  function text(el,s){el.textContent=s}
  function el(tag,props,...kids){const e=document.createElement(tag);Object.assign(e,props||{});e.append(...kids);return e}
  function pw(ph){return el('input',{type:'password',placeholder:ph,autocomplete:'new-password'})}
  let walletKey='';
  function wallet(st){const w=$('wallet');const key=st.wallet+':'+st.address;if(key===walletKey)return;walletKey=key;w.replaceChildren();
  if(st.address){w.append(el('p',{},'Address:',el('br'),el('code',{textContent:st.address})))}
  if(st.wallet==='none'){const p1=pw('password (at least 8 characters)'),k=el('input',{type:'password',placeholder:'0x… private key to import'}),p2=pw('password for the imported key');
  w.append(el('p',{textContent:'No wallet yet. Create a new one, or import a key you already use for this network. The key is stored encrypted with your password.'}),p1,
  el('div',{className:'row'},el('button',{className:'primary',textContent:'Create a new wallet',onclick:async()=>{try{await api('/api/wallet/new',{password:p1.value});p1.value='';walletKey='';load()}catch(e){alert(e.message)}}})),
  el('hr',{style:'border-color:var(--line)'}),k,p2,el('div',{className:'row'},el('button',{textContent:'Import',onclick:async()=>{try{await api('/api/wallet/import',{key:k.value,password:p2.value});k.value='';p2.value='';walletKey='';load()}catch(e){alert(e.message)}}})))}
  if(st.wallet==='locked'){const p=pw('wallet password');p.autocomplete='current-password';w.append(el('p',{className:'muted',textContent:'The wallet is locked. Enter its password to mine.'}),p,el('div',{className:'row'},el('button',{className:'primary',textContent:'Unlock',onclick:async()=>{try{await api('/api/wallet/unlock',{password:p.value});p.value='';walletKey='';load()}catch(e){alert(e.message)}}})))}
  if(st.wallet==='unprotected'){const p=pw('new password (at least 8 characters)');w.append(el('p',{className:'warn',textContent:'This wallet key is stored without a password. Protect it now: it is encrypted, and the plain file is removed.'}),p,el('div',{className:'row'},el('button',{className:'primary',textContent:'Protect with a password',onclick:async()=>{try{await api('/api/wallet/protect',{password:p.value});p.value='';walletKey='';load()}catch(e){alert(e.message)}}})))}
  if(st.wallet==='unlocked'||st.wallet==='unprotected'){const p=pw('wallet password');p.autocomplete='current-password';if(st.wallet!=='unlocked')p.style.display='none';
  w.append(el('p',{className:'warn',textContent:'Back up this wallet: a lost key cannot be recovered.'}),p,el('div',{className:'row'},el('button',{textContent:'Back up the key',onclick:async()=>{if(!confirm('Show the private key? Anyone who sees it can take your PSY. Write it down on paper and keep it offline.'))return;try{const r=await api('/api/wallet/reveal',{confirm:'I will keep it secret',password:p.value});p.value='';w.append(el('div',{className:'warn'},'Private key (keep it secret, write it down): ',el('code',{textContent:r.key})))}catch(e){alert(e.message)}}})))}}
  let first=true;async function load(){const st=await api('/api/state');text($('ver'),'v'+st.version);text($('net'),st.network.toUpperCase().replace('PSYROB ',''));$('status').className='panel'+(st.mining?' on':'');text($('state'),st.mining?'Mining':'Stopped');
  text($('rate'),st.mining?st.rate.toFixed(1)+' attempts/s · '+st.found+' found · '+st.accepted+' accepted'+(st.node?' · via '+st.node:''):(st.wallet==='locked'?'Unlock the wallet to mine.':st.address?'Ready to mine.':'Create a wallet first.'));
  $('start').disabled=st.mining||!(st.wallet==='unlocked'||st.wallet==='unprotected');$('stop').disabled=!st.mining;wallet(st);text($('height'),st.chain.height??'–');text($('balance'),st.chain.balance?(Number(BigInt(st.chain.balance)/10n**12n)/1e6).toLocaleString():'0');
  text($('neterr'),st.chain.error?'Node: '+st.chain.error:st.chain.syncing?'The node is still syncing; mining starts when it has caught up.':'');
  const a=$('accept');a.replaceChildren();if(st.chain.otherGenesis&&!st.mining)a.append(el('button',{textContent:'Mine on this new network',onclick:async()=>{if(!confirm('Mine on the network the node runs now? Only do this after an announced network reset.'))return;try{await api('/api/network/accept',{});load()}catch(e){alert(e.message)}}}));
  text($('log'),st.logs.join('\\n'));text($('home'),st.home);if(first){first=false;$('nodes').value=st.settings.nodes.join('\\n');const s=$('threads');for(let i=1;i<=st.cpus;i++){s.append(el('option',{value:i,textContent:i}))}s.value=st.settings.threads}}
  $('start').onclick=async()=>{try{text($('state'),'Starting…');await api('/api/start',{})}catch(e){alert(e.message)}load()};$('stop').onclick=async()=>{await api('/api/stop',{});load()};
  $('save').onclick=async()=>{try{await api('/api/settings',{nodes:$('nodes').value,threads:Number($('threads').value)});text($('saved'),'Saved.')}catch(e){text($('saved'),e.message)}};
  $('quit').onclick=async()=>{await api('/api/quit',{});document.body.textContent='PSYROB Miner has stopped. You can close this tab.'};
  load();setInterval(()=>load().catch(()=>{}),3000);
  </script></body></html>`;
  }
}
