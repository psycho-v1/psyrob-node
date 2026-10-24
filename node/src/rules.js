// Governance rules in the node (DAG_SPEC.md section 17): the launch ceremony signatures, the network pause filter,
// the node version required by UpgradeRegistry, and the code swap of approved contract updates.
//
// The node reads EmergencyPause and UpgradeRegistry storage directly (one slot each) instead of calling them, because
// the pause filter runs for every transaction. The slots follow the contracts' storage layout (Sys.owed is slot 0);
// node/test/council.test.js checks them against the contracts' own views.

import { keccak256, recoverAddress } from '../../common/crypto.js';
import { bytesToHex, hexToBytes, bytesToBigint, utf8, concat } from '../../common/bytes.js';
import { readResourceText } from '../../common/resources.js';
import { ADDR, DEV_ACCOUNTS, PUBLIC_CHAIN_IDS, NODE_VERSION, versionNumber, TESTNET_NAME } from './params.js';

const word = (n) => { const b = new Uint8Array(32); let x = BigInt(n); for (let i = 31; i >= 0; i--) { b[i] = Number(x & 0xffn); x >>= 8n; } return b; };
const addrWord = (a) => { const b = new Uint8Array(32); b.set(a, 12); return b; };
const MASK64 = (1n << 64n) - 1n;

// EmergencyPause: mapping(address => Pause) pauses at slot 1; Pause = { uint8 by; uint64 at; uint64 until; ... }
const PAUSE_SLOT = 1n;
const NETWORK_PAUSE_KEY = keccak256(concat(addrWord(new Uint8Array(20)), word(PAUSE_SLOT)));
// UpgradeRegistry: uint32 requiredVersion at slot 4
const REQUIRED_VERSION_SLOT = word(4n);

/** Time until which the whole network is paused (0 = not paused). */
export function networkPausedUntil(view) {
  const w = view.getStorage(ADDR.emergencyPause, NETWORK_PAUSE_KEY);
  return Number((BigInt(w) >> 72n) & MASK64);
}

/** The node version UpgradeRegistry requires (a version number, 0 = none). */
export function requiredVersion(view) {
  return Number(BigInt(view.getStorage(ADDR.upgradeRegistry, REQUIRED_VERSION_SLOT)) & 0xffffffffn);
}

export const OWN_VERSION = versionNumber(NODE_VERSION);

const sel = (sig) => bytesToHex(keccak256(utf8(sig)).subarray(0, 4));
const DEV_VESTINGS = DEV_ACCOUNTS.map((a) => bytesToHex(ADDR[a.key]));
const ANY = new Set([bytesToHex(ADDR.governor), bytesToHex(ADDR.devCouncil), bytesToHex(ADDR.upgradeRegistry), bytesToHex(ADDR.emergencyPause)]);
const ONLY = new Map([
  ...DEV_VESTINGS.map((a) => [a, new Set([sel('release()')])]),
  [bytesToHex(ADDR.finalityCommittee), new Set([sel('commitBeacon(bytes32)'), sel('revealBeacon(uint256,bytes32)'),
    sel('reportEquivocation(uint256,uint256,bytes32,bytes32,bytes,bytes32,bytes32,bytes)')])],
]);

/**
 * Why `tx` may not run while the whole network is paused, or null. Allowed, with value 0: governance (Governor), the
 * council, upgrades, the pause itself, finality beacon and equivocation transactions, and DevVesting.release (the 12 %
 * keeps vesting and can be released; the Dev Account wallets cannot send it on, like everyone else).
 */
export function pauseSkip(view, tx, timestamp) {
  if (networkPausedUntil(view) <= timestamp) return null;
  if (tx.value !== 0n || tx.to.length === 0) return 'network paused';
  const to = bytesToHex(tx.to);
  if (ANY.has(to)) return null;
  const only = ONLY.get(to);
  if (only && tx.data.length >= 4 && only.has(bytesToHex(tx.data.subarray(0, 4)))) return null;
  return 'network paused';
}

/** Addresses whose code the node never replaces, whatever UpgradeRegistry says: the 12 % and the handover rule. */
export function neverReplaceable(addr) {
  const h = bytesToHex(addr);
  return DEV_VESTINGS.includes(h) || h === bytesToHex(ADDR.devCouncil);
}

