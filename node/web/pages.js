// Light script for the read-only pages (explorer-pages.js). Nothing here signs or sends a transaction:
//  - My account: "Use my wallet address" asks the browser wallet (EIP-1193) which address is selected
//    (eth_requestAccounts) and opens /account?address=…; no signature is requested.
//  - Run a node: the Windows / Linux tabs.
//  - Contract read views: each form encodes a call to a read function and sends it as eth_call to this site's /rpc.
// Results are written with textContent, never as HTML.

import { encodeParams, decodeParams, hexToU8, u8ToHex, signatureOf } from '/abicodec.js';

// ---- my account
const connect = document.getElementById('account-connect');
if (connect) {
  connect.addEventListener('click', async () => {
    const eth = window.ethereum;
    if (!eth) { connect.textContent = 'No browser wallet found'; return; }
    try {
      const [a] = await eth.request({ method: 'eth_requestAccounts' });
      if (/^0x[0-9a-fA-F]{40}$/.test(a ?? '')) location.href = '/account?address=' + encodeURIComponent(a);
    } catch { connect.textContent = 'The wallet did not share an address'; }
  });
}

// ---- tabs (Run a node): without this script both panels stay visible
const tabs = [...document.querySelectorAll('[role="tab"]')];
if (tabs.length) {
  const show = (t) => {
    for (const x of tabs) {
      const on = x === t;
      x.setAttribute('aria-selected', String(on));
      x.tabIndex = on ? 0 : -1;
      document.getElementById(x.getAttribute('aria-controls')).hidden = !on;
    }
  };
  tabs.forEach((t, i) => {
    t.addEventListener('click', () => show(t));
    t.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      n.focus();
      show(n);
    });
  });
  show(tabs.find((t) => t.getAttribute('aria-selected') === 'true') ?? tabs[0]);
}

// ---- contract read views
const forms = [...document.querySelectorAll('form.read-call')];
if (forms.length) {
  let abi = null;
  const loadAbi = async () => (abi ??= await (await fetch('/api/abi')).json());
  const word = (text) => { // a plain word (a parameter name) as bytes32, as the explorer's pkey() does
    const b = new TextEncoder().encode(text);
    if (b.length > 32) throw new Error('more than 32 bytes');
    const o = new Uint8Array(32); o.set(b); return u8ToHex(o);
  };
  const parse = (type, s) => {
    s = s.trim();
    if (type.endsWith(']')) {
      const inner = type.slice(0, type.lastIndexOf('['));
      const list = JSON.parse(s || '[]');
      if (!Array.isArray(list)) throw new Error('a list is needed, for example ["0x…"]');
      return list.map((x) => parse(inner, String(x)));
    }
    if (type === 'address') { if (!/^0x[0-9a-fA-F]{40}$/.test(s)) throw new Error('an address is 0x and 40 hex characters'); return s; }
    if (type === 'bool') { if (!/^(true|false)$/.test(s)) throw new Error('true or false'); return s === 'true'; }
    if (/^u?int\d*$/.test(type)) { if (!/^-?\d+$/.test(s)) throw new Error('a whole number'); return BigInt(s); }
    if (type === 'bytes32') return /^0x[0-9a-fA-F]{64}$/.test(s) ? s : word(s);
    if (/^bytes\d*$/.test(type)) { if (!/^0x([0-9a-fA-F]{2})*$/.test(s)) throw new Error('hex bytes, 0x…'); return s; }
    if (type === 'string') return s;
    throw new Error('type ' + type + ' is not supported here');
  };
  const show = (v) => JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x), 2);
  for (const form of forms) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const out = form.querySelector('.out');
      out.hidden = false;
      out.textContent = '…';
      try {
        const a = await loadAbi();
        const c = a[form.dataset.contract];
        const n = Number(form.dataset.n);
        const f = c.abi.find((x) => x.name === form.dataset.fn && x.inputs.length === n);
        const args = f.inputs.map((inp, i) => parse(inp.type, form.querySelector(`[name="a${i}"]`).value));
        const data = c.selectors[signatureOf(f)] + u8ToHex(encodeParams(f.inputs, args)).slice(2);
        const r = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: c.address, data }, 'latest'] }) });
        const j = await r.json();
        if (j.error) throw new Error(j.error.message);
        const vals = decodeParams(f.outputs, hexToU8(j.result));
        out.textContent = show(f.outputs.length === 1 ? vals[0] : Object.fromEntries(f.outputs.map((o, i) => [o.name || `out${i}`, vals[i]])));
      } catch (err) {
        out.textContent = 'Could not read: ' + err.message;
      }
    });
  }
}
