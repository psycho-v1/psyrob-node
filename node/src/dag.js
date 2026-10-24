// The block DAG and GHOSTDAG (DAG_SPEC.md section 4), following the greedy algorithm of Sompolinsky, Wyborski and
// Zohar (AFT 2021) as implemented in the Kaspa reference node:
//
//   selected parent  = parent with the largest (blueWork, hash)
//   mergeset         = past(B) \ past(SP) \ {SP}, visited in ascending (blueWork, hash)
//   a candidate is blue iff at most k blues of B's view are in its anticone, and no blue of B's view would get more
//   than k blues in its anticone. B's view is scanned along the selected chain, using the blue-anticone sizes each
//   block stores for its own new blues.
//
// Reachability: blueWork strictly increases along every parent edge (a child's blueWork is its selected parent's plus
// the positive work of at least that parent), so "is X in past(Y)" is a backward walk from Y cut at blueWork(X).

import { compare, bytesToHex } from '../../common/bytes.js';
import { workOf } from '../../common/pow.js';

export const hx = (b) => (typeof b === 'string' ? b : bytesToHex(b));

export function cmpBlock(a, b) {
  if (a.blueWork !== b.blueWork) return a.blueWork < b.blueWork ? -1 : 1;
  return compare(a.hashBytes, b.hashBytes);
}

export class Dag {
  constructor(params) {
    this.p = params;
    this.blocks = new Map(); // hex -> entry
    this.tips = new Set();
    this.genesis = null;
    this.reachCache = new Map();
  }

  has(h) { return this.blocks.has(hx(h)); }
  get(h) { return this.blocks.get(hx(h)); }

  /** Genesis entry: blue score 0, blue work 0, chain height 0. */
  addGenesis(hashBytes, header, body) {
    const h = hx(hashBytes);
    const e = {
      hash: h, hashBytes, header, body, parents: [], children: new Set(), selectedParent: null,
      mergesetBlues: [], mergesetReds: [], blueAnticone: new Map(), blueScore: 0, daaScore: 0, blueWork: 0n, chainHeight: 0, work: workOf(header.target),
    };
    this.blocks.set(h, e);
    this.indexBlueScore(e);
    this.tips.add(h);
    this.genesis = e;
    return e;
  }

  /** Is `a` in the past of `b` (strict)? */
  isAncestor(a, b) {
    a = typeof a === 'string' ? this.blocks.get(a) : a;
    b = typeof b === 'string' ? this.blocks.get(b) : b;
    if (!a || !b || a === b) return false;
    if (a.blueWork >= b.blueWork) return false;
    if (a === this.genesis) return true;
    const key = a.hash + b.hash;
    const c = this.reachCache.get(key);
    if (c !== undefined) return c;
    const seen = new Set();
    const stack = [...b.parents];
    let found = false;
    while (stack.length) {
      const x = stack.pop();
      if (x === a.hash) { found = true; break; }
      if (seen.has(x)) continue;
      seen.add(x);
      const e = this.blocks.get(x);
      if (!e || e.blueWork <= a.blueWork) continue;
      for (const p of e.parents) stack.push(p);
    }
    if (this.reachCache.size > 200_000) this.reachCache.clear();
    this.reachCache.set(key, found);
    return found;
  }

  /** GHOSTDAG data of a would-be block with these parents (all known). Does not add anything. */
  ghostdag(parentHashes) {
    const parents = parentHashes.map((p) => this.blocks.get(hx(p)));
    if (parents.some((x) => !x)) throw new Error('ghostdag: unknown parent');
    let sp = parents[0];
    for (const x of parents) if (cmpBlock(x, sp) > 0) sp = x;
    const mergeset = this.mergesetOf(parents, sp);
    const ordered = mergeset.map((h) => this.blocks.get(h)).sort(cmpBlock);
    const data = { selectedParent: sp.hash, mergesetBlues: [sp.hash], mergesetReds: [], blueAnticone: new Map([[sp.hash, 0]]) };
    for (const c of ordered) {
      const r = this.checkBlueCandidate(data, c);
      if (r.blue) {
        data.mergesetBlues.push(c.hash);
        data.blueAnticone.set(c.hash, r.size);
        for (const [blue, size] of r.sizes) data.blueAnticone.set(blue, size + 1);
      } else {
        data.mergesetReds.push(c.hash);
      }
    }
    let blueWork = sp.blueWork;
    for (const b of data.mergesetBlues) blueWork += this.blocks.get(b).work;
    data.blueScore = sp.blueScore + data.mergesetBlues.length;
    // DAA score: every block merged, blue or red. Difficulty follows the total block rate, so a flood of blocks of
    // any colour makes mining harder (risk review Part 4).
    data.daaScore = sp.daaScore + mergeset.length + 1;
    data.blueWork = blueWork;
    data.chainHeight = sp.chainHeight + 1;
    data.mergesetSize = mergeset.length + 1;
    data.orderedMergeset = [sp.hash, ...ordered.map((x) => x.hash)];
    return data;
  }

  mergesetOf(parents, sp) {
    const out = [];
    const seen = new Set([sp.hash]);
    const queue = parents.filter((x) => x !== sp).map((x) => x.hash);
    while (queue.length) {
      const h = queue.shift();
      if (seen.has(h)) continue;
      seen.add(h);
      if (this.isAncestor(h, sp)) continue;
      out.push(h);
      if (out.length > this.p.mergesetLimit) break; // invalid anyway; stop early
      for (const p of this.blocks.get(h).parents) if (!seen.has(p)) queue.push(p);
    }
    return out;
  }

