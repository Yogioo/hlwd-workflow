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

export const ENGINE_KEYS = ['runner', 'model', 'thinking', 'sandbox', 'attempts', 'actor', 'readyLabel', 'timeoutMs', 'autoWatch', 'presets', 'nodes'];
export const RUNNERS = ['pi', 'codex', 'agent'];
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];
/** 会起 agent 回合、要选 AI 预设的节点。 */
export const STAGES = ['execute', 'review'];
export const STAGE_LABEL = { execute: '执行', review: '审查' };
/** 能配自己行为的节点：两个 AI 节点挂预设，收尾节点决定通过后要不要提交。 */
export const NODES = [...STAGES, 'complete'];
/** 预设里决定「用谁跑」的三个字段；sandbox / attempts / 超时是整条流水线的参数，不进预设。 */
export const PRESET_KEYS = ['runner', 'model', 'thinking'];
export const MAX_PRESETS = 20;
const PRESET_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const PRESET_NAME_MAX = 40;
const PRESET_VALUE_MAX = 120;
const DEFAULT_PRESET = { id: 'default', name: '默认', runner: 'pi', model: '', thinking: '' };
const defaultNodes = () => ({
  ...Object.fromEntries(STAGES.map((stage) => [stage, { preset: DEFAULT_PRESET.id }])),
  complete: { commit: true },
});

const str = (value) => (value == null ? '' : String(value).trim());

/** 手改配置也收敛成能用的预设：坏的条目丢掉；一份都不剩时由调用方补默认。 */
function cleanPresets(input) {
  if (!Array.isArray(input)) return [];
  const ids = new Set();
  const out = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const id = str(raw.id);
    if (!PRESET_ID.test(id) || ids.has(id)) continue;
    ids.add(id);
    out.push({
      id,
      name: (str(raw.name) || id).slice(0, PRESET_NAME_MAX),
      runner: RUNNERS.includes(raw.runner) ? raw.runner : 'pi',
      model: str(raw.model).slice(0, PRESET_VALUE_MAX),
      thinking: str(raw.thinking).slice(0, PRESET_VALUE_MAX),
    });
    if (out.length >= MAX_PRESETS) break;
  }
  return out;
}

/**
 * 节点配置收敛成能跑的形状：
 *   AI 节点只能指向存在的预设（坏引用回落到兜底，再不行用第一份）；
 *   收尾节点只认 commit 布尔值，缺了就继承旧的 engine.gitCommit（默认 true）。
 */
function cleanNodes(input, presets, fallback = {}, legacyCommit = true) {
  const first = presets[0]?.id ?? '';
  const nodes = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = {};
  for (const stage of STAGES) {
    const id = str(nodes[stage]?.preset);
    out[stage] = { preset: presets.some((p) => p.id === id) ? id : (fallback[stage] ?? first) };
  }
  const commit = typeof nodes.complete?.commit === 'boolean' ? nodes.complete.commit : legacyCommit !== false;
  out.complete = { commit };
  return out;
}

/**
 * 旧配置折成预设：engine.stages.{execute,review} 各成一份预设，engine.runner/model/thinking
 * 成为「默认」预设。只在读的时候折算，下次保存才落新形状——读不写盘。
 */
function migrateLegacy(raw = {}) {
  const base = {
    ...DEFAULT_PRESET,
    runner: RUNNERS.includes(raw.runner) ? raw.runner : DEFAULT_PRESET.runner,
    model: str(raw.model).slice(0, PRESET_VALUE_MAX),
    thinking: str(raw.thinking).slice(0, PRESET_VALUE_MAX),
  };
  const presets = [base];
  const fallback = {};
  for (const stage of STAGES) {
    const legacy = raw.stages?.[stage] ?? {};
    const override = {};
    for (const key of PRESET_KEYS) {
      const value = str(legacy[key]).slice(0, PRESET_VALUE_MAX);
      if (value) override[key] = value;
    }
    if (override.runner && !RUNNERS.includes(override.runner)) delete override.runner;
    const id = `stage-${stage}`;
    if (Object.keys(override).length) {
      presets.push({ ...base, ...override, id, name: STAGE_LABEL[stage] });
      fallback[stage] = id;
    } else {
      fallback[stage] = base.id;
    }
  }
  return { presets, fallback };
}

