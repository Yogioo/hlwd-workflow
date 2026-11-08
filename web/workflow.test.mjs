// 节点图投影的测试：拓扑自洽 + 各种运行态。
// 图是派生：这些用例只读 run.json 的形状，不碰 beads，也不写任何状态。
import test from 'node:test';
import assert from 'node:assert/strict';

import { TOPOLOGY, graphOf } from './workflow.mjs';

const card = (extra = {}) => ({ id: 'hlwd-1', status: 'in_progress', ...extra });
const run = ({ attempts = [], outcome = 'running', ...extra } = {}) => ({
  runId: 'hlwd-1-1',
  pid: process.pid,
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: null,
  outcome,
  attempts,
  ...extra,
});
const node = (graph, id) => graph.nodes.find((n) => n.id === id);
const edge = (graph, from, to) => graph.edges.find((e) => e.from === from && e.to === to);

test('拓扑自洽：每条边都指向已知节点，AI 节点的 stage 正好是执行和审查', () => {
  const ids = new Set(TOPOLOGY.nodes.map((n) => n.id));
  for (const e of TOPOLOGY.edges) {
    assert.ok(ids.has(e.from), `边的起点不存在：${e.from}`);
    assert.ok(ids.has(e.to), `边的终点不存在：${e.to}`);
  }
  const ai = TOPOLOGY.nodes.filter((n) => n.kind === 'ai');
  assert.deepEqual(ai.map((n) => n.stage).sort(), ['execute', 'review']);
});

test('没有 run 时是模板：全 idle、没有任何计数', () => {
  const g = graphOf(card({ status: 'open' }), null);
  assert.equal(g.nodes.length, TOPOLOGY.nodes.length);
  assert.ok(g.nodes.every((n) => n.tone === 'idle' && n.count === 0 && n.detail === ''));
  assert.ok(g.edges.every((e) => e.tone === 'idle'));
  assert.equal(g.live, false);
  assert.equal(g.outcome, null);
});

test('首轮执行中：执行是 live，门禁还没到', () => {
  const g = graphOf(card(), run({ attempts: [{ attempt: 1, execute: { ok: null } }] }));
  assert.equal(node(g, 'claim').tone, 'ok');
  assert.equal(node(g, 'execute').tone, 'live');
  assert.equal(node(g, 'execute').state, 'active');
  assert.equal(node(g, 'execute').count, 1);
  assert.equal(node(g, 'gate').tone, 'idle');
  assert.equal(edge(g, 'claim', 'execute').tone, 'live');
  assert.equal(g.live, true);
  assert.equal(g.attempt, 1);
});

test('门禁未过：回边着色，第二轮执行计数为 2', () => {
  const attempts = [
    { attempt: 1, execute: { ok: true }, gate: { pass: false, reason: 'npm test 失败' } },
    { attempt: 2, execute: { ok: null } },
  ];
  const g = graphOf(card(), run({ attempts }));
  assert.equal(node(g, 'execute').count, 2);
  assert.equal(node(g, 'execute').tone, 'live');
  assert.equal(node(g, 'gate').tone, 'warn');
  assert.match(node(g, 'gate').detail, /npm test/);
  // 回边是「刚走到这里」的那条，跟着最后一个节点一起亮
  assert.equal(edge(g, 'gate', 'execute').tone, 'live');
  assert.equal(edge(g, 'execute', 'gate').tone, 'done');
});

test('审查未过同样回炉，审查节点标 warn', () => {
  const attempts = [
    { attempt: 1, execute: { ok: true }, gate: { pass: true }, review: { pass: false, reason: '有无关改动' } },
    { attempt: 2, execute: { ok: null } },
  ];
  const g = graphOf(card(), run({ attempts }));
  assert.equal(node(g, 'review').tone, 'warn');
  assert.equal(node(g, 'review').count, 1);
  assert.equal(edge(g, 'review', 'execute').tone, 'live');
});

