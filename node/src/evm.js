// EVM integration (@ethereumjs/evm, Shanghai).
//
// - State: EvmState implements the ethereumjs StateManagerInterface over StateView stacks (checkpoint = push a view).
// - Block context (DAG_SPEC.md section 5): NUMBER = chain height of the accepting chain block, TIMESTAMP = its
//   timestamp, COINBASE = miner of the block that contained the transaction, BASEFEE = the accepting block's base fee,
//   PREVRANDAO = hash of its selected parent, BLOCKHASH = chain block hashes by chain height (last 256).
// - Fees: the sender buys gasLimit * effectiveGasPrice, is refunded the unused part; gasUsed * baseFee is burned, the
//   priority part is returned to the caller to credit (execute.js decides the recipient).

import { createEVM, EVMError } from '@ethereumjs/evm';
import { createCustomCommon, Mainnet, Hardfork } from '@ethereumjs/common';
import { Address, Account, KECCAK256_RLP } from '@ethereumjs/util';
import { keccak256 } from '../../common/crypto.js';
import { bytesToBigint, bigintToBytes, bytesToHex, equals, hexToBytes } from '../../common/bytes.js';
import { KECCAK_EMPTY } from './state.js';
import { SYSTEM_ADDRESS } from './params.js';
import { effectiveGasPrice } from './tx.js';

const EMPTY = new Uint8Array(0);

export class CallError extends Error {
  constructor(message, extra = {}) { super(message); Object.assign(this, extra); }
}

export class EvmState {
  constructor(txView, originalView) {
    this.stack = [txView];
    this.original = originalView;
    this.originalStorageCache = {
      get: async (address, key) => bigintToBytes(this.original.getStorage(address.bytes, setLen32(key))),
      clear: () => {},
    };
  }
  get top() { return this.stack[this.stack.length - 1]; }
  async getAccount(address) {
    const a = this.top.getAccount(address.bytes);
    if (a.nonce === 0n && a.balance === 0n && equals(a.codeHash, KECCAK_EMPTY)) return undefined;
    return new Account(a.nonce, a.balance, KECCAK256_RLP, a.codeHash);
  }
  async putAccount(address, account) {
    if (account === undefined) return this.deleteAccount(address);
    this.top.setAccount(address.bytes, { nonce: account.nonce, balance: account.balance, codeHash: account.codeHash });
  }
  async deleteAccount(address) { this.top.deleteAccount(address.bytes); }
  async modifyAccountFields(address, fields) {
    const acc = (await this.getAccount(address)) ?? new Account();
    if (fields.nonce !== undefined) acc.nonce = fields.nonce;
    if (fields.balance !== undefined) acc.balance = fields.balance;
    if (fields.codeHash !== undefined) acc.codeHash = fields.codeHash;
    await this.putAccount(address, acc);
  }
  async putCode(address, code) {
    this.top.setCode(address.bytes, code);
    this.top.setAccount(address.bytes, { codeHash: code.length ? keccak256(code) : KECCAK_EMPTY });
  }
  async getCode(address) { return this.top.getCode(address.bytes); }
  async getCodeSize(address) { return this.top.getCode(address.bytes).length; }
  async getStorage(address, key) { return bigintToBytes(this.top.getStorage(address.bytes, setLen32(key))); }
  async putStorage(address, key, value) { this.top.setStorage(address.bytes, setLen32(key), bytesToBigint(value)); }
  async clearStorage(address) { this.top.clearStorage(address.bytes); }
  async checkpoint() { this.stack.push(this.top.view()); }
  async commit() { if (this.stack.length < 2) throw new Error('evm state: commit without checkpoint'); this.stack.pop().mergeIntoParent(); }
  async revert() { if (this.stack.length < 2) throw new Error('evm state: revert without checkpoint'); this.stack.pop(); }
  async getStateRoot() { throw new Error('evm state: no state root during execution'); }
  async setStateRoot() { throw new Error('evm state: setStateRoot is not supported'); }
  async hasStateRoot() { return false; }
  clearCaches() {}
  shallowCopy() { throw new Error('evm state: shallowCopy is not supported'); }
}

