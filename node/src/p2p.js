// Peer-to-peer networking (DAG_SPEC.md section 13). Anyone can run a node and connect: the node listens for incoming
// peers, finds others through seeds and address gossip (addrman.js), keeps 8 outbound connections (at most 2 per network
// group), up to 64 inbound, 2 anchor connections across restarts, and a feeler connection every 2 minutes.
//
// Frame: magic u32be | type u8 | length u32be | payload (RLP unless noted). The HELLO handshake (same protocol, chain
// ID and genesis) must come first.
//
//   HELLO     [protocol, chainId, genesisHash, blueScore, tipHash, listenPort, nodeId, userAgent]
//   PING/PONG [nonce]
//   GETADDR   []                       -> ADDR
//   ADDR      [[host, port, lastSeen]...]   at most 1,000
//   INV       [[kind, hash]...]        kind 1 block, 2 tx; at most 500
//   GETDATA   [[kind, hash]...]        -> BLOCK / TX for each known item
//   BLOCK     raw block
//   TX        raw transaction
//   GETCHAIN  [locator...]             -> CHAIN: selected-chain hashes after the first locator hash the peer knows
//   CHAIN     [hash...]                at most 500 chain hashes; the last batch also lists the DAG tips (≤ 10)
//   CERT      finality certificate (block.js encoding)
//   SIG       [kind, payload...]       committee signatures being collected (finality.js)
//
// Transports: TCP on the P2P port, and WebSocket at GET /p2p on the HTTP port (ws.js), so a node behind an HTTPS
// reverse proxy (the Cloudflare tunnel) is reachable as wss://host/p2p. WebSocket seeds are dialled directly and kept
// out of the address manager, whose entries are TCP addresses.
//
// Sync: a peer with a higher blue score is asked for its chain (GETCHAIN with a locator); missing blocks are fetched
// with GETDATA; blocks whose parents are missing become orphans and their parents are requested. Misbehaviour raises a
// score; at 100 the peer is disconnected and its address is banned for an hour.

import net from 'node:net';
import { randomBytes } from 'node:crypto';
import * as rlp from '../../common/rlp.js';
import { bytesToHex, fromHex } from '../../common/bytes.js';
import { AddrMan, netGroup } from './addrman.js';
import { cmpBlock } from './dag.js';
import { NODE_VERSION } from './params.js';
import { decodeCert, encodeCert, decodeBlock } from './block.js';
import { acceptWebSocket, clientIp, WsClientSocket, isWsUrl } from './ws.js';

export const MSG = Object.freeze({ HELLO: 1, PING: 2, PONG: 3, GETADDR: 4, ADDR: 5, INV: 6, GETDATA: 7, BLOCK: 8, TX: 9, GETCHAIN: 10, CHAIN: 11, CERT: 12, SIG: 13 });
const FRAME_HEADER = 9;
const MAX_FRAME = 4 * 1024 * 1024;
const MAX_OUTBOUND = 8, MAX_INBOUND = 64, MAX_PER_GROUP = 2, ANCHORS = 2;
const RATE = { [MSG.GETCHAIN]: [20, 2], [MSG.GETDATA]: [200, 50], [MSG.BLOCK]: [200, 20], [MSG.TX]: [500, 100], [MSG.INV]: [200, 50],
  [MSG.ADDR]: [5, 0.1], [MSG.GETADDR]: [3, 0.05], [MSG.PING]: [5, 1], [MSG.CERT]: [50, 5], [MSG.SIG]: [500, 50] };

class Bucket {
  constructor([burst, perSec]) { this.burst = burst; this.perSec = perSec; this.tokens = burst; this.at = Date.now(); }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.perSec);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

class Peer {
  constructor(p2p, socket, { outbound, host, port, kind = 'full' }) {
    this.p2p = p2p;
    this.socket = socket;
    this.outbound = outbound;
    this.kind = kind; // full, feeler, anchor
    this.host = host ?? socket.remoteAddress?.replace(/^::ffff:/, '');
    this.port = port ?? socket.remotePort;
    this.id = `${this.host}:${this.port}`;
    this.ready = false;
    this.score = 0;
    this.known = new Set();
    this.buckets = new Map(Object.entries(RATE).map(([t, r]) => [Number(t), new Bucket(r)]));
    this.powBucket = new Bucket([4, 2]); // this peer's share of unsolicited proof-of-work checks
    this.buf = Buffer.alloc(0);
    this.queue = Promise.resolve();
    this.connectedAt = Date.now();
    this.lastRecv = Date.now();
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.inQueue = 0;
    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('error', () => {});
    socket.on('close', () => p2p.onClose(this));
    socket.setTimeout(120_000, () => socket.destroy());
  }

