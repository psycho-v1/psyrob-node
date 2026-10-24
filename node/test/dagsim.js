// Shared by the DAG proof tests: a deterministic multi-miner simulation with network delay, and DAG metrics.
import { testChain, key, mineOne } from './helpers.js';
import { signTx } from '../src/tx.js';
import { bytesToHex } from '../../common/bytes.js';

// deterministic random numbers
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

export async function simulate({ miners = 6, blocks = 120, delay = 8, seed = 7, txs = true } = {}) {
  const rand = rng(seed);
  const start = 1_800_000_000;
  const nodes = [];
  for (let i = 0; i < miners; i++) nodes.push({ t: await testChain({ start }), key: key(60 + i), produced: [] });
  const events = []; // { at, kind: 'find' | 'deliver', node, raw }
  let now = start;
  const exp = (mean) => -Math.log(1 - rand()) * mean;
  const nextFind = () => ({ at: now + exp(10), kind: 'find', node: Math.floor(rand() * miners) });
  events.push(nextFind());
  const all = [];
  const sent = [];
  while (all.length < blocks) {
    events.sort((a, b) => a.at - b.at);
    const ev = events.shift();
    now = ev.at;
    for (const n of nodes) n.t.setTime(Math.floor(now));
    if (ev.kind === 'deliver') {
      await nodes[ev.node].t.chain.addBlock(ev.raw);
      continue;
    }
    const n = nodes[ev.node];
    // transactions: after the first 30 blocks, the finder sends a transfer through its own node only
    if (txs && all.length >= 30 && all.length % 3 === 0) {
      const bal = n.t.chain.state.getAccount(n.key.addr).balance;
      if (bal > 10n ** 18n) {
        const nonce = n.nonce ?? n.t.chain.state.getAccount(n.key.addr).nonce;
        const tx = signTx({ type: 2, nonce, to: new Uint8Array(20).fill(0xee), value: 1000n, gasLimit: 21000, maxFee: 10_000_000_000n, maxPriorityFee: 1n }, n.key.sk, n.t.params);
        try { await n.t.chain.readAtTip((v, ctx) => n.t.mempool.add(tx.raw, v, ctx.baseFee)); n.nonce = nonce + 1n; sent.push(bytesToHex(tx.hash)); } catch { /* not admitted */ }
      }
    }
    const r = await mineOne(n.t, n.key);
    const raw = n.t.chain.dag.get(r.hash).raw;
    all.push({ hash: r.hash, miner: ev.node, raw });
    for (let j = 0; j < miners; j++) if (j !== ev.node) events.push({ at: now + delay * (0.75 + 0.5 * rand()), kind: 'deliver', node: j, raw });
    events.push(nextFind());
  }
  // let every block reach every node, then one more block merges all tips
  events.sort((a, b) => a.at - b.at);
  for (const ev of events.filter((e) => e.kind === 'deliver')) await nodes[ev.node].t.chain.addBlock(ev.raw);
  now += 60;
  for (const n of nodes) n.t.setTime(Math.floor(now));
  const last = await mineOne(nodes[0].t, nodes[0].key);
  for (let j = 1; j < miners; j++) await nodes[j].t.chain.addBlock(nodes[0].t.chain.dag.get(last.hash).raw);
  return { nodes, all, sent, last };
}

export function metrics(chain, produced) {
  const blocks = [...chain.dag.blocks.values()].filter((e) => e !== chain.dag.genesis);
  const chainLen = chain.tip.chainHeight;
  const multi = blocks.filter((e) => e.parents.length >= 2).length;
  const reds = [...chain.acceptedBy.values()].filter((x) => x.colour === 'red').length;
  const inDag = produced.filter((b) => chain.dag.has(b.hash)).length;
  const unmerged = blocks.filter((e) => e !== chain.tip && !chain.acceptedBy.has(e.hash)).length;
  const maxMergeset = Math.max(...blocks.map((e) => (e.mergesetBlues?.length ?? 0) + (e.mergesetReds?.length ?? 0)));
  return { blocks: blocks.length, chainLen, width: blocks.length / chainLen, multiParentShare: multi / blocks.length, reds, orphaned: produced.length - inDag, unmerged, maxMergeset };
}

