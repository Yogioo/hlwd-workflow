// 单页看板：只做「看 + 建 + 改状态 + 评论」，全部走 /api/*。
// 状态名、优先级名、AI 配置都来自 config.json（设置弹窗可改）。
import { esc, md } from './markdown.js';

const AUTO_REFRESH_MS = 5000;

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
  filter: { q: '', ready: false },
  dispatching: false,
  watch: { running: false, stopping: false },
  lastWatchError: null,
  attachments: [],
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
  if (state.filter.ready || state.filter.q) return '没有符合当前筛选的单。';
  return (
    {
      open: '没有待接的单。新建一张，或把别的卡拖过来。',
      in_progress: '没有在跑的单。',
      review: '没有等验收的单。',
      closed: '还没有完成的单。',
    }[status] ?? '这里空着。'
  );
};

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

function render() {
  const board = $('#board');
  const prev = new Map();
  for (const el of board.querySelectorAll('.card')) prev.set(el.dataset.id, el.getBoundingClientRect());

  const issues = state.issues.filter((i) => !state.filter.ready || i.labels.includes(state.readyLabel));
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

/** 数据没回来之前先把四条列画出来，不让人对着一片空白的板。 */
function renderSkeleton() {
  const board = $('#board');
  if (board.querySelector('.card')) return;
  board.dataset.loading = '1';
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
    const suffix = state.filter.q ? `（搜索「${state.filter.q}」）` : '';
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

// 面板开了又关、或者换了一张卡时，早先发出的请求回来不能让面板又弹开
let panelToken = 0;

async function openPanel(id, { quiet = false } = {}) {
  const token = ++panelToken;
  const [{ issue, comments }, attachments] = await Promise.all([
    api(`/api/issues/${encodeURIComponent(id)}`),
    api(`/api/issues/${encodeURIComponent(id)}/attachments`)
      .then((d) => d.attachments)
      .catch(() => []),
  ]);
  if (token !== panelToken) return; // 拉数据这期间面板被关了 / 换了别的卡
  const panel = $('#panel');
  const wasHidden = panel.hidden;
  state.current = issue;
  panel.hidden = false;
  panel.dataset.status = issue.status; // 面板顶上那道状态线
  if (wasHidden) requestAnimationFrame(() => panel.classList.add('is-open'));
  $('#panelId').textContent = issue.id;
  $('#panelTitle').textContent = issue.title;
  $('#panelMeta').innerHTML = [
    `<span class="meta-item"><i>类型</i>${esc(issue.type)}</span>`,
    issue.createdBy ? `<span class="meta-item"><i>创建</i>${esc(issue.createdBy)}</span>` : '',
    `<span class="meta-item"><i>负责人</i>${esc(issue.assignee || '—')}</span>`,
    `<span class="meta-item"><i>更新</i>${esc(fmtTime(issue.updated))}</span>`,
    issue.labels.map(chip).join(''),
  ].join('');
  $('#panelStatus').innerHTML = state.statuses
    .map((s) => `<option value="${s}"${s === issue.status ? ' selected' : ''}>${esc(statusLabel(s))}</option>`)
    .join('');
  fillPrioritySelect($('#panelPriority'), issue.priority);
  renderDispatch(issue);
  $('#panelBody').innerHTML = issue.body ? md(issue.body) : '<div class="empty">（无描述）</div>';
  renderAttachments(attachments);
  $('#panelComments').innerHTML =
    comments
      .map(
        (c) =>
          `<div class="comment"><div class="comment-head">${esc(c.author)}<span class="dot">·</span>${esc(fmtTime(c.created))}</div><div class="md">${md(c.text)}</div></div>`,
      )
      .join('') || '<div class="empty">还没有评论</div>';

  if (quiet) return;
  $('#panelLabel').value = '';
  // 全链路是给程序/工程看的，打开才拉数据
  state.trace = null;
  $('#panelTrace').innerHTML = '';
  $('#panelRaw').hidden = true;
  $('#panelRaw').textContent = '';
  showTab('issue');
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
    // 列表/面板后台对齐：不堵按钮（bd 列表 + 评论要一两秒）
    Promise.all([load(), openPanel(saved.id, { quiet: true })]).catch(() => {});
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

function renderAttachments(list) {
  state.attachments = list ?? [];
  $('#attachmentCount').textContent = state.attachments.length ? String(state.attachments.length) : '';
  if (!state.attachments.length) {
    $('#panelAttachments').innerHTML = '<div class="empty">还没有附件（截图、日志、设计图都可以丢进来）</div>';
    return;
  }
  $('#panelAttachments').innerHTML = state.attachments
    .map((a) => {
      const actions = `<button type="button" class="ghost mini" data-act="insert">插入评论</button><button type="button" class="ghost mini" data-act="delete">删除</button>`;
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
  return document.querySelector('.panel-body');
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
    await load();
    if (state.current?.id === id) await openPanel(id, { quiet: true });
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
    await Promise.all([load(), openPanel(state.current.id, { quiet: true })]);
  } catch (e) {
    hint(`评论失败：${e.message}`, true);
  }
}

// —— 自动刷新：看板常刷；面板只在没人输入时悄悄刷新 ——
function panelBusy() {
  const active = document.activeElement;
  return !$('#panel').hidden && (active?.closest?.('#panel') || $('#panelComment').value.trim());
}

async function tick() {
  if (!state.authed) return; // 停在登录页时别空转
  if ($('#create').open || $('#settingsDialog').open) return;
  await load();
  if (!$('#panel').hidden && state.current) {
    if (!$('#viewSession').hidden) refreshTurns(); // 有新的一轮就跟着切
    if (!panelBusy()) await openPanel(state.current.id, { quiet: true }).catch(() => {});
  }
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
  $('#authDisplayRow').hidden = !reg;
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
    await load();
    if (state.current) await openPanel(state.current.id, { quiet: true });
    hint('设置已保存');
  } catch (err) {
    hint(`保存失败：${err.message}`, true);
  }
}

/** 关面板：先播退场动画，真的关掉了才隐藏（否则动画看不到）。 */
function closePanel() {
  const panel = $('#panel');
  panelToken += 1; // 作废在飞的刷新
  sessionClear(); // 断开跟着跑的 SSE
  panel.classList.remove('is-open');
  state.current = null;
  state.trace = null;
  setTimeout(() => {
    if (state.current) return; // 280ms 内又点开了别的卡，别把它藏了
    panel.hidden = true;
  }, 280);
}

$('#board').addEventListener('click', (e) => {
  const el = e.target.closest('.card');
  if (el) openPanel(el.dataset.id).catch((err) => hint(err.message, true));
});
// 卡片可以用键盘打开：Tab 过去，回车 / 空格
$('#board').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const el = e.target.closest?.('.card');
  if (!el) return;
  e.preventDefault();
  openPanel(el.dataset.id).catch((err) => hint(err.message, true));
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
$('#q').addEventListener('input', (e) => {
  state.filter.q = e.target.value.trim();
  clearTimeout(state.qTimer);
  state.qTimer = setTimeout(load, 300);
});
$('#readyOnly').addEventListener('change', (e) => {
  state.filter.ready = e.target.checked;
  render();
});
$('#panelClose').addEventListener('click', closePanel);
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
$('#panel').addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  $('#panel').classList.add('dragging');
});
// 文件拖到看板空白处：拦下来，否则浏览器会直接把页面换成那张图
for (const type of ['dragover', 'drop']) {
  document.addEventListener(type, (e) => {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  });
}
$('#panel').addEventListener('dragleave', () => $('#panel').classList.remove('dragging'));
$('#panel').addEventListener('drop', async (e) => {
  e.preventDefault();
  $('#panel').classList.remove('dragging');
  await uploadFiles(e.dataTransfer?.files);
});
// 键盘：/ 搜索，n 新建，Esc 关面板（都不抢输入框里的键）
document.addEventListener('keydown', (e) => {
  const t = e.target;
  const typing = t?.closest?.('input, textarea, select, [contenteditable="true"]');
  const dialogOpen = $('#create').open || $('#settingsDialog').open || $('#projectDialog').open || $('#lightbox').open;
  if (e.key === 'Escape' && !dialogOpen && !$('#panel').hidden) return closePanel();
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
$('#panel').addEventListener('paste', (e) => {
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
  $('#lightboxImg').src = img.getAttribute('src');
  $('#lightbox').showModal();
});
$('#lightbox').addEventListener('click', () => $('#lightbox').close());
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
    $('#projectDialog').close();
    closePanel();
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
  renderSkeleton();
  await load();
  if (!state.timer) state.timer = setInterval(tick, AUTO_REFRESH_MS);
}

(async function boot() {
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
