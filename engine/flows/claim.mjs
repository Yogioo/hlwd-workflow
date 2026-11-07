// 阶段 1：接单。只认「open + ready-for-agent」的单，接完立刻留痕。
import * as beads from '../../web/beads.mjs';
import { latestRun } from '../../web/runs.mjs';
import { workflowOf } from '../../web/workflow.mjs';
import { log } from '../lib.mjs';

export async function listCandidates({ cfg }) {
  const issues = (await beads.listIssues({ status: 'open', ready: true, label: cfg.readyLabel })).filter((i) =>
    i.labels.includes(cfg.readyLabel),
  );
  // 状态锁是 in_progress；但如果有一张卡还停在 open、run 却还活着（人工改回、旧数据），
  // 不要再派一次——看板上的「执行中」和这里必须一致。
  const out = [];
  for (const issue of issues) {
    const wf = workflowOf(issue, await latestRun(issue.id));
    if (!wf.active) out.push(issue);
  }
  return out;
}

export async function claim({ issue, cfg }) {
  await beads.updateIssue(issue.id, { status: 'in_progress', assignee: cfg.actor });
  await beads.commentIssue(issue.id, 'AI 接单，开始执行。');
  log(`接单 ${issue.id} — ${issue.title}`);
  return beads.getIssue(issue.id);
}

export async function claimNext({ cfg }) {
  const [next] = await listCandidates({ cfg });
  return next ? claim({ issue: next, cfg }) : null;
}
