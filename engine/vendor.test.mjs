// 自带 agent-tools 的测试：用户拿到仓库就能跑，不需要先全局装一个私有包。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { ENGINE_DIR, agentToolsCommand } from './lib.mjs';

const run = promisify(execFile);
const ENTRY = path.join(ENGINE_DIR, '..', 'vendor', 'agent-tools', 'bin', 'agent-tools.mjs');

test('仓库里自带 agent-tools 入口', async () => {
  assert.ok((await fs.stat(ENTRY)).isFile(), `缺 ${ENTRY}`);
});

test('默认就用自带的（不依赖 PATH 里的全局安装）', () => {
  const saved = process.env.AGENT_TOOLS_BIN;
  delete process.env.AGENT_TOOLS_BIN;
  try {
    const { cmd, prefix } = agentToolsCommand();
    assert.equal(cmd, process.execPath);
    assert.deepEqual(prefix, [ENTRY]);
  } finally {
    if (saved !== undefined) process.env.AGENT_TOOLS_BIN = saved;
  }
});

test('AGENT_TOOLS_BIN 能覆盖自带副本', () => {
  const saved = process.env.AGENT_TOOLS_BIN;
  process.env.AGENT_TOOLS_BIN = '/tmp/some-agent-tools';
  try {
    const { cmd, prefix } = agentToolsCommand();
    assert.equal(cmd, '/tmp/some-agent-tools');
    assert.deepEqual(prefix, []);
  } finally {
    if (saved === undefined) delete process.env.AGENT_TOOLS_BIN;
    else process.env.AGENT_TOOLS_BIN = saved;
  }
});

test('自带的 agent-run 子命令能跑起来', async () => {
  const { stdout } = await run(process.execPath, [ENTRY, 'agent-run', 'capabilities'], { encoding: 'utf8' });
  const caps = JSON.parse(stdout.slice(stdout.search(/[[{]/)));
  const names = caps.runners.map((r) => r.name);
  for (const runner of ['pi', 'codex']) assert.ok(names.includes(runner), `capabilities 里应该有 ${runner}：${names}`);
});
