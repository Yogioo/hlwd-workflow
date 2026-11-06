// 单页看板：只做「看 + 建 + 改状态 + 评论」，全部走 /api/*。
// 状态名、优先级名、AI 配置都来自 config.json（设置弹窗可改）。
import { esc, md } from './markdown.js';

const AUTO_REFRESH_MS = 5000;
const VIEW_KEY = 'hlwd.view';
const SORT_DESC = new Set(['updated', 'comments']);

/** 视图是浏览器的偏好，不写进项目：同一个项目换台电脑打开，默认还是看板。 */
function readView() {
  try {
    const fromUrl = new URLSearchParams(location.search).get('view');
    if (fromUrl === 'board' || fromUrl === 'list') {
      try {
        localStorage.setItem(VIEW_KEY, fromUrl);
      } catch {
        // 隐私模式里存不了就算了
      }
      return fromUrl;
    }
  } catch {
    // 没有 URL API 就当没传
  }
  try {
    const saved = localStorage.getItem(VIEW_KEY);
    if (saved === 'board' || saved === 'list') return saved;
  } catch {
    // 存不了也照常用默认值
  }
  return 'board';
}

const $ = (s) => document.querySelector(s);
const state = {
  issues: [],
  statuses: ['open', 'in_progress', 'review', 'closed'],
  labels: { statuses: {}, priorities: {} },
  readyLabel: 'ready-for-agent',
  current: null,
  trace: null,
  gate: { path: '', exists: false },
  project: { dir: '', recent: [] },
  filter: emptyFilter(),
  // 视图配置（列 / 列宽 / 排序 / 预设）存在 ~/.hlwd/prefs/<用户>.json，按项目各一套
  prefs: { columns: [], presets: [] },
  view: readView(),
  sort: { key: 'updated', dir: 'desc' },
  dispatching: false,
  watch: { running: false, stopping: false },
  lastWatchError: null,
  attachments: [],
  comments: [],
  newComments: new Set(), // 页面开着期间新进来的评论（一直标记，刷新才清）
  auth: { auth: false, user: null, firstRun: false },
  authed: false,
  timer: null,
};

const statusLabel = (s) => state.labels.statuses[s] ?? s;
const prioLabel = (p) => state.labels.priorities[p] ?? `P${p}`;
// 全链路里的原因：一行放不下就折起来，别把面板拉成长条
const reasonCell = (text) => {
  const s = String(text ?? '');
  return s.length > 120
    ? `${esc(s.slice(0, 120))}…<details class="trace-checks"><summary>完整原因</summary><div>${esc(s)}</div></details>`
    : esc(s);
};

// ready-for-agent 对人没意义，直接说「可派给 AI」
const chip = (label) =>
  label === state.readyLabel
    ? '<span class="chip chip-ready">可派给 AI</span>'
    : `<span class="chip">${esc(label)}</span>`;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.needsLogin) {
    // 会话过期 / 在另一个窗口退了：直接回登录页，别让页面卡在一堆报错里
    showAuth();
    throw new Error(data.error ?? '需要登录');
  }
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function hint(text, isError = false) {
  const el = $('#hint');
  const changed = el.textContent !== text;
  el.textContent = text;
  el.classList.toggle('err', isError);
  // 自动刷新每 5s 会调一次，只有内容真的变了才闪，否则一直闪像坏了
  if (changed) {
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
}

/** 顶栏的「看板 / 列表」跟当前视图对齐；body 上的 data-view 给样式用。 */
function applyViewChrome() {
  document.body.dataset.view = state.view;
  const board = $('#viewBoard');
  const list = $('#viewList');
  if (!board || !list) return;
  board.classList.toggle('active', state.view === 'board');
  list.classList.toggle('active', state.view === 'list');
  board.setAttribute('aria-pressed', String(state.view === 'board'));
  list.setAttribute('aria-pressed', String(state.view === 'list'));
  // 「列」只对列表有意义
  const colsBtn = $('#colsBtn');
  if (colsBtn) colsBtn.hidden = state.view !== 'list';
}

/** 地址栏跟着视图走：/?view=list 可以直接发给别人；工单页不动它的地址。 */
function syncViewUrl(view) {
  if (document.body.dataset.mode === 'issue' || issueIdFromPath()) return;
  try {
    const url = new URL(location.href);
    if (view === 'list') url.searchParams.set('view', 'list');
    else url.searchParams.delete('view');
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // 改不了地址栏就只记在内存里
  }
}

function setView(view) {
  if (view !== 'board' && view !== 'list') return;
  const changed = state.view !== view;
  state.view = view;
  applyViewChrome();
  try {
    localStorage.setItem(VIEW_KEY, view);
  } catch {
    // 存不了也无所谓，这次会话里切换照样生效
  }
  syncViewUrl(view);
  render();
  if (!changed) return;
  window.scrollTo(0, 0);
  hint(
    view === 'list'
      ? '列表视图：点表头排序，按住表头拖换列序，拖右边界改列宽，点一行打开工单'
      : '看板视图：把卡片拖到别的列就能改状态',
  );
}

function applyConfig(cfg) {
  if (Array.isArray(cfg.statuses) && cfg.statuses.length) state.statuses = cfg.statuses;
  else if (Array.isArray(cfg.columns) && cfg.columns.length) state.statuses = cfg.columns;
  if (cfg.labels) {
    state.labels = {
      statuses: { ...state.labels.statuses, ...(cfg.labels.statuses ?? {}) },
      priorities: { ...state.labels.priorities, ...(cfg.labels.priorities ?? {}) },
    };
  }
  if (cfg.readyLabel) state.readyLabel = cfg.readyLabel;
  else if (cfg.engine?.readyLabel) state.readyLabel = cfg.engine.readyLabel;
  fillPrioritySelect($('#createPriority'), 2);
  fillPrioritySelect($('#panelPriority'), state.current?.priority ?? 2);
}

/** /api/project 的返回：{dir, config, prompts, recent, created} */
function applyProject(payload) {
  if (payload.dir) {
    state.project = { dir: payload.dir, recent: payload.recent ?? [] };
    const el = $('#projectPath');
    if (el) {
      el.textContent = payload.dir;
      el.title = payload.dir;
    }
  }
  const cfg = payload.config ?? payload;
  applyConfig({ statuses: cfg.columns, labels: cfg.labels, readyLabel: cfg.engine?.readyLabel ?? cfg.readyLabel });
  return payload;
}

function fillPrioritySelect(select, selected) {
  if (!select) return;
  select.innerHTML = [0, 1, 2, 3, 4]
    .map((p) => `<option value="${p}"${Number(selected) === p ? ' selected' : ''}>${esc(prioLabel(p))}（P${p}）</option>`)
    .join('');
}

// 空列不是「—」，是告诉你这一列现在该放什么
const laneEmpty = (status) => {
  if (hasFilter()) return '没有符合当前筛选的单。';
  return (
    {
      open: '没有待接的单。新建一张，或把别的卡拖过来。',
      in_progress: '没有在跑的单。',
      review: '没有等验收的单。',
      closed: '还没有完成的单。',
    }[status] ?? '这里空着。'
  );
};
const listEmpty = () =>
  hasFilter() ? '没有符合当前筛选的单。' : '还没有工单。点右上角「新建工单」开始。';

/** 一张卡：标题是主体，id 和类型退到脚注，别抢视线。 */
function card(issue) {
  const labels = issue.labels.map(chip).join('');
  return `<article class="card" data-id="${esc(issue.id)}" tabindex="0" draggable="true" title="拖到别的列就能改状态">
    <div class="card-top">
      <div class="card-title">${esc(issue.title)}</div>
      <span class="card-prio mono" data-prio="${esc(issue.priority)}">${esc(prioLabel(issue.priority))}</span>
    </div>
    ${labels ? `<div class="chips">${labels}</div>` : ''}
    <div class="card-foot">
      <span class="mono">${esc(issue.type)}</span>
      ${issue.commentCount ? `<span class="mono">${esc(issue.commentCount)} 条评论</span>` : ''}
      <span class="card-id mono">${esc(issue.id)}</span>
    </div>
  </article>`;
}

const dash = () => '<span class="dash">—</span>';
function orDash(text) {
  return text ? esc(text) : dash();
}

/** 列表能摊开的列。id 同时是排序键；w 只是第一次打开时的默认宽度（之后听用户的）。 */
const COLUMNS = [
  {
    id: 'status',
    label: '状态',
    w: 92,
    cls: 'c-status',
    sort: (i) => {
      const at = state.statuses.indexOf(i.status);
      return at < 0 ? state.statuses.length : at;
    },
    cell: (i) => `<span class="row-dot" aria-hidden="true"></span>${esc(statusLabel(i.status))}`,
  },
  {
    id: 'priority',
    label: '优先级',
    w: 62,
    cls: 'c-prio',
    sort: (i) => Number(i.priority) || 0,
    attrs: (i) => `data-prio="${esc(i.priority)}"`,
    cell: (i) => esc(prioLabel(i.priority)),
  },
  { id: 'type', label: '类型', w: 64, cls: 'c-type', sort: (i) => i.type || '', cell: (i) => (i.type ? `<span class="mono">${esc(i.type)}</span>` : dash()) },
  { id: 'title', label: '工单', w: 300, cls: 'c-title', sort: (i) => i.title || '', cell: titleCell },
  {
    id: 'assignee',
    label: '负责人',
    w: 110,
    cls: 'c-assignee',
    sort: (i) => i.assignee || '',
    cell: (i) => `<span title="${esc(i.assignee)}">${orDash(i.assignee)}</span>`,
  },
  {
    id: 'createdBy',
    label: '创建人',
    w: 110,
    cls: 'c-createdby',
    sort: (i) => i.createdBy || '',
    cell: (i) => `<span title="${esc(i.createdBy)}">${orDash(i.createdBy)}</span>`,
  },
  { id: 'created', label: '创建时间', w: 96, cls: 'c-created', sort: (i) => i.created || '', cell: (i) => timeCell(i.created) },
  { id: 'updated', label: '最近更新', w: 96, cls: 'c-updated', sort: (i) => i.updated || '', cell: (i) => timeCell(i.updated) },
  { id: 'labels', label: '标签', w: 160, cls: 'c-labels', sort: (i) => i.labels.join(' '), cell: labelsCell },
  {
    id: 'comments',
    label: '评论',
    w: 48,
    cls: 'c-comments',
    align: 'right',
    sort: (i) => Number(i.commentCount) || 0,
    cell: (i) => (i.commentCount ? `<span class="mono">${esc(i.commentCount)}</span>` : dash()),
  },
  {
    id: 'ready',
    label: '可派',
    w: 64,
    cls: 'c-ready',
    sort: (i) => (i.labels.includes(state.readyLabel) ? 0 : 1),
    cell: (i) => (i.labels.includes(state.readyLabel) ? '<span class="chip chip-ready">可派</span>' : dash()),
  },
  { id: 'id', label: '编号', w: 78, cls: 'c-id', align: 'right', sort: (i) => i.id || '', cell: (i) => `<span class="mono">${esc(i.id)}</span>` },
];

const COLUMN_BY_ID = Object.fromEntries(COLUMNS.map((c) => [c.id, c]));
/** 和服务端 web/prefs.mjs 的 VISIBLE_DEFAULT 一致：默认还是原来那九列。 */
const VISIBLE_DEFAULT = new Set(['status', 'priority', 'type', 'title', 'assignee', 'createdBy', 'updated', 'comments', 'id']);

function defaultColumns() {
  return COLUMNS.map((c) => ({ id: c.id, w: c.w, hidden: !VISIBLE_DEFAULT.has(c.id) }));
}

/** 用户配置里可能有本版本不认得的列（降级访问）：认不出的直接跳过，别渲染空气。 */
function columnPrefs() {
  const cols = Array.isArray(state.prefs.columns) && state.prefs.columns.length ? state.prefs.columns : defaultColumns();
  return cols.filter((c) => COLUMN_BY_ID[c.id]);
}

function visibleColumns() {
  return columnPrefs()
    .filter((c) => !c.hidden)
    .map((c) => ({ ...COLUMN_BY_ID[c.id], w: Number(c.w) || COLUMN_BY_ID[c.id].w }));
}

function titleCell(issue) {
  const labels = issue.labels.map(chip).join('');
  const summary = snippet(issue.body);
  const mobile = [
    `<span>${issue.type ? esc(issue.type) : dash()}</span>`,
    `<span>负责人 ${orDash(issue.assignee)}</span>`,
    `<span>创建人 ${orDash(issue.createdBy)}</span>`,
    `<span>更新 ${esc(fmtAgo(issue.updated))}</span>`,
    `<span>${issue.commentCount ? `${esc(issue.commentCount)} 条评论` : '无评论'}</span>`,
    `<span class="mono">${esc(issue.id)}</span>`,
  ].join('');
  const sub = labels || summary
    ? `<div class="row-sub">${labels ? `<span class="chips">${labels}</span>` : ''}${summary ? `<span class="row-snippet">${esc(summary)}</span>` : ''}</div>`
    : '';
  return `<a class="row-link" href="/issue/${encodeURIComponent(issue.id)}">${esc(issue.title)}</a>${sub}<div class="row-mobile-meta">${mobile}</div>`;
}

function labelsCell(issue) {
  if (!issue.labels.length) return dash();
  const shown = issue.labels.slice(0, 3).map(chip).join('');
  const more = issue.labels.length > 3 ? `<span class="chip">+${issue.labels.length - 3}</span>` : '';
  return `<span class="chips">${shown}${more}</span>`;
}

function timeCell(at) {
  return `<time datetime="${esc(at)}" title="${esc(fmtTime(at))}">${esc(fmtAgo(at))}</time>`;
}

/** 点同一个表头翻方向；相同值按最近更新、编号兜底，刷新时行不会乱跳。 */
function sortIssues(issues) {
  const { key, dir } = state.sort;
  const value = COLUMN_BY_ID[key]?.sort ?? COLUMN_BY_ID.updated.sort;
  const sign = dir === 'asc' ? 1 : -1;
  return [...issues].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    const cmp =
      typeof va === 'number' && typeof vb === 'number'
        ? va - vb
        : String(va).localeCompare(String(vb), 'zh-CN', { numeric: true, sensitivity: 'base' });
    if (cmp) return cmp * sign;
    return (
      String(b.updated ?? '').localeCompare(String(a.updated ?? '')) ||
      String(a.id ?? '').localeCompare(String(b.id ?? ''))
    );
  });
}

