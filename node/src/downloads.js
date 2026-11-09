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
    // a download that broke off can be resumed: one byte range (Range: bytes=start- or start-end), answered 206 with
    // Content-Range; the ETag (size and time of the file) lets the client check it is still the same file
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const head = { ...headers, 'Content-Type': TYPES[path.extname(name)] ?? 'application/octet-stream', 'Cache-Control': 'public, max-age=600',
      'Accept-Ranges': 'bytes', ETag: etag, ...(small ? {} : { 'Content-Disposition': `attachment; filename="${name}"` }) };
    let start = 0, end = st.size - 1, partial = false;
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers?.range ?? '').trim());
    const ifRange = req.headers?.['if-range'];
    if (range && (range[1] || range[2]) && (!ifRange || ifRange === etag)) {
      if (range[1]) { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), st.size - 1); } else start = Math.max(0, st.size - Number(range[2]));
      if (!(start <= end && start < st.size)) { res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}` }).end(); return true; }
      partial = true;
    }
    const length = end - start + 1;
    const status = partial ? 206 : 200;
    const out = { ...head, 'Content-Length': length, ...(partial ? { 'Content-Range': `bytes ${start}-${end}/${st.size}` } : {}) };
    if (req.method === 'HEAD') { res.writeHead(status, out).end(); return true; }
    if (!small) {
      if (this.active >= this.concurrent) { res.writeHead(503, { ...headers, 'Retry-After': '60' }).end('busy: try again in a minute'); return true; }
      // resuming a download that broke off (a range that does not start at 0) does not count against the hourly limit
      if (start === 0 && !this.allowed(client)) { res.writeHead(429, { ...headers, 'Retry-After': '3600' }).end('download limit reached: try again within the hour'); return true; }
    }
    this.active++;
    try {
      res.writeHead(status, out);
      await pipeline(fs.createReadStream(file, { start, end }), res);
    } catch { res.destroy(); } finally { this.active--; }
    return true;
  }
}
