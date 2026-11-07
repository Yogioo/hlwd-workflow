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
import { latestRuns, listRuns, setProjectDir } from './web/runs.mjs';
import { WORKFLOW_COLUMNS, workflowOf } from './web/workflow.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST ?? '127.0.0.1';
const PORT = Number(process.env.PORT ?? 3100);
// 本机探活固定走 loopback：绑 0.0.0.0 时 0.0.0.0 不是能 fetch 的地址
const PROBE = `http://127.0.0.1:${PORT}`;
const STATE_DIR = path.join(os.homedir(), '.hlwd');
const PID_FILE = path.join(STATE_DIR, 'board.pid');
const BOARD_FILE = path.join(STATE_DIR, 'board.json');
const BOARD_LOG = path.join(STATE_DIR, 'board.log');
const WATCH_LOG = path.join(STATE_DIR, 'watch.log');
const WATCH_SCRIPT = path.join(ROOT, 'engine', 'watch.mjs');

const HELP = `用法：node wf.mjs [--project <目录>] <动词>

  （不带参数）        我现在该干什么：工单概况 + 下一步
  board [--bg]       看板（建单、看全链路）；--bg 后台启动，马上返回
                     --lan 绑 0.0.0.0 让内网同事打开；--token <口令> 加访问口令
                     --host <ip> 绑指定网卡（等价自选内网地址）
  stop               停掉后台看板
  work [参数]        让 AI 干下一张就绪单（--dry / --id <卡片> / --attempts N 原样透传）
  watch [--bg]       自动流水线：常驻，有就绪单就自动开干
                     --stop 优雅停（跑完手上这张）；--interval <ms> 轮询间隔
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

// 看板进程的信息（绑了哪个地址、有没有口令）：本机自己知道，别人才需要问
async function readBoardInfo() {
  try {
    return JSON.parse(await fs.readFile(BOARD_FILE, 'utf8'));
  } catch {
    return null;
  }
}

async function saveBoardInfo(info) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(BOARD_FILE, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
}

async function boardMeta() {
  const info = await readBoardInfo();
  const headers = info?.token ? { 'x-wf-token': info.token } : {};
  try {
    const res = await fetch(`${PROBE}/api/meta`, { headers, signal: AbortSignal.timeout(500) });
    // 401 = 看板活着、只是要登录（开了账号系统），这不算「没启动」
    if (res.status === 401) return { auth: true };
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

const boardOnline = async () => (await boardMeta()) !== null;

/** 流水线状态由 engine 自己的 CLI 回答（跨模块只走进程/文件，不 import 内部）。 */
async function watchStatus(dir) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WATCH_SCRIPT, '--project', dir, '--status'], { windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.on('error', () => resolve(null));
    child.on('close', () => {
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch {
        resolve(null);
      }
    });
  });
}

/** 自动流水线：--bg 后台跑（日志进 ~/.hlwd/watch.log），--stop 优雅停，其余参数透传。 */
async function watch(dir, args = []) {
  const forward = args.filter((a) => a !== '--bg');
  const argv = [WATCH_SCRIPT, '--project', dir, ...forward];
  if (!args.includes('--bg')) return child(process.execPath, argv, { cwd: dir });

  await fs.mkdir(STATE_DIR, { recursive: true });
  const log = await fs.open(WATCH_LOG, 'a');
  const proc = spawn(process.execPath, argv, { cwd: dir, detached: true, stdio: ['ignore', log.fd, log.fd] });
  proc.unref();
  await log.close();
  for (let i = 0; i < 50; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    const st = await watchStatus(dir);
    if (st?.running) {
      console.log(`自动流水线已在后台跑（pid ${st.pid}）`);
      console.log(`项目 ${dir}`);
      console.log(`日志 ${WATCH_LOG}    停止 node wf.mjs watch --stop`);
      return 0;
    }
  }
  console.log(`自动流水线没起来，看日志：${WATCH_LOG}`);
  return 1;
}

/** 本机自己开就看带口令的地址，不然会先看到“需要访问口令”。 */
const localUrl = (token) => (token ? `${PROBE}/?token=${encodeURIComponent(token)}` : PROBE);

/** 看板绑在局域网时，告诉人同事该打开哪个地址。 */
function printShare(meta, token = '') {
  const share = meta?.share;
  if (!share || share.host === '127.0.0.1' || share.host === 'localhost') return false;
  const urls = share.lan ?? [];
  console.log(`\n分享（内网，绑 ${share.host}）：${share.token ? '需要访问口令' : '没设口令，本网段谁都能建单/改单'}`);
  if (!urls.length) console.log('  （没找到内网地址，检查网卡）');
  for (const url of urls) console.log(`  ${share.token ? `${url}/?token=${token || '<口令>'}` : url}`);
  return true;
}

/** board 的参数：--bg 后台 / --lan 绑 0.0.0.0 / --host <ip> 指定网卡 / --token <口令>。 */
function boardFlags(args = []) {
  const flags = { bg: false, lan: false, host: null, token: String(process.env.WF_TOKEN ?? '').trim() };
  const value = (i, flag, inline) => {
    const v = inline ?? args[i + 1];
    if (v === undefined || String(v).trim() === '') throw new Error(`${flag} 需要一个值`);
    return String(v).trim();
  };
  for (let i = 0; i < args.length; i += 1) {
    const [flag, inline] = args[i].split('=');
    if (flag === '--bg') flags.bg = true;
    else if (flag === '--lan') flags.lan = true;
    else if (flag === '--host') {
      flags.host = value(i, flag, inline);
      if (inline === undefined) i += 1;
    } else if (flag === '--token') {
      flags.token = value(i, flag, inline);
      if (inline === undefined) i += 1;
    }
  }
  return flags;
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
  const runs = await latestRuns();
  const rows = issues.map((issue) => ({ issue, wf: workflowOf(issue, runs.get(issue.id)) }));
  const readyLabel = cfg.engine.readyLabel;
  const counts = WORKFLOW_COLUMNS.map((c) => [c.label, rows.filter((r) => r.wf.column === c.id).length]);
  const ready = rows
    .filter((r) => r.issue.status === 'open' && r.issue.labels.includes(readyLabel) && !r.wf.active)
    .map((r) => r.issue);
  const running = rows.filter((r) => r.wf.active).length;

  console.log(`项目 ${dir}${info.created.length ? `（补齐 ${info.created.join('、')}）` : ''}`);
  console.log(`工单 ${issues.length} 张：${counts.map(([label, n]) => `${label} ${n}`).join(' · ')}`);
  console.log(`就绪 ${ready.length} 张${running ? `，另有 ${running} 张在流水线里` : ''}`);
  for (const issue of ready.slice(0, 5)) console.log(`  · ${issue.id}  ${issue.title}  [${prioName(cfg, issue.priority)}]`);
  if (ready.length > 5) console.log(`  … 还有 ${ready.length - 5} 张`);

  const meta = await boardMeta();
  const boardInfo = await readBoardInfo();
  console.log(`\n看板 ${meta ? `在线 ${PROBE}` : '未启动'}`);
  if (meta) printShare(meta, boardInfo?.token);

  const watch = await watchStatus(dir);
  const watchLine = watch?.running
    ? `开（pid ${watch.pid}，${watch.state === 'running' ? `正在干 ${watch.card}` : '等单'}）`
    : `关${watch?.lastError ? ` · 上次：${watch.lastError}` : ''}`;
  console.log(`自动流水线 ${watchLine}`);

  console.log('\n下一步');
  if (!meta) console.log('  node wf.mjs board            起看板，建单 / 看全链路');
  if (!meta) console.log('  node wf.mjs board --lan      同上，并暴露到内网给同事（可加 --token 口令）');
  if (!watch?.running) console.log('  node wf.mjs watch --bg       自动流水线：有就绪单就自动开干');
  if (ready.length) console.log('  node wf.mjs work             让 AI 干下一张就绪单');
  else console.log('  先在看板里建单（或 node wf.mjs new "标题"），再 work');
}

async function trace(cardId, cfg) {
  if (!cardId) throw new Error('用法：node wf.mjs trace <卡片id>');
  const { issue } = await beads.getIssue(cardId);
  const [history, runs] = await Promise.all([beads.listStatusHistory(cardId), listRuns(cardId)]);

  console.log(`${issue.id}  ${issue.title}`);
  const wf = workflowOf(issue, runs[0] ?? null);
  console.log(`进度 ${wf.label || wf.column}${wf.detail ? `（${wf.detail}）` : ''} · 负责人 ${issue.assignee || '—'} · 优先级 ${prioName(cfg, issue.priority)}`);

  if (history.length) {
    console.log('\n工单开关变更');
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
      console.log(`  #${a.attempt} 执行 ${dur(e.ms)} ${e.ok == null ? '进行中' : e.ok ? 'ok' : '失败'}`);
      if (!e.ok && e.error) console.log(`       ${String(e.error).split('\n')[0]}`);
      const g = a.gate;
      if (g) console.log(`  #${a.attempt} 门禁 ${dur(g.ms)} ${g.pass ? 'pass' : 'fail'} — ${String(g.reason ?? '').split('\n')[0].slice(0, 150)}`);
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

