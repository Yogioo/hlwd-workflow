// WorkSource 适配层：全项目唯一调用 bd 的文件。
// 契约见 AGENTS.md §3。页面和 engine 都不许绕开这里。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 看板列 = bd 状态。review 是 bd config status.custom 里的自定义状态。 */
export const STATUSES = ['open', 'in_progress', 'review', 'closed'];
export const READY_LABEL = 'ready-for-agent';

export class BeadsError extends Error {
  constructor(message, { args, stderr } = {}) {
    super(message);
    this.name = 'BeadsError';
    this.args = args;
    this.stderr = stderr;
  }
}

const WIN = process.platform === 'win32';

// 当前项目目录：所有 bd 命令都在它下面跑。多项目靠 setWorkdir 切换。
let workdir = process.cwd();

export function setWorkdir(dir) {
  workdir = path.resolve(dir);
}

export function getWorkdir() {
  return workdir;
}

// bd 在 Windows 上只是 .cmd 壳，spawn 不了；优先用 npm 包里的原生 exe。
function bdBin() {
  if (process.env.BD_BIN) return process.env.BD_BIN;
  if (!WIN) return 'bd';
  const candidates = [
    path.join(process.env.APPDATA ?? '', 'npm/node_modules/@beads/bd/bin/bd.exe'),
    path.join(path.dirname(process.execPath), 'node_modules/@beads/bd/bin/bd.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? 'bd.exe';
}

// 参数走数组、正文走 stdin，不经过 shell，因此中文/引号/管道符都安全。
function runOnce(args, { input, cwd = workdir } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bdBin(), args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('error', (e) => reject(new BeadsError(e.message, { args })));
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new BeadsError(err.trim() || `bd exited ${code}`, { args, stderr: err }));
    });
    child.stdin.end(input ?? '');
  });
}

/**
 * bd 刚 init 完的头一两秒数据库可能还没就绪（issue_prefix is missing）。
 * 这类错误重试一下就好：它意味着“什么都没写”，重试不会重复建单。
 */
const NOT_READY = /not initialized|issue_prefix is missing|no beads configuration/i;

async function run(args, opts) {
  let last;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await runOnce(args, opts);
    } catch (err) {
      last = err;
      if (!NOT_READY.test(String(err?.message ?? ''))) throw err;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw last;
}

function parseJson(text, args) {
  const start = text.search(/[[{]/);
  if (start < 0) throw new BeadsError(`bd 输出不是 JSON: ${text.slice(0, 200)}`, { args });
  try {
    return JSON.parse(text.slice(start));
  } catch {
    throw new BeadsError(`bd 输出不是 JSON: ${text.slice(start, start + 200)}`, { args });
  }
}

async function bdJson(args, opts) {
  return parseJson(await run(args, opts), args);
}

/** 归一成契约里的最小字段集；只在这里定义字段名。 */
export function normalize(raw) {
  return {
    id: raw.id,
    title: raw.title ?? '',
    body: raw.description ?? '',
    status: raw.status ?? 'open',
    labels: raw.labels ?? [],
    assignee: raw.assignee ?? raw.owner ?? '',
    owner: raw.owner ?? '',
    type: raw.issue_type ?? '',
    priority: raw.priority ?? 2,
    commentCount: raw.comment_count ?? 0,
    created: raw.created_at ?? '',
    updated: raw.updated_at ?? '',
    parent: raw.parent ?? null,
  };
}

export async function listIssues({ status, ready, label, assignee, q, limit = 300, all = true } = {}) {
  const args = ['list', '--json', '--flat', '-n', String(limit)];
  if (all) args.push('--all');
  if (status) args.push('--status', status);
  if (ready) args.push('--ready');
  if (label) args.push('--label', label);
  if (assignee) args.push('--assignee', assignee);
  if (q) args.push('--title-contains', q);
  const rows = await bdJson(args);
  return (Array.isArray(rows) ? rows : []).map(normalize);
}

export async function getIssue(id) {
  const rows = await bdJson(['show', id, '--json']);
  const raw = Array.isArray(rows) ? rows[0] : rows;
  if (!raw) throw new BeadsError(`工单不存在: ${id}`);
  return {
    issue: normalize(raw),
    comments: await listComments(id),
  };
}

export async function listComments(id) {
  const rows = await bdJson(['comments', id, '--json']);
  return (Array.isArray(rows) ? rows : []).map((c) => ({
    author: c.author ?? '',
    text: c.text ?? '',
    created: c.created_at ?? '',
  }));
}

export async function createIssue({ title, description = '', type, priority, labels = [], assignee } = {}) {
  if (!title || !title.trim()) throw new BeadsError('title 不能为空');
  const args = ['create', title, '--stdin', '--json'];
  if (type) args.push('-t', type);
  if (priority !== undefined && priority !== '') args.push('-p', String(priority));
  if (labels.length) args.push('-l', labels.join(','));
  if (assignee) args.push('-a', assignee);
  const raw = await bdJson(args, { input: description });
  return normalize(Array.isArray(raw) ? raw[0] : raw);
}

export async function updateIssue(id, patch = {}) {
  const { status, priority, assignee, title, description, addLabels = [], removeLabels = [] } = patch;
  const args = ['update', id];
  let input;
  if (status) args.push('--status', status);
  if (priority !== undefined && priority !== '') args.push('--priority', String(priority));
  if (assignee !== undefined) args.push('--assignee', assignee);
  if (title) args.push('--title', title);
  if (description !== undefined) {
    args.push('--stdin');
    input = description;
  }
  for (const l of addLabels) args.push('--add-label', l);
  for (const l of removeLabels) args.push('--remove-label', l);
  if (args.length > 2) await run(args, { input });
  return (await getIssue(id)).issue;
}

export async function commentIssue(id, text) {
  if (!text || !text.trim()) throw new BeadsError('评论不能为空');
  await run(['comment', id, '--stdin'], { input: text });
  return listComments(id);
}

/** 状态变更时间轴：只保留 status 变了的节点，老 → 新。bd history 自带，零额外存储。 */
export async function listStatusHistory(id, limit = 50) {
  const rows = await bdJson(['history', id, '--json', '--limit', String(limit)]);
  const entries = (Array.isArray(rows) ? rows : [])
    .map((r) => ({
      at: r.CommitDate ?? '',
      status: r.Issue?.status ?? '',
      priority: r.Issue?.priority ?? '',
      assignee: r.Issue?.assignee ?? '',
    }))
    .reverse();
  const changes = [];
  for (const entry of entries) {
    const prev = changes[changes.length - 1];
    if (!prev || prev.status !== entry.status) changes.push(entry);
  }
  return changes;
}
