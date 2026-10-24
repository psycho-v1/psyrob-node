// Transaction forms of the participation pages. Uses the visitor's browser wallet (EIP-1193, window.ethereum);
// the node never sees a private key. ABI encoding uses the shared codec (/abicodec.js) with the selectors the node
// computed (/api/abi), so no hashing library is needed here.
import { contract, u8ToHex } from '/abicodec.js';

const $ = (s, el = document) => el.querySelector(s);
const status = $('#wallet-status');
const connectBtn = $('#wallet-connect');
let abis = null, account = null, chainId = null;

export async function loadAbis() {
  if (!abis) abis = await (await fetch('/api/abi')).json();
  return abis;
}

export function codecFor(name) {
  const a = abis[name];
  const sel = new Map(Object.entries(a.selectors));
  // the codec asks for keccak(signature)[0:4]; answer from the node's table
  const fakeKeccak = (bytes) => { const sig = new TextDecoder().decode(bytes); const h = sel.get(sig); if (!h) throw new Error('unknown function ' + sig); return Uint8Array.from(h.slice(2).match(/../g).map((x) => parseInt(x, 16))); };
  return contract(a.abi, fakeKeccak);
}

export async function rpc(method, params = []) {
  const r = await fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) {
    const sel = typeof j.error.data === 'string' ? j.error.data.slice(0, 10) : null;
    const name = sel && abis?._errors?.[sel];
    throw new Error(name ? `${name.replace(/\(.*\)$/, '')} (${explain(name)})` : j.error.message);
  }
  return j.result;
}

const EXPLAIN = {
  NeverMined: 'mine at least one block with this wallet first', AlreadyRegistered: 'this wallet is already registered', NotARegisteredMiner: 'register this wallet as a miner first',
  AlreadyAnNGO: 'this wallet already has an NGO record', WrongFee: 'the amount sent must equal the fee', RoleHolderCannotBeNGO: 'a role holder cannot be an NGO',
  VoucherCannotBeNGO: 'a wallet vouching for an NGO cannot be an NGO', NotEligibleVoucher: 'vouchers must be registered miners with enough blue blocks, not NGOs or role holders',
  AlreadyVouched: 'you already vouched for this NGO', EnoughVouches: 'this NGO already has five vouches', WrongBond: 'the amount sent must equal the bond',
  WindowOpen: 'the 7-day challenge window has not ended', ChallengePending: 'a challenge is pending', NotAnElectedNGO: 'only elected NGOs can do this',
  NotAttested: 'only attested NGOs can stand', NotOpen: 'this round is not open', AlreadyVoted: 'you already voted', NoVotingPower: 'lock PSY first (it counts from the next block)',
  ApprovalsNotSorted: 'the ballot must not contain the same candidate twice', NotACandidate: 'that wallet is not a candidate in this round', RoleHolderCannotVote: 'role holders cannot vote while in office',
  NotNormalMode: 'role elections run only in Normal mode (60 elected NGOs)', ModeForbids: 'this kind of proposal needs Normal mode', BelowThreshold: 'you need 0.5 % of the locked PSY to propose',
  TargetNotAllowed: 'this kind of proposal cannot call that contract', NotEligible: 'this wallet is not eligible', Held: 'your PSY is held until your open votes close',
  // council, upgrades, pause
  NotCouncil: 'send this from a dev council key', NotDevAccount: 'send this from the seat\'s Dev Account wallet', Retired: 'the dev council has retired (60 NGOs were elected); only a pause is left',
  Expired: 'this action was not approved within 3 days', AlreadyApproved: 'this key already approved it', NotQueued: 'nothing waits in the timelock for this number',
  Timelocked: 'the timelock has not ended yet', BadKey: 'the council key must be new: not a Dev Account wallet and not another seat\'s key', NoPendingKey: 'no key change is waiting for this seat',
  Protected: 'this contract cannot be replaced by this body', NotSystemContract: 'only PSYROB system contracts can be replaced', NoCode: 'the new code address holds no code (or it changed)',
  BadVersion: 'the version must be higher than the one in force', WrongState: 'the plan is not in a state that allows this', NotAllowed: 'only the dev council (before the handover) or a DAO vote (after) can do this',
  NotPausable: 'this contract cannot be paused', CouncilCooldown: 'the council cannot pause again yet', AlreadyPaused: 'it is already paused for longer',
  NotPaused: 'it is not paused', NotACommitteeMember: 'only members of the current finality committee can ask for a pause', CommitteeCooldown: 'the committee paused this target less than 7 days ago',
  TooLong: 'a DAO pause lasts at most 30 days at a time',
  NameTaken: 'another miner address is already registered for an NGO with this name', BadName: 'the NGO name must be 1 to 80 characters and the description at most 280',
  ChallengeBarred: 'your earlier challenge of this NGO was dismissed, so you cannot challenge it again', WouldLeaveTooFew: 'a removal may not take the number of elected NGOs below 60',
  CouncilStillActive: 'the finality committee can pause only after the dev council has retired', TooManyRequests: 'a committee member can open at most 3 pause requests in 6 hours',
  NotTheCouncilsPause: 'the council can only end pauses it started itself', NetworkPaused: 'the network is paused: only upgrade and emergency proposals run', Paused: 'this contract is paused',
};
export function explain(sig) { return EXPLAIN[sig.replace(/\(.*\)$/, '')] || 'the contract refused it'; }

