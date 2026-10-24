#!/usr/bin/env node
// PSYROB wallet commands. Keys live in files (hex, mode 0600) outside the repository; they are never printed.
//
//   new --out <file>                                    create a key file; prints only the address
//   address --key <file>                                the key's address
//   balance <address>                                   balance and nonce
//   send --key <file> --to <address> --value <PSY>      transfer PSY
//   tx --key <file> <Contract> <function> [args...] [--value <PSY>]
//                                                       send a contract call (system contracts by name, see below)
//   read <Contract> <function> [args...]                read-only call
//   calldata <Contract> <function> [args...]            print calldata (for governance proposals)
//   contracts                                           list system contracts and their functions
//
// Common options: --node <url> (default http://127.0.0.1:8770), --yes (no confirmation prompt).
// Arguments: addresses as 0x…, numbers as decimal, lists as comma-separated, PSY amounts as "psy:12.5", bytes32 as 0x…,
// text hashes as "sha256:<text>".
//
// Wallet loss is permanent. Back up every key file offline; nothing on the network can recover it.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { createHash } from 'node:crypto';
import { randomPrivateKey, privateKeyToAddress, keccak256 } from '../../common/crypto.js';
import { bytesToHex, fromHex } from '../../common/bytes.js';
import { contract, u8ToHex } from '../../common/abicodec.js';
import { artifacts } from '../src/genesis.js';
import { ADDR, makeParams, artifactName } from '../src/params.js';
import { signTx } from '../src/tx.js';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const flag = (n) => { const i = argv.indexOf('--' + n); if (i < 0) return false; argv.splice(i, 1); return true; };
const NODE = opt('node', 'http://127.0.0.1:8770');
const YES = flag('yes');
const NAMES = { GovernanceMode: 'governanceMode', Params: 'params', MinerRegistry: 'minerRegistry', NGORegistry: 'ngoRegistry', Attestation: 'attestation',
  VoteEscrow: 'voteEscrow', NGOElection: 'ngoElection', RoleElection: 'roleElection', Governor: 'governor', Treasury: 'treasury', DevVesting: 'devVesting', DevVesting2: 'devVesting2', DevVesting3: 'devVesting3',
  NGORewards: 'ngoRewards', FinalityCommittee: 'finalityCommittee', FundApprovals: 'fundApprovals' };

function usage(code = 2) {
  const src = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n');
  console.log(src.slice(1, src.findIndex((l) => l.startsWith('import'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(code);
}

async function rpc(method, params = []) {
  const r = await fetch(NODE.replace(/\/$/, '') + '/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) {
    const sel = typeof j.error.data === 'string' ? j.error.data.slice(0, 10) : null;
    throw new Error(sel && errorNames()[sel] ? `reverted with ${errorNames()[sel]}` : j.error.message);
  }
  return j.result;
}

let errorCache = null;
function errorNames() {
  if (!errorCache) {
    errorCache = {};
    for (const a of Object.values(artifacts())) for (const e of a.abi.filter((f) => f.type === 'error')) {
      const sig = `${e.name}(${e.inputs.map((i) => i.type).join(',')})`;
      errorCache['0x' + bytesToHex(keccak256(new TextEncoder().encode(sig)).slice(0, 4))] = sig;
    }
  }
  return errorCache;
}

function readKey(file) {
  if (!file) throw new Error('--key <file> is required');
  if ((fs.statSync(file).mode & 0o077) !== 0) throw new Error(`key file ${file} must not be readable by others (chmod 600)`);
  const hex = fs.readFileSync(file, 'utf8').trim().replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('the key file must hold one 32-byte hex private key');
  return Uint8Array.from(Buffer.from(hex, 'hex'));
}

function psyToWei(s) {
  if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new Error('bad PSY amount ' + s);
  const [i, f = ''] = s.split('.');
  return BigInt(i) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
}
const fmt = (wei) => (Number(wei / 10n ** 12n) / 1e6).toLocaleString('en-US', { maximumFractionDigits: 6 });

function codec(name) {
  const a = artifacts()[artifactName(name)];
  if (!a || !NAMES[name]) throw new Error(`unknown contract ${name}; see "contracts"`);
  return { c: contract(a.abi, keccak256), addr: '0x' + bytesToHex(ADDR[NAMES[name]]), abi: a.abi };
}

function parseArg(input, s) {
  const t = input.type;
  if (t.endsWith('[]')) return s === '' ? [] : s.split(',').map((x) => parseArg({ type: t.slice(0, -2) }, x.trim()));
  if (t === 'address') { if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error('not an address: ' + s); return s; }
  if (t === 'bool') return /^(true|yes|1)$/i.test(s);
  if (t === 'bytes32') {
    if (s.startsWith('sha256:')) return '0x' + createHash('sha256').update(s.slice(7)).digest('hex');
    if (/^[a-zA-Z]+$/.test(s)) return '0x' + Buffer.from(s).toString('hex').padEnd(64, '0'); // parameter names
    if (!/^0x[0-9a-fA-F]{64}$/.test(s)) throw new Error('bytes32 must be 0x + 64 hex digits'); return s;
  }
  if (/^u?int/.test(t)) return s.startsWith('psy:') ? psyToWei(s.slice(4)) : BigInt(s);
  if (t === 'bytes') return s;
  return s;
}

async function confirm(q) {
  if (YES) return;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q + ' [y/N] ');
  rl.close();
  if (!/^y(es)?$/i.test(a.trim())) { console.log('cancelled'); process.exit(1); }
}

async function sendTx(sk, to, data, value) {
  const chainId = BigInt(await rpc('eth_chainId'));
  const p = makeParams({ chainId });
  const from = '0x' + bytesToHex(privateKeyToAddress(sk));
  const nonce = BigInt(await rpc('eth_getTransactionCount', [from, 'pending']));
  const call = { from, to, data, value: '0x' + value.toString(16) };
  try { await rpc('eth_call', [call, 'latest']); } catch (e) { throw new Error('would fail: ' + e.message); }
  const gas = BigInt(await rpc('eth_estimateGas', [call])) * 12n / 10n + 10_000n;
  const base = BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).baseFeePerGas);
  const tx = signTx({ type: 2, nonce, to: fromHex(to), value, data: fromHex(data), gasLimit: gas, maxFee: base * 2n + 1_000_000_000n, maxPriorityFee: 100_000_000n }, sk, p);
  const hash = await rpc('eth_sendRawTransaction', ['0x' + bytesToHex(tx.raw)]);
  console.log('sent', hash);
  for (let i = 0; i < 60; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]);
    if (r) { console.log(r.status === '0x1' ? `accepted in chain block ${Number(r.blockNumber)}` : `failed in chain block ${Number(r.blockNumber)}`); return r; }
    await new Promise((res) => setTimeout(res, 2000));
  }
  console.log('not accepted yet; check later with the explorer');
}

