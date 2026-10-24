#!/usr/bin/env node
// The release key : an Ed25519 key that signs SHA256SUMS.txt of every release, so a
// download can be checked against a key published in the repository (docs/RELEASE-KEY.pem), not only against a list
// served by the same host as the files.
//
//   node scripts/release-key.mjs new --out <file>     make a key: the private key goes to <file> (mode 0600, never
//                                                      printed); the public key is printed, to publish
//   node scripts/release-key.mjs public --key <file>  print the public key of an existing key file
import fs from 'node:fs';
import crypto from 'node:crypto';

const [cmd, ...rest] = process.argv.slice(2);
const opt = (n) => { const i = rest.indexOf('--' + n); return i >= 0 ? rest[i + 1] : undefined; };

if (cmd === 'new' && opt('out')) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(opt('out'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' }); // never overwrites
  process.stdout.write(publicKey.export({ type: 'spki', format: 'pem' }));
} else if (cmd === 'public' && opt('key')) {
  process.stdout.write(crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(opt('key')))).export({ type: 'spki', format: 'pem' }));
} else {
  console.error('usage: release-key.mjs new --out <file> | public --key <file>');
  process.exit(2);
}