/** 配置里的 engine 收敛成完整形状：预设一定至少有一份，节点一定指向存在的预设。 */
function readEngine(rawInput) {
  const raw = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {};
  const engine = { ...DEFAULT_CONFIG.engine, ...raw };
  // 收尾节点接管旧的全局 gitCommit；缺省仍然是「提交」。
  const legacyCommit = typeof raw.gitCommit === 'boolean' ? raw.gitCommit : true;
  // 旧字段不对外暴露：stages 折成预设、gitCommit 折成 nodes.complete，presets/nodes 下面统一重建。
  delete engine.stages;
  delete engine.gitCommit;
  delete engine.presets;
  delete engine.nodes;
  // 旧的全局 runner/model/thinking 只在没有预设时被 migrateLegacy 用到，顺手收敛一下
  engine.runner = RUNNERS.includes(engine.runner) ? engine.runner : DEFAULT_PRESET.runner;
  engine.model = str(engine.model);
  engine.thinking = str(engine.thinking);
  const explicit = cleanPresets(raw.presets);
  if (explicit.length) {
    return { ...engine, presets: explicit, nodes: cleanNodes(raw.nodes, explicit, {}, legacyCommit) };
  }
  const { presets, fallback } = migrateLegacy(raw);
  return { ...engine, presets, nodes: cleanNodes(raw.nodes, presets, fallback, legacyCommit) };
}

/** 严格校验：页面写进来的预设宁可不保存，也不落一份坏配置。 */
function validatePresets(input) {
  if (!Array.isArray(input)) throw new Error('engine.presets 必须是数组');
  if (!input.length) throw new Error('至少要保留一个 AI 预设');
  if (input.length > MAX_PRESETS) throw new Error(`预设最多 ${MAX_PRESETS} 个`);
  const out = [];
  const ids = new Set();
  const names = new Set();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('每个预设都必须是对象');
    let id = str(raw.id);
    if (!id) {
      let n = out.length + 1;
      while (ids.has(`p-${n}`)) n += 1;
      id = `p-${n}`;
    }
    if (!PRESET_ID.test(id)) throw new Error(`预设 id 只能是 1–32 位小写字母、数字或 -：${id}`);
    if (ids.has(id)) throw new Error(`预设 id 重复：${id}`);
    const name = str(raw.name);
    if (!name) throw new Error('预设名称不能为空');
    if (name.length > PRESET_NAME_MAX) throw new Error(`预设名称不能超过 ${PRESET_NAME_MAX} 个字符`);
    if (names.has(name)) throw new Error(`预设「${name}」重名`);
    const runner = str(raw.runner);
    if (!RUNNERS.includes(runner)) throw new Error(`预设「${name}」的执行器只能是 ${RUNNERS.join(' / ')}`);
    const model = str(raw.model);
    const thinking = str(raw.thinking);
    if (model.length > PRESET_VALUE_MAX) throw new Error(`预设「${name}」的模型名不能超过 ${PRESET_VALUE_MAX} 个字符`);
    if (thinking.length > PRESET_VALUE_MAX) throw new Error(`预设「${name}」的思考强度不能超过 ${PRESET_VALUE_MAX} 个字符`);
    ids.add(id);
    names.add(name);
    out.push({ id, name, runner, model, thinking });
  }
  return out;
}

export const MAX_TAGS = 200;
const TAG_NAME_MAX = 40;
const TAG_DESC_MAX = 200;
const TAG_COLOR = /^#[0-9a-f]{6}$/i;

