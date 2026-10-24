// Pre-launch mode (testnet launch ceremony, DAG_SPEC.md section 17.1). Before the chain exists, the node serves
// only /launch: each of the three Dev Account holders connects the Dev Account wallet, names a separate council key
// and signs the launch message (personal_sign). The node checks every signature against the fixed Dev Account
// address of the seat and stores it in <datadir>/launch.json. When all three seats are signed, the operator builds
// the genesis from that file (genesis/build.js --launch) and starts the node normally; mining starts then.
//
// Nothing here holds a key or sends a transaction. Anyone may load the page; only a valid signature of a seat's own
// Dev Account wallet changes that seat.

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { HEADERS } from './explorer.js';
import { readResource } from '../../common/resources.js';
import { launchBase, launchMessage, personalSigner } from './rules.js';
import { DEV_ACCOUNTS, NODE_VERSION, TESTNET_NAME, TESTNET_MAJOR } from './params.js';
import { bootstrapQuorumOf } from './genesis.js';
import { clientIp } from './ws.js';

const STATIC = { '/launch.js': 'text/javascript', '/logo.svg': 'image/svg+xml', '/vendor/bootstrap.min.css': 'text/css', '/vendor/fonts.css': 'text/css',
  '/vendor/fonts/barlow-condensed-latin-500-normal.woff2': 'font/woff2', '/vendor/fonts/barlow-condensed-latin-600-normal.woff2': 'font/woff2',
  '/vendor/fonts/barlow-condensed-latin-ext-500-normal.woff2': 'font/woff2', '/vendor/fonts/barlow-condensed-latin-ext-600-normal.woff2': 'font/woff2',
  '/vendor/fonts/source-serif-4-latin-opsz-normal.woff2': 'font/woff2', '/vendor/fonts/source-serif-4-latin-ext-opsz-normal.woff2': 'font/woff2' };
const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a));

/** The ceremony: the base config (chainId, target, devBeneficiaries, extra) and the signed seats, saved in `file`. */
export class Ceremony {
  constructor(config, file) {
    for (const k of ['chainId', 'target', 'devBeneficiaries']) if (config[k] === undefined) throw new Error(`launch config: ${k} is missing`);
    if (!Array.isArray(config.devBeneficiaries) || config.devBeneficiaries.length !== 3 || !config.devBeneficiaries.every(isAddr)) throw new Error('launch config: devBeneficiaries must be three addresses');
    if (config.bootstrapSigners !== undefined && (!Array.isArray(config.bootstrapSigners) || !config.bootstrapSigners.length || !config.bootstrapSigners.every(isAddr))) throw new Error('launch config: bootstrapSigners must list addresses');
    if (config.bootstrapQuorum !== undefined) bootstrapQuorumOf(config); // more than half of the list
    this.config = { chainId: Number(config.chainId), target: String(config.target), devBeneficiaries: config.devBeneficiaries.map((a) => a.toLowerCase()), extra: String(config.extra ?? `PSYROB v${TESTNET_MAJOR} genesis ${config.chainId}`),
      ...(config.bootstrapSigners ? { bootstrapSigners: config.bootstrapSigners.map((a) => a.toLowerCase()) } : {}),
      ...(config.bootstrapQuorum !== undefined ? { bootstrapQuorum: Number(config.bootstrapQuorum) } : {}) };
    this.file = file;
    const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    const sameBase = saved.baseHash === launchBase(this.config).hash;
    this.councilKeys = sameBase && Array.isArray(saved.councilKeys) ? saved.councilKeys : [null, null, null];
    this.launchSignatures = sameBase && Array.isArray(saved.launchSignatures) ? saved.launchSignatures : [null, null, null];
  }

  get complete() { return this.launchSignatures.every(Boolean); }

  state() {
    const { base, hash } = launchBase(this.config);
    return {
      base, baseHash: hash, complete: this.complete,
      seats: DEV_ACCOUNTS.map((d, i) => ({ seat: i, label: d.label, account: this.config.devBeneficiaries[i], councilKey: this.councilKeys[i], signed: Boolean(this.launchSignatures[i]) })),
    };
  }

