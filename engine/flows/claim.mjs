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

export async function claim({ issue, cfg, note = 'AI 接单（新建 → 开发中），开始执行。' }) {
  // 负责人是人选的，AI 不抢：已经有人负责就保留，没人负责才把自己记上。
  const assignees = issue.assignees?.length ? issue.assignees : [cfg.actor];
  await beads.updateIssue(issue.id, { status: 'in_progress', assignees });
  await beads.commentIssue(issue.id, note);
  log(`接单 ${issue.id} — ${issue.title}`);
  return beads.getIssue(issue.id);
}

export async function claimNext({ cfg }) {
  const [next] = await listCandidates({ cfg });
  return next ? claim({ issue: next, cfg }) : null;
}
