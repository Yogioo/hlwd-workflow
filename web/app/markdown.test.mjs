// web/app/markdown.js 的单元测试：覆盖 md() 的转义与各块级语法。
import test from 'node:test';
import assert from 'node:assert/strict';

import { md } from './markdown.js';

test('转义：HTML 标签不被当标签渲染', () => {
  const html = md('<script>x</script>');
  assert.ok(!html.includes('<script'), html);
  assert.match(html, /&lt;script&gt;/);
});

test('标题：## 渲染成 h2', () => {
  assert.match(md('## 标题'), /<h2>标题<\/h2>/);
});

test('代码块：三反引号 bash 块渲染成 pre.code', () => {
  const html = md('```bash\nnpm test\n```');
  assert.match(html, /<pre class="code">/);
  assert.match(html, /<code class="lang-bash">npm test<\/code>/);
});

test('列表嵌套：缩进条目套成子列表', () => {
  const html = md('- a\n  - b');
  assert.match(html, /<ul><li>a<ul><li>b<\/li><\/ul><\/li><\/ul>/);
});

test('表格：表头 + 分隔行渲染成 table', () => {
  const html = md('| a | b |\n| --- | --- |\n| 1 | 2 |');
  assert.match(html, /<table>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<td>2<\/td>/);
});
