// The PSYROB miner (separate from the node). It asks a node for block templates over JSON-RPC, searches nonces in
// worker threads (Argon2d, 32 MiB per attempt on the public networks), signs every attempt with the miner wallet, and
// submits solutions. The node never sees the key; the miner never sees anyone else's.
//
// //   - every template is checked before any thread signs it: re-encoded from its fields it must equal the node's
//     signingBytes, name this wallet as the miner, and carry the network's proof-of-work settings; a wrong or malicious
//     node cannot make the miner sign anything else;
//   - the threads keep hashing while a solution is submitted, and a new template is asked for at once;
//   - a submission that fails for a passing reason (connection error, node busy, HTTP 429/5xx, a web page instead of
//     JSON) is retried with back-off for up to 30 s; a found block stays valid while the node keeps its template;
//   - more than one node: an ordered list with failover; the chain ID and the genesis are checked on every node;
//   - "the node is still syncing" is waited out quietly instead of mining on an early chain.

import { Worker } from 'node:worker_threads';
import { privateKeyToAddress } from '../../common/crypto.js';
import { bytesToHex } from '../../common/bytes.js';
import { signingBytes } from '../../common/header.js';
import { availableImpls, selfTest } from '../../common/pow.js';
import { IN_SEA, readResourceText } from '../../common/resources.js';
import { headerFromTemplate } from './job.js';

const SUBMIT_RETRY_MS = 30_000;

/** An error worth retrying: no answer, a busy or overloaded node, or a web page instead of JSON-RPC. */
export class TransientError extends Error {}

export class Miner {
  /**
   * opts = { url | urls, key (bytes), threads, refreshSeconds, log, impl,
   *          expect: { chainId, genesis } (optional: refuse a node on another network) }
   */
  constructor(opts) {
    this.urls = (opts.urls ?? [opts.url]).map((u) => String(u).replace(/\/$/, ''));
    this.at = 0; // index of the node in use
    this.key = opts.key;
    this.address = '0x' + bytesToHex(privateKeyToAddress(opts.key));
    this.threads = Math.max(1, opts.threads ?? 1);
    this.refresh = (opts.refreshSeconds ?? 20) * 1000;
    this.log = opts.log ?? ((...a) => console.log(new Date().toISOString(), ...a));
    this.impl = opts.impl ?? availableImpls()[0];
    this.expect = opts.expect ?? null;
    this.workers = [];
    this.job = null;
    this.tip = null;
    this.attempts = 0;
    this.found = 0;
    this.accepted = 0;
    this.stopped = false;
    this.submitted = new Map(); // template id -> 'pending' | 'added' | 'failed'
    this.waitingSince = 0; // template refused while the node syncs
  }

  get url() { return this.urls[this.at]; }

  /** Start one worker thread without a job and stop it: proves the worker and its Argon2d code load (self-test). */
  static checkWorker(impl = availableImpls()[0]) {
    const workerData = { key: Array(32).fill(1), impl };
    const w = IN_SEA ? new Worker(readResourceText('miner/worker.cjs'), { eval: true, workerData }) : new Worker(new URL('./worker.js', import.meta.url), { workerData });
    return new Promise((resolve, reject) => {
      w.once('error', reject);
      w.once('online', () => setTimeout(() => w.postMessage({ type: 'stop' }), 200));
      w.once('exit', (code) => (code === 0 ? resolve(impl) : reject(new Error('worker exited with ' + code))));
    });
  }

  /** One JSON-RPC call to `url` (default: the node in use). Passing failures throw TransientError. */
  async rpc(method, params = [], url = this.url) {
    let r;
    try {
      r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new TransientError(`${method}: no answer from ${url} (${e.cause?.code ?? e.message})`);
    }
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch {
      // a proxy or tunnel page (HTML) instead of JSON-RPC
      throw new TransientError(`${method}: ${url} answered HTTP ${r.status} with a web page, not JSON-RPC${r.status === 200 ? ' (is this the node\'s RPC address?)' : ''}`);
    }
    if (j.error) {
      const msg = `${method}: ${j.error.message}`;
      if (j.error.code === -32005 || r.status === 429 || r.status >= 500) throw new TransientError(msg);
      throw new Error(msg);
    }
    return j.result;
  }

  /** Check a node's network. Throws if it is on another chain or genesis. */
  async checkNode(url) {
    const info = await this.rpc('psy_dagInfo', [], url);
    if (this.expect?.chainId !== undefined && Number(info.chainId) !== Number(this.expect.chainId)) throw new Error(`${url} is on chain ${Number(info.chainId)}, not ${Number(this.expect.chainId)}`);
    if (this.expect?.genesis && String(info.genesis).toLowerCase() !== String(this.expect.genesis).toLowerCase()) throw new Error(`${url} runs another network (genesis ${info.genesis})`);
    return info;
  }

  /** Move to the next node in the list that answers and is on the right network. */
  async failover(reason) {
    if (this.urls.length < 2) return false;
    for (let i = 1; i <= this.urls.length; i++) {
      const at = (this.at + i) % this.urls.length;
      try {
        await this.checkNode(this.urls[at]);
        if (at !== this.at) this.log(`switching to ${this.urls[at]} (${reason})`);
        this.at = at;
        return true;
      } catch { /* try the next */ }
    }
    return false;
  }

