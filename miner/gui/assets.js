// The PSYROB brand files the miner's dashboard uses: the explorer's fonts (Barlow Condensed, Source Serif 4), its
// icon sprite and the logo. Read from the repository, or from the program itself in a release (common/resources.js).
// They are public files: served without the page token, on this computer only.

import { readResource } from '../../common/resources.js';

export const ASSETS = {
  '/assets/sprite.svg': ['node/web/sprite.svg', 'image/svg+xml'],
  '/assets/logo.svg': ['node/web/logo.svg', 'image/svg+xml'],
  ...Object.fromEntries(['barlow-condensed-latin-500-normal', 'barlow-condensed-latin-600-normal', 'barlow-condensed-latin-ext-500-normal', 'barlow-condensed-latin-ext-600-normal',
    'source-serif-4-latin-opsz-normal', 'source-serif-4-latin-ext-opsz-normal'].map((f) => [`/assets/fonts/${f}.woff2`, [`node/web/vendor/fonts/${f}.woff2`, 'font/woff2']])),
};

/** [body, type] for an asset path, or null. */
export function asset(path) {
  const a = ASSETS[path];
  if (!a) return null;
  try { return [readResource(a[0]), a[1]]; } catch { return null; }
}