async function main() {
  const cmd = argv.shift();
  if (!cmd || cmd === 'help' || cmd === '--help') usage(0);
  if (cmd === 'new') {
    const out = opt('out');
    if (!out) throw new Error('--out <file> is required');
    if (fs.existsSync(out)) throw new Error(out + ' exists; refusing to overwrite a key');
    const sk = randomPrivateKey();
    fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
    fs.writeFileSync(out, bytesToHex(sk) + '\n', { mode: 0o600, flag: 'wx' });
    console.log('address 0x' + bytesToHex(privateKeyToAddress(sk)));
    console.log('Key written to ' + out + ' (mode 0600). Back it up offline now: a lost key cannot be recovered, and an NGO that loses its wallet must restart the whole process.');
    console.log('Never reuse a key that was used on any other network.');
    return;
  }
  if (cmd === 'address') { console.log('0x' + bytesToHex(privateKeyToAddress(readKey(opt('key'))))); return; }
  if (cmd === 'balance') {
    const a = argv[0];
    console.log(`${fmt(BigInt(await rpc('eth_getBalance', [a, 'latest'])))} PSY, nonce ${Number(await rpc('eth_getTransactionCount', [a, 'latest']))}`);
    return;
  }
  if (cmd === 'contracts') {
    for (const n of Object.keys(NAMES)) {
      const { c, addr } = codec(n);
      console.log(`${n} ${addr}`);
      for (const [, list] of c.functions) for (const f of list) console.log(`   ${f.sig}${f.f.stateMutability === 'view' || f.f.stateMutability === 'pure' ? '  (read)' : ''}`);
    }
    return;
  }
  if (cmd === 'send') {
    const sk = readKey(opt('key'));
    const to = opt('to'), value = psyToWei(opt('value', '0'));
    await confirm(`Send ${fmt(value)} PSY to ${to}?`);
    await sendTx(sk, to, '0x', value);
    return;
  }
  if (cmd === 'tx' || cmd === 'read' || cmd === 'calldata') {
    const keyFile = cmd === 'tx' ? opt('key') : null;
    const value = psyToWei(opt('value', '0'));
    const [name, fn, ...args] = argv;
    const { c, addr, abi } = codec(name);
    const f = abi.find((x) => x.type === 'function' && x.name === fn && x.inputs.length === args.length);
    if (!f) throw new Error(`${name} has no function ${fn} with ${args.length} arguments`);
    const data = u8ToHex(c.encode(fn, f.inputs.map((inp, i) => parseArg(inp, args[i]))));
    if (cmd === 'calldata') { console.log(addr, data); return; }
    if (cmd === 'read') {
      const r = await rpc('eth_call', [{ to: addr, data }, 'latest']);
      const out = c.decode(fn, fromHex(r), args.length);
      console.log(JSON.stringify(out, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
      return;
    }
    const sk = readKey(keyFile);
    await confirm(`Call ${name}.${fn}(${args.join(', ')})${value ? ` with ${fmt(value)} PSY` : ''} from 0x${bytesToHex(privateKeyToAddress(sk))}?`);
    await sendTx(sk, addr, data, value);
    return;
  }
  usage();
}

main().catch((e) => { console.error('error: ' + e.message); process.exit(1); });
