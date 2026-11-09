#!/usr/bin/env node
// engine 入口：接一张单，走完 接单 → 执行 → 审查 → 完成。
//   node engine/run.mjs                 # 接下一张 ready 单
//   node engine/run.mjs --dry           # 只看会接哪张，不动数据
//   node engine/run.mjs --project <dir> # 指定项目目录（默认当前目录）
//   node engine/run.mjs --id hlwd-abc   # 指定工单（已被接单时用）
//   node engine/run.mjs --attempts 1 --allow-dirty
//   node engine/run.mjs --fresh         # 忽略「上次发布失败」，从头跑执行+审查
import path from 'node:path';
import { ensureProject } from '../project.mjs';
import * as beads from '../web/beads.mjs';
import { latestRun, setProjectDir } from '../web/runs.mjs';
import { complete, handback, resumablePublish } from './flows/complete.mjs';
import { claim, listCandidates } from './flows/claim.mjs';
import { execute } from './flows/execute.mjs';
import { gate as gateStage } from './flows/gate.mjs';
import { review } from './flows/review.mjs';
import { prepareCardBranch } from './git.mjs';
import { engineOf, loadConfig, log, run, stageCfg } from './lib.mjs';
import { clip, createManifest, finish } from './manifest.mjs';

function parseArgs(argv) {
  const args = { dry: false, id: null, attempts: null, allowDirty: false, project: null, fresh: false };
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
    if (flag === '--fresh') {
      args.fresh = true;
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

// 这些路径的变化是工具与 beads 自己的状态，不算「项目脏改动」
const TOOL_STATE = /(^|\s)"?\.(hlwd|beads)\//;

async function assertClean(workdir, allowDirty) {
  const res = await run('git', ['status', '--porcelain'], { cwd: workdir });
  if (res.code !== 0) return; // 不是 git 仓库就不拦
  // 工具与 beads 自己的状态不算“项目脏改动”：
  //   .hlwd/ 是配置与运行记录，.beads/ 每次 bd 命令都会变（interactions.jsonl、状态迁移），
  //   把它们算成脏单会让第二张单永远跑不起来。收尾的 git add -A 仍会把它们带进提交。
  const dirty = res.out
    .split('\n')
    .filter((line) => line.trim() && !TOOL_STATE.test(line))
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
  setProjectDir(workdir);
  // 新项目第一次跑时把验收/归档状态补进 bd 配置；已存在就什么都不写。
  await beads.ensureWorkflowStatuses().catch((err) => log(`状态配置没补上：${err.message}`));
  log(`项目 ${workdir}${info.created.length ? `（补齐 ${info.created.join('、')}）` : ''}`);

  const cfg = await loadConfig(workdir);
  // 之后的 bd 写操作（接单 / 评论 / 改状态）都算「ai」干的：审计轨迹里一眼能分消人和 AI
  beads.setActor(cfg.actor);
  const attempts = args.attempts ?? cfg.attempts;

  if (args.dry) {
    const candidates = await listCandidates({ cfg });
    if (!candidates.length) return console.log(`没有就绪工单（open + ${cfg.readyLabel}）`), 0;
    console.log(`会接：${candidates[0].id} — ${candidates[0].title}`);
    if (candidates.length > 1) console.log(`队列里还有 ${candidates.length - 1} 张。`);
    return 0;
  }

  await assertClean(workdir, args.allowDirty);

  // 先挑出这张单，再决定是「从头跑」还是「只重试发布」：
  // 上一轮审查已经通过、只是收尾没做完（推送/PR 失败）时，重跑 AI 是浪费。
  let target = null;
  if (args.id) {
    const current = await beads.getIssue(args.id);
    log(`指定工单 ${current.issue.id}（${current.issue.status}）`);
    target = { issue: current.issue, comments: current.comments, needsClaim: current.issue.status === 'open' };
  } else {
    const [next] = await listCandidates({ cfg });
    if (next) target = { issue: next, comments: null, needsClaim: true };
  }
  if (!target) {
    log(`没有就绪工单（open + ${cfg.readyLabel}）`);
    return 0;
  }

  const resume = args.fresh ? null : resumablePublish(await latestRun(target.issue.id));
  const claimed = target.needsClaim
    ? await claim({ issue: target.issue, cfg, note: resume ? 'AI 接单，重试发布（不重跑执行与审查）。' : undefined })
    : await beads.getIssue(target.issue.id);

  const { issue } = claimed;
  const comments = claimed.comments;
  const { manifest, dir: runDir, save, journal } = await createManifest({ workdir, cfg, issue });
  log(`运行目录 ${path.relative(workdir, runDir)}`);
  await journal('start', { mode: args.id ? 'explicit' : 'queue', attempts });

  // 收尾要建 PR = 每张单一条分支：接单后、执行前就把工作区切过去。
  // 分支从 origin/<base>（优先）或本地 <base> 切，避免把本地没推的提交卷进 PR。
  // 重试发布也走这里：分支已存在就切回去，执行/审查的成果都还在。
  const completeCfg = cfg.nodes?.complete ?? {};
  let cardGit = null;
  if (completeCfg.pr) {
    try {
      cardGit = await prepareCardBranch({ workdir, issueId: issue.id, complete: completeCfg });
      manifest.git = cardGit;
      await save();
      log(`分支 ${cardGit.branch}（基于 ${cardGit.start}${cardGit.reused ? '，复用已有分支' : ''}）`);
    } catch (err) {
      const reason = `收尾要建 PR，但准备分支失败：${err.message}`;
      await handback({ workdir, issue, runDir, reason, status: 'open', head: 'AI 已接单，但分支准备失败' });
      await finish(manifest, save, journal, { outcome: 'rolled_back', reason });
      return 1;
    }
  }

  // 只重试发布：不跑 AI，直接接着上次的现场把提交 / 推送 / PR 做完。
  if (resume) {
    manifest.mode = 'publish';
    manifest.resumedFrom = resume.runId;
    manifest.attempts = resume.attempts; // 上一轮的执行与审查记录原样带过来，看板才画得出完整流程
    if (cardGit) manifest.git = cardGit;
    await save();
    await journal('publish-retry', { from: resume.runId, commit: resume.commit ?? null });
    log(`重试发布（上次 ${resume.runId ?? '未知 run'}${resume.commit ? `，提交 ${resume.commit}` : ''}）`);
    try {
      const result = await complete({ cfg, workdir, issue, runDir, checks: [], git: cardGit, prior: resume });
      manifest.push = result.push;
      manifest.pr = result.pr;
      await finish(manifest, save, journal, { outcome: 'delivered', commit: result.commit });
      return 0;
    } catch (err) {
      const reason = `收尾失败：${err.message}`;
      if (err.git?.push) manifest.push = err.git.push;
      if (err.git?.pr) manifest.pr = err.git.pr;
      await handback({ workdir, issue, runDir, reason, status: 'in_progress', head: 'AI 已完成，但发布仍然失败' });
      await finish(manifest, save, journal, {
        outcome: 'publish_failed',
        reason,
        commit: err.git?.commit ?? resume.commit ?? null,
      });
      return 1;
    }
  }

  const rel = (p) => path.relative(workdir, p).replaceAll('\\', '/');
  let feedback = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const record = { attempt, execute: null, gate: null, review: null };
    manifest.attempts.push(record);

    const execStart = Date.now();
    // 执行和审查各挂一个 AI 预设（设置 → 流程里选）；预设决定 runner/model/thinking
    const execCfg = stageCfg(cfg, 'execute');
    // 先把这一轮标成「正在跑」（ms/ok 还是 null）再开工：看板靠 run.json 才知道现在跑到哪一步；
    // engine 如果中途崩了，也能从 run.json 看出当时卡在哪一轮。
    // engine 快照跟着这一轮落盘：配置以后会变，这张单用的是哪个模型不能变。
    record.execute = { startedAt: new Date(execStart).toISOString(), ms: null, ok: null, error: null, engine: engineOf(execCfg) };
    await save();
    const exec = await execute({ cfg: execCfg, workdir, issue, comments, runDir, attempt, feedback });
    record.execute = { ...record.execute, ms: Date.now() - execStart, ok: exec.ok, error: exec.error, prompt: rel(exec.promptFile), outDir: rel(exec.outDir) };
    await save();
    await journal('execute', { attempt, ok: exec.ok, ms: record.execute.ms, error: clip(exec.error), outDir: record.execute.outDir });

    if (!exec.ok) {
      await handback({ workdir, issue, runDir, reason: exec.error, status: 'open' });
      await finish(manifest, save, journal, { outcome: 'rolled_back', reason: exec.error });
      return 1;
    }

    // 门禁：实现 → 门禁 → 审查。不通过就不进审查，直接把原因回灌给执行端。
    const gateStart = Date.now();
    record.gate = { startedAt: new Date(gateStart).toISOString(), ms: null, pass: null, reason: null };
    await save();
    const gateResult = await gateStage({ cfg, workdir, issue, runDir, attempt });
    record.gate = { ...record.gate, ms: Date.now() - gateStart, pass: gateResult.pass, reason: gateResult.reason };
    await save();
    await journal('gate', { attempt, pass: gateResult.pass, ms: record.gate.ms, reason: clip(gateResult.reason) });

    if (!gateResult.pass) {
      feedback = `## 门禁不通过（第 ${attempt} 轮）\n${gateResult.reason}\n（判定规则在 .hlwd/gate.mjs）`;
      if (attempt < attempts) log('门禁不通过，退回执行端继续改（同一工作区）');
      continue;
    }

    const reviewStart = Date.now();
    const reviewCfg = stageCfg(cfg, 'review');
    record.review = {
      startedAt: new Date(reviewStart).toISOString(),
      ms: null,
      pass: null,
      reason: null,
      checks: [],
      outDir: rel(path.join(runDir, `review-${attempt}`)),
      engine: engineOf(reviewCfg),
    };
    await save();
    // 评论一并交给审查端：人工的修正意见也算验收标准
    const verdict = await review({ cfg: reviewCfg, workdir, issue, runDir, attempt, comments });
    record.review = {
      ...record.review,
      ms: Date.now() - reviewStart,
      pass: verdict.pass,
      reason: verdict.reason,
      checks: verdict.checks ?? [],
    };
    await save();
    await journal('review', { attempt, pass: verdict.pass, ms: record.review.ms, reason: clip(verdict.reason) });

    if (verdict.pass) {
      try {
        const result = await complete({ cfg, workdir, issue, runDir, checks: verdict.checks, git: cardGit });
        manifest.push = result.push;
        manifest.pr = result.pr;
        await finish(manifest, save, journal, { outcome: 'delivered', commit: result.commit });
        return 0;
      } catch (err) {
        // 收尾失败也要留下痕迹，别让单卡在 in_progress 里没人知道为什么；
        // 已经做到哪一步（提交 / 推送）由 complete 挂在 error.git 上。
        const reason = `收尾失败：${err.message}`;
        if (err.git?.push) manifest.push = err.git.push;
        if (err.git?.pr) manifest.pr = err.git.pr;
        if (err.git?.failedAt) manifest.git = { ...(cardGit ?? {}), failedAt: err.git.failedAt };
        await handback({ workdir, issue, runDir, reason, status: 'in_progress', head: 'AI 已完成，但发布失败' });
        // publish_failed 是「代码已经通过审查，只是没交付出去」：下次派单只重跑收尾。
        await finish(manifest, save, journal, { outcome: 'publish_failed', reason, commit: err.git?.commit ?? null });
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
