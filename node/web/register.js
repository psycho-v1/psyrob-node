// The two registration pages (/register/miner and /register/ngo). Uses the same browser wallet code as the other
// participation pages (app.js): the visitor's wallet signs, the node never sees a key. The page shows the connected
// address, its blue blocks and balance, and whether it is registered; then sends MinerRegistry.register (a community
// miner) or MinerRegistry.registerNgoMiner (an NGO's miner, with the NGO's name).
import { connect, rpc, loadAbis, codecFor } from '/app.js';
import { u8ToHex } from '/abicodec.js';
import { T, LOCALE } from '/i18n.js';

const $ = (s, el = document) => el.querySelector(s);
const box = $('#reg');
const kind = box?.dataset.kind; // 'miner' or 'ngo'
const out = $('#reg-out');
const button = $('#reg-submit');
let address = null;

const set = (field, html) => { const el = box.querySelector(`[data-f="${field}"]`); if (el) el.innerHTML = html; };
const say = (html, tone = '') => { out.className = 'reg-out ' + tone; out.innerHTML = html; };
const short = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;

async function call(fn, args) {
  const c = codecFor('MinerRegistry');
  const r = await rpc('eth_call', [{ to: (await loadAbis()).MinerRegistry.address, data: u8ToHex(c.encode(fn, args)) }, 'latest']);
  return c.decode(fn, Uint8Array.from(r.slice(2).match(/../g)?.map((x) => parseInt(x, 16)) ?? []), args.length);
}

/** Read the address's state and update the panel. Returns { mined, registered, name }. */
async function refresh() {
  if (!address) return null;
  const [mined, registered, name, verified] = await Promise.all([call('minedTotal', [address]), call('isRegistered', [address]), call('ngoName', [address]), call('ngoNameVerified', [address]).catch(() => false)]);
  const bal = BigInt(await rpc('eth_getBalance', [address, 'latest']));
  set('address', `<a href="/address/${address}">${short(address)}</a>`);
  set('mined', mined > 0n ? (mined === 1n ? T('1 blue block') : T('{n} blue blocks', { n: mined })) : `<span class="bad">${T('none yet')}</span>`);
  set('balance', `${(Number(bal / 10n ** 14n) / 1e4).toLocaleString(LOCALE)} PSY`);
  // a name is only a claim until the NGO's record is attested
  if (kind === 'ngo') set('name', name ? `${escapeHtml(name)} <span class="${verified ? 'good' : 'muted'}">(${verified ? T('verified: attested NGO') : T('unverified')})</span>` : '–');
  set('status', registered ? `<strong class="good">${T('Registered')}</strong>` : T('Not registered'));
  button.disabled = registered || mined === 0n;
  if (registered) button.textContent = T('Registered');
  else if (mined === 0n) say(T('This address has not mined a blue block yet. Mine one first, then come back to this page.'), 'bad');
  return { mined, registered, name };
}

/** The same rule as MinerRegistry.validName: 1-80 of A-Z a-z 0-9 space . , & ' ( ) -; starts with a letter or digit,
 *  ends with a letter, digit, ")", "." or "'"; no double space. */
