// 工作流进度：由 engine 的 run.json 派生，不是工单字段。
// 工单只保留 open/closed + 标签；看板和详情页把 run 的当前步骤拼上来。
// 这里不写任何状态：run.json 是运行记录，删掉只会丢追溯，不影响工单成立。

export const WORKFLOW_COLUMNS = [
  { id: 'queued', label: '待接', empty: '没有待接的单。' },
  { id: 'active', label: '执行中', empty: '没有在跑的单。' },
  { id: 'review', label: '审查中', empty: '没有在审查的单。' },
  { id: 'done', label: '已完成', empty: '还没有完成的单。' },
];

export const WORKFLOW_ORDER = Object.fromEntries(WORKFLOW_COLUMNS.map((c, i) => [c.id, i]));

const phase = (column, label, tone, { detail = '', active = false, run = null, attempt = null } = {}) => ({
  column,
  phase: label,
  label,
  tone,
  detail,
  active,
  runId: run?.runId ?? null,
  startedAt: run?.startedAt ?? null,
  endedAt: run?.endedAt ?? null,
  attempt,
});

/** 进程还在不在：看板据此把「执行中」和「已中断」分开。 */
export const alive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** 没有 run 时，用工单自己的开关（open/closed）和旧状态兜底。 */
function fromIssue(issue) {
  if (issue.status === 'closed') return phase('done', '已完成', 'ok');
  if (issue.status === 'review') return phase('review', '审查中', 'live', { active: true });
  if (issue.status === 'in_progress') return phase('active', '执行中', 'live', { active: true });
  return phase('queued', '待接', 'idle');
}

/**
 * 当前进度：优先信最新一次 run；没有 run 才看工单开关。
 * @param {object} issue
 * @param {object|null} run 最新一次 run.json
 */
export function workflowOf(issue, run) {
  if (!run) return fromIssue(issue);

  const attempts = Array.isArray(run.attempts) ? run.attempts : [];
  const last = attempts[attempts.length - 1];
  const n = last?.attempt ?? attempts.length ?? null;
  const round = n ? `第 ${n} 轮` : '';

  // 人工关单是最终态，不能被上一次 run 的 running 覆盖。
  if (issue.status === 'closed') {
    return phase('done', '已完成', 'ok', {
      detail: run.outcome === 'running' ? 'AI 仍在跑，但工单已被人工关闭' : run.commit ? `提交 ${run.commit}` : '',
      run,
      attempt: n || null,
    });
  }

  // 上一次已经完成，但工单被重新打开了：回到待接，别再显示「已完成」。
  if (run.outcome === 'closed') {
    return phase('queued', '待接', 'idle', { detail: '上次已完成，重新打开后待接', run, attempt: n || null });
  }

  if (run.outcome === 'running') {
    // 新 run 会写 pid；进程不在了就别假装还在跑。
    if (run.pid && !alive(run.pid)) {
      const column = issue.status === 'open' ? 'queued' : 'active';
      return phase(column, '已中断', 'bad', { detail: 'engine 进程已经不在了，需要重派', run, attempt: n });
    }
    const review = last?.review;
    if (review && review.pass == null) {
      return phase('review', '审查中', 'live', { detail: round, active: true, run, attempt: n });
    }
    const gate = last?.gate;
    if (gate && gate.pass == null) {
      return phase('active', '门禁中', 'live', { detail: round, active: true, run, attempt: n });
    }
    if (gate && gate.pass === false) {
      return phase('active', '门禁未过', 'warn', { detail: `${round} · 正在回炉`, active: true, run, attempt: n });
    }
    const execute = last?.execute;
    if (execute && execute.ok == null) {
      return phase('active', '执行中', 'live', { detail: round, active: true, run, attempt: n });
    }
    if (review && review.pass === false) {
      return phase('active', '审查未过', 'warn', { detail: `${round} · 正在回炉`, active: true, run, attempt: n });
    }
    return phase('active', '已接单', 'live', { detail: round, active: true, run, attempt: n });
  }

  if (run.outcome === 'needs_human') {
    // 人工把工单改回 open = 明确重派；此时别再显示「需要人处理」，否则看起来没生效。
    if (issue.status === 'open') {
      return phase('queued', '上次失败', 'bad', { detail: `${round} · 已重派，等下一轮`, run, attempt: n });
    }
    return phase('active', '需要人处理', 'warn', { detail: `${round} · 看完流程再决定`, run, attempt: n });
  }

  if (run.outcome === 'rolled_back') {
    // 执行失败会回 open（可重派）；审查失败留在 in_progress（需要人看）。
    const column = issue.status === 'open' ? 'queued' : 'active';
    return phase(column, '上次失败', 'bad', { detail: `${round} · 可重试`, run, attempt: n });
  }

  return fromIssue(issue);
}