function toggleSort(key) {
  if (!COLUMN_BY_ID[key]) return;
  if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  else state.sort = { key, dir: SORT_DESC.has(key) ? 'desc' : 'asc' };
  render();
  savePrefsSoon();
}

const sortMark = (key) => (state.sort.key === key ? (state.sort.dir === 'asc' ? '↑' : '↓') : '');
const ariaSort = (key) =>
  state.sort.key === key ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';

function listHead(cols = visibleColumns()) {
  const cells = cols
    .map(
      ({ id, label, cls, align }) => `<th class="${cls}${align === 'right' ? ' is-right' : ''}" scope="col" data-col="${id}" aria-sort="${ariaSort(id)}" title="拖动换列序，点一下排序">
        <button type="button" class="sort-btn" data-sort="${id}" title="按${label}排序">${label}<span class="sort-mark" aria-hidden="true">${sortMark(id)}</span></button>
        <span class="col-resizer" data-resize="${id}" title="拖动改列宽，双击恢复默认"></span>
      </th>`,
    )
    .join('');
  // 末尾留一条「填充列」：吃掉窗口剩余宽度，别的列才能保持用户拖出来的 px
  return `<thead><tr>${cells}<th class="c-fill" aria-hidden="true"></th></tr></thead>`;
}

/** 列表里的摘要：把 markdown 压成一行，不显示代码块和图片地址。 */
function snippet(body, max = 110) {
  const text = String(body ?? '')
    .slice(0, 1200) // 只要开头这一行，别为 300 张单把整篇描述都正则一遍
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 列表里的「最近更新」用相对时间，扫一眼就知道哪些是刚动过的。 */
function fmtAgo(at) {
  const d = new Date(at ?? '');
  if (Number.isNaN(d.getTime())) return '—';
  const min = Math.floor((Date.now() - d.getTime()) / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days === 1) return '昨天';
  if (days < 7) return `${days} 天前`;
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

/** 列表的一行：只渲染当前显示的列，顺序由用户拖出来的 `state.prefs.columns` 决定。 */
function listRow(issue) {
  const cells = visibleColumns()
    .map(({ id, cls, align, cell, attrs }) => `<td class="${cls}${align === 'right' ? ' is-right' : ''}"${attrs ? ` ${attrs(issue)}` : ''}>${cell(issue)}</td>`)
    .join('');
  return `<tr class="list-row" data-id="${esc(issue.id)}" data-status="${esc(issue.status)}">${cells}<td class="c-fill"></td></tr>`;
}

function listTable(issues) {
  const cols = visibleColumns();
  if (!cols.length) {
    return '<div class="list-view"><div class="list-empty">所有列都收起来了：点「列」把想看的打开。</div></div>';
  }
  // 列宽是 px，窗口更宽时表格撑满、更窄时横向滚（不把每列挤成一条缝）
  const total = cols.reduce((sum, c) => sum + c.w, 0);
  const rows = issues.length
    ? issues.map(listRow).join('')
    : `<tr class="list-empty-row"><td colspan="${cols.length + 1}">${esc(listEmpty())}</td></tr>`;
  // 不要套滚动容器：表头是 sticky，一旦有 overflow 祖先就会相对那个容器算 top，整行被推下去
  return `<div class="list-view"><table class="list-table" style="min-width:${total}px">
    <colgroup>${cols.map((c) => `<col style="width:${c.w}px">`).join('')}<col></colgroup>
    ${listHead(cols)}<tbody>${rows}</tbody></table></div>`;
}

function renderList(issues) {
  const board = $('#board');
  board.innerHTML = listTable(sortIssues(issues));
  delete board.dataset.loading;
}

// —— 筛选：字段条件按 AND 叠加，搜索框只是它的快捷入口；看板和列表共用一套条件 ——

function emptyFilter() {
  return {
    q: '',
    ready: false,
    status: [],
    priority: [],
    type: [],
    assignee: [],
    createdBy: [],
    labels: [],
    updated: { period: '', from: '', to: '' },
  };
}

const normFilter = (f) =>
  JSON.stringify({
    q: f.q ?? '',
    ready: Boolean(f.ready),
    status: f.status ?? [],
    priority: (f.priority ?? []).map(Number).sort((a, b) => a - b),
    type: f.type ?? [],
    assignee: f.assignee ?? [],
    createdBy: f.createdBy ?? [],
    labels: f.labels ?? [],
    updated: { period: f.updated?.period ?? '', from: f.updated?.from ?? '', to: f.updated?.to ?? '' },
  });

function normalizeFilter(input = {}) {
  const f = input && typeof input === 'object' ? input : {};
  const arr = (v) => (Array.isArray(v) ? [...v] : []);
  return {
    q: String(f.q ?? ''),
    ready: Boolean(f.ready),
    status: arr(f.status),
    priority: arr(f.priority).map(Number),
    type: arr(f.type),
    assignee: arr(f.assignee),
    createdBy: arr(f.createdBy),
    labels: arr(f.labels),
    updated: { period: f.updated?.period ?? '', from: f.updated?.from ?? '', to: f.updated?.to ?? '' },
  };
}

function hasFilter(f = state.filter) {
  return Boolean(
    (f.q ?? '') ||
      f.ready ||
      f.status?.length ||
      f.priority?.length ||
      f.type?.length ||
      f.assignee?.length ||
      f.createdBy?.length ||
      f.labels?.length ||
      f.updated?.period,
  );
}

/** 「最近更新」的时间窗；null 表示不限。包成函数是为了跟着时钟走，不用每次重算状态。 */
function updatedWindow(u) {
  const period = u?.period;
  if (!period) return null;
  const now = new Date();
  if (period === 'custom') {
    const from = u.from ? new Date(`${u.from}T00:00:00`).getTime() : -Infinity;
    const to = u.to ? new Date(`${u.to}T23:59:59.999`).getTime() : Infinity;
    if (!Number.isFinite(from) && !Number.isFinite(to)) return null;
    return { from: Number.isFinite(from) ? from : -Infinity, to: Number.isFinite(to) ? to : Infinity };
  }
  if (period === 'today') return { from: new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime(), to: Infinity };
  const days = period === '7d' ? 7 : 30;
  return { from: now.getTime() - days * 86400000, to: Infinity };
}

function matchesFilter(issue, f = state.filter) {
  if (f.ready && !issue.labels.includes(state.readyLabel)) return false;
  if (f.status.length && !f.status.includes(issue.status)) return false;
  if (f.priority.length && !f.priority.includes(Number(issue.priority))) return false;
  if (f.type.length && !f.type.includes(issue.type || '')) return false;
  if (f.assignee.length && !f.assignee.includes(issue.assignee || '')) return false;
  if (f.createdBy.length && !f.createdBy.includes(issue.createdBy || '')) return false;
  if (f.labels.length && !f.labels.every((l) => issue.labels.includes(l))) return false;
  const win = updatedWindow(f.updated);
  if (win) {
    const at = Date.parse(issue.updated);
    if (!(at >= win.from && at <= win.to)) return false;
  }
  return true;
}

// —— 预设：内置三条（全部 / 可派 / 我负责）+ 自己存的；自建的跟着这个项目走 ——

const meName = () => state.auth?.user?.display || state.auth?.user?.name || '';

function builtinPresets() {
  const out = [
    { id: 'builtin:all', name: '全部', filter: emptyFilter() },
    { id: 'builtin:ready', name: '可派', filter: { ...emptyFilter(), ready: true } },
  ];
  const me = meName();
  if (me) out.push({ id: 'builtin:mine', name: '我负责', filter: { ...emptyFilter(), assignee: [me] } });
  return out;
}
const allPresets = () => [...builtinPresets(), ...(state.prefs.presets ?? [])];

function applyFilter(next) {
  state.filter = normalizeFilter(next);
  const q = $('#q');
  if (q && q.value !== state.filter.q) q.value = state.filter.q;
  render();
  renderFilterbar();
  updateFilterCount();
}

function applyPreset(preset) {
  const before = state.filter.q;
  closePanels(); // 面板里的勾选跟着预设走，收起来避免看起来还是旧的
  applyFilter(preset.filter);
  if (state.filter.q !== before) {
    clearTimeout(state.qTimer);
    state.qTimer = setTimeout(load, 200);
  }
  hint(`筛选：${preset.name}`);
}

function updateFilterCount() {
  const el = $('#filterCount');
  if (!el) return;
  const n = state.issues.filter((i) => matchesFilter(i)).length;
  el.textContent = hasFilter() ? `${n} / ${state.issues.length} 张` : '';
}

function addPreset(name) {
  const presets = [...(state.prefs.presets ?? [])];
  presets.push({ id: `p_${Date.now().toString(36)}`, name: name.slice(0, 30), filter: normalizeFilter(state.filter) });
  state.prefs.presets = presets;
  savePrefsSoon();
  renderFilterbar();
  hint(`已存为预设「${name}」`);
}

function deletePreset(id) {
  const target = (state.prefs.presets ?? []).find((p) => p.id === id);
  if (!target) return;
  state.prefs.presets = state.prefs.presets.filter((p) => p.id !== id);
  savePrefsSoon();
  renderFilterbar();
  hint(`已删除预设「${target.name}」`);
}

/** 存预设用行内输入框，不弹原生 prompt：一眼知道名字存到哪一行。 */
function askPresetName() {
  const host = $('#presetChips');
  const btn = host?.querySelector('#savePreset');
  if (!btn) return;
  const input = document.createElement('input');
  input.className = 'preset-name';
  input.placeholder = '预设名称，回车保存';
  input.maxLength = 30;
  btn.replaceWith(input);
  input.focus();
  // 回车保存时浏览器会顺手发 blur：用一个闸门保证只结算一次
  let settled = false;
  const done = (save) => {
    if (settled) return;
    settled = true;
    const name = input.value.trim();
    if (input.parentNode) input.remove();
    if (save && name) addPreset(name);
    else renderFilterbar();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      done(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      done(false);
    }
  });
  input.addEventListener('blur', () => done(false));
}

function renderFilterbar() {
  const chips = $('#presetChips');
  if (!chips) return;
  const active = allPresets().find((p) => normFilter(p.filter) === normFilter(state.filter));
  const customIds = new Set((state.prefs.presets ?? []).map((p) => p.id));
  const chipHtml = (p) => `<span class="preset${active?.id === p.id ? ' is-active' : ''}">
      <button type="button" class="preset-btn" data-preset="${esc(p.id)}" title="${customIds.has(p.id) ? '双击改名' : '内置预设'}">${esc(p.name)}</button>
      ${customIds.has(p.id) ? `<button type="button" class="preset-x" data-del="${esc(p.id)}" aria-label="删除预设 ${esc(p.name)}" title="删除这个预设">×</button>` : ''}
    </span>`;
  chips.innerHTML = `${allPresets().map(chipHtml).join('')}${
    hasFilter() && !active ? '<span class="preset-note">自定义筛选</span>' : ''
  }${hasFilter() ? '<button type="button" class="ghost tiny" id="clearFilter">清除</button>' : ''}<button type="button" class="ghost tiny" id="savePreset">存为预设</button>`;
  $('#filterBtn').classList.toggle('is-on', hasFilter());
}

// —— 用户偏好：列 / 列宽 / 排序 / 预设，按「人 + 项目」存在服务端 ——

let prefsTimer = null;
function savePrefsSoon() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(savePrefsNow, 400);
}

