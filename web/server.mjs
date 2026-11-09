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
  attachmentInlineSafe,
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
import { prefsFor, savePrefs } from './prefs.mjs';
import { createTag, deleteTag, listTags, updateTag } from './tags.mjs';
import { WORKFLOW_COLUMNS, alive, graphOf, workflowOf } from './workflow.mjs';
import {
  AuthError,
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  changePassword,
  countUsers,
  createSession,
  dropSession,
  listUsers,
  publicUser,
  readSession,
  register,
  renameUser,
  verify,
} from './auth.mjs';
import { getRun, latestRun, latestRuns, listRuns, readRunFile, setProjectDir } from './runs.mjs';
import { listTurns, readTurn, setProjectDir as setSessionsDir, tailFrom } from './sessions.mjs';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app');
const ENGINE_WATCH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'engine', 'watch.mjs');
const WATCH_LOG = path.join(os.homedir(), '.hlwd', 'watch.log');
const PORT = Number(process.env.PORT ?? 3100);
const HOST = process.env.HOST ?? '127.0.0.1';
// 设了口令就全站要口令：内网分享时至少不是裸奔（?token= 会记成 cookie，之后不用再带）
const TOKEN = String(process.env.WF_TOKEN ?? '').trim();
// 账号登录：部署在没人守的机器上、同事从内网访问时默认开。单机自用可以 WF_AUTH=off 关掉。
const AUTH = String(process.env.WF_AUTH ?? 'on').toLowerCase() !== 'off';
const AUTH_OPEN = new Set(['/api/auth/me', '/api/auth/login', '/api/auth/register']);
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