/** 给前端排序/筛选用的稳定键。 */
export const workflowColumn = (issue) => issue.workflow?.column ?? fromIssue(issue).column;

// —— 节点图 ——
// 拓扑是代码里的常量（真正的装配顺序在 engine/run.mjs），页面只负责画；状态仍然从 run.json 派生。
// 图是投影：删掉它不影响任何工单，也不会多一份真相。拓扑只读——改流程改 engine，不改这里。
export const TOPOLOGY = {
  nodes: [
    { id: 'claim', label: '接单', kind: 'mech' },
    { id: 'execute', label: '执行', kind: 'ai', stage: 'execute' },
    { id: 'gate', label: '门禁', kind: 'mech' },
    { id: 'review', label: '审查', kind: 'ai', stage: 'review' },
    { id: 'complete', label: '收尾', kind: 'mech' },
    { id: 'closed', label: '已关闭', kind: 'end' },
    { id: 'needs_human', label: '需要人处理', kind: 'end' },
    { id: 'rolled_back', label: '退回待接', kind: 'end' },
  ],
  edges: [
    { from: 'claim', to: 'execute' },
    { from: 'execute', to: 'gate', label: '执行成功' },
    { from: 'gate', to: 'review', label: '通过' },
    { from: 'review', to: 'complete', label: '通过' },
    { from: 'complete', to: 'closed' },
    { from: 'execute', to: 'rolled_back', label: '执行失败', kind: 'fail' },
    { from: 'complete', to: 'rolled_back', label: '收尾失败', kind: 'fail' },
    { from: 'gate', to: 'execute', label: '门禁未过', kind: 'retry' },
    { from: 'review', to: 'execute', label: '审查未过', kind: 'retry' },
    { from: 'gate', to: 'needs_human', label: '轮次用尽', kind: 'fail' },
    { from: 'review', to: 'needs_human', label: '轮次用尽', kind: 'fail' },
  ],
};

const TERMINAL_BY_OUTCOME = { closed: 'closed', needs_human: 'needs_human', rolled_back: 'rolled_back' };
const TERMINAL_TONE = { closed: 'ok', needs_human: 'warn', rolled_back: 'bad' };

const clip = (text, max = 60) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/**
 * 这一趟实际走过的节点（按发生顺序）。只读 run.json，不猜。
 * 门禁/审查未过会 continue 到下一轮的「执行」，所以同一个节点可能出现多次。
 */
function trailOf(run) {
  const trail = [{ node: 'claim', attempt: null }];
  for (const a of run.attempts ?? []) {
    trail.push({ node: 'execute', attempt: a.attempt });
    if (!a.execute) return trail; // 记录刚建好、还没开工
    if (a.execute.ok == null) return trail; // 正在执行
    if (a.execute.ok === false) return trail; // 执行失败：终态由 outcome 补
    if (!a.gate) return trail; // 刚跑完执行，门禁还没落记录
    trail.push({ node: 'gate', attempt: a.attempt });
    if (a.gate.pass == null) return trail;
    if (a.gate.pass === false) continue; // 门禁未过：下一轮从执行重来
    if (!a.review) return trail;
    trail.push({ node: 'review', attempt: a.attempt });
    if (a.review.pass == null) return trail;
    if (a.review.pass === false) continue; // 审查未过：下一轮从执行重来
    trail.push({ node: 'complete', attempt: a.attempt });
    return trail; // 收尾只发生一次
  }
  return trail;
}

const STEP_TONE = {
  execute: (rec) => (rec?.execute?.ok == null ? 'live' : rec.execute.ok ? 'ok' : 'bad'),
  gate: (rec) => (rec?.gate?.pass == null ? 'live' : rec.gate.pass ? 'ok' : 'warn'),
  review: (rec) => (rec?.review?.pass == null ? 'live' : rec.review.pass ? 'ok' : 'warn'),
};

const STEP_DETAIL = {
  execute: (rec) => (rec?.execute?.ok === false ? clip(rec.execute.error) : ''),
  gate: (rec) => (rec?.gate?.pass === false ? clip(rec.gate.reason) : ''),
  review: (rec) => (rec?.review?.pass === false ? clip(rec.review.reason) : ''),
};

