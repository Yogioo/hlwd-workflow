// 一致性检查：app.js 引用的每个 #id 必须真的存在于 index.html。
// 之前出过一次「加了 JS 事件但忘了加按钮」——页面直接报错，这里挡住它。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const read = (name) => fs.readFile(path.join(dir, name), 'utf8');

test('app.js 里 $(\'#id\') 引用都能在 index.html 找到', async () => {
  const [app, html] = await Promise.all([read('app.js'), read('index.html')]);

  const referenced = [...new Set([...app.matchAll(/\$\('#([\w-]+)'\)/g)].map((m) => m[1]))];
  // 有些元素是 app.js 自己渲染的（筛选弹层之类），不在 index.html 里，也算声明过。
  // 前面的边界必须写，否则 data-id="x" 会被当成 id="x"。
  const idsIn = (source) => new Set([...source.matchAll(/[<\s]id="([\w-]+)"/g)].map((m) => m[1]));
  const declared = new Set([...idsIn(html), ...idsIn(app)]);
  const missing = referenced.filter((id) => !declared.has(id));

  assert.deepEqual(missing, [], `index.html 缺少这些元素：${missing.join(', ')}`);
  assert.ok(referenced.length > 10, '应该真的解析到了引用');
});

test('index.html 里同一 id 不重复', async () => {
  const html = await read('index.html');
  const ids = [...html.matchAll(/id="([\w-]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual([...new Set(dup)], [], `重复 id：${dup.join(', ')}`);
});
