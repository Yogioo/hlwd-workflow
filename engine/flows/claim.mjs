// 阶段 1：接单。只认「open + ready-for-agent」的单，接完立刻留痕。
import * as beads from '../../web/beads.mjs';
import { log } from '../lib.mjs';

export async function listCandidates({ cfg }) {
  const issues = await beads.listIssues({ status: 'open', ready: true, label: cfg.readyLabel });
  return issues.filter((i) => i.labels.includes(cfg.readyLabel));
}

export async function claimNext({ cfg }) {
  const [next] = await listCandidates({ cfg });
  if (!next) return null;

  await beads.updateIssue(next.id, { status: 'in_progress', assignee: cfg.actor });
  await beads.commentIssue(
    next.id,
    `接单：engine(${cfg.actor} / ${cfg.runner})，open → in_progress。执行中，勿重复派单。`,
  );
  log(`接单 ${next.id} — ${next.title}`);

  return beads.getIssue(next.id);
}
