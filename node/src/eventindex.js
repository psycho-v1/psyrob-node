// A small, incremental index of the governance events the explorer pages need (proposal voters and descriptions,
// election ballots, challenges and their decision votes, NGO removals, vouches, committee slashes, NGO pool claims). Logs exist only in
// the chain blocks' receipts, so the index reads each chain block once, when a page first asks after the block was
// accepted; no request scans the whole chain. A reorganisation of the selected chain is undone by dropping the entries
// above the fork (found among the last WINDOW chain blocks; a deeper one rebuilds the index from genesis).
// Lists are capped so memory stays bounded on a small server.

import { keccak256 } from '../../common/crypto.js';
import { bytesToHex } from '../../common/bytes.js';
import { decodeParams } from '../../common/abicodec.js';
import { ADDR } from './params.js';

const WINDOW = 2_000; // chain blocks whose hashes are remembered for reorg detection
const CAP = 5_000; // entries kept per list (older ones are counted but dropped)

const h = (b) => '0x' + bytesToHex(b);

export class EventIndex {
  constructor(chain, artifacts) {
    this.chain = chain;
    this.specs = new Map(); // topic0 hex -> { name, contract, inputs }
    const want = {
      Governor: ['Proposed', 'Voted', 'Decided', 'Executed'],
      NGOElection: ['Ballot', 'Removed', 'Elected'],
      Attestation: ['Vouched', 'Challenged', 'DecisionVote', 'ChallengeDecided'],
      FinalityCommittee: ['Slashed'],
      NGORewards: ['Claimed', 'Forfeited'],
    };
    const addrOf = { Governor: ADDR.governor, NGOElection: ADDR.ngoElection, Attestation: ADDR.attestation, FinalityCommittee: ADDR.finalityCommittee, NGORewards: ADDR.ngoRewards };
    for (const [contract, names] of Object.entries(want)) {
      for (const ev of artifacts[contract].abi.filter((x) => x.type === 'event' && names.includes(x.name))) {
        const sig = `${ev.name}(${ev.inputs.map((i) => i.type).join(',')})`;
        this.specs.set(bytesToHex(keccak256(new TextEncoder().encode(sig))), { name: ev.name, contract, address: bytesToHex(addrOf[contract]), inputs: ev.inputs });
      }
    }
    this.reset();
  }

  reset() {
    this.height = 0; // last chain height scanned
    this.hashes = new Map(); // chain height -> hash (last WINDOW)
    this.proposals = new Map(); // id -> { description, proposer, kind, votes: [], voteCount }
    this.rounds = new Map(); // roundId -> { ballots: [], count, elected: [] }
    this.ngos = new Map(); // ngo -> { challenges: [], removed: [], vouchers: [] }
    this.byVoter = new Map(); // address -> [{ kind, id, height }]
    this.slashes = new Map(); // epoch -> [{ member, reporter, burned, reward, height }]
    this.claims = []; // NGO pool payouts, oldest first: [{ term, ngo, amount, height, tx }]
    this.entries = []; // [{ height, undo }] for reorgs: undo() reverses one entry
  }

  /** Read the chain blocks accepted since the last call. Synchronous: the chain cannot change in between. */
  sync() {
    const c = this.chain;
    // reorganisation: find the highest remembered height whose hash still matches the selected chain
    if (this.height > 0 && c.chain[this.height] !== this.hashes.get(this.height)) {
      let fork = this.height;
      while (fork > 0 && this.hashes.has(fork) && c.chain[fork] !== this.hashes.get(fork)) fork--;
      if (fork > 0 && !this.hashes.has(fork)) { this.reset(); }
      else {
        while (this.entries.length && this.entries[this.entries.length - 1].height > fork) this.entries.pop().undo();
        for (let x = fork + 1; x <= this.height; x++) this.hashes.delete(x);
        this.height = fork;
      }
    }
    const tip = c.tip.chainHeight;
    for (let x = this.height + 1; x <= tip; x++) {
      const cb = c.dag.get(c.chain[x]);
      for (const r of cb?.receipts ?? []) for (const l of r.logs ?? []) this._log(l, x, h(r.txHash));
      for (const r of cb?.systemReceipts ?? []) for (const l of r.logs ?? []) this._log(l, x, null);
      this.hashes.set(x, c.chain[x]);
      this.hashes.delete(x - WINDOW);
      this.height = x;
    }
    // undo records older than the reorg window are never needed again
    if (this.entries.length > 50_000) this.entries = this.entries.filter((e) => e.height > this.height - WINDOW);
  }

