// ERC-20 token ledger for the explorer, fed by the event index (eventindex.js) from the logs of accepted
// transactions. Any contract that emits the standard event
//   Transfer(address indexed from, address indexed to, uint256 value)   topic0 0xddf252ad…b3ef, 3 topics, 32 data bytes
// is a token here: nothing is hardcoded. ERC-721 uses the same topic0 with the token id indexed (4 topics, no data)
// and is left out. Balances are the sum of each holder's Transfer events (mints come from, burns go to, address 0),
// which is what balanceOf returns for every standard token; a token that changes balances without events (rebasing)
// shows its event balance. Every list is capped so a flood of tiny transfers cannot exhaust the server's memory.

export const TRANSFER_TOPIC = 'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ZERO = '0x' + '00'.repeat(20);

export const TOKEN_CAPS = {
  tokens: 5_000, // tokens tracked (later ones are counted in `untracked`)
  holdersPerToken: 100_000, // new holders beyond this are not added (`partial`)
  recent: 500, // newest transfers kept per token, per address and overall
  tokensPerAddress: 200,
};

/** Push to a newest-last list; when it doubles its cap the oldest half is dropped. Undo = pop. */
function pushCapped(list, item, cap) {
  list.push(item);
  if (list.length > 2 * cap) list.splice(0, list.length - cap);
}

export class TokenLedger {
  constructor() { this.reset(); }

  reset() {
    this.tokens = new Map(); // token hex (0x…) -> { holders: Map addr -> bigint, transfers, recent: [], first, partial, minted, burned }
    this.byAddr = new Map(); // addr hex -> { tokens: Map token -> count of transfers, recent: [] }
    this.recent = []; // newest transfers over all tokens
    this.untracked = 0;
    this.version = 0; // changes with every applied or undone transfer (cache key for sorted holder lists)
  }

  /** True when a log is an ERC-20 Transfer (not ERC-721). */
  static isTransfer(l) {
    return l.topics?.length === 3 && l.data?.length === 32 && Buffer.from(l.topics[0]).toString('hex') === TRANSFER_TOPIC;
  }

  _addr(a) {
    let x = this.byAddr.get(a);
    if (!x) { x = { tokens: new Map(), recent: [] }; this.byAddr.set(a, x); }
    return x;
  }

  _move(t, who, delta) {
    const before = t.holders.get(who);
    if (before === undefined && delta > 0n && t.holders.size >= TOKEN_CAPS.holdersPerToken) { t.partial = true; return () => {}; }
    const after = (before ?? 0n) + delta;
    if (after === 0n) t.holders.delete(who); else t.holders.set(who, after);
    return () => { if (before === undefined) t.holders.delete(who); else t.holders.set(who, before); };
  }

  _touch(addr, token, item) {
    const x = this._addr(addr);
    const n = x.tokens.get(token);
    if (n === undefined && x.tokens.size >= TOKEN_CAPS.tokensPerAddress) return () => {};
    x.tokens.set(token, (n ?? 0) + 1);
    pushCapped(x.recent, item, TOKEN_CAPS.recent);
    return () => { x.recent.pop(); if (n === undefined) x.tokens.delete(token); else x.tokens.set(token, n); };
  }

  /**
   * Apply one Transfer: token, from, to as 0x hex (lower case), value as bigint. Returns an undo function (reorgs).
   */
  apply(token, from, to, value, height, tx, logIndex) {
    let t = this.tokens.get(token);
    const created = !t;
    if (created) {
      if (this.tokens.size >= TOKEN_CAPS.tokens) { this.untracked++; return () => { this.untracked--; }; }
      t = { holders: new Map(), transfers: 0, recent: [], first: height, partial: false, minted: 0n, burned: 0n };
      this.tokens.set(token, t);
    }
    const item = { token, from, to, value, height, tx, logIndex };
    const undos = [];
    if (from !== ZERO) undos.push(this._move(t, from, -value)); else t.minted += value;
    if (to !== ZERO) undos.push(this._move(t, to, value)); else t.burned += value;
    t.transfers++;
    pushCapped(t.recent, item, TOKEN_CAPS.recent);
    pushCapped(this.recent, item, TOKEN_CAPS.recent);
    if (from !== ZERO) undos.push(this._touch(from, token, item));
    if (to !== ZERO && to !== from) undos.push(this._touch(to, token, item));
    this.version++;
    return () => {
      for (const u of undos.reverse()) u();
      this.recent.pop();
      t.recent.pop();
      t.transfers--;
      if (from === ZERO) t.minted -= value;
      if (to === ZERO) t.burned -= value;
      if (created) this.tokens.delete(token);
      this.version++;
    };
  }

  /** Holders of a token, largest balance first (sorted once per ledger version and token). */
  holders(token) {
    const t = this.tokens.get(token);
    if (!t) return [];
    if (t.sorted?.version !== this.version) {
      const list = [...t.holders].filter(([, b]) => b > 0n).sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0] < b[0] ? -1 : 1));
      t.sorted = { version: this.version, list };
    }
    return t.sorted.list;
  }

  /** Token balances of an address: [{ token, balance }] for every token it has sent or received. */
  balancesOf(addr) {
    const x = this.byAddr.get(addr);
    if (!x) return [];
    return [...x.tokens.keys()].map((token) => ({ token, balance: this.tokens.get(token)?.holders.get(addr) ?? 0n }));
  }

  recentOf(addr) { return [...(this.byAddr.get(addr)?.recent ?? [])].reverse(); }
}
