// 项目门禁：引擎每轮「执行」之后跑一次它，决定这一轮算不算过关。
// 通过才进审查；不通过会把 reason 交给执行端，让它在同一个工作区继续改（不新开上下文）。
//
// 契约：export default async 函数，参数 ctx 是只读快照：
//   { workdir, issue: { id, title, body, labels, priority }, runDir, attempt, cfg }
// 返回值只认三种：
//   true                               通过
//   false                              不通过（用默认文案）
//   { pass: boolean, reason?: string }  reason 会进下一轮提示词，写成执行端能照做的指令
// 抛错 / 返回值看不懂 / 超时（默认 10 分钟）一律算不通过——门禁宁严不宽。

export default async function gate() {
  return { pass: true, reason: '默认门禁：不做任何检查，直接放行' };
}

// —— 例子：要求 npm test 全绿 ——
// import { spawnSync } from 'node:child_process';
//
// export default async function gate({ workdir }) {
//   const r = spawnSync('npm', ['test'], { cwd: workdir, shell: true, encoding: 'utf8' });
//   if (r.status === 0) return { pass: true, reason: 'npm test 全绿' };
//   return { pass: false, reason: (r.stderr || r.stdout || 'npm test 失败').slice(-800) };
// }
//
// —— 例子：按工单标签放行 ——
// export default async function gate({ issue }) {
//   return issue.labels.includes('fast-lane')
//     ? true
//     : { pass: false, reason: '这张单必须补跑全量检查' };
// }
