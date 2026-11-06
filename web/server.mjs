// web 黑盒：把 beads 适配层暴露成一个 HTTP JSON 接口 + 单页看板。
// 不跑 AI、不写 git、不碰 .beads 里的数据文件。
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as beads from './beads.mjs';
import { getRun, journalFor, listRuns } from './runs.mjs';

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
    if (size > 1024 * 1024) throw new Error('请求体超过 1MB');
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

async function route(req, res, url) {
  const { pathname, searchParams } = url;

  if (pathname === '/api/meta') {
    return json(res, 200, {
      statuses: beads.STATUSES,
      readyLabel: beads.READY_LABEL,
      workspace: process.cwd(),
    });
  }

  if (pathname === '/api/issues') {
    if (req.method === 'GET') {
      const issues = await beads.listIssues({
        status: searchParams.get('status') ?? undefined,
        ready: searchParams.get('ready') === '1',
        label: searchParams.get('label') ?? undefined,
        assignee: searchParams.get('assignee') ?? undefined,
        q: searchParams.get('q') ?? undefined,
      });
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

server.listen(PORT, HOST, () => {
  console.log(`看板：http://${HOST}:${PORT}   （Ctrl+C 停止）`);
  console.log(`工作区：${process.cwd()}`);
});
