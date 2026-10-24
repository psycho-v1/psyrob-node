#!/usr/bin/env node
// Build a genesis file.
//
//   node genesis/build.js --launch <launch.json> [--time <unix seconds>] --out genesis/genesis-87870.json
//   node genesis/build.js --chain <id> --dev <Dev Account 1>,<Dev Account 2>,<Dev Account 3> [--time <unix seconds>]
//                         [--hashes <expected attempts per block at start>] --out <file>          (devnets only)
//
// --launch: the file the launch ceremony wrote (psyrob-node --prelaunch, <datadir>/launch.json): the chain ID, the
// starting target, the three Dev Account wallets, and each seat's council key with the Dev Account wallet's signature
// (DAG_SPEC.md section 17.1). The public chain IDs need it: without the three signatures the build stops.
//
// The file holds the config and the resulting genesis hash and state root; nodes rebuild the genesis state from it and
// genesis/artifacts.json, check the launch signatures, and refuse to start if anything differs.
import fs from 'node:fs';
import { buildGenesis } from '../node/src/genesis.js';
import { bytesToHex } from '../common/bytes.js';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const out = opt('out');
const timestamp = Number(opt('time', Math.floor(Date.now() / 1000)));
let config;
if (opt('launch')) {
  const l = JSON.parse(fs.readFileSync(opt('launch'), 'utf8'));
  if (!Array.isArray(l.launchSignatures) || !l.launchSignatures.every(Boolean)) {
    console.error('the launch ceremony is not complete: all three Dev Account seats must be signed'); process.exit(2);
  }
  config = { chainId: Number(l.chainId), timestamp, target: l.target, devBeneficiaries: l.devBeneficiaries, extra: l.extra, councilKeys: l.councilKeys, launchSignatures: l.launchSignatures,
    ...(l.bootstrapSigners ? { bootstrapSigners: l.bootstrapSigners } : {}), ...(l.bootstrapQuorum !== undefined ? { bootstrapQuorum: l.bootstrapQuorum } : {}) };
} else {
  const chainId = Number(opt('chain'));
  const devs = String(opt('dev', '')).split(',').map((x) => x.trim());
  if (!chainId || devs.length !== 3 || !devs.every((d) => /^0x[0-9a-fA-F]{40}$/.test(d)) || new Set(devs.map((d) => d.toLowerCase())).size !== 3) {
    console.error('usage: build.js --launch <launch.json> [--time <s>] --out <file>\n   or: build.js --chain <id> --dev <a1>,<a2>,<a3> [--time <s>] [--hashes <n>] --out <file>'); process.exit(2);
  }
  const hashes = BigInt(opt('hashes', 250));
  config = { chainId, timestamp, target: '0x' + ((1n << 256n) / hashes).toString(16), devBeneficiaries: devs, extra: `PSYROB genesis ${chainId}` };
}
if (!out) { console.error('--out <file> is required'); process.exit(2); }
const g = await buildGenesis(config); // checks the launch signatures (required for the public chain IDs)
fs.writeFileSync(out, JSON.stringify({ config, hash: '0x' + bytesToHex(g.hash), stateRoot: '0x' + bytesToHex(g.header.stateRoot),
  note: 'Never reuse a key that was used on any other network.' }, null, 1) + '\n');
console.log(`wrote ${out}: chain ${config.chainId}, genesis 0x${bytesToHex(g.hash)}, time ${new Date(timestamp * 1000).toISOString()}`);
