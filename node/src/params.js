// Chain parameters (DAG_SPEC.md section 2). Consensus values: nodes with different values reject each other's blocks.

import { fromHex, hexToBytes } from '../../common/bytes.js';
import { RATIO_COMPLEMENT } from './emission.js';

export const NODE_VERSION = '10.0.2';
/** The network's name on pages, in the launch ceremony and in downloads, derived from NODE_VERSION so labels cannot
 *  drift apart again. */
export const TESTNET_MAJOR = Number(NODE_VERSION.split('.')[0]);
export const TESTNET_NAME = `PSYROB testnet v${TESTNET_MAJOR}.0`;
/** The network's name in wallets (wallet_addEthereumChain). */
export const TESTNET_WALLET_NAME = `PSYROB v${TESTNET_MAJOR} testnet`;
/** A version as UpgradeRegistry stores it: major * 1,000,000 + minor * 1,000 + patch. */
export const versionNumber = (v) => { const [a, b, c] = String(v).split('.').map(Number); return a * 1_000_000 + (b || 0) * 1_000 + (c || 0); };
export const versionText = (n) => `${Math.floor(n / 1_000_000)}.${Math.floor(n / 1_000) % 1_000}.${n % 1_000}`;
export const SYSTEM_ADDRESS = hexToBytes('fffffffffffffffffffffffffffffffffffffffe');
export const BURN_ADDRESS = hexToBytes('000000000000000000000000000000000000dead');

/** System contract addresses (contracts/src/Base.sol, Addrs). */
export const ADDR = Object.freeze({
  minerRegistry: hexToBytes('7070000000000000000000000000000000000001'),
  ngoRegistry: hexToBytes('7070000000000000000000000000000000000002'),
  attestation: hexToBytes('7070000000000000000000000000000000000003'),
  voteEscrow: hexToBytes('7070000000000000000000000000000000000004'),
  ngoElection: hexToBytes('7070000000000000000000000000000000000005'),
  roleElection: hexToBytes('7070000000000000000000000000000000000006'),
  governor: hexToBytes('7070000000000000000000000000000000000007'),
  treasury: hexToBytes('7070000000000000000000000000000000000008'),
  devVesting: hexToBytes('7070000000000000000000000000000000000009'), // Dev Account 1
  devVesting2: hexToBytes('707000000000000000000000000000000000000f'), // Dev Account 2
  devVesting3: hexToBytes('7070000000000000000000000000000000000010'), // Dev Account 3
  ngoRewards: hexToBytes('707000000000000000000000000000000000000a'),
  finalityCommittee: hexToBytes('707000000000000000000000000000000000000b'),
  governanceMode: hexToBytes('707000000000000000000000000000000000000c'),
  fundApprovals: hexToBytes('707000000000000000000000000000000000000d'),
  params: hexToBytes('707000000000000000000000000000000000000e'),
  devCouncil: hexToBytes('7070000000000000000000000000000000000011'), // DAG_SPEC.md section 17
  upgradeRegistry: hexToBytes('7070000000000000000000000000000000000012'),
  emergencyPause: hexToBytes('7070000000000000000000000000000000000013'),
});

/**
 * The development team's 12 % in three equal, immutable DevVesting contracts, one per team member (owner decision,
 * 12 October 2026). `contract` is the name pages and the wallet use; all three run the DevVesting code.
 */
export const DEV_ACCOUNTS = Object.freeze([
  { label: 'Dev Account 1', contract: 'DevVesting', key: 'devVesting' },
  { label: 'Dev Account 2', contract: 'DevVesting2', key: 'devVesting2' },
  { label: 'Dev Account 3', contract: 'DevVesting3', key: 'devVesting3' },
]);

/** Contract name -> the artifact whose code runs there (DevVesting2 and DevVesting3 are DevVesting). */
export const artifactName = (name) => (/^DevVesting\d$/.test(name) ? 'DevVesting' : name);

const PSY = 10n ** 18n;
const DAY = 86400;