async function savePrefsNow() {
  try {
    const out = await api('/api/prefs', {
      method: 'PUT',
      body: JSON.stringify({ list: { columns: state.prefs.columns, sort: state.sort, presets: state.prefs.presets ?? [] } }),
    });
    if (out?.list) {
      state.prefs.columns = out.list.columns;
      state.prefs.presets = out.list.presets ?? [];
      state.sort = out.list.sort ?? state.sort;
    }
  } catch (e) {
    hint(`视图设置没存上：${e.message}`, true);
  }
}

function afterFilterChange() {
  render();
  renderFilterbar();
  updateFilterCount();
}

// —— 筛选面板 / 列面板：共用一套 popover，点外面、Esc、再点按钮都能关 ——

function closePanels() {
  for (const sel of ['#filterPanel', '#colsPanel']) {
    const el = $(sel);
    if (el) el.hidden = true;
  }
  for (const sel of ['#filterBtn', '#colsBtn']) {
    const el = $(sel);
    if (!el) continue;
    el.setAttribute('aria-expanded', 'false');
    el.classList.remove('is-open');
  }
}

function sortedUnique(values) {
  return [...new Set(values.filter((v) => v !== undefined && v !== null && v !== ''))].sort((a, b) =>
    String(a).localeCompare(String(b), 'zh-CN', { numeric: true }),
  );
}

/** 选项从当前项目的工单里长出来：没出现过的类型/人/标签不占位置。 */
function filterOptions() {
  const issues = state.issues;
  return {
    status: state.statuses.map((s) => ({ v: s, label: statusLabel(s) })),
    priority: [0, 1, 2, 3, 4].map((p) => ({ v: String(p), label: prioLabel(p) })),
    type: sortedUnique(issues.map((i) => i.type)).map((v) => ({ v, label: v })),
    assignee: ['', ...sortedUnique(issues.map((i) => i.assignee))].map((v) => ({ v, label: v || '未指派' })),
    createdBy: sortedUnique(issues.map((i) => i.createdBy)).map((v) => ({ v, label: v })),
    labels: sortedUnique(issues.flatMap((i) => i.labels)).map((v) => ({ v, label: v === state.readyLabel ? '可派给 AI' : v })),
  };
}

function openFilterPanel() {
  const panel = $('#filterPanel');
  if (!panel) return;
  if (!panel.hidden) {
    closePanels();
    return;
  }
  closePanels();
  const f = state.filter;
  const opts = filterOptions();
  const group = (field, label, items) =>
    `<div class="fgroup"><div class="fgroup-head">${label}</div><div class="fopts">${
      items.length
        ? items
            .map(
              ({ v, label: text }) =>
                `<label class="fopt"><input type="checkbox" data-field="${field}" value="${esc(v)}"${
                  f[field].includes(field === 'priority' ? Number(v) : v) ? ' checked' : ''
                }><span>${esc(text)}</span></label>`,
            )
            .join('')
        : '<span class="fnone">还没有可选项</span>'
    }</div></div>`;
  const period = f.updated.period;
  panel.innerHTML = `<div class="popover-head"><b>筛选</b><span class="popover-sub">看板和列表共用</span><button type="button" class="ghost tiny" data-close>关闭</button></div>
    <div class="popover-body">
      <div class="fgroup"><div class="fgroup-head">关键词</div><input id="fq" class="fq" placeholder="标题、描述、评论" value="${esc(f.q)}"></div>
      ${group('status', '状态', opts.status)}
      ${group('priority', '优先级', opts.priority)}
      ${group('type', '类型', opts.type)}
      ${group('assignee', '负责人', opts.assignee)}
      ${group('createdBy', '创建人', opts.createdBy)}
      ${group('labels', '标签', opts.labels)}
      <div class="fgroup"><div class="fgroup-head">最近更新</div>
        <div class="frow">
          <select id="fPeriod">
            <option value="">不限</option>
            <option value="today"${period === 'today' ? ' selected' : ''}>今天</option>
            <option value="7d"${period === '7d' ? ' selected' : ''}>近 7 天</option>
            <option value="30d"${period === '30d' ? ' selected' : ''}>近 30 天</option>
            <option value="custom"${period === 'custom' ? ' selected' : ''}>指定日期</option>
          </select>
          <input type="date" id="fFrom" value="${esc(f.updated.from)}"${period === 'custom' ? '' : ' disabled'}>
          <span class="farrow">→</span>
          <input type="date" id="fTo" value="${esc(f.updated.to)}"${period === 'custom' ? '' : ' disabled'}>
        </div>
      </div>
    </div>
    <div class="popover-foot"><button type="button" class="ghost tiny" data-clear>清除全部</button><span class="popover-count" id="filterCount"></span></div>`;
  panel.hidden = false;
  const btn = $('#filterBtn');
  placePopover(panel, btn);
  btn?.setAttribute('aria-expanded', 'true');
  btn?.classList.add('is-open');
  updateFilterCount();
}

function openColsPanel() {
  const panel = $('#colsPanel');
  if (!panel) return;
  if (!panel.hidden) {
    closePanels();
    return;
  }
  closePanels();
  const cols = columnPrefs();
  panel.innerHTML = `<div class="popover-head"><b>列</b><span class="popover-sub">勾选显示，拖表头换序</span><button type="button" class="ghost tiny" data-close>关闭</button></div>
    <div class="popover-body"><div class="colpicks">${cols
      .map(
        (c) =>
          `<label class="colpick"><input type="checkbox" data-col="${c.id}"${c.hidden ? '' : ' checked'}><span>${esc(COLUMN_BY_ID[c.id].label)}</span></label>`,
      )
      .join('')}</div></div>
    <div class="popover-foot"><button type="button" class="ghost tiny" data-reset>恢复默认列与宽度</button></div>`;
  panel.hidden = false;
  const btn = $('#colsBtn');
  placePopover(panel, btn);
  btn?.setAttribute('aria-expanded', 'true');
  btn?.classList.add('is-open');
}

/** 面板贴着按钮下方：顶栏换行、页面滚动时也不会跑到别处去。 */
function placePopover(panel, btn) {
  if (!btn) return;
  const rect = btn.getBoundingClientRect();
  panel.style.top = `${Math.round(rect.bottom + 8)}px`;
  panel.style.right = `${Math.round(Math.max(12, window.innerWidth - rect.right))}px`;
}

window.addEventListener('resize', () => closePanels());

async function loadPrefs() {
  try {
    const { list } = await api('/api/prefs');
    state.prefs = { columns: list.columns ?? defaultColumns(), presets: list.presets ?? [] };
    state.sort = list.sort ?? state.sort;
  } catch {
    // 老版本服务端没有这个接口：退回内置列，页面照样能用
    state.prefs = { columns: defaultColumns(), presets: [] };
  }
  renderFilterbar();
}

/** 卡片换列时从旧位置滑到新位置：只动真正挪窝的那几张。 */
function animateMoves(prev) {
  if (!prev.size || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const el of $('#board').querySelectorAll('.card')) {
    const before = prev.get(el.dataset.id);
    if (!before) continue;
    const after = el.getBoundingClientRect();
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
      duration: 340,
      easing: 'cubic-bezier(.2,.7,.3,1)',
    });
  }
}

function renderBoard(issues) {
  const board = $('#board');
  const prev = new Map();
  for (const el of board.querySelectorAll('.card')) prev.set(el.dataset.id, el.getBoundingClientRect());

  board.innerHTML = state.statuses
    .map((status, i) => {
      const list = issues.filter((i) => i.status === status);
      return `<section class="col" data-status="${esc(status)}" style="--i:${i}">
        <div class="col-head">
          <h2 class="col-name">${esc(statusLabel(status))}</h2>
          <span class="col-count mono">${list.length}</span>
        </div>
        <div class="col-body${list.length ? '' : ' is-empty'}">${list.map(card).join('') || `<div class="col-empty">${esc(laneEmpty(status))}</div>`}</div>
      </section>`;
    })
    .join('');
  delete board.dataset.loading;
  animateMoves(prev);
}

function render() {
  const issues = state.issues.filter((i) => matchesFilter(i));
  if (state.view === 'list') {
    renderList(issues);
    return;
  }
  renderBoard(issues);
}

/** 数据没回来之前先把四条列画出来，不让人对着一片空白的板。 */
function renderSkeleton() {
  const board = $('#board');
  if (board.querySelector('.card, .list-row')) return;
  board.dataset.loading = '1';
  if (state.view === 'list') {
    const cols = visibleColumns();
    board.innerHTML = `<div class="list-view"><table class="list-table" style="min-width:${cols.reduce((n, c) => n + c.w, 0)}px"><colgroup>${cols.map((c) => `<col style="width:${c.w}px">`).join('')}<col></colgroup>${listHead(cols)}<tbody><tr class="list-empty-row"><td colspan="${(cols.length || 1) + 1}">读取工单…</td></tr></tbody></table></div>`;
    return;
  }
  board.innerHTML = state.statuses
    .map(
      (status, i) => `<section class="col" data-status="${esc(status)}" style="--i:${i}">
        <div class="col-head">
          <h2 class="col-name">${esc(statusLabel(status))}</h2>
          <span class="col-count mono">·</span>
        </div>
        <div class="col-body"></div>
      </section>`,
    )
    .join('');
}

