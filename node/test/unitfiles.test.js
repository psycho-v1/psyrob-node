// The production units' start lines, parsed and run by real systemd (a user instance): systemd processes quotes and
// backslash escapes itself, so a line that looks right in bash can still be wrong. Skipped where no user systemd is available.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

const REPO = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const userSystemd = spawnSync('systemctl', ['--user', 'is-system-running'], { encoding: 'utf8' });
const available = userSystemd.status !== null && /running|degraded/.test(userSystemd.stdout ?? '');

test('psyrob-miner.service start lines work under real systemd parsing', { skip: !available && 'no user systemd', timeout: 120_000 }, async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, chainId: 87870, genesis: '0x' + '11'.repeat(32) })); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-unit-'));
  const genesis = path.join(dir, 'genesis.json');
  fs.writeFileSync(genesis, JSON.stringify({ config: { timestamp: Math.floor(Date.now() / 1000) - 3600 } }));
  const name = `psyrob-unit-test-${process.pid}.service`;
  const unitDir = path.join(os.homedir(), '.config/systemd/user');
  fs.mkdirSync(unitDir, { recursive: true });
  const file = path.join(unitDir, name);
  const out = path.join(dir, 'out.txt');
  try {
    const src = fs.readFileSync(path.join(REPO, 'deploy/psyrob-miner.service'), 'utf8');
    // the health and genesis waits (the key copy needs a credential: the full-unit test below runs it)
    const pre = src.split('\n').filter((l) => l.startsWith('ExecStartPre=') && !l.includes('%d/'))
      .map((l) => l.replaceAll('http://127.0.0.1:8787', `http://127.0.0.1:${port}`).replaceAll('/home/psycho/psyrob-node/genesis/genesis-87870.json', genesis));
    assert.equal(pre.length, 2);
    // the real ExecStart, with the miner replaced by a printout of what it would receive
    const start = src.split('\n').find((l) => l.startsWith('ExecStart='));
    assert.match(start, /--expect-address "\$\$PSYROB_MINER_ADDRESS"/);
    fs.writeFileSync(file, ['[Unit]', 'Description=psyrob unit parse test', '[Service]', 'Type=oneshot', 'Environment=PSYROB_MINER_ADDRESS=0x' + 'ab'.repeat(20), ...pre,
      `ExecStart=/bin/sh -c 'echo "address=$$PSYROB_MINER_ADDRESS" > ${out}'`, ''].join('\n'));
    spawnSync('systemctl', ['--user', 'daemon-reload']);
    // asynchronous: the stub /health server above runs in this process
    const ok = await run('systemctl', ['--user', 'start', name], { timeout: 90_000 }).then(() => true, () => false);
    assert.ok(ok, 'the start lines failed under systemd: ' + spawnSync('journalctl', ['--user', '-u', name, '--no-pager', '-n', '20'], { encoding: 'utf8' }).stdout);
    assert.equal(fs.readFileSync(out, 'utf8').trim(), 'address=0x' + 'ab'.repeat(20));
  } finally {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    spawnSync('systemctl', ['--user', 'daemon-reload']);
    spawnSync('systemctl', ['--user', 'reset-failed', name]);
    for (const f of [genesis, out]) if (fs.existsSync(f)) fs.unlinkSync(f);
    fs.rmdirSync(dir);
    server.close();
  }
});

