// 阶段 3：审查。另起一个回合，只看 diff 与证据，把结论写成 JSON 文件。
// 缺结论 / 看不懂 / 证据不足，一律算不通过。
// 工单评论一并给审查端：人工写的修正意见也是验收标准（否则「人改过口径、审查还按老标准判」）。
import fs from 'node:fs/promises';
import path from 'node:path';
import { agentTurn, bodyWithAttachments, log, readPrompt, render } from '../lib.mjs';

export async function review({ cfg, workdir, issue, runDir, attempt, comments = [] }) {
  const outDir = path.join(runDir, `review-${attempt}`);
  const promptFile = path.join(runDir, `prompt-review-${attempt}.md`);
  const verdictFile = path.join(runDir, `verdict-${attempt}.json`);

  // 和 execute 同一份历史：人工在评论里纠偏，审查端也得按新口径判。
  const history = comments.map((c) => `- ${c.author}：${c.text}`).join('\n') || '（无）';
  await fs.writeFile(
    promptFile,
    render(await readPrompt('review', workdir), {
      ID: issue.id,
      TITLE: issue.title,
      BODY: await bodyWithAttachments({ workdir, issue, fallback: '（工单没有正文，按标题判定）' }),
      HISTORY: history,
      VERDICT: verdictFile,
    }),
    'utf8',
  );

  log(`审查（第 ${attempt} 轮）→ ${path.relative(workdir, promptFile)}`);
  const turn = await agentTurn({ cfg, workdir, promptFile, outDir });
  if (!turn.ok) {
    log(`审查回合失败：${turn.error}`);
    return { pass: false, reason: `审查回合没跑起来：${turn.error}` };
  }

  try {
    const verdict = JSON.parse(await fs.readFile(verdictFile, 'utf8'));
    const pass = verdict.verdict === 'pass';
    log(`审查结论 ${pass ? 'pass' : 'fail'}：${verdict.reason ?? ''}`);
    return { pass, reason: verdict.reason ?? '', checks: verdict.checks ?? [] };
  } catch {
    log('审查未产出 verdict 文件，按不通过处理');
    return { pass: false, reason: '审查端没有产出 verdict 文件（视为不通过）' };
  }
}
