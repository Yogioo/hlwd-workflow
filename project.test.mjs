// 项目层的测试：打开目录时补齐 .hlwd/（配置 + 提示词 + 运行目录），配置读写与校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DEFAULT_CONFIG, ensureProject, readProjectConfig, readPrompts, saveProjectConfig, savePrompts } from './project.mjs';

/** 临时"项目"：预建 .beads 目录，避免测试里去 bd init。 */
async function withTempProject(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-project-'));
  await fs.mkdir(path.join(dir, '.beads'), { recursive: true });
  try {
    await fn(dir);
  } finally {
    // bd 的嵌入式 dolt 可能还占着文件，Windows 上会 EBUSY；临时目录删不掉就算了
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}

test('ensureProject 在空目录里建出 .hlwd/、config.json、两份提示词、runs/', async () => {
  await withTempProject(async (dir) => {
    const info = await ensureProject(dir);

    assert.equal(info.dir, path.resolve(dir));
    assert.ok(info.created.includes('.hlwd/'));
    assert.ok(info.created.includes('.hlwd/config.json'));
    assert.ok(info.created.includes('.hlwd/prompts/execute.md'));
    assert.ok(info.created.includes('.hlwd/prompts/review.md'));

    const config = JSON.parse(await fs.readFile(path.join(dir, '.hlwd', 'config.json'), 'utf8'));
    assert.deepEqual(config.columns, DEFAULT_CONFIG.columns);
    assert.equal(config.engine.readyLabel, 'ready-for-agent');

    for (const name of ['execute', 'review']) {
      const text = await fs.readFile(path.join(dir, '.hlwd', 'prompts', `${name}.md`), 'utf8');
      assert.ok(text.includes('{{'), `${name}.md 应该是带占位符的提示词模板`);
    }
    const runs = await fs.stat(path.join(dir, '.hlwd', 'runs'));
    assert.ok(runs.isDirectory());
  });
});

test('ensureProject 不覆盖已有配置与提示词', async () => {
  await withTempProject(async (dir) => {
    await ensureProject(dir);
    await saveProjectConfig(dir, { labels: { statuses: { open: '待认领' } } });
    await savePrompts(dir, { execute: '自定义执行提示词 {{ID}}' });

    const info = await ensureProject(dir);
    assert.equal(info.created.length, 0, '第二次打开不应该再建东西');

    const cfg = await readProjectConfig(dir);
    assert.equal(cfg.labels.statuses.open, '待认领');
    const prompts = await readPrompts(dir);
    assert.equal(prompts.execute, '自定义执行提示词 {{ID}}');
  });
});

test('saveProjectConfig 合并写入并拒绝非法值', async () => {
  await withTempProject(async (dir) => {
    await ensureProject(dir);

    const saved = await saveProjectConfig(dir, {
      labels: { priorities: { 2: '普通' } },
      engine: { attempts: 3, gitCommit: false, runner: 'codex' },
    });
    assert.equal(saved.labels.priorities['2'], '普通');
    assert.equal(saved.engine.attempts, 3);
    assert.equal(saved.engine.gitCommit, false);
    assert.equal(saved.engine.runner, 'codex');
    assert.equal(saved.labels.statuses.open, '待接', '未改的字段要保留');

    await assert.rejects(() => saveProjectConfig(dir, { engine: { runner: 'nope' } }), /runner 只能是/);
    await assert.rejects(() => saveProjectConfig(dir, { engine: { attempts: 9 } }), /attempts/);
    await assert.rejects(() => saveProjectConfig(dir, { labels: { statuses: { open: '  ' } } }), /不能为空/);
  });
});

test('ensureProject 拒绝不存在的目录', async () => {
  await assert.rejects(() => ensureProject(path.join(os.tmpdir(), 'hlwd-不存在-目录-xyz')), /目录不存在/);
});
