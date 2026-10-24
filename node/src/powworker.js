// Proof-of-work check worker for the node (powpool.js): one 32 MiB Argon2d hash per request, off the main thread, so
// the node keeps answering RPC, pages and peers while it checks blocks .
import { parentPort, workerData } from 'node:worker_threads';
import { makeImpl, checkPow } from '../../common/pow.js';

const impl = makeImpl(workerData.impl);
parentPort.on('message', (m) => {
  let ok = false;
  try { ok = checkPow(Uint8Array.from(m.header), BigInt(m.target), m.pow, impl); } catch { ok = false; }
  parentPort.postMessage({ id: m.id, ok });
});
