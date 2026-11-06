// web 黑盒：把「当前项目」的 beads 适配层暴露成 HTTP JSON 接口 + 单页看板。
// 不跑 AI、不写 git、不碰 .beads 里的数据文件；项目可以随时切换。
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureProject,
  gateFile,
  MAX_ATTACHMENT_BYTES,
  attachmentMime,
  attachmentUrl,
  listAttachments,
  readAttachment,
  readProjectConfig,
  readPrompts,
  readState,
  rememberProject,
  removeAttachment,
  saveAttachment,
  saveProjectConfig,
  savePrompts,
} from '../project.mjs';
import * as beads from './beads.mjs';
import { getRun, journalFor, listRuns, setProjectDir } from './runs.mjs';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app');
const ENGINE_WATCH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'watch.mjs');
const WATCH_LOG = path.join(os.homedir(), '.hlwd', 'watch.log');
const PORT = Number(process.env.PORT ?? 3100);
const HOST = process.env.HOST ?? '127.0.0.1';
// 设了口令就全站要口令：内网分享时至少不是裸奔（?token= 会记成 cookie，之后不用再带）
const TOKEN = String(process.env.WF_TOKEN ?? '').trim();
const isLoopbackAddr = (addr = '') => addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';

/** 内网可访问的地址：绑 0.0.0.0 时给同事的就是这些。 */
function lanUrls(port) {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const nic of list ?? []) {
      if (nic.family !== 'IPv4' || nic.internal) continue;
      urls.push(`http://${nic.address}:${port}`);
    }
  }
  return urls;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, status, payload) {
  if (res.writableEnded || res.destroyed) return; // 客户端提前断开，不再写
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

// —— 访问口令（可选，内网分享时建议开） ——
function cookieValue(req, name) {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

function tokenGiven(req, url) {
  return url.searchParams.get('token') ?? req.headers['x-wf-token'] ?? cookieValue(req, 'wf_token');
}

function needToken(res) {
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(
    '<meta charset="utf-8"><body style="font:14px system-ui;padding:2rem">' +
      '<h2>需要访问口令</h2>' +
      '<p>地址后面加上 <code>?token=口令</code> 再打开（只第一次需要，之后会记住）。</p>' +
      '<p style="color:#888">口令由启动看板的人设置：<code>WF_TOKEN=口令 node wf.mjs board --lan</code></p></body>',
  );
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) throw new Error('请求体超过 4MB');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** 附件走原始字节（不包 JSON，避免 base64 膨胀），大小上限由调用方给。 */
async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error(`附件超过 ${Math.round(limit / 1024 / 1024)}MB`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const file = path.join(APP_DIR, path.normalize(rel));
  if (!file.startsWith(APP_DIR)) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    json(res, 404, { error: `not found: ${urlPath}` });
  }
}

// —— 当前项目 ——
let current = null;

function applyProject(dir) {
  beads.setWorkdir(dir);
  setProjectDir(dir);
  commentCache.clear(); // 卡片 id 在不同项目里可能撞车
}

async function openProject(dir, { remember = false } = {}) {
  const info = await ensureProject(dir);
  applyProject(info.dir);
  current = info;
  if (remember) await rememberProject(info.dir).catch(() => {});
  return info;
}

async function project() {
  if (!current) {
    const state = await readState().catch(() => ({ project: null }));
    await openProject(process.env.HLWD_PROJECT ?? state.project ?? process.cwd());
  }
  return current;
}

async function projectPayload() {
  const p = await project();
  const [config, prompts, state] = await Promise.all([readProjectConfig(p.dir), readPrompts(p.dir), readState()]);
  return { dir: p.dir, created: p.created ?? [], config, prompts, recent: state.recent };
}

// —— 门禁：只负责把用户送到那个文件（不读内容、不编辑，改脚本是编辑器的事） ——
async function gatePayload(dir) {
  const file = gateFile(dir);
  const exists = await fs
    .stat(file)
    .then(() => true)
    .catch(() => false);
  return { path: file, exists };
}

/** 跑 engine/watch.mjs 的 CLI：--status 读状态，--stop 请求停。跨模块只走进程。 */
function watchCli(dir, args = [], { detach = false } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    const child = spawn(process.execPath, [ENGINE_WATCH, '--project', dir, ...args], {
      cwd: dir,
      windowsHide: true,
      detached: detach,
      stdio: detach ? ['ignore', 'ignore', 'ignore'] : ['ignore', 'pipe', 'pipe'],
    });
    if (!detach) {
      child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
      child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
      child.on('error', (e) => resolve({ ok: false, out, err: e.message }));
      child.on('close', (code) => resolve({ ok: code === 0, out, err }));
      return;
    }
    child.unref();
    resolve({ ok: true, out: '', err: '' });
  });
}

