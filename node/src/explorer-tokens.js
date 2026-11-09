// ERC-20 tokens in the explorer: a token list, a page per token (/token/<address>), token holdings and transfers on
// address pages, decoded Transfer events on transaction pages, and token search. Works for any standard ERC-20: the
// token ledger (tokenindex.js) picks up every contract that emits Transfer events, and name, symbol, decimals and total
// supply are read from the contract itself. Nothing about a particular token is built in.
//
// Token contracts are user code: their name() and symbol() are untrusted text (control and direction characters are
// stripped, the length is capped, and every value is escaped), and each read gets a small gas budget so a hostile
// token cannot make a page expensive.

import { bytesToHex, fromHex } from '../../common/bytes.js';
import { decodeParams } from '../../common/abicodec.js';
import { contractCall } from './evm.js';
import { TRANSFER_TOPIC } from './tokenindex.js';
import { T, locale } from './i18n.js';

const PER = 25;
const META_GAS = 100_000n; // gas for one name()/symbol()/decimals()/totalSupply() read
const META_TTL = 600_000; // name, symbol and decimals are read again after 10 minutes (proxies can change them)
const SEL = { name: '06fdde03', symbol: '95d89b41', decimals: '313ce567', totalSupply: '18160ddd' };

/** Untrusted token text: no control or bidirectional-override characters, at most 40 characters. */
export function cleanText(s) {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, '').trim();
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
}

/** A string return value: ABI string, or bytes32 (older tokens). null when it is neither. */
export function decodeText(ret) {
  if (!ret || !ret.length) return null;
  if (ret.length === 32) return new TextDecoder().decode(ret).replace(/\0+$/, '');
  try { return decodeParams([{ type: 'string' }], ret)[0]; } catch { return null; }
}

/** A token amount with its decimals: grouped by the page language, up to 6 fraction digits. */
export function units(value, decimals) {
  const d = Number.isInteger(decimals) && decimals >= 0 && decimals <= 77 ? decimals : 0;
  let v = BigInt(value);
  const neg = v < 0n; if (neg) v = -v;
  const base = 10n ** BigInt(d);
  const i = v / base;
  const f = d ? (v % base).toString().padStart(d, '0').slice(0, 6).replace(/0+$/, '') : '';
  const point = locale() === 'en-US' ? '.' : (1.5).toLocaleString(locale()).charAt(1);
  return (neg ? '-' : '') + i.toLocaleString(locale()) + (f ? point + f : '');
}

