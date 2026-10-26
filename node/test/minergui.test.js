// PSYROB Miner control page (miner/bin/psyrob-miner-gui.js), from the source tree and without mining: access
// control (token, host), the wallet (encrypted with a password, owner-only, never logged, revealed only after
// confirmation and the password, never overwritten; an old plain wallet.key is protected on request; password change
// and lock), settings validation (a list of nodes, page preferences), the app password (sign in and out, wrong
// passwords slowed down), the node test, the dashboard page in every language, and the self-test of Argon2d and the
// worker threads.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';

const BIN = new URL('../../miner/bin/psyrob-miner-gui.js', import.meta.url).pathname;

function req(port, p, { method = 'GET', token, session, host = `127.0.0.1:${port}`, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: host, 'Content-Type': 'application/json', ...(token ? { 'X-Token': token } : {}), ...(session ? { 'X-Session': session } : {}) } }, (res) => {
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
    // brand assets (icons, logo, fonts) load without the token; nothing else does
    const sprite = await req(port, '/assets/sprite.svg');
    assert.equal(sprite.code, 200);
    assert.match(sprite.body, /id="prb-wallet"/);
    assert.equal((await req(port, '/assets/logo.svg')).code, 200);
    assert.equal((await req(port, '/assets/fonts/barlow-condensed-latin-600-normal.woff2')).code, 200);
    assert.notEqual((await req(port, '/assets/../wallet.json')).code, 200, 'no path tricks');
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

async function startGui(home) {
  const child = spawn(process.execPath, [BIN, '--no-browser', '--home', home], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100 && !/\?t=[0-9a-f]+/.test(out); i++) await new Promise((r) => setTimeout(r, 100));
  const [, port, token] = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]+)/.exec(out).map((x, i) => (i === 1 ? Number(x) : x));
  return { child, port, token, out: () => out };
}

