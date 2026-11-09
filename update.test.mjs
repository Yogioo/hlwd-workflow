// 工具自更新的测试：全部在临时仓库 + 临时裸远端里跑，不碰真实 checkout。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { applyUpdates, checkUpdates, readStatus } from './update.mjs';

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
};

async function git(cwd, args) {
  const { stdout } = await exec('git', args, { cwd, env: GIT_ENV });
  return stdout.trim();
}

/**
 * 临时工具仓库 + 裸远端 + 同事的 clone。
 * advance() 在同事那边提交并推送，模拟「远端出现新版本」。
 */
async function withRepo(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-update-'));
  const remote = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  const peer = path.join(root, 'peer');
  try {
    await fs.mkdir(work);
    await git(root, ['init', '--bare', '--initial-branch=main', remote]);
    await git(work, ['init', '--initial-branch=main']);
    await fs.writeFile(path.join(work, 'README.md'), 'v1\n', 'utf8');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-m', 'init']);
    await git(work, ['remote', 'add', 'origin', remote]);
    await git(work, ['push', '-u', 'origin', 'main']);
    await git(root, ['clone', remote, peer]);
    const advance = async (text = 'v2') => {
      await fs.writeFile(path.join(peer, 'README.md'), `${text}\n`, 'utf8');
      await git(peer, ['add', '-A']);
      await git(peer, ['commit', '-m', `release ${text}`]);
      await git(peer, ['push', 'origin', 'main']);
    };
    return await fn({ root, remote, work, peer, advance });
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}

test('readStatus：干净仓库、有 upstream、没有落后', async () => {
  await withRepo(async ({ work, remote }) => {
    const status = await readStatus(work);
    assert.equal(status.git, true);
    assert.equal(status.ownRepo, true);
    assert.equal(status.branch, 'main');
    assert.equal(status.remote, 'origin');
    assert.equal(status.upstream, 'origin/main');
    assert.equal(status.dirty, false);
    assert.equal(status.behind, 0);
    assert.equal(status.ahead, 0);
    assert.equal(status.canUpdate, true);
    assert.equal(status.reason, '');
    assert.match(status.commit, /^[0-9a-f]{7,}$/);
    assert.equal(status.date.startsWith('20'), true);
    assert.equal(typeof remote, 'string');
  });
});

test('checkUpdates + applyUpdates：远端有新提交时快进，保留本地文件', async () => {
  await withRepo(async ({ work, advance }) => {
    await advance('v2');
    const checked = await checkUpdates(work);
    assert.equal(checked.error, '');
    assert.equal(checked.repo.behind, 1);
    assert.equal(checked.repo.ahead, 0);
    assert.equal(checked.repo.canUpdate, true);

    const out = await applyUpdates(work);
    assert.equal(out.ok, true);
    assert.equal(out.updated, true);
    assert.notEqual(out.from, out.to);
    assert.equal(out.repo.behind, 0);
    assert.equal(await fs.readFile(path.join(work, 'README.md'), 'utf8'), 'v2\n');
    assert.equal(await git(work, ['log', '-1', '--format=%s']), 'release v2');
  });
});

test('applyUpdates：工作区有未提交改动就拒绝，不覆盖文件', async () => {
  await withRepo(async ({ work, advance }) => {
    await advance('v2');
    await fs.writeFile(path.join(work, 'README.md'), 'my local edit\n', 'utf8');
    const before = await git(work, ['rev-parse', 'HEAD']);

    const out = await applyUpdates(work);
    assert.equal(out.ok, false);
    assert.equal(out.code, 409);
    assert.match(out.error, /未提交的改动/);
    assert.equal(await git(work, ['rev-parse', 'HEAD']), before);
    assert.equal(await fs.readFile(path.join(work, 'README.md'), 'utf8'), 'my local edit\n');
  });
});

test('applyUpdates：本地和远端分叉时拒绝快进，不 reset', async () => {
  await withRepo(async ({ work, advance }) => {
    await fs.writeFile(path.join(work, 'local.txt'), 'local\n', 'utf8');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-m', 'local work']);
    await advance('v2');

    const checked = await checkUpdates(work);
    assert.equal(checked.repo.ahead, 1);
    assert.equal(checked.repo.behind, 1);
    assert.match(checked.repo.reason, /已分叉/);

    const before = await git(work, ['rev-parse', 'HEAD']);
    const out = await applyUpdates(work);
    assert.equal(out.ok, false);
    assert.equal(out.code, 409);
    assert.equal(await git(work, ['rev-parse', 'HEAD']), before);
    assert.equal(await fs.readFile(path.join(work, 'local.txt'), 'utf8'), 'local\n');
  });
});


test('没有 remote：能看本地提交，但拒绝更新并说明原因', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-update-noremote-'));
  try {
    await git(dir, ['init', '--initial-branch=main']);
    await fs.writeFile(path.join(dir, 'README.md'), 'local\n', 'utf8');
    await git(dir, ['add', '-A']);
    await git(dir, ['commit', '-m', 'init']);

    const status = await readStatus(dir);
    assert.equal(status.git, true);
    assert.equal(status.ownRepo, true);
    assert.equal(status.remote, '');
    assert.equal(status.canUpdate, false);
    assert.match(status.reason, /没有配置 git remote/);

    const out = await applyUpdates(dir);
    assert.equal(out.ok, false);
    assert.equal(out.code, 409);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
});

test('不是 git 仓库：状态说清楚，更新直接拒绝', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-update-plain-'));
  try {
    const status = await readStatus(dir);
    assert.equal(status.git, false);
    assert.match(status.reason, /不是 git 仓库|无法自动更新/);

    const out = await applyUpdates(dir);
    assert.equal(out.ok, false);
    assert.equal(out.code, 400);
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
});
