// Explorer and participation pages (DAG_SPEC.md section 15), served by the node.
// Read pages are rendered on the server from the node's own state. Pages that send transactions use the visitor's
// browser wallet (EIP-1193) through /app.js; the node never holds visitors' keys.

import fs from 'node:fs';
import { keccak256 } from '../../common/crypto.js';
import { bytesToHex, fromHex, toQuantity } from '../../common/bytes.js';
import { contract, encodeParams, decodeParams } from '../../common/abicodec.js';
import { artifacts } from './genesis.js';
import { contractCall } from './evm.js';
import { ADDR, DEV_ACCOUNTS, NODE_VERSION, PSY, artifactName, TESTNET_NAME, TESTNET_MAJOR, TESTNET_WALLET_NAME } from './params.js';
import { scheduledReward, cumulative } from './emission.js';
import { nextBaseFee } from './consensus.js';
import { chainMetrics } from './metrics.js';
import { installPages } from './explorer-pages.js';
import { installV8Pages } from './explorer-governance.js';
import { CHART_CSS, lineChart, barChart, donut, gauge, seats, COLORS } from './charts.js';
import { readResource } from '../../common/resources.js';
import { T, lang, dir, locale, withLang, here, requestLang, clientDict, LANGS } from './i18n.js';

export const HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
    "script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

const STATIC = { '/home.css': 'text/css', '/logo.svg': 'image/svg+xml', '/sprite.svg': 'image/svg+xml', '/web-band.js': 'text/javascript',
  '/home-map.js': 'text/javascript', '/dag-graph.js': 'text/javascript', '/app.js': 'text/javascript', '/abicodec.js': 'text/javascript', '/live.js': 'text/javascript',
  '/pages.js': 'text/javascript', '/register.js': 'text/javascript', '/i18n.js': 'text/javascript',
  // self-hosted third-party assets (no CDN): Bootstrap 5.3.3 (MIT), Barlow Condensed and Source Serif 4 (OFL)
  '/vendor/bootstrap.min.css': 'text/css', '/vendor/bootstrap.bundle.min.js': 'text/javascript', '/vendor/fonts.css': 'text/css',
  '/vendor/fonts/barlow-condensed-latin-500-normal.woff2': 'font/woff2', '/vendor/fonts/barlow-condensed-latin-600-normal.woff2': 'font/woff2',
  '/vendor/fonts/barlow-condensed-latin-ext-500-normal.woff2': 'font/woff2', '/vendor/fonts/barlow-condensed-latin-ext-600-normal.woff2': 'font/woff2',
  '/vendor/fonts/source-serif-4-latin-opsz-normal.woff2': 'font/woff2', '/vendor/fonts/source-serif-4-latin-ext-opsz-normal.woff2': 'font/woff2' };

/**
 * The texts the browser scripts translate: the English text of every T('…') or L('…') call, and every quoted text
 * between "i18n-begin" and "i18n-end" comments (app.js's contract error explanations). Pages carry these, in the
 * visitor's language, as JSON.
 */