  send(type, payload) {
    if (this.socket.destroyed) return;
    if (this.socket.writableLength > 32 * 1024 * 1024) { this.socket.destroy(); return; }
    const b = Buffer.alloc(FRAME_HEADER + payload.length);
    b.writeUInt32BE(this.p2p.params.networkMagic, 0);
    b.writeUInt8(type, 4);
    b.writeUInt32BE(payload.length, 5);
    b.set(payload, FRAME_HEADER);
    this.bytesOut += b.length;
    this.p2p.bytesOut += b.length;
    this.socket.write(b);
  }

  sendRlp(type, x) { this.send(type, rlp.encode(x)); }

  misbehave(points, why) {
    this.score += points;
    this.p2p.log?.(`peer ${this.id}: ${why} (+${points})`);
    if (this.score >= 100) { this.p2p.ban(this.host, why); this.socket.destroy(); }
  }

  onData(d) {
    this.bytesIn += d.length;
    this.p2p.bytesIn += d.length;
    this.lastRecv = Date.now();
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= FRAME_HEADER && !this.socket.destroyed) {
      if (this.buf.readUInt32BE(0) !== this.p2p.params.networkMagic) {
        // before HELLO this is a node of another network (an old testnet left running): drop it without a ban, which
        // would also lock out a current node on the same IPv4 address or IPv6 /64
        if (!this.helloSeen) { this.p2p.otherNetwork(this.host); this.socket.destroy(); return; }
        this.misbehave(100, 'wrong network magic'); return;
      }
      const type = this.buf.readUInt8(4), len = this.buf.readUInt32BE(5);
      if (len > MAX_FRAME) { this.misbehave(100, 'frame too large'); return; }
      if (this.buf.length < FRAME_HEADER + len) return;
      const payload = new Uint8Array(this.buf.subarray(FRAME_HEADER, FRAME_HEADER + len));
      this.buf = this.buf.subarray(FRAME_HEADER + len);
      // HELLO is handled asynchronously; frames that arrive with it in one chunk are queued behind it, so only the
      // order of arrival matters here
      if (type === MSG.HELLO) this.helloSeen = true;
      else if (!this.helloSeen) { this.misbehave(100, 'message before HELLO'); return; }
      // BLOCK is limited in onBlockMsg, where solicited blocks (the ones we asked this peer for) are told apart: a
      // sync asks for hundreds at once and must not count them against the peer that answers
      const bucket = type === MSG.BLOCK ? null : this.buckets.get(type);
      if (bucket && !bucket.take()) { this.misbehave(5, 'rate limit on type ' + type); if (this.socket.destroyed) return; continue; }
      // inQueue: messages received but not yet handled; while a peer has any, what we asked of it is still on its way
      this.inQueue++;
      const run = () => { this.queue = this.queue.then(() => this.p2p.handle(this, type, payload)).catch((e) => this.misbehave(20, 'bad message: ' + e.message)).finally(() => { this.inQueue--; }); };
      // emulated latency (tests only): blocks are handled delayMs after arrival, in order, without holding up others
      if (type === MSG.BLOCK && this.p2p.delayMs) setTimeout(run, this.p2p.delayMs);
      else run();
    }
  }
}

export class P2P {
  /**
   * opts = { params, chain, mempool, genesisHash, listenHost, listenPort, seeds: ['host:port'], store, log,
   *          onBlock(raw, peer) -> Promise, onTx(raw, peer), onCert(cert, peer), onSig(items, peer), advertise }
   */
  constructor(opts) {
    Object.assign(this, opts);
    this.delayMs = opts.delayMs ?? 0; // emulated one-way latency for received blocks (tests and simulations only)

    this.peers = new Set();
    this.nodeId = randomBytes(16);
    this.bans = new Map();
    this.bytesIn = 0;
    this.bytesOut = 0;
    this.addrman = AddrMan.fromJSON(opts.store?.readJson('peers.json', null));
    this.anchors = opts.store?.readJson('anchors.json', []) ?? [];
    this.requested = new Map(); // block hash hex -> { at, peer } (the peer it was requested from)
    this.banLocal = opts.banLocal ?? true;
    // Proof-of-work budget for unsolicited blocks: each peer has its own small share, and inbound and outbound peers
    // draw on separate pools, so attackers' connections (inbound) cannot use up the share of the peers we chose.
    this.inboundBudget = new Bucket([30, 15]);
    this.outboundBudget = new Bucket([20, 10]);
    this.timers = [];
    this.wsSeeds = (opts.seeds ?? []).filter(isWsUrl);
    this.wsRetry = new Map(); // seed url -> { fails, nextAt }: failed dials back off from 5 s to 5 min
    this.refusedLogged = new Map(); // banned host -> last time its refusal was logged
    this.otherNetLogged = new Map(); // host of another network -> last time it was logged
    for (const s of opts.seeds ?? []) { if (isWsUrl(s)) continue; const [h, p] = splitHostPort(s); if (h) this.addrman.add(h, p, { source: 'seed' }); }
  }

