// Seconds a full mergeset of the cheapest-per-gas workloads takes to execute on this machine, under the rules before
// and after protocol 10.1.0 (audit F-05, node/src/rules.js). Each workload is a contract that calls one precompile, or
// runs one opcode, in a loop until 10 M gas run out. Run it on an idle machine, not under node:test (which makes every
// await several times slower):  node scripts/gas-bench.mjs
// The audit's criterion: a full mergeset within 25 % of the block interval.

import { testChain, key, mineOne } from '../node/test/helpers.js';
import { contractCall } from '../node/src/evm.js';
import { F05_MERGESET_GAS } from '../node/src/rules.js';
import { keccak256 } from '../common/crypto.js';

const w32 = (n) => BigInt(n).toString(16).padStart(64, '0');
const p2 = (n) => n.toString(16).padStart(4, '0');
const Gx = '79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798';
const G1 = w32(1) + w32(2);
const G2 = '198e9393920d483a7260bfb731fb5d25f1aa493335a9e71297e485b7aef312c2' + '1800deef121f1e76426a00665e5c4479674322d4f75edadd46debd5cd992f6ed' +
  '090689d0585ff075ec9e99ad690c3395bc4b313370b38ef355acdadcd122975b' + '12c85ea5db8c6deb4aab71808dcb408fe3d1e7690c43d37b4ce6cc0166fa7daa';
const modexp = (b, e, m) => w32(b.length / 2) + w32(e.length / 2) + w32(m.length / 2) + b + e + m;
// CODECOPY the input to memory 0; loop: STATICCALL(gas, precompile, 0, len, 0x4000, 0x100); POP
const precompile = (addr, input) => '61' + p2(input.length / 2) + '61' + p2(30) + '600039' + '5b' + '610100614000' + '61' + p2(input.length / 2) + '6000' + '60' + addr.toString(16).padStart(2, '0') + '5afa50600956' + '00' + input;
const opcode = (body) => '5b' + body + '600056';
const F = 'ff'.repeat(32);
const LOADS = [
  ['ecrecover', precompile(1, w32(1) + w32(27) + Gx + w32(1))],
  ['sha256 32 B', precompile(2, w32(1))],
  ['identity 32 B', precompile(4, w32(1))],
  ['modexp 32 B', precompile(5, modexp(F, F, 'fd'.repeat(31) + 'ff'))],
  ['bn254 add', precompile(6, G1 + G1)],
  ['bn254 mul', precompile(7, G1 + F)],
  ['bn254 pairing', precompile(8, G1 + G2)],
  ['blake2f', precompile(9, '000f4240' + '00'.repeat(64 + 128 + 16) + '01')],
  ['self STATICCALL', opcode('6000600060006000305afa50')],
  ['KECCAK256 32 B', opcode('602060002050')],
  ['SLOAD warm', opcode('60005450')],
  ['MULMOD', opcode('7f' + F + '7f' + F + '7f' + F + '0950')],
];

const t = await testChain();
t.advance(10);
await mineOne(t, key(7));
const addr = new Uint8Array(20).fill(0xab);
const seconds = (codeHex, f05) => t.chain.readAtTip(async (view, ctx) => {
  const code = Uint8Array.from(Buffer.from(codeHex, 'hex'));
  view.setCode(addr, code);
  view.setAccount(addr, { codeHash: keccak256(code), nonce: 1n });
  const a = performance.now();
  await contractCall(view, t.params, { ...ctx, f05 }, { to: addr, gasLimit: 10_000_000n, commit: false });
  return (performance.now() - a) / 1000;
});
const oldGas = Number(t.params.mergesetGasLimit) / 1e7, newGas = Number(F05_MERGESET_GAS) / 1e7;
const limit = 0.25 * t.params.targetSpacing;
console.log(`full mergeset: ${oldGas * 10} M gas before 10.1.0, ${newGas * 10} M after; limit ${limit} s (25 % of ${t.params.targetSpacing} s)\n`);
console.log('workload'.padEnd(18) + 'before'.padStart(10) + 'after'.padStart(10));
let worst = 0;
for (const [name, code] of LOADS) {
  const before = (await seconds(code, false)) * oldGas, after = (await seconds(code, true)) * newGas;
  worst = Math.max(worst, after);
  console.log(name.padEnd(18) + `${before.toFixed(2)} s`.padStart(10) + `${after.toFixed(2)} s`.padStart(10) + (after > limit ? '  over' : ''));
}
console.log(`\nworst after 10.1.0: ${worst.toFixed(2)} s (${((100 * worst) / t.params.targetSpacing).toFixed(0)} % of the block interval)`);
process.exit(worst > limit ? 1 : 0);
