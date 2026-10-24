// JSON-RPC (DAG_SPEC.md section 14). Ethereum methods as wallets and tools need them, with Ethereum block numbers =
// chain heights (block n is the chain block at height n; its transactions are the ones it accepted), and PSYROB
// methods for the DAG, mining, peers and finality.

import { bytesToHex, fromHex, toQuantity, parseQuantity, equals } from '../../common/bytes.js';
import { signingBytes, minerSigner, encodeHeader } from '../../common/header.js';
import { checkPow } from '../../common/pow.js';
import * as abi from '../../common/abi.js';
import { simulate, CallError, contractCall } from './evm.js';
import { nextBaseFee } from './consensus.js';
import { buildTemplate, templateJson, solvedBlock } from './template.js';
import { NODE_VERSION, ADDR } from './params.js';
import { effectiveGasPrice, parseTx } from './tx.js';
import { chainMetrics } from './metrics.js';

/** Solutions accepted per block template. */
const SUBMITS_PER_TEMPLATE = 4;
/** psy_metrics windows in chain blocks: an hour, a day, a week. Others are rounded to the nearest. */
export const METRICS_WINDOWS = [360, 8640, 60480];
export function metricsWindow(w) {
  const n = Number(w ?? 8640) || 8640;
  return METRICS_WINDOWS.reduce((best, x) => (Math.abs(x - n) < Math.abs(best - n) ? x : best), METRICS_WINDOWS[0]);
}

/** A token bucket shared by every client: the proof-of-work checks psy_submitBlock may run. */
class Bucket {
  constructor(burst, perSec) { this.burst = burst; this.perSec = perSec; this.tokens = burst; this.at = Date.now(); }
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.at) / 1000) * this.perSec);
    this.at = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const ZERO32 = '0x' + '00'.repeat(32);
const BLOOM = '0x' + '00'.repeat(256);
const h0x = (b) => '0x' + bytesToHex(b);
const addrHex = (b) => (b && b.length ? '0x' + bytesToHex(b) : null);

export class RpcError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}

function parseAddr(s) {
  if (typeof s !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(s)) throw new RpcError(-32602, 'invalid address');
  return fromHex(s);
}
function parseData(s) {
  if (s === undefined || s === null) return new Uint8Array(0);
  if (typeof s !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(s)) throw new RpcError(-32602, 'invalid data');
  return fromHex(s);
}

export class Rpc {
  constructor({ chain, mempool, p2p, finality, node }) {
    this.chain = chain;
    this.mempool = mempool;
    this.p2p = p2p;
    this.finality = finality;
    this.node = node;
    this.powBudget = new Bucket(8, 4); // 32 MiB Argon2d checks for submitted blocks, all clients together
    // miners that had a block added through this node in the last day check against a budget of
    // their own, so other clients spending the shared one cannot lock them out; and no one miner address may use more
    // than its share of either budget
    this.powKnown = new Bucket(8, 4);
    this.knownMiners = new Map(); // miner hex -> unix seconds of its last block added through psy_submitBlock
    this.powPerMiner = new Map(); // miner hex -> Bucket(4, 1), least recently used first
    this.templates = new Map(); // id -> template (last 32)
  }

  async handle(method, params = []) {
    const fn = this.methods[method];
    if (!fn) throw new RpcError(-32601, 'method not found: ' + method);
    return fn.call(this, ...(Array.isArray(params) ? params : [params]));
  }

  // ---------------------------------------------------------------- helpers

  chainBlock(tag) {
    const c = this.chain;
    if (tag === undefined || tag === 'latest' || tag === 'pending' || tag === 'safe') return c.tip;
    if (tag === 'finalized') return c.dag.get(c.finalCheckpoint.hash) ?? c.dag.genesis;
    if (tag === 'earliest') return c.dag.genesis;
    const n = Number(parseQuantity(tag, 64));
    const h = c.chain[n];
    return h ? c.dag.get(h) : null;
  }

  requireLatest(tag) {
    if (tag === undefined || tag === 'latest' || tag === 'pending' || tag === 'safe' || tag === 'finalized') return;
    const b = this.chainBlock(tag);
    if (b && b === this.chain.tip) return;
    if (typeof tag === 'object') return; // EIP-1898 objects: answered at the tip
    throw new RpcError(-32000, 'historical state is not available; only the latest state is kept');
  }

