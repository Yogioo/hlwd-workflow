// web/sessions.mjs 的单元测试：归一化（partial/final、工具配对）、增量尾随、轮次列表、翻页、路径安全。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  collectMessages,
  createNormalizer,
  listTurns,
  readTurn,
  setProjectDir,
  tailFrom,
} from './sessions.mjs';
import { setProjectDir as setRunsDir } from './runs.mjs';

const CARD = 'hlwd-abc';
const RUN = `${CARD}-1700000000000`;

async function withProject(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hlwd-session-'));
  try {
    setProjectDir(dir);
    setRunsDir(dir);
    await fn(dir);
  } finally {
    setProjectDir(process.cwd());
    setRunsDir(process.cwd());
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const phaseDir = (dir, phaseKey) => path.join(dir, '.hlwd', 'runs', RUN, phaseKey);
const write = async (file, text) => {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
};
const jsonl = (events) => events.map((e) => JSON.stringify(e)).join('\n') + '\n';

const RUN_JSON = (attempts) => JSON.stringify({ runId: RUN, outcome: 'closed', startedAt: '2026-01-01T00:00:00.000Z', attempts });

const thinkingPartial = (t, text) => ({ kind: 'thinking_partial', t, text });
const thinkingFinal = (t, text) => ({ kind: 'thinking', t, text, payload: { assistantMessageEvent: { type: 'thinking_end', content: text } } });
const textPartial = (t, text) => ({ kind: 'assistant_partial', t, text });
const textFinal = (t, text) => ({ kind: 'assistant', t, text });
const toolStart = (t, callId, name, args) => ({ kind: 'tool', t, callId, phase: 'start', toolName: name, args });
const toolDone = (t, callId, name, text, extra = {}) => ({
  kind: 'tool',
  t,
  callId,
  phase: 'done',
  toolName: name,
  result: { content: [{ type: 'text', text }] },
  payload: { type: 'tool_execution_end', durationMs: extra.ms ?? 12, isError: Boolean(extra.isError) },
});

test('归一化：partial 累加，final 用全文覆盖同一条消息', () => {
  const n = createNormalizer();
  const a = n.push(thinkingPartial(1, 'Let'));
  const b = n.push(thinkingPartial(2, ' me check'));
  const c = n.push(thinkingFinal(3, 'Let me check the file.'));

  assert.equal(a.kind, 'thinking');
  assert.equal(b.id, a.id, '同一个思考块用同一个 id');
  assert.equal(b.text, 'Let me check');
  assert.equal(c.text, 'Let me check the file.', 'final 是全文，不是增量');
  assert.equal(c.final, true);

  const d = n.push(textPartial(4, '搞定'));
  assert.notEqual(d.id, a.id, '换了一种块就是新消息');
  assert.equal(d.kind, 'assistant');
  assert.equal(d.final, false);
  assert.equal(n.push(textFinal(5, '搞定了。')).text, '搞定了。');
});

test('归一化：runner 重复发的同一条定稿只算一次', () => {
  const n = createNormalizer();
  const a = n.push(textFinal(1000, '改好了'));
  const b = n.push(textFinal(1000, '改好了')); // pi 会重复发几遍（同一毫秒）
  const c = n.push(textFinal(1001, '改好了'));
  assert.equal(b, null, '同一毫秒的重复定稿要扔掉');
  assert.equal(c, null);
  assert.equal(a.text, '改好了');

  // 过一会儿真的又说了一遍同样的话：那是两句，不能吞
  const later = n.push(textFinal(9000, '改好了'));
  assert.equal(later?.text, '改好了');
  assert.notEqual(later.id, a.id);
});

test('归一化：工具 start/done 配成一条（参数 + 结果 + 耗时 + 失败）', () => {
  const n = createNormalizer();
  const start = n.push(toolStart(1, 'call_1', 'bash', { command: 'npm test' }));
  assert.equal(start.tool.done, false);
  assert.equal(start.tool.name, 'bash');
  assert.equal(start.tool.args.command, 'npm test');

  const done = n.push(toolDone(2, 'call_1', 'bash', 'all good', { ms: 1234 }));
  assert.equal(done.id, start.id, '结果要配回那条调用，不能新建一条');
  assert.equal(done.tool.done, true);
  assert.equal(done.tool.result, 'all good');
  assert.equal(done.tool.ms, 1234);

  const bad = n.push(toolStart(3, 'call_2', 'bash', { command: 'exit 1' }));
  const failed = n.push(toolDone(4, 'call_2', 'bash', 'boom', { isError: true }));
  assert.equal(failed.id, bad.id);
  assert.equal(failed.tool.isError, true);
});

test('归一化：raw 信封事件丢掉，工具调用会打断文本块', () => {
  const n = createNormalizer();
  assert.equal(n.push({ kind: 'raw', t: 1, payload: { type: 'session' } }), null);
  const first = n.push(textPartial(2, '先看看目录'));
  n.push(toolStart(3, 'c1', 'bash', { command: 'ls' }));
  const after = n.push(textPartial(4, '目录里没有 Hi.txt'));
  assert.notEqual(after.id, first.id, '工具之后的文字算新的一段');
  assert.equal(after.text, '目录里没有 Hi.txt');
});

test('尾随写入 = 重放整个文件（消息完全一致）', async () => {
  await withProject(async (dir) => {
    const file = path.join(phaseDir(dir, 'exec-1'), 'events.jsonl');
    const events = [
      thinkingPartial(1, 'a'),
      thinkingPartial(2, 'b'),
      thinkingFinal(3, 'ab'),
      toolStart(4, 'c1', 'bash', { command: 'ls -la' }),
      toolDone(5, 'c1', 'bash', 'total 0'),
      textPartial(6, 'x'),
      textPartial(7, 'y'),
      textFinal(8, 'xy'),
    ];

    // 1) 整个文件一次性重放
    await write(file, jsonl(events));
    const replay = await collectMessages(file);

    // 2) 同一个文件，一行一行写进去并尾随（模拟正在跑）
    await write(file, '');
    let state = {};
    const tailed = [];
    for (const line of jsonl(events).split('\n').filter(Boolean)) {
      await fs.appendFile(file, `${line}\n`);
      state = await tailFrom(CARD, RUN, 'exec-1', state);
      tailed.push(...state.messages);
    }

    // 流式中同一条消息会被更新多次，前端按 id 覆盖，所以只比「每个 id 的最后一次」
    const lastOf = (list) => {
      const map = new Map();
      for (const m of list) map.set(m.id, m);
      return [...map.values()];
    };
    assert.deepEqual(lastOf(tailed), lastOf(replay), '尾随和重放得到同样的消息');
    assert.equal(lastOf(replay).length, 3, '思考 + 工具 + 文本 = 3 条');
    assert.equal(lastOf(replay)[0].text, 'ab', '思考最后是全文');
    assert.equal(lastOf(replay)[1].tool.result, 'total 0');
    assert.equal(lastOf(replay)[2].text, 'xy');
  });
});

test('尾随能处理「最后一行还没写完」', async () => {
  await withProject(async (dir) => {
    const file = path.join(phaseDir(dir, 'exec-1'), 'events.jsonl');
    const line = JSON.stringify(textFinal(1, '完整一行'));
    await write(file, `${line.slice(0, 12)}`); // 只有半行

    let state = {};
    const first = await tailFrom(CARD, RUN, 'exec-1', state);
    state = first;
    assert.deepEqual(first.messages, [], '半行不算一条消息');
    assert.ok(state.rest.length > 0, '半行要留着');

    await fs.appendFile(file, `${line.slice(12)}\n`);
    const second = await tailFrom(CARD, RUN, 'exec-1', state);
    assert.equal(second.messages.length, 1);
    assert.equal(second.messages[0].text, '完整一行');
  });
});

test('轮次列表：exec/review 都在，跑完的和正在跑的能分开', async () => {
  await withProject(async (dir) => {
    await write(path.join(phaseDir(dir, 'exec-1'), 'events.jsonl'), jsonl([textFinal(1, '干完了')]));
    await write(path.join(phaseDir(dir, 'review-1'), 'events.jsonl'), jsonl([textFinal(2, 'pass')]));
    await write(path.join(phaseDir(dir, 'exec-2'), 'events.jsonl'), jsonl([textPartial(3, '第二轮')]));
    await write(
      path.join(dir, '.hlwd', 'runs', RUN, 'run.json'),
      RUN_JSON([
        {
          attempt: 1,
          execute: { startedAt: '2026-01-01T00:00:00.000Z', ms: 100, ok: true },
          gate: { startedAt: '2026-01-01T00:00:01.000Z', ms: 5, pass: true },
          review: { startedAt: '2026-01-01T00:00:02.000Z', ms: 200, pass: true },
        },
        { attempt: 2, execute: { startedAt: '2026-01-01T00:00:03.000Z', ms: null, ok: null }, gate: null, review: null },
      ]),
    );

    const turns = await listTurns(CARD);
    assert.deepEqual(
      turns.map((t) => t.phaseKey),
      ['exec-2', 'exec-1', 'review-1'],
      '新的在前，同一轮 exec 在 review 前面',
    );
    const first = turns.find((t) => t.phaseKey === 'exec-1');
    assert.equal(first.done, true);
    assert.equal(first.ms, 100);
    assert.equal(first.result, true);

    const live = turns.find((t) => t.phaseKey === 'exec-2');
    assert.equal(live.done, false, 'ms/ok 还是 null 就是还在跑');
    assert.equal(live.result, null);
    assert.equal(live.live, true);
  });
});

test('轮次列表：engine 崩了没写 run.json，也照样能翻已经跑掉的回合', async () => {
  await withProject(async (dir) => {
    await write(path.join(phaseDir(dir, 'exec-1'), 'events.jsonl'), jsonl([textFinal(1, '半路崩了')]));
    // 只有目录，没有 run.json
    const turns = await listTurns(CARD);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].phaseKey, 'exec-1');
    assert.equal(turns[0].done, false);
  });
});

