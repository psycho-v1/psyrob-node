// HTTP front: JSON-RPC (POST / or /rpc), /health, the explorer and the participation pages (GET).
// Every request must carry an allowed Host header (DNS-rebinding protection; --http-vhosts). RPC calls are rate-limited
// per client address.

import http from 'node:http';
import { Explorer, HEADERS } from './explorer.js';
import { Downloads } from './downloads.js';
import { RpcError } from './rpc.js';
import { clientIp } from './ws.js';
import { banKey } from './p2p.js';
import { NODE_VERSION, versionText } from './params.js';

const MAX_BODY = 1024 * 1024;

/**
 * Per-client token buckets. IPv6 clients are keyed by their /64 (one subscriber's range, as P2P bans are), and when
 * the table is full the least recently used entry goes, instead of clearing every client's budget at once.
 */
class Limiter {
  constructor(burst, perSec, max = 10_000) { this.burst = burst; this.perSec = perSec; this.max = max; this.map = new Map(); }
  take(addr) {
    const key = banKey(addr) ?? addr;
    const now = Date.now();
    let b = this.map.get(key);
    if (b) this.map.delete(key); // re-inserted below: the Map keeps use order
    else b = { t: this.burst, at: now };
    this.map.set(key, b);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
    b.t = Math.min(this.burst, b.t + ((now - b.at) / 1000) * this.perSec);
    b.at = now;
    if (b.t < 1) return false;
    b.t -= 1;
    return true;
  }
}

const json = (x) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? '0x' + v.toString(16) : v));

// Host headers accepted by default: DNS-rebinding protection is on unless --http-vhosts says otherwise. The public node lists its names in its service file.
export const DEFAULT_VHOSTS = ['localhost', '127.0.0.1', '::1'];
// Methods that reveal who this node talks to (peer addresses): local callers only, never through the public RPC.
const LOCAL_ONLY = new Set(['psy_peers', 'psy_addrman']);

