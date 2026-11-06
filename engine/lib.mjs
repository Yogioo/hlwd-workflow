// engine 内部小工具：跑命令、读配置、渲染提示词。
// 这里不碰 beads（beads 只在 web/beads.mjs 里），也不做流程判断。
import { spawn } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));

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

/** 配置在仓库根的 config.json（看板里的「设置」写的就是它），engine 只读。 */
export async function loadConfig() {
  let raw = {};
  try {
    raw = JSON.parse(await fs.readFile(path.join(ENGINE_DIR, '..', 'config.json'), 'utf8'));
  } catch {
    // 没有配置文件就用默认值，不拦流程
  }
  return { ...DEFAULTS, ...(raw.engine ?? {}) };
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

export async function readPrompt(name) {
  return fs.readFile(path.join(ENGINE_DIR, 'prompts', `${name}.md`), 'utf8');
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
