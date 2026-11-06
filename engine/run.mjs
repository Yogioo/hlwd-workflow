#!/usr/bin/env node
// engine 入口：接一张单，走完 接单 → 执行 → 审查 → 完成。
//   node engine/run.mjs                 # 接下一张 ready 单
//   node engine/run.mjs --dry           # 只看会接哪张，不动数据
//   node engine/run.mjs --project <dir> # 指定项目目录（默认当前目录）
//   node engine/run.mjs --id hlwd-abc   # 指定工单（已被接单时用）
//   node engine/run.mjs --attempts 1 --allow-dirty
import path from 'node:path';
import { ensureProject } from '../project.mjs';
import * as beads from '../web/beads.mjs';
import { complete, handback } from './flows/complete.mjs';
import { claim, claimNext, listCandidates } from './flows/claim.mjs';
import { execute } from './flows/execute.mjs';
import { gate as gateStage } from './flows/gate.mjs';
import { review } from './flows/review.mjs';
import { loadConfig, log, run } from './lib.mjs';
import { clip, createManifest, finish } from './manifest.mjs';

function parseArgs(argv) {
  const args = { dry: false, id: null, attempts: null, allowDirty: false, project: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const flag = token.split('=')[0];
    if (flag === '--dry') {
      args.dry = true;
      continue;
    }
    if (flag === '--allow-dirty') {
      args.allowDirty = true;
      continue;
    }
    if (['--project', '--id', '--attempts'].includes(flag)) {
      const inline = token.includes('=') ? token.slice(flag.length + 1) : null;
      const value = inline ?? argv[i + 1];
      if (inline === null) i += 1; // 吃掉值，别把它当参数
      if (value === undefined) throw new Error(`${flag} 需要一个值`);
      if (flag === '--project') args.project = value;
      else if (flag === '--id') args.id = value;
      else args.attempts = Number(value);
      continue;
    }
    throw new Error(`未知参数：${token}`);
  }
  return args;
}

async function assertClean(workdir, allowDirty) {
  const res = await run('git', ['status', '--porcelain'], { cwd: workdir });
  if (res.code !== 0) return; // 不是 git 仓库就不拦
  // .hlwd/ 是工具自身的配置与运行记录，不算"项目脏改动"
  const dirty = res.out
    .split('\n')
    .filter((line) => line.trim() && !/^\s*\S+\s+\.hlwd\//.test(line))
    .join('\n')
    .trim();
  if (dirty && !allowDirty) {
    console.error('工作区不干净，脏改动会被算进这张单的提交。先处理，或加 --allow-dirty。\n');
    console.error(dirty);
    process.exit(2);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const workdir = path.resolve(args.project ?? process.cwd());

  // 项目缺 .hlwd/ 或 .beads/ 就补齐；engine 的所有路径都以项目目录为基准
  const info = await ensureProject(workdir);
  beads.setWorkdir(workdir);
  log(`项目 ${workdir}${info.created.length ? `（补齐 ${info.created.join('、')}）` : ''}`);

  const cfg = await loadConfig(workdir);
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
    const current = await beads.getIssue(args.id);
    log(`指定工单 ${current.issue.id}（${current.issue.status}）`);
    claimed = current.issue.status === 'open' ? await claim({ issue: current.issue, cfg }) : current;
  } else {
    claimed = await claimNext({ cfg });
  }
  if (!claimed) {
    log(`没有就绪工单（open + ${cfg.readyLabel}）`);
    return 0;
  }

  const { issue } = claimed;
  const comments = claimed.comments;
  const { manifest, dir: runDir, save, journal } = await createManifest({ workdir, cfg, issue });
  log(`运行目录 ${path.relative(workdir, runDir)}`);
  await journal('start', { mode: args.id ? 'explicit' : 'queue', attempts });

  const rel = (p) => path.relative(workdir, p).replaceAll('\\', '/');
  let feedback = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const record = { attempt, execute: null, gate: null, review: null };
    manifest.attempts.push(record);

    const execStart = Date.now();
    const exec = await execute({ cfg, workdir, issue, comments, runDir, attempt, feedback });
    record.execute = {
      startedAt: new Date(execStart).toISOString(),
      ms: Date.now() - execStart,
      ok: exec.ok,
      error: exec.error,
      prompt: rel(exec.promptFile),
      outDir: rel(exec.outDir),
    };
    await save();
    await journal('execute', { attempt, ok: exec.ok, ms: record.execute.ms, error: clip(exec.error), outDir: record.execute.outDir });

    if (!exec.ok) {
      await handback({ workdir, issue, runDir, reason: exec.error, status: 'open' });
      await finish(manifest, save, journal, { outcome: 'rolled_back', reason: exec.error });
      return 1;
    }

    // 门禁：实现 → 门禁 → 审查。不通过就不进审查，直接把原因回灌给执行端。
    const gateStart = Date.now();
    const gateResult = await gateStage({ cfg, workdir, issue, runDir, attempt });
    record.gate = {
      startedAt: new Date(gateStart).toISOString(),
      ms: Date.now() - gateStart,
      pass: gateResult.pass,
      reason: gateResult.reason,
    };
    await save();
    await journal('gate', { attempt, pass: gateResult.pass, ms: record.gate.ms, reason: clip(gateResult.reason) });

    if (!gateResult.pass) {
      feedback = `## 门禁不通过（第 ${attempt} 轮）\n${gateResult.reason}\n（判定规则在 .hlwd/gate.mjs）`;
      if (attempt < attempts) log('门禁不通过，退回执行端继续改（同一工作区）');
      continue;
    }

    const reviewStart = Date.now();
    const verdict = await review({ cfg, workdir, issue, runDir, attempt });
    record.review = {
      startedAt: new Date(reviewStart).toISOString(),
      ms: Date.now() - reviewStart,
      pass: verdict.pass,
      reason: verdict.reason,
      checks: verdict.checks ?? [],
      outDir: rel(path.join(runDir, `review-${attempt}`)),
    };
    await save();
    await journal('review', { attempt, pass: verdict.pass, ms: record.review.ms, reason: clip(verdict.reason) });

    if (verdict.pass) {
      try {
        const commit = await complete({ cfg, workdir, issue, runDir, checks: verdict.checks });
        await finish(manifest, save, journal, { outcome: 'closed', commit });
        return 0;
      } catch (err) {
        // 收尾失败也要留下痕迹，别让单卡在 in_progress 里没人知道为什么
        const reason = `收尾失败：${err.message}`;
        await handback({ workdir, issue, runDir, reason, status: 'in_progress' });
        await finish(manifest, save, journal, { outcome: 'rolled_back', reason });
        return 1;
      }
    }

    feedback = `${verdict.reason}\n（第 ${attempt} 轮审查原文：${rel(runDir)}）`;
    if (attempt < attempts) log(`审查不通过，退回执行端继续改（同一工作区）`);
  }

  await handback({ workdir, issue, runDir, reason: feedback, status: 'in_progress' });
  await finish(manifest, save, journal, { outcome: 'needs_human', reason: feedback });
  return 1;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`engine 中止：${err.message}`);
    process.exit(1);
  });
