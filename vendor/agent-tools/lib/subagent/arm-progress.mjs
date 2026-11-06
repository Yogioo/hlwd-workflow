/**
 * 一个臂的进度记录器：把归一化事件压成「能回答跑到哪、正在干什么」的少量记录。
 *
 * 为什么不全写：pi 一轮能产出上千条 assistant/thinking 片段，全写进 progress.jsonl
 * 会让看板既读不动也看不懂。这里只留五类：
 *   arm_start  臂开始（带 runner/model/thinking，页面靠它写标题）
 *   think      一块完整的思考（取 `thinking_end` 的全文，截断）
 *   say        一条完整的助手消息（截断；流式片段一律不写，那是上千条）
 *   tool       一次工具调用完成（start/done 成对合并，只写完成态）
 *   arm_end    臂结束，带 status/tokens/cost/耗时/失败原因（截断）
 *
 * `tool` 行必须带 `detail`：只写 `name=read` 的进度，人看了等于没看。detail 在这里
 * 从各 runner 不同的 args 形状里提炼（路径 / 命令 / 搜索词），所以看板只管排版，
 * 不必认识 pi、codex、cursor 的三种参数格式。
 *
 * 记录形状与 lib/run-runtime/progress.mjs 一致（t/level/event + 自定义字段），
 * 所以 `run-runtime serve`、看板、`progress read` 都能直接吃。
 *
 * 铁律：任何写入异常都必须吞掉。观察端不许杀死正在跑的执行。
 */

import { appendEvent } from '../run-runtime/progress.mjs'

const REASON_MAX = 200
const DETAIL_MAX = 200
const SAY_MAX = 240
const THINK_MAX = 400

/** 参数里可能是「要看的东西」的键，按可信度排序。 */
const PATH_KEYS = ['path', 'filePath', 'file_path', 'file', 'notebook_path', 'target', 'pattern', 'query', 'command', 'cmd', 'url']

function clip(text, max) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * 长路径：能按 workdir 减成相对路径就减（`Assets/Scripts/…/Foo.cs` 最好读）；
 * 不在 workdir 里就留尾巴三段，至少能看出是哪棵树。
 */
