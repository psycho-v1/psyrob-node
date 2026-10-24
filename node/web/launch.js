// Launch ceremony page (pre-launch mode): connect the Dev Account wallet, show the exact message, sign it with
// personal_sign and send the signature to the node, which checks it against the seat's Dev Account address.
(() => {
  const $ = (id) => document.getElementById(id);
  const out = (t) => { $('out').textContent = t; };
  const hex = (s) => '0x' + Array.from(new TextEncoder().encode(s), (b) => b.toString(16).padStart(2, '0')).join('');

  $('sign').addEventListener('click', async () => {
    try {
      const eth = window.ethereum;
      if (!eth) { out('No browser wallet found. Install MetaMask (or another wallet) and select your Dev Account wallet.'); return; }
      const seat = Number($('seat').value);
      const key = $('key').value.trim();
      if (!/^0x[0-9a-fA-F]{40}$/.test(key)) { out('Enter the council key: an address, 0x and 40 hex characters.'); return; }
      const state = await (await fetch('/api/launch')).json();
      const want = state.seats[seat].account;
      const [account] = await eth.request({ method: 'eth_requestAccounts' });
      if (!account || account.toLowerCase() !== want) { out(`Your wallet shows ${account}. Select the ${state.seats[seat].label} wallet ${want} and try again.`); return; }
      if (key.toLowerCase() === want) { out('The council key must be a different wallet from your Dev Account wallet.'); return; }
      const r = await (await fetch('/api/launch/message?seat=' + seat + '&key=' + encodeURIComponent(key))).json();
      if (r.error) { out(r.error); return; }
      $('msg').textContent = r.message;
      out('Check the message above in your wallet, then sign.');
      const signature = await eth.request({ method: 'personal_sign', params: [hex(r.message), account] });
      const res = await fetch('/api/launch/sign', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seat, councilKey: key, signature }) });
      const j = await res.json();
      if (!res.ok) { out(j.error || 'The node refused the signature.'); return; }
      out(j.complete ? 'Signed. All three seats are signed: the network can start.' : 'Signed. Waiting for the other seats.');
      setTimeout(() => location.reload(), 1500);
    } catch (e) {
      out(e && e.message ? e.message : String(e));
    }
  });
})();
