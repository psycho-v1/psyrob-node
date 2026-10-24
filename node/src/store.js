// On-disk data: an append-only block log (blocks are written in the order they were accepted, so parents always come
// first), final checkpoint certificates and the address manager's tables. At start-up the node replays the block log
// (without re-checking proof of work, which it checked before writing) to rebuild the DAG and the state.
//
// blocks.dat = repeated [u32 big-endian length][raw block]. A torn record at the end (power loss) is cut off.

import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';

export class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.lockFile = path.join(dir, 'LOCK');
    try {
      const fd = fs.openSync(this.lockFile, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(this.lockFile, 'utf8'));
      if (pid && pid !== process.pid && alive(pid)) throw new Error(`data directory ${dir} is in use by process ${pid}`);
      fs.writeFileSync(this.lockFile, String(process.pid));
    }
    this.blocksFile = path.join(dir, 'blocks.dat');
    this.fd = fs.openSync(this.blocksFile, 'a+');
    this.unsynced = 0;
    // cold.dat: the bulky per-block data of blocks far below the finality depth (raw bytes, transactions, receipts,
    // payments), moved out of memory by Chain and read back on demand. Rebuilt from scratch on every start, because
    // the replay re-executes every block; never synced to disk .
    this.coldFile = path.join(dir, 'cold.dat');
    this.coldFd = fs.openSync(this.coldFile, 'w+');
    this.coldSize = 0;
  }

  /** Append one cold record (any v8-serialisable value); returns its offset. */
  putCold(value) {
    const body = v8.serialize(value);
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    const at = this.coldSize;
    fs.writeSync(this.coldFd, Buffer.concat([head, body]), 0, 4 + body.length, at);
    this.coldSize += 4 + body.length;
    return at;
  }

  /** The cold record at `at`. */
  getCold(at) {
    const head = Buffer.alloc(4);
    fs.readSync(this.coldFd, head, 0, 4, at);
    const body = Buffer.alloc(head.readUInt32BE(0));
    fs.readSync(this.coldFd, body, 0, body.length, at + 4);
    return v8.deserialize(body);
  }

  /** Every stored raw block, in order. Cuts a torn tail. */
  readBlocks() {
    const buf = fs.readFileSync(this.blocksFile);
    const out = [];
    let pos = 0;
    while (pos + 4 <= buf.length) {
      const len = buf.readUInt32BE(pos);
      if (pos + 4 + len > buf.length) break;
      out.push(new Uint8Array(buf.subarray(pos + 4, pos + 4 + len)));
      pos += 4 + len;
    }
    if (pos !== buf.length) fs.truncateSync(this.blocksFile, pos);
    return out;
  }

  appendBlock(raw) {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(raw.length, 0);
    fs.writeSync(this.fd, Buffer.concat([head, Buffer.from(raw)]));
    if (++this.unsynced >= 8) this.sync();
  }

  sync() {
    if (this.unsynced) { fs.fsyncSync(this.fd); this.unsynced = 0; }
  }

  readJson(name, fallback) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8')); } catch { return fallback; }
  }

  writeJson(name, value) {
    const f = path.join(this.dir, name);
    fs.writeFileSync(f + '.new', JSON.stringify(value));
    fs.renameSync(f + '.new', f);
  }

  /**
   * Move the data of another network (another genesis) aside into old-network-<time>/ and start an empty block log.
   * Peer addresses are kept: the same hosts serve the new network. Returns the folder name.
   */
  archive() {
    this.sync();
    fs.closeSync(this.fd);
    const sub = 'old-network-' + new Date().toISOString().replace(/[:.]/g, '-');
    fs.mkdirSync(path.join(this.dir, sub));
    for (const f of ['blocks.dat', 'certs.json', 'anchors.json', 'signed-checkpoints.json', 'signed-fund.json']) {
      try { fs.renameSync(path.join(this.dir, f), path.join(this.dir, sub, f)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    }
    this.fd = fs.openSync(this.blocksFile, 'a+');
    return sub;
  }

  close() {
    try { this.sync(); fs.closeSync(this.fd); } catch { /* closed */ }
    try { fs.closeSync(this.coldFd); fs.unlinkSync(this.coldFile); } catch { /* closed */ }
    try { if (Number(fs.readFileSync(this.lockFile, 'utf8')) === process.pid) fs.unlinkSync(this.lockFile); } catch { /* gone */ }
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