async function watchState(dir) {
  const res = await watchCli(dir, ['--status']);
  for (const line of res.out.trim().split('\n').reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // 不是这一行
    }
  }
  return { running: false, state: 'unknown', error: res.err.trim() || res.out.trim() };
}

async function watchAction(dir, action) {
  if (action === 'start') {
    const current = await watchState(dir);
    if (current.running) return current;
    await fs.mkdir(path.dirname(WATCH_LOG), { recursive: true });
    const log = await fs.open(WATCH_LOG, 'a');
    const child = spawn(process.execPath, [ENGINE_WATCH, '--project', dir], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
    });
    child.unref();
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const st = await watchState(dir);
      if (st.running) return st;
    }
    await log.close();
    return { ...(await watchState(dir)), error: `没起来，看日志 ${WATCH_LOG}` };
  }

  // stop：先请求优雅停（它跑完手上这张），短暂等一下；还在跑就告诉前端“停止中”
  if (action === 'force') {
    // 强停交给 engine 自己做：它知道子进程 pid，能把跑到一半的 agent 一起杀掉
    await watchCli(dir, ['--force']);
    for (let i = 0; i < 15; i += 1) {
      await new Promise((r) => setTimeout(r, 200));
      const st = await watchState(dir);
      if (!st.running) return st;
    }
    return { ...(await watchState(dir)), stopping: true };
  }

  await watchCli(dir, ['--stop']);
  for (let i = 0; i < 8; i += 1) {
    await new Promise((r) => setTimeout(r, 200));
    const st = await watchState(dir);
    if (!st.running) return st;
  }
  return { ...(await watchState(dir)), stopping: true };
}
function launch(cmd, args) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      resolve({ ok, error });
    };
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('spawn', () => done(true));
      child.on('error', (err) => done(false, err.message));
      child.unref();
    } catch (err) {
      done(false, err.message);
    }
  });
}

/** 依次尝试几个打开方式，第一个起得来的算数。返回的是“当时用了哪个命令”。 */
async function launchFirst(attempts, what) {
  const errors = [];
  for (const [cmd, args, label] of attempts) {
    const res = await launch(cmd, args);
    if (res.ok) return label ?? cmd;
    errors.push(`${label ?? cmd}: ${res.error}`);
  }
  throw new Error(`打不开${what}（${errors.join('；')}）`);
}

