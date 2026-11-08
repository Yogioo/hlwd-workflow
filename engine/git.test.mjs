// git 外壳的测试：分支准备 / 提交 / 推送 / 切回，全部在临时仓库 + 临时裸远端里跑。
// 不测 gh（那是外部服务），PR 的失败分支由 complete 的调用方兜。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { branchExists, commitAll, currentBranch, prepareCardBranch, pushBranch, returnToBase } from './git.mjs';

const exec = promisify(execFile);

/** git 在 Windows 上要靠 user.name/email 才能提交：测试里显式给，不碰全局配置。 */
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};

async function git(cwd, args) {
  const { stdout } = await exec('git', args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

/** 临时工作仓库 + 临时裸远端：origin/main 存在，工作区在 main 上。 */
async function withRepo(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-git-'));
  const remote = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  try {
    await fs.mkdir(work);
    await git(root, ['init', '--bare', '--initial-branch=main', remote]);
    await git(work, ['init', '--initial-branch=main']);
    await fs.writeFile(path.join(work, 'README.md'), 'hello\n', 'utf8');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-m', 'init']);
    await git(work, ['remote', 'add', 'origin', remote]);
    await git(work, ['push', '-u', 'origin', 'main']);
    return await fn({ root, remote, work });
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}

test('prepareCardBranch：从 origin/main 切出 card/<id>，工作区跟着走', async () => {
  await withRepo(async ({ work }) => {
    const got = await prepareCardBranch({ workdir: work, issueId: 'hlwd-abc', complete: { remote: 'origin', base: 'main' } });
    assert.equal(got.branch, 'card/hlwd-abc');
    assert.equal(got.base, 'main');
    assert.equal(got.reused, false);
    assert.equal(await currentBranch(work), 'card/hlwd-abc');
    assert.equal(await branchExists(work, 'card/hlwd-abc'), true);
  });
});

test('prepareCardBranch：分支已存在就复用，不重建', async () => {
  await withRepo(async ({ work }) => {
    await prepareCardBranch({ workdir: work, issueId: 'hlwd-abc', complete: {} });
    await returnToBase(work, { base: 'main', remote: 'origin' });
    const again = await prepareCardBranch({ workdir: work, issueId: 'hlwd-abc', complete: {} });
    assert.equal(again.reused, true);
    assert.equal(await currentBranch(work), 'card/hlwd-abc');
  });
});

test('prepareCardBranch：基准分支不存在时报清楚', async () => {
  await withRepo(async ({ work }) => {
    await assert.rejects(
      () => prepareCardBranch({ workdir: work, issueId: 'hlwd-abc', complete: { base: 'nope' } }),
      /找不到基准分支 nope/,
    );
  });
});

test('commitAll：有改动才提交，没改动返回 null 不算失败', async () => {
  await withRepo(async ({ work }) => {
    const empty = await commitAll(work, { subject: 'x', body: 'y' });
    assert.equal(empty.commit, null);

    await fs.writeFile(path.join(work, 'a.txt'), 'change\n', 'utf8');
    const made = await commitAll(work, { subject: 'hlwd-abc: 标题', body: 'Card: hlwd-abc' });
    assert.match(made.commit, /^[0-9a-f]{7,}$/);
    assert.equal(await git(work, ['log', '-1', '--format=%s']), 'hlwd-abc: 标题');
    assert.match(await git(work, ['log', '-1', '--format=%b']), /Card: hlwd-abc/);
  });
});

test('pushBranch：推到远端后能在 origin 上看到这条分支', async () => {
  await withRepo(async ({ work, remote }) => {
    const { branch } = await prepareCardBranch({ workdir: work, issueId: 'hlwd-push', complete: {} });
    await fs.writeFile(path.join(work, 'b.txt'), 'x\n', 'utf8');
    await commitAll(work, { subject: 'work', body: '' });
    const pushed = await pushBranch(work, { remote: 'origin', branch });
    assert.equal(pushed.ok, true);
    assert.match(await git(remote, ['branch', '--list', branch]), /card\/hlwd-push/);
  });
});

test('returnToBase：成功后能切回 main', async () => {
  await withRepo(async ({ work }) => {
    await prepareCardBranch({ workdir: work, issueId: 'hlwd-back', complete: {} });
    const back = await returnToBase(work, { base: 'main', remote: 'origin' });
    assert.equal(back.ok, true);
    assert.equal(await currentBranch(work), 'main');
  });
});