export function clientKeysOf(sources) {
  const keys = new Set();
  const unq = (x) => x.replace(/\\(['\\])/g, '$1');
  for (const src of sources) {
    for (const m of src.matchAll(/\b[TL]\(\s*'((?:[^'\\\n]|\\.)*)'/g)) keys.add(unq(m[1]));
    for (const b of src.matchAll(/i18n-begin[^]*?i18n-end/g)) for (const m of b[0].matchAll(/:\s*'((?:[^'\\\n]|\\.)*)'/g)) keys.add(unq(m[1]));
  }
  return [...keys];
}
const CLIENT_SCRIPTS = ['app.js', 'register.js', 'pages.js', 'home-map.js'];

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const icon = (name) => `<svg class="prb" aria-hidden="true"><use href="/sprite.svg#prb-${name}"></use></svg>`;
const short = (s) => (String(s).length < 16 ? String(s) : String(s).slice(0, 10) + '…' + String(s).slice(-6));
const num = (n) => Number(n).toLocaleString(locale());
const h0x = (b) => '0x' + bytesToHex(b);
function psy(wei, dp = 4) {
  wei = BigInt(wei);
  const neg = wei < 0n; if (neg) wei = -wei;
  const i = wei / PSY, f = (wei % PSY).toString().padStart(18, '0').slice(0, dp).replace(/0+$/, '');
  const point = lang() === 'en' ? '.' : (1.5).toLocaleString(locale()).charAt(1);
  return (neg ? '-' : '') + i.toLocaleString(locale()) + (f ? point + f : '');
}
const gwei = (wei) => (Number(wei) / 1e9).toLocaleString(locale(), { maximumFractionDigits: 3 });
function ago(sec, now) {
  const d = Math.max(0, now - sec);
  if (d < 60) return T('{n}s ago', { n: d });
  if (d < 3600) return T('{n}m ago', { n: Math.floor(d / 60) });
  if (d < 86400) return T('{n}h ago', { n: Math.floor(d / 3600) });
  return T('{n}d ago', { n: Math.floor(d / 86400) });
}
const when = (t) => (t ? new Date(Number(t) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '–');
const badge = (t, on = false) => `<span class="st ${on ? 'on' : 'off'}">${esc(T(t))}</span>`;

const NAV = [
  ['Explorer', 'layers', [['/', 'home', 'Home'], ['/dag', 'git-branch', 'Block DAG'], ['/blocks', 'box', 'Chain blocks'], ['/txs', 'swap', 'Transactions'],
    ['/mempool', 'swap', 'Pending transactions'], ['/holders', 'list', 'Top holders'], ['/emission', 'chart-line', 'Emission and supply'], ['/account', 'key', 'My account']]],
  ['Register', 'badge', [['/register/miner', 'cpu', 'Register your miner'], ['/register/ngo', 'id', 'Register a miner for your NGO']]],
  ['Governance', 'shield', [['/ngos', 'list', 'NGO register'], ['/ngo-submit', 'upload', 'Submit and mint'], ['/attestation', 'badge', 'Attestation'],
    ['/election', 'check', 'NGO election'], ['/election-rounds', 'check', 'All election rounds'], ['/proposals', 'clipboard', 'Proposals'], ['/governance', 'clipboard', 'Vote and propose'],
    ['/roles', 'id', 'Roles and candidacy'], ['/treasury', 'wallet', 'Treasury and funds'], ['/upgrades', 'refresh', 'Upgrades and council'], ['/pause', 'pause', 'Emergency pause']]],
  ['Network', 'globe', [['/network', 'globe', 'Network and peers'], ['/mining', 'cpu', 'Mining statistics'], ['/committee', 'lock', 'Finality committee'],
    ['/metrics', 'chart-line', 'Decentralisation metrics'], ['/run-a-node', 'server', 'Run a node'], ['/mine', 'cpu', 'Mine'], ['/wallet', 'key', 'Wallet set-up']]],
  ['Developers', 'server', [['/developers', 'clipboard', 'RPC and API'], ['/contracts', 'box', 'Contracts (read)'], ['/about', 'info', 'About']]],
];
const BAND = new Set(['/dag', '/blocks', '/txs', '/emission', '/network', '/ngos', '/ngo-submit', '/attestation', '/election', '/governance', '/roles', '/treasury', '/committee', '/metrics', '/run-a-node', '/mine', '/wallet', '/about',
  '/mempool', '/holders', '/account', '/election-rounds', '/proposals', '/mining', '/developers', '/contracts', '/upgrades', '/pause']);
/** PSY still held by the three Dev Account vesting contracts. */
const devHeld = (view) => DEV_ACCOUNTS.reduce((t, a) => t + view.getAccount(ADDR[a.key]).balance, 0n);
const ROLE_NAMES = ['CEO', 'CTO', 'Treasurer', 'Community Lead', 'Security Lead'];

// Step-by-step help for new users, shown under the heading of the governance pages (keyed by page title).
const GUIDES = {
  Governance: { need: 'A browser wallet (MetaMask or similar) on this network, and PSY locked for voting.', steps: [
    ['Get PSY', 'Mine it (<a href="/mine">Mine</a>): there is no airdrop or sale.'],
    ['Lock PSY', 'On <a href="/election">NGO election</a>, use "Lock PSY for voting". Locked PSY is your voting weight; you can unlock it after your votes close.'],
    ['Connect', 'Press "Connect wallet" below. The page asks your wallet to switch to this network.'],
    ['Vote', 'Find the proposal in the table (or on <a href="/proposals">Proposals</a>), enter its number, choose Yes, No or Abstain and send.'],
    ['Count and execute', 'After 5 days anyone presses "Count a finished vote"; a passed proposal can be executed by anyone 48 hours later.'],
  ] },
  Proposals: { need: 'Nothing: this page only shows proposals.', steps: [
    ['Pick a proposal', 'Open its number to see exactly what it would do, who voted and what it still needs to pass.'],
    ['Check the floor', 'Each proposal shows the floor it must reach (5 % or 10 % of locked PSY, or enough yes voters).'],
    ['Vote', 'Voting itself is on <a href="/governance">Vote and propose</a>.'],
  ] },
  'NGO election': { need: 'PSY locked for voting, ideally for 30 days before you vote (recently locked PSY counts less).', steps: [
    ['Lock PSY', 'Use "Lock PSY for voting" below. Your ballot counts at most your average locked PSY over the last 30 days.'],
    ['Connect', 'Press "Connect wallet" (the page switches your wallet to this network).'],
    ['Choose NGOs', 'In "Cast a ballot", enter the round number and the wallets of every NGO you approve, one per line; approve as many as you trust.'],
    ['Send', 'Send the ballot. Your locked PSY stays locked until the round closes.'],
    ['NGOs', 'An attested NGO stands with "Stand as a candidate" from its own wallet.'],
  ] },
  'Election rounds': { need: 'Nothing: this page only shows rounds.', steps: [
    ['Find a round', 'The newest rounds are first; open one for every candidate, their approvals and the ballots.'],
    ['First election', 'In the first election each winner also needs approvals from at least 5 different voters.'],
  ] },
  Attestation: { need: 'NGOs: a minted record. Miners: 100 blue blocks mined over at least 4 weeks and 1,000 PSY per vouch.', steps: [
    ['NGO', 'Mint your record on <a href="/ngo-submit">Submit and mint</a>, then ask five miners you know to vouch for you.'],
    ['Miner', 'To vouch, enter the NGO wallet in "Vouch for an NGO" and send the bond (returned one year later unless the NGO is rejected).'],
    ['Anyone', 'If an NGO looks false, "Challenge" it during its 7-day window with a reason; elected NGOs or a token vote decide.'],
    ['Done', 'With no challenge after 7 days, anyone presses "Finalise": the NGO is attested and can stand in elections.'],
  ] },
  'Submit and mint': { need: 'The NGO\'s own wallet, which must also mine (one mined block registers it), and 100 PSY for the fee.', steps: [
    ['Mine', 'Mine with the NGO wallet until it has PSY (<a href="/mine">Mine</a>).'],
    ['Register', 'Register that wallet as a miner (form below).'],
    ['Publish', 'Publish your dossier (registration, governing body, annual report, funders) online and mint the record with its hash.'],
    ['Attestation', 'Ask five miners to vouch (<a href="/attestation">Attestation</a>).'],
  ] },
  Roles: { need: 'Candidates: an individual wallet (not an NGO). Voters: an elected NGO wallet.', steps: [
    ['Stand', 'Individuals stand for a role with a refundable deposit while the round takes candidates (14 days).'],
    ['Vote', 'Elected NGOs vote, one NGO one vote, for 14 days.'],
    ['Result', 'The most votes wins a 1-year term; a tie is decided by a verifiable draw. Holders are paid from the Treasury and cannot vote.'],
  ] },
  Treasury: { need: 'Nothing: this page only shows balances.', steps: [
    ['Read', 'Where the PSY is: the Treasury, the team vesting, the NGO pool and the committee contract.'],
    ['Spend', 'The Treasury pays only after a Treasury proposal passes (see <a href="/governance">Vote and propose</a>).'],
  ] },
  'Finality committee': { need: 'To serve: an elected NGO wallet or a registered miner, a bond and a node that stays online.', steps: [
    ['What it is', 'Every week 21 members (6 NGOs, 15 miners) are drawn at random. Every 30 chain blocks they sign the chain; with 15 signatures that part is final and can never be undone.'],
    ['Join', 'Bond PSY with "Bond to be drawn" from your NGO or miner wallet, and run a node with <code>--signer-key</code>.'],
    ['Earn', 'Members who sign at least half of the checkpoints share 2 % of the mining reward of their week ("Claim").'],
    ['Rules', 'Signing two different checkpoints for the same number burns 90 % of the bond. Leaving takes 14 days.'],
  ] },
};

// (pages pass their title already translated: the guide is found by its English key or its translation)
function guideHtml(title) {
  const g = GUIDES[title] ?? Object.entries(GUIDES).find(([k]) => T(k) === title)?.[1];
  if (!g) return '';
  return `<section class="panel guide" aria-label="${T('How to use this page')}"><h2 class="h5">${T('New here? How this page works')}</h2>` +
    `<ol class="steps">${g.steps.map(([h, t], i) => `<li><span class="n">${i + 1}</span><div><strong>${T(h)}</strong><p>${T(t)}</p></div></li>`).join('')}</ol>` +
    `<p class="muted small mb-0"><strong>${T('You need:')}</strong> ${T(g.need)}</p></section>`;
}

const MODES = ['Bootstrap', 'Normal', 'Interim'];
const NGO_STATUS = ['none', 'minted, waiting for vouches', 'attested', 'rejected or removed'];

export class Explorer {
  constructor(node) {
    this.node = node;
    this.cache = new Map();
    this.chain = node.chain;
    this.p = node.params;
    const arts = artifacts();
    this.abi = {};
    this.c = {};
    const map = { GovernanceMode: 'governanceMode', Params: 'params', MinerRegistry: 'minerRegistry', NGORegistry: 'ngoRegistry', Attestation: 'attestation',
      VoteEscrow: 'voteEscrow', NGOElection: 'ngoElection', RoleElection: 'roleElection', Governor: 'governor', Treasury: 'treasury', DevVesting: 'devVesting', DevVesting2: 'devVesting2', DevVesting3: 'devVesting3',
      NGORewards: 'ngoRewards', FinalityCommittee: 'finalityCommittee', FundApprovals: 'fundApprovals', DevCouncil: 'devCouncil', UpgradeRegistry: 'upgradeRegistry',
      EmergencyPause: 'emergencyPause' };
    for (const [name, key] of Object.entries(map)) {
      const a = arts[artifactName(name)];
      this.c[name] = { addr: ADDR[key], codec: contract(a.abi, keccak256), abi: a.abi };
    }
    this.labels = new Map(Object.entries(map).map(([name, key]) => [bytesToHex(ADDR[key]), name]));
    for (const d of DEV_ACCOUNTS) this.labels.set(bytesToHex(ADDR[d.key]), `${d.label} vesting`);
    this.labels.set('000000000000000000000000000000000000dead', 'Burn address');
    // custom errors by selector, so pages can explain why a transaction would fail
    const errors = {};
    for (const x of Object.values(arts)) for (const e of x.abi.filter((f) => f.type === 'error')) {
      const sig = `${e.name}(${e.inputs.map((i) => i.type).join(',')})`;
      errors['0x' + bytesToHex(keccak256(new TextEncoder().encode(sig)).slice(0, 4))] = sig;
    }
    this.errors = errors;
    this.clientKeys = clientKeysOf(CLIENT_SCRIPTS.map((f) => { try { return readResource('node/web/' + f).toString('utf8'); } catch { return ''; } }));
    this.abiJson = JSON.stringify({
      ...Object.fromEntries(Object.entries(this.c).map(([n, x]) => [n, {
        address: h0x(x.addr), abi: x.abi.filter((f) => f.type === 'function'),
        selectors: Object.fromEntries([...x.codec.functions.values()].flat().map((y) => [y.sig, '0x' + bytesToHex(y.sel)])),
      }])),
      _errors: errors,
    });
  }

  /** Run several contract reads on one consistent tip state: fn(read) where read(contract, fn, args) -> decoded. */
  reads(fn) {
    return this.chain.readAtTip(async (view, ctx) => {
      const read = async (name, f, args = []) => {
        const c = this.c[name];
        const r = await contractCall(view, this.p, ctx, { to: c.addr, data: c.codec.encode(f, args), commit: false });
        if (!r.status) return null;
        return c.codec.decode(f, r.returnValue, args.length);
      };
      return fn(read, view);
    });
  }

  // ---------------------------------------------------------------- HTTP

  async handle(req, res, url) {
    if (STATIC[url.pathname]) return this.serve(req, res, url);
    // every page and API answer is in the visitor's language; ?lang= also remembers the choice for a year
    const l = requestLang(url.searchParams, req.headers);
    if (l.set) res.setHeader('Set-Cookie', `lang=${l.code}; Path=/; Max-Age=31536000; SameSite=Lax`);
    res.setHeader('Vary', 'Accept-Language, Cookie');
    return withLang(l.code, () => this.serve(req, res, url), { path: url.pathname, query: url.search });
  }

  async serve(req, res, url) {
    const p = url.pathname;
    if (STATIC[p]) {
      const file = p === '/abicodec.js' ? 'common/abicodec.js' : 'node/web' + p;
      try {
        const body = readResource(file);
        res.writeHead(200, { 'Content-Type': STATIC[p], 'Cache-Control': 'public, max-age=300', ...HEADERS });
        res.end(body);
      } catch { res.writeHead(404, HEADERS).end(); }
      return true;
    }
    const send = (code, body, type = 'text/html; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...HEADERS }); res.end(body); return true; };
    try {
      if (p === '/api/map') return send(200, JSON.stringify(await this.mapData(url.searchParams)), 'application/json');
      if (p === '/api/summary') return send(200, JSON.stringify(this.summary()), 'application/json');
      if (p === '/api/abi') return send(200, this.abiJson, 'application/json');
      if (p === '/api/metrics') return send(200, JSON.stringify(await this.metricsData()), 'application/json');
      if (p === '/api/mining') return send(200, JSON.stringify(this.miningData()), 'application/json');
      if (p === '/api/dag') return send(200, JSON.stringify(this.dagData(Number(url.searchParams.get('n') || 60))), 'application/json');
      await this.refreshMode();
      await this.refreshPause();
      // pages are cached per tip for 5 seconds: many contract reads hold the chain lock
      const key = lang() + ':' + p + '?' + url.searchParams.toString();
      const hit = this.cache.get(key);
      let page;
      if (hit && hit.tip === this.chain.tip.hash && Date.now() - hit.at < 5000) page = hit.page;
      else {
        page = await this.route(p, url.searchParams);
        if (this.cache.size > 500) this.cache.clear();
        this.cache.set(key, { tip: this.chain.tip.hash, at: Date.now(), page });
      }
      if (page?.redirect) { res.writeHead(302, { Location: page.redirect, ...HEADERS }); res.end(); return true; }
      if (page) return send(200, page);
      return send(404, this.layout(T('Not found'), `<h1>${T('Not found')}</h1><p class="muted">${T('That page is not on this explorer.')}</p>` + this.searchBox(), ''));
    } catch (e) {
      this.node.log(`explorer ${p}: ${e.stack ?? e.message}`);
      return send(500, this.layout(T('Error'), `<h1>${T('Something went wrong')}</h1><p class="muted">${T('The page could not be built. Try again in a moment.')}</p>`, ''));
    }
  }

  async route(p, q) {
    const page = Math.min(10_000, Math.max(0, Number.parseInt(q.get('page') || '0', 10) || 0));
    if (p === '/') return this.home();
    if (p === '/proposals') return this.proposalsPage(q);
    if (p.startsWith('/proposal/')) return this.proposalPage(decodeURIComponent(p.slice(10)), q);
    if (p === '/election-rounds') return this.electionRoundsPage(q);
    if (p.startsWith('/election-round/')) return this.electionRoundPage(decodeURIComponent(p.slice(16)), q);
    if (p === '/account') return this.accountPage(q);
    if (p === '/mining') return this.miningPage();
    if (p === '/mempool') return this.mempoolPage(q);
    if (p === '/holders') return this.holdersPage(q);
    if (p.startsWith('/committee/')) return this.committeeEpochPage(decodeURIComponent(p.slice(11)));
    if (p === '/developers') return this.developersPage();
    if (p === '/contracts') return this.contractsPage();
    if (p.startsWith('/contract/')) return this.contractPage(decodeURIComponent(p.slice(10)));
    if (p === '/dag') return this.dagPage();
    if (p === '/blocks') return this.blocksPage(page);
    if (p.startsWith('/block/')) return this.blockPage(decodeURIComponent(p.slice(7)));
    if (p === '/txs') return this.txsPage();
    if (p.startsWith('/tx/')) return this.txPage(decodeURIComponent(p.slice(4)));
    if (p.startsWith('/address/')) return this.addressPage(decodeURIComponent(p.slice(9)));
    if (p === '/emission') return this.emissionPage();
    if (p === '/network') return this.networkPage();
    if (p === '/ngos') return this.ngosPage();
    if (p.startsWith('/ngo/')) return this.ngoPage(decodeURIComponent(p.slice(5)));
    if (p === '/ngo-submit') return this.submitPage();
    if (p === '/register/miner') return this.registerMinerPage();
    if (p === '/register/ngo') return this.registerNgoPage();
    if (p === '/attestation') return this.attestationPage();
    if (p === '/election') return this.electionPage();
    if (p === '/governance') return this.governancePage();
    if (p === '/roles') return this.rolesPage();
    if (p === '/treasury') return this.treasuryPage();
    if (p === '/upgrades') return this.upgradesPage();
    if (p === '/pause') return this.pausePage();
    if (p.startsWith('/role-round/')) return this.roleRoundPage(decodeURIComponent(p.slice(12)));
    if (p === '/committee') return this.committeePage();
    if (p === '/metrics') return this.metricsPage();
    if (p === '/run-a-node') return this.runNodeTabsPage();
    if (p === '/mine') return this.minePage();
    if (p === '/wallet') return this.walletPage();
    if (p === '/about') return this.aboutPage();
    if (p === '/search') return this.search(String(q.get('q') || '').trim());
    return null;
  }

  now() { return Math.floor(Date.now() / 1000); }

  // ---------------------------------------------------------------- layout

  layout(title, body, active, { head = '', scripts = '' } = {}) {
    title = T(title); // pages may pass the English title (a translated one is returned as it is)
    const m = BAND.has(active) && /^(<p class="eyebrow">[^]*?<\/p><h1>[^]*?<\/h1>)(<p class="lead">[^]*?<\/p>)?/.exec(body);
    if (m) {
      body = `<section class="band"><canvas class="web-band" aria-hidden="true"></canvas><div class="band-head">${m[1]}${m[2] ?? ''}</div></section>` +
        `<div class="rail" id="block-rail" aria-label="${T('Latest chain blocks')}"></div>` + guideHtml(title) + body.slice(m[0].length);
      scripts = '<script src="/web-band.js"></script>' + scripts;
    }
    const link = ([href, ic, label]) => `<li><a class="dropdown-item${href === active ? ' active' : ''}" href="${href}">${icon(ic)}<span>${T(label)}</span></a></li>`;
    const nav = NAV.map(([group, ic, items], i) => {
      const on = items.some(([href]) => href === active || (href !== '/' && active.startsWith(href + '/')));
      return `<li class="nav-item dropdown"><a class="nav-link dropdown-toggle${on ? ' active' : ''}" href="#" id="nav${i}" role="button" data-bs-toggle="dropdown" aria-expanded="false">${icon(ic)}<span>${T(group)}</span></a>` +
        `<ul class="dropdown-menu dropdown-menu-end" aria-labelledby="nav${i}">${items.map(link).join('')}</ul></li>`;
    }).join('');
    const foot = `${TESTNET_NAME} · ${T('chain {id}', { id: this.p.chainId })} · ${T('block DAG (GHOSTDAG, k = {k})', { k: this.p.k })} · ${T('Testnet PSY is for testing only')} · ` +
      T('Use a new key for this network: never reuse a key that was used on any other network, because transactions signed with it could be replayed.');
    // the language menu: the same page in another language (?lang= also sets the cookie)
    const page = here(), keep = new URLSearchParams(page.query);
    keep.delete('lang');
    const langHref = (c) => { const q = new URLSearchParams(keep); q.set('lang', c); return esc(page.path + '?' + q.toString()); };
    const cur = LANGS.find((x) => x.code === lang());
    const langMenu = `<li class="nav-item dropdown"><a class="nav-link dropdown-toggle" href="#" id="navLang" role="button" data-bs-toggle="dropdown" aria-expanded="false" aria-label="${T('Language')}">${icon('globe')}<span>${esc(cur?.short ?? 'EN')}</span></a>` +
      `<ul class="dropdown-menu dropdown-menu-end" aria-labelledby="navLang">${LANGS.map((x) => `<li><a class="dropdown-item${x.code === lang() ? ' active' : ''}" href="${langHref(x.code)}" lang="${x.code}" dir="${x.dir}" hreflang="${x.code}" style="text-transform:none">${esc(x.name)}</a></li>`).join('')}</ul></li>`;
    const texts = this.clientKeys ? JSON.stringify(clientDict(this.clientKeys)).replace(/</g, '\\u003c') : '{}';
    return `<!doctype html><html lang="${lang()}" dir="${dir()}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
      `<title>${esc(title)} · ${T('PSYROB v{n} Explorer', { n: TESTNET_MAJOR })}</title><meta name="psyrob-network" content="${TESTNET_WALLET_NAME}"><link rel="icon" href="/logo.svg">` +
      '<link href="/vendor/fonts.css" rel="stylesheet"><link href="/vendor/bootstrap.min.css" rel="stylesheet">' +
      '<style>:root{--bg:#071014;--ink:#e7f4f2;--mute:#8aa8a6;--line:#1c3336;--cyan:#3ee0d6;--panel:#0c181c;--field:#081216}' +
      "body{background:var(--bg);color:var(--ink);font:18px/1.5 'Source Serif 4',Palatino,serif}a{color:var(--cyan)}" +
      '.navbar{background:rgba(7,16,20,.94);border-bottom:1px solid var(--line)}' +
      ".brand{letter-spacing:.22em;font-family:'Barlow Condensed',sans-serif;font-weight:600;color:var(--ink);font-size:18px}.brand img{width:34px;height:34px}" +
      ".nav-link{display:flex;align-items:center;gap:8px;color:var(--mute)!important;font-family:'Barlow Condensed',sans-serif;letter-spacing:.08em;text-transform:uppercase;font-size:14px;line-height:1}" +
      '.nav-link.active,.nav-link:hover{color:var(--ink)!important}.prb{width:14px;height:14px;color:var(--cyan);flex:0 0 14px}' +
      '.navbar-toggler{border:1px solid var(--line);padding:8px}.navbar-toggler .prb{width:18px;height:18px}' +
      ".test{font:600 12px/1 'Barlow Condensed',sans-serif;letter-spacing:.14em;color:#06201e;background:var(--cyan);padding:4px 7px}" +
      "h1,h2,h3{font-family:'Barlow Condensed',sans-serif;font-weight:600}h1{font-size:clamp(36px,7vw,64px);line-height:.95}" +
      ".eyebrow{color:var(--cyan);font:600 13px/1 'Barlow Condensed',sans-serif;letter-spacing:.16em;text-transform:uppercase}" +
      '.muted,.lead{color:var(--mute)!important}.panel{background:var(--panel);border:1px solid var(--line);padding:14px;margin-bottom:14px}' +
      ".stat strong{display:block;font:600 28px/1 'Barlow Condensed',sans-serif;margin-top:6px}.panel a,.stat strong{overflow-wrap:anywhere}" +
      '.form-control,.form-select{background:#081216;color:var(--ink);border:1px solid var(--line);border-radius:0}.form-control:focus{background:#081216;color:var(--ink)}' +
      ".btn-cyan{background:var(--cyan);color:#06201e;border:0;border-radius:0;font-family:'Barlow Condensed',sans-serif;letter-spacing:.1em;text-transform:uppercase}" +
      ".btn-line{background:transparent;color:var(--cyan);border:1px solid var(--line);border-radius:0;font-family:'Barlow Condensed',sans-serif;letter-spacing:.1em;text-transform:uppercase}" +
      'table{width:100%;border-collapse:collapse;min-width:640px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid var(--line);vertical-align:top}' +
      "th{color:var(--mute);font:500 13px/1 'Barlow Condensed',sans-serif;letter-spacing:.08em;text-transform:uppercase}code{color:var(--cyan);word-break:break-all}" +
      ".rail{display:flex;gap:14px;overflow:hidden;padding:8px 0 16px}.block-node{min-width:92px;text-align:center;color:var(--cyan)}.block-node svg{width:54px;height:54px}.block-node span{display:block;font:600 13px/1 'Barlow Condensed',sans-serif}" +
      '.dropdown-menu{background:var(--bg);border:1px solid var(--line);border-radius:0;padding:4px 0;min-width:210px}' +
      ".dropdown-item{display:flex;align-items:center;gap:8px;color:var(--mute);font:500 14px/1 'Barlow Condensed',sans-serif;letter-spacing:.08em;text-transform:uppercase;padding:10px 14px}" +
      '.dropdown-item:hover,.dropdown-item:focus,.dropdown-item.active{background:var(--panel);color:var(--ink)}' +
      ".st{display:inline-block;font:600 11px/1 'Barlow Condensed',sans-serif;letter-spacing:.12em;text-transform:uppercase;padding:3px 6px;white-space:nowrap}" +
      '.st.on{background:var(--cyan);color:#06201e}.st.off{border:1px solid var(--line);color:var(--mute)}.st.red{border:1px solid #6b3a3a;color:#d99}' +
      ".foot{border-top:1px solid var(--line);margin-top:28px;padding-top:10px;padding-bottom:28px;color:var(--mute);font:500 13px/1.4 'Barlow Condensed',sans-serif;letter-spacing:.08em;text-transform:uppercase}" +
      '.band{position:relative;min-height:210px;border:1px solid var(--line);overflow:hidden;margin-bottom:18px}.band canvas{position:absolute;inset:0;display:block}' +
      '.band-head{position:relative;padding:22px 20px}.band-head h1{margin:6px 0 8px}.band-head .lead{max-width:62ch;margin-bottom:0}@media (max-width:700px){.band{min-height:190px}}' +
      '.warn{border:1px solid #6b5a2a;background:#151208;color:#e8d9a8;padding:12px 14px;margin:12px 0}.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}' +
      'form.tx label{display:block;margin:8px 0 4px;color:var(--mute);font:500 13px/1 "Barlow Condensed",sans-serif;letter-spacing:.08em;text-transform:uppercase}form.tx .out{margin-top:8px;font-size:15px;overflow-wrap:anywhere}' +
      '#wallet-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:6px 0 14px}' +
      ".tn-banner{background:var(--cyan);color:#06201e;font:600 13px/1.3 'Barlow Condensed',sans-serif;letter-spacing:.1em;text-transform:uppercase;text-align:center;padding:6px 12px}" +
      ".pz-banner{border-bottom:1px solid #6b3a3a;background:#1a0b0b;color:#f0c4c4;font-size:15px;padding:10px 0}.pz-banner strong{font-family:'Barlow Condensed',sans-serif;letter-spacing:.08em;text-transform:uppercase}" +
      ".im-banner{border-bottom:1px solid #6b5a2a;background:#151208;color:#e8d9a8;font-size:15px;padding:10px 0}.im-banner strong{font-family:'Barlow Condensed',sans-serif;letter-spacing:.08em;text-transform:uppercase}" +
      '.dl-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:16px 0}.dl h3{font-size:1.05rem;margin:0 0 6px}.dl .btn{margin-top:4px}' +
      'ol.steps{counter-reset:s;list-style:none;padding-left:0}ol.steps>li{counter-increment:s;position:relative;padding:0 0 10px 40px}ol.steps>li::before{content:counter(s);position:absolute;left:0;top:0;width:28px;height:28px;border:1px solid var(--cyan);color:var(--cyan);display:flex;align-items:center;justify-content:center;font-size:.85rem}' +
      '.pager{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:12px 0}.tabs{display:flex;gap:6px;flex-wrap:wrap;margin:10px 0}.tabs button[aria-selected="true"]{background:var(--cyan);color:#06201e}' +
      'pre.code{background:var(--field);border:1px solid var(--line);padding:12px;overflow-x:auto;font-size:14px;color:var(--ink)}' +
      CHART_CSS +
      '.guide{border-left:3px solid var(--cyan)}.guide .steps{list-style:none;padding:0;margin:10px 0;display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}' +
      '.guide .steps li{display:flex;gap:10px;background:var(--field);border:1px solid var(--line);padding:10px}.guide .steps p{margin:4px 0 0;font-size:15px;color:var(--mute)}' +
      ".guide .n{flex:0 0 28px;height:28px;display:grid;place-items:center;background:var(--cyan);color:#06201e;font:600 15px/1 'Barlow Condensed',sans-serif}" +
      '.hm-facts{list-style:none;padding:0;margin:10px 0 0}.hm-facts li{padding:2px 0 2px 18px;position:relative;color:var(--mute)}.hm-facts li:before{content:"";position:absolute;left:2px;top:.7em;width:7px;height:7px;background:var(--cyan)}.hm-facts b{color:var(--ink);font-weight:600}' +
      '.turnout{border-left:3px solid var(--cyan)}.turnout strong{color:var(--cyan)}.turnout .bar{position:relative;height:8px;background:var(--field);border:1px solid var(--line);margin:10px 0 8px}' +
      '.turnout .bar i{display:block;height:100%;background:var(--cyan);animation:grow 1.2s ease-out}.turnout .bar span{position:absolute;top:-4px;bottom:-4px;width:1px;background:var(--mute)}' +
      '@keyframes grow{from{width:0}}@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}' +
      // right-to-left (Arabic): the layout mirrors; code, hashes and addresses stay left to right
      '[dir=rtl] th,[dir=rtl] td{text-align:right}[dir=rtl] .guide{border-left:0;border-right:3px solid var(--cyan)}[dir=rtl] .turnout{border-left:0;border-right:3px solid var(--cyan)}' +
      '[dir=rtl] ol.steps>li{padding:0 40px 10px 0}[dir=rtl] ol.steps>li::before{left:auto;right:0}[dir=rtl] .hm-facts li{padding:2px 18px 2px 0}[dir=rtl] .hm-facts li:before{left:auto;right:2px}' +
      '[dir=rtl] .navbar-nav{margin-left:0!important;margin-right:auto}[dir=rtl] .ms-auto{margin-left:0!important;margin-right:auto!important}[dir=rtl] .dropdown-menu-end{right:auto;left:0}' +
      'code,pre,.mono{direction:ltr;unicode-bidi:isolate}' +
      `</style><script type="application/json" id="psy-i18n">${texts}</script>` + head + '</head><body><nav class="navbar navbar-expand-lg sticky-top"><div class="container">' +
      `<a class="navbar-brand brand d-flex align-items-center gap-2" href="/"><img src="/logo.svg" alt="">PSYROB</a><span class="test d-none d-sm-inline">TESTNET v${TESTNET_MAJOR}</span>` +
      `<button class="navbar-toggler ms-auto" type="button" data-bs-toggle="collapse" data-bs-target="#siteNav" aria-controls="siteNav" aria-expanded="false" aria-label="${T('Open menu')}">${icon('menu')}</button>` +
      `<div class="collapse navbar-collapse" id="siteNav"><ul class="navbar-nav ms-auto">${nav}${langMenu}</ul></div></div></nav>` +
      `<div class="tn-banner" role="note">${T('Test network. No presale. Wallet loss is permanent.')}</div>` + this.pauseBanner() + this.interimBanner() +
      `<main class="container py-4">${body}</main><footer class="container foot">${esc(foot)}</footer>` +
      '<script src="/vendor/bootstrap.bundle.min.js"></script><script src="/live.js"></script>' + scripts + '</body></html>';
  }

  /** Shown on every page while the network is in Interim mode (fewer than 60 elected NGOs after the first 3 months). */
  interimBanner() {
    if (this.modeNow?.mode !== 2) return '';
    return `<div class="im-banner" role="status"><div class="container"><strong>${T('Interim mode.')}</strong> ${T('Fewer than 60 NGOs are elected.')} ` +
      T('Still working: mining, transfers, the explorer, NGO minting, attestation, NGO elections (supplementary rounds), locking PSY and Ordinary proposals.') + ' ' +
      T('Paused until 60 NGOs are elected: finality checkpoints, role elections, Treasury, parameter, fund and removal proposals.') + ' ' +
      T('The Interim Council (the NGOs elected so far) may only decide attestation challenges.') + '</div></div>';
  }

  async refreshMode() {
    if (this.modeNow?.tip === this.chain.tip.hash) return;
    const mode = await this.reads(async (read) => Number(await read('GovernanceMode', 'mode') ?? 0n)).catch(() => 0);
    this.modeNow = { tip: this.chain.tip.hash, mode };
  }

  searchBox(q = '') {
    return `<form class="row g-2 my-3" action="/search" method="get"><div class="col"><input class="form-control" name="q" value="${esc(q)}" placeholder="${T('Address, transaction hash, chain height or block hash')}" required></div><div class="col-auto"><button class="btn btn-cyan" type="submit">${T('Search')}</button></div></form>`;
  }

  addr(hexOrBytes) {
    if (!hexOrBytes || hexOrBytes.length === 0) return `<span class="muted">${T('contract creation')}</span>`;
    const h = typeof hexOrBytes === 'string' ? hexOrBytes.replace(/^0x/, '').toLowerCase() : bytesToHex(hexOrBytes);
    const label = this.labels.get(h);
    return `<a href="/address/0x${h}">${label ? esc(T(label)) : esc(short('0x' + h))}</a>`;
  }

  blockLink(e) { return `<a href="/block/0x${e.hash}"><code>${esc(short('0x' + e.hash))}</code></a>`; }

  /** A transaction form handled by /app.js in the browser wallet. fields: [[label, type, placeholder]] in argument order. */
  txForm(contractName, fn, title, fields, { value = null, warn = null, note = '' } = {}) {
    const inputs = fields.map(([label, type, ph = '', val = ''], i) => {
      const id = `f-${contractName}-${fn}-${i}`;
      if (type === 'file-hash') return `<label for="${id}">${esc(T(label))}</label><input class="form-control" id="${id}" data-i="${i}" data-kind="file-hash" type="file"><input class="form-control mt-1" data-hash-for="${i}" placeholder="${T('or paste the 0x SHA-256 hash')}" value="${esc(val)}">`;
      if (type === 'select') return `<label for="${id}">${esc(T(label))}</label><select class="form-select" id="${id}" data-i="${i}">${ph}</select>`;
      if (type === 'select-address') return `<label for="${id}">${esc(T(label))}</label><select class="form-select" id="${id}" data-i="${i}" data-kind="address">${ph}</select>`;
      return `<label for="${id}">${esc(T(label))}</label><input class="form-control" id="${id}" data-i="${i}" data-kind="${type}" placeholder="${esc(T(ph))}" value="${esc(val)}"${type === 'hidden' ? ' type="hidden"' : ''}>`;
    }).join('');
    const v = value === null ? '' : value === 'input' ? `<label>${T('Amount (PSY)')}</label><input class="form-control" data-value="psy" placeholder="0">` : `<input type="hidden" data-value="wei" value="${value}">`;
    const w = warn === 'loss' ? `<div class="warn"><label class="d-flex gap-2 m-0" style="text-transform:none;letter-spacing:0;font:inherit;color:inherit"><input type="checkbox" data-confirm required> ${T('I understand that this wallet is the NGO\'s identity. If its key is lost, nothing can recover or reassign it: the NGO must restart the whole process with a new wallet.')}</label></div>` : '';
    return `<form class="tx panel" data-c="${contractName}" data-f="${fn}" data-n="${fields.length}"><h3 class="h5">${esc(T(title))}</h3>${note ? `<p class="muted small">${T(note)}</p>` : ''}${inputs}${v}${w}` +
      `<button class="btn btn-cyan mt-3" type="submit">${T('Send with wallet')}</button><div class="out muted"></div></form>`;
  }

  walletBar() {
    return `<div id="wallet-bar"><button class="btn btn-line" id="wallet-connect" type="button">${T('Connect wallet')}</button><span class="muted" id="wallet-status">${T('No wallet connected.')} ` +
      `${T('Pages that change state use your browser wallet on chain {id}.', { id: this.p.chainId })}</span></div>`;
  }

  appScripts() { return '<script type="module" src="/app.js"></script>'; }

  // ---------------------------------------------------------------- data

  summary() {
    const c = this.chain;
    const blocks = c.chain.slice(-12).map((h) => { const e = c.dag.get(h); return { height: e.chainHeight, hash: '0x' + e.hash }; });
    return { height: c.tip.chainHeight, blueScore: c.tip.blueScore, blocks };
  }

  mapCenter() {
    const bal = this.chain.state.getAccount(ADDR.ngoRewards).balance;
    return { address: h0x(ADDR.ngoRewards), label: T('NGO pool'), psy: Number(bal / 10n ** 12n) / 1e6, valueText: psy(bal) };
  }

  mapBlock(e) {
    const merged = (e.mergesetBlues ?? []).concat(e.mergesetReds ?? []).filter((x) => x !== e.selectedParent).map((x) => {
      const m = this.chain.dag.get(x);
      return { hash: '0x' + x, miner: h0x(m.header.miner), red: (e.mergesetReds ?? []).includes(x) };
    });
    return { number: e.chainHeight, hash: '0x' + e.hash, parentHash: e.selectedParent ? '0x' + e.selectedParent : null, miner: e.chainHeight === 0 ? null : h0x(e.header.miner), timestamp: e.header.timestamp, txCount: (e.accepted ?? []).length, merged };
  }

  mapTx(cb, r, index) {
    const tx = this.chain.dag.get(r.block).body.txs.find((t) => bytesToHex(t.hash) === bytesToHex(r.txHash));
    return {
      hash: h0x(r.txHash), block: cb.chainHeight, index, ts: cb.header.timestamp, from: h0x(tx.from), to: tx.to.length ? h0x(tx.to) : null,
      contract: r.contractAddress ? h0x(r.contractAddress) : null, value: tx.value.toString(), psy: Number(tx.value / 10n ** 12n) / 1e6, valueText: psy(tx.value),
      kind: tx.to.length === 0 ? 'deploy' : tx.data.length ? 'call' : 'transfer', status: r.status, call: this.callName(tx),
    };
  }

  callName(tx) {
    if (!tx.to.length || tx.data.length < 4) return null;
    const name = this.labels.get(bytesToHex(tx.to));
    if (!name || !this.c[name]) return null;
    const sel = bytesToHex(tx.data.subarray(0, 4));
    for (const list of this.c[name].codec.functions.values()) for (const f of list) if (bytesToHex(f.sel) === sel) return `${name}.${f.f.name}`;
    return null;
  }

  recentTxs(max = 50, maxBlocks = 2000) {
    const c = this.chain, out = [];
    for (let h = c.tip.chainHeight; h > 0 && out.length < max && c.tip.chainHeight - h < maxBlocks; h--) {
      const cb = c.dag.get(c.chain[h]);
      (cb.receipts ?? []).forEach((r, i) => out.push(this.mapTx(cb, r, i)));
    }
    return out.slice(0, max);
  }

  /** Front-page figures (also sent with /api/map, in the same order, so the page updates them in place). */
  async stats() {
    const c = this.chain, t = c.tip, s = c.supply();
    const peers = this.node.p2p ? [...this.node.p2p.peers].filter((p) => p.ready).length : 0;
    const m = this.miningData();
    const g = await this.govFigures();
    const pct = (x) => (x * 100).toLocaleString(locale(), { maximumFractionDigits: 2 }) + ' %';
    return [
      [T('Chain height'), num(t.chainHeight)], [T('Blue score'), num(t.blueScore)], [T('DAG tips'), num(c.dag.tips.size)], [T('Peers'), num(peers)],
      [T('Base fee'), gwei(nextBaseFee(t.baseFee, t.gasUsed, this.p)) + ' gwei'], [T('Block gas use'), pct(m.gasUse)],
      [T('Difficulty'), T('{n} attempts', { n: num(BigInt(m.difficulty)) })], [T('Network rate'), T('{n} attempts/s', { n: num(Math.round(m.attemptsPerSecond)) })],
      [T('Mined so far'), psy(s.issuedMining, 0) + ' PSY'], [T('NGO pool so far'), psy(s.issuedNGO, 0) + ' PSY'], [T('Burned'), psy(s.burned, 0) + ' PSY'],
      [T('Locked for voting'), psy(BigInt(g.lockedPSY), 0) + ' PSY'], [T('Elected NGOs'), `${g.ngos.elected} / 100`], [T('Committee'), T('{n} / 21 members', { n: g.committee.members })],
      [T('Final checkpoint'), '#' + num(c.finalCheckpoint.number)], [T('Mode'), T(g.mode)],
    ];
  }

  /** Governance and participation figures (metricsData), computed once per tip. */
  async govFigures() {
    if (this.govCache?.tip === this.chain.tip.hash) return this.govCache.value;
    const value = (await this.metricsData()).governance;
    this.govCache = { tip: this.chain.tip.hash, value };
    return value;
  }

  /** The supply table on the front page: the locked 36/36/12/16 allocation and where the PSY is now. */
  async supplyTable() {
    const s = this.chain.supply();
    const d = await this.reads(async (read, view) => ({
      treasury: view.getAccount(ADDR.treasury).balance, dev: devHeld(view), ngoPool: view.getAccount(ADDR.ngoRewards).balance,
      fc: view.getAccount(ADDR.finalityCommittee).balance, locked: await read('VoteEscrow', 'totalLocked') ?? 0n,
    }));
    const circulating = s.genesisSupply + s.issuedMining + s.issuedNGO - s.burned - d.treasury - d.dev;
    const rows = [
      [T('Maximum supply'), num(1e9) + ' PSY', T('fixed')],
      [T('Mining pool (36 %)'), T('{n} PSY over decades', { n: num(36e7) }), T('{n} PSY issued to miners so far', { n: psy(s.issuedMining, 0) })],
      [T('NGO pool (36 %)'), T('{n} PSY over decades', { n: num(36e7) }), T('{a} PSY issued; {b} PSY in the NGO pool contract', { a: psy(s.issuedNGO, 0), b: psy(d.ngoPool, 0) })],
      [T('Team vesting (12 %)'), T('{a} PSY at genesis: {b} each for Dev Accounts 1, 2 and 3', { a: num(12e7), b: num(4e7) }), T('{n} PSY still in the three vesting contracts (no powers)', { n: psy(d.dev, 0) })],
      [T('Community/Treasury (16 %)'), T('{n} PSY at genesis', { n: num(16e7) }), T('{n} PSY in the Treasury (spent only by a Treasury vote)', { n: psy(d.treasury, 0) })],
      [T('Burned'), T('base fees and minting fees'), `${psy(s.burned, 0)} PSY`],
      [T('Locked for voting'), T('held in the vote escrow'), `${psy(d.locked, 0)} PSY`],
      [T('Committee bonds and rewards'), T('held in the committee contract'), `${psy(d.fc, 0)} PSY`],
      [T('Circulating'), T('issued, minus burned, Treasury and team vesting'), `${psy(circulating, 0)} PSY`],
    ].map(([a, b, c2]) => `<tr><th>${esc(a)}</th><td>${esc(b)}</td><td>${esc(c2)}</td></tr>`).join('');
    return `<section class="mt-4" aria-labelledby="hm-supply-title"><h2 id="hm-supply-title">${T('Supply')}</h2><div class="table-responsive"><table>` +
      `<thead><tr><th>${T('Part')}</th><th>${T('Size')}</th><th>${T('Now')}</th></tr></thead><tbody>${rows}</tbody></table></div><p class="muted small">${T('No presale and no airdrop: PSY is obtained by mining. See <a href="/emission">Emission and supply</a>.')}</p></section>`;
  }

  async mapData(q) {
    const c = this.chain;
    const since = /^\d{1,10}$/.test(q.get('since') ?? '') ? Number(q.get('since')) : null;
    const hash = String(q.get('hash') ?? '').toLowerCase();
    const delta = since !== null && since <= c.tip.chainHeight && c.tip.chainHeight - since <= 50 && c.chain[since] && '0x' + c.chain[since] === hash;
    let blocks, txs;
    if (delta) {
      blocks = []; txs = [];
      for (let h = since + 1; h <= c.tip.chainHeight; h++) {
        const e = c.dag.get(c.chain[h]);
        blocks.push(this.mapBlock(e));
        (e.receipts ?? []).forEach((r, i) => txs.push(this.mapTx(e, r, i)));
      }
    } else {
      blocks = c.chain.slice(Math.max(1, c.tip.chainHeight - 4), c.tip.chainHeight + 1).map((h) => this.mapBlock(c.dag.get(h)));
      txs = this.recentTxs(60);
    }
    const accounts = {};
    const note = (hx) => {
      if (!hx || accounts[hx]) return;
      const label = this.labels.get(hx.slice(2));
      accounts[hx] = label ? { role: 'system', label: T(label) } : { role: c.state.getCode(fromHex(hx)).length ? 'contract' : '' };
    };
    for (const t of txs) { note(t.from); note(t.to); note(t.contract); }
    return {
      chainId: Number(this.p.chainId), targetSpacing: this.p.targetSpacing, reset: since !== null && !delta,
      tip: { number: c.tip.chainHeight, hash: '0x' + c.tip.hash, timestamp: c.tip.header.timestamp },
      genesis: { hash: h0x(c.genesisHash), timestamp: c.genesisTime }, center: this.mapCenter(), blocks, txs, accounts, stats: await this.stats(), radar: await this.radarData(),
    };
  }

  dagData(n) {
    const c = this.chain;
    const all = [...c.dag.blocks.values()].sort((a, b) => (a.blueWork < b.blueWork ? 1 : -1)).slice(0, Math.min(300, Math.max(10, n)));
    return all.map((e) => ({
      hash: '0x' + e.hash, parents: e.parents.map((p) => '0x' + p), selectedParent: e.selectedParent ? '0x' + e.selectedParent : null, blueScore: e.blueScore,
      chainHeight: e.chainHeight, onChain: c.chain[e.chainHeight] === e.hash,
      colour: e === c.dag.genesis ? 'blue' : c.acceptedBy.get(e.hash)?.colour ?? 'pending', mergedBy: c.acceptedBy.get(e.hash) ? '0x' + c.acceptedBy.get(e.hash).by : null,
      mergeset: (e.mergesetBlues ?? []).length + (e.mergesetReds ?? []).length, miner: h0x(e.header.miner), txs: e.body?.txs?.length ?? 0, time: e.header.timestamp,
    }));
  }

  // ---------------------------------------------------------------- chain pages

  async home() {
    const p = this.p, c = this.chain, now = this.now();
    const radar = await this.radarData();
    const lead = `<p class="lead">${T('PSYROB is a CPU-mined DAG consensus network that uses the Argon2d algorithm. The testnet is currently undergoing testing.')} ` +
      `${T('Rather than discarding parallel blocks, the network merges them and preserves the work they contain. The target block interval is approximately {s} seconds, with k = {k}.', { s: p.targetSpacing, k: p.k })}</p>` +
      `<ul class="hm-facts"><li><b>${T('Chain ID:')}</b> ${p.chainId} (0x${p.chainId.toString(16)})</li><li><b>${T('Network:')}</b> ${T('Testnet')}</li>` +
      `<li><b>${T('Token distribution:')}</b> ${T('Elected NGOs receive 36% of all PSY, issued on the same schedule as miner rewards.')}</li></ul>`;
    const legend = [['--hm-accent', '', 'from the NGO pool'], ['--hm-text', '', 'to the NGO pool'], ['--hm-muted', '', 'between others'], ['--hm-muted', ' class="dash"', 'block threads (parents)']]
      .map(([col, cls, t]) => `<li><i${cls} style="--c:var(${col})"></i>${T(t)}</li>`).join('');
    const map = `<section class="hm-map" aria-labelledby="hm-map-title"><div class="hm-map-head"><div><h2 id="hm-map-title">${T('The web')}</h2>` +
      `<p>${T('Transfers between addresses, and the newest chain blocks with the parallel blocks each one merged on neighbouring strands (red blocks muted).')}</p></div>` +
      `<p class="hm-feed"><i aria-hidden="true"></i><span id="hm-feed-txt">${T('Live · block {n}', { n: num(c.tip.chainHeight) })}</span></p></div>` +
      `<ul class="hm-legend" aria-label="${T('Line colours')}">${legend}</ul>` +
      `<div class="hm-canvas-box" id="hm-box"><canvas id="hm-graph" role="img" aria-label="${T('Live map of PSY transfers and DAG blocks')}">${T('The map needs JavaScript.')}</canvas><div id="hm-tip" hidden></div></div>` +
      `<div class="hm-gauges"><div class="hm-gauge"><h3>${T('Network health')}</h3><canvas id="hm-radar" aria-hidden="true"></canvas>` +
      `<ul class="hm-radar-list" id="hm-radar-list" aria-label="${T('Network health figures')}">${radar.map((x) => `<li><b>${esc(x.axis)}</b> ${esc(x.text)}</li>`).join('')}</ul></div>` +
      `<div class="hm-gauge hm-heat"><h3>${T('Transactions by chain height')}</h3><div class="hm-strip" id="hm-strip" aria-hidden="true"></div>` +
      `<div class="hm-axis"><span>0</span><span>${T('BLOCK')}</span><span id="hm-axis-end"></span></div><ul class="hm-chips" id="hm-chips"></ul></div>` +
      `<div class="hm-gauge hm-count"><h3>${T('Chain height')}</h3><div class="hm-num" id="hm-blk">0</div>` +
      `<p>${T('<span id="hm-txc">0</span> transactions on the map<br><span id="hm-moved">0</span> PSY moved')}</p>` +
      `<div class="hm-bar" title="${T('Time to the next block')}" aria-hidden="true"><i id="hm-next"></i></div></div></div></section>`;
    const stats = (await this.stats()).map(([k, v]) => `<div class="hm-stat"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('');
    const supply = await this.supplyTable();
    const body = '<div class="hm" id="hm"><div class="hm-hero"><section class="hm-intro"><p class="eyebrow">' + T('{name} explorer', { name: TESTNET_NAME }) + '</p><h1>PSYROB</h1>' + lead +
      this.searchBox() + `<div class="rail" id="block-rail" aria-label="${T('Latest chain blocks')}"></div>` +
      '</section>' + map + '</div>' +
      `<dl class="hm-stats" id="hm-stats" aria-label="${T('Network figures')}">${stats}</dl>` + supply +
      `<section class="hm-txs" aria-labelledby="hm-tx-title"><h2 class="mt-4" id="hm-tx-title">${T('Latest transactions')}</h2><div id="hm-txs">` + this.txTable(this.recentTxs(10), now) + '</div></section></div>';
    return this.layout(T('Home'), body, '/', { head: '<link href="/home.css" rel="stylesheet"><style>.hm-radar-list{list-style:none;padding:0;margin:8px 0 0;font-size:13px;color:var(--mute)}.hm-radar-list b{color:var(--cyan);font:600 11px/1 "Barlow Condensed",sans-serif;letter-spacing:.1em;margin-right:4px}</style>', scripts: '<script src="/home-map.js"></script>' });
  }

  txTable(txs, now = this.now()) {
    const rows = txs.map((t) => `<tr><td><a href="/block/${t.block}">${t.block}</a><div class="muted">${esc(ago(t.ts, now))}</div></td><td><a href="/tx/${t.hash}">${esc(short(t.hash))}</a>${t.status === 0 ? ` <span class="muted">${T('failed')}</span>` : ''}</td>` +
      `<td>${this.addr(t.from)}</td><td>${t.to ? this.addr(t.to) : this.addr(t.contract) + ` <span class="muted">${T('(new contract)')}</span>`}${t.call ? `<div class="muted">${esc(t.call)}</div>` : ''}</td><td>${esc(t.valueText)} PSY</td></tr>`);
    return `<div class="table-responsive"><table><thead><tr><th>${T('Chain block')}</th><th>${T('Transaction')}</th><th>${T('From')}</th><th>${T('To')}</th><th>${T('Value')}</th></tr></thead><tbody>${rows.join('') || `<tr><td colspan="5">${T('No transactions yet.')}</td></tr>`}</tbody></table></div>`;
  }

  dagPage() {
    const data = this.dagData(80);
    const rows = data.map((b) => `<tr><td><a href="/block/${b.hash}"><code>${esc(short(b.hash))}</code></a></td><td>${b.blueScore}</td><td>${b.onChain ? `${badge('chain', true)} #${b.chainHeight}` : badge('parallel')}</td>` +
      `<td>${b.colour === 'red' ? `<span class="st red">${T('red')}</span>` : b.colour === 'blue' ? badge('blue', true) : badge('not merged yet')}</td><td>${b.parents.length}</td><td>${this.addr(b.miner)}</td><td>${b.txs}</td><td>${esc(ago(b.time, this.now()))}</td></tr>`);
    const multi = data.filter((b) => b.parents.length > 1).length;
    const body = `<p class="eyebrow">${T('Block DAG')}</p><h1>${T('Multi-Parent Consensus')}</h1><p class="lead">${T('Every block may belong to the main chain or exist in parallel. Blocks may reference up to 10 parents. GHOSTDAG colours the well-connected blocks blue and orders all of them; the chain is the path of selected parents. Blue blocks earn the block reward, while red blocks earn nothing and their fees go to the block that merged them.')}</p>` +
      `<div class="panel"><h2 class="h5">${T('The graph')}</h2><p class="muted small">${T('The newest blocks, left to right by blue score. Every line is a parent link; the bright path is the selected chain.')} ` +
      `${T('Blue knots: blue blocks. Muted red knots: red blocks. Outlined knots: not merged yet. {m} of the last {n} blocks have two or more parents. Click a knot to open the block.', { m: multi, n: data.length })}</p>` +
      `<div style="overflow-x:auto"><canvas id="dag-graph" height="300" aria-label="${T('Graph of the newest DAG blocks with all parent links')}"></canvas></div></div>` +
      `<div class="table-responsive"><table><thead><tr><th>${T('Block')}</th><th>${T('Blue score')}</th><th>${T('Position')}</th><th>${T('Colour')}</th><th>${T('Parents')}</th><th>${T('Miner')}</th><th>${T('Txs')}</th><th>${T('Age')}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
    return this.layout(T('Block DAG'), body, '/dag', { scripts: '<script src="/dag-graph.js"></script>' });
  }

  blocksPage(pageNo) {
    const c = this.chain, size = 25, start = c.tip.chainHeight - pageNo * size, now = this.now();
    const rows = [];
    for (let h = start; h > start - size && h >= 0; h--) {
      const e = c.dag.get(c.chain[h]);
      const final = h <= c.finalCheckpoint.number * this.p.checkpointInterval && c.finalCheckpoint.number > 0;
      rows.push(`<tr><td><a href="/block/${h}">${h}</a></td><td>${this.blockLink(e)}</td><td>${h === 0 ? T('genesis') : this.addr(e.header.miner)}</td><td>${e.blueScore}</td>` +
        `<td>${(e.mergesetBlues ?? []).length} / ${(e.mergesetReds ?? []).length}</td><td>${(e.accepted ?? []).length}${(e.skipped ?? []).length ? ` <span class="muted">${T('({n} skipped)', { n: e.skipped.length })}</span>` : ''}</td>` +
        `<td>${gwei(e.baseFee)} gwei</td><td>${final ? badge('final', true) : badge('not final')}</td><td>${esc(ago(e.header.timestamp, now))}</td></tr>`);
    }
    const pager = (pageNo ? `<a href="/blocks?page=${pageNo - 1}">${T('Newer')}</a> ` : '') + (start - size >= 0 ? `<a href="/blocks?page=${pageNo + 1}">${T('Older')}</a>` : '');
    const body = `<p class="eyebrow">${T('Chain blocks')}</p><h1>${T('The Selected Chain')}</h1><p class="lead">${T('Each chain block accepts its mergeset, consisting of its selected parent and the parallel blocks it has merged, with their transactions ordered according to GHOSTDAG. Wallets display chain heights as block numbers.')}</p>` +
      this.searchBox() + `<div class="table-responsive"><table><thead><tr><th>${T('Height')}</th><th>${T('Hash')}</th><th>${T('Miner')}</th><th>${T('Blue score')}</th><th>${T('Merged blue / red')}</th><th>${T('Accepted txs')}</th><th>${T('Base fee')}</th><th>${T('Finality')}</th><th>${T('Age')}</th></tr></thead><tbody>${rows.join('')}</tbody></table></div><p>${pager}</p>`;
    return this.layout(T('Chain blocks'), body, '/blocks');
  }

  entryFor(ref) {
    const c = this.chain;
    if (/^\d{1,12}$/.test(ref)) return c.chain[Number(ref)] ? c.dag.get(c.chain[Number(ref)]) : null;
    if (/^0x[0-9a-fA-F]{64}$/.test(ref)) return c.dag.get(ref.slice(2).toLowerCase()) ?? null;
    return null;
  }

  blockPage(ref) {
    const e = this.entryFor(ref), c = this.chain;
    if (!e) return this.layout(T('Block'), `<h1>${T('Block not found')}</h1>` + this.searchBox(ref), '/blocks');
    const onChain = c.chain[e.chainHeight] === e.hash;
    const hd = e.header;
    const kv = [
      ['Hash', `<code>0x${e.hash}</code>`], ['Position', onChain ? T('chain block at height {h}', { h: e.chainHeight }) : T('parallel block (not on the selected chain)')],
      ['Blue score', e.blueScore], ['Parents', e.parents.map((p) => `<a href="/block/0x${p}"><code>${short('0x' + p)}</code></a>${p === e.selectedParent ? ` <span class="muted">${T('(selected)')}</span>` : ''}`).join('<br>') || T('none (genesis)')],
      ['Merged blue', (e.mergesetBlues ?? []).map((x) => `<a href="/block/0x${x}"><code>${short('0x' + x)}</code></a>`).join(' ') || '–'],
      ['Merged red', (e.mergesetReds ?? []).map((x) => `<a href="/block/0x${x}"><code>${short('0x' + x)}</code></a>`).join(' ') || '–'],
      ['Miner', e === c.dag.genesis ? T('genesis') : this.addr(hd.miner)], ['Time', when(hd.timestamp)], ['Target', '0x' + hd.target.toString(16).padStart(64, '0')],
      ['Base fee', gwei(e.baseFee) + ' gwei'], ['Gas used (accepted)', num(e.gasUsed ?? 0n)], ['State root', `<code>${h0x(e.stateRoot)}</code>`],
      ['Own transactions', (e.body?.txs ?? []).length], ['Children', [...e.children].map((x) => `<a href="/block/0x${x}"><code>${short('0x' + x)}</code></a>`).join(' ') || '–'],
    ].map(([k, v]) => `<tr><th>${T(k)}</th><td>${v}</td></tr>`).join('');
    const acc = (e.receipts ?? []).map((r, i) => this.mapTx(e, r, i));
    const skipped = (e.skipped ?? []).map((s) => `<tr><td><code>${short(h0x(s.hash))}</code></td><td><a href="/block/0x${s.block}"><code>${short('0x' + s.block)}</code></a></td><td>${esc(T(s.reason))}</td></tr>`).join('');
    const sys = (e.systemReceipts ?? []).map((s) => `<tr><td>${esc(s.label)}</td><td>${s.status ? badge('ok', true) : badge('reverted')}</td><td>${num(s.gasUsed)}</td><td>${esc(s.reason)}</td></tr>`).join('');
    const body = `<h1>${T('Block {ref}', { ref: onChain ? '#' + e.chainHeight : short('0x' + e.hash) })}</h1><div class="table-responsive"><table>${kv}</table></div>` +
      `<h2 class="mt-4">${T('Transactions accepted by this block')}</h2>${this.txTable(acc)}` +
      (skipped ? `<h2 class="mt-4">${T('Skipped transactions')}</h2><p class="muted">${T('Conflicting or no longer valid when their turn came in the DAG order. They paid nothing and changed nothing.')}</p><div class="table-responsive"><table><thead><tr><th>${T('Transaction')}</th><th>${T('In block')}</th><th>${T('Reason')}</th></tr></thead><tbody>${skipped}</tbody></table></div>` : '') +
      this.blockRewards(e) +
      (sys ? `<h2 class="mt-4">${T('System calls')}</h2><div class="table-responsive"><table><thead><tr><th>${T('Call')}</th><th>${T('Result')}</th><th>${T('Gas')}</th><th>${T('Note')}</th></tr></thead><tbody>${sys}</tbody></table></div>` : '');
    return this.layout(T('Block'), body, '/blocks');
  }

  txsPage() {
    const body = `<p class="eyebrow">${T('Transactions')}</p><h1>${T('Accepted transactions.')}</h1><p class="lead">${T('The newest transactions accepted by chain blocks. Pending transactions are shown on their own page until a chain block accepts them.')}</p>` +
      this.txTable(this.recentTxs(100));
    return this.layout(T('Transactions'), body, '/txs');
  }

  txPage(ref) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(ref)) return this.layout(T('Transaction'), `<h1>${T('Not a transaction hash')}</h1>` + this.searchBox(ref), '/txs');
    const rpc = this.node.rpc;
    const t = rpc.methods.eth_getTransactionByHash.call(rpc, ref);
    if (!t) return this.layout(T('Transaction'), `<h1>${T('Transaction not found')}</h1>` + this.searchBox(ref), '/txs');
    const r = rpc.methods.eth_getTransactionReceipt.call(rpc, ref);
    const kv = [['Hash', `<code>${t.hash}</code>`], ['Status', r ? (r.status === '0x1' ? badge('success', true) : badge('failed')) : badge('pending')], ['From', this.addr(t.from)],
      ['To', t.to ? this.addr(t.to) : T('contract creation')], ['Value', psy(BigInt(t.value)) + ' PSY'], ['Nonce', Number(t.nonce)], ['Gas limit', num(BigInt(t.gas))],
      ...(r ? [['Chain block', `<a href="/block/${Number(r.blockNumber)}">#${Number(r.blockNumber)}</a>`], ['Contained in DAG block', `<a href="/block/${r.dagBlock}"><code>${short(r.dagBlock)}</code></a>`],
        ['Gas used', num(BigInt(r.gasUsed))], ['Effective gas price', gwei(BigInt(r.effectiveGasPrice)) + ' gwei'], ['Contract created', r.contractAddress ? this.addr(r.contractAddress) : '–'], ['Logs', r.logs.length]] : []),
      ['Input', `<code>${esc(t.input.length > 300 ? t.input.slice(0, 300) + '…' : t.input)}</code>`]].map(([k, v]) => `<tr><th>${T(k)}</th><td>${v}</td></tr>`).join('');
    return this.layout(T('Transaction'), `<h1>${T('Transaction')}</h1><div class="table-responsive"><table>${kv}</table></div>${this.internalTransfers(r)}`, '/txs');
  }

  async addressPage(ref) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(ref)) return this.layout(T('Address'), `<h1>${T('Not an address')}</h1>` + this.searchBox(ref), '');
    const a = fromHex(ref);
    const info = await this.reads(async (read, view) => ({
      acc: view.getAccount(a), code: view.getCode(a).length, miner: await read('MinerRegistry', 'isRegistered', [ref]), mined: await read('MinerRegistry', 'minedTotal', [ref]),
      ngo: await read('NGORegistry', 'status', [ref]), elected: await read('NGOElection', 'isElected', [ref]), role: await read('RoleElection', 'isRoleHolder', [ref]),
      locked: await read('VoteEscrow', 'locked', [ref]),
    }));
    const txs = this.recentTxs(500, 5000).filter((t) => t.from === ref.toLowerCase() || t.to === ref.toLowerCase()).slice(0, 25);
    const kv = [['Address', `<code>${esc(ref)}</code>${this.labels.get(ref.slice(2).toLowerCase()) ? ` <span class="muted">(${esc(T(this.labels.get(ref.slice(2).toLowerCase())))})</span>` : ''}`],
      ['Balance', psy(info.acc.balance) + ' PSY'], ['Nonce', String(info.acc.nonce)], ['Kind', info.code ? T('contract') : T('account')],
      ['Miner', info.miner ? T('registered · {n} blue blocks', { n: num(info.mined ?? 0n) }) : T('{n} blue blocks · not registered', { n: num(info.mined ?? 0n) })],
      ['NGO', info.ngo ? `<a href="/ngo/${esc(ref)}">${T(NGO_STATUS[Number(info.ngo)])}</a>${info.elected ? ' · ' + badge('elected', true) : ''}` : '–'],
      ['Role holder', info.role ? badge('in office (cannot vote)', true) : '–'], ['Locked for voting', psy(info.locked ?? 0n) + ' PSY']].map(([k, v]) => `<tr><th>${T(k)}</th><td>${v}</td></tr>`).join('');
    return this.layout(T('Address'), `<h1>${T('Address')}</h1><div class="table-responsive"><table>${kv}</table></div><h2 class="mt-4">${T('Recent transactions')}</h2>${this.txTable(txs)}${this.addressRewards(ref.toLowerCase())}`, '');
  }

  search(q) {
    if (/^\d{1,12}$/.test(q)) return { redirect: '/block/' + q };
    if (/^0x[0-9a-fA-F]{40}$/.test(q)) return { redirect: '/address/' + q };
    if (/^0x[0-9a-fA-F]{64}$/.test(q)) return { redirect: this.chain.dag.has(q.slice(2).toLowerCase()) ? '/block/' + q : '/tx/' + q };
    return this.layout(T('Search'), `<h1>${T('Nothing found')}</h1><p class="muted">${T('Search for an address, a transaction hash, a chain height or a block hash.')}</p>` + this.searchBox(q), '');
  }

  /** Emission charts: reward per blue block and cumulative issue of each pool over the years, the allocation. */
  emissionCharts() {
    const p = this.p, c = this.chain, s = c.supply();
    const yr = Math.floor(365 * 86400 / p.targetSpacing);
    const P = (w) => Number(w / 10n ** 15n) / 1000;
    const reward = [], issued = [];
    for (let y = 0; y <= 40; y += 0.5) {
      reward.push([y, P(scheduledReward(Math.floor(y * yr), p))]);
      issued.push([y, P(cumulative(Math.floor(y * yr), p)) / 1e6]);
    }
    const now = c.tip.blueScore / yr;
    const fmtY = (v) => (v >= 100 ? Math.round(v).toLocaleString(locale()) : v.toLocaleString(locale(), { minimumFractionDigits: v < 1 ? 3 : 1, maximumFractionDigits: v < 1 ? 3 : 1 }));
    const year = (v) => T('year {n}', { n: Math.round(v) });
    return '<div class="charts">' +
      `<div class="panel"><h3>${T('Reward per blue block, each pool (PSY)')}</h3>${lineChart({ title: T('Reward per blue block over 40 years'), series: [{ name: T('Mining pool and NGO pool (same schedule)'), color: COLORS[0], points: reward }], fmtX: year, fmtY, marker: { x: now, label: T('now') } })}</div>` +
      `<div class="panel"><h3>${T('PSY issued so far, each pool (millions)')}</h3>${lineChart({ title: T('Cumulative issue of each pool over 40 years'), series: [{ name: T('Each pool, of 360 million'), color: COLORS[1], points: issued }], fmtX: year, fmtY, marker: { x: now, label: T('now') } })}</div>` +
      `<div class="panel"><h3>${T('Allocation of the {n} PSY', { n: num(1e9) })}</h3>${donut({ title: T('Allocation'), center: T('1B'), sub: T('PSY maximum'), parts: [{ label: T('Miners'), value: 36, color: COLORS[0] }, { label: T('NGOs'), value: 36, color: COLORS[1] }, { label: T('Treasury'), value: 16, color: COLORS[2] }, { label: T('Team (vesting)'), value: 12, color: COLORS[3] }] })}</div>` +
      `<div class="panel"><h3>${T('Issued and burned so far (PSY)')}</h3>${barChart({ title: T('Issued and burned'), items: [{ label: T('Mining pool'), value: P(s.issuedMining), color: COLORS[0] }, { label: T('NGO pool'), value: P(s.issuedNGO), color: COLORS[1] }, { label: T('Burned'), value: P(s.burned), color: COLORS[4] }], fmt: (v) => v.toLocaleString(locale(), { maximumFractionDigits: 2 }) })}</div>` +
      '</div>';
  }

  emissionPage() {
    const p = this.p, c = this.chain, s = c.supply();
    const genesis = s.genesisSupply, circulatingCap = p.maxSupply;
    const yr = Math.floor(365 * 86400 / p.targetSpacing);
    const rows = [0, 1, 2, 4, 8, 12, 20].map((y) => `<tr><td>${T('Year {n}', { n: y + 1 })}</td><td>${psy(scheduledReward(y * yr, p))} PSY</td><td>${psy(cumulative((y + 1) * yr, p) - cumulative(y * yr, p), 0)} PSY</td></tr>`).join('');
    const kv = [['Chain', `${p.chainId} (0x${p.chainId.toString(16)}), ${T('testnet')}`], ['Genesis hash', `<code>${h0x(c.genesisHash)}</code>`], ['Maximum supply', psy(circulatingCap, 0) + ' PSY'], ['Genesis (Treasury 16 % + team vesting 12 %)', psy(genesis, 0) + ' PSY'],
      ['Mining pool issued (36 % cap)', psy(s.issuedMining) + ' PSY'], ['NGO pool issued (36 % cap)', psy(s.issuedNGO) + ' PSY'], ['Burned (base fees and burn address)', psy(s.burned) + ' PSY'],
      ['Reward per blue block now', T('{n} PSY to each pool', { n: psy(scheduledReward(c.tip.blueScore, p)) })], ['Committee share of the mining reward', `${Number(p.committeeShareBps) / 100} %`],
      ['First-year cap', T('emission never runs ahead of an ideal 10-second chain')], ['Airdrops', T('none: PSY is obtained by mining')]].map(([k, v]) => `<tr><th>${T(k)}</th><td>${v}</td></tr>`).join('');
    const body = `<p class="eyebrow">${T('Emission and supply')}</p><h1>${T('36 % to miners, 36 % to NGOs.')}</h1><p class="lead">${T('Both pools follow the same smoothly decaying schedule: the reward per blue block falls a little each month and halves about every four years.')}</p>` +
      this.emissionCharts() + `<div class="table-responsive"><table>${kv}</table></div><h2 class="mt-4">${T('Schedule (each pool)')}</h2><div class="table-responsive"><table><thead><tr><th>${T('Period')}</th><th>${T('Reward per blue block at start')}</th><th>${T('Emitted in the year')}</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    return this.layout(T('Emission'), body, '/emission');
  }

  networkPage() {
    const n = this.node, c = this.chain;
    const peers = n.p2p ? n.p2p.info() : [];
    const rows = peers.map((p) => `<tr><td><code>${esc(p.id)}</code></td><td>${p.outbound ? T('outbound') : T('inbound')}${p.kind !== 'full' ? ` (${T(p.kind)})` : ''}</td><td>${p.ready ? badge('ready', true) : badge('connecting')}</td><td>${p.blueScore ?? '–'}</td><td>${num(p.bytesIn)} / ${num(p.bytesOut)}</td><td>${p.connectedSeconds}s</td></tr>`).join('');
    const am = n.p2p?.addrman;
    const kv = [['Node version', NODE_VERSION], ['Chain ID', String(this.p.chainId)], ['Genesis', `<code>${h0x(c.genesisHash)}</code>`], ['DAG blocks', num(c.dag.blocks.size)],
      ['Tips', num(c.dag.tips.size)], ['Orphans waiting', num(c.orphans.size)], ['Known addresses', am ? T('{a} ({b} tried)', { a: num(am.size), b: num(am.triedTable.size) }) : '–'],
      // a rough count of the network: node addresses
      // this node heard of, through gossip or a connection, in the last 24 hours. Nodes behind a NAT that never accept
      // connections may be missing; one operator can run several addresses.
      ['Nodes heard of (24 h)', am ? T('about {n}', { n: num(this.recentNodes(am)) }) : '–'],
      ['Sync', n.p2p?.syncing?.() ? T('catching up (blue score {a} of about {b})', { a: num(n.p2p.syncing().blueScore), b: num(n.p2p.syncing().target) }) : T('up to date')]].map(([k, v]) => `<tr><th>${T(k)}</th><td>${v}</td></tr>`).join('');
    const body = `<p class="eyebrow">${T('Network')}</p><h1>${T('Peers and this node.')}</h1><p class="lead">${T('Anyone can run a full node and connect. Nodes find each other through seeds and address gossip, keep 8 outbound connections spread over network groups, and accept up to 64 inbound.')}</p>` +
      `<div class="warn">${TESTNET_NAME}: ${T('chain ID {id}. Run node {v} or newer. Until the first finality committee is chosen, checkpoints are signed by bootstrap keys (2 of 3) for at most 12 months.', { id: this.p.chainId, v: NODE_VERSION })}</div>` +
      `<div class="table-responsive"><table>${kv}</table></div><h2 class="mt-4">${T('Connected peers')}</h2><div class="table-responsive"><table><thead><tr><th>${T('Peer')}</th><th>${T('Direction')}</th><th>${T('State')}</th><th>${T('Blue score')}</th><th>${T('Bytes in / out')}</th><th>${T('Connected')}</th></tr></thead><tbody>${rows || `<tr><td colspan="6">${T('No peers connected.')}</td></tr>`}</tbody></table></div>`;
    return this.layout(T('Network'), body, '/network');
  }

  // ---------------------------------------------------------------- NGO pages

  async ngoList() {
    return this.reads(async (read) => {
      const n = Number(await read('NGORegistry', 'ngoCount') ?? 0n);
      const list = n ? await read('NGORegistry', 'list', [0n, BigInt(Math.min(n, 1000))]) : [];
      const out = [];
      for (const a of list ?? []) {
        const rec = await read('NGORegistry', 'get', [a]);
        const vs = (await read('Attestation', 'vouchesOf', [a])) ?? [];
        out.push({ address: a, ...rec, elected: await read('NGOElection', 'isElected', [a]), vouches: vs.length, vouchers: vs.filter((v) => !v.withdrawn).map((v) => v.voucher.toLowerCase()), kase: await read('Attestation', 'caseOf', [a]) });
      }
      // P2: for each NGO, the other NGOs that share at least one active voucher with it (clusters run by one party
      // show up as NGOs that share vouchers)
      const byVoucher = new Map();
      for (const x of out) for (const v of x.vouchers) byVoucher.set(v, [...(byVoucher.get(v) ?? []), x]);
      for (const x of out) {
        const others = new Map();
        for (const v of x.vouchers) for (const y of byVoucher.get(v)) if (y !== x) others.set(y.address, y.name);
        x.sharesWith = [...others].map(([address, name]) => ({ address, name }));
      }
      return { out, mode: Number(await read('GovernanceMode', 'mode') ?? 0n), elected: Number(await read('NGOElection', 'electedCount') ?? 0n), term: Number(await read('NGOElection', 'currentTerm') ?? 0n) };
    });
  }

  async ngosPage() {
    const d = await this.ngoList();
    const rows = d.out.map((x) => `<tr><td><a href="/ngo/${x.address}">${esc(x.name)}</a><div class="muted">${esc(x.country)}</div></td><td>${this.addr(x.address)}</td><td>${esc(T(NGO_STATUS[Number(x.status)]))}</td><td>${x.vouches} / 5</td><td>${x.elected ? badge('elected', true) : badge('not elected')}</td><td>${when(x.mintedAt)}</td></tr>`).join('');
    const body = `<p class="eyebrow">${T('NGO register')}</p><h1>${T('100 seats, 1-year terms.')}</h1><p class="lead">${T('Order of the process: mine PSY with the NGO\'s own wallet, publish the dossier and mint the record on-chain, be attested by five miners, be elected. Finality checkpoints start once 60 NGOs are elected.')}</p>` +
      `<div class="grid2"><div class="panel stat">${T('Mode')}<strong>${T(MODES[d.mode])}</strong></div><div class="panel stat">${T('Elected this term')}<strong>${d.elected} / 100</strong></div><div class="panel stat">${T('Term')}<strong>${d.term || T('first election running')}</strong></div><div class="panel stat">${T('Records minted')}<strong>${d.out.length}</strong></div></div>` +
      `<div class="table-responsive"><table><thead><tr><th>${T('NGO')}</th><th>${T('Wallet (miner)')}</th><th>${T('Status')}</th><th>${T('Vouches')}</th><th>${T('Seat')}</th><th>${T('Minted')}</th></tr></thead><tbody>${rows || `<tr><td colspan="6">${T('No NGO has minted a record yet.')}</td></tr>`}</tbody></table></div>` +
      await this.ngoPoolSection();
    return this.layout(T('NGOs'), body, '/ngos');
  }

  async ngoPage(ref) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(ref)) return null;
    const d = await this.reads(async (read) => ({ rec: await read('NGORegistry', 'get', [ref]), vouches: await read('Attestation', 'vouchesOf', [ref]), kase: await read('Attestation', 'caseOf', [ref]),
      elected: await read('NGOElection', 'isElected', [ref]), last: await read('NGOElection', 'lastElectedTerm', [ref]), mined: await read('MinerRegistry', 'minedTotal', [ref]) }));
    if (!d.rec || Number(d.rec.status) === 0) return this.layout(T('NGO'), `<h1>${T('No NGO record at this address')}</h1>`, '/ngos');
    const r = d.rec;
    const kv = [['Name', esc(r.name)], ['Country', esc(r.country)], ['Legal registration', esc(r.registration)], ['Dossier', `<a href="${esc(/^(https?|ipfs):/.test(r.dossierURI) ? r.dossierURI : '#')}" rel="nofollow noopener">${esc(r.dossierURI)}</a>`],
      ['Dossier hash', `<code>${esc(r.dossierHash)}</code>`], ['Wallet (also its miner)', this.addr(ref) + ' · ' + T('{n} blue blocks', { n: num(d.mined ?? 0n) })], ['Status', esc(T(NGO_STATUS[Number(r.status)]))],
      ['Seat', d.elected ? badge('elected this term', true) : Number(d.last) ? T('last elected for term {n}', { n: d.last }) : T('not elected')], ['Minted', when(r.mintedAt)], ['Attested', when(r.attestedAt)],
      ['Challenge window ends', when(d.kase?.windowEnds)], ['Pending challenge', d.kase && d.kase.challenger !== '0x0000000000000000000000000000000000000000' ? this.addr(d.kase.challenger) + ' · ' + T('{a} uphold / {b} dismiss', { a: d.kase.upholdVotes, b: d.kase.dismissVotes }) : '–']]
      .map(([k, v]) => `<tr><th>${T(k)}</th><td>${v}</td></tr>`).join('');
    const me = (await this.ngoList()).out.find((x) => x.address.toLowerCase() === ref.toLowerCase());
    const shares = me?.sharesWith?.length ? me.sharesWith.map((y) => `<a href="/ngo/${y.address}">${esc(y.name)}</a>`).join(', ') : T('none');
    const vrows = (d.vouches ?? []).map((v) => `<tr><td>${this.addr(v.voucher)}</td><td>${psy(v.bond)} PSY</td><td>${when(v.at)}</td><td>${v.withdrawn ? T('returned or burned') : T('locked')}</td></tr>`).join('');
    const extras = await this.ngoExtras(ref) + await this.ngoPoolSection(ref);
    return this.layout(T('NGO'), `<h1>${esc(r.name)}</h1><div class="table-responsive"><table>${kv}</table></div>${extras}<h2 class="mt-4">${T('Vouches')}</h2><p class="muted">${T('Its vouchers also back: {list}', { list: shares })}</p><div class="table-responsive"><table><thead><tr><th>${T('Miner')}</th><th>${T('Bond')}</th><th>${T('When')}</th><th>${T('State')}</th></tr></thead><tbody>${vrows || `<tr><td colspan="4">${T('None yet.')}</td></tr>`}</tbody></table></div>`, '/ngos');
  }

  async submitPage() {
    const fee = await this.reads((read) => read('Params', 'get', ['0x' + Buffer.from('ngoMintFee').toString('hex').padEnd(64, '0')]));
    const body = `<p class="eyebrow">${T('Submit and mint')}</p><h1>${T('Register your NGO.')}</h1><p class="lead">${T('One wallet is the NGO: it mines, mints the record, is attested and is elected. Mine at least one block with it first (that is how it gets PSY for the fee; there is no airdrop).')}</p>` +
      this.walletBar() +
      `<div class="warn"><b>${T('Wallet loss is permanent.')}</b> ${T('There is no recovery and no reassignment. If the key is lost, the NGO must start again from the first step with a new wallet. Keep at least two offline backups of the key.')}</div>` +
      `<ol class="muted"><li>${T('Mine with the NGO wallet (<a href="/mine">how to mine</a>).')}</li><li>${T('Register that wallet as a miner (below).')}</li><li>${T('Publish the dossier off-chain (for example on IPFS or the NGO\'s website) and mint the record with its hash.')}</li><li>${T('Ask five registered miners to vouch (<a href="/attestation">Attestation</a>). After a 7-day challenge window the NGO is attested.')}</li><li>${T('Stand in the election (<a href="/election">NGO election</a>).')}</li></ol>` +
      '<div class="grid2">' +
      this.txForm('MinerRegistry', 'register', '1. Register the wallet as a miner', [['Operator label (optional, 0x… 32 bytes; empty = the address)', 'bytes32', '0x00…00', '0x' + '00'.repeat(32)]], { warn: 'loss' }) +
      this.txForm('NGORegistry', 'mint', '2. Mint the NGO record', [['Name', 'string', 'Example Foundation'], ['Country', 'string', 'NL'], ['Legal registration reference', 'string', 'Chamber of Commerce 12345678'],
        ['Dossier URI', 'string', 'ipfs://… or https://…'], ['Dossier file (its SHA-256 is stored)', 'file-hash']], { value: (fee ?? 100n * PSY).toString(), warn: 'loss', note: T('Minting fee: {n} PSY, burned.', { n: psy(fee ?? 100n * PSY) }) }) +
      this.txForm('NGORegistry', 'updateDossier', 'Publish a new dossier version (optional)', [['Dossier URI', 'string', 'ipfs://…'], ['Dossier file', 'file-hash']]) +
      '</div>';
    return this.layout(T('Submit and mint'), body, '/ngo-submit', { scripts: this.appScripts() });
  }

  async attestationPage() {
    const d = await this.ngoList();
    const params = await this.reads(async (read) => ({ bond: await read('Params', 'get', [pkey('vouchBond')]), cb: await read('Params', 'get', [pkey('challengeBond')]), minBlocks: await read('Params', 'get', [pkey('vouchMinBlocks')]), cap: await read('Params', 'get', [pkey('maxActiveVouches')]), epochs: await read('Params', 'get', [pkey('vouchMinEpochs')]) }));
    const waiting = d.out.filter((x) => Number(x.status) === 1);
    const rows = waiting.map((x) => {
      const k = x.kase, ch = k && k.challenger !== '0x0000000000000000000000000000000000000000';
      const sw = x.sharesWith.length ? (x.sharesWith.length > 1 ? T('{n} other NGOs:', { n: x.sharesWith.length }) : T('1 other NGO:')) + ' ' + x.sharesWith.slice(0, 5).map((y) => `<a href="/ngo/${y.address}">${esc(y.name)}</a>`).join(', ') + (x.sharesWith.length > 5 ? ' …' : '') : T('none');
      return `<tr><td><a href="/ngo/${x.address}">${esc(x.name)}</a></td><td>${x.vouches} / 5</td><td>${sw}</td><td>${Number(k?.windowEnds ?? 0n) ? when(k.windowEnds) : T('after the fifth vouch')}</td><td>${ch ? T('challenged · {a} uphold / {b} dismiss', { a: k.upholdVotes, b: k.dismissVotes }) : '–'}</td><td><code>${x.address}</code></td></tr>`;
    }).join('');
    const body = `<p class="eyebrow">${T('Attestation')}</p><h1>${T('Five miners vouch, anyone may challenge.')}</h1>` +
      `<p class="lead">${T('A registered miner with at least {blocks} blue blocks, mined in at least {weeks} different weeks, can vouch for an NGO by locking {bond} PSY for one term, for at most {cap} NGOs at a time. After five vouches a 7-day challenge window opens. A challenge locks {cb} PSY and is decided by the elected NGOs (the Interim Council in Interim mode), or by a token vote while too few NGOs are elected. If upheld, the vouchers\' locks are burned.', { blocks: num(params.minBlocks ?? 100n), weeks: num(params.epochs ?? 4n), bond: psy(params.bond ?? 0n), cap: num(params.cap ?? 10n), cb: psy(params.cb ?? 0n) })}</p>` +
      `<p>${T('New here? First <a href="/register/miner">register your miner</a>. NGOs: <a href="/register/ngo">register a miner for your NGO</a>.')}</p>` +
      `<p class="muted">${T('The five vouchers of an NGO must declare five different operators. "Its vouchers also back" lists the other NGOs vouched for by the same miners: many NGOs sharing vouchers can mean one party behind them, which is a reason to look closely and, if warranted, to challenge.')}</p>` +
      this.walletBar() +
      `<div class="table-responsive"><table><thead><tr><th>${T('NGO')}</th><th>${T('Vouches')}</th><th>${T('Its vouchers also back')}</th><th>${T('Window ends')}</th><th>${T('Challenge')}</th><th>${T('Wallet')}</th></tr></thead><tbody>${rows || `<tr><td colspan="6">${T('No NGO is waiting for attestation.')}</td></tr>`}</tbody></table></div>` +
      '<div class="grid2 mt-3">' +
      this.txForm('Attestation', 'vouch', 'Vouch for an NGO', [['NGO wallet', 'address', '0x…']], { value: String(params.bond ?? 0n) }) +
      this.txForm('Attestation', 'challenge', 'Challenge an attestation', [['NGO wallet', 'address', '0x…'], ['Reason (its keccak hash is stored; publish the text yourself)', 'text-hash', 'The registration number does not exist']], { value: String(params.cb ?? 0n) }) +
      this.txForm('Attestation', 'decisionVote', 'Decide a challenge (elected NGOs)', [['NGO wallet', 'address', '0x…'], ['Uphold the challenge? (true/false)', 'bool', 'true']]) +
      this.txForm('Attestation', 'resolve', 'Close a decided challenge', [['NGO wallet', 'address', '0x…']]) +
      this.txForm('Attestation', 'finalize', 'Finalise an attestation after the window', [['NGO wallet', 'address', '0x…']]) +
      this.txForm('Attestation', 'withdrawVouch', 'Take back a vouch bond after one term', [['NGO wallet', 'address', '0x…']]) +
      '</div>';
    return this.layout(T('Attestation'), body, '/attestation', { scripts: this.appScripts() });
  }

  async electionPage() {
    const d = await this.reads(async (read) => {
      const n = Number(await read('NGOElection', 'roundCount') ?? 0n);
      const rounds = [];
      for (let i = Math.max(0, n - 4); i < n; i++) {
        const r = await read('NGOElection', 'getRound', [BigInt(i)]);
        const cands = await read('NGOElection', 'candidates', [BigInt(i)]) ?? [];
        const rows = [];
        for (const c of cands) rows.push({ c, voters: await read('NGOElection', 'approvers', [BigInt(i), c]), w: await read('NGOElection', 'approvals', [BigInt(i), c]), name: (await read('NGORegistry', 'get', [c]))?.name, elected: await read('NGOElection', 'isElectedIn', [r.term, c]) });
        rows.sort((a, b) => (b.w > a.w ? 1 : b.w < a.w ? -1 : 0));
        rounds.push({ id: i, r, rows });
      }
      return { minVoters: Number(await read('Params', 'get', [pkey('firstElectionMinVoters')]) ?? 5n), rounds: rounds.reverse(), elected: Number(await read('NGOElection', 'electedCount') ?? 0n), term: Number(await read('NGOElection', 'currentTerm') ?? 0n), due: await read('NGOElection', 'dueRound') };
    });
    const now = this.now();
    const turnout = this.turnoutPanel((await this.metricsData()).governance);
    const rounds = d.rounds.map(({ id, r, rows }) => {
      const open = now >= Number(r.opens) && now < Number(r.closes);
      const first = Number(r.term) === 1 && Number(r.slot) === 0;
      const tr = rows.map((x) => `<tr><td><a href="/ngo/${x.c}">${esc(x.name ?? short(x.c))}</a></td><td>${psy(x.w ?? 0n, 2)} PSY${first ? `<div class="muted">${T('{a} of {b} required voters', { a: x.voters ?? 0n, b: d.minVoters })}</div>` : ''}</td><td>${x.elected ? badge('elected', true) : '–'}</td><td><code>${x.c}</code></td></tr>`).join('');
      return `<div class="panel"><h3 class="h5">${Number(r.slot) === 0 ? T('Round {id}: main election for term {term}', { id, term: r.term }) : T('Round {id}: supplementary round {slot} for term {term}', { id, slot: r.slot, term: r.term })}</h3><p class="muted">${T('{a} to {b}', { a: when(r.opens), b: when(r.closes) })} · ${T('{n} seats', { n: r.seats })} · ${T('{n} ballots', { n: r.ballots })} · ${r.finalized ? badge('final', true) : open ? badge('open', true) : badge('closed')}</p>` +
        `<div class="table-responsive"><table><thead><tr><th>${T('Candidate')}</th><th>${T('Approval weight')}</th><th>${T('Result')}</th><th>${T('Wallet')}</th></tr></thead><tbody>${tr || `<tr><td colspan="4">${T('No candidates yet.')}</td></tr>`}</tbody></table></div></div>`;
    }).join('');
    const body = `<p class="eyebrow">${T('NGO election')}</p><h1>${T('Approve the NGOs you trust.')}</h1>` + turnout + `<p class="lead">${T('Lock PSY to vote. A ballot approves any number of candidates; each approval counts the voter\'s locked PSY. The 100 candidates with the most approval weight win a 1-year term. Role holders cannot vote while in office. A ballot counts the PSY that was locked both when the round opened and at the ballot (in the first election, which opens at genesis: the PSY locked at the ballot, held until the close). A ballot also counts at most your average locked PSY over the last 30 days, and at most 1 % of all locked PSY per wallet. An NGO that held a seat in the two previous terms sits out one term. In the first election a candidate also needs approvals from at least {n} different voters who each have at least 100 PSY locked. An elected NGO can be removed for the rest of its term by a Removal vote; its seat is filled in the next supplementary round.', { n: d.minVoters })}</p>` +
      this.walletBar() +
      `<div class="grid2"><div class="panel stat">${T('Elected this term')}<strong>${d.elected} / 100</strong></div><div class="panel stat">${T('Current term')}<strong>${d.term || '–'}</strong></div></div>` + rounds +
      '<div class="grid2 mt-3">' +
      this.txForm('VoteEscrow', 'lock', 'Lock PSY for voting', [], { value: 'input' }) +
      this.txForm('VoteEscrow', 'unlock', 'Unlock PSY (after your ballots close)', [['Amount (PSY)', 'psy', '10']]) +
      this.txForm('NGOElection', 'stand', 'Stand as a candidate (attested NGO wallet)', [['Round number', 'uint', '0']]) +
      this.txForm('NGOElection', 'vote', 'Cast a ballot', [['Round number', 'uint', '0'], ['Approved NGO wallets (one per line, any order)', 'address[]sorted', '0x…']]) +
      this.txForm('NGOElection', 'open', 'Open the round that is due (anyone)', []) +
      this.txForm('NGOElection', 'finalize', 'Finalise a closed round (anyone)', [['Round number', 'uint', '0']]) +
      '</div>';
    return this.layout(T('NGO election'), body, '/election', { scripts: this.appScripts() });
  }

  // ---------------------------------------------------------------- governance pages

  async governancePage() {
    const d = await this.reads(async (read) => {
      const n = Number(await read('Governor', 'proposalCount') ?? 0n);
      const ps = [];
      for (let i = Math.max(0, n - 20); i < n; i++) ps.push({ id: i, p: await read('Governor', 'getProposal', [BigInt(i)]), q: await read('Governor', 'quorumOf', [BigInt(i)]), passes: await read('Governor', 'passes', [BigInt(i)]) });
      const keys = await read('Params', 'allKeys') ?? [];
      const params = [];
      for (const k of keys) params.push({ k, b: await read('Params', 'bounds', [k]) });
      return { ps: ps.reverse(), params, total: await read('VoteEscrow', 'totalLocked'), baseline: await read('Governor', 'baseline'), mode: Number(await read('GovernanceMode', 'mode') ?? 0n) };
    });
    const KIND = ['Ordinary', 'Treasury', 'Parameter', 'Fund', 'Removal', 'Upgrade', 'Emergency'];
    const STATE = ['voting', 'defeated', 'queued', 'executed'];
    const rows = d.ps.map(({ id, p, q, passes }) => `<tr><td>${id}</td><td>${T(KIND[Number(p.kind)])}</td><td>${this.addr(p.proposer)}</td><td>${psy(p.yes, 0)} / ${psy(p.no, 0)} / ${psy(p.abstain, 0)}<div class="muted">${T('{n} yes voters', { n: p.yesVoters })}</div></td>` +
      `<td>${T('yes ≥ {a} and (yes ≥ {b} or {c} yes voters)', { a: psy(q?.[0] ?? 0n, 0), b: psy(q?.[1] ?? 0n, 0), c: q?.[2] ?? 0n })}</td><td>${passes ? badge('passing', true) : badge('not passing')}</td><td>${T(STATE[Number(p.state)])}</td><td>${when(p.end)}${Number(p.eta) ? `<div class="muted">${T('executable {t}', { t: when(p.eta) })}</div>` : ''}</td></tr>`).join('');
    const prow = d.params.map(({ k, b }) => `<tr><td><code>${esc(Buffer.from(k.slice(2), 'hex').toString().replace(/\0+$/, ''))}</code></td><td>${b ? fmtParam(k, b[0]) : '–'}</td><td>${b ? T('{a} to {b}', { a: fmtParam(k, b[1]), b: fmtParam(k, b[2]) }) : ''}</td></tr>`).join('');
    const body = `<p class="eyebrow">${T('Proposals and voting')}</p><h1>${T('Votes count yes weight.')}</h1><p class="lead">${T('Anyone holding 0.5 % of the locked PSY can propose. A proposal passes if yes beats no, yes reaches half the recent turnout, and yes reaches the floor (5 % of locked PSY, 10 % for Treasury, parameter, fund and removal proposals) or enough people voted yes (50, or 100). Then 48 hours of timelock. A token vote that decides an attestation challenge always needs the higher floor (10 % or 100 yes voters). Where 100 yes voters are needed, only voters with at least 100 PSY in their ballot count. A ballot counts the PSY that was locked both when the proposal was made and at the ballot, so PSY locked later adds nothing. A parameter moves at most to double or half its value, once per 30 days.')}</p>` +
      this.walletBar() + `<div class="grid2"><div class="panel stat">${T('Locked PSY')}<strong>${psy(d.total ?? 0n, 0)}</strong></div><div class="panel stat">${T('Turnout baseline')}<strong>${psy(d.baseline ?? 0n, 0)}</strong></div><div class="panel stat">${T('Mode')}<strong>${T(MODES[d.mode])}</strong></div></div>` +
      `<div class="table-responsive"><table><thead><tr><th>#</th><th>${T('Kind')}</th><th>${T('Proposer')}</th><th>${T('Yes / no / abstain')}</th><th>${T('Needs')}</th><th>${T('Now')}</th><th>${T('State')}</th><th>${T('Voting ends')}</th></tr></thead><tbody>${rows || `<tr><td colspan="8">${T('No proposals yet.')}</td></tr>`}</tbody></table></div>` +
      '<div class="grid2 mt-3">' +
      this.txForm('Governor', 'vote', 'Vote', [['Proposal number', 'uint', '0'], ['Vote', 'select', `<option value="1">${T('Yes')}</option><option value="0">${T('No')}</option><option value="2">${T('Abstain')}</option>`]]) +
      this.txForm('Governor', 'decide', 'Count a finished vote (anyone)', [['Proposal number', 'uint', '0']]) +
      this.txForm('Governor', 'execute', 'Execute after the timelock (anyone)', [['Proposal number', 'uint', '0']]) +
      this.txForm('Governor', 'propose', 'Make a proposal', [['Kind', 'select', ['Ordinary', 'Treasury', 'Parameter', 'Fund', 'Removal of an elected NGO', 'Upgrade (UpgradeRegistry)', 'Emergency (EmergencyPause)'].map((k, i) => `<option value="${i}">${T(k)}</option>`).join('')],
        ['Target contract addresses (one per line)', 'address[]', '0x7070…'], ['Values in wei (one per line)', 'uint[]', '0'], ['Calldata (one 0x… per line)', 'bytes[]', '0x…'], ['Description', 'string', 'What and why']],
        { note: 'Treasury proposals may only call the Treasury, parameter proposals only Params, fund proposals only FundApprovals, removal proposals only <code>NGOElection.remove(ngo, reasonHash)</code>, upgrade proposals only UpgradeRegistry (they also need yes votes from a majority of the elected NGOs), emergency proposals only EmergencyPause (2 days of voting, no timelock). Build calldata with the wallet tool: <code>psyrob-wallet calldata …</code>.' }) +
      '</div>' +
      `<h2 class="mt-4">${T('Parameters')}</h2><div class="table-responsive"><table><thead><tr><th>${T('Name')}</th><th>${T('Value')}</th><th>${T('Allowed range')}</th></tr></thead><tbody>${prow}</tbody></table></div>`;
    return this.layout(T('Governance'), body, '/governance', { scripts: this.appScripts() });
  }

  async rolesPage() {
    const d = await this.reads(async (read) => {
      const holders = [];
      for (let i = 0; i < 5; i++) holders.push(await read('RoleElection', 'holder', [BigInt(i)]));
      const n = Number(await read('RoleElection', 'roundCount') ?? 0n);
      const rounds = [];
      for (let i = Math.max(0, n - 10); i < n; i++) {
        const r = await read('RoleElection', 'getRound', [BigInt(i)]);
        const cands = await read('RoleElection', 'candidates', [BigInt(i)]) ?? [];
        const rows = [];
        for (const c of cands) rows.push({ c, v: await read('RoleElection', 'votes', [BigInt(i), c]) });
        const dr = await read('RoleElection', 'getDraw', [BigInt(i)]);
        rounds.push({ id: i, r, rows, draw: dr?.[0] });
      }
      return { holders, rounds: rounds.reverse(), pay: await read('Params', 'get', [pkey('rolePayPer30Days')]), dep: await read('Params', 'get', [pkey('candidacyDeposit')]), mode: Number(await read('GovernanceMode', 'mode') ?? 0n) };
    });
    const now = this.now();
    const hrows = d.holders.map((h, i) => `<tr><td>${T(ROLE_NAMES[i])}</td><td>${h && h.who !== '0x0000000000000000000000000000000000000000' && Number(h.termEnd) > now ? this.addr(h.who) : `<span class="muted">${T('vacant')}</span>`}</td><td>${h && Number(h.termEnd) ? when(h.termEnd) : '–'}</td></tr>`).join('');
    const rrows = d.rounds.map(({ id, r, rows, draw }) => {
      const vStart = Number(r.opens) + 14 * 86400;
      const phase = r.finalized ? T('final') : draw && Number(draw.status) === 1 ? T('tie: draw pending') : now < vStart ? T('candidacy until {t}', { t: when(vStart) }) : T('voting until {t}', { t: when(vStart + 14 * 86400) });
      const zero = '0x0000000000000000000000000000000000000000';
      const how = draw && Number(draw.status) === 2 && Number(draw.sourceKind) > 0 ? ' ' + badge('decided by draw', true) : draw && Number(draw.status) === 1 ? ' ' + badge('tie, draw pending') : '';
      return `<tr><td><a href="/role-round/${id}">${id}</a></td><td>${T(ROLE_NAMES[Number(r.role)])}</td><td>${esc(phase)}</td><td>${rows.map((x) => `${this.addr(x.c)} (${x.v})`).join('<br>') || '–'}</td><td>${r.winner !== zero ? this.addr(r.winner) + how : r.finalized ? T('none: vacant, can be run again') : how || '–'}</td></tr>`;
    }).join('');
    const body = `<p class="eyebrow">${T('Roles and candidacy')}</p><h1>${T('Five roles, elected by the NGOs.')}</h1>` +
      `<p class="lead">${T('CEO, CTO, Treasurer, Community Lead and Security Lead are individuals, never NGOs. A tie for the most votes is decided by a verifiable random draw among the tied candidates; a role with no votes stays vacant and is run again. The elected NGOs vote, one NGO one vote. Holders serve one year, cannot vote anywhere while in office, and are paid {pay} PSY per 30 days from the Treasury (never from the volunteer fund). Role elections run only in Normal mode.', { pay: psy(d.pay ?? 0n, 0) })}</p>` +
      this.walletBar() +
      `<div class="table-responsive"><table><thead><tr><th>${T('Role')}</th><th>${T('Holder')}</th><th>${T('Term ends')}</th></tr></thead><tbody>${hrows}</tbody></table></div>` +
      `<h2 class="mt-4">${T('Rounds')}</h2><div class="table-responsive"><table><thead><tr><th>#</th><th>${T('Role')}</th><th>${T('Phase')}</th><th>${T('Candidates (votes)')}</th><th>${T('Winner')}</th></tr></thead><tbody>${rrows || `<tr><td colspan="5">${T('No role election yet.')}</td></tr>`}</tbody></table></div>` +
      '<div class="grid2 mt-3">' +
      this.txForm('RoleElection', 'open', 'Open a role election (anyone, Normal mode)', [['Role', 'select', ROLE_NAMES.map((n, i) => `<option value="${i}">${T(n)}</option>`).join('')]]) +
      this.txForm('RoleElection', 'stand', 'Stand as a candidate (individual wallet)', [['Round number', 'uint', '0']], { value: String(d.dep ?? 0n), note: T('Deposit {n} PSY, refunded after the round.', { n: psy(d.dep ?? 0n) }) }) +
      this.txForm('RoleElection', 'vote', 'Vote (elected NGO wallet)', [['Round number', 'uint', '0'], ['Candidate', 'address', '0x…']]) +
      this.txForm('RoleElection', 'finalize', 'Finalise a round (anyone)', [['Round number', 'uint', '0']]) +
      this.txForm('RoleElection', 'draw', 'Run a tie draw once its seed exists (anyone; the node also runs it)', [['Round number', 'uint', '0']]) +
      this.txForm('RoleElection', 'withdrawCandidacy', 'Withdraw your candidacy', [['Round number', 'uint', '0']]) +
      this.txForm('RoleElection', 'claimPay', 'Pay a role holder what has accrued (anyone)', [['Role', 'select', ROLE_NAMES.map((n, i) => `<option value="${i}">${T(n)}</option>`).join('')]]) +
      this.txForm('RoleElection', 'withdrawDeposit', 'Take back a candidacy deposit', [['Round number', 'uint', '0']]) +
      '</div>';
    return this.layout(T('Roles'), body, '/roles', { scripts: this.appScripts() });
  }

  async roleRoundPage(ref) {
    if (!/^\d{1,9}$/.test(ref)) return null;
    const id = BigInt(ref);
    const d = await this.reads(async (read) => {
      const n = await read('RoleElection', 'roundCount');
      if (n === null || id >= n) return null;
      const r = await read('RoleElection', 'getRound', [id]);
      const cands = await read('RoleElection', 'candidates', [id]) ?? [];
      const rows = [];
      for (const c of cands) rows.push({ c, v: await read('RoleElection', 'votes', [id, c]), w: await read('RoleElection', 'withdrawn', [id, c]) });
      const [draw, tied] = await read('RoleElection', 'getDraw', [id]);
      return { r, rows, draw, tied };
    });
    if (!d) return this.layout(T('Role election'), `<h1>${T('No such round')}</h1>`, '/roles');
    const { r, draw, tied } = d;
    const rows = d.rows.sort((a, b) => (b.v > a.v ? 1 : b.v < a.v ? -1 : 0)).map((x) => `<tr><td>${this.addr(x.c)}</td><td>${x.v}</td><td>${x.w ? badge('withdrawn') : ''}${tied.includes(x.c) ? ' ' + badge('tied') : ''}</td></tr>`).join('');
    let tie = '';
    const st = Number(draw.status);
    if (st === 1) {
      tie = `<div class="panel"><h3 class="h5">${T('Tie: draw pending')}</h3><p>${T('{n} candidates share the top count ({v} votes). The tie was recorded at chain block #{b}.', { n: tied.length, v: draw.votes, b: draw.tieBlock })} ` +
        T('If a finality committee exists, its randomness beacon (commit-reveal) is asked first: members reveal the next layer of the hash chain they committed to, and the seed is the mix of their reveals. If nobody reveals:') + ' ' +
        (draw.useCheckpoint ? T('The seed is the hash of finalised checkpoint #{c} (chain block #{b}), produced after the tie was recorded.', { c: Math.ceil(Number(draw.seedBlock) / 30), b: Math.ceil(Number(draw.seedBlock) / 30) * 30 })
          : T('The seed is the hash of chain block #{b}, produced after the tie was recorded.', { b: draw.seedBlock })) + ' ' + T('Nobody can know or choose it now. The node runs the draw as soon as the seed exists; anyone may also run it once.') + '</p></div>';
    } else if (st === 2) {
      const kind = Number(draw.sourceKind);
      const src = kind === 3 ? T('committee randomness beacon, round {n} (FinalityCommittee.beacon)', { n: draw.sourceRef }) : kind === 1 ? T('finalised checkpoint #{n}', { n: draw.sourceRef }) : kind === 2 ? T('chain block #{n}', { n: draw.sourceRef }) : T('none (only one tied candidate remained eligible)');
      tie = `<div class="panel"><h3 class="h5">${kind ? T('Decided by draw') : T('Tie resolved without a draw')} ${kind ? badge('decided by draw', true) : ''}</h3><div class="table-responsive"><table>` +
        [['Election (round)', String(id)], ['Role', T(ROLE_NAMES[Number(r.role)])], ['Tied candidates (sorted by address)', tied.map((a) => this.addr(a)).join('<br>')], ['Their vote count', String(draw.votes)],
          ['Seed source', src], ['Source hash', `<code>${draw.sourceHash}</code>`], ['Seed', `<code>${draw.seed}</code>`], ['Winner', draw.winner !== '0x0000000000000000000000000000000000000000' ? this.addr(draw.winner) : T('none (role vacant)')],
          ['Drawn at chain block', `<a href="/block/${draw.drawnAt}">#${draw.drawnAt}</a>`]].map(([k, v]) => `<tr><th>${T(k)}</th><td>${v}</td></tr>`).join('') +
        `</table></div><p class="muted small">${T('Check it yourself: seed = keccak256(abi.encode(source hash, round, role)); remove tied candidates who withdrew or became ineligible (keep address order); winner = remaining[seed mod count].')} ` +
        `${T('The contract function <code>RoleElection.pick(sourceHash, round, role, count)</code> returns the index, and the RoleDrawn event in the block above carries every value.')}</p></div>`;
    }
    const body = `<h1>${T('{role} election, round {id}', { role: T(ROLE_NAMES[Number(r.role)]), id })}</h1><p class="muted">${T('Opened {t}', { t: when(r.opens) })} · ${r.finalized ? T('decided') : T('not decided yet')}${r.winner !== '0x0000000000000000000000000000000000000000' ? ' · ' + T('holder {a}', { a: this.addr(r.winner) }) : ''}</p>` +
      tie + `<div class="table-responsive"><table><thead><tr><th>${T('Candidate')}</th><th>${T('NGO votes')}</th><th></th></tr></thead><tbody>${rows || `<tr><td colspan="3">${T('No candidates.')}</td></tr>`}</tbody></table></div>`;
    return this.layout(T('Role election'), body, '/roles');
  }

  async treasuryPage() {
    const c = this.chain;
    const d = await this.reads(async (read, view) => {
      const n = Number(await read('FundApprovals', 'count') ?? 0n);
      const approvals = [];
      for (let i = 0; i < Math.min(n, 50); i++) approvals.push({ id: i, a: await read('FundApprovals', 'get', [BigInt(i)]) });
      return {
        treasury: view.getAccount(ADDR.treasury).balance, spent: await read('Treasury', 'totalSpent'), rolePay: await read('Treasury', 'totalRolePay'),
        devs: await Promise.all(DEV_ACCOUNTS.map(async (a) => ({ label: a.label, contract: '0x' + bytesToHex(ADDR[a.key]), held: view.getAccount(ADDR[a.key]).balance,
          vested: await read(a.contract, 'vested', [BigInt(this.now())]), released: await read(a.contract, 'released'), ben: await read(a.contract, 'beneficiary') }))),
        ngo: view.getAccount(ADDR.ngoRewards).balance, ngoUndistributed: await read('NGORewards', 'undistributed'), fc: view.getAccount(ADDR.finalityCommittee).balance, approvals,
      };
    });
    const kv = [[T('Community/Treasury (16 % at genesis)'), psy(d.treasury, 0) + ' PSY'], [T('Spent by governance'), psy(d.spent ?? 0n) + ' PSY'], [T('Paid to role holders'), psy(d.rolePay ?? 0n) + ' PSY'],
      ...d.devs.map((x) => [T('{label} (4 % of supply, immutable vesting at {addr})', { label: T(x.label), addr: this.addr(x.contract) }), T('{a} PSY held · {b} vested · {c} released to {to}', { a: psy(x.held, 0), b: psy(x.vested ?? 0n, 0), c: psy(x.released ?? 0n, 0), to: x.ben ? this.addr(x.ben) : '–' })]),
      [T('NGO pool contract'), T('{a} PSY (of which {b} waiting for elected NGOs)', { a: psy(d.ngo), b: psy(d.ngoUndistributed ?? 0n) })], [T('Finality committee contract (bonds and rewards)'), psy(d.fc) + ' PSY']]
      .map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('');
    const arows = d.approvals.map(({ id, a }) => `<tr><td>${id}</td><td>${a.token === '0x0000000000000000000000000000000000000000' ? 'BNB' : `<code>${a.token}</code>`}</td><td><code>${a.to}</code></td><td>${(Number(a.amount) / 1e18).toLocaleString(locale())}</td><td>${when(a.approvedAt)}</td><td>${this.node.finality?.fundSignatures(id).length ?? 0} / 15</td></tr>`).join('');
    const body = `<p class="eyebrow">${T('Treasury and funds')}</p><h1>${T('Where the PSY is.')}</h1><p class="lead">${T('The Treasury spends only after a Treasury vote and the timelock. The team allocation (12 %) is split equally over Dev Accounts 1, 2 and 3, one per team member, each in its own vesting contract on a fixed schedule with no admin: nothing in the first 12 months, then linear to month 48. The volunteer fund is kept on BNB Chain under a multi-sig and is moved only after a fund vote here, signatures of 15 committee members, 3 of 5 signers and a 48 to 72 hour timelock.')}</p>` +
      `<div class="table-responsive"><table>${kv}</table></div>` +
      `<h2 class="mt-4">${T('Volunteer fund (BNB Chain)')}</h2><div class="warn">${T('Not deployed. The contract (contracts/src/bnb/VolunteerFund.sol) is written and tested; it will be deployed with its signers and committee once the network is in Normal mode. Fund decisions need at least 60 elected NGOs.')}</div>` +
      `<div class="table-responsive"><table><thead><tr><th>${T('Approval')}</th><th>${T('Token')}</th><th>${T('Recipient')}</th><th>${T('Amount')}</th><th>${T('Approved')}</th><th>${T('Committee signatures')}</th></tr></thead><tbody>${arows || `<tr><td colspan="6">${T('No fund transfer has been approved.')}</td></tr>`}</tbody></table></div>`;
    return this.layout(T('Treasury'), body, '/treasury');
  }

  async committeePage() {
    const c = this.chain;
    const d = await this.reads(async (read) => {
      const e = await read('FinalityCommittee', 'currentEpoch');
      const members = await read('FinalityCommittee', 'members', [e]) ?? [];
      const rows = [];
      for (const m of members) rows.push({ m, seat: await read('FinalityCommittee', 'seatOf', [e, m]), signed: await read('FinalityCommittee', 'signedCount', [e, m]), slashed: await read('FinalityCommittee', 'slashed', [e, m]) });
      // bootstrap finality: quorum, deadline, DAO replacement
      const boot = { active: await read('FinalityCommittee', 'bootstrapActive'), signers: await read('FinalityCommittee', 'genesisBootstrapSigners') ?? [], current: await read('FinalityCommittee', 'bootstrapSigners') ?? [],
        quorum: await read('FinalityCommittee', 'bootstrapQuorum'), deadline: await read('FinalityCommittee', 'bootstrapDeadline') };
      return { e, rows, boot, bonded: (await read('FinalityCommittee', 'bondedList') ?? []).length, cps: await read('FinalityCommittee', 'checkpointCount', [e]), pool: await read('FinalityCommittee', 'rewardPool', [e]), active: await read('GovernanceMode', 'finalityActive'), bond: await read('Params', 'get', [pkey('committeeBond')]) };
    });
    const b = d.boot;
    const bootList = (b.current.length ? b.current : b.signers).map((a) => `<li>${this.addr(a)}</li>`).join('');
    const bootPanel = b.active
      ? `<div class="warn" id="bootstrap"><strong>${T('Bootstrap finality is active.')}</strong> ${T('Until the first committee is chosen, a checkpoint is final with {q} of these {n} signatures: keys kept only for this, which do not mine and hold no PSY.', { q: b.quorum ?? '?', n: b.current.length })} ` +
        `${T('It ends by {d} at the latest; after that only a committee can make checkpoints final. Only a DAO vote can replace these keys, and never with fewer than a majority of them.', { d: b.deadline ? esc(new Date(Number(b.deadline) * 1000).toISOString().slice(0, 10)) : T('the deadline') })}<ul class="mb-0 mt-2">${bootList}</ul></div>`
      : (b.signers.length ? `<p class="muted" id="bootstrap">${T('Bootstrap finality has ended. Only the committee finalises checkpoints now. The bootstrap keys were: {list}.', { list: (b.signers).map((a) => this.addr(a)).join(', ') })}</p>` : '');
    const rows = d.rows.map((x) => `<tr><td>${this.addr(x.m)}</td><td>${Number(x.seat) === 1 ? T('NGO') : T('miner')}</td><td>${x.signed}</td><td>${x.slashed ? `<span class="st red">${T('slashed')}</span>` : badge('active', true)}</td></tr>`).join('');
    const st = this.node.finality?.status();
    const body = `<p class="eyebrow">${T('Finality committee')}</p><h1>${T('21 members, 15 to finalise.')}</h1><p class="lead">${T('Each week 6 elected NGOs and 15 registered miners are drawn among those who bonded PSY; no operator holds more than 3 seats. Every 30 chain blocks they sign a checkpoint; with 15 signatures it is final. Signing two different checkpoints for the same number burns 90 % of the bond.')}</p>` +
      bootPanel + this.walletBar() +
      '<div class="charts">' + `<div class="panel"><h3>${T('This week\'s 21 seats')}</h3>${seats({ title: T('Committee seats'), groups: [{ label: T('NGO seats'), count: 6, filled: d.rows.filter((x) => Number(x.seat) === 1).length, color: COLORS[1] }, { label: T('Miner seats'), count: 15, filled: d.rows.filter((x) => Number(x.seat) !== 1).length, color: COLORS[0] }] })}</div>` +
      `<div class="panel"><h3>${T('Finality')}</h3>${gauge({ title: T('Checkpoints signed'), value: d.rows.length && Number(d.cps ?? 0n) ? d.rows.reduce((a, x) => a + Number(x.signed ?? 0n), 0) / (d.rows.length * Number(d.cps)) : 0, center: '#' + num(c.finalCheckpoint.number), sub: T('latest final checkpoint') })}</div></div>` +
      `<div class="grid2"><div class="panel stat">${T('Finality')}<strong>${d.active ? T('active') : T('not yet (needs Normal mode)')}</strong></div><div class="panel stat">${T('Epoch')}<strong>${d.e ?? 0n}</strong></div><div class="panel stat">${T('Final checkpoint')}<strong>#${c.finalCheckpoint.number}</strong></div><div class="panel stat">${T('Bonded candidates')}<strong>${d.bonded}</strong></div></div>` +
      `<div class="table-responsive"><table><thead><tr><th>${T('Member')}</th><th>${T('Seat')}</th><th>${T('Checkpoints signed (of {n})', { n: d.cps ?? 0n })}</th><th>${T('State')}</th></tr></thead><tbody>${rows || `<tr><td colspan="4">${T('No committee this epoch.')}</td></tr>`}</tbody></table></div>` +
      (st?.collecting?.length ? `<p class="muted">${T('Collecting: {list}', { list: st.collecting.map((x) => T('checkpoint {c} ({s})', { c: x.checkpoint, s: x.signatures })).join(', ') })}</p>` : '') +
      (Number(d.e ?? 0n) > 0 ? `<p class="mt-3">${T('Earlier epochs:')} ${Array.from({ length: Math.min(12, Number(d.e)) }, (_, i) => Number(d.e) - 1 - i).map((x) => `<a href="/committee/${x}">${x}</a>`).join(' · ')} · <a href="/committee/${Number(d.e ?? 0n)}">${T('this epoch in detail')}</a></p>` : `<p class="mt-3"><a href="/committee/0">${T('This epoch in detail')}</a></p>`) +
      '<div class="grid2 mt-3">' +
      this.txForm('FinalityCommittee', 'bond', 'Bond to be drawn (elected NGO or registered miner)', [], { value: String(d.bond ?? 0n), note: T('Bond: {n} PSY. Run a node with --signer-key to sign checkpoints.', { n: psy(d.bond ?? 0n, 0) }) }) +
      this.txForm('FinalityCommittee', 'requestUnbond', 'Leave (bond returns 14 days later)', []) +
      this.txForm('FinalityCommittee', 'withdrawBond', 'Withdraw the bond', []) +
      this.txForm('FinalityCommittee', 'claimReward', 'Claim the committee reward of an epoch', [['Epoch', 'uint', '0']]) +
      '</div>';
    return this.layout(T('Finality committee'), body, '/committee', { scripts: this.appScripts() });
  }

  /** Decentralisation and participation metrics (RISK_REVIEW.md Part 3). */
  async metricsData() {
    const m = chainMetrics(this.chain);
    const gov = await this.reads(async (read, view) => {
      const n = Number(await read('Governor', 'proposalCount') ?? 0n);
      const recent = [];
      for (let i = Math.max(0, n - 10); i < n; i++) {
        const p = await read('Governor', 'getProposal', [BigInt(i)]);
        const cast = p.yes + p.no + p.abstain;
        recent.push({ id: i, kind: Number(p.kind), turnout: p.totalPower > 0n ? Number((cast * 10_000n) / p.totalPower) / 100 : 0, yesVoters: Number(p.yesVoters), state: Number(p.state) });
      }
      const rounds = Number(await read('NGOElection', 'roundCount') ?? 0n);
      const lastRound = rounds ? await read('NGOElection', 'getRound', [BigInt(rounds - 1)]) : null;
      const e = await read('FinalityCommittee', 'currentEpoch');
      const members = await read('FinalityCommittee', 'members', [e]) ?? [];
      const cps = Number(await read('FinalityCommittee', 'checkpointCount', [e]) ?? 0n);
      let signed = 0;
      for (const a of members) signed += Number(await read('FinalityCommittee', 'signedCount', [e, a]) ?? 0n);
      const locked = await read('VoteEscrow', 'totalLocked') ?? 0n;
      const s = this.chain.supply();
      const circulating = s.genesisSupply + s.issuedMining + s.issuedNGO - s.burned - view.getAccount(ADDR.treasury).balance - devHeld(view);
      return {
        lockedPSY: locked.toString(), lockedShareOfCirculating: circulating > 0n ? Number((locked * 10_000n) / circulating) / 100 : 0,
        proposals: n, turnoutBaseline: (await read('Governor', 'baseline') ?? 0n).toString(), recentProposals: recent,
        ngos: { minted: Number(await read('NGORegistry', 'ngoCount') ?? 0n), elected: Number(await read('NGOElection', 'electedCount') ?? 0n), lastRoundBallots: lastRound ? Number(lastRound.ballots) : 0 },
        committee: { epoch: Number(e ?? 0n), members: members.length, checkpoints: cps, signingRate: members.length && cps ? Math.round((signed / (members.length * cps)) * 1e4) / 1e4 : null },
        mode: MODES[Number(await read('GovernanceMode', 'mode') ?? 0n)],
      };
    });
    return { ...m, governance: gov };
  }

  /** P4: how much of the circulating PSY is locked for voting; a warning while it is low in Bootstrap (first election). */
  turnoutPanel(g) {
    const low = g.mode === 'Bootstrap' && g.lockedShareOfCirculating < 50;
    const pct = Math.max(0, Math.min(100, Number(g.lockedShareOfCirculating) || 0));
    return `<div class="panel turnout${low ? ' low' : ''}"><strong>${T('Locked for voting: {a} PSY, {p} % of the circulating PSY.', { a: psy(BigInt(g.lockedPSY), 0), p: g.lockedShareOfCirculating })}</strong>` +
      `<div class="bar" role="img" aria-label="${T('{p} % locked', { p: pct })}"><i style="width:${pct}%"></i><span style="left:50%"></span></div>` +
      (low ? `<p class="mb-0">${T('Less than half of the PSY is locked. In the first election a small group holding a large share of the mined PSY can then decide most seats: lock and vote if you hold PSY.')}</p>` : '') + '</div>';
  }

  /** Charts for the metrics page: miner shares, holdings (Lorenz curve) and participation gauges. */
  async metricsCharts(d) {
    const g = d.governance;
    const mining = d.mining.top.slice(0, 8).map((x, i) => ({ label: short(x.miner), value: x.share, color: COLORS[i % 2], text: (x.share * 100).toFixed(1) + ' %' }));
    const rest = Math.max(0, 1 - d.mining.top.slice(0, 8).reduce((a, x) => a + x.share, 0));
    if (mining.length && rest > 0.0001) mining.push({ label: T('everyone else'), value: rest, color: COLORS[2], text: (rest * 100).toFixed(1) + ' %' });
    // Lorenz curve of ordinary holdings (the 1,000 largest balances; system contracts excluded)
    const skip = new Set([...this.labels.keys(), 'fffffffffffffffffffffffffffffffffffffffe']);
    const bal = this.holdersData().top.filter(([h]) => !skip.has(h)).map(([, b]) => Number(b / 10n ** 15n)).sort((a, b) => a - b);
    const tot = bal.reduce((a, b) => a + b, 0);
    let acc = 0;
    const lorenz = [[0, 0], ...bal.map((b, i) => { acc += b; return [(i + 1) / bal.length * 100, tot ? acc / tot * 100 : 0]; })];
    const pc = (v) => `${Math.round(v)} %`;
    return '<div class="charts">' +
      `<div class="panel"><h3>${T('Share of blue blocks by miner (last day)')}</h3>${barChart({ title: T('Miner shares'), items: mining, max: 1 })}</div>` +
      `<div class="panel"><h3>${T('Mining spread')}</h3>${gauge({ title: T('Mining spread'), value: d.mining.holders ? 1 - d.mining.hhi : 0, center: String(d.mining.nakamoto), sub: T('miners needed for a majority') })}</div>` +
      `<div class="panel"><h3>${T('How evenly PSY is held (Lorenz curve)')}</h3>${lineChart({ title: T('Lorenz curve of holdings'), series: [{ name: T('Actual'), color: COLORS[0], points: bal.length ? lorenz : [] }, { name: T('Perfectly equal'), color: COLORS[2], points: [[0, 0], [100, 100]] }], fmtX: pc, fmtY: pc, yMin: 0, area: false })}</div>` +
      `<div class="panel"><h3>${T('Participation')}</h3><div class="grid2">${gauge({ title: T('Locked for voting'), value: g.lockedShareOfCirculating / 100, center: g.lockedShareOfCirculating + ' %', sub: T('of PSY locked') })}` +
      `${gauge({ title: T('NGO seats'), value: g.ngos.elected / 100, center: `${g.ngos.elected}/100`, sub: T('NGO seats filled') })}${gauge({ title: T('Committee signing'), value: g.committee.signingRate ?? 0, center: g.committee.signingRate === null ? '–' : Math.round(g.committee.signingRate * 100) + ' %', sub: T('signatures given') })}</div></div>` +
      '</div>';
  }

  async metricsPage() {
    const d = await this.metricsData();
    const pct = (x) => (x * 100).toLocaleString(locale(), { maximumFractionDigits: 2 }) + ' %';
    const conc = (c, unit) => [['Counted', `${num(c.holders)} ${T(unit)}`], ['Largest', pct(c.top1)], ['Largest five', pct(c.top5)], ['Nakamoto coefficient (fewest that exceed 50 %)', num(c.nakamoto)], ['HHI (1 = one holder)', String(c.hhi)], ['Gini', String(c.gini)]]
      .map(([k, v]) => `<tr><th>${T(k)}</th><td>${v}</td></tr>`).join('');
    const top = d.mining.top.map((x) => `<tr><td>${this.addr(x.miner)}</td><td>${num(x.blocks)}</td><td>${pct(x.share)}</td></tr>`).join('');
    const g = d.governance;
    const KIND = ['Ordinary', 'Treasury', 'Parameter', 'Fund', 'Removal', 'Upgrade', 'Emergency'];
    const prow = g.recentProposals.map((p) => `<tr><td>${p.id}</td><td>${T(KIND[p.kind])}</td><td>${p.turnout} %</td><td>${p.yesVoters}</td></tr>`).join('');
    const body = `<p class="eyebrow">${T('Decentralisation metrics')}</p><h1>${T('Who mines, who holds, who votes.')}</h1><p class="lead">${T('Computed by this node from its own DAG and state at every page load; any node gives the same numbers for the same tip. Also as JSON at <code>/api/metrics</code> and through the RPC method <code>psy_metrics</code>.')}</p>` +
      await this.metricsCharts(d) + `<h2 class="mt-4">${T('Mining (blue blocks, chain blocks #{a} to #{b})', { a: d.mining.fromChainHeight, b: d.mining.toChainHeight })}</h2><div class="table-responsive"><table>${conc(d.mining, 'miner addresses')}<tr><th>${T('Blue blocks')}</th><td>${num(d.mining.blueBlocks)}</td></tr></table></div>` +
      `<p class="muted small">${T('Counts are per miner address. One operator can use several addresses and pools are invisible on-chain, so true concentration can be higher.')}</p>` +
      `<div class="table-responsive"><table><thead><tr><th>${T('Miner')}</th><th>${T('Blue blocks')}</th><th>${T('Share')}</th></tr></thead><tbody>${top || `<tr><td colspan="3">${T('No blocks yet.')}</td></tr>`}</tbody></table></div>` +
      `<h2 class="mt-4">${T('Holdings (PSY in ordinary addresses)')}</h2><div class="table-responsive"><table>${conc(d.holdings, 'addresses')}</table></div>` +
      `<p class="muted small">${T('System contracts (Treasury, team vesting, NGO pool, committee, vote escrow) and the burn address are not counted; locked PSY sits in the vote escrow.')}</p>` +
      `<h2 class="mt-4">${T('Participation')}</h2>${this.turnoutPanel(g)}<div class="table-responsive"><table><tr><th>${T('Mode')}</th><td>${T(g.mode)}</td></tr><tr><th>${T('Locked for voting')}</th><td>${T('{a} PSY ({p} % of circulating)', { a: psy(BigInt(g.lockedPSY), 0), p: g.lockedShareOfCirculating })}</td></tr>` +
      `<tr><th>${T('Proposals')}</th><td>${T('{n} · turnout baseline {b} PSY', { n: g.proposals, b: psy(BigInt(g.turnoutBaseline), 0) })}</td></tr><tr><th>${T('NGOs')}</th><td>${T('{m} minted · {e} / 100 elected · {b} ballots in the latest round', { m: g.ngos.minted, e: g.ngos.elected, b: g.ngos.lastRoundBallots })}</td></tr>` +
      `<tr><th>${T('Finality committee, epoch {n}', { n: g.committee.epoch })}</th><td>${T('{m} members · {c} checkpoints · signing rate {r}', { m: g.committee.members, c: g.committee.checkpoints, r: g.committee.signingRate === null ? '–' : pct(g.committee.signingRate) })}</td></tr></table></div>` +
      `<h3 class="h5 mt-3">${T('Recent proposals')}</h3><div class="table-responsive"><table><thead><tr><th>#</th><th>${T('Kind')}</th><th>${T('Turnout (of locked PSY at the snapshot)')}</th><th>${T('Yes voters')}</th></tr></thead><tbody>${prow || `<tr><td colspan="4">${T('No proposals yet.')}</td></tr>`}</tbody></table></div>`;
    return this.layout(T('Decentralisation metrics'), body, '/metrics');
  }

  // ---------------------------------------------------------------- take part

  minePage() {
    const body = `<p class="eyebrow">${T('Mine')}</p><h1>${T('CPU mining with Argon2d.')}</h1><p class="lead">${T('Anyone can mine. PSYROB Miner searches with Argon2d (32 MiB per attempt), signs every attempt with your miner wallet and submits the blocks it finds; the reward goes to that wallet. Mining is the only way to obtain PSY at the start.')}</p>` +
      `<div class="panel"><h2 class="h4">${T('Start in three steps')}</h2><ol class="steps"><li>${T('Download PSYROB Miner for Windows or Ubuntu on <a href="/run-a-node">Run a node</a> and double-click it.')}</li>` +
      `<li>${T('On the dashboard that opens in your browser, create a wallet and back up its key on paper. The dashboard has 11 languages.')}</li><li>${T('Choose the threads and press Start mining. Running your own node? Choose “My node on this PC” under Nodes.')}</li></ol>` +
      `<a class="btn btn-cyan" href="/run-a-node">${T('Download the miner')}</a></div>` +
      `<p class="mt-3">${T('The miner works through the public node <code>https://rpc.psyrob.com</code>, or through your own node (Nodes: <code>http://127.0.0.1:8770</code>). Progress is on the <a href="/mining">mining</a> page.')}</p>` +
      `<div class="warn">${T('The miner wallet is also your identity for NGO registration, vouching and committee seats. An NGO mines with its own NGO wallet. Back the key up offline: a lost key cannot be recovered.')}</div>`;
    return this.layout(T('Mine'), body, '/mine');
  }

  /** Node addresses the address manager saw in the last 24 hours, plus this node and its connected peers. */
  recentNodes(am) {
    const since = Math.floor(Date.now() / 1000) - 86_400;
    let n = 0;
    for (const x of am.info?.values?.() ?? []) if ((x.lastSeen ?? 0) >= since || (x.lastSuccess ?? 0) >= since) n++;
    return n + 1;
  }

  walletPage() {
    const p = this.p;
    const body = `<p class="eyebrow">${T('Wallet set-up')}</p><h1>${T('Add the network to your wallet.')}</h1><p class="lead">${T('The pages use your browser wallet (any EIP-1193 wallet such as MetaMask). The button adds the network for you.')}</p>` +
      this.walletBar() +
      `<div class="table-responsive"><table><tr><th>${T('Network name')}</th><td>${TESTNET_WALLET_NAME}</td></tr><tr><th>${T('RPC URL')}</th><td>${T('<code>https://rpc.psyrob.com</code> (or this site\'s <code>/rpc</code>)')}</td></tr><tr><th>${T('Chain ID')}</th><td>${p.chainId} (<code>0x${p.chainId.toString(16)}</code>), ${T('network testnet')}</td></tr><tr><th>${T('Explorer')}</th><td><code>https://explorer.psyrob.com</code></td></tr><tr><th>${T('Symbol')}</th><td>PSY</td></tr></table></div>` +
      `<div class="warn">${T('Use a new key for this network. Never reuse a key that was used on any other network. Wallet loss is permanent: back up your key or seed phrase offline, twice.')}</div>`;
    return this.layout(T('Wallet'), body, '/wallet', { scripts: this.appScripts() });
  }

  aboutPage() {
    const p = this.p;
    const li = (...items) => '<ul>' + items.map((x) => `<li>${x}</li>`).join('') + '</ul>';
    const body = `<p class="eyebrow">${T('About')}</p><h1>${T('The PSYROB testnet.')}</h1><p class="lead">${T('A block-DAG network with CPU mining, where NGOs are elected on-chain and share the emission with miners.')} ${esc(TESTNET_NAME)}, ${T('chain ID {id}. Testnet PSY has no value.', { id: p.chainId })}</p>` +
      `<h2 class="mt-4">${T('The chain')}</h2>` +
      li(T('GHOSTDAG ordering, k = {k}, about {s} seconds per block, up to {p} parents. Conflicting transactions in parallel blocks are skipped, not fatal.', { k: p.k, s: p.targetSpacing, p: p.maxParents }),
        T('Argon2d proof of work with 32 MiB per attempt; every attempt is signed by the miner wallet, so the work cannot be handed to a pool operator.'),
        T('Maximum supply {n} PSY: 36 % mining, 36 % NGOs, 12 % team (immutable vesting, never paused or upgraded), 16 % Community/Treasury.', { n: num(1e9) }),
        T('Transactions that drop out of the chain in a reorganisation go back into the queue and are included again; transactions that cannot run yet never block the queue.')) +
      `<h2 class="mt-4">${T('Finality')}</h2>` +
      li(T('Finality committee of 21: 6 NGO seats and 15 miner seats, quorum 15 with at least 4 NGO signatures, slashing for equivocation.'),
        T('Until the first committee is chosen, a checkpoint needs 2 of 3 signatures from keys kept only for this (they do not mine and hold no PSY), for 12 months at the latest; only a DAO vote can replace the keys. See <a href="/committee#bootstrap">the committee page</a>. Once a checkpoint is final, the chain cannot be rewritten below it.')) +
      `<h2 class="mt-4">${T('Governance')}</h2>` +
      li(T('100 NGO seats with one-year terms, in this order: mine, publish and mint, attestation, election, then finality. Register on <a href="/register/miner">the miner page</a> or <a href="/register/ngo">the NGO page</a>.'),
        T('NGO names follow simple rules (letters, digits, spaces and . , &amp; \' ( ) -); look-alike spellings such as "0xfam" for "Oxfam" count as the same name, and a name is shown as unverified until the NGO\'s record is attested.'),
        T('Roles (CEO, CTO, Treasurer, Community Lead, Security Lead) are elected by the NGOs, cannot vote, and are paid from the Treasury.'),
        T('Launch ceremony: the three Dev Account holders each signed their seat with the Dev Account wallet and named a separate council key before the network started.'),
        T('Dev council: until 60 NGOs are elected for the first time, or 12 months at most, two of three council keys can approve small node updates, change the committee bond and the role candidacy deposit, and pause. Then it keeps only the emergency pause (once every 7 days). It never has access to the Treasury, balances, the 12 %, the NGO election or its rules; contract updates are the DAO\'s.'),
        T('<a href="/upgrades">Upgrades</a>: every contract or node update is submitted, approved and waits a public timelock before it takes effect. Nodes that are too old stop instead of splitting the chain.'),
        T('<a href="/pause">Emergency pause</a>: one contract or all transactions, 72 hours at most; only the DAO can extend or end it early. Mining, votes, upgrades and the 12 % vesting continue.'),
        T('If fewer than 60 NGOs are elected three months after genesis, the Interim Council fallback applies; Normal mode ends only after 30 days in a row below 60 NGOs.')) +
      `<h2 class="mt-4">${T('Nodes and miners')}</h2>` +
      li(T('Nodes keep only recent blocks fully in memory, answer with their progress while they start and while they catch up, and bound every list request.'),
        T('The miner stores its key encrypted with a password, can use several nodes, checks every template before signing and retries a submission that failed for a passing reason. Its dashboard shows hash rate, blocks and node status in 11 languages.'),
        T('Downloads are plain (not obfuscated), reproducible from the source, and their checksum list is signed with the published release key.'));
    return this.layout(T('About'), body, '/about');
  }
}

function pkey(name) { return '0x' + Buffer.from(name).toString('hex').padEnd(64, '0'); }

installPages(Explorer, { esc, num, psy, when, badge, short, h0x, pkey, ROLE_NAMES, MODES, NGO_STATUS });
installV8Pages(Explorer, { esc, num, when, badge, short });
function fmtParam(k, v) {
  const name = Buffer.from(k.slice(2), 'hex').toString().replace(/\0+$/, '');
  if (name === 'maxBallotWeightBps') return T('{n} % of locked PSY', { n: (Number(v) / 100).toLocaleString(locale()) });
  return ['vouchMinBlocks', 'maxActiveVouches', 'vouchMinEpochs'].includes(name) ? num(v) : psy(v, 2) + ' PSY';
}

export { encodeParams, decodeParams, toQuantity };
