#!/usr/bin/env node
// 自动流水线：常驻循环，有「待接 + 可派」的单就跑一张，跑完接着看，没有就等。
// 单进程 + 心跳文件（~/.hlwd/watch/<项目>.json）：看板和终端只读状态，不替它做决定。
//
//   node engine/watch.mjs --project <dir> [--interval 5000]   # 前台跑（日志就在终端）
//   node engine/watch.mjs --project <dir> --stop              # 请求优雅停止（跑完手上这张）
//   node engine/watch.mjs --project <dir> --status            # 打印一行 JSON 状态，退出
//
// 每张单都是独立的 engine/run.mjs 子进程：一张单崩了不会带走循环，进程退出也不留状态。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ensureProject } from '../project.mjs';
import * as beads from '../web/beads.mjs';
import { latestRun, setProjectDir } from '../web/runs.mjs';
import { workflowOf } from '../web/workflow.mjs';
import { loadConfig, log } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ENGINE = path.join(HERE, 'run.mjs');
const STATE_DIR = path.join(os.homedir(), '.hlwd', 'watch');

/** 项目路径 → 文件名。同一个项目只能有一个流水线，不同项目互不干扰。 */
export function keyOf(dir) {
  const key = path
    .resolve(dir)
    .toLowerCase()
    .replace(/^[a-z]:/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return key || 'project';
}

export const stateFile = (dir) => path.join(STATE_DIR, `${keyOf(dir)}.json`);
export const stopFile = (dir) => path.join(STATE_DIR, `${keyOf(dir)}.stop`);

const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const readJson = async (file) => {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
};

/** 读状态：running 要 pid 活着**且**没被标成 stopped；文件只是线索，stopping 看有没有 stop 文件。
 *  只看 pid 会撒谎：进程退了但 pid 被别人复用，看板就会显示「已开」，还会挡住下一次启动。 */
export async function readWatch(dir) {
  const raw = (await readJson(stateFile(dir))) ?? null;
  const stopping = await stopRequested(dir);
  if (!raw) return { running: false, stopping: false, state: 'stopped', project: path.resolve(dir) };
  return { ...raw, stopping, running: raw.state !== 'stopped' && alive(raw.pid) };
}

export async function writeWatch(dir, patch) {
  const current = (await readJson(stateFile(dir))) ?? {};
  const next = { ...current, ...patch, beatAt: new Date().toISOString() };
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(stateFile(dir), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export async function requestStop(dir) {
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.writeFile(stopFile(dir), new Date().toISOString(), 'utf8');
}

const stopRequested = async (dir) => (await fs.access(stopFile(dir)).then(() => true).catch(() => false));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等一会儿，但每 500ms 看一眼停止请求：点「停止」不用等满一轮轮询。 */
async function idleWait(dir, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await stopRequested(dir)) return true;
    await sleep(Math.min(500, Math.max(0, until - Date.now())));
  }
  return stopRequested(dir);
}

/** 跑一张单：子进程继承 stdio，日志直接进流水线的输出（后台时就是 watch.log）。 */
function runOne(dir, onSpawn) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [RUN_ENGINE, '--project', dir], { cwd: dir, stdio: 'inherit' });
    if (child.pid) onSpawn(child.pid);
    child.on('error', () => resolve(-1));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** 强停时连子进程一起杀：只杀循环会留下一个跑着 agent 的孤儿。 */
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(pid, 'SIGKILL');
  } catch {
    // 已经不在
  }
}

async function listReady(dir, cfg) {
  setProjectDir(dir);
  const issues = await beads.listIssues({ status: 'open', ready: true, label: cfg.readyLabel });
  const out = [];
  for (const issue of issues) {
    const wf = workflowOf(issue, await latestRun(issue.id));
    if (!wf.active) out.push(issue);
  }
  return out;
}

