// Bootstrap finality: the quorum is a contract value (2 of 3 at launch), a node may hold several bootstrap keys
// and signs with each, and the first final certificate for a checkpoint number wins.

import test from 'node:test';
import assert from 'node:assert/strict';
import { testChain, key, mineOne, blockOn, hex } from './helpers.js';
import { checkpointDigest, BOOTSTRAP_EPOCH } from '../src/consensus.js';
import { sig65, Finality } from '../src/finality.js';
import { ADDR } from '../src/params.js';
import { contractCall } from '../src/evm.js';
import * as abi from '../../common/abi.js';

const A = key(1), B1 = key(11), B2 = key(12), B3 = key(13), OTHER = key(14);

async function chain2of3(extra = 40) {
  const t = await testChain({ config: { bootstrapSigners: [B1, B2, B3].map((k) => '0x' + hex(k.addr)), bootstrapQuorum: 2 } });
  for (let i = 0; i < extra; i++) { t.advance(10); await mineOne(t, A); }
  return t;
}

function certFor(t, number, signers, chainBlock = null) {
  const cb = chainBlock ?? t.chain.dag.get(t.chain.chain[number * t.params.checkpointInterval]);
  const digest = checkpointDigest(t.params.chainId, t.chain.dag.genesis.header.timestamp, number, cb.hashBytes, cb.stateRoot);
  return { number, chainBlock: cb.hashBytes, stateRoot: cb.stateRoot, epoch: BOOTSTRAP_EPOCH, sigs: signers.map((k) => sig65(digest, k.sk)) };
}

test('2 of 3: one bootstrap signature is not enough, two are; outsiders do not count', async () => {
  const t = await chain2of3();
  const q = await t.chain.readAtTip(async (view, ctx) => (await contractCall(view, t.params, ctx, { to: ADDR.finalityCommittee, data: abi.call('bootstrapQuorum()'), commit: false })).returnValue);
  assert.equal(q[31], 2, 'the quorum is in the contract');
  assert.equal(await t.chain.noteFinal(certFor(t, 1, [B1])), false, 'one of three');
  assert.equal(await t.chain.noteFinal(certFor(t, 1, [B1, OTHER])), false, 'one plus an outsider');
  assert.equal(await t.chain.noteFinal(certFor(t, 1, [B2, B2])), false, 'the same key twice');
  assert.equal(await t.chain.noteFinal(certFor(t, 1, [B1, B3])), true, 'two of three');
  assert.equal(t.chain.finalCheckpoint.number, 1);
});

test('a node holding two bootstrap keys signs with both and finalises; the first certificate for a number wins', async () => {
  const t = await chain2of3(70);
  const certs = [];
  const fin = new Finality({ chain: t.chain, p2p: { broadcastSig() {}, broadcastCert(c) { certs.push(c); } }, store: null, signerKeys: [B1.sk, B2.sk] });
  assert.deepEqual(fin.status().signers, ['0x' + hex(B1.addr), '0x' + hex(B2.addr)]);
  await fin.onTip();
  assert.ok(t.chain.finalCheckpoint.number >= 1, 'final with the node\'s own two signatures');
  assert.ok(certs.length >= 1 && certs[0].sigs.length === 2, 'and the certificate went out');
  // a second, different certificate for an already final number (another block at that height) is refused
  const n = t.chain.finalCheckpoint.number;
  const fake = { ...certFor(t, n, [B2, B3]), chainBlock: new Uint8Array(32).fill(7) };
  const digest = checkpointDigest(t.params.chainId, t.chain.dag.genesis.header.timestamp, n, fake.chainBlock, fake.stateRoot);
  fake.sigs = [B2, B3].map((k) => sig65(digest, k.sk));
  assert.equal(await t.chain.noteFinal(fake), false, 'the first final certificate stands');
  // signing again after a restart never produces a second signature for a number already signed
  const again = new Finality({ chain: t.chain, p2p: { broadcastSig() {}, broadcastCert() {} }, store: { readJson: () => [...fin.signed], writeJson() {} }, signerKeys: [B1.sk, B2.sk] });
  const before = again.signed.size;
  await again.onTip();
  assert.equal(again.signed.size, before, 'nothing signed twice');
});

test('bootstrap quorum must be a majority in the genesis config', async () => {
  await assert.rejects(testChain({ config: { bootstrapSigners: [B1, B2, B3].map((k) => '0x' + hex(k.addr)), bootstrapQuorum: 1 } }), /more than half/);
  await assert.rejects(testChain({ config: { bootstrapSigners: [B1, B2].map((k) => '0x' + hex(k.addr)), bootstrapQuorum: 1 } }), /more than half/);
});

test('a block on a branch that excludes a 2-of-3 final checkpoint is refused', async () => {
  const t = await chain2of3();
  const fork = await blockOn(t, [t.chain.chain[20]], key(3));
  assert.ok(await t.chain.noteFinal(certFor(t, 1, [B2, B3])));
  await assert.rejects(t.chain.addBlock(fork), /final checkpoint/);
});
