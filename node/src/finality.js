// Finality checkpoints and committee signatures (DAG_SPEC.md sections 9 and 12).
//
// Signer (a node run by a committee member, with --signer-key): for every checkpoint (chain height a multiple of 30)
// that is at least SIGN_DEPTH (30) chain blocks deep, if the member sits on that epoch's committee, sign
//   keccak256(abi.encode(keccak256("PSYROB-checkpoint"), chainId, genesisTime, number, chainBlockHash, stateRoot))
// exactly once per checkpoint number (the signed numbers are kept on disk, so a restart can never cause a second,
// conflicting signature, which would be slashed). Members also sign approved volunteer-fund transfers
// (FundApprovals.digest(id)) after reading the approval from their own node's state: the governance module check.
//
// Collector (every node): signatures are gossiped (P2P SIG); with 15 valid signatures of the epoch's committee, among
// them the NGO signatures the epoch needs (FinalityCommittee.ngoSignaturesRequired: 4), or,
// before the first committee is sealed, the bootstrap quorum of the bootstrap keys (2 of 3; DAG_SPEC.md section 9.1), a
// certificate is formed, the checkpoint becomes final (no reorganisation below it), the certificate is gossiped (CERT)
// and offered to miners for inclusion in blocks (for the on-chain record and rewards).

import * as rlp from '../../common/rlp.js';
import * as abi from '../../common/abi.js';
import { signDigest, privateKeyToAddress, keccak256 } from '../../common/crypto.js';
import { bytesToHex, bigintToFixed, concat, bytesToBigint, fromHex, utf8 } from '../../common/bytes.js';
import { signTx } from './tx.js';
import { checkpointDigest, recoverSig65, certQuorum, CERT_QUORUM, BOOTSTRAP_EPOCH } from './consensus.js';
import { contractCall } from './evm.js';
import { ADDR } from './params.js';

// 30 chain blocks (one checkpoint interval, ~5 minutes): a reorganisation deeper than this after signing would split
// the votes and lose the checkpoint; still far below the DAG finality depth of 8,640.
export const SIGN_DEPTH = 30;
// Signatures are only gathered for the newest checkpoints: honest signers sign the last 4 due ones (onTip); older ones
// are dropped before any work.
const SIG_WINDOW = 10;
// Misbehaviour points for a signature that recovers to someone outside the committee of our view, and for a
// certificate that does not verify. Peers relay what they verified against their own view, so
// an occasional mismatch costs little; a stream of junk bans the peer within seconds at the SIG rate limit.
const NON_MEMBER_SIG_POINTS = 5, BAD_CERT_POINTS = 10;
// (bytes32 arguments are encoded as uint256: the same 32-byte word; common/abi.js has no bytes32.)
// Randomness beacon (FinalityCommittee commit-reveal): onion depth, gas, and how many chain
// blocks to wait before sending the same commit or reveal again.
const BEACON_LAYERS = 4096, BEACON_GAS = 200_000n, BEACON_RESEND = 20;
const BEACON_WINDOW = 60; // FinalityCommittee.BEACON_WINDOW
const KIND_CHECKPOINT = 1, KIND_FUND = 2;

export function sig65(digest, sk) {
  const { r, s, recovery } = signDigest(digest, sk);
  return concat(bigintToFixed(r, 32), bigintToFixed(s, 32), Uint8Array.of(27 + recovery));
}

export class Finality {
  /**
   * signerKey: one key, or signerKeys: several (the public node holds the three bootstrap keys for now and signs
   * with each that belongs to the signers of a checkpoint; any 2 of them make it final). The first key is the one used
   * for the committee beacon.
   */
  constructor({ chain, p2p, store, mempool = null, signerKey = null, signerKeys = null, log = () => {} }) {
    this.chain = chain;
    this.mempool = mempool;
    this.onions = new Map(); // onion index -> { layers, pos: Map(layer hex -> position) }
    this.beaconSent = new Map(); // 'commit:i' | 'reveal:r' -> chain height when sent
    this.p2p = p2p;
    this.store = store;
    const keys = signerKeys ?? (signerKey ? [signerKey] : []);
    this.keys = keys.map((sk) => ({ sk, addr: bytesToHex(privateKeyToAddress(sk)) }));
    this.sk = this.keys[0]?.sk ?? null;
    this.signer = this.keys[0]?.addr ?? null;
    this.log = log;
    // checkpoints each key signed: "addr:number" (a plain number means the first key).
    // A key never signs a second, different checkpoint for a number it signed (no equivocation after a restart).
    this.signed = new Set((store?.readJson('signed-checkpoints.json', []) ?? []).map((x) => (typeof x === 'number' ? `${this.signer}:${x}` : String(x))));
    this.sigs = new Map(); // "number:hash:root:epoch" -> Map(addr -> sig)
    this.fundSigs = new Map(); // id -> Map(addr -> sig)
    this.fundSigned = new Set(store?.readJson('signed-fund.json', []) ?? []);
    this.pendingCerts = new Map(); // number -> cert, offered to templates until recorded on chain
    this.membersCache = { tip: null, map: new Map() }; // checkpoint chain block -> { epoch, members }, per tip
  }

