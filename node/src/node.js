// The PSYROB full node: consensus, storage, peer-to-peer network, finality, JSON-RPC, explorer and pages.

import path from 'node:path';
import http from 'node:http';
import { loadGenesis } from './genesis.js';
import { Chain, BlockError } from './consensus.js';
import { parseTx } from './tx.js';
import { Mempool } from './mempool.js';
import { Store } from './store.js';
import { P2P } from './p2p.js';
import { decodeBlock } from './block.js';
import { Finality } from './finality.js';
import { Rpc } from './rpc.js';
import { PowPool } from './powpool.js';
import { startHttp } from './http.js';
import { selfTest } from '../../common/pow.js';
import { bytesToHex } from '../../common/bytes.js';
import { NODE_VERSION } from './params.js';

export class Node {
  /**
   * opts = { genesisFile, datadir, paramOverrides, p2pHost, p2pPort, seeds, advertise, httpHost, httpPort,
   *          signerKey (bytes|null), log, rpcRate }
   */
  constructor(opts) {
    this.opts = opts;
    this.log = opts.log ?? ((...a) => console.log(new Date().toISOString(), ...a));
    this.events = [];
  }

  async start() {
    const o = this.opts;
    selfTest(undefined, { maxMemoryKiB: 4096 });
    const g = await loadGenesis(o.genesisFile, o.paramOverrides ?? {});
    this.params = g.params;
    this.store = new Store(o.datadir);
    this.chain = new Chain(g.params, g, { cold: this.store, onEvent: (t, d) => this.onChainEvent(t, d) });
    this.mempool = new Mempool(g.params);
    this.log(`psyrob ${NODE_VERSION}: chain ${g.params.chainId}, genesis 0x${bytesToHex(g.hash)}`);
    // replay stored blocks (proof of work was checked before they were written)
    this.replaying = true;
    let raws = this.store.readBlocks();
    // blocks of another network (e.g. the chain before a genesis reset): the first stored block always builds on the
    // genesis alone, so if it does not build on this one, the old data is moved aside instead of replayed as orphans
    if (raws.length && !decodeBlock(raws[0]).header.parents.some((p) => bytesToHex(p) === bytesToHex(g.hash))) {
      const sub = this.store.archive();
      this.log(`the stored blocks belong to another genesis (another network); moved them to ${sub} and starting from genesis`);
      raws = [];
    }
    let ok = 0;
    // while the stored blocks are replayed (minutes on a long chain), a small stand-in server answers /health and pages
    // with the progress, so the node never looks dead and nobody restarts it or deletes its data
    this.startup = { replayed: 0, of: raws.length, since: Date.now() };
    const standIn = o.httpPort === null || !raws.length ? null : await startingServer(this, g, o).catch(() => null);
    for (const raw of raws) {
      try { const r = await this.chain.addBlock(raw, { trusted: true }); if (r.status === 'added') ok++; } catch (e) { this.log('stored block rejected: ' + e.message); }
      this.startup.replayed++;
      if (this.startup.replayed % 100 === 0) await new Promise((r) => setImmediate(r));
    }
    if (standIn) await new Promise((r) => { standIn.closeAllConnections?.(); standIn.close(r); });
    this.startup = null;
    for (const c of this.store.readJson('certs.json', [])) {
      try { await this.chain.noteFinal(decodeCertJson(c)); } catch { /* ignore */ }
    }
    this.replaying = false;
    this.log(`replayed ${ok}/${raws.length} blocks; chain height ${this.chain.tip.chainHeight}, blue score ${this.chain.tip.blueScore}`);
    this.p2p = new P2P({
      params: g.params, chain: this.chain, mempool: this.mempool, genesisHash: g.hash, listenHost: o.p2pHost, listenPort: o.p2pPort,
      seeds: o.seeds ?? [], store: this.store, advertise: o.advertise, log: (m) => this.log(m), delayMs: o.p2pDelayMs ?? 0, banLocal: o.banLocal ?? true,
      rawBlock: (h) => this.chain.dag.get(h)?.raw ?? null,
      onBlock: (raw, peer) => this.receiveBlock(raw, peer),
      onTx: (raw, peer) => this.receiveTx(raw, peer),
      onCert: (cert, peer) => this.finality.addCert(cert, peer),
      onSig: (items, peer) => this.finality.onSig(items, peer),
    });
    this.powPool = o.powWorker === false ? null : new PowPool({ pow: g.params.pow, log: (m) => this.log(m) });
    this.finality = new Finality({ chain: this.chain, p2p: this.p2p, store: this.store, mempool: this.mempool, signerKey: o.signerKey ?? null, signerKeys: o.signerKeys ?? null, log: (m) => this.log(m) });
    this.rpc = new Rpc({ chain: this.chain, mempool: this.mempool, p2p: this.p2p, finality: this.finality, node: this });
    if (o.p2pPort !== null) await this.p2p.start();
    this.http = await startHttp({ node: this, host: o.httpHost ?? '127.0.0.1', port: o.httpPort ?? 8770, rate: o.rpcRate });
    this.log(`P2P on ${o.p2pHost ?? '0.0.0.0'}:${o.p2pPort}, HTTP/RPC and explorer on http://${o.httpHost ?? '127.0.0.1'}:${o.httpPort ?? 8770}`);
    return this;
  }

