#!/usr/bin/env node
// Build the downloadable programs (dist/downloads/), served by the explorer at /downloads/ and listed on /run-a-node.
//
//   npm run release
//
// For Linux (x64) and Windows (x64):
//   psyrob-node   the full node (explorer, JSON-RPC, P2P); a .tar.gz for Linux, a .zip for Windows
//   psyrob-miner  the miner with its control page in the browser; a .tar.gz and an Ubuntu .deb for Linux, an .exe for
//                 Windows (double-click)
// Each is a Node.js "single executable application": the official Node.js runtime (downloaded from nodejs.org and
// checked against its published SHA-256) with the bundled PSYROB code and its data files (genesis, contract
// artifacts, Argon2d WebAssembly, web pages) embedded. The official Windows runtime is signed by the Node.js project;
// injecting the PSYROB code would leave that signature invalid, so it is removed and the .exe is unsigned.
// SHA256SUMS.txt lists every file. The Linux programs are smoke-tested here; the Windows ones cannot be run here.
//
// no obfuscation and no minification, so the bundled code reads like the repository; the
// archives are reproducible (file times set to the commit time, entries sorted, owners zeroed, gzip without a
// timestamp), so anyone with the same Node.js version can rebuild them from the tagged commit and compare
// SHA256SUMS.txt (scripts/verify-release.mjs); and SHA256SUMS.txt is signed with the release key
// (PSYROB_RELEASE_KEY = path of an Ed25519 private key, made with scripts/release-key.mjs) as SHA256SUMS.txt.sig.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import { build } from 'esbuild';
import { NODE_VERSION, TESTNET_CHAIN_ID, TESTNET_NAME, TESTNET_WALLET_NAME } from '../node/src/params.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = NODE_VERSION;
const CHAIN_ID = Number(TESTNET_CHAIN_ID);
const GENESIS_FILE = `genesis/genesis-${CHAIN_ID}.json`;
// reproducible: every time in the packages is the commit time (SOURCE_DATE_EPOCH, as Debian and others use it)
const EPOCH = Number(process.env.SOURCE_DATE_EPOCH || execFileSync('git', ['-C', path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), 'log', '-1', '--format=%ct'], { encoding: 'utf8' }).trim());
process.env.SOURCE_DATE_EPOCH = String(EPOCH);
const NODE = process.version; // the runtime must be the same version that writes the blob
const CACHE = path.join(ROOT, 'build/cache');
const WORK = path.join(ROOT, 'build/work');
const OUT = path.join(ROOT, 'dist/downloads');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const log = (...a) => console.log('[release]', ...a);
const sha256 = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

for (const d of [CACHE, WORK, OUT]) fs.mkdirSync(d, { recursive: true });
for (const f of fs.readdirSync(OUT)) fs.unlinkSync(path.join(OUT, f)); // only files this script wrote

// ---- 1. official runtimes, checked against nodejs.org SHASUMS256.txt
async function fetchTo(url, file) {
  if (fs.existsSync(file)) return;
  log('download', url);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  fs.writeFileSync(file + '.part', Buffer.from(await r.arrayBuffer()));
  fs.renameSync(file + '.part', file);
}
const base = `https://nodejs.org/dist/${NODE}`;
await fetchTo(`${base}/SHASUMS256.txt`, path.join(CACHE, `SHASUMS256-${NODE}.txt`));
const sums = Object.fromEntries(fs.readFileSync(path.join(CACHE, `SHASUMS256-${NODE}.txt`), 'utf8').trim().split('\n').map((l) => l.split(/\s+/).reverse()));
const runtimes = { linux: `node-${NODE}-linux-x64.tar.xz`, win: `node-${NODE}-win-x64.zip` };
for (const f of Object.values(runtimes)) {
  await fetchTo(`${base}/${f}`, path.join(CACHE, f));
  if (sha256(path.join(CACHE, f)) !== sums[f]) throw new Error(`${f}: SHA-256 does not match nodejs.org SHASUMS256.txt`);
}
log('runtimes verified against SHASUMS256.txt');
const linuxNode = path.join(WORK, 'node-linux');
const winNode = path.join(WORK, 'node-win.exe');
execFileSync('tar', ['-xJf', path.join(CACHE, runtimes.linux), '-C', WORK, `node-${NODE}-linux-x64/bin/node`]);
fs.copyFileSync(path.join(WORK, `node-${NODE}-linux-x64/bin/node`), linuxNode);
execFileSync('python3', ['-I', '-c', `import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); open(sys.argv[2],'wb').write(z.read('node-${NODE}-win-x64/node.exe'))`, path.join(CACHE, runtimes.win), winNode]);

