#!/usr/bin/env node
// PSYROB testnet full node.
//
//   node node/bin/psyrob-node.js [options]
//
// Options:
//   --genesis <file>        genesis file (default: the network's genesis, genesis/genesis-<chain ID>.json)
//   --datadir <dir>         data directory (default ~/.psyrob)
//   --prelaunch <file>      launch ceremony only (no chain): serve /launch, where the three Dev Account holders sign
//                           their seats; <file> holds chainId, target, devBeneficiaries and extra. The signatures are
//                           saved in <datadir>/launch.json for genesis/build.js --launch
//   --p2p-host <host>       listen address for peers (default 0.0.0.0)
//   --p2p-port <port>       listen port for peers (default 39870); --no-listen to make outbound connections only
//   --seeds <list>          peers to start from, comma-separated: host:port (TCP) or wss://host/p2p (WebSocket, for
//                           nodes behind an HTTPS proxy); also read from genesis/seeds.txt
//   --no-default-seeds      do not read genesis/seeds.txt (dry runs and devnets: never dial the public node)
//   --advertise <h:p>       public address to tell peers (optional)
//   --http-host <host>      explorer and JSON-RPC address (default 127.0.0.1)
//   --http-port <port>      explorer and JSON-RPC port (default 8770)
//   --http-vhosts <list>    allowed Host headers, comma-separated, or * for any (default: localhost,127.0.0.1,::1)
//   --http-cors <list>      origins allowed to call the RPC from a browser, comma-separated, or * (default: none)
//   --downloads <dir>       serve the release packages in <dir> at /downloads/ and list them on /run-a-node
//                           (default: dist/downloads of this checkout, if npm run release was run there)
//   --rpc-rate <b,r>        RPC rate limit per client: burst, per second (default 200,50)
//   --no-ban-local          do not ban local/private addresses that misbehave (devnets on one machine only)
//   --signer-key <file>     committee member or bootstrap key file (hex private key, mode 0600): sign checkpoints and
//                           fund approvals; may be given more than once (one node holding several bootstrap keys)
//   --devnet <params.json>  parameter overrides for a local devnet (refused for the public chain IDs)
//   --help

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Node } from '../src/node.js';
import { splitHostPort } from '../src/p2p.js';
import { PUBLIC_CHAIN_IDS, GENESIS_FILE } from '../src/params.js';
import { IN_SEA, readResourceText } from '../../common/resources.js';
import { Ceremony, startPrelaunch } from '../src/prelaunch.js';
import { DEFAULT_VHOSTS } from '../src/http.js';

// from the source tree: the repository root; in the single executable the genesis and seeds are embedded
const ROOT = IN_SEA ? null : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const argv = process.argv.slice(2);
const opt = (name, def = undefined) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes('--' + name);

if (flag('help')) {
  if (IN_SEA) { console.log(readResourceText('help/psyrob-node.txt')); process.exit(0); }
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  console.log(src.slice(1, src.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(0);
}

function readKey(file) {
  const st = fs.statSync(file);
  if ((st.mode & 0o077) !== 0) throw new Error(`key file ${file} must not be readable by others (chmod 600)`);
  const hex = fs.readFileSync(file, 'utf8').trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`key file ${file} must hold one 32-byte hex private key`);
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

if (opt('prelaunch')) {
  const datadir = path.resolve(opt('datadir', path.join(os.homedir(), '.psyrob')));
  const ceremony = new Ceremony(JSON.parse(fs.readFileSync(path.resolve(opt('prelaunch')), 'utf8')), path.join(datadir, 'launch.json'));
  const host = opt('http-host', '127.0.0.1'), port = Number(opt('http-port', 8770));
  const vhosts = opt('http-vhosts') ? opt('http-vhosts').split(',').map((x) => x.trim().toLowerCase()) : DEFAULT_VHOSTS;
  // no top-level await: the release bundles this file as CommonJS
  startPrelaunch({ ceremony, host, port, vhosts, log: (m) => console.log(new Date().toISOString(), m) }).then(() =>
    console.log(`pre-launch: chain ${ceremony.config.chainId}, launch ceremony on http://${host}:${port}/launch (${ceremony.launchSignatures.filter(Boolean).length} of 3 seats signed; file ${ceremony.file})`),
  (e) => { console.error(e); process.exit(1); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
} else {
  const genesisFile = opt('genesis') ? path.resolve(opt('genesis')) : IN_SEA ? null : path.join(ROOT, GENESIS_FILE);
  if (genesisFile && !fs.existsSync(genesisFile)) {
    // between the code freeze and the launch ceremony the network's genesis does not exist yet
    console.error(`no genesis file ${genesisFile}: this network has not been launched yet (the launch ceremony builds it), or pass --genesis <file>`);
    process.exit(2);
  }
  const g = JSON.parse(genesisFile ? fs.readFileSync(genesisFile, 'utf8') : readResourceText(GENESIS_FILE));
  let paramOverrides = {};
  if (opt('devnet')) {
    if (PUBLIC_CHAIN_IDS.has(BigInt(g.config.chainId))) { console.error(`--devnet is refused for the public chain IDs (${[...PUBLIC_CHAIN_IDS].join(', ')})`); process.exit(2); }
    paramOverrides = JSON.parse(fs.readFileSync(opt('devnet'), 'utf8'));
  }
  const seedText = flag('no-default-seeds') ? '' : IN_SEA ? readResourceText('genesis/seeds.txt') : fs.existsSync(path.join(ROOT, 'genesis/seeds.txt')) ? fs.readFileSync(path.join(ROOT, 'genesis/seeds.txt'), 'utf8') : '';
  const seeds = [...(opt('seeds') ? opt('seeds').split(',') : []), ...seedText.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))];
  const adv = opt('advertise') ? splitHostPort(opt('advertise')) : null;

  const node = new Node({
    genesisFile, paramOverrides,
    datadir: path.resolve(opt('datadir', path.join(os.homedir(), '.psyrob'))),
    p2pHost: opt('p2p-host', '0.0.0.0'), p2pPort: flag('no-listen') ? 0 : Number(opt('p2p-port', 39870)), seeds,
    advertise: adv ? { host: adv[0], port: adv[1] } : null,
    httpHost: opt('http-host', '127.0.0.1'), httpPort: Number(opt('http-port', 8770)),
    // the release packages to offer on /run-a-node: --downloads, else dist/downloads of this checkout when it was built
    // there (npm run release; the public node), else none
    downloadsDir: opt('downloads') ? path.resolve(opt('downloads'))
      : !IN_SEA && fs.existsSync(path.join(ROOT, 'dist/downloads/manifest.json')) ? path.join(ROOT, 'dist/downloads') : null,
    vhosts: opt('http-vhosts') ? opt('http-vhosts').split(',').map((s) => s.trim().toLowerCase()) : undefined,
    cors: opt('http-cors') ? opt('http-cors').split(',').map((s) => s.trim().toLowerCase()) : [],
    rpcRate: opt('rpc-rate', '200,50').split(',').map(Number),
    signerKeys: argv.flatMap((a, i) => (a === '--signer-key' && argv[i + 1] ? [readKey(argv[i + 1])] : [])),
    banLocal: !flag('no-ban-local'),
  });

  node.start().catch((e) => { console.error('start failed:', e.message); process.exit(1); });
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, async () => {
      if (stopping) return;
      stopping = true;
      console.log('stopping…');
      await node.stop().catch(() => {});
      process.exit(0);
    });
  }
}
