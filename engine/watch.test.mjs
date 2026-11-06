// 自动流水线的测试：状态文件的读写口径 + --status CLI。
// 不测循环本体（那会真跑 agent），只保证「看板和终端看到的状态是真的」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { keyOf, readWatch, requestStop, stateFile, stopFile, writeWatch } from './watch.mjs';

const run = promisify(execFile);
const WATCH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'watch.mjs');

async function withDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-watch-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(stopFile(dir), { force: true }).catch(() => {});
    await fs.rm(stateFile(dir), { force: true }).catch(() => {});
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

test('keyOf 把路径折成安全的文件名', () => {
  assert.equal(keyOf('C:\\projects\\my-app'), 'projects-my-app');
  assert.equal(keyOf('/home/me/项目'), 'home-me');
  assert.equal(keyOf('/'), 'project');
});

test('没跑过时 readWatch 报 stopped', async () => {
  await withDir(async (dir) => {
    const state = await readWatch(dir);
    assert.equal(state.running, false);
    assert.equal(state.stopping, false);
    assert.equal(state.state, 'stopped');
  });
});

test('心跳写入后能读回来；pid 已死则 running=false', async () => {
  await withDir(async (dir) => {
    await writeWatch(dir, { pid: process.pid, project: dir, state: 'idle', card: null });
    const live = await readWatch(dir);
    assert.equal(live.running, true);
    assert.equal(live.state, 'idle');

    await writeWatch(dir, { pid: 999999, state: 'running', card: 'hlwd-abc' });
    const dead = await readWatch(dir);
    assert.equal(dead.running, false, '进程不在了就不能算在跑');
    assert.equal(dead.pid, 999999);
    assert.equal(dead.card, 'hlwd-abc');
  });
});

test('requestStop 写 stop 文件，readWatch 报 stopping', async () => {
  await withDir(async (dir) => {
    await writeWatch(dir, { pid: process.pid, state: 'running', card: 'hlwd-abc' });
    await requestStop(dir);
    const state = await readWatch(dir);
    assert.equal(state.stopping, true);
    assert.equal(state.running, true);
  });
});

test('--status 打一行 JSON（没跑过就是 running:false）', async () => {
  await withDir(async (dir) => {
    const { stdout } = await run(process.execPath, [WATCH, '--project', dir, '--status']);
    const state = JSON.parse(stdout.trim());
    assert.equal(state.running, false);
    assert.equal(state.project, path.resolve(dir));
  });
});

test('--stop 在没跑的时候也安全，且不留下 stop 文件之外的垃圾', async () => {
  await withDir(async (dir) => {
    const { stdout } = await run(process.execPath, [WATCH, '--project', dir, '--stop']);
    assert.match(stdout, /没在跑/);
    await fs.access(stopFile(dir)).then(
      () => assert.fail('没在跑就不该写 stop 文件'),
      () => {},
    );
  });
});