  key(n, h, r, e) { return `${n}:${h}:${r}:${e}`; }

  /** Called after each new tip. Signs due checkpoints and approved fund transfers if this node is a member. */
  async onTip() {
    const c = this.chain;
    const iv = c.p.checkpointInterval;
    const top = c.tip.chainHeight - SIGN_DEPTH;
    if (top < iv) return;
    const last = Math.floor(top / iv);
    for (let n = Math.max(1, last - 3); n <= last; n++) {
      if (n <= c.finalCheckpoint.number) continue;
      const h = c.chain[n * iv];
      if (!h) continue;
      const cb = c.dag.get(h);
      const { epoch, members } = await this.membersFor(cb);
      if (!members.size) continue;
      this.pruneOld(n);
      for (const k of this.keys) {
        if (!members.has(k.addr) || this.signed.has(`${k.addr}:${n}`)) continue;
        const digest = checkpointDigest(c.p.chainId, c.dag.genesis.header.timestamp, n, cb.hashBytes, cb.stateRoot);
        const sig = sig65(digest, k.sk);
        this.signed.add(`${k.addr}:${n}`);
        this.store?.writeJson('signed-checkpoints.json', [...this.signed].slice(-15000));
        await this.addCheckpointSig({ number: n, chainBlock: cb.hashBytes, stateRoot: cb.stateRoot, epoch, sig }, null);
      }
    }
    if (this.keys.length) await this.signFundApprovals();
    if (this.sk && this.mempool) await this.beaconTick().catch((e) => this.log('beacon: ' + e.message));
  }

  // ------------------------------------------------------------------ randomness beacon (commit-reveal)

  /** Onion `index` of this signer: layers[0] is the secret, layers[i] = keccak256(layers[i - 1]); layers[N] is
   *  committed and layers are revealed downwards. Derived from the signer key, so nothing is stored and a restart
   *  regenerates it; nobody without the key can predict a layer. */
  onion(index) {
    let o = this.onions.get(index);
    if (o) return o;
    let x = keccak256(concat(this.sk, utf8('PSYROB-beacon-onion'), bigintToFixed(this.chain.p.chainId, 32), bigintToFixed(BigInt(index), 32)));
    const layers = [x];
    for (let i = 1; i <= BEACON_LAYERS; i++) { x = keccak256(x); layers.push(x); }
    o = { layers, pos: new Map(layers.map((l, i) => [bytesToHex(l), i])) };
    this.onions.clear(); // only the current onion is needed
    this.onions.set(index, o);
    return o;
  }

  async beaconState() {
    const me = fromHex('0x' + this.signer);
    return this.chain.readAtTip(async (view, ctx) => {
      const fc = async (sig, types = [], vals = []) => (await contractCall(view, this.chain.p, ctx, { to: ADDR.finalityCommittee, data: abi.call(sig, types, vals), commit: false })).returnValue;
      const word = (d, i = 0) => bytesToBigint(d.subarray(i * 32, i * 32 + 32));
      const bonded = word(await fc('bonds(address)', ['address'], [me])) > 0n;
      const layer = await fc('beaconLayer(address)', ['address'], [me]);
      const commits = Number(word(await fc('beaconCommits(address)', ['address'], [me])));
      const commitBlock = Number(word(await fc('beaconCommitBlock(address)', ['address'], [me])));
      const count = Number(word(await fc('beaconCount()')));
      const closed = Number(word(await fc('beaconsClosed()')));
      const open = [];
      for (let r = closed; r < count; r++) {
        const b = await fc('beacon(uint256)', ['uint256'], [BigInt(r)]);
        const requestBlock = Number(word(b, 0)), epoch = word(b, 1), done = word(b, 3) !== 0n;
        if (done || ctx.number > requestBlock + BEACON_WINDOW || commitBlock === 0 || commitBlock >= requestBlock) continue;
        if (word(await fc('seatOf(uint256,address)', ['uint256', 'address'], [epoch, me])) === 0n) continue;
        if (word(await fc('slashed(uint256,address)', ['uint256', 'address'], [epoch, me])) !== 0n) continue;
        if (word(await fc('beaconRevealed(uint256,address)', ['uint256', 'address'], [BigInt(r), me])) !== 0n) continue;
        open.push(r);
      }
      const acc = view.getAccount(me);
      return { bonded, layer: bytesToHex(layer), commits, open, nonce: acc.nonce, baseFee: ctx.baseFee, height: this.chain.tip.chainHeight };
    });
  }

