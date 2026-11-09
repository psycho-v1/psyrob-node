// Downloads can be resumed: a download that broke off asks for the rest with a byte range and gets 206 with exactly the
// missing bytes; resuming does not count against the hourly limit; a file that changed in between is sent whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { Downloads } from '../src/downloads.js';

test('downloads: byte ranges resume a broken download', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psy-dl-'));
  const body = crypto.randomBytes(300_000);
  fs.writeFileSync(path.join(dir, 'big.deb'), body);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ files: [{ name: 'big.deb' }] }));
  const d = new Downloads(dir, { perHour: 2 });
  const server = http.createServer((req, res) => d.serve(req, res, req.url, 'one-client', {})).listen(0);
  const port = server.address().port;
  const get = (headers = {}, method = 'GET') => new Promise((resolve, reject) => {
    http.request({ port, path: '/downloads/big.deb', method, headers }, (res) => {
      const parts = []; res.on('data', (c) => parts.push(c)); res.on('end', () => resolve({ status: res.statusCode, h: res.headers, body: Buffer.concat(parts) }));
    }).on('error', reject).end();
  });
  try {
    const full = await get();
    assert.equal(full.status, 200);
    assert.equal(full.h['accept-ranges'], 'bytes');
    assert.ok(full.body.equals(body));
    // the download broke off after 120,000 bytes: ask for the rest
    const rest = await get({ Range: 'bytes=120000-', 'If-Range': full.h.etag });
    assert.equal(rest.status, 206);
    assert.equal(rest.h['content-range'], `bytes 120000-299999/300000`);
    assert.ok(Buffer.concat([full.body.subarray(0, 120000), rest.body]).equals(body), 'the pieces make the whole file');
    assert.equal((await get({ Range: 'bytes=-1000' })).body.length, 1000, 'the last 1,000 bytes');
    assert.equal((await get({ Range: 'bytes=10-19' })).body.length, 10);
    assert.equal((await get({ Range: 'bytes=400000-' })).status, 416);
    // the file changed: the old ETag no longer matches, so the whole new file is sent
    const changed = await get({ Range: 'bytes=120000-', 'If-Range': '"stale"' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.length, 300000);
    // the hourly limit (2 here) counts downloads from the start; resuming never runs into it
    assert.equal((await get()).status, 429, 'three downloads from the start: the third is refused');
    assert.equal((await get({ Range: 'bytes=5-' })).status, 206, 'a resume still works');
    assert.equal((await get({}, 'HEAD')).h['content-length'], '300000');
  } finally { server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
