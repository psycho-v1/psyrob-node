// Proof-of-work checks of blocks from peers in a worker thread (powworker.js). One worker, first in first out, so the
// blocks of a sync batch are checked in the order they came; the main thread only waits on a promise. If the worker
// cannot start or the queue is full, the check runs on the main thread as before, so a block is never skipped.
import { Worker } from 'node:worker_threads';
import { argon2Impl, checkPow } from '../../common/pow.js';
import { IN_SEA, readResourceText } from '../../common/resources.js';

const MAX_QUEUE = 1024;

export class PowPool {
  constructor({ pow, log = () => {} } = {}) {
    this.pow = pow;
    this.log = log;
    this.next = 1;
    this.waiting = new Map(); // id -> resolve
    try {
      const workerData = { impl: argon2Impl().name };
      // single executable: the worker is an embedded, separately bundled script (scripts/build-release.mjs)
      this.worker = IN_SEA ? new Worker(readResourceText('node/powworker.cjs'), { eval: true, workerData }) : new Worker(new URL('./powworker.js', import.meta.url), { workerData });
      this.worker.unref();
      this.worker.on('message', (m) => { const r = this.waiting.get(m.id); this.waiting.delete(m.id); r?.(m.ok); });
      this.worker.on('error', (e) => this.fail(e));
      this.worker.on('exit', (code) => { if (code !== 0) this.fail(new Error('exited with ' + code)); });
    } catch (e) {
      this.fail(e);
    }
  }

  fail(e) {
    if (!this.worker) return;
    this.log('pow worker unavailable, checking on the main thread: ' + e.message);
    this.worker = null;
    for (const [id, r] of this.waiting) { this.waiting.delete(id); r(null); }
  }

  /** Is the proof of work of this header (signing bytes) at or below `target`? */
  async check(header, target) {
    if (this.worker && this.waiting.size < MAX_QUEUE) {
      const id = this.next++;
      const ok = await new Promise((resolve) => {
        this.waiting.set(id, resolve);
        this.worker.postMessage({ id, header, target: '0x' + target.toString(16), pow: this.pow });
      });
      if (ok !== null) return ok;
    }
    return checkPow(header, target, this.pow);
  }

  close() { this.worker?.terminate(); this.worker = null; }
}
