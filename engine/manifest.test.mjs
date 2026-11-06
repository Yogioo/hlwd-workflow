// engine/manifest.mjs 的单元测试：run.json 落盘、journal 追加、finish 收尾记账。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createManifest, finish } from './manifest.mjs';

const issue = { id: 't-1', title: 't', labels: [], priority: 2 };
const cfg = { runner: 'pi', actor: 'ai' };

/** 每个用例一个独立临时工作区，跑完删掉。 */
async function withTempWorkdir(fn) {
  const workdir = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-manifest-'));
  try {
    await fn(workdir);
  } finally {
    await fs.rm(workdir, { recursive: true, force: true });
  }
}

const readRunJson = async (dir) => JSON.parse(await fs.readFile(path.join(dir, 'run.json'), 'utf8'));

test('createManifest 落盘 run.json，初始 outcome 为 running', async () => {
  await withTempWorkdir(async (workdir) => {
    const { manifest, dir } = await createManifest({ workdir, cfg, issue });

    assert.equal(dir, path.join(workdir, '.engine', 'runs', manifest.runId));
    const saved = await readRunJson(dir);
    assert.equal(saved.card.id, 't-1');
    assert.equal(saved.outcome, 'running');
    assert.equal(saved.endedAt, null);
  });
});

test('journal 追加一行合法 JSON，带 event/card/run/at', async () => {
  await withTempWorkdir(async (workdir) => {
    const { manifest, journal } = await createManifest({ workdir, cfg, issue });

    await journal('start', { mode: 'queue' });

    const file = path.join(workdir, '.engine', 'journal.ndjson');
    const lines = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 1);

    const event = JSON.parse(lines[0]);
    assert.equal(event.event, 'start');
    assert.equal(event.card, 't-1');
    assert.equal(event.run, manifest.runId);
    assert.equal(event.mode, 'queue');
    assert.match(event.at, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test('finish 回写 outcome/commit/endedAt 到 run.json', async () => {
  await withTempWorkdir(async (workdir) => {
    const { manifest, dir, save, journal } = await createManifest({ workdir, cfg, issue });

    await finish(manifest, save, journal, { outcome: 'closed', commit: 'abc1234' });

    const saved = await readRunJson(dir);
    assert.equal(saved.outcome, 'closed');
    assert.equal(saved.commit, 'abc1234');
    assert.ok(saved.endedAt);
    assert.match(saved.endedAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});
