// Server-rendered SVG charts in the explorer's theme (no libraries, no external files). Every label is escaped. Lines
// draw themselves in, bars grow and rings fill with CSS animations (pathLength="1" with stroke-dashoffset); the
// animations stop for visitors who ask for reduced motion. The CSS is CHART_CSS, added once to the page layout.

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const n = (x) => (Number.isFinite(x) ? Math.round(x * 100) / 100 : 0);

export const COLORS = ['#3ee0d6', '#8de9b8', '#8aa8a6', '#e7f4f2', '#d99'];

export const CHART_CSS =
  '.chart{width:100%;height:auto;display:block;overflow:visible}.chart text{fill:var(--mute);font:500 11px "Barlow Condensed",sans-serif;letter-spacing:.06em}' +
  '.chart .grid{stroke:var(--line);stroke-width:1}.chart .axis{stroke:var(--mute);stroke-width:1}' +
  '.chart .draw{stroke-dasharray:1;stroke-dashoffset:1;animation:chart-draw 1.8s ease-out forwards}.chart .area{opacity:0;animation:chart-fade 1.2s .8s ease-out forwards}' +
  '.chart .dot{animation:chart-pulse 2.4s ease-in-out infinite}.chart .bar{transform-box:fill-box;transform-origin:left center;animation:chart-grow 1.1s ease-out both}' +
  '.chart .vbar{transform-box:fill-box;transform-origin:center bottom;animation:chart-rise 1s ease-out both}.chart .ring{stroke-dasharray:1;stroke-dashoffset:1;animation:chart-draw 1.6s ease-out forwards}' +
  '.chart .big{fill:var(--ink);font:600 26px "Barlow Condensed",sans-serif}.chart .seat{animation:chart-fade .6s ease-out both}' +
  '.legend{display:flex;flex-wrap:wrap;gap:6px 16px;margin:6px 0 0;padding:0;list-style:none;font:500 13px "Barlow Condensed",sans-serif;letter-spacing:.06em;color:var(--mute)}' +
  '.legend i{display:inline-block;width:10px;height:10px;margin-right:6px;vertical-align:-1px}' +
  '.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;margin:14px 0}.charts .panel h3{font-size:16px;margin-bottom:8px}' +
  '@keyframes chart-draw{to{stroke-dashoffset:0}}@keyframes chart-fade{to{opacity:1}}@keyframes chart-grow{from{transform:scaleX(0)}}@keyframes chart-rise{from{transform:scaleY(0)}}' +
  '@keyframes chart-pulse{0%,100%{opacity:1}50%{opacity:.35}}@media (prefers-reduced-motion:reduce){.chart *{animation:none!important;stroke-dashoffset:0!important;opacity:1!important}}';

const legend = (items) => `<ul class="legend">${items.map(([c, t]) => `<li><i style="background:${c}"></i>${esc(t)}</li>`).join('')}</ul>`;

/**
 * Line chart. series: [{ name, color, points: [[x, y], ...] }]; marker: { x, label } draws a vertical line (for "now").
 * fmtX / fmtY format tick labels; ticks are chosen evenly.
 */
