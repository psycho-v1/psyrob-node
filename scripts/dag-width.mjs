#!/usr/bin/env node
// Expected DAG width at the locked block interval (10 s per blue block) for a number of miners and a network delay.
// Structure only: each miner builds on the tips of its own view; a block reaches the other miners after the delay;
// GHOSTDAG (k = 18) colours and orders the result. Equal hash power per miner.
//
//   node scripts/dag-width.mjs [blocks=3000]
import { Dag } from '../node/src/dag.js';
import { makeParams } from '../node/src/params.js';
import { randomBytes } from 'node:crypto';

const p = makeParams({ chainId: 1337n, k: 18, pow: { memoryKiB: 8 } });
const N_BLOCKS = Number(process.argv[2] ?? 3000);

function run(miners, delay, spacing = 10, seed = 1) {
  let s = seed;
  const rand = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
  const dag = new Dag(p);
  const g = randomBytes(32);
  dag.addGenesis(g, { target: (1n << 256n) - 1n }, {});
  const gh = Buffer.from(g).toString('hex');
  const views = Array.from({ length: miners }, () => ({ tips: new Set([gh]), known: new Set([gh]) }));
  const pending = []; // { at, miner, hash, parents }
  let t = 0, multi = 0, mergeTotal = 0, reds = 0;
  const deliver = (v, b) => {
    if (v.known.has(b.hash)) return;
    v.known.add(b.hash);
    for (const q of b.parents) v.tips.delete(q);
    v.tips.add(b.hash);
  };
  for (let i = 0; i < N_BLOCKS; i++) {
    t += -Math.log(1 - rand()) * spacing;
    pending.sort((a, b) => a.at - b.at);
    while (pending.length && pending[0].at <= t) { const d = pending.shift(); deliver(views[d.miner], d.b); }
    const m = Math.floor(rand() * miners);
    const v = views[m];
    let parents = [...v.tips].map((h) => dag.get(h)).sort((a, b) => (b.blueWork > a.blueWork ? 1 : -1)).slice(0, 10).map((e) => e.hash).sort();
    const gd = dag.ghostdag(parents);
    const hash = randomBytes(32);
    dag.insert(hash, { parents: parents.map((x) => Buffer.from(x, 'hex')), target: (1n << 256n) - 1n }, {}, gd);
    const b = { hash: Buffer.from(hash).toString('hex'), parents };
    deliver(v, b);
    for (let j = 0; j < miners; j++) if (j !== m) pending.push({ at: t + delay, miner: j, b });
    if (parents.length >= 2) multi++;
    mergeTotal += gd.mergesetSize;
    reds += gd.mergesetReds.length;
  }
  const tipBlue = [...dag.tips].map((h) => dag.get(h)).sort((a, b) => (b.blueWork > a.blueWork ? 1 : -1))[0];
  return { miners, delay, multiParentShare: multi / N_BLOCKS, width: N_BLOCKS / tipBlue.chainHeight, meanMergeset: mergeTotal / N_BLOCKS, reds };
}

console.log('miners | delay | blocks with 2+ parents | width (blocks per chain block) | mean mergeset | red blocks');
for (const delay of [1, 2, 5]) for (const miners of [1, 10, 100]) {
  const r = run(miners, delay);
  console.log(`${String(miners).padStart(6)} | ${delay} s | ${(100 * r.multiParentShare).toFixed(1).padStart(5)} % | ${r.width.toFixed(3)} | ${r.meanMergeset.toFixed(3)} | ${r.reds}`);
}
