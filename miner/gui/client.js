// The miner dashboard in the browser. page.js embeds this function's source in the page and calls it with the
// translations and the start settings, so it must not use anything from this module's scope. Every text that comes
// from the miner or a node (addresses, hashes, log lines, errors) is set with textContent, never as HTML.

export function client(I18N, BOOT) {
  const T = new URLSearchParams(location.search).get('t');
  const $ = (id) => document.getElementById(id);
  const SECTIONS = ['dashboard', 'stats', 'blocks', 'wallet', 'nodes', 'settings', 'logs'];
  // icons from the PSYROB sprite (node/web/sprite.svg, served by the miner at /assets/sprite.svg)
  const ICONS = { dashboard: 'grid', stats: 'chart-line', blocks: 'box', wallet: 'wallet', nodes: 'server', settings: 'settings', logs: 'terminal' };
  let lang = I18N.pick(BOOT.lang ? [BOOT.lang] : navigator.languages), S = null, app = null, session = null, section = 'dashboard', range = '1h', hist = null, lastInput = Date.now();

  // ---- texts, numbers and dates in the chosen language
  const t = (k, v = {}) => String(I18N.strings[lang]?.[k] ?? I18N.strings.en[k] ?? k).replace(/\{(\w+)\}/g, (_, n) => (v[n] ?? ''));
  const nf = (d = 0) => new Intl.NumberFormat(lang, { maximumFractionDigits: d, minimumFractionDigits: 0 });
  const num = (x, d = 0) => (x === null || x === undefined || Number.isNaN(Number(x)) ? '–' : nf(d).format(x));
  function rate(hs) {
    if (!hs) return '0 H/s';
    const u = [['GH/s', 1e9], ['MH/s', 1e6], ['kH/s', 1e3]].find(([, f]) => hs >= f);
    return u ? num(hs / u[1], 2) + ' ' + u[0] : num(hs, hs < 10 ? 2 : 1) + ' H/s';
  }
  function dur(s) {
    if (s === null || s === undefined || !Number.isFinite(s)) return '–';
    const unit = (n, u) => new Intl.NumberFormat(lang, { style: 'unit', unit: u, unitDisplay: 'short', maximumFractionDigits: 0 }).format(n);
    if (s < 60) return unit(s, 'second');
    if (s < 3600) return unit(Math.floor(s / 60), 'minute');
    if (s < 86400) return unit(Math.floor(s / 3600), 'hour') + ' ' + unit(Math.floor((s % 3600) / 60), 'minute');
    if (s < 86400 * 365) return unit(Math.floor(s / 86400), 'day') + ' ' + unit(Math.floor((s % 86400) / 3600), 'hour');
    return t('overYear');
  }
  const when = (ms, o = { dateStyle: 'short', timeStyle: 'short' }) => new Intl.DateTimeFormat(lang, o).format(new Date(ms));
  const psy = (wei) => { if (!wei) return '0'; const b = BigInt(wei); return num(Number(b / 10n ** 12n) / 1e6, 4); };
  const share = (f) => (f * 100 < 0.01 ? '< ' + num(0.01, 2) : num(f * 100, 2));
  const short = (h, n = 10) => (h && h.length > 2 * n + 2 ? h.slice(0, n + 2) + '…' + h.slice(-n) : h ?? '–');

  // ---- DOM helpers
  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k.startsWith('aria') || k === 'role' || k.startsWith('data') || k === 'for') e.setAttribute(k.replace(/^aria([A-Z])/, (_, c) => 'aria-' + c.toLowerCase()), v);
      else e[k] = v;
    }
    e.append(...kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
    return e;
  }
  const SVG = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, ...kids) { const e = document.createElementNS(SVG, tag); for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v); e.append(...kids); return e; }
  const icon = (name) => svg('svg', { class: 'prb', 'aria-hidden': 'true' }, svg('use', { href: '/assets/sprite.svg#prb-' + name }));
  const card = (title, ...kids) => el('section', { className: 'card' }, title ? el('h2', { textContent: title }) : null, ...kids);
  const field = (label, input, hint) => { const id = 'f' + Math.random().toString(36).slice(2); input.id = id; return el('div', { className: 'field' }, el('label', { for: id, textContent: label }), input, hint ? el('p', { className: 'hint', textContent: hint }) : null); };
  const pw = (ph, auto = 'new-password') => el('input', { type: 'password', placeholder: ph, autocomplete: auto });
  const btn = (text, onclick, cls = '', ic = null) => el('button', { type: 'button', className: cls, onclick }, ic ? icon(ic) : null, text);
  /** Status: an icon and a word, never the colour alone. */
  const badge = (kind, text) => el('span', { className: 'badge ' + kind }, icon({ good: 'check', warn: 'alert', bad: 'close', idle: 'clock', info: 'info' }[kind]), text);
  function toast(text, kind = 'info') {
    const n = el('div', { className: 'toast ' + kind, role: 'status', textContent: text });
    $('toasts').append(n);
    setTimeout(() => n.remove(), 4000);
  }
  async function guard(fn, okText) { try { const r = await fn(); if (okText) toast(okText, 'good'); return r; } catch (e) { toast(e.message, 'bad'); return null; } }

  async function api(p, body) {
    const r = await fetch(p, { method: body === undefined ? 'GET' : 'POST', headers: { 'X-Token': T, 'X-Session': session ?? '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401) { session = null; showLogin(); throw new Error(t('signedOut')); }
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  }

  // ---- dropdown menus (keyboard: arrows, Home/End, Enter, Escape)
  function dropdown(button, items, onPick) {
    const menu = el('ul', { className: 'menu', role: 'menu', hidden: true });
    const wrap = el('div', { className: 'dd' }, button, menu);
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    const close = (focus) => { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); if (focus) button.focus(); };
    const open = () => {
      menu.replaceChildren(...items().map((it) => el('li', { role: 'none' }, el('button', { type: 'button', role: 'menuitem', className: it.current ? 'current' : '', lang: it.lang || null, dir: it.dir || null,
        onclick: () => { close(true); onPick(it.value); } }, it.icon ? icon(it.icon) : null, it.label))));
      menu.hidden = false;
      button.setAttribute('aria-expanded', 'true');
      (menu.querySelector('.current') ?? menu.querySelector('button'))?.focus();
    };
    button.addEventListener('click', () => (menu.hidden ? open() : close()));
    button.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown') { e.preventDefault(); open(); } });
    menu.addEventListener('keydown', (e) => {
      const list = [...menu.querySelectorAll('button')], i = list.indexOf(document.activeElement);
      const go = (j) => { e.preventDefault(); list[(j + list.length) % list.length]?.focus(); };
      if (e.key === 'ArrowDown') go(i + 1); else if (e.key === 'ArrowUp') go(i - 1); else if (e.key === 'Home') go(0); else if (e.key === 'End') go(list.length - 1);
      else if (e.key === 'Escape') { e.preventDefault(); close(true); } else if (e.key === 'Tab') close();
    });
    document.addEventListener('pointerdown', (e) => { if (!wrap.contains(e.target)) close(); });
    return wrap;
  }

  // ---- charts: inline SVG, one series per chart, crosshair and tooltip, a table view for every chart
  function lineChart(points, { fmt = (v) => num(v), time = (ms) => when(ms, { timeStyle: 'short' }), label }) {
    const W = 720, H = 220, L = 64, R = 12, Tp = 12, B = 28;
    const box = el('div', { className: 'chart' });
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': label, preserveAspectRatio: 'none' });
    box.append(s);
    if (!points.length) { box.append(el('p', { className: 'empty', textContent: t('noData') })); return box; }
    const max = Math.max(...points.map((p) => p.v)) || 1, t0 = points[0].t, t1 = points.at(-1).t || t0 + 1;
    const x = (tm) => L + ((tm - t0) / Math.max(1, t1 - t0)) * (W - L - R), y = (v) => Tp + (1 - v / (max * 1.1)) * (H - Tp - B);
    for (let i = 0; i <= 3; i++) {
      const v = (max * 1.1 * i) / 3, yy = y(v);
      s.append(svg('line', { x1: L, x2: W - R, y1: yy, y2: yy, class: 'grid' }), svg('text', { x: L - 8, y: yy + 4, class: 'tick', 'text-anchor': 'end' }, fmt(v)));
    }
    for (const tm of [t0, (t0 + t1) / 2, t1]) s.append(svg('text', { x: x(tm), y: H - 8, class: 'tick', 'text-anchor': tm === t0 ? 'start' : tm === t1 ? 'end' : 'middle' }, time(tm)));
    const d = points.map((p, i) => (i ? 'L' : 'M') + x(p.t).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ');
    s.append(svg('path', { d: d + ` L${x(t1)} ${y(0)} L${x(t0)} ${y(0)} Z`, class: 'area' }), svg('path', { d, class: 'line' }));
    const hair = svg('line', { y1: Tp, y2: H - B, class: 'hair', visibility: 'hidden' }), dot = svg('circle', { r: 4.5, class: 'dot', visibility: 'hidden' });
    s.append(hair, dot);
    const tip = el('div', { className: 'tip', hidden: true });
    box.append(tip);
    const show = (cx) => {
      const tm = t0 + ((cx - L) / (W - L - R)) * (t1 - t0);
      const p = points.reduce((a, b) => (Math.abs(b.t - tm) < Math.abs(a.t - tm) ? b : a));
      for (const [k, v] of [['x1', x(p.t)], ['x2', x(p.t)]]) hair.setAttribute(k, v);
      dot.setAttribute('cx', x(p.t)); dot.setAttribute('cy', y(p.v));
      hair.setAttribute('visibility', 'visible'); dot.setAttribute('visibility', 'visible');
      tip.replaceChildren(el('strong', { textContent: fmt(p.v) }), el('span', { textContent: time(p.t) }));
      tip.hidden = false;
      const frac = (x(p.t) / W) * 100;
      tip.style.left = Math.min(Math.max(frac, 12), 88) + '%';
    };
    s.addEventListener('pointermove', (e) => { const r = s.getBoundingClientRect(); show(((e.clientX - r.left) / r.width) * W); });
    s.addEventListener('pointerleave', () => { tip.hidden = true; hair.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); });
    s.tabIndex = 0;
    let at = points.length - 1;
    s.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); at = Math.max(0, Math.min(points.length - 1, at + (e.key === 'ArrowLeft' ? -1 : 1))); show(x(points[at].t)); } });
    s.addEventListener('blur', () => s.dispatchEvent(new Event('pointerleave')));
    return box;
  }
  /** Stacked bars: accepted (series 1) under refused (series 2), with a legend. */
  function blockBars(points, { time }) {
    const W = 720, H = 200, L = 40, R = 12, Tp = 12, B = 28;
    const box = el('div', { className: 'chart' });
    const total = points.reduce((s, p) => s + p.accepted + p.rejected, 0);
    box.append(el('div', { className: 'legend' }, el('span', {}, el('i', { className: 'sw s1' }), t('accepted')), el('span', {}, el('i', { className: 'sw s2' }), t('refused'))));
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': t('blocksChart'), preserveAspectRatio: 'none' });
    box.append(s);
    if (!total) { box.append(el('p', { className: 'empty', textContent: t('noBlocksYet') })); return box; }
    const max = Math.max(1, ...points.map((p) => p.accepted + p.rejected));
    const bw = (W - L - R) / points.length, y = (v) => Tp + (1 - v / max) * (H - Tp - B);
    for (const v of [0, Math.ceil(max / 2), max]) s.append(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }), svg('text', { x: L - 8, y: y(v) + 4, class: 'tick', 'text-anchor': 'end' }, num(v)));
    const tip = el('div', { className: 'tip', hidden: true });
    box.append(tip);
    points.forEach((p, i) => {
      const x0 = L + i * bw, w = Math.max(1, bw - 2);
      const g = svg('g', { class: 'bar', tabindex: p.accepted + p.rejected ? 0 : -1 });
      if (p.accepted) g.append(svg('rect', { x: x0 + 1, y: y(p.accepted), width: w, height: y(0) - y(p.accepted), class: 's1', rx: Math.min(3, w / 2) }));
      if (p.rejected) g.append(svg('rect', { x: x0 + 1, y: y(p.accepted + p.rejected), width: w, height: Math.max(0, y(p.accepted) - y(p.accepted + p.rejected) - 2), class: 's2', rx: Math.min(3, w / 2) }));
      g.append(svg('rect', { x: x0, y: Tp, width: bw, height: H - Tp - B, class: 'hit' }));
      const showTip = () => { tip.replaceChildren(el('strong', { textContent: t('nAccepted', { n: num(p.accepted) }) + ' · ' + t('nRefused', { n: num(p.rejected) }) }), el('span', { textContent: time(p.t) })); tip.hidden = false; tip.style.left = Math.min(Math.max(((x0 + bw / 2) / W) * 100, 12), 88) + '%'; };
      g.addEventListener('pointerenter', showTip); g.addEventListener('focus', showTip);
      g.addEventListener('pointerleave', () => { tip.hidden = true; }); g.addEventListener('blur', () => { tip.hidden = true; });
      s.append(g);
    });
    for (const i of [0, points.length - 1]) s.append(svg('text', { x: i ? W - R : L, y: H - 8, class: 'tick', 'text-anchor': i ? 'end' : 'start' }, time(points[i].t)));
    return box;
  }
  function chartTable(headers, rows) {
    return el('details', { className: 'tableview' }, el('summary', { textContent: t('showTable') }),
      el('div', { className: 'scroll' }, el('table', {}, el('thead', {}, el('tr', {}, headers.map((h) => el('th', { textContent: h })))), el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', { textContent: c }))))))));
  }

  // ---- the top bar
  const sectionBtn = el('button', { type: 'button', className: 'navbtn', id: 'navbtn' });
  const langBtn = el('button', { type: 'button', className: 'ghost', id: 'langbtn' });
  function topbar() {
    const bar = $('top');
    bar.replaceChildren(...[
      el('div', { className: 'brand' }, el('img', { src: '/assets/logo.svg', alt: '' }), 'PSYROB', el('span', { className: 'sub', textContent: t('miner') }), el('span', { className: 'net', id: 'net', textContent: 'TESTNET' })),
      dropdown(sectionBtn, () => SECTIONS.map((s) => ({ value: s, label: t('sec_' + s), icon: ICONS[s], current: s === section })), (s) => go(s)),
      el('div', { className: 'spacer' }),
      el('span', { id: 'pill', className: 'pill' }),
      el('button', { type: 'button', id: 'startstop', className: 'primary' }),
      dropdown(langBtn, () => I18N.langs.map((l) => ({ value: l.code, label: l.name, current: l.code === lang, lang: l.code, dir: l.dir })), (c) => setLang(c)),
      app?.protected ? el('button', { type: 'button', className: 'ghost icon', title: t('logout'), ariaLabel: t('logout'), onclick: logout }, icon('power')) : null,
    ].filter(Boolean));
    sectionBtn.replaceChildren(icon(ICONS[section]), t('sec_' + section), icon('chevron-down'));
    langBtn.replaceChildren(icon('globe'), I18N.langs.find((l) => l.code === lang)?.short ?? lang);
    langBtn.setAttribute('aria-label', t('language'));
    $('startstop').onclick = () => guard(async () => { if (S?.mining) await api('/api/stop', {}); else { setPill('busy'); await api('/api/start', {}); } await load(); });
    if (S) updateTop();
  }
  function setPill(kind) {
    const p = $('pill');
    const m = { mining: ['good', t('mining')], waiting: ['warn', t('waitingSync')], stopped: ['idle', t('stopped')], busy: ['info', t('starting')] }[kind];
    p.replaceChildren(badge(m[0], m[1]));
  }
  function updateTop() {
    $('net').textContent = String(S.network).toUpperCase().replace('PSYROB ', '');
    setPill(S.mining ? (S.waiting ? 'waiting' : 'mining') : 'stopped');
    const b = $('startstop');
    b.textContent = S.mining ? t('stop') : t('start');
    b.className = S.mining ? '' : 'primary';
    b.disabled = !S.mining && !(S.wallet === 'unlocked' || S.wallet === 'unprotected');
    b.title = b.disabled ? (S.wallet === 'locked' ? t('unlockFirst') : t('createFirst')) : '';
  }

  // ---- sections: built once when shown, then updated in place every 3 seconds (inputs keep what is typed)
  const views = {};
  function go(s) {
    if (!SECTIONS.includes(s)) s = 'dashboard';
    section = s;
    if (location.hash !== '#' + s) window.history.replaceState(null, '', '#' + s);
    topbar();
    const v = (views[s] = build[s]());
    $('main').replaceChildren(el('p', { className: 'eyebrow', textContent: 'PSYROB ' + t('miner') }), el('h1', { className: 'title', textContent: t('sec_' + s) }), v.root);
    if (S) v.update(S);
    $('main').focus({ preventScroll: true });
  }
  const tile = (label, id, subId) => el('div', { className: 'tile' }, el('div', { className: 'tl', textContent: label }), el('div', { className: 'tv', id }), subId ? el('div', { className: 'ts', id: subId }) : null);
  const kv = (rows) => el('dl', { className: 'kv' }, rows.map(([k, id]) => [el('dt', { textContent: k }), el('dd', { id })]));
  const set = (id, text) => { const e = $(id); if (e) e.textContent = text; };
  function nodeBadge(s) {
    if (s.chain.error) return badge('bad', t('nodeError'));
    if (s.chain.syncing) return badge('warn', t('nodeSyncing'));
    return s.chain.height === null ? badge('idle', t('connecting')) : badge('good', t('nodeSynced'));
  }

  const build = {
    dashboard() {
      const onboard = el('div', { id: 'onboard' });
      const root = el('div', {},
        onboard,
        el('div', { className: 'tiles' },
          tile(t('hashRate'), 'd_rate', 'd_rate2'), tile(t('blocksFound'), 'd_found', 'd_found2'), tile(t('balance'), 'd_bal', 'd_bal2'),
          tile(t('timeToBlock'), 'd_eta', 'd_eta2'), tile(t('networkRate'), 'd_net', 'd_net2'), tile(t('node'), 'd_node', 'd_node2')),
        el('div', { className: 'grid2' },
          card(t('liveRate'), el('div', { id: 'd_chart' })),
          card(t('threads'), el('div', { id: 'd_threads', className: 'threads' }))),
        card(t('recentBlocks'), el('div', { id: 'd_blocks' }), el('p', {}, btn(t('allBlocks'), () => go('blocks'), 'link', 'arrow-right'))));
      let chartKey = '';
      return {
        root,
        update(s) {
          onboard.replaceChildren(...(s.wallet === 'none' ? [el('div', { className: 'notice' }, el('strong', { textContent: t('welcome') }), el('p', { textContent: t('welcomeText') }), btn(t('setupWallet'), () => go('wallet'), 'primary'))]
            : s.wallet === 'locked' ? [el('div', { className: 'notice' }, el('p', { textContent: t('walletLockedText') }), btn(t('unlock'), () => go('wallet'), 'primary'))]
            : s.wallet === 'unprotected' ? [el('div', { className: 'notice warn' }, el('p', { textContent: t('unprotectedText') }), btn(t('protect'), () => go('wallet'), 'primary'))] : []));
          set('d_rate', rate(s.mining ? s.rateNow : 0)); set('d_rate2', s.mining ? t('avgSince', { r: rate(s.rate), d: dur(s.uptime) }) : t('stopped'));
          set('d_found', num(s.found)); set('d_found2', t('accRef', { a: num(s.accepted), r: num(s.rejected) }));
          set('d_bal', psy(s.chain.balance) + ' PSY'); set('d_bal2', s.address ? short(s.address, 6) : t('noWallet'));
          set('d_eta', s.estimate?.secondsPerBlock ? dur(s.estimate.secondsPerBlock) : '–'); set('d_eta2', t('estimate'));
          set('d_net', s.estimate ? rate(s.estimate.networkRate) : '–'); set('d_net2', s.estimate && s.rateNow ? t('shareOf', { p: share(s.rateNow / s.estimate.networkRate) }) : t('estimate'));
          const n = $('d_node'); n.replaceChildren(nodeBadge(s)); set('d_node2', (s.node ?? s.settings.nodes[0]).replace(/^https?:\/\//, '') + (s.latencyMs !== null ? ' · ' + num(s.latencyMs) + ' ms' : ''));
          const key = s.live.length + ':' + (s.live.at(-1)?.t ?? 0) + lang;
          if (key !== chartKey) { chartKey = key; $('d_chart').replaceChildren(lineChart(s.live.map((p) => ({ t: p.t, v: p.rate })), { fmt: rate, time: (ms) => when(ms, { timeStyle: 'medium' }), label: t('liveRate') })); }
          const th = $('d_threads');
          if (!s.threads.length) th.replaceChildren(el('p', { className: 'muted', textContent: s.mining ? t('starting') : t('threadsIdle', { n: num(s.settings.threads) }) }));
          else { const mx = Math.max(...s.threads, 1e-9); th.replaceChildren(...s.threads.map((r, i) => el('div', { className: 'thr' }, el('span', { textContent: t('threadN', { n: i + 1 }) }), el('div', { className: 'track' }, el('div', { className: 'fill', style: { width: (r / mx) * 100 + '%' } })), el('span', { className: 'num', textContent: rate(r) })))); }
          const b = s.blocks.slice(-5).reverse();
          $('d_blocks').replaceChildren(b.length ? blockTable(b, true) : el('p', { className: 'muted', textContent: t('noBlocksYet') }));
        },
      };
    },
    stats() {
      const tabs = el('div', { className: 'tabs', role: 'tablist' }, ['1h', '24h', '7d'].map((r) => el('button', { type: 'button', role: 'tab', ariaSelected: String(r === range), className: r === range ? 'on' : '', textContent: t('range_' + r),
        onclick: () => { range = r; hist = null; go('stats'); } })));
      const root = el('div', {}, tabs,
        card(t('hashRateOver', { r: t('range_' + range) }), el('div', { id: 's_rate' })),
        card(t('blocksOver', { r: t('range_' + range) }), el('div', { id: 's_blocks' })),
        el('div', { className: 'grid2' },
          card(t('currentJob'), kv([[t('blueScore'), 'j_bs'], [t('parents'), 'j_par'], [t('target'), 'j_tgt'], [t('attemptsPerBlock'), 'j_apb'], [t('powParams'), 'j_pow'], [t('templateAge'), 'j_age'], [t('argonImpl'), 'j_impl'], [t('nodeLatency'), 'j_lat']])),
          card(t('lifetime'), kv([[t('totalAttempts'), 'l_att'], [t('blocksFound'), 'l_found'], [t('accepted'), 'l_acc'], [t('refused'), 'l_rej'], [t('acceptRate'), 'l_ratio'], [t('miningTime'), 'l_time'], [t('avgRate'), 'l_avg']]))));
      const loadHist = () => api('/api/history?range=' + range).then((h) => { hist = h; draw(); }).catch(() => {});
      const fmtT = (ms) => when(ms, range === '1h' ? { timeStyle: 'short' } : { dateStyle: 'short', timeStyle: 'short' });
      function draw() {
        if (!hist || !$('s_rate')) return;
        const pts = hist.points.map((p) => ({ t: p.t, v: p.rate }));
        $('s_rate').replaceChildren(lineChart(pts, { fmt: rate, time: fmtT, label: t('hashRate') }), chartTable([t('time'), t('hashRate')], hist.points.map((p) => [fmtT(p.t), rate(p.rate)])));
        $('s_blocks').replaceChildren(blockBars(hist.points, { time: fmtT }), chartTable([t('time'), t('accepted'), t('refused')], hist.points.filter((p) => p.accepted + p.rejected).map((p) => [fmtT(p.t), num(p.accepted), num(p.rejected)])));
      }
      loadHist();
      let last = Date.now();
      return {
        root,
        update(s) {
          if (Date.now() - last > 60_000) { last = Date.now(); loadHist(); }
          const j = s.job;
          set('j_bs', j ? num(j.blueScore) : '–'); set('j_par', j ? num(j.parents) : '–'); set('j_tgt', j ? short(j.target, 8) : '–');
          set('j_apb', s.estimate ? num(s.estimate.attemptsPerBlock) : '–'); set('j_pow', j ? `Argon2d · ${num(j.memoryKiB / 1024)} MiB · ${num(j.iterations)}×` : '–');
          set('j_age', j ? dur(j.ageSeconds) : '–'); set('j_impl', s.impl ?? '–'); set('j_lat', s.latencyMs !== null ? num(s.latencyMs) + ' ms' : '–');
          const L = s.totals, settled = L.accepted + L.rejected;
          set('l_att', num(L.attempts)); set('l_found', num(L.found)); set('l_acc', num(L.accepted)); set('l_rej', num(L.rejected));
          set('l_ratio', settled ? num((L.accepted / settled) * 100, 1) + ' %' : '–'); set('l_time', dur(L.miningSeconds)); set('l_avg', L.miningSeconds ? rate(L.attempts / L.miningSeconds) : '–');
        },
      };
    },
    blocks() {
      const root = el('div', {}, card(null, el('p', { className: 'muted', textContent: t('blocksIntro') }), el('div', { id: 'b_list' })));
      let key = '';
      return { root, update(s) { const k = s.blocks.length + ':' + (s.blocks.at(-1)?.status ?? '') + lang; if (k === key) return; key = k; $('b_list').replaceChildren(s.blocks.length ? blockTable(s.blocks.slice().reverse(), false) : el('p', { className: 'muted', textContent: t('noBlocksYet') })); } };
    },
    wallet() {
      const root = el('div', {});
      let key = '';
      return { root, update(s) { const k = s.wallet + ':' + s.address + ':' + s.mining + lang; if (k !== key) { key = k; root.replaceChildren(...walletView(s)); } set('w_bal', psy(s.chain.balance) + ' PSY'); } };
    },
    nodes() {
      const list = el('div', { id: 'n_list' }), input = el('input', { type: 'url', placeholder: 'https://… or http://127.0.0.1:8770', spellcheck: false });
      const result = el('div', { id: 'n_result' });
      let draft = null; // the edited list, saved with Save
      const root = el('div', {},
        card(t('nodesInUse'), el('p', { className: 'muted', textContent: t('nodesIntro') }), list, el('div', { className: 'row' }, btn(t('save'), () => saveNodes(), 'primary'), btn(t('undo'), () => { draft = null; drawList(); }))),
        card(t('addNode'),
          el('div', { className: 'presets' },
            preset('server', t('ownNode'), t('ownNodeText'), 'http://127.0.0.1:8770'),
            preset('globe', t('publicNode'), t('publicNodeText'), 'https://rpc.psyrob.com')),
          field(t('nodeAddress'), input, t('nodeAddressHint')),
          el('div', { className: 'row' }, btn(t('test'), () => test(input.value), '', 'activity'), btn(t('add'), () => add(input.value), 'primary', 'plus')), result),
        card(t('ownNodeHelp'), el('ol', { className: 'steps' }, el('li', { textContent: t('own1') }), el('li', { textContent: t('own2') }), el('li', { textContent: t('own3') }), el('li', { textContent: t('own4') }))));
      function preset(ic, title, text, url) {
        return el('button', { type: 'button', className: 'preset', onclick: () => { input.value = url; add(url); } }, icon(ic), el('strong', { textContent: title }), el('span', { className: 'muted', textContent: text }), el('code', { textContent: url }));
      }
      const current = () => draft ?? S.settings.nodes.slice();
      function drawList() {
        const l = current();
        list.replaceChildren(el('ol', { className: 'nodes' }, l.map((u, i) => el('li', {},
          el('span', { className: 'nrank', textContent: i === 0 ? t('primary') : t('fallback') }), el('code', { textContent: u }), el('span', { className: 'nstat', id: 'ns' + i }),
          el('span', { className: 'nact' },
            btn(t('test'), async () => { const r = await guard(() => api('/api/nodes/test', { url: u })); if (r) $('ns' + i)?.replaceChildren(testBadge(r)); }, 'small'),
            btn('', () => move(i, -1), 'small icon', 'arrow-up'), btn('', () => move(i, 1), 'small icon', 'arrow-down'), btn('', () => { const d = current(); d.splice(i, 1); draft = d; drawList(); }, 'small icon', 'close'))))));
        list.querySelectorAll('.icon').forEach((b, j) => b.setAttribute('aria-label', [t('moveUp'), t('moveDown'), t('remove')][j % 3]));
      }
      function move(i, d) { const l = current(), j = i + d; if (j < 0 || j >= l.length) return; [l[i], l[j]] = [l[j], l[i]]; draft = l; drawList(); }
      async function test(u) { result.replaceChildren(el('p', { className: 'muted', textContent: t('testing') })); const r = await guard(() => api('/api/nodes/test', { url: u.trim() })); result.replaceChildren(r ? testDetails(r) : ''); return r; }
      async function add(u) {
        u = u.trim().replace(/\/$/, '');
        if (!u) return;
        const r = await test(u);
        if (!r) return;
        const l = current();
        if (!l.includes(u)) l.unshift(u);
        draft = l; drawList();
        toast(t('nodeAddedSave'), 'info');
      }
      async function saveNodes() {
        if (!draft) return;
        if (!draft.length) return toast(t('needOneNode'), 'bad');
        if (await guard(() => api('/api/settings', { nodes: draft, threads: S.settings.threads }), t('saved'))) { draft = null; await load(); drawList(); }
      }
      let seen = '';
      return { root, update(s) { const k = s.settings.nodes.join() + lang; if (k !== seen && !draft) { seen = k; drawList(); } } };
    },
    settings() {
      const threads = el('select', {}), auto = el('input', { type: 'checkbox' }), langSel = el('select', {}), theme = el('select', {}), lock = el('select', {}), explorer = el('input', { type: 'url', spellcheck: false });
      const sec = el('div', { id: 'st_sec' });
      const root = el('div', {},
        el('div', { className: 'grid2' },
          card(t('mining'),
            field(t('threadsLabel'), threads, t('threadsHint')),
            el('div', { className: 'row' }, btn(t('save'), () => guard(async () => { await api('/api/settings', { nodes: S.settings.nodes, threads: Number(threads.value) }); await load(); }, t('saved')), 'primary')),
            el('label', { className: 'check' }, auto, el('span', { textContent: t('autoStart') }))),
          card(t('appearance'), field(t('language'), langSel), field(t('theme'), theme))),
        el('div', { className: 'grid2' },
          card(t('security'), sec, field(t('autoLock'), lock, t('autoLockHint'))),
          card(t('advanced'), field(t('explorer'), explorer), el('div', { className: 'row' }, btn(t('save'), () => guard(() => api('/api/prefs', { explorer: explorer.value }), t('saved')))),
            el('p', { className: 'muted' }, t('dataFolder') + ': ', el('code', { id: 'st_home' })),
            el('div', { className: 'row' }, btn(t('quit'), async () => { if (!confirm(t('quitConfirm'))) return; await api('/api/quit', {}).catch(() => {}); document.body.replaceChildren(el('p', { className: 'bye', textContent: t('quitDone') })); }, 'danger', 'power')))));
      langSel.append(...I18N.langs.map((l) => el('option', { value: l.code, textContent: l.name, lang: l.code })));
      theme.append(...['system', 'dark', 'light'].map((v) => el('option', { value: v, textContent: t('theme_' + v) })));
      lock.append(...[0, 5, 15, 30, 60].map((v) => el('option', { value: v, textContent: v ? t('afterMin', { n: num(v) }) : t('never') })));
      langSel.onchange = () => setLang(langSel.value);
      theme.onchange = () => guard(async () => { await api('/api/prefs', { theme: theme.value }); applyTheme(theme.value); });
      auto.onchange = () => guard(() => api('/api/prefs', { autoStart: auto.checked }), t('saved'));
      lock.onchange = () => guard(async () => { await api('/api/prefs', { autoLockMinutes: Number(lock.value) }); app.autoLockMinutes = Number(lock.value); }, t('saved'));
      let first = true, secKey = '';
      return {
        root,
        update(s) {
          if (first) {
            first = false;
            threads.replaceChildren(...Array.from({ length: s.cpus }, (_, i) => el('option', { value: i + 1, textContent: num(i + 1) })));
            threads.value = s.settings.threads; auto.checked = !!s.settings.autoStart; langSel.value = lang; theme.value = s.settings.theme ?? 'system';
            lock.value = s.settings.autoLockMinutes ?? 0; explorer.value = s.settings.explorer;
          }
          threads.disabled = s.mining; threads.title = s.mining ? t('stopToChange') : '';
          lock.disabled = !s.appProtected;
          set('st_home', s.home);
          const k = String(s.appProtected) + lang;
          if (k !== secKey) { secKey = k; sec.replaceChildren(...appPasswordView(s.appProtected)); }
        },
      };
    },
    logs() {
      const filter = el('input', { type: 'search', placeholder: t('filter') }), pre = el('pre', { className: 'log', id: 'lg', tabIndex: 0 });
      const root = el('div', {}, card(null, el('div', { className: 'row' }, field(t('filter'), filter), btn(t('copy'), () => guard(() => navigator.clipboard.writeText(pre.textContent), t('copied')), '', 'copy')), pre));
      let lines = [];
      const draw = () => { const f = filter.value.toLowerCase(); const atEnd = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8; pre.textContent = lines.filter((l) => !f || l.toLowerCase().includes(f)).join('\n'); if (atEnd) pre.scrollTop = pre.scrollHeight; };
      filter.oninput = draw;
      return { root, update(s) { if (s.logs.join('\n') !== lines.join('\n')) { lines = s.logs; draw(); } } };
    },
  };

  function blockTable(list, compact) {
    const st = (b) => (b.status === 'added' ? badge('good', t('accepted')) : b.status === 'pending' ? badge('info', t('submitting')) : b.status === 'known' ? badge('idle', t('known')) : badge('bad', t('refused')));
    const link = (b) => (b.hash ? el('a', { href: S.settings.explorer + '/block/' + b.hash, target: '_blank', rel: 'noopener noreferrer', textContent: short(b.hash, compact ? 6 : 10) }) : el('span', { className: 'muted', textContent: '–' }));
    return el('div', { className: 'scroll' }, el('table', { className: 'tbl' },
      el('thead', {}, el('tr', {}, [t('time'), t('blueScore'), t('status'), t('hash'), compact ? null : t('node')].filter(Boolean).map((h) => el('th', { textContent: h })))),
      el('tbody', {}, list.map((b) => el('tr', { title: b.reason ?? '' }, el('td', { textContent: when(b.at) }), el('td', { className: 'num', textContent: num(b.blueScore) }), el('td', {}, st(b)), el('td', {}, link(b)),
        compact ? null : el('td', { className: 'muted', textContent: String(b.node ?? '').replace(/^https?:\/\//, '') }))))));
  }
  function testBadge(r) { return !r.ok ? badge('bad', t('unreachable')) : !r.chainOk || !r.genesisOk ? badge('bad', t('otherNetwork')) : r.syncing ? badge('warn', t('nodeSyncing')) : badge('good', t('okLatency', { ms: num(r.latencyMs) })); }
  function testDetails(r) {
    if (!r.ok) return el('div', { className: 'notice bad' }, testBadge(r), el('p', { textContent: r.error }));
    return el('div', { className: 'notice' }, testBadge(r), kv([[t('chainId'), 'tr_c'], [t('chainHeight'), 'tr_h'], [t('blueScore'), 'tr_b'], [t('peers'), 'tr_p'], [t('nodeVersion'), 'tr_v'], [t('nodeLatency'), 'tr_l']]),
      (setTimeout(() => { set('tr_c', String(r.chainId)); set('tr_h', num(r.height)); set('tr_b', num(r.blueScore)); set('tr_p', num(r.peers)); set('tr_v', r.version ?? '–'); set('tr_l', num(r.latencyMs) + ' ms'); }), ''));
  }

  function walletView(s) {
    const out = [];
    const reload = async () => { await load(); };
    if (s.address) {
      out.push(card(t('yourWallet'),
        el('div', { className: 'addr' }, el('code', { textContent: s.address }), btn(t('copy'), () => guard(() => navigator.clipboard.writeText(s.address), t('copied')), 'small', 'copy')),
        el('p', { className: 'big', id: 'w_bal' }), el('p', {}, el('a', { href: s.settings.explorer + '/address/' + s.address, target: '_blank', rel: 'noopener noreferrer', textContent: t('viewExplorer') })),
        el('p', {}, badge(s.wallet === 'unlocked' ? 'good' : s.wallet === 'locked' ? 'idle' : 'warn', t('wstate_' + s.wallet)))));
    }
    if (s.wallet === 'none') {
      const p1 = pw(t('pwMin')), k = el('input', { type: 'password', placeholder: '0x…', autocomplete: 'off', spellcheck: false }), p2 = pw(t('pwMin'));
      out.push(el('div', { className: 'grid2' },
        card(t('createWallet'), el('p', { className: 'muted', textContent: t('createText') }), field(t('password'), p1), el('div', { className: 'row' }, btn(t('createWallet'), () => guard(async () => { await api('/api/wallet/new', { password: p1.value }); p1.value = ''; await reload(); }, t('walletCreated')), 'primary'))),
        card(t('importWallet'), el('p', { className: 'muted', textContent: t('importText') }), field(t('privateKey'), k), field(t('password'), p2), el('div', { className: 'row' }, btn(t('import'), () => guard(async () => { await api('/api/wallet/import', { key: k.value, password: p2.value }); k.value = ''; p2.value = ''; await reload(); }, t('walletImported')))))));
    }
    if (s.wallet === 'locked') {
      const p = pw(t('walletPassword'), 'current-password');
      const unlock = () => guard(async () => { await api('/api/wallet/unlock', { password: p.value }); p.value = ''; await reload(); }, t('unlocked'));
      p.addEventListener('keydown', (e) => { if (e.key === 'Enter') unlock(); });
      out.push(card(t('unlockWallet'), el('p', { className: 'muted', textContent: t('walletLockedText') }), field(t('walletPassword'), p), el('div', { className: 'row' }, btn(t('unlock'), unlock, 'primary'))));
    }
    if (s.wallet === 'unprotected') {
      const p = pw(t('pwMin'));
      out.push(card(t('protect'), el('div', { className: 'notice warn' }, el('p', { textContent: t('unprotectedText') })), field(t('newPassword'), p), el('div', { className: 'row' }, btn(t('protect'), () => guard(async () => { await api('/api/wallet/protect', { password: p.value }); p.value = ''; await reload(); }, t('saved')), 'primary'))));
    }
    if (s.wallet === 'unlocked' || s.wallet === 'unprotected') {
      // the key: one box, hidden again with Hide or after 2 minutes
      const p = pw(t('walletPassword'), 'current-password'), shown = el('div');
      let timer = 0;
      const hide = () => { clearTimeout(timer); shown.replaceChildren(); };
      const reveal = () => guard(async () => {
        if (!confirm(t('revealConfirm'))) return;
        const r = await api('/api/wallet/reveal', { confirm: 'I will keep it secret', password: p.value });
        p.value = ''; hide();
        shown.append(el('div', { className: 'notice warn' }, el('p', { textContent: t('keyShown') }), el('code', { className: 'secret', textContent: r.key }), el('div', { className: 'row' }, btn(t('hideKey'), hide, 'primary', 'eye-off'))));
        timer = setTimeout(hide, 120_000);
      });
      const backup = card(t('backup'), el('div', { className: 'notice warn' }, el('p', { textContent: t('backupText') })), s.wallet === 'unlocked' ? field(t('walletPassword'), p) : null, el('div', { className: 'row' }, btn(t('showKey'), reveal, '', 'eye')), shown);
      const extra = [];
      if (s.wallet === 'unlocked') {
        const cur = pw(t('currentPassword'), 'current-password'), nx = pw(t('pwMin')), nx2 = pw(t('repeatPassword'));
        extra.push(card(t('changeWalletPw'), field(t('currentPassword'), cur), field(t('newPassword'), nx), field(t('repeatPassword'), nx2),
          el('div', { className: 'row' }, btn(t('change'), () => guard(async () => { if (nx.value !== nx2.value) throw new Error(t('pwMismatch')); await api('/api/wallet/password', { current: cur.value, next: nx.value }); cur.value = nx.value = nx2.value = ''; }, t('pwChanged')), 'primary'))));
        extra.push(card(t('lockWallet'), el('p', { className: 'muted', textContent: s.mining ? t('lockStopFirst') : t('lockText') }), el('div', { className: 'row' }, el('button', { type: 'button', textContent: t('lockWallet'), disabled: s.mining, onclick: () => guard(async () => { await api('/api/wallet/lock', {}); await reload(); }) }))));
      }
      out.push(el('div', { className: 'grid2' }, backup, ...extra));
    }
    return out;
  }

  function appPasswordView(isSet) {
    const cur = pw(t('currentPassword'), 'current-password'), nx = pw(t('pwMin')), nx2 = pw(t('repeatPassword'));
    const submit = (remove) => guard(async () => {
      if (!remove && nx.value !== nx2.value) throw new Error(t('pwMismatch'));
      if (remove && !confirm(t('removeAppPwConfirm'))) return;
      const r = await api('/api/app/password', { current: cur.value, next: remove ? '' : nx.value });
      session = r.session; app.protected = !!r.session || (!remove && isSet);
      cur.value = nx.value = nx2.value = '';
      app = await api('/api/app'); await load(); topbar();
    }, remove ? t('appPwRemoved') : t('appPwSaved'));
    return [
      el('p', {}, isSet ? badge('good', t('appPwOn')) : badge('idle', t('appPwOff'))),
      el('p', { className: 'muted', textContent: t('appPwText') }),
      isSet ? field(t('currentPassword'), cur) : null, field(isSet ? t('newPassword') : t('appPassword'), nx), field(t('repeatPassword'), nx2),
      el('div', { className: 'row' }, btn(isSet ? t('change') : t('setAppPw'), () => submit(false), 'primary'), isSet ? btn(t('removeAppPw'), () => submit(true), 'danger') : null),
      el('p', { className: 'hint', textContent: t('forgotAppPw') }),
    ];
  }

  // ---- signing in and out
  function showLogin() {
    clearInterval(timer);
    const p = pw(t('appPassword'), 'current-password'), err = el('p', { className: 'err', role: 'alert' });
    const submit = async () => {
      try { const r = await fetch('/api/app/login', { method: 'POST', headers: { 'X-Token': T, 'Content-Type': 'application/json' }, body: JSON.stringify({ password: p.value }) }); const j = await r.json(); if (!r.ok) throw new Error(j.error); session = j.session; p.value = ''; start(); } catch (e) { err.textContent = e.message === 'wrong password' ? t('wrongPassword') : e.message; p.select(); }
    };
    p.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    $('top').replaceChildren(el('div', { className: 'brand' }, el('img', { src: '/assets/logo.svg', alt: '' }), 'PSYROB', el('span', { className: 'sub', textContent: t('miner') })), el('div', { className: 'spacer' }),
      dropdown(langBtn, () => I18N.langs.map((l) => ({ value: l.code, label: l.name, current: l.code === lang, lang: l.code, dir: l.dir })), (c) => { lang = c; applyLang(); showLogin(); }));
    langBtn.replaceChildren(icon('globe'), I18N.langs.find((l) => l.code === lang)?.short ?? lang);
    $('main').replaceChildren(el('div', { className: 'login' }, el('img', { className: 'logo', src: '/assets/logo.svg', alt: 'PSYROB' }), card(t('signIn'), el('p', { className: 'muted', textContent: t('signInText') }), field(t('appPassword'), p), err, el('div', { className: 'row' }, btn(t('signIn'), submit, 'primary')), el('p', { className: 'hint', textContent: t('forgotAppPw') }))));
    p.focus();
  }
  async function logout() { await fetch('/api/app/logout', { method: 'POST', headers: { 'X-Token': T, 'X-Session': session ?? '' } }).catch(() => {}); session = null; S = null; showLogin(); }

  // ---- language and theme
  function applyLang() {
    const l = I18N.langs.find((x) => x.code === lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = l?.dir ?? 'ltr';
    document.title = t('title');
  }
  async function setLang(c) { lang = c; applyLang(); await api('/api/prefs', { lang: c }).catch(() => {}); go(section); }
  function applyTheme(v) { if (v === 'system') document.documentElement.removeAttribute('data-theme'); else document.documentElement.setAttribute('data-theme', v); }

  // ---- polling
  let timer = 0;
  async function load() {
    S = await api('/api/state');
    if (!S.settings.lang) { S.settings.lang = lang; api('/api/prefs', { lang }).catch(() => {}); } // the browser's language, remembered on first start
    updateTop();
    views[section]?.update(S);
    $('foot').textContent = `PSYROB Miner v${S.version} · ${S.network} · ${t('chainId')} ${S.chainId}`;
  }
  async function start() {
    app = await api('/api/app');
    if (app.protected && !session) return showLogin();
    go(SECTIONS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'dashboard');
    await load().catch((e) => toast(e.message, 'bad'));
    clearInterval(timer);
    timer = setInterval(() => {
      load().catch(() => {});
      if (app.protected && app.autoLockMinutes && Date.now() - lastInput > app.autoLockMinutes * 60_000) logout();
    }, 3000);
  }
  for (const ev of ['pointerdown', 'keydown', 'wheel']) document.addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true });
  window.addEventListener('hashchange', () => { const s = location.hash.slice(1); if (S && s !== section && SECTIONS.includes(s)) go(s); });
  applyLang();
  applyTheme(BOOT.theme ?? 'system');
  start().catch((e) => toast(e.message, 'bad'));
}
