import test from 'node:test';
import assert from 'node:assert/strict';
import { selfTest, availableImpls, powHash, checkPow, workOf } from '../pow.js';
import { encodeHeader, decodeHeader, signHeader, minerSigner, signingBytes, headerHash, HEADER_VERSION } from '../header.js';
import { privateKeyToAddress, keccak256 } from '../crypto.js';
import { contract, encodeParams, decodeParams } from '../abicodec.js';
import { bytesToHex } from '../bytes.js';

const sk = Uint8Array.from(Buffer.from('22'.repeat(32), 'hex'));
const header = () => ({
  version: HEADER_VERSION, parents: [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)], timestamp: 1_800_000_000, target: (1n << 255n), blueScore: 5n, blueWork: 77n,
  stateRoot: new Uint8Array(32).fill(3), txRoot: new Uint8Array(32).fill(4), receiptsRoot: new Uint8Array(32).fill(5), acceptedTxRoot: new Uint8Array(32).fill(6),
  gasLimit: 10_000_000n, gasUsed: 0n, baseFee: 1_000_000_000n, miner: privateKeyToAddress(sk), extra: new Uint8Array(0), nonce: 42n, minerSig: new Uint8Array(65),
});

test('pow: every available Argon2d implementation matches the fixed vectors', () => {
  assert.ok(availableImpls().includes('wasm-simd') || availableImpls().includes('wasm-ref'));
  selfTest(availableImpls(), { maxMemoryKiB: 4096 });
  const a = powHash(new Uint8Array([1, 2, 3]), { memoryKiB: 8, iterations: 1 });
  assert.equal(a.length, 32);
  assert.equal(workOf((1n << 256n) - 1n), 1n);
});

test('header: encode/decode round trip, signature binds the miner, canonical form enforced', () => {
  const h = header();
  signHeader(h, sk);
  const raw = encodeHeader(h);
  const d = decodeHeader(raw);
  assert.equal(bytesToHex(headerHash(d)), bytesToHex(keccak256(raw)));
  assert.equal(bytesToHex(minerSigner(d)), bytesToHex(privateKeyToAddress(sk)));
  d.nonce = 43n; // changing the nonce invalidates the signature (it signs the nonce)
  assert.notEqual(bytesToHex(minerSigner(d) ?? new Uint8Array(20)), bytesToHex(privateKeyToAddress(sk)));
  const bad = header(); bad.parents = [new Uint8Array(32).fill(2), new Uint8Array(32).fill(1)]; signHeader(bad, sk);
  assert.throws(() => decodeHeader(encodeHeader(bad)), /sorted/);
  const many = header(); many.parents = Array.from({ length: 11 }, (_, i) => new Uint8Array(32).fill(i + 1)); signHeader(many, sk);
  assert.throws(() => decodeHeader(encodeHeader(many)), /parents/);
  // the proof of work covers the signature: same nonce, different signature bytes -> different hash
  const h2 = header(); signHeader(h2, sk);
  const p1 = bytesToHex(powHash(encodeHeader(h2), { memoryKiB: 8, iterations: 1 }));
  h2.minerSig = new Uint8Array(65);
  assert.notEqual(bytesToHex(powHash(encodeHeader(h2), { memoryKiB: 8, iterations: 1 })), p1);
  assert.ok(checkPow(signingBytes(h2), (1n << 256n) - 1n, { memoryKiB: 8, iterations: 1 }));
});

test('abicodec: nested dynamic tuples and arrays round trip; selectors', () => {
  const params = [{ type: 'tuple', components: [{ name: 'name', type: 'string' }, { name: 'n', type: 'uint64' }, { name: 'list', type: 'address[]' }] }, { type: 'bytes32[2]' }, { type: 'bool' }];
  const v = [{ name: 'Example', n: 7n, list: ['0x' + '11'.repeat(20), '0x' + '22'.repeat(20)] }, ['0x' + 'aa'.repeat(32), '0x' + 'bb'.repeat(32)], true];
  const out = decodeParams(params, encodeParams(params, v));
  assert.deepEqual(out[0], { name: 'Example', n: 7n, list: v[0].list });
  assert.deepEqual(out[1], v[1]);
  assert.equal(out[2], true);
  const c = contract([{ type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }], keccak256);
  assert.equal(c.selector('transfer'), '0xa9059cbb');
});