  /** Commit an onion when bonded without a usable one; reveal the next layer for every open round we belong to. */
  async beaconTick() {
    const st = await this.beaconState();
    if (!st.bonded) return;
    const cur = st.commits > 0 ? this.onion(st.commits - 1) : null;
    let pos = cur?.pos.get(st.layer);
    const sends = [];
    if (pos === undefined || pos < 2) {
      // no commitment yet, one made elsewhere, or the onion is used up: commit a new one (index = commits so far), but
      // never while a reveal is owed (the contract counts that as staying silent)
      if (st.open.length && pos === 1) {
        if (this.due(`reveal:${st.open[0]}`, st.height)) sends.push(abi.call('revealBeacon(uint256,bytes32)', ['uint256', 'uint256'], [BigInt(st.open[0]), bytesToBigint(cur.layers[0])]));
      } else if (!st.open.length) {
        const next = this.onion(st.commits);
        if (this.due(`commit:${st.commits}`, st.height)) sends.push(abi.call('commitBeacon(bytes32)', ['uint256'], [bytesToBigint(next.layers[BEACON_LAYERS])]));
      }
    } else {
      for (const r of st.open) {
        if (pos < 1) break;
        pos -= 1;
        if (this.due(`reveal:${r}`, st.height)) sends.push(abi.call('revealBeacon(uint256,bytes32)', ['uint256', 'uint256'], [BigInt(r), bytesToBigint(cur.layers[pos])]));
      }
    }
    let nonce = st.nonce + BigInt(this.mempool.bySender.get(this.signer)?.size ?? 0);
    for (const data of sends) {
      const tx = signTx({ type: 2, nonce: nonce++, to: ADDR.finalityCommittee, data, gasLimit: BEACON_GAS, maxFee: st.baseFee * 2n + 1_000_000_000n, maxPriorityFee: 100_000_000n }, this.sk, this.chain.p);
      await this.chain.readAtTip((view, ctx) => this.mempool.add(tx.raw, view, ctx.baseFee, ctx.timestamp));
      this.p2p?.announce(2, bytesToHex(tx.hash));
    }
  }

  /** True (and remembered) if `key` was not sent within the last BEACON_RESEND chain blocks. */
  due(key, height) {
    const at = this.beaconSent.get(key);
    if (at !== undefined && height - at < BEACON_RESEND) return false;
    this.beaconSent.set(key, height);
    if (this.beaconSent.size > 1000) this.beaconSent.delete(this.beaconSent.keys().next().value);
    return true;
  }

  /** The committee that signs checkpoint block `cb`, read at the tip. Cached until the tip changes, so a flood of
   *  signatures costs no EVM calls beyond the first per checkpoint. */
  async membersFor(cb) {
    const tip = this.chain.tip.hash;
    if (this.membersCache.tip !== tip) this.membersCache = { tip, map: new Map() };
    const cache = this.membersCache;
    const hit = cache.map.get(cb.hash);
    if (hit) return hit;
    // the committee, or before the first committee the bootstrap dev miners (consensus.js certSigners)
    const r = await this.chain.readAtTip((view, ctx) => this.chain.certSigners(view, ctx, cb));
    cache.map.set(cb.hash, r);
    return r;
  }

  pruneOld(n) {
    for (const k of this.sigs.keys()) if (Number(k.split(':')[0]) < n - 100) this.sigs.delete(k);
  }

