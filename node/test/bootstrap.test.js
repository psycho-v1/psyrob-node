// Bootstrap finality with a single signer (DAG_SPEC.md section 9.1): before the first committee is sealed, one signature of a
// bootstrap signer named in the genesis makes a checkpoint final; anyone else's does not; a final checkpoint stops a
// deeper reorganisation; certificates are bound to this launch (genesis time).

import test from 'node:test';
import assert from 'node:assert/strict';
import { testChain, key, mineOne, blockOn, hex } from './helpers.js';
import { checkpointDigest, BOOTSTRAP_EPOCH, BlockError } from '../src/consensus.js';
import { sig65 } from '../src/finality.js';
import { ADDR } from '../src/params.js';
import { contractCall } from '../src/evm.js';
import * as abi from '../../common/abi.js';

const A = key(1), C = key(3), BOOT = key(9), OTHER = key(10);

async function chainWithBootstrap() {
  const t = await testChain({ config: { bootstrapSigners: ['0x' + hex(BOOT.addr)] } });
  for (let i = 0; i < 40; i++) { t.advance(10); await mineOne(t, A); }
  return t;
}

function certFor(t, number, signers, { epoch = BOOTSTRAP_EPOCH, genesisTime = t.chain.dag.genesis.header.timestamp } = {}) {
  const cb = t.chain.dag.get(t.chain.chain[number * t.params.checkpointInterval]);
  const digest = checkpointDigest(t.params.chainId, genesisTime, number, cb.hashBytes, cb.stateRoot);
  return { number, chainBlock: cb.hashBytes, stateRoot: cb.stateRoot, epoch, sigs: signers.map((k) => sig65(digest, k.sk)) };
}

test('bootstrap finality: one dev-miner signature makes a checkpoint final; nobody else can', async () => {
  const t = await chainWithBootstrap();
  const active = await t.chain.readAtTip(async (view, ctx) => (await contractCall(view, t.params, ctx, { to: ADDR.finalityCommittee, data: abi.call('bootstrapActive()'), commit: false })).returnValue);
  assert.equal(active[31], 1, 'bootstrap is active until a committee is sealed');
  assert.equal(await t.chain.noteFinal(certFor(t, 1, [OTHER])), false, 'a signature of someone else is refused');
  assert.equal(await t.chain.noteFinal(certFor(t, 1, [BOOT], { epoch: 0 })), false, 'a committee epoch that has no committee is refused');
  assert.equal(await t.chain.noteFinal(certFor(t, 1, [BOOT], { genesisTime: 1 })), false, 'a signature for another launch of the chain ID is refused');
  assert.equal(await t.chain.noteFinal(certFor(t, 1, [BOOT])), true, 'the bootstrap signer alone finalises');
  assert.equal(t.chain.finalCheckpoint.number, 1);
});

test('bootstrap finality: a final checkpoint stops a reorganisation below it; the certificate is recorded on chain', async () => {
  const t = await chainWithBootstrap();
  // a competing branch forking below the checkpoint (height 30), prepared before finality
  const forkBase = t.chain.chain[20];
  t.advance(1);
  const first = await blockOn(t, [forkBase], C);
  assert.ok(await t.chain.noteFinal(certFor(t, 1, [BOOT])));
  await assert.rejects(t.chain.addBlock(first), (e) => e instanceof BlockError && /final checkpoint/.test(e.message), 'blocks on a branch without the final checkpoint are refused');
  // the certificate goes into a block and is recorded in FinalityCommittee (rewards bookkeeping, seeds)
  const cert = certFor(t, 1, [BOOT]);
  t.advance(10);
  await mineOne(t, A, { certs: [cert] });
  t.advance(10);
  await mineOne(t, A);
  const recorded = await t.chain.readAtTip(async (view, ctx) => (await contractCall(view, t.params, ctx, { to: ADDR.finalityCommittee, data: abi.call('checkpointRecorded(uint256)', ['uint256'], [1n]), commit: false })).returnValue);
  assert.equal(recorded[31], 1, 'recorded on chain');
});
