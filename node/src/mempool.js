// Pending transactions. Kept per sender in nonce order. A transaction is admitted if its signature and encoding are
// valid, its nonce is not below the sender's current nonce at the chain tip, and the sender can pay for it at that
// nonce. Replacement of the same (sender, nonce) needs a 10 % higher max fee. Limits bound memory.
//
// Pending and queued. A transaction is *pending* (executable) if every nonce from the sender's tip nonce
// up to its own is in the pool; otherwise it is *queued* behind a nonce gap. Queued transactions are capped per sender
// and in total, expire after 3 hours, are never relayed, and are the first to go when the pool is full, so transactions
// that cannot run (yet) never crowd out ones that can. A queued transaction becomes pending, and is relayed, once the
// gap is filled. The same split is used by go-ethereum's transaction pool (pending/queue, 3-hour queue lifetime).

import { bytesToHex } from '../../common/bytes.js';
import { parseTx } from './tx.js';
import { intrinsicGas } from './evm.js';
import { KECCAK_EMPTY } from './state.js';
import { equals } from '../../common/bytes.js';
import { SYSTEM_ADDRESS } from './params.js';
import { pauseSkip } from './rules.js';

export class Mempool {
  constructor(params, { maxTxs = 5000, maxPerSender = 64, maxQueued = 1024, maxQueuedPerSender = 16, queuedLifetime = 3 * 3600 } = {}) {
    this.p = params;
    this.maxTxs = maxTxs;
    this.maxPerSender = maxPerSender;
    this.maxQueued = maxQueued;
    this.maxQueuedPerSender = maxQueuedPerSender;
    this.queuedLifetime = queuedLifetime;
    this.bySender = new Map(); // sender hex -> Map(nonce -> tx)
    this.byHash = new Map(); // hash hex -> tx
    this.addedAt = new Map(); // hash hex -> unix seconds
    this.base = new Map(); // sender hex -> nonce at the tip when last seen
    this.lastAdd = { executable: false, promoted: [] };
    // queued (gapped) transactions per sender and in total, kept up to date on every change, so counts() does not
    // walk the whole pool on each add
    this.queuedBy = new Map();
    this.queuedTotal = 0;
  }

  /** Recount the queued transactions of one sender (at most maxPerSender + maxQueuedPerSender of them). */
  _recount(s) {
    const before = this.queuedBy.get(s) ?? 0;
    const now = this.bySender.has(s) ? this.split(s).queued.length : 0;
    if (now) this.queuedBy.set(s, now); else this.queuedBy.delete(s);
    this.queuedTotal += now - before;
  }

  get size() { return this.byHash.size; }

  /** Is `tx` executable: are all nonces from the sender's tip nonce up to its own in the pool? */
  isExecutable(tx) {
    const s = bytesToHex(tx.from);
    const list = this.bySender.get(s);
    let n = this.base.get(s) ?? 0n;
    if (!list) return false;
    while (n < tx.nonce) { if (!list.has(n)) return false; n += 1n; }
    return list.get(tx.nonce) === tx;
  }

