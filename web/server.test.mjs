// server 的集成测试：起一个真进程，验证访问口令（WF_TOKEN）与分享信息。
// 只测只读接口，不碰 /api/gate/open——那会在本机真的拉起编辑器。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');
const TOKEN = 's3cret';

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function waitUp(base) {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${base}/api/meta`);
      if (res.status === 401) return true; // 有口令时这就是"起来了"的信号
    } catch {
      // 还没监听
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server 没起来');
}

/** 起一个只绑 loopback、带口令的 server，跑完就杀。 */
async function withServer(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-server-'));
  await fs.mkdir(path.join(dir, '.beads'), { recursive: true }); // 免得走 bd init
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER], {
    cwd: dir,
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), WF_TOKEN: TOKEN, HLWD_PROJECT: dir, WF_NO_OPEN: '1' },
    stdio: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitUp(base);
    await fn({ base, dir });
  } finally {
    proc.kill();
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

test('设了 WF_TOKEN：没口令 401，带口令 200 并记 cookie', async () => {
  await withServer(async ({ base }) => {
    const denied = await fetch(`${base}/api/meta`);
    assert.equal(denied.status, 401);
    assert.match(await denied.text(), /需要访问口令/);

    const wrong = await fetch(`${base}/api/meta?token=nope`);
    assert.equal(wrong.status, 401);

    const ok = await fetch(`${base}/api/meta?token=${TOKEN}`);
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get('set-cookie') ?? '';
    assert.match(cookie, /wf_token=/);

    const meta = await ok.json();
    assert.equal(meta.share.token, true, '分享信息里只说明有口令，不回显口令');
    assert.equal(meta.share.host, '127.0.0.1');
    assert.ok(Array.isArray(meta.share.lan));

    // 带上 cookie 就不用再挂 ?token
    const viaCookie = await fetch(`${base}/api/meta`, { headers: { cookie: cookie.split(';')[0] } });
    assert.equal(viaCookie.status, 200);
  });
});

test('静态页也要口令（否则页面能开、接口 401 会莫名其妙）', async () => {
  await withServer(async ({ base }) => {
    assert.equal((await fetch(`${base}/index.html`)).status, 401);
    assert.equal((await fetch(`${base}/index.html?token=${TOKEN}`)).status, 200);
  });
});
