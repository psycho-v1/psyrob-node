// The languages of the miner dashboard and the explorer: code (BCP 47), name in the language itself, a short label
// for the language button, and the writing direction. English is the fallback for any text a language lacks.

export const LANGS = Object.freeze([
  { code: 'en', name: 'English', short: 'EN', dir: 'ltr' },
  { code: 'de', name: 'Deutsch', short: 'DE', dir: 'ltr' },
  { code: 'nl', name: 'Nederlands', short: 'NL', dir: 'ltr' },
  { code: 'es', name: 'Español', short: 'ES', dir: 'ltr' },
  { code: 'pt', name: 'Português', short: 'PT', dir: 'ltr' },
  { code: 'ru', name: 'Русский', short: 'RU', dir: 'ltr' },
  { code: 'ar', name: 'العربية', short: 'AR', dir: 'rtl' },
  { code: 'hi', name: 'हिन्दी', short: 'HI', dir: 'ltr' },
  { code: 'zh-CN', name: '简体中文', short: '简', dir: 'ltr' },
  { code: 'zh-TW', name: '繁體中文', short: '繁', dir: 'ltr' },
  { code: 'ko', name: '한국어', short: 'KO', dir: 'ltr' },
]);
export const LANG_CODES = LANGS.map((l) => l.code);

/**
 * The best language for a list of preferences (navigator.languages or an Accept-Language header): an exact match,
 * then the same base language (zh-HK and zh-MO read Traditional Chinese, other zh Simplified), else English.
 */
export function pickLang(prefs) {
  for (const raw of [].concat(prefs ?? [])) {
    const p = String(raw).trim();
    if (!p) continue;
    const exact = LANG_CODES.find((c) => c.toLowerCase() === p.toLowerCase());
    if (exact) return exact;
    const [base, region] = p.toLowerCase().split(/[-_]/);
    if (base === 'zh') return ['tw', 'hk', 'mo', 'hant'].includes(region) || /hant/i.test(p) ? 'zh-TW' : 'zh-CN';
    const b = LANG_CODES.find((c) => c === base);
    if (b) return b;
  }
  return 'en';
}
