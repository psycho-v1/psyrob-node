// The dashboard page of PSYROB Miner: one self-contained HTML document (styles, texts in 11 languages and the client
// code inline: the page's Content-Security-Policy allows nothing from elsewhere, and the miner is a single program).

import { LANGS, LANG_CODES, pickLang } from '../../common/langs.js';
import { client } from './client.js';
import en from './lang/en.js';
import de from './lang/de.js';
import nl from './lang/nl.js';
import es from './lang/es.js';
import pt from './lang/pt.js';
import ru from './lang/ru.js';
import ar from './lang/ar.js';
import hi from './lang/hi.js';
import zhCN from './lang/zh-CN.js';
import zhTW from './lang/zh-TW.js';
import ko from './lang/ko.js';

export { LANG_CODES };
export const STRINGS = { en, de, nl, es, pt, ru, ar, hi, 'zh-CN': zhCN, 'zh-TW': zhTW, ko };

// JSON inside <script>: "<" escaped so no text can close the script element
const data = (x) => JSON.stringify(x).replace(/</g, '\\u003c');

const FONTS = [['Barlow Condensed', 500, 'barlow-condensed-latin-ext-500-normal', 'ext'], ['Barlow Condensed', 500, 'barlow-condensed-latin-500-normal', 'latin'],
  ['Barlow Condensed', 600, 'barlow-condensed-latin-ext-600-normal', 'ext'], ['Barlow Condensed', 600, 'barlow-condensed-latin-600-normal', 'latin'],
  ['Source Serif 4', '200 900', 'source-serif-4-latin-ext-opsz-normal', 'ext'], ['Source Serif 4', '200 900', 'source-serif-4-latin-opsz-normal', 'latin']];