/** PATH 里有没有这个命令：win32 下 spawn .cmd 需要 shell，所以先问一句再决定。 */
function hasCommand(cmd) {
  const [finder, args] = process.platform === 'win32' ? ['where.exe', [cmd]] : ['which', [cmd]];
  return new Promise((resolve) => {
    const child = spawn(finder, args, { stdio: 'ignore', windowsHide: true });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/** target=editor 用编辑器打开脚本；target=folder 在文件管理器里定位到它。 */
async function openGate(dir, target) {
  const gate = await gatePayload(dir);
  if (!gate.exists) throw new Error(`门禁脚本不存在：${gate.path}（重新打开项目会自动创建）`);
  const win = process.platform === 'win32';
  const mac = process.platform === 'darwin';

  if (target === 'folder') {
    const attempts = win
      ? [['explorer.exe', [`/select,"${gate.path}"`], 'explorer']]
      : mac
        ? [['open', ['-R', gate.path], 'finder']]
        : [['xdg-open', [path.dirname(gate.path)], 'xdg-open']];
    const via = await launchFirst(attempts, '文件管理器');
    return { ...gate, target, via };
  }

  // editor：自定义编辑器 > VS Code > 系统默认关联程序
  const custom = (process.env.HLWD_EDITOR ?? '').trim().split(/\s+/).filter(Boolean);
  const attempts = [];
  if (custom.length) attempts.push([custom[0], [...custom.slice(1), gate.path], custom[0]]);
  if (await hasCommand('code')) {
    attempts.push(win ? ['cmd.exe', ['/c', 'code', '--goto', gate.path], 'code'] : ['code', ['--goto', gate.path], 'code']);
  }
  attempts.push(
    win
      ? ['cmd.exe', ['/c', 'start', '', gate.path], '系统默认程序']
      : mac
        ? ['open', [gate.path], '系统默认程序']
        : ['xdg-open', [gate.path], 'xdg-open'],
  );

  const via = await launchFirst(attempts, '门禁脚本');
  return { ...gate, target, via };
}

// 搜索：标题 + 描述 + 评论。评论按 issue.updated 缓存，避免每敲一个字都重跑 bd。
const commentCache = new Map();

async function commentText(issue) {
  const hit = commentCache.get(issue.id);
  if (hit && hit.updated === issue.updated) return hit.text;
  const comments = await beads.listComments(issue.id).catch(() => []);
  const text = comments.map((c) => c.text).join('\n').toLowerCase();
  commentCache.set(issue.id, { updated: issue.updated, text });
  return text;
}

async function searchIssues(issues, query) {
  const needle = query.toLowerCase();
  const matched = new Set();
  for (const issue of issues) {
    if (`${issue.title}\n${issue.body}`.toLowerCase().includes(needle)) matched.add(issue.id);
  }
  await Promise.all(
    issues
      .filter((issue) => !matched.has(issue.id))
      .map(async (issue) => {
        if ((await commentText(issue)).includes(needle)) matched.add(issue.id);
      }),
  );
  return issues.filter((issue) => matched.has(issue.id));
}

async function route(req, res, url) {
  const { pathname, searchParams } = url;

  if (TOKEN) {
    if (tokenGiven(req, url) !== TOKEN) return needToken(res);
    if (searchParams.get('token') === TOKEN) {
      // 第一次带对了就记住，刷新/切页不用一直挂着口令
      res.setHeader('set-cookie', `wf_token=${TOKEN}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax`);
    }
  }

  if (pathname === '/api/meta') {
    const p = await project();
    const cfg = await readProjectConfig(p.dir);
    return json(res, 200, {
      statuses: cfg.columns,
      labels: cfg.labels,
      readyLabel: cfg.engine.readyLabel,
      workspace: p.dir,
      share: { host: HOST, port: PORT, token: Boolean(TOKEN), lan: lanUrls(PORT) },
    });
  }

  if (pathname === '/api/project') {
    if (req.method === 'GET') return json(res, 200, await projectPayload());
    if (req.method === 'POST') {
      const body = await readBody(req);
      if (!body.dir || typeof body.dir !== 'string') return json(res, 400, { error: '缺少项目目录 dir' });
      try {
        const info = await openProject(body.dir, { remember: true });
        return json(res, 200, { ...(await projectPayload()), created: info.created });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  if (pathname === '/api/settings') {
    const p = await project();
    if (req.method === 'GET') {
      return json(res, 200, {
        config: await readProjectConfig(p.dir),
        prompts: await readPrompts(p.dir),
        gate: await gatePayload(p.dir),
      });
    }
    if (req.method === 'PUT') {
      const body = await readBody(req);
      try {
        const config = await saveProjectConfig(p.dir, body);
        const prompts = body.prompts ? await savePrompts(p.dir, body.prompts) : await readPrompts(p.dir);
        return json(res, 200, { config, prompts });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  await project(); // 以下接口都作用于当前项目

  // 自动流水线：有就绪单就自己开干，不用人守着终端
  if (pathname === '/api/watch') {
    const p = await project();
    if (req.method === 'GET') return json(res, 200, { watch: await watchState(p.dir) });
    if (req.method === 'POST') {
      // 这个会在这台机器上起 AI：只允许本机点（内网只能看状态、派单）
      if (!isLoopbackAddr(req.socket.remoteAddress)) {
        return json(res, 403, { error: '只允许在本机开关自动流水线' });
      }
      const body = await readBody(req);
      const action = ['stop', 'force'].includes(body.action) ? body.action : 'start';
      return json(res, 200, { watch: await watchAction(p.dir, action) });
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  // 设置里的「门禁」按钮：把用户送到 <项目>/.hlwd/gate.mjs
  if (pathname === '/api/gate/open') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    // 这个接口会在这台机器上调起编辑器：内网分享时只能是本机自己点
    if (!isLoopbackAddr(req.socket.remoteAddress)) {
      return json(res, 403, { error: '只允许在本机打开门禁脚本；远程请直接改文件' });
    }
    const body = await readBody(req);
    const target = body.target === 'folder' ? 'folder' : 'editor';
    const p = await project();
    try {
      return json(res, 200, await openGate(p.dir, target));
    } catch (err) {
      return json(res, 400, { error: err.message });
    }
  }

  if (pathname === '/api/issues') {
    if (req.method === 'GET') {
      let issues = await beads.listIssues({
        status: searchParams.get('status') ?? undefined,
        ready: searchParams.get('ready') === '1',
        label: searchParams.get('label') ?? undefined,
        assignee: searchParams.get('assignee') ?? undefined,
      });
      const q = (searchParams.get('q') ?? '').trim();
      if (q) issues = await searchIssues(issues, q);
      return json(res, 200, { issues });
    }
    if (req.method === 'POST') {
      const body = await readBody(req);
      const issue = await beads.createIssue({
        title: body.title,
        description: body.description ?? '',
        type: body.type ?? 'task',
        priority: body.priority,
        labels: body.labels ?? [],
        assignee: body.assignee ?? undefined,
      });
      return json(res, 201, { issue });
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  const m = pathname.match(/^\/api\/issues\/([^/]+)(\/comments|\/runs|\/history|\/journal|\/attachments)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
    if (m[2] === '/attachments') {
      const p = await project();
      if (req.method === 'GET') {
        const files = await listAttachments(p.dir, id);
        return json(res, 200, { attachments: files.map((f) => ({ ...f, url: attachmentUrl(id, f.stored) })) });
      }
      if (req.method === 'POST') {
        const filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'file'));
        // x-scope: inline 表示「粘进评论的图」，是评论 markdown 的一部分，不进附件列表
        const scope = String(req.headers['x-scope'] ?? '') === 'inline' ? 'inline' : 'card';
        const data = await readRaw(req, MAX_ATTACHMENT_BYTES);
        try {
          const meta = await saveAttachment(p.dir, id, { name: filename, data, scope });
          return json(res, 201, { attachment: { ...meta, url: attachmentUrl(id, meta.stored) } });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
      return json(res, 405, { error: 'method not allowed' });
    }
    if (m[2] === '/comments') {
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      const body = await readBody(req);
      const comments = await beads.commentIssue(id, body.text);
      return json(res, 200, { comments });
    }
    if (m[2] === '/runs') return json(res, 200, { runs: await listRuns(id) });
    if (m[2] === '/journal') return json(res, 200, { journal: await journalFor(id) });
    if (m[2] === '/history') return json(res, 200, { history: await beads.listStatusHistory(id) });
    if (req.method === 'GET') return json(res, 200, await beads.getIssue(id));
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const issue = await beads.updateIssue(id, {
        status: body.status ?? undefined,
        priority: body.priority ?? undefined,
        assignee: body.assignee ?? undefined,
        title: body.title ?? undefined,
        description: body.description ?? undefined,
        addLabels: body.addLabels ?? [],
        removeLabels: body.removeLabels ?? [],
      });
      return json(res, 200, { issue });
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  // 附件字节：GET 看/下载，DELETE 删
  const att = pathname.match(/^\/api\/attachments\/([^/]+)\/([^/]+)$/);
  if (att) {
    const p = await project();
    const cardId = decodeURIComponent(att[1]);
    const stored = decodeURIComponent(att[2]);
    if (req.method === 'DELETE') {
      const ok = await removeAttachment(p.dir, cardId, stored);
      return ok ? json(res, 200, { ok: true }) : json(res, 404, { error: '附件不存在' });
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    const hit = await readAttachment(p.dir, cardId, stored);
    if (!hit) return json(res, 404, { error: '附件不存在' });
    res.writeHead(200, {
      'content-type': attachmentMime(hit.meta.name),
      'content-length': hit.data.length,
      'cache-control': 'private, max-age=3600',
      'content-disposition': `inline; filename*=UTF-8''${encodeURIComponent(hit.meta.name)}`,
    });
    return res.end(hit.data);
  }

  if (pathname === '/api/runs') {
    const cardId = searchParams.get('card');
    if (!cardId) return json(res, 400, { error: '缺少 card 参数' });
    return json(res, 200, { runs: await listRuns(cardId) });
  }

  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (runMatch) {
    const run = await getRun(decodeURIComponent(runMatch[1]));
    return run ? json(res, 200, { run }) : json(res, 404, { error: '运行记录不存在' });
  }

  if (pathname.startsWith('/api/')) return json(res, 404, { error: 'unknown api' });
  return serveStatic(res, pathname);
}

const server = http.createServer((req, res) => {
  res.on('error', () => {}); // 客户端中途断开（EPIPE）不应拖垮整个服务
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    return json(res, 400, { error: 'bad request url' });
  }
  route(req, res, url).catch((err) => {
    json(res, 400, { error: err.message ?? String(err) });
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${PORT} 已被占用（很可能看板已经在跑）。`);
    console.error(`→ 直接打开 http://127.0.0.1:${PORT}`);
    console.error(`→ 或换个端口：PORT=3101 npm start`);
    process.exit(1);
  }
  console.error(`看板启动失败：${err.message}`);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log('\n看板已停止');
    server.close(() => process.exit(0));
  });
}

server.listen(PORT, HOST, async () => {
  console.log(`看板：http://127.0.0.1:${PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    const urls = lanUrls(PORT);
    console.log(`内网分享（绑 ${HOST}）：${urls.join('  ') || '没找到内网地址'}`);
    console.log(TOKEN ? '访问口令：已开启（WF_TOKEN）' : '注意：没设 WF_TOKEN，本网段的人都能建单/改单');
  }
  try {
    const p = await project();
    console.log(`当前项目：${p.dir}`);
    if (p.created?.length) console.log(`已补齐：${p.created.join('、')}`);
    // 项目选了「看板启动时自动开流水线」就顺手拉起来（默认关，不替人做决定）
    if (p.config?.engine?.autoWatch) {
      const st = await watchAction(p.dir, 'start');
      console.log(st.running ? `自动流水线：已随看板启动（pid ${st.pid}）` : `自动流水线没起来：${st.error ?? '看 watch.log'}`);
    }
  } catch (err) {
    console.error(`项目初始化失败：${err.message}`);
  }
});