async function load() {
  // 正在拖列宽时别重画表格，否则拖到一半宽度被重置
  if (document.body.classList.contains('is-col-resizing')) return;
  try {
    const params = new URLSearchParams();
    if (state.filter.q) params.set('q', state.filter.q);
    const [{ issues }, watchPayload] = await Promise.all([
      api(`/api/issues?${params}`),
      api('/api/watch').catch(() => ({ watch: null })),
    ]);
    state.issues = issues;
    if (watchPayload?.watch) state.watch = watchPayload.watch;
    render();
    renderWatch();
    updateFilterCount();
    const shown = issues.filter((i) => matchesFilter(i)).length;
    const suffix = hasFilter() ? `（筛选后 ${shown} 张）` : '';
    hint(`共 ${issues.length} 张${suffix} · 自动刷新 ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    hint(`加载失败：${e.message}`, true);
  }
}

/** 自动流水线开关：关 → 点一下开；开 → 点一下请求停（跑完手上这张）；停不下来再点就强杀 */
function renderWatch() {
  const btn = $('#watch');
  const label = $('#watchText');
  const w = state.watch ?? { running: false };
  const busy = w.running && w.state === 'running' && w.card;
  label.textContent = w.stopping
    ? '自动流水线：停止中（点一下强杀）'
    : w.running
      ? `自动流水线：开${busy ? `（${w.card}）` : '（等单）'}`
      : '自动流水线：关';
  btn.classList.toggle('watch-on', Boolean(w.running) && !w.stopping);
  btn.classList.toggle('watch-stopping', Boolean(w.stopping));
  btn.title = w.running
    ? `pid ${w.pid}${w.lastError ? ` · 上次：${w.lastError}` : ''} · 点一下停（跑完手上这张）`
    : `点一下开：有就绪单就自动开干${w.lastError ? ` · 上次：${w.lastError}` : ''}`;
  // 卡住时别让人靠悬停才发现：错误写进 hint（变更时提醒一次）
  if (w.lastError && w.lastError !== state.lastWatchError) {
    state.lastWatchError = w.lastError;
    setTimeout(() => hint(`自动流水线卡住了：${w.lastError}`, true), 0);
  }
}

async function toggleWatch() {
  const w = state.watch ?? { running: false };
  const action = w.stopping ? 'force' : w.running ? 'stop' : 'start';
  const btn = $('#watch');
  btn.disabled = true;
  $('#watchText').textContent = action === 'start' ? '启动中…' : '停止中…';
  try {
    const { watch } = await api('/api/watch', { method: 'POST', body: JSON.stringify({ action }) });
    state.watch = watch;
    renderWatch();
    hint(
      watch.stopping
        ? '已请求停止：它跑完手上这张就退（再点一下就强杀）'
        : watch.running
          ? `自动流水线已开（pid ${watch.pid}）：有就绪单就自己干`
          : '自动流水线已停',
    );
    load();
  } catch (err) {
    hint(`开关失败：${err.message}`, true);
    renderWatch();
  } finally {
    btn.disabled = false;
  }
}

// 页面在跳/换卡时，早先发出的请求回来不能把内容盖回去
let issueToken = 0;

/** 当前地址是不是某张工单的独立页面；是就返回 id。 */
function issueIdFromPath() {
  const m = location.pathname.match(/^\/issue\/([^/]+)\/?$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** 把工单渲染到独立页面（/issue/<id>，地址可以直接发给别人）。 */
async function openIssue(id, { keepTab = false } = {}) {
  const token = ++issueToken;
  const [{ issue, comments }, attachments] = await Promise.all([
    api(`/api/issues/${encodeURIComponent(id)}`),
    api(`/api/issues/${encodeURIComponent(id)}/attachments`)
      .then((d) => d.attachments)
      .catch(() => []),
  ]);
  if (token !== issueToken) return; // 这期间又换了别的卡
  state.current = issue;
  if (!keepTab) state.newComments = new Set();
  state.comments = comments;

  document.body.dataset.mode = 'issue';
  $('#filterbar').hidden = true;
  closePanels();
  $('#issuePage').hidden = false;
  $('#issuePage').dataset.status = issue.status; // 顶部那道状态线
  $('#panelId').textContent = issue.id;
  $('#panelTitle').textContent = issue.title;
  renderIssueMeta(issue);
  renderIssueFields(issue);
  $('#panelBody').innerHTML = issue.body ? md(issue.body) : '<div class="empty">（无描述）</div>';
  renderAttachments(attachments);
  renderComments(comments);

  if (!keepTab) {
    $('#panelLabel').value = '';
    state.trace = null;
    $('#panelTrace').innerHTML = '';
    $('#panelRaw').hidden = true;
    $('#panelRaw').textContent = '';
    showTab('issue');
  }
  watchIssue(id); // 评论 / 字段实时推送
  document.title = `${issue.id} · ${issue.title}`;
}

function renderIssueMeta(issue) {
  $('#panelMeta').innerHTML = [
    `<span class="meta-item"><i>类型</i>${esc(issue.type)}</span>`,
    issue.createdBy ? `<span class="meta-item"><i>创建</i>${esc(issue.createdBy)}</span>` : '',
    `<span class="meta-item"><i>负责人</i>${esc(issue.assignee || '—')}</span>`,
    `<span class="meta-item"><i>更新</i>${esc(fmtTime(issue.updated))}</span>`,
    issue.labels.map(chip).join(''),
  ].join('');
}

/** 状态 / 优先级 / 派单按钮：别人改了也要跟着变，但正在操作的那个控件不打扰。 */
function renderIssueFields(issue) {
  const status = $('#panelStatus');
  if (document.activeElement !== status) {
    status.innerHTML = state.statuses
      .map((s) => `<option value="${s}"${s === issue.status ? ' selected' : ''}>${esc(statusLabel(s))}</option>`)
      .join('');
  }
  const prio = $('#panelPriority');
  if (document.activeElement !== prio) fillPrioritySelect(prio, issue.priority);
  renderDispatch(issue);
}

const commentKey = (c) => `${c.author}|${c.created}|${String(c.text ?? '').slice(0, 24)}`;

/** 评论列表；这页开着的时候新进来的那条会有个标记（不刷新不清）。 */
function renderComments(comments) {
  const box = $('#panelComments');
  box.innerHTML =
    comments
      .map(
        (c) =>
          `<div class="comment${state.newComments.has(commentKey(c)) ? ' is-new' : ''}"><div class="comment-head">${esc(c.author)}<span class="dot">·</span>${esc(fmtTime(c.created))}</div><div class="md">${md(c.text)}</div></div>`,
      )
      .join('') || '<div class="empty">还没有评论</div>';
}

// —— 实时：同一张卡上别人发的评论 / 改的状态，不用刷新就能看到 ——
let issueStream = null;

function watchIssue(id) {
  if (issueStream?.card === id) return; // 同一张卡已经在跟了
  closeIssueStream();
  const source = new EventSource(`/api/issues/${encodeURIComponent(id)}/events`);
  source.card = id;
  issueStream = source;
  source.addEventListener('issue', (e) => {
    let payload;
    try {
      payload = JSON.parse(e.data);
    } catch {
      return;
    }
    if (state.current?.id !== id) return;
    applyLiveIssue(payload.issue, payload.comments ?? []);
  });
  source.addEventListener('gone', () => {
    hint('这张工单读不到了（可能被删了）', true);
    closeIssueStream();
  });
  source.addEventListener('error', () => {}); // 断了浏览器会自动重连
}

function closeIssueStream() {
  if (!issueStream) return;
  issueStream.close();
  issueStream = null;
}

/** 别人改了：更新字段 + 把新评论接在后面（不重排你正在看的部分）。 */
function applyLiveIssue(issue, comments) {
  const prev = state.current;
  if (!prev) return;
  const changed = [];
  if (issue.status !== prev.status) changed.push(`状态改成「${statusLabel(issue.status)}」`);
  if (Number(issue.priority) !== Number(prev.priority)) changed.push(`优先级改成「${prioLabel(issue.priority)}」`);
  if (issue.title !== prev.title) changed.push('标题改了');
  const labelsA = [...(prev.labels ?? [])].sort().join(',');
  const labelsB = [...(issue.labels ?? [])].sort().join(',');
  if (labelsA !== labelsB) changed.push('标签变了');

  state.current = issue;
  renderIssueMeta(issue);
  renderIssueFields(issue);
  if (issue.title !== prev.title) {
    $('#panelTitle').textContent = issue.title;
    document.title = `${issue.id} · ${issue.title}`;
  }

  const known = new Set((state.comments ?? []).map(commentKey));
  const added = comments.filter((c) => !known.has(commentKey(c)));
  for (const c of added) state.newComments.add(commentKey(c));
  state.comments = comments;
  renderComments(comments);

  const who = added.length ? `${added[added.length - 1].author || '有人'} 发了${added.length > 1 ? `${added.length} 条` : ''}新评论` : '';
  const parts = [...changed, who].filter(Boolean);
  if (parts.length) hint(parts.join('，'));
  if (added.length) scrollToNewComments();
}

function scrollToNewComments() {
  if (document.body.dataset.mode !== 'issue') return;
  const last = $('#panelComments').lastElementChild;
  if (!last) return;
  const rect = last.getBoundingClientRect();
  const visible = rect.bottom <= window.innerHeight - 60 && rect.top >= 0;
  if (!visible) last.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

/** 一键派单按钮：没标签就加上（已关闭的就顺手重开），有标签就变成取消派单。 */
function renderDispatch(issue) {
  const btn = $('#panelDispatch');
  const hintEl = $('#panelDispatchHint');
  if (issue.labels.includes(state.readyLabel)) {
    btn.textContent = '取消派单';
    btn.className = 'ghost';
    hintEl.textContent =
      issue.status === 'open'
        ? `已标 ${state.readyLabel}：${state.watch?.running ? '自动流水线会自己接它' : '点右上角「自动流水线」或 node wf.mjs work'}`
        : `已标 ${state.readyLabel}，但状态是「${statusLabel(issue.status)}」——engine 只接「${statusLabel('open')}」`;
    return;
  }
  if (issue.status === 'closed') {
    btn.textContent = '重开并派给 AI';
    btn.className = 'primary';
    hintEl.textContent = `会改回「${statusLabel('open')}」并打上 ${state.readyLabel}`;
    return;
  }
  btn.textContent = '让 AI 干这个';
  btn.className = 'primary';
  hintEl.textContent = state.watch?.running
    ? `打上 ${state.readyLabel}，自动流水线立刻开跑`
    : `加 ${state.readyLabel} 标签，再点右上角「自动流水线」（或 node wf.mjs work）`;
}

async function dispatchCurrent() {
  const issue = state.current;
  if (!issue || state.dispatching) return;
  const ready = issue.labels.includes(state.readyLabel);
  const body = ready
    ? { removeLabels: [state.readyLabel] }
    : { addLabels: [state.readyLabel], ...(issue.status === 'closed' ? { status: 'open' } : {}) };
  state.dispatching = true;
  const btn = $('#panelDispatch');
  btn.disabled = true;
  btn.textContent = ready ? '取消中…' : '派单中…'; // bd 往返要半秒，先给个反馈
  try {
    // 用 PATCH 的返回值直接翻面，不等 bd 列表刷新（否则连点会错一步）
    const { issue: saved } = await api(`/api/issues/${encodeURIComponent(issue.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    state.current = saved;
    renderDispatch(saved);
    hint(ready ? '已取消派单' : `已标 ${state.readyLabel}：终端跑 node wf.mjs work 就开始干`);
    // 后台对齐：不堵按钮（bd 列表 + 评论要一两秒）
    const sync = document.body.dataset.mode === 'board' ? load() : Promise.resolve();
    Promise.all([sync, openIssue(saved.id, { keepTab: true })]).catch(() => {});
  } catch (err) {
    hint(`改动失败：${err.message}`, true);
    if (state.current) renderDispatch(state.current);
  } finally {
    state.dispatching = false;
    btn.disabled = false;
  }
}

/** 附件：图片/文件，存在项目的 .hlwd/attachments/ 里（不进 beads，也不进 git）。 */
const fmtSize = (n) =>
  n == null ? '' : n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${Math.round(n / 1024)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`;
const mdFor = (a) => (a.kind === 'image' ? `![${a.name}](${a.url})` : `[${a.name}](${a.url})`);

/** 附件地址 → 下载地址；外部图片就原样返回。 */
const downloadHref = (url) =>
  String(url).startsWith('/api/attachments/') ? `${url}${url.includes('?') ? '&' : '?'}download=1` : String(url);

/** 从附件地址里猜个文件名：去掉存盘时加的时间戳前缀。 */
function fileNameFromUrl(url) {
  try {
    const last = decodeURIComponent(new URL(url, location.origin).pathname.split('/').pop() ?? '');
    return last.replace(/^\d+-/, '') || 'download';
  } catch {
    return 'download';
  }
}

function renderAttachments(list) {
  state.attachments = list ?? [];
  $('#attachmentCount').textContent = state.attachments.length ? String(state.attachments.length) : '';
  if (!state.attachments.length) {
    $('#panelAttachments').innerHTML = '<div class="empty">还没有附件（截图、日志、设计图都可以丢进来）</div>';
    return;
  }
  $('#panelAttachments').innerHTML = state.attachments
    .map((a) => {
      const dl = `<a class="att-dl" href="${esc(downloadHref(a.url))}" download="${esc(a.name)}" title="下载到本地">下载</a>`;
      const actions = `${dl}<button type="button" class="ghost mini" data-act="insert">插入评论</button><button type="button" class="ghost mini" data-act="delete">删除</button>`;
      const head = `<span class="att-name" title="${esc(a.name)}">${esc(a.name)}</span><span class="dot">·</span>${esc(fmtSize(a.size))}`;
      return a.kind === 'image'
        ? `<figure class="attachment" data-stored="${esc(a.stored)}">
             <img src="${esc(a.url)}" alt="${esc(a.name)}" loading="lazy" class="md-img" />
             <figcaption>${head}${actions}</figcaption>
           </figure>`
        : `<div class="attachment file" data-stored="${esc(a.stored)}">
             <a href="${esc(a.url)}" target="_blank" rel="noreferrer">${head}</a>${actions}
           </div>`;
    })
    .join('');
}

async function refreshAttachments() {
  if (!state.current) return;
  const { attachments } = await api(`/api/issues/${encodeURIComponent(state.current.id)}/attachments`).catch(() => ({
    attachments: [],
  }));
  renderAttachments(attachments);
}

/** 把 markdown 插到光标处（没光标就追加），粘贴上传后自动用。 */
function insertComment(text) {
  const box = $('#panelComment');
  const start = box.selectionStart ?? box.value.length;
  const end = box.selectionEnd ?? start;
  box.value = `${box.value.slice(0, start)}${text}${box.value.slice(end)}`;
  const pos = start + text.length;
  box.focus();
  try {
    box.setSelectionRange(pos, pos);
  } catch {
    // 不支持的浏览器就算了
  }
}

async function uploadFiles(files, { insert = false, scope = 'card' } = {}) {
  const issue = state.current;
  const list = [...(files ?? [])];
  if (!issue || !list.length) return [];
  const inline = scope === 'inline';
  const done = [];
  for (const file of list) {
    try {
      const res = await fetch(`/api/issues/${encodeURIComponent(issue.id)}/attachments`, {
        method: 'POST',
        headers: {
          'x-filename': encodeURIComponent(file.name || (inline ? '粘贴的图片.png' : 'file')),
          'x-scope': scope,
        },
        body: file,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      done.push(data.attachment);
    } catch (err) {
      hint(`上传失败：${err.message}`, true);
    }
  }
  // 粘进评论的图不归「附件」管，不用去刷那个列表
  if (!inline) await refreshAttachments();
  if (done.length) {
    hint(inline ? `已插入 ${done.length} 张图片，发送评论后显示` : `已上传 ${done.length} 个附件`);
    if (insert) insertComment(`${done.map(mdFor).join(' ')}\n`);
  }
  return done;
}

/** 从粘贴事件里取文件（截图就是这条路径）。 */
function pastedFiles(event) {
  return [...(event.clipboardData?.items ?? [])]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean);
}

async function loadTrace() {
  if (!state.current || state.trace?.loading) return;
  const id = state.current.id;
  state.trace = { loading: true };
  const [runs, history, journal] = await Promise.all([
    api(`/api/issues/${encodeURIComponent(id)}/runs`).then((d) => d.runs).catch(() => []),
    api(`/api/issues/${encodeURIComponent(id)}/history`).then((d) => d.history).catch(() => []),
    api(`/api/issues/${encodeURIComponent(id)}/journal`).then((d) => d.journal).catch(() => []),
  ]);
  state.trace = { runs, history, journal, loading: false };
  renderTrace({ runs, history });
}

// 时间统一按本地时区展示（run.json 存 UTC，bd history 带 +08:00，不统一会看得像两个事件）
const fmtTime = (at) => {
  const d = new Date(at ?? '');
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('zh-CN', { hour12: false }).slice(0, 16);
};
const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

function showTab(name) {
  const isIssue = name === 'issue';
  const isTrace = name === 'trace';
  const isSession = name === 'session';
  $('#tabIssue').classList.toggle('active', isIssue);
  $('#tabTrace').classList.toggle('active', isTrace);
  $('#tabSession').classList.toggle('active', isSession);
  $('#viewIssue').hidden = !isIssue;
  $('#viewTrace').hidden = !isTrace;
  $('#viewSession').hidden = !isSession;
  if (isTrace) loadTrace();
  if (isSession) openSession();
}

// 追溯面板：beads 的状态变更（bd history）+ engine 的 run.json 时间线
function renderTrace({ runs, history }) {
  const blocks = [];

  if (history.length) {
    blocks.push(`<div class="trace-block">
      <div class="trace-title">状态变更（bd history）</div>
      ${history
        .map(
          (h) =>
            `<div class="trace-line"><span class="mono">${fmtTime(h.at)}</span> <b>${esc(statusLabel(h.status))}</b>${h.assignee ? `<span class="dot">·</span>${esc(h.assignee)}` : ''}</div>`,
        )
        .join('')}
    </div>`);
  }

  if (!runs.length) {
    blocks.push('<div class="trace-block"><div class="empty">还没有 engine 运行记录（.engine/runs）</div></div>');
  }

  for (const run of runs) {
    const steps = [`<div class="trace-line"><span class="mono">${fmtTime(run.startedAt)}</span> 接单（${esc(run.actor ?? '')} / ${esc(run.runner ?? '')}）</div>`];
    for (const a of run.attempts ?? []) {
      const e = a.execute ?? {};
      steps.push(`<div class="trace-line"><span class="mono">${fmtTime(e.startedAt)}</span> 执行 #${esc(a.attempt)}<span class="dot">·</span>${e.ok == null ? '<b class="live">进行中</b>' : `${fmtMs(e.ms)}<span class="dot">·</span>${e.ok ? 'ok' : '<b class="fail">失败</b>'}`}</div>`);
      if (!e.ok && e.error) steps.push(`<div class="trace-sub">${esc(e.error)}</div>`);

      const g = a.gate;
      if (g) {
        steps.push(`<div class="trace-line"><span class="mono">${fmtTime(g.startedAt)}</span> 门禁 #${esc(a.attempt)}<span class="dot">·</span>${g.pass == null ? '<b class="live">进行中</b>' : `${fmtMs(g.ms)}<span class="dot">·</span><b class="${g.pass ? 'pass' : 'fail'}">${g.pass ? 'pass' : 'fail'}</b> ${reasonCell(g.reason)}`}</div>`);
      }

      const r = a.review;
      if (r) {
        steps.push(`<div class="trace-line"><span class="mono">${fmtTime(r.startedAt)}</span> 审查 #${esc(a.attempt)}<span class="dot">·</span>${r.pass == null ? '<b class="live">进行中</b>' : `${fmtMs(r.ms)}<span class="dot">·</span><b class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'pass' : 'fail'}</b> ${reasonCell(r.reason)}`}</div>`);
        if (r.checks?.length) {
          steps.push(`<details class="trace-checks"><summary>验证 ${r.checks.length} 条</summary>${r.checks.map((c) => `<div>${esc(c)}</div>`).join('')}</details>`);
        }
      }
    }
    if (run.commit) steps.push(`<div class="trace-line">提交 <span class="mono">${esc(run.commit)}</span></div>`);
    steps.push(`<div class="trace-line">结局 <b>${esc(run.outcome)}</b>${run.reason ? `<span class="dot">·</span>${esc(run.reason)}` : ''}</div>`);

    blocks.push(`<div class="trace-block">
      <div class="trace-title mono">${esc(run.runId)}</div>
      ${steps.join('')}
      <div class="trace-foot">.engine/runs/${esc(run.runId)}/</div>
    </div>`);
  }

  $('#panelTrace').innerHTML = blocks.join('');
}

