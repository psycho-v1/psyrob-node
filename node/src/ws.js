// P2P over WebSocket (RFC 6455), so peers can reach a node through an HTTPS reverse proxy such as the Cloudflare
// tunnel: the node accepts peers at GET /p2p (Upgrade: websocket) on its HTTP port, and dials peers given as
// ws://host[:port]/p2p or wss://host/p2p (DAG_SPEC.md section 13). Every binary message carries a chunk of the same
// framed byte stream as a TCP connection, so p2p.js's Peer works unchanged on either transport: both adapters below
// offer the socket interface it uses (data/close/error events, write, destroy, destroyed, writableLength,
// setTimeout, setNoDelay, remoteAddress, remotePort).

import net from 'node:net';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
export const MAX_MESSAGE = 5 * 1024 * 1024; // one P2P frame is at most 4 MiB + 9 bytes
const OP = { CONT: 0, TEXT: 1, BIN: 2, CLOSE: 8, PING: 9, PONG: 10 };

/**
 * The client's address. Behind the tunnel every connection comes from the local cloudflared, so the address
 * Cloudflare saw (CF-Connecting-IP) is used, but only when the TCP peer is the local machine: a remote client cannot
 * forge it. Bans and per-address limits then apply to the real client, never to 127.0.0.1 (which would cut off every
 * peer that arrives through the tunnel).
 */
export function clientIp(remoteAddress, headers) {
  const r = String(remoteAddress ?? '').replace(/^::ffff:/, '');
  const loopback = r === '127.0.0.1' || r === '::1';
  const cf = String(headers?.['cf-connecting-ip'] ?? '').trim().replace(/^::ffff:/, '');
  return loopback && net.isIP(cf) ? cf : r;
}

/** Accept a WebSocket upgrade on `socket` (from http.Server 'upgrade'). Returns the adapter, or null if refused. */
export function acceptWebSocket(req, socket, head, host) {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade ?? '').toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 16) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WsServerSocket(socket, head, host);
}

/** Server side of one WebSocket connection: client frames must be masked, server frames are not. */
export class WsServerSocket extends EventEmitter {
  constructor(socket, head, host) {
    super();
    this.socket = socket;
    this.remoteAddress = host;
    this.remotePort = socket.remotePort;
    this.buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
    this.parts = [];
    this.partsLen = 0;
    this.closed = false;
    socket.on('data', (d) => this._onData(d));
    socket.on('error', (e) => this.emit('error', e));
    socket.on('close', () => this._closed());
    if (this.buf.length) queueMicrotask(() => this._onData(Buffer.alloc(0)));
  }

  get destroyed() { return this.closed || this.socket.destroyed; }
  get writableLength() { return this.socket.writableLength; }
  setNoDelay(v) { this.socket.setNoDelay(v); }
  setTimeout(ms, cb) { this.socket.setTimeout(ms, cb); }
  destroy() { this.socket.destroy(); this._closed(); }

  write(data) {
    if (this.destroyed) return false;
    return this.socket.write(Buffer.concat([frameHeader(OP.BIN, data.length), Buffer.from(data.buffer, data.byteOffset, data.length)]));
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _fail() { this.socket.destroy(); this._closed(); }

  _onData(d) {
    if (d.length) this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 2) {
      const b0 = this.buf[0], b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
      if ((b0 & 0x70) !== 0 || !masked) return this._fail(); // no extensions; clients must mask (RFC 6455 5.1)
      let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this._fail();
        len = Number(big); off = 10;
      }
      if (len > MAX_MESSAGE) return this._fail();
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (op >= 8) { // control frames: final, at most 125 bytes
        if (!fin || len > 125) return this._fail();
        if (op === OP.PING) this.socket.write(Buffer.concat([frameHeader(OP.PONG, len), payload]));
        else if (op === OP.CLOSE) { this.socket.end(frameHeader(OP.CLOSE, 0)); this._closed(); return; }
        continue;
      }
      if (op === OP.TEXT) return this._fail(); // the P2P stream is binary only
      if (op === OP.BIN && this.parts.length) return this._fail();
      if (op === OP.CONT && !this.parts.length) return this._fail();
      if (op !== OP.BIN && op !== OP.CONT) return this._fail();
      this.parts.push(payload);
      this.partsLen += len;
      if (this.partsLen > MAX_MESSAGE) return this._fail();
      if (fin) {
        const msg = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts);
        this.parts = [];
        this.partsLen = 0;
        if (msg.length) this.emit('data', msg);
      }
    }
  }
}

function frameHeader(op, len) {
  if (len < 126) return Buffer.from([0x80 | op, len]);
  if (len < 65536) { const h = Buffer.alloc(4); h[0] = 0x80 | op; h[1] = 126; h.writeUInt16BE(len, 2); return h; }
  const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h;
}

/** Client side: Node's built-in WebSocket (ws:// or wss://), with the socket interface Peer expects. */
export class WsClientSocket extends EventEmitter {
  constructor(url, { timeoutMs = 10_000 } = {}) {
    super();
    const u = new URL(url);
    this.remoteAddress = u.hostname;
    this.remotePort = Number(u.port || (u.protocol === 'wss:' ? 443 : 80));
    this.closed = false;
    this.idleMs = 0;
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'arraybuffer';
    this.connectTimer = setTimeout(() => { if (this.ws.readyState !== 1) this.emit('timeout'); }, timeoutMs);
    this.ws.addEventListener('open', () => { clearTimeout(this.connectTimer); this._touch(); this.emit('connect'); });
    this.ws.addEventListener('message', (ev) => {
      this._touch();
      if (typeof ev.data === 'string') { this.destroy(); return; }
      if (ev.data.byteLength) this.emit('data', Buffer.from(ev.data));
    });
    this.ws.addEventListener('error', () => this.emit('error', new Error('websocket error')));
    this.ws.addEventListener('close', () => this._closed());
  }

  get destroyed() { return this.closed; }
  get writableLength() { return this.ws.bufferedAmount; }
  setNoDelay() {}

  setTimeout(ms, cb) {
    this.idleMs = ms;
    this.onIdle = cb;
    this._touch();
  }

  _touch() {
    clearTimeout(this.idleTimer);
    if (this.idleMs && !this.closed) this.idleTimer = setTimeout(() => this.onIdle?.(), this.idleMs);
  }

  write(data) {
    if (this.closed || this.ws.readyState !== 1) return false;
    this.ws.send(data);
    this._touch();
    return true;
  }

  destroy() {
    try { this.ws.close(); } catch { /* already closing */ }
    this._closed();
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectTimer);
    clearTimeout(this.idleTimer);
    this.emit('close');
  }
}

/** A seed or peer address given as a WebSocket URL (ws:// or wss://). */
export const isWsUrl = (s) => /^wss?:\/\/[^\s/]+(\/\S*)?$/i.test(String(s));
