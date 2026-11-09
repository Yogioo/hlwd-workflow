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
    // 开箱就有一份预设，两个 AI 节点都挂着它：新项目不会因为「没配模型」跑不起来
    assert.equal(config.engine.presets.length, 1);
    assert.equal(config.engine.presets[0].id, 'default');
    assert.deepEqual(config.engine.nodes, {
      execute: { preset: 'default' },
      review: { preset: 'default' },
      complete: { commit: true, push: false, pr: false, remote: 'origin', base: 'main' },
    });

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
    // 旧的 engine.gitCommit 写成收尾节点自己的配置，不再留全局字段
    assert.equal(saved.engine.nodes.complete.commit, false);
    assert.equal(saved.engine.gitCommit, undefined);
    assert.equal(saved.engine.runner, 'codex');
    assert.equal(saved.engine.autoWatch, true, '看板启动时自动开流水线是个开关，要能存');
    assert.equal(saved.labels.statuses.open, '新建', '未改的字段要保留');

    await assert.rejects(() => saveProjectConfig(dir, { engine: { runner: 'nope' } }), /runner 只能是/);
    await assert.rejects(() => saveProjectConfig(dir, { engine: { attempts: 9 } }), /attempts/);
    await assert.rejects(() => saveProjectConfig(dir, { labels: { statuses: { open: '  ' } } }), /不能为空/);
  });
});

test('engine.presets + nodes：执行和审查各挂一份预设', async () => {
  await withTempProject(async (dir) => {
    await ensureProject(dir);

    const saved = await saveProjectConfig(dir, {
      engine: {
        presets: [
          { id: 'exec', name: '执行 · sonnet', runner: 'pi', model: 'exec-model', thinking: 'high' },
          { id: 'rev', name: '审查 · opus', runner: 'codex', model: 'review-model', thinking: 'low' },
        ],
        nodes: { execute: { preset: 'exec' }, review: { preset: 'rev' } },
      },
    });
    assert.deepEqual(saved.engine.presets.map((p) => p.id), ['exec', 'rev']);
    assert.deepEqual(saved.engine.nodes, {
      execute: { preset: 'exec' },
      review: { preset: 'rev' },
      complete: { commit: true, push: false, pr: false, remote: 'origin', base: 'main' },
    });
    assert.equal(saved.engine.stages, undefined, '旧字段不再写回，读出来也不该有');

    // 只改预设（比如换模型）：节点挂着不动
    const again = await saveProjectConfig(dir, {
      engine: {
        presets: [
          { id: 'exec', name: '执行', runner: 'pi', model: 'other', thinking: '' },
          { id: 'rev', name: '审查', runner: 'codex', model: '', thinking: '' },
        ],
      },
    });
    assert.equal(again.engine.presets[0].model, 'other');
    assert.deepEqual(again.engine.nodes, {
      execute: { preset: 'exec' },
      review: { preset: 'rev' },
      complete: { commit: true, push: false, pr: false, remote: 'origin', base: 'main' },
    });

    // 收尾节点：提交 → 推送 → PR 是一串有顺序的动作，改动下一次运行生效
    const noCommit = await saveProjectConfig(dir, { engine: { nodes: { complete: { commit: false } } } });
    assert.equal(noCommit.engine.nodes.complete.commit, false);
    assert.equal(noCommit.engine.nodes.complete.push, false, '关掉提交，推送必须跟着关');
    assert.equal(noCommit.engine.presets[0].id, 'exec', '改收尾节点不该动预设');

    const publishing = await saveProjectConfig(dir, {
      engine: { nodes: { complete: { commit: true, push: true, pr: true, remote: 'upstream', base: 'develop' } } },
    });
    assert.deepEqual(publishing.engine.nodes.complete, {
      commit: true,
      push: true,
      pr: true,
      remote: 'upstream',
      base: 'develop',
    });

    // 依赖关系：不能跳过前一步开后一步
    await assert.rejects(
      () => saveProjectConfig(dir, { engine: { nodes: { complete: { commit: false, push: true } } } }),
      /推送需要先提交/,
    );
    await assert.rejects(
      () => saveProjectConfig(dir, { engine: { nodes: { complete: { push: false, pr: true } } } }),
      /创建 PR 需要推送/,
    );
    await assert.rejects(
      () => saveProjectConfig(dir, { engine: { nodes: { complete: { remote: '--upload-pack=rm -rf' } } } }),
      /远端 remote/,
    );
    await assert.rejects(
      () => saveProjectConfig(dir, { engine: { nodes: { complete: { base: '' } } } }),
      /基准分支 base/,
    );

    // 新预设可以不带 id：服务端发一个 p-N，页面靠返回值刷新
    const withNew = await saveProjectConfig(dir, {
      engine: { presets: [...again.engine.presets, { name: '新预设', runner: 'pi' }] },
    });
    assert.match(withNew.engine.presets.at(-1).id, /^p-\d+$/);
    assert.equal(withNew.engine.presets.at(-1).name, '新预设');

    // 校验：宁可不保存，也不落坏配置
    await assert.rejects(() => saveProjectConfig(dir, { engine: { presets: [] } }), /至少/);
    await assert.rejects(
      () =>
        saveProjectConfig(dir, {
          engine: {
            presets: [
              { id: 'a', name: 'x', runner: 'pi' },
              { id: 'a', name: 'y', runner: 'pi' },
            ],
          },
        }),
      /id 重复/,
    );
    await assert.rejects(
      () =>
        saveProjectConfig(dir, {
          engine: {
            presets: [
              { id: 'a', name: 'x', runner: 'pi' },
              { id: 'b', name: 'x', runner: 'pi' },
            ],
          },
        }),
      /重名/,
    );
    await assert.rejects(
      () => saveProjectConfig(dir, { engine: { presets: [{ id: 'a', name: 'x', runner: 'nope' }] } }),
      /执行器只能是/,
    );
    await assert.rejects(() => saveProjectConfig(dir, { engine: { nodes: { execute: { preset: 'missing' } } } }), /不存在/);
    await assert.rejects(() => saveProjectConfig(dir, { engine: { nodes: { claim: { preset: 'exec' } } } }), /未知节点/);
    await assert.rejects(() => saveProjectConfig(dir, { engine: { nodes: { execute: { preset: 'exec', model: 'x' } } } }), /不认识字段/);
    await assert.rejects(
      () => saveProjectConfig(dir, { engine: { nodes: { complete: { commit: 'yes' } } } }),
      /true \/ false/,
    );
    await assert.rejects(
      () => saveProjectConfig(dir, { engine: { nodes: { complete: { preset: 'exec' } } } }),
      /不认识字段/,
    );
    // 还挂在节点上的预设删不掉：先换节点，再删
    await assert.rejects(
      () => saveProjectConfig(dir, { engine: { presets: [{ id: 'rev', name: '审查', runner: 'codex', model: '', thinking: '' }] } }),
      /正被执行节点使用/,
    );
  });
});

