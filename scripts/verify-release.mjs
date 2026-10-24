#!/usr/bin/env node
// Check a PSYROB release . Anyone can run it; nothing here needs a secret.
//
//   node scripts/verify-release.mjs <folder> [--key docs/RELEASE-KEY.pem] [--rebuilt <folder>]
//
// <folder> holds the downloads (SHA256SUMS.txt, SHA256SUMS.txt.sig and the packages, as served at /downloads/).
//   1. The signature SHA256SUMS.txt.sig must verify with the release key from the repository (not the copy next to
//      the downloads, which the same host serves).
//   2. Every file listed in SHA256SUMS.txt that is in the folder must have that SHA-256.
//   3. --rebuilt <folder>: a build of your own from the tagged commit (git checkout v10.x.y; npm ci; npm run release,
//      with the same Node.js version as manifest.json names) must give the same SHA256SUMS.txt: then the programs are
//      exactly the published source.
// For a node update plan (/upgrades): the plan's release hash must equal the SHA-256 of this SHA256SUMS.txt.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 ? args[i + 1] : d; };
const dir = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!dir) { console.error('usage: verify-release.mjs <folder> [--key docs/RELEASE-KEY.pem] [--rebuilt <folder>]'); process.exit(2); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const keyFile = opt('key', path.join(root, 'docs/RELEASE-KEY.pem'));
let failed = false;
const ok = (m) => console.log('ok    ' + m);
const bad = (m) => { console.log('FAIL  ' + m); failed = true; };

const sums = fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'));
console.log(`SHA-256 of SHA256SUMS.txt (compare with a node update plan): 0x${crypto.createHash('sha256').update(sums).digest('hex')}`);
try {
  const sig = Buffer.from(fs.readFileSync(path.join(dir, 'SHA256SUMS.txt.sig'), 'utf8').trim(), 'base64');
  if (crypto.verify(null, sums, crypto.createPublicKey(fs.readFileSync(keyFile)), sig)) ok(`signature of SHA256SUMS.txt with ${path.relative(process.cwd(), keyFile) || keyFile}`);
  else bad('the signature of SHA256SUMS.txt does not match the release key');
} catch (e) { bad('signature: ' + e.message); }

for (const line of sums.toString('utf8').trim().split('\n')) {
  const [hash, name] = line.split(/\s+/);
  const f = path.join(dir, name);
  if (!fs.existsSync(f)) { console.log(`skip  ${name} (not downloaded)`); continue; }
  const have = crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  if (have === hash) ok(name); else bad(`${name}: SHA-256 ${have}, the list says ${hash}`);
}

if (opt('rebuilt')) {
  const mine = fs.readFileSync(path.join(opt('rebuilt'), 'SHA256SUMS.txt'));
  if (mine.equals(sums)) ok('your own build gives the same SHA256SUMS.txt: the programs are the published source');
  else bad('your own build differs: check the Node.js version (manifest.json) and the commit');
}
process.exit(failed ? 1 : 0);
