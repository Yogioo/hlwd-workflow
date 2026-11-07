// 用户偏好：列表显示哪些列、列宽、排序、筛选预设。
// 属于「这个人 + 这个项目」——存在 ~/.hlwd/prefs/<用户名>.json，不写进项目目录，
// 也不进 beads。换项目是另一套，换人是另一份文件；内容全是可重算的视图配置。
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.join(os.homedir(), '.hlwd', 'prefs');
const VERSION = 1;

/** 列表认得的列。id 同时是前端排序键；加列要同时改 app.js 的 COLUMNS。 */
export const COLUMN_IDS = [
  'workflow',
  'priority',
  'type',
  'title',
  'assignee',
  'createdBy',
  'created',
  'updated',
  'labels',
  'comments',
  'ready',
  'id',
];
const DEFAULT_W = {
  workflow: 100,
  priority: 62,
  type: 64,
  title: 300,
  assignee: 110,
  createdBy: 110,
  created: 96,
  updated: 96,
  labels: 160,
  comments: 48,
  ready: 64,
  id: 78,
};
// 和改版前的九列一致：新加的「创建时间 / 标签 / 可派」默认收起来
const VISIBLE_DEFAULT = new Set(['workflow', 'priority', 'type', 'title', 'assignee', 'createdBy', 'updated', 'comments', 'id']);
const MIN_W = 56;
const MAX_W = 720;
const MAX_PRESETS = 30;
const PERIODS = new Set(['', 'today', '7d', '30d', 'custom']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v, { max = 40, len = 120 } = {}) =>
  Array.isArray(v)
    ? [...new Set(v.filter((s) => typeof s === 'string').map((s) => s.trim().slice(0, len)).filter(Boolean))].slice(0, max)
    : [];

export function emptyFilter() {
  return {
    q: '',
    ready: false,
    workflow: [],
    priority: [],
    type: [],
    assignee: [],
    createdBy: [],
    labels: [],
    updated: { period: '', from: '', to: '' },
  };
}

/** 不认识的值一律丢掉：偏好文件是用户可手改的，不能让它把页面带崩。 */
function cleanFilter(input = {}) {
  const f = input && typeof input === 'object' ? input : {};
  const u = f.updated && typeof f.updated === 'object' ? f.updated : {};
  const LEGACY = { open: 'queued', in_progress: 'active', review: 'review', closed: 'done' };
  const workflow = f.workflow !== undefined ? list(f.workflow) : list(f.status).map((s) => LEGACY[s] ?? s);
  return {
    q: str(f.q, 120),
    ready: f.ready === true,
    workflow,
    priority: Array.isArray(f.priority)
      ? [...new Set(f.priority.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 4))].sort((a, b) => a - b)
      : [],
    type: list(f.type, { max: 20, len: 40 }),
    assignee: list(f.assignee, { max: 60, len: 60 }),
    createdBy: list(f.createdBy, { max: 60, len: 60 }),
    labels: list(f.labels),
    updated: {
      period: PERIODS.has(u.period) ? u.period : '',
      from: DATE.test(u.from ?? '') ? u.from : '',
      to: DATE.test(u.to ?? '') ? u.to : '',
    },
  };
}

function cleanColumns(input) {
  const seen = new Set();
  const out = [];
  for (const c of Array.isArray(input) ? input : []) {
    // 旧版把这一列叫 status；迁移时保留原来的宽度与顺序。
    const id = c?.id === 'status' ? 'workflow' : c?.id;
    if (!COLUMN_IDS.includes(id) || seen.has(id)) continue;
    seen.add(id);
    const w = Number(c.w);
    out.push({
      id,
      w: Number.isFinite(w) ? Math.min(MAX_W, Math.max(MIN_W, Math.round(w))) : DEFAULT_W[id],
      hidden: c.hidden === true,
    });
  }
  // 工具加了新列：老配置里没有的补在最后，默认收起，不突然改变别人的表
  for (const id of COLUMN_IDS) {
    if (!seen.has(id)) out.push({ id, w: DEFAULT_W[id], hidden: !VISIBLE_DEFAULT.has(id) });
  }
  return out;
}

