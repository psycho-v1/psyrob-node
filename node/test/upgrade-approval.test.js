// Council approval of a node update without a new genesis (docs/NODE-UPGRADES.md): a plan for the next protocol
// version is submitted, two of the three council keys sign it on /upgrade/<id>, every page shows a banner while it is
// pending and approved, and after the 7-day timelock the network requires the new protocol version: a node that only
// implements the old one stops, the chain and its history stay.

import test from 'node:test';
import assert from 'node:assert/strict';
import { testChain, key, mineOne } from './helpers.js';
import { signTx } from '../src/tx.js';
import { ADDR, PROTOCOL_VERSION, NODE_VERSION, versionNumber } from '../src/params.js';
import { OWN_VERSION, requiredVersion, launchMessage, personalDigest } from '../src/rules.js';
import { contract } from '../../common/abicodec.js';
import { keccak256, signDigest } from '../../common/crypto.js';
import { bytesToHex, bigintToFixed, concat } from '../../common/bytes.js';
import { artifacts } from '../src/genesis.js';
import { contractCall } from '../src/evm.js';
import { Explorer } from '../src/explorer.js';
import { Rpc } from '../src/rpc.js';
import { withLang } from '../src/i18n.js';

const A = artifacts();
const C = Object.fromEntries(['DevCouncil', 'UpgradeRegistry'].map((n) => [n, contract(A[n].abi, keccak256)]));
const hex = (a) => '0x' + bytesToHex(a);
const PSY = 10n ** 18n;
const devs = [key(31), key(32), key(33)];
const council = [key(41), key(42), key(43)];

function launchConfig() {
  const personalSign = (text, sk) => { const s = signDigest(personalDigest(text), sk); return hex(concat(bigintToFixed(s.r, 32), bigintToFixed(s.s, 32), Uint8Array.of(27 + s.recovery))); };
  const config = { chainId: 1337, target: '0x' + ((1n << 256n) / 4n).toString(16), devBeneficiaries: devs.map((d) => hex(d.addr)), extra: 'PSYROB upgrade test' };
  config.councilKeys = council.map((k) => hex(k.addr));
  config.launchSignatures = devs.map((d, i) => personalSign(launchMessage(config, i, config.councilKeys[i]), d.sk));
  return config;
}

const DESCRIPTION = 'PSYROB node 11.1.0: cheaper state roots\nRelease: 11.1.0\nConsensus change: yes\n\nChanges:\n- new state commitment\n- <script>alert(1)</script>';

test('protocol version: the node gates on its protocol version, not its release number', () => {
  assert.equal(OWN_VERSION, versionNumber(PROTOCOL_VERSION));
  assert.equal(PROTOCOL_VERSION, '10.0.0', 'a fresh network starts at UpgradeRegistry.BASE_VERSION');
  assert.notEqual(OWN_VERSION, versionNumber(NODE_VERSION));
});

