#!/usr/bin/env node
// 门禁执行器：引擎 spawn 出来跑项目的 .hlwd/gate.mjs。
// 单独一个进程：门禁是用户脚本，语法错 / 死循环 / process.exit 都不能拖垮引擎。
// 只由 engine/lib.mjs 的 runGate() 调用：
//   node gate-run.mjs <门禁脚本路径>     ← ctx 从 stdin 读 JSON
// 输出：stdout 最后一行是 {"pass":bool,"reason":string}，退出码 0 通过 / 1 不通过。
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const readStdin = () =>
  new Promise((resolve, reject) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (raw += chunk));
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', reject);
  });

function emit(pass, reason) {
  const text = String(reason ?? '').trim() || (pass ? '门禁通过' : '门禁不通过');
  console.log(JSON.stringify({ pass: Boolean(pass), reason: text }));
  process.exit(pass ? 0 : 1);
}

const [gatePath] = process.argv.slice(2);
if (!gatePath) emit(false, '没有给门禁脚本路径');

let ctx = {};
try {
  ctx = JSON.parse((await readStdin()) || '{}');
} catch (err) {
  emit(false, `门禁上下文解析失败：${err.message}`);
}

let gate;
try {
  const mod = await import(pathToFileURL(path.resolve(gatePath)).href);
  gate = mod.default;
} catch (err) {
  emit(false, `门禁脚本加载失败：${err.message}`);
}
if (typeof gate !== 'function') emit(false, `${path.basename(gatePath)} 没有 export default 函数`);

let result;
try {
  result = await gate(ctx);
} catch (err) {
  emit(false, `门禁抛错：${err?.message ?? err}`);
}

// 只认 true / false / {pass}；看不懂的一律不通过，并把契约写进原因里
if (result === true) emit(true, '门禁返回 true');
else if (result === false) emit(false, '门禁返回 false');
else if (result && typeof result === 'object' && typeof result.pass === 'boolean') emit(result.pass, result.reason);
else {
  let shape;
  try {
    shape = JSON.stringify(result);
  } catch {
    shape = String(result);
  }
  emit(false, `门禁返回值看不懂（只认 true / false / { pass, reason }）：${String(shape).slice(0, 200)}`);
}