/** Network chain IDs whose early-network bounds are enforced (locked rule: T >= 10 s, k >= 18 for 12 months). */
// The testnet's chain ID. Public chain IDs get the locked parameter bounds below and need the launch ceremony.
export const TESTNET_CHAIN_ID = 87870n;
export const PUBLIC_CHAIN_IDS = new Set([TESTNET_CHAIN_ID]);
/** The network's own genesis file (repository path; embedded in the single-executable builds). */
export const GENESIS_FILE = `genesis/genesis-${TESTNET_CHAIN_ID}.json`;

export const DEFAULTS = Object.freeze({
  chainId: 87870n,
  networkMagic: 0x50535941, // "PSYA": peers on another magic are refused at the handshake
  protocolVersion: 10,
  pow: { memoryKiB: 32768, iterations: 1 },
  targetSpacing: 10, // seconds per blue block
  k: 18,
  maxParents: 10,
  mergesetLimit: 180,
  mergeDepth: 360,
  finalityDepth: 8640,
  checkpointInterval: 30, // chain blocks
  blockGasLimit: 10_000_000n,
  mergesetGasLimit: 30_000_000n,
  baseFeeTarget: 5_000_000n,
  baseFeeChangeDenominator: 8n,
  minBaseFee: 1_000_000_000n, // 1 gwei
  maxFutureDrift: 120,
  pastMedianWindow: 31,
  asertHalfLife: 900, // 90 blocks: a 10x jump in block rate is absorbed in ~40 min (risk review Part 4)
  // Emission (section 7): R(s) = R0 * 2^(-s/48) per blue block, s = floor(blueScore / stepBlocks)
  stepBlocks: 262_980,
  halvingSteps: 48,
  poolCap: 360_000_000n * PSY, // each of the mining and NGO pools
  committeeShareBps: 200n, // 2 % of the mining subsidy to the finality committee
  earlyBoundsSeconds: 365 * DAY,
  maxSupply: 1_000_000_000n * PSY,
  // Transactions
  maxTxBytes: 131072,
  maxBlockTxs: 2000,
  maxCertsPerBlock: 8,
  maxInitCodeSize: 49152,
  txBaseGas: 21000n,
  txCreateGas: 32000n,
  txDataZeroGas: 4n,
  txDataNonZeroGas: 16n,
  initCodeWordGas: 2n,
  systemCallGas: 200_000_000n,
});

export function makeParams(overrides = {}) {
  const p = { ...DEFAULTS, ...overrides, pow: { ...DEFAULTS.pow, ...(overrides.pow ?? {}) } };
  for (const k of ['chainId', 'blockGasLimit', 'mergesetGasLimit', 'baseFeeTarget', 'baseFeeChangeDenominator', 'minBaseFee', 'poolCap',
    'committeeShareBps', 'maxSupply', 'txBaseGas', 'txCreateGas', 'txDataZeroGas', 'txDataNonZeroGas', 'initCodeWordGas', 'systemCallGas']) {
    p[k] = BigInt(p[k]);
  }
  if (PUBLIC_CHAIN_IDS.has(p.chainId)) {
    // Locked early-network bounds. They are compile-time values for the public networks; any change needs a new release.
    if (p.targetSpacing < 10) throw new Error('params: block interval must be at least 10 s on chain ' + p.chainId);
    if (p.k < 18) throw new Error('params: k must be at least 18 on chain ' + p.chainId);
    if (p.pow.memoryKiB !== 32768) throw new Error('params: proof of work must use 32 MiB on chain ' + p.chainId);
  }
  if (p.mergesetLimit < 2 * p.k) throw new Error('params: mergeset limit must be at least 2k');
  p.R0 = emissionR0(p);
  return Object.freeze(p);
}

/** R0 such that the sum over all steps of stepBlocks * R(s) is the pool cap: poolCap * (1 - 2^(-1/48)) / stepBlocks. */
export function emissionR0(p) {
  if (p.halvingSteps !== 48) throw new Error('params: the emission table has 48 steps per halving');
  return p.poolCap * RATIO_COMPLEMENT / 10n ** 18n / BigInt(p.stepBlocks);
}

/** Parse a hex-or-decimal number from JSON configuration. */
export const big = (x) => (typeof x === 'string' && x.startsWith('0x') ? BigInt(x) : BigInt(x));
export { PSY, DAY, fromHex };