test('旧配置（engine.stages / 全局模型）读的时候折成预设', async () => {
  await withTempProject(async (dir) => {
    await ensureProject(dir);
    await fs.writeFile(
      path.join(dir, '.hlwd', 'config.json'),
      JSON.stringify({
        engine: {
          runner: 'pi',
          model: 'global-model',
          thinking: 'high',
          gitCommit: false,
          stages: { execute: { model: 'exec-model' } },
        },
      }),
      'utf8',
    );
    const cfg = await readProjectConfig(dir);
    assert.equal(cfg.engine.stages, undefined, '旧字段不再对外暴露');
    assert.equal(cfg.engine.gitCommit, undefined, '旧字段不再对外暴露');
    const byId = Object.fromEntries(cfg.engine.presets.map((p) => [p.id, p]));
    assert.equal(byId.default.model, 'global-model');
    assert.equal(byId.default.thinking, 'high');
    assert.equal(byId['stage-execute'].model, 'exec-model');
    assert.equal(byId['stage-execute'].runner, 'pi');
    assert.deepEqual(cfg.engine.nodes, {
      execute: { preset: 'stage-execute' },
      review: { preset: 'default' },
      complete: { commit: false, push: false, pr: false, remote: 'origin', base: 'main' },
    });
  });
});

test('手改坏的 presets / nodes 读回来也收敛成能跑的形状', async () => {
  await withTempProject(async (dir) => {
    await ensureProject(dir);
    await fs.writeFile(
      path.join(dir, '.hlwd', 'config.json'),
      JSON.stringify({
        engine: {
          presets: [{ id: 'Bad Id', name: 'x' }, { id: 'ok', name: '', runner: 'nope' }, { id: 'ok', name: 'dup' }],
          // 手改出的矛盾组合：不提交却推送、没推送却建 PR，读的时候要折回去
          nodes: {
            execute: { preset: 'gone' },
            review: { preset: 'ok' },
            complete: { commit: false, push: true, pr: true, remote: '-bad', base: '' },
          },
        },
      }),
      'utf8',
    );
    const cfg = await readProjectConfig(dir);
    assert.deepEqual(cfg.engine.presets, [{ id: 'ok', name: 'ok', runner: 'pi', model: '', thinking: '' }]);
    assert.deepEqual(cfg.engine.nodes, {
      execute: { preset: 'ok' },
      review: { preset: 'ok' },
      // 不提交 → 推送/PR 都折回 false；坏的 remote/base 回落到默认
      complete: { commit: false, push: false, pr: false, remote: 'origin', base: 'main' },
    });
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