async function board(projectDir, flags) {
  const bindHost = flags.host ?? (flags.lan ? '0.0.0.0' : HOST);

  if (await boardOnline()) {
    const [meta, info] = [await boardMeta(), await readBoardInfo()];
    console.log(`看板已经在跑：${localUrl(info?.token)}`);
    if (!printShare(meta, info?.token || flags.token)) {
      if (bindHost !== '127.0.0.1' && bindHost !== 'localhost') {
        console.log('它现在只绑在本机；先 node wf.mjs stop，再起：node wf.mjs board --lan');
      }
    }
    openBrowser(localUrl(info?.token));
    return 0;
  }

  const env = { ...process.env, HLWD_PROJECT: projectDir, HOST: bindHost };
  if (flags.token) env.WF_TOKEN = flags.token;
  const info = { pid: null, port: PORT, host: bindHost, token: flags.token ?? '', startedAt: new Date().toISOString() };

  if (flags.bg) {
    await fs.mkdir(STATE_DIR, { recursive: true });
    const log = await fs.open(BOARD_LOG, 'a');
    const proc = spawn(process.execPath, [path.join(ROOT, 'web', 'server.mjs')], {
      cwd: projectDir,
      detached: true,
      stdio: ['ignore', log.fd, log.fd],
      env,
    });
    proc.unref();
    await log.close(); // fd 已经给子进程了，父进程别攥着
    await fs.writeFile(PID_FILE, String(proc.pid), 'utf8');
    await saveBoardInfo({ ...info, pid: proc.pid });
    for (let i = 0; i < 40; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      if (await boardOnline()) break;
    }
    console.log(`看板已在后台启动：${localUrl(flags.token)}`);
    console.log(`项目 ${projectDir}`);
    printShare(await boardMeta(), flags.token);
    console.log(`日志 ${BOARD_LOG}    停止 node wf.mjs stop`);
    openBrowser(localUrl(flags.token));
    return 0;
  }

  setTimeout(() => openBrowser(localUrl(flags.token)), 700);
  console.log(`看板：${localUrl(flags.token)}`);
  if (bindHost !== '127.0.0.1' && bindHost !== 'localhost') {
    console.log(`暴露到内网（绑 ${bindHost}）${flags.token ? '，已设访问口令' : '；没设 --token / WF_TOKEN，本网段谁都能改单'}`);
  }
  await saveBoardInfo(info);
  return child(process.execPath, [path.join(ROOT, 'web', 'server.mjs')], { cwd: projectDir, env });
}