  checkBlueCandidate(data, cand) {
    const k = this.p.k;
    if (data.mergesetBlues.length === k + 1) return { blue: false };
    const sizes = new Map();
    let size = 0;
    let chain = { hash: null, data };
    for (;;) {
      if (chain.hash !== null && this.isAncestor(chain.hash, cand)) return { blue: true, size, sizes };
      for (const b of chain.data.mergesetBlues) {
        if (this.isAncestor(b, cand)) continue;
        const bs = this.blueAnticoneSize(b, data);
        sizes.set(b, bs);
        size += 1;
        if (size > k) return { blue: false };
        if (bs === k) return { blue: false };
        if (bs > k) throw new Error('ghostdag: blue anticone above k (corrupt data)');
      }
      const sp = chain.data.selectedParent;
      if (sp === null) return { blue: true, size, sizes }; // reached genesis
      chain = { hash: sp, data: this.blocks.get(sp) };
    }
  }

  blueAnticoneSize(block, data) {
    let cur = data;
    for (;;) {
      const v = cur.blueAnticone.get(block);
      if (v !== undefined) return v;
      if (cur.selectedParent === null) throw new Error('ghostdag: blue block not found in the selected chain');
      cur = this.blocks.get(cur.selectedParent);
    }
  }

  /** Insert a validated block with its computed GHOSTDAG data. */
  /** Blocks by blue score, so range queries touch only their range. */
  indexBlueScore(e) {
    if (!this.byBlueScore) this.byBlueScore = new Map();
    const l = this.byBlueScore.get(e.blueScore);
    if (l) l.push(e.hash); else this.byBlueScore.set(e.blueScore, [e.hash]);
    if (!(e.blueScore <= this.maxBlueScore)) this.maxBlueScore = e.blueScore;
  }

  /** Blocks with blue score in [lo, hi]. */
  *blocksInBlueScoreRange(lo, hi) {
    // integers only, and never past the highest blue score in the DAG: a start at or above 2^53 (or Infinity) made the
    // counter stop growing and the loop never ended
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) throw new Error('blue score range must be safe integers');
    const top = Math.min(hi, this.maxBlueScore ?? 0);
    for (let s = Math.max(0, lo); s <= top; s++) for (const h of this.byBlueScore?.get(s) ?? []) yield this.blocks.get(h);
  }

  insert(hashBytes, header, body, gd, extra = {}) {
    const h = hx(hashBytes);
    const e = {
      hash: h, hashBytes, header, body, parents: header.parents.map(hx), children: new Set(),
      selectedParent: gd.selectedParent, mergesetBlues: gd.mergesetBlues, mergesetReds: gd.mergesetReds, blueAnticone: gd.blueAnticone,
      orderedMergeset: gd.orderedMergeset, blueScore: gd.blueScore, daaScore: gd.daaScore, blueWork: gd.blueWork, chainHeight: gd.chainHeight,
      work: workOf(header.target), ...extra,
    };
    this.blocks.set(h, e);
    this.indexBlueScore(e);
    for (const p of e.parents) { this.blocks.get(p).children.add(h); this.tips.delete(p); }
    this.tips.add(h);
    return e;
  }

  /** Virtual parents: the tips with the largest (blueWork, hash), at most maxParents, sorted for the header. */
  virtualParents() {
    const tips = [...this.tips].map((t) => this.blocks.get(t)).sort((a, b) => -cmpBlock(a, b));
    return tips.slice(0, this.p.maxParents).map((t) => t.hash);
  }

  /**
   * Parents for a new block template: the virtual parents without any that block validation would refuse. A stale tip
   * (for example a block mined while the node was still syncing) stays a tip for ever; if it were a parent, the block
   * would be refused with "parent below the merge depth" and nobody could extend the chain. Mirrors the checks in Chain._connect: every parent and every red mergeset block within the
   * merge depth of the selected parent, and the mergeset within its limit. Dropping a parent only shrinks the
   * mergeset; the selected parent is always kept.
   */
  templateParents() {
    // first by blue score alone: a tip far below the others may already be pruned (no GHOSTDAG working data), so it
    // must go before GHOSTDAG runs; the selected parent's blue score is at most the highest tip's
    const tips = this.virtualParents();
    const high = Math.max(...tips.map((h) => this.blocks.get(h).blueScore));
    let parents = tips.filter((h) => this.blocks.get(h).blueScore + this.p.mergeDepth >= high);
    for (;;) {
      const gd = this.ghostdag(parents);
      const floor = this.blocks.get(gd.selectedParent).blueScore - this.p.mergeDepth;
      const kept = parents.filter((h) => this.blocks.get(h).blueScore >= floor);
      if (kept.length < parents.length) { parents = kept; continue; }
      const tooDeep = gd.mergesetReds.some((r) => this.blocks.get(r).blueScore < floor);
      if (parents.length === 1 || (!tooDeep && gd.mergesetSize <= this.p.mergesetLimit)) return parents;
      // drop the parent with the lowest blue score (never the selected parent) and try again
      const drop = parents.filter((h) => h !== gd.selectedParent).sort((a, b) => this.blocks.get(a).blueScore - this.blocks.get(b).blueScore)[0];
      parents = parents.filter((h) => h !== drop);
    }
  }

  /** The selected chain from `tipHash` back to genesis, genesis first. */
  selectedChain(tipHash) {
    const out = [];
    for (let h = tipHash; h !== null; h = this.blocks.get(h).selectedParent) out.push(h);
    return out.reverse();
  }

  isRed(h) { return !!this.blocks.get(h)?.red; }
}