function clipPath(value, workdir) {
  const path = String(value).replace(/\\/g, '/')
  if (workdir) {
    const root = String(workdir).replace(/\\/g, '/').replace(/\/+$/, '')
    if (root && path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return path.slice(root.length + 1)
  }
  const parts = path.split('/').filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-3).join('/')}` : path
}

function firstString(value, depth = 0) {
  if (depth > 2 || value == null) return null
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (typeof value === 'object') {
    for (const key of PATH_KEYS) {
      if (value[key] != null) {
        const found = firstString(value[key], depth + 1)
        if (found) return found
      }
    }
    for (const item of Object.values(value)) {
      const found = firstString(item, depth + 1)
      if (found) return found
    }
  }
  return null
}

/**
 * 把一次工具调用的参数说成人话：`…/Battle/DeathSystem.cs`、`ls -la Temp`、`sceneLayout in …/Game/UI`。
 *
 * 刻意不带工具名：工具名已经在 `name` 字段里，页面自己配图标与动词。两处都写就成了
 * `读 read …/Foo.cs`。认不出的一律降级成第一个像样的参数，绝不编。
 * @param {unknown} args 该 runner 原始参数
 * @param {{workdir?:string}} [opts] 有 workdir 就把路径减成相对路径
 * @returns {string|undefined} 说不出东西时返回 undefined，让调用方别写空话
 */
export function describeToolCall(name, args, opts = {}) {
  // pi 的 done 事件只有 result，参数全在配对的 start 上：这里不编。
  if (args == null) return undefined
  if (typeof args === 'string') return clip(args, DETAIL_MAX)
  if (typeof args !== 'object') return undefined

  const pick = (keys) => {
    for (const key of keys) {
      const value = args[key]
      if (typeof value === 'string' && value.trim() !== '') return value
      if (Array.isArray(value) && value.length > 0) {
        const first = value.find((item) => typeof item === 'string' || (item && typeof item === 'object'))
        if (typeof first === 'string') return first
        if (first && typeof first === 'object' && typeof first.path === 'string') return first.path
      }
    }
    return null
  }

  const command = pick(['command', 'cmd', 'script'])
  if (command) {
    const lines = command.split('\n')
    const head = lines[0]
    // 一行说不完的脚本如实标出来，别让人以为就跑了这一行。
    const extra = lines.length > 1 ? ` (+${lines.length - 1} 行)` : ''
    return clip(`${head}${extra}`, DETAIL_MAX)
  }

  const path = pick(['path', 'filePath', 'file_path', 'file', 'notebook_path', 'target'])
  const pattern = pick(['pattern', 'query', 'regex', 'search'])
  if (pattern && path) return clip(`${pattern} in ${clipPath(path, opts.workdir)}`, DETAIL_MAX)
  if (pattern) return clip(pattern, DETAIL_MAX)
  if (path) return clip(clipPath(path, opts.workdir), DETAIL_MAX)

  // 认不出的工具（多数是 mcp）：给第一个像样的字符串参数＋工具名，至少能分清是哪次调用。
  const loose = firstString(args)
  return loose ? clip(loose, DETAIL_MAX) : undefined
}

/**
 * @param {{file:string, arm:string, workdir?:string, meta?:object, now?:()=>number}} opts
 *   `workdir` 用来把工具参数里的绝对路径减成相对路径；`meta` 是写进 `arm_start` 的标题
 *   信息（runner/model/thinking），页面据此写副标题。
 * @returns {{onEvent:(event:object)=>void, end:(facts:object)=>void, stats:()=>object}}
 */
export function createArmProgress(opts) {
  const { file, arm, workdir } = opts
  const now = opts.now || Date.now
  const startedAt = now()
  const calls = new Map()
  let tools = 0
  let lastTool
  let lastDetail
  let lastSaid
  let lastThought

  const write = (event, level, data) => {
    try {
      appendEvent(file, { event, level, data: { arm, ...data } })
    } catch {
      /* 观察端不许杀死执行 */
    }
  }

  write('arm_start', 1, { at: startedAt, ...(opts.meta || {}) })

  const onEvent = (event) => {
    try {
      if (!event) return
      // 思考也是人想看的：pi 在 `thinking_end` 给全文，一轮大约几十条。
      if (event.kind === 'thinking') {
        const text = clip(event.text || '', THINK_MAX)
        if (!text || text === lastThought) return
        lastThought = text
        write('think', 1, { text })
        return
      }
      // 完整的助手消息才写：流式片段一轮上千条，写了看板就读不动了。
      if (event.kind === 'assistant') {
        const text = clip(event.text || '', SAY_MAX)
        if (!text || text === lastSaid) return
        lastSaid = text
        write('say', 1, { text })
        return
      }
      if (event.kind !== 'tool') return
      const name = String(event.toolName || 'tool')
      // done 事件（pi）没有参数，所以 detail 在 start 时就算好、按 callId 存着。
      const detail = describeToolCall(name, event.args, { workdir })
      // pi 的 tool 事件成对（start/done），Cursor 的是一次性。两种都要认。
      if (event.phase === 'start') {
        const key = event.callId || `${name}:${calls.size}`
        calls.set(key, { at: now(), detail })
        return
      }
      const key = event.callId
      const begun = key ? calls.get(key) : undefined
      if (key) calls.delete(key)
      tools += 1
      lastTool = name
      // 配对的 start 优先（参数在那边）；一次性事件（Cursor）才用自己带的参数。
      lastDetail = begun?.detail || detail
      // 没有配对的 start 就不要编一个耗时出来。
      write('tool', 1, {
        name,
        ...(lastDetail ? { detail: lastDetail } : {}),
        ms: begun ? now() - begun.at : undefined,
      })
    } catch {
      /* 同上 */
    }
  }

  /**
   * 收尾。失败原因必带（否则看板只有 `error` 三个字母），且截断到 200 字符。
   * @param {{status?:string, tokens?:number, cost?:number, chars?:number,
   *   errorMessage?:string, stopReason?:string}} facts
   */
  const end = (facts = {}) => {
    const reason = facts.errorMessage ? String(facts.errorMessage).slice(0, REASON_MAX) : undefined
    write('arm_end', 1, {
      status: facts.status,
      stopReason: facts.stopReason,
      tokens: facts.tokens,
      cost: facts.cost,
      chars: facts.chars,
      tools,
      lastTool,
      lastDetail,
      elapsedMs: now() - startedAt,
      ...(reason ? { reason } : {}),
    })
  }

  return {
    onEvent,
    end,
    stats: () => ({ tools, lastTool, lastDetail, elapsedMs: now() - startedAt }),
  }
}