const cleanSort = (s) => {
  const key = s?.key === 'status' ? 'workflow' : s?.key;
  return { key: COLUMN_IDS.includes(key) ? key : 'updated', dir: s?.dir === 'asc' ? 'asc' : 'desc' };
};

function cleanPresets(input) {
  const out = [];
  for (const p of Array.isArray(input) ? input : []) {
    if (out.length >= MAX_PRESETS) break;
    const name = str(p?.name, 30);
    if (!name) continue;
    out.push({ id: str(p.id, 40) || `p${out.length + 1}`, name, filter: cleanFilter(p.filter) });
  }
  // id 撞了就补个后缀，别让「选中哪一条」变得含糊
  const ids = new Set();
  return out.map((p) => {
    let id = p.id;
    let n = 2;
    while (ids.has(id)) id = `${p.id}-${n++}`;
    ids.add(id);
    return { ...p, id };
  });
}

export function defaultList() {
  return { columns: cleanColumns(null), sort: cleanSort(), presets: [] };
}

function cleanList(input, base = defaultList()) {
  const src = input && typeof input === 'object' ? input : {};
  return {
    columns: src.columns === undefined ? base.columns : cleanColumns(src.columns),
    sort: src.sort === undefined ? base.sort : cleanSort(src.sort),
    presets: src.presets === undefined ? base.presets ?? [] : cleanPresets(src.presets),
  };
}

const clone = (v) => JSON.parse(JSON.stringify(v));

/** 一个人一个文件；没开登录（WF_AUTH=off）就落到 _local.json。
    用户名被改写（带 / 或太长）时补一个短哈希：a/b 和 a_b 不能共用一份偏好。 */
function fileFor(user) {
  const raw = String(user?.name ?? '');
  if (!raw) return path.join(ROOT, '_local.json');
  const safe = raw.replace(/[^\w.-]+/g, '_').slice(0, 48);
  const key = safe === raw ? safe : `${safe}-${crypto.createHash('sha1').update(raw).digest('hex').slice(0, 8)}`;
  return path.join(ROOT, `${key}.json`);
}

function normalize(raw) {
  const defaults = cleanList(raw?.defaults, defaultList());
  const projects = {};
  for (const [dir, v] of Object.entries(raw?.projects ?? {})) {
    if (typeof dir !== 'string' || !dir) continue;
    projects[dir] = { list: cleanList(v?.list, defaults) };
  }
  return { version: VERSION, defaults, projects };
}

export async function readPrefs(user) {
  try {
    return normalize(JSON.parse(await fs.readFile(fileFor(user), 'utf8')));
  } catch {
    return { version: VERSION, defaults: defaultList(), projects: {} };
  }
}

/** 这个项目看到的视图配置：没单独配过就继承「最后一次改过的布局」。
    只继承列与排序——预设是给这个项目存的筛选，不带进别的项目。 */
export async function prefsFor(user, dir) {
  const all = await readPrefs(user);
  const entry = all.projects[dir]?.list;
  const list = entry
    ? clone(entry)
    : { columns: clone(all.defaults.columns), sort: clone(all.defaults.sort), presets: [] };
  return { version: all.version, list };
}

/** 只写当前项目那一段，顺手把 defaults 滚成它：下次打开新项目就是这套。 */
export async function savePrefs(user, dir, patch = {}) {
  const all = await readPrefs(user);
  if (patch && typeof patch === 'object' && patch.list !== undefined) {
    const base = all.projects[dir]?.list ?? all.defaults;
    const next = cleanList(patch.list, base);
    all.projects[dir] = { list: next };
    // defaults 只滚列与排序：预览是「这个项目的」，换项目不该带过去
    all.defaults = { columns: clone(next.columns), sort: clone(next.sort), presets: [] };
  }
  all.version = VERSION;
  all.updatedAt = new Date().toISOString();
  await fs.mkdir(ROOT, { recursive: true });
  await fs.writeFile(fileFor(user), `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  return { version: all.version, list: clone(all.projects[dir]?.list ?? { ...all.defaults, presets: [] }) };
}