function setLen32(key) {
  if (key.length === 32) return key;
  if (key.length > 32) throw new Error('storage key longer than 32 bytes');
  const out = new Uint8Array(32);
  out.set(key, 32 - key.length);
  return out;
}

let commonTemplate = null;
function makeCommon(chainId) {
  if (!commonTemplate || commonTemplate.chainId !== chainId) {
    commonTemplate = { chainId, common: createCustomCommon({ chainId: Number(chainId), name: 'psyrob', networkId: Number(chainId) }, Mainnet, { hardfork: Hardfork.Shanghai }) };
  }
  return commonTemplate.common.copy();
}

/**
 * ctx = { number, timestamp, coinbase, baseFee, prevRandao, gasLimit, blockHash(n) -> bytes|null }
 */
async function buildEvm(p, state, ctx) {
  const evm = await createEVM({
    common: makeCommon(p.chainId),
    stateManager: state,
    blockchain: {
      getBlock: async (n) => {
        const h = Number(n) < ctx.number ? ctx.blockHash?.(Number(n)) : null;
        if (!h) throw new Error('BLOCKHASH: unknown block');
        return { hash: () => h };
      },
      shallowCopy() { return this; },
    },
  });
  const block = {
    header: {
      number: BigInt(ctx.number), coinbase: new Address(ctx.coinbase), timestamp: BigInt(ctx.timestamp), difficulty: 0n,
      prevRandao: ctx.prevRandao ?? new Uint8Array(32), gasLimit: ctx.gasLimit ?? p.blockGasLimit, baseFeePerGas: ctx.baseFee,
      slotNumber: 0n, getBlobGasPrice: () => undefined,
    },
  };
  return { evm, block };
}

function warm(evm, addrs) {
  for (const a of addrs) evm.journal.addAlwaysWarmAddress(bytesToHex(a));
  for (const a of evm.precompiles.keys()) evm.journal.addAlwaysWarmAddress(a);
}

export function intrinsicGas(tx, p) {
  let gas = p.txBaseGas;
  for (const b of tx.data) gas += b === 0 ? p.txDataZeroGas : p.txDataNonZeroGas;
  if (tx.to.length === 0) gas += p.txCreateGas + p.initCodeWordGas * BigInt(Math.ceil(tx.data.length / 32));
  return gas;
}

/**
 * Why a transaction cannot be accepted now, or null. These are the "skip" conditions of DAG_SPEC.md section 5 (except
 * duplicates and the mergeset gas budget, which execute.js checks). Shared with the mempool.
 */
export function skipReason(view, tx, baseFee, p) {
  if (tx.maxFee < baseFee) return 'max fee below base fee';
  if (tx.gasLimit > p.blockGasLimit) return 'gas limit above block gas limit';
  if (tx.gasLimit < intrinsicGas(tx, p)) return 'intrinsic gas too low';
  if (equals(tx.from, SYSTEM_ADDRESS)) return 'system address cannot send';
  if (tx.to.length === 0 && tx.data.length > p.maxInitCodeSize) return 'init code too large';
  const sender = view.getAccount(tx.from);
  if (!equals(sender.codeHash, KECCAK_EMPTY)) return 'sender has code';
  if (tx.nonce !== sender.nonce) return `nonce ${tx.nonce}, expected ${sender.nonce}`;
  if (sender.balance < tx.value + tx.gasLimit * tx.maxFee) return 'insufficient funds';
  return null;
}