// 同一次响应可能要种两个 cookie（口令 + 会话），setHeader 会互相盖掉，所以追加着写
function appendCookie(res, value) {
  const prev = res.getHeader('set-cookie');
  const list = prev ? (Array.isArray(prev) ? prev : [prev]) : [];
  res.setHeader('set-cookie', [...list, value]);
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

// —— 身份 ——
// 登录后 cookie 里是随机 token（不是密码）；token → 用户在 auth.mjs 里查。
const sessionToken = (req) => cookieValue(req, SESSION_COOKIE);

async function currentUser(req) {
  if (!AUTH) return null;
  return readSession(sessionToken(req)).catch(() => null);
}

/** bd 的 --actor 用显示名：审计轨迹（created_by / 评论作者）里人一眼认得。 */
const actorOf = (user) => (user ? user.display || user.name : '');

const setSessionCookie = (res, token) =>
  appendCookie(res, `${SESSION_COOKIE}=${token}; Path=/; Max-Age=${SESSION_MAX_AGE_S}; HttpOnly; SameSite=Lax`);
const clearSessionCookie = (res) => appendCookie(res, `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);

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
  setSessionsDir(dir);
  stopCardStreams(); // 换了项目，旧项目的实时通道全部作废
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

// —— 工作流进度：从最新 run 派生，不写回 beads ——
// 列表只带 workflow（列用）；单卡再带 graph（节点图用），别给看板塞冗余。
const withWorkflow = (issue, run) => ({ ...issue, workflow: workflowOf(issue, run) });
const withCard = (issue, run) => ({ ...withWorkflow(issue, run), graph: graphOf(issue, run) });
const runSig = (run) =>
  run
    ? [
        run.runId,
        run.outcome,
        run.endedAt,
        run.attempts?.length,
        run.attempts?.at(-1)?.execute?.ok,
        run.attempts?.at(-1)?.gate?.pass,
        run.attempts?.at(-1)?.review?.pass,
        // 进程没了也要推一次，否则页面会一直停在“执行中”等手动刷新
        run.outcome === 'running' ? (alive(run.pid) ? 'live' : 'dead') : '',
      ].join('|')
    : '';

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
    // 子进程已经拿到自己那份 fd，父进程这份立刻关掉：
    // 不关会漏文件句柄，Node 22+ 还会在 GC 时报 DEP0137 警告
    await log.close().catch(() => {});
    child.unref();
    for (let i = 0; i < 50; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      const st = await watchState(dir);
      if (st.running) return st;
    }
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

// —— 会话（执行端 / 审查端的内部过程）——
// 一轮 agent 回合可能有几百 KB 的 events.jsonl：跑完的用 GET 分页翻，还在跑的开 SSE 跟着长。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function streamTurn(req, res, cardId, runId, phase) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no', // 内网反代别攒包
  });

  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  const send = (event, data) => {
    if (closed || res.writableEnded || res.destroyed) return false;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    return true;
  };

  send('hello', { card: cardId, runId, phase });

  let state = {}; // 事件读游标 + 半行残留 + 归一化状态，tailFrom 会一路带下去
  const startedAt = Date.now();
  let lastWrite = Date.now();
  let missingPolls = 0;

  try {
    while (!closed) {
      const chunk = await tailFrom(cardId, runId, phase, state);
      state = chunk;

      if (chunk.missing) {
        // 回合刚起来、events.jsonl 还没写（agent 吞第一条事件前有一段空白）：等它一会儿
        missingPolls += 1;
        if (missingPolls === 1) send('waiting', { phase });
        if (missingPolls > 120) {
          send('missing', { phase });
          break;
        }
      } else {
        missingPolls = 0;
        if (chunk.messages.length) {
          send('messages', { card: cardId, runId, phase, messages: chunk.messages });
          lastWrite = Date.now();
        }
      }

      // 这一轮回合跑完了就不再等：收尾信息给前端，前端再拉一次完整内容（带 output.txt）
      const turn = (await listTurns(cardId)).find((t) => t.runId === runId && t.phaseKey === phase);
      if (turn?.done) {
        send('done', { phase, ms: turn.ms, result: turn.result });
        break;
      }
      // 过程很久没新东西也别装死：定时发个注释保活，超过上限主动收线
      if (Date.now() - lastWrite > 15000) {
        if (!send('ping', { at: Date.now() })) break;
        lastWrite = Date.now();
      }
      if (Date.now() - startedAt > 15 * 60 * 1000) {
        send('timeout', { phase });
        break;
      }
      await sleep(500);
    }
  } catch (err) {
    send('error', { error: err.message ?? String(err) });
  } finally {
    res.end();
  }
}

// —— 实时：同一张卡上的评论 / 字段变化，推给所有正在看它的人 ——
// 写路径（我们的 POST/PATCH）直接广播；另外每条被看的卡一个慢轮询（2s），
// 把 engine 或别的进程直接改 bd 的变化也接进来。轮询是**每卡一份**，不随人数增长。
const CARD_POLL_MS = 2000;
const cardStreams = new Map(); // cardId -> { clients:Set<res>, timer, stamp }

const SSE_HEAD = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
};

function cardEntry(cardId) {
  let entry = cardStreams.get(cardId);
  if (!entry) {
    entry = { clients: new Set(), timer: null, stamp: '' };
    cardStreams.set(cardId, entry);
  }
  return entry;
}

function pushCard(cardId, payload) {
  const entry = cardStreams.get(cardId);
  if (!entry?.clients.size) return;
  const data = `event: issue\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of [...entry.clients]) {
    if (res.writableEnded || res.destroyed) {
      entry.clients.delete(res);
      continue;
    }
    try {
      res.write(data);
    } catch {
      entry.clients.delete(res);
    }
  }
}

/** 有变化就把整张卡（工单 + 评论，都很小）推一遍。 */
async function broadcastCard(cardId) {
  const entry = cardStreams.get(cardId);
  if (!entry?.clients.size) return;
  try {
    const [stamp, run, payload] = await Promise.all([beads.issueStamp(cardId), latestRun(cardId), beads.getIssue(cardId)]);
    entry.stamp = `${stamp}|${runSig(run)}`;
    pushCard(cardId, { ...payload, issue: withCard(payload.issue, run) });
  } catch {
    // 工单被删了之类：这一轮就算了
  }
}

function startCardPoll(cardId) {
  const entry = cardEntry(cardId);
  if (entry.timer) return;
  entry.timer = setInterval(async () => {
    if (!entry.clients.size) {
      clearInterval(entry.timer);
      entry.timer = null;
      cardStreams.delete(cardId);
      return;
    }
    try {
      const [stamp, run] = await Promise.all([beads.issueStamp(cardId), latestRun(cardId)]);
      const seen = `${stamp}|${runSig(run)}`;
      if (seen === entry.stamp) return;
      entry.stamp = seen;
      const { issue, comments } = await beads.getIssue(cardId);
      pushCard(cardId, { issue: withCard(issue, run), comments });
    } catch {
      // 临时读不到就算了，下一轮再说
    }
  }, CARD_POLL_MS);
  entry.timer.unref?.();
}

