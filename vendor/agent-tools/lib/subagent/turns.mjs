// 臂的解析、provider 归属、结果判定与有界并发扇出。
//
// 这个文件里最值钱的一条经验：agent-run 的 exitCode 是**子进程**的退出码，
// 不是这一轮的结果。实测 grok 上游 503、重试三次全挂，agent-run 照样报
// exitCode 0。所以 status 一律从 events.jsonl 与 output.txt 判，exitCode 只上报不采信。
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { runAgentTurn } from '../agent-run/run-agent-turn.mjs'
import { createArmProgress } from './arm-progress.mjs'
import { parseProviderTable } from './model-lists.mjs'

/** 兼容旧引用：pi 的表格解析器现在住在 model-lists.mjs，与其他 runner 的解析器并列。 */
export const parseModelList = parseProviderTable

/** 判定结果时用到的 stopReason：这些都不算成功。 */
const ERROR_STOP_REASONS = new Set(['error', 'aborted', 'length'])

/** 去掉空值：`arm_start` 只记真的定了的旋钮。 */
function compactMeta(input) {
  const out = {}
  for (const [key, value] of Object.entries(input)) {
    if (value != null && value !== '') out[key] = value
  }
  return out
}

const PROMPT_PREVIEW_MAX = 700

/**
 * 这一臂被要求干什么。看板不展示输入就只能看到一堆 tool，人无法判断这轮对不对。
 *
 * 优先读 prompt 文件（常见情况），拿不到就用内联 prompt；全文只写前 700 字，
 * 另存总字数与文件路径 —— progress.jsonl 是给看板看的，不背全文。
 * 读不到文件不算错：进度少一段说明，执行照旧。
 * @param {{prompt?:string, promptFile?:string}} arm
 * @returns {{prompt?:string, promptChars?:number, promptFile?:string}}
 */
export function describeArmPrompt(arm) {
  let text = typeof arm.prompt === 'string' ? arm.prompt : ''
  if (!text && arm.promptFile) {
    try {
      text = readFileSync(arm.promptFile, 'utf8')
    } catch {
      text = ''
    }
  }
  const summary = {}
  if (text) {
    summary.prompt = text.length > PROMPT_PREVIEW_MAX ? `${text.slice(0, PROMPT_PREVIEW_MAX)}…` : text
    summary.promptChars = text.length
  }
  if (arm.promptFile) summary.promptFile = arm.promptFile
  return summary
}

/**
 * 决定这一臂用哪个 provider，并给出真正要传给 runner 的模型 id。
 *
 * 角色表里可以写 `provider/id`（pi 原生写法），也可以只写模型 id。裸 id 在多厂商下
 * 会被 harness 的 fuzzy 匹配送到别的厂商（实测：裸 `deepseek/deepseek-v4.1-flash` 被送到
 * openrouter）。所以规则是：能唯一确定就定下来，多义就交给调用方拒绕，绝不猜。
 * @param {object} input
 * @param {string|undefined} input.model
 * @param {string|undefined} input.provider
 * @param {Array<{provider: string, model: string}>} [input.models]
 * @returns {{model?: string, provider?: string, source: 'flag'|'prefix'|'models-unique'|'unknown', candidates?: string[]}}
 */
export function resolveProvider(input) {
  const { model, provider, models = [] } = input
  if (provider) return { provider, model, source: 'flag' }
  if (!model) return { model, source: 'unknown' }
  // 模型 id 本身可以含 `/`（例如 deepseek/deepseek-v4.1-flash），所以只有
  // 拆分后的那一行真的存在，才把前缀当 provider。
  const slash = String(model).indexOf('/')
  if (slash > 0) {
    const head = model.slice(0, slash)
    const tail = model.slice(slash + 1)
    if (models.some((entry) => entry.provider === head && entry.model === tail)) {
      return { provider: head, model: tail, source: 'prefix' }
    }
  }
  const matches = [...new Set(models.filter((entry) => entry.model === model).map((entry) => entry.provider))]
  if (matches.length === 1) return { provider: matches[0], model, source: 'models-unique' }
  if (matches.length > 1) return { model, source: 'unknown', candidates: matches }
  return { model, source: 'unknown' }
}

/**
 * 从 events.jsonl 里取最后一次用量、stopReason 与 outcome。不同 runner 的收尾记录
 * 形状不同（pi 给 turn_end 消息，agent 给 result），所以两种都认。
 * @param {string} eventsText
 */
