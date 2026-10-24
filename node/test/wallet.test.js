import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BIN = new URL('../bin/psyrob-wallet.js', import.meta.url).pathname;
const run = (...args) => execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

test('wallet: new key file (0600, address only), address, calldata, contracts; refuses to overwrite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-w-'));
  const f = path.join(dir, 'k.key');
  const out = run('new', '--out', f);
  assert.match(out, /^address 0x[0-9a-f]{40}/);
  assert.match(out, /cannot be recovered/);
  const key = fs.readFileSync(f, 'utf8').trim();
  assert.ok(!out.includes(key), 'the key is never printed');
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  assert.equal(run('address', '--key', f).trim(), out.split('\n')[0].slice(8));
  assert.throws(() => run('new', '--out', f), /exists/);
  const cd = run('calldata', 'Treasury', 'spend', '0x' + '11'.repeat(20), 'psy:5', 'audit');
  assert.match(cd, /^0x7070000000000000000000000000000000000008 0x[0-9a-f]+/);
  assert.match(run('contracts'), /NGORegistry 0x7070000000000000000000000000000000000002/);
  fs.unlinkSync(f);
  fs.rmdirSync(dir);
});
