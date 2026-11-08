// 节点图：只画，不定义拓扑。
// 拓扑由 web/workflow.mjs 的 TOPOLOGY 决定，服务端随卡片 / 设置一起发过来；
// 这里只负责布局、着色、抽屉，以及两种模式的差异：
//   run      卡片页：看这一趟怎么走的（只读 + 看原始产物）
//   template 设置页：点节点改它自己的提示词与模型（拓扑仍然不可连）
const NS = 'http://www.w3.org/2000/svg';

// 布局写死：流程本来就固定，画布也就固定。坐标是百分比（0–100），跟容器宽高走。
const POS = {
  claim: [9, 30],
  execute: [27, 30],
  gate: [45, 30],
  review: [63, 30],
  complete: [80, 30],
  closed: [92, 30],
  rolled_back: [27, 78],
  needs_human: [63, 78],
};

const TONE_TEXT = { ok: '完成', live: '进行中', warn: '需注意', bad: '失败', idle: '未开始' };

const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
const fmtTime = (at) => {
  if (!at) return '—';
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return String(at);
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** 一条边怎么画：横向直连、回边从下面绕、竖向直连、斜向走贝塞尔。 */
function edgeGeom(edge) {
  const a = POS[edge.from];
  const b = POS[edge.to];
  if (!a || !b) return null;
  const [x1, y1] = a;
  const [x2, y2] = b;
  if (Math.abs(y1 - y2) < 0.5 && x2 < x1) {
    const dip = y1 + (edge.from === 'review' ? 44 : 26);
    return { d: `M${x1} ${y1}C${x1} ${dip} ${x2} ${dip} ${x2} ${y2}`, lx: (x1 + x2) / 2, ly: dip - 2 };
  }
  if (Math.abs(y1 - y2) < 0.5) {
    return { d: `M${x1} ${y1}L${x2} ${y2}`, lx: (x1 + x2) / 2, ly: y1 - 2.5 };
  }
  if (Math.abs(x1 - x2) < 0.5) {
    return { d: `M${x1} ${y1}L${x2} ${y2}`, lx: x1 + 2.5, ly: (y1 + y2) / 2 };
  }
  const dip = Math.max(y1, y2) + (y2 > y1 ? 6 : 10);
  return { d: `M${x1} ${y1}C${x1} ${dip} ${x2} ${dip} ${x2} ${y2}`, lx: (x1 + x2) / 2, ly: Math.max(y1, y2) + 6 };
}

const nodeSub = (node, mode) => {
  if (mode === 'template') {
    if (node.kind === 'ai') return node.presetName ? `预设 · ${node.presetName}` : '未选预设';
    if (node.id === 'complete') return node.commit ? '通过后提交' : '不提交';
    return node.kind === 'end' ? '终态' : '不调用模型';
  }
  if (node.count > 1) return `第 ${node.attempt} 轮`;
  if (node.detail) return node.detail;
  if (node.attempt) return `第 ${node.attempt} 轮`;
  return node.tone === 'idle' ? '' : TONE_TEXT[node.tone] ?? '';
};

export function createGraph(root, options = {}) {
  const opts = { mode: 'run', cardId: null, onOpenTurn: null, onSaveNode: null, onOpenGate: null, ...options };
  const canvas = root.querySelector('.graph-canvas');
  const list = root.querySelector('.graph-list');
  const drawer = root.querySelector('.graph-drawer');
  const meta = root.querySelector('.graph-meta');
  let graph = null;
  let prompts = {};
  let presets = [];
  let nodes = {};
  let selected = null;

  /** 节点挂的预设：找不到就像引擎一样回落到第一份（正常配置不会走到这里）。 */
  const presetIdOf = (stage) => {
    const id = String(nodes?.[stage]?.preset ?? '').trim();
    return presets.some((preset) => preset.id === id) ? id : presets[0]?.id ?? '';
  };
  const presetOf = (stage) => presets.find((preset) => preset.id === presetIdOf(stage)) ?? null;

  /** 收尾节点自己的行为：没配过默认提交（和 engine 的老默认一致）。 */
  const commitOf = () => nodes?.complete?.commit !== false;

  /** 节点上的配置标记：设置页用，来自 config.engine.nodes / presets。 */
  const markPresets = () => {
    if (!graph) return;
    for (const node of graph.nodes) {
      const preset = node.stage ? presetOf(node.stage) : null;
      node.presetId = preset?.id ?? '';
      node.presetName = preset?.name ?? '';
      node.commit = node.id === 'complete' ? commitOf() : null;
    }
  };

  const edgeSvg = (edge) => {
    const g = edgeGeom(edge);
    if (!g) return '';
    const cls = `ge ${edge.kind ? `ge-${edge.kind}` : ''} t-${edge.tone ?? 'idle'}`;
    return `<path class="${cls}" d="${g.d}" vector-effect="non-scaling-stroke" />`;
  };

  // 标签不能画在 SVG 里：viewBox 是 100x100 且 preserveAspectRatio="none"，
  // 文字会被横向拉长。用同百分比定位的 HTML 标签，跟着容器走。
  const edgeLabel = (edge) => {
    if (!edge.label || !['retry', 'fail'].includes(edge.kind)) return '';
    const g = edgeGeom(edge);
    if (!g) return '';
    return `<span class="ge-tag t-${edge.tone ?? 'idle'}" style="left:${g.lx}%;top:${g.ly}%">${esc(edge.label)}</span>`;
  };

  const toneOf = (node) => (opts.mode === 'template' ? 'plain' : node.tone ?? 'idle');

  const nodeHtml = (node) => {
    const [x, y] = POS[node.id] ?? [50, 30];
    const count = node.count > 1 ? `<i class="gnode-count">×${node.count}</i>` : '';
    return `<button type="button" draggable="false" class="gnode k-${node.kind} t-${toneOf(node)}${selected === node.id ? ' sel' : ''}"
      data-node="${esc(node.id)}" style="left:${x}%;top:${y}%" title="${esc(node.detail || node.label)}">
      <span class="gnode-name">${esc(node.label)}</span>
      <span class="gnode-sub">${esc(nodeSub(node, opts.mode))}</span>${count}
    </button>`;
  };

  const listHtml = () =>
    (graph?.nodes ?? [])
      .filter((n) => n.kind !== 'end' || (opts.mode === 'run' && n.tone !== 'idle'))
      .map(
        (n) => `<button type="button" class="gl-row t-${toneOf(n)}${selected === n.id ? ' sel' : ''}" data-node="${esc(n.id)}">
          <b>${esc(n.label)}</b><span>${esc(nodeSub(n, opts.mode) || TONE_TEXT[n.tone] || '')}</span>
        </button>`,
      )
      .join('');

  const metaHtml = () => {
    if (!graph) return '';
    if (opts.mode === 'template') {
      return `<span class="graph-hint">点节点查看并编辑它自己的提示词和 AI 预设（再点一次收起）。拓扑固定在代码里，不能拖动，也不能连线。</span>`;
    }
    const bits = [];
    if (graph.outcome) bits.push(`<span class="graph-pill">结局 <b>${esc(graph.outcome)}</b></span>`);
    if (graph.attempt) bits.push(`<span class="graph-pill">第 <b>${graph.attempt}</b> 轮</span>`);
    if (graph.interrupted) bits.push('<span class="graph-pill bad">已中断</span>');
    if (graph.reopened) bits.push('<span class="graph-pill warn">工单已重新打开</span>');
    if (graph.live) bits.push('<span class="graph-pill live">正在跑</span>');
    return bits.join('') || '<span class="graph-hint">还没有运行记录。这张图就是流程模板。</span>';
  };

  const render = () => {
    if (!graph) {
      if (canvas) canvas.innerHTML = '';
      if (list) list.innerHTML = '';
      if (meta) meta.innerHTML = '';
      return;
    }
    markPresets();
    if (canvas) {
      canvas.innerHTML =
        `<svg class="graph-edges" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">` +
        graph.edges.map(edgeSvg).join('') +
        `</svg>` +
        graph.edges.map(edgeLabel).join('') +
        graph.nodes.map(nodeHtml).join('');
    }
    if (list) list.innerHTML = listHtml();
    if (meta) meta.innerHTML = metaHtml();
  };

  // —— 抽屉 ——
  const kv = (pairs) =>
    `<dl class="graph-kv">${pairs
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
      .join('')}</dl>`;

  const engineKv = (engine) => {
    if (!engine) return kv([['执行器', '未记录（这次运行比字段还老）']]);
    return kv([
      ['执行器', engine.runner || '（默认）'],
      ['模型', engine.model || '（默认）'],
      ['思考', engine.thinking || '（默认）'],
    ]);
  };

  const runBody = (node) => {
    if (node.kind === 'end') {
      return `<section><h4>终态</h4>${kv([
        ['结局', graph.outcome ?? ''],
        ['原因', graph.reason ?? ''],
        ['提交', graph.commit ?? ''],
        ['结束', fmtTime(graph.endedAt)],
      ])}</section>`;
    }
    if (node.id === 'claim') {
      return `<section><h4>接单</h4>${kv([
        ['时间', fmtTime(graph.startedAt)],
        ['谁', 'engine（cfg.actor）'],
        ['候选规则', 'open + 可派标签，且没有活跃的 run'],
      ])}<p class="graph-note">接单必然发生：有这张图就说明已经被接走了。</p></section>`;
    }
    if (node.id === 'complete') {
      return `<section><h4>收尾</h4>${kv([
        ['提交', graph.commit || '（无代码改动）'],
        ['结局', graph.outcome ?? ''],
      ])}<p class="graph-note">通过后才提交并关单；这一步不调用模型。</p></section>`;
    }
    if (!node.attempt) {
      return `<section><h4>${esc(node.label)}</h4><p class="graph-note">这一步还没跑到。</p></section>`;
    }
    const info = kv([
      ['轮次', `第 ${node.attempt} 轮`],
      ['耗时', fmtMs(node.ms)],
      ['结论', TONE_TEXT[node.tone] ?? ''],
    ]);
    const engine = node.kind === 'ai' ? engineKv(node.engine) : '';
    const reason = node.reason ? `<pre class="graph-reason">${esc(node.reason)}</pre>` : '';
    const files =
      node.id === 'gate'
        ? `<button type="button" class="ghost" data-action="file" data-name="gate-${node.attempt}.log">看门禁原始日志</button>`
        : node.id === 'execute'
          ? `<button type="button" class="ghost" data-action="file" data-name="prompt-exec-${node.attempt}.md">看渲染后的提示词</button>
             <button type="button" class="ghost" data-action="turn" data-phase="exec" data-attempt="${node.attempt}">打开会话</button>`
          : node.id === 'review'
            ? `<button type="button" class="ghost" data-action="file" data-name="prompt-review-${node.attempt}.md">看渲染后的提示词</button>
               <button type="button" class="ghost" data-action="turn" data-phase="review" data-attempt="${node.attempt}">打开会话</button>`
            : '';
    const checks = node.checks?.length
      ? `<details class="graph-checks"><summary>验证 ${node.checks.length} 条</summary>${node.checks.map((c) => `<div>${esc(c)}</div>`).join('')}</details>`
      : '';
    return `<section><h4>这一轮</h4>${info}${engine}${reason}
      <div class="graph-actions">${files}</div>
      <pre class="graph-file" hidden></pre>${checks}</section>`;
  };

  const templateBody = (node) => {
    if (node.kind === 'end') return `<section><h4>终态</h4><p class="graph-note">这是流程的出口，没有可配置的东西。</p></section>`;
    if (node.id === 'claim') {
      return `<section><h4>接单</h4><p class="graph-note">规则写死在 engine 里：<code>open</code> + 可派标签，且这张卡没有活跃的 run。可派标签去「运行」里改。</p></section>`;
    }
    if (node.id === 'gate') {
      return `<section><h4>门禁</h4><p class="graph-note">门禁是项目里的一个 JS 文件（进版本库），页面不编辑它。</p>
        <div class="graph-actions"><button type="button" class="ghost" data-action="gate">打开脚本</button></div></section>`;
    }
    if (node.id === 'complete') {
      return `<section>
        <h4>收尾</h4>
        <label class="graph-field chk-field">通过后自动提交
          <span class="graph-note">（审查通过才走到这里；关掉就只关单、不动 git）</span>
          <input type="checkbox" data-field="commit"${commitOf() ? ' checked' : ''} />
        </label>
        <p class="graph-note">提交信息由 engine 写（<code>卡片id: 标题</code> + 运行目录 trailer）。改完<strong>下一次运行</strong>生效。</p>
      </section>`;
    }
    const stage = node.stage;
    const cur = presetOf(stage);
    const options = presets
      .map((preset) => `<option value="${esc(preset.id)}"${preset.id === cur?.id ? ' selected' : ''}>${esc(preset.name)}</option>`)
      .join('');
    return `<section>
      <h4>${esc(node.label)}</h4>
      <label class="graph-field">系统提示词 <span class="graph-note">（${stage}.md，清空＝恢复工具自带模板）</span>
        <textarea data-field="prompt" rows="6" spellcheck="false">${esc(prompts[stage] ?? '')}</textarea>
      </label>
      <label class="graph-field">AI 预设 <span class="graph-note">（执行器 / 模型 / 思考强度）</span>
        <select data-field="preset">${options}</select>
      </label>
      <div class="graph-actions">
        <button type="button" class="ghost" data-action="edit-preset">编辑这个预设</button>
        <button type="button" class="ghost" data-action="new-preset">新建预设</button>
      </div>
      <p class="graph-note">保存后<strong>下一次运行</strong>生效；已经在跑的单不受影响。</p>
    </section>`;
  };

  const open = (node) => {
    selected = node.id;
    drawer.hidden = false;
    const chip =
      opts.mode === 'template' ? '' : `<span class="graph-chip t-${node.tone ?? 'idle'}">${TONE_TEXT[node.tone ?? 'idle'] ?? ''}</span>`;
    // 保存按钮固定在页脚：正文再长也不会把它顶出可视区；没有可配项的节点（接单 / 门禁 / 终态）不显示
    const configurable = Boolean(node.stage) || node.id === 'complete';
    const foot =
      opts.mode === 'template' && configurable
        ? `<div class="graph-drawer-foot">
             <button type="button" class="primary" data-action="save">保存这个节点</button>
             <span class="graph-saved" hidden>已保存</span>
           </div>`
        : '';
    drawer.innerHTML = `<header class="graph-drawer-head">
        <div class="graph-drawer-title"><b>${esc(node.label)}</b>${chip}</div>
        <button type="button" class="graph-drawer-x" data-action="close" aria-label="关闭">×</button>
      </header>
      <div class="graph-drawer-body">${opts.mode === 'template' ? templateBody(node) : runBody(node)}</div>${foot}`;
    render();
  };

  const close = (redraw = true) => {
    selected = null;
    drawer.hidden = true;
    drawer.innerHTML = '';
    if (redraw) render();
    return true;
  };

  const loadFile = async (name, pre) => {
    pre.hidden = false;
    pre.textContent = '读取…';
    try {
      const card = typeof opts.cardId === 'function' ? opts.cardId() : opts.cardId;
      const url = `/api/issues/${encodeURIComponent(card)}/runs/${encodeURIComponent(graph.runId)}/file?name=${encodeURIComponent(name)}`;
      const res = await fetch(url, { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      pre.textContent = res.ok ? data.text ?? '' : data.error ?? `读取失败（HTTP ${res.status}）`;
    } catch (err) {
      pre.textContent = `读取失败：${err.message}`;
    }
  };

  const save = async (btn) => {
    const node = graph.nodes.find((n) => n.id === selected);
    const promptEl = drawer.querySelector('[data-field="prompt"]');
    const commitEl = drawer.querySelector('[data-field="commit"]');
    if (!promptEl && !commitEl) return;
    const payload = promptEl
      ? {
          nodeId: node.id,
          stage: node.stage,
          prompt: promptEl.value,
          preset: drawer.querySelector('[data-field="preset"]')?.value ?? '',
        }
      : { nodeId: node.id, commit: Boolean(commitEl.checked) };
    btn.disabled = true;
    try {
      await opts.onSaveNode?.(payload);
      if (payload.prompt !== undefined) {
        prompts = { ...prompts, [payload.stage]: payload.prompt };
        nodes = { ...nodes, [payload.stage]: { preset: payload.preset } };
      } else {
        nodes = { ...nodes, complete: { commit: payload.commit } };
      }
      const ok = drawer.querySelector('.graph-saved');
      if (ok) {
        ok.hidden = false;
        ok.textContent = '已保存';
      }
      render();
    } catch (err) {
      const ok = drawer.querySelector('.graph-saved');
      if (ok) {
        ok.hidden = false;
        ok.textContent = `保存失败：${err.message}`;
        ok.classList.add('bad');
      }
    } finally {
      btn.disabled = false;
    }
  };

  const onRootClick = (event) => {
    const nodeEl = event.target.closest('[data-node]');
    if (nodeEl) {
      // 再点一次同一个节点就收起来：节点的语义是「选中查看」，不是画布上可摆弄的对象
      if (nodeEl.dataset.node === selected) {
        close();
        return;
      }
      const node = graph?.nodes.find((n) => n.id === nodeEl.dataset.node);
      if (node) open(node);
      return;
    }
    // 点画布空白处 = 收起抽屉（不用去找那个小 ×）
    if (event.target.closest('.graph-canvas') && !drawer.hidden) {
      close();
      return;
    }
    const action = event.target.closest('[data-action]');
    if (!action || !drawer.contains(action)) return;
    const kind = action.dataset.action;
    if (kind === 'close') close();
    else if (kind === 'file') loadFile(action.dataset.name, drawer.querySelector('.graph-file'));
    else if (kind === 'turn') opts.onOpenTurn?.({ runId: graph.runId, phaseKey: `${action.dataset.phase}-${action.dataset.attempt}` });
    else if (kind === 'gate') opts.onOpenGate?.();
    else if (kind === 'edit-preset') opts.onEditPreset?.(presetIdOf(graph?.nodes.find((n) => n.id === selected)?.stage));
    else if (kind === 'new-preset') opts.onEditPreset?.('');
    else if (kind === 'save') save(action);
  };

  root.addEventListener('click', onRootClick);
  // 双保险：万一浏览器把按钮当可拖元素，直接掐掉
  root.addEventListener('dragstart', (e) => e.preventDefault());
  drawer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  return {
    update(next) {
      graph = next;
      if (selected && !graph?.nodes.some((n) => n.id === selected)) close(false);
      render();
    },
    setData({ graph: g, prompts: p, presets: ps, nodes: ns }) {
      if (g) graph = g;
      if (p) prompts = p;
      if (ps) presets = ps;
      if (ns) nodes = ns;
      render();
    },
    close,
    destroy() {
      root.removeEventListener('click', onRootClick);
      close(false);
      graph = null;
    },
  };
}