test('读一轮：分页游标 + 最终回复', async () => {
  await withProject(async (dir) => {
    const events = [];
    for (let i = 0; i < 5; i += 1) events.push(textFinal(i, `第 ${i} 段`));
    await write(path.join(phaseDir(dir, 'exec-1'), 'events.jsonl'), jsonl(events));
    await write(path.join(phaseDir(dir, 'exec-1'), 'output.txt'), '最终回复在这里\n');

    const page1 = await readTurn(CARD, RUN, 'exec-1', { limit: 2 });
    assert.equal(page1.total, 5);
    assert.equal(page1.messages.length, 2);
    assert.equal(page1.next, 2);
    assert.equal(page1.output, '最终回复在这里');

    const page2 = await readTurn(CARD, RUN, 'exec-1', { after: page1.next, limit: 2 });
    assert.equal(page2.messages[0].text, '第 2 段');
    const page3 = await readTurn(CARD, RUN, 'exec-1', { after: page2.next, limit: 5 });
    assert.equal(page3.next, null, '最后一页没有下一页');
  });
});

test('路径安全：卡片 id / runId / 阶段名不合法一律当没有', async () => {
  await withProject(async (dir) => {
    await write(path.join(phaseDir(dir, 'exec-1'), 'events.jsonl'), jsonl([textFinal(1, 'x')]));
    assert.equal(await readTurn('../../etc', RUN, 'exec-1'), null);
    assert.equal(await readTurn(CARD, '../..', 'exec-1'), null);
    assert.equal(await readTurn(CARD, RUN, '../../config'), null);
    assert.equal(await readTurn(CARD, RUN, 'exec-1/../../x'), null);
    // 合法但不存在
    assert.equal(await readTurn(CARD, RUN, 'review-9'), null);
    assert.deepEqual((await listTurns('../..')), []);
  });
});