export function lineChart({ series, title = '', fmtX = String, fmtY = String, marker = null, yMin = null, height = 220, area = true, xTicks = 5, yTicks = 4 }) {
  const W = 600, H = height, L = 58, R = 14, T = 12, B = 28;
  const pts = series.flatMap((s) => s.points);
  if (!pts.length) return `<p class="muted">No data yet.</p>`;
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs, x0 + 1e-9);
  const y0 = yMin ?? Math.min(0, ...ys), y1 = Math.max(...ys, y0 + 1e-9);
  const X = (x) => L + ((x - x0) / (x1 - x0 || 1)) * (W - L - R), Y = (y) => T + (1 - (y - y0) / (y1 - y0 || 1)) * (H - T - B);
  let g = '';
  for (let i = 0; i <= yTicks; i++) {
    const v = y0 + ((y1 - y0) * i) / yTicks, y = n(Y(v));
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y}" y2="${y}"/><text x="${L - 6}" y="${y + 4}" text-anchor="end">${esc(fmtY(v))}</text>`;
  }
  for (let i = 0; i <= xTicks; i++) {
    const v = x0 + ((x1 - x0) * i) / xTicks;
    g += `<text x="${n(X(v))}" y="${H - 8}" text-anchor="middle">${esc(fmtX(v))}</text>`;
  }
  let lines = '', defs = '';
  series.forEach((s, k) => {
    if (!s.points.length) return;
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${n(X(p[0]))},${n(Y(p[1]))}`).join('');
    if (area && k === 0) {
      defs += `<linearGradient id="g${k}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${s.color}" stop-opacity=".28"/><stop offset="1" stop-color="${s.color}" stop-opacity="0"/></linearGradient>`;
      lines += `<path class="area" fill="url(#g${k})" d="${d}L${n(X(s.points.at(-1)[0]))},${n(Y(y0))}L${n(X(s.points[0][0]))},${n(Y(y0))}Z"/>`;
    }
    lines += `<path class="draw" pathLength="1" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" d="${d}" style="animation-delay:${k * 0.25}s"/>`;
    const last = s.points.at(-1);
    lines += `<circle class="dot" cx="${n(X(last[0]))}" cy="${n(Y(last[1]))}" r="3.5" fill="${s.color}"/>`;
  });
  if (marker && marker.x >= x0 && marker.x <= x1) {
    const mx = n(X(marker.x));
    lines += `<line x1="${mx}" x2="${mx}" y1="${T}" y2="${H - B}" stroke="var(--cyan)" stroke-dasharray="3 4"/><text x="${mx + 5}" y="${T + 10}" fill="var(--cyan)">${esc(marker.label)}</text>`;
  }
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}"><defs>${defs}</defs>${g}<line class="axis" x1="${L}" x2="${W - R}" y1="${H - B}" y2="${H - B}"/>${lines}</svg>` +
    (series.length > 1 || series[0]?.name ? legend(series.map((s) => [s.color, s.name])) : '');
}

