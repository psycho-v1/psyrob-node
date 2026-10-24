// Read-only explorer pages: proposals, election rounds, account, mining statistics,
// pending transactions, top holders, committee epochs, developer documentation and contract read views.
// Nothing here signs or sends anything: the account page only reads an address (typed, or asked from the browser
// wallet with eth_requestAccounts), and contract read views call eth_call. Every chain or user value is escaped,
// every list is paginated with a fixed page size and a cap, and the expensive figures are cached per tip.

import { decodeParams } from '../../common/abicodec.js';
import { bytesToHex } from '../../common/bytes.js';
import { artifacts } from './genesis.js';
import { ADDR, TESTNET_WALLET_NAME } from './params.js';
import { EventIndex } from './eventindex.js';
import { chainMetrics } from './metrics.js';
import { lineChart, columnChart, donut, gauge, COLORS } from './charts.js';

const PER = 25; // rows per page on list pages
const PER_LONG = 50; // rows per page on voter, ballot, holder and mempool lists
const MAX_PAGE = 10_000;
const KIND = ['Ordinary', 'Treasury', 'Parameter', 'Fund', 'Removal', 'Upgrade', 'Emergency'];
const STATE = ['voting', 'defeated', 'queued', 'executed'];
const SUPPORT = ['no', 'yes', 'abstain'];
const ZERO = '0x0000000000000000000000000000000000000000';
const TWO256 = 1n << 256n;

/** Page number from ?page=: an integer in [1, max]; anything else is page 1. */
export function pageOf(q, max = MAX_PAGE) {
  const s = String(q?.get?.('page') ?? '');
  if (!/^\d{1,6}$/.test(s)) return 1;
  return Math.min(Math.max(1, Number(s)), Math.max(1, max));
}

