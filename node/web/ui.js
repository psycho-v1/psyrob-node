// Small helpers for every explorer page (no wallet, nothing sent).
// Copy buttons next to addresses and hashes (<button class="copy" data-copy="0x…" data-done="Copied">).
// The full value is copied, never the shortened text shown in tables, so a look-alike address cannot be pasted by
// accident from a list.
document.addEventListener('click', async (e) => {
  const b = e.target.closest('button.copy[data-copy]');
  if (!b) return;
  const text = b.textContent;
  try {
    await navigator.clipboard.writeText(b.dataset.copy);
    b.textContent = b.dataset.done || '✓';
  } catch {
    // no clipboard access (http, old browser): select the value so Ctrl+C works
    const r = document.createRange();
    const v = b.previousElementSibling;
    if (v) { r.selectNodeContents(v); getSelection().removeAllRanges(); getSelection().addRange(r); }
  }
  setTimeout(() => { b.textContent = text; }, 1500);
});

// Times: the server writes "2026-11-02 10:38 UTC". Show them in the visitor's own time zone and language, with the
// UTC value on hover; deadlines that are still ahead also get a countdown.
(() => {
  const RE = /\b(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}) UTC\b/g, HAS = /\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/;
  const lang = document.documentElement.lang || 'en';
  const fmt = (d) => { try { return d.toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return d.toLocaleString(); } };
  const left = (ms) => { // "in 3 days", "in 5 hours" in the page's language
    const m = Math.round(ms / 60000), rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'always' });
    return m >= 2880 ? rtf.format(Math.round(m / 1440), 'day') : m >= 120 ? rtf.format(Math.round(m / 60), 'hour') : rtf.format(m, 'minute');
  };
  const walker = document.createTreeWalker(document.querySelector('main') || document.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (HAS.test(n.nodeValue) && !n.parentElement.closest('code,pre,time,script,style,textarea') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const n of nodes) {
    RE.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let at = 0, m;
    while ((m = RE.exec(n.nodeValue))) {
      frag.append(n.nodeValue.slice(at, m.index));
      const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
      const t = document.createElement('time');
      t.dateTime = d.toISOString();
      t.title = m[0];
      t.textContent = fmt(d) + (d - Date.now() > 60000 ? ` · ${left(d - Date.now())}` : '');
      frag.append(t);
      at = m.index + m[0].length;
    }
    frag.append(n.nodeValue.slice(at));
    n.replaceWith(frag);
  }
})();

// "/" jumps to the search field in the header (not while typing somewhere else)
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? '') || document.activeElement?.isContentEditable) return;
  const q = document.getElementById('nav-q');
  if (!q) return;
  e.preventDefault();
  const menu = document.getElementById('siteNav');
  if (menu && !menu.classList.contains('show') && getComputedStyle(menu).display === 'none') document.querySelector('.navbar-toggler')?.click();
  q.focus();
});