/** 面板第三个 tab：AI 到底在里面做了什么（工具调用 / 思考 / 文本）。 */
const SESSION_PAGE = 300; // 一次最多拉多少条：一轮事件可能有几千条
state.session = {
  turns: [],
  current: null,
  source: null,
  next: null,
  nodes: new Map(),
  autoFollow: true,
};

const turnKey = (t) => `${t.runId}/${t.phaseKey}`;
const turnName = (t) => `${t.phase === 'exec' ? '执行' : '审查'} #${t.attempt}`;
const turnApi = (suffix = '') => `/api/issues/${encodeURIComponent(state.current.id)}/turns${suffix}`;
const pickTurn = (turns) => turns.find((t) => t.live) ?? turns[0] ?? null;
// 「最新」= 开始时间最晚的那个（列表顺序是 attempt 倒序、同轮 exec 在前，不能直接拿 turns[0]）。
// 同毫秒打平的时候按流水线顺序算：同一轮的 review 比 exec 新。
const latestTurn = (turns) =>
  [...turns].sort(
    (a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')) || (a.phase === 'review' ? -1 : 1),
  )[0] ?? null;

function setSessionStatus(text, isError = false) {
  const el = $('#sessionStatus');
  el.textContent = text ?? '';
  el.classList.toggle('err', isError);
}

function renderTurns() {
  const cur = state.session.current;
  // 5 秒一次自动刷新，签名没变就别重建按钮（否则会把焦点和 hover 弄丢）
  const sig = state.session.turns
    .map((t) => `${turnKey(t)}:${t.live}:${t.done}:${t.ms}:${cur && turnKey(cur) === turnKey(t) ? 1 : 0}`)
    .join('|');
  if (sig === state.session.turnSig) return;
  state.session.turnSig = sig;

  $('#sessionTurns').innerHTML = state.session.turns.length
    ? state.session.turns
        .map(
          (t) => `<button type="button" class="turn-btn${cur && turnKey(cur) === turnKey(t) ? ' active' : ''}"
            data-run="${esc(t.runId)}" data-phase="${esc(t.phaseKey)}" title="${esc(t.startedAt ?? '')}">
            <span class="turn-dot${t.live ? ' live' : t.done ? ' done' : ''}"></span>
            <span class="turn-name">${esc(turnName(t))}</span>
            <span class="turn-meta mono">${t.live ? '正在跑' : esc(fmtMs(t.ms))}</span>
          </button>`,
        )
        .join('')
    : '<div class="empty">这张卡还没跑过 AI。</div>';
}

function sessionClear() {
  const s = state.session;
  if (s.source) {
    s.source.close();
    s.source = null;
  }
  s.nodes = new Map();
  s.next = null;
  s.lastAssistant = null;
  $('#sessionBody').innerHTML = '';
  $('#sessionMore').hidden = true;
}

function sessionScroller() {
  return document.scrollingElement || document.documentElement;
}

function nearBottom() {
  const box = sessionScroller();
  return !box || box.scrollHeight - box.scrollTop - box.clientHeight < 120;
}

function scrollSessionToBottom() {
  const box = sessionScroller();
  if (box) box.scrollTop = box.scrollHeight;
}

const toolArgLine = (args) => {
  const a = args ?? {};
  const raw = a.command ?? a.path ?? a.file ?? a.pattern ?? (Object.keys(a).length ? JSON.stringify(a) : '');
  return String(raw).replace(/\s+/g, ' ').trim();
};

function msgNode(m) {
  const node = document.createElement('div');
  node.className = `msg msg-${m.kind}`;
  node.dataset.id = m.id;
  if (m.kind === 'tool') {
    node.innerHTML = `<details class="tool"><summary>
        <span class="tool-name mono"></span><span class="tool-arg mono"></span><span class="tool-ms mono"></span>
      </summary><pre class="tool-result mono"></pre></details>`;
  } else if (m.kind === 'thinking') {
    node.innerHTML = `<details class="think"><summary><span class="think-label">思考</span><span class="think-peek"></span></summary><div class="msg-text"></div></details>`;
  } else {
    node.innerHTML = '<div class="msg-text"></div>';
  }
  return node;
}

function msgUpdate(node, m) {
  if (m.kind === 'tool') {
    const tool = m.tool ?? {};
    const arg = toolArgLine(tool.args);
    node.querySelector('.tool-name').textContent = tool.name ?? 'tool';
    const argEl = node.querySelector('.tool-arg');
    argEl.textContent = arg.length > 140 ? `${arg.slice(0, 140)}…` : arg;
    argEl.title = arg;
    node.querySelector('.tool-ms').textContent = tool.done ? (tool.ms != null ? fmtMs(tool.ms) : '完成') : '…';
    node.querySelector('.tool-ms').classList.toggle('is-error', Boolean(tool.isError));
    if (tool.done) {
      node.querySelector('.tool-result').textContent = tool.result || '（没有输出）';
      node.classList.toggle('is-error', Boolean(tool.isError));
      // 失败的工具调用直接展开：人就是来找它的
      if (tool.isError) node.querySelector('details').open = true;
    }
    return;
  }

  const textEl = node.querySelector('.msg-text');
  if (!textEl) return;
  if (m.final) {
    // 定稿了才跑 markdown：流式过程中每帧都渲染一遍太重
    if (m.kind === 'assistant') {
      textEl.classList.add('md'); // md 里是缩排与块级标签，得关掉 pre-wrap
      textEl.innerHTML = md(m.text);
      state.session.lastAssistant = { text: m.text, node }; // 留给 renderOutput 去重
    } else {
      textEl.textContent = m.text;
    }
    node.dataset.final = '1';
  } else {
    textEl.textContent = m.text;
  }
  if (m.kind === 'thinking') {
    const oneLine = String(m.text ?? '').replace(/\s+/g, ' ').trim();
    node.querySelector('.think-peek').textContent = oneLine ? ` ${oneLine.slice(0, 80)}${oneLine.length > 80 ? '…' : ''}` : '';
  }
}

function applyThinkFilter() {
  $('#sessionBody').classList.toggle('hide-think', !$('#sessionThink').checked);
}

function appendMessages(list, { follow = true } = {}) {
  if (!list?.length) return;
  const body = $('#sessionBody');
  const stick = follow && nearBottom();
  for (const m of list) {
    let node = state.session.nodes.get(m.id);
    if (!node) {
      node = msgNode(m);
      state.session.nodes.set(m.id, node);
      body.append(node);
    }
    msgUpdate(node, m);
  }
  applyThinkFilter();
  if (stick) scrollSessionToBottom();
}

function renderOutput(text) {
  const body = $('#sessionBody');
  body.querySelector('.msg-output')?.remove();
  if (!text) return;
  // 最终回复和最后一条正文通常是同一段话（output.txt 就是从它来的）：留一份就够
  const lastAssistant = state.session.lastAssistant;
  if (lastAssistant && lastAssistant.text.trim() === text.trim()) lastAssistant.node.remove();
  const node = document.createElement('div');
  node.className = 'msg msg-output';
  node.innerHTML = '<div class="msg-label">最终回复</div><div class="md"></div>';
  node.querySelector('.md').innerHTML = md(text);
  body.append(node);
  if (nearBottom()) scrollSessionToBottom();
}

async function fetchTurn(turn, after = null) {
  const q = new URLSearchParams({ limit: String(SESSION_PAGE) });
  if (after != null) q.set('after', String(after));
  const path = `${turnApi(`/${encodeURIComponent(turn.runId)}/${encodeURIComponent(turn.phaseKey)}`)}?${q}`;
  try {
    const data = await api(path);
    // 第一次打开一轮（不是「加载更多」）：停在开头，不要直接跳到结尾
    appendMessages(data.messages, { follow: after != null });
    state.session.next = data.next;
    $('#sessionMore').hidden = data.next == null;
    renderOutput(data.output);
    if (after == null) {
      const box = sessionScroller();
      if (box) box.scrollTop = 0;
    }
    setSessionStatus(`${turnName(turn)} · ${data.total} 条消息 · ${fmtSize(data.bytes)}`);
  } catch (err) {
    setSessionStatus(`读不到这一轮的记录：${err.message}`, true);
  }
}

/** 正在跑的这一轮：开 SSE 跟着长。收尾再拉一次完整内容（带最终回复）。 */
function followTurn(turn) {
  const s = state.session;
  if (s.source) {
    s.source.close();
    s.source = null;
  }
  const url = turnApi(`/${encodeURIComponent(turn.runId)}/${encodeURIComponent(turn.phaseKey)}/stream`);
  const source = new EventSource(url);
  s.source = source;
  let finished = false;
  setSessionStatus(`${turnName(turn)} · 正在跑，跟着看`);

  source.addEventListener('messages', (e) => {
    try {
      appendMessages(JSON.parse(e.data).messages ?? []);
    } catch {
      // 半包就算了，下一轮还会来
    }
  });
  source.addEventListener('done', () => {
    finished = true;
    source.close();
    s.source = null;
    refreshTurns({ reopenCurrent: true });
  });
  source.addEventListener('missing', () => {
    finished = true;
    source.close();
    s.source = null;
    setSessionStatus('这一轮没有会话记录（执行器没写 events.jsonl）', true);
  });
  source.addEventListener('timeout', () => {
    finished = true;
    source.close();
    s.source = null;
    setSessionStatus('等太久了先断开；点一下这一轮可以再看', true);
  });
  source.addEventListener('error', () => {
    if (finished) return; // 正常收线的 close 也会走这里
    source.close();
    s.source = null;
    setSessionStatus('跟丢了（连接断了），点一下这一轮重看', true);
  });
}

async function openTurn(turn) {
  if (!state.current || !turn) return;
  sessionClear();
  state.session.current = turn;
  renderTurns();
  if (turn.live) {
    followTurn(turn);
    return;
  }
  await fetchTurn(turn);
}

/**
 * 重新读一次「有哪些回合」。
 * reopenCurrent：把当前这轮从头重拉（跑完了，需要最终回复）。
 */
async function refreshTurns({ reopenCurrent = false } = {}) {
  if (!state.current) return;
  let turns = [];
  try {
    turns = (await api(turnApi())).turns ?? [];
  } catch (err) {
    setSessionStatus(`读不到运行记录：${err.message}`, true);
    return;
  }
  state.session.turns = turns;
  const cur = state.session.current;
  const same = cur ? turns.find((t) => turnKey(t) === turnKey(cur)) : null;
  renderTurns();

  if (reopenCurrent && same) return openTurn({ ...same, live: false });
  if (!cur) return turns.length ? openTurn(pickTurn(turns)) : setSessionStatus('还没有运行记录');

  // 正在跟的这一轮跑完了、后面又开了一轮（执行完了接着审查）：自动接上去
  const newest = latestTurn(turns);
  if (state.session.autoFollow && same?.done && newest && turnKey(newest) !== turnKey(same) && newest.live) {
    return openTurn(newest);
  }
  if (same) {
    state.session.current = same; // 只更新 live/耗时，不动内容
    return;
  }
  // 当前这轮不在了：跟着自动切（用户手动选过的就不抢）
  if (state.session.autoFollow) return openTurn(pickTurn(turns));
}

async function openSession() {
  if (!state.current) return;
  state.session.autoFollow = true;
  state.session.current = null;
  sessionClear();
  renderTurns();
  setSessionStatus('读取中…');
  await refreshTurns();
}

async function patch(fields, id = state.current?.id) {
  if (!id) return false;
  try {
    await api(`/api/issues/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    });
    if (document.body.dataset.mode === 'board') await load();
    if (state.current?.id === id) await openIssue(id, { keepTab: true });
    return true;
  } catch (e) {
    hint(`改动失败：${e.message}`, true);
    return false;
  }
}

async function sendComment() {
  const box = $('#panelComment');
  const text = box.value.trim();
  if (!text || !state.current) return;
  try {
    await api(`/api/issues/${encodeURIComponent(state.current.id)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    box.value = '';
    await openIssue(state.current.id, { keepTab: true });
    hint('评论已发送');
  } catch (e) {
    hint(`评论失败：${e.message}`, true);
  }
}

// —— 自动刷新：看板常刷；面板只在没人输入时悄悄刷新 ——
async function tick() {
  if (!state.authed) return; // 停在登录页时别空转
  if (document.body.classList.contains('is-col-resizing')) return; // 拖列宽时别抢着重画
  if ($('#create').open || $('#settingsDialog').open) return;
  if (document.body.dataset.mode === 'board') {
    await load();
    return;
  }
  // 工单页：评论和字段有 SSE 推，不用轮询；只有「会话」tab 需要定时看有没有新的一轮
  if (!$('#viewSession').hidden) refreshTurns();
}

// —— 登录 / 注册 ——
// 部署在没人的机器上时，同事从内网进来先登录；WF_AUTH=off 时整段不生效。
function authError(text) {
  const el = $('#authError');
  el.textContent = text ?? '';
  el.hidden = !text;
}

const authMode = () => ($('#authTabRegister').classList.contains('active') ? 'register' : 'login');

function setAuthMode(mode) {
  const reg = mode === 'register';
  $('#authTabLogin').classList.toggle('active', !reg);
  $('#authTabRegister').classList.toggle('active', reg);
  // 显示名只在注册时出现。除了 hidden 属性再上 inline style：
  // 标签页可能还拿着旧样式表（改完没刷新），那也得藏住
  const displayRow = $('#authDisplayRow');
  displayRow.hidden = !reg;
  displayRow.style.display = reg ? '' : 'none';
  $('#authTitle').textContent = reg ? '注册' : '登录';
  $('#authSubmit').textContent = reg ? '注册并进入' : '登录';
  $('#authIntro').textContent = reg
    ? state.auth?.firstRun
      ? '第一个注册的账号是管理员。填个名字就能开始派活了。'
      : '注册之后，你建的工单、改的状态、发的评论都会记在你名下。'
    : '这台机器上的工单是几个人共用的。登录后，谁建的、谁改的状态、谁评论的都会留下名字。';
  $('#authForm').password.autocomplete = reg ? 'new-password' : 'current-password';
  $('#authHint').textContent = reg ? '密码至少 6 位，用户名以后改不了。' : '还没有账号？切到「注册」。';
  authError('');
}

function applyAuth(me) {
  state.auth = me ?? { auth: false, user: null, firstRun: false };
  const authed = Boolean(me?.auth && me.user);
  const needsLogin = Boolean(me?.auth && !me.user);
  state.authed = authed;
  document.body.classList.toggle('needs-auth', needsLogin);
  $('#authScreen').hidden = !needsLogin;
  $('#userChip').hidden = !authed;
  $('#logout').hidden = !authed;
  if (authed) {
    const name = me.user.display || me.user.name;
    $('#userName').textContent = name;
    $('#userInitial').textContent = [...name][0]?.toUpperCase() ?? '?';
    $('#userChip').title = `${me.user.name} · ${me.user.role === 'owner' ? '管理员' : '成员'}`;
  }
  if (needsLogin) setAuthMode(me.firstRun ? 'register' : 'login');
  return authed;
}

/** 会话过期时从任何地方掉回登录页。 */
function showAuth() {
  applyAuth({ auth: true, user: null, firstRun: state.auth?.firstRun });
  $('#authForm').name?.focus?.();
}

async function submitAuth(event) {
  event.preventDefault();
  const form = event.target;
  const f = new FormData(form);
  const mode = authMode();
  const payload = { name: String(f.get('name') ?? ''), password: String(f.get('password') ?? '') };
  if (mode === 'register') payload.display = String(f.get('display') ?? '');
  const btn = $('#authSubmit');
  btn.disabled = true;
  authError('');
  try {
    const out = await api(`/api/auth/${mode}`, { method: 'POST', body: JSON.stringify(payload) });
    applyAuth({ auth: true, user: out.user, firstRun: false });
    form.reset();
    await enterBoard();
    hint(mode === 'register' ? `注册好了，欢迎 ${out.user.display}` : `欢迎回来，${out.user.display}`);
  } catch (err) {
    authError(err.message);
  } finally {
    btn.disabled = false;
  }
}

async function logout() {
  await api('/api/auth/logout', { method: 'POST', body: '{}' }).catch(() => {});
  location.reload(); // 重走一遍启动流程，顺便清掉内存里的旧状态
}


// —— 设置 ——
async function openSettings() {
  const { config: cfg, prompts, gate } = await api('/api/settings');
  state.gate = gate ?? { path: '', exists: false };
  $('#gatePath').textContent = gate?.path ?? '—';
  $('#gatePath').title = gate?.exists ? '门禁脚本路径' : '门禁脚本还不存在（重新打开项目会自动创建）';
  $('#statusLabels').innerHTML = (cfg.columns ?? state.statuses)
    .map((s) => `<label>${esc(s)}<input name="status:${esc(s)}" value="${esc(cfg.labels?.statuses?.[s] ?? '')}" /></label>`)
    .join('');
  $('#priorityLabels').innerHTML = [0, 1, 2, 3, 4]
    .map((p) => `<label>P${p}<input name="prio:${p}" value="${esc(cfg.labels?.priorities?.[p] ?? '')}" /></label>`)
    .join('');
  const f = $('#settingsForm');
  const e = cfg.engine ?? {};
  f.runner.value = e.runner ?? 'pi';
  f.sandbox.value = e.sandbox ?? 'workspace-write';
  f.model.value = e.model ?? '';
  f.thinking.value = e.thinking ?? '';
  f.attempts.value = e.attempts ?? 2;
  f.actor.value = e.actor ?? 'ai';
  f.readyLabel.value = e.readyLabel ?? 'ready-for-agent';
  f.gitCommit.checked = e.gitCommit !== false;
  f.autoWatch.checked = e.autoWatch === true;
  f.prompt_execute.value = prompts?.execute ?? '';
  f.prompt_review.value = prompts?.review ?? '';
  $('#settingsDialog').showModal();
}

async function saveSettings(event) {
  event.preventDefault();
  const f = new FormData(event.target);
  const payload = { labels: { statuses: {}, priorities: {} }, engine: {} };
  for (const [key, value] of f.entries()) {
    if (key.startsWith('status:')) payload.labels.statuses[key.slice(7)] = String(value);
    else if (key.startsWith('prio:')) payload.labels.priorities[key.slice(5)] = String(value);
  }
  payload.prompts = {
    execute: String(f.get('prompt_execute') ?? ''),
    review: String(f.get('prompt_review') ?? ''),
  };
  payload.engine = {
    runner: f.get('runner'),
    sandbox: f.get('sandbox'),
    model: String(f.get('model') ?? ''),
    thinking: String(f.get('thinking') ?? ''),
    attempts: Number(f.get('attempts')),
    actor: String(f.get('actor') ?? ''),
    readyLabel: String(f.get('readyLabel') ?? ''),
    gitCommit: f.get('gitCommit') === 'on',
    autoWatch: f.get('autoWatch') === 'on',
  };
  try {
    const saved = await api('/api/settings', { method: 'PUT', body: JSON.stringify(payload) });
    applyConfig({ statuses: saved.config.columns, labels: saved.config.labels, engine: saved.config.engine });
    $('#settingsDialog').close();
    if (document.body.dataset.mode === 'board') await load();
    else if (state.current) await openIssue(state.current.id, { keepTab: true });
    hint('设置已保存');
  } catch (err) {
    hint(`保存失败：${err.message}`, true);
  }
}

// 点卡片 / 列表行 = 打开这张卡的独立地址；标题本身就是链接，中键 / Ctrl 点能开新标签页
$('#board').addEventListener('click', (e) => {
  const sortBtn = e.target.closest('.sort-btn');
  if (sortBtn) {
    toggleSort(sortBtn.dataset.sort);
    return;
  }
  if (e.target.closest('a')) return; // 链接交给浏览器，别抢它的默认行为
  const el = e.target.closest('.card, .list-row');
  if (!el) return;
  location.assign(`/issue/${encodeURIComponent(el.dataset.id)}`);
});
// 卡片可以用键盘打开：Tab 过去，回车 / 空格
$('#board').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest?.('.card');
  if (!el) return;
  e.preventDefault();
  location.assign(`/issue/${encodeURIComponent(el.dataset.id)}`);
});

// —— 拖卡片到别的列 = 改状态 ——
let dragId = null;
const clearDropMarks = () => {
  for (const el of document.querySelectorAll('.card.is-dragging')) el.classList.remove('is-dragging');
  for (const el of document.querySelectorAll('.col.is-drop-target')) el.classList.remove('is-drop-target');
};
$('#board').addEventListener('dragstart', (e) => {
  const el = e.target.closest?.('.card');
  if (!el) return;
  dragId = el.dataset.id;
  el.classList.add('is-dragging');
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragId);
});
$('#board').addEventListener('dragend', () => {
  dragId = null;
  clearDropMarks();
});
$('#board').addEventListener('dragover', (e) => {
  if (!dragId) return;
  const col = e.target.closest?.('.col');
  if (!col) return;
  e.preventDefault(); // 不拦住就不允许松手
  e.dataTransfer.dropEffect = 'move';
  for (const other of document.querySelectorAll('.col.is-drop-target')) if (other !== col) other.classList.remove('is-drop-target');
  col.classList.add('is-drop-target');
});
$('#board').addEventListener('drop', async (e) => {
  if (!dragId) return;
  const col = e.target.closest?.('.col');
  e.preventDefault();
  const id = dragId;
  dragId = null;
  clearDropMarks();
  const status = col?.dataset.status;
  const issue = state.issues.find((i) => i.id === id);
  // 拖回原列、拖到不认识的列：当没发生
  if (!col || !status || !issue || issue.status === status) return;
  const from = statusLabel(issue.status);
  issue.status = status; // 先在本地翻面，手一松就能看到它落到哪一列
  render();
  const ok = await patch({ status }, id);
  hint(ok ? `「${issue.title}」从「${from}」移到「${statusLabel(status)}」` : '改状态失败', !ok);
});
// —— 搜索 / 筛选条 / 预设 ——