  get outboundCount() { return [...this.peers].filter((p) => p.outbound && p.kind !== 'feeler').length; }
  get inboundCount() { return [...this.peers].filter((p) => !p.outbound).length; }

  async start() {
    if (this.listenPort) {
      this.server = net.createServer((s) => this.onIncoming(s));
      await new Promise((res, rej) => { this.server.once('error', rej); this.server.listen(this.listenPort, this.listenHost ?? '0.0.0.0', res); });
    }
    for (const a of this.anchors.slice(0, ANCHORS)) this.connect(a.host, a.port, 'anchor');
    this.timers.push(setInterval(() => this.maintain(), 5_000));
    this.timers.push(setInterval(() => this.feeler(), 120_000));
    this.timers.push(setInterval(() => this.ping(), 30_000));
    this.timers.push(setInterval(() => this.save(), 60_000));
    this.maintain();
  }

  stop() {
    for (const t of this.timers) clearInterval(t);
    this.save();
    this.server?.close();
    for (const p of this.peers) p.socket.destroy();
  }

  save() {
    if (!this.store) return;
    this.store.writeJson('peers.json', this.addrman.toJSON());
    const anchors = [...this.peers].filter((p) => p.outbound && p.ready && p.kind !== 'feeler' && !p.wsUrl).slice(0, ANCHORS).map((p) => ({ host: p.host, port: p.port }));
    if (anchors.length) this.store.writeJson('anchors.json', anchors);
  }

  // Bans are by address, never by peer ID (a new node ID changes nothing): IPv4 by address, IPv6 by /64 prefix (one
  // subscriber's range), local and private addresses included unless --no-ban-local (devnets).
  banned(host) { const t = this.bans.get(banKey(host)); return t && t > Date.now(); }
  ban(host, why = '') {
    if (!host || (!this.banLocal && isLocal(host))) return;
    this.bans.set(banKey(host), Date.now() + 3_600_000);
    this.log?.(`p2p: banned ${banKey(host)} for 1 hour${why ? ' (' + why + ')' : ''}`);
  }

  /** A banned address is refused without a reply; logged at most once per 10 minutes per address. */
  refuse(host, socket) {
    socket.destroy();
    const k = banKey(host), last = this.refusedLogged.get(k) ?? 0;
    if (Date.now() - last < 600_000) return;
    this.refusedLogged.set(k, Date.now());
    this.log?.(`p2p: refused ${k}: banned until ${new Date(this.bans.get(k)).toISOString().slice(11, 16)} UTC`);
  }

  /** A peer that opened with another network's magic is dropped, not banned; logged at most once per 10 minutes. */
  otherNetwork(host) {
    const k = banKey(host), last = this.otherNetLogged.get(k) ?? 0;
    if (Date.now() - last < 600_000) return;
    this.otherNetLogged.set(k, Date.now());
    this.log?.(`p2p: dropped ${k}: wrong network magic (a node of another network or an older version; not banned)`);
  }

  onIncoming(socket) {
    const host = socket.remoteAddress?.replace(/^::ffff:/, '');
    if (this.banned(host)) { this.refuse(host, socket); return; }
    if (this.inboundCount >= MAX_INBOUND) { socket.destroy(); return; }
    const sameHost = [...this.peers].filter((p) => p.host === host).length;
    if (sameHost >= 4 && !isLocal(host)) { socket.destroy(); return; }
    const peer = new Peer(this, socket, { outbound: false });
    this.peers.add(peer);
    this.hello(peer);
  }

  /** An incoming WebSocket peer (GET /p2p on the HTTP port). The address is the real client's (ws.js clientIp). */
  acceptWs(req, socket, head) {
    const host = clientIp(req.socket.remoteAddress, req.headers);
    if (this.banned(host)) { this.refuse(host, socket); return; }
    if (this.inboundCount >= MAX_INBOUND) { socket.destroy(); return; }
    const sameHost = [...this.peers].filter((p) => p.host === host).length;
    if (sameHost >= 4 && !isLocal(host)) { socket.destroy(); return; }
    const ws = acceptWebSocket(req, socket, head, host);
    if (!ws) return;
    const peer = new Peer(this, ws, { outbound: false, host });
    peer.transport = 'ws';
    this.peers.add(peer);
    this.hello(peer);
  }

