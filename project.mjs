// 项目层：一个"工作目录"就是一个项目。
// 项目自带 .hlwd/（配置 + 提示词 + 运行记录）与 .beads/（工单），工具本身不存项目数据。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(os.homedir(), '.hlwd');
const STATE_FILE = path.join(STATE_DIR, 'state.json');

export const ENGINE_KEYS = ['runner', 'model', 'thinking', 'sandbox', 'attempts', 'actor', 'readyLabel', 'timeoutMs', 'gitCommit'];
const RUNNERS = ['pi', 'codex', 'agent'];
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];

export const DEFAULT_CONFIG = {
  labels: {
    statuses: { open: '待接', in_progress: '执行中', review: '待审', closed: '已完成' },
    priorities: { 0: '紧急', 1: '高', 2: '中', 3: '低', 4: '最低' },
  },
  columns: ['open', 'in_progress', 'review', 'closed'],
  engine: {
    runner: 'pi',
    model: '',
    thinking: '',
    sandbox: 'workspace-write',
    attempts: 2,
    actor: 'ai',
    readyLabel: 'ready-for-agent',
    timeoutMs: 1800000,
    gitCommit: true,
  },
};

export const hlwdDir = (projectDir) => path.join(projectDir, '.hlwd');
export const runsDir = (projectDir) => path.join(hlwdDir(projectDir), 'runs');
export const journalFile = (projectDir) => path.join(hlwdDir(projectDir), 'journal.ndjson');
export const promptsDir = (projectDir) => path.join(hlwdDir(projectDir), 'prompts');
export const gateFile = (projectDir) => path.join(hlwdDir(projectDir), 'gate.mjs');
const configFile = (projectDir) => path.join(hlwdDir(projectDir), 'config.json');

const readJson = async (file, fallback) => {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
};

// —— 全局态（只记"打开了哪个项目"，不是项目配置） ——
export async function readState() {
  const raw = await readJson(STATE_FILE, {});
  return { project: raw.project ?? null, recent: Array.isArray(raw.recent) ? raw.recent : [] };
}

