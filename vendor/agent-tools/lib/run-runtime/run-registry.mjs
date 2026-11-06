/**
 * 运行中 agent 回合的登记簿：`<AFK home>/runs/<runId>.json`。
 *
 * 一个 run 一个文件，文件名带 workdir 摘要与 pid，所以多项目、多 agent 同时跑
 * 也不会互相覆盖。写入走「临时文件 + rename」，读到的永远是完整 JSON。
 *
 * 活着的判定只看 pid（复用 lease.mjs 的实现）：进程没了就标 `stale`，绝不因为
 * 文件还在就说「在跑」。
 *
 * 注意：这个模块不 import skills/ 下的任何东西 —— 运行时包必须能独立安装
 * （tests/run-runtime/standalone.test.mjs 会把它单独拷出去跑）。AFK home 的解析
 * 规则与 skills/afk-run/scripts/afk-home.mjs 保持一致，但这里自带一份。
 */

import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

import { isProcessAlive } from './lease.mjs'

/** AFK 根目录：`AFK_HOME` 覆盖，默认 `~/.afk`。 */
export function afkHomeRoot() {
  if (process.env.AFK_HOME) return resolve(process.env.AFK_HOME)
  return join(homedir(), '.afk')
}

/** 注册表目录；`AFK_HOME` 变了目录就跟着变，测试可以完全隔离。 */
export function runsDir() {
  return join(afkHomeRoot(), 'runs')
}

/** workdir 的稳定摘要（与 afk-home.mjs 的 projectUidFromWorkdir 同规则）。 */
export function workdirUid(workdir) {
  const abs = resolve(workdir).replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `${d.toUpperCase()}:`)
  return createHash('sha256').update(abs).digest('hex').slice(0, 8)
}

/** runId 里同时带 workdir 摘要与 pid：同项目并发、跨项目并发都不会撞。 */
export function runIdFor(workdir, pid = process.pid) {
  return `${workdirUid(workdir)}-${Number(pid)}`
}

function recordPath(runId) {
  return join(runsDir(), `${runId}.json`)
}

/**
 * 一条记录是否还活着 —— 已收尾的不算，否的只看 pid。
 * `endedAt` 由 `finishRun` / `adoptRun` 写入：进程可能已经没了，也可能 pid 已被
 * 系统重用，所以“账上已结”比“pid 还活着”更可信。
 * @param {{pid?:number, endedAt?:number}} record
 * @returns {boolean}
 */
export function isRunAlive(record) {
  if (record && record.endedAt) return false
  const pid = Number(record?.pid)
  return Number.isInteger(pid) && pid > 0 && isProcessAlive(pid)
}

/**
 * 登记一次 run。
 *
 * `inputs` 是这次给每个臂的提示词（`label`/`prompt`/`promptChars`/`promptFile`）。
 * 它必须进**记录**而不只是 progress：看板只读 `progress.jsonl` 的尾巴，长跑早期
 * 的 `arm_start` 早掉出窗口了，而“这轮被要求干什么”到跑完之后才是最想看的。
 * @param {{workdir:string, outDir:string, progressFile?:string, labels?:string[],
 *   runner?:string, note?:string, pid?:number, now?:number, inputs?:object[]}} input
 * @returns {{runId:string, file:string, record:object}}
 */
export function registerRun(input) {
  const pid = Number(input.pid || process.pid)
  const runId = runIdFor(input.workdir, pid)
  const inputs = normalizeInputs(input.inputs)
  const arms = normalizeArms(input.arms)
  const record = {
    runId,
    pid,
    workdir: resolve(input.workdir),
    outDir: resolve(input.outDir),
    progressFile: input.progressFile ? resolve(input.progressFile) : resolve(join(input.outDir, 'progress.jsonl')),
    labels: Array.isArray(input.labels) ? input.labels.map(String) : [],
    runner: input.runner ? String(input.runner) : undefined,
    note: input.note ? String(input.note).slice(0, 200) : undefined,
    ...(arms.length ? { arms } : {}),
    ...(inputs.length ? { inputs } : {}),
    startedAt: Number(input.now || Date.now()),
  }
  mkdirSync(runsDir(), { recursive: true })
  const file = recordPath(runId)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, 'utf8')
  renameSync(tmp, file)
  return { runId, file, record }
}