  /** Dial a WebSocket peer (ws://host[:port]/p2p or wss://host/p2p). */
  connectWs(url, kind = 'full') {
    const u = new URL(url);
    if (this.banned(u.hostname) || [...this.peers].some((p) => p.wsUrl === url)) return;
    const r = this.wsRetry.get(url);
    if (r && Date.now() < r.nextAt) return;
    if (!r?.fails) this.log?.(`p2p: connecting to ${url}`);
    const socket = new WsClientSocket(url);
    const peer = new Peer(this, socket, { outbound: true, host: u.hostname, port: socket.remotePort, kind });
    peer.wsUrl = url;
    peer.transport = 'ws';
    peer.id = url;
    this.peers.add(peer);
    socket.once('connect', () => this.hello(peer));
    socket.once('timeout', () => socket.destroy());
  }

  connect(host, port, kind = 'full') {
    const id = AddrMan.id(host, port);
    if (this.banned(host) || [...this.peers].some((p) => p.outbound && AddrMan.id(p.host, p.port) === id)) return;
    this.addrman.attempt(host, port);
    const socket = net.connect({ host, port, timeout: 10_000 });
    const peer = new Peer(this, socket, { outbound: true, host, port, kind });
    this.peers.add(peer);
    socket.once('connect', () => this.hello(peer));
    socket.once('timeout', () => socket.destroy());
  }

  /** Keep MAX_OUTBOUND outbound peers, at most MAX_PER_GROUP per network group (local addresses are exempt). */
  maintain() {
    this.resync();
    let out = [...this.peers].filter((p) => p.outbound && p.kind !== 'feeler');
    for (const url of this.wsSeeds) {
      if (out.length >= MAX_OUTBOUND) break;
      if (!out.some((p) => p.wsUrl === url)) { this.connectWs(url); out = [...this.peers].filter((p) => p.outbound && p.kind !== 'feeler'); }
    }
    if (out.length >= MAX_OUTBOUND) return;
    const groups = new Map();
    for (const p of out) groups.set(netGroup(p.host), (groups.get(netGroup(p.host)) ?? 0) + 1);
    const exclude = new Set([...this.peers].map((p) => AddrMan.id(p.host, p.port)));
    for (let i = 0; i < 10 && out.length + i < MAX_OUTBOUND; i++) {
      const a = this.addrman.select({ exclude });
      if (!a) return;
      exclude.add(AddrMan.id(a.host, a.port));
      const g = netGroup(a.host);
      if (g !== 'local' && (groups.get(g) ?? 0) >= MAX_PER_GROUP) continue;
      if (this.isSelf(a.host, a.port)) continue;
      groups.set(g, (groups.get(g) ?? 0) + 1);
      this.connect(a.host, a.port);
    }
  }

  /** Feeler: a short test connection to a "new" address; also resolves tried-table collisions (test-before-evict). */
  feeler() {
    for (const [id, occ] of this.addrman.collisions) {
      const o = this.addrman.info.get(occ);
      if (!o) { this.addrman.resolveCollision(id, false); continue; }
      const s = net.connect({ host: o.host, port: o.port, timeout: 5_000 });
      s.once('connect', () => { s.destroy(); this.addrman.resolveCollision(id, true); });
      s.once('error', () => this.addrman.resolveCollision(id, false));
      s.once('timeout', () => { s.destroy(); this.addrman.resolveCollision(id, false); });
      return;
    }
    const a = this.addrman.select({ newOnly: true, exclude: new Set([...this.peers].map((p) => AddrMan.id(p.host, p.port))) });
    if (a && !this.isSelf(a.host, a.port)) this.connect(a.host, a.port, 'feeler');
  }

  isSelf(host, port) {
    return (isLocal(host) || host === this.advertise?.host) && port === this.listenPort;
  }

  ping() {
    for (const p of this.peers) {
      if (!p.ready) { if (Date.now() - p.connectedAt > 30_000) p.socket.destroy(); continue; }
      if (Date.now() - p.lastRecv > 90_000) { p.socket.destroy(); continue; }
      p.sendRlp(MSG.PING, [randomBytes(8)]);
    }
  }

  hello(peer) {
    const t = this.chain.tip;
    peer.sendRlp(MSG.HELLO, [rlp.int(this.params.protocolVersion), rlp.int(this.params.chainId), this.genesisHash, rlp.int(t.blueScore),
      t.hashBytes, rlp.int(this.listenPort ?? 0), this.nodeId, new TextEncoder().encode('psyrob/' + NODE_VERSION)]);
  }

