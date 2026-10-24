import test from 'node:test';
import assert from 'node:assert/strict';
import { TABLE, RATIO_COMPLEMENT, cumulative, scheduledReward } from '../src/emission.js';
import { makeParams } from '../src/params.js';
import { AddrMan, netGroup } from '../src/addrman.js';
import { signTx, parseTx } from '../src/tx.js';
import { privateKeyToAddress } from '../../common/crypto.js';
import { bytesToHex } from '../../common/bytes.js';
import { concentration } from '../src/metrics.js';

test('emission table and constants match 2^(-i/48); the pools converge to 360 million', () => {
  TABLE.forEach((v, i) => assert.ok(Math.abs(Number(v) / 1e18 - 2 ** (-i / 48)) < 1e-12));
  assert.ok(Math.abs(Number(RATIO_COMPLEMENT) / 1e18 - (1 - 2 ** (-1 / 48))) < 1e-15);
  const p = makeParams();
  const total = cumulative(p.stepBlocks * 48 * 60, p); // 240 years
  assert.ok(total <= 360_000_000n * 10n ** 18n && total > 359_999_000n * 10n ** 18n);
  assert.ok(scheduledReward(p.stepBlocks * 48, p) * 2n - scheduledReward(0, p) <= 1n); // halves after 48 steps
});

test('params: the locked early-network bounds are enforced on the public chain IDs', () => {
  assert.throws(() => makeParams({ chainId: 87870n, targetSpacing: 5 }), /at least 10 s/);
  assert.throws(() => makeParams({ chainId: 87870n, k: 10 }), /k must be at least 18/);
  assert.throws(() => makeParams({ chainId: 87870n, pow: { memoryKiB: 8 } }), /32 MiB/);
  assert.doesNotThrow(() => makeParams({ chainId: 1337n, targetSpacing: 1, pow: { memoryKiB: 8 } }));
});

test('transactions: legacy and EIP-1559 sign and parse; wrong chain refused', () => {
  const p = makeParams({ chainId: 1337n });
  const sk = Uint8Array.from(Buffer.from('33'.repeat(32), 'hex'));
  const to = new Uint8Array(20).fill(9);
  const a = signTx({ nonce: 1, to, value: 5, gasPrice: 2_000_000_000n }, sk, p);
  const b = signTx({ type: 2, nonce: 2, to, value: 5, maxFee: 3_000_000_000n, maxPriorityFee: 1n }, sk, p);
  for (const t of [a, b]) assert.equal(bytesToHex(parseTx(t.raw, p).from), bytesToHex(privateKeyToAddress(sk)));
  assert.throws(() => parseTx(b.raw, makeParams({ chainId: 1338n })), /chain id/);
  assert.throws(() => parseTx(a.raw, makeParams({ chainId: 1338n })), /EIP-155/);
});

test('address manager: deterministic slots, groups, test-before-evict, sampling', () => {
  let now = 1_800_000_000;
  const m = new AddrMan({ key: 'k', now: () => now });
  assert.equal(netGroup('1.2.3.4'), 'v4:1.2');
  assert.equal(netGroup('10.0.0.1'), 'local');
  for (let i = 0; i < 200; i++) m.add(`5.6.${i}.1`, 39870, { source: '9.9.9.9' });
  const before = m.newTable.size;
  // re-adding the same addresses does not grow the tables (deterministic slots)
  for (let i = 0; i < 200; i++) m.add(`5.6.${i}.1`, 39870, { source: '9.9.9.9' });
  assert.equal(m.newTable.size, before);
  m.good('5.6.1.1', 39870);
  assert.equal(m.triedTable.size, 1);
  assert.ok(m.select());
  assert.ok(m.sample(1000).length > 0);
  const j = AddrMan.fromJSON(JSON.parse(JSON.stringify(m.toJSON())), { now: () => now });
  assert.equal(j.size, m.size);
  // stale addresses become terrible
  now += 40 * 86400;
  assert.ok(m.isTerrible(m.info.get('5.6.2.1:39870')));
});

test('metrics: concentration measures (top shares, Nakamoto coefficient, HHI, Gini)', () => {
  const equal = concentration(Array(10).fill(5));
  assert.deepEqual([equal.holders, equal.top1, equal.top5, equal.nakamoto, equal.hhi, equal.gini], [10, 0.1, 0.5, 6, 0.1, 0]);
  const one = concentration([100n, 0n]);
  assert.deepEqual([one.holders, one.top1, one.nakamoto, one.hhi, one.gini], [1, 1, 1, 1, 0]);
  // 60 / 25 / 15: the largest alone exceeds half; HHI = 0.36 + 0.0625 + 0.0225; Gini = 0.3
  const c = concentration([15n * 10n ** 24n, 60n * 10n ** 24n, 25n * 10n ** 24n]);
  assert.deepEqual([c.top1, c.nakamoto, c.hhi, c.gini], [0.6, 1, 0.445, 0.3]);
  assert.equal(c.total, (100n * 10n ** 24n).toString()); // amounts above 2^53 are summed exactly
  // exactly half is not a majority: two of four equal holders do not exceed 50 %
  assert.equal(concentration([1, 1, 1, 1]).nakamoto, 3);
  assert.deepEqual(concentration([]), { holders: 0, total: '0', top1: 0, top5: 0, nakamoto: 0, hhi: 0, gini: 0 });
});