export async function setState({ project, recent }) {
  const current = await readState();
  const next = {
    project: project ?? current.project,
    recent: recent ?? current.recent,
  };
  await fsp.mkdir(STATE_DIR, { recursive: true });
  await fsp.writeFile(STATE_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

export async function rememberProject(dir) {
  const { recent } = await readState();
  const next = [dir, ...recent.filter((d) => d !== dir)].slice(0, 10);
  return setState({ project: dir, recent: next });
}

// —— 项目配置 ——
export async function readProjectConfig(projectDir) {
  const raw = await readJson(configFile(projectDir), {});
  return {
    labels: {
      statuses: { ...DEFAULT_CONFIG.labels.statuses, ...(raw.labels?.statuses ?? {}) },
      priorities: { ...DEFAULT_CONFIG.labels.priorities, ...(raw.labels?.priorities ?? {}) },
    },
    columns: Array.isArray(raw.columns) && raw.columns.length ? raw.columns.map(String) : [...DEFAULT_CONFIG.columns],
    engine: { ...DEFAULT_CONFIG.engine, ...(raw.engine ?? {}) },
  };
}

/** 只接受认识的字段，类型不对就报错——宁可不保存，也不写坏配置。 */
export async function saveProjectConfig(projectDir, patch = {}) {
  const current = await readProjectConfig(projectDir);
  const next = structuredClone(current);

  if (patch.labels?.statuses && typeof patch.labels.statuses === 'object') {
    for (const [key, label] of Object.entries(patch.labels.statuses)) {
      if (typeof label !== 'string' || !label.trim()) throw new Error(`状态 ${key} 的名称不能为空`);
      next.labels.statuses[key] = label.trim();
    }
  }
  if (patch.labels?.priorities && typeof patch.labels.priorities === 'object') {
    for (const [key, label] of Object.entries(patch.labels.priorities)) {
      if (typeof label !== 'string' || !label.trim()) throw new Error(`优先级 P${key} 的名称不能为空`);
      next.labels.priorities[key] = label.trim();
    }
  }

  const engine = patch.engine ?? {};
  if (engine.runner !== undefined) {
    if (!RUNNERS.includes(engine.runner)) throw new Error(`runner 只能是 ${RUNNERS.join(' / ')}`);
    next.engine.runner = engine.runner;
  }
  if (engine.sandbox !== undefined) {
    if (!SANDBOXES.includes(engine.sandbox)) throw new Error(`sandbox 只能是 ${SANDBOXES.join(' / ')}`);
    next.engine.sandbox = engine.sandbox;
  }
  if (engine.attempts !== undefined) {
    const n = Number(engine.attempts);
    if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error('attempts 只能是 1–5 的整数');
    next.engine.attempts = n;
  }
  if (engine.timeoutMs !== undefined) {
    const n = Number(engine.timeoutMs);
    if (!Number.isInteger(n) || n < 60000) throw new Error('timeoutMs 不能小于 60000');
    next.engine.timeoutMs = n;
  }
  if (engine.gitCommit !== undefined) next.engine.gitCommit = Boolean(engine.gitCommit);
  for (const key of ['model', 'thinking', 'actor', 'readyLabel']) {
    if (engine[key] !== undefined) next.engine[key] = String(engine[key]).trim();
  }

  next.columns = [...new Set([...next.columns, ...Object.keys(next.labels.statuses)])];
  await fsp.mkdir(hlwdDir(projectDir), { recursive: true });
  await fsp.writeFile(configFile(projectDir), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

// —— 提示词（项目可定制，缺失时回落到工具自带的默认模板） ——
const DEFAULT_PROMPTS = {
  execute: path.join(TOOL_DIR, 'engine', 'prompts', 'execute.md'),
  review: path.join(TOOL_DIR, 'engine', 'prompts', 'review.md'),
};

export async function readPrompts(projectDir) {
  const out = {};
  for (const [name, fallback] of Object.entries(DEFAULT_PROMPTS)) {
    try {
      out[name] = await fsp.readFile(path.join(promptsDir(projectDir), `${name}.md`), 'utf8');
    } catch {
      out[name] = await fsp.readFile(fallback, 'utf8').catch(() => '');
    }
  }
  return out;
}

export async function savePrompts(projectDir, prompts = {}) {
  await fsp.mkdir(promptsDir(projectDir), { recursive: true });
  for (const name of Object.keys(DEFAULT_PROMPTS)) {
    if (typeof prompts[name] !== 'string' || !prompts[name].trim()) continue;
    await fsp.writeFile(path.join(promptsDir(projectDir), `${name}.md`), prompts[name], 'utf8');
  }
  return readPrompts(projectDir);
}

// —— 门禁：项目自己的判定脚本。默认放行，用户改这个文件就能改判定规则 ——
// 契约见 AGENTS.md §4：export default async (ctx) => true | false | { pass, reason }
export const GATE_TEMPLATE = `// 项目门禁：引擎每轮「执行」之后跑一次它，决定这一轮算不算过关。
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
`;

// —— 打开项目：缺什么补什么，绝不覆盖已有内容 ——
function bdBin() {
  if (process.env.BD_BIN) return process.env.BD_BIN;
  if (process.platform !== 'win32') return 'bd';
  const candidates = [
    path.join(process.env.APPDATA ?? '', 'npm/node_modules/@beads/bd/bin/bd.exe'),
    path.join(path.dirname(process.execPath), 'node_modules/@beads/bd/bin/bd.exe'),
  ];
  return candidates.find((p) => p && fs.existsSync(p)) ?? 'bd.exe';
}

function bd(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bdBin(), args, { cwd, windowsHide: true });
    let err = '';
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('error', (e) => reject(new Error(`bd 启动失败：${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `bd 退出码 ${code}`))));
    child.stdin.end();
  });
}

const prefixOf = (dir) => path.basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'proj';

/** 打开项目：建 .hlwd/ 与其中的配置/提示词，缺 .beads 就 bd init。返回本次新建了什么。 */
export async function ensureProject(inputDir) {
  const dir = path.resolve(inputDir);
  const stat = await fsp.stat(dir).catch(() => null);
  if (!stat || !stat.isDirectory()) throw new Error(`目录不存在：${dir}`);

  const created = [];

  if (!fs.existsSync(hlwdDir(dir))) {
    await fsp.mkdir(hlwdDir(dir), { recursive: true });
    created.push('.hlwd/');
  }
  if (!fs.existsSync(configFile(dir))) {
    await fsp.writeFile(configFile(dir), `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, 'utf8');
    created.push('.hlwd/config.json');
  }
  if (!fs.existsSync(promptsDir(dir))) {
    await fsp.mkdir(promptsDir(dir), { recursive: true });
    created.push('.hlwd/prompts/');
  }
  for (const [name, fallback] of Object.entries(DEFAULT_PROMPTS)) {
    const target = path.join(promptsDir(dir), `${name}.md`);
    if (!fs.existsSync(target)) {
      await fsp.copyFile(fallback, target).catch(() => {});
      created.push(`.hlwd/prompts/${name}.md`);
    }
  }
  // 门禁脚本跟着项目走：用户改它，不碰工具代码
  if (!fs.existsSync(gateFile(dir))) {
    await fsp.writeFile(gateFile(dir), GATE_TEMPLATE, 'utf8');
    created.push('.hlwd/gate.mjs');
  }
  if (!fs.existsSync(runsDir(dir))) {
    await fsp.mkdir(runsDir(dir), { recursive: true });
    created.push('.hlwd/runs/');
  }

  if (!fs.existsSync(path.join(dir, '.beads'))) {
    await bd(['init', '--prefix', prefixOf(dir), '--non-interactive', '--skip-agents', '--skip-hooks'], dir);
    created.push('.beads/（bd init）');
  }
  // 运行记录是产物：用 .hlwd/.gitignore 排除，不动项目自己的 .gitignore
  const hlwdIgnore = path.join(hlwdDir(dir), '.gitignore');
  if (!fs.existsSync(hlwdIgnore)) {
    await fsp.writeFile(hlwdIgnore, 'runs/\njournal.ndjson\n', 'utf8');
    created.push('.hlwd/.gitignore');
  }

  // review 是工作流用的自定义状态；已配置过就跳过
  await bd(['config', 'set', 'status.custom', 'review:wip'], dir).catch(() => {});

  const config = await readProjectConfig(dir);
  return { dir, created, config };
}
