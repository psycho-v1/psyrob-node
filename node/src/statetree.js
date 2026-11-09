// Incremental form of the state root (audit F-01). The root is exactly merkle.js merkleRootFromLeafHashes over the
// leaf hashes of every record sorted by key; only the work to get it changes.
//
// Every level of the tree is kept in one contiguous buffer (32 bytes per node). Between two roots the tree records
// which keys were added, deleted or changed. root() then
//   - merges the added and deleted keys into the sorted key list in one pass (no full re-sort),
//   - from the first position whose leaf moved, rehashes each level to its end (inserting a key shifts every later
//     leaf, so with this tree shape that suffix must be rehashed: an unavoidable cost without a consensus change), and
//   - for records whose value changed in place before that position, rehashes only their paths to the top.
// A block that only updates existing records costs O(changes * log n) instead of O(n).

import { keccak256 } from '../../common/crypto.js';

const H = 32;

export class SortedMerkle {
  /** leafOf(key) -> 32-byte leaf hash of the record's current value. */
  constructor(leafOf) {
    this.leafOf = leafOf;
    this.keys = []; // keys in the tree, sorted
    this.levels = []; // levels[0] = leaf hashes in key order; levels[top] has one node
    this.adds = new Set(); // keys not in the tree yet
    this.dels = new Set(); // keys in the tree to remove
    this.changed = new Set(); // keys in the tree whose value changed
    this.cached = null; // root while nothing changed
    this.scratch = new Uint8Array(1 + 2 * H);
    this.scratch[0] = 1; // merkle.js NODE prefix
    this.stats = { lastMs: 0, lastRehashed: 0 };
  }

  get size() { return this.keys.length - this.dels.size + this.adds.size; }

  /** A record was created (wasPresent = false) or changed (true). */
  put(key, wasPresent) {
    this.cached = null;
    if (!wasPresent) {
      if (this.dels.delete(key)) this.changed.add(key);
      else this.adds.add(key);
    } else if (!this.adds.has(key)) this.changed.add(key);
  }

  /** A record that existed was deleted. */
  remove(key) {
    this.cached = null;
    this.changed.delete(key);
    if (!this.adds.delete(key)) this.dels.add(key);
  }

  _index(key) {
    let lo = 0, hi = this.keys.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const k = this.keys[mid];
      if (k === key) return mid;
      if (k < key) lo = mid + 1; else hi = mid - 1;
    }
    throw new Error('statetree: changed key not in the tree ' + key);
  }

  _node(child, n, i, out) {
    const l = 2 * i;
    if (l + 1 < n) {
      this.scratch.set(child.subarray(l * H, l * H + H), 1);
      this.scratch.set(child.subarray(l * H + H, l * H + 2 * H), 1 + H);
      out.set(keccak256(this.scratch), i * H);
    } else out.set(child.subarray(l * H, l * H + H), i * H); // odd node promoted unchanged
  }

  /** The tree root (merkle.js: the hash of the top node, or 32 zero bytes when empty) and the leaf count. */
  treeRoot() {
    if (this.cached) return this.cached;
    const t0 = performance.now();
    let rehashed = 0;
    let from = Infinity; // first leaf position whose leaf moved (all later ones are rehashed)
    let L0 = this.levels[0] ?? new Uint8Array(0);
    if (this.adds.size || this.dels.size) {
      const old = this.keys, oldL0 = L0;
      const adds = [...this.adds].sort();
      const n = old.length - this.dels.size + adds.length;
      const keys = new Array(n);
      L0 = new Uint8Array(n * H);
      let i = 0, j = 0, o = 0;
      // before the first difference the new order equals the old one: copied in one block afterwards
      const hasDels = this.dels.size > 0;
      while (from === Infinity && i < old.length) {
        if ((hasDels && this.dels.has(old[i])) || (j < adds.length && adds[j] < old[i])) { from = o; break; }
        keys[o++] = old[i++];
      }
      L0.set(oldL0.subarray(0, o * H));
      if (from === Infinity) from = o;
      while (i < old.length || j < adds.length) {
        if (i < old.length && hasDels && this.dels.has(old[i])) { i++; continue; }
        if (j < adds.length && (i >= old.length || adds[j] < old[i])) {
          keys[o] = adds[j]; L0.set(this.leafOf(adds[j]), o * H); o++; j++; rehashed++;
          continue;
        }
        keys[o] = old[i]; L0.set(oldL0.subarray(i * H, i * H + H), o * H); o++; i++;
      }
      if (o !== n) throw new Error('statetree: merge size mismatch');
      this.keys = keys;
      this.levels[0] = L0;
    }
    // changed values: new leaf in place (positions after `from` were copied from the old leaves, so they need it too)
    let dirty = [];
    for (const k of this.changed) {
      const idx = this._index(k);
      L0.set(this.leafOf(k), idx * H);
      rehashed++;
      if (idx < from) dirty.push(idx);
    }
    // upper levels
    let n = this.keys.length, L = 0;
    while (n > 1) {
      const m = (n + 1) >>> 1;
      const child = this.levels[L];
      let out = this.levels[L + 1];
      const f = from === Infinity ? Infinity : from >>> 1;
      if (!out || out.length !== m * H) {
        const fresh = new Uint8Array(m * H);
        if (out && f > 0) fresh.set(out.subarray(0, Math.min(f, m, out.length / H) * H));
        out = fresh;
        this.levels[L + 1] = out;
      }
      if (f !== Infinity) for (let i = f; i < m; i++) { this._node(child, n, i, out); rehashed++; }
      const next = new Set();
      for (const d of dirty) { const p = d >>> 1; if (p < f) next.add(p); }
      for (const p of next) { this._node(child, n, p, out); rehashed++; }
      dirty = next;
      from = f;
      n = m;
      L++;
    }
    this.levels.length = Math.max(L + 1, 1);
    if (!this.keys.length) this.levels.length = 0;
    this.adds.clear(); this.dels.clear(); this.changed.clear();
    const top = this.keys.length ? this.levels[L].slice(0, H) : new Uint8Array(H);
    this.cached = { top, count: this.keys.length };
    this.stats = { lastMs: performance.now() - t0, lastRehashed: rehashed };
    return this.cached;
  }
}