/** Execute an accepted transaction on `view` (skipReason must be null). Returns the receipt fields. */
export async function runTx(view, tx, ctx, p) {
  const price = effectiveGasPrice(tx, ctx.baseFee);
  const intrinsic = intrinsicGas(tx, p);
  const create = tx.to.length === 0;
  const sender = view.getAccount(tx.from);
  view.setAccount(tx.from, { balance: sender.balance - tx.gasLimit * price });
  const txView = view.view();
  const state = new EvmState(txView, view);
  const { evm, block } = await buildEvm(p, state, ctx);
  warm(evm, [tx.from, ctx.coinbase, ...(create ? [] : [tx.to])]);
  const res = await evm.runCall({
    caller: new Address(tx.from), origin: new Address(tx.from), to: create ? undefined : new Address(tx.to),
    value: tx.value, data: tx.data, gasLimit: tx.gasLimit - intrinsic, gasPrice: price, block,
  });
  const r = res.execResult;
  const err = r.exceptionError;
  if (state.stack.length !== 1) throw new Error('internal: unbalanced EVM checkpoints');
  if (!err && r.selfdestruct) for (const a of r.selfdestruct.keys()) txView.deleteAccount(hexToBytes(a.replace(/^0x/, '')));
  // Value conservation: execution may destroy wei (SELFDESTRUCT); count it as burned so supply checks hold.
  let delta = 0n;
  for (const [k, v] of txView.changes) if (k[0] === 'a') delta += (v?.balance ?? 0n) - (view.get(k)?.balance ?? 0n);
  if (delta > 0n) throw new Error('internal: EVM execution created wei');
  if (delta < 0n) txView.setGlobal({ burned: txView.getGlobal().burned - delta });
  txView.mergeIntoParent();
  // ethereumjs increments the caller nonce at depth 0; a reverted call may roll that back. The rule is simple: an
  // accepted transaction always advances the sender nonce by exactly one.
  view.setAccount(tx.from, { nonce: tx.nonce + 1n });
  const used = intrinsic + r.executionGasUsed;
  const refundCap = used / 5n;
  const refund = err ? 0n : ((r.gasRefund ?? 0n) < refundCap ? (r.gasRefund ?? 0n) : refundCap);
  const gasUsed = used - refund;
  const s = view.getAccount(tx.from);
  view.setAccount(tx.from, { balance: s.balance + (tx.gasLimit - gasUsed) * price });
  const burned = gasUsed * ctx.baseFee;
  const tip = gasUsed * (price - ctx.baseFee);
  const logs = err ? [] : (r.logs ?? []).map(([address, topics, data]) => ({ address, topics, data }));
  const contractAddress = create && !err && res.createdAddress ? res.createdAddress.bytes : null;
  return { status: err ? 0 : 1, gasUsed, effectiveGasPrice: price, burned, tip, logs, contractAddress, failure: err ? err.error : undefined };
}

/**
 * Message call without fee, signature or nonce: system calls, genesis set-up and reads. On success the changes are
 * merged into `view` unless commit is false. Never throws for a revert.
 */
export async function contractCall(view, p, ctx, { caller = SYSTEM_ADDRESS, to, data = EMPTY, value = 0n, gasLimit = p.systemCallGas, commit = true }) {
  const txView = view.view();
  const state = new EvmState(txView, view);
  const { evm, block } = await buildEvm(p, state, ctx);
  warm(evm, [caller, to]);
  const res = await evm.runCall({
    caller: new Address(caller), origin: new Address(caller), to: new Address(to), value, data, gasLimit, gasPrice: 0n, block, skipBalance: value === 0n, skipNonceIncrement: true,
  });
  const r = res.execResult;
  const returnValue = r.returnValue ?? EMPTY;
  if (r.exceptionError) return { status: 0, returnValue, gasUsed: r.executionGasUsed, logs: [], error: r.exceptionError.error, reason: revertReason(returnValue) };
  if (commit) txView.mergeIntoParent();
  const logs = (r.logs ?? []).map(([address, topics, data]) => ({ address, topics, data }));
  return { status: 1, returnValue, gasUsed: r.executionGasUsed, logs, error: null, reason: '' };
}

