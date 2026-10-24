// The full process order on a test chain, through real transactions and the node's own system calls:
// mine PSY -> register miners -> mint 60 NGO records -> 5 vouches each -> challenge window -> attested -> stand ->
// lock PSY and vote -> the first election closes after 90 days -> Normal mode -> committee bonds -> the epoch's
// committee is drawn -> 15 members sign a checkpoint -> it is final -> a block carries the certificate -> recorded.

import test from 'node:test';
import assert from 'node:assert/strict';
import { testChain, key, mineOne } from './helpers.js';
import { signTx } from '../src/tx.js';
import { ADDR } from '../src/params.js';
import { contract, u8ToHex } from '../../common/abicodec.js';
import { keccak256 } from '../../common/crypto.js';
import { bytesToHex, fromHex, utf8 } from '../../common/bytes.js';
import * as abi from '../../common/abi.js';
import { artifacts } from '../src/genesis.js';
import { contractCall } from '../src/evm.js';
import { checkpointDigest } from '../src/consensus.js';
import { sig65 } from '../src/finality.js';
import { Explorer } from '../src/explorer.js';
import { Rpc } from '../src/rpc.js';

const A = artifacts();
const C = Object.fromEntries(['MinerRegistry', 'NGORegistry', 'Attestation', 'VoteEscrow', 'NGOElection', 'FinalityCommittee', 'GovernanceMode', 'RoleElection'].map((n) => [n, contract(A[n].abi, keccak256)]));
const TO = { RoleElection: ADDR.roleElection, MinerRegistry: ADDR.minerRegistry, NGORegistry: ADDR.ngoRegistry, Attestation: ADDR.attestation, VoteEscrow: ADDR.voteEscrow, NGOElection: ADDR.ngoElection, FinalityCommittee: ADDR.finalityCommittee, GovernanceMode: ADDR.governanceMode };
const PSY = 10n ** 18n;
const hex = (a) => '0x' + bytesToHex(a);

