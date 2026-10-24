// Address manager (DAG_SPEC.md section 13), following the eclipse-attack countermeasures of Heilman et al.
// (USENIX Security 2015):
//   - a "new" table (addresses heard of) and a "tried" table (addresses we connected to), bucketed by network group
//     (/16 for IPv4, /32 for IPv6) with a secret per-node key, and a deterministic slot per address in its bucket
//     (an attacker cannot fill a table by re-inserting the same address);
//   - random selection from both tables (no bias to fresh timestamps);
//   - test-before-evict: a tried slot is only taken over if the current occupant fails a test connection;
//   - feeler connections test new addresses and promote them; anchors (the node keeps its last outbound peers).

import { randomBytes, createHash } from 'node:crypto';
import net from 'node:net';

const NEW_BUCKETS = 256, TRIED_BUCKETS = 64, SLOTS = 64;
const DAY = 86400;

export function netGroup(host) {
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return 'local';
    return `v4:${a}.${b}`;
  }
  if (net.isIPv6(host)) {
    const h = host.toLowerCase();
    if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return 'local';
    return 'v6:' + h.split(':').slice(0, 2).join(':');
  }
  return 'name:' + host; // host names (seeds): one group each
}

const H = (...xs) => createHash('sha256').update(xs.join('|')).digest().readUInt32BE(0);

export class AddrMan {
  constructor({ key, now = () => Math.floor(Date.now() / 1000) } = {}) {
    this.key = key ?? randomBytes(16).toString('hex');
    this.now = now;
    this.info = new Map(); // "host:port" -> { host, port, lastSeen, lastTry, lastSuccess, attempts, source, inTried }
    this.newTable = new Map(); // "b:s" -> addr
    this.triedTable = new Map();
    this.collisions = new Map(); // addr waiting to enter tried -> occupant to test
  }

  static id(host, port) { return net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`; }

  newSlot(a) {
    const b = H(this.key, 'new', netGroup(a.source ?? a.host), netGroup(a.host)) % NEW_BUCKETS;
    return `${b}:${H(this.key, 'slot', b, AddrMan.id(a.host, a.port)) % SLOTS}`;
  }

  triedSlot(a) {
    const b = H(this.key, 'tried', netGroup(a.host), H(this.key, AddrMan.id(a.host, a.port)) % 8) % TRIED_BUCKETS;
    return `${b}:${H(this.key, 'slot', b, AddrMan.id(a.host, a.port)) % SLOTS}`;
  }

  isTerrible(a) {
    const t = this.now();
    if (a.lastTry && t - a.lastTry < 60) return false; // just tried
    if (a.lastSeen > t + 600) return true; // from the future
    if (t - a.lastSeen > 30 * DAY) return true;
    if (!a.lastSuccess && a.attempts >= 3) return true;
    if (a.lastSuccess && t - a.lastSuccess > 7 * DAY && a.attempts >= 10) return true;
    return false;
  }

  /** Learn an address (from a peer's addr message, a seed or an incoming connection). */
  add(host, port, { lastSeen = this.now(), source = null } = {}) {
    if (!host || !(port > 0 && port < 65536)) return false;
    const id = AddrMan.id(host, port);
    let a = this.info.get(id);
    if (a) { if (lastSeen > a.lastSeen) a.lastSeen = Math.min(lastSeen, this.now()); return false; }
    a = { host, port, lastSeen: Math.min(lastSeen, this.now()), lastTry: 0, lastSuccess: 0, attempts: 0, source, inTried: false };
    const slot = this.newSlot(a);
    const occ = this.newTable.get(slot);
    if (occ && occ !== id) {
      const o = this.info.get(occ);
      if (o && !this.isTerrible(o)) return false; // keep the occupant
      this.info.delete(occ);
    }
    this.info.set(id, a);
    this.newTable.set(slot, id);
    return true;
  }

  attempt(host, port) {
    const a = this.info.get(AddrMan.id(host, port));
    if (a) { a.attempts += 1; a.lastTry = this.now(); }
  }

  /** An outbound connection to this address succeeded: move it to tried (test-before-evict on collision). */
  good(host, port) {
    const id = AddrMan.id(host, port);
    let a = this.info.get(id);
    if (!a) { this.add(host, port); a = this.info.get(id); if (!a) return; }
    a.lastSuccess = this.now();
    a.lastSeen = a.lastSuccess;
    a.attempts = 0;
    if (a.inTried) return;
    const slot = this.triedSlot(a);
    const occ = this.triedTable.get(slot);
    if (occ && occ !== id) { this.collisions.set(id, occ); return; }
    this._toTried(id, slot);
  }

  _toTried(id, slot) {
    const a = this.info.get(id);
    for (const [s, x] of this.newTable) if (x === id) this.newTable.delete(s);
    a.inTried = true;
    this.triedTable.set(slot, id);
  }

  /** Resolve a collision after testing the occupant: if it failed, the new address takes the slot. */
  resolveCollision(id, occupantAlive) {
    const occ = this.collisions.get(id);
    this.collisions.delete(id);
    if (!occ || occupantAlive) return;
    const a = this.info.get(id);
    if (!a) return;
    const slot = this.triedSlot(a);
    const o = this.info.get(occ);
    this.triedTable.delete(slot);
    if (o) { o.inTried = false; const ns = this.newSlot(o); if (!this.newTable.has(ns)) this.newTable.set(ns, occ); else this.info.delete(occ); }
    this._toTried(id, slot);
  }

  /** A random address to connect to: tried or new with equal chance; never one in `exclude`. */
  select({ newOnly = false, exclude = new Set() } = {}) {
    const pick = (table) => {
      const ids = [...table.values()].filter((x) => !exclude.has(x));
      if (!ids.length) return null;
      for (let i = 0; i < 20; i++) {
        const a = this.info.get(ids[Math.floor(Math.random() * ids.length)]);
        if (a && !this.isTerrible(a)) return a;
      }
      return this.info.get(ids[Math.floor(Math.random() * ids.length)]) ?? null;
    };
    if (newOnly) return pick(this.newTable);
    const useTried = this.triedTable.size > 0 && (this.newTable.size === 0 || Math.random() < 0.5);
    return pick(useTried ? this.triedTable : this.newTable) ?? pick(useTried ? this.newTable : this.triedTable);
  }

  /** Up to `max` addresses for a getaddr reply (random, not terrible). */
  sample(max = 1000) {
    const all = [...this.info.values()].filter((a) => !this.isTerrible(a));
    for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
    return all.slice(0, Math.min(max, Math.max(1, Math.floor(all.length * 0.23)) + 50));
  }

  get size() { return this.info.size; }

  toJSON() { return { key: this.key, addrs: [...this.info.values()] }; }

  static fromJSON(j, opts = {}) {
    const m = new AddrMan({ ...opts, key: j?.key });
    for (const a of j?.addrs ?? []) {
      const id = AddrMan.id(a.host, a.port);
      m.info.set(id, { ...a });
      if (a.inTried) { const s = m.triedSlot(a); if (!m.triedTable.has(s)) m.triedTable.set(s, id); else { m.info.get(id).inTried = false; m.newTable.set(m.newSlot(a), id); } } else m.newTable.set(m.newSlot(a), id);
    }
    return m;
  }
}