  onClose(peer) {
    this.peers.delete(peer);
    const secs = Math.floor((Date.now() - peer.connectedAt) / 1000);
    if (peer.self) {
      // our own address: closed on purpose, nothing to report
    } else if (peer.wsUrl) {
      // a seed that closes before the handshake is retried with back-off; the reason is not visible from here
      const r = this.wsRetry.get(peer.wsUrl) ?? { fails: 0, nextAt: 0 };
      if (peer.ready) r.fails = 0; else r.fails++;
      const wait = peer.ready ? 5 : Math.min(300, 5 * 2 ** (r.fails - 1));
      r.nextAt = Date.now() + wait * 1000;
      this.wsRetry.set(peer.wsUrl, r);
      if (peer.ready) this.log?.(`p2p: ${peer.wsUrl} closed after ${secs} s (in ${peer.bytesIn} B, out ${peer.bytesOut} B); reconnecting in ${wait} s`);
      else if (r.fails <= 3 || wait === 300) this.log?.(`p2p: no handshake with ${peer.wsUrl} (attempt ${r.fails}; unreachable, or it refuses this address, e.g. a 1-hour ban); retrying in ${wait} s`);
    } else if (peer.ready && peer.kind !== 'feeler') {
      this.log?.(`p2p: ${peer.outbound ? 'outbound' : 'inbound'} peer ${peer.id} closed after ${secs} s (in ${peer.bytesIn} B, out ${peer.bytesOut} B)`);
    }
    this.onPeers?.();
  }

  // ------------------------------------------------------------------ messages

  async handle(peer, type, payload) {
    switch (type) {
      case MSG.HELLO: return this.onHello(peer, payload);
      case MSG.PING: { const [n] = rlp.decode(payload); return peer.sendRlp(MSG.PONG, [n]); }
      case MSG.PONG: return;
      case MSG.GETADDR: {
        if (peer.sentAddr) return;
        peer.sentAddr = true;
        const list = this.addrman.sample(1000).map((a) => [new TextEncoder().encode(a.host), rlp.int(a.port), rlp.int(a.lastSeen)]);
        if (this.advertise?.host) list.unshift([new TextEncoder().encode(this.advertise.host), rlp.int(this.advertise.port ?? this.listenPort), rlp.int(Math.floor(Date.now() / 1000))]);
        return peer.sendRlp(MSG.ADDR, list.slice(0, 1000));
      }
      case MSG.ADDR: {
        const list = rlp.decode(payload);
        if (!Array.isArray(list) || list.length > 1000) return peer.misbehave(20, 'oversized addr');
        for (const [h, p, ls] of list) {
          const host = new TextDecoder().decode(h);
          if (host.length > 255) continue;
          this.addrman.add(host, Number(rlp.decodeInt(p, 2)), { lastSeen: Number(rlp.decodeInt(ls, 6)), source: peer.host });
        }
        if (peer.kind === 'feeler') peer.socket.destroy();
        return;
      }
      case MSG.INV: {
        const items = rlp.decode(payload);
        if (!Array.isArray(items) || items.length > 500) return peer.misbehave(20, 'oversized inv');
        const want = [];
        for (const [k, h] of items) {
          const hx = bytesToHex(h);
          peer.known.add(hx);
          const kind = Number(rlp.decodeInt(k, 1));
          if (kind === 1 && !this.chain.dag.has(hx) && !this.chain.orphans.has(hx) && !this.recentlyRequested(hx)) { this.markRequested(hx, peer); want.push([rlp.int(1), h]); }
          if (kind === 2 && !this.mempool.get(hx) && !this.chain.txIndex.has(hx)) want.push([rlp.int(2), h]);
        }
        if (want.length) peer.sendRlp(MSG.GETDATA, want);
        return;
      }
      case MSG.GETDATA: {
        const items = rlp.decode(payload);
        if (!Array.isArray(items) || items.length > 500) return peer.misbehave(20, 'oversized getdata');
        for (const [k, h] of items) {
          const kind = Number(rlp.decodeInt(k, 1));
          const hx = bytesToHex(h);
          if (kind === 1) { const raw = this.rawBlock?.(hx); if (raw) peer.send(MSG.BLOCK, raw); }
          if (kind === 2) { const t = this.mempool.get(hx); if (t) peer.send(MSG.TX, t.raw); }
        }
        return;
      }
      case MSG.BLOCK: return this.onBlockMsg(peer, payload);
      case MSG.TX: return this.onTx?.(payload, peer);
      case MSG.GETCHAIN: {
        const loc = rlp.decode(payload);
        if (!Array.isArray(loc) || loc.length > 64) return peer.misbehave(20, 'bad locator');
        let start = 0;
        for (const h of loc) {
          const e = this.chain.dag.get(bytesToHex(h));
          if (e && this.chain.chain[e.chainHeight] === e.hash) { start = e.chainHeight + 1; break; }
        }
        return peer.sendRlp(MSG.CHAIN, this.chainBatch(start).map((h) => fromHex('0x' + h)));
      }
      case MSG.CHAIN: {
        const hashes = rlp.decode(payload);
        if (!Array.isArray(hashes) || hashes.length > 510) return peer.misbehave(20, 'oversized chain');
        const want = hashes.map(bytesToHex).filter((h) => !this.chain.dag.has(h) && !this.chain.orphans.has(h) && !this.recentlyRequested(h));
        for (let i = 0; i < want.length; i += 100) peer.sendRlp(MSG.GETDATA, want.slice(i, i + 100).map((h) => { this.markRequested(h, peer); return [rlp.int(1), fromHex('0x' + h)]; }));
        // the batch: what this reply asked for. Only it decides when to ask again; announced tip blocks and orphan
        // parents requested from the same peer meanwhile do not (they kept every sync stalled after two batches)
        peer.batch = new Set(want);
        peer.batchAt = Date.now();
        peer.syncMore = hashes.length === 500;
        if (!want.length && peer.syncMore) this.requestChain(peer, hashes.map(bytesToHex));
        return;
      }
      case MSG.CERT: return this.onCert?.(decodeCert(rlp.decode(payload)), peer);
      case MSG.SIG: return this.onSig?.(rlp.decode(payload), peer);
      default: return peer.misbehave(10, 'unknown message ' + type);
    }
  }

