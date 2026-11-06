// 阶段 2.5：门禁。夹在「执行」和「审查」之间，跑项目自己的 .hlwd/gate.mjs。
// 门禁不是审查：它只回答「机械检查过没过」（测试/构建/lint/自定义规则），
// 代码质量仍归 review。它也不改代码——只给结论。
import fs from 'node:fs/promises';
import path from 'node:path';
import { gateFile } from '../../project.mjs';
import { log, runGate } from '../lib.mjs';

export async function gate({ cfg, workdir, issue, runDir, attempt }) {
  const file = gateFile(workdir);
  const context = {
    workdir,
    issue: {
      id: issue.id,
      title: issue.title,
      body: issue.body ?? '',
      labels: issue.labels ?? [],
      priority: issue.priority,
    },
    runDir,
    attempt,
    cfg,
  };

  const result = await runGate({ gateFile: file, context });

  // 门禁到底打印了什么，留在运行目录里，别只剩一句 reason
  const raw = `# ${file}\n# attempt ${attempt} · ${result.pass ? 'pass' : 'fail'} · ${result.ms}ms\n${result.out}${result.err ? `\n[stderr]\n${result.err}` : ''}`;
  await fs.writeFile(path.join(runDir, `gate-${attempt}.log`), raw, 'utf8').catch(() => {});

  log(result.pass ? `门禁通过（${result.ms}ms）：${result.reason}` : `门禁不通过（${result.ms}ms）：${result.reason}`);
  return result;
}