  onChainEvent(type, d) {
    if (type === 'upgradeRequired') this.log(`UPGRADE REQUIRED: an approved node update is in force; this network now needs node ${d.version} or newer. This node (${NODE_VERSION}) stops following the chain until it is updated.`);
    if (type === 'systemCallFailed') {
      this.systemCallFailures = (this.systemCallFailures ?? 0) + 1;
      if (!this.replaying) this.log(`system call ${d.label} reverted in block ${d.hash} (chain height ${d.chainHeight}, gas ${d.gasUsed}): ${d.reason || 'no reason'}`);
    }
    if (type === 'block' && !this.replaying) {
      this.store.appendBlock(d.raw);
      this.p2p?.announce(1, d.hash);
    }
    if (type === 'tip' && !this.replaying) {
      const lost = d.lost ?? [];
      this.chain.readAtTip((view, ctx) => {
        this.mempool.prune(view, ctx.timestamp);
        // transactions a reorganisation dropped from the chain go back into the pool, checked against the new tip
        // like any new transaction
        for (const t of lost) { try { this.mempool.add(t.raw, view, ctx.baseFee, ctx.timestamp); } catch { /* now invalid: dropped */ } }
      }).catch(() => {});
      if (lost.length) this.log(`reorganisation: ${lost.length} transaction(s) returned to the mempool`);
      this.finality?.onTip().catch((e) => this.log('finality: ' + e.message));
      this.http?.notify?.('tip', d.tip);
    }
    if (type === 'final') {
      const cert = this.chain.certs.get(d.number);
      if (cert && !this.replaying) {
        const all = [...this.chain.certs.values()].slice(-200).map(encodeCertJson);
        this.store.writeJson('certs.json', all);
      }
    }
  }

  async receiveBlock(raw, peer) {
    try {
      // the 32 MiB proof of work is checked in a worker thread before the block goes in, so the main thread keeps
      // answering while a sync batch is checked . Known and malformed blocks go straight to addBlock.
      let powChecked = false;
      if (this.powPool) {
        let b = null;
        try { b = decodeBlock(raw); } catch { /* addBlock reports it */ }
        if (b && !this.chain.dag.has(bytesToHex(b.hash))) {
          if (!(await this.powPool.check(b.headerRaw, b.header.target))) throw new BlockError('proof of work above target', { ban: 100 });
          powChecked = true;
        }
      }
      return await this.chain.addBlock(raw, { source: peer?.id, powChecked });
    } catch (e) {
      if (e instanceof BlockError) { if (e.ban) peer?.misbehave(e.ban, 'invalid block: ' + e.message); else this.log('block refused: ' + e.message); return null; }
      throw e;
    }
  }

  async submitBlock(raw, { powChecked = false } = {}) {
    const r = await this.chain.addBlock(raw, { powChecked });
    this.log(`mined block 0x${r.hash.slice(0, 16)} (${r.status}); chain height ${this.chain.tip.chainHeight}`);
    return r;
  }

  async receiveTx(raw, peer) {
    try {
      // signature and shape are checked before the chain lock is taken; only the state check needs it
      const tx = parseTx(raw, this.params);
      const relay = await this.chain.readAtTip((view, ctx) => this.mempool.relayAfterAdd(tx, view, ctx.baseFee, ctx.timestamp));
      for (const t of relay) this.p2p.announce(2, bytesToHex(t.hash), peer);
    } catch { /* not admitted */ }
  }

  async stop() {
    this.powPool?.close();
    this.p2p?.stop();
    this.http?.closeAllConnections?.();
    await new Promise((r) => (this.http ? this.http.close(r) : r()));
    this.store?.close();
  }
}

/** The stand-in HTTP server during replay: /health as JSON with "starting": true and the progress, everything else a
 *  short page that says the node is starting. Closed before the real server takes the port. */
export function startingServer(node, g, o) {
  const genesis = '0x' + bytesToHex(g.hash);
  const server = http.createServer((req, res) => {
    const s = node.startup ?? { replayed: 0, of: 0 };
    const body = { ok: false, starting: true, version: NODE_VERSION, chainId: Number(g.params.chainId), genesis, replayed: s.replayed, of: s.of };
    if ((req.url ?? '').startsWith('/health')) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '30', 'Access-Control-Allow-Origin': '*' }).end(JSON.stringify(body));
    } else if (req.method === 'POST') {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '30', 'Access-Control-Allow-Origin': '*' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32005, message: `the node is starting: ${s.replayed} of ${s.of} stored blocks loaded; try again shortly` } }));
    } else {
      const pct = s.of ? Math.floor((100 * s.replayed) / s.of) : 100;
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '30', 'Refresh': '30' })
        .end(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PSYROB node starting</title><body style="font:16px system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem"><h1>The node is starting</h1><p>It is loading the blocks it has stored: ${s.replayed.toLocaleString('en-US')} of ${s.of.toLocaleString('en-US')} (${pct} %). This page reloads by itself every 30 seconds.</p><p>Please do not restart the node or delete its data: it is working.</p></body>`);
    }
  });
  server.requestTimeout = 10_000;
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(o.httpPort ?? 8770, o.httpHost ?? '127.0.0.1', () => resolve(server)); });
}

function encodeCertJson(c) {
  return { number: c.number, chainBlock: bytesToHex(c.chainBlock), stateRoot: bytesToHex(c.stateRoot), epoch: c.epoch, sigs: c.sigs.map(bytesToHex) };
}
function decodeCertJson(j) {
  const b = (h) => Uint8Array.from(Buffer.from(h, 'hex'));
  return { number: j.number, chainBlock: b(j.chainBlock), stateRoot: b(j.stateRoot), epoch: j.epoch, sigs: j.sigs.map(b) };
}

export { path };
