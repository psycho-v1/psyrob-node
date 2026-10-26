// Home page transfer map. Loaded only by the home page.
// The chain blocks form the strand of blocks; the parallel blocks each chain block merged
// appear as knots on neighbouring strands, tied by threads to the chain block that merged them and to its parent.
// Red blocks (outside the blue set) are drawn muted.
// Reads GET /api/map: a snapshot on load, then every few seconds the blocks after the one it
// has, which it hands to onNewBlock / onNewTx. No libraries, no build step; the page's CSP
// allows this file because it is served from the explorer itself.
(() => {
'use strict';

const root = document.getElementById('hm');
if (!root || !document.getElementById('hm-graph')) return;

// texts in the page's language (the page carries them as JSON; the English text is the key, as T() in /i18n.js;
// named L here because T is the animation time in this file)
const I18N = (() => { try { return JSON.parse(document.getElementById('psy-i18n')?.textContent || '{}'); } catch (_) { return {}; } })();
const L = (en, v) => { const s = I18N[en] ?? en; return v ? s.replace(/\{(\w+)\}/g, (m, k) => (k in v ? String(v[k]) : m)) : s; };
const LOCALE = document.documentElement.lang && document.documentElement.lang !== 'en' ? document.documentElement.lang : 'en-US';

const CENTER_LABEL = L('CENTRE');        // tag under the middle address if the server sends no label (D28: the pool)
const SPINE_LENGTH = 5;               // how many of the latest blocks stay on the map
const MAX_PER_PAIR = 6;               // newest transfers kept as lines between any two addresses
const MAX_ADDRESSES = 16;             // addresses on the map besides the centre (two rings of 8)
const MAX_ADDRESSES_NARROW = 8;       // on a map narrower than NARROW_PX only the inner ring is used
const NARROW_PX = 560;
const MAX_TX_LINES = 60;              // transaction lines on the map in total
const INTRO_SECONDS = 7;              // first draw-in, from genesis to the chain tip
const POLL_MS = 5000, POLL_HIDDEN_MS = 30000, POLL_RETRY_MS = 10000;

const chain = { latest: 0, tipHash: '', tipTime: 0, spacing: 15 };
let center = null, centerInfo = null, accounts = {};
let txLog = [];                       // transactions drawn on the map, newest first

/* ───────────────────────── snapshot ───────────────────────── */

const isMapTx = t => t.to !== null || t.contract !== null;
const target = t => t.contract || t.to;
const notSelf = t => t.from !== target(t);

// the latest MAX_TX_LINES map transactions, at most MAX_PER_PAIR per address pair, among at most
// addressCap() addresses (the most recently active win)
function capSnapshot(txs) {
  const perPair = new Map(), kept = [];
  for (const t of txs) {                                   // newest first
    if (!isMapTx(t) || !notSelf(t)) continue;
    const a = t.from, b = target(t), k = a < b ? a + '|' + b : b + '|' + a;
    const n = perPair.get(k) || 0;
    if (n >= MAX_PER_PAIR) continue;
    perPair.set(k, n + 1); kept.push(t);
    if (kept.length >= MAX_TX_LINES) break;
  }
  const order = [];
  for (const t of kept) for (const id of [t.from, target(t)]) if (id !== centerInfo.address && !order.includes(id)) order.push(id);
  const allowed = new Set(order.slice(0, addressCap()));
  return kept.filter(t => (t.from === centerInfo.address || allowed.has(t.from)) && (target(t) === centerInfo.address || allowed.has(target(t))));
}

/* loadNodes: the centre, the genesis block, the addresses in the snapshot, the latest blocks */
function loadNodes(snap, txs) {
  const out = [{ id: centerInfo.address, kind: 'address', role: '' }];
  if (centerInfo.psy > 0) out.push({ id: 'block:0', kind: 'block', role: 'genesis', number: 0, fixed: { deg: -140, ring: 1 } });
  const seen = new Set([centerInfo.address]);
  // newest first: rebuild() hands out slots in this order, so the most recently active addresses
  // get the inner ring
  for (const t of txs) for (const id of [t.from, target(t)]) {
    if (seen.has(id)) continue;
    seen.add(id); out.push({ id, kind: 'address', role: roleOf(id) });
  }
  for (const b of snap.blocks) out.push({ id: 'block:' + b.number, kind: 'block', role: '', number: b.number, spine: true, miner: b.miner });
  for (const b of snap.blocks) (b.merged || []).forEach((m, i) => out.push(strandNode(b, m, i)));
  return out;
}

/* loadEdges: the genesis allocation, the snapshot's transfers, parent links, block -> sender */
function loadEdges(snap, txs) {
  const B = n => 'block:' + n, spineSet = new Set(snap.blocks.map(b => b.number));
  const out = [];
  if (centerInfo.psy > 0) out.push({ from: B(0), to: centerInfo.address, kind: 'alloc', value: centerInfo.psy, valueText: centerInfo.valueText, block: 0, bend: .05 });
  for (const t of txs.slice().reverse()) out.push(txEdge(t));
  for (const b of snap.blocks) if (spineSet.has(b.number - 1)) out.push({ from: B(b.number), to: B(b.number - 1), kind: 'parent', value: 0, block: b.number });
  for (const t of txs) if (spineSet.has(t.block)) out.push({ from: B(t.block), to: t.from, kind: 'includes', value: 0, block: t.block });
  for (const b of snap.blocks) for (const m of (b.merged || [])) out.push(...strandEdges(b, m, spineSet.has(b.number - 1)));
  return out;
}
// a parallel block merged by chain block b: a knot on a neighbouring strand
function strandNode(b, m, i) {
  return { id: 'dag:' + m.hash, kind: 'block', role: m.red ? 'red' : 'parallel', number: b.number, strand: i, host: 'block:' + b.number, miner: m.miner };
}
function strandEdges(b, m, hasPrev) {
  const out = [{ from: 'dag:' + m.hash, to: 'block:' + b.number, kind: 'parent', value: 0, block: b.number }];
  if (hasPrev) out.push({ from: 'dag:' + m.hash, to: 'block:' + (b.number - 1), kind: 'parent', value: 0, block: b.number });
  return out;
}
function txEdge(t) {
  return { from: t.from, to: target(t), kind: t.kind, value: t.psy, valueText: t.valueText, block: t.block, hash: t.hash, failed: t.status === 0 };
}
function roleOf(id) { const a = accounts[id]; return a ? a.role : ''; }
function labelOf(id) { const a = accounts[id]; return a && a.label ? a.label : ''; }

/* setCenter: the centre address sent by the server (/api/map) goes in the middle */
function setCenter(id) {
  center = byId.get(id) || nodes[0];
  for (const n of nodes) n.isCenter = n === center;
  relink();
}

/* ───────────────────────── live feed ───────────────────────── */

const feed = { queue: [], timer: 0, busy: false, ok: true };

async function fetchMap(query) {
  const r = await fetch('/api/map' + query, { cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function schedulePoll(ms) {
  clearTimeout(feed.timer);
  feed.timer = setTimeout(poll, ms ?? (document.hidden ? POLL_HIDDEN_MS : POLL_MS));
}

async function poll() {
  if (feed.busy) return;
  feed.busy = true;
  try {
    const d = await fetchMap(`?since=${chain.latest}&hash=${chain.tipHash}`);
    setOnline(true);
    Object.assign(accounts, d.accounts);
    if (d.reset) rebuild(d, false);
    else if (d.blocks.length) for (const b of d.blocks) feed.queue.push({ block: b, txs: d.txs.filter(t => t.block === b.number) });
    applyFigures(d);
    schedulePoll();
  } catch (_) {
    setOnline(false);
    schedulePoll(POLL_RETRY_MS);
  } finally {
    feed.busy = false;
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) schedulePoll(200); });

// queued blocks go onto the map one at a time, after the first draw-in has finished
let nextDue = 0;
function drainFeed(T) {
  if (T < introEnd || !feed.queue.length || T < nextDue) return;
  const { block, txs } = feed.queue.shift();
  onNewBlock(block, T);
  for (const t of txs) {
    addTableRow(t);
    if (isMapTx(t) && notSelf(t)) onNewTx(t, T);
  }
  nextDue = T + (feed.queue.length > 4 ? .15 : .7);    // catch up quickly after a long pause
}

function applyFigures(d) {
  if (d.tip.number >= chain.latest) { chain.latest = d.tip.number; chain.tipHash = d.tip.hash; chain.tipTime = d.tip.timestamp; }
  chain.spacing = d.targetSpacing;
  renderStats(d.stats);
  applyRadar(d.radar);
  for (const n of nodes) if (n.kind === 'address' && !n.isCenter) { n.role = roleOf(n.id); n.label = labelOf(n.id); }
}

function setOnline(ok) {
  if (feed.ok === ok) return;
  feed.ok = ok;
  $('hm-feed-txt').parentElement.classList.toggle('hm-off', !ok);
  renderFeedText();
}
function renderFeedText() {
  $('hm-feed-txt').textContent = feed.ok ? L('Live · block {n}', { n: fmt(shownTip) }) : L('Offline · retrying');
}

// a new block: it joins the tip of the spine, the oldest block on the map retires
let shownTip = 0, shownTipAt = 0;
function onNewBlock(b, T) {
  shownTip = b.number; shownTipAt = b.timestamp;
  const prev = spine[spine.length - 1];
  const n = makeNode({ id: 'block:' + b.number, kind: 'block', role: '', number: b.number, spine: true, miner: b.miner }, T);
  n.origin = prev; nodes.push(n); byId.set(n.id, n); spine.push(n);
  if (prev && prev.number === b.number - 1) edges.push(makeEdge({ from: n.id, to: prev.id, kind: 'parent', value: 0, block: b.number }, T + .25));
  (b.merged || []).forEach((m, i) => {
    const k = makeNode(strandNode(b, m, i), T + .15); k.origin = n; nodes.push(k); byId.set(k.id, k);
    for (const e of strandEdges(b, m, prev && prev.number === b.number - 1)) if (byId.has(e.to)) edges.push(makeEdge(e, T + .35));
  });
  while (spine.length > SPINE_LENGTH) {
    const old = spine.shift(); old.out = T; for (const e of old.links) e.out = T;
    for (const x of nodes) if (x.host === old.id && x.out === null) { x.out = T; for (const e of x.links) e.out = e.out ?? T; }
  }
  relink(); renderFeedText(); refreshTip(); rev++;
}

// a new transaction: a line draws in between the two addresses, tied to its block
function onNewTx(t, T) {
  for (const id of [t.from, target(t)]) {
    if (!byId.has(id)) { const n = makeNode({ id, kind: 'address', role: roleOf(id), label: labelOf(id) }, T); nodes.push(n); byId.set(id, n); claimSlot(n); }
  }
  const e = makeEdge(txEdge(t), T + .5); edges.push(e);
  const blk = byId.get('block:' + t.block);
  if (blk && blk.out === null) edges.push(makeEdge({ from: blk.id, to: t.from, kind: 'includes', value: 0, block: t.block }, T + .3));
  const live = edges.filter(x => isTx(x) && x.out === null);
  const same = live.filter(x => pairKey(x) === pairKey(e)).sort((p, q) => p.block - q.block);
  while (same.length > MAX_PER_PAIR) same.shift().out = T;
  const all = live.filter(x => x.out === null).sort((p, q) => p.block - q.block);
  while (all.length > MAX_TX_LINES) all.shift().out = T;
  retireIdle(T, new Set([t.from, target(t)]));
  txLog.unshift({ ...t, at: T + .5 });
  if (txLog.length > 200) txLog.length = 200;
  relink(); refreshTip(); rev++;
}

const addressCap = () => (W && W < NARROW_PX ? MAX_ADDRESSES_NARROW : MAX_ADDRESSES);

// addresses with no transaction line left leave the map; beyond addressCap() the least recently active leave
function retireIdle(T, keep) {
  const addrs = nodes.filter(n => n.kind === 'address' && !n.isCenter && n.out === null);
  const lastActive = n => Math.max(-1, ...n.links.filter(e => isTx(e) && e.out === null).map(e => e.block));
  for (const n of nodes) { n.links.length = 0; }
  for (const e of edges) { e.a.links.push(e); e.b.links.push(e); }
  const ranked = addrs.map(n => [n, lastActive(n)]).sort((p, q) => q[1] - p[1]);
  ranked.forEach(([n, last], i) => {
    if (keep.has(n.id)) return;
    if (last < 0 || i >= addressCap()) { n.out = T; for (const e of n.links) e.out = e.out ?? T; }
  });
}

/* ───────────────────────── setup ───────────────────────── */

const $ = id => document.getElementById(id);
const box = $('hm-box'), canvas = $('hm-graph'), ctx = canvas.getContext('2d'), tip = $('hm-tip');
const radar = $('hm-radar'), rc = radar.getContext('2d');
const strip = $('hm-strip'), chips = $('hm-chips');
const blkEl = $('hm-blk'), txcEl = $('hm-txc'), movedEl = $('hm-moved'), nextBar = $('hm-next');

const tokStyle = getComputedStyle(root);
const tok = name => tokStyle.getPropertyValue(name).trim();
const COL = { bg: tok('--hm-bg'), panel: tok('--hm-panel'), field: tok('--hm-field'), line: tok('--hm-line'),
  accent: tok('--hm-accent'), glow: tok('--hm-glow'), muted: tok('--hm-muted'), text: tok('--hm-text') };
const HEAD = '"Barlow Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';
const still = matchMedia('(prefers-reduced-motion: reduce)').matches;

const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const easeInOut = t => t < .5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
const easeOutBack = t => 1 + 2.4 * Math.pow(t - 1, 3) + 1.4 * Math.pow(t - 1, 2);
const rgba = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };
const short = id => id.startsWith('block:') ? '#' + fmt(+id.slice(6)) : id.startsWith('dag:') ? id.slice(6, 12) + '…' : id.slice(0, 6) + '…' + id.slice(-6);
const fmt = n => n.toLocaleString(LOCALE);
const isTx = e => e.kind === 'transfer' || e.kind === 'call' || e.kind === 'deploy';
const pairKey = e => e.a.id < e.b.id ? e.a.id + '|' + e.b.id : e.b.id + '|' + e.a.id;
const drawRank = e => e.tether ? 0 : e.kind === 'parent' ? 1 : e.dir === 'other' ? 2 : 3;
const life = (x, T) => x.out === null ? 1 : clamp(1 - (T - x.out) / .5);
const valueLabel = e => (e.valueText || fmt(e.value)) + ' PSY';

let nodes = [], edges = [], drawOrder = [], spine = [], timeline = [];
const byId = new Map();
let W = 0, H = 0, dpr = 1, cx = 0, cy = 0, rx = 1, ry = 1;
let particles = [];
let introEnd = INTRO_SECONDS, rev = 0, built = false;
const startedAt = performance.now();
const clock = now => (now - startedAt) / 1000 + (still ? 100 : 0);   // reduced motion skips the draw-in
let hover = null, drag = null, tipNode = null, onScreen = true;

function makeNode(n, T) {
  return { label: '', ...n, at: T, x: 0, y: 0, vx: 0, vy: 0, fx: 0, fy: 0, hx: 0, hy: 0, spawned: false, out: null, origin: null, adj: new Set(), links: [], slot: null };
}
function makeEdge(e, T) {
  const a = byId.get(e.from), b = byId.get(e.to), tether = e.kind === 'includes';
  return { ...e, a, b, tether, at: T, k: 0, kGoal: 0, fresh: true, out: null, col: COL.muted, dir: 'other',
    w: tether ? .8 : e.kind === 'parent' ? 1.3 : 1 + .7 * Math.log10(1 + e.value),
    alpha: tether ? .38 : e.kind === 'parent' ? .85 : .95,
    dash: tether ? [2, 4] : e.kind === 'parent' ? [5, 4] : null,
    ps: null, next: T + 1.6 + Math.random() * 5 };
}

// rebuild everything derived from the node and line lists: neighbours, colours, draw order, positions
function relink() {
  for (const n of nodes) { n.adj.clear(); n.links.length = 0; }
  for (const e of edges) {
    e.a.adj.add(e.b); e.b.adj.add(e.a); e.a.links.push(e); e.b.links.push(e);
    if (e.kind === 'parent') { e.col = COL.muted; e.dir = 'parent'; }
    else if (e.tether) { e.col = COL.muted; e.dir = 'tether'; }
    else if (e.a === center) { e.col = COL.accent; e.dir = 'out'; }
    else if (e.b === center) { e.col = COL.text; e.dir = 'in'; }
    else { e.col = COL.muted; e.dir = 'other'; }
  }
  drawOrder = edges.slice().sort((p, q) => drawRank(p) - drawRank(q));
  layout();
  describe();
}

// (re)build the map from a snapshot; `intro` runs the first draw-in, otherwise it appears at once
function rebuild(snap, intro) {
  applyRadar(snap.radar);
  centerInfo = snap.center;
  Object.assign(accounts, snap.accounts);
  const txs = capSnapshot(snap.txs);
  const T = clock(performance.now());
  nodes = loadNodes(snap, txs).map(n => makeNode({ ...n, label: labelOf(n.id) }, 0));
  byId.clear();
  for (const n of nodes) byId.set(n.id, n);
  spine = nodes.filter(n => n.spine).sort((p, q) => p.number - q.number);
  edges = loadEdges(snap, txs).map(e => makeEdge(e, 0));
  for (const s of slots) s.node = null;
  for (const n of nodes) if (n.kind === 'address') claimSlot(n);
  feed.queue.length = 0;
  txLog = txs.map(t => ({ ...t, at: 0 }));
  hover = drag = null; setTip(null);
  chain.latest = snap.tip.number; chain.tipHash = snap.tip.hash; chain.tipTime = snap.tip.timestamp; chain.spacing = snap.targetSpacing;
  shownTip = snap.tip.number; shownTipAt = snap.tip.timestamp;
  setCenter(centerInfo.address);
  if (intro) schedule(T);
  else {
    for (const n of nodes) n.at = T;
    for (const e of edges) { e.at = T; e.next = T + 1.6 + Math.random() * 5; }
    for (const t of txLog) t.at = T;
    timeline = []; introEnd = T;
  }
  if (!built) {
    strip.replaceChildren(...Array.from({ length: 36 }, () => document.createElement('i')));
    chips.replaceChildren(...['transfer', 'call', 'deploy'].map(k => {
      const li = document.createElement('li'), b = document.createElement('b');
      b.textContent = '0'; b.dataset.k = k;
      li.append(k + ' × ', b);
      return li;
    }));
    built = true;
  }
  renderFeedText(); renderStats(snap.stats);
  if (snap.reset) renderTable(snap.txs);
  rev++;
}

// first draw-in: lines appear in block order over INTRO_SECONDS; a node appears just before its first line
function schedule(T0) {
  const pri = e => e.kind === 'parent' ? 0 : e.tether ? 1 : 2;
  const timed = edges.slice().sort((p, q) => p.block - q.block || pri(p) - pri(q));
  const step = (INTRO_SECONDS - 1.3) / Math.max(1, timed.length - 1);
  timed.forEach((e, i) => { e.at = T0 + .5 + i * step; e.next = e.at + 1.6 + Math.random() * 5; });
  for (const n of nodes) n.at = n.isCenter || !n.links.length ? T0 : Math.max(T0 + .1, Math.min(...n.links.map(e => e.at)) - .35);
  timeline = timed.map(e => [e.at, e.block]);
  timeline.push([T0 + INTRO_SECONDS - .5, chain.latest]);
  introEnd = timed.length ? Math.max(timed[timed.length - 1].at + .8, T0 + INTRO_SECONDS - .5) : T0;
  for (const t of txLog) { const e = edges.find(x => x.hash === t.hash); t.at = e ? e.at : T0; }
}
function heightAt(T) {                 // the chain-height counter climbs with the draw-in, then follows the feed
  if (T >= introEnd || !timeline.length) return shownTip;
  let prev = [timeline[0][0] - .5, 0];
  for (const p of timeline) {
    if (T < p[0]) return prev[1] + (p[1] - prev[1]) * clamp((T - prev[0]) / Math.max(.001, p[0] - prev[0]));
    prev = p;
  }
  return prev[1];
}

// drop nodes and lines that have finished fading out
function purge(T) {
  const gone = x => x.out !== null && T - x.out > .6;
  if (!nodes.some(gone) && !edges.some(gone)) return;
  const dead = new Set(nodes.filter(gone));
  nodes = nodes.filter(n => !dead.has(n));
  for (const n of dead) { byId.delete(n.id); if (n.slot) n.slot.node = null; }
  edges = edges.filter(e => !gone(e) && !dead.has(e.a) && !dead.has(e.b));
  if (dead.has(hover)) hover = null;
  if (dead.has(drag)) drag = null;
  if (dead.has(tipNode)) setTip(null);
  relink(); rev++;
}

/* ───────────────────────── layout ───────────────────────── */

// Sticky slots on two rings. The latest blocks run down the left arc (inner), so address slots
// avoid that side; the genesis block keeps its own place at the upper left of the outer ring.
// An address keeps its slot until it leaves the map, so arrivals never move anyone else.
const slots = [
  ...Array.from({ length: 8 }, (_, i) => ({ deg: -100 + 210 * (i + .5) / 8, ring: .74, node: null })),
  ...Array.from({ length: 8 }, (_, i) => ({ deg: -120 + 245 * i / 7, ring: 1, node: null })),
];
function preferredDeg(id) { return -100 + 210 * (parseInt(id.slice(2, 10), 16) / 0xffffffff); }
function claimSlot(n) {
  if (n.isCenter || n.id === centerInfo.address || n.slot) return;
  const want = preferredDeg(n.id);
  const pick = ring => slots.filter(s => s.ring === ring && !s.node).sort((p, q) => Math.abs(p.deg - want) - Math.abs(q.deg - want))[0];
  const s = pick(.74) || pick(1) || slots.slice().sort((p, q) => Math.abs(p.deg - want) - Math.abs(q.deg - want))[0];
  if (s.node && s.node !== n) s.node.slot = null;
  s.node = n; n.slot = s;
}

const FAN = .075;

function layout() {
  cx = W / 2; cy = H / 2;
  rx = Math.min(W * .40, 330);
  ry = Math.max(90, H * .38);
  spine.forEach((n, i) => n.auto = { deg: 202 - 73 * (spine.length > 1 ? i / (spine.length - 1) : .5), ring: .5 });
  for (const n of nodes) {                               // parallel blocks: neighbouring strands, outside the chain's strand
    if (!n.host) continue;
    const h = byId.get(n.host);
    if (h && h.auto) n.auto = { deg: h.auto.deg + (n.strand % 2 ? -1 : 1) * (6 + 5 * Math.floor(n.strand / 2)), ring: .5 + .19 + .07 * Math.floor(n.strand / 2) };
  }
  for (const n of nodes) {
    if (n.isCenter) { n.hx = cx; n.hy = cy; continue; }
    if (n.out !== null) continue;                    // a retiring node fades where it stood
    const s = n.fixed || n.slot || n.auto || { deg: 0, ring: 1 }, a = s.deg * Math.PI / 180;
    n.hx = cx + Math.cos(a) * rx * s.ring;
    n.hy = cy + Math.sin(a) * ry * s.ring;
  }
  // curvature: lines bulge away from the centre, and parallel lines between the same pair fan out
  const groups = new Map();
  for (const e of edges) {
    if (e.out !== null) continue;
    const key = pairKey(e);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  for (const list of groups.values()) {
    list.forEach((e, i) => {
      const flip = e.a.id < e.b.id ? 1 : -1, A = flip === 1 ? e.a : e.b, Bn = flip === 1 ? e.b : e.a;
      const dx = Bn.hx - A.hx, dy = Bn.hy - A.hy, len = Math.hypot(dx, dy) || 1;
      const d = (-dy / len) * ((A.hx + Bn.hx) / 2 - cx) + (dx / len) * ((A.hy + Bn.hy) / 2 - cy);
      const out = Math.abs(d) < 1 ? 1 : Math.sign(d);
      const base = e.bend ?? (e.tether ? 0 : list.length > 1 ? 0 : .12);
      e.kGoal = (out * base + (i - (list.length - 1) / 2) * FAN) * flip;
      e.lt = clamp(.5 + (i - (list.length - 1) / 2) * .24, .22, .78);   // parallel lines stagger their value labels
      if (e.fresh) { e.k = e.kGoal; e.fresh = false; }
    });
  }
}

// keeps the canvas description in step with what is drawn
let lastDesc = '';
function describe() {
  const others = nodes.filter(n => n.kind === 'address' && !n.isCenter && n.out === null).length;
  const blocks = spine.filter(n => n.out === null).length;
  const d = L('Live map of PSY transfers between the {c} {a} and {n} other addresses, with the latest {b} blocks', { c: centerInfo.label || L('centre address'), a: short(centerInfo.address), n: others, b: blocks });
  if (d !== lastDesc) { lastDesc = d; canvas.setAttribute('aria-label', d); }
}

function resize() {
  const r = box.getBoundingClientRect();
  W = Math.max(260, r.width); H = Math.max(280, r.height);
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  radar.width = Math.round(radar.clientWidth * dpr); radar.height = Math.round(radar.clientHeight * dpr);
  layout();
  for (const e of edges) e.k = e.kGoal;
  if (centerInfo && nodes.filter(n => n.kind === 'address' && !n.isCenter && n.out === null).length > addressCap()) {
    retireIdle(clock(performance.now()), new Set()); relink(); rev++;
  }
  const count = Math.round(clamp(W * H / 4200, 40, 140));
  particles = Array.from({ length: count }, () => ({
    x: Math.random() * W, y: Math.random() * H, s: Math.random() < .14 ? 2 : 1,
    vx: (Math.random() - .5) * .1, vy: (Math.random() - .5) * .1,
    a: .1 + Math.random() * .35, f: .4 + Math.random() * 1.4, ph: Math.random() * 6.28,
    c: Math.random() < .3 ? COL.accent : COL.muted }));
}

/* ───────────────────────── physics ───────────────────────── */

const K_HOME = .032, K_LINK = .012, DAMP = .86;

function simulate(T) {
  for (const n of nodes) {
    if (T < n.at) continue;
    if (!n.spawned) {
      n.spawned = true; n.vx = n.vy = 0;
      const src = n.origin && n.origin.spawned ? n.origin : center;
      if (still || n.isCenter || !src.spawned) { n.x = n.hx; n.y = n.hy; }
      else { n.x = src.x + (Math.random() - .5) * 6; n.y = src.y + (Math.random() - .5) * 6; }
    }
    n.fx = (n.hx - n.x) * K_HOME; n.fy = (n.hy - n.y) * K_HOME;
  }
  for (const e of edges) {
    e.k += (e.kGoal - e.k) * .12;
    if (T < e.at || !e.a.spawned || !e.b.spawned) continue;
    const a = e.a, b = e.b, dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
    const rest = Math.hypot(b.hx - a.hx, b.hy - a.hy);
    const f = (d - rest) * K_LINK / d;
    a.fx += dx * f; a.fy += dy * f; b.fx -= dx * f; b.fy -= dy * f;
  }
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i]; if (!a.spawned) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j]; if (!b.spawned) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      if (d < 44) { const p = (44 - d) / 44 * .7 / d; a.fx -= dx * p; a.fy -= dy * p; b.fx += dx * p; b.fy += dy * p; }
    }
  }
  for (const n of nodes) {
    if (!n.spawned) continue;
    if (n === drag) { n.vx = n.vy = 0; continue; }
    n.vx = (n.vx + n.fx) * DAMP; n.vy = (n.vy + n.fy) * DAMP;
    n.x += n.vx; n.y += n.vy;
  }
}

