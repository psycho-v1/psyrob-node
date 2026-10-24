// Genesis (DAG_SPEC.md sections 7.1 and 16). The genesis state is built deterministically from a small config and
// genesis/artifacts.json: every system contract's constructor runs at its fixed address, the Treasury receives the
// Community/Treasury allocation (16 %) and three DevVesting contracts the team allocation (12 %, 40,000,000 PSY each,
// Dev Accounts 1-3, one per team member). No other address receives PSY.
//
// config = { chainId, timestamp, target (hex), devBeneficiaries ([3 hex addresses]), extra (text),
//            councilKeys ([3 hex addresses]), launchSignatures ([3 hex signatures]) }
// (devBeneficiary, one address, is still read by devnets and tests: it then receives all three.)
// the dev council, the upgrade registry and the emergency pause are created too. The council keys come from the
// launch ceremony: each Dev Account wallet signs its seat and key (node/src/rules.js); the public chain IDs require it.

import fs from 'node:fs';
import { State } from './state.js';
import { genesisCreate } from './evm.js';
import { ADDR, PSY, DEV_ACCOUNTS, PUBLIC_CHAIN_IDS, GENESIS_FILE, makeParams } from './params.js';
import { bodyRoot } from './block.js';
import { merkleRoot } from '../../common/merkle.js';
import { genesisHash, HEADER_VERSION } from '../../common/header.js';
import * as abi from '../../common/abi.js';
import { bytesToHex, fromHex, hexToBytes, concat, utf8 } from '../../common/bytes.js';
import { readResourceText } from '../../common/resources.js';
import { verifyLaunch } from './rules.js';

export const TREASURY_ALLOCATION = 160_000_000n * PSY;
export const DEV_ALLOCATION = 120_000_000n * PSY;
export const DEV_ACCOUNT_ALLOCATION = DEV_ALLOCATION / 3n; // 40,000,000 PSY each, exactly

let artifactsCache = null;
export function artifacts() {
  if (!artifactsCache) artifactsCache = JSON.parse(readResourceText('genesis/artifacts.json')).contracts;
  return artifactsCache;
}

const ORDER = [
  ['GovernanceMode', 'governanceMode'], ['Params', 'params'], ['MinerRegistry', 'minerRegistry'], ['NGORegistry', 'ngoRegistry'],
  ['Attestation', 'attestation'], ['VoteEscrow', 'voteEscrow'], ['NGOElection', 'ngoElection'], ['RoleElection', 'roleElection'],
  ['Governor', 'governor'], ['Treasury', 'treasury'], ['DevVesting', 'devVesting'], ['NGORewards', 'ngoRewards'],
  ['FinalityCommittee', 'finalityCommittee'], ['FundApprovals', 'fundApprovals'],
  ['DevCouncil', 'devCouncil'], ['UpgradeRegistry', 'upgradeRegistry'], ['EmergencyPause', 'emergencyPause'],
];

/**
 * The bootstrap finality signers of a genesis config: `bootstrapSigners` (1 to 21 distinct addresses), required on
 * the public chain IDs; a devnet without it uses Dev Account 1.
 */
export function bootstrapSignersOf(config) {
  const list = config.bootstrapSigners;
  if (list === undefined) {
    if (PUBLIC_CHAIN_IDS.has(BigInt(config.chainId))) throw new Error('genesis: bootstrapSigners (the dev miners that sign checkpoints until the first committee) are missing');
    return [String((config.devBeneficiaries ?? [config.devBeneficiary])[0]).toLowerCase()];
  }
  if (!Array.isArray(list) || list.length < 1 || list.length > 21) throw new Error('genesis: bootstrapSigners must list 1 to 21 addresses');
  const out = list.map((a) => String(a).toLowerCase());
  if (!out.every((a) => /^0x[0-9a-f]{40}$/.test(a) && !/^0x0{40}$/.test(a)) || new Set(out).size !== out.length) throw new Error('genesis: bootstrapSigners must be distinct, non-zero addresses');
  return out;
}

/**
 * Signatures a bootstrap certificate needs : `bootstrapQuorum` from the config, or a majority of the list (2 of
 * 3). Must be more than half the list, so two conflicting bootstrap certificates always share a signer.
 */
export function bootstrapQuorumOf(config) {
  const n = bootstrapSignersOf(config).length;
  const q = config.bootstrapQuorum === undefined ? Math.floor(n / 2) + 1 : Number(config.bootstrapQuorum);
  if (!Number.isInteger(q) || q < 1 || q > n || q * 2 <= n) throw new Error(`genesis: bootstrapQuorum must be more than half of the ${n} bootstrap signers and at most ${n}`);
  return q;
}

