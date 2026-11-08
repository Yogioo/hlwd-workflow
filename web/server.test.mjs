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
import { ensureProject } from '../project.mjs';

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

/** 起一个只绑 loopback 的 server，跑完就杀。auth=true 时开账号登录（默认关着，测老契约）。 */
async function withServer(fn, { auth = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-server-'));
  await fs.mkdir(path.join(dir, '.beads'), { recursive: true }); // 免得走 bd init
  const port = await freePort();
  const proc = spawn(process.execPath, [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      WF_TOKEN: TOKEN,
      WF_AUTH: auth ? 'on' : 'off',
      HLWD_HOME: path.join(dir, 'home'), // 账号/会话写到临时目录，别碰本机真账号
      HLWD_PROJECT: dir,
      WF_NO_OPEN: '1',
    },
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

test('账号：没登录 401，注册后按人记账（创建者 / 评论作者 / 改状态）', async () => {
  await withServer(async ({ base, dir }) => {
    // 自己管 cookie：node 的 fetch 不存 cookie
    const jar = {};
    const takeCookies = (res) => {
      const raw = res.headers.getSetCookie?.() ?? [];
      for (const line of raw) {
        const [pair] = line.split(';');
        const [k, ...rest] = pair.split('=');
        jar[k.trim()] = rest.join('=');
      }
    };
    const call = async (path, options = {}) => {
      const url = `${base}${path}${path.includes('?') ? '&' : '?'}token=${TOKEN}`;
      const res = await fetch(url, {
        ...options,
        headers: { 'content-type': 'application/json', ...(jar.wf_session ? { cookie: `wf_session=${jar.wf_session}` } : {}) },
      });
      takeCookies(res);
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    };

    // 这个用例真的要写 beads：把占位目录换成真库（bd init）
    await fs.rm(path.join(dir, '.beads'), { recursive: true, force: true });
    await ensureProject(dir);

    // 1) 没登录：接口挡住，登录页自己能加载
    assert.equal((await call('/api/issues')).status, 401);
    assert.equal((await call('/api/issues')).data.needsLogin, true);
    assert.equal((await fetch(`${base}/index.html?token=${TOKEN}`)).status, 200);

    const me0 = await call('/api/auth/me');
    assert.equal(me0.status, 200);
    assert.equal(me0.data.auth, true);
    assert.equal(me0.data.user, null);
    assert.equal(me0.data.firstRun, true, '还没有账号 → 引导去注册');

    // 2) 注册第一个账号：自动是 owner，并直接登录
    const reg = await call('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'alice', display: '爱丽丝', password: 'secret1' }),
    });
    assert.equal(reg.status, 201, JSON.stringify(reg.data));
    assert.equal(reg.data.user.name, 'alice');
    assert.equal(reg.data.user.display, '爱丽丝');
    assert.equal(reg.data.user.role, 'owner');
    assert.ok(jar.wf_session, '注册后要有会话 cookie');
    assert.equal(reg.data.user.hash, undefined, '别把密码哈希吐给前端');
    assert.equal(reg.data.user.salt, undefined);

    // 3) 建单：创建者记成登录的人
    const created = await call('/api/issues', {
      method: 'POST',
      body: JSON.stringify({ title: '谁建的这张单', type: 'task', priority: 2 }),
    });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const cardId = created.data.issue.id;
    assert.equal(created.data.issue.createdBy, '爱丽丝');

    // 4) 评论：作者是登录的人
    await call(`/api/issues/${cardId}/comments`, { method: 'POST', body: JSON.stringify({ text: '我是爱丽丝' }) });
    const detail = await call(`/api/issues/${cardId}`);
    assert.equal(detail.data.comments.at(-1).author, '爱丽丝');

    // 5) 改状态：留一条「谁改的」记录
    const patched = await call(`/api/issues/${cardId}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'in_progress' }),
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.data));
    assert.equal(patched.data.issue.status, 'in_progress');
    const after = await call(`/api/issues/${cardId}`);
    const change = after.data.comments.at(-1);
    assert.equal(change.author, '爱丽丝', '状态变更要署上是谁改的');
    assert.match(change.text, /状态/);
    assert.match(change.text, /待接|open/);
    assert.match(change.text, /执行中|in_progress/);

    // 6) 第二个人：重名不行，密码错不行
    const dup = await call('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name: 'ALICE', password: 'secret2' }),
    });
    assert.equal(dup.status, 400);
    assert.match(dup.data.error, /已经被注册/);

    const badPass = await call('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ name: 'alice', password: 'nope-nope' }),
    });
    assert.equal(badPass.status, 401);

    // 7) 重登（清除当前会话后用密码登回来），资料落在磁盘上且是 0600
    const usersFile = path.join(dir, 'home', 'users.json');
    const saved = JSON.parse(await fs.readFile(usersFile, 'utf8'));
    assert.equal(saved.users.length, 1);
    assert.ok(saved.users[0].salt && saved.users[0].hash, '密码只存 salt + hash');
    assert.ok(!JSON.stringify(saved).includes('secret1'), '不能存明文密码');
    const mode = (await fs.stat(usersFile)).mode & 0o777;
    if (process.platform !== 'win32') assert.equal(mode, 0o600);

    await call('/api/auth/logout', { method: 'POST', body: '{}' });
    assert.equal((await call('/api/issues')).status, 401, '退出后又要登录');
    const back = await call('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ name: 'alice', password: 'secret1' }),
    });
    assert.equal(back.status, 200);
    assert.equal((await call('/api/issues')).status, 200);
  }, { auth: true });
});

test('账号：WF_AUTH=off 时不用登录（单机自用）', async () => {
  await withServer(async ({ base }) => {
    const t = `?token=${TOKEN}`;
    const me = await (await fetch(`${base}/api/auth/me${t}`)).json();
    assert.equal(me.auth, false);
    assert.equal(me.user, null);
    assert.equal((await fetch(`${base}/api/meta${t}`)).status, 200, '关掉登录就能直接访问接口');
    const reg = await fetch(`${base}/api/auth/register${t}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'bob', password: 'secret1' }),
    });
    assert.equal(reg.status, 400, '关着的时候不该还能注册');
  });
});