// ---------------------------------------------------------------- launch ceremony

/** The part of the genesis config the three Dev Account holders sign (the start time is set when the genesis is built). */
export function launchBase(config) {
  const artifacts = '0x' + bytesToHex(keccak256(utf8(readResourceText('genesis/artifacts.json'))));
  const base = {
    chainId: Number(config.chainId), target: String(config.target).toLowerCase(),
    devBeneficiaries: config.devBeneficiaries.map((a) => String(a).toLowerCase()), extra: String(config.extra ?? ''), artifacts,
    // the keys that sign bootstrap checkpoints are part of what the three seats sign, with their quorum
    ...(config.bootstrapSigners ? { bootstrapSigners: config.bootstrapSigners.map((a) => String(a).toLowerCase()) } : {}),
    ...(config.bootstrapQuorum !== undefined ? { bootstrapQuorum: Number(config.bootstrapQuorum) } : {}),
  };
  return { base, hash: '0x' + bytesToHex(keccak256(utf8(JSON.stringify(base)))) };
}

/** The text Dev Account holder `seat` (0..2) signs with the Dev Account wallet (personal_sign). */
export function launchMessage(config, seat, councilKey) {
  const { hash } = launchBase(config);
  return [
    `${TESTNET_NAME} launch ceremony`,
    `Chain ID: ${Number(config.chainId)}`,
    `Genesis base: ${hash}`,
    `Seat: ${DEV_ACCOUNTS[seat].label}`,
    `Dev Account wallet: ${String(config.devBeneficiaries[seat]).toLowerCase()}`,
    `Council key: ${String(councilKey).toLowerCase()}`,
    ...(config.bootstrapSigners ? [`Bootstrap finality signers: ${config.bootstrapSigners.map((a) => String(a).toLowerCase()).join(', ')}`] : []),
    ...(config.bootstrapQuorum !== undefined ? [`Bootstrap finality quorum: ${Number(config.bootstrapQuorum)} of ${config.bootstrapSigners?.length ?? '?'} signatures, at most 12 months`] : []),
    'By signing I take this seat on the dev council (DAG_SPEC.md section 17): powers only until 60 NGOs are first elected or 12 months have passed, then emergency pause only; no Treasury access; the 12 % is never paused or changed.',
  ].join('\n');
}

/** EIP-191 personal_sign digest. */
export function personalDigest(text) {
  const m = utf8(text);
  return keccak256(concat(utf8(`\x19Ethereum Signed Message:\n${m.length}`), m));
}

/** The signer of a 65-byte personal_sign signature (0x hex, v = 27/28 or 0/1), or null. */
export function personalSigner(text, sigHex) {
  try {
    const s = hexToBytes(String(sigHex).replace(/^0x/, ''));
    if (s.length !== 65) return null;
    const v = s[64] >= 27 ? s[64] - 27 : s[64];
    return '0x' + bytesToHex(recoverAddress(personalDigest(text), bytesToBigint(s.subarray(0, 32)), bytesToBigint(s.subarray(32, 64)), v));
  } catch { return null; }
}

/**
 * Check the launch ceremony of a genesis config: three council keys, each with a signature of its Dev Account wallet.
 * Required on the public chain IDs; a devnet may leave it out (its council then has no keys). Throws if wrong.
 */
export function verifyLaunch(config) {
  const keys = config.councilKeys, sigs = config.launchSignatures;
  if (!keys && !sigs) {
    if (PUBLIC_CHAIN_IDS.has(BigInt(config.chainId))) throw new Error('genesis: the launch ceremony signatures of the three Dev Accounts are missing');
    return false;
  }
  if (!Array.isArray(keys) || !Array.isArray(sigs) || keys.length !== 3 || sigs.length !== 3) throw new Error('genesis: councilKeys and launchSignatures must each list three entries');
  for (let i = 0; i < 3; i++) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(keys[i]))) throw new Error(`genesis: council key ${i + 1} is not an address`);
    const who = personalSigner(launchMessage(config, i, keys[i]), sigs[i]);
    if (!who || who !== String(config.devBeneficiaries[i]).toLowerCase()) throw new Error(`genesis: the launch signature of ${DEV_ACCOUNTS[i].label} does not match its wallet`);
  }
  return true;
}