  txLocation(hashHex) {
    const loc = this.chain.txIndex.get(hashHex);
    if (!loc) return null;
    const cb = this.chain.dag.get(loc.block);
    const receipt = cb.receipts[loc.index];
    const xb = this.chain.dag.get(receipt.block);
    const tx = xb.body.txs.find((t) => bytesToHex(t.hash) === hashHex);
    return { cb, receipt, tx, index: loc.index, containing: xb };
  }

  txJson(tx, loc = null) {
    const o = {
      hash: h0x(tx.hash), nonce: toQuantity(tx.nonce), from: h0x(tx.from), to: addrHex(tx.to), value: toQuantity(tx.value), gas: toQuantity(tx.gasLimit),
      input: h0x(tx.data), type: toQuantity(tx.type), chainId: toQuantity(this.chain.p.chainId), v: toQuantity(tx.v), r: toQuantity(tx.r), s: toQuantity(tx.s),
      blockHash: loc ? '0x' + loc.cb.hash : null, blockNumber: loc ? toQuantity(loc.cb.chainHeight) : null, transactionIndex: loc ? toQuantity(loc.index) : null,
    };
    if (tx.type === 2) { o.maxFeePerGas = toQuantity(tx.maxFee); o.maxPriorityFeePerGas = toQuantity(tx.maxPriorityFee); o.accessList = []; o.yParity = toQuantity(tx.v); o.gasPrice = toQuantity(loc ? effectiveGasPrice(tx, loc.cb.baseFee) : tx.maxFee); } else o.gasPrice = toQuantity(tx.gasPrice);
    if (loc) o.dagBlock = '0x' + loc.containing.hash;
    return o;
  }

  logsOf(cb, receipt, index, logIndexStart) {
    return receipt.logs.map((l, i) => ({
      address: addrHex(l.address), topics: l.topics.map(h0x), data: h0x(l.data), blockNumber: toQuantity(cb.chainHeight), blockHash: '0x' + cb.hash,
      transactionHash: h0x(receipt.txHash), transactionIndex: toQuantity(index), logIndex: toQuantity(logIndexStart + i), removed: false,
    }));
  }

  receiptJson(loc) {
    const { cb, receipt: r, tx, index } = loc;
    let logStart = 0;
    for (let i = 0; i < index; i++) logStart += cb.receipts[i].logs.length;
    return {
      transactionHash: h0x(tx.hash), transactionIndex: toQuantity(index), blockHash: '0x' + cb.hash, blockNumber: toQuantity(cb.chainHeight),
      from: h0x(tx.from), to: addrHex(tx.to), cumulativeGasUsed: toQuantity(r.cumulativeGasUsed), gasUsed: toQuantity(r.gasUsed),
      effectiveGasPrice: toQuantity(r.effectiveGasPrice), contractAddress: addrHex(r.contractAddress), logs: this.logsOf(cb, r, index, logStart),
      logsBloom: BLOOM, status: toQuantity(r.status), type: toQuantity(tx.type), dagBlock: '0x' + r.block,
    };
  }

  blockJson(cb, full) {
    const hd = cb.header;
    const txs = (cb.accepted ?? []).map((h, i) => (full ? this.txJson(this.txLocation(bytesToHex(h)).tx, { cb, index: i, containing: this.chain.dag.get(cb.receipts[i].block) }) : h0x(h)));
    return {
      number: toQuantity(cb.chainHeight), hash: '0x' + cb.hash, parentHash: cb.selectedParent ? '0x' + cb.selectedParent : ZERO32, nonce: '0x' + hd.nonce.toString(16).padStart(16, '0'),
      sha3Uncles: '0x1dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d49347', logsBloom: BLOOM, transactionsRoot: h0x(hd.acceptedTxRoot),
      stateRoot: h0x(cb.stateRoot), receiptsRoot: h0x(hd.receiptsRoot), miner: h0x(hd.miner), difficulty: '0x0', totalDifficulty: '0x' + cb.blueWork.toString(16),
      extraData: h0x(hd.extra), size: '0x0', gasLimit: toQuantity(hd.gasLimit), gasUsed: toQuantity(cb.gasUsed ?? 0n), timestamp: toQuantity(hd.timestamp),
      baseFeePerGas: toQuantity(cb.baseFee), mixHash: ZERO32, uncles: [], transactions: txs,
      blueScore: toQuantity(cb.blueScore), dagParents: cb.parents.map((p) => '0x' + p), mergesetBlues: (cb.mergesetBlues ?? []).map((x) => '0x' + x), mergesetReds: (cb.mergesetReds ?? []).map((x) => '0x' + x),
    };
  }

