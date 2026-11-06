// 唯一配置文件的读写口：状态/优先级的中文名 + AI 执行配置。
// web 只读写这个文件（不碰 beads schema），engine 只读它。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'config.json');

const DEFAULT_LABELS = { statuses: {}, priorities: { 0: '紧急', 1: '高', 2: '中', 3: '低', 4: '最低' } };
const ENGINE_KEYS = ['runner', 'model', 'thinking', 'sandbox', 'attempts', 'actor', 'readyLabel', 'timeoutMs', 'gitCommit'];
const RUNNERS = ['pi', 'codex', 'agent'];
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];

const str = (v, fallback = '') => (typeof v === 'string' ? v : fallback);

export async function readConfig() {
  let raw;
  try {
    raw = JSON.parse(await fs.readFile(CONFIG_FILE, 'utf8'));
  } catch {
    raw = {};
  }
  return {
    labels: {
      statuses: { ...DEFAULT_LABELS.statuses, ...(raw.labels?.statuses ?? {}) },
      priorities: { ...DEFAULT_LABELS.priorities, ...(raw.labels?.priorities ?? {}) },
    },
    columns: Array.isArray(raw.columns) && raw.columns.length ? raw.columns.map(String) : Object.keys(raw.labels?.statuses ?? {}),
    engine: Object.fromEntries(ENGINE_KEYS.map((k) => [k, raw.engine?.[k] ?? null])),
  };
}

/** 只接受认识的字段，类型不对就报错——宁可不保存，也不写坏配置。 */
export async function saveConfig(patch = {}) {
  const current = await readConfig();
  const next = {
    labels: {
      statuses: { ...current.labels.statuses },
      priorities: { ...current.labels.priorities },
    },
    columns: current.columns,
    engine: { ...current.engine },
  };

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
    if (engine[key] !== undefined) next.engine[key] = str(engine[key]).trim();
  }

  next.columns = [...new Set([...next.columns, ...Object.keys(next.labels.statuses)])];
  await fs.writeFile(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