/**
 * 每个臂用的是什么：cli（runner）、模型、思考等级、provider。
 *
 * 这些以前只写在 progress 的 `arm_start` 里，而看板只读尾巴 —— 长跑跑完时那条
 * 早掉出窗口了，于是「这轮用的什么模型」就看不见了。记录里必须自带一份。
 * @param {unknown} list
 */
function normalizeArms(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const arms = {}
    for (const key of ['label', 'runner', 'model', 'provider', 'thinking']) {
      if (item[key] != null && item[key] !== '') arms[key] = String(item[key])
    }
    if (Object.keys(arms).length > 0) out.push(arms)
  }
  return out
}

/** 输入的预览上限：与 progress 里的 arm_start 一致，记录不是全文仓库。 */
const INPUT_PREVIEW_MAX = 700

/** @param {unknown} list */
function normalizeInputs(list) {
  if (!Array.isArray(list)) return []
  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const prompt = typeof item.prompt === 'string' ? item.prompt : ''
    const entry = {
      ...(item.label ? { label: String(item.label) } : {}),
      ...(prompt ? { prompt: prompt.length > INPUT_PREVIEW_MAX ? `${prompt.slice(0, INPUT_PREVIEW_MAX)}…` : prompt } : {}),
      ...(Number.isFinite(Number(item.promptChars)) ? { promptChars: Number(item.promptChars) } : {}),
      ...(item.promptFile ? { promptFile: String(item.promptFile) } : {}),
    }
    if (Object.keys(entry).length > 0) out.push(entry)
  }
  return out
}

/** 注销：只删自己的记录。找不到也算成功（幂等）。 */
export function unregisterRun(runId) {
  const file = recordPath(runId)
  if (!existsSync(file)) return { runId, removed: false }
  rmSync(file, { force: true })
  return { runId, removed: true }
}

/**
 * 收尾：把记录标记成已结束，**不删**。
 *
 * 曾经这里是 "unregister"（直接删文件），于是跑完的 run 就从看板上消失了 ——
 * 人第二天想回看「昨天那个 review 到底改了什么」时什么都没了。历史就是记录本身，
 * 删记录应该是一个显式动作（`runs forget`），不能是收尾的副作用。
 * @param {string} runId
 * @param {{outcome?:string, elapsedMs?:number, now?:number}} [facts]
 * @returns {{runId:string, record:object|null, updated:boolean}}
 */
export function finishRun(runId, facts = {}) {
  const { record } = readRun(runId)
  if (!record) return { runId, record: null, updated: false }
  const now = Number(facts.now || Date.now())
  const next = {
    ...record,
    endedAt: record.endedAt || now,
    elapsedMs: Number.isFinite(Number(facts.elapsedMs))
      ? Number(facts.elapsedMs)
      : Math.max(0, now - Number(record.startedAt || now)),
    ...(facts.outcome ? { outcome: String(facts.outcome) } : {}),
  }
  writeRecord(next)
  return { runId, record: next, updated: true }
}

function writeRecord(record) {
  mkdirSync(runsDir(), { recursive: true })
  const file = recordPath(record.runId)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** 读一条记录；坏 JSON 返回 `{record:null, error}` 而不是抛。 */
export function readRun(runId) {
  const file = recordPath(runId)
  if (!existsSync(file)) return { runId, record: null, error: 'not-found' }
  try {
    return { runId, record: JSON.parse(readFileSync(file, 'utf8')), error: null }
  } catch (err) {
    return { runId, record: null, error: `malformed: ${err.message}` }
  }
}

/**
 * 列出全部 run，活着的在前、按开始时间倒序。
 * `stale` 表示「文件还在、进程已死」—— 必须显式标出来，不谎报在跑。
 * @param {{now?:number, includeStale?:boolean}} [opts]
 */
export function listRuns(opts = {}) {
  const { now = Date.now(), since = 0, includeFinished = true } = opts
  const dir = runsDir()
  if (!existsSync(dir)) return { dir, runs: [], finished: 0, crashed: 0, malformed: 0 }
  const runs = []
  let finished = 0
  let crashed = 0
  let malformed = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const runId = name.slice(0, -'.json'.length)
    const { record, error } = readRun(runId)
    if (!record) {
      malformed++
      continue
    }
    // 窗口：`since` 之外的历史不发，但文件不删 —— 旧记录还在，改窗口就能看到。
    if (since > 0 && Number(record.startedAt || 0) < since) continue
    const alive = isRunAlive(record)
    if (!alive) {
      finished++
      if (!record.endedAt) crashed++
      if (!includeFinished) continue
    }
    runs.push({
      ...record,
      alive,
      crashed: !alive && !record.endedAt,
      elapsedMs: Number.isFinite(Number(record.elapsedMs))
        ? Number(record.elapsedMs)
        : Math.max(0, Number(record.endedAt || now) - Number(record.startedAt || now)),
    })
  }
  runs.sort((a, b) => Number(a.alive === b.alive ? 0 : a.alive ? -1 : 1) || b.startedAt - a.startedAt)
  return { dir, runs, finished, crashed, malformed }
}

