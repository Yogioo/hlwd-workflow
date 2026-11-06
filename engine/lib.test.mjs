// engine/lib.mjs 的单元测试：只覆盖 render() 的占位符替换语义。
import test from 'node:test';
import assert from 'node:assert/strict';

import { render } from './lib.mjs';

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
