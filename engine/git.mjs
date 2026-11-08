// git / gh 外壳：分支、提交、推送、PR。
// 只返回结果，工单状态由调用方（flows）决定；这里不写 beads、不写 run.json。
import { run } from './lib.mjs';

const git = (workdir, args) => run('git', args, { cwd: workdir });
const gh = (workdir, args) => run('gh', args, { cwd: workdir });
const firstLine = (text) => String(text ?? '').split('\n').map((line) => line.trim()).find(Boolean) ?? '';
const failText = (res) => firstLine(res.err) || firstLine(res.out) || `退出码 ${res.code}`;

export async function isGitRepo(workdir) {
  return (await git(workdir, ['rev-parse', '--is-inside-work-tree'])).code === 0;
}

export async function currentBranch(workdir) {
  const res = await git(workdir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return res.code === 0 ? res.out.trim() : '';
}

export async function refExists(workdir, ref) {
  return (await git(workdir, ['rev-parse', '--verify', '--quiet', ref])).code === 0;
}

export async function branchExists(workdir, branch) {
  return (await git(workdir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0;
}

export async function switchBranch(workdir, branch) {
  return git(workdir, ['switch', branch]);
}

/**
 * PR 要求每张单一条分支。接单时调用：
 *   - 从 origin/<base>（优先）或本地 <base> 切 card/<id>；分支已存在就切回去复用。
 *   - 从远端跟踪分支切，避免把本地 base 上没推的提交卷进 PR。
 */
export async function prepareCardBranch({ workdir, issueId, complete }) {
  if (!(await isGitRepo(workdir))) throw new Error('创建 PR 需要 git 仓库，但当前项目不是');
  const remote = complete.remote || 'origin';
  const base = complete.base || 'main';
  const branch = `card/${String(issueId).replace(/[^A-Za-z0-9._-]+/g, '-')}`;
  const start = (await refExists(workdir, `${remote}/${base}`))
    ? `${remote}/${base}`
    : (await refExists(workdir, base))
      ? base
      : '';
  if (!start) throw new Error(`找不到基准分支 ${base}（本地 ${base} 和 ${remote}/${base} 都不存在）`);

  if (await branchExists(workdir, branch)) {
    const res = await switchBranch(workdir, branch);
    if (res.code !== 0) throw new Error(`切到分支 ${branch} 失败：${failText(res)}`);
    return { branch, base, remote, start, reused: true };
  }
  const res = await git(workdir, ['switch', '-c', branch, start]);
  if (res.code !== 0) throw new Error(`创建分支 ${branch} 失败：${failText(res)}`);
  return { branch, base, remote, start, reused: false };
}

/** 提交当前工作区；没有改动返回 commit: null（不算失败）。 */
export async function commitAll(workdir, { subject, body }) {
  await git(workdir, ['add', '-A']);
  const staged = await git(workdir, ['diff', '--cached', '--quiet']);
  if (staged.code === 0) return { commit: null };
  const res = await git(workdir, ['commit', '-m', subject, '-m', body]);
  if (res.code !== 0) return { commit: null, error: `git commit 失败：${failText(res)}` };
  const head = await git(workdir, ['rev-parse', '--short', 'HEAD']);
  return { commit: head.out.trim() };
}

export async function pushBranch(workdir, { remote, branch }) {
  const res = await git(workdir, ['push', '-u', remote, branch]);
  return { ok: res.code === 0, error: res.code === 0 ? '' : `推送 ${branch} 到 ${remote} 失败：${failText(res)}` };
}

/** 建 PR 之前先看有没有同一个 head 的开放 PR：重跑不应重复建。 */
export async function findOpenPr(workdir, branch) {
  const res = await gh(workdir, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--limit', '1']);
  if (res.code !== 0) return null;
  try {
    const list = JSON.parse(res.out);
    return Array.isArray(list) && list[0]?.url ? list[0].url : null;
  } catch {
    return null;
  }
}

async function ghReady(workdir) {
  if ((await gh(workdir, ['--version'])).code !== 0) {
    return { ok: false, error: '找不到 gh：创建 PR 需要 GitHub CLI（gh）' };
  }
  if ((await gh(workdir, ['auth', 'status'])).code !== 0) {
    return { ok: false, error: 'gh 还没有登录：先运行 gh auth login' };
  }
  return { ok: true };
}

export async function createPr(workdir, { branch, base, title, body }) {
  const ready = await ghReady(workdir);
  if (!ready.ok) return { ok: false, error: ready.error };
  const res = await gh(workdir, ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', body]);
  if (res.code !== 0) return { ok: false, error: `创建 PR 失败：${failText(res)}` };
  const url = res.out.split('\n').map((line) => line.trim()).find((line) => /^https?:\/\//.test(line)) ?? '';
  return { ok: true, url: url || res.out.trim() };
}

/** 发布成功后把工作区切回 base；切不回去只是不方便，不影响已完成的交付。 */
export async function returnToBase(workdir, { base, remote }) {
  if (await branchExists(workdir, base)) {
    const res = await switchBranch(workdir, base);
    return { ok: res.code === 0, error: res.code === 0 ? '' : failText(res) };
  }
  if (await refExists(workdir, `${remote}/${base}`)) {
    const res = await git(workdir, ['switch', '-c', base, '--track', `${remote}/${base}`]);
    return { ok: res.code === 0, error: res.code === 0 ? '' : failText(res) };
  }
  return { ok: true };
}