  async readCall(call, { forEstimate = false } = {}) {
    const c = this.chain;
    return c.readAtTip(async (view, ctx) => {
      try {
        return await simulate(view, c.p, ctx, call.forEstimate === undefined ? { ...call, forEstimate } : call, { deadlineMs: 1000 });
      } catch (e) {
        if (e instanceof CallError) throw new RpcError(e.revert ? 3 : -32000, e.message, e.data ? h0x(e.data) : undefined);
        throw e;
      }
    });
  }

  parseCall(o) {
    if (!o || typeof o !== 'object') throw new RpcError(-32602, 'call object expected');
    return {
      from: o.from ? parseAddr(o.from) : null, to: o.to ? parseAddr(o.to) : new Uint8Array(0), data: parseData(o.data ?? o.input),
      value: o.value ? parseQuantity(o.value) : 0n, gas: o.gas ? parseQuantity(o.gas, 64) : this.chain.p.blockGasLimit,
    };
  }

  /** Read-only call of a system contract at the tip (explorer and pages). */
  async view(to, sig, types = [], values = []) {
    return this.chain.readAtTip(async (view, ctx) => contractCall(view, this.chain.p, ctx, { to, data: abi.call(sig, types, values), commit: false }));
  }

  /** The chain block that accepted e (merged it) and the colour it gave e; null while no chain block merged it. */
  mergedBy(e) {
    const m = this.chain.acceptedBy.get(e.hash);
    return m ? { by: this.chain.dag.get(m.by), colour: m.colour } : null;
  }

  dagBlockJson(e) {
    const c = this.chain;
    const m = this.mergedBy(e);
    return {
      hash: '0x' + e.hash, parents: e.parents.map((p) => '0x' + p), children: [...e.children].map((x) => '0x' + x), selectedParent: e.selectedParent ? '0x' + e.selectedParent : null,
      blueScore: e.blueScore, blueWork: '0x' + e.blueWork.toString(16), chainHeight: e.chainHeight, isChainBlock: c.chain[e.chainHeight] === e.hash,
      colour: e === c.dag.genesis ? 'blue' : m ? m.colour : 'not merged yet', mergedBy: m ? '0x' + m.by.hash : null,
      timestamp: e.header.timestamp, miner: h0x(e.header.miner),
      mergesetBlues: (e.mergesetBlues ?? []).map((x) => '0x' + x), mergesetReds: (e.mergesetReds ?? []).map((x) => '0x' + x), txCount: e.body?.txs?.length ?? 0,
      accepted: (e.accepted ?? []).length, skipped: (e.skipped ?? []).map((s) => ({ hash: h0x(s.hash), reason: s.reason })),
    };
  }

  // ---------------------------------------------------------------- methods

