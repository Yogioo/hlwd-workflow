// 可追溯：每次运行一个 run.json（人读），全局一条 journal.ndjson（机器/时间线读）。
// 只写文件，不改 beads；beads 仍是唯一真相源，这两样是产物。
import fs from 'node:fs/promises';
import path from 'node:path';

const iso = () => new Date().toISOString();

/** journal 是一行一事件，长文本截断；全文留在 run.json 里。 */
export function clip(text, max = 160) {
  const s = String(text ?? '').replaceAll('\n', ' ');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

export async function appendJournal(workdir, event) {
  const file = path.join(workdir, '.engine', 'journal.ndjson');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(event)}\n`, 'utf8');
}

/** 建运行目录 + 初始 run.json；返回 save() 供各阶段落盘。 */
export async function createManifest({ workdir, cfg, issue }) {
  const runId = `${issue.id}-${Date.now()}`;
  const dir = path.join(workdir, '.engine', 'runs', runId);

  const manifest = {
    runId,
    card: { id: issue.id, title: issue.title, labels: issue.labels, priority: issue.priority },
    runner: cfg.runner,
    actor: cfg.actor,
    startedAt: iso(),
    endedAt: null,
    outcome: 'running',
    commit: null,
    reason: null,
    attempts: [],
  };

  const save = async () => {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'run.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  };

  const journal = (event, extra = {}) => appendJournal(workdir, { at: iso(), event, card: issue.id, run: runId, ...extra });

  await save();
  return { manifest, dir, save, journal };
}

/** 收尾时统一记账，避免某个分支忘了写。 */
export async function finish(manifest, save, journal, { outcome, reason = null, commit = null }) {
  manifest.outcome = outcome;
  manifest.reason = reason;
  manifest.commit = commit ?? manifest.commit;
  manifest.endedAt = iso();
  await save();
  await journal(outcome, { reason: clip(reason), commit: manifest.commit });
}