function stopCardStreams() {
  for (const entry of cardStreams.values()) {
    if (entry.timer) clearInterval(entry.timer);
    for (const res of entry.clients) {
      try {
        res.end();
      } catch {
        // 已经断了
      }
    }
  }
  cardStreams.clear();
}

/** 一张卡的实时通道：先给一份当前快照，之后有变化就推。 */
async function streamCard(req, res, cardId) {
  res.writeHead(200, SSE_HEAD);
  const entry = cardEntry(cardId);
  entry.clients.add(res);
  const send = (event, payload) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  };

  const bye = () => {
    entry.clients.delete(res);
  };
  req.on('close', bye);
  res.on('close', bye);

  try {
    const [{ issue, comments }, run] = await Promise.all([beads.getIssue(cardId), latestRun(cardId)]);
    entry.stamp = `${issue.updated}|${issue.commentCount}|${runSig(run)}`;
    send('issue', { issue: withCard(issue, run), comments });
  } catch (err) {
    send('gone', { error: err.message });
  }
  startCardPoll(cardId);

  // 注释行保活：中间有反代/浏览器空闲超时也不会断
  const keepalive = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(keepalive);
      return;
    }
    res.write(': ping\n\n');
  }, 25000);
  keepalive.unref?.();
  res.on('close', () => clearInterval(keepalive));
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

  const user = await currentUser(req);

  // 没登录就只能访问登录/注册接口和静态页（页面自己要能加载才能显示登录框）
  if (AUTH && !user && pathname.startsWith('/api/') && !AUTH_OPEN.has(pathname)) {
    return json(res, 401, { error: '需要登录', needsLogin: true });
  }

  if (pathname === '/api/auth/me') {
    return json(res, 200, {
      auth: AUTH,
      user: user ? publicUser(user) : null,
      firstRun: AUTH && (await countUsers()) === 0,
      users: AUTH ? await listUsers() : [],
    });
  }

  if (pathname === '/api/auth/register' || pathname === '/api/auth/login' || pathname === '/api/auth/logout') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    try {
      if (!AUTH) throw new AuthError('这个看板没开登录（启动时设了 WF_AUTH=off）', 400);
      if (pathname === '/api/auth/logout') {
        await dropSession(sessionToken(req));
        clearSessionCookie(res);
        return json(res, 200, { ok: true, user: null });
      }
      const body = await readBody(req);
      // 注册完直接算登录：不用让人填两遍
      const account = pathname === '/api/auth/register' ? await register(body) : await verify(body);
      setSessionCookie(res, await createSession(account.name));
      return json(res, pathname === '/api/auth/register' ? 201 : 200, { user: account, auth: AUTH });
    } catch (err) {
      return json(res, err instanceof AuthError ? err.status : 400, { error: err.message });
    }
  }

  if (pathname === '/api/auth/password') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    if (!user) throw new AuthError('需要登录', 401);
    try {
      const body = await readBody(req);
      const updated = await changePassword(user.name, body.oldPassword, body.newPassword, sessionToken(req));
      return json(res, 200, { user: updated });
    } catch (err) {
      return json(res, err instanceof AuthError ? err.status : 400, { error: err.message });
    }
  }

  if (pathname === '/api/auth/name') {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    if (!user) throw new AuthError('需要登录', 401);
    try {
      const body = await readBody(req);
      const updated = await renameUser(user.name, body.display);
      return json(res, 200, { user: updated });
    } catch (err) {
      return json(res, err instanceof AuthError ? err.status : 400, { error: err.message });
    }
  }

  if (pathname === '/api/meta') {
    const p = await project();
    const cfg = await readProjectConfig(p.dir);
    return json(res, 200, {
      // 兼容旧前端：状态不再作为工单字段展示；工作流列是固定的。
      statuses: cfg.columns,
      workflow: WORKFLOW_COLUMNS,
      labels: cfg.labels,
      tags: cfg.tags ?? [],
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
        // 设置页画的就是这张图，只是没有 run：全 idle 的模板形状
        graph: graphOf(null, null),
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

  // 标签库：目录存项目配置，使用数实时从 beads 算；改名会级联到历史工单。
  if (pathname === '/api/tags') {
    const p = await project();
    if (req.method === 'GET') return json(res, 200, { tags: await listTags(p.dir) });
    if (req.method === 'POST') {
      const body = await readBody(req);
      try {
        return json(res, 201, { tags: await createTag(p.dir, body) });
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    return json(res, 405, { error: 'method not allowed' });
  }
  const tagMatch = pathname.match(/^\/api\/tags\/([^/]+)$/);
  if (tagMatch) {
    const p = await project();
    const name = decodeURIComponent(tagMatch[1]);
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      try {
        const out = await updateTag(p.dir, name, body, { actor: actorOf(user) });
        return json(res, 200, out);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    if (req.method === 'DELETE') {
      try {
        const out = await deleteTag(p.dir, name, { purge: searchParams.get('purge') === '1', actor: actorOf(user) });
        return json(res, 200, out);
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  // 用户偏好（列表列 / 列宽 / 排序 / 筛选预设）：只读写当前登录人自己的文件。
  // 没登录（WF_AUTH=off）时落到 ~/.hlwd/prefs/_local.json。
  if (pathname === '/api/prefs') {
    const p = await project();
    const dir = path.resolve(p.dir);
    if (req.method === 'GET') return json(res, 200, await prefsFor(user, dir));
    if (req.method === 'PUT') {
      const body = await readBody(req);
      try {
        return json(res, 200, await savePrefs(user, dir, body));
      } catch (err) {
        return json(res, 400, { error: err.message });
      }
    }
    return json(res, 405, { error: 'method not allowed' });
  }

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
      const runs = await latestRuns();
      issues = issues.map((i) => withWorkflow(i, runs.get(i.id) ?? null));
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
        actor: actorOf(user), // 记下是谁建的（bd 原生 created_by）
      });
      return json(res, 201, { issue: withWorkflow(issue, null) });
    }
    return json(res, 405, { error: 'method not allowed' });
  }

  const cardEvents = pathname.match(/^\/api\/issues\/([^/]+)\/events$/);
  if (cardEvents) {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    await project(); // 让 beads 指向当前项目
    return streamCard(req, res, decodeURIComponent(cardEvents[1]));
  }

  const turnsMatch = pathname.match(/^\/api\/issues\/([^/]+)\/turns(?:\/([^/]+)\/([^/]+))?(\/stream)?$/);
  if (turnsMatch) {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    const cardId = decodeURIComponent(turnsMatch[1]);
    const runId = turnsMatch[2] ? decodeURIComponent(turnsMatch[2]) : null;
    const phase = turnsMatch[3] ? decodeURIComponent(turnsMatch[3]) : null;
    const wantStream = Boolean(turnsMatch[4]);
    await project(); // 让 sessions 指向当前项目
    if (!runId) return json(res, 200, { turns: await listTurns(cardId) });
    if (wantStream) return streamTurn(req, res, cardId, runId, phase);
    const turn = await readTurn(cardId, runId, phase, {
      after: searchParams.get('after'),
      limit: searchParams.get('limit'),
    });
    return turn ? json(res, 200, turn) : json(res, 404, { error: '这一轮没有会话记录' });
  }

  // 运行目录里的单个文件（渲染后的提示词 / 门禁日志 / verdict）：只读，白名单在 runs.mjs 里。
  const runFile = pathname.match(/^\/api\/issues\/([^/]+)\/runs\/([^/]+)\/file$/);
  if (runFile) {
    if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
    const cardId = decodeURIComponent(runFile[1]);
    const runId = decodeURIComponent(runFile[2]);
    const run = await getRun(runId);
    if (!run || run.card?.id !== cardId) return json(res, 404, { error: '运行记录不存在' });
    const hit = await readRunFile(runId, searchParams.get('name'));
    return hit ? json(res, 200, hit) : json(res, 404, { error: '没有这个文件' });
  }

  const m = pathname.match(/^\/api\/issues\/([^/]+)(\/comments|\/runs|\/attachments|\/revise)?$/);
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
      // 评论作者 = 登录的人（bd comments 的 author 就来自 --actor）
      const comments = await beads.commentIssue(id, body.text, { actor: actorOf(user) });
      broadcastCard(id); // 正在看这张卡的人立刻看到，不用等下一次轮询
      return json(res, 200, { comments });
    }
    if (m[2] === '/revise') {
      // 人工纠偏：一条修正意见 + 退回待接。评论会进下一轮执行/审查的 {{HISTORY}}。
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      const body = await readBody(req);
      const text = String(body.text ?? '').trim();
      if (!text) return json(res, 400, { error: '修正意见不能为空' });
      const current = await beads.getIssue(id);
      const run = await latestRun(id);
      // 正在跑的这一轮，提示词在接单时就已经写死了：现在写的意见它看不到，别假装退回成功。
      if (workflowOf(current.issue, run).active) {
        return json(res, 409, { error: '这张单还在跑：等这一轮结束再退回（或先停自动流水线）' });
      }
      const p = await project();
      const cfg = await readProjectConfig(p.dir);
      const actor = actorOf(user);
      await beads.commentIssue(id, text, { actor });
      // 退回 = 重新打开 + 保留可派标签。engine 接单时会把整段评论带进提示词。
      const issue = await beads.updateIssue(id, { status: 'open', addLabels: [cfg.engine.readyLabel], actor });
      broadcastCard(id);
      return json(res, 200, {
        issue: withCard(issue, await latestRun(id)),
        comments: await beads.listComments(id),
      });
    }
    if (m[2] === '/runs') return json(res, 200, { runs: await listRuns(id) });
    if (req.method === 'GET') {
      // ?run=<runId> 看历史某一趟：图跟着那一趟，不是最新那趟
      const wanted = searchParams.get('run');
      let run = wanted ? await getRun(wanted) : null;
      if (run && run.card?.id !== id) run = null; // 别的卡的 run 不认
      if (!run) run = await latestRun(id);
      const payload = await beads.getIssue(id);
      return json(res, 200, { ...payload, issue: withCard(payload.issue, run) });
    }
    if (req.method === 'PATCH') {
      const body = await readBody(req);
      const actor = actorOf(user);
      // 状态变了要留一笔「谁改的」：bd 的 update 不记变更人，只能靠评论 + --actor
      let before = null;
      if (body.status) before = (await beads.getIssue(id)).issue;
      const issue = await beads.updateIssue(id, {
        status: body.status ?? undefined,
        priority: body.priority ?? undefined,
        assignee: body.assignee ?? undefined,
        title: body.title ?? undefined,
        description: body.description ?? undefined,
        addLabels: body.addLabels ?? [],
        removeLabels: body.removeLabels ?? [],
        actor,
      });
      if (before && before.status !== issue.status) {
        const p = await project();
        const cfg = await readProjectConfig(p.dir);
        const name = (s) => cfg.labels?.statuses?.[s] ?? s;
        await beads
          .commentIssue(id, `状态：${name(before.status)} → ${name(issue.status)}`, { actor })
          .catch(() => {}); // 留不下痕迹也不影响改单本身
      }
      if (body.status || body.priority !== undefined || body.addLabels || body.removeLabels) broadcastCard(id);
      return json(res, 200, { issue: withCard(issue, await latestRun(id)) });
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
    // 默认 inline（图片/文本直接在页面上看）；?download=1 存盘，存回原名。
    // 不能在本站直接打开的类型（比如 SVG）一律 attachment：能下载，但不会在本站执行。
    const asFile = searchParams.get('download') === '1' || !attachmentInlineSafe(hit.meta.name);
    res.writeHead(200, {
      'content-type': attachmentMime(hit.meta.name),
      'content-length': hit.data.length,
      'cache-control': 'private, max-age=3600',
      // 强制按声明的类型处理，别让浏览器把 .txt 嗅探成 HTML 去执行
      'x-content-type-options': 'nosniff',
      'content-disposition': `${asFile ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(hit.meta.name)}`,
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
  // 工单详情是独立页面（地址可分享）：/issue/<id> 也给同一个单页，id 由前端从 URL 读
  if (pathname.startsWith('/issue/')) return serveStatic(res, '/index.html');
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
    console.log(TOKEN ? '访问口令：已开启（WF_TOKEN）' : '访问口令：无');
  }
  console.log(
    AUTH
      ? '账号登录：已开启（第一次打开页面会引导注册；单机自用可 WF_AUTH=off 关掉）'
      : '账号登录：关（WF_AUTH=off），评论与建单按 bd 的 actor 记',
  );
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