export async function ensureChain() {
  const eth = window.ethereum;
  if (!eth) throw new Error('No browser wallet found. Install one (for example MetaMask) and reload.');
  const want = await rpc('eth_chainId');
  chainId = await eth.request({ method: 'eth_chainId' });
  if (chainId !== want) {
    try {
      await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: want }] });
    } catch (e) {
      if (e.code !== 4902 && !/unrecognized|not added|unknown chain/i.test(e.message || '')) throw e;
      await eth.request({ method: 'wallet_addEthereumChain', params: [{ chainId: want, chainName: document.querySelector('meta[name="psyrob-network"]')?.content || 'PSYROB testnet', nativeCurrency: { name: 'PSY', symbol: 'PSY', decimals: 18 }, rpcUrls: [location.origin + '/rpc'], blockExplorerUrls: [location.origin] }] });
    }
    chainId = want;
  }
}

export async function connect() {
  await ensureChain();
  const accs = await window.ethereum.request({ method: 'eth_requestAccounts' });
  account = accs[0];
  const bal = await rpc('eth_getBalance', [account, 'latest']);
  if (status) status.innerHTML = `Connected: <a href="/address/${account}">${account.slice(0, 10)}…${account.slice(-6)}</a> · ${(Number(BigInt(bal) / 10n ** 14n) / 1e4).toLocaleString('en-US')} PSY`;
  return account;
}

if (connectBtn) connectBtn.addEventListener('click', () => connect().catch((e) => { if (status) status.textContent = e.message; }));

async function sha256Hex(data) {
  if (!crypto.subtle) throw new Error('File hashing needs a secure page (https or localhost); paste the hash instead.');
  return '0x' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', data))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function psyToWei(s) {
  s = String(s).trim();
  if (!/^\d+(\.\d{1,18})?$/.test(s)) throw new Error('amount must be a number of PSY');
  const [i, f = ''] = s.split('.');
  return BigInt(i) * 10n ** 18n + BigInt((f + '0'.repeat(18)).slice(0, 18));
}