/** Build the genesis: { header, hash, records, params }. `paramOverrides` for devnets and tests. */
export async function buildGenesis(config, paramOverrides = {}) {
  const p = makeParams({ chainId: BigInt(config.chainId), ...paramOverrides });
  const t = Number(config.timestamp);
  const state = new State();
  const view = state.view();
  const ctx = { number: 0, timestamp: t, baseFee: p.minBaseFee, coinbase: new Uint8Array(20), gasLimit: p.blockGasLimit, blockHash: () => null };
  const art = artifacts();
  const devInits = [];
  const devs = (config.devBeneficiaries ?? [config.devBeneficiary, config.devBeneficiary, config.devBeneficiary]).map((a) => hexToBytes(String(a ?? '').replace(/^0x/, '')));
  if (devs.length !== DEV_ACCOUNTS.length || devs.some((d) => d.length !== 20)) throw new Error('genesis: devBeneficiaries must be three addresses');
  const launched = config.devBeneficiaries ? verifyLaunch(config) : false;
  const councilKeys = launched ? config.councilKeys.map((a) => hexToBytes(a.replace(/^0x/, ''))) : [0, 1, 2].map(() => new Uint8Array(20));
  // bootstrap finality (DAG_SPEC.md section 9.1): the dedicated keys that sign checkpoints until the first committee
  // is sealed (2 of 3). Named in the genesis config (and so in the launch ceremony's signed base); a devnet
  // without the field uses Dev Account 1 with a quorum of 1.
  const bootstrap = bootstrapSignersOf(config).map((a) => hexToBytes(a.replace(/^0x/, '')));
  for (const [name, key] of ORDER) {
    let init = fromHex('0x' + art[name].initCode.replace(/^0x/, ''));
    let value = 0n;
    if (name === 'GovernanceMode') init = concat(init, abi.encode(['uint256'], [BigInt(t)]));
    if (name === 'FinalityCommittee') init = concat(init, abi.encode(['address[]', 'uint256'], [bootstrap, BigInt(bootstrapQuorumOf(config))]));
    if (name === 'DevCouncil') init = concat(init, ...devs.map((d) => abi.encode(['address'], [d])), ...councilKeys.map((k) => abi.encode(['address'], [k])));
    if (name === 'DevVesting') {
      // three instances of the same immutable code, one per Dev Account
      DEV_ACCOUNTS.forEach((a, i) => devInits.push({ address: ADDR[a.key], initCode: concat(init, abi.encode(['address', 'uint256', 'uint256'], [devs[i], BigInt(t), DEV_ACCOUNT_ALLOCATION])) }));
      for (const d of devInits) {
        await genesisCreate(view, p, ctx, { address: d.address, initCode: d.initCode, value: DEV_ACCOUNT_ALLOCATION }); // CALLVALUE seen by the constructor
        view.setAccount(d.address, { balance: DEV_ACCOUNT_ALLOCATION });
      }
      continue;
    }
    await genesisCreate(view, p, ctx, { address: ADDR[key], initCode: init, value });
  }
  view.setAccount(ADDR.treasury, { balance: TREASURY_ALLOCATION });
  view.setGlobal({ genesisSupply: TREASURY_ALLOCATION + DEV_ALLOCATION, issuedMining: 0n, issuedNGO: 0n, burned: 0n });
  state.commit(view);
  const header = {
    version: HEADER_VERSION, parents: [], timestamp: t, target: BigInt(config.target), blueScore: 0n, blueWork: 0n, stateRoot: state.root(),
    txRoot: bodyRoot([], []), receiptsRoot: merkleRoot([]), acceptedTxRoot: merkleRoot([]), gasLimit: p.blockGasLimit, gasUsed: 0n,
    baseFee: p.minBaseFee, miner: new Uint8Array(20), extra: utf8(String(config.extra ?? 'PSYROB genesis').slice(0, 32)), nonce: 0n,
    minerSig: new Uint8Array(65),
  };
  return { header, hash: genesisHash(header), records: state.records(), params: p };
}

/** genesis.json on disk: the config and the expected genesis hash and state root (checked at start-up). */
export async function loadGenesis(file, paramOverrides = {}) {
  // no file: the network's own genesis (embedded in the single-executable builds)
  const j = JSON.parse(file ? fs.readFileSync(file, 'utf8') : readResourceText(GENESIS_FILE));
  const g = await buildGenesis(j.config, { ...(j.params ?? {}), ...paramOverrides });
  if (j.hash && j.hash !== '0x' + bytesToHex(g.hash)) throw new Error(`genesis: built hash 0x${bytesToHex(g.hash)} differs from ${j.hash} (artifacts or config changed)`);
  return { ...g, file: j };
}
