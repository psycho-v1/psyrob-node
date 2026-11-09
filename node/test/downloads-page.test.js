// The download section of /run-a-node and /mine: the separate node and miner downloads until a PSYROB Suite release
// is in manifest.json, then one PSYROB Suite section (a button per operating system, size, version, SHA-256).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { testChain } from './helpers.js';
import { Explorer } from '../src/explorer.js';
import { Rpc } from '../src/rpc.js';
import { Downloads } from '../src/downloads.js';
import { withLang } from '../src/i18n.js';

const H = (c) => c.repeat(64);
const legacy = { version: '11.1.0', built: '2026-11-09T00:00:00.000Z', files: [
  { name: 'psyrob-miner-11.1.0-windows-x64.exe', os: 'Windows', program: 'miner', type: 'program (.exe)', bytes: 9e7, sha256: H('a') },
  { name: 'psyrob-node-11.1.0-linux-x64.tar.gz', os: 'Linux', program: 'node', type: 'archive (.tar.gz)', bytes: 4e7, sha256: H('b') },
] };
const suite = { ...legacy, suite: { version: '1.0.4', engine: '11.1.0', built: '2026-11-10T00:00:00.000Z' }, files: [
  { name: 'PSYROB-Suite-Setup-1.0.4-x64.exe', os: 'Windows', arch: 'x64', program: 'suite', type: 'installer (.exe)', bytes: 1.1e8, sha256: H('c') },
  { name: 'PSYROB-Suite-1.0.4-x64-portable.exe', os: 'Windows', arch: 'x64', program: 'suite', type: 'portable (.exe)', bytes: 1.1e8, sha256: H('d') },
  { name: 'PSYROB-Suite-Setup-1.0.4-arm64.exe', os: 'Windows', arch: 'arm64', program: 'suite', type: 'installer (.exe)', bytes: 1.0e8, sha256: H('e') },
  { name: 'psyrob-suite_1.0.4_amd64.deb', os: 'Linux', arch: 'x64', program: 'suite', type: 'Ubuntu package (.deb)', bytes: 1.04e8, sha256: H('f') },
  { name: 'psyrob-suite_1.0.4_x86_64.AppImage', os: 'Linux', arch: 'x64', program: 'suite', type: 'AppImage', bytes: 1.3e8, sha256: H('1') },
  { name: 'psyrob-suite_1.0.4_x64.tar.gz', os: 'Linux', arch: 'x64', program: 'suite', type: 'archive (.tar.gz)', bytes: 1.2e8, sha256: H('2') },
] };

test('downloads: separate node and miner until Suite is published, then one PSYROB Suite section', async () => {
  const t = await testChain();
  const node = { chain: t.chain, params: t.params, mempool: t.mempool, p2p: null, finality: null, opts: { vhosts: ['*'] }, log: () => {} };
  node.rpc = new Rpc({ chain: t.chain, mempool: t.mempool, p2p: null, finality: null, node });
  const ex = new Explorer(node);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psy-dl-'));
  ex.downloads = new Downloads(dir);
  const page = (p) => withLang('en', () => ex.route(p, new URLSearchParams()), { path: p, query: '' });
  try {
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(legacy));
    let html = await page('/run-a-node');
    assert.match(html, /Miner for Windows/);
    assert.match(html, /psyrob-miner-11\.1\.0-windows-x64\.exe/);
    assert.doesNotMatch(html, /PSYROB-Suite/);
    assert.match(await page('/mine'), /Download the miner/);
    // the Suite release arrives: the manifest is re-read, no restart
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(suite));
    const t1 = Date.now() / 1000 + 5;
    fs.utimesSync(path.join(dir, 'manifest.json'), t1, t1);
    html = await page('/run-a-node');
    assert.match(html, /PSYROB Suite 1\.0\.4/);
    assert.doesNotMatch(html, /psyrob-miner|psyrob-node-11/, 'no separate node or miner links');
    for (const f of suite.files) {
      assert.match(html, new RegExp(`href="/downloads/${f.name.replace(/\./g, '\\.')}"`), f.name);
      assert.match(html, new RegExp(f.sha256), `SHA-256 of ${f.name}`);
    }
    assert.match(html, /110 MB/);
    assert.match(html, /with node 11\.1\.0/);
    assert.match(await page('/mine'), /Download PSYROB Suite/);
    assert.match(await withLang('de', () => ex.route('/run-a-node', new URLSearchParams()), { path: '/run-a-node', query: '' }), /PSYROB Suite 1\.0\.4/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
