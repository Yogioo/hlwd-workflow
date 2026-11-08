// 阶段 4：收尾。通过就提交+关闭；不通过就退回并写清楚原因。
// 评论只写一句 AI 结论；细节（验证命令、运行目录、原始事件）留在 run.json / 全链路里。
import path from 'node:path';
import * as beads from '../../web/beads.mjs';
import { log, run } from '../lib.mjs';

const rel = (workdir, p) => path.relative(workdir, p).replaceAll('\\', '/');
const oneLine = (text, max = 80) => {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

export async function complete({ cfg, workdir, issue, runDir, checks = [] }) {
  let commit = null;
  // 收尾节点自己的配置：设置 → 流程 → 收尾里勾。没配过（老 run）默认提交。
  const shouldCommit = cfg.nodes?.complete?.commit !== false;
  const isRepo = (await run('git', ['rev-parse', '--is-inside-work-tree'], { cwd: workdir })).code === 0;
  if (shouldCommit && !isRepo) log('不是 git 仓库，跳过提交');
  if (shouldCommit && isRepo) {
    await run('git', ['add', '-A'], { cwd: workdir });
    const staged = await run('git', ['diff', '--cached', '--quiet'], { cwd: workdir });
    if (staged.code !== 0) {
      // trailer 是反查入口：git log --grep='^Card: <id>'
      const trailers = `Card: ${issue.id}\nRun: ${rel(workdir, runDir)}`;
      const res = await run('git', ['commit', '-m', `${issue.id}: ${issue.title}`, '-m', trailers], { cwd: workdir });
      if (res.code !== 0) throw new Error(`git commit 失败：${res.err.trim() || res.out.trim()}`);
      commit = (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: workdir })).out.trim();
      log(`已提交 ${commit}`);
    } else {
      log('无代码改动，跳过提交');
    }
  }

  await beads.updateIssue(issue.id, { status: 'closed' });
  await beads.commentIssue(issue.id, commit ? `AI 已完成并提交 ${commit}。` : 'AI 已完成（无代码改动）。');
  log(`关闭 ${issue.id}`);
  void checks;
  return commit;
}

/** 退回：执行失败回 open（可以重派），审查不通过留在 in_progress（需要人看）。 */
export async function handback({ issue, reason, status }) {
  await beads.updateIssue(issue.id, { status });
  const head = status === 'open' ? 'AI 执行中断，已退回待接' : 'AI 审查未通过，留待人工处理';
  await beads.commentIssue(issue.id, `${head}：${oneLine(reason)}`);
  log(`回退 ${issue.id} → ${status}`);
}
