// engine 内部小工具：跑命令、读配置、渲染提示词。
// 这里不碰 beads（beads 只在 web/beads.mjs 里），也不做流程判断。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ENGINE_DIR = path.dirname(fileURLToPath(import.meta.url));

export async function loadConfig() {
  const raw = await fs.readFile(path.join(ENGINE_DIR, 'config.json'), 'utf8');
  return JSON.parse(raw);
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

  const { code, out, err } = await run('agent-tools', args, { cwd: workdir });
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