/**
 * 按年龄清理已结束的记录。活着的一个都不动。
 *
 * 以前叫 `pruneStale`，语义是“清掉进程已死的”——那等于把全部历史都删了。
 * 历史是有用的，所以默认只看 30 天前的；要保留就传更长的 `olderThanMs`。
 * @param {{olderThanMs?:number, now?:number}} [opts]
 * @returns {{removed:string[], kept:number}}
 */
export function pruneRuns(opts = {}) {
  const { olderThanMs = 30 * 24 * 60 * 60 * 1000, now = Date.now() } = opts
  const cutoff = now - olderThanMs
  const dir = runsDir()
  const removed = []
  if (!existsSync(dir)) return { removed, kept: 0 }
  let kept = 0
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const runId = name.slice(0, -'.json'.length)
    const { record } = readRun(runId)
    if (record && isRunAlive(record)) {
      kept++
      continue
    }
    if (record && Number(record.startedAt || 0) >= cutoff) {
      kept++
      continue
    }
    rmSync(join(dir, name), { force: true })
    removed.push(runId)
  }
  return { removed, kept }
}

/** 最小 JSONL 读取：adopt 只需要 t / event / arm / status，不必拉进整个 progress 模块。 */
function readProgressLite(file) {
  const out = []
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return out
  }
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    try {
      const record = JSON.parse(raw)
      if (record && typeof record === 'object' && typeof record.event === 'string' && Number.isFinite(Number(record.t))) {
        out.push(record)
      }
    } catch {
      /* 坏行忽略：adopt 是补账，不是审计 */
    }
  }
  return out
}

const USER_MESSAGE_SCAN_BYTES = 4 * 1024 * 1024

/**
 * 从一臂的 events.jsonl 里找回“给 agent 的提示词”。
 *
 * 一个回合的事件文件动辄几十 MB，但用户消息总是第一次请求里就完整出现（实测在
 * 60KB～320KB 处），所以只读文件头。`--prompt-file` 被 pi 展开成
 * `<file name="…">` 包装，正好能顺手把原 brief 路径也拿回来。
 * @param {string} file
 * @returns {{text:string, file?:string}|null}
 */
function readFirstUserMessage(file) {
  if (!existsSync(file)) return null
  let text
  try {
    const fd = openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(USER_MESSAGE_SCAN_BYTES)
      const read = readSync(fd, buffer, 0, USER_MESSAGE_SCAN_BYTES, 0)
      text = buffer.subarray(0, read).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  for (const line of text.split('\n')) {
    if (!line.trim() || !line.includes('"user"')) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    // 我们写的是归一化事件（`payload` 里包原始事件），但别人/旧日志可能直接存原始
    // 形状；两种都认，adopt 是补账，不该因为一层包装就不干。
    const payload = event && typeof event.payload === 'object' && event.payload ? event.payload : event
    if (!payload || payload.type !== 'message_end') continue
    const message = payload.message
    if (!message || message.role !== 'user') continue
    const content = message.content
    let body = ''
    if (typeof content === 'string') body = content
    else if (Array.isArray(content)) {
      body = content
        .map((part) => (part && typeof part === 'object' && typeof part.text === 'string' ? part.text : ''))
        .join('')
    }
    if (!body.trim()) continue
    const named = body.match(/^<file name="([^"]+)">/)
    return { text: body, ...(named ? { file: named[1] } : {}) }
  }
  return null
}

/**
 * 从一臂的 log.txt 里读回「用的什么 cli / 模型 / 思考等级」。
 *
 * subagent 把实际命令行写成日志第一行（形如
 *   $ pi -p --mode json --provider sub2api-lan --model deepseek-flash --thinking xhigh @brief.md
 * 历史 run 的模型信息只能从这里找回来 —— pi 自己的 events 里不记模型。
 * 只读文件头：log.txt 能到几十 MB，而命令行永远在第一行。
 * @param {string} logFile
 * @returns {{runner?:string, model?:string, thinking?:string, provider?:string}|null}
 */
