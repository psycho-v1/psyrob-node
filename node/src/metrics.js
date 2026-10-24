// Published decentralisation and participation metrics (RISK_REVIEW.md Part 3: published metrics; concentration of
// mining and holdings). Computed by every node from its own DAG and state, so anyone can check them.
//
// Measures for a set of shares (blue blocks per miner, PSY per address):
//   top1, top5      share of the largest one and five holders
//   nakamoto        the fewest holders that together exceed 50 % (the Nakamoto coefficient)
//   hhi             Herfindahl-Hirschman index, sum of squared shares (1 = one holder, 1/n = n equal holders)
//   gini            Gini coefficient over the holders counted (0 = equal, toward 1 = concentrated)

import { bytesToHex } from '../../common/bytes.js';
import { ADDR } from './params.js';

const SYSTEM = 'fffffffffffffffffffffffffffffffffffffffe';
const BURN = '000000000000000000000000000000000000dead';

/** Concentration of non-negative amounts (numbers or bigints). */
export function concentration(amounts) {
  const xs = amounts.map((a) => BigInt(a)).filter((a) => a > 0n).sort((a, b) => (a > b ? -1 : a < b ? 1 : 0));
  const total = xs.reduce((s, a) => s + a, 0n);
  const n = xs.length;
  if (n === 0) return { holders: 0, total: '0', top1: 0, top5: 0, nakamoto: 0, hhi: 0, gini: 0 };
  // shares as floats with 1e-9 precision (amounts can exceed 2^53)
  const share = (a) => Number((a * 1_000_000_000n) / total) / 1e9;
  const sh = xs.map(share);
  let acc = 0n, nakamoto = 0;
  for (const a of xs) { acc += a; nakamoto++; if (acc * 2n > total) break; }
  const hhi = sh.reduce((s, x) => s + x * x, 0);
  // Gini from the sorted shares (ascending): G = (2 * sum(i * x_i)) / (n * sum x) - (n + 1) / n
  const asc = [...sh].reverse();
  const sumIx = asc.reduce((s, x, i) => s + (i + 1) * x, 0);
  const gini = n === 1 ? 0 : (2 * sumIx) / (n * asc.reduce((s, x) => s + x, 0)) - (n + 1) / n;
  const round = (x) => Math.round(x * 1e4) / 1e4;
  return { holders: n, total: total.toString(), top1: round(sh[0]), top5: round(sh.slice(0, 5).reduce((s, x) => s + x, 0)), nakamoto, hhi: round(hhi), gini: round(Math.max(0, gini)) };
}

/** Blue blocks per miner over the last `window` chain blocks (one day = 8,640 at 10 s). */
export function miningMetrics(chain, window = 8640) {
  const counts = new Map();
  const to = chain.tip.chainHeight, from = Math.max(1, to - window + 1);
  let blocks = 0;
  for (let h = from; h <= to; h++) {
    const e = chain.dag.get(chain.chain[h]);
    for (const xh of e.mergesetBlues ?? []) {
      const x = chain.dag.get(xh);
      if (!x || x === chain.dag.genesis) continue;
      const m = bytesToHex(x.header.miner);
      counts.set(m, (counts.get(m) ?? 0) + 1);
      blocks++;
    }
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([miner, n]) => ({ miner: '0x' + miner, blocks: n, share: Math.round((n / blocks) * 1e4) / 1e4 }));
  return { fromChainHeight: from, toChainHeight: to, blueBlocks: blocks, ...concentration([...counts.values()]), top };
}

/** PSY held by ordinary addresses (system contracts, the burn address and the system caller excluded). */
export function holdingMetrics(state) {
  const skip = new Set([...Object.values(ADDR).map((a) => bytesToHex(a)), BURN, SYSTEM]);
  const balances = [];
  for (const [k, v] of state.data) {
    if (k[0] !== 'a' || skip.has(k.slice(1)) || !(v.balance > 0n)) continue;
    balances.push(v.balance);
  }
  return concentration(balances);
}

/** Chain-derived metrics, cached per tip. */
export function chainMetrics(chain, window = 8640) {
  // one cache entry per window, all for the current tip; holdings (a pass over the whole state) once per tip
  const tip = chain.tip.hash;
  if (chain._metricsCache?.tip !== tip) chain._metricsCache = { tip, windows: new Map(), holdings: null };
  const c = chain._metricsCache;
  const hit = c.windows.get(window);
  if (hit) return hit;
  c.holdings ??= holdingMetrics(chain.state);
  const value = { tip: '0x' + tip, chainHeight: chain.tip.chainHeight, mining: miningMetrics(chain, window), holdings: c.holdings };
  if (c.windows.size < 8) c.windows.set(window, value);
  return value;
}
