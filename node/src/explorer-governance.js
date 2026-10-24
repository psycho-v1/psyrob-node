// Governance explorer pages (DAG_SPEC.md section 17): the dev council and the upgrade path (/upgrades) and the
// emergency pause (/pause), plus the pause banner every page shows while something is paused. Forms use the visitor's
// browser wallet (app.js); the node only reads.

import { ADDR, NODE_VERSION, versionText, DEV_ACCOUNTS } from './params.js';
import { bytesToHex } from '../../common/bytes.js';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ACTION_KIND = ['Approve update', 'Cancel update', 'Change parameter', 'Pause', 'End pause', 'Cancel action'];
const ACTION_STATE = ['waiting for a second key', 'in timelock', 'done', 'cancelled'];
const PLAN_STATE = ['submitted', 'approved, in timelock', 'in force', 'cancelled', 'failed (code changed)'];
const BY = ['', 'dev council', 'finality committee', 'DAO vote'];
const PER = 25;

export function installV8Pages(Explorer, H) {
  const { esc, num, when, badge, short } = H;
  const P = Explorer.prototype;
  const table = (head, rows, empty) => `<div class="table-responsive"><table><thead><tr>${head.map((x) => `<th>${x}</th>`).join('')}</tr></thead><tbody>` +
    (rows.length ? rows.join('') : `<tr><td colspan="${head.length}">${empty}</td></tr>`) + '</tbody></table></div>';
  const kv = (rows) => `<div class="table-responsive"><table>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</table></div>`;
  const ZERO = '0x0000000000000000000000000000000000000000';
  const PAUSABLE = [['Whole network', ZERO], ['MinerRegistry', ADDR.minerRegistry], ['NGORegistry', ADDR.ngoRegistry], ['Attestation', ADDR.attestation],
    ['VoteEscrow', ADDR.voteEscrow], ['NGOElection', ADDR.ngoElection], ['RoleElection', ADDR.roleElection], ['Treasury', ADDR.treasury],
    ['NGORewards', ADDR.ngoRewards], ['FinalityCommittee', ADDR.finalityCommittee], ['FundApprovals', ADDR.fundApprovals]]
    .map(([n, a]) => [n, typeof a === 'string' ? a : '0x' + bytesToHex(a)]);
  const targetName = (a) => PAUSABLE.find(([, x]) => x === String(a).toLowerCase())?.[0] ?? short(a);
  const ago = (t, now) => { const d = Number(t) - now; const h = Math.round(Math.abs(d) / 3600); return d > 0 ? `in ${h < 48 ? h + ' h' : Math.round(h / 24) + ' days'}` : 'reached'; };

  /** Council, registry and pause state at the tip, cached per tip. */
  P.v8State = async function () {
    const c = this.chain;
    if (this.v8Cache?.tip === c.tip.hash) return this.v8Cache.value;
    const value = await this.reads(async (read) => {
      const keys = await read('DevCouncil', 'keys');
      const nActions = Number(await read('DevCouncil', 'actionCount') ?? 0n);
      const actions = [];
      for (let i = nActions - 1; i >= Math.max(0, nActions - PER); i--) actions.push({ id: i, a: await read('DevCouncil', 'getAction', [BigInt(i)]) });
      const nPlans = Number(await read('UpgradeRegistry', 'planCount') ?? 0n);
      // approved plans waiting for their timelock are always listed (anyone can submit, so the newest submissions
      // could otherwise push them off the page), then the newest submissions
      const w = await read('UpgradeRegistry', 'waiting');
      const ids = [...new Set([...(w?.[0] ?? []), ...(w?.[1] ?? [])].map(Number))].sort((a, b) => b - a);
      for (let i = nPlans - 1; i >= Math.max(0, nPlans - PER); i--) if (!ids.includes(i)) ids.push(i);
      const plans = [];
      for (const i of ids) {
        const p = await read('UpgradeRegistry', 'getPlan', [BigInt(i)]);
        if (p) plans.push({ id: i, p: { ...p, eta: await read('UpgradeRegistry', 'effectiveEta', [BigInt(i)]) ?? p.eta } });
      }
      const pauses = [];
      for (const [name, addr] of PAUSABLE) {
        const x = await read('EmergencyPause', 'pauses', [addr]);
        if (x) pauses.push({ name, addr, by: Number(x[0]), at: Number(x[1]), until: Number(x[2]), reason: x[3] });
      }
      const nHist = Number(await read('EmergencyPause', 'historyCount') ?? 0n);
      const history = [];
      for (let i = nHist - 1; i >= Math.max(0, nHist - PER); i--) history.push(await read('EmergencyPause', 'history', [BigInt(i)]));
      const nReq = Number(await read('EmergencyPause', 'requestCount') ?? 0n);
      const requests = [];
      for (let i = nReq - 1; i >= Math.max(0, nReq - 10); i--) requests.push({ id: i, r: await read('EmergencyPause', 'request', [BigInt(i)]) });
      return {
        retired: Boolean(await read('DevCouncil', 'retired')), retiredAt: Number(await read('DevCouncil', 'retiredAt') ?? 0n), keys, actions, nActions,
        plans, nPlans, required: Number(await read('UpgradeRegistry', 'requiredVersion') ?? 0n), pauses, history, nHist, requests,
        lastCouncilPause: Number(await read('EmergencyPause', 'lastCouncilPauseAfterHandover') ?? 0n), lockout: Number(await read('EmergencyPause', 'councilLockoutUntil') ?? 0n),
        elected: Number(await read('NGOElection', 'electedCount') ?? 0n),
      };
    });
    this.v8Cache = { tip: c.tip.hash, value };
    return value;
  };

  /** Pauses running now (refreshed with the mode before each page). */
  P.refreshPause = async function () {
    if (this.pauseNow?.tip === this.chain.tip.hash) return;
    const now = Number(this.chain.tip.header.timestamp); // block time, as the contracts judge a pause
    const list = await this.reads(async (read) => {
      const out = [];
      for (const [name, addr] of PAUSABLE) {
        const x = await read('EmergencyPause', 'pauses', [addr]);
        if (x && Number(x[2]) > now) out.push({ name, until: Number(x[2]), by: Number(x[0]), reason: x[3] });
      }
      return out;
    }).catch(() => []);
    this.pauseNow = { tip: this.chain.tip.hash, list };
  };

  P.pauseBanner = function () {
    const list = this.pauseNow?.list ?? [];
    if (!list.length) return '';
    const items = list.map((x) => `<strong>${esc(x.name)}</strong> paused by the ${esc(BY[x.by] ?? '?')} until ${esc(when(x.until))} (reason <code>${esc(short(x.reason))}</code>)`).join('; ');
    const net = list.some((x) => x.name === 'Whole network');
    return `<div class="pz-banner" role="alert"><div class="container">${items}. ${net ? 'Transfers and ordinary transactions wait until the pause ends; mining, votes, upgrades and DevVesting releases continue. ' : ''}<a href="/pause">Details</a></div></div>`;
  };

  // ------------------------------------------------------------------ /upgrades

  P.upgradesPage = async function () {
    const d = await this.v8State();
    const now = Number(this.chain.tip.header.timestamp); // block time, as the contracts judge a pause
    const [accounts, current, pending, etas] = d.keys ?? [[], [], [], []];
    const seats = DEV_ACCOUNTS.map((x, i) => `<tr><td>${esc(x.label)}</td><td>${this.addr(accounts[i] ?? ZERO)}</td><td>${current[i] && current[i] !== ZERO ? `<code>${esc(current[i])}</code>` : '<span class="muted">none</span>'}</td>` +
      `<td>${pending[i] && pending[i] !== ZERO ? `<code>${esc(short(pending[i]))}</code> from ${esc(when(etas[i]))}` : '–'}</td></tr>`);
    const acts = d.actions.map(({ id, a }) => {
      const k = Number(a.kind), approvals = [0, 1, 2].filter((s) => Number(a.approvals) & (1 << s)).map((s) => s + 1).join(', ');
      const what = k === 2 ? `<code>${esc(Buffer.from(String(a.key).slice(2), 'hex').toString().replace(/\0+$/, ''))}</code> = ${esc(String(a.arg))}`
        : k <= 1 ? `plan ${esc(String(a.arg))}` : k === 5 ? `action ${esc(String(a.arg))}` : esc(targetName(a.target));
      return `<tr><td>${id}</td><td>${esc(ACTION_KIND[k] ?? '?')}</td><td>${what}</td><td>seats ${approvals}</td><td>${esc(ACTION_STATE[Number(a.state)] ?? '?')}${Number(a.state) === 1 ? `<div class="muted">executable ${esc(when(a.eta))}</div>` : ''}</td></tr>`;
    });
    // the SHA-256 of the SHA256SUMS.txt this node serves, to compare with node update plans
    const ownRelease = (() => { try { const dir = this.downloads?.dir; return dir ? '0x' + createHash('sha256').update(fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'))).digest('hex') : null; } catch { return null; } })();
    const plans = d.plans.map(({ id, p }) => {
      const st = Number(p.state);
      const what = Number(p.kind) === 0
        ? `replace <b>${esc(this.labels.get(String(p.target).slice(2).toLowerCase()) ?? short(p.target))}</b> with the code at ${this.addr(p.impl)}<div class="muted">code hash <code>${esc(short(p.codeHash))}</code></div>`
        : `node <b>${esc(versionText(Number(p.version)))}</b><div class="muted">SHA256SUMS.txt <code>${esc(short(p.releaseHash))}</code>${ownRelease ? (ownRelease === String(p.releaseHash).toLowerCase() ? ' · matches this node\'s downloads' : ' · not the downloads this node serves') : ''}</div>`;
      return `<tr><td>${id}</td><td>${what}<div class="muted">commit <code>${esc(String(p.commit).slice(0, 12))}</code> · submitted by ${this.addr(p.submitter)}</div></td>` +
        `<td>${esc(PLAN_STATE[st] ?? '?')}${st === 1 ? `<div class="muted">takes effect ${esc(when(p.eta))} (${esc(ago(p.eta, now))})</div>` : ''}${st === 2 ? `<div class="muted">${esc(when(p.activatedAt))}</div>` : ''}</td>` +
        `<td>${st >= 1 && st !== 3 ? esc(p.byDao ? 'DAO vote' : 'dev council') : '–'}</td></tr>`;
    });
    const behind = d.required > 0 && d.required > versionNumberOf(NODE_VERSION);
    const status = d.retired
      ? `${badge('retired', false)} since ${esc(when(d.retiredAt))}: the 60th NGO was elected. Updates now need an Upgrade proposal (token vote and a majority of the elected NGOs). The council keeps only the emergency pause.`
      : `${badge('active', true)} until 60 NGOs are elected for the first time (now ${num(d.elected)}). Then it retires for good.`;
    const body = '<p class="eyebrow">Upgrades and dev council</p><h1>Every update: submit, approve, wait, take effect.</h1>' +
      '<p class="lead">Contract and node updates are submitted here and wait out a public timelock before they take effect. Until 60 NGOs are first elected, two of the three dev council keys can approve node updates (7 days; each operator chooses to install them). Contract updates, and after the handover every update, need a DAO vote with a majority of the elected NGOs: 7 days for contracts, 14 days for nodes.</p>' +
      this.walletBar() +
      `<div class="grid2"><div class="panel stat">Dev council<strong>${d.retired ? 'retired' : 'active'}</strong></div><div class="panel stat">Elected NGOs<strong>${num(d.elected)} / 60</strong></div>` +
      `<div class="panel stat">Node version required<strong>${d.required ? esc(versionText(d.required)) : 'none yet'}</strong></div><div class="panel stat">This node<strong>${esc(NODE_VERSION)}</strong></div></div>` +
      (behind ? `<div class="warn">This node runs ${esc(NODE_VERSION)} but the network requires ${esc(versionText(d.required))}: it has stopped following the chain. Update it.</div>` : '') +
      `<h2 class="mt-4">Dev council</h2><p>${status}</p>` +
      '<div class="warn">The council can never touch the Treasury, balances, the 12 % (DevVesting), the NGO election or its rules, or the handover rule, and it replaces no contract: every system contract holds PSY or feeds the election, the Treasury or the volunteer fund. It can approve node updates, change the committee bond and the role candidacy deposit (48 hours), and pause (at most 7 days in a row before the handover, then 7 days without).</div>' +
      table(['Seat', 'Dev Account wallet', 'Council key', 'Key change waiting'], seats, '') +
      `<h3 class="h5 mt-3">Council actions</h3>` + table(['#', 'Action', 'What', 'Approved by', 'State'], acts, 'No council actions yet.') +
      `<h2 class="mt-4">Update plans</h2>` + table(['#', 'Update', 'State', 'Approved by'], plans, 'Nothing submitted yet.') +
      '<h2 class="mt-4">Check an update yourself</h2><ol class="steps">' +
      '<li><b>Contract update:</b> check out the plan\'s commit, run <code>cd contracts && forge build</code>, and compare <code>keccak256</code> of the runtime code with the plan\'s code hash (<code>cast keccak $(cast code &lt;new code address&gt; --rpc-url https://rpc.psyrob.com)</code>). The node copies the code only if the hash still matches when the timelock ends.</li>' +
      '<li><b>Node update:</b> download the release, run <code>sha256sum SHA256SUMS.txt</code> and compare with the plan; then <code>sha256sum -c SHA256SUMS.txt</code> checks every file. From the activation block, nodes older than the required version stop and say so.</li></ol>' +
      '<h2 class="mt-4">Submit and approve</h2><div class="grid2">' +
      this.txForm('UpgradeRegistry', 'submit', 'Submit an update (anyone)', [['Kind', 'select', '<option value="0">Contract update</option><option value="1">Node update</option>'],
        ['Contract to replace (contract updates; else 0x000…)', 'address', '0x7070…', ZERO], ['Address of the new code (contract updates; else 0x000…)', 'address', '0x…', ZERO],
        ['Node version number (node updates: 10.1.0 = 10001000; else 0)', 'uint', '0'], ['Git commit (0x + 40 hex)', 'bytes20', '0x…'],
        ['SHA-256 of SHA256SUMS.txt (node updates; else 0x00…)', 'bytes32', '0x…', '0x' + '00'.repeat(32)], ['Description', 'string', 'What it changes and why']]) +
      this.txForm('DevCouncil', 'propose', 'Council: propose an action (first key)', [['Action', 'select', ACTION_KIND.map((n, i) => `<option value="${i}">${n}</option>`).join('')],
        ['Target (pause: contract or 0x000… for the whole network)', 'address', '0x…', ZERO], ['Parameter name hex or reason hash (0x + 64 hex)', 'bytes32', '0x…', '0x' + '00'.repeat(32)],
        ['Number (plan, action or new parameter value)', 'uint', '0']], { note: 'Sent from a council key. A second key approves with the form below; pauses and node update approvals take effect at once (the update then waits its 7 days), parameter changes (committeeBond, candidacyDeposit) after 48 hours.' }) +
      this.txForm('DevCouncil', 'approve', 'Council: approve an action (second key)', [['Action number', 'uint', '0']]) +
      this.txForm('DevCouncil', 'execute', 'Run a parameter change after 48 hours (anyone)', [['Action number', 'uint', '0']]) +
      this.txForm('DevCouncil', 'requestKeyChange', 'Replace a council key (from the Dev Account wallet)', [['Seat (0, 1 or 2)', 'uint', '0'], ['New council key', 'address', '0x…']],
        { note: 'Takes effect after 48 hours. Another seat can cancel it in that time.' }) +
      this.txForm('DevCouncil', 'cancelKeyChange', 'Cancel another seat\'s key change (council key)', [['Seat (0, 1 or 2)', 'uint', '0']]) +
      this.txForm('DevCouncil', 'applyKeyChange', 'Apply a key change after 48 hours (anyone)', [['Seat (0, 1 or 2)', 'uint', '0']]) +
      '</div><p class="muted">After the handover, approve with an <a href="/governance">Upgrade proposal</a>: target <code>' + esc('0x' + bytesToHex(ADDR.upgradeRegistry)) + '</code>, calldata <code>approve(planNumber)</code>.</p>';
    return this.layout('Upgrades', body, '/upgrades', { scripts: this.appScripts() });
  };

  // ------------------------------------------------------------------ /pause

  P.pausePage = async function () {
    const d = await this.v8State();
    const now = Number(this.chain.tip.header.timestamp); // block time, as the contracts judge a pause
    const live = d.pauses.filter((x) => x.until > now);
    const cur = PAUSABLE.map(([name, addr]) => {
      const x = d.pauses.find((y) => y.addr === addr);
      const on = x && x.until > now;
      return `<tr><td>${esc(name)}</td><td>${on ? badge('paused') : badge('running', true)}</td><td>${on ? `${esc(BY[x.by])} · until ${esc(when(x.until))}<div class="muted">reason <code>${esc(short(x.reason))}</code></div>` : '–'}</td></tr>`;
    });
    const hist = d.history.map((r) => `<tr><td>${esc(targetName(r.target))}</td><td>${esc(BY[Number(r.by)] ?? '?')}</td><td>${esc(when(r.at))}</td><td>${esc(when(r.until))}${r.endedEarly ? ' <span class="muted">(ended early)</span>' : ''}</td><td><code>${esc(short(r.reason))}</code></td></tr>`);
    const reqs = d.requests.map(({ id, r }) => `<tr><td>${id}</td><td>${esc(targetName(r.target))}</td><td>${num(r.votes)} of 14 · ${num(r.ngoVotes)} of 4 NGOs</td><td>${r.done ? 'paused' : Number(r.openedAt) + 6 * 3600 > now ? 'open until ' + esc(when(Number(r.openedAt) + 6 * 3600)) : 'expired'}</td></tr>`);
    const options = PAUSABLE.map(([n, a]) => `<option value="${a}">${esc(n)}</option>`).join('');
    const cooldown = d.retired ? `After the handover the council can start a pause at most once every 7 days${d.lastCouncilPause ? ` (next from ${esc(when(d.lastCouncilPause + 7 * 86400))})` : ''}${d.lockout > now ? `; locked out until ${esc(when(d.lockout))} because the DAO ended its last pause early` : ''}.` : 'Before the handover the council can pause, renew and end pauses.';
    const body = '<p class="eyebrow">Emergency pause</p><h1>A brake, not a lever.</h1>' +
      '<p class="lead">In a hack or a serious bug, one contract or all transactions can be paused for at most 72 hours. Mining, rewards, votes, upgrades, finality and the 12 % vesting keep running; nobody can move PSY while the whole network is paused, the Dev Account wallets included. Only a DAO vote can pause for longer or end a pause early.</p>' +
      this.walletBar() +
      `<div class="grid2"><div class="panel stat">Paused now<strong>${live.length ? live.map((x) => esc(x.name)).join(', ') : 'nothing'}</strong></div><div class="panel stat">Dev council<strong>${d.retired ? 'pause only' : 'active'}</strong></div></div>` +
      kv([['Who can pause', d.retired ? '2 of 3 dev council keys, or the finality committee (14 of 21 members, at least 4 of them NGOs, within 6 hours)' : '2 of 3 dev council keys'],
        ['How long', '72 hours at most, then it lifts by itself; a DAO Emergency proposal (2 days of voting, no timelock) can pause up to 30 days or end a pause'],
        ['Limits', cooldown + ' If the DAO ends a council pause early, the council cannot pause for 30 days. The committee cannot pause the same target again within 7 days.'],
        ['Never paused', 'the three DevVesting contracts (the 12 %), the Governor, the dev council, the upgrade registry and the pause itself']]) +
      '<h2 class="mt-4">Now</h2>' + table(['Target', 'State', 'Detail'], cur, '') +
      '<h2 class="mt-4">Committee requests</h2>' + table(['#', 'Target', 'Votes', 'State'], reqs, 'No committee requests.') +
      '<h2 class="mt-4">History</h2>' + table(['Target', 'By', 'From', 'Until', 'Reason'], hist, 'No pauses yet.') +
      '<h2 class="mt-4">Act</h2><div class="grid2">' +
      this.txForm('EmergencyPause', 'committeeVote', 'Committee member: ask for a pause', [['Target', 'select-address', options], ['Reason (published text; its SHA-256 is stored)', 'text-hash', 'What is wrong']],
        { note: 'From your committee member wallet. Members who name the same target and the same reason text within 6 hours add up; at 14 votes with 4 NGOs the pause starts.' }) +
      this.txForm('DevCouncil', 'propose', 'Council key: propose a pause', [['Action', 'hidden', '', '3'], ['Target', 'select-address', options], ['Reason (published text; its SHA-256 is stored)', 'text-hash', 'What is wrong'], ['', 'hidden', '', '0']],
        { note: 'A second council key approves it on the <a href="/upgrades">upgrades page</a> (Council: approve an action).' }) +
      '</div>';
    return this.layout('Emergency pause', body, '/pause', { scripts: this.appScripts() });
  };
}

function versionNumberOf(v) { const [a, b, c] = String(v).split('.').map(Number); return a * 1_000_000 + (b || 0) * 1_000 + (c || 0); }
