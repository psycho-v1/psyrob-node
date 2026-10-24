// Consensus: block validation, mergeset execution, the virtual chain, reorganisations and finality
// (DAG_SPEC.md sections 3-10).
//
// State model. Every block B commits to the state after accepting its mergeset on top of its selected parent's state.
// The node keeps one State object and, for each block within the DAG finality window, the exact changes accepting its
// mergeset made (redo) and the previous values (undo). `moveTo(X)` walks the selected-parent tree from the block the
// state currently represents to X, reverting and re-applying those changes. Validation of B is: moveTo(SP(B)),
// execute B's mergeset in a view, commit, compare the roots (revert if they differ).

import * as rlp from '../../common/rlp.js';
import { keccak256 } from '../../common/crypto.js';
import { merkleRoot } from '../../common/merkle.js';
import { bytesToHex, bytesToBigint, concat, equals, utf8, bigintToFixed, compare, fromHex } from '../../common/bytes.js';
import { signingBytes, minerSigner, genesisHash, encodeHeader } from '../../common/header.js';
import { checkPow } from '../../common/pow.js';
import * as abi from '../../common/abi.js';
import { recoverAddress } from '../../common/crypto.js';
import { Dag, hx } from './dag.js';
import { State } from './state.js';
import { asertNextTarget } from './asert.js';
import { decodeBlock, bodyRoot } from './block.js';
import { parseTx } from './tx.js';
import { runTx, skipReason, contractCall } from './evm.js';
import { poolSubsidy } from './emission.js';
import { ADDR, SYSTEM_ADDRESS, BURN_ADDRESS, versionText } from './params.js';
import { pauseSkip, requiredVersion, OWN_VERSION, neverReplaceable } from './rules.js';
import { KECCAK_EMPTY } from './state.js';

const EMPTY = new Uint8Array(0);
// the checkpoint digest also names the genesis time, so a signature of one launch on a chain ID
// cannot be used on another. The genesis hash itself cannot be bound: it depends on the contracts' state.
export const CHECKPOINT_DOMAIN = keccak256(utf8('PSYROB-checkpoint'));
/** A certificate's signers (distinct committee members, hex) reach the quorum: 15 in all, of which the epoch's required
 *  number of NGO members. */
export const CERT_QUORUM = 15;
/** The epoch bootstrap certificates carry (FinalityCommittee.BOOTSTRAP_EPOCH, 2^48 - 1; DAG_SPEC.md section 9.1). */
export const BOOTSTRAP_EPOCH = 2 ** 48 - 1;
export function certQuorum(signers, rule) {
  const { ngo, ngoRequired } = rule;
  let n = 0, ngoN = 0;
  for (const a of signers) { n++; if (ngo.has(a)) ngoN++; }
  return n >= (rule.quorum ?? CERT_QUORUM) && ngoN >= ngoRequired;
}

// Orphan pool bounds
export const ORPHAN_MAX_COUNT = 512, ORPHAN_MAX_BYTES = 64 * 1024 * 1024;
export const ORPHAN_SOURCE_COUNT = 256, ORPHAN_SOURCE_BYTES = 16 * 1024 * 1024;

/** Per-block fields moved to the cold store once a block is far below the finality depth (Chain._pruneUndo). */
const COLD_FIELDS = ['raw', 'body', 'receipts', 'accepted', 'skipped', 'systemReceipts', 'colours', 'paid'];

const COLD_SKIP = new Set([...COLD_FIELDS, 'header', 'stateRoot', 'hashBytes', 'undo', 'redo', 'blueAnticone', 'orderedMergeset']);

/** A block far below the finality depth: its bulky data is in the cold store (Chain._freeze). */
class ColdBlock {
  constructor(chain, at) { this.chainRef = chain; this.coldAt = at; this.undo = null; this.redo = null; this.blueAnticone = null; this.orderedMergeset = null; }
  get stateRoot() { return this.chainRef._coldRecord(this).stateRoot; }
  get hashBytes() { return fromHex('0x' + this.hash); }
}
for (const k of COLD_FIELDS) {
  Object.defineProperty(ColdBlock.prototype, k, {
    get() { return this.chainRef._coldRecord(this)[k]; },
    set(v) { Object.defineProperty(this, k, { value: v, writable: true, configurable: true, enumerable: true }); },
  });
}

/** The header of a cold block: scalar fields kept, the rest read from the cold record. */
class ColdHeader {
  constructor(block, h, miner) {
    this.blockRef = block;
    this.version = h.version; this.timestamp = h.timestamp; this.target = h.target; this.blueScore = h.blueScore; this.blueWork = h.blueWork;
    this.gasLimit = h.gasLimit; this.gasUsed = h.gasUsed; this.baseFee = h.baseFee; this.miner = miner;
  }
}
for (const k of ['parents', 'stateRoot', 'txRoot', 'receiptsRoot', 'acceptedTxRoot', 'extra', 'nonce', 'minerSig']) {
  Object.defineProperty(ColdHeader.prototype, k, { get() { const b = this.blockRef; return b.chainRef._coldRecord(b).header[k]; }, enumerable: true });
}

/** moveTo refused: a block on the way has no undo/redo record any more. Nothing was changed. */
export class StateUnavailable extends Error {}

export class BlockError extends Error {
  constructor(message, { ban = 0, missing = null } = {}) { super(message); this.ban = ban; this.missing = missing; }
}

export function encodeReceipt(r) {
  return rlp.encode([
    rlp.int(r.status), rlp.int(r.gasUsed), r.logs.map((l) => [l.address, l.topics, l.data]), r.contractAddress ?? EMPTY,
    rlp.int(r.burned ?? 0n), rlp.int(r.tip ?? 0n),
  ]);
}

