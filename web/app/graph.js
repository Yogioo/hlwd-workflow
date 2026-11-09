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
  rolled_back: [27, 74],
  needs_human: [63, 74],
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

// 边的坐标必须按画布的真实像素算：原来的 viewBox 是 100x100 + preserveAspectRatio="none"，
// 箭头会被横向拉扁，方向根本看不出来。现在 viewBox = 画布像素尺寸，节点仍用百分比定位。
const TONES = ['idle', 'done', 'live', 'warn', 'bad'];
const GAP = 2; // 线离节点边框的距离
const RADIUS = 10; // 折线的圆角半径
const LANE = 24; // 顶部回边通道之间的间距（容纳一行标签）

const keyOf = (edge) => `${edge.from}->${edge.to}`;
const n1 = (v) => Math.round(v * 10) / 10;

/** 节点相对画布的位置（用 getBoundingClientRect，边框/padding 都不用自己算）。 */
const rectOf = (el, origin) => {
  const r = el.getBoundingClientRect();
  const left = r.left - origin.left;
  const top = r.top - origin.top;
  return { left, top, right: left + r.width, bottom: top + r.height, cx: left + r.width / 2, cy: top + r.height / 2, w: r.width, h: r.height };
};

/** 折线 + 圆角：正交路由比贝塞尔更容易看出这条线从哪来到哪去，标签也才好压在线上。 */
function polyline(points, radius = RADIUS) {
  const pts = points.filter((p, i) => i === 0 || Math.abs(p.x - points[i - 1].x) + Math.abs(p.y - points[i - 1].y) > 0.2);
  if (pts.length < 2) return '';
  let d = `M${n1(pts[0].x)} ${n1(pts[0].y)}`;
  for (let i = 1; i < pts.length - 1; i += 1) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const next = pts[i + 1];
    const l1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const l2 = Math.hypot(next.x - cur.x, next.y - cur.y);
    const rr = Math.min(radius, l1 / 2, l2 / 2);
    const ax = cur.x - ((cur.x - prev.x) / l1) * rr;
    const ay = cur.y - ((cur.y - prev.y) / l1) * rr;
    const bx = cur.x + ((next.x - cur.x) / l2) * rr;
    const by = cur.y + ((next.y - cur.y) / l2) * rr;
    d += ` L${n1(ax)} ${n1(ay)} Q${n1(cur.x)} ${n1(cur.y)} ${n1(bx)} ${n1(by)}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${n1(last.x)} ${n1(last.y)}`;
}

/**
 * 一条边怎么画，返回路径 + 标签位置：
 * - 同行向右：直连，标签在线上方
 * - 同列向下：直连，标签压在线上
 * - 回边（向左）：从源节点上沿出去，走自己的顶部通道，再从目标上沿回来（箭头朝下指进目标）
 * - 落到下一行的终态：从源节点底部下去，横切到终态的侧面（箭头指进侧面）；
 *   横切会穿过别的节点时，改从终端那一行的下面绕过去（收尾失败 → 退回待接）
 */