  /** A checkpoint signature from us or from a peer. Verified, stored, relayed; forms a certificate at 15.
   *  Cheap checks run first (window, our chain, state root, recovery, duplicate); the committee is read last, from a
   *  per-tip cache. */
  async addCheckpointSig(s, fromPeer) {
    const c = this.chain;
    if (s.number <= c.finalCheckpoint.number) return;
    const iv = c.p.checkpointInterval;
    if (s.number * iv > c.tip.chainHeight || s.number < Math.floor(c.tip.chainHeight / iv) - SIG_WINDOW) return;
    const h = bytesToHex(s.chainBlock);
    const cb = c.dag.get(h);
    if (!cb || c.chain[s.number * iv] !== h) return; // not on our chain (yet)
    if (bytesToHex(cb.stateRoot) !== bytesToHex(s.stateRoot)) return;
    let who;
    try { who = bytesToHex(recoverSig65(checkpointDigest(c.p.chainId, c.dag.genesis.header.timestamp, s.number, s.chainBlock, s.stateRoot), s.sig)); } catch { fromPeer?.misbehave(10, 'bad checkpoint signature'); return; }
    const k = this.key(s.number, h, bytesToHex(s.stateRoot), s.epoch);
    if (this.sigs.get(k)?.has(who)) return;
    const { epoch, members, rule } = await this.membersFor(cb);
    if (epoch !== s.epoch) return;
    if (!members.has(who)) { fromPeer?.misbehave(NON_MEMBER_SIG_POINTS, 'checkpoint signature from a non-member'); return; }
    const m = this.sigs.get(k) ?? new Map();
    if (m.has(who)) return;
    m.set(who, s.sig);
    this.sigs.set(k, m);
    this.p2p?.broadcastSig([rlp.int(KIND_CHECKPOINT), rlp.int(s.number), s.chainBlock, s.stateRoot, rlp.int(epoch), s.sig], fromPeer);
    // 15 signatures including the NGO signatures the epoch needs; during bootstrap at least one signature here,
    // the contract's bootstrap quorum when the certificate is verified
    if (certQuorum(m.keys(), rule)) {
      const cert = { number: s.number, chainBlock: s.chainBlock, stateRoot: s.stateRoot, epoch, sigs: [...m.values()] };
      if (await c.noteFinal(cert)) {
        this.pendingCerts.set(cert.number, cert);
        this.p2p?.broadcastCert(cert);
        this.log(`checkpoint ${cert.number} final (${m.size} signatures)`);
      }
    }
  }

  /** A certificate from a peer. Cheap fields are checked before the chain lock; a certificate for a checkpoint on our
   *  chain that does not verify costs the peer misbehaviour points. */
  async addCert(cert, fromPeer) {
    const c = this.chain;
    if (cert.number <= c.finalCheckpoint.number) return; // already final here: harmless
    if (cert.sigs.length < (cert.epoch === BOOTSTRAP_EPOCH ? 1 : CERT_QUORUM)) { fromPeer?.misbehave(BAD_CERT_POINTS, 'certificate with too few signatures'); return; }
    const height = cert.number * c.p.checkpointInterval;
    if (height > c.tip.chainHeight || c.chain[height] !== bytesToHex(cert.chainBlock)) return; // not on our chain (yet)
    if (await c.noteFinal(cert)) {
      this.pendingCerts.set(cert.number, cert);
      this.p2p?.broadcastCert(cert, fromPeer);
    } else if (cert.number > c.finalCheckpoint.number) {
      fromPeer?.misbehave(BAD_CERT_POINTS, 'certificate does not verify');
    }
  }

  /** Gossiped SIG message. */
  async onSig(items, peer) {
    const kind = Number(rlp.decodeInt(items[0], 1));
    if (kind === KIND_CHECKPOINT) {
      const [, n, h, r, e, sig] = items;
      return this.addCheckpointSig({ number: Number(rlp.decodeInt(n, 6)), chainBlock: h, stateRoot: r, epoch: Number(rlp.decodeInt(e, 6)), sig }, peer);
    }
    if (kind === KIND_FUND) {
      const [, id, sig] = items;
      return this.addFundSig(Number(rlp.decodeInt(id, 6)), sig, peer);
    }
  }