  onHello(peer, payload) {
    if (peer.ready) return peer.misbehave(20, 'second HELLO');
    const [ver, chainId, genesis, blueScore, tip, listenPort, nodeId, ua] = rlp.decode(payload);
    if (Number(rlp.decodeInt(ver, 4)) !== this.params.protocolVersion) { this.log?.(`p2p: ${peer.id} speaks protocol ${rlp.decodeInt(ver, 4)}, not ${this.params.protocolVersion}; closed`); peer.socket.destroy(); return; }
    if (rlp.decodeInt(chainId, 8) !== this.params.chainId || bytesToHex(genesis) !== bytesToHex(this.genesisHash)) { peer.misbehave(100, 'other network'); return; }
    if (bytesToHex(nodeId) === bytesToHex(this.nodeId)) { // connected to ourselves
      if (peer.wsUrl) this.wsSeeds = this.wsSeeds.filter((u) => u !== peer.wsUrl); // the public node's own seed: do not redial it
      peer.self = true;
      peer.socket.destroy();
      return;
    }
    peer.ready = true;
    peer.blueScore = Number(rlp.decodeInt(blueScore, 8));
    peer.tip = bytesToHex(tip);
    peer.listenPort = Number(rlp.decodeInt(listenPort, 2));
    if (peer.kind !== 'feeler') this.log?.(`p2p: ${peer.outbound ? 'connected to' : 'inbound peer'} ${peer.id} (${new TextDecoder().decode(ua ?? new Uint8Array(0)).slice(0, 40) || 'unknown'}, blue score ${peer.blueScore}${peer.outbound ? '' : ', ' + (peer.transport ?? 'tcp')})`);
    if (peer.outbound) {
      if (!peer.wsUrl) this.addrman.good(peer.host, peer.port);
      if (peer.kind === 'feeler') { peer.sendRlp(MSG.GETADDR, []); setTimeout(() => peer.socket.destroy(), 5_000); return; }
    } else if (peer.listenPort) {
      this.addrman.add(peer.host, peer.listenPort, { source: peer.host }); // learnt from an incoming connection
    }
    peer.sendRlp(MSG.GETADDR, []);
    if (peer.blueScore > this.chain.tip.blueScore || !this.chain.dag.has(peer.tip)) this.requestChain(peer);
    this.onPeers?.();
  }

  /**
   * The CHAIN reply from selected-chain height `start`: every block in parent-first order, each chain block preceded
   * by the blocks it merges (ascending blue work, as GHOSTDAG orders them), so a syncing node receives no block before
   * its parents. Exactly 500 hashes means "ask again" (a cut may fall inside a mergeset; the next locator then starts
   * from the asker's own tip). The last batch also carries every DAG tip, so parallel blocks that no chain block has
   * merged yet are synced too.
   */
  chainBatch(start) {
    const { chain, dag } = this.chain;
    const batch = [];
    let h = start;
    for (; h < chain.length && batch.length < 500; h++) {
      const e = dag.get(chain[h]);
      const merged = h === 0 ? [] : [...e.mergesetBlues.slice(1), ...e.mergesetReds].map((x) => dag.get(x)).sort(cmpBlock).map((x) => x.hash);
      for (const x of [...merged, e.hash]) if (batch.length < 500) batch.push(x);
    }
    if (batch.length < 500) for (const tip of dag.tips) if (!batch.includes(tip) && batch.length < 510) batch.push(tip);
    return batch;
  }

