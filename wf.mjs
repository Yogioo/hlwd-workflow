#!/usr/bin/env node
// 唯一入口。这里只做分发，不含业务逻辑：所有事情都由 beads / web / engine 三个黑盒完成。
//   node wf.mjs [--project <dir>] [动词]
//   node wf.mjs            我现在该干什么
//   node wf.mjs board      看板（建单 / 看全链路）
//   node wf.mjs work       让 AI 干下一张就绪单
//   node wf.mjs trace <id> 终端看一张单的全链路
//   node wf.mjs new "标题" [描述]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureProject, readProjectConfig, readState, rememberProject } from './project.mjs';
import * as beads from './web/beads.mjs';
import { listRuns, setProjectDir } from './web/runs.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3100);
const STATE_DIR = path.join(os.homedir(), '.hlwd');
const PID_FILE = path.join(STATE_DIR, 'board.pid');
const BOARD_LOG = path.join(STATE_DIR, 'board.log');

const HELP = `用法：node wf.mjs [--project <目录>] <动词>

  （不带参数）        我现在该干什么：工单概况 + 下一步
  board [--bg]       看板（建单、看全链路）；--bg 后台启动，马上返回
  stop               停掉后台看板
  work [参数]        让 AI 干下一张就绪单（--dry / --id <卡片> / --attempts N 原样透传）
  trace <卡片id>     在终端看一张单的执行全链路
  new <标题> [描述]  建一张单，自动打可派标签

--project 不给就用上次打开的项目（~/.hlwd/state.json），首次打开会自动建 .hlwd/ 与 .beads/。
npm start = board --bg，npm run engine = work
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

/** 解析项目：--project > 上次打开的项目 > 当前目录；顺手补齐 .hlwd/ 与 .beads/。 */
async function useProject(explicitDir) {
  const state = await readState();
  const dir = path.resolve(explicitDir ?? state.project ?? process.cwd());
  const info = await ensureProject(dir);
  beads.setWorkdir(dir);
  setProjectDir(dir);
  const cfg = await readProjectConfig(dir);
  return { dir, info, cfg };
}

const statusName = (cfg, s) => cfg.labels.statuses[s] ?? s;
const prioName = (cfg, p) => cfg.labels.priorities[p] ?? `P${p}`;

async function status({ dir, cfg, info }) {
  const issues = await beads.listIssues({ all: true });
  const readyLabel = cfg.engine.readyLabel;
  const counts = cfg.columns.map((s) => [s, issues.filter((i) => i.status === s).length]);
  const ready = issues.filter((i) => i.status === 'open' && i.labels.includes(readyLabel));
  const running = issues.filter((i) => i.status !== 'open' && i.status !== 'closed' && i.labels.includes(readyLabel));

  console.log(`项目 ${dir}${info.created.length ? `（补齐 ${info.created.join('、')}）` : ''}`);
  console.log(`工单 ${issues.length} 张：${counts.map(([s, n]) => `${statusName(cfg, s)} ${n}`).join(' · ')}`);
  console.log(`就绪 ${ready.length} 张${running.length ? `，另有 ${running.length} 张在流水线里` : ''}`);
  for (const issue of ready.slice(0, 5)) console.log(`  · ${issue.id}  ${issue.title}  [${prioName(cfg, issue.priority)}]`);
  if (ready.length > 5) console.log(`  … 还有 ${ready.length - 5} 张`);

  const online = await boardOnline();
  console.log(`\n看板 ${online ? `在线 http://${HOST}:${PORT}` : '未启动'}`);

  console.log('\n下一步');
  if (!online) console.log('  node wf.mjs board            起看板，建单 / 看全链路');
  if (ready.length) console.log('  node wf.mjs work             让 AI 干下一张就绪单');
  else console.log('  先在看板里建单（或 node wf.mjs new "标题"），再 work');
}

async function trace(cardId, cfg) {
  if (!cardId) throw new Error('用法：node wf.mjs trace <卡片id>');
  const { issue } = await beads.getIssue(cardId);
  const [history, runs] = await Promise.all([beads.listStatusHistory(cardId), listRuns(cardId)]);

  console.log(`${issue.id}  ${issue.title}`);
  console.log(`状态 ${statusName(cfg, issue.status)}（${issue.status}） · 负责人 ${issue.assignee || '—'} · 优先级 ${prioName(cfg, issue.priority)}`);

  if (history.length) {
    console.log('\n状态变更');
    for (const h of history) console.log(`  ${time(h.at)}  ${statusName(cfg, h.status)}${h.assignee ? ` · ${h.assignee}` : ''}`);
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
    console.log(`  产物 .hlwd/runs/${run.runId}/`);
  }
}

async function newCard(args, cfg) {
  const [title, ...rest] = args;
  if (!title) throw new Error('用法：node wf.mjs new "标题" [描述]');
  const issue = await beads.createIssue({
    title,
    description: rest.join(' '),
    type: 'task',
    priority: 2,
    labels: [cfg.engine.readyLabel],
  });
  console.log(`已建单 ${issue.id}  ${issue.title}`);
  console.log(`下一步：node wf.mjs work         （或 node wf.mjs work --id ${issue.id}）`);
}

async function board(projectDir, bg) {
  const url = `http://${HOST}:${PORT}`;

  if (await boardOnline()) {
    console.log(`看板已经在跑：${url}`);
    openBrowser(url);
    return 0;
  }

  if (bg) {
    await fs.mkdir(STATE_DIR, { recursive: true });
    const log = await fs.open(BOARD_LOG, 'a');
    const env = { ...process.env, HLWD_PROJECT: projectDir };
    const proc = spawn(process.execPath, [path.join(ROOT, 'web', 'server.mjs')], {
      cwd: projectDir,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env,
    });
    proc.unref();
    await fs.writeFile(PID_FILE, String(proc.pid), 'utf8');
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      if (await boardOnline()) break;
    }
    console.log(`看板已在后台启动：${url}`);
    console.log(`项目 ${projectDir}`);
    console.log(`日志 ${BOARD_LOG}    停止 node wf.mjs stop`);
    openBrowser(url);
    return 0;
  }

  setTimeout(() => openBrowser(url), 700);
  return child(process.execPath, [path.join(ROOT, 'web', 'server.mjs')], {
    cwd: projectDir,
    env: { ...process.env, HLWD_PROJECT: projectDir },
  });
}

