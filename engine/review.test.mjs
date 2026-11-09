// review 阶段的提示词：工单评论要一起交给审查端（人工的修正意见也算验收标准）。
// 不调用任何 agent：把 agent-tools 指到不存在的文件，回合会快速失败，但提示词已经落盘。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { review } from './flows/review.mjs';

test('审查提示词带上工单评论：人工修正意见能在 {{HISTORY}} 里看到', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-review-'));
  const runDir = path.join(dir, 'run');
  await fs.mkdir(runDir, { recursive: true });
  process.env.AGENT_TOOLS_BIN = path.join(dir, '没有这个-agent-tools.mjs');
  try {
    const verdict = await review({
      cfg: { runner: 'pi', sandbox: 'workspace-write', timeoutMs: 5000 },
      workdir: dir,
      issue: { id: 'hlwd-1', title: '按钮位置', body: '把按钮放到右边' },
      runDir,
      attempt: 1,
      comments: [
        { author: 'AI', text: 'AI 接单，开始执行。', created: '' },
        { author: '张三', text: '按钮应该在右边，不是左边。', created: '' },
      ],
    });

    // 回合没跑起来 = 不通过（顺便检验 fail-closed）
    assert.equal(verdict.pass, false);

    const prompt = await fs.readFile(path.join(runDir, 'prompt-review-1.md'), 'utf8');
    assert.doesNotMatch(prompt, /\{\{HISTORY\}\}/, '占位符要被替换掉');
    assert.match(prompt, /- 张三：按钮应该在右边，不是左边。/);
    assert.match(prompt, /已有评论/);
  } finally {
    delete process.env.AGENT_TOOLS_BIN;
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
});