/* ───────────────────────── drawing ───────────────────────── */

function geom(e) {
  const a = e.a, b = e.b, dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  return { x0: a.x, y0: a.y, x1: b.x, y1: b.y, nx, ny, len,
    qx: (a.x + b.x) / 2 + nx * len * e.k, qy: (a.y + b.y) / 2 + ny * len * e.k };
}
function pt(g, t) {
  const u = 1 - t;
  return [u * u * g.x0 + 2 * u * t * g.qx + t * t * g.x1, u * u * g.y0 + 2 * u * t * g.qy + t * t * g.y1];
}
function strokeTo(g, t) {            // draws the curve from its start up to fraction t
  const [ex, ey] = pt(g, t);
  ctx.beginPath(); ctx.moveTo(g.x0, g.y0);
  ctx.quadraticCurveTo(g.x0 + (g.qx - g.x0) * t, g.y0 + (g.qy - g.y0) * t, ex, ey);
  ctx.stroke();
}
function dot(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill(); }
function ring(x, y, r) { ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.stroke(); }
function pulseAt(g, t, size, a) {
  const [x, y] = pt(g, t);
  ctx.fillStyle = rgba(COL.glow, a * .2); dot(x, y, size * 3.4);
  ctx.fillStyle = rgba(COL.glow, a * .55); dot(x, y, size * 1.7);
  ctx.fillStyle = rgba(COL.text, a); dot(x, y, size * .8);
}
function outlined(text, x, y, fill) {
  ctx.strokeStyle = rgba(COL.field, .92); ctx.lineWidth = 4; ctx.lineJoin = 'round';
  ctx.strokeText(text, x, y); ctx.fillStyle = fill; ctx.fillText(text, x, y);
}
function rhombus(y, hw, hh) { ctx.beginPath(); ctx.moveTo(0, y - hh); ctx.lineTo(hw, y); ctx.lineTo(0, y + hh); ctx.lineTo(-hw, y); ctx.closePath(); }