function edgeGeom(edge, rects, laneOf, entryOf, exitOf, height) {
  const a = rects[edge.from];
  const b = rects[edge.to];
  if (!a || !b) return null;
  const key = keyOf(edge);
  const sx = a.cx + (exitOf.get(key) ?? 0);

  if (Math.abs(a.cy - b.cy) < 6 && b.cx > a.cx) {
    const y = (a.cy + b.cy) / 2;
    return { d: polyline([{ x: a.right + GAP, y }, { x: b.left - GAP, y }]), lx: (a.right + b.left) / 2, ly: y - 13 };
  }

  if (Math.abs(a.cx - b.cx) < 6 && b.cy > a.cy) {
    return { d: polyline([{ x: sx, y: a.bottom + GAP }, { x: b.cx, y: b.top - GAP }]), lx: sx, ly: (a.bottom + b.top) / 2 };
  }

  if (Math.abs(a.cy - b.cy) < 6 && b.cx < a.cx) {
    const lane = laneOf.get(key);
    if (lane == null) return null;
    const ex = b.cx + (entryOf.get(key) ?? 0);
    return {
      d: polyline([
        { x: a.cx, y: a.top - GAP },
        { x: a.cx, y: lane },
        { x: ex, y: lane },
        { x: ex, y: b.top - GAP },
      ]),
      lx: (a.cx + ex) / 2,
      ly: lane,
    };
  }

  if (b.cy > a.cy) {
    const y = b.cy;
    const ex = b.cx > a.cx ? b.left - GAP : b.right + GAP;
    // 横着切过去会不会穿过别的节点（比如从收尾直接横穿到最左边的终态）？
    // 会穿就绕到终端那一行的下面，再多走一段，别把线压在节点上。
    const blocked = Object.entries(rects).some(
      ([id, r]) =>
        id !== edge.from &&
        id !== edge.to &&
        y > r.top &&
        y < r.bottom &&
        Math.min(sx, ex) < r.right &&
        Math.max(sx, ex) > r.left,
    );
    if (!blocked) {
      return { d: polyline([{ x: sx, y: a.bottom + GAP }, { x: sx, y }, { x: ex, y }]), lx: (sx + ex) / 2, ly: y };
    }
    const bottom = Math.max(...Object.values(rects).map((r) => r.bottom));
    const lane = Math.min(height - 16, bottom + 26);
    return {
      d: polyline([
        { x: sx, y: a.bottom + GAP },
        { x: sx, y: lane },
        { x: b.cx, y: lane },
        { x: b.cx, y: b.bottom + GAP },
      ]),
      lx: b.cx + (sx - b.cx) * 0.35,
      ly: lane,
    };
  }
  return null;
}