$('#q').addEventListener('input', (e) => {
  state.filter.q = e.target.value.trim();
  renderFilterbar();
  clearTimeout(state.qTimer);
  state.qTimer = setTimeout(load, 300);
});

$('#presetChips').addEventListener('click', (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    deletePreset(del.dataset.del);
    return;
  }
  const btn = e.target.closest('[data-preset]');
  if (btn) {
    const preset = allPresets().find((p) => p.id === btn.dataset.preset);
    if (preset) applyPreset(preset);
    return;
  }
  if (e.target.closest('#clearFilter')) applyFilter(emptyFilter());
  else if (e.target.closest('#savePreset')) askPresetName();
});

// 自建的预设双击改名（内置的三条不给改）
$('#presetChips').addEventListener('dblclick', (e) => {
  const btn = e.target.closest('[data-preset]');
  const preset = btn ? (state.prefs.presets ?? []).find((p) => p.id === btn.dataset.preset) : null;
  if (!preset) return;
  const name = window.prompt('给这个预设改个名字', preset.name);
  if (name === null) return;
  const clean = name.trim().slice(0, 30);
  if (!clean) return;
  preset.name = clean;
  savePrefsSoon();
  renderFilterbar();
  hint(`预设改名为「${clean}」`);
});

$('#filterBtn').addEventListener('click', () => openFilterPanel());
$('#colsBtn').addEventListener('click', () => openColsPanel());