function readTurnFacts(eventsText) {
  let stopReason
  let errorMessage
  let usage
  let model
  let provider
  let thinking
  let outcomeText
  let outcomeFailed = false
  let hasOutcome = false
  for (const raw of String(eventsText ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.kind === 'outcome') {
      hasOutcome = true
      if (typeof record.text === 'string' && record.text !== '') outcomeText = record.text
      const payload = record.payload || {}
      const subtype = String(payload.subtype || '')
      if (subtype && subtype !== 'success') outcomeFailed = true
      if (payload.is_error === true) outcomeFailed = true
      continue
    }
    const payload = record.payload || record
    const message = payload.message || (Array.isArray(payload.messages) ? payload.messages.at(-1) : undefined)
    if (!message || typeof message !== 'object') continue
    if (message.stopReason !== undefined) stopReason = message.stopReason
    if (message.errorMessage !== undefined) errorMessage = message.errorMessage
    if (message.usage) usage = message.usage
    if (message.model) model = message.model
    if (message.provider) provider = message.provider
    if (message.thinkingLevel) thinking = message.thinkingLevel
  }
  return { stopReason, errorMessage, usage, model, provider, thinking, outcomeText, outcomeFailed, hasOutcome }
}

/**
 * 判定一轮的结果。不看 exitCode。
 * @param {object} input
 * @param {string} input.eventsText
 * @param {string} input.outputText
 * @param {{timedOut?: boolean, aborted?: boolean, exitCode?: number}} [input.facts]
 * @returns {{status: 'ok'|'empty'|'error'|'timeout'|'aborted', stopReason?: string,
 *   errorMessage?: string, chars: number, textSource: 'output'|'events'|'none',
 *   tokens?: number, cost?: number, model?: string, provider?: string, thinking?: string}}
 */
export function classifyTurn(input) {
  const { eventsText, outputText, facts = {} } = input
  const turn = readTurnFacts(eventsText)
  const fromOutput = String(outputText ?? '')
  // output.txt 是调用方真正会读的那份；两处不一致时要能看出来。
  const text = fromOutput !== '' ? fromOutput : turn.outcomeText || ''
  const textSource = fromOutput !== '' ? 'output' : turn.outcomeText ? 'events' : 'none'
  const base = {
    stopReason: turn.stopReason,
    errorMessage: turn.errorMessage,
    chars: text.length,
    textSource,
    tokens: turn.usage ? turn.usage.totalTokens : undefined,
    cost: turn.usage && turn.usage.cost ? turn.usage.cost.total : undefined,
    model: turn.model,
    provider: turn.provider,
    thinking: turn.thinking,
  }
  if (facts.timedOut) return { ...base, status: 'timeout' }
  if (facts.aborted || turn.stopReason === 'aborted') return { ...base, status: 'aborted' }
  if (turn.stopReason && ERROR_STOP_REASONS.has(turn.stopReason)) return { ...base, status: 'error' }
  if (turn.errorMessage || turn.outcomeFailed) return { ...base, status: 'error' }
  // 既没有收尾记录也没有一个字：子进程死了，这是失败，不是空产出。
  if (turn.stopReason === undefined && !turn.hasOutcome && textSource === 'none') {
    return { ...base, status: 'error' }
  }
  if (text.trim() === '') return { ...base, status: 'empty' }
  return { ...base, status: 'ok' }
}

/** 一臂三个产物的固定路径。 */
function armPaths(outDir) {
  return {
    outputFile: join(outDir, 'output.txt'),
    eventsFile: join(outDir, 'events.jsonl'),
    logFile: join(outDir, 'log.txt'),
  }
}

/**
 * 一臂起不来时也要交出一张同形状的记录，否则调用方拿不到“哪一臂挂了”。
 * @param {object} arm
 * @param {string} outDir
 * @param {string} errorMessage
 */
function failedArm(arm, outDir, errorMessage) {
  return {
    label: arm.label,
    role: arm.role,
    runner: arm.runner,
    provider: arm.provider,
    model: arm.model,
    thinking: arm.thinking,
    sandbox: arm.sandbox,
    status: 'error',
    stopReason: undefined,
    errorMessage,
    timedOut: false,
    aborted: false,
    exitCode: null,
    tokens: undefined,
    cost: undefined,
    chars: 0,
    ...armPaths(outDir),
  }
}

/**
 * 子进程失败了但没给出结构化原因时，把 log 的尾巴当原因带出来。否则调用方只看到
 * “error” 三个字母，还得自己去翻文件；Cursor CLI 这类只往 stderr 写的情况很常见。
 * @param {string} text
 */
function lastLogReason(text) {
  const clean = String(text ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
  const lines = clean
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('$ '))
  // 取尾巴而不是最后一行：CLI 多半一行说完，但 node 报错会把真正的消息夹在多行中间。
  const tail = lines.slice(-3).join(' | ')
  return tail.length > 300 ? `${tail.slice(0, 300)}…` : tail
}

/**
 * 跑一臂。
 * @param {object} arm 已解析的臂：label/runner/workdir/promptFile|prompt/model/...
 * @param {object} context
 * @param {string} context.outDir 本臂的独占目录（必须还不存在）
 * @param {number} [context.timeoutMs]
 * @param {string} [context.bin]
 * @param {AbortSignal} [context.signal]
 * @param {Function} [context.runTurn] 可注入，方便测试
 */
