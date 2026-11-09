// ERC-20 tokens in the explorer: any contract emitting standard Transfer events shows up in the token list, on its own
// token page, in the holdings of the addresses involved, decoded on transaction pages and in search; nothing is
// hardcoded. Hostile token contracts cannot make pages expensive or inject markup.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { testChain, key, mineOne } from './helpers.js';
import { Explorer } from '../src/explorer.js';
import { Rpc } from '../src/rpc.js';
import { withLang } from '../src/i18n.js';
import { signTx } from '../src/tx.js';
import { TokenLedger, TRANSFER_TOPIC } from '../src/tokenindex.js';
import { units, cleanText } from '../src/explorer-tokens.js';
import { contract, encodeParams } from '../../common/abicodec.js';
import { bytesToHex, fromHex, concat } from '../../common/bytes.js';
import { keccak256 } from '../../common/crypto.js';
import * as rlp from '../../common/rlp.js';

const FIX = JSON.parse(fs.readFileSync(new URL('./fixtures/test-token.json', import.meta.url), 'utf8'));
const C = contract(FIX.abi, keccak256);
const A = key(1), B = key(2), D = key(3);
const hx = (b) => '0x' + bytesToHex(b);
const createdAddress = (from, nonce) => keccak256(rlp.encode([from, rlp.int(nonce)])).slice(12);

async function setup() {
  const t = await testChain({ params: { maxSupply: 10n ** 30n } });
  for (let i = 0; i < 3; i++) { t.advance(10); await mineOne(t, A); }
  let nonce = t.chain.state.getAccount(A.addr).nonce;
  const sent = [];
  const send = async (from, to, data, gasLimit = 2_000_000n) => {
    const n = from === A ? nonce++ : t.chain.state.getAccount(from.addr).nonce;
    const tx = signTx({ type: 2, nonce: n, to, data, value: 0n, gasLimit, maxFee: 20_000_000_000n, maxPriorityFee: 1n }, from.sk, t.params);
    await t.chain.readAtTip((v, ctx) => t.mempool.add(tx.raw, v, ctx.baseFee, ctx.timestamp));
    sent.push(hx(tx.hash));
    return tx;
  };
  const mine = async (n = 2) => { for (let i = 0; i < n; i++) { t.advance(10); await mineOne(t, A, { gasLimit: t.params.blockGasLimit }); await t.chain.readAtTip((v) => t.mempool.prune(v)); } };
  const deploy = async (name, symbol, decimals, supply) => {
    const addr = createdAddress(A.addr, nonce);
    const args = encodeParams([{ type: 'string' }, { type: 'string' }, { type: 'uint8' }, { type: 'uint256' }], [name, symbol, BigInt(decimals), supply]);
    await send(A, new Uint8Array(0), concat(fromHex(FIX.bytecode), args), 3_000_000n);
    return hx(addr);
  };
  const call = (token, fn, args, from = A) => send(from, fromHex(token), C.encode(fn, args), 200_000n);
  return { t, send, mine, deploy, call, sent };
}

function explorer(t) {
  const node = { chain: t.chain, params: t.params, mempool: t.mempool, p2p: null, finality: null, opts: { vhosts: ['*'] }, log: () => {} };
  node.rpc = new Rpc({ chain: t.chain, mempool: t.mempool, p2p: null, finality: null, node });
  const ex = new Explorer(node);
  const page = (path, lang = 'en') => {
    const u = new URL(path, 'http://x');
    return withLang(lang, () => ex.route(u.pathname, u.searchParams), { path: u.pathname, query: u.search });
  };
  return { ex, page };
}

