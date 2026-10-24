#!/usr/bin/env node
// PSYROB miner (command line; the control-page version is psyrob-miner-gui).
//
//   node miner/bin/psyrob-miner.js --key <file> [--node http://127.0.0.1:8770] [--threads 1]
//
// Options:
//   --key <file>        miner wallet key file (hex private key, mode 0600). The block reward goes to this wallet, and
//                       every attempt is signed with it. Create one with: node node/bin/psyrob-wallet.js new --out <file>
//   --node <url,...>    the node's JSON-RPC URL (default http://127.0.0.1:8770); several, comma-separated, are tried in
//                       order when one does not answer
//   --chain-id <n>      refuse a node on another chain (production units: 87870)
//   --threads <n>       worker threads (default 1). Each needs 32 MiB of memory and one CPU core.
//   --refresh <s>       fetch a new template at least every s seconds (default 20)
//   --expect-address <0x…>  refuse to start unless the key belongs to this address (production units)
//   --help

import fs from 'node:fs';
import { Miner } from '../src/miner.js';
import { IN_SEA, readResourceText } from '../../common/resources.js';
import { privateKeyToAddress } from '../../common/crypto.js';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
if (argv.includes('--help') || !opt('key')) {
  if (IN_SEA) { console.log(readResourceText('help/psyrob-miner.txt')); process.exit(argv.includes('--help') ? 0 : 2); }
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  console.log(src.slice(1, src.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(argv.includes('--help') ? 0 : 2);
}
const file = opt('key');
if ((fs.statSync(file).mode & 0o077) !== 0) { console.error(`key file ${file} must not be readable by others (chmod 600)`); process.exit(2); }
const hex = fs.readFileSync(file, 'utf8').trim().replace(/^0x/, '');
if (!/^[0-9a-fA-F]{64}$/.test(hex)) { console.error('the key file must hold one 32-byte hex private key'); process.exit(2); }

const keyBytes = Uint8Array.from(Buffer.from(hex, 'hex'));
if (opt('expect-address')) {
  const have = '0x' + Buffer.from(privateKeyToAddress(keyBytes)).toString('hex');
  if (have.toLowerCase() !== String(opt('expect-address')).toLowerCase()) {
    console.error(`the key file belongs to ${have}, not to the expected miner address ${opt('expect-address')}; refusing to mine`);
    process.exit(2);
  }
}
const urls = String(opt('node', 'http://127.0.0.1:8770')).split(',').map((u) => u.trim()).filter(Boolean);
const expect = opt('chain-id') ? { chainId: Number(opt('chain-id')) } : null;
const miner = new Miner({ urls, key: keyBytes, threads: Number(opt('threads', 1)), refreshSeconds: Number(opt('refresh', 20)), expect });
miner.start().catch((e) => { console.error('miner: ' + e.message); process.exit(1); });
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, async () => { await miner.stop(); process.exit(0); });