// the explorer's unicode ranges (node/web/vendor/fonts.css); other scripts (Arabic, Devanagari, CJK, Cyrillic, Hangul) use the system fonts
const RANGE = { latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  ext: 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C4,U+2113,U+2C60-2C7F,U+A720-A7FF' };
const FONT_CSS = FONTS.map(([fam, w, f, r]) => `@font-face{font-family:'${fam}';font-style:normal;font-display:swap;font-weight:${w};src:url(/assets/fonts/${f}.woff2) format('woff2');unicode-range:${RANGE[r]}}`).join('');

// PSYROB colours (the explorer's): ink on a near-black teal, one cyan accent, square panels with hairline borders
const CSS = FONT_CSS + `
:root{color-scheme:dark;--bg:#071014;--surface:#0c181c;--raised:#081216;--line:#1c3336;--ink:#e7f4f2;--ink2:#b9cfcc;--mute:#8aa8a6;--accent:#3ee0d6;--accent-ink:#06201e;--focus:#7af0e8;
--s1:#22a39b;--s2:#9085e9;--grid:#14262a;--good:#3cc83c;--warn:#fab219;--bad:#ef6b6b;--info:#6ea8f0;--warnbg:#151208;--warnline:#6b5a2a;--warnink:#e8d9a8;--hd:'Barlow Condensed','Arial Narrow',sans-serif;--tx:'Source Serif 4',Palatino,Georgia,serif}
@media (prefers-color-scheme:light){:root:not([data-theme=dark]){color-scheme:light;--bg:#eef4f4;--surface:#ffffff;--raised:#f4f8f8;--line:#cfdcdd;--ink:#0a1a1d;--ink2:#34494d;--mute:#56696c;--accent:#008f84;--accent-ink:#ffffff;--focus:#006e66;
--s1:#008f84;--s2:#6250d6;--grid:#e1eaeb;--good:#0a7d0a;--warn:#9a6700;--bad:#c23434;--info:#2a6fc4;--warnbg:#fff8e6;--warnline:#d9b25a;--warnink:#5a4300}}
:root[data-theme=light]{color-scheme:light;--bg:#eef4f4;--surface:#ffffff;--raised:#f4f8f8;--line:#cfdcdd;--ink:#0a1a1d;--ink2:#34494d;--mute:#56696c;--accent:#008f84;--accent-ink:#ffffff;--focus:#006e66;
--s1:#008f84;--s2:#6250d6;--grid:#e1eaeb;--good:#0a7d0a;--warn:#9a6700;--bad:#c23434;--info:#2a6fc4;--warnbg:#fff8e6;--warnline:#d9b25a;--warnink:#5a4300}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--ink);font:17px/1.5 var(--tx)}
:lang(ar) body,:lang(hi) body,:lang(zh-CN) body,:lang(zh-TW) body,:lang(ko) body,:lang(ru) body{font-family:system-ui,"Noto Sans","Noto Sans Arabic","Noto Sans Devanagari","PingFang SC","Microsoft YaHei","Malgun Gothic",sans-serif;font-size:16px}
a{color:var(--accent)}code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86em;color:var(--accent);overflow-wrap:anywhere;direction:ltr;unicode-bidi:isolate}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.prb{width:16px;height:16px;flex:0 0 16px;color:var(--accent);vertical-align:-3px}
header#top{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 16px;background:color-mix(in srgb,var(--bg) 94%,transparent);backdrop-filter:blur(8px);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;white-space:nowrap;font-family:var(--hd);font-weight:600;letter-spacing:.22em;font-size:18px;color:var(--ink);text-decoration:none}.brand img{width:32px;height:32px}.brand .sub{color:var(--mute);letter-spacing:.16em;font-size:14px}
.net{font:600 12px/1 var(--hd);letter-spacing:.14em;color:var(--accent-ink);background:var(--accent);padding:4px 7px}
.spacer{flex:1}
button{font:500 15px/1 var(--hd);letter-spacing:.1em;text-transform:uppercase;cursor:pointer;border-radius:0;border:1px solid var(--line);background:transparent;color:var(--accent);padding:10px 16px;min-height:40px;display:inline-flex;align-items:center;gap:8px;justify-content:center}
button:hover:not(:disabled){border-color:var(--accent)}button:disabled{opacity:.4;cursor:not-allowed}
button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink);font-weight:600}button.primary .prb{color:var(--accent-ink)}
button.danger{color:var(--bad);border-color:color-mix(in srgb,var(--bad) 45%,var(--line))}button.danger .prb{color:var(--bad)}
button.ghost{color:var(--mute)}button.ghost:hover{color:var(--ink)}button.icon{padding:8px 10px;min-width:40px}button.small{min-height:32px;padding:6px 10px;font-size:13px}
button.link{border:0;background:none;color:var(--accent);padding:0;min-height:0}
.navbtn{color:var(--ink);font-weight:600}.caret{color:var(--mute);width:12px;height:12px}
.dd{position:relative}.menu{position:absolute;inset-inline-start:0;top:calc(100% + 6px);min-width:230px;max-height:70vh;overflow:auto;margin:0;padding:4px 0;list-style:none;background:var(--bg);border:1px solid var(--line);box-shadow:0 12px 30px rgba(0,0,0,.35);z-index:30}
.menu button{display:flex;gap:10px;justify-content:flex-start;width:100%;text-align:start;border:0;color:var(--mute);font:500 14px/1 var(--hd);letter-spacing:.08em;padding:11px 14px;min-height:0}
.menu button:hover,.menu button:focus,.menu button.current{background:var(--surface);color:var(--ink)}.menu button[lang]{text-transform:none;font-family:system-ui,sans-serif;letter-spacing:0;font-size:15px}
#top .dd:last-of-type .menu{inset-inline-start:auto;inset-inline-end:0}
main{max-width:1180px;margin:0 auto;padding:22px 16px 40px;outline:none}
.eyebrow{color:var(--accent);font:600 13px/1 var(--hd);letter-spacing:.16em;text-transform:uppercase;margin:0 0 6px}
h1.title{font:600 clamp(34px,6vw,54px)/.95 var(--hd);margin:0 0 18px}
.card{background:var(--surface);border:1px solid var(--line);padding:16px;min-width:0;margin-bottom:14px}
.card h2{font:600 15px/1.1 var(--hd);letter-spacing:.12em;text-transform:uppercase;color:var(--mute);margin:0 0 12px;display:flex;align-items:center;gap:8px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(175px,1fr));gap:12px;margin-bottom:14px}
.tile{background:var(--surface);border:1px solid var(--line);padding:14px;min-width:0}
.tl{color:var(--mute);font:500 13px/1.2 var(--hd);letter-spacing:.1em;text-transform:uppercase}.tv{font:600 30px/1.05 var(--hd);margin-top:6px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.ts{color:var(--mute);font-size:14px;margin-top:4px;overflow-wrap:anywhere}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:14px;margin-bottom:14px}.grid2>.card{margin-bottom:0}
.badge{display:inline-flex;align-items:center;gap:6px;font:600 13px/1 var(--hd);letter-spacing:.1em;text-transform:uppercase;white-space:nowrap}.badge .prb{width:14px;height:14px}
.badge.good{color:var(--good)}.badge.good .prb{color:var(--good)}.badge.warn{color:var(--warn)}.badge.warn .prb{color:var(--warn)}.badge.bad{color:var(--bad)}.badge.bad .prb{color:var(--bad)}
.badge.idle{color:var(--mute)}.badge.idle .prb{color:var(--mute)}.badge.info{color:var(--info)}.badge.info .prb{color:var(--info)}
.pill .badge{border:1px solid var(--line);padding:8px 10px}
.notice{border:1px solid var(--line);border-inline-start:3px solid var(--accent);background:var(--raised);padding:12px 14px;margin:0 0 14px}.notice p{margin:6px 0}
.notice.warn{border-color:var(--warnline);background:var(--warnbg);color:var(--warnink)}.notice.bad{border-color:color-mix(in srgb,var(--bad) 50%,var(--line));border-inline-start-color:var(--bad)}
.secret{display:block;font-size:15px;padding:10px;background:var(--bg);border:1px dashed var(--warn);margin:8px 0;user-select:all}
.muted{color:var(--mute)}.hint{color:var(--mute);font-size:14px;margin:4px 0 0}.err{color:var(--bad);min-height:1.2em;margin:6px 0}
.big{font:600 34px/1 var(--hd);margin:12px 0 6px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;margin-top:10px}.row .field{flex:1;min-width:200px;margin:0}
.field{margin:10px 0}label{display:block;color:var(--mute);font:500 13px/1.2 var(--hd);letter-spacing:.08em;text-transform:uppercase;margin-bottom:5px}
input,select{font:16px/1.3 var(--tx);width:100%;background:var(--raised);color:var(--ink);border:1px solid var(--line);border-radius:0;padding:9px 10px;min-height:40px}
input:focus,select:focus{border-color:var(--accent);outline:none}
.check{display:flex;gap:10px;align-items:flex-start;margin-top:14px;color:var(--ink);font:16px/1.4 var(--tx);text-transform:none;letter-spacing:0}.check input{width:18px;height:18px;min-height:0;margin-top:3px;flex:none;accent-color:var(--accent)}
.addr{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.addr code{font-size:14px}
.kv{display:grid;grid-template-columns:minmax(130px,auto) 1fr;gap:8px 16px;margin:0}.kv dt{color:var(--mute);font:500 13px/1.5 var(--hd);letter-spacing:.08em;text-transform:uppercase}.kv dd{margin:0;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.scroll{overflow-x:auto}
table{border-collapse:collapse;width:100%;font-size:15px}th,td{text-align:start;padding:10px 8px;border-bottom:1px solid var(--line);white-space:nowrap}th{color:var(--mute);font:500 13px/1 var(--hd);letter-spacing:.08em;text-transform:uppercase}
td.num{font-variant-numeric:tabular-nums}
.chart{position:relative}.chart svg{width:100%;height:220px;display:block;touch-action:none}.chart .empty{position:absolute;inset:0;display:grid;place-items:center;margin:0;color:var(--mute)}
.chart .grid{stroke:var(--grid);stroke-width:1}.chart .tick{fill:var(--mute);font:500 12px var(--hd);letter-spacing:.04em;font-variant-numeric:tabular-nums}
.chart .line{fill:none;stroke:var(--s1);stroke-width:2;stroke-linejoin:round;vector-effect:non-scaling-stroke}.chart .area{fill:var(--s1);opacity:.14}
.chart .hair{stroke:var(--mute);stroke-width:1;stroke-dasharray:3 3;vector-effect:non-scaling-stroke}.chart .dot{fill:var(--s1);stroke:var(--surface);stroke-width:2}
.chart .s1{fill:var(--s1)}.chart .s2{fill:var(--s2)}.chart .hit{fill:transparent}.chart .bar:hover rect:not(.hit),.chart .bar:focus rect:not(.hit){opacity:.8}
.tip{position:absolute;top:4px;transform:translateX(-50%);background:var(--bg);border:1px solid var(--line);padding:6px 10px;pointer-events:none;box-shadow:0 6px 20px rgba(0,0,0,.3);font-size:14px;display:flex;flex-direction:column;white-space:nowrap}
.tip strong{color:var(--ink);font:600 16px/1.2 var(--hd);letter-spacing:.04em}.tip span{color:var(--mute)}
.legend{display:flex;gap:16px;font:500 13px/1 var(--hd);letter-spacing:.08em;text-transform:uppercase;color:var(--ink2);margin-bottom:8px}.legend span{display:inline-flex;align-items:center;gap:6px}.sw{width:12px;height:12px;display:inline-block}.sw.s1{background:var(--s1)}.sw.s2{background:var(--s2)}
.tableview{margin-top:8px}.tableview summary{cursor:pointer;color:var(--accent);font:500 13px/1 var(--hd);letter-spacing:.1em;text-transform:uppercase}.tableview .scroll{max-height:260px;overflow:auto}
.threads{display:flex;flex-direction:column;gap:10px}.thr{display:grid;grid-template-columns:90px 1fr 90px;gap:10px;align-items:center;font:500 14px/1 var(--hd);letter-spacing:.06em}.thr .num{text-align:end;font-variant-numeric:tabular-nums}
.track{height:8px;background:var(--raised);border:1px solid var(--line)}.fill{height:100%;background:var(--accent)}
.tabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}.tabs button.on{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.presets{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:10px;margin-bottom:6px}
.preset{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;justify-items:start;text-align:start;padding:14px;text-transform:none;letter-spacing:0;font:16px/1.3 var(--tx);color:var(--ink)}.preset .prb{grid-row:span 3;width:26px;height:26px}.preset strong{font:600 16px/1 var(--hd);letter-spacing:.1em;text-transform:uppercase}.preset code{font-size:13px}
ol.nodes{list-style:none;padding:0;margin:0}ol.nodes li{display:grid;grid-template-columns:100px 1fr auto auto;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--line)}
.nrank{font:600 12px/1 var(--hd);color:var(--mute);text-transform:uppercase;letter-spacing:.12em}.nact{display:flex;gap:4px}
@media (max-width:640px){ol.nodes li{grid-template-columns:1fr auto}.nrank{grid-column:1/-1}.nstat{grid-column:1/-1}}
ol.steps{counter-reset:s;list-style:none;padding:0;margin:0}ol.steps li{counter-increment:s;position:relative;padding:2px 0 12px 40px}ol.steps li::before{content:counter(s);position:absolute;inset-inline-start:0;top:0;width:28px;height:28px;border:1px solid var(--accent);color:var(--accent);display:flex;align-items:center;justify-content:center;font:600 15px/1 var(--hd)}
[dir=rtl] ol.steps li{padding:2px 40px 12px 0}
pre.log{background:var(--raised);border:1px solid var(--line);padding:12px;height:60vh;overflow:auto;font:12.5px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-word;margin:10px 0 0;direction:ltr;text-align:left;color:var(--ink2)}
.login{max-width:440px;margin:8vh auto}.login .logo{display:block;width:72px;height:72px;margin:0 auto 18px}
#toasts{position:fixed;bottom:16px;inset-inline-end:16px;display:flex;flex-direction:column;gap:8px;z-index:50;max-width:min(420px,calc(100vw - 32px))}
.toast{background:var(--bg);border:1px solid var(--line);border-inline-start:3px solid var(--info);padding:10px 14px;box-shadow:0 8px 24px rgba(0,0,0,.35)}
.toast.good{border-inline-start-color:var(--good)}.toast.bad{border-inline-start-color:var(--bad)}
footer{border-top:1px solid var(--line);color:var(--mute);font:500 13px/1.4 var(--hd);letter-spacing:.08em;text-transform:uppercase;max-width:1180px;margin:10px auto 0;padding:12px 16px 26px}
.bye{text-align:center;margin-top:20vh;font:600 24px/1.2 var(--hd);letter-spacing:.08em}
@media (max-width:640px){.brand .sub{display:none}.tv{font-size:24px}header#top{gap:6px}}
@media (prefers-reduced-motion:no-preference){.fill{transition:width .4s}}
`;

/** The page. `lang` (null: from the browser) and `theme` come from the saved settings. */
export function page({ lang = null, theme = 'dark' } = {}) {
  const l = LANGS.find((x) => x.code === lang);
  const dir = l?.dir ?? 'ltr';
  const themeAttr = theme === 'dark' || theme === 'light' ? ` data-theme="${theme}"` : '';
  return `<!doctype html><html lang="${l?.code ?? 'en'}" dir="${dir}"${themeAttr}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light"><title>PSYROB Miner</title><link rel="icon" href="/assets/logo.svg"><style>${CSS}</style></head><body>
<header id="top"></header><main id="main" tabindex="-1"></main><footer id="foot"></footer><div id="toasts" aria-live="polite"></div>
<script>
const LANG_CODES = ${data(LANG_CODES)};
const pickLang = ${pickLang.toString()};
(${client.toString()})({ langs: ${data(LANGS)}, strings: ${data(STRINGS)}, pick: pickLang }, ${data({ lang, theme })});
</script></body></html>`;
}
