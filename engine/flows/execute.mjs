// 阶段 2：执行。一次 agent 回合，只负责「把活干出来」，不判对错。
import fs from 'node:fs/promises';
import path from 'node:path';
import { agentTurn, bodyWithAttachments, log, readPrompt, render } from '../lib.mjs';

export async function execute({ cfg, workdir, issue, comments, runDir, attempt, feedback }) {
  const outDir = path.join(runDir, `exec-${attempt}`);
  const promptFile = path.join(runDir, `prompt-exec-${attempt}.md`);

  const history = comments.map((c) => `- ${c.author}：${c.text}`).join('\n') || '（无）';
  await fs.writeFile(
    promptFile,
    render(await readPrompt('execute', workdir), {
      ID: issue.id,
      TITLE: issue.title,
      BODY: await bodyWithAttachments({ workdir, issue, fallback: '（工单没有正文，按标题执行）' }),
      HISTORY: history,
      FEEDBACK: feedback ? `## 上一轮审查意见（本轮必须处理）\n${feedback}` : '',
    }),
    'utf8',
  );

  log(`执行（第 ${attempt} 轮）→ ${path.relative(workdir, promptFile)}`);
  const turn = await agentTurn({ cfg, workdir, promptFile, outDir });
  log(turn.ok ? `执行回合结束 → ${outDir}` : `执行回合失败：${turn.error}`);
  return { ...turn, outDir, promptFile };
}
