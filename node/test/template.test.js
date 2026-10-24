// Template ids: two miners asking the same node for templates in the same second get distinct ids, and each one's
// solution is accepted.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Node } from '../src/node.js';
import { headerFromTemplate } from '../../miner/src/job.js';
import { key, solve } from './helpers.js';

test('two miners in the same second get distinct template ids; both solutions are accepted', { timeout: 60_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-tpl-'));
  const gf = path.join(dir, 'genesis.json');
  fs.writeFileSync(gf, JSON.stringify({ config: { chainId: 1337, timestamp: Math.floor(Date.now() / 1000) - 600, target: '0x' + ((1n << 256n) / 4n).toString(16), devBeneficiary: '0x' + '22'.repeat(20) }, params: { pow: { memoryKiB: 8, iterations: 1 } } }));
  // no P2P listener, and an HTTP port chosen by the system: no clash with other tests' ports
  const node = await new Node({ genesisFile: gf, datadir: path.join(dir, 'n'), p2pHost: '127.0.0.1', p2pPort: 0, seeds: [], httpHost: '127.0.0.1', httpPort: 0, log: () => {} }).start();
  const port = node.http.address().port;
  const rpc = async (method, params) => {
    const r = await (await fetch(`http://127.0.0.1:${port}/rpc`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json();
    if (r.error) throw new Error(r.error.message);
    return r.result;
  };
  try {
    const A = key(1), B = key(2);
    const hex = (a) => '0x' + Buffer.from(a).toString('hex');
    let ta, tb;
    do { ta = await rpc('psy_getBlockTemplate', [hex(A.addr)]); tb = await rpc('psy_getBlockTemplate', [hex(B.addr)]); } while (ta.header.timestamp !== tb.header.timestamp);
    assert.equal(ta.header.parents[0], tb.header.parents[0], 'same parent, same second: the case that collided');
    assert.notEqual(ta.id, tb.id);
    const p = { pow: ta.pow };
    for (const [t, k] of [[ta, A], [tb, B]]) {
      const h = solve(headerFromTemplate(t), k.sk, p);
      const r = await rpc('psy_submitBlock', [t.id, '0x' + h.nonce.toString(16), hex(h.minerSig)]);
      assert.equal(r.status, 'added', 'the solution is accepted');
    }
  } finally {
    await node.stop().catch(() => {});
    try { fs.rmSync(dir, { recursive: true }); } catch { /* temp */ }
  }
});