export const DEFAULT_CONFIG = {
  labels: {
    statuses: { open: '待接', in_progress: '执行中', review: '待审', closed: '已完成' },
    priorities: { 0: '紧急', 1: '高', 2: '中', 3: '低', 4: '最低' },
  },
  columns: ['open', 'in_progress', 'review', 'closed'],
  // 标签目录只存展示信息（颜色/说明/归档）；哪些单有什么标签仍从 beads 读。
  tags: [],
  engine: {
    runner: 'pi',
    model: '',
    thinking: '',
    sandbox: 'workspace-write',
    attempts: 2,
    actor: 'ai',
    readyLabel: 'ready-for-agent',
    timeoutMs: 1800000,
    autoWatch: false,
    // AI 配置的唯一来源：预设 + 节点挂载。runner/model/thinking 是旧字段，留着只为兼容读取；
    // 「通过后是否提交」不在这里，它是收尾节点自己的配置（nodes.complete.commit）。
    presets: [{ ...DEFAULT_PRESET }],
    nodes: defaultNodes(),
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

// —— 标签目录 ——
// 标签名是 beads 的原生 label；这里只校验展示层能接受的形状，不去改 bd 的命名规则。
export function tagName(value, { strict = true } = {}) {
  const name = String(value ?? '').trim();
  if (!name) {
    if (strict) throw new Error('标签名不能为空');
    return '';
  }
  if (name.length > TAG_NAME_MAX) throw new Error(`标签名不能超过 ${TAG_NAME_MAX} 个字符`);
  if (name.includes(',')) throw new Error('标签名不能包含逗号（新建工单时用逗号分隔标签）');
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error('标签名不能包含控制字符');
  return name;
}

export function tagColor(value) {
  const color = String(value ?? '').trim();
  if (!color) return '';
  if (!TAG_COLOR.test(color)) throw new Error('标签颜色只能是 #rrggbb');
  return color.toLowerCase();
}

/** 把用户手改的配置收敛成能用的目录：坏的条目丢掉，不把页面带崩。 */
function cleanTags(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    let name = '';
    try {
      name = tagName(raw?.name, { strict: false });
    } catch {
      continue;
    }
    if (!name || seen.has(name) || out.length >= MAX_TAGS) continue;
    let color = '';
    try {
      color = tagColor(raw?.color);
    } catch {
      color = '';
    }
    seen.add(name);
    out.push({
      name,
      color,
      desc: String(raw?.desc ?? '').trim().slice(0, TAG_DESC_MAX),
      archived: raw?.archived === true,
    });
  }
  return out;
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
    tags: cleanTags(raw.tags),
    // engine 单独收敛：预设至少一份、节点一定指向存在的预设（旧 stages 在这里折成预设）
    engine: readEngine(raw.engine),
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
  // 旧客户端还在提交 engine.gitCommit：折进收尾节点，不再写回全局字段。
  if (engine.gitCommit !== undefined) next.engine.nodes.complete = { commit: Boolean(engine.gitCommit) };
  if (engine.autoWatch !== undefined) next.engine.autoWatch = Boolean(engine.autoWatch);
  for (const key of ['model', 'thinking', 'actor', 'readyLabel']) {
    if (engine[key] !== undefined) next.engine[key] = String(engine[key]).trim();
  }
  // AI 预设：整表替换（页面一次存全量），严格校验；节点随后挂载到预设上。
  if (engine.presets !== undefined) next.engine.presets = validatePresets(engine.presets);
  if (engine.nodes !== undefined) {
    if (!engine.nodes || typeof engine.nodes !== 'object' || Array.isArray(engine.nodes)) {
      throw new Error('engine.nodes 必须是对象');
    }
    for (const [nodeId, raw] of Object.entries(engine.nodes)) {
      if (!NODES.includes(nodeId)) throw new Error(`未知节点 ${nodeId}：只有 ${NODES.join(' / ')} 可以配置`);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`engine.nodes.${nodeId} 必须是对象`);
      if (nodeId === 'complete') {
        for (const key of Object.keys(raw)) {
          if (key !== 'commit') throw new Error(`engine.nodes.complete 不认识字段 ${key}`);
        }
        if (typeof raw.commit !== 'boolean') throw new Error('engine.nodes.complete.commit 必须是 true / false');
        next.engine.nodes.complete = { commit: raw.commit };
        continue;
      }
      for (const key of Object.keys(raw)) {
        if (key !== 'preset') throw new Error(`engine.nodes.${nodeId} 不认识字段 ${key}`);
      }
      if (typeof raw.preset !== 'string') throw new Error(`engine.nodes.${nodeId}.preset 必须是字符串`);
      next.engine.nodes[nodeId] = { preset: raw.preset.trim() };
    }
  }
  for (const stage of STAGES) {
    const id = next.engine.nodes[stage]?.preset ?? '';
    if (!id) throw new Error(`${STAGE_LABEL[stage]}节点必须选一个预设`);
    if (next.engine.presets.some((preset) => preset.id === id)) continue;
    const used = STAGES.filter((name) => next.engine.nodes[name]?.preset === id).map((name) => `${STAGE_LABEL[name]}节点`);
    // 原来就有这份预设 = 用户想删但它还挂着；从来没有 = 节点引用写错了。
    if (current.engine.presets.some((preset) => preset.id === id)) {
      throw new Error(`预设「${id}」正被${used.join('、')}使用，先给它换一个再删`);
    }
    throw new Error(`预设「${id}」不存在：${used.join('、')}选错了`);
  }
  // 旧字段不再写回：stages 已折成预设，gitCommit 已折成收尾节点，presets/nodes 才是配置。
  delete next.engine.stages;
  delete next.engine.gitCommit;
  if (!next.engine.readyLabel) throw new Error('可派标签不能为空：engine 靠它找就绪单');

  if (patch.tags !== undefined) {
    if (!Array.isArray(patch.tags)) throw new Error('tags 必须是数组');
    if (patch.tags.length > MAX_TAGS) throw new Error(`标签最多 ${MAX_TAGS} 个`);
    const seen = new Set();
    const tags = [];
    for (const raw of patch.tags) {
      const name = tagName(raw?.name);
      if (seen.has(name)) throw new Error(`标签「${name}」重复`);
      seen.add(name);
      tags.push({
        name,
        color: tagColor(raw?.color),
        desc: String(raw?.desc ?? '').trim().slice(0, TAG_DESC_MAX),
        archived: raw?.archived === true,
      });
    }
    next.tags = tags;
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
    if (typeof prompts[name] !== 'string') continue;
    const file = path.join(promptsDir(projectDir), `${name}.md`);
    // 清空 = 把工具自带模板写回项目文件。不能只删文件：ensureProject 下次打开
    // 发现缺文件又会补一份，用户会以为“恢复默认”没生效。
    if (!prompts[name].trim()) {
      await fsp.copyFile(DEFAULT_PROMPTS[name], file).catch(async () => {
        await fsp.writeFile(file, await fsp.readFile(DEFAULT_PROMPTS[name], 'utf8'), 'utf8');
      });
      continue;
    }
    await fsp.writeFile(file, prompts[name], 'utf8');
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

// —— 附件（图片/文件）：存项目里，不进 beads，也不进版本库 ——
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);
const MIME_BY_EXT = {
  // 图片
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  // 文档 / 数据
  '.pdf': 'application/pdf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.log': 'text/plain; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.tsv': 'text/tab-separated-values; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // 压缩包
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tgz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.7z': 'application/x-7z-compressed',
  '.rar': 'application/vnd.rar',
  // 音视频
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
};

const extOf = (name) => path.extname(String(name ?? '')).toLowerCase();

/**
 * 能不能让浏览器**以本站的身份直接打开**这个附件。
 * SVG 不行：它里面可以带 <script>，被当页面打开就是在我们的 origin 里执行别人的代码。
 * （在 <img> 里渲染不受影响 ——— 子资源不看 content-disposition，脚本也不会执行。）
 * 其他未知类型走 application/octet-stream + nosniff，浏览器也只会下载。
 */
export const attachmentInlineSafe = (name) => extOf(name) !== '.svg';
/** 卡片 id 进目录名前先洗一遗：不许拼路径。 */
export function safeCardId(cardId) {
  const cleaned = String(cardId ?? '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 80);
  return cleaned || 'card';
}

/** 用户给的文件名：丢目录、丢控制字符，保留中文与空格。 */
export function safeFileName(name) {
  const base = String(name ?? '').replace(/\\/g, '/').split('/').pop() ?? '';
  const cleaned = base.replace(/[^\w.\- \u4e00-\u9fa5]+/g, '_').replace(/\s+/g, ' ').trim();
  return (cleaned || 'file').slice(0, 80);
}

export const attachmentsDir = (projectDir, cardId = '') =>
  path.join(hlwdDir(projectDir), 'attachments', cardId ? safeCardId(cardId) : '');

export const attachmentKind = (name) => (IMAGE_EXT.has(extOf(name)) ? 'image' : 'file');
export const attachmentMime = (name) => MIME_BY_EXT[extOf(name)] ?? 'application/octet-stream';
export const attachmentUrl = (cardId, stored) =>
  `/api/attachments/${encodeURIComponent(safeCardId(cardId))}/${encodeURIComponent(stored)}`;

function attachmentMeta(stored) {
  const name = stored.replace(/^\d+-/, '');
  return { stored, name, kind: attachmentKind(name) };
}

async function uniqueStoredName(dir, base) {
  let stored = base;
  for (let n = 2; ; n += 1) {
    const exists = await fsp
      .access(path.join(dir, stored))
      .then(() => true)
      .catch(() => false);
    if (!exists) return stored;
    stored = `${base.replace(/(\.[^.]+)?$/, `-${n}$1`)}`;
  }
}

// 附件有两种用途，存在同一个目录里，用一张旁挂表区分：
//   card   显式上传 / 拖到面板：算工单的附件，列在「附件」里
//   inline 粘进评论的图：它是评论 markdown 的一部分，不进附件列表（否则每条评论的图都变成工单资产）
const SCOPES_FILE = '.scopes.json';
const scopesFile = (dir) => path.join(dir, SCOPES_FILE);

async function readScopes(dir) {
  const raw = await fsp.readFile(scopesFile(dir), 'utf8').catch(() => null);
  if (!raw) return {};
  try {
    return JSON.parse(raw) ?? {};
  } catch {
    return {};
  }
}

async function markScope(dir, stored, scope) {
  if (scope !== 'inline') return;
  const map = await readScopes(dir);
  map[stored] = 'inline';
  await fsp.writeFile(scopesFile(dir), `${JSON.stringify(map, null, 2)}\n`);
}

/** 存一个附件：返回 {stored, name, kind, size, at, scope}。 */
export async function saveAttachment(projectDir, cardId, { name, data, scope = 'card' }) {
  const bytes = data?.length ?? 0;
  if (!bytes) throw new Error('空文件');
  if (bytes > MAX_ATTACHMENT_BYTES) throw new Error(`附件太大（上限 ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB）`);
  const dir = attachmentsDir(projectDir, cardId);
  await fsp.mkdir(dir, { recursive: true });
  const at = Date.now();
  const stored = await uniqueStoredName(dir, `${at}-${safeFileName(name)}`);
  await fsp.writeFile(path.join(dir, stored), data);
  await markScope(dir, stored, scope);
  return { ...attachmentMeta(stored), size: bytes, at, scope };
}

/** 列一张卡的附件（新的在后）。粘进评论的 inline 图不算附件，不在这里出现。 */
export async function listAttachments(projectDir, cardId) {
  const dir = attachmentsDir(projectDir, cardId);
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const scopes = await readScopes(dir);
  const out = [];
  for (const stored of names.sort()) {
    if (stored === SCOPES_FILE || scopes[stored] === 'inline') continue;
    const stat = await fsp.stat(path.join(dir, stored)).catch(() => null);
    if (!stat?.isFile()) continue;
    const at = Number(/(\d+)-/.exec(stored)?.[1] ?? 0);
    out.push({ ...attachmentMeta(stored), size: stat.size, at });
  }
  return out;
}

/** 读一个附件；返回 null 表示不存在或路径越界。 */
export async function readAttachment(projectDir, cardId, stored) {
  const dir = attachmentsDir(projectDir, cardId);
  const file = path.resolve(dir, String(stored ?? ''));
  if (!file.startsWith(path.resolve(dir) + path.sep)) return null;
  const data = await fsp.readFile(file).catch(() => null);
  return data ? { data, meta: { ...attachmentMeta(path.basename(file)), size: data.length } } : null;
}

export async function removeAttachment(projectDir, cardId, stored) {
  const dir = attachmentsDir(projectDir, cardId);
  const file = path.resolve(dir, String(stored ?? ''));
  if (!file.startsWith(path.resolve(dir) + path.sep)) return false;
  return fsp
    .rm(file, { force: true })
    .then(async () => {
      // 顺手清掉旁挂表里那一项，别让 .scopes.json 越积越脏
      const scopes = await readScopes(dir);
      if (scopes[stored]) {
        delete scopes[stored];
        await fsp.writeFile(scopesFile(dir), `${JSON.stringify(scopes, null, 2)}\n`).catch(() => {});
      }
      return true;
    })
    .catch(() => false);
}

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
  // 运行记录与附件是产物：用 .hlwd/.gitignore 排除，不动项目自己的 .gitignore
  const hlwdIgnore = path.join(hlwdDir(dir), '.gitignore');
  const ignoreLines = ['runs/', 'journal.ndjson', 'attachments/'];
  const currentIgnore = await fsp.readFile(hlwdIgnore, 'utf8').catch(() => null);
  if (currentIgnore === null) {
    await fsp.writeFile(hlwdIgnore, `${ignoreLines.join('\n')}\n`, 'utf8');
    created.push('.hlwd/.gitignore');
  } else {
    // 老项目补上新条目（只追加，不覆盖已有内容）
    const missing = ignoreLines.filter((line) => !currentIgnore.split('\n').includes(line));
    if (missing.length) await fsp.writeFile(hlwdIgnore, `${currentIgnore.replace(/\n?$/, '\n')}${missing.join('\n')}\n`, 'utf8');
  }

  // review 只为旧数据兼容保留：新流程把审查阶段放在 run.json 里，不再写这个工单状态。
  await bd(['config', 'set', 'status.custom', 'review:wip'], dir).catch(() => {});

  const config = await readProjectConfig(dir);
  return { dir, created, config };
}