// The whole miner unit as systemd runs it, with the real miner (key permission check on), mining blocks on a throwaway
// devnet node. Only what a user systemd instance cannot apply is changed: no User=/Group= (no user switch), no
// the options that drop capabilities (CapabilityBoundingSet, PrivateDevices, ProtectKernelModules, ProtectKernelLogs,
// ProtectClock: a user instance may not, status 218/CAPABILITIES; the system node unit runs with the same lines), no dependency on the system node unit, Restart=no (a failure shows at once), and the test's
// own node, genesis, key and runtime directory name. In a user instance the mount sandbox (ProtectHome, BindReadOnlyPaths, ProtectSystem) is not
// applied and the credential arrives as 0400 (with User= the system manager makes it group-readable: the bug this
// covers), so the source key is 0640 like /etc/psyrob/miner.key and the test checks that the miner refuses it.
test('psyrob-miner.service: the full unit starts the real miner, which mines blocks, key check on', { skip: !available && 'no user systemd', timeout: 240_000 }, async () => {
  const { Node } = await import('../src/node.js');
  const { privateKeyToAddress } = await import('../../common/crypto.js');
  const { randomBytes } = await import('node:crypto');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psyrob-unitmine-'));
  const genesis = path.join(dir, 'genesis.json');
  fs.writeFileSync(genesis, JSON.stringify({
    config: { chainId: 1337, timestamp: Math.floor(Date.now() / 1000) - 600, target: '0x' + ((1n << 256n) / 2000n).toString(16), devBeneficiary: '0x' + '22'.repeat(20) },
    params: { pow: { memoryKiB: 8, iterations: 1 } },
  }));
  const sk = randomBytes(32);
  const address = '0x' + Buffer.from(privateKeyToAddress(sk)).toString('hex');
  const keyFile = path.join(dir, 'miner.key');
  fs.writeFileSync(keyFile, sk.toString('hex') + '\n', { mode: 0o640 }); // as the launch writes it (root:psyrob 0640)
  fs.chmodSync(keyFile, 0o640);
  const name = `psyrob-unitmine-${process.pid}`;
  const unitDir = path.join(os.homedir(), '.config/systemd/user');
  fs.mkdirSync(unitDir, { recursive: true });
  const file = path.join(unitDir, name + '.service');
  const node = new Node({ genesisFile: genesis, datadir: path.join(dir, 'data'), p2pHost: '127.0.0.1', p2pPort: 0, seeds: [], httpHost: '127.0.0.1', httpPort: 0, log: () => {} });
  try {
    // the miner's check still refuses the group-readable source key itself
    const direct = await run(process.execPath, [path.join(REPO, 'miner/bin/psyrob-miner.js'), '--node', 'http://127.0.0.1:9', '--key', keyFile], { timeout: 30_000 }).then(() => null, (e) => e);
    assert.equal(direct?.code, 2);
    assert.match(direct.stderr, /must not be readable by others/);

    await node.start();
    const port = node.http.address().port;
    const src = fs.readFileSync(path.join(REPO, 'deploy/psyrob-miner.service'), 'utf8');
    const limits = fs.readFileSync(path.join(REPO, 'deploy/psyrob-miner.service.d/limits.conf'), 'utf8').split('\n').filter((l) => /^\w+=/.test(l));
    const service = src.slice(src.indexOf('[Service]'), src.indexOf('[Install]')).split('\n')
      // options that drop capabilities, refused in a user instance (probed one by one with systemd-run --user)
      .filter((l) => !/^(User|Group|CapabilityBoundingSet|AmbientCapabilities|PrivateDevices|ProtectKernelModules|ProtectKernelLogs|ProtectClock)=/.test(l))
      .map((l) => (l.startsWith('Restart=') ? 'Restart=no' : l)
        .replaceAll('/home/psycho/psyrob-node/genesis/genesis-87870.json', genesis)
        .replaceAll('/home/psycho/psyrob-node', REPO)
        .replaceAll('http://127.0.0.1:8787', `http://127.0.0.1:${port}`)
        .replaceAll('chainId.:87870', 'chainId.:1337')
        .replaceAll('--chain-id 87870', '--chain-id 1337')
        .replaceAll('/etc/psyrob/miner.key', keyFile)
        .replace(/psyrob-miner(?!\.js)/g, name));
    assert.ok(service.some((l) => l.startsWith('ExecStart=') && l.includes('$$RUNTIME_DIRECTORY/miner.key')), 'the miner reads the private copy');
    assert.ok(service.some((l) => /^ExecStartPre=\/usr\/bin\/install -m 0600 %d\/miner\.key %t\//.test(l)));
    fs.writeFileSync(file, ['[Unit]', 'Description=psyrob miner unit end-to-end test', ...service, `Environment=PSYROB_MINER_ADDRESS=${address}`, ...limits, ''].join('\n'));
    await run('systemctl', ['--user', 'daemon-reload']);
    await run('systemctl', ['--user', 'start', name + '.service'], { timeout: 120_000 });
    const journal = async () => (await run('journalctl', ['--user', '-u', name + '.service', '--no-pager', '-o', 'cat', '-n', '40']).catch((e) => e)).stdout ?? '';
    const end = Date.now() + 120_000;
    while (node.chain.tip.chainHeight < 2) {
      const active = (await run('systemctl', ['--user', 'is-active', name + '.service']).catch((e) => e)).stdout?.trim();
      if (active !== 'active' && active !== 'activating') assert.fail(`the miner unit is ${active}:\n${await journal()}`);
      if (Date.now() > end) assert.fail('no blocks within 120 s:\n' + await journal());
      await new Promise((r) => setTimeout(r, 500));
    }
    const copy = path.join(process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`, name, 'miner.key');
    assert.equal(fs.statSync(copy).mode & 0o777, 0o600, 'the private copy is 0600');
    assert.equal(fs.statSync(path.dirname(copy)).mode & 0o777, 0o700, 'in a 0700 runtime directory');
    const j = await journal();
    assert.match(j, new RegExp(`miner for ${address}`, 'i'));
    assert.match(j, /block 0x[0-9a-f]+… added/);
    assert.doesNotMatch(j, new RegExp(sk.toString('hex')), 'the key is never logged');
    await run('systemctl', ['--user', 'stop', name + '.service'], { timeout: 60_000 });
    assert.ok(!fs.existsSync(copy), 'the copy is removed when the service stops');
  } finally {
    await run('systemctl', ['--user', 'stop', name + '.service']).catch(() => {});
    if (fs.existsSync(file)) fs.unlinkSync(file);
    await run('systemctl', ['--user', 'daemon-reload']).catch(() => {});
    await run('systemctl', ['--user', 'reset-failed', name + '.service']).catch(() => {});
    await node.stop().catch(() => {});
    if (fs.existsSync(path.join(dir, 'data'))) fs.rmSync(path.join(dir, 'data'), { recursive: true });
    for (const f of [genesis, keyFile]) if (fs.existsSync(f)) fs.unlinkSync(f);
    fs.rmdirSync(dir);
  }
});
