// 阶段 1：接单。只认「open + ready-for-agent」的单，接完立刻留痕。
import * as beads from '../../web/beads.mjs';
import { log } from '../lib.mjs';

export async function listCandidates({ cfg }) {
  const issues = await beads.listIssues({ status: 'open', ready: true, label: cfg.readyLabel });
  return issues.filter((i) => i.labels.includes(cfg.readyLabel));
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
