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

test('附件：粘进评论的图只留在评论里，不进附件列表', async () => {
  await withServer(async ({ base }) => {
    const t = `?token=${TOKEN}`;
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]);

    const up = await fetch(`${base}/api/issues/hlwd-img2/attachments${t}`, {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent('粘贴的图片.png'), 'x-scope': 'inline' },
      body: bytes,
    });
    assert.equal(up.status, 201);
    const { attachment } = await up.json();
    assert.equal(attachment.scope, 'inline');

    const list = await (await fetch(`${base}/api/issues/hlwd-img2/attachments${t}`)).json();
    assert.deepEqual(list.attachments, [], 'inline 图不该出现在工单附件里');

    // 但评论 markdown 里的 ![x](url) 必须能打开
    const got = await fetch(`${base}${attachment.url}${t}`);
    assert.equal(got.status, 200);
    assert.equal((await got.arrayBuffer()).byteLength, bytes.length);
  });
});

test('会话接口：列出轮次 / 读一轮 / SSE 跟着长', async () => {
  await withServer(async ({ base, dir }) => {
    const t = `?token=${TOKEN}`;
    const cardId = 'hlwd-sess';
    const runId = `${cardId}-1700000000000`;
    const phaseDir = path.join(dir, '.hlwd', 'runs', runId, 'exec-1');
    await fs.mkdir(phaseDir, { recursive: true });

    const events = [
      { kind: 'raw', t: 1, payload: { type: 'session' } },
      { kind: 'thinking_partial', t: 2, text: '先看' },
      { kind: 'thinking_partial', t: 3, text: '一眼' },
      { kind: 'thinking', t: 4, text: '先看一眼' },
      { kind: 'tool', t: 5, callId: 'c1', phase: 'start', toolName: 'bash', args: { command: 'ls -la' } },
      { kind: 'tool', t: 6, callId: 'c1', phase: 'done', toolName: 'bash', result: { content: [{ type: 'text', text: 'total 0' }] }, payload: { durationMs: 42 } },
      { kind: 'assistant_partial', t: 7, text: '目录' },
      { kind: 'assistant', t: 8, text: '目录是空的。' },
    ];
    await fs.writeFile(path.join(phaseDir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
    await fs.writeFile(path.join(phaseDir, 'output.txt'), '做完了。');
    await fs.writeFile(
      path.join(dir, '.hlwd', 'runs', runId, 'run.json'),
      JSON.stringify({
        runId,
        outcome: 'closed',
        startedAt: '2026-01-01T00:00:00.000Z',
        attempts: [{ attempt: 1, execute: { startedAt: '2026-01-01T00:00:00.000Z', ms: 900, ok: true } }],
      }),
    );

    // 1) 轮次列表
    const turnsRes = await fetch(`${base}/api/issues/${cardId}/turns${t}`);
    assert.equal(turnsRes.status, 200);
    const { turns } = await turnsRes.json();
    assert.equal(turns.length, 1);
    assert.equal(turns[0].phaseKey, 'exec-1');
    assert.equal(turns[0].done, true);
    assert.equal(turns[0].live, false);

    // 2) 读一轮：归一化后的消息 + 最终回复
    const turnRes = await fetch(`${base}/api/issues/${cardId}/turns/${runId}/exec-1${t}`);
    assert.equal(turnRes.status, 200);
    const turn = await turnRes.json();
    assert.equal(turn.output, '做完了。');
    assert.deepEqual(
      turn.messages.map((m) => m.kind),
      ['thinking', 'tool', 'assistant'],
      'raw 丢掉、partial 合并、工具配成一条',
    );
    assert.equal(turn.messages[1].tool.done, true);
    assert.equal(turn.messages[1].tool.ms, 42);
    assert.equal(turn.messages[1].tool.result, 'total 0');

    // 3) 参数不对 / 路径越界
    assert.equal((await fetch(`${base}/api/issues/${cardId}/turns/${runId}/exec-9${t}`)).status, 404);
    assert.equal((await fetch(`${base}/api/issues/..%2F..%2Fetc/turns${t}`)).status, 200); // 列表接口只会返回空
    assert.equal((await fetch(`${base}/api/issues/${cardId}/turns/..%2F..%2Fetc/exec-1${t}`)).status, 404);

    // 4) SSE：把这一轮标成「正在跑」，流里应该看得到消息和 done
    await fs.writeFile(
      path.join(dir, '.hlwd', 'runs', runId, 'run.json'),
      JSON.stringify({
        runId,
        outcome: 'running',
        startedAt: '2026-01-01T00:00:00.000Z',
        attempts: [{ attempt: 1, execute: { startedAt: '2026-01-01T00:00:00.000Z', ms: null, ok: null } }],
      }),
    );
    const streamRes = await fetch(`${base}/api/issues/${cardId}/turns/${runId}/exec-1/stream${t}`);
    assert.equal(streamRes.status, 200);
    assert.match(streamRes.headers.get('content-type') ?? '', /text\/event-stream/);
    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    for (let i = 0; i < 20 && !text.includes('event: done'); i += 1) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (!text.includes('event: messages') && i === 0) {
        // 第一包之后把这一轮收尾，模拟「跑完了」
        await fs.writeFile(
          path.join(dir, '.hlwd', 'runs', runId, 'run.json'),
          JSON.stringify({
            runId,
            outcome: 'closed',
            startedAt: '2026-01-01T00:00:00.000Z',
            attempts: [{ attempt: 1, execute: { startedAt: '2026-01-01T00:00:00.000Z', ms: 900, ok: true } }],
          }),
        );
      }
    }
    await reader.cancel().catch(() => {});
    assert.match(text, /event: hello/);
    assert.match(text, /event: messages/);
    assert.match(text, /event: done/);
    assert.match(text, /"kind":"tool"/);
  });
});

test('附件：上传 → 列表 → 取回 → 删除', async () => {
  await withServer(async ({ base }) => {
    const t = `?token=${TOKEN}`;
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

    const up = await fetch(`${base}/api/issues/hlwd-img1/attachments${t}`, {
      method: 'POST',
      headers: { 'x-filename': encodeURIComponent('截图.png') },
      body: bytes,
    });
    assert.equal(up.status, 201);
    const { attachment } = await up.json();
    assert.equal(attachment.kind, 'image');
    assert.equal(attachment.name, '截图.png');
    assert.equal(attachment.size, bytes.length);
    assert.match(attachment.url, /^\/api\/attachments\/hlwd-img1\//);

    const list = await (await fetch(`${base}/api/issues/hlwd-img1/attachments${t}`)).json();
    assert.equal(list.attachments.length, 1);
    assert.equal(list.attachments[0].stored, attachment.stored);

    const got = await fetch(`${base}${attachment.url}${t}`);
    assert.equal(got.status, 200);
    assert.match(got.headers.get('content-type'), /image\/png/);
    assert.equal((await got.arrayBuffer()).byteLength, bytes.length);

    const del = await fetch(`${base}${attachment.url}${t}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const after = await (await fetch(`${base}/api/issues/hlwd-img1/attachments${t}`)).json();
    assert.deepEqual(after.attachments, []);

    // 越界与不存在的都按 404 处理，不吐栈
    assert.equal((await fetch(`${base}/api/attachments/hlwd-img1/..%2F..%2Fconfig.json${t}`)).status, 404);
    assert.equal((await fetch(`${base}/api/issues/hlwd-img1/attachments/nope${t}`)).status, 404);
  });
});
