// engine 内部小工具：跑命令、读配置、渲染提示词。
// 这里不碰 beads（beads 只在 web/beads.mjs 里），也不做流程判断。
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProjectConfig, readPrompts } from '../project.mjs';
export const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));
const GATE_RUNNER = path.join(ENGINE_DIR, 'gate-run.mjs');
// 门禁可能要跑测试/构建，给 10 分钟；用环境变量可改
const GATE_TIMEOUT_MS = Number(process.env.HLWD_GATE_TIMEOUT_MS ?? 600000);

const WIN = process.platform === 'win32';

/**
 * agent-tools 在 Windows 上只有 .cmd 壳，spawn 不了；
 * 优先用 npm 全局装里的 .mjs 入口（用当前 node 跑），否则回落 PATH。
 */
function resolveAgentTools() {
  if (process.env.AGENT_TOOLS_BIN) return { cmd: process.env.AGENT_TOOLS_BIN, prefix: [] };
  if (!WIN) return { cmd: 'agent-tools', prefix: [] };
  const entry = [
    path.join(process.env.APPDATA ?? '', 'npm/node_modules/@yogioo/agent-tools/bin/agent-tools.mjs'),
    path.join(path.dirname(process.execPath), 'node_modules/@yogioo/agent-tools/bin/agent-tools.mjs'),
  ].find((p) => p && fsSync.existsSync(p));
  if (!entry) throw new Error('找不到 agent-tools，请设 AGENT_TOOLS_BIN 指向可执行文件');
  return { cmd: process.execPath, prefix: [entry] };
}

const DEFAULTS = {
  runner: 'pi',
  model: '',
  thinking: '',
  sandbox: 'workspace-write',
  attempts: 2,
  actor: 'ai',
  readyLabel: 'ready-for-agent',
  timeoutMs: 1800000,
  gitCommit: true,
};

/** 配置在项目的 .hlwd/config.json（看板里的「设置」写的就是它），engine 只读。 */
export async function loadConfig(projectDir = process.cwd()) {
  const cfg = await readProjectConfig(projectDir).catch(() => ({ engine: {} }));
  return { ...DEFAULTS, ...(cfg.engine ?? {}) };
}

export function log(message) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

/** 跑一个命令，返回 {code, out, err}；不抛错，调用方自己判。 */
export function run(cmd, args, { cwd = process.cwd(), input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('error', (e) => resolve({ code: -1, out, err: e.message }));
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(input ?? '');
  });
}

/** 只替换已知占位符，正文里的 {{ }} 原样保留。 */
export function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (whole, key) => (key in vars ? String(vars[key]) : whole));
}

/** 项目自定义提示词在 .hlwd/prompts/；没写就回落到工具自带模板。 */
export async function readPrompt(name, projectDir = process.cwd()) {
  const prompts = await readPrompts(projectDir).catch(() => ({}));
  return prompts[name] ?? '';
}

/**
 * 跑项目门禁（<项目>/.hlwd/gate.mjs）。只回报 pass 与原因，不抛错。
 * 单独进程跑，门禁崩溃/超时不会拖垮引擎；返回值看不懂也算不通过。
 */
export function runGate({ gateFile, context, timeoutMs = GATE_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [GATE_RUNNER, gateFile], {
      cwd: context.workdir,
      windowsHide: true,
    });
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ pass: false, reason: `门禁跑不起来：${e.message}`, out, err, ms: Date.now() - started });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      let verdict = null;
      for (const line of out.trim().split('\n').reverse()) {
        try {
          verdict = JSON.parse(line);
          break;
        } catch {
          // 上一行不是结论，继续往前找
        }
      }
      const tail = (err.trim() || out.trim()).slice(-500);
      const pass = !timedOut && verdict?.pass === true;
      const reason = timedOut
        ? `门禁超时（${Math.round(timeoutMs / 1000)}s）被中止`
        : verdict?.reason || (pass ? '门禁通过' : tail || `门禁退出码 ${code}`);
      resolve({ pass, reason: String(reason), out, err, ms: Date.now() - started });
    });
    child.stdin.end(JSON.stringify(context));
  });
}

/**
 * 一次 agent 回合。语义只有「跑没跑起来」——不表示做完或通过。
 * 见 engine/skills/agent-run/SKILL.md。
 */
export async function agentTurn({ cfg, workdir, promptFile, outDir }) {
  const args = [
    'agent-run', 'run',
    '--runner', cfg.runner,
    '--workdir', workdir,
    '--prompt-file', promptFile,
    '--out-dir', outDir,
    '--sandbox', cfg.sandbox,
  ];
  if (cfg.model) args.push('--model', cfg.model);
  if (cfg.thinking) args.push('--thinking', cfg.thinking);
  if (cfg.timeoutMs) args.push('--timeout', String(cfg.timeoutMs));

  const { cmd, prefix } = resolveAgentTools();
  const { code, out, err } = await run(cmd, [...prefix, ...args], { cwd: workdir });
  let facts = null;
  try {
    facts = JSON.parse(out.trim().split('\n').pop());
  } catch {
    facts = null;
  }
  const ok = code === 0 && facts && facts.exitCode === 0 && !facts.timedOut && !facts.aborted;
  return {
    ok,
    facts,
    error: ok ? null : (err.trim() || out.trim()).slice(-500) || `agent-tools 退出码 ${code}`,
  };
}