$('#filterPanel').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) return closePanels();
  if (e.target.closest('[data-clear]')) {
    applyFilter(emptyFilter());
    closePanels();
    openFilterPanel(); // 重画一次，把勾选状态清干净
  }
});

$('#filterPanel').addEventListener('change', (e) => {
  const box = e.target.closest('input[type="checkbox"][data-field]');
  if (box) {
    const field = box.dataset.field;
    const value = field === 'priority' ? Number(box.value) : box.value;
    const set = new Set(state.filter[field]);
    if (box.checked) set.add(value);
    else set.delete(value);
    state.filter[field] = [...set];
    afterFilterChange();
    return;
  }
  if (e.target.closest('#fPeriod')) {
    const period = e.target.value;
    state.filter.updated.period = period;
    const custom = period === 'custom';
    if ($('#fFrom')) $('#fFrom').disabled = !custom;
    if ($('#fTo')) $('#fTo').disabled = !custom;
    if (!custom) {
      state.filter.updated.from = '';
      state.filter.updated.to = '';
    }
    afterFilterChange();
    return;
  }
  if (e.target.closest('#fFrom') || e.target.closest('#fTo')) {
    state.filter.updated.from = $('#fFrom')?.value ?? '';
    state.filter.updated.to = $('#fTo')?.value ?? '';
    afterFilterChange();
  }
});

// 面板里的关键词和顶栏搜索是同一个条件，两边同步
$('#filterPanel').addEventListener('input', (e) => {
  if (e.target.id !== 'fq') return;
  state.filter.q = e.target.value.trim();
  const q = $('#q');
  if (q) q.value = e.target.value;
  renderFilterbar();
  clearTimeout(state.qTimer);
  state.qTimer = setTimeout(load, 300);
});

$('#colsPanel').addEventListener('change', (e) => {
  const box = e.target.closest('input[data-col]');
  if (!box) return;
  const col = columnPrefs().find((c) => c.id === box.dataset.col);
  if (!col) return;
  col.hidden = !box.checked;
  state.prefs.columns = columnPrefs();
  render();
  savePrefsSoon();
});

$('#colsPanel').addEventListener('click', (e) => {
  if (e.target.closest('[data-close]')) return closePanels();
  if (e.target.closest('[data-reset]')) {
    state.prefs.columns = defaultColumns();
    render();
    closePanels();
    openColsPanel();
    savePrefsSoon();
    hint('列和列宽已恢复默认');
  }
});

// 点面板外面收起（点在按钮上不算，否则一开就关）
document.addEventListener('click', (e) => {
  if (e.target.closest('#filterPanel, #colsPanel, #filterBtn, #colsBtn')) return;
  closePanels();
});

// —— 列表：按住表头拖动换列序，拖右边界改列宽 ——

const COL_MIN_W = 56;
const COL_MAX_W = 720;
let colResize = null;
let colDrag = null;
let suppressClick = false;

// 拖完列序会跟一次 click：在捕获阶段吃掉，不落到排序按钮上
document.addEventListener(
  'click',
  (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.stopPropagation();
    e.preventDefault();
  },
  true,
);

$('#board').addEventListener('pointerdown', (e) => {
  if (e.button !== undefined && e.button !== 0) return;
  // 最右边那一窄条 = 改宽度；表头其余地方按住拖动 = 换列序，点一下 = 排序
  const handle = e.target.closest?.('.col-resizer');
  const th = handle?.closest('th[data-col]');
  if (th) {
    e.preventDefault();
    colResize = { id: th.dataset.col, x: e.clientX, w: th.getBoundingClientRect().width, th, next: null };
    document.body.classList.add('is-col-resizing');
    return;
  }
  const head = e.target.closest?.('th[data-col]');
  if (!head) return;
  colDrag = { from: head.dataset.col, th: head, x: e.clientX, y: e.clientY, moved: false };
});

document.addEventListener('pointermove', (e) => {
  if (colDrag) {
    if (!colDrag.moved && Math.hypot(e.clientX - colDrag.x, e.clientY - colDrag.y) < 5) return;
    if (!colDrag.moved) {
      colDrag.moved = true;
      suppressClick = true; // 松手后浏览器还会补一次 click，别让它顺手排序
      document.body.classList.add('is-col-dragging');
      colDrag.th.classList.add('is-dragging');
      getSelection()?.removeAllRanges(); // 拖动时别把表头文字选中
    }
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('th[data-col]');
    for (const other of document.querySelectorAll('th.is-drop')) if (other !== over) other.classList.remove('is-drop');
    if (over && over !== colDrag.th) over.classList.add('is-drop');
    return;
  }
  if (!colResize) return;
  const next = Math.max(COL_MIN_W, Math.min(COL_MAX_W, Math.round(colResize.w + (e.clientX - colResize.x))));
  colResize.next = next;
  const table = colResize.th.closest('table');
  const index = [...colResize.th.parentElement.children].indexOf(colResize.th);
  // 只改 <col>：表头跟着列走，不用等重画
  const col = table?.querySelectorAll('colgroup col')[index];
  if (col) col.style.width = `${next}px`;
});

document.addEventListener('pointerup', (e) => {
  if (colDrag) {
    const drag = colDrag;
    const over = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('th[data-col]');
    colDrag = null;
    document.body.classList.remove('is-col-dragging');
    drag.th.classList.remove('is-dragging');
    for (const el of document.querySelectorAll('th.is-drop')) el.classList.remove('is-drop');
    // 拖完浏览器可能补一次 click；这一发吃掉，但别让它留到下一次真正的点击
    if (drag.moved) {
      setTimeout(() => {
        suppressClick = false;
      }, 0);
    }
    if (!drag.moved || !over || over === drag.th) return;
    const rect = over.getBoundingClientRect();
    moveColumn(drag.from, over.dataset.col, e.clientX > rect.left + rect.width / 2);
    return;
  }
  if (!colResize) return;
  const { id, next } = colResize;
  colResize = null;
  document.body.classList.remove('is-col-resizing');
  if (!next) return;
  const col = state.prefs.columns.find((c) => c.id === id);
  if (!col) return;
  col.w = next;
  savePrefsSoon();
});

