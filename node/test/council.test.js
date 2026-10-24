// Governance rules in the node (DAG_SPEC.md section 17): the launch ceremony, the dev council's network pause as the
// mempool and block execution apply it, contract code replacement by UpgradeRegistry, nodes that are too old stopping,
// the pre-launch server and the new explorer pages.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { testChain, key, mineOne, blockOn } from './helpers.js';
import { signTx } from '../src/tx.js';
import { ADDR, versionText } from '../src/params.js';
import { contract } from '../../common/abicodec.js';
import { keccak256, signDigest } from '../../common/crypto.js';
import { bytesToHex, bigintToFixed, concat } from '../../common/bytes.js';
import { artifacts, buildGenesis } from '../src/genesis.js';
import { contractCall } from '../src/evm.js';
import { launchMessage, personalDigest, verifyLaunch, networkPausedUntil, requiredVersion, pauseSkip, neverReplaceable } from '../src/rules.js';
import { Ceremony, startPrelaunch } from '../src/prelaunch.js';
import { Explorer } from '../src/explorer.js';
import { Rpc } from '../src/rpc.js';

const A = artifacts();
const C = Object.fromEntries(['DevCouncil', 'UpgradeRegistry', 'EmergencyPause', 'MinerRegistry', 'DevVesting'].map((n) => [n, contract(A[n].abi, keccak256)]));
const hex = (a) => '0x' + bytesToHex(a);
const PSY = 10n ** 18n;
const devs = [key(31), key(32), key(33)];
const council = [key(41), key(42), key(43)];

/** A personal_sign signature (65 bytes, v = 27/28) as a wallet returns it. */
function personalSign(text, sk) {
  const s = signDigest(personalDigest(text), sk);
  return hex(concat(bigintToFixed(s.r, 32), bigintToFixed(s.s, 32), Uint8Array.of(27 + s.recovery)));
}

function launchConfig(chainId = 1337) {
  const config = { chainId, target: '0x' + ((1n << 256n) / 4n).toString(16), devBeneficiaries: devs.map((d) => hex(d.addr)), extra: 'PSYROB council test' };
  config.councilKeys = council.map((k) => hex(k.addr));
  config.launchSignatures = devs.map((d, i) => personalSign(launchMessage(config, i, config.councilKeys[i]), d.sk));
  return config;
}

test('launch ceremony: three Dev Account signatures are required and checked', async () => {
  const config = launchConfig();
  assert.equal(verifyLaunch(config), true);
  await buildGenesis({ ...config, timestamp: 1_800_000_000 });
  // a signature by the wrong wallet, or for another key, is refused
  const swapped = { ...config, launchSignatures: [config.launchSignatures[1], config.launchSignatures[0], config.launchSignatures[2]] };
  assert.throws(() => verifyLaunch(swapped), /Dev Account 1 does not match/);
  const otherKey = { ...config, councilKeys: [hex(key(99).addr), ...config.councilKeys.slice(1)] };
  assert.throws(() => verifyLaunch(otherKey), /Dev Account 1 does not match/);
  // the public chain IDs cannot start without the ceremony
  assert.throws(() => verifyLaunch({ chainId: 87870, devBeneficiaries: config.devBeneficiaries }), /launch ceremony signatures/);
  // a devnet may skip it
  assert.equal(verifyLaunch({ chainId: 1337, devBeneficiaries: config.devBeneficiaries }), false);
});

