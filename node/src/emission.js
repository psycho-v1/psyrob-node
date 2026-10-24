// Emission (DAG_SPEC.md section 7). The mining pool and the NGO pool follow the identical schedule.
//
//   R(s)  = R0 * 2^(-s/48), s = floor(blueScore / stepBlocks)   (monthly steps, halving every 48 steps ≈ 4 years)
//   mined = min(R(s), poolCap - issued)
//   first 12 months: mined <= cumulative(R, blue score an ideal 10-second chain would have reached by the past median
//                    time, plus the median's lag of 16 blocks) - issued
//
// 2^(-i/48) comes from a fixed table of 1e18-scaled integers, so every node computes identical amounts without floats.

const SCALE = 10n ** 18n;
/** TABLE[i] = floor(2^(-i/48) * 1e18), i = 0..47. Fixed constants (checked by the tests against Math.pow). */
export const TABLE = Object.freeze([
  1000000000000000000n, 985663198640188000n, 971531941153606000n, 957603280698574000n, 943874312681694000n, 930342174152147000n,
  917004043204671000n, 903857138391101000n, 890898718140339000n, 878126080186650000n, 865536561006143000n, 853127535261343000n,
  840896415253715000n, 828840650384044000n, 816957726620550000n, 805245165974627000n, 793700525984100000n, 782321399203887000n,
  771105412703970000n, 760050227574557000n, 749153538438341000n, 738413072969750000n, 727826591421094000n, 717391886155500000n,
  707106781186548000n, 696969131724500000n, 686976823729045000n, 677127773468446000n, 667419927085017000n, 657851260166819000n,
  648419777325505000n, 639123511780215000n, 629960524947437000n, 620928906036742000n, 612026771652328000n, 603252265400261000n,
  594603557501361000n, 586078844409626000n, 577676348436137000n, 569394317378346000n, 561231024154687000n, 553184766444417000n,
  545253866332629000n, 537436669960348000n, 529731547179648000n, 522136891213707000n, 514651118321746000n, 507272667468762000n,
]);
/** 1 - 2^(-1/48), 1e18-scaled (fixed constant). */
export const RATIO_COMPLEMENT = 14336801359812412n;

export function rewardAtStep(s, p) {
  const halvings = Math.floor(s / p.halvingSteps);
  if (halvings > 255) return 0n;
  return (p.R0 * TABLE[s % p.halvingSteps] / SCALE) >> BigInt(halvings);
}

// the step index by integer (BigInt) division: exact for any blue score, not only below 2^53 (PSYROB Lab review M §4.1)
export const scheduledReward = (blueScore, p) => rewardAtStep(Number((typeof blueScore === 'bigint' ? blueScore : BigInt(Math.floor(blueScore))) / BigInt(p.stepBlocks)), p);

/** Sum of the schedule for blue scores 0 .. b-1. */
export function cumulative(b, p) {
  b = Number(b);
  let total = 0n;
  const full = Math.floor(b / p.stepBlocks);
  for (let s = 0; s < full; s++) total += BigInt(p.stepBlocks) * rewardAtStep(s, p);
  total += BigInt(b % p.stepBlocks) * rewardAtStep(full, p);
  return total;
}

/**
 * Subsidy of one pool for a blue block with `blueScore`, given what the pool has issued and the past median time of
 * the accepting chain block. Same function for the mining and the NGO pool.
 */
export function poolSubsidy(blueScore, issued, pastMedianTime, genesisTime, p) {
  let amount = scheduledReward(blueScore, p);
  const left = p.poolCap - issued;
  if (amount > left) amount = left;
  const elapsed = pastMedianTime - genesisTime;
  if (elapsed < p.earlyBoundsSeconds) {
    // The past median time lags the newest block by about half its window; that many blocks are added back so a chain
    // running exactly on schedule is never capped.
    const lag = Math.floor(p.pastMedianWindow / 2) + 1;
    const ideal = Math.max(0, Math.floor(elapsed / p.targetSpacing)) + 1 + lag;
    const allowed = cumulative(ideal, p) - issued;
    if (amount > allowed) amount = allowed > 0n ? allowed : 0n;
  }
  return amount < 0n ? 0n : amount;
}
