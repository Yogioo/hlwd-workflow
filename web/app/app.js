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
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

function hint(text, isError = false) {
  const el = $('#hint');
  el.textContent = text;
  el.classList.toggle('err', isError);
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

function card(issue) {
  const labels = issue.labels.map(chip).join('');
  return `<article class="card" data-id="${esc(issue.id)}">
    <div class="card-id mono">${esc(issue.id)}</div>
    <div class="card-title">${esc(issue.title)}</div>
    ${labels ? `<div class="chips">${labels}</div>` : ''}
    <div class="card-foot">${esc(issue.type)} · ${esc(prioLabel(issue.priority))} · 💬 ${esc(issue.commentCount)}</div>
  </article>`;
}

function render() {
  const issues = state.issues.filter((i) => !state.filter.ready || i.labels.includes(state.readyLabel));
  $('#board').innerHTML = state.statuses
    .map((status) => {
      const list = issues.filter((i) => i.status === status);
      return `<section class="col">
        <h2>${esc(statusLabel(status))} <span class="count">${list.length}</span></h2>
        <div class="col-body">${list.map(card).join('') || '<div class="empty">—</div>'}</div>
      </section>`;
    })
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
  const w = state.watch ?? { running: false };
  const busy = w.running && w.state === 'running' && w.card;
  btn.textContent = w.stopping
    ? '自动流水线：停止中（点一下强杀）'
    : w.running
      ? `自动流水线：开${busy ? `（${w.card}）` : '（等单）'}`
      : '自动流水线：关';
  btn.classList.toggle('watch-on', Boolean(w.running) && !w.stopping);
  btn.classList.toggle('watch-stopping', Boolean(w.stopping));
  btn.title = w.running
    ? `pid ${w.pid}${w.lastError ? ` · 上次：${w.lastError}` : ''} · 点一下停（跑完手上这张）`
    : `点一下开：有就绪单就自动开干${w.lastError ? ` · 上次：${w.lastError}` : ''}`;
}

async function toggleWatch() {
  const w = state.watch ?? { running: false };
  const action = w.stopping ? 'force' : w.running ? 'stop' : 'start';
  const btn = $('#watch');
  btn.disabled = true;
  btn.textContent = action === 'start' ? '启动中…' : '停止中…';
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

async function openPanel(id, { quiet = false } = {}) {
  const { issue, comments } = await api(`/api/issues/${encodeURIComponent(id)}`);
  state.current = issue;
  $('#panel').hidden = false;
  $('#panelId').textContent = issue.id;
  $('#panelTitle').textContent = issue.title;
  $('#panelMeta').innerHTML = [
    `类型 ${esc(issue.type)}`,
    `负责人 ${esc(issue.assignee || '—')}`,
    `更新 ${esc(issue.updated)}`,
    issue.labels.map(chip).join(' '),
  ].join('<span class="dot">·</span>');
  $('#panelStatus').innerHTML = state.statuses
    .map((s) => `<option value="${s}"${s === issue.status ? ' selected' : ''}>${esc(statusLabel(s))}</option>`)
    .join('');
  fillPrioritySelect($('#panelPriority'), issue.priority);
  renderDispatch(issue);
  $('#panelBody').innerHTML = issue.body ? md(issue.body) : '<div class="empty">（无描述）</div>';
  $('#panelComments').innerHTML =
    comments
      .map(
        (c) =>
          `<div class="comment"><div class="comment-head">${esc(c.author)}<span class="dot">·</span>${esc(c.created)}</div><div class="md">${md(c.text)}</div></div>`,
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
  const isTrace = name === 'trace';
  $('#tabIssue').classList.toggle('active', !isTrace);
  $('#tabTrace').classList.toggle('active', isTrace);
  $('#viewIssue').hidden = isTrace;
  $('#viewTrace').hidden = !isTrace;
  if (isTrace) loadTrace();
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
      steps.push(`<div class="trace-line"><span class="mono">${fmtTime(e.startedAt)}</span> 执行 #${esc(a.attempt)}<span class="dot">·</span>${fmtMs(e.ms)}<span class="dot">·</span>${e.ok ? 'ok' : '<b class="fail">失败</b>'}</div>`);
      if (!e.ok && e.error) steps.push(`<div class="trace-sub">${esc(e.error)}</div>`);

      const g = a.gate;
      if (g) {
        steps.push(`<div class="trace-line"><span class="mono">${fmtTime(g.startedAt)}</span> 门禁 #${esc(a.attempt)}<span class="dot">·</span>${fmtMs(g.ms)}<span class="dot">·</span><b class="${g.pass ? 'pass' : 'fail'}">${g.pass ? 'pass' : 'fail'}</b> ${reasonCell(g.reason)}</div>`);
      }

      const r = a.review;
      if (r) {
        steps.push(`<div class="trace-line"><span class="mono">${fmtTime(r.startedAt)}</span> 审查 #${esc(a.attempt)}<span class="dot">·</span>${fmtMs(r.ms)}<span class="dot">·</span><b class="${r.pass ? 'pass' : 'fail'}">${r.pass ? 'pass' : 'fail'}</b> ${reasonCell(r.reason)}</div>`);
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

async function patch(fields) {
  if (!state.current) return false;
  try {
    await api(`/api/issues/${encodeURIComponent(state.current.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    });
    await Promise.all([load(), openPanel(state.current.id, { quiet: true })]);
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
  if ($('#create').open || $('#settingsDialog').open) return;
  await load();
  if (!$('#panel').hidden && state.current && !panelBusy()) {
    await openPanel(state.current.id, { quiet: true }).catch(() => {});
  }
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

$('#board').addEventListener('click', (e) => {
  const el = e.target.closest('.card');
  if (el) openPanel(el.dataset.id).catch((err) => hint(err.message, true));
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
$('#panelClose').addEventListener('click', () => {
  $('#panel').hidden = true;
  state.current = null;
  state.trace = null;
});
$('#tabIssue').addEventListener('click', () => showTab('issue'));
$('#tabTrace').addEventListener('click', () => showTab('trace'));
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
    $('#panel').hidden = true;
    state.current = null;
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

api('/api/project')
  .then((p) => {
    applyProject(p);
    hint(`项目 ${p.dir}`);
  })
  .catch(() => api('/api/meta').then(applyConfig).catch(() => {}));

load();
setInterval(tick, AUTO_REFRESH_MS);