async function runOneArm(arm, context) {
  const { outDir, timeoutMs, bin, signal, runTurn = runAgentTurn, progressFile } = context
  // 进度记录器先建：目标目录不存在时 appendEvent 会自己 mkdir，写失败也只是无声跳过。
  const progress = progressFile
    ? createArmProgress({
      file: progressFile,
      arm: arm.label,
      // 工具参数里的路径按这个减成相对路径，看板上就是 Assets/… 而不是 C:\projects\…。
      workdir: arm.workdir,
      // 页面副标题：谁在跑、什么模型、思考多深。空值不写，别在看板上留 `model=undefined`。
      meta: compactMeta({
        runner: arm.runner,
        provider: arm.provider,
        model: arm.model,
        thinking: arm.thinking,
        ...describeArmPrompt(arm),
      }),
    })
    : null
  try {
    mkdirSync(outDir, { recursive: true })
  } catch (error) {
    progress?.end({ status: 'error', errorMessage: `无法创建臂目录：${error.message}` })
    return failedArm(arm, outDir, `无法创建臂目录：${error.message}`)
  }
  const { outputFile, eventsFile, logFile } = armPaths(outDir)
  let facts
  try {
    facts = await runTurn({
      runner: arm.runner,
      bin,
      workdir: arm.workdir,
      prompt: arm.prompt,
      promptFile: arm.promptFile,
      outFile: outputFile,
      eventsFile,
      logFile,
      model: arm.model,
      provider: arm.provider,
      thinking: arm.thinking,
      sandbox: arm.sandbox,
      timeoutMs,
      signal,
      onEvent: progress ? progress.onEvent : undefined,
    })
  } catch (error) {
    // 一个臂起不来不该带走整批：臂之间本来就是独立的。
    progress?.end({ status: 'error', errorMessage: `启动失败：${error.message}` })
    return failedArm(arm, outDir, `启动失败：${error.message}`)
  }
  const readIfPresent = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : '')
  const verdict = classifyTurn({
    eventsText: readIfPresent(eventsFile),
    outputText: readIfPresent(outputFile),
    facts,
  })
  // 失败必须带上一个可读的原因，log 尾巴是最后一道兵。
  const reason = verdict.status === 'ok' ? undefined : verdict.errorMessage || lastLogReason(readIfPresent(logFile)) || undefined
  progress?.end({
    status: verdict.status,
    stopReason: verdict.stopReason,
    tokens: verdict.tokens,
    cost: verdict.cost,
    chars: verdict.chars,
    errorMessage: reason,
  })
  return {
    label: arm.label,
    role: arm.role,
    runner: facts.runner,
    provider: verdict.provider || arm.provider,
    model: verdict.model || arm.model,
    thinking: verdict.thinking || arm.thinking,
    sandbox: arm.sandbox,
    status: verdict.status,
    stopReason: verdict.stopReason,
    errorMessage: reason,
    timedOut: facts.timedOut === true,
    aborted: facts.aborted === true,
    exitCode: facts.exitCode,
    tokens: verdict.tokens,
    cost: verdict.cost,
    chars: verdict.chars,
    outputFile,
    eventsFile,
    logFile,
  }
}

/**
 * 有界并发跑完所有臂，按输入顺序返回结果。
 * @param {object} input
 * @param {Array<object>} input.arms
 * @param {string} input.outDir 新建的根目录；每臂占 `<outDir>/<label>/`
 * @param {number} [input.concurrency=1]
 * @param {number} [input.timeoutMs]
 * @param {string} [input.bin]
 * @param {AbortSignal} [input.signal]
 * @param {Function} [input.runTurn]
 */
export async function runArms(input) {
  const { arms, outDir, concurrency = 1, timeoutMs, bin, signal, runTurn } = input
  const labels = new Set()
  for (const arm of arms) {
    if (labels.has(arm.label)) throw new Error(`臂名重复: ${arm.label}（臂名要做目录名）`)
    labels.add(arm.label)
  }
  if (existsSync(outDir)) throw new Error(`out-dir 已存在: ${outDir}`)
  mkdirSync(outDir, { recursive: true })
  const results = new Array(arms.length)
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, arms.length))
  let next = 0
  const worker = async () => {
    for (;;) {
      const index = next++
      if (index >= arms.length) return
      const arm = arms[index]
      const armDir = join(outDir, arm.label)
      // 双层保护：启动失败与程序错误都不允许把整批结果吞掉。
      results[index] = await runOneArm(arm, {
        outDir: armDir,
        timeoutMs,
        bin,
        signal,
        runTurn,
        progressFile: join(outDir, 'progress.jsonl'),
      }).catch((error) =>
        failedArm(arm, armDir, `臂内部错误：${error.message}`),
      )
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return results
}

/**
 * 汇总一批臂的结果。`ok` 才算过，其余都算没过。
 * @param {Array<{status: string}>} results
 */
export function summarize(results) {
  const summary = { arms: results.length, ok: 0, empty: 0, error: 0, timeout: 0, aborted: 0 }
  for (const result of results) {
    if (result.status === 'ok') summary.ok++
    else if (Object.hasOwn(summary, result.status)) summary[result.status]++
    else summary.error++
  }
  return summary
}