// 双击边界 = 这列恢复默认宽度
$('#board').addEventListener('dblclick', (e) => {
  const handle = e.target.closest?.('.col-resizer');
  if (!handle) return;
  const id = handle.dataset.resize;
  const col = state.prefs.columns.find((c) => c.id === id);
  if (!col) return;
  col.w = COLUMN_BY_ID[id].w;
  render();
  savePrefsSoon();
  hint(`「${COLUMN_BY_ID[id].label}」列宽已恢复默认`);
});

function moveColumn(fromId, toId, after) {
  if (fromId === toId) return;
  const cols = columnPrefs();
  const [moved] = cols.splice(
    cols.findIndex((c) => c.id === fromId),
    1,
  );
  if (!moved) return;
  const at = cols.findIndex((c) => c.id === toId);
  if (at < 0) return;
  cols.splice(after ? at + 1 : at, 0, moved);
  state.prefs.columns = cols;
  render();
  savePrefsSoon();
  hint(`「${COLUMN_BY_ID[moved.id].label}」挪到了「${COLUMN_BY_ID[toId].label}」${after ? '后面' : '前面'}`);
}
$('#viewBoard').addEventListener('click', () => setView('board'));
$('#viewList').addEventListener('click', () => setView('list'));
$('#tabIssue').addEventListener('click', () => showTab('issue'));
$('#tabTrace').addEventListener('click', () => showTab('trace'));
$('#tabSession').addEventListener('click', () => showTab('session'));
$('#sessionTurns').addEventListener('click', (e) => {
  const btn = e.target.closest('.turn-btn');
  if (!btn) return;
  const turn = state.session.turns.find((t) => t.runId === btn.dataset.run && t.phaseKey === btn.dataset.phase);
  if (!turn) return;
  state.session.autoFollow = false; // 人自己选了就别再自动跳
  openTurn(turn);
});
$('#sessionMore').addEventListener('click', () => {
  if (state.session.current && state.session.next != null) fetchTurn(state.session.current, state.session.next);
});
$('#sessionThink').addEventListener('change', applyThinkFilter);
$('#showRaw').addEventListener('click', () => {
  const pre = $('#panelRaw');
  if (!pre.hidden) {
    pre.hidden = true;
    return;
  }
  pre.textContent = JSON.stringify(
    { card: state.current, runs: state.trace?.runs ?? [], journal: state.trace?.journal ?? [] },
    null,
    2,
  );
  pre.hidden = false;
});
$('#panelStatus').addEventListener('change', (e) => patch({ status: e.target.value }));
$('#watch').addEventListener('click', toggleWatch);
$('#panelDispatch').addEventListener('click', dispatchCurrent);
$('#attachPick').addEventListener('click', () => $('#attachFile').click());
$('#attachFile').addEventListener('change', async (e) => {
  await uploadFiles(e.target.files);
  e.target.value = '';
});
$('#issuePage').addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  $('#issuePage').classList.add('dragging');
});
// 文件拖到工单页空白处：拦下来，否则浏览器会直接把页面换成那张图
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  });
}
$('#issuePage').addEventListener('dragleave', () => $('#issuePage').classList.remove('dragging'));
$('#issuePage').addEventListener('drop', async (e) => {
  e.preventDefault();
  $('#issuePage').classList.remove('dragging');
  await uploadFiles(e.dataTransfer?.files);
});
// 键盘：/ 搜索，n 新建，Esc 关面板（都不抢输入框里的键）
document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t?.closest?.('input, textarea, select, [contenteditable="true"]');
  const dialogOpen = $('#create').open || $('#settingsDialog').open || $('#projectDialog').open || $('#lightbox').open;
  if (e.key === 'Escape' && !dialogOpen) closePanels(); // 先收筛选/列面板，别一按就离开页面
  if (e.key === 'Escape' && !dialogOpen && document.body.dataset.mode === 'issue') {
    e.preventDefault();
    location.assign('/');
    return;
  }
  if (typing || dialogOpen || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === '/') {
    e.preventDefault();
    $('#q').focus();
    $('#q').select();
  } else if (e.key === 'n' || e.key === 'N') {
    e.preventDefault();
    $('#create').showModal();
  }
});
$('#issuePage').addEventListener('paste', (e) => {
  const files = pastedFiles(e);
  if (!files.length) return;
  e.preventDefault();
  // 粘贴 = 图是这条评论正文的一部分（md 里一张图一行），不往工单附件里塞
  uploadFiles(files, { insert: true, scope: 'inline' }).catch((err) => hint(`上传失败：${err.message}`, true));
});
$('#panelAttachments').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const holder = btn.closest('[data-stored]');
  const att = state.attachments.find((a) => a.stored === holder?.dataset.stored);
  if (!att) return;
  if (btn.dataset.act === 'insert') return insertComment(`${mdFor(att)} `);
  if (btn.dataset.act === 'delete') {
    if (!window.confirm(`删除附件「${att.name}」？正文/评论里引用它的图片会变成裂图`)) return;
    const res = await fetch(att.url, { method: 'DELETE' });
    if (!res.ok) return hint('删除失败', true);
    await refreshAttachments();
    hint(`已删除 ${att.name}`);
  }
});
// 点图放大：正文、评论、附件缩略图都一样
document.addEventListener('click', (e) => {
  const img = e.target.closest?.('.md-img');
  if (!img) return;
  const src = img.getAttribute('src');
  $('#lightboxImg').src = src;
  const dl = $('#lightboxDownload');
  dl.href = downloadHref(src);
  dl.setAttribute('download', fileNameFromUrl(src));
  $('#lightbox').showModal();
});
$('#lightbox').addEventListener('click', (e) => {
  if (e.target.closest('#lightboxDownload')) return; // 点下载别把弹窗关掉
  $('#lightbox').close();
});
$('#panelPriority').addEventListener('change', (e) => patch({ priority: Number(e.target.value) }));
$('#panelLabelAdd').addEventListener('click', () => {
  const labels = $('#panelLabel')
    .value.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (labels.length) patch({ addLabels: labels });
});
$('#panelCommentSend').addEventListener('click', sendComment);
$('#panelComment').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') sendComment();
});

$('#new').addEventListener('click', () => $('#create').showModal());
$('#createCancel').addEventListener('click', () => $('#create').close());
$('#createForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    const { issue } = await api('/api/issues', {
      method: 'POST',
      body: JSON.stringify({
        title: f.get('title'),
        description: f.get('description'),
        type: f.get('type'),
        priority: Number(f.get('priority')),
        labels: String(f.get('labels') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }),
    });
    e.target.reset();
    $('#create').close();
    await load();
    hint(`已创建 ${issue.id}`);
  } catch (err) {
    hint(`创建失败：${err.message}`, true);
  }
});

$('#settings').addEventListener('click', () => openSettings().catch((err) => hint(err.message, true)));
async function openGate(target) {
  if (!state.gate?.path) return hint('当前项目还没有门禁路径', true);
  try {
    const res = await api('/api/gate/open', { method: 'POST', body: JSON.stringify({ target }) });
    hint(target === 'folder' ? `已在文件管理器里定位：${res.path}` : `已用 ${res.via} 打开：${res.path}`);
  } catch (err) {
    hint(`打不开，手动去改：${state.gate.path}`, true);
    throw err;
  }
}

$('#gateOpen').addEventListener('click', () => openGate('editor').catch((err) => hint(`打不开：${err.message}`, true)));
$('#gateReveal').addEventListener('click', () => openGate('folder').catch((err) => hint(`打不开：${err.message}`, true)));
$('#gateCopy').addEventListener('click', async () => {
  const text = state.gate?.path ?? '';
  if (!text) return hint('当前项目还没有门禁路径', true);
  try {
    await navigator.clipboard.writeText(text);
    hint(`已复制门禁路径：${text}`);
  } catch {
    hint('复制失败，请手动选中上面的路径', true);
  }
});

// 弹窗：点背景或右上角 × 就能关，不必滚到底部找「取消」
for (const dialog of document.querySelectorAll('dialog.dialog')) {
  dialog.addEventListener('click', (e) => {
    if (e.target.closest?.('[data-close]')) {
      dialog.close();
      return;
    }
    // 内容都在 form 里（dialog 自身没有 padding），点到 dialog = 点到背景
    if (e.target === dialog) dialog.close();
  });
}

$('#settingsCancel').addEventListener('click', () => $('#settingsDialog').close());
$('#settingsForm').addEventListener('submit', saveSettings);

// —— 项目切换 ——
function renderRecent(recent = state.project.recent) {
  $('#recentProjects').innerHTML = recent.length
    ? recent.map((d) => `<button type="button" class="recent-item mono" data-dir="${esc(d)}">${esc(d)}</button>`).join('')
    : '<div class="empty">还没有最近打开的项目</div>';
}

async function openProjectDialog() {
  const p = await api('/api/project').catch(() => state.project);
  state.project = { dir: p.dir ?? state.project.dir, recent: p.recent ?? [] };
  renderRecent(state.project.recent);
  $('#projectForm').dir.value = state.project.dir;
  $('#projectDialog').showModal();
}

async function submitProject(event) {
  event.preventDefault();
  const dir = String(new FormData(event.target).get('dir') ?? '').trim();
  try {
    const p = await api('/api/project', { method: 'POST', body: JSON.stringify({ dir }) });
    applyProject(p);
    closePanels();
    // 换项目就清空筛选：上一个项目的「P1」留下来只会让人以为新项目没单
    state.filter = emptyFilter();
    $('#q').value = '';
    await loadPrefs();
    if (document.body.dataset.mode === 'issue') location.assign('/'); // 换了项目，当前这张卡不属于它了
    $('#projectDialog').close();
    await load();
    const created = p.created?.length ? `，补充了 ${p.created.join('、')}` : '';
    hint(`已打开 ${p.dir}${created}`);
  } catch (err) {
    hint(`打开失败：${err.message}`, true);
  }
}

$('#openProject').addEventListener('click', () => openProjectDialog().catch((e) => hint(e.message, true)));
$('#projectCancel').addEventListener('click', () => $('#projectDialog').close());
$('#projectForm').addEventListener('submit', submitProject);
$('#recentProjects').addEventListener('click', (e) => {
  const item = e.target.closest('.recent-item');
  if (item) $('#projectForm').dir.value = item.dataset.dir;
});

// —— 登录页 ——
$('#authTabLogin').addEventListener('click', () => setAuthMode('login'));
$('#authTabRegister').addEventListener('click', () => setAuthMode('register'));
$('#authForm').addEventListener('submit', submitAuth);
$('#logout').addEventListener('click', logout);

/** 登录之后才进看板：这里做的事就是原来的启动流程，只是可以被重复调用。 */
async function enterBoard() {
  document.body.classList.remove('needs-auth');
  state.authed = true;
  await api('/api/project')
    .then((p) => {
      applyProject(p);
      hint(`项目 ${p.dir}`);
    })
    .catch(() => api('/api/meta').then(applyConfig).catch(() => {}));
  await loadPrefs(); // 列/列宽/预设按「人 + 项目」来，换人换项目都是另一套

  const issueId = issueIdFromPath();
  if (issueId) {
    document.body.dataset.mode = 'issue';
    try {
      await openIssue(issueId);
      hint('这张卡可以直接分享：复制地址栏就行');
    } catch (err) {
      hint(`打不开 ${issueId}：${err.message}`, true);
      await showBoard();
    }
  } else {
    await showBoard();
  }
  if (!state.timer) state.timer = setInterval(tick, AUTO_REFRESH_MS);
}

/** 回到看板：收起工单页、断开实时通道。 */
async function showBoard() {
  closeIssueStream();
  sessionClear();
  document.body.dataset.mode = 'board';
  $('#filterbar').hidden = false;
  $('#issuePage').hidden = true;
  state.current = null;
  state.comments = [];
  document.title = '工单看板';
  renderSkeleton();
  await load();
}

(async function boot() {
  applyViewChrome();
  syncViewUrl(state.view);
  let me = { auth: false, user: null, firstRun: false };
  try {
    me = await api('/api/auth/me');
  } catch {
    // 老版本看板没有这个接口：直接进，当作没开登录
  }
  applyAuth(me);
  if (me.auth && !me.user) return; // 停在登录/注册
  await enterBoard();
})();