/** Horizontal bars. items: [{ label, value, color?, text? }] with values from 0 to max. */
export function barChart({ items, title = '', max = null, fmt = String }) {
  if (!items.length) return '<p class="muted">No data yet.</p>';
  const W = 600, row = 26, L = 150, H = items.length * row + 6;
  const m = max ?? Math.max(...items.map((x) => x.value), 1e-9);
  const bars = items.map((x, i) => {
    const w = n(Math.max(0, Math.min(1, x.value / (m || 1))) * (W - L - 70));
    return `<text x="${L - 8}" y="${i * row + 17}" text-anchor="end">${esc(x.label)}</text>` +
      `<rect x="${L}" y="${i * row + 6}" width="${W - L - 70}" height="14" fill="var(--field)" stroke="var(--line)"/>` +
      `<rect class="bar" x="${L}" y="${i * row + 6}" width="${w}" height="14" fill="${x.color ?? COLORS[0]}" style="animation-delay:${i * 0.07}s"/>` +
      `<text x="${L + w + 6}" y="${i * row + 17}">${esc(x.text ?? fmt(x.value))}</text>`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${bars}</svg>`;
}

/** Vertical bars for a series (e.g. block intervals). values: numbers; target draws a dashed line. */
export function columnChart({ values, title = '', target = null, fmtY = String, color = COLORS[0], height = 170, labels = null }) {
  if (!values.length) return '<p class="muted">No data yet.</p>';
  const W = 600, H = height, L = 40, B = 18, T = 8;
  const m = Math.max(...values, target ?? 0, 1e-9);
  const bw = (W - L - 6) / values.length;
  const Y = (v) => T + (1 - v / m) * (H - T - B);
  const bars = values.map((v, i) => `<rect class="vbar" x="${n(L + i * bw + 1)}" y="${n(Y(v))}" width="${n(Math.max(1, bw - 2))}" height="${n(H - B - Y(v))}" fill="${color}" opacity=".85" style="animation-delay:${n(i * 0.012)}s"/>`).join('');
  const tl = target === null ? '' : `<line x1="${L}" x2="${W - 4}" y1="${n(Y(target))}" y2="${n(Y(target))}" stroke="var(--ink)" stroke-dasharray="4 4"/><text x="${W - 4}" y="${n(Y(target)) - 4}" text-anchor="end" fill="var(--ink)">target ${esc(fmtY(target))}</text>`;
  const axis = `<text x="${L - 6}" y="${T + 8}" text-anchor="end">${esc(fmtY(m))}</text><text x="${L - 6}" y="${H - B}" text-anchor="end">0</text>` +
    (labels ? `<text x="${L}" y="${H - 4}">${esc(labels[0])}</text><text x="${W - 4}" y="${H - 4}" text-anchor="end">${esc(labels[1])}</text>` : '');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}"><line class="axis" x1="${L}" x2="${W - 4}" y1="${H - B}" y2="${H - B}"/>${axis}${bars}${tl}</svg>`;
}

/** Ring split into parts. parts: [{ label, value, color }]; center: big text in the middle. */
export function donut({ parts, title = '', center = '', sub = '' }) {
  const total = parts.reduce((s, p) => s + Math.max(0, p.value), 0);
  const r = 70, C = 2 * Math.PI * r;
  let off = 0, rings = '';
  parts.forEach((p, i) => {
    const f = total ? Math.max(0, p.value) / total : 0;
    if (f <= 0) return;
    rings += `<circle cx="100" cy="100" r="${r}" fill="none" stroke="${p.color}" stroke-width="22" stroke-dasharray="${n(f * C)} ${n(C)}" stroke-dashoffset="${n(-off * C)}" transform="rotate(-90 100 100)" class="seat" style="animation-delay:${i * 0.15}s"/>`;
    off += f;
  });
  if (!rings) rings = `<circle cx="100" cy="100" r="${r}" fill="none" stroke="var(--line)" stroke-width="22"/>`;
  return `<svg class="chart" viewBox="0 0 200 200" style="max-width:240px;margin:auto" role="img" aria-label="${esc(title)}">${rings}` +
    `<text class="big" x="100" y="104" text-anchor="middle">${esc(center)}</text><text x="100" y="124" text-anchor="middle">${esc(sub)}</text></svg>` +
    legend(parts.map((p) => [p.color, `${p.label}${total ? ` ${(100 * Math.max(0, p.value) / total).toFixed(1)} %` : ''}`]));
}

/** Half-ring gauge for a value from 0 to 1. */
export function gauge({ value, title = '', center = '', sub = '' }) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  const d = 'M20,110 A80,80 0 0 1 180,110';
  return `<svg class="chart" viewBox="0 0 200 130" style="max-width:260px;margin:auto" role="img" aria-label="${esc(title)}">` +
    `<path d="${d}" fill="none" stroke="var(--line)" stroke-width="14" stroke-linecap="round"/>` +
    (v > 0 ? `<path class="ring" pathLength="1" d="${d}" fill="none" stroke="var(--cyan)" stroke-width="14" stroke-linecap="round" style="stroke-dasharray:${v} 2"/>` : '') +
    `<text class="big" x="100" y="100" text-anchor="middle">${esc(center)}</text><text x="100" y="124" text-anchor="middle">${esc(sub)}</text></svg>`;
}

/** Seats as squares (e.g. the 21 committee seats): groups [{ label, count, filled, color }]. */
export function seats({ groups, title = '', perRow = 11 }) {
  let i = 0, out = '';
  for (const g of groups) {
    for (let k = 0; k < g.count; k++, i++) {
      const x = 6 + (i % perRow) * 30, y = 6 + Math.floor(i / perRow) * 30;
      out += `<rect class="seat" x="${x}" y="${y}" width="24" height="24" fill="${k < g.filled ? g.color : 'none'}" stroke="${g.color}" stroke-width="2" style="animation-delay:${n(i * 0.04)}s"><title>${esc(g.label)}</title></rect>`;
    }
  }
  const rows = Math.ceil(i / perRow);
  return `<svg class="chart" viewBox="0 0 ${perRow * 30 + 6} ${rows * 30 + 6}" style="max-width:${perRow * 34}px" role="img" aria-label="${esc(title)}">${out}</svg>` +
    legend(groups.map((g) => [g.color, `${g.label}: ${g.filled} of ${g.count}`]));
}
