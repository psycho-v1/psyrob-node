// PSYROB Miner control page (miner/bin/psyrob-miner-gui.js), from the source tree and without mining: access
// control (token, host), the wallet (encrypted with a password, owner-only, never logged, revealed only after
// confirmation and the password, never overwritten; an old plain wallet.key is protected on request), settings
// validation (a list of nodes), and the self-test of Argon2d and the worker threads.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

const BIN = new URL('../../miner/bin/psyrob-miner-gui.js', import.meta.url).pathname;

function req(port, p, { method = 'GET', token, host = `127.0.0.1:${port}`, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: host, 'Content-Type': 'application/json', ...(token ? { 'X-Token': token } : {}) } }, (res) => {
      let s = ''; res.on('data', (d) => { s += d; }); res.on('end', () => resolve({ code: res.statusCode, body: s, headers: res.headers }));
    });
    r.on('error', reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

test('miner GUI: self-test passes (Argon2d and worker threads)', { timeout: 60_000 }, () => {
  const out = execFileSync(process.execPath, [BIN, '--self-test'], { encoding: 'utf8' });
  assert.match(out, /self-test passed: Argon2d \(.*\) and worker threads/);
});

test('miner GUI: token and host checks, wallet handling, settings, no key in the log', { timeout: 60_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-gui-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ node: 'http://127.0.0.1:9', threads: 1 })); // no node: nothing is mined
  const child = spawn(process.execPath, [BIN, '--no-browser', '--home', home], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 100 && !/\?t=[0-9a-f]+/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    const m = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]+)/.exec(out);
    assert.ok(m, 'the control page address is printed: ' + out);
    const [port, token] = [Number(m[1]), m[2]];
    // access control
    assert.equal((await req(port, '/')).code, 403, 'no token');
    assert.equal((await req(port, '/?t=' + token)).code, 200);
    assert.equal((await req(port, '/?t=' + token, { host: 'evil.example' })).code, 403, 'DNS rebinding: wrong Host');
    assert.equal((await req(port, '/api/state')).code, 403, 'API without token');
    assert.match((await req(port, '/?t=' + token)).headers['content-security-policy'], /default-src 'none'/);
    // wallet: encrypted with a password
    let st = JSON.parse((await req(port, '/api/state', { token })).body);
    assert.equal(st.address, null);
    assert.equal(st.wallet, 'none');
    assert.equal((await req(port, '/api/wallet/new', { method: 'POST', token, body: { password: 'short' } })).code, 400, 'a password of at least 8 characters');
    const created = JSON.parse((await req(port, '/api/wallet/new', { method: 'POST', token, body: { password: 'correct horse' } })).body);
    assert.match(created.address, /^0x[0-9a-f]{40}$/);
    const walletFile = path.join(home, 'wallet.json');
    assert.equal(fs.statSync(walletFile).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(home, 'wallet.key')), false, 'no plain key file');
    assert.equal((await req(port, '/api/wallet/new', { method: 'POST', token, body: { password: 'correct horse' } })).code, 409, 'never overwrites a wallet');
    assert.equal((await req(port, '/api/wallet/import', { method: 'POST', token, body: { key: '11'.repeat(32), password: 'correct horse' } })).code, 409);
    assert.equal((await req(port, '/api/wallet/reveal', { method: 'POST', token, body: { password: 'correct horse' } })).code, 400, 'reveal needs the confirmation');
    assert.equal((await req(port, '/api/wallet/reveal', { method: 'POST', token, body: { confirm: 'I will keep it secret', password: 'wrong one!' } })).code, 400, 'and the password');
    const key = JSON.parse((await req(port, '/api/wallet/reveal', { method: 'POST', token, body: { confirm: 'I will keep it secret', password: 'correct horse' } })).body).key.slice(2);
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(!fs.readFileSync(walletFile, 'utf8').includes(key), 'the file holds only the encrypted key');
    const { decryptKey } = await import('../../miner/src/wallet.js');
    assert.equal(Buffer.from(decryptKey(JSON.parse(fs.readFileSync(walletFile, 'utf8')), 'correct horse')).toString('hex'), key);
    assert.throws(() => decryptKey(JSON.parse(fs.readFileSync(walletFile, 'utf8')), 'wrong one!'), /wrong password/);
    // settings: a list of nodes
    assert.equal((await req(port, '/api/settings', { method: 'POST', token, body: { nodes: 'javascript:alert(1)', threads: 1 } })).code, 400);
    assert.equal((await req(port, '/api/settings', { method: 'POST', token, body: { nodes: 'http://127.0.0.1:9\nhttp://127.0.0.1:10', threads: 9999 } })).code, 200);
    st = JSON.parse((await req(port, '/api/state', { token })).body);
    assert.ok(st.settings.threads <= st.cpus && st.settings.threads >= 1);
    assert.deepEqual(st.settings.nodes, ['http://127.0.0.1:9', 'http://127.0.0.1:10']);
    // with no node, start fails cleanly and nothing mines
    assert.equal((await req(port, '/api/start', { method: 'POST', token, body: {} })).code, 500);
    assert.equal(JSON.parse((await req(port, '/api/state', { token })).body).mining, false);
    assert.ok(!out.includes(key) && !JSON.stringify(st.logs).includes(key), 'the key is never logged');
    assert.equal((await req(port, '/api/quit', { method: 'POST', token, body: {} })).code, 200);
    await new Promise((r) => child.once('exit', r));
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('miner GUI: an old plain wallet.key is detected and protected with a password on request', { timeout: 60_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-gui-'));
  const plain = '22'.repeat(32);
  fs.writeFileSync(path.join(home, 'wallet.key'), plain + '\n', { mode: 0o600 });
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ node: 'http://127.0.0.1:9', threads: 1 })); // a 9.x settings file
  const child = spawn(process.execPath, [BIN, '--no-browser', '--home', home], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 100 && !/\?t=[0-9a-f]+/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
    const [, port, token] = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]+)/.exec(out).map((x, i) => (i === 1 ? Number(x) : x));
    let st = JSON.parse((await req(port, '/api/state', { token })).body);
    assert.equal(st.wallet, 'unprotected');
    assert.deepEqual(st.settings.nodes, ['http://127.0.0.1:9'], 'the old single node setting is kept');
    assert.equal((await req(port, '/api/wallet/protect', { method: 'POST', token, body: { password: 'correct horse' } })).code, 200);
    assert.equal(fs.existsSync(path.join(home, 'wallet.key')), false, 'the plain file is gone');
    st = JSON.parse((await req(port, '/api/state', { token })).body);
    assert.equal(st.wallet, 'unlocked');
    assert.ok(!out.includes(plain), 'the key is never logged');
    await req(port, '/api/quit', { method: 'POST', token, body: {} });
    await new Promise((r) => child.once('exit', r));
    // after a restart the wallet is locked until the password is given
    const again = spawn(process.execPath, [BIN, '--no-browser', '--home', home], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out2 = '';
    again.stdout.on('data', (d) => { out2 += d; });
    try {
      for (let i = 0; i < 100 && !/\?t=[0-9a-f]+/.test(out2); i++) await new Promise((r) => setTimeout(r, 100));
      const [, p2, t2] = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]+)/.exec(out2).map((x, i) => (i === 1 ? Number(x) : x));
      assert.equal(JSON.parse((await req(p2, '/api/state', { token: t2 })).body).wallet, 'locked');
      assert.equal((await req(p2, '/api/start', { method: 'POST', token: t2, body: {} })).code, 500, 'no mining while locked');
      assert.equal((await req(p2, '/api/wallet/unlock', { method: 'POST', token: t2, body: { password: 'nope nope' } })).code, 400);
      assert.equal((await req(p2, '/api/wallet/unlock', { method: 'POST', token: t2, body: { password: 'correct horse' } })).code, 200);
      assert.equal(JSON.parse((await req(p2, '/api/state', { token: t2 })).body).wallet, 'unlocked');
      await req(p2, '/api/quit', { method: 'POST', token: t2, body: {} });
      await new Promise((r) => again.once('exit', r));
    } finally { if (again.exitCode === null) again.kill('SIGTERM'); }
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM');
    fs.rmSync(home, { recursive: true, force: true });
  }
});
