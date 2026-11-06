// 项目层的测试：打开目录时补齐 .hlwd/（配置 + 提示词 + 运行目录），配置读写与校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_CONFIG,
  GATE_TEMPLATE,
  MAX_ATTACHMENT_BYTES,
  attachmentMime,
  attachmentsDir,
  ensureProject,
  gateFile,
  listAttachments,
  readAttachment,
  readProjectConfig,
  readPrompts,
  removeAttachment,
  safeFileName,
  saveAttachment,
  saveProjectConfig,
  savePrompts,
} from './project.mjs';

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

test('ensureProject 在空目录里建出 .hlwd/、config.json、两份提示词、门禁、runs/', async () => {
  await withTempProject(async (dir) => {
    const info = await ensureProject(dir);

    assert.equal(info.dir, path.resolve(dir));
    assert.ok(info.created.includes('.hlwd/'));
    assert.ok(info.created.includes('.hlwd/config.json'));
    assert.ok(info.created.includes('.hlwd/prompts/execute.md'));
    assert.ok(info.created.includes('.hlwd/prompts/review.md'));
    assert.ok(info.created.includes('.hlwd/gate.mjs'));

    const config = JSON.parse(await fs.readFile(path.join(dir, '.hlwd', 'config.json'), 'utf8'));
    assert.deepEqual(config.columns, DEFAULT_CONFIG.columns);
    assert.equal(config.engine.readyLabel, 'ready-for-agent');

    for (const name of ['execute', 'review']) {
      const text = await fs.readFile(path.join(dir, '.hlwd', 'prompts', `${name}.md`), 'utf8');
      assert.ok(text.includes('{{'), `${name}.md 应该是带占位符的提示词模板`);
    }
    const runs = await fs.stat(path.join(dir, '.hlwd', 'runs'));
    assert.ok(runs.isDirectory());

    // 门禁默认是 always true：新建的项目不应该因为门禁被卡住
    assert.equal(await fs.readFile(gateFile(dir), 'utf8'), GATE_TEMPLATE);
    const gate = (await import(`${pathToFileURL(gateFile(dir)).href}?t=${Date.now()}`)).default;
    assert.equal(typeof gate, 'function');
    assert.equal((await gate({ workdir: dir, attempt: 1 })).pass, true);
  });
});

test('ensureProject 不覆盖已有配置、提示词与门禁', async () => {
  await withTempProject(async (dir) => {
    await ensureProject(dir);
    await saveProjectConfig(dir, { labels: { statuses: { open: '待认领' } } });
    await savePrompts(dir, { execute: '自定义执行提示词 {{ID}}' });
    await fs.writeFile(gateFile(dir), 'export default async () => false;\n', 'utf8');

    const info = await ensureProject(dir);
    assert.equal(info.created.length, 0, '第二次打开不应该再建东西');

    const cfg = await readProjectConfig(dir);
    assert.equal(cfg.labels.statuses.open, '待认领');
    const prompts = await readPrompts(dir);
    assert.equal(prompts.execute, '自定义执行提示词 {{ID}}');
    assert.match(await fs.readFile(gateFile(dir), 'utf8'), /export default async \(\) => false/, '用户改过的门禁不能被模板覆盖');
  });
});

test('saveProjectConfig 合并写入并拒绝非法值', async () => {
  await withTempProject(async (dir) => {
    await ensureProject(dir);

    const saved = await saveProjectConfig(dir, {
      labels: { priorities: { 2: '普通' } },
      engine: { attempts: 3, gitCommit: false, runner: 'codex', autoWatch: true },
    });
    assert.equal(saved.labels.priorities['2'], '普通');
    assert.equal(saved.engine.attempts, 3);
    assert.equal(saved.engine.gitCommit, false);
    assert.equal(saved.engine.runner, 'codex');
    assert.equal(saved.engine.autoWatch, true, '看板启动时自动开流水线是个开关，要能存');
    assert.equal(saved.labels.statuses.open, '待接', '未改的字段要保留');

    await assert.rejects(() => saveProjectConfig(dir, { engine: { runner: 'nope' } }), /runner 只能是/);
    await assert.rejects(() => saveProjectConfig(dir, { engine: { attempts: 9 } }), /attempts/);
    await assert.rejects(() => saveProjectConfig(dir, { labels: { statuses: { open: '  ' } } }), /不能为空/);
  });
});