  _log(l, height, tx) {
    const t0 = l.topics?.[0];
    if (!t0) return;
    const spec = this.specs.get(bytesToHex(t0));
    if (!spec || bytesToHex(l.address) !== spec.address) return;
    const ev = {};
    let ti = 1;
    const plain = spec.inputs.filter((i) => !i.indexed);
    const vals = plain.length ? decodeParams(plain, l.data) : [];
    let vi = 0;
    for (const inp of spec.inputs) {
      if (inp.indexed) {
        const word = l.topics[ti++];
        ev[inp.name] = inp.type === 'address' ? '0x' + bytesToHex(word.slice(12)) : inp.type.startsWith('uint') ? BigInt(h(word)) : h(word);
      } else ev[inp.name] = vals[vi++];
    }
    this._apply(spec.name, ev, height, tx);
  }

  _push(list, item) { if (list.length < CAP) { list.push(item); return true; } return false; }

  _record(height, undo) { this.entries.push({ height, undo }); }

  _voter(addr, item, height) {
    const k = addr.toLowerCase();
    if (!this.byVoter.has(k)) this.byVoter.set(k, []);
    const list = this.byVoter.get(k);
    if (this._push(list, item)) this._record(height, () => list.pop());
  }

  _ngo(a) {
    const k = a.toLowerCase();
    if (!this.ngos.has(k)) this.ngos.set(k, { challenges: [], removed: [], vouchers: [], claims: [], forfeits: [] });
    return this.ngos.get(k);
  }

  _apply(name, e, height, tx) {
    switch (name) {
      case 'Proposed': {
        const id = Number(e.id);
        this.proposals.set(id, { description: String(e.description).slice(0, 2_000), proposer: e.proposer, kind: Number(e.kind), votes: [], voteCount: 0, height, tx });
        this._record(height, () => this.proposals.delete(id));
        break;
      }
      case 'Voted': {
        const id = Number(e.id);
        const p = this.proposals.get(id);
        if (!p) break;
        p.voteCount++;
        const pushed = this._push(p.votes, { voter: e.voter, support: Number(e.support), weight: e.weight, height, tx });
        this._record(height, () => { p.voteCount--; if (pushed) p.votes.pop(); });
        this._voter(e.voter, { kind: 'proposal', id, height }, height);
        break;
      }
      case 'Ballot': {
        const id = Number(e.roundId);
        if (!this.rounds.has(id)) this.rounds.set(id, { ballots: [], count: 0 });
        const r = this.rounds.get(id);
        r.count++;
        const pushed = this._push(r.ballots, { voter: e.voter, weight: e.weight, approved: e.approved.length, height, tx });
        this._record(height, () => { r.count--; if (pushed) r.ballots.pop(); });
        this._voter(e.voter, { kind: 'round', id, height }, height);
        break;
      }
      case 'Removed': {
        const n = this._ngo(e.ngo);
        n.removed.push({ term: Number(e.term), reasonHash: e.reasonHash, height, tx });
        this._record(height, () => n.removed.pop());
        break;
      }
      case 'Vouched': {
        const n = this._ngo(e.ngo);
        n.vouchers.push({ voucher: e.voucher, height });
        this._record(height, () => n.vouchers.pop());
        this._voter(e.voucher, { kind: 'vouch', id: e.ngo, height }, height);
        break;
      }
      case 'Challenged': {
        const n = this._ngo(e.ngo);
        n.challenges.push({ challenger: e.challenger, reasonHash: e.reasonHash, height, tx, votes: [], decided: null });
        this._record(height, () => n.challenges.pop());
        break;
      }
      case 'DecisionVote': {
        const c = this._ngo(e.ngo).challenges.at(-1);
        if (!c) break;
        c.votes.push({ voter: e.voter, uphold: e.uphold, height, tx });
        this._record(height, () => c.votes.pop());
        break;
      }
      case 'ChallengeDecided': {
        const c = this._ngo(e.ngo).challenges.at(-1);
        if (!c) break;
        c.decided = { upheld: e.upheld, byGovernor: e.byGovernor, height };
        this._record(height, () => { c.decided = null; });
        break;
      }
      case 'Slashed': {
        const ep = Number(e.epoch);
        if (!this.slashes.has(ep)) this.slashes.set(ep, []);
        const list = this.slashes.get(ep);
        list.push({ member: e.member, reporter: e.reporter, burned: e.burned, reward: e.reward, height, tx });
        this._record(height, () => list.pop());
        break;
      }
      case 'Claimed': {
        const item = { term: Number(e.term), ngo: e.ngo, amount: e.amount, height, tx };
        const n = this._ngo(e.ngo);
        n.claims.push(item);
        // the newest are kept (pages show the latest claims); the oldest half is dropped when the list doubles the cap
        this.claims.push(item);
        if (this.claims.length > 2 * CAP) this.claims.splice(0, CAP);
        this._record(height, () => { n.claims.pop(); this.claims.pop(); });
        break;
      }
      case 'Forfeited': {
        const n = this._ngo(e.ngo);
        n.forfeits.push({ term: Number(e.term), amount: e.amount, height });
        this._record(height, () => n.forfeits.pop());
        break;
      }
      default:
    }
  }
}