  methods = {
    web3_clientVersion() { return `psyrob/${NODE_VERSION}`; },
    net_version() { return this.chain.p.chainId.toString(); },
    net_listening() { return true; },
    net_peerCount() { return toQuantity(this.p2p ? [...this.p2p.peers].filter((p) => p.ready).length : 0); },
    eth_chainId() { return toQuantity(this.chain.p.chainId); },
    eth_syncing() {
      const s = this.p2p?.syncing?.();
      return s ? { startingBlock: '0x0', currentBlock: toQuantity(s.blueScore), highestBlock: toQuantity(s.target) } : false;
    },
    eth_mining() { return false; },
    eth_hashrate() { return '0x0'; },
    eth_accounts() { return []; },
    eth_blockNumber() { return toQuantity(this.chain.tip.chainHeight); },
    eth_gasPrice() { const t = this.chain.tip; return toQuantity(nextBaseFee(t.baseFee, t.gasUsed, this.chain.p) + 100_000_000n); },
    eth_maxPriorityFeePerGas() { return toQuantity(100_000_000n); },
    eth_feeHistory(count, newest) {
      const n = Math.min(Number(typeof count === 'string' ? parseQuantity(count, 16) : count) || 1, 1024);
      const last = this.chainBlock(newest) ?? this.chain.tip;
      const base = [], ratios = [];
      for (let h = Math.max(0, last.chainHeight - n + 1); h <= last.chainHeight; h++) {
        const b = this.chain.dag.get(this.chain.chain[h]);
        base.push(toQuantity(b.baseFee));
        ratios.push(Number(b.gasUsed ?? 0n) / Number(this.chain.p.mergesetGasLimit));
      }
      base.push(toQuantity(nextBaseFee(last.baseFee, last.gasUsed, this.chain.p)));
      return { oldestBlock: toQuantity(Math.max(0, last.chainHeight - n + 1)), baseFeePerGas: base, gasUsedRatio: ratios, reward: [] };
    },
    async eth_getBalance(a, tag) { this.requireLatest(tag); const ad = parseAddr(a); return this.chain.readAtTip((v) => toQuantity(v.getAccount(ad).balance)); },
    async eth_getTransactionCount(a, tag) {
      const ad = parseAddr(a);
      const n = await this.chain.readAtTip((v) => v.getAccount(ad).nonce);
      if (tag === 'pending') { let m = n; const pend = this.mempool.pendingOf(bytesToHex(ad)); while (pend.some((t) => t.nonce === m)) m++; return toQuantity(m); }
      this.requireLatest(tag);
      return toQuantity(n);
    },
    async eth_getCode(a, tag) { this.requireLatest(tag); const ad = parseAddr(a); return this.chain.readAtTip((v) => h0x(v.getCode(ad))); },
    async eth_getStorageAt(a, slot, tag) {
      this.requireLatest(tag);
      const ad = parseAddr(a);
      const s = parseQuantity(slot);
      const key = fromHex('0x' + s.toString(16).padStart(64, '0'));
      return this.chain.readAtTip((v) => '0x' + v.getStorage(ad, key).toString(16).padStart(64, '0'));
    },
    async eth_call(o, tag) { this.requireLatest(tag); const r = await this.readCall(this.parseCall(o)); return h0x(r.returnValue); },
    async eth_estimateGas(o) { const r = await this.readCall({ ...this.parseCall(o), forEstimate: true }); return toQuantity(r.gasUsed); },
    async eth_sendRawTransaction(raw) {
      const bytes = parseData(raw);
      let tx;
      // signature and shape outside the chain lock
      try { tx = parseTx(bytes, this.chain.p); } catch (e) { throw new RpcError(-32000, e.message); }
      const relay = await this.chain.readAtTip((view, ctx) => {
        try { return this.mempool.relayAfterAdd(tx, view, ctx.baseFee, ctx.timestamp); } catch (e) { throw new RpcError(-32000, e.message); }
      });
      // only executable transactions are relayed; one waiting behind a nonce gap stays here until the gap is filled
      for (const t of relay) this.p2p?.announce(2, bytesToHex(t.hash));
      return h0x(tx.hash);
    },
    eth_getTransactionByHash(h) {
      const hx = parseData(h);
      const loc = this.txLocation(bytesToHex(hx));
      if (loc) return this.txJson(loc.tx, loc);
      const t = this.mempool.get(bytesToHex(hx));
      return t ? this.txJson(t) : null;
    },
    eth_getTransactionReceipt(h) {
      const loc = this.txLocation(bytesToHex(parseData(h)));
      return loc ? this.receiptJson(loc) : null;
    },
    eth_getBlockByNumber(tag, full) { const b = this.chainBlock(tag); return b ? this.blockJson(b, !!full) : null; },
    eth_getBlockByHash(h, full) {
      const e = this.chain.dag.get(bytesToHex(parseData(h)));
      if (!e) return null;
      return this.blockJson(e, !!full && this.chain.chain[e.chainHeight] === e.hash);
    },
    eth_getBlockTransactionCountByNumber(tag) { const b = this.chainBlock(tag); return b ? toQuantity((b.accepted ?? []).length) : null; },
    eth_getLogs(f = {}) {
      const c = this.chain;
      let from, to;
      if (f.blockHash) { const e = c.dag.get(bytesToHex(parseData(f.blockHash))); if (!e) return []; from = to = e.chainHeight; } else {
        from = (this.chainBlock(f.fromBlock ?? 'latest') ?? c.tip).chainHeight;
        to = (this.chainBlock(f.toBlock ?? 'latest') ?? c.tip).chainHeight;
      }
      if (to - from > 10_000) throw new RpcError(-32005, 'block range too large (max 10,000)');
      // bounded filter sizes (docs/RPC-LIMITS.md): each log is checked against every listed address and topic
      const addrList = f.address ? (Array.isArray(f.address) ? f.address : [f.address]) : null;
      if (addrList && addrList.length > 100) throw new RpcError(-32602, 'at most 100 addresses');
      if (!Array.isArray(f.topics ?? []) || (f.topics ?? []).length > 4) throw new RpcError(-32602, 'at most 4 topic positions');
      const addrs = addrList ? new Set(addrList.map((a) => bytesToHex(parseAddr(a)))) : null;
      const topics = (f.topics ?? []).map((t) => {
        if (t === null) return null;
        const alts = Array.isArray(t) ? t : [t];
        if (alts.length > 100) throw new RpcError(-32602, 'at most 100 alternatives per topic');
        return alts.map((x) => String(x).toLowerCase());
      });
      const out = [];
      for (let hgt = from; hgt <= to; hgt++) {
        const cb = c.dag.get(c.chain[hgt]);
        if (!cb?.receipts) continue;
        let li = 0;
        cb.receipts.forEach((r, i) => {
          for (const l of this.logsOf(cb, r, i, li)) {
            if (addrs && !addrs.has(l.address.slice(2))) continue;
            if (topics.some((t, k) => t && !t.includes(l.topics[k]))) continue;
            out.push(l);
          }
          li += r.logs.length;
        });
        if (out.length > 10_000) throw new RpcError(-32005, 'too many logs; narrow the range');
      }
      return out;
    },

    // ---- PSYROB ----
    psy_dagInfo() {
      const c = this.chain;
      return {
        chainId: toQuantity(c.p.chainId), genesis: h0x(c.genesisHash), tip: '0x' + c.tip.hash, chainHeight: c.tip.chainHeight, blueScore: c.tip.blueScore,
        blueWork: '0x' + c.tip.blueWork.toString(16), tips: [...c.dag.tips].map((t) => '0x' + t), blocks: c.dag.blocks.size, orphans: c.orphans.size,
        k: c.p.k, targetSpacing: c.p.targetSpacing, finalCheckpoint: c.finalCheckpoint, pastMedianTime: c.pastMedianTime(c.tip), mempool: this.mempool.size,
      };
    },
    psy_getDagBlock(h) {
      const e = this.chain.dag.get(bytesToHex(parseData(h)));
      if (!e) return null;
      return this.dagBlockJson(e);
    },
    /** DAG blocks with blue score in [from, to] (at most 500), all of them, chain or parallel. */
    psy_getDagRange(from, to) {
      // blue scores as decimal or 0x quantities; anything else (Infinity, fractions, > 2^53) is refused
      const num = (x, name) => {
        const n = typeof x === 'number' ? x : /^(0x[0-9a-f]+|[0-9]+)$/i.test(String(x ?? '')) ? Number(x) : NaN;
        if (!Number.isSafeInteger(n) || n < 0) throw new RpcError(-32602, `${name} must be a non-negative integer blue score`);
        return n;
      };
      const lo = num(from, 'from'), hi = Math.min(num(to, 'to'), lo + 500);
      if (hi < lo) return [];
      const out = [];
      // the blue-score index touches only the range, not every block in memory
      for (const e of this.chain.dag.blocksInBlueScoreRange(lo, hi)) { out.push(this.dagBlockJson(e)); if (out.length >= 2_000) break; }
      return out.sort((a, b) => a.blueScore - b.blueScore || (a.hash < b.hash ? -1 : 1));
    },
    psy_tips() { return [...this.chain.dag.tips].map((t) => '0x' + t); },
    async psy_getBlockTemplate(minerAddr) {
      const miner = parseAddr(minerAddr);
      const sync = this.p2p?.syncing?.();
      if (sync) throw new RpcError(-32005, `the node is still syncing (blue score ${sync.blueScore} of about ${sync.target}); mining starts when it has caught up`);
      // the same template for the same miner and the same DAG tips for 3 seconds
      const key = minerAddr.toLowerCase() + [...this.chain.dag.tips].sort().join('') + this.mempool.size;
      if (this.lastTemplate?.key === key && Date.now() - this.lastTemplate.at < 3000) return this.lastTemplate.json;
      const certs = (await this.finality?.certsForTemplate()) ?? [];
      const t = await buildTemplate(this.chain, this.mempool, miner, { certs });
      this.templates.set(t.id, t);
      // many public miners share the public node: keep enough outstanding templates (each is small)
      if (this.templates.size > 512) this.templates.delete(this.templates.keys().next().value);
      const json = templateJson(t, this.chain.p);
      if (this.templates.size) this.lastTemplate = { key, at: Date.now(), json };
      return json;
    },
    async psy_submitBlock(id, nonceHex, sigHex) {
      const t = this.templates.get(id);
      if (!t) throw new RpcError(-32000, 'unknown or expired template');
      const nonce = parseQuantity(nonceHex, 64);
      const sig = parseData(sigHex);
      if (sig.length !== 65) throw new RpcError(-32602, 'signature must be 65 bytes');
      // each template takes at most SUBMITS_PER_TEMPLATE solutions and is dropped once one is added; all
      // clients together share a proof-of-work budget; the 32 MiB Argon2d check runs before the chain lock is taken
      t.submissions = (t.submissions ?? 0) + 1;
      if (t.submissions > SUBMITS_PER_TEMPLATE) throw new RpcError(-32000, 'too many submissions for this template; get a new one');
      const who = bytesToHex(t.header.miner), now = Math.floor(Date.now() / 1000);
      let mine = this.powPerMiner.get(who);
      if (mine) this.powPerMiner.delete(who); else mine = new Bucket(4, 1);
      this.powPerMiner.set(who, mine);
      if (this.powPerMiner.size > 1024) this.powPerMiner.delete(this.powPerMiner.keys().next().value);
      if (!mine.take()) throw new RpcError(-32005, 'too many submissions from this miner address; try again in a second');
      const known = (this.knownMiners.get(who) ?? 0) > now - 86_400;
      if (!(known ? this.powKnown : this.powBudget).take()) throw new RpcError(-32005, 'the node is busy checking blocks; try again shortly');
      const header = { ...t.header, nonce, minerSig: sig };
      if (!minerSigner(header) || !equals(minerSigner(header), header.miner)) throw new RpcError(-32000, 'miner signature does not match the miner address');
      if (!checkPow(encodeHeader(header), header.target, this.chain.p.pow, this.chain.powImpl)) throw new RpcError(-32000, 'proof of work above target');
      const raw = solvedBlock(t, nonce, sig);
      const r = await this.node.submitBlock(raw, { powChecked: true });
      if (r.status === 'added' || r.status === 'known') this.templates.delete(id);
      if (r.status === 'added') {
        this.knownMiners.delete(who);
        this.knownMiners.set(who, now);
        if (this.knownMiners.size > 4096) this.knownMiners.delete(this.knownMiners.keys().next().value);
      }
      return { status: r.status, hash: '0x' + r.hash };
    },
    psy_peers() { return this.p2p ? this.p2p.info() : []; },
    psy_addrman() { return this.p2p ? { known: this.p2p.addrman.size, tried: this.p2p.addrman.triedTable.size, new: this.p2p.addrman.newTable.size } : null; },
    psy_finality() { return this.finality?.status() ?? null; },
    psy_fundSignatures(id) { return this.finality?.fundSignatures(Number(id)) ?? []; },
    psy_supply() {
      const s = this.chain.supply();
      return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, toQuantity(v)]));
    },
    /** Mining and holdings concentration (blue blocks per miner over `window` chain blocks, default one day). */
    // three fixed windows (an hour, a day, a week of chain blocks), each cached per tip
    psy_metrics(window) { return chainMetrics(this.chain, metricsWindow(window)); },
    async psy_mode() { const r = await this.view(ADDR.governanceMode, 'mode()'); return ['bootstrap', 'normal', 'interim'][Number(abi.decodeWord('uint256', r.returnValue))]; },
  };
}

export { signingBytes };
