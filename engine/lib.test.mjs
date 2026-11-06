// engine/lib.mjs 的单元测试：覆盖 render() 的占位符替换语义与 run() 的进程产物收集。
import test from 'node:test';
import assert from 'node:assert/strict';

import { render, run } from './lib.mjs';

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
