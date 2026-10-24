// World state: typed records under one Merkle root, with copy-on-write views and exact undo.
//
// Execution never mutates the base state directly. A block (or a mempool check, or an
// eth_call) runs against a StateView; only a fully valid block is committed, and commit
// returns an undo record so the block can be disconnected during a reorg.
//
// Records (key = type char + hex):
//   a<addr>            account   { nonce, balance, codeHash }
//   c<addr>            code      { code }
//   k<addr><slot32>    storage   { value }
//   g                  globals   { genesisSupply, issuedMining, issuedNGO, burned }
//
// State root: domain-separated Merkle root (merkle.js) over every non-empty record sorted by
// key; leaf = rlp([typeByte || keyBytes, ...fields]). Empty records are deleted, so the root
// depends only on semantic content.

import * as rlp from '../../common/rlp.js';
import { bytesToHex, hexToBytes, concat } from '../../common/bytes.js';
import { leafHash, merkleRootFromLeafHashes } from '../../common/merkle.js';
import { keccak256 } from '../../common/crypto.js';

export const KECCAK_EMPTY = keccak256(new Uint8Array(0));
const KECCAK_EMPTY_HEX = bytesToHex(KECCAK_EMPTY);

const TYPES = {
  a: { code: 1, empty: { nonce: 0n, balance: 0n, codeHash: KECCAK_EMPTY }, fields: ['nonce', 'balance', 'codeHash'],
    isEmpty: (v) => v.nonce === 0n && v.balance === 0n && bytesToHex(v.codeHash) === KECCAK_EMPTY_HEX },
  g: { code: 3, empty: { genesisSupply: 0n, issuedMining: 0n, issuedNGO: 0n, burned: 0n }, fields: ['genesisSupply', 'issuedMining', 'issuedNGO', 'burned'], isEmpty: () => false },
  c: { code: 4, empty: { code: new Uint8Array(0) }, fields: ['code'], isEmpty: (v) => v.code.length === 0 },
  k: { code: 5, empty: { value: 0n }, fields: ['value'], isEmpty: (v) => v.value === 0n },
};

export const RECORD_FIELDS = Object.fromEntries(Object.entries(TYPES).map(([t, v]) => [t, v.fields]));

export const keys = {
  account: (addr) => 'a' + bytesToHex(addr),
  code: (addr) => 'c' + bytesToHex(addr),
  storage: (addr, slot) => 'k' + bytesToHex(addr) + bytesToHex(slot),
  globals: () => 'g',
};

function encField(x) {
  if (typeof x === 'bigint') return rlp.int(x);
  if (typeof x === 'number') return rlp.int(BigInt(x));
  if (x instanceof Uint8Array) return x;
  if (Array.isArray(x)) return x.map(encField);
  throw new Error('state: unencodable field');
}

function encodeLeaf(key, v) {
  const t = TYPES[key[0]];
  return rlp.encode([concat(Uint8Array.of(t.code), hexToBytes(key.slice(1))), ...t.fields.map((f) => encField(v[f]))]);
}

function checkValue(key, v) {
  const t = TYPES[key[0]];
  if (!t) throw new Error('state: unknown record type ' + key[0]);
  for (const f of t.fields) {
    const x = v[f];
    if ((typeof x === 'bigint' && x < 0n) || (typeof x === 'number' && (!Number.isSafeInteger(x) || x < 0))) {
      throw new Error(`state: negative or invalid ${key[0]}.${f}`);
    }
  }
}

class Reader {
  _rec(key) { return this.get(key) ?? TYPES[key[0]].empty; }
  getAccount(addr) { return this._rec(keys.account(addr)); }
  getCode(addr) { return this._rec(keys.code(addr)).code; }
  getStorage(addr, slot) { return this._rec(keys.storage(addr, slot)).value; }
  getGlobal() { return this._rec(keys.globals()); }
  view() { return new StateView(this); }
}

export class StateView extends Reader {
  constructor(parent) {
    super();
    this.parent = parent;
    this.changes = new Map(); // key -> frozen value, or undefined for deletion
    this.cleared = new Set(); // addrHex whose storage was cleared in this view
  }

  get(key) {
    if (this.changes.has(key)) return this.changes.get(key);
    if (key[0] === 'k' && this.cleared.has(key.slice(1, 41))) return undefined;
    return this.parent.get(key);
  }