test('pre-launch server: page, signing rules, launch file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psy-launch-'));
  const base = launchConfig();
  delete base.councilKeys;
  delete base.launchSignatures;
  const cer = new Ceremony(base, path.join(dir, 'launch.json'));
  const server = await startPrelaunch({ ceremony: cer, host: '127.0.0.1', port: 0 });
  const port = server.address().port;
  const req = (method, p, body, type = 'application/json') => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { Host: 'localhost', ...(body ? { 'Content-Type': type } : {}) } }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
  try {
    const page = await req('GET', '/launch');
    assert.equal(page.status, 200);
    assert.match(page.body, /Launch ceremony/);
    assert.match(page.body, /separate council key/);
    assert.equal(JSON.parse((await req('GET', '/health')).body).prelaunch, true);
    assert.equal((await req('POST', '/api/launch/sign', '{}', 'text/plain')).status, 415);
    const keyHex = hex(council[0].addr);
    const msg = JSON.parse((await req('GET', `/api/launch/message?seat=0&key=${keyHex}`)).body).message;
    assert.equal(msg, launchMessage(base, 0, keyHex));
    // signed by another wallet: refused
    let r = await req('POST', '/api/launch/sign', JSON.stringify({ seat: 0, councilKey: keyHex, signature: personalSign(msg, devs[1].sk) }));
    assert.equal(r.status, 400);
    assert.match(JSON.parse(r.body).error, /not from the Dev Account 1 wallet/);
    // the Dev Account wallet itself as council key: refused
    r = await req('POST', '/api/launch/sign', JSON.stringify({ seat: 0, councilKey: hex(devs[0].addr), signature: personalSign(launchMessage(base, 0, hex(devs[0].addr)), devs[0].sk) }));
    assert.match(JSON.parse(r.body).error, /separate key/);
    for (let i = 0; i < 3; i++) {
      const k = hex(council[i].addr);
      r = await req('POST', '/api/launch/sign', JSON.stringify({ seat: i, councilKey: k, signature: personalSign(launchMessage(base, i, k), devs[i].sk) }));
      assert.equal(r.status, 200, r.body);
    }
    assert.equal(JSON.parse(r.body).complete, true);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'launch.json'), 'utf8'));
    assert.equal(verifyLaunch(saved), true);
    const g = await buildGenesis({ ...saved, timestamp: 1_800_000_000 });
    assert.equal(g.hash.length, 32);
    // the signatures survive a restart of the pre-launch node
    assert.equal(new Ceremony(base, path.join(dir, 'launch.json')).complete, true);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('council: network pause in pool and blocks, contract update, node update stops old nodes, pages', { timeout: 300_000 }, async () => {
  const cfg = launchConfig();
  const t = await testChain({ config: cfg, params: { poolCap: 360_000_000_000n * PSY, maxSupply: 10n ** 30n } });
  const nonces = new Map();
  const mine = async (who, n = 1) => { for (let i = 0; i < n; i++) { t.advance(10); await mineOne(t, who); await t.chain.readAtTip((v) => t.mempool.prune(v)); } };
  const raw = async (from, to, data = new Uint8Array(0), value = 0n, gasLimit = 3_000_000n) => {
    const k = hex(from.addr);
    const n = nonces.get(k) ?? (await t.chain.readAtTip((v) => v.getAccount(from.addr).nonce));
    nonces.set(k, n + 1n);
    return signTx({ type: 2, nonce: n, to, data, value, gasLimit, maxFee: 20_000_000_000n, maxPriorityFee: 0n }, from.sk, t.params);
  };
  const send = async (from, to, data, value, gasLimit) => {
    const tx = await raw(from, to, data, value, gasLimit);
    await t.chain.readAtTip((view, ctx) => t.mempool.add(tx.raw, view, ctx.baseFee, ctx.timestamp));
    return tx;
  };
  const flush = async (who) => { for (let i = 0; i < 10 && t.mempool.size > 0; i++) await mine(who); await mine(who); };
  const read = (name, to, fn, args = []) => t.chain.readAtTip(async (view, ctx) => {
    const r = await contractCall(view, t.params, ctx, { to, data: C[name].encode(fn, args), commit: false });
    assert.ok(r.status, `${name}.${fn} reverted: ${r.reason}`);
    return C[name].decode(fn, r.returnValue, args.length);
  });
  const councilAct = async (kind, target, k, arg) => {
    const id = await read('DevCouncil', ADDR.devCouncil, 'actionCount');
    await send(council[0], ADDR.devCouncil, C.DevCouncil.encode('propose', [BigInt(kind), target, k, arg]));
    await flush(council[0]);
    await send(council[1], ADDR.devCouncil, C.DevCouncil.encode('approve', [id]));
    await flush(council[0]);
    return id;
  };

  // the council keys mine their own gas; a user with PSY
  const user = key(50);
  await mine(council[0], 3);
  await mine(council[1], 2);
  await mine(user, 2);
  // the genesis holds the council keys from the ceremony
  const ks = await read('DevCouncil', ADDR.devCouncil, 'keys');
  assert.deepEqual(ks[0].map((x) => x.toLowerCase()), cfg.devBeneficiaries);
  assert.deepEqual(ks[1].map((x) => x.toLowerCase()), cfg.councilKeys);
  // the council and pause system calls run in every block, after the election calls
  const labels = t.chain.tip.systemReceipts.map((r) => r.label);
  assert.ok(labels.indexOf('devCouncil.advance') > labels.indexOf('ngoElection.advance'));
  assert.ok(t.chain.tip.systemReceipts.every((r) => r.status), JSON.stringify(t.chain.tip.systemReceipts.filter((r) => !r.status)));

  // ---- network pause
  const reason = hex(keccak256(new TextEncoder().encode('test pause')));
  await councilAct(3, '0x' + '00'.repeat(20), reason, 0n);
  assert.equal(await read('EmergencyPause', ADDR.emergencyPause, 'networkPaused'), true);
  const p = await read('EmergencyPause', ADDR.emergencyPause, 'pauses', ['0x' + '00'.repeat(20)]);
  const until = await t.chain.readAtTip((v) => networkPausedUntil(v));
  assert.equal(until, Number(p[2]), 'the node reads the same pause end as the contract (storage layout)');
  // the pool refuses a transfer, and a value sent to the Governor; it takes council and DevVesting.release transactions
  const transfer = await raw(user, key(51).addr, new Uint8Array(0), 1n * PSY, 21_000n);
  await assert.rejects(t.chain.readAtTip((view, ctx) => t.mempool.add(transfer.raw, view, ctx.baseFee, ctx.timestamp)), /network paused/);
  nonces.delete(hex(user.addr));
  const view = await t.chain.readAtTip((v) => v);
  const tsNow = t.now();
  assert.equal(pauseSkip(view, { to: ADDR.governor, value: 1n, data: new Uint8Array(0) }, tsNow), 'network paused');
  assert.equal(pauseSkip(view, { to: ADDR.governor, value: 0n, data: Uint8Array.of(1, 2, 3, 4) }, tsNow), null);
  assert.equal(pauseSkip(view, { to: ADDR.devVesting2, value: 0n, data: C.DevVesting.encode('release') }, tsNow), null);
  assert.equal(pauseSkip(view, { to: ADDR.devVesting2, value: 0n, data: C.DevVesting.encode('released') }, tsNow), 'network paused');
  assert.equal(pauseSkip(view, { to: ADDR.minerRegistry, value: 0n, data: Uint8Array.of(1, 2, 3, 4) }, tsNow), 'network paused');
  // a block that carries the transfer anyway: it is skipped, pays nothing and changes nothing
  const before = await t.chain.readAtTip((v) => v.getAccount(user.addr));
  t.advance(10);
  const blk = await blockOn(t, [t.chain.tip.hash], user, { txRaws: [transfer.raw] });
  assert.equal((await t.chain.addBlock(blk)).status, 'added');
  await mine(council[0]);
  const skipped = t.chain.tip.skipped.find((s) => bytesToHex(s.hash) === bytesToHex(transfer.hash));
  assert.equal(skipped?.reason, 'network paused');
  const after = await t.chain.readAtTip((v) => v.getAccount(user.addr));
  assert.equal(after.nonce, before.nonce);
  // explorer: banner on every page, the pause page and the upgrades page
  const node = { chain: t.chain, params: t.params, mempool: t.mempool, p2p: null, finality: null, opts: { vhosts: ['*'] }, log: (m) => { throw new Error(m); } };
  node.rpc = new Rpc({ chain: t.chain, mempool: t.mempool, p2p: null, finality: null, node });
  const ex = new Explorer(node);
  const get = async (pth) => { await ex.refreshMode(); await ex.refreshPause(); return ex.route(pth, new URLSearchParams()); };
  assert.match(await get('/blocks'), /class="pz-banner"[^]*Whole network<\/strong> paused by the dev council/);
  const pp = await get('/pause');
  assert.match(pp, /A brake, not a lever/);
  assert.match(pp, /Whole network<\/td><td><span class="st off">paused/);
  const up = await get('/upgrades');
  assert.match(up, /Dev council/);
  assert.match(up, new RegExp(cfg.councilKeys[0]));
  // after 72 hours the pause lifts by itself and the transfer goes through
  t.advance(72 * 3600);
  await mine(council[0]);
  assert.equal(await read('EmergencyPause', ADDR.emergencyPause, 'networkPaused'), false);
  await send(user, key(51).addr, new Uint8Array(0), 1n * PSY, 21_000n);
  await flush(council[0]);
  assert.equal(await t.chain.readAtTip((v) => v.getAccount(key(51).addr).balance), 1n * PSY);
  assert.doesNotMatch(await get('/blocks'), /class="pz-banner"/);

  // ---- contract update: the council cannot approve one; approved by the DAO, the node swaps the code 7 days later
  const runtime = Uint8Array.from(Buffer.from('602a60005260206000f3', 'hex')); // returns 42
  const init = concat(Uint8Array.from(Buffer.from('600a600c600039600a6000f3', 'hex')), runtime);
  const create = await send(council[0], new Uint8Array(0), init, 0n, 200_000n);
  await flush(council[0]);
  let implAddr = null;
  for (let h = t.chain.tip.chainHeight; h > 0 && !implAddr; h--) for (const r of t.chain.dag.get(t.chain.chain[h]).receipts ?? []) if (bytesToHex(r.txHash) === bytesToHex(create.hash)) implAddr = r.contractAddress;
  assert.ok(implAddr, 'the new code was deployed');
  const planId = await read('UpgradeRegistry', ADDR.upgradeRegistry, 'planCount');
  await send(council[0], ADDR.upgradeRegistry, C.UpgradeRegistry.encode('submit', [0n, hex(ADDR.minerRegistry), hex(implAddr), 0n, '0x' + '00'.repeat(20), '0x' + '00'.repeat(32), 'test update']));
  await flush(council[0]);
  await councilAct(0, '0x' + '00'.repeat(20), '0x' + '00'.repeat(32), planId); // the approval reverts inside the council
  let plan = await read('UpgradeRegistry', ADDR.upgradeRegistry, 'getPlan', [planId]);
  assert.equal(Number(plan.state), 0, 'the council cannot approve a contract update');
  // stand-in for the DAO (60 NGOs are out of reach in a unit test): mark the council retired in its storage (slot 11)
  // and approve as the Governor, on this node's tip state
  await t.chain.readAtTip(async (v, ctx) => {
    const slot = new Uint8Array(32); slot[31] = 11;
    v.setStorage(ADDR.devCouncil, slot, 1n | (BigInt(ctx.timestamp) << 8n));
    const r = await contractCall(v, t.params, ctx, { caller: ADDR.governor, to: ADDR.upgradeRegistry, data: C.UpgradeRegistry.encode('approve', [planId]) });
    assert.ok(r.status, r.reason);
    t.chain.state.commit(v);
  });
  plan = await read('UpgradeRegistry', ADDR.upgradeRegistry, 'getPlan', [planId]);
  assert.equal(Number(plan.state), 1);
  assert.equal(plan.byDao, true);
  t.advance(7 * 86400);
  await mine(council[0], 2);
  plan = await read('UpgradeRegistry', ADDR.upgradeRegistry, 'getPlan', [planId]);
  assert.equal(Number(plan.state), 2, 'activated');
  const code = await t.chain.readAtTip((v) => v.getCode(ADDR.minerRegistry));
  assert.equal(bytesToHex(code), bytesToHex(runtime));
  // the node never replaces the 12 % or the handover rule, whatever a registry says
  assert.equal(neverReplaceable(ADDR.devVesting), true);
  assert.equal(neverReplaceable(ADDR.devVesting3), true);
  assert.equal(neverReplaceable(ADDR.devCouncil), true);
  assert.equal(neverReplaceable(ADDR.treasury), false);

  // ---- node update: version 10.1.0 approved (by the DAO stand-in); 14 days later this 10.0.0 node stops
  const nodePlan = await read('UpgradeRegistry', ADDR.upgradeRegistry, 'planCount');
  await send(council[0], ADDR.upgradeRegistry, C.UpgradeRegistry.encode('submit', [1n, '0x' + '00'.repeat(20), '0x' + '00'.repeat(20), 10_001_000n, '0x' + '01'.repeat(20), hex(keccak256(Uint8Array.of(1))), '10.1.0']));
  await flush(council[0]);
  await t.chain.readAtTip(async (v, ctx) => {
    const r = await contractCall(v, t.params, ctx, { caller: ADDR.governor, to: ADDR.upgradeRegistry, data: C.UpgradeRegistry.encode('approve', [nodePlan]) });
    assert.ok(r.status, r.reason);
    t.chain.state.commit(v);
  });
  t.advance(14 * 86400);
  await mine(council[0]); // this block brings 10.1.0 into force
  assert.equal(await t.chain.readAtTip((v) => requiredVersion(v)), 10_001_000);
  assert.equal(versionText(10_001_000), '10.1.0');
  t.advance(10);
  await assert.rejects(mineOne(t, council[0]), /upgrade required: this network now needs node 10.1.0/);
  const raw2 = await blockOn(t, [t.chain.tip.hash], council[0]).catch((e) => e);
  if (raw2 instanceof Uint8Array) await assert.rejects(t.chain.addBlock(raw2), /upgrade required/);
  assert.ok(t.events.some(([type, d]) => type === 'upgradeRequired' && d.version === '10.1.0'));
});