test('process order end to end: NGOs elected, Normal mode, committee drawn, checkpoint final and recorded', { timeout: 600_000 }, async () => {
  // chain 1337 only: pools 1,000 times larger than the public networks', so one test miner can fund all the bonds
  const t = await testChain({ params: { mergesetGasLimit: 60_000_000n, blockGasLimit: 30_000_000n, poolCap: 360_000_000_000n * 10n ** 18n, maxSupply: 10n ** 30n } });
  const nonces = new Map();
  t.mempool.maxPerSender = 300;
  const rich = key(1);
  // a voucher backs at most 10 NGOs at a time (maxActiveVouches): 60 NGOs x 5 vouches need 30 vouchers
  const vouchers = Array.from({ length: 30 }, (_, i) => key(140 + i));
  const ngos = Array.from({ length: 60 }, (_, i) => key(40 + i));
  const cminers = Array.from({ length: 16 }, (_, i) => key(120 + i));
  // the first election needs 5 distinct approvers with at least 100 PSY locked each (firstElectionMinVoters)
  const voters = Array.from({ length: 5 }, (_, i) => key(200 + i));

  const mine = async (who, n = 1) => { for (let i = 0; i < n; i++) { t.advance(10); await mineOne(t, who); await t.chain.readAtTip((v) => t.mempool.prune(v)); } };
  const read = (name, fn, args = []) => t.chain.readAtTip(async (view, ctx) => {
    const r = await contractCall(view, t.params, ctx, { to: TO[name], data: C[name].encode(fn, args), commit: false });
    if (!r.status) throw new Error(`${name}.${fn} reverted: ${r.reason}`);
    return C[name].decode(fn, r.returnValue, args.length);
  });
  // queue a transaction; `mineTxs` mines until the mempool is empty and the blocks carrying them are accepted
  const send = async (from, to, data = new Uint8Array(0), value = 0n, gasLimit = 3_000_000n) => {
    const k = hex(from.addr);
    const n = nonces.get(k) ?? (await t.chain.readAtTip((v) => v.getAccount(from.addr).nonce));
    nonces.set(k, n + 1n);
    const tx = signTx({ type: 2, nonce: n, to, data, value, gasLimit, maxFee: 20_000_000_000n, maxPriorityFee: 0n }, from.sk, t.params);
    await t.chain.readAtTip((view, ctx) => t.mempool.add(tx.raw, view, ctx.baseFee));
    return tx;
  };
  const call = (from, name, fn, args = [], value = 0n, gas) => send(from, TO[name], C[name].encode(fn, args), value, gas);
  const mineTxs = async () => {
    for (let i = 0; i < 40 && t.mempool.size > 0; i++) await mine(rich);
    await mine(rich); // accept the last carrier block
    assert.equal(t.mempool.size, 0, 'all transactions mined');
  };
  const failures = () => t.chain.tip.receipts.filter((r) => r.status === 0).length;

  // 1. mine PSY: vouchers need 100 blue blocks each; NGOs and committee miners one each; the rich miner funds fees
  // vouchers also need blue blocks in 4 distinct 7-day epochs (vouchMinEpochs): 4 weekly batches of 26
  for (let wk = 0; wk < 4; wk++) {
    for (const v of vouchers) await mine(v, 26);
    if (wk < 3) t.advance(7 * 86400);
  }
  for (const n of ngos) await mine(n, 1);
  for (const m of cminers) await mine(m, 2);
  await mine(rich, 80);
  for (const x of [...ngos, ...cminers, ...voters]) await send(rich, x.addr, new Uint8Array(0), 12_000n * PSY, 21_000n);
  for (const v of vouchers) await send(rich, v.addr, new Uint8Array(0), 12_000n * PSY, 21_000n);
  await mineTxs();
  assert.ok((await t.chain.readAtTip((v) => v.getAccount(ngos[0].addr).balance)) >= 12_000n * PSY);

  // 2. register miners, mint NGO records (fee burned), vouch 5 times each
  for (const x of [...vouchers, ...ngos, ...cminers]) await call(x, 'MinerRegistry', 'register', ['0x' + '00'.repeat(32)]);
  await mineTxs();
  for (const [i, n] of ngos.entries()) await call(n, 'NGORegistry', 'mint', [`NGO ${i}`, 'NL', `REG-${i}`, `ipfs://dossier-${i}`, hex(keccak256(new Uint8Array([i])))], 100n * PSY);
  await mineTxs();
  assert.equal(await read('NGORegistry', 'ngoCount'), 60n);
  for (const [i, n] of ngos.entries()) for (const v of vouchers.slice(Math.floor(i / 10) * 5, Math.floor(i / 10) * 5 + 5)) await call(v, 'Attestation', 'vouch', [hex(n.addr)], 1_000n * PSY);
  await mineTxs();
  t.advance(7 * 86400 + 60);
  for (const n of ngos) await call(rich, 'Attestation', 'finalize', [hex(n.addr)]);
  await mineTxs();
  assert.equal(await read('NGORegistry', 'status', [hex(ngos[59].addr)]), 2n);

  // 3. the first election (round 0 was opened by the node's system call), stand, lock, vote
  for (const n of ngos) await call(n, 'NGOElection', 'stand', [0n]);
  for (const v of voters) await call(v, 'VoteEscrow', 'lock', [], 1_000n * PSY);
  await mineTxs();
  for (const v of voters) await call(v, 'NGOElection', 'vote', [0n, ngos.map((n) => hex(n.addr)).sort()], 0n, 25_000_000n);
  await mineTxs();
  assert.equal(failures(), 0);
  assert.equal(await read('GovernanceMode', 'mode'), 0n); // Bootstrap
  t.setTime(t.chain.genesisTime + 90 * 86400 + 30);
  await mine(rich, 3); // the system call finalises round 0
  assert.equal(await read('NGOElection', 'electedCount'), 60n);
  assert.equal(await read('GovernanceMode', 'mode'), 1n); // Normal

  // 4. committee: 6 NGOs and 15 miners bond; in the next epoch the system call freezes the candidates, and the first
  //    committee is sealed with the hash of the chain block 30 blocks after the freeze (no checkpoint exists yet)
  for (const n of ngos.slice(0, 8)) await call(n, 'FinalityCommittee', 'bond', [], 10_000n * PSY);
  for (const m of cminers) await call(m, 'FinalityCommittee', 'bond', [], 10_000n * PSY);
  await mineTxs();
  for (const m of cminers) await mine(m, 1); // blue blocks in this epoch weight the miner draw
  t.advance(7 * 86400);
  await mine(rich, 2);
  const epoch = await read('FinalityCommittee', 'currentEpoch');
  // the full freeze check runs at most once per 30 blocks
  for (let i = 0; i < 31 && (await read('FinalityCommittee', 'epochDraw', [epoch]))[0].freezeBlock === 0n; i++) await mine(rich, 1);
  const [fd] = await read('FinalityCommittee', 'epochDraw', [epoch]);
  assert.ok(fd.freezeBlock > 0n && fd.useCheckpoint === false);
  assert.equal((await read('FinalityCommittee', 'members', [epoch])).length, 0); // not before the seed block exists
  while (BigInt(t.chain.tip.chainHeight) <= fd.seedBlock + 1n) await mine(rich, 1);
  const members = await read('FinalityCommittee', 'members', [epoch]);
  assert.equal(members.length, 21);
  const [fd2] = await read('FinalityCommittee', 'epochDraw', [epoch]);
  assert.equal(fd2.sourceKind, 2n);
  assert.equal(fd2.sourceHash, hex(t.chain.dag.get(t.chain.chain[Number(fd.seedBlock)]).hashBytes)); // the chain block's hash
  const keyOf = new Map([...ngos, ...cminers].map((k) => [hex(k.addr), k]));
  const ngoSeats = members.filter((m) => ngos.some((n) => hex(n.addr) === m)).length;
  assert.equal(ngoSeats, 6);

  // 5. reach a checkpoint height after the seal, 15 members sign, the checkpoint becomes final
  const iv = t.params.checkpointInterval;
  await mine(rich, 1);
  while (t.chain.tip.chainHeight % iv !== 0) await mine(rich, 1);
  const number = t.chain.tip.chainHeight / iv;
  const cb = t.chain.tip;
  await mine(rich, 2);
  assert.equal(await read('FinalityCommittee', 'signerEpoch', [BigInt(cb.header.timestamp), BigInt(cb.chainHeight)]), epoch);
  const digest = checkpointDigest(t.params.chainId, t.chain.dag.genesis.header.timestamp, number, cb.hashBytes, cb.stateRoot);
  // a certificate needs 15 signatures, 4 of them from NGO members
  const ngoSet = new Set(ngos.map((n) => hex(n.addr)));
  const signersFor = (mem, ngoMem) => [...ngoMem.slice(0, 4), ...mem.filter((m) => !ngoMem.includes(m))].slice(0, 15);
  const ngoMembers = members.filter((m) => ngoSet.has(m));
  const sigs = signersFor(members, ngoMembers).map((m) => sig65(digest, keyOf.get(m).sk));
  const cert = { number, chainBlock: cb.hashBytes, stateRoot: cb.stateRoot, epoch: Number(epoch), sigs };
  assert.equal(await t.chain.noteFinal({ ...cert, sigs: sigs.slice(0, 14) }), false); // 14 are not enough
  const minerSigs = members.filter((m) => !ngoSet.has(m)).map((m) => sig65(digest, keyOf.get(m).sk));
  assert.equal(minerSigs.length, 15);
  assert.equal(await t.chain.noteFinal({ ...cert, sigs: minerSigs }), false); // 15 miners alone never finalise
  assert.equal(await t.chain.noteFinal(cert), true);
  assert.equal(t.chain.finalCheckpoint.number, number);

  // 6. a block carries the certificate; when it is accepted the contract records who signed
  t.advance(10);
  await mineOne(t, rich, { certs: [cert] });
  await mine(rich, 1);
  assert.equal(await read('FinalityCommittee', 'checkpointRecorded', [BigInt(number)]), true);
  const signed = signersFor(members, ngoMembers);
  assert.equal(await read('FinalityCommittee', 'signedCount', [epoch, signed[0]]), 1n);
  assert.equal(await read('FinalityCommittee', 'signedCount', [epoch, members.find((m) => !signed.includes(m))]), 0n);

  // what the committee members' nodes do: sign every checkpoint up to the tip, form certificates, and miners carry
  // them in blocks (Finality.onTip does this in a running node)
  const finaliseUpTo = async () => {
    const certs = [];
    for (let n = t.chain.finalCheckpoint.number + 1; n * iv <= t.chain.tip.chainHeight - 2; n++) {
      const b = t.chain.dag.get(t.chain.chain[n * iv]);
      const se = await read('FinalityCommittee', 'signerEpoch', [BigInt(b.header.timestamp), BigInt(b.chainHeight)]);
      const mem = await read('FinalityCommittee', 'activeMembers', [se]);
      const ngoMem = await read('FinalityCommittee', 'activeNgoMembers', [se]);
      const dg = checkpointDigest(t.params.chainId, t.chain.dag.genesis.header.timestamp, n, b.hashBytes, b.stateRoot);
      const c = { number: n, chainBlock: b.hashBytes, stateRoot: b.stateRoot, epoch: Number(se), sigs: signersFor(mem, ngoMem).map((m) => sig65(dg, keyOf.get(m).sk)) };
      assert.equal(await t.chain.noteFinal(c), true, 'checkpoint ' + n);
      certs.push(c);
    }
    for (let i = 0; i < certs.length; i += 8) { t.advance(10); await mineOne(t, rich, { certs: certs.slice(i, i + 8) }); }
    await mine(rich, 2);
  };

  // 7. the committee members commit to hash onions (the randomness beacon). A role election ends
  //    in a tie, and the epoch changes: the system calls record the tie and freeze the next committee's candidates, and
  //    each opens a beacon round; the members reveal, and both draws are seeded by the mix of the reveals
  const onion = (k) => { const l = [keccak256(utf8('onion ' + hex(k.addr)))]; for (let i = 1; i <= 3; i++) l.push(keccak256(l[i - 1])); return l; };
  const cands = [key(220), key(221)];
  for (const c of cands) await send(rich, c.addr, new Uint8Array(0), 1_000n * PSY, 21_000n);
  await call(rich, 'RoleElection', 'open', [0n]);
  await mineTxs();
  for (const c of cands) await call(c, 'RoleElection', 'stand', [0n], 100n * PSY);
  await mineTxs();
  t.advance(14 * 86400);
  for (let i = 0; i < 4; i++) await call(ngos[i], 'RoleElection', 'vote', [0n, hex(cands[i % 2].addr)]);
  await mineTxs();
  // (an epoch in between has frozen candidates and opened a round nobody revealed in: the draw fell back, and nobody had
  // committed yet, so nobody is marked silent.) The members commit now, before the rounds under test open.
  const before = Number(await read('FinalityCommittee', 'beaconCount'));
  for (const m of members) await call(keyOf.get(m), 'FinalityCommittee', 'commitBeacon', [hex(onion(keyOf.get(m))[3])]);
  await mineTxs();
  // the committee miners keep mining: seat weight counts blue blocks of the last 4 epochs
  for (const m of cminers) await mine(m, 1);
  t.advance(14 * 86400);
  await mine(rich, 2); // the system call finalises: a 2-2 tie is recorded
  const [d0, tied] = await read('RoleElection', 'getDraw', [0n]);
  assert.equal(d0.status, 1n);
  assert.equal(tied.length, 2);
  const ep2 = await read('FinalityCommittee', 'currentEpoch');
  for (let i = 0; i < 31 && (await read('FinalityCommittee', 'epochDraw', [ep2]))[0].freezeBlock === 0n; i++) await mine(rich, 1);
  const rounds = Number(await read('FinalityCommittee', 'beaconCount')) - before;
  assert.equal(rounds, 2); // one for the tie, one for the freeze
  const mixes = [];
  for (let r = 0; r < rounds; r++) {
    const b = await read('FinalityCommittee', 'beacon', [BigInt(before + r)]);
    assert.equal(b.epoch, epoch);
    mixes.push(b.mix);
  }
  // every member reveals, round by round, the next layer down
  for (let r = 0; r < rounds; r++) {
    for (const m of members) {
      const layer = onion(keyOf.get(m))[2 - r];
      await call(keyOf.get(m), 'FinalityCommittee', 'revealBeacon', [BigInt(before + r), hex(layer)]);
      mixes[r] = hex(keccak256(abi.encode(['uint256', 'address', 'uint256'], [BigInt(mixes[r]), fromHex(m), BigInt(hex(layer))])));
    }
  }
  await mineTxs();
  assert.equal((await read('RoleElection', 'getDraw', [0n]))[0].status, 1n); // not drawn while the window is open
  assert.equal((await read('FinalityCommittee', 'members', [ep2])).length, 0); // the previous committee still signs
  const last = await read('FinalityCommittee', 'beacon', [BigInt(before + rounds - 1)]);
  while (BigInt(t.chain.tip.chainHeight) <= last.requestBlock + 62n) await mine(rich, 1);
  const tieRound = await read('FinalityCommittee', 'beacon', [BigInt(before)]);
  assert.equal(tieRound.closed, true);
  assert.equal(Number(tieRound.reveals), 21);
  const [d2] = await read('RoleElection', 'getDraw', [0n]);
  assert.equal(d2.status, 2n);
  assert.equal(d2.sourceKind, 3n); // the beacon
  const tieMixFirst = d2.sourceHash === mixes[0];
  assert.ok(tieMixFirst || d2.sourceHash === mixes[1], 'the tie is seeded by a beacon mix');
  const sortedTied = tied.slice().sort();
  const idx = await read('RoleElection', 'pick', [d2.sourceHash, 0n, 0n, 2n]);
  assert.equal(d2.winner, sortedTied[Number(idx)]);
  assert.equal((await read('RoleElection', 'holder', [0n])).who, d2.winner);
  const [cd1] = await read('FinalityCommittee', 'epochDraw', [ep2]);
  assert.equal(cd1.sourceKind, 3n); // the rotated committee is sealed from the beacon
  assert.equal(cd1.sourceHash, tieMixFirst ? mixes[1] : mixes[0]);
  assert.equal((await read('FinalityCommittee', 'members', [ep2])).length, 21);
  for (const m of members) assert.equal(await read('FinalityCommittee', 'missedReveal', [epoch, m]), false);
  await mine(rich, 1);
  await finaliseUpTo(); // the new committee now signs
  assert.equal(await read('FinalityCommittee', 'signerEpoch', [BigInt(t.chain.tip.header.timestamp), BigInt(t.chain.tip.chainHeight)]), ep2);

  // 8. every page renders against this populated state
  const node = { chain: t.chain, params: t.params, mempool: t.mempool, p2p: null, finality: null, opts: {}, log: (m) => { throw new Error(m); } };
  node.rpc = new Rpc({ chain: t.chain, mempool: t.mempool, p2p: null, finality: null, node });
  const ex = new Explorer(node);
  const pages = ['/', '/dag', '/blocks', '/block/1', '/txs', '/emission', '/network', '/ngos', `/ngo/${hex(ngos[0].addr)}`, '/ngo-submit', '/attestation',
    '/election', '/governance', '/roles', '/role-round/0', '/treasury', '/committee', '/metrics', `/address/${hex(ngos[0].addr)}`, `/address/${members[0]}`];
  for (const pth of pages) {
    const html = await ex.route(pth, new URLSearchParams());
    assert.ok(typeof html === 'string' && html.includes('</html>'), 'page ' + pth);
    assert.ok(!/spider/i.test(html), 'no "spider" on ' + pth);
  }
  assert.match(await ex.route('/ngos', new URLSearchParams()), /60 \/ 100/);
  assert.match(await ex.route('/committee', new URLSearchParams()), /Final checkpoint<strong>#\d+/);
  const rr = await ex.route('/role-round/0', new URLSearchParams());
  assert.match(rr, /Decided by draw/);
  assert.match(rr, new RegExp(d2.seed));
  assert.match(await ex.route('/roles', new URLSearchParams()), /decided by draw/);
  // published metrics (RISK_REVIEW.md Part 3): mining concentration over the last day, participation
  const met = await ex.metricsData();
  const tipH = t.chain.tip.chainHeight;
  const perMiner = new Map();
  for (let h = Math.max(1, tipH - 8640 + 1); h <= tipH; h++) {
    for (const x of t.chain.dag.get(t.chain.chain[h]).mergesetBlues) {
      if (x === t.chain.dag.genesis.hash) continue;
      const m = hex(t.chain.dag.get(x).header.miner);
      perMiner.set(m, (perMiner.get(m) ?? 0) + 1);
    }
  }
  const counts = [...perMiner.values()].sort((a, b) => b - a);
  const blues = counts.reduce((a, b) => a + b, 0);
  let acc = 0, nak = 0;
  for (const n of counts) { acc += n; nak++; if (acc * 2 > blues) break; }
  assert.equal(met.mining.blueBlocks, blues);
  assert.equal(met.mining.top[0].miner, hex(rich.addr)); // the rich test miner mined most blocks
  assert.equal(met.mining.top[0].blocks, counts[0]);
  assert.equal(met.mining.nakamoto, nak); // 30 vouchers mined 101 blocks each, so no single miner has a majority
  assert.ok(nak > 1);
  assert.equal(met.governance.ngos.elected, 60);
  assert.equal(met.governance.committee.members, 21);
  assert.ok(met.holdings.holders > 100);
  assert.deepEqual(await node.rpc.handle('psy_metrics', []), { tip: met.tip, chainHeight: met.chainHeight, mining: met.mining, holdings: met.holdings });
  assert.match(await ex.route('/metrics', new URLSearchParams()), /Nakamoto coefficient/);
  // P2: each group of 5 vouchers backed 10 NGOs, so every NGO shares its vouchers with exactly the 9 others of its group
  const nl = await ex.ngoList();
  for (const x of nl.out) assert.equal(x.sharesWith.length, 9, x.name);
  const g0 = new Set(ngos.slice(0, 10).map((n) => hex(n.addr).toLowerCase()));
  assert.ok(nl.out.find((x) => x.address.toLowerCase() === hex(ngos[0].addr).toLowerCase()).sharesWith.every((y) => g0.has(y.address.toLowerCase())));
  assert.match(await ex.route(`/ngo/${hex(ngos[0].addr)}`, new URLSearchParams()), /Its vouchers also back: <a/);
  // P4: the turnout panel on the election and metrics pages
  assert.match(await ex.route('/election', new URLSearchParams()), /Locked for voting: [\d,]+ PSY, [\d.]+ % of the circulating PSY/);
  assert.match(await ex.route('/metrics', new URLSearchParams()), /Locked for voting/);
  assert.match(ex.turnoutPanel({ mode: 'Bootstrap', lockedShareOfCirculating: 12.5, lockedPSY: '0' }), /class="panel turnout low".*Less than half/);
  assert.doesNotMatch(ex.turnoutPanel({ mode: 'Normal', lockedShareOfCirculating: 12.5, lockedPSY: '0' }), /Less than half/);
  const map = await ex.mapData(new URLSearchParams());
  assert.ok(map.txs.length > 0 && map.blocks.length > 0);
});

export { fromHex, u8ToHex };
