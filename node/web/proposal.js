// The guided proposal builder of /governance: one template per proposal kind, so nobody has to write calldata.
// It encodes the call with the node's ABI (/api/abi), shows what it does in plain words with the rules it must meet
// (proposer threshold, floor, timeline), and only then lets the wallet sign Governor.propose. The contracts check
// everything again, and app.js dry-runs the transaction before the wallet is asked.
import { loadAbis, codecFor, rpc, sendTx, connect, connectedAccount } from '/app.js';
import { u8ToHex, hexToU8 } from '/abicodec.js';
import { T, LOCALE } from '/i18n.js';

const form = document.getElementById('proposal-builder');
if (form) {
  const $ = (id) => document.getElementById(id);
  const data = JSON.parse($('pb-data').textContent);
  const KIND = { signal: 0, decide: 0, treasury: 1, param: 2, fund: 3, removal: 4, emergency: 6 };
  const ZERO = '0x0000000000000000000000000000000000000000';
  const isAddr = (a) => /^0x[0-9a-fA-F]{40}$/.test(a);
  const fmt = (wei, dp = 2) => (Number(BigInt(wei) / 10n ** 14n) / 1e4).toLocaleString(LOCALE, { maximumFractionDigits: dp });
  const psyToWei = (s) => {
    s = String(s).trim();
    if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new Error(T('amount must be a number of PSY'));
    const [i, f = ''] = s.split('.');
    return BigInt(i) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
  };
  const sha256Hex = async (text) => {
    if (!crypto.subtle) throw new Error(T('File hashing needs a secure page (https or localhost); paste the hash instead.'));
    return '0x' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

  const kindSel = $('pb-kind'), summary = $('pb-summary'), send = $('pb-send'), out = form.querySelector('.out');
  let built = null;
  const show = () => {
    for (const fs of form.querySelectorAll('fieldset[data-for]')) fs.hidden = fs.dataset.for !== kindSel.value;
    built = null; send.disabled = true; summary.innerHTML = '';
    paramHint();
  };
  // a parameter in its own unit: PSY, a plain number, or a percentage (basis points)
  const param = () => data.params[Number($('pb-p-key')?.value ?? 0)];
  const shownValue = (p, raw) => (p.unit === 'psy' ? fmt(raw) + ' PSY' : p.unit === 'bps' ? (Number(raw) / 100).toLocaleString(LOCALE) + ' %' : Number(raw).toLocaleString(LOCALE));
  const toRaw = (p, s) => {
    s = String(s).trim();
    if (p.unit === 'psy') return psyToWei(s);
    if (p.unit === 'bps') { if (!/^\d+(\.\d{1,2})?$/.test(s)) throw new Error(T('enter a percentage, for example 1.5')); return BigInt(Math.round(Number(s) * 100)); }
    if (!/^\d+$/.test(s)) throw new Error(T('enter a whole number'));
    return BigInt(s);
  };
  function paramHint() {
    const p = param(), hint = $('pb-p-hint');
    if (!p || !hint) return;
    const cur = BigInt(p.value), lo = BigInt(p.min) > (cur + 1n) / 2n ? BigInt(p.min) : (cur + 1n) / 2n, hi = BigInt(p.max) < cur * 2n ? BigInt(p.max) : cur * 2n;
    hint.textContent = T('Now {v}. Allowed range {a} to {b}; one change may at most halve or double it ({c} to {d}), and a parameter changes at most once per 30 days.',
      { v: shownValue(p, p.value), a: shownValue(p, p.min), b: shownValue(p, p.max), c: shownValue(p, lo), d: shownValue(p, hi) });
    $('pb-p-value').placeholder = p.unit === 'psy' ? 'PSY' : p.unit === 'bps' ? '%' : '';
  }
  kindSel.addEventListener('change', show);
  $('pb-p-key')?.addEventListener('change', () => { paramHint(); built = null; send.disabled = true; });
  form.addEventListener('input', () => { built = null; send.disabled = true; });
  show();

  /** The contract call(s) of the chosen template and a plain-words line for each. */
  async function build() {
    const abis = await loadAbis();
    const enc = (name, fn, args) => u8ToHex(codecFor(name).encode(fn, args));
    const kind = kindSel.value, desc = $('pb-desc').value.trim();
    if (!desc) throw new Error(T('write a title and explanation: voters read it first'));
    let calls, words;
    if (kind === 'signal') {
      calls = [[ZERO, 0n, '0x']];
      words = T('No contract call: if it passes, the decision stands as written in the explanation.');
    } else if (kind === 'decide') {
      const ngo = $('pb-decide-ngo')?.value, up = $('pb-decide-up').value === 'true';
      if (!ngo) throw new Error(T('No NGO has an open challenge.'));
      calls = [[abis.Attestation.address, 0n, enc('Attestation', 'governorDecide', [ngo, up])]];
      words = (up ? T('Uphold the challenge against {ngo}: the NGO is rejected, its vouchers\' bonds are burned and the challenger gets the bond back.', { ngo: esc(ngo) })
        : T('Dismiss the challenge against {ngo}: the NGO stays, the challenger\'s bond goes to its vouchers, and a new 7-day challenge window opens.', { ngo: esc(ngo) })) + ' ' + T('A token vote on a challenge needs the higher floor (10 % or 100 yes voters).');
    } else if (kind === 'treasury') {
      const to = $('pb-t-to').value.trim(), amount = psyToWei($('pb-t-amount').value), memo = $('pb-t-memo').value.trim();
      if (!isAddr(to)) throw new Error(T('not an address: {a}', { a: to }));
      if (amount === 0n) throw new Error(T('the amount must be more than 0'));
      calls = [[abis.Treasury.address, 0n, enc('Treasury', 'spend', [to, amount, memo])]];
      words = T('Pay {n} PSY from the Treasury to {to} (memo: "{m}").', { n: fmt(amount, 4), to: esc(to), m: esc(memo) });
    } else if (kind === 'param') {
      const p = param(), v = toRaw(p, $('pb-p-value').value), cur = BigInt(p.value);
      if (v < BigInt(p.min) || v > BigInt(p.max)) throw new Error(T('outside the allowed range'));
      if (v < (cur + 1n) / 2n || v > cur * 2n) throw new Error(T('one change may at most halve or double a parameter'));
      if (v === cur) throw new Error(T('that is the current value'));
      calls = [[abis.Params.address, 0n, enc('Params', 'set', [p.key, v])]];
      words = T('Change {p} from {a} to {b}.', { p: `<code>${esc(p.name)}</code>`, a: shownValue(p, p.value), b: shownValue(p, v) });
    } else if (kind === 'removal') {
      const ngo = $('pb-r-ngo')?.value, reason = $('pb-r-reason').value.trim();
      if (!ngo) throw new Error(T('No NGO is elected.'));
      if (!reason) throw new Error(T('give the reason: its hash is stored and voters will look for the text'));
      calls = [[abis.NGOElection.address, 0n, enc('NGOElection', 'remove', [ngo, await sha256Hex(reason)])]];
      words = T('Remove the elected NGO {ngo} for the rest of its term; its seat is filled in the next supplementary round. Publish the reason text where voters can read it.', { ngo: esc(ngo) });
    } else if (kind === 'emergency') {
      const target = $('pb-e-target').value, hours = Number($('pb-e-hours').value || 0), reason = $('pb-e-reason').value.trim();
      if (!(hours >= 1 && hours <= 720 && Number.isInteger(hours))) throw new Error(T('the pause lasts 1 to 720 hours'));
      if (!reason) throw new Error(T('give the reason: its hash is stored and voters will look for the text'));
      calls = [[abis.EmergencyPause.address, 0n, enc('EmergencyPause', 'daoPause', [target, await sha256Hex(reason), BigInt(hours * 3600)])]];
      words = T('Pause {t} for {h} hours from execution.', { t: esc(data.pausable.find((x) => x.address === target)?.name ?? target), h: hours });
    } else if (kind === 'fund') {
      const token = $('pb-f-token').value.trim(), to = $('pb-f-to').value.trim(), fund = $('pb-f-fund').value.trim();
      const amount = BigInt($('pb-f-amount').value.trim() || '0'), chain = BigInt($('pb-f-chain').value.trim() || '56');
      for (const a of [token, to, fund]) if (!isAddr(a)) throw new Error(T('not an address: {a}', { a }));
      if (amount === 0n) throw new Error(T('the amount must be more than 0'));
      calls = [[abis.FundApprovals.address, 0n, enc('FundApprovals', 'approve', [token, to, amount, chain, fund])]];
      words = T('Approve a volunteer-fund transfer on BNB Chain (chain {c}): {n} units of token {tk} to {to}, from fund {f}.', { c: chain, n: amount.toLocaleString(LOCALE), tk: esc(token), to: esc(to), f: esc(fund) });
    } else throw new Error(T('choose what the proposal should do'));
    const k = KIND[kind];
    const calldata = enc('Governor', 'propose', [BigInt(k), calls.map((c) => c[0]), calls.map((c) => c[1]), calls.map((c) => c[2]), desc]);
    return { k, kind, words, data: calldata, to: abis.Governor.address };
  }

  /** The proposer threshold at the last block (0.5 % of locked PSY), against this wallet's voting power. */
  async function threshold(account) {
    const abis = await loadAbis(), ve = codecFor('VoteEscrow');
    const block = BigInt(await rpc('eth_blockNumber')) - 1n;
    const call = async (fn, args) => ve.decode(fn, hexToU8(await rpc('eth_call', [{ to: abis.VoteEscrow.address, data: u8ToHex(ve.encode(fn, args)) }, 'latest'])), args.length);
    const total = BigInt(await call('totalAt', [block]) ?? 0n), power = BigInt(await call('powerAt', [account, block]) ?? 0n);
    return { total, power, needed: total * 50n / 10_000n };
  }

  $('pb-review').addEventListener('click', async () => {
    out.textContent = '';
    try {
      built = await build();
      const account = connectedAccount() ?? await connect();
      const t = await threshold(account).catch(() => null);
      const high = [1, 2, 3, 4].includes(built.k) || built.kind === 'decide';
      const rows = [
        [T('What it does'), built.words],
        [T('Who may propose'), t ? (t.power >= t.needed && t.power > 0n
          ? T('Yes: this wallet has {p} PSY of voting power; {n} PSY (0.5 % of locked PSY) is needed.', { p: fmt(t.power), n: fmt(t.needed) })
          : T('Not yet: this wallet has {p} PSY of voting power; {n} PSY (0.5 % of locked PSY) is needed. Lock more PSY on the NGO election page.', { p: fmt(t.power), n: fmt(t.needed) })) : '–'],
        [T('To pass'), high ? T('more yes than no, yes at least half the recent turnout, and yes at least 10 % of locked PSY (or 100 yes voters together holding at least 1 % of locked PSY)')
          : T('more yes than no, yes at least half the recent turnout, and yes at least 5 % of locked PSY (or 50 yes voters together holding at least 1 % of locked PSY)')],
        [T('Timeline'), built.k === 6 ? T('2 days of voting, then it can be executed at once (no timelock).') : T('5 days of voting, then 48 hours of timelock before anyone can execute it.')],
      ];
      summary.innerHTML = `<div class="panel"><h3 class="h5">${T('Check before you sign')}</h3><table><tbody>${rows.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}</tbody></table>` +
        `<details class="mt-2"><summary class="muted small">${T('Show the encoded call')}</summary><pre class="code">${esc(built.data)}</pre></details></div>`;
      send.disabled = false;
    } catch (e) {
      built = null; send.disabled = true;
      out.textContent = e.message || String(e);
    }
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (!built) { out.textContent = T('Press Review first.'); return; }
    try { await sendTx(built.to, built.data, 0n, out); } catch (e) { out.textContent = e.message || String(e); }
  });
}