test('工单页：/issue/<id> 也给同一个单页（地址可分享）', async () => {
  await withServer(async ({ base }) => {
    const t = `?token=${TOKEN}`;
    const res = await fetch(`${base}/issue/hlwd-abc${t}`);
    assert.equal(res.status, 200);
    assert.ok((res.headers.get('content-type') ?? '').includes('text/html'));
    const html = await res.text();
    assert.match(html, /id="issuePage"/, '返回的是看板单页（前端从 URL 读 id）');
    assert.match(html, /id="panelComments"/);
    // 别的非 API 路径还是 404，不要变成万能兜底
    assert.equal((await fetch(`${base}/nope/whatever${t}`)).status, 404);
  });
});

test('实时通道：SSE 先给快照，发评论后推一次', async () => {
  await withServer(async ({ base, dir }) => {
    // 这个用例要真写 beads
    await fs.rm(path.join(dir, '.beads'), { recursive: true, force: true });
    await ensureProject(dir);
    const t = `?token=${TOKEN}`;
    const mk = await fetch(`${base}/api/issues${t}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '实时通道测试', type: 'task', priority: 2 }),
    });
    assert.equal(mk.status, 201);
    const { issue } = await mk.json();

    const stream = await fetch(`${base}/api/issues/${issue.id}/events${t}`);
    assert.equal(stream.status, 200);
    assert.ok((stream.headers.get('content-type') ?? '').includes('text/event-stream'));
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const readUntil = async (needle) => {
      for (let i = 0; i < 40 && !buffer.includes(needle); i += 1) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
      }
      return buffer.includes(needle);
    };

    // 1) 连上就给一份当前快照
    assert.ok(await readUntil('event: issue'), '连上先拿快照');
    assert.match(buffer, /"title":"实时通道测试"/);

    // 2) 别人发评论 → 推一条新的过来
    buffer = '';
    const posted = await fetch(`${base}/api/issues/${issue.id}/comments${t}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '这条应该实时推过去' }),
    });
    assert.equal(posted.status, 200);
    assert.ok(await readUntil('这条应该实时推过去'), `推送里要带上新评论，收到：${buffer.slice(0, 120)}`);
    await reader.cancel().catch(() => {});
  });
});