export function installTokenPages(Explorer, H) {
  const { esc, num, short, table, kv, pager, pageOf, blockLink } = H;
  const P = Explorer.prototype;

  /** The token ledger, up to the current tip. */
  P.tokenLedger = function () { return this.events().tokens; };

  /** name, symbol, decimals, totalSupply of a token (cached; totalSupply per tip). Missing values are null. */
  P.tokenMeta = async function (token) {
    if (!this.tokenMetaCache) this.tokenMetaCache = new Map();
    const c = this.tokenMetaCache.get(token);
    const tip = this.chain.tip.hash;
    if (c && Date.now() - c.at < META_TTL && c.tip === tip) return c.meta;
    const fresh = !c || Date.now() - c.at >= META_TTL;
    const meta = await this.chain.readSnapshot(async (view, ctx) => {
      const to = fromHex(token);
      if (!view.getCode(to).length) return { name: null, symbol: null, decimals: null, totalSupply: null, isContract: false };
      const call = async (sel) => {
        const r = await contractCall(view, this.p, ctx, { caller: new Uint8Array(20), to, data: fromHex('0x' + sel), gasLimit: META_GAS, commit: false });
        return r.status ? r.returnValue : null;
      };
      const word = (r) => (r && r.length >= 32 ? BigInt('0x' + bytesToHex(r.slice(0, 32))) : null);
      const old = c?.meta;
      const name = fresh ? decodeText(await call(SEL.name)) : old.name;
      const symbol = fresh ? decodeText(await call(SEL.symbol)) : old.symbol;
      const dec = fresh ? word(await call(SEL.decimals)) : (old.decimals === null ? null : BigInt(old.decimals));
      return { name: name === null ? null : cleanText(name), symbol: symbol === null ? null : cleanText(symbol), decimals: dec !== null && dec <= 77n ? Number(dec) : null,
        totalSupply: word(await call(SEL.totalSupply)), isContract: true };
    });
    if (this.tokenMetaCache.size > 10_000) this.tokenMetaCache.delete(this.tokenMetaCache.keys().next().value);
    this.tokenMetaCache.set(token, { meta, tip, at: fresh ? Date.now() : c.at });
    return meta;
  };

  /** "Name (SYMBOL)" linked to the token page; the short address when the token has no name. */
  P.tokenLink = function (token, meta) {
    const label = meta?.name ? meta.name + (meta.symbol ? ` (${meta.symbol})` : '') : meta?.symbol ?? short(token);
    return `<a href="/token/${esc(token)}" title="${esc(token)}">${esc(label)}</a>`;
  };

  const amount = (v, meta) => esc(units(v, meta?.decimals ?? 0)) + (meta?.symbol ? ' ' + esc(meta.symbol) : '');
  const txLink = (tx) => (tx ? `<a href="/tx/${esc(tx)}"><code>${esc(short(tx))}</code></a>` : `<span class="muted">${T('system')}</span>`);

  /** Transfer rows: [time-ordered newest first] with token column optional. */
  P.tokenTransferRows = async function (items, { withToken = true } = {}) {
    const rows = [];
    for (const x of items) {
      const meta = await this.tokenMeta(x.token);
      rows.push(`<tr><td>${txLink(x.tx)}</td><td>${blockLink(x.height)}</td><td>${this.addr(x.from)}</td><td>${this.addr(x.to)}</td><td>${amount(x.value, meta)}</td>` +
        (withToken ? `<td>${this.tokenLink(x.token, meta)}</td>` : '') + '</tr>');
    }
    return rows;
  };

  // ------------------------------------------------------------------ token list

  P.tokensPage = async function (q) {
    const L = this.tokenLedger();
    const all = [...L.tokens].sort((a, b) => b[1].transfers - a[1].transfers || (a[0] < b[0] ? -1 : 1));
    const pages = Math.max(1, Math.ceil(all.length / PER));
    const page = pageOf(q, pages);
    const rows = [];
    for (const [token, t] of all.slice((page - 1) * PER, page * PER)) {
      const meta = await this.tokenMeta(token);
      rows.push(`<tr><td>${this.tokenLink(token, meta)}</td><td>${esc(meta.symbol ?? '–')}</td><td>${this.addr(token)}</td><td>${num(t.holders.size)}</td><td>${num(t.transfers)}</td></tr>`);
    }
    const body = `<p class="eyebrow">${T('Tokens')}</p><h1>${T('ERC-20 tokens.')}</h1><p class="lead">${T('Every ERC-20 token that has moved on this chain, found from its Transfer events. Any new token appears here after its first transfer.')}</p>` +
      `<p class="muted">${T('{n} tokens.', { n: num(all.length) })}</p>` +
      table(['Token', 'Symbol', 'Contract', 'Holders', 'Transfers'], rows, 'No tokens yet.') + pager('/tokens', page, pages) +
      `<h2 class="mt-4">${T('Recent transfers')}</h2>` + table(['Transaction', 'Chain block', 'From', 'To', 'Amount', 'Token'], await this.tokenTransferRows([...L.recent].reverse().slice(0, PER)), 'No token transfers yet.');
    return this.layout('Tokens', body, '/tokens');
  };

  // ------------------------------------------------------------------ one token

  P.tokenPage = async function (ref, q) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(ref)) return { notFound: this.layout(T('Token'), `<h1>${T('Not an address')}</h1>` + this.searchBox(ref), '/tokens') };
    const token = ref.toLowerCase();
    const L = this.tokenLedger();
    const t = L.tokens.get(token);
    const meta = await this.tokenMeta(token);
    if (!t) {
      if (!meta.isContract) return { notFound: this.layout(T('Token'), `<h1>${T('Not a token')}</h1><p class="muted">${T('No contract at this address.')}</p>` + this.searchBox(ref), '/tokens') };
      return this.layout(T('Token'), `<h1>${this.tokenLink(token, meta)}</h1><p class="muted">${T('No ERC-20 transfers of this contract have been seen yet. A token appears here after its first Transfer event.')}</p>` +
        `<p><a href="/address/${esc(token)}">${T('Open the contract address')}</a></p>`, '/tokens');
    }
    const holders = L.holders(token);
    const pages = Math.max(1, Math.ceil(Math.min(holders.length, 1_000) / PER));
    const page = pageOf(q, pages);
    const supply = meta.totalSupply ?? t.minted - t.burned;
    const share = (b) => (supply > 0n ? (Number((b * 1_000_000n) / supply) / 10_000).toLocaleString(locale(), { maximumFractionDigits: 4 }) + ' %' : '–');
    const hrows = holders.slice((page - 1) * PER, page * PER).map(([a, b], i) => `<tr><td>${num((page - 1) * PER + i + 1)}</td><td>${this.addr(a)}</td><td>${amount(b, meta)}</td><td>${share(b)}</td></tr>`);
    const body = `<p class="eyebrow">${T('Token')}</p><h1>${esc(meta.name ?? short(token))}${meta.symbol ? ` <span class="muted">${esc(meta.symbol)}</span>` : ''}</h1>` +
      kv([['Name', esc(meta.name ?? '–')], ['Symbol', esc(meta.symbol ?? '–')], ['Decimals', meta.decimals === null ? '–' : String(meta.decimals)],
        ['Total supply', meta.totalSupply === null ? '–' : amount(meta.totalSupply, meta)], ['Holders', num(holders.length) + (t.partial ? ' ' + T('(list incomplete)') : '')],
        ['Transfers', num(t.transfers)], ['Contract', this.addr(token) + ` <code class="small">${esc(token)}</code>`], ['First transfer', blockLink(t.first)]]) +
      `<p class="muted small">${T('Balances are the sum of each holder\'s Transfer events.')}</p>` +
      `<h2 class="mt-4">${T('Top holders')}</h2>` + table(['Rank', 'Address', 'Balance', 'Share'], hrows, 'No holders.') + pager('/token/' + token, page, pages) +
      `<h2 class="mt-4">${T('Recent transfers')}</h2>` + table(['Transaction', 'Chain block', 'From', 'To', 'Amount'], await this.tokenTransferRows([...t.recent].reverse().slice(0, PER), { withToken: false }), 'No token transfers yet.');
    return this.layout(T('Token'), body, '/tokens');
  };

  // ------------------------------------------------------------------ on address and transaction pages

  /** The token section of an address page: holdings and recent token transfers ('' when there are none). */
  P.addressTokens = async function (ref) {
    const me = ref.toLowerCase();
    const L = this.tokenLedger();
    let out = '';
    if (L.tokens.has(me)) out += `<div class="panel mt-3">${T('This address is a token contract: <a href="{href}">see the token page</a>.', { href: '/token/' + esc(me) })}</div>`;
    const bal = L.balancesOf(me).filter((x) => x.balance !== 0n);
    const rows = [];
    for (const { token, balance } of bal.slice(0, 100)) {
      const meta = await this.tokenMeta(token);
      rows.push(`<tr><td>${this.tokenLink(token, meta)}</td><td>${esc(meta.symbol ?? '–')}</td><td>${meta.decimals ?? '–'}</td><td>${amount(balance, meta)}</td></tr>`);
    }
    const recent = L.recentOf(me).slice(0, 10);
    if (!rows.length && !recent.length) return out;
    out += `<h2 class="mt-4">${T('Token holdings')}</h2>` + table(['Token', 'Symbol', 'Decimals', 'Balance'], rows, 'No token balances.') +
      `<p class="muted small">${T('Native PSY is shown above; tokens are ERC-20 contracts. Balances are the sum of each holder\'s Transfer events.')}</p>`;
    if (recent.length) out += `<h2 class="mt-4">${T('Recent token transfers')}</h2>` + table(['Transaction', 'Chain block', 'From', 'To', 'Amount', 'Token'], await this.tokenTransferRows(recent), '');
    return out;
  };

  /** Decoded ERC-20 Transfer events of one transaction receipt (receiptJson form). */
  P.txTokenTransfers = async function (receipt) {
    const rows = [];
    for (const l of receipt?.logs ?? []) {
      if (l.topics?.length !== 3 || String(l.topics[0]).toLowerCase() !== '0x' + TRANSFER_TOPIC || String(l.data).length !== 66) continue;
      const token = String(l.address).toLowerCase();
      const meta = await this.tokenMeta(token);
      rows.push(`<tr><td>${this.addr('0x' + l.topics[1].slice(-40))}</td><td>${this.addr('0x' + l.topics[2].slice(-40))}</td><td>${amount(BigInt(l.data), meta)}</td><td>${this.tokenLink(token, meta)}</td></tr>`);
      if (rows.length >= 200) break;
    }
    return rows.length ? `<h2 class="mt-4">${T('Token transfers')}</h2>` + table(['From', 'To', 'Amount', 'Token'], rows, '') : '';
  };

  // ------------------------------------------------------------------ search

  /** Tokens whose name or symbol contains q (case-insensitive), among the 500 most-used tokens. */
  P.searchTokens = async function (q) {
    const needle = cleanText(q).toLowerCase();
    if (needle.length < 2) return [];
    const L = this.tokenLedger();
    const top = [...L.tokens].sort((a, b) => b[1].transfers - a[1].transfers).slice(0, 500);
    const hits = [];
    for (const [token] of top) {
      const m = await this.tokenMeta(token);
      const sym = (m.symbol ?? '').toLowerCase(), name = (m.name ?? '').toLowerCase();
      if (sym === needle || name === needle) hits.unshift({ token, meta: m }); else if (sym.includes(needle) || name.includes(needle)) hits.push({ token, meta: m });
      if (hits.length >= 50) break;
    }
    return hits;
  };
}
