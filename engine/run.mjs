#!/usr/bin/env node
// engine 入口：接一张单，走完 接单 → 执行 → 审查 → 完成。
//   node engine/run.mjs                 # 接下一张 ready 单
//   node engine/run.mjs --dry           # 只看会接哪张，不动数据
//   node engine/run.mjs --id hlwd-abc   # 指定工单（已被接单时用）
//   node engine/run.mjs --attempts 1 --allow-dirty
import fs from 'node:fs/promises';
import path from 'node:path';
import * as beads from '../web/beads.mjs';
import { complete, handback } from './flows/complete.mjs';
import { claimNext, listCandidates } from './flows/claim.mjs';
import { execute } from './flows/execute.mjs';
import { review } from './flows/review.mjs';
import { loadConfig, log, run } from './lib.mjs';

function parseArgs(argv) {
  const args = { dry: false, id: null, attempts: null, allowDirty: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split('=');
    const value = inline ?? argv[i + 1];
    if (flag === '--dry') args.dry = true;
    else if (flag === '--allow-dirty') args.allowDirty = true;
    else if (flag === '--id') args.id = value;
    else if (flag === '--attempts') args.attempts = Number(value);
    else throw new Error(`未知参数：${argv[i]}`);
  }
  return args;
}

async function assertClean(workdir, allowDirty) {
  const res = await run('git', ['status', '--porcelain'], { cwd: workdir });
  if (res.code !== 0) return; // 不是 git 仓库就不拦
  const dirty = res.out.trim();
  if (dirty && !allowDirty) {
    console.error('工作区不干净，脏改动会被算进这张单的提交。先处理，或加 --allow-dirty。\n');
    console.error(dirty);
    process.exit(2);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = await loadConfig();
  const workdir = process.cwd();
  const attempts = args.attempts ?? cfg.attempts;

  if (args.dry) {
    const candidates = await listCandidates({ cfg });
    if (!candidates.length) return console.log(`没有就绪工单（open + ${cfg.readyLabel}）`), 0;
    console.log(`会接：${candidates[0].id} — ${candidates[0].title}`);
    if (candidates.length > 1) console.log(`队列里还有 ${candidates.length - 1} 张。`);
    return 0;
  }

  await assertClean(workdir, args.allowDirty);

  let claimed;
  if (args.id) {
    claimed = await beads.getIssue(args.id);
    log(`指定工单 ${claimed.issue.id}（${claimed.issue.status}）`);
  } else {
    claimed = await claimNext({ cfg });
  }
  if (!claimed) {
    log(`没有就绪工单（open + ${cfg.readyLabel}）`);
    return 0;
  }

  const { issue } = claimed;
  const comments = claimed.comments;
  const runDir = path.join(workdir, '.engine', 'runs', `${issue.id}-${Date.now()}`);
  await fs.mkdir(runDir, { recursive: true });
  log(`运行目录 ${path.relative(workdir, runDir)}`);

  let feedback = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const exec = await execute({ cfg, workdir, issue, comments, runDir, attempt, feedback });
    if (!exec.ok) {
      await handback({ workdir, issue, runDir, reason: exec.error, status: 'open' });
      return 1;
    }

    const verdict = await review({ cfg, workdir, issue, runDir, attempt });
    if (verdict.pass) {
      await complete({ cfg, workdir, issue, runDir, checks: verdict.checks });
      return 0;
    }

    feedback = `${verdict.reason}\n（第 ${attempt} 轮审查原文：${path.relative(workdir, runDir)}）`;
    if (attempt < attempts) log(`审查不通过，退回执行端继续改（同一工作区）`);
  }

  await handback({ workdir, issue, runDir, reason: feedback, status: 'in_progress' });
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`engine 中止：${err.message}`);
    process.exit(1);
  });
