// 只读端口：把 engine 的运行记录（<项目>/.hlwd/runs/*/run.json 与 journal）给看板看。
// 只读，不写；真相源仍然是 beads。
import fs from 'node:fs/promises';
import path from 'node:path';
import { journalFile, runsDir } from '../project.mjs';

const SAFE = /^[A-Za-z0-9._-]+$/;

let projectDir = process.cwd();

export function setProjectDir(dir) {
  projectDir = path.resolve(dir);
}

/** 该卡片的最新一次运行记录；没有就返回 null。给工作流进度用。 */
export async function latestRun(cardId) {
  if (!SAFE.test(cardId)) return null;
  const base = runsDir(projectDir);
  let names = [];
  try {
    names = await fs.readdir(base);
  } catch {
    return null;
  }
  let best = null;
  for (const name of names) {
    if (!name.startsWith(`${cardId}-`)) continue;
    try {
      const run = JSON.parse(await fs.readFile(path.join(base, name, 'run.json'), 'utf8'));
      if (!best || String(run.startedAt ?? '').localeCompare(String(best.startedAt ?? '')) > 0) best = run;
    } catch {
      // 半截目录（正在跑）或旧格式，跳过
    }
  }
  return best;
}

/** 看板一次读全：cardId → 最新 run。 */
export async function latestRuns() {
  const base = runsDir(projectDir);
  let names = [];
  try {
    names = await fs.readdir(base);
  } catch {
    return new Map();
  }
  const out = new Map();
  for (const name of names) {
    try {
      const run = JSON.parse(await fs.readFile(path.join(base, name, 'run.json'), 'utf8'));
      const id = run?.card?.id;
      if (!id) continue;
      const prev = out.get(id);
      if (!prev || String(run.startedAt ?? '').localeCompare(String(prev.startedAt ?? '')) > 0) out.set(id, run);
    } catch {
      // 半截目录/旧格式，跳过
    }
  }
  return out;
}

/** 该卡片的所有运行记录，新的在前。 */
export async function listRuns(cardId) {
  if (!SAFE.test(cardId)) return [];
  const base = runsDir(projectDir);
  let names = [];
  try {
    names = await fs.readdir(base);
  } catch {
    return []; // 还没跑过 engine
  }
  const runs = [];
  for (const name of names) {
    if (!name.startsWith(`${cardId}-`)) continue;
    try {
      runs.push(JSON.parse(await fs.readFile(path.join(base, name, 'run.json'), 'utf8')));
    } catch {
      // 半截目录（正在跑）或旧格式，跳过
    }
  }
  return runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

/** 单次运行记录；也用于按 runId 精确取。 */
export async function getRun(runId) {
  if (!SAFE.test(runId)) return null;
  try {
    return JSON.parse(await fs.readFile(path.join(runsDir(projectDir), runId, 'run.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** 该卡片在 journal 里的事件（原始行，给「全链路」用）。 */
export async function journalFor(cardId, limit = 200) {
  if (!SAFE.test(cardId)) return [];
  let text = '';
  try {
    text = await fs.readFile(journalFile(projectDir), 'utf8');
  } catch {
    return [];
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.card === cardId) events.push(event);
    } catch {
      // 半行/损坏行跳过
    }
  }
  return events.slice(-limit);
}
