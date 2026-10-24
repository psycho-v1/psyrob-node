#!/usr/bin/env node
// Check that this copy of the code is on the right network: rebuild the genesis state from the network's genesis file
// (genesis/genesis-<chain ID>.json, params.js GENESIS_FILE) and genesis/artifacts.json and compare with the recorded
// hash (and with genesis/chain.json).
//
//   npm run genesis:check
import fs from 'node:fs';
import { buildGenesis } from '../node/src/genesis.js';
import { bytesToHex } from '../common/bytes.js';
import { GENESIS_FILE } from '../node/src/params.js';

const file = new URL('../' + GENESIS_FILE, import.meta.url);
if (!fs.existsSync(file)) {
  // between the code freeze and the launch ceremony the network's genesis does not exist yet
  console.log(`${GENESIS_FILE} does not exist yet: it is built by the launch script after the launch ceremony`);
  process.exit(1);
}
const g = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!g.config.launchSignatures) {
  console.log(`${GENESIS_FILE} (${g.hash}) has no launch ceremony signatures: a public genesis needs them`);
  process.exit(1);
}
const built = '0x' + bytesToHex((await buildGenesis(g.config)).hash);
const meta = JSON.parse(fs.readFileSync(new URL('./chain.json', import.meta.url), 'utf8'));
console.log(`chain ID:              ${g.config.chainId} (0x${g.config.chainId.toString(16)}), network ${meta.network}`);
console.log(`genesis time:          ${new Date(g.config.timestamp * 1000).toISOString()}`);
console.log(`genesis hash:          ${built}`);
(g.config.devBeneficiaries ?? []).forEach((d, i) => console.log(`Dev Account ${i + 1}:         ${d} (40,000,000 PSY, vesting)` +
  (g.config.councilKeys ? `, council key ${g.config.councilKeys[i]}, launch signature checked` : '')));
let ok = built === g.hash;
if (!ok) console.log(`MISMATCH: the file records ${g.hash}; this copy is not on the published network`);
if (meta.genesis !== built) { console.log(`MISMATCH: genesis/chain.json records ${meta.genesis}`); ok = false; }
if (meta.chainId !== g.config.chainId) { console.log('MISMATCH: genesis/chain.json has another chain ID'); ok = false; }
process.exit(ok ? 0 : 1);
