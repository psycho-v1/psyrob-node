// Texts of the explorer's browser scripts in the page's language. The page carries them as JSON
// (<script type="application/json" id="psy-i18n">, only the texts these scripts use); the English text is the key.
const D = (() => { try { return JSON.parse(document.getElementById('psy-i18n')?.textContent || '{}'); } catch { return {}; } })();

export function T(en, vars) {
  const s = D[en] ?? en;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
}

/** Number formatting in the page's language (English keeps 1,234.5). */
export const LOCALE = document.documentElement.lang && document.documentElement.lang !== 'en' ? document.documentElement.lang : 'en-US';
