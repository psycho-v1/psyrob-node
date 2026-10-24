// The "parent" is the selected
// parent and the height is its blue score (DAG_SPEC.md section 2).
// ASERT difficulty adjustment (absolutely scheduled exponentially rising targets),
// the integer-only aserti3-2d algorithm from Bitcoin Cash, anchored at genesis.
//
//   next_target = anchor_target * 2^((time_delta - spacing * (height_delta + 1)) / half_life)
//
// time_delta  = parent.timestamp - anchor_parent_timestamp
// height_delta = parent.number - anchor.number
// The anchor is genesis; its "parent timestamp" is defined as genesis.timestamp - spacing.
// 2^x is computed in 16.16 fixed point with the reference cubic approximation, so every
// node gets bit-identical results. Result is clamped to [1, powLimit].

export function asertNextTarget(anchor, parentTimestamp, parentNumber, params) {
  const spacing = BigInt(params.targetSpacing);
  const halfLife = BigInt(params.asertHalfLife);
  const timeDelta = BigInt(parentTimestamp) - BigInt(anchor.parentTimestamp);
  const heightDelta = BigInt(parentNumber) - BigInt(anchor.number);
  if (heightDelta < 0n) throw new Error('asert: parent below anchor');

  // BigInt division truncates toward zero, matching the C++ reference.
  const exponent = ((timeDelta - spacing * (heightDelta + 1n)) * 65536n) / halfLife;
  let shifts = exponent >> 16n; // arithmetic shift = floor
  const frac = exponent - (shifts << 16n); // 0 <= frac < 65536
  const factor = 65536n + ((
    195766423245049n * frac +
    971821376n * frac * frac +
    5127n * frac * frac * frac +
    (1n << 47n)
  ) >> 48n);

  let next = anchor.target * factor;
  shifts -= 16n;
  next = shifts <= 0n ? next >> -shifts : next << shifts;

  if (next === 0n) next = 1n;
  if (next > params.powLimit) next = params.powLimit;
  return next;
}
