// The downloadable programs (built by scripts/build-release.mjs into dist/downloads/): served by the explorer at
// /downloads/<file>, streamed from disk, only the files listed in manifest.json, with a per-client hourly limit and a
// cap on simultaneous downloads (the public node shares its line with the P2P network).

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const TYPES = { '.exe': 'application/vnd.microsoft.portable-executable', '.deb': 'application/vnd.debian.binary-package', '.zip': 'application/zip', '.gz': 'application/gzip', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };

export class Downloads {
  /** dir: the folder with manifest.json, SHA256SUMS.txt and the packages; null when this node serves none. */
  constructor(dir, { perHour = 12, concurrent = 6 } = {}) {
    this.dir = dir ? path.resolve(dir) : null;
    this.perHour = perHour;
    this.concurrent = concurrent;
    this.active = 0;
    this.byClient = new Map();
    this.cached = null;
  }

  /** The manifest ({ version, node, genesis, built, files: [{ name, os, program, type, bytes, sha256 }] }), or null. */
  manifest() {
    if (!this.dir) return null;
    try {
      const f = path.join(this.dir, 'manifest.json');
      const m = fs.statSync(f).mtimeMs;
      if (this.cached?.m !== m) this.cached = { m, value: JSON.parse(fs.readFileSync(f, 'utf8')) };
      return this.cached.value;
    } catch { return null; }
  }

  allowed(client) {
    const now = Date.now();
    let e = this.byClient.get(client);
    if (!e || now - e.since > 3_600_000) {
      if (this.byClient.size > 10_000) this.byClient.clear();
      e = { since: now, n: 0 };
      this.byClient.set(client, e);
    }
    return ++e.n <= this.perHour;
  }

  /** Serve /downloads/<name>; returns false for other paths. */
  async serve(req, res, p, client, headers) {
    if (!p.startsWith('/downloads/')) return false;
    const name = p.slice('/downloads/'.length);
    const m = this.manifest();
    // SHA256SUMS.txt.sig (Ed25519 signature of the release key) and release-key.pem are served next to the list
    const small = name === 'SHA256SUMS.txt' || name === 'manifest.json' || name === 'SHA256SUMS.txt.sig' || name === 'release-key.pem';
    if (!m || !(small || m.files.some((f) => f.name === name))) { res.writeHead(404, headers).end('not found'); return true; }
    const file = path.join(this.dir, name);
    let st;
    try { st = fs.statSync(file); } catch { res.writeHead(404, headers).end('not found'); return true; }
    const head = { ...headers, 'Content-Type': TYPES[path.extname(name)] ?? 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=600',
      ...(small ? {} : { 'Content-Disposition': `attachment; filename="${name}"` }) };
    if (req.method === 'HEAD') { res.writeHead(200, head).end(); return true; }
    if (!small) {
      if (this.active >= this.concurrent) { res.writeHead(503, { ...headers, 'Retry-After': '60' }).end('busy: try again in a minute'); return true; }
      if (!this.allowed(client)) { res.writeHead(429, { ...headers, 'Retry-After': '3600' }).end('download limit reached: try again within the hour'); return true; }
    }
    this.active++;
    try {
      res.writeHead(200, head);
      await pipeline(fs.createReadStream(file), res);
    } catch { res.destroy(); } finally { this.active--; }
    return true;
  }
}