function readRunnerInvocation(logFile) {
  if (!existsSync(logFile)) return null
  let head = ''
  try {
    const fd = openSync(logFile, 'r')
    try {
      const buffer = Buffer.alloc(4096)
      head = buffer.subarray(0, readSync(fd, buffer, 0, 4096, 0)).toString('utf8')
    } finally {
      closeSync(fd)
    }
  } catch {
    return null
  }
  const first = head.split('\n').find((line) => line.startsWith('$ '))
  if (!first) return null
  const tokens = first.slice(2).trim().split(/[ 	]+/)
  if (tokens.length === 0) return null
  const slash = String.fromCharCode(92)
  const binary = tokens[0].split('/').pop().split(slash).pop()
  const runner = binary.replace(/[.](exe|cmd|bat)$/i, '')
  const out = { runner }
  const flags = { '--model': 'model', '-m': 'model', '--thinking': 'thinking', '--effort': 'thinking', '--provider': 'provider' }
  for (let i = 1; i < tokens.length - 1; i++) {
    const key = flags[tokens[i]]
    if (key && tokens[i + 1] && !tokens[i + 1].startsWith('-')) out[key] = tokens[i + 1]
  }
  return out
}

/**
 * 把一份已经跑完、但没登记过的 out-dir 补登记成历史。
 *
 * 用得着它，是因为记录曾经在收尾时被删掉：目录还在、`progress.jsonl` 还在，
 * 只是账上没有了。`runId` 从 startedAt 推导，所以重复 adopt 同一个目录是幂等的。
 * 提示词也从各臂的 events.jsonl 里找回来——否则历史上只能看到一堆 tool。
 * @param {{outDir:string, workdir:string, now?:number}} input
 * @returns {{adopted:boolean, reason?:string, record?:object}}
 */
export function adoptRun(input) {
  const outDir = resolve(input.outDir)
  const progressFile = join(outDir, 'progress.jsonl')
  if (!existsSync(progressFile)) return { adopted: false, reason: 'no-progress' }
  const events = readProgressLite(progressFile)
  if (events.length === 0) return { adopted: false, reason: 'no-events' }
  const starts = events.filter((event) => event.event === 'arm_start')
  const ends = events.filter((event) => event.event === 'arm_end')
  const labels = [...new Set(events.map((event) => event.arm).filter(Boolean))]
  const startedAt = Number(starts[0]?.at || starts[0]?.t || events[0].t)
  const endedAt = ends.length > 0 ? Math.max(...ends.map((event) => Number(event.t))) : undefined
  const ok = ends.length > 0 && ends.every((event) => event.status === 'ok')
  const arms = []
  const inputs = []
  for (const label of labels) {
    // 命令行优先来自 log.txt；较新的 run 在 progress 的 arm_start 里就有。
    const start = starts.find((event) => String(event.arm) === String(label)) || {}
    const invocation = readRunnerInvocation(join(outDir, String(label), 'log.txt')) || {}
    const entry = {}
    for (const key of ['runner', 'model', 'provider', 'thinking']) {
      const value = start[key] || invocation[key]
      if (value) entry[key] = String(value)
    }
    arms.push({ label: String(label), ...entry })
    const found = readFirstUserMessage(join(outDir, String(label), 'events.jsonl'))
    if (!found) continue
    inputs.push({
      label: String(label),
      prompt: found.text.length > INPUT_PREVIEW_MAX ? `${found.text.slice(0, INPUT_PREVIEW_MAX)}…` : found.text,
      promptChars: found.text.length,
      ...(found.file ? { promptFile: found.file } : {}),
    })
  }
  const record = {
    runId: runIdFor(input.workdir, startedAt % 1_000_000),
    pid: 0,
    workdir: resolve(input.workdir),
    outDir,
    progressFile,
    labels,
    ...(arms.find((arm) => arm.runner)?.runner ? { runner: arms.find((arm) => arm.runner).runner } : {}),
    arms,
    startedAt,
    adopted: true,
    ...(inputs.length ? { inputs } : {}),
    ...(endedAt
      ? { endedAt, outcome: ok ? 'ok' : 'failed', elapsedMs: Math.max(0, endedAt - startedAt) }
      : { outcome: 'crashed' }),
  }
  writeRecord(record)
  return { adopted: true, record }
}