/**
 * 把一次 run 投影成节点图。没有 run 时返回全 idle 的拓扑——设置页的「模板」就是这个形状。
 * @param {object} issue
 * @param {object|null} run 最新一次 run.json
 */
export function graphOf(issue, run) {
  const nodes = TOPOLOGY.nodes.map((n) => ({
    ...n,
    state: 'idle',
    tone: 'idle',
    detail: '',
    attempt: null,
    count: 0,
    ms: null, // 这一步的耗时（没跑过就是 null）
    engine: null, // 这一步当时生效的 runner/model/thinking（只有 AI 节点有）
    reason: '', // 完整原因：detail 是给徽章的短句，reason 给抽屉看
    checks: [],
  }));
  const edges = TOPOLOGY.edges.map((e) => ({ ...e, tone: 'idle' }));
  const byId = new Map(nodes.map((n) => [n.id, n]));

  if (!run) {
    return { nodes, edges, live: false, interrupted: false, reopened: false, outcome: null, attempt: null, attempts: 0, runId: null, startedAt: null, endedAt: null };
  }

  const attempts = new Map((run.attempts ?? []).map((a) => [a.attempt, a]));
  const trail = trailOf(run);
  const interrupted = run.outcome === 'running' && Boolean(run.pid) && !alive(run.pid);
  const live = run.outcome === 'running' && !interrupted;

  // 终态写在 outcome 里，轨迹里推不出来（轮次用尽 / 收尾失败都是这样）
  const terminal = TERMINAL_BY_OUTCOME[run.outcome] ?? null;
  if (terminal && trail.at(-1)?.node !== terminal) {
    trail.push({ node: terminal, attempt: trail.at(-1)?.attempt ?? null });
  }

  for (const step of trail) {
    const node = byId.get(step.node);
    if (!node) continue;
    node.count += 1;
    node.attempt = step.attempt;
    node.state = 'done';
    if (node.kind === 'end') {
      node.tone = TERMINAL_TONE[node.id] ?? 'idle';
    } else if (STEP_TONE[step.node]) {
      const rec = step.attempt == null ? null : attempts.get(step.attempt);
      const stepRec = rec?.[step.node] ?? null;
      node.tone = STEP_TONE[step.node](rec);
      node.detail = STEP_DETAIL[step.node]?.(rec) ?? '';
      node.ms = stepRec?.ms ?? null;
      node.engine = stepRec?.engine ?? null;
      node.reason = String(
        step.node === 'execute' ? (stepRec?.error ?? '') : step.node === 'gate' ? (stepRec?.reason ?? '') : (stepRec?.reason ?? ''),
      );
      node.checks = Array.isArray(rec?.review?.checks) ? rec.review.checks : [];
    } else {
      node.tone = 'ok';
    }
  }

  // 轨迹最后一个节点就是此刻所在的位置：跑着的是 live，进程没了就是 bad
  const lastNode = byId.get(trail.at(-1)?.node);
  if (lastNode) {
    if (interrupted) {
      lastNode.tone = 'bad';
      lastNode.detail = '已中断：engine 进程不在了';
    } else if (live && lastNode.kind !== 'end') {
      lastNode.state = 'active';
    }
  }

  const touched = new Set();
  for (let i = 1; i < trail.length; i += 1) touched.add(`${trail[i - 1].node}->${trail[i].node}`);
  const lastKey = trail.length > 1 ? `${trail.at(-2).node}->${trail.at(-1).node}` : null;
  for (const edge of edges) {
    const key = `${edge.from}->${edge.to}`;
    if (!touched.has(key)) continue;
    edge.tone = key === lastKey && live ? 'live' : 'done';
  }

  return {
    nodes,
    edges,
    live,
    interrupted,
    // 人工关过又重开：轨迹还是那次完成的，但工单已经不在完成态了
    reopened: issue?.status !== 'closed' && run.outcome === 'closed',
    outcome: run.outcome ?? null,
    attempt: trail.findLast((s) => s.attempt != null)?.attempt ?? null,
    attempts: attempts.size,
    runId: run.runId ?? null,
    reason: run.reason ?? null,
    commit: run.commit ?? null,
    // 收尾发布到哪了：分支、推送、PR（没有就是 null，不猜）
    git: run.git ?? null,
    push: run.push ?? null,
    pr: run.pr ?? null,
    startedAt: run.startedAt ?? null,
    endedAt: run.endedAt ?? null,
  };
}