test('miner GUI: app password, sign in and out, preferences, wallet password change and lock, node test, history', { timeout: 90_000 }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-gui-'));
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ nodes: ['http://127.0.0.1:9'], threads: 1 }));
  const g = await startGui(home);
  const { port, token } = g;
  const post = (p, body, session) => req(port, p, { method: 'POST', token, session, body });
  try {
    // no app password: everything answers, the dashboard says so
    let app = JSON.parse((await req(port, '/api/app', { token })).body);
    assert.deepEqual([app.protected, app.signedIn], [false, true]);
    assert.equal((await req(port, '/api/state', { token })).code, 200);
    // set it: the answer carries a session; other pages are signed out
    assert.equal((await post('/api/app/password', { next: 'short' })).code, 400, 'at least 8 characters');
    const { session } = JSON.parse((await post('/api/app/password', { next: 'app secret 1' })).body);
    assert.match(session, /^[0-9a-f]{36}$/);
    assert.equal(fs.statSync(path.join(home, 'app.json')).mode & 0o777, 0o600);
    assert.ok(!fs.readFileSync(path.join(home, 'app.json'), 'utf8').includes('app secret 1'), 'only a scrypt hash is stored');
    assert.equal((await req(port, '/api/state', { token })).code, 401, 'signed out without the session');
    assert.equal((await post('/api/start', {})).code, 401, 'nothing can be changed while signed out');
    assert.equal((await post('/api/quit', {})).code, 401);
    app = JSON.parse((await req(port, '/api/app', { token })).body);
    assert.deepEqual([app.protected, app.signedIn], [true, false]);
    assert.equal((await req(port, '/api/state', { token, session })).code, 200);
    // sign in: a wrong password is refused, five in a row wait 30 s
    assert.equal((await post('/api/app/login', { password: 'nope nope' })).code, 400);
    for (let i = 0; i < 4; i++) await post('/api/app/login', { password: 'nope nope' });
    assert.equal((await post('/api/app/login', { password: 'app secret 1' })).code, 429, 'too many wrong passwords');
    // log out ends that session only
    await post('/api/app/logout', {}, session);
    assert.equal((await req(port, '/api/state', { token, session })).code, 401);
    // a restart signs everybody out and ends the 30 s wait
    await post('/api/quit', {}, session).catch(() => {});
    g.child.kill('SIGTERM');
    await new Promise((r) => g.child.once('exit', r));
    const h = await startGui(home);
    const p2 = (p, body, s) => req(h.port, p, { method: 'POST', token: h.token, session: s, body });
    try {
      const s2 = JSON.parse((await p2('/api/app/login', { password: 'app secret 1' })).body).session;
      assert.ok(s2);
      // page preferences: validated and saved (they may change while mining)
      assert.equal((await p2('/api/prefs', { lang: 'xx' }, s2)).code, 400);
      assert.equal((await p2('/api/prefs', { theme: 'pink' }, s2)).code, 400);
      assert.equal((await p2('/api/prefs', { autoLockMinutes: 7 }, s2)).code, 400);
      assert.equal((await p2('/api/prefs', { explorer: 'javascript:alert(1)' }, s2)).code, 400);
      assert.equal((await p2('/api/prefs', { lang: 'zh-TW', theme: 'light', autoLockMinutes: 15, autoStart: true, explorer: 'https://explorer.example.org/' }, s2)).code, 200);
      const saved = JSON.parse(fs.readFileSync(path.join(home, 'settings.json'), 'utf8'));
      assert.deepEqual([saved.lang, saved.theme, saved.autoLockMinutes, saved.autoStart, saved.explorer], ['zh-TW', 'light', 15, true, 'https://explorer.example.org']);
      const html = (await req(h.port, '/?t=' + h.token)).body;
      assert.match(html, /<html lang="zh-TW" dir="ltr" data-theme="light">/, 'the page opens in the saved language and theme');
      // wallet: change its password, lock it
      await p2('/api/prefs', { autoStart: false }, s2);
      await p2('/api/wallet/new', { password: 'wallet pw 1' }, s2);
      assert.equal((await p2('/api/wallet/password', { current: 'wrong one!', next: 'wallet pw 2' }, s2)).code, 400);
      assert.equal((await p2('/api/wallet/password', { current: 'wallet pw 1', next: 'short' }, s2)).code, 400);
      assert.equal((await p2('/api/wallet/password', { current: 'wallet pw 1', next: 'wallet pw 2' }, s2)).code, 200);
      assert.equal(fs.statSync(path.join(home, 'wallet.json')).mode & 0o777, 0o600);
      assert.equal((await p2('/api/wallet/lock', {}, s2)).code, 200);
      let st = JSON.parse((await req(h.port, '/api/state', { token: h.token, session: s2 })).body);
      assert.equal(st.wallet, 'locked');
      assert.equal((await p2('/api/wallet/unlock', { password: 'wallet pw 1' }, s2)).code, 400, 'the old password no longer opens it');
      assert.equal((await p2('/api/wallet/unlock', { password: 'wallet pw 2' }, s2)).code, 200);
      // the node test reports an unreachable node without changing the settings
      assert.equal((await p2('/api/nodes/test', { url: 'file:///etc/passwd' }, s2)).code, 400);
      const tr = JSON.parse((await p2('/api/nodes/test', { url: 'http://127.0.0.1:9' }, s2)).body);
      assert.equal(tr.ok, false);
      // the dashboard state and the history
      st = JSON.parse((await req(h.port, '/api/state', { token: h.token, session: s2 })).body);
      for (const k of ['rateNow', 'threads', 'totals', 'live', 'blocks', 'estimate', 'job', 'appProtected']) assert.ok(k in st, k);
      const hist = JSON.parse((await req(h.port, '/api/history?range=24h', { token: h.token, session: s2 })).body);
      assert.equal(hist.range, '24h');
      assert.ok(hist.points.length >= 100 && hist.points.length <= 130);
      // remove the app password (the current one is needed)
      assert.equal((await p2('/api/app/password', { current: 'wrong one!', next: '' }, s2)).code, 400);
      assert.equal((await p2('/api/app/password', { current: 'app secret 1', next: '' }, s2)).code, 200);
      assert.equal(fs.existsSync(path.join(home, 'app.json')), false);
      assert.equal((await req(h.port, '/api/state', { token: h.token })).code, 200, 'open again without a session');
      assert.ok(!h.out().includes('app secret') && !h.out().includes('wallet pw'), 'no password in the log');
      await p2('/api/quit', {});
      await new Promise((r) => h.child.once('exit', r));
    } finally { if (h.child.exitCode === null) h.child.kill('SIGTERM'); }
  } finally {
    if (g.child.exitCode === null) g.child.kill('SIGTERM');
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('miner GUI: the dashboard page in every language (complete texts, direction, nothing that closes the script)', async () => {
  const { page, STRINGS, LANG_CODES } = await import('../../miner/gui/page.js');
  const { LANGS, pickLang } = await import('../../common/langs.js');
  const keys = Object.keys(STRINGS.en);
  for (const c of LANG_CODES) {
    assert.deepEqual(Object.keys(STRINGS[c]).sort(), keys.slice().sort(), c + ' has every text');
    for (const k of keys) assert.equal([...String(STRINGS[c][k]).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(), [...String(STRINGS.en[k]).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(), `${c}.${k}: the same placeholders`);
    const html = page({ lang: c, theme: 'system' });
    assert.match(html, new RegExp(`<html lang="${c}" dir="${LANGS.find((l) => l.code === c).dir}">`));
    const js = html.split('<script>')[1].split('</script>')[0];
    assert.doesNotThrow(() => new Function(js), 'the inline script parses');
  }
  assert.equal(page({ lang: 'ar' }).includes('dir="rtl"'), true);
  assert.equal(page({}).split('<script>').length, 2, 'one script, no </script> inside the texts');
  assert.deepEqual(['de-AT', 'zh-HK', 'zh', 'pt-BR', 'xx', 'ar-EG'].map((p) => pickLang([p])), ['de', 'zh-TW', 'zh-CN', 'pt', 'en', 'ar']);
});