const nodeSub = (node, mode) => {
  if (mode === 'template') {
    if (node.kind === 'ai') return node.presetName ? `预设 · ${node.presetName}` : '未选预设';
    if (node.id === 'complete') {
      const bits = [node.commit && '提交', node.push && '推送', node.pr && 'PR'].filter(Boolean);
      return bits.length ? bits.join(' · ') : '不发布';
    }
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
  let edgeSvg = null;
  let labelsEl = null;
  let hotEdge = null;
  let raf = 0;
  let lastSig = null;

  /** 节点挂的预设：找不到就像引擎一样回落到第一份（正常配置不会走到这里）。 */
  const presetIdOf = (stage) => {
    const id = String(nodes?.[stage]?.preset ?? '').trim();
    return presets.some((preset) => preset.id === id) ? id : presets[0]?.id ?? '';
  };
  const presetOf = (stage) => presets.find((preset) => preset.id === presetIdOf(stage)) ?? null;

  /** 收尾节点自己的行为：提交 → 推送 → PR，没配过的部分按默认关掉。 */
  const completeOf = () => nodes?.complete ?? {};

  /** 节点上的配置标记：设置页用，来自 config.engine.nodes / presets。 */
  const markPresets = () => {
    if (!graph) return;
    const complete = completeOf();
    for (const node of graph.nodes) {
      const preset = node.stage ? presetOf(node.stage) : null;
      node.presetId = preset?.id ?? '';
      node.presetName = preset?.name ?? '';
      node.commit = node.id === 'complete' ? complete.commit !== false : null;
      node.push = node.id === 'complete' ? complete.push === true : null;
      node.pr = node.id === 'complete' ? complete.pr === true : null;
    }
  };

  /** 按画布像素给边算路径：先量节点，再画线；标签跟着线走，窗口变了重算。 */
  const layout = () => {
    if (!graph || !edgeSvg || !labelsEl) return;
    const base = edgeSvg.getBoundingClientRect();
    if (base.width < 40 || base.height < 40) return; // 面板还藏着，等 ResizeObserver 再画
    hotEdge = null; // 重画会换掉节点，旧的悬停状态跟着作废
    edgeSvg.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
    edgeSvg.setAttribute('preserveAspectRatio', 'none');

    // 节点用百分比定位，边按实际像素画——两边在同一坐标系里，箭头才不会被拉扁
    const rects = {};
    for (const node of graph.nodes) {
      const el = canvas.querySelector(`[data-node="${CSS.escape(node.id)}"]`);
      if (el) rects[node.id] = rectOf(el, base);
    }

    // 回边要走顶部通道：线越多通道越高，每条通道留出一行标签的高度
    const tops = graph.nodes.filter((n) => rects[n.id] && rects[n.id].cy < base.height / 2).map((n) => rects[n.id].top);
    const rowTop = tops.length ? Math.min(...tops) : base.height * 0.2;
    const laneBase = Math.max(14, rowTop - 18);
    const loops = graph.edges
      .filter((e) => {
        const a = rects[e.from];
        const b = rects[e.to];
        return a && b && Math.abs(a.cy - b.cy) < 6 && b.cx < a.cx;
      })
      .sort((e1, e2) => Math.abs(rects[e1.from].cx - rects[e1.to].cx) - Math.abs(rects[e2.from].cx - rects[e2.to].cx));
    const laneOf = new Map();
    loops.forEach((e, i) => laneOf.set(keyOf(e), Math.max(14, laneBase - i * LANE)));

    // 同一个目标收到多条回边时错开进入点：绕得最远的那条走最左边，
    // 它的竖线才不会横穿较短那条的横向通道（反过来就会在目标顶上打叉）。
    const entryOf = new Map();
    const byTo = new Map();
    for (const e of loops) {
      const list = byTo.get(e.to) ?? [];
      list.push(e);
      byTo.set(e.to, list);
    }
    for (const list of byTo.values()) {
      list.forEach((e, i) => entryOf.set(keyOf(e), (list.length - 1 - i - (list.length - 1) / 2) * 26));
    }

    // 一个节点有多条向下的边（收尾 → 需要人处理 / 退回待接）时，出口左右错开：
    // 绕远路的那条走外侧，否则两条线会从同一点出发、再互相横穿。
    const exitOf = new Map();
    const downOf = new Map();
    for (const e of graph.edges) {
      const a = rects[e.from];
      const b = rects[e.to];
      if (!a || !b || b.cy <= a.cy) continue;
      const list = downOf.get(e.from) ?? [];
      list.push(e);
      downOf.set(e.from, list);
    }
    for (const list of downOf.values()) {
      list.sort((e1, e2) => rects[e2.to].cx - rects[e1.to].cx);
      list.forEach((e, i) => exitOf.set(keyOf(e), (i - (list.length - 1) / 2) * 28));
    }

    const defs = TONES.map(
      (tone) =>
        `<marker id="ge-arrow-${tone}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="8" markerHeight="8" markerUnits="userSpaceOnUse" orient="auto"><path class="ge-arrow t-${tone}" d="M0 0L8 4L0 8Z" /></marker>`,
    ).join('');

    labelsEl.textContent = '';
    const shapes = [];
    for (const edge of graph.edges) {
      const g = edgeGeom(edge, rects, laneOf, entryOf, exitOf, base.height);
      if (!g) continue;
      const tone = edge.tone ?? 'idle';
      const kind = edge.kind ? ` ge-${edge.kind}` : '';
      const key = keyOf(edge);
      shapes.push(
        `<g class="ge-group t-${tone}" data-edge="${esc(key)}"><path class="ge${kind} t-${tone}" d="${g.d}" marker-end="url(#ge-arrow-${tone})" /><path class="ge-hit" d="${g.d}" /></g>`,
      );
      if (!edge.label) continue;
      const tag = document.createElement('span');
      tag.className = `ge-tag t-${tone}${kind}`;
      tag.dataset.edge = key;
      tag.style.left = `${g.lx}px`;
      tag.style.top = `${g.ly}px`;
      tag.textContent = edge.label;
      labelsEl.append(tag);
    }
    edgeSvg.innerHTML = `<defs>${defs}</defs>${shapes.join('')}`;
  };

  /** 悬停时把线和它的标签一起点亮：不用猜这段文字属于哪条虚线。 */
  const setHot = (key) => {
    if (key === hotEdge) return;
    for (const el of canvas?.querySelectorAll('[data-edge]') ?? []) {
      if (el.dataset.edge === hotEdge || el.dataset.edge === key) el.classList.toggle('hot', el.dataset.edge === key);
    }
    hotEdge = key ?? null;
  };
  const onPointerMove = (event) => {
    if (!canvas) return;
    const el = event.target.closest?.('[data-edge]');
    setHot(el && canvas.contains(el) ? el.dataset.edge : null);
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

  // 图例只解释线型；方向由箭头表达，不用再写「箭头 = 方向」这种废话
  const legendHtml = `<span class="graph-key"><i class="gk gk-solid"></i>正常流转</span><span class="graph-key"><i class="gk gk-dash"></i>回退 / 失败</span>`;

  const metaHtml = () => {
    if (!graph) return '';
    if (opts.mode === 'template') {
      return `<span class="graph-hint">点节点查看并编辑它自己的提示词和 AI 预设（再点一次收起）。拓扑固定在代码里，不能拖动，也不能连线。</span>${legendHtml}`;
    }
    const bits = [];
    if (graph.outcome) bits.push(`<span class="graph-pill">结局 <b>${esc(graph.outcome)}</b></span>`);
    if (graph.attempt) bits.push(`<span class="graph-pill">第 <b>${graph.attempt}</b> 轮</span>`);
    if (graph.interrupted) bits.push('<span class="graph-pill bad">已中断</span>');
    if (graph.reopened) bits.push('<span class="graph-pill warn">工单已重新打开</span>');
    if (graph.live) bits.push('<span class="graph-pill live">正在跑</span>');
    return (bits.join('') || '<span class="graph-hint">还没有运行记录。这张图就是流程模板。</span>') + legendHtml;
  };

  const render = () => {
    if (!graph) {
      if (canvas) canvas.innerHTML = '';
      if (list) list.innerHTML = '';
      if (meta) meta.innerHTML = '';
      edgeSvg = null;
      labelsEl = null;
      return;
    }
    markPresets();
    hotEdge = null;
    if (canvas) {
      canvas.innerHTML = graph.nodes.map(nodeHtml).join('');
      edgeSvg = document.createElementNS(NS, 'svg');
      edgeSvg.setAttribute('class', 'graph-edges');
      edgeSvg.setAttribute('aria-hidden', 'true');
      labelsEl = document.createElement('div');
      labelsEl.className = 'graph-labels';
      canvas.prepend(labelsEl);
      canvas.prepend(edgeSvg);
      layout();
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
      const pushed = graph.push
        ? (graph.push.ok ? `${graph.push.remote}/${graph.push.branch}` : `失败：${String(graph.push.error ?? '').slice(0, 120)}`)
        : '';
      const pr = graph.pr?.url
        ? `<p class="graph-note">PR：<a href="${esc(graph.pr.url)}" target="_blank" rel="noreferrer">${esc(graph.pr.url)}</a></p>`
        : '';
      return `<section><h4>收尾</h4>${kv([
        ['分支', graph.git?.branch ?? ''],
        ['基于', graph.git?.base ?? ''],
        ['提交', graph.commit || '（无代码改动）'],
        ['推送', pushed],
        ['结局', graph.outcome ?? ''],
      ])}${pr}<p class="graph-note">通过后才提交并关单；这一步不调用模型。</p></section>`;
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
        <div class="graph-actions"><button type="button" class="ghost" data-action="gate">查看脚本</button></div></section>`;
    }
    if (node.id === 'complete') {
      const cur = completeOf();
      return `<section>
        <h4>收尾</h4>
        <label class="chk-line"><input type="checkbox" data-field="commit"${cur.commit ? ' checked' : ''} /> 提交（git add -A + commit）</label>
        <label class="chk-line"><input type="checkbox" data-field="push"${cur.push ? ' checked' : ''} /> 推送到远端（需要先提交）</label>
        <label class="chk-line"><input type="checkbox" data-field="pr"${cur.pr ? ' checked' : ''} /> 创建 PR（需要推送；每张单一条 card/&lt;id&gt; 分支）</label>
        <div class="graph-grid">
          <label class="graph-field">远端<input data-field="remote" value="${esc(cur.remote ?? 'origin')}" maxlength="120" /></label>
          <label class="graph-field">基准分支<input data-field="base" value="${esc(cur.base ?? 'main')}" maxlength="120" /></label>
        </div>
        <p class="graph-note">顺序：提交 → 推送 → PR → 关单。任一步失败都不关单，评论写原因；PR 建好后工作区切回基准分支。</p>
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

  /** 收尾的三个开关有顺序：不提交就推送没意义，不推送就建 PR 没意义。 */
  const wireCompleteForm = () => {
    const commit = drawer.querySelector('[data-field="commit"]');
    const push = drawer.querySelector('[data-field="push"]');
    const pr = drawer.querySelector('[data-field="pr"]');
    if (!commit || !push || !pr) return;
    const sync = () => {
      push.disabled = !commit.checked;
      if (!commit.checked) push.checked = false;
      pr.disabled = !push.checked;
      if (!push.checked) pr.checked = false;
    };
    for (const el of [commit, push, pr]) el.addEventListener('change', sync);
    sync();
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
    if (opts.mode === 'template' && node.id === 'complete') wireCompleteForm();
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
      : {
          nodeId: node.id,
          commit: Boolean(drawer.querySelector('[data-field="commit"]')?.checked),
          push: Boolean(drawer.querySelector('[data-field="push"]')?.checked),
          pr: Boolean(drawer.querySelector('[data-field="pr"]')?.checked),
          remote: drawer.querySelector('[data-field="remote"]')?.value ?? '',
          base: drawer.querySelector('[data-field="base"]')?.value ?? '',
        };
    btn.disabled = true;
    try {
      await opts.onSaveNode?.(payload);
      if (payload.prompt !== undefined) {
        prompts = { ...prompts, [payload.stage]: payload.prompt };
        nodes = { ...nodes, [payload.stage]: { preset: payload.preset } };
      } else {
        nodes = {
          ...nodes,
          complete: {
            commit: payload.commit,
            push: payload.push,
            pr: payload.pr,
            remote: payload.remote,
            base: payload.base,
          },
        };
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
  canvas?.addEventListener('pointermove', onPointerMove);
  canvas?.addEventListener('pointerleave', () => setHot(null));
  // 画布宽度跟着窗口走：节点是百分比，线是像素，尺寸变了必须重画
  const ro = canvas
    ? new ResizeObserver(() => {
        if (raf) return;
        raf = requestAnimationFrame(() => {
          raf = 0;
          layout();
        });
      })
    : null;
  ro?.observe(canvas);
  drawer.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });

  return {
    update(next) {
      // 卡片页每 2s 会拿同一份图来更新：没变就不重画，免得悬停/选中被打断
      const sig = JSON.stringify(next ?? null);
      if (sig === lastSig) return;
      lastSig = sig;
      graph = next;
      if (selected && !graph?.nodes.some((n) => n.id === selected)) close(false);
      render();
    },
    setData({ graph: g, prompts: p, presets: ps, nodes: ns }) {
      if (g) {
        graph = g;
        lastSig = JSON.stringify(g);
      }
      if (p) prompts = p;
      if (ps) presets = ps;
      if (ns) nodes = ns;
      render();
    },
    close,
    destroy() {
      root.removeEventListener('click', onRootClick);
      canvas?.removeEventListener('pointermove', onPointerMove);
      ro?.disconnect();
      if (raf) cancelAnimationFrame(raf);
      close(false);
      graph = null;
    },
  };
}