export async function startHttp({ node, host, port, rate = [200, 50], vhosts = null }) {
  const explorer = new Explorer(node);
  explorer.downloads = new Downloads(node.opts.downloadsDir ?? null);
  const limiter = new Limiter(rate[0], rate[1]);
  // CPU-heavy methods get a stricter limit of their own; so do pages
  const heavy = new Limiter(20, 5);
  // all clients together, so many addresses cannot add up to an unbounded load
  const heavyAll = new Limiter(120, 40);
  // psy_submitBlock runs Argon2d, psy_getDagRange and psy_metrics walk the DAG
  const HEAVY = new Set(['eth_call', 'eth_estimateGas', 'psy_getBlockTemplate', 'eth_getLogs', 'psy_submitBlock', 'psy_getDagRange', 'psy_metrics']);
  const pages = new Limiter(60, 10);
  const allowed = vhosts ?? node.opts.vhosts ?? DEFAULT_VHOSTS;
  const hostOk = (req) => {
    if (allowed.includes('*')) return true;
    const h = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
    return allowed.includes(h);
  };
  // Cross-origin access is opt-in (--http-cors; the public node allows '*' so wallets and dapps can use its RPC). By
  // default a website open in the operator's browser cannot read this node's responses, and since JSON-RPC POSTs must
  // be application/json, it cannot send them either (no CORS preflight passes).
  const corsList = node.opts.cors ?? [];
  const corsFor = (req) => {
    const origin = String(req.headers.origin ?? '');
    const allow = corsList.includes('*') ? '*' : corsList.includes(origin.toLowerCase()) ? origin : null;
    return allow ? { 'Access-Control-Allow-Origin': allow, 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', ...(allow === '*' ? {} : { Vary: 'Origin' }) } : {};
  };

  async function rpcOne(m, local) {
    if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'invalid request' } };
    if (LOCAL_ONLY.has(m.method) && !local) return { jsonrpc: '2.0', id: m.id ?? null, error: { code: -32601, message: `${m.method} is only available to local callers` } };
    try {
      const result = await node.rpc.handle(m.method, m.params ?? []);
      return { jsonrpc: '2.0', id: m.id ?? null, result: result === undefined ? null : result };
    } catch (e) {
      const code = e instanceof RpcError ? e.code : -32000;
      return { jsonrpc: '2.0', id: m.id ?? null, error: { code, message: e.message, ...(e.data ? { data: e.data } : {}) } };
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!hostOk(req)) { res.writeHead(403).end('host not allowed'); return; }
      const url = new URL(req.url, 'http://x');
      const cors = corsFor(req);
      if (req.method === 'OPTIONS') { res.writeHead(204, cors).end(); return; }
      if (req.method === 'POST' && (url.pathname === '/' || url.pathname === '/rpc')) {
        if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) { res.writeHead(415, cors).end('JSON-RPC needs Content-Type: application/json'); return; }
        const ip = clientIp(req.socket.remoteAddress, req.headers); // behind the tunnel: the real client, not 127.0.0.1
        const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
        let body = '';
        let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) { res.writeHead(413, cors).end(); return; } body += chunk; }
        let msg;
        try { msg = JSON.parse(body); } catch { res.writeHead(200, { 'Content-Type': 'application/json', ...cors }).end(json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })); return; }
        const batch = Array.isArray(msg);
        const list = batch ? msg.slice(0, 100) : [msg];
        if (!list.every((m) => limiter.take(ip) && (!HEAVY.has(m?.method) || (heavy.take(ip) && heavyAll.take('all'))))) { res.writeHead(429, { 'Content-Type': 'application/json', ...cors }).end(json({ jsonrpc: '2.0', id: null, error: { code: -32005, message: 'rate limit exceeded' } })); return; }
        const out = await Promise.all(list.map((m) => rpcOne(m, local)));
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(json(batch ? out : out[0]));
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
      // rpc.psyrob.com is the RPC name: a browser that opens it is sent to the explorer (JSON-RPC is POST, /p2p is a
      // WebSocket upgrade, /health and /api/* stay here for tools and the watchdog)
      const hostName = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
      if (hostName === 'rpc.psyrob.com' && url.pathname !== '/health' && !url.pathname.startsWith('/api/')) {
        res.writeHead(302, { Location: 'https://explorer.psyrob.com' + url.pathname + url.search, 'Cache-Control': 'no-store' }).end();
        return;
      }
      if (url.pathname === '/health') {
        const c = node.chain;
        res.writeHead(200, { 'Content-Type': 'application/json', ...cors });
        res.end(json({ ok: true, version: NODE_VERSION, chainId: Number(node.params.chainId), chainHeight: c.tip.chainHeight, blueScore: c.tip.blueScore, tip: '0x' + c.tip.hash,
          tips: c.dag.tips.size, genesis: '0x' + Buffer.from(c.genesisHash).toString('hex'), peers: node.p2p ? [...node.p2p.peers].filter((p) => p.ready).length : 0,
          syncing: node.p2p?.syncing?.() ?? false, finalCheckpoint: c.finalCheckpoint.number, mempool: node.mempool.size, systemCallFailures: node.systemCallFailures ?? 0,
          ...(c.upgradeRequired ? { upgradeRequired: versionText(c.upgradeRequired) } : {}), p2pBytes: node.p2p ? { in: node.p2p.bytesIn, out: node.p2p.bytesOut } : null }));
        return;
      }
      if (!pages.take(clientIp(req.socket.remoteAddress, req.headers))) { res.writeHead(429, HEADERS).end('too many requests'); return; }
      if (await explorer.downloads.serve(req, res, url.pathname, clientIp(req.socket.remoteAddress, req.headers), HEADERS)) return;
      if (await explorer.handle(req, res, url)) return;
      res.writeHead(404, HEADERS).end();
    } catch (e) {
      node.log('http: ' + (e.stack ?? e.message));
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  // P2P over WebSocket: GET /p2p with Upgrade: websocket (ws.js), for peers that reach this node through an HTTPS proxy
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    let path = '';
    try { path = new URL(req.url, 'http://x').pathname; } catch { /* refused below */ }
    if (!hostOk(req) || path !== '/p2p' || !node.p2p) { socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
    node.p2p.acceptWs(req, socket, head);
  });
  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxConnections = 256;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  server.explorer = explorer;
  return server;
}