async function collectArgs(form) {
  const args = [];
  const n = Number(form.dataset.n);
  for (let i = 0; i < n; i++) {
    const el = form.querySelector(`[data-i="${i}"]`);
    const kind = el.dataset.kind || (el.tagName === 'SELECT' ? 'uint' : 'string');
    const v = el.value;
    if (kind === 'file-hash') {
      const typed = form.querySelector(`[data-hash-for="${i}"]`).value.trim();
      if (el.files && el.files[0]) args.push(await sha256Hex(await el.files[0].arrayBuffer()));
      else if (/^0x[0-9a-fA-F]{64}$/.test(typed)) args.push(typed);
      else throw new Error('choose the dossier file or paste its SHA-256 hash');
      continue;
    }
    if (kind === 'text-hash') { args.push(await sha256Hex(new TextEncoder().encode(v))); continue; }
    const lines = () => v.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
    switch (kind) {
      case 'address': if (!/^0x[0-9a-fA-F]{40}$/.test(v.trim())) throw new Error('not an address: ' + v); args.push(v.trim()); break;
      case 'address[]':
      case 'address[]sorted': {
        const l = lines();
        for (const a of l) if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error('not an address: ' + a);
        // ballots list candidates in increasing address order, without duplicates (NGOElection.vote)
        args.push(kind === 'address[]sorted' ? [...new Set(l.map((x) => x.toLowerCase()))].sort() : l);
        break;
      }
      case 'uint': args.push(BigInt(v.trim() || '0')); break;
      case 'uint[]': args.push(lines().map((x) => BigInt(x))); break;
      case 'bytes[]': args.push(v.split(/\n+/).map((x) => x.trim()).filter(Boolean)); break;
      case 'psy': args.push(psyToWei(v)); break;
      case 'bool': args.push(/^(true|yes|1)$/i.test(v.trim())); break;
      case 'bytes32': if (!/^0x[0-9a-fA-F]{64}$/.test(v.trim())) throw new Error('expected 0x followed by 64 hex digits'); args.push(v.trim()); break;
      default: args.push(v);
    }
  }
  return args;
}

async function waitReceipt(hash, out) {
  for (let i = 0; i < 120; i++) {
    const r = await rpc('eth_getTransactionReceipt', [hash]).catch(() => null);
    if (r) {
      out.innerHTML = r.status === '0x1' ? `Done in chain block <a href="/block/${Number(r.blockNumber)}">#${Number(r.blockNumber)}</a>. <a href="/tx/${hash}">Transaction</a>.`
        : `The transaction failed (reverted). <a href="/tx/${hash}">Details</a>.`;
      return;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  out.innerHTML = `Sent; not accepted yet. <a href="/tx/${hash}">Follow it here</a>.`;
}

for (const form of document.querySelectorAll('form.tx')) {
  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const out = $('.out', form);
    try {
      const confirmBox = form.querySelector('[data-confirm]');
      if (confirmBox && !confirmBox.checked) throw new Error('Please confirm that you understand wallet loss is permanent.');
      await loadAbis();
      const from = account ?? await connect();
      const args = await collectArgs(form);
      const codec = codecFor(form.dataset.c);
      const data = u8ToHex(codec.encode(form.dataset.f, args));
      let value = 0n;
      const vEl = form.querySelector('[data-value]');
      if (vEl) value = vEl.dataset.value === 'psy' ? psyToWei(vEl.value || '0') : BigInt(vEl.value || '0');
      const tx = { from, to: abis[form.dataset.c].address, data, value: '0x' + value.toString(16) };
      // dry run first, so a mistake is explained before the wallet asks for a signature
      try { await rpc('eth_call', [tx, 'latest']); } catch (e) { throw new Error('This would fail: ' + e.message + '. Nothing was sent.'); }
      out.textContent = 'Waiting for your wallet…';
      const hash = await window.ethereum.request({ method: 'eth_sendTransaction', params: [tx] });
      out.innerHTML = `Sent: <a href="/tx/${hash}">${hash.slice(0, 18)}…</a>. Waiting for a chain block to accept it…`;
      await waitReceipt(hash, out);
    } catch (e) {
      out.textContent = e.message || String(e);
    }
  });
}