function drawBackdrop(now) {
  ctx.fillStyle = COL.field; ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry) * 1.05);
  g.addColorStop(0, rgba(COL.accent, .10)); g.addColorStop(.5, rgba(COL.accent, .025)); g.addColorStop(1, rgba(COL.accent, 0));
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // faint guide rings: straight threads between twelve spokes
  ctx.lineWidth = 1; ctx.strokeStyle = rgba(COL.line, .75);
  for (const k of [.5, .74, 1]) {
    ctx.beginPath();
    for (let i = 0; i <= 12; i++) {
      const a = i * Math.PI / 6 - Math.PI / 2, x = cx + Math.cos(a) * rx * k, y = cy + Math.sin(a) * ry * k;
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    }
    ctx.stroke();
  }
  ctx.strokeStyle = rgba(COL.line, .5); ctx.beginPath();
  for (let i = 0; i < 12; i++) {
    const a = i * Math.PI / 6 - Math.PI / 2;
    ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * rx * 1.14, cy + Math.sin(a) * ry * 1.14);
  }
  ctx.stroke();
  // particle field
  for (const p of particles) {
    if (!still) {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0) p.x += W; else if (p.x > W) p.x -= W;
      if (p.y < 0) p.y += H; else if (p.y > H) p.y -= H;
    }
    ctx.globalAlpha = p.a * (still ? .8 : .55 + .45 * Math.sin(now * .001 * p.f + p.ph));
    ctx.fillStyle = p.c; ctx.fillRect(p.x, p.y, p.s, p.s);
  }
  ctx.globalAlpha = 1;
}