test('tokens: any ERC-20 appears in the list, its page, holdings, transactions and search', { timeout: 300_000 }, async () => {
  const { t, mine, deploy, call, sent } = await setup();
  const gold = await deploy('Gold Test', 'GLDT', 18, 1_000_000n * 10n ** 18n);
  const cent = await deploy('Cent <b>Token</b>‮', 'CNT', 2, 50_000n);
  await mine(3);
  await call(gold, 'transfer', [hx(B.addr), 2_500n * 10n ** 18n]);
  await call(cent, 'transfer', [hx(B.addr), 1_234n]);
  await call(gold, 'burn', [10n ** 18n]);
  await mine(3);
  const transferTx = sent[2];
  // the chain agrees with the contract
  const { ex, page } = explorer(t);

  const list = await page('/tokens');
  assert.match(list, /Gold Test/);
  assert.match(list, /GLDT/);
  assert.match(list, /CNT/);
  assert.doesNotMatch(list, /<b>Token<\/b>/, 'token names are escaped');
  assert.doesNotMatch(list, /‮/, 'direction overrides are stripped');
  assert.match(list, /2 tokens/);

  const tp = await page('/token/' + gold);
  assert.match(tp, /Gold Test/);
  assert.match(tp, /999,999 GLDT/, 'total supply after the burn, with decimals');
  assert.match(tp, /997,499 GLDT/, 'the deployer keeps the rest');
  assert.match(tp, /2,500 GLDT/);
  assert.match(tp, /Holders<\/th><td>2</);

  const ap = await page('/address/' + hx(B.addr));
  assert.match(ap, /Token holdings/);
  assert.match(ap, /2,500 GLDT/);
  assert.match(ap, /12\.34 CNT/, 'two decimals');
  assert.match(ap, /Recent token transfers/);
  const tokenAddrPage = await page('/address/' + gold);
  assert.match(tokenAddrPage, /This address is a token contract/);

  const txp = await page('/tx/' + transferTx);
  assert.match(txp, /Token transfers/);
  assert.match(txp, /2,500 GLDT/);

  assert.deepEqual(await page('/search?q=gldt'), { redirect: '/token/' + gold }, 'symbol search, any case');
  assert.deepEqual(await page('/search?q=Gold%20Test'), { redirect: '/token/' + gold });
  assert.deepEqual(await page('/search?q=' + gold), { redirect: '/token/' + gold }, 'a token contract address opens the token');
  assert.deepEqual(await page('/search?q=' + hx(B.addr)), { redirect: '/address/' + hx(B.addr) });

  // event balances match balanceOf
  const L = ex.tokenLedger();
  const onChain = BigInt(await ex.node.rpc.handle('eth_call', [{ to: gold, data: hx(C.encode('balanceOf', [hx(B.addr)])) }]));
  assert.equal(L.tokens.get(gold).holders.get(hx(B.addr)), onChain);

  // other languages render the token pages too
  assert.match(await page('/token/' + gold, 'de'), /Gold Test/);
});

test('tokens: a hostile token cannot make a page slow', { timeout: 120_000 }, async () => {
  const { t, send, mine } = await setup();
  // runtime: JUMPDEST PUSH1 0 JUMP (every call loops until its gas runs out); init code returns it
  const runtime = '5b600056';
  const init = '63' + runtime + '600052' + '6004601cf3';
  const addr = hx(createdAddress(A.addr, t.chain.state.getAccount(A.addr).nonce));
  await send(A, new Uint8Array(0), fromHex('0x' + init), 200_000n);
  await mine(2);
  const { page } = explorer(t);
  const a = performance.now();
  const html = await page('/token/' + addr);
  assert.ok(performance.now() - a < 3_000, 'four metadata reads with a small gas budget each');
  assert.match(html, /No ERC-20 transfers/);
});

test('token ledger: balances, caps and undo', () => {
  const L = new TokenLedger();
  const tok = '0x' + 'aa'.repeat(20), z = '0x' + '00'.repeat(20), x = '0x' + '11'.repeat(20), y = '0x' + '22'.repeat(20);
  const u1 = L.apply(tok, z, x, 100n, 1, '0x01', 0);
  const u2 = L.apply(tok, x, y, 30n, 2, '0x02', 0);
  assert.deepEqual(L.holders(tok), [[x, 70n], [y, 30n]]);
  assert.deepEqual(L.balancesOf(y), [{ token: tok, balance: 30n }]);
  u2();
  assert.deepEqual(L.holders(tok), [[x, 100n]]);
  assert.deepEqual(L.balancesOf(y), []);
  u1();
  assert.equal(L.tokens.size, 0, 'undoing the first transfer forgets the token');
  // ERC-721 Transfer (token id indexed, no data) is not an ERC-20 transfer
  const topic = fromHex('0x' + TRANSFER_TOPIC), w = new Uint8Array(32);
  assert.equal(TokenLedger.isTransfer({ topics: [topic, w, w], data: w }), true);
  assert.equal(TokenLedger.isTransfer({ topics: [topic, w, w, w], data: new Uint8Array(0) }), false);
  assert.equal(units(123456789n, 6), '123.456789');
  assert.equal(units(5n, 0), '5');
  assert.equal(cleanText('a\u0000b‮c' + 'x'.repeat(60)).length, 41);
});