  /** Certificates that templates should include (dropped once recorded on chain). */
  async certsForTemplate() {
    if (!this.pendingCerts.size) return [];
    const recorded = await this.chain.readAtTip(async (view, ctx) => {
      const out = new Set();
      for (const n of this.pendingCerts.keys()) {
        const r = await contractCall(view, this.chain.p, ctx, { to: ADDR.finalityCommittee, data: abi.call('checkpointRecorded(uint256)', ['uint256'], [BigInt(n)]), commit: false });
        if (r.status && bytesToBigint(r.returnValue) !== 0n) out.add(n);
      }
      return out;
    });
    for (const n of recorded) this.pendingCerts.delete(n);
    return [...this.pendingCerts.values()].slice(0, this.chain.p.maxCertsPerBlock);
  }

  // ------------------------------------------------------------------ volunteer-fund approvals

  /** Fund records, their digests and the signing committee, read at the tip; cached until the tip changes (a gossiped
   *  fund signature used to read every record from the EVM). */
  async fundState() {
    const tip = this.chain.tip.hash;
    if (this.fundCache?.tip === tip) return this.fundCache.st;
    const st = await this._readFundState();
    this.fundCache = { tip, st };
    return st;
  }

  async _readFundState() {
    return this.chain.readAtTip(async (view, ctx) => {
      const call = (sig, types = [], vals = []) => contractCall(view, this.chain.p, ctx, { to: ADDR.fundApprovals, data: abi.call(sig, types, vals), commit: false });
      const n = Number(bytesToBigint((await call('count()')).returnValue));
      const fc = (sig, types = [], vals = []) => contractCall(view, this.chain.p, ctx, { to: ADDR.finalityCommittee, data: abi.call(sig, types, vals), commit: false });
      // the committee currently signing (the newest sealed one)
      const le = bytesToBigint((await fc('lastSealedEpoch()')).returnValue);
      const epoch = le >= 1n << 64n ? -1 : Number(le);
      // no committee sealed yet (bootstrap finality): nobody signs fund transfers; epoch -1 cannot be ABI-encoded and
      // failed on every tip
      const members = new Set(epoch < 0 ? [] : await this.chain.committeeMembers(view, ctx, epoch));
      const digests = [];
      for (let i = 0; i < n; i++) digests.push((await call('digest(uint256)', ['uint256'], [BigInt(i)])).returnValue);
      return { count: n, epoch, members, digests };
    });
  }

  async signFundApprovals() {
    const st = await this.fundState();
    for (const k of this.keys) {
      if (!st.members.has(k.addr)) continue;
      for (let id = 0; id < st.count; id++) {
        const tag = k.addr === this.signer ? id : `${k.addr}:${id}`; // the first key keeps the old file format
        if (this.fundSigned.has(tag)) continue;
        const sig = sig65(st.digests[id], k.sk);
        this.fundSigned.add(tag);
        this.store?.writeJson('signed-fund.json', [...this.fundSigned]);
        await this.addFundSig(id, sig, null, st);
      }
    }
  }

  async addFundSig(id, sig, fromPeer, st = null) {
    st = st ?? await this.fundState();
    if (id >= st.count) return;
    let who;
    try { who = bytesToHex(recoverSig65(st.digests[id], sig)); } catch { fromPeer?.misbehave(10, 'bad fund signature'); return; }
    if (!st.members.has(who)) { fromPeer?.misbehave(NON_MEMBER_SIG_POINTS, 'fund signature from a non-member'); return; }
    const m = this.fundSigs.get(id) ?? new Map();
    if (m.has(who)) return;
    m.set(who, sig);
    this.fundSigs.set(id, m);
    this.p2p?.broadcastSig([rlp.int(KIND_FUND), rlp.int(id), sig], fromPeer);
  }

  fundSignatures(id) {
    return [...(this.fundSigs.get(id) ?? new Map()).entries()].map(([a, s]) => ({ member: '0x' + a, sig: '0x' + bytesToHex(s) }));
  }

  status() {
    return {
      signer: this.signer ? '0x' + this.signer : null,
      signers: this.keys.map((k) => '0x' + k.addr),
      finalCheckpoint: this.chain.finalCheckpoint,
      collecting: [...this.sigs.entries()].slice(-10).map(([k, m]) => ({ checkpoint: Number(k.split(':')[0]), block: '0x' + k.split(':')[1], signatures: m.size })),
      pendingCerts: [...this.pendingCerts.keys()],
    };
  }
}

export { fromHex };
