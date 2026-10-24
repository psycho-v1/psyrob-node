// Data files (genesis, contract artifacts, Argon2d WebAssembly, test vectors, web assets) for both ways of running:
// from the source tree, and as a single executable (Node "single executable application"), where the build embeds
// them as assets named by their path relative to the repository root (scripts/build-release.mjs).

import fs from 'node:fs';

const sea = (() => {
  try {
    const s = process.getBuiltinModule?.('node:sea');
    return s && s.isSea() ? s : null;
  } catch { return null; }
})();

/** True inside a single-executable build. */
export const IN_SEA = sea !== null;

/** Bytes of a data file, by its path relative to the repository root (for example 'genesis/artifacts.json'). */
export function readResource(rel) {
  if (sea) return Buffer.from(sea.getRawAsset(rel));
  return fs.readFileSync(new URL('../' + rel, import.meta.url));
}

export const readResourceText = (rel) => readResource(rel).toString('utf8');

export function resourceExists(rel) {
  try { readResource(rel); return true; } catch { return false; }
}
