// 阶段 4：收尾。提交 → 推送 → 建 PR → 关单；任一步失败就不关单，交给人工。
// 评论只写一句 AI 结论；细节（验证命令、运行目录、原始事件）留在 run.json / 全链路里。
import path from 'node:path';
import * as beads from '../../web/beads.mjs';
import { log } from '../lib.mjs';
import { commitAll, createPr, currentBranch, findOpenPr, isGitRepo, pushBranch, returnToBase } from '../git.mjs';

const rel = (workdir, p) => path.relative(workdir, p).replaceAll('\\', '/');
const oneLine = (text, max = 80) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

const clipBody = (text, max = 3000) => {
  const s = String(text ?? '').trim();
  return s.length > max ? `${s.slice(0, max)}\n\n…（工单正文过长，已截断）` : s;
};

/** PR 正文：工单本身 + 这次交付的落点，足够让 reviewer 不用再回看板找。 */
function prBody({ issue, workdir, runDir, commit, base, branch }) {
  return [
    `工单：${issue.id} — ${issue.title}`,
    '',
    clipBody(issue.body) || '（工单没有正文）',
    '',
    '---',
    `- 分支：${branch} → ${base}`,
    `- 提交：${commit ?? '（无）'}`,
    `- 运行记录：${rel(workdir, runDir)}`,
  ].join('\n');
}

export async function complete({ cfg, workdir, issue, runDir, checks = [], git: card = null }) {
  const opts = cfg.nodes?.complete ?? {};
  const result = { commit: null, push: null, pr: null };
  const fail = (message) => {
    const error = new Error(message);
    error.git = result; // 让 run.mjs 把「做到哪一步」写进 run.json
    throw error;
  };

  const repo = await isGitRepo(workdir);
  if ((opts.push || opts.pr) && !repo) fail('推送 / 创建 PR 需要 git 仓库，但当前项目不是');
  if (opts.commit && !repo) log('不是 git 仓库，跳过提交');

  if (opts.commit && repo) {
    const made = await commitAll(workdir, {
      // trailer 是反查入口：git log --grep='^Card: <id>'
      subject: `${issue.id}: ${issue.title}`,
      body: `Card: ${issue.id}\nRun: ${rel(workdir, runDir)}`,
    });
    if (made.error) fail(made.error);
    result.commit = made.commit;
    if (made.commit) log(`已提交 ${made.commit}`);
    else log('无代码改动，跳过提交');
  }

  const published = Boolean(result.commit) && repo;
  if (opts.push && published) {
    const branch = card?.branch || (await currentBranch(workdir));
    const remote = card?.remote || opts.remote || 'origin';
    if (!branch) fail('推送失败：当前不在任何分支上');
    const pushed = await pushBranch(workdir, { remote, branch });
    result.push = { ok: pushed.ok, remote, branch, error: pushed.ok ? '' : pushed.error };
    if (!pushed.ok) fail(pushed.error);
    log(`已推送 ${remote}/${branch}`);
  }

  if (opts.pr && result.push?.ok) {
    const branch = result.push.branch;
    const base = card?.base || opts.base || 'main';
    const remote = card?.remote || opts.remote || 'origin';
    const existing = await findOpenPr(workdir, branch);
    if (existing) {
      result.pr = { ok: true, url: existing, reused: true };
      log(`PR 已存在，复用 ${existing}`);
    } else {
      const pr = await createPr(workdir, {
        branch,
        base,
        title: `${issue.id}: ${issue.title}`,
        body: prBody({ issue, workdir, runDir, commit: result.commit, base, branch }),
      });
      if (!pr.ok) fail(pr.error);
      result.pr = { ok: true, url: pr.url };
      log(`已创建 PR ${pr.url}`);
    }
    // 成功后回到基准分支；失败会提前抛出，工作区留在 card 分支上方便看现场。
    const back = await returnToBase(workdir, { base, remote });
    if (!back.ok) log(`没能切回 ${base}：${back.error}`);
  }

  const bits = [];
  if (result.commit) bits.push(`提交 ${result.commit}`);
  if (result.push?.ok) bits.push(`推送 ${result.push.branch}`);
  if (result.pr?.url) bits.push(`PR ${result.pr.url}`);
  await beads.updateIssue(issue.id, { status: 'closed' });
  await beads.commentIssue(issue.id, bits.length ? `AI 已完成：${bits.join('，')}。` : 'AI 已完成（无代码改动）。');
  log(`关闭 ${issue.id}`);
  void checks;
  return result;
}

/** 退回：执行失败回 open（可以重派），审查不通过或发布失败留在 in_progress（需要人看）。 */
export async function handback({ issue, reason, status, head = '' }) {
  await beads.updateIssue(issue.id, { status });
  const title = head || (status === 'open' ? 'AI 执行中断，已退回待接' : 'AI 审查未通过，留待人工处理');
  await beads.commentIssue(issue.id, `${title}：${oneLine(reason)}`);
  log(`回退 ${issue.id} → ${status}`);
}