  message(seat, key) {
    if (![0, 1, 2].includes(seat)) throw new Error('seat must be 0, 1 or 2');
    if (!isAddr(key)) throw new Error('the council key must be an address (0x and 40 hex characters)');
    return launchMessage(this.config, seat, key);
  }

  /** Record seat `seat` if `signature` is its Dev Account wallet's signature of the launch message for `key`. */
  sign(seat, key, signature) {
    const text = this.message(seat, key);
    const k = key.toLowerCase();
    if (this.config.devBeneficiaries.includes(k)) throw new Error('the council key must be a separate key, not a Dev Account wallet');
    if (this.councilKeys.some((x, i) => i !== seat && x === k)) throw new Error('another seat already uses this council key');
    const who = personalSigner(text, signature);
    if (who !== this.config.devBeneficiaries[seat]) throw new Error(`the signature is not from the ${DEV_ACCOUNTS[seat].label} wallet ${this.config.devBeneficiaries[seat]}`);
    this.councilKeys[seat] = k;
    this.launchSignatures[seat] = String(signature).toLowerCase();
    this.save();
    return this.state();
  }

  /** The launch file genesis/build.js --launch reads. */
  save() {
    const out = { ...this.config, baseHash: launchBase(this.config).hash, councilKeys: this.councilKeys, launchSignatures: this.launchSignatures };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(out, null, 1) + '\n');
    fs.renameSync(this.file + '.tmp', this.file);
  }
}

function page(c) {
  const s = c.state();
  const rows = s.seats.map((x) => `<tr><td>${esc(x.label)}</td><td><code>${esc(x.account)}</code></td><td>${x.councilKey ? `<code>${esc(x.councilKey)}</code>` : '–'}</td><td>${x.signed ? '<span class="ok">signed</span>' : 'waiting'}</td></tr>`).join('');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Launch ceremony · ' + TESTNET_NAME + '</title><link rel="icon" href="/logo.svg"><link href="/vendor/fonts.css" rel="stylesheet"><link href="/vendor/bootstrap.min.css" rel="stylesheet">' +
    "<style>body{background:#071014;color:#e7f4f2;font:18px/1.5 'Source Serif 4',Palatino,serif}a{color:#3ee0d6}h1,h2{font-family:'Barlow Condensed',sans-serif;letter-spacing:.04em}" +
    '.muted{color:#8aa8a6}.panel{border:1px solid #1c3336;background:#0c181c;padding:16px;margin:16px 0}table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid #1c3336;padding:8px;vertical-align:top}' +
    'code{color:#3ee0d6;word-break:break-all}.ok{color:#3ee0d6;font-weight:600}.warn{border-left:3px solid #e0a33e;padding:8px 12px;background:#1a1408;margin:16px 0}' +
    'input,select{background:#081216;color:#e7f4f2;border:1px solid #1c3336;padding:8px;width:100%}button{background:#3ee0d6;color:#06201e;border:0;padding:10px 16px;font-weight:600;margin-top:8px}' +
    'pre{white-space:pre-wrap;color:#8aa8a6;font-size:14px}.wrap{max-width:860px;margin:0 auto;padding:24px 16px}</style></head><body><div class="wrap">' +
    '<p class="muted">' + TESTNET_NAME + ' · chain ' + esc(s.base.chainId) + ' · node ' + esc(NODE_VERSION) + ' · pre-launch</p>' +
    '<h1>Launch ceremony</h1><p>The testnet starts when the three Dev Account holders have each signed here with their Dev Account wallet. ' +
    'Each names a <b>separate council key</b>: a different wallet (a hardware wallet is best) that signs council actions. The 4 % of each Dev Account keeps going to the Dev Account wallet; nobody can change that.</p>' +
    '<div class="warn">What the council can do (DAG_SPEC.md section 17): until 60 NGOs are elected for the first time, two of the three council keys can approve node updates (they take effect after 7 days, on the nodes whose operators install them), change the committee bond and the role candidacy deposit within their bounds (48 hours) and pause (72 hours at a time, at most 7 days in a row, then 7 days without). ' +
    'They can never touch the Treasury, balances, the 12 %, the NGO election or its rules, and contract updates are the DAO\'s. When the 60th NGO is first elected, the council keeps only the emergency pause (once every 7 days), for good.</div>' +
    `<div class="panel"><h2>Seats</h2><table><thead><tr><th>Seat</th><th>Dev Account wallet</th><th>Council key</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="muted">Genesis base (the chain ID, the starting difficulty, the three Dev Accounts and the hash of all contract code): <code>${esc(s.baseHash)}</code></p>` +
    (s.complete ? '<p class="ok">All three seats are signed. The operator now builds the genesis and starts the network.</p>' : '') + '</div>' +
    '<div class="panel"><h2>Sign your seat</h2><p class="muted">Needs a browser wallet (MetaMask or similar) with your Dev Account wallet selected. Signing a message costs nothing and sends nothing.</p>' +
    '<label for="seat">Your seat</label><select id="seat">' + s.seats.map((x) => `<option value="${x.seat}">${esc(x.label)}</option>`).join('') + '</select>' +
    '<label for="key" class="mt-2">Your council key (address of the separate wallet)</label><input id="key" placeholder="0x…" autocomplete="off" spellcheck="false">' +
    '<button id="sign" type="button">Connect wallet and sign</button><pre id="msg"></pre><p id="out" role="status"></p></div>' +
    '</div><script src="/launch.js"></script></body></html>';
}

