// 只读端口：把 engine 每个 agent 回合的 events.jsonl 归一成看板能直接渲染的消息流。
// events.jsonl 是 runner 的原始流，人没法直接看，这里做三件事：
//   1) partial 增量合并成块，final 到达时用全文覆盖（前端按 id 覆盖同一条，天然有打字效果）
//   2) tool 的 start/done 配成一条调用：工具名 + 参数 + 结果 + 耗时
//   3) 丢掉 raw（runner 的信封事件）和没人看的 usage/cost
// 只读：不写文件、不改 beads。真相源仍然是 beads，这里是运行产物。
import fs from 'node:fs/promises';
import path from 'node:path';
import { runsDir } from '../project.mjs';

const SAFE = /^[A-Za-z0-9._-]+$/;
const PHASE_RE = /^(exec|review)-(\d+)$/;
const MAX_TEXT = 24000; // 一条消息的正文上限
const MAX_RESULT = 8000; // 工具输出上限（原文仍在 events.jsonl 里）
const LIVE_WINDOW_MS = 5 * 60 * 1000; // 文件这么久没动就不再当「正在跑」

let projectDir = process.cwd();

export function setProjectDir(dir) {
  projectDir = path.resolve(dir);
}

const clip = (text, max) => {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n…（还有 ${s.length - max} 字，原文见 events.jsonl）` : s;
};

/** 工具结果 → 纯文本。形如 {content:[{type:'text',text}]}。 */
function resultText(result) {
  if (!result) return '';
  if (typeof result === 'string') return result;
  const parts = Array.isArray(result.content) ? result.content : [];
  const text = parts
    .map((p) => (typeof p === 'string' ? p : p?.text ?? ''))
    .filter(Boolean)
    .join('\n');
  if (text) return text;
  if (result.output) return String(result.output);
  if (result.error) return String(result.error);
  return '';
}

const newTool = (event, at) => ({
  id: null, // 由 push 里的计数器补
  kind: 'tool',
  at,
  tool: { name: event.toolName ?? 'tool', args: event.args ?? {}, result: '', isError: false, ms: null, done: false },
});

/**
 * 增量归一化器：喂进一条原始事件，吐出一条消息更新（或 null）。
 * 消息 id 只依赖事件顺序（m0, m1, …），所以「重放整个文件」和「从中间尾随」
 * 得到的 id 一致 —— 前端可以拿它当游标翻页，也可以按 id 覆盖同一条消息。
 */
export function createNormalizer() {
  let seq = 0;
  let open = null; // 正在累积的文本块 {id, kind, text}
  const tools = new Map(); // callId -> message
  // runner 会把同一个定稿事件重复发几遍（同一毫秒、同一段文字），得认出来扔掉
  const lastFinal = { assistant: null, thinking: null };

  const nextId = () => `m${seq++}`;

  const ensureText = (kind, at) => {
    if (!open || open.kind !== kind) open = { id: nextId(), kind, text: '', at };
    return open;
  };

  return {
    push(event) {
      if (!event || typeof event !== 'object') return null;
      const at = event.t ?? null;

      if (event.kind === 'tool') {
        const callId = event.callId ?? event.payload?.toolCallId ?? '';
        if (event.phase === 'start') {
          open = null; // 工具调用打断文本块：后面的文字是新的一段
          const message = newTool(event, at);
          message.id = nextId();
          if (callId) tools.set(callId, message);
          return message;
        }
        // phase=done：把结果配回那条调用上
        const message = (callId && tools.get(callId)) || { ...newTool(event, at), id: nextId() };
        message.tool.result = clip(resultText(event.result ?? event.payload?.result), MAX_RESULT);
        message.tool.isError = Boolean(event.isError ?? event.payload?.isError);
        message.tool.ms = event.payload?.durationMs ?? event.ms ?? null;
        message.tool.done = true;
        if (at) message.at = at;
        if (callId) tools.set(callId, message);
        return message;
      }

      const kind =
        event.kind === 'thinking' || event.kind === 'thinking_partial'
          ? 'thinking'
          : event.kind === 'assistant' || event.kind === 'assistant_partial'
            ? 'assistant'
            : null;
      if (!kind) return null; // raw 之类，人不需要看

      const final = event.kind === kind; // 非 partial 的那个就是全文
      const text = String(event.text ?? '');
      if (final) {
        const prev = lastFinal[kind];
        if (prev && prev.text === text && Math.abs((at ?? 0) - prev.t) < 500) return null; // 重复的定稿
        lastFinal[kind] = { text, t: at ?? 0 };
      }
      const block = ensureText(kind, at);
      if (final) {
        block.text = text;
        open = null;
      } else {
        block.text += String(event.text ?? event.payload?.assistantMessageEvent?.delta ?? '');
      }
      return { id: block.id, kind, at: block.at, text: clip(block.text, MAX_TEXT), final };
    },

    flush() {
      open = null;
    },
  };
}

// —— 路径 ——

/** 一次 agent 回合的 events.jsonl；标识不合法或越界返回 null。 */
function phaseFile(cardId, runId, phase) {
  if (!SAFE.test(String(cardId)) || !SAFE.test(String(runId))) return null;
  if (!PHASE_RE.test(String(phase))) return null;
  const base = path.resolve(runsDir(projectDir));
  const file = path.resolve(base, runId, phase, 'events.jsonl');
  return file.startsWith(base + path.sep) ? file : null;
}

const statSafe = (file) => fs.stat(file).catch(() => null);

/**
 * 这张卡有哪些 agent 回合（新的在前）。
 * 以目录为准：engine 崩了没写 run.json，已经跑掉的那几轮照样能翻；
 * run.json 只用来补耗时/结论这些账。
 */
export async function listTurns(cardId) {
  if (!SAFE.test(String(cardId))) return [];
  const base = runsDir(projectDir);
  let names = [];
  try {
    names = await fs.readdir(base);
  } catch {
    return []; // 还没跑过 engine
  }

  const prefix = `${cardId}-`;
  const runIds = names.filter((n) => n.startsWith(prefix) && SAFE.test(n)).sort().reverse(); // 新的在前
  const now = Date.now();
  const turns = [];

  for (const runId of runIds) {
    const runDir = path.join(base, runId);
    let run = {};
    try {
      run = JSON.parse(await fs.readFile(path.join(runDir, 'run.json'), 'utf8'));
    } catch {
      run = {}; // 没有/半截的 run.json：目录里有什么算什么
    }

    let phaseDirs = [];
    try {
      phaseDirs = (await fs.readdir(runDir)).filter((n) => PHASE_RE.test(n));
    } catch {
      continue;
    }
    const seen = new Set(phaseDirs);
    // run.json 里记了但目录还没建出来的（刚开始那一瞬间）也列上，前端能显示「正在跑」
    for (const a of run.attempts ?? []) {
      for (const phase of ['exec', 'review']) if (a[phase === 'exec' ? 'execute' : 'review']) seen.add(`${phase}-${a.attempt}`);
    }

    const keys = [...seen].sort((a, b) => {
      const [, pa, na] = PHASE_RE.exec(a);
      const [, pb, nb] = PHASE_RE.exec(b);
      return Number(nb) - Number(na) || (pa === 'exec' ? -1 : 1); // 新的一轮在前，同轮 exec 在前
    });

    for (const phaseKey of keys) {
      const [, phase, attemptStr] = PHASE_RE.exec(phaseKey);
      const attempt = Number(attemptStr);
      const file = phaseFile(cardId, runId, phaseKey);
      const stat = file ? await statSafe(file) : null;
      const key = phase === 'exec' ? 'execute' : 'review';
      const rec = (run.attempts ?? []).find((a) => a.attempt === attempt)?.[key];
      if (!stat && !rec) continue;
      const done = rec?.ms != null && (key === 'execute' ? rec.ok != null : rec.pass != null);
      // 「最后动作时间」：events.jsonl 还没建出来时看阶段目录，目录也没有就看 run 目录，
      // 否则刚起的回合会被当成已停止（agent 写第一条事件前有一段空白）
      const touched =
        stat?.mtimeMs ?? (await statSafe(path.join(runDir, phaseKey)))?.mtimeMs ?? (await statSafe(runDir))?.mtimeMs ?? 0;
      turns.push({
        runId,
        attempt,
        phase,
        phaseKey,
        bytes: stat?.size ?? 0,
        startedAt: rec?.startedAt ?? (stat ? new Date(stat.mtimeMs).toISOString() : null),
        ms: rec?.ms ?? null,
        result: key === 'execute' ? (rec?.ok ?? null) : (rec?.pass ?? null),
        done,
        // 没跑完、最近又动过 —— 看板据此决定要不要开着尾巴跟随
        live: !done && touched > 0 && now - touched < LIVE_WINDOW_MS,
        runOutcome: run.outcome ?? null,
      });
    }
  }

  return turns;
}

/**
 * 重放整个文件 → 消息列表（每个 id 只留最后一次更新，按首次出现排序）。
 * 流式过程中同一条消息会来很多次（partial 增量），定稿的历史只要最终样子；
 * id 稳定，所以可以直接当翻页游标。
 */
export async function collectMessages(file) {
  const raw = await fs.readFile(file, 'utf8').catch(() => '');
  const normalizer = createNormalizer();
  const byId = new Map(); // Map 保插入顺序，重复 set 只换值
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue; // 半行/坏行跳过
    }
    const message = normalizer.push(event);
    if (message) byId.set(message.id, message);
  }
  normalizer.flush();
  return [...byId.values()];
}

/**
 * 某一轮的会话内容。after 是游标（消息 id 的数字部分），limit 是本次最多给多少条：
 * 几百 KB 的文件不一口气塞给浏览器，够看当前这一屏就行。
 */
export async function readTurn(cardId, runId, phase, { after = 0, limit = 300 } = {}) {
  const file = phaseFile(cardId, runId, phase);
  if (!file) return null;
  const stat = await statSafe(file);
  if (!stat) return null;

  const messages = await collectMessages(file);
  const from = Math.max(0, Number(after) || 0);
  const take = Math.max(1, Math.min(2000, Number(limit) || 300));
  const slice = messages.slice(from, from + take);
  const output = await fs.readFile(path.join(path.dirname(file), 'output.txt'), 'utf8').catch(() => '');
  return {
    card: cardId,
    runId,
    phase,
    bytes: stat.size,
    total: messages.length,
    messages: slice,
    next: from + slice.length < messages.length ? from + slice.length : null,
    output: clip(output.trim(), MAX_TEXT),
  };
}

/**
 * 从 offset 往后读新写进来的部分并增量归一化。
 * 用法是「状态接力」：state = await tailFrom(card, run, phase, state)。
 * state 里的 rest（末尾没写完的半行）和 normalizer（累积的文本块）会带上，
 * 所以分多次尾随和一次性重放整个文件得到的消息 id 完全一致。
 */
export async function tailFrom(cardId, runId, phase, state = {}) {
  const engine = state.normalizer ?? createNormalizer();
  const rest = state.rest ?? '';
  let offset = state.offset ?? 0;
  const file = phaseFile(cardId, runId, phase);
  if (!file) return { offset, rest: '', messages: [], normalizer: engine, missing: true };
  const stat = await statSafe(file);
  if (!stat) return { offset, rest: '', messages: [], normalizer: engine, missing: true };

  if (stat.size < offset) offset = 0; // 文件被截断/换了一份，从头再来
  if (stat.size === offset) return { offset, rest, messages: [], normalizer: engine, size: stat.size };

  const handle = await fs.open(file, 'r').catch(() => null);
  if (!handle) return { offset, rest, messages: [], normalizer: engine, size: stat.size };
  try {
    const length = stat.size - offset;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, offset);
    const lines = (rest + buffer.toString('utf8')).split('\n');
    const tail = lines.pop() ?? ''; // 最后一段可能还没写完
    const messages = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const message = engine.push(event);
      if (message) messages.push(message);
    }
    return { offset: stat.size, rest: tail, messages, normalizer: engine, size: stat.size };
  } finally {
    await handle.close().catch(() => {});
  }
}