  set(key, value) {
    const t = TYPES[key[0]];
    const v = { ...t.empty, ...value };
    for (const f of t.fields) if (Array.isArray(v[f])) v[f] = Object.freeze([...v[f]]);
    checkValue(key, v);
    this.changes.set(key, t.isEmpty(v) ? undefined : Object.freeze(v));
  }

  setAccount(addr, v) { this.set(keys.account(addr), { ...this.getAccount(addr), ...v }); }
  setCode(addr, code) { this.set(keys.code(addr), { code }); }
  setStorage(addr, slot, value) { this.set(keys.storage(addr, slot), { value }); }
  setGlobal(v) { this.set(keys.globals(), { ...this.getGlobal(), ...v }); }

  /** Remove every storage slot of `addr` (used by the EVM on CREATE / SELFDESTRUCT). */
  clearStorage(addr) {
    const a = bytesToHex(addr);
    for (const k of [...this.changes.keys()]) if (k[0] === 'k' && k.slice(1, 41) === a) this.changes.delete(k);
    this.cleared.add(a);
  }

  deleteAccount(addr) {
    this.changes.set(keys.account(addr), undefined);
    this.changes.set(keys.code(addr), undefined);
    this.clearStorage(addr);
  }

  /** Fold this view's changes into its parent view. */
  mergeIntoParent() {
    if (!(this.parent instanceof StateView)) throw new Error('mergeIntoParent: parent is not a view');
    for (const a of this.cleared) this.parent.clearStorage(hexToBytes(a));
    for (const [k, v] of this.changes) this.parent.changes.set(k, v);
    this.changes.clear();
    this.cleared.clear();
  }
}

export class State extends Reader {
  constructor() {
    super();
    this.data = new Map();
    this.leaves = new Map(); // key -> cached leaf hash
    this.slotsByAddr = new Map(); // addrHex -> Set of storage keys (for clearStorage)
    this.sortedKeys = null;
  }

  get(key) { return this.data.get(key); }

  _put(key, value) {
    if (value === undefined) {
      if (this.data.delete(key)) {
        this.leaves.delete(key);
        this.sortedKeys = null;
        if (key[0] === 'k') this.slotsByAddr.get(key.slice(1, 41))?.delete(key);
      }
      return;
    }
    if (!this.data.has(key)) {
      this.sortedKeys = null;
      if (key[0] === 'k') {
        const a = key.slice(1, 41);
        if (!this.slotsByAddr.has(a)) this.slotsByAddr.set(a, new Set());
        this.slotsByAddr.get(a).add(key);
      }
    }
    this.data.set(key, value);
    this.leaves.set(key, leafHash(encodeLeaf(key, value)));
  }

  /** Apply a view's changes. Returns an undo record (Map key -> previous value). */
  commit(view) {
    if (view.parent !== this) throw new Error('commit: view does not belong to this state');
    const undo = new Map();
    const record = (k) => { if (!undo.has(k)) undo.set(k, this.data.get(k)); };
    for (const a of view.cleared) {
      for (const k of [...(this.slotsByAddr.get(a) ?? [])]) { record(k); this._put(k, undefined); }
    }
    for (const [k, v] of view.changes) { record(k); this._put(k, v); }
    return undo;
  }

  revert(undo) {
    for (const [k, prev] of undo) this._put(k, prev);
  }

  root() {
    if (!this.sortedKeys) this.sortedKeys = [...this.data.keys()].sort();
    return merkleRootFromLeafHashes(this.sortedKeys.map((k) => this.leaves.get(k)));
  }

  /** Root this state would have with `view` applied, without keeping the changes. */
  rootWith(view) {
    const undo = this.commit(view);
    try { return this.root(); } finally { this.revert(undo); }
  }

  /** Every record as [key, value] (pruning snapshots, prune.js). */
  records() { return [...this.data]; }

  /** Load records into an empty state (pruning snapshots). */
  importRecords(entries) {
    if (this.data.size) throw new Error('state: importRecords needs an empty state');
    for (const [k, v] of entries) { checkValue(k, v); this._put(k, Object.freeze(v)); }
  }

  /** Sum of every account balance (supply invariant checks; O(accounts)). */
  sumBalances() {
    let s = 0n;
    for (const [k, v] of this.data) if (k[0] === 'a') s += v.balance;
    return s;
  }
}