  /** The sender's transactions split into pending (consecutive from the tip nonce) and queued (behind a gap). */
  split(s) {
    const list = this.bySender.get(s) ?? new Map();
    const pending = [], queued = [];
    let n = this.base.get(s) ?? 0n;
    for (const nonce of [...list.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
      if (nonce === n) { pending.push(list.get(nonce)); n += 1n; } else queued.push(list.get(nonce));
    }
    return { pending, queued };
  }

  /** Counts for pages and health: { pending, queued }. */
  counts() {
    return { pending: this.byHash.size - this.queuedTotal, queued: this.queuedTotal };
  }

  _remove(tx) {
    const s = bytesToHex(tx.from), h = bytesToHex(tx.hash);
    const list = this.bySender.get(s);
    if (list?.get(tx.nonce) === tx) list.delete(tx.nonce);
    if (list && list.size === 0) this.bySender.delete(s);
    this.byHash.delete(h);
    this.addedAt.delete(h);
    this._recount(s);
  }

  /** All queued transactions, oldest first. */
  _queuedOldestFirst() {
    const out = [];
    for (const s of this.queuedBy.keys()) out.push(...this.split(s).queued);
    return out.sort((a, b) => this.addedAt.get(bytesToHex(a.hash)) - this.addedAt.get(bytesToHex(b.hash)));
  }

  /**
   * Make room for one transaction when the pool is full: the oldest queued transaction goes first; otherwise, for an
   * executable newcomer, the cheapest last-in-line pending transaction of another sender if the newcomer pays more
   * (so no new gap appears). Returns false if nothing may go.
   */
  _evictFor(tx, executable) {
    const q = this._queuedOldestFirst().filter((t) => !equals(t.from, tx.from));
    if (q.length) { this._remove(q[0]); return true; }
    if (!executable) return false;
    let cheapest = null;
    for (const [s, list] of this.bySender) {
      if (s === bytesToHex(tx.from) || !list.size) continue;
      const last = list.get([...list.keys()].reduce((a, b) => (a > b ? a : b)));
      if (!cheapest || last.maxFee < cheapest.maxFee) cheapest = last;
    }
    if (cheapest && cheapest.maxFee < tx.maxFee) { this._remove(cheapest); return true; }
    return false;
  }

  /**
   * Admit a raw transaction against `view` (tip state). Returns the parsed tx; throws with a reason. Afterwards
   * `lastAdd` says whether it is executable and which queued transactions it made executable (to relay them).
   */
  add(raw, view, baseFee, timestamp = Math.floor(Date.now() / 1000)) {
    // `raw` may already be parsed (signature recovered) outside the chain lock
    const tx = raw instanceof Uint8Array ? parseTx(raw, this.p) : raw;
    const h = bytesToHex(tx.hash);
    if (this.byHash.has(h)) { this.lastAdd = { executable: this.isExecutable(this.byHash.get(h)), promoted: [] }; return this.byHash.get(h); }
    if (equals(tx.from, SYSTEM_ADDRESS)) throw new Error('the system address cannot send');
    if (tx.gasLimit > this.p.blockGasLimit) throw new Error('gas limit above block gas limit');
    if (tx.gasLimit < intrinsicGas(tx, this.p)) throw new Error('intrinsic gas too low');
    if (tx.maxFee < this.p.minBaseFee) throw new Error('max fee below the minimum base fee');
    if (tx.to.length === 0 && tx.data.length > this.p.maxInitCodeSize) throw new Error('init code too large');
    const paused = pauseSkip(view, tx, timestamp);
    if (paused) throw new Error(paused + ': only governance, the council, upgrades, the pause, finality and DevVesting.release are accepted until it ends');
    const acc = view.getAccount(tx.from);
    if (!equals(acc.codeHash, KECCAK_EMPTY)) throw new Error('sender has code');
    if (tx.nonce < acc.nonce) throw new Error(`nonce too low: next is ${acc.nonce}`);
    const s = bytesToHex(tx.from);
    this.base.set(s, acc.nonce);
    const list = this.bySender.get(s) ?? new Map();
    if (tx.nonce > acc.nonce + BigInt(this.maxPerSender)) throw new Error('nonce too far ahead');
    // the sender must afford this and every earlier pooled transaction
    let need = tx.value + tx.gasLimit * tx.maxFee;
    for (const [n, t] of list) if (n < tx.nonce) need += t.value + t.gasLimit * t.maxFee;
    if (acc.balance < need) throw new Error('insufficient funds for value + gas');
    const old = list.get(tx.nonce);
    if (old && tx.maxFee * 10n < old.maxFee * 11n) throw new Error('replacement needs a 10 % higher fee');
    // executable if every nonce from the tip nonce up to this one is pooled
    let executable = true;
    for (let n = acc.nonce; n < tx.nonce; n += 1n) if (!list.has(n)) { executable = false; break; }
    if (!old && !executable) {
      if (this.split(s).queued.length >= this.maxQueuedPerSender) throw new Error(`too many transactions waiting behind a nonce gap for this sender (at most ${this.maxQueuedPerSender}); send nonce ${acc.nonce} first`);
      if (this.counts().queued >= this.maxQueued && !this._evictFor(tx, false)) throw new Error('mempool full');
    }
    if (!old && this.byHash.size >= this.maxTxs && !this._evictFor(tx, executable)) throw new Error('mempool full');
    const wasQueued = new Set(this.split(s).queued);
    if (old) this._remove(old);
    const cur = this.bySender.get(s) ?? new Map();
    cur.set(tx.nonce, tx);
    this.bySender.set(s, cur);
    this.byHash.set(h, tx);
    this.addedAt.set(h, timestamp);
    this._recount(s);
    const nowPending = this.split(s).pending;
    this.lastAdd = { executable, promoted: nowPending.filter((t) => wasQueued.has(t)) };
    return tx;
  }

  /**
   * add(), then the transactions to relay: this one if it is executable, plus any queued ones it made executable.
   * A transaction behind a nonce gap is not relayed. `lastTx` is the admitted transaction.
   */
  relayAfterAdd(raw, view, baseFee, timestamp) {
    const tx = this.add(raw, view, baseFee, timestamp);
    this.lastTx = tx;
    return [...(this.lastAdd.executable ? [tx] : []), ...this.lastAdd.promoted];
  }

  get(hashHex) { return this.byHash.get(hashHex.replace(/^0x/, '')); }

  /** Drop transactions whose nonce is already used at `view`, and queued ones older than the queue lifetime. */
  prune(view, now = Math.floor(Date.now() / 1000)) {
    for (const [s, list] of [...this.bySender]) {
      const n = view.getAccount(Uint8Array.from(Buffer.from(s, 'hex'))).nonce;
      this.base.set(s, n);
      for (const [nonce, tx] of [...list]) if (nonce < n) this._remove(tx);
      for (const tx of this.split(s).queued) if (now - (this.addedAt.get(bytesToHex(tx.hash)) ?? now) > this.queuedLifetime) this._remove(tx);
      if (!this.bySender.get(s)?.size) { this.bySender.delete(s); this.base.delete(s); }
      this._recount(s);
    }
  }

  /**
   * Transactions for a block template: per sender, consecutive nonces starting at the sender's nonce in `view`;
   * senders ordered by the tip of their first transaction; within the block gas limit. Queued transactions are never
   * selected, so a gap only holds up its own sender.
   */
  select(view, baseFee, gasLimit, timestamp = null) {
    const queues = [];
    for (const [s, list] of this.bySender) {
      let n = view.getAccount(Uint8Array.from(Buffer.from(s, 'hex'))).nonce;
      const q = [];
      // while the network is paused, transactions outside the allowlist wait in the pool (DAG_SPEC.md section 17.4)
      while (list.has(n)) { const t = list.get(n); if (t.maxFee < baseFee || (timestamp !== null && pauseSkip(view, t, timestamp))) break; q.push(t); n += 1n; }
      if (q.length) queues.push(q);
    }
    const tipOf = (t) => (t.type === 2 ? (t.maxFee - baseFee < t.maxPriorityFee ? t.maxFee - baseFee : t.maxPriorityFee) : t.gasPrice - baseFee);
    queues.sort((a, b) => (tipOf(b[0]) > tipOf(a[0]) ? 1 : tipOf(b[0]) < tipOf(a[0]) ? -1 : 0));
    const out = [];
    let gas = 0n;
    for (const q of queues) for (const t of q) { if (gas + t.gasLimit > gasLimit || out.length >= this.p.maxBlockTxs) break; out.push(t); gas += t.gasLimit; }
    return out;
  }

  pendingOf(senderHex) { return [...(this.bySender.get(senderHex) ?? new Map()).values()]; }
  all() { return [...this.byHash.values()]; }
}
