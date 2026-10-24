// Mining worker thread: searches nonces for the current job and reports solutions and attempt counts.
import { parentPort, workerData } from 'node:worker_threads';
import { makeImpl } from '../../common/pow.js';
import { headerFromTemplate, attempt } from './job.js';

const impl = makeImpl(workerData.impl);
const sk = Uint8Array.from(workerData.key);
let job = null, header = null, nonce = 0n, step = 1n, count = 0;

parentPort.on('message', (m) => {
  if (m.type === 'job') { job = m.job; header = headerFromTemplate(job); nonce = BigInt(m.start); step = BigInt(m.step); }
  if (m.type === 'stop') process.exit(0);
});

function loop() {
  if (job) {
    for (let i = 0; i < 4; i++) {
      const r = attempt(header, nonce, sk, job.pow, impl);
      count++;
      // keep hashing after a find (the miner asks for the next template at once and skips further solutions of
      // this one); the finding thread used to sit idle until the next template arrived
      if (r.ok) parentPort.postMessage({ type: 'found', id: job.id, nonce: '0x' + nonce.toString(16), sig: '0x' + Buffer.from(header.minerSig).toString('hex') });
      nonce = (nonce + step) & 0xffffffffffffffffn;
    }
    if (count >= 16) { parentPort.postMessage({ type: 'count', n: count }); count = 0; }
  }
  setImmediate(loop); // yield so new jobs are picked up
}
loop();
