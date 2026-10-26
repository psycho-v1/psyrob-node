// Mining history for the control page: a live series (5 s steps, the last 15 minutes, memory only), a minute series
// (the last 7 days, saved in stats.json in the data folder), lifetime totals and the last 200 block submissions.
// The miner's counters start again at each start; the history takes the differences between samples.

import fs from 'node:fs';

const LIVE = 180, MINUTES = 7 * 24 * 60, BLOCKS = 200;
const RANGES = { '1h': 60, '24h': 24 * 60, '7d': MINUTES };

export class History {
  constructor(file) {
    this.file = file;
    this.live = [];
    this.minutes = [];
    this.blocks = [];
    this.totals = { attempts: 0, found: 0, accepted: 0, rejected: 0, miningSeconds: 0 };
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(j.minutes)) this.minutes = j.minutes.slice(-MINUTES);
      if (Array.isArray(j.blocks)) this.blocks = j.blocks.slice(-BLOCKS);
      if (j.totals) for (const k of Object.keys(this.totals)) this.totals[k] = Number(j.totals[k]) || 0;
    } catch { /* first start */ }
    this.miner = null;
    this.base = null; // the miner's counters at the last sample
    this.minute = null; // the minute being filled: { t, attempts, found, accepted, rejected, secs }
  }

  /** Called every 5 s with the running miner (or null). */
  sample(miner, now = Date.now()) {
    if (miner !== this.miner) { this.miner = miner; this.base = miner ? { attempts: 0, found: 0, accepted: 0, rejected: 0, at: now, blocks: 0 } : null; }
    const d = { attempts: 0, found: 0, accepted: 0, rejected: 0, secs: 0 };
    if (miner && this.base) {
      for (const k of ['attempts', 'found', 'accepted', 'rejected']) { d[k] = Math.max(0, (miner[k] ?? 0) - this.base[k]); this.base[k] = miner[k] ?? 0; }
      d.secs = (now - this.base.at) / 1000;
      this.base.at = now;
      for (const k of Object.keys(d)) this.totals[k === 'secs' ? 'miningSeconds' : k] += d[k];
      // block submissions: copied once they are settled (not pending any more)
      while (this.base.blocks < miner.blocks.length && miner.blocks[this.base.blocks].status !== 'pending') {
        const b = miner.blocks[this.base.blocks++];
        this.blocks.push({ at: b.at, hash: b.hash, status: b.status, reason: b.reason, blueScore: b.blueScore, node: b.node });
        if (this.blocks.length > BLOCKS) this.blocks.shift();
      }
    }
    this.live.push({ t: now, rate: d.secs > 0 ? d.attempts / d.secs : 0 });
    if (this.live.length > LIVE) this.live.shift();
    const t = Math.floor(now / 60_000) * 60_000;
    if (this.minute && this.minute.t !== t) this.closeMinute();
    this.minute ??= { t, attempts: 0, found: 0, accepted: 0, rejected: 0, secs: 0 };
    for (const k of Object.keys(d)) this.minute[k] += d[k];
  }

  closeMinute() {
    const m = this.minute;
    this.minute = null;
    if (!m) return;
    this.minutes.push({ t: m.t, rate: m.secs > 0 ? Math.round((m.attempts / m.secs) * 100) / 100 : 0, found: m.found, accepted: m.accepted, rejected: m.rejected });
    if (this.minutes.length > MINUTES) this.minutes.shift();
  }

  /** A range ('1h', '24h', '7d') in about `points` buckets, each from its start t: { t, rate (mean), found, accepted, rejected }. */
  range(name, points = 120, now = Date.now()) {
    const span = RANGES[name] ?? 60;
    const step = Math.max(1, Math.ceil(span / points)) * 60_000;
    const from = Math.floor((now - span * 60_000) / step) * step;
    const out = [];
    for (let t = from; t <= now; t += step) out.push({ t, rate: 0, n: 0, found: 0, accepted: 0, rejected: 0 });
    for (const m of this.minutes) {
      const i = Math.floor((m.t - from) / step);
      const b = out[i];
      if (!b) continue;
      b.rate += m.rate; b.n++; b.found += m.found; b.accepted += m.accepted; b.rejected += m.rejected;
    }
    return { range: name, stepSeconds: step / 1000, points: out.map(({ n, ...b }) => ({ ...b, rate: n ? Math.round((b.rate / n) * 100) / 100 : 0 })) };
  }

  save() {
    try { fs.writeFileSync(this.file, JSON.stringify({ version: 1, totals: this.totals, blocks: this.blocks, minutes: this.minutes }), { mode: 0o600 }); } catch { /* read-only data folder */ }
  }
}
