// web 黑盒：把「当前项目」的 beads 适配层暴露成 HTTP JSON 接口 + 单页看板。
// 不跑 AI、不写 git、不碰 .beads 里的数据文件；项目可以随时切换。
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureProject,
  readProjectConfig,
  readPrompts,
  readState,
  rememberProject,
  saveProjectConfig,
  savePrompts,
} from '../project.mjs';
import * as beads from './beads.mjs';
import { getRun, journalFor, listRuns, setProjectDir } from './runs.mjs';

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'app');
const PORT = Number(process.env.PORT ?? 3100);
const HOST = process.env.HOST ?? '127.0.0.1';

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

  if (pathname === '/api/meta') {
    const p = await project();
    const cfg = await readProjectConfig(p.dir);
    return json(res, 200, {
      statuses: cfg.columns,
      labels: cfg.labels,
      readyLabel: cfg.engine.readyLabel,
      workspace: p.dir,
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
      return json(res, 200, { config: await readProjectConfig(p.dir), prompts: await readPrompts(p.dir) });
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

  const m = pathname.match(/^\/api\/issues\/([^/]+)(\/comments|\/runs|\/history|\/journal)?$/);
  if (m) {
    const id = decodeURIComponent(m[1]);
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
    console.error(`→ 直接打开 http://${HOST}:${PORT}`);
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
  console.log(`看板：http://${HOST}:${PORT}`);
  try {
    const p = await project();
    console.log(`当前项目：${p.dir}`);
    if (p.created?.length) console.log(`已补齐：${p.created.join('、')}`);
  } catch (err) {
    console.error(`项目初始化失败：${err.message}`);
  }
});