test('附件：各种文件类型都能传能下（名字和字节都不变）', async () => {
  await withServer(async ({ base }) => {
    const t = '?token=' + TOKEN;
    const cases = [
      // 文件名, 期望的 content-type 前缀, 正文
      ['报告.pdf', 'application/pdf', '%PDF-1.4 fake', 'inline'],
      ['数据.csv', 'text/csv', 'a,b\n1,2\n', 'inline'],
      ['配置.json', 'application/json', '{"a":1}', 'inline'],
      ['说明.md', 'text/plain', '# 标题', 'inline'],
      ['压缩包.zip', 'application/zip', 'PK\x03\x04fake', 'inline'],
      ['文档.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'PK\x03\x04docx', 'inline'],
      ['表格.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'PK\x03\x04xlsx', 'inline'],
      ['归档.tar.gz', 'application/gzip', '\x1f\x8bgz', 'inline'],
      ['没有扩展名', 'application/octet-stream', 'raw bytes', 'inline'],
      ['大写扩展.PDF', 'application/pdf', '%PDF-1.4 upper', 'inline'],
      ['图标.svg', 'image/svg+xml', '<svg onload="alert(1)"></svg>', 'attachment'],
    ];

    for (const [name, type, body, defaultDisposition] of cases) {
      const bytes = Buffer.from(body, 'utf8');
      const up = await fetch(base + '/api/issues/hlwd-type/attachments' + t, {
        method: 'POST',
        headers: { 'x-filename': encodeURIComponent(name) },
        body: bytes,
      });
      assert.equal(up.status, 201, name + ' 上传失败');
      const { attachment } = await up.json();
      assert.equal(attachment.name, name, '列表里要保留原名');

      // 不带参数：能不能在页面里直接打开
      const inline = await fetch(base + attachment.url + t);
      assert.equal(inline.status, 200);
      assert.ok((inline.headers.get('content-type') ?? '').startsWith(type), name + ' 的 content-type：' + inline.headers.get('content-type'));
      assert.equal(inline.headers.get('x-content-type-options'), 'nosniff', name + ' 要带 nosniff');
      const dispInline = decodeURIComponent(inline.headers.get('content-disposition') ?? '');
      assert.ok(dispInline.startsWith(defaultDisposition), name + ' 默认应该是 ' + defaultDisposition + '，实际 ' + dispInline);
      assert.ok(dispInline.includes(name), name + ' 默认响应里要带原名：' + dispInline);

      // 下载：一定是 attachment，名字还原，字节一致
      const dl = await fetch(base + attachment.url + '?download=1&token=' + TOKEN);
      assert.equal(dl.status, 200);
      const disp = decodeURIComponent(dl.headers.get('content-disposition') ?? '');
      assert.ok(disp.startsWith('attachment'), name + ' 下载要是 attachment：' + disp);
      assert.ok(disp.includes(name), name + ' 下载要用原名：' + disp);
      const got = Buffer.from(await dl.arrayBuffer());
      assert.equal(got.length, bytes.length, name + ' 字节数对不上');
      assert.ok(got.equals(bytes), name + ' 字节内容变了');
    }

    // 列表里：图片算 image，其余都算 file（SVG 仍是 image，但只能下载，不会在本站当页面打开）
    const list = await (await fetch(base + '/api/issues/hlwd-type/attachments' + t)).json();
    const kinds = Object.fromEntries(list.attachments.map((a) => [a.name, a.kind]));
    assert.equal(kinds['图标.svg'], 'image');
    assert.equal(kinds['报告.pdf'], 'file');
    assert.equal(kinds['没有扩展名'], 'file');
    assert.equal(list.attachments.length, cases.length);
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

    // 默认 inline（页面里直接看）；?download=1 变成下载，文件名还原成用户给的那个
    assert.ok((got.headers.get('content-disposition') ?? '').startsWith('inline'), got.headers.get('content-disposition'));
    const dl = await fetch(`${base}${attachment.url}?download=1&token=${TOKEN}`);
    assert.equal(dl.status, 200);
    const disp = dl.headers.get('content-disposition') ?? '';
    assert.ok(disp.startsWith('attachment'), disp);
    assert.ok(decodeURIComponent(disp).includes('截图.png'), '下载时要用原文件名：' + disp);
    assert.equal((await dl.arrayBuffer()).byteLength, bytes.length);

    const del = await fetch(`${base}${attachment.url}${t}`, { method: 'DELETE' });
    assert.equal(del.status, 200);
    const after = await (await fetch(`${base}/api/issues/hlwd-img1/attachments${t}`)).json();
    assert.deepEqual(after.attachments, []);

    // 越界与不存在的都按 404 处理，不吐栈
    assert.equal((await fetch(`${base}/api/attachments/hlwd-img1/..%2F..%2Fconfig.json${t}`)).status, 404);
    assert.equal((await fetch(`${base}/api/issues/hlwd-img1/attachments/nope${t}`)).status, 404);
  });
});

test('运行目录文件：只放白名单，越界、别的卡、不在名单里一律 404', async () => {
  await withServer(async ({ base, dir }) => {
    const cardId = 'hlwd-file';
    const runId = `${cardId}-1700000000001`;
    const runDir = path.join(dir, '.hlwd', 'runs', runId);
    const at = (card, name) =>
      `${base}/api/issues/${card}/runs/${runId}/file?name=${encodeURIComponent(name)}&token=${TOKEN}`;
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, 'run.json'),
      JSON.stringify({ runId, card: { id: cardId }, outcome: 'closed', attempts: [] }),
    );
    await fs.writeFile(path.join(runDir, 'gate-1.log'), '# 门禁\nnpm test 失败\n');
    await fs.writeFile(path.join(runDir, 'prompt-exec-1.md'), '你是执行端');

    const gate = await fetch(at(cardId, 'gate-1.log'));
    assert.equal(gate.status, 200);
    assert.match((await gate.json()).text, /npm test 失败/);

    const prompt = await fetch(at(cardId, 'prompt-exec-1.md'));
    assert.equal(prompt.status, 200);
    assert.equal((await prompt.json()).text, '你是执行端');

    // run.json 是内部记录，不在白名单里
    assert.equal((await fetch(at(cardId, 'run.json'))).status, 404);
    // 越界 / 别的卡的 run / 不存在的文件
    assert.equal((await fetch(at(cardId, '../../secret'))).status, 404);
    assert.equal((await fetch(at('other-card', 'gate-1.log'))).status, 404);
    assert.equal((await fetch(at(cardId, 'gate-2.log'))).status, 404);
  });
});

