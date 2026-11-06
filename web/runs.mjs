// 只读端口：把 engine 的运行记录（.engine/runs/*/run.json）给看板看。
// 只读，不写；真相源仍然是 beads。
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RUNS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.engine', 'runs');
const SAFE = /^[A-Za-z0-9._-]+$/;

/** 该卡片的所有运行记录，新的在前。 */
export async function listRuns(cardId) {
  if (!SAFE.test(cardId)) return [];
  let names = [];
  try {
    names = await fs.readdir(RUNS_DIR);
  } catch {
    return []; // 还没跑过 engine
  }
  const runs = [];
  for (const name of names) {
    if (!name.startsWith(`${cardId}-`)) continue;
    try {
      runs.push(JSON.parse(await fs.readFile(path.join(RUNS_DIR, name, 'run.json'), 'utf8')));
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
    return JSON.parse(await fs.readFile(path.join(RUNS_DIR, runId, 'run.json'), 'utf8'));
  } catch {
    return null;
  }
}