export function installPages(Explorer, H) {
  const { esc, num, psy, when, badge, short, h0x, pkey, ROLE_NAMES, MODES, NGO_STATUS } = H;
  const P = Explorer.prototype;

  const pager = (base, page, pages, extra = '') => pages <= 1 ? '' : `<nav class="pager" aria-label="Pages">` +
    (page > 1 ? `<a class="btn btn-line" href="${base}?page=${page - 1}${extra}">Newer</a>` : '') +
    `<span class="muted">page ${num(page)} of ${num(pages)}</span>` +
    (page < pages ? `<a class="btn btn-line" href="${base}?page=${page + 1}${extra}">Older</a>` : '') + '</nav>';
  const table = (head, rows, empty) => `<div class="table-responsive"><table><thead><tr>${head.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>` +
    (rows.length ? rows.join('') : `<tr><td colspan="${head.length}">${empty}</td></tr>`) + '</tbody></table></div>';
  const kv = (rows) => `<div class="table-responsive"><table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table></div>`;
  const blockLink = (height) => `<a href="/block/${Number(height)}">#${num(height)}</a>`;
  const val = (v) => {
    if (typeof v === 'bigint') return num(v);
    if (Array.isArray(v)) return '[' + v.map(val).join(', ') + ']';
    if (v instanceof Uint8Array) return `<code>${esc(h0x(v))}</code>`;
    if (v && typeof v === 'object') return '{' + Object.entries(v).map(([k, x]) => `${esc(k)}: ${val(x)}`).join(', ') + '}';
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) return `<code>${esc(v)}</code>`;
    return esc(String(v));
  };

  /** The event index, brought up to the current tip. */
  P.events = function () {
    if (!this.eventIndex) this.eventIndex = new EventIndex(this.chain, artifacts());
    this.eventIndex.sync();
    return this.eventIndex;
  };

  // ------------------------------------------------------------------ proposals

  P.proposalsPage = async function (q) {
    const ev = this.events();
    const d = await this.reads(async (read) => {
      const n = Number(await read('Governor', 'proposalCount') ?? 0n);
      const pages = Math.max(1, Math.ceil(n / PER));
      const page = pageOf(q, pages);
      const rows = [];
      for (let id = n - 1 - (page - 1) * PER; id >= 0 && id > n - 1 - page * PER; id--) rows.push({ id, p: await read('Governor', 'getProposal', [BigInt(id)]), passes: await read('Governor', 'passes', [BigInt(id)]) });
      return { n, pages, page, rows };
    });
    const rows = d.rows.map(({ id, p, passes }) => {
      const desc = ev.proposals.get(id)?.description ?? '';
      return `<tr><td><a href="/proposal/${id}">${id}</a></td><td>${esc(KIND[Number(p.kind)] ?? '?')}</td><td>${esc(desc.length > 90 ? desc.slice(0, 90) + '…' : desc)}</td>` +
        `<td>${this.addr(p.proposer)}</td><td>${psy(p.yes, 0)} / ${psy(p.no, 0)} / ${psy(p.abstain, 0)}</td><td>${esc(STATE[Number(p.state)] ?? '?')}${Number(p.state) === 0 ? ' ' + (passes ? badge('passing', true) : badge('not passing')) : ''}</td><td>${when(p.end)}</td></tr>`;
    });
    const body = '<p class="eyebrow">Proposals</p><h1>Every proposal.</h1><p class="lead">All proposals, newest first. Open one for its actions, voters, the floor it needs and its timelock. To vote or propose, use <a href="/governance">Vote and propose</a>.</p>' +
      `<p class="muted">${num(d.n)} proposals.</p>` + table(['#', 'Kind', 'Description', 'Proposer', 'Yes / no / abstain (PSY)', 'State', 'Voting ends'], rows, 'No proposals yet.') + pager('/proposals', d.page, d.pages);
    return this.layout('Proposals', body, '/proposals');
  };

  /** Decode one action's calldata against the ABI of the system contract it targets. */
  P.decodeAction = function (target, value, rawData) {
    const data = typeof rawData === 'string' ? Uint8Array.from(Buffer.from(rawData.replace(/^0x/, ''), 'hex')) : rawData;
    const name = this.labels.get(String(target).replace(/^0x/, '').toLowerCase());
    const out = { target: this.addr(target), value: psy(value), fn: null, args: [], raw: data };
    const c = name && this.c[name];
    if (!c || data.length < 4) return out;
    const sel = h0x(data.slice(0, 4));
    for (const list of c.codec.functions.values()) {
      for (const x of list) {
        if (h0x(x.sel) !== sel) continue;
        out.fn = `${name}.${x.f.name}`;
        try { const vals = decodeParams(x.f.inputs, data.slice(4)); out.args = x.f.inputs.map((inp, i) => [inp.name || `arg${i}`, inp.type, vals[i]]); } catch { out.args = null; }
        return out;
      }
    }
    return out;
  };

  P.proposalPage = async function (ref, q) {
    if (!/^\d{1,9}$/.test(ref)) return null;
    const id = BigInt(ref);
    const d = await this.reads(async (read) => {
      const n = await read('Governor', 'proposalCount');
      if (n === null || id >= n) return null;
      return {
        p: await read('Governor', 'getProposal', [id]), actions: await read('Governor', 'actions', [id]), quorum: await read('Governor', 'quorumOf', [id]),
        passes: await read('Governor', 'passes', [id]), high: await read('Governor', 'highFloor', [id]), counted: await read('Governor', 'lockedYesVoters', [id]),
        minLock: await read('Params', 'get', [pkey('minCountedVoterLock')]), mode: Number(await read('GovernanceMode', 'mode') ?? 0n),
      };
    });
    if (!d) return null;
    const { p } = d;
    const kind = Number(p.kind), state = Number(p.state), now = this.now();
    const lowTier = kind === 0 && !d.high;
    const [aq, fw, mv] = d.quorum ?? [0n, 0n, 0n];
    const tier = lowTier ? 'Ordinary tier: 5 % of the locked PSY at the snapshot, or 50 distinct yes voters'
      : (d.high ? 'Higher tier (attestation decision by token vote, P1): ' : `${esc(KIND[kind])} tier: `) + `10 % of the locked PSY at the snapshot, or 100 yes voters with at least ${psy(d.minLock ?? 0n, 0)} PSY each`;
    const voters = lowTier ? Number(p.yesVoters) : Number(d.counted ?? 0n);
    const [targets = [], values = [], datas = []] = d.actions ?? [];
    const acts = targets.map((t, i) => {
      const a = this.decodeAction(t, values[i], datas[i]);
      const args = a.args === null ? '<span class="muted">arguments could not be decoded</span>'
        : a.args.length ? '<ul class="mb-0">' + a.args.map(([n, ty, v]) => `<li><code>${esc(n)}</code> <span class="muted">${esc(ty)}</span>: ${val(v)}</li>`).join('') + '</ul>' : '<span class="muted">no arguments</span>';
      return `<tr><td>${i}</td><td>${a.target}</td><td>${a.fn ? `<code>${esc(a.fn)}</code>` : '<span class="muted">unknown function</span>'}<div>${args}</div><details><summary class="muted">calldata</summary><code>${esc(h0x(a.raw))}</code></details></td><td>${a.value} PSY</td></tr>`;
    });
    const status = state === 0 ? (now < Number(p.end) ? `voting until ${when(p.end)}` : 'voting closed: anyone can count it (<code>decide</code>)')
      : state === 1 ? 'defeated' : state === 2 ? (now < Number(p.eta) ? `passed; timelocked until ${when(p.eta)}` : 'passed; the timelock is over: anyone can execute it') : 'executed';
    const ev = this.events().proposals.get(Number(id));
    const vs = ev?.votes ?? [];
    const pages = Math.max(1, Math.ceil(vs.length / PER_LONG));
    const page = pageOf(q, pages);
    const slice = vs.slice().reverse().slice((page - 1) * PER_LONG, page * PER_LONG);
    const vrows = slice.map((v) => `<tr><td>${this.addr(v.voter)}</td><td>${esc(SUPPORT[v.support] ?? '?')}</td><td>${psy(v.weight, 2)}</td><td>${blockLink(v.height)}</td></tr>`);
    const body = `<p class="eyebrow">Proposal ${esc(ref)}</p><h1>${esc(KIND[kind] ?? '?')} proposal ${esc(ref)}</h1>` +
      (ev?.description ? `<div class="panel" style="white-space:pre-wrap">${esc(ev.description)}</div>` : '') +
      kv([['Proposer', this.addr(p.proposer)], ['Status', status], ['Snapshot', `chain block ${blockLink(Number(p.snapshotBlock))}`], ['Voting', `${when(p.start)} to ${when(p.end)}`],
        ['Timelock', Number(p.eta) ? `executable from ${when(p.eta)} (48 hours after the count)` : '48 hours after a passing count'],
        ['Yes / no / abstain', `${psy(p.yes, 2)} / ${psy(p.no, 2)} / ${psy(p.abstain, 2)} PSY`], ['Floor in use', tier],
        ['What passing needs', `yes &gt; no, yes ≥ ${psy(aq, 2)} PSY (half the recent turnout), and yes ≥ ${psy(fw, 2)} PSY or ${num(mv)} counted yes voters (now ${num(voters)}${lowTier ? '' : ` of ${num(p.yesVoters)} yes voters`})`],
        ['Passes now', d.passes ? badge('yes', true) : badge('no')], ['Mode', esc(MODES[d.mode] ?? '?') + (kind !== 0 && d.mode !== 1 ? ' <span class="muted">(this kind executes only in Normal mode)</span>' : '')]]) +
      '<h2 class="mt-4">Actions</h2>' + table(['#', 'Target', 'Call', 'Value'], acts, 'No actions.') +
      `<h2 class="mt-4">Voters</h2><p class="muted">${num(ev?.voteCount ?? 0)} ballots, newest first.</p>` + table(['Voter', 'Vote', 'Weight (PSY)', 'Block'], vrows, 'No votes yet.') + pager(`/proposal/${esc(ref)}`, page, pages);
    return this.layout(`Proposal ${ref}`, body, '/proposals');
  };

  // ------------------------------------------------------------------ election rounds

  P.electionRoundsPage = async function (q) {
    const d = await this.reads(async (read) => {
      const n = Number(await read('NGOElection', 'roundCount') ?? 0n);
      const pages = Math.max(1, Math.ceil(n / PER));
      const page = pageOf(q, pages);
      const rows = [];
      for (let id = n - 1 - (page - 1) * PER; id >= 0 && id > n - 1 - page * PER; id--) rows.push({ id, r: await read('NGOElection', 'getRound', [BigInt(id)]), cands: (await read('NGOElection', 'candidates', [BigInt(id)]) ?? []).length });
      return { n, pages, page, rows };
    });
    const now = this.now();
    const rows = d.rows.map(({ id, r, cands }) => {
      const open = now >= Number(r.opens) && now < Number(r.closes);
      return `<tr><td><a href="/election-round/${id}">${id}</a></td><td>${num(r.term)}</td><td>${Number(r.slot) === 0 ? 'main' : 'supplementary ' + num(r.slot)}</td><td>${when(r.opens)}</td><td>${when(r.closes)}</td><td>${num(r.seats)}</td><td>${num(cands)}</td><td>${num(r.ballots)}</td><td>${r.finalized ? badge('final', true) : open ? badge('open', true) : badge('closed')}</td></tr>`;
    });
    const body = '<p class="eyebrow">NGO election rounds</p><h1>Every round.</h1><p class="lead">The main round of each term and the supplementary rounds that fill empty seats, newest first.</p>' +
      table(['Round', 'Term', 'Kind', 'Opens', 'Closes', 'Seats', 'Candidates', 'Ballots', 'State'], rows, 'No round yet.') + pager('/election-rounds', d.page, d.pages);
    return this.layout('Election rounds', body, '/election-rounds');
  };

  P.electionRoundPage = async function (ref, q) {
    if (!/^\d{1,9}$/.test(ref)) return null;
    const id = BigInt(ref);
    const d = await this.reads(async (read) => {
      const n = await read('NGOElection', 'roundCount');
      if (n === null || id >= n) return null;
      const r = await read('NGOElection', 'getRound', [id]);
      const cands = (await read('NGOElection', 'candidates', [id])) ?? [];
      const rows = [];
      for (const c of cands) {
        const rec = await read('NGORegistry', 'get', [c]);
        rows.push({ c, name: rec?.name, status: Number(rec?.status ?? 0), w: await read('NGOElection', 'approvals', [id, c]) ?? 0n, voters: await read('NGOElection', 'approvers', [id, c]) ?? 0n, elected: await read('NGOElection', 'isElectedIn', [r.term, c]) });
      }
      return { r, rows, minVoters: await read('Params', 'get', [pkey('firstElectionMinVoters')]) ?? 5n, snap: await read('NGOElection', 'snapshotOf', [id]) ?? 0n };
    });
    if (!d) return null;
    const { r } = d;
    const first = Number(r.term) === 1 && Number(r.slot) === 0;
    d.rows.sort((a, b) => (b.w > a.w ? 1 : b.w < a.w ? -1 : 0));
    const crows = d.rows.map((x, i) => `<tr><td>${i + 1}</td><td><a href="/ngo/${esc(x.c)}">${esc(x.name ?? short(x.c))}</a><div class="muted">${esc(NGO_STATUS[x.status] ?? '')}</div></td><td>${psy(x.w, 2)}</td>` +
      `<td>${num(x.voters)}${first ? ` of ${num(d.minVoters)} required${x.voters >= d.minVoters ? '' : ' ' + badge('too few')}` : ''}</td><td>${x.elected ? badge('elected', true) : r.finalized ? badge('not elected') : '–'}</td></tr>`);
    const ev = this.events().rounds.get(Number(id));
    const bs = ev?.ballots ?? [];
    const pages = Math.max(1, Math.ceil(bs.length / PER_LONG));
    const page = pageOf(q, pages);
    const brows = bs.slice().reverse().slice((page - 1) * PER_LONG, page * PER_LONG).map((b) => `<tr><td>${this.addr(b.voter)}</td><td>${psy(b.weight, 2)}</td><td>${num(b.approved)}</td><td>${blockLink(b.height)}</td></tr>`);
    const elected = d.rows.filter((x) => x.elected).length;
    const body = `<p class="eyebrow">Election round ${esc(ref)}</p><h1>${first ? 'The first election' : Number(r.slot) === 0 ? `Main election, term ${num(r.term)}` : `Supplementary round ${num(r.slot)}, term ${num(r.term)}`}</h1>` +
      kv([['Term', num(r.term)], ['Opens', when(r.opens)], ['Closes', when(r.closes)], ['Seats', num(r.seats)], ['Candidates', num(d.rows.length)], ['Ballots', num(r.ballots)],
        ['Weights', Number(d.snap) ? `locked PSY at chain block ${blockLink(Number(d.snap))} and at the ballot (the smaller), at most the 30-day average and 1 % of all locked PSY per wallet` : 'locked PSY at the ballot (the first election opens at genesis), at most the 30-day average and 1 % of all locked PSY per wallet'],
        ...(first ? [['Distinct voters needed', `${num(d.minVoters)} approvers with at least 100 PSY locked each, per candidate`]] : []),
        ['Result', r.finalized ? `${num(elected)} elected` : 'not counted yet']]) +
      '<h2 class="mt-4">Candidates</h2>' + table(['#', 'NGO', 'Approval weight (PSY)', 'Counted approvers', 'Result'], crows, 'No candidates.') +
      `<h2 class="mt-4">Ballots</h2><p class="muted">${num(ev?.count ?? 0)} ballots, newest first.</p>` + table(['Voter', 'Weight (PSY)', 'Approved', 'Block'], brows, 'No ballots yet.') + pager(`/election-round/${esc(ref)}`, page, pages);
    return this.layout(`Election round ${ref}`, body, '/election-rounds');
  };

  // ------------------------------------------------------------------ my account (read-only)

  P.accountPage = async function (q) {
    const raw = String(q.get('address') ?? '').trim();
    const form = '<form class="row g-2 my-3" action="/account" method="get"><div class="col"><input class="form-control" name="address" value="' + esc(raw) + '" placeholder="0x… address" pattern="0x[0-9a-fA-F]{40}"></div>' +
      '<div class="col-auto"><button class="btn btn-line" type="submit">Show</button></div><div class="col-auto"><button class="btn btn-cyan" type="button" id="account-connect">Use my wallet address</button></div></form>' +
      '<p class="muted small">Read-only. "Use my wallet address" only asks your browser wallet which address is selected; nothing is signed or sent.</p>';
    const head = '<p class="eyebrow">My account</p><h1>Your PSY, votes and duties.</h1><p class="lead">Locked PSY and holds, ballots, vouches, PSY owed to you, NGO rewards, role pay and committee bond, for one address.</p>';
    if (!raw) return this.layout('My account', head + form, '/account', { scripts: '<script type="module" src="/pages.js"></script>' });
    if (!/^0x[0-9a-fA-F]{40}$/.test(raw)) return this.layout('My account', head + form + '<div class="warn">That is not an address (0x and 40 hex characters).</div>', '/account', { scripts: '<script type="module" src="/pages.js"></script>' });
    const a = raw.toLowerCase();
    const now = this.now();
    const d = await this.reads(async (read, view) => {
      const acct = view.getAccount(Uint8Array.from(Buffer.from(a.slice(2), 'hex')));
      const owed = [];
      for (const name of Object.keys(this.c)) {
        if (!this.c[name].codec.functions.has('owed')) continue;
        const o = await read(name, 'owed', [a]);
        if (o) owed.push([name, o]);
      }
      const term = Number(await read('NGOElection', 'currentTerm') ?? 0n);
      const claim = [];
      for (const t of [term, term - 1]) if (t >= 1) { const x = await read('NGORewards', 'claimable', [BigInt(t), a]); if (x) claim.push([t, x]); }
      const roles = [];
      const pay = await read('Params', 'get', [pkey('rolePayPer30Days')]) ?? 0n;
      for (let i = 0; i < 5; i++) {
        const hld = await read('RoleElection', 'holder', [BigInt(i)]);
        if (hld && hld.who.toLowerCase() === a) {
          const end = Math.min(now, Number(hld.termEnd));
          roles.push([i, hld, end > Number(hld.paidUntil) ? pay * BigInt(end - Number(hld.paidUntil)) / 2_592_000n : 0n]);
        }
      }
      const e = Number(await read('FinalityCommittee', 'currentEpoch') ?? 0n);
      const epochs = [];
      for (let x = e; x >= Math.max(0, e - 4); x--) {
        const seat = Number(await read('FinalityCommittee', 'seatOf', [BigInt(x), a]) ?? 0n);
        if (!seat) continue;
        epochs.push({ e: x, seat, signed: await read('FinalityCommittee', 'signedCount', [BigInt(x), a]), cps: await read('FinalityCommittee', 'checkpointCount', [BigInt(x)]),
          slashed: await read('FinalityCommittee', 'slashed', [BigInt(x), a]), claimed: await read('FinalityCommittee', 'rewardClaimed', [BigInt(x), a]),
          pool: await read('FinalityCommittee', 'rewardPool', [BigInt(x)]), settled: await read('FinalityCommittee', 'eligibleCount', [BigInt(x)]) });
      }
      return {
        balance: acct.balance, nonce: acct.nonce, locked: await read('VoteEscrow', 'locked', [a]) ?? 0n, held: await read('VoteEscrow', 'heldUntil', [a]) ?? 0n,
        registered: await read('MinerRegistry', 'isRegistered', [a]), mined: await read('MinerRegistry', 'minedTotal', [a]) ?? 0n, weeks: await read('MinerRegistry', 'activeEpochs', [a]) ?? 0n,
        operator: await read('MinerRegistry', 'operatorOf', [a]), ngo: Number(await read('NGORegistry', 'status', [a]) ?? 0n), elected: await read('NGOElection', 'isElected', [a]),
        vouches: await read('Attestation', 'activeVouches', [a]) ?? 0n, roleHolder: await read('RoleElection', 'isRoleHolder', [a]), owed, claim, roles, term,
        bond: await read('FinalityCommittee', 'bonds', [a]), epoch: e, epochs,
        // the evidence window: locked until 14 days after its last committee was replaced
        lastServed: Number(await read('FinalityCommittee', 'lastServed', [a]) ?? 0n),
        retiredAt: await (async () => { const s = Number(await read('FinalityCommittee', 'lastServed', [a]) ?? 0n); return s ? Number(await read('FinalityCommittee', 'retiredAt', [BigInt(s - 1)]) ?? 0n) : 0; })(),
      };
    });
    const ix = this.events().byVoter.get(a) ?? [];
    const ballots = ix.filter((x) => x.kind !== 'vouch').slice(-PER_LONG).reverse().map((x) => x.kind === 'proposal'
      ? `<li>Vote on <a href="/proposal/${x.id}">proposal ${x.id}</a> at ${blockLink(x.height)}</li>` : `<li>Ballot in <a href="/election-round/${x.id}">election round ${x.id}</a> at ${blockLink(x.height)}</li>`);
    const vouched = ix.filter((x) => x.kind === 'vouch').slice(-PER_LONG).reverse().map((x) => `<li><a href="/ngo/${esc(x.id)}">${esc(short(x.id))}</a> at ${blockLink(x.height)}</li>`);
    const bondAmt = d.bond?.amount ?? d.bond?.[0] ?? 0n, unbondAt = Number(d.bond?.unbondAt ?? d.bond?.[2] ?? 0n);
    const erows = d.epochs.map((x) => {
      const eligible = !x.slashed && Number(x.cps) > 0 && x.signed * 2n >= x.cps;
      const share = Number(x.settled) > 1 ? x.pool / (x.settled - 1n) : null;
      const st = x.e >= d.epoch ? 'epoch running' : x.claimed ? 'claimed' : eligible ? `claimable${share !== null ? ' (' + psy(share, 2) + ' PSY)' : ' once the epoch is settled'}` : 'not earned';
      return `<tr><td><a href="/committee/${x.e}">${x.e}</a></td><td>${x.seat === 1 ? 'NGO' : 'miner'}</td><td>${num(x.signed)} of ${num(x.cps)}</td><td>${x.slashed ? '<span class="st red">slashed</span>' : '–'}</td><td>${esc(st)}</td></tr>`;
    });
    const body = head + form +
      kv([['Address', `<code>${esc(a)}</code> · <a href="/address/${esc(a)}">transactions</a>`], ['Balance', psy(d.balance) + ' PSY'], ['Nonce', num(d.nonce)],
        ['Locked for voting', `${psy(d.locked)} PSY` + (Number(d.held) > now ? ` · held until ${when(d.held)} (a vote is open)` : ' · not held')],
        ['Miner', d.registered ? `registered · ${num(d.mined)} blue blocks in ${num(d.weeks)} weeks · operator <code>${esc(String(d.operator))}</code>` : 'not registered'],
        ['NGO', d.ngo ? esc(NGO_STATUS[d.ngo] ?? '?') + (d.elected ? ' · ' + badge('elected', true) : '') : 'not an NGO'],
        ['Active vouches', num(d.vouches)], ['Role holder', d.roleHolder ? 'yes: cannot vote while in office' : 'no'],
        ['PSY owed to you', d.owed.length ? d.owed.map(([n, o]) => `${psy(o)} PSY in ${esc(n)}`).join('<br>') + '<div class="muted">take it with <code>withdrawOwed()</code> on that contract</div>' : 'none'],
        ['Claimable NGO rewards', d.claim.length ? d.claim.map(([t, x]) => `${psy(x)} PSY (term ${num(t)})`).join('<br>') : 'none'],
        ['Role pay accrued', d.roles.length ? d.roles.map(([i, , amt]) => `${esc(ROLE_NAMES[i])}: ${psy(amt)} PSY`).join('<br>') : 'none'],
        ['Committee bond', bondAmt > 0n ? `${psy(bondAmt)} PSY` + (unbondAt ? ` · leaving, ${d.lastServed && !d.retiredAt
          ? `withdrawable 14 days after the committee of epoch ${num(d.lastServed - 1)} is replaced (evidence window)`
          : `withdrawable from ${when(Math.max(unbondAt, d.lastServed ? d.retiredAt + 14 * 86400 : 0))}`}` : '') : 'none']]) +
      `<h2 class="mt-4">Committee seats (last 5 epochs)</h2>` + table(['Epoch', 'Seat', 'Checkpoints signed', 'Slashed', 'Reward'], erows, 'No seat in the last 5 epochs.') +
      `<h2 class="mt-4">Ballots</h2>${ballots.length ? `<ul>${ballots.join('')}</ul>` : '<p class="muted">No ballots.</p>'}` +
      `<h2 class="mt-4">Vouches</h2>${vouched.length ? `<ul>${vouched.join('')}</ul>` : '<p class="muted">No vouches.</p>'}`;
    return this.layout('My account', body, '/account', { scripts: '<script type="module" src="/pages.js"></script>' });
  };

  // ------------------------------------------------------------------ NGO page additions

  /** Term limit, removal and challenge history for /ngo/:addr. */
  P.ngoExtras = async function (ref) {
    const a = ref.toLowerCase();
    const d = await this.reads(async (read) => {
      const term = Number(await read('NGOElection', 'currentTerm') ?? 0n);
      return { term, limitedNext: await read('NGOElection', 'termLimited', [BigInt(term + 1), a]) };
    });
    const ix = this.events().ngos.get(a) ?? { challenges: [], removed: [] };
    const rows = [];
    if (d.limitedNext) rows.push(['Term limit', `held a seat in terms ${num(d.term - 1)} and ${num(d.term)}: sits out term ${num(d.term + 1)}; may stand again for term ${num(d.term + 2)}`]);
    else rows.push(['Term limit', 'may stand in the next election']);
    for (const r of ix.removed) rows.push(['Removed', `for the rest of term ${num(r.term)} at ${blockLink(r.height)} · reason hash <code>${esc(r.reasonHash)}</code>`]);
    const ch = ix.challenges.map((c, i) => `<div class="panel"><h3 class="h5">Challenge ${i + 1}</h3>` + kv([['Challenger', this.addr(c.challenger)], ['Reason hash', `<code>${esc(c.reasonHash)}</code> <span class="muted">(the text is published by the challenger)</span>`],
      ['Opened', blockLink(c.height)], ['Outcome', c.decided ? (c.decided.upheld ? badge('upheld', true) + ' NGO rejected' : badge('dismissed')) + (c.decided.byGovernor ? ' by token vote' : ' by the elected NGOs') : 'pending']]) +
      table(['NGO', 'Vote', 'Block'], c.votes.map((v) => `<tr><td>${this.addr(v.voter)}</td><td>${v.uphold ? 'uphold' : 'dismiss'}</td><td>${blockLink(v.height)}</td></tr>`), 'No decision votes yet.') + '</div>').join('');
    return '<h2 class="mt-4">Seat history</h2>' + kv(rows) + (ch ? '<h2 class="mt-4">Challenges</h2>' + ch : '');
  };

  // ------------------------------------------------------------------ mining statistics

  /** Difficulty, estimated attempts per second, block interval, red-block rate and gas use over the last chain blocks. Cached per tip. */
  P.miningData = function (window = 500) {
    const c = this.chain;
    if (this.miningCache?.tip === c.tip.hash) return this.miningCache.value;
    const tip = c.tip, to = tip.chainHeight, from = Math.max(0, to - window);
    let blues = 0, reds = 0, work = 0n, gas = 0n;
    const series = []; // the last 60 chain blocks: seconds since the previous one, blue/red merged, gas use, work
    for (let x = from + 1; x <= to; x++) {
      const e = c.dag.get(c.chain[x]);
      let bw = 0n, b1 = 0, r1 = 0;
      for (const hsh of e.mergesetBlues ?? []) { const b = c.dag.get(hsh); if (b && b !== c.dag.genesis) { blues++; b1++; bw += TWO256 / BigInt(b.header.target); } }
      for (const hsh of e.mergesetReds ?? []) { const b = c.dag.get(hsh); if (b) { reds++; r1++; bw += TWO256 / BigInt(b.header.target); } }
      work += bw;
      gas += BigInt(e.gasUsed ?? 0n);
      if (x > to - 60) {
        const prev = c.dag.get(c.chain[x - 1]);
        series.push({ height: x, interval: Math.max(0, e.header.timestamp - prev.header.timestamp), blues: b1, reds: r1, gas: Number((BigInt(e.gasUsed ?? 0n) * 10_000n) / BigInt(this.p.mergesetGasLimit)) / 10_000, work: bw.toString() });
      }
    }
    const t0 = c.dag.get(c.chain[from]).header.timestamp, span = Math.max(1, tip.header.timestamp - t0), chainBlocks = to - from;
    const next = c.expectedTarget(tip);
    const value = {
      tip: '0x' + tip.hash, chainHeight: to, window: chainBlocks, difficulty: (TWO256 / BigInt(next)).toString(), target: '0x' + BigInt(next).toString(16),
      attemptsPerSecond: chainBlocks ? Number(work / BigInt(span)) : 0, secondsPerChainBlock: chainBlocks ? span / chainBlocks : null,
      secondsPerDagBlock: blues + reds ? span / (blues + reds) : null, targetSpacing: this.p.targetSpacing, blueBlocks: blues, redBlocks: reds,
      redRate: blues + reds ? reds / (blues + reds) : 0, gasUse: chainBlocks ? Number((gas * 10_000n) / (BigInt(chainBlocks) * BigInt(this.p.mergesetGasLimit))) / 10_000 : 0,
      blockGasLimit: String(this.p.mergesetGasLimit), series,
    };
    this.miningCache = { tip: c.tip.hash, value };
    return value;
  };

  P.miningPage = function () {
    const m = this.miningData();
    const r = (x, d = 1) => (x === null ? '–' : Number(x).toLocaleString('en-US', { maximumFractionDigits: d }));
    const ser = m.series;
    const pace = m.secondsPerChainBlock ? Math.min(1, m.targetSpacing / m.secondsPerChainBlock) : 0;
    // estimated attempts per second over a sliding window of 10 chain blocks
    const rate = [];
    for (let i = 9; i < ser.length; i++) {
      const w = ser.slice(i - 9, i + 1), secs = w.reduce((a, x) => a + x.interval, 0);
      if (secs > 0) rate.push([ser[i].height, Number(w.reduce((a, x) => a + BigInt(x.work), 0n) / BigInt(secs))]);
    }
    const cpu = '<svg class="chart" viewBox="0 0 120 120" style="max-width:120px;margin:auto" aria-hidden="true"><rect x="30" y="30" width="60" height="60" fill="none" stroke="var(--cyan)" stroke-width="3"/>' +
      '<rect x="44" y="44" width="32" height="32" fill="var(--cyan)" opacity=".25" class="dot"/>' +
      [38, 52, 66, 80].map((v) => `<line x1="${v}" y1="18" x2="${v}" y2="30" stroke="var(--cyan)"/><line x1="${v}" y1="90" x2="${v}" y2="102" stroke="var(--cyan)"/><line x1="18" y1="${v}" x2="30" y2="${v}" stroke="var(--cyan)"/><line x1="90" y1="${v}" x2="102" y2="${v}" stroke="var(--cyan)"/>`).join('') +
      '<text class="big" x="60" y="66" text-anchor="middle" style="font-size:13px">ARGON2D</text></svg>';
    const body = '<p class="eyebrow">Mining statistics</p><h1>Work, pace and red blocks.</h1><p class="lead">Over the last chain blocks (at most 500). Each attempt is one Argon2d evaluation with 32 MiB of memory; the network rate is estimated from the work of the blocks found.</p>' +
      '<div class="charts">' +
      `<div class="panel"><h3>Pace</h3>${gauge({ title: 'Block pace', value: pace, center: m.secondsPerChainBlock ? r(m.secondsPerChainBlock) + ' s' : '–', sub: `per chain block (target ${m.targetSpacing} s)` })}</div>` +
      `<div class="panel"><h3>Blue and red blocks</h3>${donut({ title: 'Blue and red blocks', center: m.blueBlocks + m.redBlocks ? r((1 - m.redRate) * 100) + ' %' : '–', sub: 'blue', parts: [{ label: 'Blue', value: m.blueBlocks, color: COLORS[0] }, { label: 'Red', value: m.redBlocks, color: COLORS[4] }] })}</div>` +
      `<div class="panel"><h3>CPU mining</h3>${cpu}<p class="text-center mb-0"><strong>${r(m.attemptsPerSecond, 0)}</strong> attempts per second<br><span class="muted">difficulty ${num(BigInt(m.difficulty))} attempts per block</span></p></div>` +
      '</div><div class="charts">' +
      `<div class="panel"><h3>Seconds between chain blocks (last ${ser.length})</h3>${columnChart({ title: 'Block intervals', values: ser.map((x) => x.interval), target: m.targetSpacing, fmtY: (v) => Math.round(v) + ' s', labels: ser.length ? ['#' + ser[0].height, '#' + ser.at(-1).height] : null })}</div>` +
      `<div class="panel"><h3>Network attempts per second</h3>${lineChart({ title: 'Network rate', series: [{ name: 'Estimated, 10-block window', color: COLORS[0], points: rate }], fmtX: (v) => '#' + Math.round(v), fmtY: (v) => Math.round(v).toLocaleString('en-US') })}</div>` +
      `<div class="panel"><h3>Gas use per chain block</h3>${columnChart({ title: 'Gas use', values: ser.map((x) => x.gas * 100), fmtY: (v) => v.toFixed(1) + ' %', color: COLORS[1], labels: ser.length ? ['#' + ser[0].height, '#' + ser.at(-1).height] : null })}</div>` +
      '</div>' +
      kv([['Window', `chain blocks ${blockLink(m.chainHeight - m.window)} to ${blockLink(m.chainHeight)} (${num(m.window)})`], ['Current difficulty', `${num(BigInt(m.difficulty))} expected attempts per block`],
        ['Estimated network rate', `${r(m.attemptsPerSecond, 0)} attempts per second`], ['Time per chain block', `${r(m.secondsPerChainBlock)} s (target ${num(m.targetSpacing)} s)`],
        ['Time per DAG block', `${r(m.secondsPerDagBlock)} s (blue and red)`], ['Blue / red blocks', `${num(m.blueBlocks)} / ${num(m.redBlocks)}`],
        ['Red-block rate', `${r(m.redRate * 100, 2)} %`], ['Block gas use', `${r(m.gasUse * 100, 2)} % of ${num(BigInt(m.blockGasLimit))} gas per chain block (its whole mergeset)`]]) +
      '<p class="muted">Also as JSON at <code>/api/mining</code>. Concentration of mining by address is on <a href="/metrics">Decentralisation metrics</a>.</p>';
    return this.layout('Mining statistics', body, '/mining');
  };

  // ------------------------------------------------------------------ pending transactions

  P.mempoolPage = function (q) {
    const all = this.node.mempool.all().slice(0, 5_000).sort((x, y) => (y.maxFee > x.maxFee ? 1 : y.maxFee < x.maxFee ? -1 : 0)).slice(0, 1_000);
    const pages = Math.max(1, Math.ceil(all.length / PER_LONG));
    const page = pageOf(q, pages);
    const rows = all.slice((page - 1) * PER_LONG, page * PER_LONG).map((t) => `<tr><td><code>${esc(short(h0x(t.hash)))}</code></td><td>${this.addr(t.from)}</td><td>${this.addr(t.to)}</td>` +
      `<td>${num(t.nonce)}</td><td>${psy(t.value)}</td><td>${(Number(t.maxFee) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 3 })} / ${(Number(t.maxPriorityFee) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 3 })}</td></tr>`);
    const body = '<p class="eyebrow">Pending transactions</p><h1>Waiting for a block.</h1><p class="lead">Transactions this node holds that no chain block has accepted yet, highest fee first (at most 1,000 shown).</p>' +
      `<p class="muted">${num(this.node.mempool.size)} pending.</p>` + table(['Hash', 'From', 'To', 'Nonce', 'Value (PSY)', 'Max fee / tip (gwei)'], rows, 'Nothing is pending.') + pager('/mempool', page, pages);
    return this.layout('Pending transactions', body, '/mempool');
  };

  // ------------------------------------------------------------------ top holders

  /** Balances of every account, largest first (top 1,000), refreshed at most every 30 seconds. */
  P.holdersData = function () {
    const c = this.chain;
    if (this.holdersCache && (this.holdersCache.tip === c.tip.hash || Date.now() - this.holdersCache.at < 30_000)) return this.holdersCache.value;
    const top = [];
    for (const [k, v] of c.state.data) {
      if (k[0] !== 'a' || !(v.balance > 0n)) continue;
      top.push([k.slice(1), v.balance]);
    }
    top.sort((x, y) => (y[1] > x[1] ? 1 : y[1] < x[1] ? -1 : 0));
    const value = { total: top.length, top: top.slice(0, 1_000) };
    this.holdersCache = { tip: c.tip.hash, at: Date.now(), value };
    return value;
  };

  P.holdersPage = function (q) {
    const d = this.holdersData();
    const conc = chainMetrics(this.chain).holdings;
    const pages = Math.max(1, Math.ceil(d.top.length / PER_LONG));
    const page = pageOf(q, pages);
    const sys = (hex) => this.labels.get(hex) ?? (hex === 'fffffffffffffffffffffffffffffffffffffffe' ? 'System caller' : null);
    const rows = d.top.slice((page - 1) * PER_LONG, page * PER_LONG).map(([hex, bal], i) => {
      const label = sys(hex);
      return `<tr><td>${num((page - 1) * PER_LONG + i + 1)}</td><td>${this.addr(hex)}</td><td>${label ? badge('system: ' + label) : ''}</td><td>${psy(bal, 2)}</td></tr>`;
    });
    const pct = (x) => (x * 100).toLocaleString('en-US', { maximumFractionDigits: 2 }) + ' %';
    const body = '<p class="eyebrow">Top holders</p><h1>Who holds the PSY.</h1><p class="lead">Every address by balance. System contracts (Treasury, team vesting, NGO pool, committee, vote escrow) and the burn address are labelled; PSY locked for voting sits in the vote escrow.</p>' +
      kv([['Addresses with PSY', num(d.total)], ['Concentration (ordinary addresses)', `largest ${pct(conc.top1)} · largest five ${pct(conc.top5)} · Nakamoto coefficient ${num(conc.nakamoto)} · Gini ${conc.gini}`]]) +
      table(['Rank', 'Address', '', 'Balance (PSY)'], rows, 'No balances.') + pager('/holders', page, pages) + '<p class="muted">More figures on <a href="/metrics">Decentralisation metrics</a>.</p>';
    return this.layout('Top holders', body, '/holders');
  };

  // ------------------------------------------------------------------ committee epochs

  P.committeeEpochPage = async function (ref) {
    if (!/^\d{1,7}$/.test(ref)) return null;
    const e = BigInt(ref);
    const d = await this.reads(async (read) => {
      const cur = await read('FinalityCommittee', 'currentEpoch');
      if (cur === null || e > cur) return null;
      const members = await read('FinalityCommittee', 'members', [e]) ?? [];
      const rows = [];
      for (const m of members) rows.push({ m, seat: await read('FinalityCommittee', 'seatOf', [e, m]), signed: await read('FinalityCommittee', 'signedCount', [e, m]), slashed: await read('FinalityCommittee', 'slashed', [e, m]), claimed: await read('FinalityCommittee', 'rewardClaimed', [e, m]) });
      return { cur, rows, cps: await read('FinalityCommittee', 'checkpointCount', [e]) ?? 0n, pool: await read('FinalityCommittee', 'rewardPool', [e]) ?? 0n, settled: await read('FinalityCommittee', 'eligibleCount', [e]) ?? 0n };
    });
    if (!d) return null;
    const slashes = this.events().slashes.get(Number(e)) ?? [];
    const rows = d.rows.map((x) => `<tr><td>${this.addr(x.m)}</td><td>${Number(x.seat) === 1 ? 'NGO' : 'miner'}</td><td>${num(x.signed)} of ${num(d.cps)}</td><td>${x.slashed ? '<span class="st red">slashed</span>' : badge('active', true)}</td><td>${x.claimed ? 'claimed' : '–'}</td></tr>`);
    const srows = slashes.map((s) => `<tr><td>${this.addr(s.member)}</td><td>${this.addr(s.reporter)}</td><td>${psy(s.burned, 2)}</td><td>${psy(s.reward, 2)}</td><td>${blockLink(s.height)}</td></tr>`);
    const body = `<p class="eyebrow">Finality committee</p><h1>Epoch ${esc(ref)}</h1>` +
      kv([['State', e === d.cur ? 'current epoch' : 'past epoch'], ['Members', num(d.rows.length)], ['Checkpoints signed', num(d.cps)], ['Reward pool', psy(d.pool, 2) + ' PSY'],
        ['Settled', Number(d.settled) ? `yes: ${num(d.settled - 1n)} members earned a share` : 'not yet']]) +
      '<h2 class="mt-4">Members</h2>' + table(['Member', 'Seat', 'Checkpoints signed', 'State', 'Reward'], rows, 'No committee in this epoch.') +
      '<h2 class="mt-4">Slashes</h2>' + table(['Member', 'Reporter', 'Burned (PSY)', 'Reporter reward (PSY)', 'Block'], srows, 'No slashes.') +
      `<nav class="pager">${e > 0n ? `<a class="btn btn-line" href="/committee/${e - 1n}">Epoch ${e - 1n}</a>` : ''}${e < d.cur ? `<a class="btn btn-line" href="/committee/${e + 1n}">Epoch ${e + 1n}</a>` : ''}<a class="btn btn-line" href="/committee">Current committee</a></nav>`;
    return this.layout(`Committee epoch ${ref}`, body, '/committee');
  };

  // ------------------------------------------------------------------ developers

  P.developersPage = function () {
    const p = this.p;
    const methods = Object.keys(this.node.rpc?.methods ?? {}).sort();
    const eth = methods.filter((m) => !m.startsWith('psy_')), psyM = methods.filter((m) => m.startsWith('psy_'));
    const ex = (method, params = []) => `curl -s https://rpc.psyrob.com -H 'Content-Type: application/json' \\\n  -d '${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}'`;
    const body = '<p class="eyebrow">Developers</p><h1>RPC, API and P2P.</h1><p class="lead">The public node speaks Ethereum JSON-RPC, a few PSYROB methods, read-only JSON endpoints and P2P over WebSocket. Block numbers in RPC are chain heights of the selected chain.</p>' +
      '<h2 class="mt-4">Network</h2>' + kv([['Network name', TESTNET_WALLET_NAME], ['Chain ID', `${p.chainId} (<code>0x${p.chainId.toString(16)}</code>)`], ['Symbol and decimals', 'PSY, 18'],
        ['RPC', '<code>https://rpc.psyrob.com</code> (POST JSON-RPC; also <code>/rpc</code> on the explorer)'], ['Explorer', '<code>https://explorer.psyrob.com</code>'],
        ['P2P', '<code>wss://rpc.psyrob.com/p2p</code> (WebSocket; a node uses it with <code>--seeds wss://rpc.psyrob.com/p2p</code>)'],
        ['Genesis', `<code>${esc(h0x(this.chain.genesisHash))}</code> (check with <code>npm run genesis:check</code>)`]]) +
      '<h2 class="mt-4">Add to a wallet</h2>' + kv([['chainId', `<code>0x${p.chainId.toString(16)}</code>`], ['chainName', TESTNET_WALLET_NAME], ['nativeCurrency', 'name PSY, symbol PSY, decimals 18'],
        ['rpcUrls', '<code>https://rpc.psyrob.com</code>'], ['blockExplorerUrls', '<code>https://explorer.psyrob.com</code>']]) +
      '<div class="warn">Use a new key for this network. Never reuse a key that was used on any other network.</div>' +
      '<h2 class="mt-4">Contracts</h2><p>The EVM runs the <strong>Shanghai</strong> rules: compile contracts with <code>evmVersion: "shanghai"</code> (no transient storage, no blob opcodes). The system contracts and their ABIs are under <a href="/contracts">Contracts</a> and at <code>/api/abi</code>.</p>' +
      '<h2 class="mt-4">Examples</h2>' + `<pre class="code">${esc(ex('eth_chainId'))}\n\n${esc(ex('eth_getBalance', ['0x0000000000000000000000000000000000000000', 'latest']))}\n\n${esc(ex('psy_dagInfo'))}\n\n${esc(ex('psy_metrics', [8640]))}</pre>` +
      `<h2 class="mt-4">Ethereum methods</h2><p>${eth.map((m) => `<code>${esc(m)}</code>`).join(' ')}</p>` +
      `<h2 class="mt-4">PSYROB methods</h2><p>${psyM.map((m) => `<code>${esc(m)}</code>`).join(' ')}</p>` +
      '<h2 class="mt-4">Read-only JSON</h2>' + table(['Path', 'Content'], [['/health', 'node status: chain ID, genesis, height, tip, peers'], ['/api/summary', 'tip and the latest chain blocks'], ['/api/dag?n=60', 'the newest DAG blocks (at most 500)'],
        ['/api/map', 'data of the home page map'], ['/api/metrics', 'concentration and participation'], ['/api/mining', 'difficulty, attempts per second, intervals, red-block rate'], ['/api/abi', 'system contract ABIs and selectors']]
        .map(([a, b]) => `<tr><td><code>${a}</code></td><td>${b}</td></tr>`), '') +
      '<h2 class="mt-4">Limits</h2>' + kv([['JSON-RPC', '200 calls burst, 50 per second per client; <code>eth_call</code>, <code>eth_estimateGas</code>, <code>eth_getLogs</code> and <code>psy_getBlockTemplate</code> 20 burst, 5 per second'],
        ['Batches', 'at most 100 calls; request body at most 1 MiB'], ['eth_getLogs', 'at most 10,000 blocks and 10,000 logs per call'], ['Pages and /api', '60 requests burst, 10 per second per client'],
        ['State', 'the latest chain block only (no historical state)']]);
    return this.layout('Developers', body, '/developers');
  };

  // ------------------------------------------------------------------ contract read views

  P.contractsPage = function () {
    const rows = Object.entries(this.c).map(([name, x]) => {
      const views = x.abi.filter((f) => f.type === 'function' && (f.stateMutability === 'view' || f.stateMutability === 'pure')).length;
      return `<tr><td><a href="/contract/${esc(name)}">${esc(name)}</a></td><td><code>${esc(h0x(x.addr))}</code></td><td>${num(views)}</td></tr>`;
    });
    const body = '<p class="eyebrow">Contracts</p><h1>Read the system contracts.</h1><p class="lead">The contracts created at genesis, with no owner and no upgrade. Each page calls their read functions with <code>eth_call</code> only: nothing is signed or sent.</p>' +
      table(['Contract', 'Address', 'Read functions'], rows, '');
    return this.layout('Contracts', body, '/contracts');
  };

  P.contractPage = function (name) {
    const x = this.c[name];
    if (!x || !Object.hasOwn(this.c, name)) return null;
    const views = x.abi.filter((f) => f.type === 'function' && (f.stateMutability === 'view' || f.stateMutability === 'pure'));
    const forms = views.map((f) => `<form class="panel read-call" data-contract="${esc(name)}" data-fn="${esc(f.name)}" data-n="${f.inputs.length}"><h3 class="h5"><code>${esc(f.name)}</code></h3>` +
      f.inputs.map((inp, i) => `<label>${esc(inp.name || 'arg' + i)} <span class="muted">${esc(inp.type)}</span><input class="form-control" name="a${i}" data-type="${esc(inp.type)}" autocomplete="off"></label>`).join('') +
      `<button class="btn btn-line mt-2" type="submit">Read</button> <span class="muted">returns ${esc(f.outputs.map((o) => o.type).join(', ') || 'nothing')}</span><pre class="code out" hidden></pre></form>`).join('');
    const body = `<p class="eyebrow">Contract</p><h1>${esc(name)}</h1><p class="lead">Address <code>${esc(h0x(x.addr))}</code>. Read functions, answered by this node at the latest chain block with <code>eth_call</code>.</p>` +
      '<p class="muted">Arguments: addresses and numbers as typed; <code>bytes32</code> as 0x and 64 hex characters (a plain word is converted, for parameter names); lists as JSON, for example <code>["0x…","0x…"]</code>.</p>' +
      (forms || '<p class="muted">No read functions.</p>');
    return this.layout(name, body, '/contracts', { scripts: '<script type="module" src="/pages.js"></script>' });
  };

  // ------------------------------------------------------------------ run a node

  // ------------------------------------------------------------------ registration pages 
  /** The note at the top of both registration pages. */
  const TESTNET_NOTE = '<div class="warn">This is the PSYROB public testnet. Tokens and registrations on this network have no real-world value and will be reset when we launch a new version.</div>';

  /** Short explanations, given before the words are used. */
  const WORDS = '<div class="panel reg-words"><h2 class="h6">What the words on this page mean</h2><dl>' +
    '<dt>Miner address</dt><dd>The wallet address your mining program sends its rewards to.</dd>' +
    '<dt>Blue block</dt><dd>A block that the network counts as valid and in order. Most blocks are blue. Only blue blocks count for registration.</dd>' +
    '<dt>PSY</dt><dd>The coin of this network. On the testnet it has no value.</dd>' +
    '<dt>Network fee</dt><dd>A small amount of PSY paid for every transaction. It is taken from the address that sends it.</dd>' +
    '<dt>Wallet</dt><dd>An app, such as MetaMask, that holds the private key of your address and signs transactions for you.</dd>' +
    '<dt>Transaction</dt><dd>A signed message that changes something on the network, such as a registration.</dd>' +
    '<dt>Vouch</dt><dd>To state, as a registered miner, that you trust an NGO. Five vouches are needed.</dd>' +
    '<dt>Attested</dt><dd>An NGO that five registered miners vouched for, with no open challenge. Only attested NGOs can stand in the election.</dd>' +
    '</dl></div>';

  /** The panel that shows the connected address and sends the registration. */
  const regPanel = (kind) => {
    const ngo = kind === 'ngo';
    const fields = ngo
      ? '<label for="reg-name">Name of the NGO</label><input class="form-control" id="reg-name" maxlength="80" autocomplete="organization" placeholder="For example: Clean Water Foundation" aria-describedby="reg-name-rules">' +
        // name rules (MinerRegistry.validName / nameKey)
        '<p class="muted small mt-1 mb-0" id="reg-name-rules">Use letters, digits, spaces and . , &amp; \' ( ) - only, starting with a letter or digit. Names that differ only in capitals, punctuation or spaces, or in 0 for o and 1 for l, count as the same name. The name is shown as unverified until the NGO’s record is attested.</p>' +
        '<label for="reg-description" class="mt-2">Short description (optional, but recommended)</label><textarea class="form-control" id="reg-description" maxlength="280" rows="3" placeholder="What does the NGO do? One or two sentences."></textarea>'
      : '';
    return `<form id="reg-form" class="panel reg-panel"><div id="reg" data-kind="${kind}">` +
      '<button class="btn btn-line" id="reg-connect" type="button">Connect wallet</button>' +
      '<dl class="reg-state"><dt>Address</dt><dd data-f="address">not connected</dd><dt>Blue blocks mined</dt><dd data-f="mined">–</dd>' +
      '<dt>Balance</dt><dd data-f="balance">–</dd>' + (ngo ? '<dt>NGO name</dt><dd data-f="name">–</dd>' : '') + '<dt>Status</dt><dd data-f="status">–</dd></dl>' +
      fields + `<button class="btn btn-cyan mt-3" id="reg-submit" type="submit">${ngo ? 'Register NGO miner' : 'Register miner'}</button>` +
      '<div id="reg-out" class="reg-out" role="status" aria-live="polite"></div></div></form>';
  };

  const REG_STYLE = '<style>.reg-panel dl.reg-state{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:14px 0}' +
    '.reg-panel dt{color:var(--mute);font-weight:400}.reg-panel dd{margin:0;word-break:break-all}.reg-out{margin-top:12px}.reg-out.bad,.bad{color:#ff9b8a}' +
    '.reg-out.good,.good{color:var(--cyan)}.reg-words dl{margin:0}.reg-words dt{margin-top:8px}.reg-words dd{margin:0;color:var(--mute)}' +
    '.reg-faq dt{margin-top:14px}.reg-faq dd{margin:0}@media (max-width:576px){.reg-panel dl.reg-state{grid-template-columns:1fr}.reg-panel dt{margin-top:6px}}</style>';

  P.registerMinerPage = async function () {
    const q = await this.reads(async (read) => ({ min: await read('Params', 'get', [pkey('vouchMinBlocks')]), weeks: await read('Params', 'get', [pkey('vouchMinEpochs')]), bond: await read('Params', 'get', [pkey('vouchBond')]) })).catch(() => ({}));
    const body = TESTNET_NOTE + '<p class="eyebrow">Registration</p><h1>Register your miner</h1>' +
      '<p class="lead">If you have been mining on the PSYROB testnet and want to help NGOs get verified, you need to register your miner address first. Registration is free and only takes a few minutes. Once you are registered you can vouch for NGOs that you trust.</p>' +
      WORDS +
      '<h2 class="h4 mt-4">What you need before you start</h2><ul>' +
      '<li>A miner address that has already mined at least one blue block.</li>' +
      '<li>A small amount of PSY in that address to pay the network fee (usually less than 0.01 PSY).</li>' +
      '<li>A wallet or tool that can send a transaction from that address.</li></ul>' +
      '<h2 class="h4 mt-4">Steps</h2><ol class="steps">' +
      '<li>Connect the wallet that controls your miner address.</li>' +
      '<li>Check that the page shows your address and that it has mined blue blocks.</li>' +
      '<li>Click “Register miner”.</li>' +
      '<li>Confirm the transaction in your wallet.</li>' +
      '<li>Wait for the transaction to be included in a block. The page will update and show “Registered” next to your address.</li></ol>' +
      regPanel('miner') +
      '<h2 class="h4 mt-4">After you register</h2><p>You can now go to the <a href="/attestation">Attestation page</a> and vouch for an NGO. You may vouch for up to 10 NGOs. Each NGO needs 5 different registered miners to become attested.</p>' +
      `<p class="muted small">To vouch, your address also needs at least ${num(q.min ?? 100n)} blue blocks, mined in at least ${num(q.weeks ?? 4n)} different weeks, and you lock ${psy(q.bond ?? 0n)} PSY for each NGO you vouch for. You get it back one year later, unless a challenge against that NGO is upheld.</p>` +
      '<h2 class="h4 mt-4">Common questions</h2><dl class="reg-faq">' +
      '<dt>I mined blocks but the page says I have not mined.</dt><dd>Wait a few minutes and refresh. Blue blocks can take a short time to appear.</dd>' +
      '<dt>The transaction failed.</dt><dd>Make sure you have a little PSY for the fee and that you are using the correct address.</dd>' +
      '<dt>Can I unregister?</dt><dd>No. Registration is permanent on this testnet.</dd></dl>' +
      '<p class="muted small mt-4">Running an NGO? Use <a href="/register/ngo">Register a miner for your NGO</a> instead.</p>';
    return this.layout('Register your miner', body, '/register/miner', { head: REG_STYLE, scripts: '<script type="module" src="/register.js"></script>' });
  };

  P.registerNgoPage = function () {
    const body = TESTNET_NOTE + '<p class="eyebrow">Registration</p><h1>Register a miner for your NGO</h1>' +
      '<p class="lead">NGOs that want to take part in the testnet need a registered miner address. This address will be used when the NGO stands for election and when it participates in finality. You can register one miner address for your organisation.</p>' +
      WORDS +
      '<h2 class="h4 mt-4">What you need before you start</h2><ul>' +
      '<li>The wallet that will act as the NGO’s miner.</li>' +
      '<li>That address must have already mined at least one blue block.</li>' +
      '<li>A small amount of PSY in the address for the network fee.</li>' +
      '<li>You should be the person authorised to act for the NGO.</li></ul>' +
      '<h2 class="h4 mt-4">Steps</h2><ol class="steps">' +
      '<li>Connect the wallet that controls the NGO’s miner address.</li>' +
      '<li>Enter the name of the NGO and a short description (optional but recommended).</li>' +
      '<li>Check that the page shows the address and that it has mined blue blocks.</li>' +
      '<li>Click “Register NGO miner”.</li>' +
      '<li>Confirm the transaction in your wallet.</li>' +
      '<li>Wait for the transaction to confirm. The page will show the NGO name and “Registered”.</li></ol>' +
      regPanel('ngo') +
      '<h2 class="h4 mt-4">After you register</h2><p>Other registered community miners can now vouch for your NGO. Once five different miners have vouched, the NGO becomes attested and can stand in the election.</p>' +
      '<p class="muted small">Before miners can vouch, the NGO also publishes its details (country, registration number and a dossier) on the <a href="/ngo-submit">Submit and mint</a> page, from the same address.</p>' +
      '<h2 class="h4 mt-4">Common questions</h2><dl class="reg-faq">' +
      '<dt>Can one NGO have more than one miner address?</dt><dd>No. One miner address per NGO on this testnet.</dd>' +
      '<dt>What if we change the person who manages the wallet?</dt><dd>You will need to use the same address. Make sure the NGO keeps control of the private key.</dd>' +
      '<dt>Do we need to register before or after we start mining?</dt><dd>You must mine at least one blue block before you can register.</dd></dl>';
    return this.layout('Register a miner for your NGO', body, '/register/ngo', { head: REG_STYLE, scripts: '<script type="module" src="/register.js"></script>' });
  };

  P.runNodeTabsPage = function () {
    const g = h0x(this.chain.genesisHash);
    const m = this.downloads?.manifest() ?? null;
    const file = (os, program, ext) => m?.files.find((f) => f.os === os && f.program === program && f.name.endsWith(ext)) ?? null;
    const mb = (b) => (b / 1e6).toLocaleString('en-US', { maximumFractionDigits: 1 }) + ' MB';
    const link = (f, label) => (f ? `<a class="btn btn-cyan" href="/downloads/${esc(f.name)}" download>${esc(label)}</a> <span class="muted small">${mb(f.bytes)}</span>` : '<span class="muted">not available on this node</span>');
    const wMiner = file('Windows', 'miner', '.exe'), wNode = file('Windows', 'node', '.zip');
    const dMiner = file('Linux', 'miner', '.deb'), lMiner = file('Linux', 'miner', '.tar.gz'), lNode = file('Linux', 'node', '.tar.gz');
    const cards = m
      ? '<div class="dl-grid">' +
        `<div class="panel dl"><h3>Miner for Windows</h3><p class="muted">Double-click to start; the control page opens in your browser.</p>${link(wMiner, 'Download .exe')}</div>` +
        `<div class="panel dl"><h3>Miner for Ubuntu</h3><p class="muted">Installs “PSYROB Miner” in your applications.</p>${link(dMiner, 'Download .deb')}<p class="small mt-2">Other Linux: ${lMiner ? `<a href="/downloads/${esc(lMiner.name)}" download>.tar.gz</a> (${mb(lMiner.bytes)})` : '–'}</p></div>` +
        `<div class="panel dl"><h3>Node for Windows</h3><p class="muted">Your own full node, explorer and RPC.</p>${link(wNode, 'Download .zip')}</div>` +
        `<div class="panel dl"><h3>Node for Linux</h3><p class="muted">Runs on any 64-bit Linux (x64).</p>${link(lNode, 'Download .tar.gz')}</div>` +
        '</div>' +
        `<p class="muted small">Version ${esc(m.version)} for 64-bit (x64) computers, built ${esc(String(m.built).slice(0, 10))}. Nothing else to install: each program includes its runtime. ` +
        'Check a download against <a href="/downloads/SHA256SUMS.txt">SHA256SUMS.txt</a>: on Windows <code>Get-FileHash .\\file</code> in PowerShell, on Linux <code>sha256sum file</code>.</p>'
      : '<div class="panel"><p class="mb-0">The downloads are offered on <a href="https://explorer.psyrob.com/run-a-node">explorer.psyrob.com/run-a-node</a>.</p></div>';
    const winName = wMiner ? esc(wMiner.name) : 'psyrob-miner-…-windows-x64.exe';
    const debName = dMiner ? esc(dMiner.name) : 'psyrob-miner_…_amd64.deb';
    const win = '<h3 class="h5">Mine (PSYROB Miner)</h3><ol class="steps">' +
      `<li>Download <code>${winName}</code> above and double-click it.</li>` +
      '<li>If Windows shows “Windows protected your PC”: click <strong>More info</strong>, then <strong>Run anyway</strong>. The program is not signed with a paid certificate yet; compare its checksum first if you like.</li>' +
      '<li>A black window opens (keep it open) and your browser shows the miner’s control page. It is reachable only from this computer.</li>' +
      '<li>Press <strong>Create a new wallet</strong> (or import a key you already use on this network), then <strong>Back up the key</strong> and write it on paper. A lost key cannot be recovered.</li>' +
      '<li>Choose the threads (each uses one CPU core and 32 MiB) and press <strong>Start mining</strong>. The rewards go to the wallet shown on the page.</li>' +
      '<li>To stop: press <strong>Quit</strong> on the page or close the black window. Your wallet stays in <code>%APPDATA%\\PSYROB Miner</code>.</li></ol>' +
      '<h3 class="h5 mt-3">Run a node</h3><ol class="steps">' +
      `<li>Download the node <code>.zip</code> above, right-click it, choose <strong>Extract All</strong>.</li>` +
      '<li>In the extracted folder, double-click <code>Start-PSYROB-node.bat</code> and keep the window open. The node follows the public network over <code>wss://rpc.psyrob.com/p2p</code>; no port forwarding is needed.</li>' +
      `<li>Open <code>http://127.0.0.1:8770/health</code>: the genesis must be <code>${esc(g)}</code>. Your own explorer is at <code>http://127.0.0.1:8770</code>.</li>` +
      '<li>Mine through your own node: in the miner’s Settings, set the node to <code>http://127.0.0.1:8770</code>.</li></ol>' +
      '<p class="muted">If Windows asks about the firewall, you can click Cancel: the node and the miner page listen only on this computer.</p>';
    const lin = '<h3 class="h5">Mine (PSYROB Miner)</h3><ol class="steps">' +
      `<li>Ubuntu: download <code>${debName}</code> above and install it, either by double-clicking it (App Center) or in a terminal:<pre class="code">sudo apt install ./${debName}</pre></li>` +
      '<li>Open <strong>PSYROB Miner</strong> from your applications (or type <code>psyrob-miner</code> in a terminal). Your browser shows the miner’s control page, reachable only from this computer.</li>' +
      '<li>Press <strong>Create a new wallet</strong> (or import one), then <strong>Back up the key</strong> on paper. A lost key cannot be recovered.</li>' +
      '<li>Choose the threads and press <strong>Start mining</strong>. Quit on the page to stop. Your wallet stays in <code>~/.local/share/psyrob-miner</code>.</li>' +
      `<li>Other Linux: unpack the miner <code>.tar.gz</code> and run <code>./psyrob-miner</code> in its folder. On a server without a browser: <code>./psyrob-miner --no-browser</code>, then open the printed address through an SSH tunnel.</li></ol>` +
      '<h3 class="h5 mt-3">Run a node</h3><ol class="steps">' +
      `<li>Download and unpack the node:<pre class="code">tar -xzf ${lNode ? esc(lNode.name) : 'psyrob-node-…-linux-x64.tar.gz'}\ncd ${lNode ? esc(lNode.name.replace(/\.tar\.gz$/, '')) : 'psyrob-node-…-linux-x64'}\n./psyrob-node</pre></li>` +
      `<li>Open <code>http://127.0.0.1:8770/health</code>: the genesis must be <code>${esc(g)}</code>. Your own explorer is at <code>http://127.0.0.1:8770</code>; data is kept in <code>~/.psyrob</code>.</li>` +
      '<li>To accept peers, open the P2P port 39870 in your firewall; with <code>--no-listen</code> the node only connects out. All options: <code>./psyrob-node --help</code>.</li>' +
      '<li>Mine through your own node: in the miner’s Settings, set the node to <code>http://127.0.0.1:8770</code>.</li></ol>';
    const body = '<p class="eyebrow">Run a node</p><h1>Anyone can join.</h1><p class="lead">Download the miner to earn PSY with your computer, or the full node, which checks every block and transaction itself, keeps the whole block DAG and serves your own explorer and JSON-RPC. Anyone may run both.</p>' +
      cards +
      '<p class="muted small">Every node checks every block against the rules itself, so a changed copy of a program cannot change the network for anyone else. Download only from this page and check the checksum.</p>' +
      '<div class="tabs" role="tablist"><button class="btn btn-line" type="button" role="tab" id="tab-win" aria-controls="pane-win" aria-selected="true">Windows</button><button class="btn btn-line" type="button" role="tab" id="tab-lin" aria-controls="pane-lin" aria-selected="false">Ubuntu and Linux</button></div>' +
      `<section class="panel" role="tabpanel" id="pane-win" aria-labelledby="tab-win"><h2 class="h4">Windows 10 and 11 (64-bit)</h2>${win}</section><section class="panel" role="tabpanel" id="pane-lin" aria-labelledby="tab-lin"><h2 class="h4">Ubuntu and Linux (64-bit)</h2>${lin}</section>` +
      `<p class="muted">Expected genesis hash: <code>${esc(g)}</code></p>` +
      '<h2 class="h4 mt-4">Reading your node’s log</h2><ul>' +
      '<li><code>p2p: connecting to wss://rpc.psyrob.com/p2p</code>, then <code>p2p: connected to … (psyrob/10.0.0, blue score …)</code>: your node reached the public node and is syncing. Check progress at <code>http://127.0.0.1:8770/health</code> (<code>chainHeight</code>).</li>' +
      '<li><code>p2p: no handshake with … retrying in … s</code>: the public node could not be reached or refused your address. A refusal (a ban after a node misbehaves) lasts one hour; the node retries by itself, waiting longer each time, up to 5 minutes. Leave it running, and report it if it lasts more than an hour.</li>' +
      '<li><code>the stored blocks belong to another genesis</code>: your data folder held blocks of another network. The node moved it to an <code>old-network-…</code> folder and starts again from the new genesis. You can delete that folder.</li></ul>';
    return this.layout('Run a node', body, '/run-a-node', { scripts: '<script type="module" src="/pages.js"></script>' });
  };

  // ------------------------------------------------------------------ front page figures

  /**
   * The radar on the front page: eight network figures, each a ratio from 0 to 1 (plotted on a square-root scale, so
   * small values stay visible). Cached per tip.
   */
  P.radarData = async function () {
    const c = this.chain;
    if (this.radarCache?.tip === c.tip.hash) return this.radarCache.value;
    const m = this.miningData();
    const met = chainMetrics(c);
    const g = await this.govFigures();
    const s = c.supply();
    const issued = s.issuedMining + s.issuedNGO;
    const clamp = (x) => Math.max(0, Math.min(1, Number.isFinite(x) ? x : 0));
    const value = [
      { axis: 'PACE', value: clamp(m.secondsPerChainBlock ? m.targetSpacing / m.secondsPerChainBlock : 0), text: m.secondsPerChainBlock ? `${m.secondsPerChainBlock.toFixed(1)} s per chain block (target ${m.targetSpacing} s)` : 'no blocks yet' },
      { axis: 'BLUE', value: clamp(m.blueBlocks + m.redBlocks ? 1 - m.redRate : 0), text: m.blueBlocks + m.redBlocks ? `${((1 - m.redRate) * 100).toFixed(1)} % of recent blocks blue` : 'no blocks yet' },
      { axis: 'MINERS', value: clamp(met.mining.holders ? 1 - met.mining.hhi : 0), text: `${met.mining.holders} miner addresses, HHI ${met.mining.hhi}` },
      { axis: 'GAS', value: clamp(m.gasUse), text: `${(m.gasUse * 100).toFixed(2)} % of block gas used` },
      { axis: 'BURN', value: clamp(issued > 0n ? Number((s.burned * 10_000n) / issued) / 10_000 : 0), text: `${psy(s.burned, 2)} PSY burned of ${psy(issued, 0)} issued` },
      { axis: 'LOCKED', value: clamp(g.lockedShareOfCirculating / 100), text: `${g.lockedShareOfCirculating} % of circulating PSY locked for voting` },
      { axis: 'NGOS', value: clamp(g.ngos.elected / 100), text: `${g.ngos.elected} of 100 NGO seats filled` },
      { axis: 'FINALITY', value: clamp(g.committee.signingRate ?? 0), text: g.committee.signingRate === null ? 'no committee yet' : `${(g.committee.signingRate * 100).toFixed(1)} % of checkpoint signatures given` },
    ];
    this.radarCache = { tip: c.tip.hash, value };
    return value;
  };

  // ------------------------------------------------------------------ rewards (credits made outside transactions)
  // Block rewards, the committee and NGO pool shares and priority fees are credited by the node when a chain block
  // accepts its mergeset (DAG_SPEC.md sections 5 and 7). They are not transactions: no sender, signature, nonce or
  // hash, and the RPC does not know them. So they are listed here, on the block, address and NGO pages, and not on
  // the transactions page.

  /** A merged block: "#height" if it is a chain block, its short hash otherwise. */
  const dagLink = (c, xh) => {
    const x = c.dag.get(xh);
    return x && c.chain[x.chainHeight] === xh ? blockLink(x.chainHeight) : `<a href="/block/0x${xh}"><code>${esc(short('0x' + xh))}</code></a>`;
  };

  /** The credits chain block `e` made when it accepted its mergeset: [{ kind, to (hex), amount, block (merged block) }]. */
  P.rewardRows = function (e) {
    const c = this.chain, out = [];
    if (!e?.paid) return out;
    const fc = bytesToHex(ADDR.finalityCommittee), pool = bytesToHex(ADDR.ngoRewards);
    (e.mergesetBlues ?? []).forEach((xh, i) => {
      const m = e.paid.sub[i] ?? 0n, n = e.paid.ngo[i] ?? 0n;
      const share = m * this.p.committeeShareBps / 10_000n;
      if (m - share > 0n) out.push({ kind: 'Block reward', to: bytesToHex(c.dag.get(xh).header.miner), amount: m - share, block: xh });
      if (share > 0n) out.push({ kind: 'Committee share', to: fc, amount: share, block: xh });
      if (n > 0n) out.push({ kind: 'NGO pool share', to: pool, amount: n, block: xh });
    });
    for (const [xh, to, amount] of e.paid.fees ?? []) out.push({ kind: 'Priority fees', to, amount, block: xh });
    return out;
  };

  /** The chain block that merged `e` (blue: it paid e's reward; red: no reward), within 200 chain blocks; null if none yet. */
  P.mergedBy = function (e) {
    const c = this.chain;
    for (let h = Math.max(1, e.chainHeight); h <= Math.min(c.tip.chainHeight, e.chainHeight + 200); h++) {
      const cb = c.dag.get(c.chain[h]);
      if (cb.mergesetBlues?.includes(e.hash)) return { cb, blue: true };
      if (cb.mergesetReds?.includes(e.hash)) return { cb, blue: false };
    }
    return null;
  };

  const rewardTable = (self, rows, { paidAt = false } = {}) => table(
    [...(paidAt ? ['Paid by chain block'] : []), 'For block', 'Recipient', 'Kind', 'Amount'],
    rows.map((r) => `<tr>${paidAt ? `<td>${blockLink(r.height)}<div class="muted">${esc(when(r.ts))}</div></td>` : ''}<td>${dagLink(self.chain, r.block)}</td><td>${self.addr(r.to)}</td><td>${esc(r.kind)}</td><td>${psy(r.amount)} PSY</td></tr>`),
    'None.');

  /** The rewards section of /block/:ref. */
  P.blockRewards = function (e) {
    const c = this.chain;
    if (e === c.dag.genesis) return '';
    const onChain = c.chain[e.chainHeight] === e.hash;
    const by = this.mergedBy(e);
    const own = by ? (by.blue ? `paid by chain block ${blockLink(by.cb.chainHeight)}, which merged it as a blue block` : `none: chain block ${blockLink(by.cb.chainHeight)} merged it as a red block (its transactions' priority fees went to that block's miner)`)
      : 'not paid yet: no chain block has merged this block';
    const rows = onChain ? this.rewardRows(e) : [];
    const total = rows.reduce((t, r) => t + r.amount, 0n);
    return `<h2 class="mt-4">Rewards</h2><p class="muted">Credited by the node, not sent as transactions. A block's reward is paid by the chain block that merges it, so each chain block pays for its selected parent and the other blue blocks it merges.</p>` +
      kv([['This block\'s own reward', own], ...(onChain ? [['Paid when this chain block was accepted', `${psy(total)} PSY in ${num(rows.length)} credits`]] : [])]) +
      (onChain ? rewardTable(this, rows) : '');
  };

  /** Rewards credited to address `a` (hex, lowercase, with 0x) in the last `maxBlocks` chain blocks; newest first. */
  P.addressRewards = function (a, maxBlocks = 5000, max = PER) {
    const c = this.chain, k = a.slice(2), rows = [];
    let total = 0n, count = 0, h = c.tip.chainHeight;
    for (; h > 0 && c.tip.chainHeight - h < maxBlocks; h--) {
      const cb = c.dag.get(c.chain[h]);
      for (const r of this.rewardRows(cb)) {
        if (r.to !== k) continue;
        total += r.amount;
        count++;
        if (rows.length < max) rows.push({ ...r, height: h, ts: cb.header.timestamp });
      }
    }
    if (!count) return '';
    return `<h2 class="mt-4">Recent rewards</h2><p class="muted">${num(count)} credits, ${psy(total)} PSY, in the last ${num(c.tip.chainHeight - h)} chain blocks. Block rewards, pool shares and priority fees are credited by the node, not sent as transactions, so they are not in the list above.</p>` +
      rewardTable(this, rows, { paidAt: true });
  };

  /** NGO pool income and payouts, for /ngos. `ngo` (hex with 0x) limits the claims to one NGO, for /ngo/:addr. */
  P.ngoPoolSection = async function (ngo = null) {
    const c = this.chain, ix = this.events();
    const claims = (ngo ? (ix.ngos.get(ngo.toLowerCase())?.claims ?? []) : ix.claims).slice(-PER).reverse();
    const crows = claims.map((x) => `<tr><td>${blockLink(x.height)}</td><td>${x.tx ? `<a href="/tx/${esc(x.tx)}">${esc(short(x.tx))}</a>` : '–'}</td>${ngo ? '' : `<td><a href="/ngo/${esc(x.ngo)}">${esc(short(x.ngo))}</a></td>`}<td>${num(x.term)}</td><td>${psy(x.amount)} PSY</td></tr>`);
    const head = ['Chain block', 'Transaction', ...(ngo ? [] : ['NGO']), 'Term', 'Paid out'];
    if (ngo) {
      const forfeits = ix.ngos.get(ngo.toLowerCase())?.forfeits ?? [];
      return '<h2 class="mt-4">NGO pool payouts</h2><p class="muted">Each claim is a transaction to the NGO pool contract; the PSY moves inside that call, so the transaction itself shows a value of 0.</p>' +
        table(head, crows, 'No claims yet.') + (forfeits.length ? kv(forfeits.map((f) => ['Forfeited', `${psy(f.amount)} PSY of term ${num(f.term)} at ${blockLink(f.height)} (back to the pool)`])) : '');
    }
    const d = await this.reads(async (read, view) => ({ bal: view.getAccount(ADDR.ngoRewards).balance, und: await read('NGORewards', 'undistributed') ?? 0n,
      notified: await read('NGORewards', 'totalNotified') ?? 0n, claimed: await read('NGORewards', 'totalClaimed') ?? 0n }));
    const income = [];
    for (let h = c.tip.chainHeight; h > 0 && income.length < 10; h--) {
      const cb = c.dag.get(c.chain[h]);
      const amt = this.rewardRows(cb).filter((r) => r.kind === 'NGO pool share').reduce((t, r) => t + r.amount, 0n);
      if (amt > 0n) income.push(`<tr><td>${blockLink(h)}<div class="muted">${esc(when(cb.header.timestamp))}</div></td><td>${num(cb.mergesetBlues.length)}</td><td>${psy(amt)} PSY</td></tr>`);
    }
    return `<h2 class="mt-4">NGO pool</h2><p class="muted">36 % of all PSY: each blue block adds the NGO share to the pool contract ${this.addr(h0x(ADDR.ngoRewards))}, credited by the node (not a transaction). It is shared equally by the NGOs elected in the current term; while none is elected it waits in the pool. Each elected NGO claims its part with its own wallet.</p>` +
      kv([['In the pool contract', psy(d.bal) + ' PSY'], ['Received so far', psy(d.notified) + ' PSY'], ['Paid out to NGOs', psy(d.claimed) + ' PSY'], ['Waiting for elected NGOs', psy(d.und) + ' PSY']]) +
      '<h3 class="h5 mt-3">Latest income</h3>' + table(['Chain block', 'Blue blocks merged', 'Added to the pool'], income, 'None yet.') +
      '<h3 class="h5 mt-3">Latest payouts</h3>' + table(head, crows, 'No NGO has claimed yet.');
  };

  /** PSY moved inside a transaction by the NGO pool (Claimed events in its receipt), for /tx/:hash. */
  P.internalTransfers = function (receipt) {
    const spec = [...this.events().specs.entries()].find(([, x]) => x.contract === 'NGORewards' && x.name === 'Claimed');
    if (!receipt || !spec) return '';
    const [topic, info] = spec;
    const rows = [];
    for (const l of receipt.logs ?? []) {
      if (String(l.address).toLowerCase() !== '0x' + info.address || String(l.topics?.[0]).toLowerCase() !== '0x' + topic) continue;
      const to = '0x' + String(l.topics[2]).slice(-40);
      const [amount] = decodeParams([{ type: 'uint256' }], Uint8Array.from(Buffer.from(String(l.data).slice(2), 'hex')));
      rows.push(`<tr><td>${this.addr(h0x(ADDR.ngoRewards))}</td><td>${this.addr(to)}</td><td>${psy(amount)} PSY</td><td>NGO pool payout, term ${num(BigInt(l.topics[1]))}</td></tr>`);
    }
    return rows.length ? '<h2 class="mt-4">PSY moved inside this transaction</h2>' + table(['From', 'To', 'Amount', 'What'], rows, '') : '';
  };
}