/** Run init code at a fixed address (genesis only): the constructor runs and its runtime code is stored there. */
export async function genesisCreate(view, p, ctx, { address, initCode, value = 0n }) {
  view.setAccount(address, { nonce: 1n }); // the account must exist before the constructor writes storage
  const txView = view.view();
  const state = new EvmState(txView, view);
  const { evm, block } = await buildEvm(p, state, ctx);
  const res = await evm.runCode({ code: initCode, data: EMPTY, gasLimit: p.systemCallGas, to: new Address(address), caller: new Address(SYSTEM_ADDRESS), origin: new Address(SYSTEM_ADDRESS), value, block, isStatic: false });
  if (res.exceptionError) throw new Error(`genesis: constructor at 0x${bytesToHex(address)} failed: ${res.exceptionError.error} ${revertReason(res.returnValue ?? EMPTY)}`);
  if (state.stack.length !== 1) throw new Error('internal: unbalanced EVM checkpoints');
  txView.mergeIntoParent();
  await new EvmState(view, view).putCode(new Address(address), res.returnValue);
  view.setAccount(address, { nonce: 1n });
  return res;
}

/** eth_call / eth_estimateGas on a discarded view (deadline in wall-clock ms only aborts the simulation). */
export async function simulate(view, p, ctx, call, { deadlineMs = 1000 } = {}) {
  const intrinsic = intrinsicGas({ to: call.to, data: call.data }, p);
  if (call.gas < intrinsic) throw new CallError('gas below intrinsic gas');
  const deadline = Date.now() + deadlineMs;
  const run = async (gas) => {
    const v = view.view();
    const state = new EvmState(v.view(), v);
    const { evm, block } = await buildEvm(p, state, ctx);
    let steps = 0, timedOut = false;
    evm.events.on('step', () => { if (++steps % 512 === 0 && Date.now() > deadline) { timedOut = true; throw new Error('simulation time limit exceeded'); } });
    const from = call.from ?? new Uint8Array(20);
    warm(evm, [from, ...(call.to.length ? [call.to] : [])]);
    const res = await evm.runCall({
      caller: new Address(from), origin: new Address(from), to: call.to.length ? new Address(call.to) : undefined,
      value: call.value, data: call.data, gasLimit: gas - intrinsic, gasPrice: 0n, block, skipBalance: true,
    });
    if (timedOut) throw new CallError('simulation time limit exceeded');
    const r = res.execResult;
    const used = intrinsic + r.executionGasUsed;
    const refund = r.exceptionError ? 0n : ((r.gasRefund ?? 0n) < used / 5n ? (r.gasRefund ?? 0n) : used / 5n);
    return { err: r.exceptionError, returnValue: r.returnValue ?? EMPTY, gasUsed: used - refund };
  };
  const first = await run(call.gas);
  if (first.err) {
    if (first.err.error === EVMError.errorMessages.REVERT) throw new CallError('execution reverted' + reasonText(first.returnValue), { revert: true, data: first.returnValue });
    throw new CallError('execution failed: ' + first.err.error);
  }
  if (!call.forEstimate) return { returnValue: first.returnValue, gasUsed: first.gasUsed };
  let lo = first.gasUsed - 1n, hi = call.gas;
  for (let i = 0; i < 24 && hi - lo > 1n; i++) {
    if (Date.now() > deadline) break;
    const mid = (lo + hi) / 2n;
    const r = mid < intrinsic ? { err: true } : await run(mid);
    if (r.err) lo = mid; else hi = mid;
  }
  return { returnValue: first.returnValue, gasUsed: hi };
}

export function revertReason(data) {
  const s = reasonText(data);
  if (s) return s.slice(2);
  if (data.length >= 4) return '0x' + bytesToHex(data.subarray(0, 4));
  return '';
}

function reasonText(data) {
  try {
    if (data.length >= 68 && data[0] === 0x08 && data[1] === 0xc3 && data[2] === 0x79 && data[3] === 0xa0) {
      const len = Number(bytesToBigint(data.subarray(36, 68)));
      return ': ' + new TextDecoder().decode(data.subarray(68, 68 + len));
    }
  } catch { /* not Error(string) */ }
  return '';
}