test('ensureProject 拒绝不存在的目录', async () => {
  await assert.rejects(() => ensureProject(path.join(os.tmpdir(), 'hlwd-不存在-目录-xyz')), /目录不存在/);
});

test('附件：存 / 列 / 读 / 删都在项目 .hlwd/attachments 下', async () => {
  await withTempProject(async (dir) => {
    await ensureProject(dir);
    const saved = await saveAttachment(dir, 'hlwd-abc', { name: '截图 1.png', data: Buffer.from('png-bytes') });

    assert.match(saved.stored, /^\d+-截图 1\.png$/);
    assert.equal(saved.name, '截图 1.png');
    assert.equal(saved.kind, 'image');
    assert.ok((await fs.stat(path.join(attachmentsDir(dir, 'hlwd-abc'), saved.stored))).isFile());

    const ignore = await fs.readFile(path.join(dir, '.hlwd', '.gitignore'), 'utf8');
    assert.match(ignore, /attachments\//, '附件目录不进版本库');

    const list = await listAttachments(dir, 'hlwd-abc');
    assert.equal(list.length, 1);
    assert.equal(list[0].size, 9);

    const hit = await readAttachment(dir, 'hlwd-abc', saved.stored);
    assert.equal(hit.data.toString(), 'png-bytes');
    assert.equal(attachmentMime(saved.name), 'image/png');

    assert.equal(await readAttachment(dir, 'hlwd-abc', '../config.json'), null, '不许路径穿越');
    assert.equal(await readAttachment(dir, '../../etc/passwd', saved.stored), null);

    assert.equal(await removeAttachment(dir, 'hlwd-abc', saved.stored), true);
    assert.deepEqual(await listAttachments(dir, 'hlwd-abc'), []);
  });
});

test('附件：粘进评论的图（inline）不算工单附件', async () => {
  await withTempProject(async (dir) => {
    await ensureProject(dir);
    // 拖到面板的 = 工单附件；粘进评论的 = 评论正文的一部分（md 里的图片）
    const cardScope = await saveAttachment(dir, 'hlwd-abc', { name: '设计图.png', data: Buffer.from('a') });
    const inline = await saveAttachment(dir, 'hlwd-abc', { name: '评论里的图.png', data: Buffer.from('b'), scope: 'inline' });
    assert.equal(cardScope.scope, 'card');
    assert.equal(inline.scope, 'inline');

    const list = await listAttachments(dir, 'hlwd-abc');
    assert.deepEqual(
      list.map((f) => f.stored),
      [cardScope.stored],
      '附件列表只剩真正上传的，inline 图不进列表',
    );
    assert.ok(list.length === 1);

    // 字节照样取得到：评论里的 ![x](/api/attachments/…) 得能显示
    const hit = await readAttachment(dir, 'hlwd-abc', inline.stored);
    assert.equal(hit.data.toString(), 'b');

    // 删 inline 图时顺手清旁挂表
    assert.equal(await removeAttachment(dir, 'hlwd-abc', inline.stored), true);
    const scopes = JSON.parse(await fs.readFile(path.join(attachmentsDir(dir, 'hlwd-abc'), '.scopes.json'), 'utf8'));
    assert.deepEqual(scopes, {});
  });
});

test('附件：文件名洗掉路径，空文件与超大文件被拒', async () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('a/b/c.log'), 'c.log');
  assert.equal(safeFileName(''), 'file');
  assert.equal(safeFileName('截图.png'), '截图.png');

  await withTempProject(async (dir) => {
    await ensureProject(dir);
    await assert.rejects(() => saveAttachment(dir, 'x', { name: 'e.txt', data: Buffer.alloc(0) }), /空文件/);
    await assert.rejects(
      () => saveAttachment(dir, 'x', { name: 'big.bin', data: Buffer.alloc(MAX_ATTACHMENT_BYTES + 1) }),
      /太大/,
    );
  });
});
