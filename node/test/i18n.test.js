// Explorer languages (i18n.js): every dictionary covers keys.json with the same {placeholders} and HTML tags, every
// literal T('…') text is a key, pages carry lang/dir, the language menu and the browser texts, and the visitor's
// language comes from ?lang= (which sets the cookie), then the cookie, then Accept-Language.

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { testChain, key, mineOne } from './helpers.js';
import { DICTS, LANG_CODES, T, withLang, requestLang, locale } from '../src/i18n.js';
import { Explorer, clientKeysOf } from '../src/explorer.js';
import { Rpc } from '../src/rpc.js';
import { startHttp } from '../src/http.js';

const ROOT = new URL('../../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, ROOT), 'utf8');
const KEYS = JSON.parse(read('node/src/i18n/keys.json'));
const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
const tags = (s) => [...s.matchAll(/<\/?([a-z0-9]+)((?:\s+[a-z-]+="[^"]*")*)\s*\/?>/gi)].map((m) => m[0].replace(/\s+/g, ' ')).sort().join('');

test('i18n dictionaries: complete, nothing extra, same placeholders and tags as the English', () => {
  assert.deepEqual(Object.keys(DICTS).sort(), LANG_CODES.filter((c) => c !== 'en').sort());
  const keys = new Set(KEYS);
  for (const [code, d] of Object.entries(DICTS)) {
    assert.deepEqual(KEYS.filter((k) => !(k in d)), [], `${code}: missing texts`);
    assert.deepEqual(Object.keys(d).filter((k) => !keys.has(k)), [], `${code}: texts that are not keys`);
    for (const k of KEYS) {
      assert.equal(ph(d[k]), ph(k), `${code} placeholders: ${k}`);
      assert.equal(tags(d[k]), tags(k), `${code} tags: ${k}`);
      assert.ok(d[k].trim(), `${code} empty: ${k}`);
    }
  }
});

test('i18n keys: every literal T() text on the server and in the browser scripts is translated', () => {
  const keys = new Set(KEYS);
  const unq = (x) => x.replace(/\\(['\\])/g, '$1');
  const KEEP = new Set(['…']);
  for (const f of ['explorer.js', 'explorer-pages.js', 'explorer-governance.js', 'charts.js']) {
    for (const m of read('node/src/' + f).matchAll(/\bT\(\s*'((?:[^'\\\n]|\\.)*)'/g)) {
      const k = unq(m[1]);
      if (!KEEP.has(k)) assert.ok(keys.has(k), `${f}: T('${k}') is not in keys.json (run scripts/i18n-keys.mjs)`);
    }
  }
  const client = clientKeysOf(['app.js', 'register.js', 'pages.js', 'home-map.js'].map((f) => read('node/web/' + f)));
  assert.ok(client.length > 50, 'browser texts found');
  assert.deepEqual(client.filter((k) => !keys.has(k)), [], 'browser texts in keys.json');
});

test('i18n T(): fills placeholders, falls back to English, numbers per language', () => {
  assert.equal(withLang('de', () => T('{n}m ago', { n: 5 })), DICTS.de['{n}m ago'].replace('{n}', '5'));
  assert.equal(withLang('de', () => T('not a key {x}', { x: 1 })), 'not a key 1');
  assert.equal(withLang('en', () => T('{n}m ago', { n: 5 })), '5m ago');
  assert.equal(withLang('xx', () => locale()), 'en-US', 'unknown language is English');
  assert.equal(withLang('de', () => (1234.5).toLocaleString(locale())), '1.234,5');
  assert.equal(T('Search'), 'Search', 'outside a request: English');
});

test('i18n request language: ?lang= then cookie then Accept-Language', () => {
  const q = (s) => new URLSearchParams(s);
  assert.deepEqual(requestLang(q('lang=ko'), { cookie: 'lang=de', 'accept-language': 'ru' }), { code: 'ko', set: true });
  assert.deepEqual(requestLang(q('lang=xx'), { cookie: 'a=1; lang=de', 'accept-language': 'ru' }), { code: 'de', set: false });
  assert.deepEqual(requestLang(q(''), { cookie: 'lang=xx', 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.8' }), { code: 'pt', set: false });
  assert.equal(requestLang(q(''), { 'accept-language': 'zh-HK' }).code, 'zh-TW');
  assert.equal(requestLang(q(''), { 'accept-language': 'zh' }).code, 'zh-CN');
  assert.equal(requestLang(q(''), { 'accept-language': 'fr-FR' }).code, 'en');
  assert.equal(requestLang(q(''), {}).code, 'en');
});

test('i18n pages: lang and dir, language menu, browser texts, cookie and cache per language', { timeout: 120_000 }, async () => {
  const t = await testChain();
  await mineOne(t, key(1));
  const node = { chain: t.chain, params: t.params, mempool: t.mempool, p2p: null, finality: null, opts: { vhosts: ['*'] }, log: () => {} };
  node.rpc = new Rpc({ chain: t.chain, mempool: t.mempool, p2p: null, finality: null, node });
  const ex = new Explorer(node);
  for (const code of LANG_CODES) {
    const html = await withLang(code, () => ex.route('/', new URLSearchParams()), { path: '/', query: '' });
    const dir = code === 'ar' ? 'rtl' : 'ltr';
    assert.match(html, new RegExp(`<html lang="${code}" dir="${dir}">`), code);
    for (const c of LANG_CODES) assert.ok(html.includes(`hreflang="${c}"`), `${code}: menu has ${c}`);
    const texts = JSON.parse(/<script type="application\/json" id="psy-i18n">([^]*?)<\/script>/.exec(html)[1].replace(/\\u003c/g, '<'));
    if (code === 'en') assert.deepEqual(texts, {});
    else {
      assert.ok(Object.keys(texts).length > 50, `${code}: browser texts`);
      assert.ok(html.includes(DICTS[code]['Test network. No presale. Wallet loss is permanent.']), `${code}: banner translated`);
    }
  }

  const server = await startHttp({ node, host: '127.0.0.1', port: 0 });
  try {
    const port = server.address().port;
    const get = (path, headers = {}) => new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path, headers: { Host: 'explorer.psyrob.com', ...headers } }, (res) => {
        let body = ''; res.setEncoding('utf8'); res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ code: res.statusCode, headers: res.headers, body }));
      }).on('error', reject);
    });
    const chosen = await get('/governance?lang=nl', { 'Accept-Language': 'de' });
    assert.equal(chosen.code, 200);
    assert.match(chosen.headers['set-cookie']?.[0] ?? '', /^lang=nl; Path=\/; Max-Age=31536000; SameSite=Lax/);
    assert.match(chosen.headers.vary, /Accept-Language/);
    assert.match(chosen.body, /<html lang="nl" dir="ltr">/);
    const cookie = await get('/governance', { Cookie: 'lang=ar', 'Accept-Language': 'de' });
    assert.equal(cookie.headers['set-cookie'], undefined, 'no cookie without ?lang=');
    assert.match(cookie.body, /<html lang="ar" dir="rtl">/);
    // the page cache keeps one copy per language
    assert.match((await get('/governance', { 'Accept-Language': 'de-DE,de;q=0.9' })).body, /<html lang="de" dir="ltr">/);
    assert.match((await get('/governance')).body, /<html lang="en" dir="ltr">/);
    assert.equal((await get('/i18n.js')).code, 200);
  } finally {
    server.close();
  }
});