  requestChain(peer, after = null) {
    peer.chainAskedAt = Date.now();
    const loc = [];
    if (after?.length) loc.push(fromHex('0x' + after[after.length - 1]));
    const c = this.chain.chain;
    for (let i = c.length - 1, step = 1; i >= 0 && loc.length < 64; i -= step, step = loc.length > 10 ? step * 2 : 1) loc.push(fromHex('0x' + c[i]));
    if (c.length && bytesToHex(loc[loc.length - 1]) !== c[0]) loc.push(fromHex('0x' + c[0]));
    peer.sendRlp(MSG.GETCHAIN, loc);
  }

  /**
   * A request is due for 20 s, or longer while the peer we asked still has received messages waiting to be handled:
   * checking a 500-block batch (32 MiB Argon2d each) can take longer than 20 s on a home PC.
   */
  live(r) { return Date.now() - r.at < 20_000 || (r.peer.inQueue > 0 && !r.peer.socket.destroyed); }

  recentlyRequested(h) {
    const r = this.requested.get(h);
    if (this.requested.size > 20_000) this.requested.clear();
    return !!r && this.live(r);
  }

  /** Did we ask this very peer for block h? Only then is its reply "solicited" (however long it took to arrive). */
  requestedFrom(h, peer) {
    const r = this.requested.get(h);
    return !!r && r.peer === peer;
  }

  /**
   * Is this node still catching up? Only when its tip is more than 10 minutes old by its own clock AND a connected
   * peer that said it is ahead is still delivering blocks (asked for more, or a request to it is due, or a block was
   * added in the last minute). A peer that only claims a high blue score cannot keep a node with a fresh tip from
   * mining, and a halted network (no peer ahead) can always mine again. Returns null or { blueScore, target }.
   * Used to refuse block templates while syncing: a node that mined on the early chain while syncing left a stale tip
   * that stopped all mining.
   */
  syncing() {
    const tip = this.chain.tip;
    if (Math.floor(Date.now() / 1000) - Number(tip.header.timestamp) <= 600) return null;
    const recent = Date.now() - (this.lastProgress ?? 0) < 60_000;
    const ahead = [...this.peers].filter((p) => p.ready && p.kind !== 'feeler' && p.blueScore > tip.blueScore + 10 && (p.syncMore || recent || this.awaiting(p)));
    if (!ahead.length) return null;
    return { blueScore: tip.blueScore, target: Math.max(...ahead.map((p) => p.blueScore)) };
  }

  markRequested(h, peer) { this.requested.set(h, { at: Date.now(), peer }); }

  /** Is a block we asked this peer for still due? Expired requests do not hold up a sync. */
  awaiting(peer) {
    for (const r of this.requested.values()) if (r.peer === peer && this.live(r)) return true;
    return false;
  }

  /**
   * Stall recovery (every 5 s): if the best peer is ahead of us, or said it has more, and no block was added for 15 s
   * while no block of its last batch arrived for 15 s either, ask it for its chain again from our tip; what is left of
   * the batch may then be requested again. A sync then survives lost replies, dropped or evicted orphans and dead
   * requests. Other requests to the peer (announced tip blocks, orphan parents) do not hold this up: during a long
   * sync they never stop, since each new tip block arrives as an orphan whose parents are thousands of blocks away.
   */
  resync() {
    const now = Date.now();
    if (now - (this.lastProgress ?? 0) < 15_000) return;
    const tip = this.chain.tip.blueScore;
    const best = [...this.peers].filter((p) => p.ready && p.kind !== 'feeler' && (p.syncMore || p.blueScore > tip)).sort((a, b) => b.blueScore - a.blueScore)[0];
    if (!best || now - (best.chainAskedAt ?? 0) < 15_000) return;
    if (best.batch?.size && now - (best.batchAt ?? 0) < 15_000) return;
    for (const h of best.batch ?? []) if (this.requested.get(h)?.peer === best) this.requested.delete(h);
    best.batch = null;
    best.syncMore = false;
    this.requestChain(best);
  }