async function stop() {
  let pid = 0;
  try {
    pid = Number((await fs.readFile(PID_FILE, 'utf8')).trim());
  } catch {
    // 没 pid 文件，靠端口判断
  }
  if (pid) {
    try {
      process.kill(pid);
    } catch {
      // 进程已经不在了
    }
    await fs.rm(PID_FILE, { force: true });
  }
  await new Promise((r) => setTimeout(r, 300));
  console.log((await boardOnline()) ? '没停掉（可能是前台启动的）：用 Ctrl+C 或关掉那个终端' : '看板已停止');
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  let explicitProject = null;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    if (flag === '--project') {
      explicitProject = inline ?? argv[i + 1];
      if (inline === undefined) i += 1;
    } else {
      rest.push(argv[i]);
    }
  }

  const [verb, ...verbArgs] = rest;
  if (verb === '-h' || verb === '--help' || verb === 'help') {
    console.log(HELP);
    return 0;
  }
  if (!verb) {
    await status(await useProject(explicitProject));
    return 0;
  }

  if (verb === 'board') {
    const { dir } = await useProject(explicitProject);
    await rememberProject(dir).catch(() => {});
    return board(dir, verbArgs.includes('--bg'));
  }
  if (verb === 'stop') return stop();

  if (verb === 'work' || verb === 'run') {
    const { dir } = await useProject(explicitProject);
    await rememberProject(dir).catch(() => {});
    return child(process.execPath, [path.join(ROOT, 'engine', 'run.mjs'), '--project', dir, ...verbArgs]);
  }

  const project = await useProject(explicitProject);
  if (verb === 'trace') {
    await trace(verbArgs[0], project.cfg);
    return 0;
  }
  if (verb === 'new') {
    await newCard(verbArgs, project.cfg);
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