function drawEdges(T, hot) {
  ctx.lineCap = 'round';
  for (const e of drawOrder) {
    if (T < e.at || !e.a.spawned || !e.b.spawned) continue;
    const p = still ? 1 : easeInOut(clamp((T - e.at) / .8)), g = geom(e);
    let alpha = e.alpha * (e.dir === 'other' ? .8 : 1) * life(e, T), w = e.w;
    if (hot) { if (e.a === hot || e.b === hot) { alpha = Math.min(1, alpha + .4 * life(e, T)); w += .6; } else alpha *= .12; }
    ctx.setLineDash(e.dash || []);
    if (!e.dash) { ctx.strokeStyle = rgba(e.col, alpha * .16); ctx.lineWidth = w + 5; strokeTo(g, p); }
    ctx.strokeStyle = rgba(e.col, alpha); ctx.lineWidth = w; strokeTo(g, p);
    ctx.setLineDash([]);
    e._g = g; e._p = p; e._vis = alpha / e.alpha;
  }
  // pulses: one rides the head of each line as it draws in, then occasional ones show direction
  ctx.globalCompositeOperation = 'lighter';
  for (const e of drawOrder) {
    if (T < e.at || still || !e._g) continue;
    const size = Math.max(1.5, e.w * .9), vis = Math.min(1, e._vis);
    if (e._p < 1) pulseAt(e._g, e._p, size + .5, vis);
    if (T > e.next) { e.ps = T; e.next = T + 4 + Math.random() * 8; }
    if (e.ps !== null) {
      const u = (T - e.ps) / 1.3;
      if (u < 1) pulseAt(e._g, easeInOut(u), size, Math.sin(Math.PI * u) * (e.tether ? .45 : .9) * vis);
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

// value labels on lines that carry PSY; one that would cover a placed label is left out
function drawValueLabels(T, taken) {
  ctx.font = `600 12px ${HEAD}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const e of drawOrder) {
    if (!e.value || T < e.at + .8 || !e._g || e._g.len < 130) continue;      // no room for a label on a short line
    const a = clamp((T - e.at - .8) / .4) * Math.min(1, e._vis + .1) * life(e, T);
    if (a <= 0) continue;
    const text = valueLabel(e), [x, y] = pt(e._g, e.lt ?? .5), off = e.w / 2 + 9, s = e.k < 0 ? -1 : 1;
    const lx = clamp(x + e._g.nx * off * s, 44, W - 44), ly = y + e._g.ny * off * s, hw = ctx.measureText(text).width / 2 + 2;
    const box = [lx - hw, ly - 8, lx + hw, ly + 8];
    if (taken.some(b => hits(b, box))) continue;
    taken.push(box);
    ctx.globalAlpha = a;
    outlined(text, lx, ly, e.col);
  }
  ctx.globalAlpha = 1;
}
const hits = (p, q) => p[0] < q[2] && q[0] < p[2] && p[1] < q[3] && q[1] < p[3];

function drawNode(n, now, T, hot) {
  const age = T - n.at, a = clamp(age / .4) * life(n, T), s = still ? 1 : easeOutBack(clamp(age / .6));
  const dim = hot && hot !== n && !n.adj.has(hot) ? .25 : 1;
  ctx.save(); ctx.translate(n.x, n.y); ctx.scale(s, s); ctx.globalAlpha = a * dim;
  if (n.isCenter) {
    const k = still ? .5 : .5 + .5 * Math.sin(now * .0017);
    ctx.globalCompositeOperation = 'lighter';
    let g = ctx.createRadialGradient(0, 0, 0, 0, 0, 52 + 6 * k);
    g.addColorStop(0, rgba(COL.glow, .5)); g.addColorStop(.35, rgba(COL.glow, .14)); g.addColorStop(1, rgba(COL.glow, 0));
    ctx.fillStyle = g; dot(0, 0, 58);
    ctx.globalCompositeOperation = 'source-over';
    if (!still) {
      const ph = (now % 2800) / 2800;
      ctx.strokeStyle = rgba(COL.accent, (1 - ph) * .4); ctx.lineWidth = 1; ring(0, 0, 22 + ph * 32);
    }
    ctx.strokeStyle = rgba(COL.accent, .2); ctx.lineWidth = 7; ring(0, 0, 21 + 1.5 * k);
    ctx.strokeStyle = COL.accent; ctx.lineWidth = 1.8; ring(0, 0, 21 + 1.5 * k);
    ctx.setLineDash([2, 6]); ctx.lineDashOffset = still ? 0 : -now * .008;
    ctx.strokeStyle = rgba(COL.accent, .55); ctx.lineWidth = 1; ring(0, 0, 29);
    ctx.setLineDash([]); ctx.lineDashOffset = 0;
    g = ctx.createRadialGradient(-3, -3, 0, 0, 0, 12 + k);
    g.addColorStop(0, COL.text); g.addColorStop(.3, COL.text); g.addColorStop(.7, COL.accent); g.addColorStop(1, rgba(COL.accent, .55));
    ctx.fillStyle = COL.field; dot(0, 0, 12 + k);
    ctx.fillStyle = g; dot(0, 0, 12 + k);
  } else if (n.kind === 'block') {
    if (n.role === 'red') ctx.globalAlpha *= .4;          // red blocks: muted
    // the explorer's own block mark: two stacked rhombi
    ctx.lineJoin = 'miter'; ctx.strokeStyle = COL.accent; ctx.lineWidth = 1.4;
    rhombus(3, 9, 4.6); ctx.fillStyle = COL.field; ctx.fill(); ctx.stroke();
    rhombus(-2.5, 9, 4.6); ctx.fillStyle = COL.field; ctx.fill(); ctx.fillStyle = rgba(COL.accent, .2); ctx.fill(); ctx.stroke();
  } else {
    const boxy = n.role === 'contract' || n.role === 'system';
    const core = boxy || n.role === 'miner' ? COL.accent : COL.text;
    ctx.fillStyle = rgba(COL.accent, .09); dot(0, 0, 13);
    ctx.fillStyle = COL.field; ctx.strokeStyle = COL.text; ctx.lineWidth = 1.4;
    ctx.beginPath();
    if (boxy) ctx.rect(-6.5, -6.5, 13, 13); else ctx.arc(0, 0, 7, 0, 6.2832);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = core;
    if (boxy) ctx.fillRect(-2.5, -2.5, 5, 5); else dot(0, 0, 2.6);
  }
  if (n === hot) {
    ctx.setTransform(dpr, 0, 0, dpr, n.x * dpr, n.y * dpr);
    ctx.strokeStyle = rgba(COL.text, .8); ctx.lineWidth = 1; ring(0, 0, n.isCenter ? 36 : 16);
  }
  ctx.restore();
}

function tagOf(n) {
  if (n.isCenter) return (centerInfo.label || CENTER_LABEL).toUpperCase();
  if (n.role === 'system') return (n.label || 'system').toUpperCase();
  return n.role ? n.role.toUpperCase() : '';
}

// Where each label goes, in priority order: the hovered node, the centre, the block column,
// tagged addresses, then the most recently active. A label that would cover one already placed
// is left out (its node still shows it on hover or tap).
function placeLabels(T, hot) {
  const items = [];
  for (const n of nodes) {
    if (!n.spawned) continue;
    const a = clamp((T - n.at - .15) / .4) * life(n, T) * (hot && hot !== n && !n.adj.has(hot) ? .25 : 1);
    if (a <= 0) continue;
    const text = short(n.id);
    ctx.font = `600 13px ${HEAD}`;
    const tw = ctx.measureText(text).width;
    let it;
    if (n.spine) {
      const left = n.hx < cx, x = n.x + (left ? -15 : 15);
      it = { n, a, text, x, y: n.y, align: left ? 'right' : 'left', fill: COL.accent, box: [left ? x - tw - 2 : x - 2, n.y - 9, left ? x + 2 : x + tw + 2, n.y + 9] };
    } else {
      const r = n.isCenter ? 37 : n.kind === 'block' ? 12 : 14;
      const sgn = !n.isCenter && n.hy < cy - 1 ? -1 : 1;
      const half = tw / 2 + 6, x = clamp(n.x, half, W - half), y = n.y + sgn * (r + 9);
      const tag = tagOf(n);
      ctx.font = `600 11px ${HEAD}`;
      const th = tag ? ctx.measureText(tag).width / 2 + 6 : 0, tagX = clamp(x, th, W - th), tagY = y + sgn * 13;
      const hw = Math.max(tw / 2, th - 6) + 2, top = Math.min(y, tag ? tagY : y) - 9, bottom = Math.max(y, tag ? tagY : y) + 9;
      it = { n, a, text, x, y, align: 'center', fill: n.kind === 'block' ? COL.accent : COL.text, tag, tagX, tagY, box: [x - hw, top, x + hw, bottom] };
    }
    it.pri = n === hot ? 0 : n.isCenter ? 1 : n.spine ? 2 : n.kind === 'block' ? 3 : it.tag ? 4 : 5;
    it.recent = Math.max(-1, ...n.links.map(e => e.block));
    items.push(it);
  }
  items.sort((p, q) => p.pri - q.pri || q.recent - p.recent);
  const placed = [];
  for (const it of items) if (it.pri <= 2 || !placed.some(o => hits(o.box, it.box))) placed.push(it);
  return placed;
}

function drawLabels(placed) {
  ctx.textBaseline = 'middle';
  for (const it of placed) {
    ctx.globalAlpha = it.a; ctx.font = `600 13px ${HEAD}`; ctx.textAlign = it.align;
    outlined(it.text, it.x, it.y, it.fill);
    if (it.tag) { ctx.font = `600 11px ${HEAD}`; ctx.textAlign = 'center'; outlined(it.tag, it.tagX, it.tagY, it.n.isCenter ? COL.accent : COL.muted); }
  }
  ctx.globalAlpha = 1;
}

function draw(now, T) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawBackdrop(now);
  const hot = drag || hover;
  drawEdges(T, hot);
  for (const n of nodes) if (n.spawned && !n.isCenter) drawNode(n, now, T, hot);
  if (center && center.spawned) drawNode(center, now, T, hot);
  const placed = placeLabels(T, hot);
  drawValueLabels(T, placed.map(it => it.box));
  drawLabels(placed);
}

/* ───────────────────────── gauges under the map ───────────────────────── */

// network figures from the node (/api/map radar): each a ratio from 0 to 1, drawn on a square-root scale
let RADAR_AXES = ['PACE', 'BLUE', 'MINERS', 'GAS', 'BURN', 'LOCKED', 'NGOS', 'FINALITY'];
let radarVals = new Array(RADAR_AXES.length).fill(.08), radarGoal = new Array(RADAR_AXES.length).fill(.08);
function applyRadar(list) {
  if (!Array.isArray(list) || !list.length) return;
  if (list.length !== RADAR_AXES.length) { radarVals = new Array(list.length).fill(.08); }
  RADAR_AXES = list.map(x => String(x.axis));
  radarGoal = list.map(x => Math.max(.04, Math.sqrt(Math.min(1, Math.max(0, Number(x.value) || 0)))));
  const ul = $('hm-radar-list');
  if (ul) {
    ul.replaceChildren(...list.map(x => { const li = el('li'); li.append(el('b', null, String(x.axis)), document.createTextNode(' ' + String(x.text))); return li; }));
  }
}
let lastSig = '', lastBlk = '', lastBar = -1;

function updateGauges(T) {
  let bornN = 0, bornE = 0;
  for (const n of nodes) if (T >= n.at) bornN++;
  for (const e of edges) if (T >= e.at) bornE++;
  const sig = bornN + '|' + bornE + '|' + rev;
  if (sig !== lastSig) {
    lastSig = sig;
    const seen = txLog.filter(t => T >= t.at);
    const by = (list, k) => list.filter(t => t.kind === k).length;
    const onMap = (list, f) => list.filter(x => x.out === null && T >= x.at && f(x)).length;
    // block-height strip: every transaction warms the bucket its block falls in
    const cells = strip.children, heat = new Array(cells.length).fill(0), top = Math.max(1, shownTip);
    for (const t of seen) heat[Math.min(cells.length - 1, Math.floor(t.block / top * cells.length))] += .34 + .1 * Math.log10(1 + t.psy);
    for (let i = 0; i < cells.length; i++) {
      const h = clamp(heat[i]);
      cells[i].style.background = h ? `color-mix(in srgb, ${COL.accent} ${Math.round(25 + 75 * h)}%, ${COL.line})` : '';
      cells[i].style.opacity = h ? '1' : '';
    }
    $('hm-axis-end').textContent = fmt(shownTip);
    for (const b of chips.querySelectorAll('b')) b.textContent = String(by(seen, b.dataset.k));
    txcEl.textContent = fmt(seen.length);
    movedEl.textContent = fmtPsy(seen.reduce((s, t) => s + t.psy, 0));
  }
  const bt = fmt(Math.round(heightAt(T)));
  if (bt !== lastBlk) { lastBlk = bt; blkEl.textContent = bt; }
  const bar = T < introEnd ? 0 : Math.round(clamp((Date.now() / 1000 - shownTipAt) / chain.spacing) * 100);
  if (bar !== lastBar) { lastBar = bar; nextBar.style.width = bar + '%'; }
  drawRadar();
}
const fmtPsy = v => v.toLocaleString(LOCALE, { maximumFractionDigits: 6 });

function drawRadar() {
  const w = radar.clientWidth, h = radar.clientHeight, N = RADAR_AXES.length;
  rc.setTransform(dpr, 0, 0, dpr, 0, 0); rc.clearRect(0, 0, w, h);
  const ox = w / 2, oy = h / 2, R = Math.max(18, Math.min(h / 2 - 15, w / 2 - 46));
  const at = (i, k) => { const a = i * 2 * Math.PI / N - Math.PI / 2; return [ox + Math.cos(a) * R * k * 1.1, oy + Math.sin(a) * R * k]; };
  rc.lineWidth = 1; rc.strokeStyle = COL.line;
  for (const k of [1 / 3, 2 / 3, 1]) {
    rc.beginPath();
    for (let i = 0; i <= N; i++) { const [x, y] = at(i % N, k); i ? rc.lineTo(x, y) : rc.moveTo(x, y); }
    rc.stroke();
  }
  rc.font = `600 10px ${HEAD}`; rc.textBaseline = 'middle'; rc.fillStyle = COL.muted;
  rc.beginPath();
  for (let i = 0; i < N; i++) {
    const [x, y] = at(i, 1); rc.moveTo(ox, oy); rc.lineTo(x, y);
    const dx = x - ox, side = Math.abs(dx) < 2 ? 0 : dx > 0 ? 1 : -1;
    const [lx, ly] = at(i, side ? 1.08 : 1.24);
    rc.textAlign = side === 0 ? 'center' : side > 0 ? 'left' : 'right';
    rc.fillText(RADAR_AXES[i], lx + side * 4, ly);
  }
  rc.stroke();
  rc.beginPath();
  for (let i = 0; i <= N; i++) {
    const j = i % N;
    if (i < N) radarVals[j] += (radarGoal[j] - radarVals[j]) * (still ? 1 : .06);
    const [x, y] = at(j, radarVals[j]); i ? rc.lineTo(x, y) : rc.moveTo(x, y);
  }
  rc.fillStyle = rgba(COL.accent, .18); rc.fill();
  rc.strokeStyle = COL.accent; rc.lineWidth = 1.4; rc.stroke();
  rc.fillStyle = COL.accent;
  for (let i = 0; i < N; i++) { const [x, y] = at(i, radarVals[i]); rc.beginPath(); rc.arc(x, y, 1.8, 0, 6.2832); rc.fill(); }
}

/* ───────────────────────── tooltip ───────────────────────── */

function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function valueText(e) {
  if (e.kind === 'transfer') return valueLabel(e) + (e.failed ? ' · ' + L('failed') : '');
  if (e.kind === 'alloc') return valueLabel(e) + ' · ' + L('genesis');
  if (e.kind === 'call') return valueLabel(e) + ' · ' + (e.failed ? L('call, failed') : L('call'));
  if (e.kind === 'deploy') return valueLabel(e) + ' · ' + L('new contract');
  return e.kind === 'parent' ? L('parent') : L('includes tx');
}
function setTip(n) {
  if (n === tipNode) return;
  tipNode = n;
  if (!n) { tip.hidden = true; return; }
  const tNow = clock(performance.now());
  const links = n.links.filter(e => tNow >= e.at && e.out === null).sort((p, q) => q.block - p.block);
  const meta = [n.isCenter ? (centerInfo.label || L('centre address')) : n.role === 'system' ? n.label : T(n.role || n.kind), links.length === 1 ? L('1 line') : L('{n} lines', { n: links.length })];
  const table = el('table'), head = el('tr');
  for (const h of ['from', 'to', 'value', 'block']) head.append(el('th', '', T(h)));
  table.append(head);
  for (const e of links.slice(0, 8)) {
    const tr = el('tr'), from = el('td'), sw = el('span', 'sw');
    sw.style.setProperty('--c', e.col);
    from.append(sw, short(e.from));
    tr.append(from, el('td', '', short(e.to)), el('td', '', valueText(e)), el('td', '', fmt(e.block)));
    table.append(tr);
  }
  const parts = [el('div', 'id', n.kind === 'block' ? L('Block {ref}', { ref: fmt(n.number) }) : n.id), el('div', 'meta', meta.join(' · ')), table];
  if (links.length > 8) parts.push(el('p', 'more', L('+ {n} earlier', { n: links.length - 8 })));
  tip.replaceChildren(...parts);
  tip.hidden = false;
}
function refreshTip() { if (tipNode) { const n = tipNode; tipNode = null; setTip(n); } }
function placeTip() {
  if (!tipNode) return;
  const pad = 10, tw = tip.offsetWidth, th = tip.offsetHeight, gap = tipNode.isCenter ? 40 : 20;
  let x = tipNode.x + gap, y = tipNode.y + gap;
  if (x + tw > W - pad) x = tipNode.x - gap - tw;
  x = clamp(x, pad, Math.max(pad, W - pad - tw));
  if (y + th > H - pad) y = tipNode.y - gap - th;
  y = clamp(y, pad, Math.max(pad, H - pad - th));
  tip.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
}

/* ───────────────────────── interaction ───────────────────────── */

function hit(px, py, reach) {
  let best = null, bd = reach;
  for (const n of nodes) {
    if (!n.spawned || n.out !== null) continue;
    const d = Math.hypot(n.x - px, n.y - py) - (n.isCenter ? 14 : 0);
    if (d < bd) { bd = d; best = n; }
  }
  return best;
}
function pos(ev) { const r = canvas.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; }

canvas.addEventListener('pointerdown', ev => {
  const [x, y] = pos(ev), n = hit(x, y, ev.pointerType === 'mouse' ? 16 : 26);
  hover = n; setTip(n);
  if (n) { drag = n; try { canvas.setPointerCapture(ev.pointerId); } catch (_) {} canvas.style.cursor = 'grabbing'; }
});
// a finger on a node drags the node; a finger anywhere else still scrolls the page
canvas.addEventListener('touchstart', ev => {
  const t = ev.touches[0], r = canvas.getBoundingClientRect();
  if (t && hit(t.clientX - r.left, t.clientY - r.top, 26)) ev.preventDefault();
}, { passive: false });
canvas.addEventListener('pointermove', ev => {
  const [x, y] = pos(ev);
  if (drag) { drag.x = clamp(x, 8, W - 8); drag.y = clamp(y, 8, H - 8); return; }
  if (ev.pointerType !== 'mouse') return;
  hover = hit(x, y, 16); setTip(hover);
  canvas.style.cursor = hover ? 'grab' : 'default';
});
const release = ev => {
  if (!drag) return;
  drag = null; canvas.style.cursor = ev.pointerType === 'mouse' && hover ? 'grab' : 'default';
};
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('pointerleave', ev => { if (ev.pointerType === 'mouse' && !drag) { hover = null; setTip(null); } });

/* ───────────────────────── the rest of the home page ───────────────────────── */

function renderStats(stats) {
  const cards = $('hm-stats').children;
  stats.forEach(([, v], i) => { const dd = cards[i] && cards[i].lastElementChild; if (dd && dd.textContent !== v) dd.textContent = v; });
}

// Rows in the same markup as the server's transaction table (Explorer.txTable)
const cut = h => (h.length < 16 ? h : h.slice(0, 10) + '…' + h.slice(-6));
function ago(sec) {
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 60) return L('{n}s ago', { n: d });
  if (d < 3600) return L('{n}m ago', { n: Math.floor(d / 60) });
  if (d < 86400) return L('{n}h ago', { n: Math.floor(d / 3600) });
  return new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ');
}
function addrLink(hex) {
  if (!hex) return el('span', 'muted', L('contract creation'));
  const a = el('a', '', labelOf(hex) || cut(hex)); a.href = '/address/' + hex; return a;
}
function link(href, text) { const a = el('a', '', text); a.href = href; return a; }
function tableRow(t) {
  const tr = el('tr'), c = [el('td'), el('td'), el('td'), el('td'), el('td', '', t.valueText + ' PSY')];
  const age = el('div', 'muted', ago(t.ts)); age.dataset.ts = t.ts;
  c[0].append(link('/block/' + t.block, String(t.block)), age);
  c[1].append(link('/tx/' + t.hash, cut(t.hash)));
  if (t.status === 0) c[1].append(' ', el('span', 'muted', L('failed')));
  c[2].append(addrLink(t.from));
  if (!t.to && t.contract) c[3].append(addrLink(t.contract), ' ', el('span', 'muted', L('(new contract)')));
  else c[3].append(addrLink(t.to));
  if (t.call) c[3].append(el('div', 'muted', t.call));
  tr.append(...c); tr.dataset.hash = t.hash;
  return tr;
}
const tbody = () => document.querySelector('#hm-txs tbody');
function addTableRow(t) {
  const body = tbody(); if (!body || body.querySelector(`tr[data-hash="${t.hash}"]`)) return;
  const empty = body.querySelector('td[colspan]'); if (empty) empty.parentElement.remove();
  body.prepend(tableRow(t));
  while (body.children.length > 10) body.lastElementChild.remove();
}
function renderTable(txs) {
  const body = tbody(); if (!body) return;
  const rows = txs.slice(0, 10).map(tableRow);
  if (rows.length) body.replaceChildren(...rows);
  else { const tr = el('tr'), td = el('td', '', L('No transactions yet.')); td.colSpan = 5; tr.append(td); body.replaceChildren(tr); }
}
// the server rendered the first rows; tag them with their time so the ages keep counting
function adoptTableRows(txs) {
  const byHash = new Map(txs.map(t => [t.hash, t]));
  for (const tr of document.querySelectorAll('#hm-txs tbody tr')) {
    const a = tr.querySelector('a[href^="/tx/"]'), t = a && byHash.get(a.getAttribute('href').slice(4));
    if (!t) continue;
    tr.dataset.hash = t.hash;
    const age = tr.querySelector('td div.muted'); if (age) age.dataset.ts = t.ts;
  }
}
function refreshAges() {
  for (const d of document.querySelectorAll('#hm-txs [data-ts]')) { const v = ago(+d.dataset.ts); if (d.textContent !== v) d.textContent = v; }
}

// keep the newest block of the shared rail (filled by live.js) in view in the narrow column
const rail = $('block-rail');
if (rail) new MutationObserver(() => { rail.scrollLeft = rail.scrollWidth; }).observe(rail, { childList: true });

/* ───────────────────────── run ───────────────────────── */

function frame(now) {
  const T = clock(now);
  if (centerInfo) {
    drainFeed(T);
    purge(T);
    simulate(T);
    if (onScreen) { draw(now, T); updateGauges(T); placeTip(); }
  }
  requestAnimationFrame(frame);
}

async function start() {
  resize();
  new ResizeObserver(resize).observe(box);
  new IntersectionObserver(es => { onScreen = es[0].isIntersecting; }).observe(box);
  setInterval(refreshAges, 10000);
  requestAnimationFrame(frame);
  for (;;) {
    try {
      const snap = await fetchMap('');
      rebuild(snap, true);
      adoptTableRows(snap.txs);
      setOnline(true);
      schedulePoll();
      return;
    } catch (_) {
      setOnline(false);
      await new Promise(r => setTimeout(r, POLL_RETRY_MS));
    }
  }
}
start();
})();