test('设置：AI 预设与节点引用一起保存，挂在节点上的预设删不掉', async () => {
  await withServer(async ({ base }) => {
    const t = `?token=${TOKEN}`;
    const boot = await fetch(`${base}/api/settings${t}`);
    assert.equal(boot.status, 200);
    const settings = await boot.json();
    assert.deepEqual(settings.config.engine.presets.map((p) => p.id), ['default']);
    assert.deepEqual(settings.config.engine.nodes, {
      execute: { preset: 'default' },
      review: { preset: 'default' },
      complete: { commit: true },
    });

    const put = async (body) => {
      const res = await fetch(`${base}/api/settings${t}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json() };
    };

    const presets = [
      { id: 'exec', name: '执行', runner: 'pi', model: 'exec-model', thinking: 'high' },
      { id: 'rev', name: '审查', runner: 'codex', model: 'review-model', thinking: 'low' },
    ];
    const saved = await put({
      engine: { presets, nodes: { execute: { preset: 'exec' }, review: { preset: 'rev' } } },
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.config.engine.nodes, {
      execute: { preset: 'exec' },
      review: { preset: 'rev' },
      complete: { commit: true },
    });

    // 收尾节点：通过后是否提交，独立于预设
    const noCommit = await put({ engine: { nodes: { complete: { commit: false } } } });
    assert.equal(noCommit.status, 200);
    assert.equal(noCommit.body.config.engine.nodes.complete.commit, false);
    assert.equal((await put({ engine: { nodes: { complete: { commit: 'yes' } } } })).status, 400);

    // 只改预设，节点挂着不动
    const tweak = await put({ engine: { presets: [presets[0], { ...presets[1], model: 'other' }] } });
    assert.equal(tweak.status, 200);
    assert.equal(tweak.body.config.engine.presets[1].model, 'other');
    assert.equal(tweak.body.config.engine.nodes.review.preset, 'rev');

    // 还挂在节点上的预设删不掉；节点也不能留空或指向不存在的预设
    const del = await put({ engine: { presets: [presets[1]] } });
    assert.equal(del.status, 400);
    assert.match(del.body.error, /正被执行节点使用/);

    assert.equal((await put({ engine: { nodes: { execute: { preset: '' } } } })).status, 400);
    const missing = await put({ engine: { nodes: { execute: { preset: 'nope' } } } });
    assert.equal(missing.status, 400);
    assert.match(missing.body.error, /不存在/);
  });
});