async function stop() {
  // 先让流水线收尾（不在半张单中途砍），再停看板
  const { project } = await readState().catch(() => ({ project: null }));
  if (project) {
    const watch = await watchStatus(project);
    if (watch?.running) {
      await child(process.execPath, [WATCH_SCRIPT, '--project', project, '--stop']);
      console.log(`自动流水线：已请求停止（项目 ${project}，它跑完手上这张就退）`);
      console.log('  要立即停（含手上的 agent）：node wf.mjs watch --force');
    }
  }

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
  // 只有真的没了才删探活信息（带着口令），不然前台跑着的看板就探不到了
  if (await boardOnline()) {
    console.log('没停掉（可能是前台启动的）：用 Ctrl+C 或关掉那个终端');
  } else {
    await fs.rm(BOARD_FILE, { force: true });
    console.log('看板已停止');
  }
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
    return board(dir, boardFlags(verbArgs));
  }
  if (verb === 'stop') return stop();

  if (verb === 'watch') {
    const { dir } = await useProject(explicitProject);
    await rememberProject(dir).catch(() => {});
    return watch(dir, verbArgs);
  }

  if (verb === 'work' || verb === 'run') {
    const { dir } = await useProject(explicitProject);
    await rememberProject(dir).catch(() => {});
    // 流水线在跑时别再手动插手，否则两张单会被两个进程同时接单
    if (!verbArgs.includes('--dry')) {
      const watch = await watchStatus(dir);
      if (watch?.running) {
        console.error(`自动流水线正在跑（pid ${watch.pid}${watch.card ? `，当前 ${watch.card}` : ''}）：它会自己接单。`);
        console.error('要手动跑就先 node wf.mjs watch --stop。');
        return 2;
      }
    }
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

// 被 `| head` / `| grep -m1` 截断时别喷栈，安静退出
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

main()
  .then((code) => {
    // 用 exitCode 而不是 process.exit()：刚 spawn 完就硬退会撞上 libuv 的句柄断言
    process.exitCode = code ?? 0;
  })
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
