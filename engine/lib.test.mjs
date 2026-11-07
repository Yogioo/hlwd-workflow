// engine/lib.mjs 的单元测试：覆盖 render() 的占位符替换语义与 run() 的进程产物收集。
import test from 'node:test';
import assert from 'node:assert/strict';

import { engineOf, render, run, stageCfg } from './lib.mjs';

test('已知占位符被替换', () => {
  assert.equal(render('a {{X}} b', { X: 'v' }), 'a v b');
});

test('未知占位符原样保留', () => {
  assert.equal(render('a {{Y}} b', { X: 'v' }), 'a {{Y}} b');
});

test('空字符串按值替换，不当成缺省', () => {
  assert.equal(render('a {{X}} b', { X: '' }), 'a  b');
});

test('0 按值替换，不当成缺省', () => {
  assert.equal(render('a {{X}} b', { X: 0 }), 'a 0 b');
});

test('run() 命令失败不抛错，退出码原样返回', async () => {
  const res = await run(process.execPath, ['-e', 'process.exit(3)']);
  assert.equal(res.code, 3);
});

test('run() 捕获 stderr', async () => {
  const res = await run(process.execPath, ['-e', 'console.error("boom"); process.exit(1)']);
  assert.match(res.err, /boom/);
});

test('run() 传 input 时写进 stdin', async () => {
  const res = await run(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'hi' });
  assert.match(res.out, /hi/);
});

// —— 阶段配置：节点上留空 = 继承全局，不是“不设模型” ——
const base = { runner: 'pi', model: 'global-model', thinking: 'high', sandbox: 'workspace-write' };

test('stageCfg：没配阶段时原样继承全局', () => {
  assert.deepEqual(stageCfg(base, 'execute'), base);
  assert.deepEqual(stageCfg({ ...base, stages: {} }, 'review'), { ...base, stages: {} });
});

test('stageCfg：阶段上的值覆盖全局，没填的项继续继承', () => {
  const cfg = { ...base, stages: { execute: { model: 'exec-model', runner: '', thinking: '' } } };
  const got = stageCfg(cfg, 'execute');
  assert.equal(got.model, 'exec-model');
  assert.equal(got.runner, 'pi', '空字符串表示没说，继续用全局');
  assert.equal(got.thinking, 'high');
  assert.equal(got.sandbox, 'workspace-write');
});

test('stageCfg：两个阶段互不影响', () => {
  const cfg = { ...base, stages: { execute: { model: 'a' }, review: { model: 'b' } } };
  assert.equal(stageCfg(cfg, 'execute').model, 'a');
  assert.equal(stageCfg(cfg, 'review').model, 'b');
});

test('engineOf 只取进 run.json 的三个字段', () => {
  assert.deepEqual(engineOf(base), { runner: 'pi', model: 'global-model', thinking: 'high' });
});