// ---- 2. bundles: plain (not minified, not obfuscated), so the code inside the programs reads like the
// repository and can be compared with it
const bundle = (entry, out) => build({ entryPoints: [path.join(ROOT, entry)], outfile: path.join(WORK, out), bundle: true, platform: 'node', format: 'cjs', target: 'node22', logLevel: 'warning', legalComments: 'inline',
  minify: false, logOverride: { 'empty-import-meta': 'silent' } });
await bundle('node/bin/psyrob-node.js', 'psyrob-node.cjs');
await bundle('node/src/powworker.js', 'powworker.cjs');
await bundle('miner/bin/psyrob-miner-gui.js', 'psyrob-miner.cjs');
await bundle('miner/src/worker.js', 'worker.cjs');
log('bundled (plain, readable)');

// help texts from the header comments of the programs
const help = (file) => {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n');
  return src.slice(1, src.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n').replace(/node (node|miner)\/bin\/psyrob-(node|miner(-gui)?)\.js/g, 'psyrob-$2');
};
fs.mkdirSync(path.join(WORK, 'help'), { recursive: true });
fs.writeFileSync(path.join(WORK, 'help/psyrob-node.txt'), help('node/bin/psyrob-node.js'));
fs.writeFileSync(path.join(WORK, 'help/psyrob-miner.txt'), help('miner/bin/psyrob-miner-gui.js'));

// ---- 3. embedded data files (names = paths relative to the repository root, as common/resources.js reads them)
const common = ['common/pow-vectors.json', 'common/pow-wasm/argon2-simd.wasm', 'common/pow-wasm/argon2-ref.wasm'];
const web = [];
const walk = (d) => { for (const f of fs.readdirSync(path.join(ROOT, d))) { const r = d + '/' + f; fs.statSync(path.join(ROOT, r)).isDirectory() ? walk(r) : web.push(r); } };
walk('node/web');
const assets = {
  node: Object.fromEntries([...common, ...web, 'common/abicodec.js', 'genesis/artifacts.json', GENESIS_FILE, 'genesis/seeds.txt'].map((r) => [r, path.join(ROOT, r)])
    .concat([['help/psyrob-node.txt', path.join(WORK, 'help/psyrob-node.txt')], ['node/powworker.cjs', path.join(WORK, 'powworker.cjs')]])),
  // the miner's dashboard shows the PSYROB fonts, icons and logo (miner/gui/assets.js serves them)
  miner: Object.fromEntries([...common, ...web.filter((r) => /^node\/web\/(sprite\.svg|logo\.svg|vendor\/fonts\/.+\.woff2)$/.test(r))].map((r) => [r, path.join(ROOT, r)]).concat([['miner/worker.cjs', path.join(WORK, 'worker.cjs')], ['help/psyrob-miner.txt', path.join(WORK, 'help/psyrob-miner.txt')]])),
};

// ---- 4. blobs and executables
/** Remove the Authenticode signature of a Windows executable (the security data directory and the appended data). */
function stripSignature(file) {
  const b = fs.readFileSync(file);
  const pe = b.readUInt32LE(0x3c);
  if (b.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('not a PE file');
  const opt = pe + 24;
  const magic = b.readUInt16LE(opt);
  const dirs = opt + (magic === 0x20b ? 112 : 96);
  const sec = dirs + 4 * 8;
  const at = b.readUInt32LE(sec), size = b.readUInt32LE(sec + 4);
  if (!size) return b;
  if (at + size < b.length - 8) throw new Error('the signature is not at the end of the file');
  b.writeUInt32LE(0, sec); b.writeUInt32LE(0, sec + 4); b.writeUInt32LE(0, opt + 64); // no signature, no checksum
  fs.writeFileSync(file, b.subarray(0, at));
  return null;
}
async function makeExe(name, runtime, out) {
  const cfg = path.join(WORK, `${name}.sea.json`), blob = path.join(WORK, `${name}.blob`);
  fs.writeFileSync(cfg, JSON.stringify({ main: path.join(WORK, `${name}.cjs`), output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets: assets[name === 'psyrob-node' ? 'node' : 'miner'] }));
  execFileSync(process.execPath, ['--experimental-sea-config', cfg], { stdio: 'inherit' });
  fs.copyFileSync(runtime, out);
  if (out.endsWith('.exe')) stripSignature(out);
  // postject in its own process each time: it holds the whole executable in WebAssembly memory (~600 MB)
  execFileSync(process.execPath, [path.join(ROOT, 'node_modules/postject/dist/cli.js'), out, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE, '--overwrite'], { stdio: ['ignore', 'ignore', 'inherit'] });
  if (!out.endsWith('.exe')) fs.chmodSync(out, 0o755);
}
const bin = path.join(WORK, 'bin');
fs.mkdirSync(bin, { recursive: true });
await makeExe('psyrob-node', linuxNode, path.join(bin, 'psyrob-node'));
await makeExe('psyrob-miner', linuxNode, path.join(bin, 'psyrob-miner'));
await makeExe('psyrob-node', winNode, path.join(bin, 'psyrob-node.exe'));
await makeExe('psyrob-miner', winNode, path.join(bin, 'psyrob-miner.exe'));
log('executables built');

// ---- 5. smoke tests of the Linux programs (no mining)
const genesis = JSON.parse(fs.readFileSync(path.join(ROOT, GENESIS_FILE), 'utf8')).hash;
log(execFileSync(path.join(bin, 'psyrob-miner'), ['--self-test'], { encoding: 'utf8' }).trim());
if (!/full node/i.test(execFileSync(path.join(bin, 'psyrob-node'), ['--help'], { encoding: 'utf8' }))) throw new Error('psyrob-node --help');
// start the node on a throwaway datadir and check it serves /health and the pages (exercises the bundle)
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-smoke-'));
  const child = spawn(path.join(bin, 'psyrob-node'), ['--datadir', home, '--no-default-seeds', '--no-listen', '--http-port', '18791'], { stdio: 'ignore' });
  try {
    let health = null;
    for (let i = 0; i < 60; i++) { try { health = await (await fetch('http://127.0.0.1:18791/health')).json(); break; } catch { await sleep(1000); } }
    if (!health || health.genesis !== genesis) throw new Error('node /health: ' + JSON.stringify(health));
    for (const p of ['/', '/run-a-node', '/emission', '/mining', '/metrics', '/committee', '/dag', '/blocks', '/about', '/network', '/register/miner', '/register/ngo']) {
      const r = await fetch('http://127.0.0.1:18791' + p);
      if (!r.ok) throw new Error(`node page ${p}: HTTP ${r.status}`);
    }
    log('smoke test: the node serves /health and all pages');
  } finally { child.kill('SIGTERM'); fs.rmSync(home, { recursive: true, force: true }); }
}

// ---- 6. packages
const readme = (os, what) => {
  const exe = os === 'win' ? '.exe' : '';
  return `${TESTNET_WALLET_NAME} (chain ${CHAIN_ID}, 0x${CHAIN_ID.toString(16)}), ${what} ${VERSION} for ${os === 'win' ? 'Windows' : 'Linux'} x64
Genesis hash: ${genesis}

${what === 'node' ? `Start: ${os === 'win' ? 'double-click Start-PSYROB-node.bat' : './psyrob-node'}
The node follows the public network through wss://rpc.psyrob.com/p2p (no port forwarding needed) and serves your own
explorer and JSON-RPC on http://127.0.0.1:8770 (options: psyrob-node${exe} --help). Data: ${os === 'win' ? '%USERPROFILE%\\.psyrob' : '~/.psyrob'}.
Check: http://127.0.0.1:8770/health must show the genesis hash above.` : `Start: ${os === 'win' ? 'double-click psyrob-miner.exe' : './psyrob-miner'}
It opens the miner's control page in your browser (this computer only). Create or import a wallet (stored encrypted
with your password), back up the key (a lost key cannot be recovered), choose the threads and press Start. Use at most
as many threads as your PC has physical cores, and leave one free if a node runs on the same PC. It mines through
https://rpc.psyrob.com unless you set your own nodes. Self-test: psyrob-miner${exe} --self-test`}

These programs contain the Node.js runtime (MIT licence, https://nodejs.org) and the PSYROB code, not encrypted, not
obfuscated. Verify the download against SHA256SUMS.txt on https://explorer.psyrob.com/run-a-node, and SHA256SUMS.txt
against its signature SHA256SUMS.txt.sig and the release key (release-key.pem, also in the repository's docs/).
${os === 'win' ? '\nWindows may say "Windows protected your PC" because the program is not signed: choose "More info", then "Run anyway".\n' : ''}`;
};
const stage = (dir) => { const d = path.join(WORK, 'pkg', dir); fs.mkdirSync(d, { recursive: true }); return d; };
// reproducible archives: sorted entries, owner 0, every time = the commit time, gzip without its own timestamp
const touchAll = (dir) => { for (const f of fs.readdirSync(dir, { recursive: true })) { const p = path.join(dir, f); if (!fs.lstatSync(p).isSymbolicLink()) fs.utimesSync(p, EPOCH, EPOCH); } fs.utimesSync(dir, EPOCH, EPOCH); };
const tgz = (dir, out) => { touchAll(dir); execFileSync('tar', ['--sort=name', `--mtime=@${EPOCH}`, '--owner=0', '--group=0', '--numeric-owner', '--use-compress-program=gzip -n -9', '-cf', path.join(OUT, out), '-C', path.dirname(dir), path.basename(dir)]); };
const zip = (dir, out) => execFileSync('python3', ['-I', '-c', 'import zipfile,os,sys,time\nd,o,e=sys.argv[1],sys.argv[2],int(sys.argv[3])\nt=time.gmtime(e)[:6]\nwith zipfile.ZipFile(o,"w",zipfile.ZIP_DEFLATED) as z:\n for r,ds,fs_ in sorted(os.walk(d)):\n  ds.sort()\n  for f in sorted(fs_):\n   p=os.path.join(r,f); i=zipfile.ZipInfo(os.path.relpath(p, os.path.dirname(d)),t); i.compress_type=zipfile.ZIP_DEFLATED; i.external_attr=0o644<<16\n   z.writestr(i, open(p,"rb").read())', dir, path.join(OUT, out), String(EPOCH)]);

let d = stage(`psyrob-node-${VERSION}-linux-x64`);
fs.copyFileSync(path.join(bin, 'psyrob-node'), path.join(d, 'psyrob-node')); fs.chmodSync(path.join(d, 'psyrob-node'), 0o755);
fs.writeFileSync(path.join(d, 'README.txt'), readme('linux', 'node'));
tgz(d, `psyrob-node-${VERSION}-linux-x64.tar.gz`);
d = stage(`psyrob-miner-${VERSION}-linux-x64`);
fs.copyFileSync(path.join(bin, 'psyrob-miner'), path.join(d, 'psyrob-miner')); fs.chmodSync(path.join(d, 'psyrob-miner'), 0o755);
fs.writeFileSync(path.join(d, 'README.txt'), readme('linux', 'miner'));
tgz(d, `psyrob-miner-${VERSION}-linux-x64.tar.gz`);
d = stage(`psyrob-node-${VERSION}-windows-x64`);
fs.copyFileSync(path.join(bin, 'psyrob-node.exe'), path.join(d, 'psyrob-node.exe'));
fs.writeFileSync(path.join(d, 'Start-PSYROB-node.bat'), `@echo off\r\nREM ${TESTNET_NAME} node: follows the public network over wss://rpc.psyrob.com/p2p. Close this window to stop.\r\ncd /d "%~dp0"\r\npsyrob-node.exe --no-listen\r\npause\r\n`);
fs.writeFileSync(path.join(d, 'README.txt'), readme('win', 'node').replace(/\n/g, '\r\n'));
zip(d, `psyrob-node-${VERSION}-windows-x64.zip`);
fs.copyFileSync(path.join(bin, 'psyrob-miner.exe'), path.join(OUT, `psyrob-miner-${VERSION}-windows-x64.exe`));
fs.utimesSync(path.join(OUT, `psyrob-miner-${VERSION}-windows-x64.exe`), EPOCH, EPOCH);

// Ubuntu .deb for the miner: installs to /opt/psyrob-miner with a menu entry
d = stage(`deb/psyrob-miner_${VERSION}_amd64`);
for (const sub of ['DEBIAN', 'opt/psyrob-miner', 'usr/bin', 'usr/share/applications', 'usr/share/icons/hicolor/scalable/apps']) fs.mkdirSync(path.join(d, sub), { recursive: true });
fs.copyFileSync(path.join(bin, 'psyrob-miner'), path.join(d, 'opt/psyrob-miner/psyrob-miner')); fs.chmodSync(path.join(d, 'opt/psyrob-miner/psyrob-miner'), 0o755);
fs.writeFileSync(path.join(d, 'opt/psyrob-miner/README.txt'), readme('linux', 'miner'));
try { fs.unlinkSync(path.join(d, 'usr/bin/psyrob-miner')); } catch { /* first build */ } // a link: existsSync follows it
fs.symlinkSync('/opt/psyrob-miner/psyrob-miner', path.join(d, 'usr/bin/psyrob-miner'));
fs.copyFileSync(path.join(ROOT, 'node/web/logo.svg'), path.join(d, 'usr/share/icons/hicolor/scalable/apps/psyrob-miner.svg'));
fs.writeFileSync(path.join(d, 'usr/share/applications/psyrob-miner.desktop'), `[Desktop Entry]\nType=Application\nName=PSYROB Miner\nComment=Mine PSY on the ${TESTNET_WALLET_NAME} (opens the control page in your browser)\nExec=/opt/psyrob-miner/psyrob-miner\nIcon=psyrob-miner\nTerminal=false\nCategories=Network;\n`);
const size = Math.ceil(fs.statSync(path.join(bin, 'psyrob-miner')).size / 1024);
fs.writeFileSync(path.join(d, 'DEBIAN/control'), `Package: psyrob-miner\nVersion: ${VERSION}\nArchitecture: amd64\nMaintainer: PSYROB <noreply@psyrob.com>\nInstalled-Size: ${size}\nDepends: xdg-utils\nSection: net\nPriority: optional\nHomepage: https://explorer.psyrob.com/run-a-node\nDescription: ${TESTNET_WALLET_NAME} miner\n Mines PSY on the ${TESTNET_WALLET_NAME} (chain ${CHAIN_ID}) with Argon2d. Double-click "PSYROB Miner" in the\n applications: the control page opens in the browser (this computer only).\n`);
touchAll(d);
execFileSync('dpkg-deb', ['--root-owner-group', '-Zxz', '--build', d, path.join(OUT, `psyrob-miner_${VERSION}_amd64.deb`)], { stdio: 'pipe', env: { ...process.env, SOURCE_DATE_EPOCH: String(EPOCH) } });

// ---- 7. checksums and the manifest read by the explorer
const files = fs.readdirSync(OUT).filter((f) => !f.endsWith('.txt') && f !== 'manifest.json').sort();
const kind = (f) => ({ os: /windows/.test(f) ? 'Windows' : 'Linux', program: /node/.test(f) ? 'node' : 'miner', type: f.endsWith('.deb') ? 'Ubuntu package (.deb)' : f.endsWith('.exe') ? 'program (.exe)' : f.endsWith('.zip') ? 'archive (.zip)' : 'archive (.tar.gz)' });
const list = files.map((f) => ({ name: f, ...kind(f), bytes: fs.statSync(path.join(OUT, f)).size, sha256: sha256(path.join(OUT, f)) }));
fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt'), list.map((x) => `${x.sha256}  ${x.name}`).join('\n') + '\n');
// the release signature: Ed25519 over SHA256SUMS.txt with the release key (never printed; only its public part is
// published, as release-key.pem next to the downloads and docs/RELEASE-KEY.pem in the repository)
let signed = false;
if (process.env.PSYROB_RELEASE_KEY) {
  const sk = crypto.createPrivateKey(fs.readFileSync(process.env.PSYROB_RELEASE_KEY));
  const sums = fs.readFileSync(path.join(OUT, 'SHA256SUMS.txt'));
  fs.writeFileSync(path.join(OUT, 'SHA256SUMS.txt.sig'), crypto.sign(null, sums, sk).toString('base64') + '\n');
  fs.writeFileSync(path.join(OUT, 'release-key.pem'), crypto.createPublicKey(sk).export({ type: 'spki', format: 'pem' }));
  if (!crypto.verify(null, sums, crypto.createPublicKey(sk), Buffer.from(fs.readFileSync(path.join(OUT, 'SHA256SUMS.txt.sig'), 'utf8'), 'base64'))) throw new Error('release signature does not verify');
  signed = true;
  log('SHA256SUMS.txt signed (SHA256SUMS.txt.sig, release-key.pem)');
} else log('SHA256SUMS.txt NOT signed: set PSYROB_RELEASE_KEY to the release key file to sign it');
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ version: VERSION, node: NODE, chainId: CHAIN_ID, genesis, built: new Date(EPOCH * 1000).toISOString(), signed, files: list }, null, 1) + '\n');
for (const x of list) log(`${x.name}  ${(x.bytes / 1e6).toFixed(1)} MB  ${x.sha256}`);
