// 阶段 4：收尾。通过就提交+关闭；不通过就退回 open 并写清楚原因。
import path from 'node:path';
import * as beads from '../../web/beads.mjs';
import { log, run } from '../lib.mjs';

const rel = (workdir, p) => path.relative(workdir, p).replaceAll('\\', '/');

export async function complete({ cfg, workdir, issue, runDir, checks = [] }) {
  let commit = null;
  if (cfg.gitCommit) {
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
  await beads.commentIssue(
    issue.id,
    [
      '审查通过，关闭工单。',
      `- 提交：${commit ?? '无代码改动'}`,
      `- 运行记录：${rel(workdir, path.join(runDir, 'run.json'))}`,
      `- 验证：${checks.length ? checks.join('；') : '审查端未列出验证命令'}`,
    ].join('\n'),
  );
  log(`关闭 ${issue.id}`);
  return commit;
}

/** 退回：执行失败回 open（可以重派），审查不通过留在 in_progress（需要人看）。 */
export async function handback({ issue, runDir, reason, status, workdir }) {
  await beads.updateIssue(issue.id, { status });
  await beads.commentIssue(
    issue.id,
    [
      `engine 回退：in_progress → ${status}`,
      `- 原因：${reason}`,
      `- 运行记录：${rel(workdir, path.join(runDir, 'run.json'))}`,
      status === 'open' ? '- 处理方式：修好环境或提示词后可重新派单。' : '- 处理方式：人工查看运行记录后决定继续改还是重派。',
    ].join('\n'),
  );
  log(`回退 ${issue.id} → ${status}`);
}