test('完成：一路 ok，终态是已关闭', () => {
  const attempts = [{ attempt: 1, execute: { ok: true }, gate: { pass: true }, review: { pass: true } }];
  const g = graphOf(card({ status: 'closed' }), run({ attempts, outcome: 'closed', endedAt: '2026-01-01T00:01:00.000Z' }));
  assert.equal(node(g, 'complete').tone, 'ok');
  assert.equal(node(g, 'closed').tone, 'ok');
  assert.equal(node(g, 'needs_human').tone, 'idle');
  assert.equal(edge(g, 'complete', 'closed').tone, 'done');
  assert.equal(g.live, false);
  assert.equal(g.reopened, false);
});

test('执行失败：直接落到退回待接，不经过门禁', () => {
  const attempts = [{ attempt: 1, execute: { ok: false, error: 'agent 超时' } }];
  const g = graphOf(card({ status: 'open' }), run({ attempts, outcome: 'rolled_back' }));
  assert.equal(node(g, 'execute').tone, 'bad');
  assert.match(node(g, 'execute').detail, /agent 超时/);
  assert.equal(node(g, 'gate').tone, 'idle');
  assert.equal(edge(g, 'execute', 'rolled_back').tone, 'done');
  assert.equal(edge(g, 'execute', 'gate').tone, 'idle');
});

test('轮次用尽：最后一轮的门禁指向需要人处理', () => {
  const attempts = [
    { attempt: 1, execute: { ok: true }, gate: { pass: false, reason: '一' } },
    { attempt: 2, execute: { ok: true }, gate: { pass: false, reason: '二' } },
  ];
  const g = graphOf(card(), run({ attempts, outcome: 'needs_human' }));
  assert.equal(node(g, 'needs_human').tone, 'warn');
  assert.equal(edge(g, 'gate', 'needs_human').tone, 'done');
  assert.equal(node(g, 'execute').count, 2);
  assert.equal(edge(g, 'gate', 'execute').tone, 'done');
});

test('收尾失败：从收尾指向退回待接', () => {
  const attempts = [{ attempt: 1, execute: { ok: true }, gate: { pass: true }, review: { pass: true } }];
  const g = graphOf(card(), run({ attempts, outcome: 'rolled_back' }));
  assert.equal(node(g, 'rolled_back').tone, 'bad');
  assert.equal(edge(g, 'complete', 'rolled_back').tone, 'done');
});

test('发布失败：收尾标 warn，流程停在「需要人处理」，但重派只重试收尾', () => {
  const attempts = [{ attempt: 1, execute: { ok: true }, gate: { pass: true }, review: { pass: true } }];
  const g = graphOf(
    card(),
    run({ attempts, outcome: 'publish_failed', reason: '收尾失败：推送失败：rejected' }),
  );
  assert.equal(node(g, 'complete').tone, 'warn');
  assert.equal(node(g, 'complete').reason, '收尾失败：推送失败：rejected');
  assert.equal(node(g, 'needs_human').tone, 'warn');
  assert.equal(edge(g, 'complete', 'needs_human').tone, 'done');
  assert.equal(g.outcome, 'publish_failed');
});

test('进程没了：最后一个节点标成已中断，不再算 live', () => {
  const g = graphOf(card(), run({ attempts: [{ attempt: 1, execute: { ok: null } }], pid: 2147483647 }));
  assert.equal(g.interrupted, true);
  assert.equal(g.live, false);
  assert.equal(node(g, 'execute').tone, 'bad');
  assert.match(node(g, 'execute').detail, /中断/);
});

test('人工重开：轨迹还在，但标记为 reopened', () => {
  const attempts = [{ attempt: 1, execute: { ok: true }, gate: { pass: true }, review: { pass: true } }];
  const g = graphOf(card({ status: 'open' }), run({ attempts, outcome: 'closed' }));
  assert.equal(g.reopened, true);
  assert.equal(node(g, 'closed').tone, 'ok');
});
