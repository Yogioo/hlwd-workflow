// 门禁的测试：默认放行、不通过带原因、抛错/看不懂/语法错一律挡下。
// runGate 是 engine 唯一调用门禁的入口，所以这里直接测它（会真 spawn 一个 node 进程）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { GATE_TEMPLATE, gateFile } from '../project.mjs';
import { runGate } from './lib.mjs';

/** 临时项目目录 + 一份门禁脚本。 */
async function withGate(source, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-gate-'));
  const file = path.join(dir, 'gate.mjs');
  await fs.writeFile(file, source, 'utf8');
  try {
    return await fn({ dir, file });
  } finally {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

const ctxFor = (dir) => ({
  workdir: dir,
  issue: { id: 'hlwd-x1', title: '示例单', body: '', labels: ['ready-for-agent'], priority: 2 },
  runDir: path.join(dir, 'runs', 'hlwd-x1-1'),
  attempt: 2,
  cfg: { runner: 'pi' },
});

test('gateFile() 指向 .hlwd/gate.mjs', () => {
  assert.equal(gateFile(path.join('C:', 'tmp', 'p')), path.join('C:', 'tmp', 'p', '.hlwd', 'gate.mjs'));
});

test('默认模板（always true）放行', async () => {
  await withGate(GATE_TEMPLATE, async ({ dir, file }) => {
    const res = await runGate({ gateFile: file, context: ctxFor(dir) });
    assert.equal(res.pass, true);
    assert.match(res.reason, /默认门禁/);
  });
});

test('返回 { pass: false, reason } 时挡下，原因原样带出', async () => {
  const source = 'export default async () => ({ pass: false, reason: "npm test 有 3 个失败，先修 web/app/app.js" });\n';
  await withGate(source, async ({ dir, file }) => {
    const res = await runGate({ gateFile: file, context: ctxFor(dir) });
    assert.equal(res.pass, false);
    assert.match(res.reason, /npm test 有 3 个失败/);
  });
});

test('返回 false 也算不通过', async () => {
  await withGate('export default async () => false;\n', async ({ dir, file }) => {
    const res = await runGate({ gateFile: file, context: ctxFor(dir) });
    assert.equal(res.pass, false);
    assert.match(res.reason, /false/);
  });
});

test('门禁能拿到工单与轮次', async () => {
  const source = `export default async ({ issue, attempt }) => ({
    pass: issue.id === 'hlwd-x1' && attempt === 2,
    reason: \`\${issue.id}/\${attempt}\`,
  });\n`;
  await withGate(source, async ({ dir, file }) => {
    const res = await runGate({ gateFile: file, context: ctxFor(dir) });
    assert.equal(res.pass, true);
    assert.equal(res.reason, 'hlwd-x1/2');
  });
});

test('门禁抛错 = 不通过，错误信息当原因', async () => {
  await withGate('export default async () => { throw new Error("构建挂了"); };\n', async ({ dir, file }) => {
    const res = await runGate({ gateFile: file, context: ctxFor(dir) });
    assert.equal(res.pass, false);
    assert.match(res.reason, /构建挂了/);
  });
});

test('返回值看不懂 = 不通过（宁严不宽）', async () => {
  await withGate('export default async () => 42;\n', async ({ dir, file }) => {
    const res = await runGate({ gateFile: file, context: ctxFor(dir) });
    assert.equal(res.pass, false);
    assert.match(res.reason, /看不懂/);
  });
});

test('没有 export default = 不通过', async () => {
  await withGate('export const gate = 1;\n', async ({ dir, file }) => {
    const res = await runGate({ gateFile: file, context: ctxFor(dir) });
    assert.equal(res.pass, false);
    assert.match(res.reason, /export default/);
  });
});

test('语法错 = 不通过，引擎不崩', async () => {
  await withGate('export default async ( => {};\n', async ({ dir, file }) => {
    const res = await runGate({ gateFile: file, context: ctxFor(dir) });
    assert.equal(res.pass, false);
    assert.match(res.reason, /加载失败/);
  });
});

test('门禁自己打印的噪音不影响判定', async () => {
  const source = 'export default async () => { console.log("正在跑检查…"); return true; };\n';
  await withGate(source, async ({ dir, file }) => {
    const res = await runGate({ gateFile: file, context: ctxFor(dir) });
    assert.equal(res.pass, true);
    assert.match(res.out, /正在跑检查/);
  });
});

test('门禁脚本不存在 = 不通过', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-gate-'));
  try {
    const res = await runGate({ gateFile: path.join(dir, 'nope.mjs'), context: ctxFor(dir) });
    assert.equal(res.pass, false);
    assert.match(res.reason, /加载失败/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