export function validNgoName(n) {
  return n.length >= 1 && n.length <= 80 && /^[A-Za-z0-9](?:[A-Za-z0-9.,&'()\- ]*[A-Za-z0-9).'])?$/.test(n) && !n.includes('  ');
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Turn a wallet or node error into a sentence a person can act on. */
function plain(e) {
  const m = String(e?.message ?? e);
  if (e?.code === 4001 || /user (rejected|denied)/i.test(m)) return T('You cancelled the transaction in your wallet. Nothing was sent.');
  if (/insufficient funds/i.test(m)) return T('There is not enough PSY in this address to pay the network fee. Mine a little more, then try again.');
  if (/NeverMined/.test(m)) return T('This address has not mined a blue block yet. Mine one first, then try again.');
  if (/AlreadyRegistered/.test(m)) return T('This address is already registered. There is nothing more to do.');
  if (/NameTaken/.test(m)) return T('Another miner address is already registered for an NGO with this name, or with a name that differs only in capitals, punctuation, spaces, or 0 for o and 1 for l. Each NGO can register one address. If someone took your NGO’s name, it is released when that NGO’s record is rejected.');
  if (/BadName/.test(m)) return T('Please check the NGO name: up to 80 characters, only letters, digits, spaces and . , &amp; \' ( ) -, starting with a letter or digit. The description can be up to 280 characters.');
  if (/No browser wallet/.test(m) || !window.ethereum) return T('No wallet was found in this browser. Install a wallet such as MetaMask, then reload this page.');
  return T('Something went wrong: {why}', { why: escapeHtml(m) });
}

async function onConnect() {
  try {
    say(T('Connecting to your wallet…'));
    await loadAbis();
    address = await connect();
    say('');
    await refresh();
  } catch (e) {
    say(plain(e), 'bad');
  }
}

async function onSubmit(ev) {
  ev.preventDefault();
  try {
    if (!address) await onConnect();
    if (!address) return;
    const state = await refresh();
    if (state.registered) return;
    let fn = 'register', args = ['0x' + '00'.repeat(32)];
    if (kind === 'ngo') {
      const name = $('#reg-name').value.trim(), description = $('#reg-description').value.trim();
      if (!name) { say(T('Please enter the name of the NGO first.'), 'bad'); $('#reg-name').focus(); return; }
      if (!validNgoName(name)) { say(plain({ message: 'BadName' }), 'bad'); $('#reg-name').focus(); return; }
      fn = 'registerNgoMiner';
      args = [name, description];
    }
    const abis = await loadAbis();
    const tx = { from: address, to: abis.MinerRegistry.address, data: u8ToHex(codecFor('MinerRegistry').encode(fn, args)), value: '0x0' };
    // try it first, so a problem is explained before the wallet asks for a signature
    try { await rpc('eth_call', [tx, 'latest']); } catch (e) { say(plain(e) + ' ' + T('Nothing was sent.'), 'bad'); return; }
    button.disabled = true;
    say(T('Please confirm the transaction in your wallet.'));
    const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });
    say(T('Sent. Transaction {tx}. Waiting for it to be included in a block. This usually takes less than a minute.', { tx: `<a href="/tx/${hash}">${short(hash)}</a>` }));
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
      if (!r) continue;
      if (r.status === '0x1') {
        const now = await refresh();
        const who = kind === 'ngo' && now?.name ? T('{name} is registered.', { name: escapeHtml(now.name) }) : T('Your miner address is registered.');
        say(`<strong>${T('Done.')}</strong> ${who} ` + T('Transaction {tx} is in block {b}.', { tx: `<a href="/tx/${hash}">${short(hash)}</a>`, b: `<a href="/block/${Number(r.blockNumber)}">#${Number(r.blockNumber)}</a>` }), 'good');
      } else {
        button.disabled = false;
        say(T('The transaction was included but did not go through. <a href="{href}">See the details</a>, then try again.', { href: `/tx/${hash}` }), 'bad');
      }
      return;
    }
    say(T('The transaction was sent but is not in a block yet. You can <a href="{href}">follow it here</a> and refresh this page later.', { href: `/tx/${hash}` }));
  } catch (e) {
    button.disabled = false;
    say(plain(e), 'bad');
  }
}

if (box) {
  $('#reg-connect').addEventListener('click', onConnect);
  $('#reg-form').addEventListener('submit', onSubmit);
  window.ethereum?.on?.('accountsChanged', (accs) => { address = accs?.[0] ?? null; button.disabled = false; button.textContent = kind === 'ngo' ? T('Register NGO miner') : T('Register miner'); say(''); refresh().catch(() => {}); });
}