  async start() {
    selfTest([this.impl], { maxMemoryKiB: 4096 });
    let info;
    try { info = await this.checkNode(this.url); } catch (e) {
      if (!(e instanceof TransientError) || !(await this.failover(e.message))) throw e;
      info = await this.checkNode(this.url);
    }
    this.log(`miner for ${this.address} on chain ${Number(info.chainId)} via ${this.url}; ${this.threads} thread(s), Argon2d ${this.impl}`);
    for (let i = 0; i < this.threads; i++) {
      const workerData = { key: [...this.key], impl: this.impl };
      // single executable: the worker is an embedded, separately bundled script
      const w = IN_SEA ? new Worker(readResourceText('miner/worker.cjs'), { eval: true, workerData }) : new Worker(new URL('./worker.js', import.meta.url), { workerData });
      w.on('message', (m) => this.onWorker(m));
      w.on('error', (e) => this.log('worker error: ' + e.message));
      this.workers.push(w);
    }
    await this.newJob().catch((e) => this.log('template: ' + e.message));
    this.timer = setInterval(() => this.poll().catch((e) => this.log('poll: ' + e.message)), 2000);
    this.stats = setInterval(() => this.report(), 60_000);
    this.started = Date.now();
  }

  /** Is this template safe to sign? Throws with the reason if not. */
  checkTemplate(t) {
    const h = headerFromTemplate(t);
    if ('0x' + bytesToHex(signingBytes(h)) !== String(t.signingBytes).toLowerCase()) throw new Error('the node sent a template whose fields do not match its signing bytes; refusing to sign it');
    if (String(t.header.miner).toLowerCase() !== this.address) throw new Error('the node sent a template for another miner address; refusing to sign it');
    const pow = t.pow ?? {};
    if (!Number.isInteger(pow.memoryKiB) || pow.memoryKiB < 8 || pow.memoryKiB > 1 << 21 || !Number.isInteger(pow.iterations) || pow.iterations < 1 || pow.iterations > 16) throw new Error('the node sent unusual proof-of-work settings; refusing to mine');
    if (this.expect?.chainId !== undefined && Number(this.expect.chainId) === 87870 && (pow.memoryKiB !== 32768 || pow.iterations !== 1)) throw new Error('the node sent proof-of-work settings of another network; refusing to mine');
    return h;
  }

  async newJob() {
    let t;
    try {
      t = await this.rpc('psy_getBlockTemplate', [this.address]);
    } catch (e) {
      if (/still syncing/.test(e.message)) {
        if (!this.waitingSince) { this.waitingSince = Date.now(); this.log('the node is still syncing; mining starts when it has caught up'); }
        return;
      }
      if (e instanceof TransientError && (await this.failover(e.message))) return this.newJob();
      throw e;
    }
    if (this.waitingSince) { this.log(`the node has caught up after ${Math.round((Date.now() - this.waitingSince) / 1000)} s; mining`); this.waitingSince = 0; }
    this.checkTemplate(t);
    t.url = this.url; // solutions go to the node that issued the template
    this.job = t;
    this.jobAt = Date.now();
    const base = BigInt('0x' + [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join(''));
    this.workers.forEach((w, i) => w.postMessage({ type: 'job', job: t, start: (base + BigInt(i)).toString(), step: String(this.workers.length) }));
    if (this.submitted.size > 64) this.submitted.delete(this.submitted.keys().next().value);
  }

  async poll() {
    if (this.stopped) return;
    let info;
    try { info = await this.rpc('psy_dagInfo'); } catch (e) {
      if (e instanceof TransientError && (await this.failover(e.message))) return;
      throw e;
    }
    const tips = info.tips.slice().sort().join(',');
    if (!this.job || tips !== this.tip || Date.now() - this.jobAt > this.refresh) {
      this.tip = tips;
      await this.newJob();
    }
  }

  async onWorker(m) {
    if (m.type === 'count') { this.attempts += m.n; return; }
    if (m.type !== 'found' || this.stopped) return;
    // a second solution for a template already submitted would be refused ("unknown or expired template")
    const state = this.submitted.get(m.id);
    if (state === 'pending' || state === 'added') return;
    this.found++;
    this.submitted.set(m.id, 'pending');
    const url = this.job?.id === m.id ? this.job.url : this.url;
    // ask for the next template at once; the threads keep hashing meanwhile
    this.newJob().catch((e) => this.log('template: ' + e.message));
    const until = Date.now() + SUBMIT_RETRY_MS;
    for (let wait = 500; ; wait = Math.min(wait * 2, 4000)) {
      try {
        const r = await this.rpc('psy_submitBlock', [m.id, m.nonce, m.sig], url);
        if (r.status === 'added') this.accepted++;
        this.submitted.set(m.id, r.status === 'added' || r.status === 'known' ? 'added' : 'failed');
        this.log(`block ${r.hash.slice(0, 18)}… ${r.status}`);
        return;
      } catch (e) {
        if (!(e instanceof TransientError) || Date.now() + wait > until || this.stopped) {
          this.submitted.set(m.id, 'failed');
          this.log('submit refused: ' + e.message);
          return;
        }
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  report() {
    const secs = (Date.now() - this.started) / 1000;
    this.log(`${(this.attempts / secs).toFixed(1)} attempts/s · ${this.found} found · ${this.accepted} accepted`);
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    clearInterval(this.stats);
    for (const w of this.workers) await w.terminate();
  }
}