const json = (res, code, x) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...HEADERS }); res.end(JSON.stringify(x)); };

/** Serve the ceremony. vhosts: allowed Host headers ('*' = any). */
export async function startPrelaunch({ ceremony, host = '127.0.0.1', port = 8770, vhosts = ['localhost', '127.0.0.1', '::1'], log = () => {} }) {
  const hits = new Map();
  const limited = (ip) => { const now = Date.now(); const h = (hits.get(ip) ?? []).filter((t) => now - t < 60_000); h.push(now); hits.set(ip, h); if (hits.size > 10_000) hits.clear(); return h.length > 30; };
  const server = http.createServer(async (req, res) => {
    try {
      const hostName = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
      if (!vhosts.includes('*') && !vhosts.includes(hostName)) { res.writeHead(403).end('host not allowed'); return; }
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      if (req.method === 'GET' && STATIC[p]) {
        res.writeHead(200, { 'Content-Type': STATIC[p], 'Cache-Control': 'public, max-age=300', ...HEADERS });
        res.end(readResource('node/web' + p));
        return;
      }
      if (req.method === 'GET' && p === '/health') return json(res, 200, { ok: true, prelaunch: true, version: NODE_VERSION, chainId: ceremony.config.chainId, signed: ceremony.launchSignatures.filter(Boolean).length });
      if (req.method === 'GET' && p === '/api/launch') return json(res, 200, ceremony.state());
      if (req.method === 'GET' && p === '/api/launch/message') {
        try { return json(res, 200, { message: ceremony.message(Number(url.searchParams.get('seat')), String(url.searchParams.get('key') ?? '')) }); } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'POST' && p === '/api/launch/sign') {
        if (limited(clientIp(req.socket.remoteAddress, req.headers))) return json(res, 429, { error: 'too many requests' });
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) return json(res, 415, { error: 'needs Content-Type: application/json' });
        let body = '';
        for await (const chunk of req) { body += chunk; if (body.length > 4096) return json(res, 413, { error: 'too large' }); }
        try {
          const m = JSON.parse(body);
          const st = ceremony.sign(Number(m.seat), String(m.councilKey), String(m.signature));
          log(`launch: ${DEV_ACCOUNTS[Number(m.seat)].label} signed (council key ${m.councilKey})`);
          return json(res, 200, st);
        } catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (req.method === 'GET' && (p === '/' || p === '/launch')) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...HEADERS });
        res.end(page(ceremony));
        return;
      }
      if (req.method === 'GET') { res.writeHead(302, { Location: '/launch', ...HEADERS }).end(); return; }
      res.writeHead(405).end();
    } catch (e) {
      log('prelaunch: ' + (e.stack ?? e.message));
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  return server;
}
