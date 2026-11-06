// 单页看板：只做「看 + 建 + 改状态 + 评论」，全部走 /api/*。
const COLUMNS = [
  ['open', '待接'],
  ['in_progress', '执行中'],
  ['review', '待审'],
  ['closed', '已完成'],
];

const $ = (s) => document.querySelector(s);
const state = { issues: [], statuses: COLUMNS.map(([s]) => s), current: null, filter: { q: '', ready: false } };

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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

function card(issue) {
  const labels = issue.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join('');
  return `<article class="card" data-id="${esc(issue.id)}">
    <div class="card-id mono">${esc(issue.id)}</div>
    <div class="card-title">${esc(issue.title)}</div>
    ${labels ? `<div class="chips">${labels}</div>` : ''}
    <div class="card-foot">${esc(issue.type)} · P${esc(issue.priority)} · 💬 ${esc(issue.commentCount)}</div>
  </article>`;
}

function render() {
  const { q, ready } = state.filter;
  const issues = state.issues.filter((i) => {
    if (q && !i.title.toLowerCase().includes(q.toLowerCase()) && !i.id.toLowerCase().includes(q.toLowerCase())) return false;
    if (ready && !i.labels.includes('ready-for-agent')) return false;
    return true;
  });
  $('#board').innerHTML = COLUMNS.map(([status, label]) => {
    const list = issues.filter((i) => i.status === status);
    return `<section class="col">
      <h2>${label} <span class="count">${list.length}</span></h2>
      <div class="col-body">${list.map(card).join('') || '<div class="empty">—</div>'}</div>
    </section>`;
  }).join('');
}

async function load() {
  try {
    const { issues } = await api('/api/issues');
    state.issues = issues;
    render();
    hint(`共 ${issues.length} 张 · ${new Date().toLocaleTimeString()}`);
  } catch (e) {
    hint(`加载失败：${e.message}`, true);
  }
}

async function openPanel(id) {
  const { issue, comments } = await api(`/api/issues/${encodeURIComponent(id)}`);
  state.current = issue;
  $('#panel').hidden = false;
  $('#panelId').textContent = issue.id;
  $('#panelTitle').textContent = issue.title;
  $('#panelMeta').innerHTML = [
    `类型 ${esc(issue.type)}`,
    `负责人 ${esc(issue.assignee || '—')}`,
    `更新 ${esc(issue.updated)}`,
    issue.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join(' '),
  ].join('<span class="dot">·</span>');
  $('#panelStatus').innerHTML = state.statuses
    .map((s) => `<option value="${s}"${s === issue.status ? ' selected' : ''}>${s}</option>`)
    .join('');
  $('#panelPriority').value = issue.priority;
  $('#panelBody').textContent = issue.body || '（无描述）';
  $('#panelLabel').value = '';
  $('#panelComments').innerHTML = comments
    .map((c) => `<div class="comment"><div class="comment-head">${esc(c.author)}<span class="dot">·</span>${esc(c.created)}</div><div class="comment-text">${esc(c.text)}</div></div>`)
    .join('') || '<div class="empty">还没有评论</div>';
}

async function patch(fields) {
  if (!state.current) return;
  try {
    await api(`/api/issues/${encodeURIComponent(state.current.id)}`, {
      method: 'PATCH',
      body: JSON.stringify(fields),
    });
    await Promise.all([load(), openPanel(state.current.id)]);
  } catch (e) {
    hint(`改动失败：${e.message}`, true);
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
    await Promise.all([load(), openPanel(state.current.id)]);
  } catch (e) {
    hint(`评论失败：${e.message}`, true);
  }
}

$('#board').addEventListener('click', (e) => {
  const el = e.target.closest('.card');
  if (el) openPanel(el.dataset.id).catch((err) => hint(err.message, true));
});
$('#refresh').addEventListener('click', load);
$('#q').addEventListener('input', (e) => {
  state.filter.q = e.target.value;
  render();
});
$('#readyOnly').addEventListener('change', (e) => {
  state.filter.ready = e.target.checked;
  render();
});
$('#panelClose').addEventListener('click', () => {
  $('#panel').hidden = true;
  state.current = null;
});
$('#panelStatus').addEventListener('change', (e) => patch({ status: e.target.value }));
$('#panelPriority').addEventListener('change', (e) => patch({ priority: Number(e.target.value) }));
$('#panelLabelAdd').addEventListener('click', () => {
  const labels = $('#panelLabel').value.split(',').map((s) => s.trim()).filter(Boolean);
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
        labels: String(f.get('labels') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
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

api('/api/meta').then((m) => {
  if (Array.isArray(m.statuses) && m.statuses.length) state.statuses = m.statuses;
  hint(`工作区 ${m.workspace}`);
}).catch(() => {});

load();
setInterval(() => {
  if (!$('#create').open && $('#panel').hidden) load();
}, 10000);