/** EIP-1559 style base fee of a block from its selected parent (accepted gas vs target). */
export function nextBaseFee(parentBaseFee, parentGasUsed, p) {
  const t = p.baseFeeTarget;
  let fee = parentBaseFee;
  if (parentGasUsed > t) {
    const d = parentBaseFee * (parentGasUsed - t) / t / p.baseFeeChangeDenominator;
    fee = parentBaseFee + (d > 0n ? d : 1n);
  } else if (parentGasUsed < t) {
    fee = parentBaseFee - parentBaseFee * (t - parentGasUsed) / t / p.baseFeeChangeDenominator;
  }
  return fee < p.minBaseFee ? p.minBaseFee : fee;
}

export function checkpointDigest(chainId, genesisTime, number, chainBlock, stateRoot) {
  return keccak256(abi.encode(['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
    [bytesToBigint(CHECKPOINT_DOMAIN), chainId, BigInt(genesisTime), BigInt(number), bytesToBigint(chainBlock), bytesToBigint(stateRoot)]));
}

export function recoverSig65(digest, sig) {
  const r = bytesToBigint(sig.subarray(0, 32)), s = bytesToBigint(sig.subarray(32, 64));
  let v = sig[64];
  if (v >= 27) v -= 27;
  return recoverAddress(digest, r, s, v);
}

export class Chain {
  /**
   * genesis = { header, hash, records } where records are the genesis state records (genesis/build.js).
   * opts = { now() -> unix seconds, onEvent(type, data), verifyPow(bool) }
   */
  constructor(params, genesis, opts = {}) {
    this.p = params;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
    this.onEvent = opts.onEvent ?? (() => {});
    this.powImpl = opts.powImpl;
    // where bulky data of old blocks goes (Store: putCold/getCold), or null to keep everything in memory (tests)
    this.cold = opts.cold ?? null;
    this.coldCache = new Map(); // block hash -> cold record, least recently used first
    this.minerBytes = new Map(); // miner hex -> one shared Uint8Array for the headers of cold blocks
    this.prunedTo = 0; // blue scores below this have been pruned
    this.dag = new Dag(params);
    this.state = new State();
    this.state.importRecords(genesis.records);
    this.genesisHeader = genesis.header;
    this.genesisTime = genesis.header.timestamp;
    const gh = genesisHash(genesis.header);
    if (genesis.hash && !equals(gh, genesis.hash)) throw new Error('genesis hash mismatch');
    if (!equals(this.state.root(), genesis.header.stateRoot)) throw new Error('genesis state root mismatch');
    this.genesisHash = gh;
    // easiest allowed target: 16 times the genesis target, never above 2^256 - 1 (consensus rule)
    const max = (1n << 256n) - 1n;
    this.powLimit = genesis.header.target * 16n > max ? max : genesis.header.target * 16n;
    const g = this.dag.addGenesis(gh, genesis.header, { txs: [], certs: [] });
    g.stateRoot = genesis.header.stateRoot;
    g.gasUsed = 0n;
    g.baseFee = genesis.header.baseFee;
    g.receipts = [];
    g.accepted = [];
    this.stateAt = g.hash;
    this.tip = g; // selected parent of the virtual = head of the chain
    this.chain = [g.hash]; // chain hashes by chain height
    this.txIndex = new Map(); // tx hash hex -> { block (chain block hex), index } for the current chain
    this.acceptedBy = new Map(); // block hex -> { by: chain block that merged it, colour } for the current chain
    this.finalCheckpoint = { number: 0, hash: g.hash }; // highest final checkpoint known
    this.certs = new Map(); // checkpoint number -> cert (final, any source)
    this.orphans = new Map();
    this.orphanBytes = 0;
    this.orphanUse = new Map(); // source -> { count, bytes }
    this.lock = Promise.resolve();
  }

  /** Serialise async work on the chain (block intake, RPC reads that need a consistent state). */
  exclusive(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }

  get(h) { return this.dag.get(h); }

  // ---------------------------------------------------------------- time and difficulty

  pastMedianTime(entry) {
    const ts = [];
    for (let e = entry, i = 0; e && i < this.p.pastMedianWindow; e = e.selectedParent ? this.dag.get(e.selectedParent) : null, i++) ts.push(e.header.timestamp);
    // a numeric sort of plain integers: equal timestamps are equal values, so the median is the same on every node
    // whatever the arrival order
    ts.sort((a, b) => a - b);
    return ts[Math.floor(ts.length / 2)];
  }

  expectedTarget(sp) {
    const anchor = { target: this.genesisHeader.target, parentTimestamp: this.genesisTime - this.p.targetSpacing, number: 0 };
    // ASERT on the DAA score (all blocks, blue and red) of the selected parent and its timestamp
    return asertNextTarget(anchor, sp.header.timestamp, sp.daaScore, { ...this.p, powLimit: this.powLimit });
  }

  // ---------------------------------------------------------------- state movement

  _path(fromHex, toHex) {
    // walk both up to the common selected-chain ancestor
    let a = this.dag.get(fromHex), b = this.dag.get(toHex);
    const down = [], up = [];
    while (a !== b) {
      if (a.chainHeight >= b.chainHeight) { up.push(a); a = this.dag.get(a.selectedParent); } else { down.push(b); b = this.dag.get(b.selectedParent); }
    }
    return { up, down: down.reverse() };
  }

  /** Can the state move to block h? Every block on the way needs its undo (going back) or redo (going forward) record. */
  canMoveTo(h) {
    h = hx(h);
    if (this.stateAt === h) return true;
    if (!this.dag.has(h)) return false;
    const { up, down } = this._path(this.stateAt, h);
    return up.every((e) => e.undo) && down.every((e) => e.redo);
  }

  moveTo(h) {
    h = hx(h);
    if (this.stateAt === h) return;
    const { up, down } = this._path(this.stateAt, h);
    // check the whole path before changing anything: a record missing halfway used to leave the state half reverted
    // while stateAt still named the old block, and every later block was then executed on a wrong state
    const gap = up.find((e) => !e.undo) ?? down.find((e) => !e.redo);
    if (gap) throw new StateUnavailable(`state: ${up.includes(gap) ? 'undo' : 'redo'} record pruned for ${gap.hash}`);
    for (const e of up) {
      this.state.revert(e.undo);
    }
    for (const e of down) {
      const v = this.state.view();
      for (const [k, val] of e.redo) v.changes.set(k, val);
      this.state.commit(v);
    }
    this.stateAt = h;
  }

  // ---------------------------------------------------------------- block intake

  /** Add a raw block. Returns { status: 'added'|'known'|'orphan', hash, entry }. Throws BlockError if invalid. */
  /** `powChecked`: the caller already checked the proof of work outside the lock (psy_submitBlock). */
  addBlock(raw, { trusted = false, source = null, powChecked = false } = {}) {
    return this.exclusive(() => this._addBlock(raw, { trusted, source, powChecked }));
  }

  async _addBlock(raw, { trusted, source, powChecked = false }) {
    let b;
    try { b = decodeBlock(raw); } catch (e) { throw new BlockError('malformed block: ' + e.message, { ban: 100 }); }
    const h = hx(b.hash);
    if (this.dag.has(h)) return { status: 'known', hash: h };
    const hd = b.header;
    // Checks in order of cost (risk review Part 4): sizes and fields, then difficulty and time against the selected
    // parent (cheap, so a forged easy target never reaches Argon2d), then the body hash, the miner signature, the
    // 32 MiB proof of work, and last the transaction signatures.
    if (hd.timestamp > this.now() + this.p.maxFutureDrift && !trusted) throw new BlockError('timestamp too far in the future');
    if (b.txRaws.length > this.p.maxBlockTxs) throw new BlockError('too many transactions', { ban: 100 });
    if (b.certs.length > this.p.maxCertsPerBlock) throw new BlockError('too many certificates', { ban: 100 });
    if (hd.gasLimit !== this.p.blockGasLimit) throw new BlockError('wrong gas limit', { ban: 100 });
    const missing = hd.parents.map(hx).filter((p) => !this.dag.has(p));
    if (!missing.length) {
      let sp = null;
      for (const p of hd.parents) { const e = this.dag.get(hx(p)); if (!sp || e.blueWork > sp.blueWork || (e.blueWork === sp.blueWork && compare(e.hashBytes, sp.hashBytes) > 0)) sp = e; }
      if (hd.target !== this.expectedTarget(sp)) throw new BlockError('wrong target', { ban: 100 });
      if (hd.timestamp <= this.pastMedianTime(sp)) throw new BlockError('timestamp not after the past median time', { ban: 100 });
    } else if (hd.target > this.powLimit || hd.target > this.expectedTarget(this.tip) * 16n) {
      // an orphan cannot be checked against its parents yet; it must at least not claim an implausibly easy target
      throw new BlockError('orphan with an implausible target', { ban: 100 });
    }
    if (!equals(bodyRoot(b.txRaws, b.certs), hd.txRoot)) throw new BlockError('body does not match txRoot', { ban: 100 });
    const signing = signingBytes(hd);
    const signer = minerSigner(hd, signing);
    if (!signer || !equals(signer, hd.miner)) throw new BlockError('miner signature does not match the miner address', { ban: 100 });
    if (!trusted && !powChecked && !checkPow(b.headerRaw, hd.target, this.p.pow, this.powImpl)) throw new BlockError('proof of work above target', { ban: 100 });
    let txs;
    try { txs = b.txRaws.map((t) => parseTx(t, this.p)); } catch (e) { throw new BlockError('bad transaction: ' + e.message, { ban: 100 }); }
    let gasSum = 0n;
    for (const t of txs) gasSum += t.gasLimit;
    if (gasSum > this.p.blockGasLimit) throw new BlockError('transactions exceed the block gas limit', { ban: 100 });
    if (missing.length) {
      this._storeOrphan(h, { raw, missing: new Set(missing), source });
      return { status: 'orphan', hash: h, missing };
    }
    const entry = await this._connect(b, txs, trusted, raw);
    this.onEvent('block', entry);
    await this._updateVirtual();
    // orphans waiting for this block
    for (const [oh, o] of [...this.orphans]) {
      if (!o.missing.has(h)) continue;
      o.missing.delete(h);
      if (o.missing.size === 0) {
        this._dropOrphan(oh);
        // its proof of work was checked when it was stored as an orphan
        try { await this._addBlock(o.raw, { trusted, source: o.source, powChecked: true }); } catch (e) { this.onEvent('orphanInvalid', { hash: oh, error: e.message, source: o.source }); }
      }
    }
    return { status: 'added', hash: h, entry };
  }

  // Orphan pool: bounded by bytes as well as count, with a per-source share. When full, the
  // oldest orphan of the source holding the most bytes goes first, and a source over its share evicts its own oldest:
  // a peer feeding junk orphans pushes out its own, not the ones honest peers sent during a sync.
  _storeOrphan(h, o) {
    const key = o.source ?? 'local';
    const size = o.raw.length;
    const use = (k) => this.orphanUse.get(k) ?? { count: 0, bytes: 0 };
    while (this.orphans.size && (this.orphans.size >= ORPHAN_MAX_COUNT || this.orphanBytes + size > ORPHAN_MAX_BYTES
      || use(key).count >= ORPHAN_SOURCE_COUNT || use(key).bytes + size > ORPHAN_SOURCE_BYTES)) {
      let victimSource = key;
      if (use(key).count < ORPHAN_SOURCE_COUNT && use(key).bytes + size <= ORPHAN_SOURCE_BYTES) {
        let most = -1;
        for (const [k, u] of this.orphanUse) if (u.bytes > most) { most = u.bytes; victimSource = k; }
      }
      let victim = null;
      for (const [oh, x] of this.orphans) if ((x.source ?? 'local') === victimSource) { victim = oh; break; }
      this._dropOrphan(victim ?? this.orphans.keys().next().value);
    }
    this.orphans.set(h, o);
    this.orphanBytes += size;
    const u = use(key);
    this.orphanUse.set(key, { count: u.count + 1, bytes: u.bytes + size });
  }

  _dropOrphan(h) {
    const o = this.orphans.get(h);
    if (!o) return;
    this.orphans.delete(h);
    const key = o.source ?? 'local';
    this.orphanBytes -= o.raw.length;
    const u = this.orphanUse.get(key);
    if (u.count <= 1) this.orphanUse.delete(key);
    else this.orphanUse.set(key, { count: u.count - 1, bytes: u.bytes - o.raw.length });
  }

  async _connect(b, txs, trusted, raw) {
    const hd = b.header;
    let gd;
    try { gd = this.dag.ghostdag(hd.parents); } catch (e) { throw new BlockError('ghostdag: ' + e.message, { ban: 100 }); }
    if (gd.mergesetSize > this.p.mergesetLimit) throw new BlockError('mergeset too large', { ban: 100 });
    const sp = this.dag.get(gd.selectedParent);
    // parents must not be ancestors of each other (redundant parents)
    for (const p of hd.parents) for (const q of hd.parents) if (p !== q && this.dag.isAncestor(hx(p), hx(q))) throw new BlockError('redundant parent', { ban: 100 });
    // every parent must be within the merge depth of the selected parent: a block cannot point far into the past and
    // force long reachability walks
    for (const p of hd.parents) {
      if (this.dag.get(hx(p)).blueScore + this.p.mergeDepth < sp.blueScore) throw new BlockError('parent below the merge depth', { ban: 100 });
    }
    for (const r of gd.mergesetReds) {
      if (this.dag.get(r).blueScore + this.p.mergeDepth < sp.blueScore) throw new BlockError('merge depth exceeded by a red block', { ban: 100 });
    }
    if (BigInt(gd.blueScore) !== hd.blueScore || gd.blueWork !== hd.blueWork) throw new BlockError('wrong blue score or blue work', { ban: 100 });
    if (hd.timestamp <= this.pastMedianTime(sp)) throw new BlockError('timestamp not after the past median time', { ban: 100 });
    if (hd.target !== this.expectedTarget(sp)) throw new BlockError('wrong target', { ban: 100 });
    const baseFee = nextBaseFee(sp.baseFee, sp.gasUsed, this.p);
    if (hd.baseFee !== baseFee) throw new BlockError('wrong base fee', { ban: 100 });
    // finality: never build on a branch that excludes the last final checkpoint. The final checkpoint is this node's
    // own view (certificates it has seen), so an honest peer that has not seen the same certificate is refused without
    // a ban score
    if (!this._includesFinal(sp)) throw new BlockError('block conflicts with a final checkpoint', { ban: 0 });
    // a selected parent deeper than the finality depth below the tip can never become the chain, and its state may
    // already be pruned: refuse the block before touching the state
    if (sp.blueScore + this.p.finalityDepth < this.tip.blueScore) throw new BlockError('selected parent below the finality depth', { ban: 0 });
    if (!this.canMoveTo(sp.hash)) throw new BlockError('the state of the selected parent is no longer kept', { ban: 0 });
    // execution
    this.moveTo(sp.hash);
    // an approved node update in force at the selected parent that this node does not run: stop here instead of
    // following a chain whose rules it does not know (DAG_SPEC.md section 17.3)
    const need = requiredVersion(this.state);
    if (need > OWN_VERSION) {
      if (this.upgradeRequired !== need) { this.upgradeRequired = need; this.onEvent('upgradeRequired', { version: versionText(need) }); }
      throw new BlockError(`upgrade required: this network now needs node ${versionText(need)} or newer`, { ban: 0 });
    }
    const pending = { header: hd, txs, certs: b.certs, hash: hx(b.hash), hashBytes: b.hash };
    const res = await this.acceptMergeset(pending, gd, sp, baseFee);
    const undo = this.state.commit(res.view);
    const root = this.state.root();
    const redo = new Map();
    for (const k of undo.keys()) redo.set(k, this.state.get(k));
    const fail = (m) => { this.state.revert(undo); return new BlockError(m, { ban: 100 }); };
    if (!equals(root, hd.stateRoot)) throw fail('state root mismatch');
    if (!equals(res.receiptsRoot, hd.receiptsRoot)) throw fail('receipts root mismatch');
    if (!equals(res.acceptedTxRoot, hd.acceptedTxRoot)) throw fail('accepted transactions root mismatch');
    if (res.gasUsed !== hd.gasUsed) throw fail('gas used mismatch');
    const entry = this.dag.insert(b.hash, hd, { txs, certs: b.certs, raw: null }, gd, {
      stateRoot: root, gasUsed: res.gasUsed, baseFee, undo, redo, receipts: res.receipts, accepted: res.accepted, skipped: res.skipped,
      systemReceipts: res.systemReceipts, colours: res.colours, paid: res.paid, raw,
    });
    this.stateAt = entry.hash;
    // a reverted system call (draw, election, rewards) is part of consensus and does not invalidate the block, but it
    // must not pass silently
    for (const r of res.systemReceipts) if (!r.status) this.onEvent('systemCallFailed', { hash: entry.hash, chainHeight: entry.chainHeight, label: r.label, reason: r.reason, gasUsed: r.gasUsed });
    return entry;
  }

  _includesFinal(sp) {
    const f = this.dag.get(this.finalCheckpoint.hash);
    if (!f || f === this.dag.genesis) return true;
    if (sp.chainHeight < f.chainHeight) return false;
    let e = sp;
    while (e.chainHeight > f.chainHeight) e = this.dag.get(e.selectedParent);
    return e === f;
  }

  /** Chain block hash at chain height n on the selected chain of `from` (n <= from.chainHeight). */
  chainHashAt(from, n) {
    let e = from;
    if (n > e.chainHeight || n < 0) return null;
    if (this.chain[n] && this.chain[e.chainHeight] === e.hash) return this.chain[n];
    while (e.chainHeight > n) e = this.dag.get(e.selectedParent);
    return e.hash;
  }

  // ---------------------------------------------------------------- mergeset acceptance (section 5)

  /**
   * Accept the mergeset of a block (`pending`, not yet in the DAG) on the current state (which must be at SP).
   * Returns { view, receipts, accepted, skipped, gasUsed, receiptsRoot, acceptedTxRoot, systemReceipts, colours, paid }.
   * `paid` records the credits made outside transactions, for the explorer only (not part of consensus): `sub[i]` and
   * `ngo[i]` are the mining and NGO pool subsidies of mergesetBlues[i] (the miner gets sub minus the committee share),
   * `fees` the priority fees as [merged block, recipient (hex), amount], one entry per block and recipient.
   */
  async acceptMergeset(pending, gd, sp, baseFee) {
    const p = this.p;
    const view = this.state.view();
    const hd = pending.header;
    const pmt = this.pastMedianTime(sp);
    const ctxBase = {
      number: gd.chainHeight, timestamp: hd.timestamp, baseFee, prevRandao: sp.hashBytes, gasLimit: p.blockGasLimit,
      blockHash: (n) => { const x = this.chainHashAt(sp, n); return x ? this.dag.get(x).hashBytes : null; },
    };
    const blues = new Set(gd.mergesetBlues);
    const receipts = [], accepted = [], skipped = [], colours = {};
    let gasUsed = 0n;
    const credit = (addr, amount) => { if (amount > 0n) { const a = view.getAccount(addr); view.setAccount(addr, { balance: a.balance + amount }); } };
    let burned = 0n;
    const fees = new Map();
    for (const xh of gd.orderedMergeset) {
      const blue = blues.has(xh);
      colours[xh] = blue ? 'blue' : 'red';
      const x = this.dag.get(xh);
      if (!x.body?.txs) continue;
      for (const tx of x.body.txs) {
        const why = skipReason(view, tx, baseFee, p) ?? pauseSkip(view, tx, hd.timestamp) ?? (gasUsed + tx.gasLimit > p.mergesetGasLimit ? 'mergeset gas budget' : null);
        if (why) { skipped.push({ hash: tx.hash, block: xh, reason: why }); continue; }
        const scratch = view.view();
        const r = await runTx(scratch, tx, { ...ctxBase, coinbase: x.header.miner }, p);
        scratch.mergeIntoParent();
        gasUsed += r.gasUsed;
        burned += r.burned;
        const feeTo = blue ? x.header.miner : hd.miner;
        credit(feeTo, r.tip);
        if (r.tip > 0n) { const k = xh + bytesToHex(feeTo); fees.set(k, (fees.get(k) ?? 0n) + r.tip); }
        receipts.push({ ...r, txHash: tx.hash, block: xh, from: tx.from, to: tx.to, cumulativeGasUsed: gasUsed });
        accepted.push(tx.hash);
      }
    }
    // rewards for blue blocks (genesis is not mined)
    const g = view.getGlobal();
    let issuedMining = g.issuedMining, issuedNGO = g.issuedNGO;
    let committeeTotal = 0n, ngoTotal = 0n;
    const minedBy = new Map();
    const paid = { sub: [], ngo: [], fees: [...fees].map(([k, v]) => [k.slice(0, 64), k.slice(64), v]) };
    for (const xh of gd.mergesetBlues) {
      const x = this.dag.get(xh);
      if (x === this.dag.genesis) { paid.sub.push(0n); paid.ngo.push(0n); continue; }
      const m = poolSubsidy(x.blueScore, issuedMining, pmt, this.genesisTime, p);
      const n = poolSubsidy(x.blueScore, issuedNGO, pmt, this.genesisTime, p);
      issuedMining += m;
      issuedNGO += n;
      const c = m * p.committeeShareBps / 10_000n;
      committeeTotal += c;
      ngoTotal += n;
      paid.sub.push(m);
      paid.ngo.push(n);
      credit(x.header.miner, m - c);
      const mk = bytesToHex(x.header.miner);
      minedBy.set(mk, (minedBy.get(mk) ?? 0n) + 1n);
    }
    credit(ADDR.finalityCommittee, committeeTotal);
    credit(ADDR.ngoRewards, ngoTotal);
    view.setGlobal({ issuedMining, issuedNGO, burned: view.getGlobal().burned + burned });
    if (view.getGlobal().genesisSupply + issuedMining + issuedNGO > p.maxSupply) throw new Error('internal: maximum supply exceeded');
    // system calls (section 10)
    const sysCtx = { ...ctxBase, coinbase: hd.miner };
    const systemReceipts = [];
    const sys = async (label, to, data) => {
      const r = await contractCall(view, p, sysCtx, { caller: SYSTEM_ADDRESS, to, data });
      systemReceipts.push({ label, status: r.status, gasUsed: r.gasUsed, logs: r.logs, reason: r.reason || r.error || '' });
      return r;
    };
    for (const xh of gd.orderedMergeset) {
      const x = xh === pending.hash ? pending : this.dag.get(xh);
      for (const cert of x.body?.certs ?? []) {
        const signers = await this.verifyCert(cert, sp, view, sysCtx);
        // already recorded, or not a valid certificate for this block's view: ignored (the certificate is not a validity
        // condition of the block; only certificates that verify are recorded)
        if (!signers) continue;
        await sys('recordCheckpoint', ADDR.finalityCommittee, abi.call('recordCheckpoint(uint256,uint256,bytes32,address[])',
          ['uint256', 'uint256', 'uint256', 'address[]'], [BigInt(cert.epoch), BigInt(cert.number), bytesToBigint(cert.chainBlock), signers]));
      }
    }
    if (minedBy.size) {
      const miners = [...minedBy.keys()].map((k) => Uint8Array.from(Buffer.from(k, 'hex')));
      await sys('recordBlocks', ADDR.minerRegistry, abi.call('recordBlocks(address[],uint256[])', ['address[]', 'uint256[]'], [miners, [...minedBy.values()]]));
    }
    if (ngoTotal > 0n) await sys('ngoRewards.notify', ADDR.ngoRewards, abi.call('notify(uint256)', ['uint256'], [ngoTotal]));
    if (committeeTotal > 0n) await sys('finality.notify', ADDR.finalityCommittee, abi.call('notify(uint256)', ['uint256'], [committeeTotal]));
    await sys('ngoElection.advance', ADDR.ngoElection, abi.call('advance()'));
    // GovernanceMode remembers Normal mode and a dip below 60 NGOs (30-day grace)
    await sys('governanceMode.advance', ADDR.governanceMode, abi.call('advance()'));
    await sys('roleElection.advance', ADDR.roleElection, abi.call('advance()'));
    await sys('finality.advance', ADDR.finalityCommittee, abi.call('advance()'));
    // the handover check runs after the election, so the first block in which the 60th
    // NGO is elected also retires the dev council; then node updates in force, then due contract updates
    await sys('devCouncil.advance', ADDR.devCouncil, abi.call('advance()'));
    await sys('upgrades.advance', ADDR.upgradeRegistry, abi.call('advance()'));
    for (let i = 0; i < 4; i++) {
      const due = await contractCall(view, p, sysCtx, { to: ADDR.upgradeRegistry, data: abi.call('nextDue()'), commit: false });
      if (!due.status || due.returnValue.length < 160 || due.returnValue[31] !== 1) break;
      const w = (k) => due.returnValue.subarray(32 * k, 32 * k + 32);
      const id = bytesToBigint(w(1)), target = w(2).slice(12), impl = w(3).slice(12), codeHash = w(4);
      const code = view.getCode(impl);
      // the node itself never replaces the 12 % or the handover rule, whatever the registry says
      const ok = code.length > 0 && equals(keccak256(code), codeHash) && !neverReplaceable(target) && !equals(view.getAccount(target).codeHash, KECCAK_EMPTY);
      if (ok) {
        view.setCode(target, code);
        view.setAccount(target, { codeHash: keccak256(code) });
      }
      const r = await sys('upgrades.activated', ADDR.upgradeRegistry, abi.call('activated(uint256,bool)', ['uint256', 'bool'], [id, ok]));
      if (!r.status) break;
    }
    const receiptsRoot = merkleRoot([...systemReceipts.map((r) => encodeReceipt({ status: r.status, gasUsed: r.gasUsed, logs: r.logs })), ...receipts.map(encodeReceipt)]);
    const acceptedTxRoot = merkleRoot(accepted);
    return { view, receipts, accepted, skipped, gasUsed, receiptsRoot, acceptedTxRoot, systemReceipts, colours, paid };
  }

  // ---------------------------------------------------------------- finality certificates (section 9)

  /**
   * Who signs the checkpoint of chain block `cb`, and what a certificate needs, read in `view`:
   *   - a committee is sealed for it: its members; 15 signatures with the NGO signatures the epoch needs;
   *   - no committee was ever sealed (bootstrap, DAG_SPEC.md section 9.1): the dev miner addresses named in the
   *     genesis (FinalityCommittee.bootstrapSigners); any one of their signatures is enough; epoch BOOTSTRAP_EPOCH;
   *   - otherwise nobody (epoch -1).
   * The first seal empties bootstrapSigners() for good, so from then on only the committee rule applies.
   */
  async certSigners(view, ctx, cb) {
    const epoch = await this.signerEpoch(view, ctx, cb.header.timestamp, cb.chainHeight);
    if (epoch >= 0) return { epoch, members: new Set(await this.committeeMembers(view, ctx, epoch)), rule: { ...(await this.committeeNgoRule(view, ctx, epoch)), quorum: CERT_QUORUM } };
    const r = await contractCall(view, this.p, ctx, { to: ADDR.finalityCommittee, data: abi.call('bootstrapSigners()'), commit: false });
    const boot = r.status ? abi.decodeAddressArray(r.returnValue).map(bytesToHex) : [];
    if (boot.length) {
      // the quorum is a contract value (2 of 3 at launch), no longer a node constant of 1
      const q = await contractCall(view, this.p, ctx, { to: ADDR.finalityCommittee, data: abi.call('bootstrapQuorum()'), commit: false });
      const need = q.status ? bytesToBigint(q.returnValue) : 0n;
      const quorum = need >= 1n && need <= BigInt(boot.length) ? Number(need) : Infinity;
      return { epoch: BOOTSTRAP_EPOCH, members: new Set(boot), rule: { quorum, ngo: new Set(), ngoRequired: 0 } };
    }
    return { epoch: -1, members: new Set(), rule: { quorum: Infinity, ngo: new Set(), ngoRequired: Infinity } };
  }

  async committeeMembers(view, ctx, epoch) {
    const r = await contractCall(view, this.p, ctx, { to: ADDR.finalityCommittee, data: abi.call('activeMembers(uint256)', ['uint256'], [BigInt(epoch)]), commit: false });
    if (!r.status) return [];
    return abi.decodeAddressArray(r.returnValue).map(bytesToHex);
  }

  /** The NGO members of `epoch` and how many of them a certificate needs. */
  async committeeNgoRule(view, ctx, epoch) {
    const call = (sig) => contractCall(view, this.p, ctx, { to: ADDR.finalityCommittee, data: abi.call(sig, ['uint256'], [BigInt(epoch)]), commit: false });
    const m = await call('activeNgoMembers(uint256)');
    const q = await call('ngoSignaturesRequired(uint256)');
    if (!m.status || !q.status) return { ngo: new Set(), ngoRequired: Infinity };
    // a count; anything that is not a small integer means no certificate can meet it (M §3.1 range assertion)
    const need = bytesToBigint(q.returnValue);
    return { ngo: new Set(abi.decodeAddressArray(m.returnValue).map(bytesToHex)), ngoRequired: need > 1_000_000n ? Infinity : Number(need) };
  }

  /** The committee epoch that signs a checkpoint whose chain block has timestamp t and chain height h (-1 = none). */
  async signerEpoch(view, ctx, t, h) {
    const r = await contractCall(view, this.p, ctx, { to: ADDR.finalityCommittee, data: abi.call('signerEpoch(uint256,uint256)', ['uint256', 'uint256'], [BigInt(t), BigInt(h)]), commit: false });
    if (!r.status) return -1;
    const e = bytesToBigint(r.returnValue);
    return e > BigInt(Number.MAX_SAFE_INTEGER) ? -1 : Number(e); // exact as a Number, or none (M §3.1)
  }

  /**
   * Verify a certificate against the state `view` (at the accepting block's selected parent). Returns the signer
   * addresses (bytes) if it is a valid certificate for a checkpoint on `sp`'s selected chain that this view has not
   * recorded yet; null otherwise. A certificate that is malformed or wrong makes its block invalid (checked at intake).
   */
  async verifyCert(cert, sp, view, ctx) {
    const p = this.p;
    const height = cert.number * p.checkpointInterval;
    const hash = this.chainHashAt(sp, height);
    if (!hash || hash !== hx(cert.chainBlock)) return null;
    const cb = this.dag.get(hash);
    if (!equals(cb.stateRoot, cert.stateRoot)) return null;
    const rec = await contractCall(view, p, ctx, { to: ADDR.finalityCommittee, data: abi.call('checkpointRecorded(uint256)', ['uint256'], [BigInt(cert.number)]), commit: false });
    if (rec.status && bytesToBigint(rec.returnValue) !== 0n) return null;
    const { epoch, members, rule } = await this.certSigners(view, ctx, cb);
    if (epoch < 0 || epoch !== cert.epoch) return null;
    const digest = checkpointDigest(p.chainId, this.dag.genesis.header.timestamp, cert.number, cert.chainBlock, cert.stateRoot);
    const signers = new Map();
    for (const s of cert.sigs) {
      let a;
      try { a = bytesToHex(recoverSig65(digest, s)); } catch { return null; }
      if (members.has(a)) signers.set(a, true);
    }
    if (!certQuorum(signers.keys(), rule)) return null;
    return [...signers.keys()].map((k) => Uint8Array.from(Buffer.from(k, 'hex')));
  }

  /** A certificate gossiped or included: if valid against the current chain, mark the checkpoint final. */
  async noteFinal(cert) {
    return this.exclusive(async () => {
      if (cert.number <= this.finalCheckpoint.number) return false;
      const height = cert.number * this.p.checkpointInterval;
      if (height > this.tip.chainHeight || this.chain[height] !== hx(cert.chainBlock)) return false;
      const cb = this.dag.get(this.chain[height]);
      this.moveTo(this.tip.hash);
      const ctx = this.readContext();
      const view = this.state.view();
      const signers = await this.verifyCert(cert, this.tip, view, ctx);
      // verifyCert returns null if already recorded on-chain; accept that case too by checking membership directly
      let ok = !!signers;
      if (!ok) {
        const { epoch, members, rule } = await this.certSigners(view, ctx, cb);
        const digest = checkpointDigest(this.p.chainId, this.dag.genesis.header.timestamp, cert.number, cert.chainBlock, cert.stateRoot);
        const seen = new Set();
        for (const s of cert.sigs) { try { const a = bytesToHex(recoverSig65(digest, s)); if (members.has(a)) seen.add(a); } catch { /* skip */ } }
        ok = certQuorum(seen, rule) && equals(cb.stateRoot, cert.stateRoot) && epoch === cert.epoch;
      }
      if (!ok) return false;
      this.finalCheckpoint = { number: cert.number, hash: hx(cert.chainBlock) };
      this.certs.set(cert.number, cert);
      this.onEvent('final', { number: cert.number, hash: hx(cert.chainBlock) });
      return true;
    });
  }

  // ---------------------------------------------------------------- the virtual chain

  async _updateVirtual() {
    const parents = this.dag.virtualParents();
    let best = this.dag.get(parents[0]);
    // the virtual's selected parent: the tip with the largest (blueWork, hash) that keeps the final checkpoint and
    // does not reorganise deeper than the DAG finality depth
    const candidates = parents.map((x) => this.dag.get(x));
    best = null;
    for (const c of candidates) {
      if (!this._includesFinal(c)) continue;
      if (!this._withinFinalityDepth(c)) continue;
      if (!best || c.blueWork > best.blueWork || (c.blueWork === best.blueWork && bytesToHex(c.hashBytes) > bytesToHex(best.hashBytes))) best = c;
    }
    if (!best || best === this.tip) { this.moveTo(this.tip.hash); return; }
    const old = this.tip;
    this.moveTo(best.hash);
    // rebuild the chain index from the fork point
    let e = best;
    const added = [];
    while (this.chain[e.chainHeight] !== e.hash) { added.push(e); e = this.dag.get(e.selectedParent); }
    const fork = e.chainHeight;
    const removed = this.chain.slice(fork + 1);
    // transactions the old chain accepted and the new one does not: handed back to the mempool by the node, so a
    // reorganisation cannot silently drop them
    const wasAccepted = new Set(removed.flatMap((rh) => (this.dag.get(rh).accepted ?? []).map((t) => bytesToHex(t))));
    for (const a of added) for (const t of a.accepted ?? []) wasAccepted.delete(bytesToHex(t));
    const lost = [];
    if (wasAccepted.size) {
      for (const rh of removed) for (const x of [rh, ...(this.dag.get(rh).orderedMergeset ?? [])]) {
        for (const t of this.dag.get(x)?.body?.txs ?? []) if (wasAccepted.delete(bytesToHex(t.hash))) lost.push(t);
      }
    }
    for (const rh of removed) {
      const r = this.dag.get(rh);
      for (const t of r.accepted ?? []) this.txIndex.delete(bytesToHex(t));
      for (const x of r.orderedMergeset ?? []) if (this.acceptedBy.get(x)?.by === rh) this.acceptedBy.delete(x);
    }
    this.chain.length = fork + 1;
    for (const a of added.reverse()) {
      this.chain[a.chainHeight] = a.hash;
      (a.accepted ?? []).forEach((t, i) => this.txIndex.set(bytesToHex(t), { block: a.hash, index: i }));
      for (const x of a.orderedMergeset ?? []) this.acceptedBy.set(x, { by: a.hash, colour: a.mergesetReds?.includes(x) ? 'red' : 'blue' });
    }
    this.tip = best;
    this._pruneUndo();
    this.onEvent('tip', { tip: best, old, removed, added, lost });
  }

  /**
   * Blocks far below the DAG finality depth can never be reorganised or re-executed (_connect refuses a selected
   * parent below the finality depth): drop their undo/redo records and the GHOSTDAG working data
   * only new blocks within the merge depth need, and move their bulky data (raw bytes, transactions, receipts,
   * payments) to the cold store, read back on demand, so the heap does not grow with every block
   * for good (a full entry takes about 5.3 kB of heap, a cold one about 0.4 kB). Walks only the newly passed blue scores.
   */
  _pruneUndo() {
    const floor = this.tip.blueScore - this.p.finalityDepth - 2 * this.p.mergeDepth;
    if (floor <= 0 || this.tip.chainHeight % 100 !== 0 || floor <= this.prunedTo) return;
    for (const e of this.dag.blocksInBlueScoreRange(this.prunedTo, floor - 1)) {
      if (e === this.dag.genesis) continue;
      e.undo = null; e.redo = null;
      e.blueAnticone = null; e.orderedMergeset = null;
      if (this.cold && e.coldAt === undefined) this._freeze(e);
    }
    this.prunedTo = floor;
  }

  _freeze(e) {
    const rec = { header: e.header, stateRoot: e.stateRoot };
    for (const k of COLD_FIELDS) rec[k] = e[k];
    const at = this.cold.putCold(rec);
    // a smaller object takes the block's place: plain fields for what is read often, getters on the shared prototype
    // for the rest (no per-block closures; measured: a full entry held about 6.5 kB of heap, its header alone 2.2 kB)
    const h = e.header;
    let miner = this.minerBytes.get(bytesToHex(h.miner));
    if (!miner) { miner = h.miner; this.minerBytes.set(bytesToHex(h.miner), miner); }
    const c = new ColdBlock(this, at);
    for (const k of Object.keys(e)) if (!COLD_SKIP.has(k)) c[k] = e[k];
    c.header = new ColdHeader(c, h, miner);
    this.dag.blocks.set(e.hash, c);
  }

  _coldRecord(e) {
    let r = this.coldCache.get(e.hash);
    if (r) { this.coldCache.delete(e.hash); this.coldCache.set(e.hash, r); return r; }
    r = this.cold.getCold(e.coldAt);
    this.coldCache.set(e.hash, r);
    if (this.coldCache.size > 512) this.coldCache.delete(this.coldCache.keys().next().value);
    return r;
  }

  _withinFinalityDepth(c) {
    if (c.blueScore + 0 < this.tip.blueScore - this.p.finalityDepth) return false;
    // the fork point with the current chain must be within the finality depth
    let e = c;
    while (e.chainHeight > 0 && this.chain[e.chainHeight] !== e.hash) e = this.dag.get(e.selectedParent);
    return this.tip.blueScore - e.blueScore <= this.p.finalityDepth;
  }

  // ---------------------------------------------------------------- reads

  /** EVM context for reads at the chain tip (eth_call, templates). */
  readContext(extra = {}) {
    const t = this.tip;
    return {
      number: t.chainHeight + 1, timestamp: Math.max(this.now(), t.header.timestamp + 1), baseFee: nextBaseFee(t.baseFee, t.gasUsed, this.p),
      prevRandao: t.hashBytes, gasLimit: this.p.blockGasLimit, coinbase: new Uint8Array(20),
      blockHash: (n) => (this.chain[n] ? this.dag.get(this.chain[n]).hashBytes : null), ...extra,
    };
  }

  /** Run fn(view, ctx) on the tip state, serialised with block intake. */
  readAtTip(fn) {
    return this.exclusive(async () => {
      this.moveTo(this.tip.hash);
      return fn(this.state.view(), this.readContext());
    });
  }

  supply() {
    const g = this.state.getGlobal();
    return { genesisSupply: g.genesisSupply, issuedMining: g.issuedMining, issuedNGO: g.issuedNGO, burned: g.burned + this.state.getAccount(BURN_ADDRESS).balance };
  }
}

export { bigintToFixed, concat };
