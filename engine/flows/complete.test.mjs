// 收尾阶段的集成测试：真跑 bd + git，验证「提交 → 推送 → 关单」的顺序与失败不关单。
// 不测 PR（会真的调 gh 去 GitHub 建 PR，不能在测试里做）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { ensureProject } from '../../project.mjs';
import * as beads from '../../web/beads.mjs';
import { complete } from './complete.mjs';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = async (cwd, args) => (await exec('git', args, { cwd, env: GIT_ENV })).stdout.trim();

/** 临时项目：ensureProject 建 .hlwd + .beads（bd init 会顺手 git init 并提交一次），再挂一个裸远端。 */
async function withProject(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-complete-'));
  const dir = path.join(root, 'proj');
  const remote = path.join(root, 'origin.git');
  try {
    await fs.mkdir(dir);
    await ensureProject(dir);
    beads.setWorkdir(dir);
    beads.setActor('ai');
    // bd init 建的仓库分支名取决于本机 git 配置（main / master 都可能），这里用真实分支名。
    const branch = await git(dir, ['symbolic-ref', '--short', 'HEAD']);
    await git(root, ['init', '--bare', remote]);
    await git(dir, ['remote', 'add', 'origin', remote]);
    await git(dir, ['push', '-u', 'origin', branch]);
    return await fn({ dir, remote, branch, runDir: path.join(dir, '.hlwd', 'runs', 'test-run') });
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

const issueOf = async (id) => (await beads.getIssue(id)).issue;

/** 把工作区清干净：engine 的收尾是 git add -A，任何残留（.hlwd / .beads）都会被算进提交。 */
async function syncTree(dir) {
  await git(dir, ['add', '-A']);
  const pending = await exec('git', ['diff', '--cached', '--quiet'], { cwd: dir, env: GIT_ENV }).then(
    () => false,
    () => true,
  );
  if (pending) await git(dir, ['commit', '-m', 'chore: sync']);
}

test('收尾：提交 + 推送 + 关单，评论写明做了哪几步', async () => {
  await withProject(async ({ dir, remote, branch, runDir }) => {
    const created = await beads.createIssue({ title: '收尾测试', description: '正文', labels: ['ready-for-agent'] });
    await fs.writeFile(path.join(dir, 'work.txt'), 'ai 改的东西\n', 'utf8');

    const result = await complete({
      cfg: { nodes: { complete: { commit: true, push: true, pr: false, remote: 'origin', base: branch } } },
      workdir: dir,
      issue: created,
      runDir,
      git: { branch, base: branch, remote: 'origin' },
    });

    assert.match(result.commit, /^[0-9a-f]{7,}$/);
    assert.equal(result.push.ok, true);
    assert.equal(result.pr, null);

    const issue = await issueOf(created.id);
    assert.equal(issue.status, 'closed');
    const comments = (await beads.getIssue(created.id)).comments.map((c) => c.text).join('\n');
    assert.match(comments, new RegExp(`已完成：提交 [0-9a-f]+，推送 ${branch}`));
    // 远端真的收到了这次提交
    assert.equal(await git(remote, ['rev-parse', '--short', branch]), result.commit);
  });
});

test('收尾：推送失败就不关单，错误里带着已经做到的那一步', async () => {
  await withProject(async ({ dir, branch, runDir }) => {
    const created = await beads.createIssue({ title: '推送失败', description: '', labels: ['ready-for-agent'] });
    await fs.writeFile(path.join(dir, 'work.txt'), 'x\n', 'utf8');

    await assert.rejects(
      () =>
        complete({
          cfg: { nodes: { complete: { commit: true, push: true, pr: false, remote: 'nope', base: branch } } },
          workdir: dir,
          issue: created,
          runDir,
          git: { branch, base: branch, remote: 'nope' },
        }),
      (err) => {
        assert.match(err.message, /推送/);
        assert.match(err.git.commit, /^[0-9a-f]{7,}$/, '提交已经做完了，要留在错误上给 run.json');
        assert.equal(err.git.push.ok, false);
        return true;
      },
    );

    const issue = await issueOf(created.id);
    assert.equal(issue.status, 'open', '发布失败不能关单');
  });
});

test('收尾：没有代码改动时不提交也不推送，仍然关单', async () => {
  await withProject(async ({ dir, branch, runDir }) => {
    const created = await beads.createIssue({ title: '没改动', description: '', labels: ['ready-for-agent'] });
    await syncTree(dir); // 建单会顺手改 .beads，先提交掉，才谈得上「没有代码改动」
    const result = await complete({
      cfg: { nodes: { complete: { commit: true, push: true, pr: false, remote: 'origin', base: branch } } },
      workdir: dir,
      issue: created,
      runDir,
      git: { branch, base: branch, remote: 'origin' },
    });
    assert.equal(result.commit, null);
    assert.equal(result.push, null);
    assert.equal((await issueOf(created.id)).status, 'closed');
    const comments = (await beads.getIssue(created.id)).comments.map((c) => c.text).join('\n');
    assert.match(comments, /无代码改动/);
  });
});