async function loop({ dir, interval }) {
  const startedAt = new Date().toISOString();
  const cfg = await loadConfig(dir);
  await writeWatch(dir, { pid: process.pid, project: dir, startedAt, interval, state: 'idle', card: null, lastCode: null, lastError: null });
  log(`自动流水线启动：${dir}（每 ${Math.round(interval / 1000)}s 看一眼，标签 ${cfg.readyLabel}）`);

  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      stopping = true;
      log(`收到 ${signal}：跑完手上这张就停（再按一次强退）`);
    });
  }

  while (!stopping) {
    if (await stopRequested(dir)) {
      log('收到停止请求：跑完手上这张就停');
      break;
    }

    const ready = await listReady(dir, cfg).catch((err) => {
      log(`列工单失败：${err.message}`);
      return [];
    });
    if (!ready.length) {
      await writeWatch(dir, { state: 'idle', card: null });
      if (await idleWait(dir, interval)) break;
      continue;
    }

    const card = ready[0];
    await writeWatch(dir, { state: 'running', card: card.id, cardTitle: card.title });
    log(`开跑 ${card.id} — ${card.title}`);

    const code = await runOne(dir, (childPid) => writeWatch(dir, { childPid }));
    const lastError =
      code === 2
        ? '工作区不干净：先处理改动（wf 只在干净时开跑）'
        : code === 1
          ? '这张没跑通：看卡片评论与全链路'
          : null;
    await writeWatch(dir, { state: 'idle', card: null, childPid: null, lastCode: code, lastError });
    log(`结束 ${card.id}：engine 退出码 ${code}${lastError ? `（${lastError}）` : ''}`);

    // 工作区不干净时别空转刷屏，等一会儿再试
    if (code === 2 && (await idleWait(dir, Math.max(interval, 15000)))) break;
  }

  await fs.rm(stopFile(dir), { force: true });
  await writeWatch(dir, { state: 'stopped', card: null, stoppedAt: new Date().toISOString() });
  log('自动流水线已停止');
}

async function main() {
  const argv = process.argv.slice(2);
  const args = { project: process.cwd(), interval: 5000, stop: false, status: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const take = () => {
      const value = inline ?? argv[i + 1];
      if (inline === undefined) i += 1;
      if (value === undefined) throw new Error(`${flag} 需要一个值`);
      return value;
    };
    if (flag === '--project') args.project = take();
    else if (flag === '--interval') args.interval = Math.max(1000, Number(take()) || 5000);
    else if (flag === '--stop') args.stop = true;
    else if (flag === '--force') args.force = true;
    else if (flag === '--status') args.status = true;
    else throw new Error(`未知参数：${argv[i]}`);
  }

  const dir = path.resolve(args.project);
  const state = await readWatch(dir);

  if (args.status) {
    console.log(JSON.stringify(state));
    return 0;
  }
  if (args.force) {
    if (!state.running) {
      console.log('自动流水线没在跑');
      return 0;
    }
    log(`强停：pid ${state.pid}${state.childPid ? `（含子进程 ${state.childPid}）` : ''}`);
    killTree(state.childPid);
    killTree(state.pid);
    await sleep(600);
    await fs.rm(stopFile(dir), { force: true });
    await writeWatch(dir, { state: 'stopped', card: null, childPid: null, stoppedAt: new Date().toISOString() });
    console.log('已强停' + (state.card ? `；卡在 ${state.card} 上，需要的话把状态改回待接` : ''));
    return 0;
  }
  if (args.stop) {
    if (!state.running) {
      console.log('自动流水线没在跑');
      return 0;
    }
    await requestStop(dir);
    console.log(`已请求停止（pid ${state.pid}）：它跑完手上这张就退出`);
    return 0;
  }
  if (state.running) {
    console.log(`自动流水线已在跑（pid ${state.pid}，当前 ${state.card ?? '等单'}）`);
    return 0;
  }

  await ensureProject(dir);
  beads.setWorkdir(dir);
  setProjectDir(dir);
  await loop({ dir, interval: args.interval });
  return 0;
}

// 被 import（测试）时不启动循环
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main()
    .then((code) => {
      process.exitCode = code ?? 0;
    })
    .catch((err) => {
      console.error(`自动流水线中止：${err.message}`);
      process.exitCode = 1;
    });
}
