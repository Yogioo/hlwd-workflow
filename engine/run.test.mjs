// engine 入口的行为测试：发布失败后重派，只重跑收尾，不再叫 AI。
// 用真 bd + 真 git（临时仓库 + 裸远端），但不调用任何 agent：重试路径本来就不产 AI 回合。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { ensureProject, saveProjectConfig } from '../project.mjs';
import * as beads from '../web/beads.mjs';

const exec = promisify(execFile);
const RUN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'run.mjs');
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = async (cwd, args) => (await exec('git', args, { cwd, env: GIT_ENV })).stdout.trim();

async function withProject(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-run-'));
  const dir = path.join(root, 'proj');
  const remote = path.join(root, 'origin.git');
  try {
    await fs.mkdir(dir);
    await ensureProject(dir);
    beads.setWorkdir(dir);
    beads.setActor('ai');
    const branch = await git(dir, ['symbolic-ref', '--short', 'HEAD']);
    await git(root, ['init', '--bare', remote]);
    await git(dir, ['remote', 'add', 'origin', remote]);
    await git(dir, ['push', '-u', 'origin', branch]);
    return await fn({ dir, remote, branch });
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

/** 造一份「代码已经写完并提交、只是没推出去」的现场。 */
async function seedPublishFailed({ dir, branch, issue }) {
  await fs.writeFile(path.join(dir, 'done.txt'), 'ai 干的活\n', 'utf8');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '-m', `${issue.id}: 已完成的活`]);
  const commit = await git(dir, ['rev-parse', '--short', 'HEAD']);

  const runId = `${issue.id}-${Date.now()}`;
  const runDir = path.join(dir, '.hlwd', 'runs', runId);
  await fs.mkdir(runDir, { recursive: true });
  await fs.writeFile(
    path.join(runDir, 'run.json'),
    JSON.stringify({
      runId,
      card: { id: issue.id, title: issue.title },
      outcome: 'publish_failed',
      reason: '收尾失败：推送失败：rejected',
      commit,
      git: { branch, base: branch, remote: 'origin' },
      push: { ok: false, remote: 'origin', branch, error: '推送失败：rejected' },
      pr: null,
      attempts: [{ attempt: 1, execute: { ok: true }, gate: { pass: true }, review: { pass: true, checks: [] } }],
      startedAt: new Date(Date.now() - 60000).toISOString(),
      endedAt: new Date().toISOString(),
    }),
    'utf8',
  );
  return { runId, commit };
}

test('发布失败后重派：只重跑收尾，直接推送并交付，不调用 AI', async () => {
  await withProject(async ({ dir, remote, branch }) => {
    await saveProjectConfig(dir, {
      engine: { nodes: { complete: { commit: true, push: true, pr: false, remote: 'origin', base: branch } } },
    });
    const created = await beads.createIssue({ title: '重试发布', description: '', labels: ['ready-for-agent'] });
    const seeded = await seedPublishFailed({ dir, branch, issue: created });
    // 现场是「已接单但没交付」：改回新建，让它能被再派一次
    await beads.updateIssue(created.id, { status: 'open' });

    const { stdout } = await exec(process.execPath, [RUN, '--project', dir, '--id', created.id], {
      cwd: dir,
      env: { ...process.env, WF_NO_REMEMBER: '1' },
      timeout: 120000,
    }).catch((err) => {
      throw new Error(`engine 退出失败：${err.stdout}\n${err.stderr}`);
    });

    assert.match(stdout, /重试发布/);
    // 远端拿到了这次交付，而且上一轮那次提交还在历史里（收尾会把 .beads 之类一起带上，所以不要求同一个 sha）
    const head = await git(remote, ['rev-parse', '--short', branch]);
    await git(remote, ['merge-base', '--is-ancestor', seeded.commit, 'HEAD']);

    const runs = await fs.readdir(path.join(dir, '.hlwd', 'runs'));
    const latest = runs.sort().at(-1);
    const run = JSON.parse(await fs.readFile(path.join(dir, '.hlwd', 'runs', latest, 'run.json'), 'utf8'));
    assert.equal(run.mode, 'publish', '这一趟是发布重试，不是完整运行');
    assert.equal(run.resumedFrom, seeded.runId, '记下是从哪一次接着做的');
    assert.equal(run.attempts.length, 1, '上一轮的执行/审查记录要带过来，看板才画得出流程');
    assert.equal(run.outcome, 'delivered');
    assert.equal(run.push.ok, true);
    assert.equal(run.commit, head, '记的是推出去的那个提交');

    const after = await beads.getIssue(created.id);
    assert.equal(after.issue.status, 'in_progress', '交付后停在开发中，等人工验收');
    assert.match(after.comments.map((c) => c.text).join('\n'), /重试发布/);
    assert.match(after.comments.map((c) => c.text).join('\n'), /等人工验收/);
  });
});
