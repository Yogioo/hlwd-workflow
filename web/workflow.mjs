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

const alive = (pid) => {
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
    return phase('active', '需要人处理', 'warn', { detail: `${round} · 看完全链路再决定`, run, attempt: n });
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