  async onBlockMsg(peer, raw) {
    // Proof-of-work checks (32 MiB Argon2d each) for blocks we did not ask this peer for are limited: per peer
    // (burst 4, 2 per second) and per pool (inbound 15/s, outbound 10/s). Blocks requested from this peer (sync,
    // orphan parents, announced blocks) are not limited: honest relay announces first and sends on request.
    // Over budget, a block is dropped without a ban; it can be fetched later through its announcement.
    let h;
    try { h = bytesToHex(decodeBlock(raw).hash); } catch { peer.misbehave(100, 'malformed block'); return; }
    if (!this.requestedFrom(h, peer)) {
      if (!peer.buckets.get(MSG.BLOCK).take()) { peer.misbehave(5, 'rate limit on unsolicited blocks'); return; }
      const pool = peer.outbound ? this.outboundBudget : this.inboundBudget;
      if (!peer.powBucket.take() || !pool.take()) { this.droppedUnsolicited = (this.droppedUnsolicited ?? 0) + 1; peer.dropped = (peer.dropped ?? 0) + 1; return; }
    }
    const r = await this.onBlock(raw, peer);
    // a batch block counts as delivered whatever became of it (added, orphan, known or invalid)
    if (peer.batch?.delete(h)) {
      peer.batchAt = Date.now();
      if (!peer.batch.size && peer.syncMore) { peer.syncMore = false; this.requestChain(peer); }
    }
    if (!r) return;
    peer.known.add(r.hash);
    this.requested.delete(r.hash);
    if (r.status === 'orphan') {
      // only parents we hold nowhere: a parent waiting in the orphan pool is already on its way (re-asking for it
      // once per orphan sent hundreds of GETDATA messages during a sync and got the syncing node banned)
      const want = r.missing.filter((h) => !this.chain.orphans.has(h) && !this.chain.dag.has(h) && !this.recentlyRequested(h));
      for (const h of want) this.markRequested(h, peer);
      if (want.length) peer.sendRlp(MSG.GETDATA, want.map((h) => [rlp.int(1), fromHex('0x' + h)]));
    }
    if (r.status === 'added') this.lastProgress = Date.now();
  }

  /**
   * Announce a block or transaction to peers that do not know it. Announcements are gathered per peer for 50 ms and
   * sent as one INV (up to 500 items), so a node relaying a burst (blocks it is syncing) stays inside the INV limit.
   */
  announce(kind, hashHex, exceptPeer = null) {
    for (const p of this.peers) {
      if (!p.ready || p === exceptPeer || p.known.has(hashHex) || p.kind === 'feeler') continue;
      p.known.add(hashHex);
      if (p.known.size > 20_000) p.known.clear();
      (p.invQueue ??= []).push([rlp.int(kind), fromHex('0x' + hashHex)]);
      p.invTimer ??= setTimeout(() => {
        p.invTimer = null;
        const q = p.invQueue;
        p.invQueue = [];
        for (let i = 0; i < q.length; i += 500) p.sendRlp(MSG.INV, q.slice(i, i + 500));
      }, 50);
    }
  }

  broadcastCert(cert, exceptPeer = null) {
    const payload = rlp.encode(encodeCert(cert));
    for (const p of this.peers) if (p.ready && p !== exceptPeer && p.kind !== 'feeler') p.send(MSG.CERT, payload);
  }

  broadcastSig(items, exceptPeer = null) {
    const payload = rlp.encode(items);
    for (const p of this.peers) if (p.ready && p !== exceptPeer && p.kind !== 'feeler') p.send(MSG.SIG, payload);
  }

  info() {
    return [...this.peers].map((p) => ({
      id: p.id, transport: p.transport ?? 'tcp', outbound: p.outbound, kind: p.kind, ready: p.ready, blueScore: p.blueScore ?? null, score: p.score,
      connectedSeconds: Math.floor((Date.now() - p.connectedAt) / 1000), bytesIn: p.bytesIn, bytesOut: p.bytesOut,
    }));
  }
}

export function splitHostPort(s) {
  const m = /^\[(.+)\]:(\d+)$/.exec(s) ?? /^([^:]+):(\d+)$/.exec(s);
  return m ? [m[1], Number(m[2])] : [null, 0];
}

function isLocal(host) { return netGroup(host) === 'local'; }

/** The unit a ban applies to: an IPv4 address, or the /64 prefix of an IPv6 address. */
export function banKey(host) {
  if (!host) return host;
  const h = host.replace(/^::ffff:/, '');
  if (!net.isIPv6(h)) return h;
  // expand '::' and keep the first four groups
  const [head, tail = ''] = h.toLowerCase().split('::');
  const a = head ? head.split(':') : [], b = tail ? tail.split(':') : [];
  const groups = [...a, ...Array(8 - a.length - b.length).fill('0'), ...b].map((x) => x.replace(/^0+(?=.)/, ''));
  return groups.slice(0, 4).join(':') + '::/64';
}
