// Languages of the explorer pages. The English text is the key: T('Chain blocks') returns the visitor's language
// when a translation exists, else the English text. Placeholders are {name}: T('Block {n}', { n }) (values are
// inserted as given, so escape them first where they come from the chain or a visitor). Translations may contain the
// same HTML tags as their English text and nothing else (node/test/i18n.test.js checks this), so they are inserted
// as HTML like the English text.
//
// The language of the current request is kept in an AsyncLocalStorage: a page renders in its visitor's language
// while other requests run in between. Outside a request (tests, logs) it is English.

import { AsyncLocalStorage } from 'node:async_hooks';
import { LANGS, LANG_CODES, pickLang } from '../../common/langs.js';
import de from './i18n/de.js';
import nl from './i18n/nl.js';
import es from './i18n/es.js';
import pt from './i18n/pt.js';
import ru from './i18n/ru.js';
import ar from './i18n/ar.js';
import hi from './i18n/hi.js';
import zhCN from './i18n/zh-CN.js';
import zhTW from './i18n/zh-TW.js';
import ko from './i18n/ko.js';

export { LANGS, LANG_CODES };
export const DICTS = { de, nl, es, pt, ru, ar, hi, 'zh-CN': zhCN, 'zh-TW': zhTW, ko };
const als = new AsyncLocalStorage();

/** The language of the current request ('en' outside a request). */
export const lang = () => als.getStore()?.lang ?? 'en';
export const dir = () => LANGS.find((l) => l.code === lang())?.dir ?? 'ltr';
/** Run fn with `code` as the language of everything it renders; `req` ({ path, query }) is the page being built. */
export const withLang = (code, fn, req = {}) => als.run({ lang: LANG_CODES.includes(code) ? code : 'en', ...req }, fn);
/** The path and query string of the page being built (for links to the same page in another language). */
export const here = () => ({ path: als.getStore()?.path ?? '/', query: als.getStore()?.query ?? '' });

// the English texts asked for while PSYROB_I18N_COLLECT is set (scripts/i18n-keys.mjs: which texts the pages use)
export const COLLECTED = process.env.PSYROB_I18N_COLLECT ? new Set() : null;
export const FILLED = process.env.PSYROB_I18N_COLLECT ? new Set() : null; // texts with values filled in (not keys)

/** The text in the current language, with {placeholders} filled in. */
export function T(en, vars) {
  COLLECTED?.add(en);
  const s = DICTS[lang()]?.[en] ?? en;
  if (!vars) return s;
  const out = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  FILLED?.add(out);
  return out;
}

/** Number formatting in the current language (English keeps 1,234.5). */
export const locale = () => (lang() === 'en' ? 'en-US' : lang());

/**
 * The visitor's language: ?lang= (a link or the language menu), then the lang cookie, then Accept-Language.
 * Returns { code, set } where set is true when ?lang= chose it (the cookie is then written).
 */
export function requestLang(searchParams, headers) {
  const q = searchParams?.get('lang');
  if (q && LANG_CODES.includes(q)) return { code: q, set: true };
  const c = /(?:^|;\s*)lang=([A-Za-z-]+)/.exec(String(headers?.cookie ?? ''))?.[1];
  if (c && LANG_CODES.includes(c)) return { code: c, set: false };
  const accept = String(headers?.['accept-language'] ?? '').split(',').map((x) => x.split(';')[0].trim()).filter(Boolean);
  return { code: pickLang(accept), set: false };
}

/** The texts a browser script needs (its T('...') keys), for the current language: inlined as JSON in the page. */
export function clientDict(keys) {
  const d = DICTS[lang()];
  if (!d) return {};
  return Object.fromEntries(keys.filter((k) => k in d).map((k) => [k, d[k]]));
}