test('node update: two council keys approve on /upgrade/<id>; 7 days later the new protocol is required, no new genesis', { timeout: 300_000 }, async () => {
  const t = await testChain({ config: launchConfig(), params: { poolCap: 360_000_000_000n * PSY, maxSupply: 10n ** 30n } });
  const genesis = t.chain.dag.genesis.hash;
  const nonces = new Map();
  const mine = async (who, n = 1) => { for (let i = 0; i < n; i++) { t.advance(10); await mineOne(t, who); await t.chain.readAtTip((v) => t.mempool.prune(v)); } };
  const send = async (from, to, data) => {
    const k = hex(from.addr);
    const n = nonces.get(k) ?? (await t.chain.readAtTip((v) => v.getAccount(from.addr).nonce));
    nonces.set(k, n + 1n);
    const tx = signTx({ type: 2, nonce: n, to, data, value: 0n, gasLimit: 3_000_000n, maxFee: 20_000_000_000n, maxPriorityFee: 0n }, from.sk, t.params);
    await t.chain.readAtTip((view, ctx) => t.mempool.add(tx.raw, view, ctx.baseFee, ctx.timestamp));
  };
  const flush = async () => { for (let i = 0; i < 10 && t.mempool.size > 0; i++) await mine(council[2]); await mine(council[2]); };
  const read = (name, to, fn, args = []) => t.chain.readAtTip(async (view, ctx) => {
    const r = await contractCall(view, t.params, ctx, { to, data: C[name].encode(fn, args), commit: false });
    assert.ok(r.status, `${name}.${fn} reverted: ${r.reason}`);
    return C[name].decode(fn, r.returnValue, args.length);
  });
  await mine(council[0], 3); await mine(council[1], 3); await mine(council[2], 3);

  const node = { chain: t.chain, params: t.params, mempool: t.mempool, p2p: null, finality: null, opts: { vhosts: ['*'] }, log: () => {} };
  node.rpc = new Rpc({ chain: t.chain, mempool: t.mempool, p2p: null, finality: null, node });
  const ex = new Explorer(node);
  const page = async (p) => { await ex.refreshUpgrades(); return withLang('en', () => ex.route(p, new URLSearchParams()), { path: p, query: '' }); };

  // 1. anyone submits: protocol 10.1.0 (the next minor step above the base 10.0.0), release 11.1.0
  await send(council[2], ADDR.upgradeRegistry, C.UpgradeRegistry.encode('submit', [1n, '0x' + '00'.repeat(20), '0x' + '00'.repeat(20), 10_001_000n, '0x' + 'ab'.repeat(20), hex(keccak256(Uint8Array.of(7))), DESCRIPTION]));
  // a plan the council may not approve (a whole major version): shown, with the reason
  await send(council[2], ADDR.upgradeRegistry, C.UpgradeRegistry.encode('submit', [1n, '0x' + '00'.repeat(20), '0x' + '00'.repeat(20), 11_001_000n, '0x' + 'cd'.repeat(20), hex(keccak256(Uint8Array.of(8))), 'Too big a step\nConsensus change: no']));
  await flush();
  let html = await page('/upgrade/0');
  assert.match(html, /cheaper state roots/);
  assert.match(html, /10\.1\.0/);
  assert.match(html, /Node release<\/th><td>11\.1\.0/);
  assert.match(html, /yes: new consensus rules/);
  assert.match(html, /description matches the hash on chain/);
  assert.doesNotMatch(html, /<script>alert/, 'the description is escaped');
  assert.match(html, /Waiting for a first council signature/);
  assert.match(html, /data-c="DevCouncil" data-f="propose"/, 'the first key signs from the page');
  assert.match(await page('/upgrade/1'), /can approve only the next step above protocol 10\.0\.0 \(10\.1\.0 or 10\.0\.1\)/);
  assert.match(await page('/upgrade'), /cheaper state roots/);
  assert.doesNotMatch(await page("/"), /class="im-banner"/, 'a submission alone raises no banner (anyone can submit)');

  // 2. first council key signs
  const action = await read('DevCouncil', ADDR.devCouncil, 'actionCount');
  await send(council[0], ADDR.devCouncil, C.DevCouncil.encode('propose', [0n, '0x' + '00'.repeat(20), '0x' + '00'.repeat(32), 0n]));
  await flush();
  html = await page('/upgrade/0');
  assert.match(html, /1 of 2 signatures/);
  assert.match(html, new RegExp(`data-c="DevCouncil" data-f="approve"[^]*value="${action}"`), 'the second key approves that very action');
  assert.equal((html.match(/st on">signed</g) ?? []).length, 1, 'one seat has signed');
  const home = await page('/');
  assert.match(home, /class="im-banner"/);
  assert.match(home, /waiting for dev council signatures \(1 of 2\)/);
  assert.match(home, /href="\/upgrade\/0"/);

  // 3. second key signs: approved, 7-day timelock
  await send(council[1], ADDR.devCouncil, C.DevCouncil.encode('approve', [action]));
  await flush();
  const plan = await read('UpgradeRegistry', ADDR.upgradeRegistry, 'getPlan', [0n]);
  assert.equal(Number(plan.state), 1);
  html = await page('/upgrade/0');
  assert.match(html, /approved/);
  assert.equal((html.match(/st on">signed</g) ?? []).length, 2);
  assert.match(await page('/'), /is approved and takes effect/);

  // 4. after the timelock the network requires protocol 10.1.0; this node (protocol 10.0.0) stops; same genesis
  t.advance(7 * 86400 + 60);
  await mine(council[0]);
  assert.equal(await t.chain.readAtTip((v) => requiredVersion(v)), 10_001_000);
  assert.equal(t.chain.dag.genesis.hash, genesis, 'no new genesis');
  t.advance(10);
  await assert.rejects(mineOne(t, council[0]), /needs protocol 10\.1\.0/);
  assert.match(await page('/upgrade/0'), /in force/);
});
