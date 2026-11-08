// engine/lib.mjs 的单元测试：覆盖 render() 的占位符替换语义与 run() 的进程产物收集。
import test from 'node:test';
import assert from 'node:assert/strict';

import { engineOf, presetOf, render, run, stageCfg } from './lib.mjs';

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

// —— 阶段配置：节点挂预设，预设决定 runner/model/thinking ——
const base = { runner: 'pi', model: '', thinking: '', sandbox: 'workspace-write' };
const presets = [
  { id: 'exec', name: '执行', runner: 'pi', model: 'exec-model', thinking: 'high' },
  { id: 'rev', name: '审查', runner: 'codex', model: 'review-model', thinking: 'low' },
];
const cfg = { ...base, presets, nodes: { execute: { preset: 'exec' }, review: { preset: 'rev' } } };

test('stageCfg：执行和审查各用自己节点上的预设', () => {
  assert.equal(stageCfg(cfg, 'execute').model, 'exec-model');
  assert.equal(stageCfg(cfg, 'execute').thinking, 'high');
  assert.equal(stageCfg(cfg, 'review').runner, 'codex');
  assert.equal(stageCfg(cfg, 'review').model, 'review-model');
  assert.equal(stageCfg(cfg, 'execute').sandbox, 'workspace-write', '运行参数仍跟整条流水线走');
});

test('stageCfg：预设里空的 model/thinking 是执行器默认，不继承别的值', () => {
  const c = {
    ...base,
    model: 'global-model',
    thinking: 'global-high',
    presets: [{ id: 'p', name: 'p', runner: 'pi', model: '', thinking: '' }],
    nodes: { execute: { preset: 'p' } },
  };
  assert.equal(stageCfg(c, 'execute').model, '');
  assert.equal(stageCfg(c, 'execute').thinking, '');
});

test('stageCfg：节点引用丢了 / 没配时回落到第一份预设', () => {
  assert.equal(presetOf({ ...cfg, nodes: { execute: { preset: 'gone' } } }, 'execute').id, 'exec');
  assert.equal(stageCfg({ ...base, presets, nodes: {} }, 'review').model, 'exec-model');
});

test('stageCfg：一份预设都没有时保留原配置（手改坏配置也不至于崩）', () => {
  assert.deepEqual(stageCfg(base, 'execute'), base);
});

test('engineOf 只取进 run.json 的三个字段', () => {
  assert.deepEqual(engineOf({ ...base, model: 'global-model', thinking: 'high' }), {
    runner: 'pi',
    model: 'global-model',
    thinking: 'high',
  });
});
