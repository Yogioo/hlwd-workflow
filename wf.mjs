#!/usr/bin/env node
// 唯一入口。这里只做分发，不含业务逻辑：所有事情都由 beads / web / engine 三个黑盒完成。
//   node wf.mjs            我现在该干什么
//   node wf.mjs board      看板（建单 / 看追溯）
//   node wf.mjs work       让 AI 干下一张就绪单
//   node wf.mjs trace <id> 终端看一张单的全链路
//   node wf.mjs new "标题" [描述]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as beads from './web/beads.mjs';
import { listRuns } from './web/runs.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3100);
const READY = beads.READY_LABEL;
const LABELS = { open: '待接', in_progress: '执行中', review: '待审', closed: '已完成' };

const HELP = `用法：node wf.mjs <动词>

  （不带参数）        我现在该干什么：工单概况 + 下一步
  board              打开看板（建单、看追溯）
  work [参数]        让 AI 干下一张就绪单（--dry / --id <卡片> / --attempts N 原样透传）
  trace <卡片id>     在终端看一张单的执行全链路
  new <标题> [描述]  建一张单，自动打 ${READY} 标签

npm start = board，npm run engine = work
`;

const time = (at) => {
  const d = new Date(at ?? '');
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
};
const dur = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

function child(cmd, args, opts = {}) {
  const proc = spawn(cmd, args, { stdio: 'inherit', cwd: process.cwd(), ...opts });
  return new Promise((resolve) => proc.on('close', (code) => resolve(code ?? 1)));
}

function openBrowser(url) {
  if (process.env.WF_NO_OPEN === '1') return;
  const [cmd, args] =
    process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch {
    // 打不开浏览器不影响服务
  }
}

async function boardOnline() {
  try {
    const res = await fetch(`http://${HOST}:${PORT}/api/meta`, { signal: AbortSignal.timeout(400) });
    return res.ok;
  } catch {
    return false;
  }
}

async function status() {
  const issues = await beads.listIssues({ all: true });
  const counts = beads.STATUSES.map((s) => [s, issues.filter((i) => i.status === s).length]);
  const ready = issues.filter((i) => i.status === 'open' && i.labels.includes(READY));
  const running = issues.filter((i) => i.status !== 'open' && i.status !== 'closed' && i.labels.includes(READY));

  console.log(`工单 ${issues.length} 张：${counts.map(([s, n]) => `${LABELS[s]} ${n}`).join(' · ')}`);
  console.log(`就绪 ${ready.length} 张${running.length ? `，另有 ${running.length} 张在流水线里` : ''}`);
  for (const issue of ready.slice(0, 5)) console.log(`  · ${issue.id}  ${issue.title}`);
  if (ready.length > 5) console.log(`  … 还有 ${ready.length - 5} 张`);

  const online = await boardOnline();
  console.log(`\n看板 ${online ? `在线 http://${HOST}:${PORT}` : '未启动'}`);

  console.log('\n下一步');
  if (!online) console.log('  node wf.mjs board            起看板，建单 / 看追溯');
  if (ready.length) console.log('  node wf.mjs work             让 AI 干下一张就绪单');
  else console.log('  先在看板里建单（或 node wf.mjs new "标题"），再 work');
}

async function trace(id) {
  if (!id) throw new Error('用法：node wf.mjs trace <卡片id>');
  const { issue } = await beads.getIssue(id);
  const [history, runs] = await Promise.all([beads.listStatusHistory(id), listRuns(id)]);

  console.log(`${issue.id}  ${issue.title}`);
  console.log(`状态 ${LABELS[issue.status] ?? issue.status}（${issue.status}） · 负责人 ${issue.assignee || '—'} · P${issue.priority}`);

  if (history.length) {
    console.log('\n状态变更');
    for (const h of history) console.log(`  ${time(h.at)}  ${h.status}${h.assignee ? ` · ${h.assignee}` : ''}`);
  }

  if (!runs.length) {
    console.log('\n还没有 engine 运行记录。');
    return;
  }

  for (const run of runs) {
    const total = run.endedAt ? new Date(run.endedAt) - new Date(run.startedAt) : null;
    console.log(`\n运行 ${run.runId}  ${dur(total)}  → ${run.outcome}${run.commit ? `  提交 ${run.commit}` : ''}`);
    for (const a of run.attempts ?? []) {
      const e = a.execute ?? {};
      console.log(`  #${a.attempt} 执行 ${dur(e.ms)} ${e.ok ? 'ok' : '失败'}`);
      if (!e.ok && e.error) console.log(`       ${String(e.error).split('\n')[0]}`);
      const r = a.review;
      if (!r) continue;
      console.log(`  #${a.attempt} 审查 ${dur(r.ms)} ${r.pass ? 'pass' : 'fail'} — ${String(r.reason ?? '').slice(0, 150)}`);
      for (const c of (r.checks ?? []).slice(0, 3)) console.log(`       · ${c}`);
      if ((r.checks ?? []).length > 3) console.log(`       … 共 ${r.checks.length} 条验证，见 run.json`);
    }
    if (run.reason) console.log(`  结局 ${run.outcome} — ${String(run.reason).split('\n')[0].slice(0, 150)}`);
    console.log(`  产物 .engine/runs/${run.runId}/`);
  }
}

async function newCard(args) {
  const [title, ...rest] = args;
  if (!title) throw new Error('用法：node wf.mjs new "标题" [描述]');
  const issue = await beads.createIssue({
    title,
    description: rest.join(' '),
    type: 'task',
    priority: 2,
    labels: [READY],
  });
  console.log(`已建单 ${issue.id}  ${issue.title}`);
  console.log(`下一步：node wf.mjs work         （或 node wf.mjs work --id ${issue.id}）`);
}

async function main() {
  const [verb, ...rest] = process.argv.slice(2);

  if (verb === '-h' || verb === '--help' || verb === 'help') {
    console.log(HELP);
    return 0;
  }
  if (!verb) {
    await status();
    return 0;
  }

  if (verb === 'board') {
    const url = `http://${HOST}:${PORT}`;
    setTimeout(() => openBrowser(url), 700);
    return child(process.execPath, [path.join(ROOT, 'web', 'server.mjs')]);
  }

  if (verb === 'work' || verb === 'run') return child(process.execPath, [path.join(ROOT, 'engine', 'run.mjs'), ...rest]);
  if (verb === 'trace') {
    await trace(rest[0]);
    return 0;
  }
  if (verb === 'new') {
    await newCard(rest);
    return 0;
  }

  console.log(`未知动词：${verb}\n`);
  console.log(HELP);
  return 2;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
