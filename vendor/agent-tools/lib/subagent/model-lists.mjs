// 每个 runner 各自的模型清单。谁怎么列模型、输出什么格式，由 runner 自己的能力声明决定，
// 这一层只按声明去调、按声明去解析。所以加一个新的 CLI 不用改这里。
//
// 为什么需要它：`doctor` 要核对模型 id 是否真实存在，而唯一权威来源就是 runner 自己。
// pi 给的是 `provider model ...` 表，Cursor 给的是 `id - 标签` 行，codex 没有这个命令
// （那些角色只能靠 probe 验）。
import { CAPABILITIES } from '../agent-run/runners/index.mjs'

/**
 * 解析 `pi --list-models` 的表格输出（provider 与 model 两列，表头跳过）。
 * @param {string} text
 * @returns {Array<{provider: string|null, model: string}>}
 */
export function parseProviderTable(text) {
  const models = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || /^provider\s/i.test(line)) continue
    const [provider, model] = line.split(/\s+/)
    if (!provider || !model) continue
    models.push({ provider, model })
  }
  return models
}

/**
 * 解析 Cursor `agent --list-models` 的输出：一行一个 `id - 标签`，前面可能有标题行。
 * 这类 CLI 没有“厂商”这一维，所以 provider 一律为 null。
 * @param {string} text
 * @returns {Array<{provider: null, model: string}>}
 */
export function parseIdLabelList(text) {
  const models = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || !line.includes(' - ')) continue
    const id = line.slice(0, line.indexOf(' - ')).trim()
    if (id === '' || /\s/.test(id)) continue
    models.push({ provider: null, model: id })
  }
  return models
}

/** 按 runner 声明里的格式名选解析器。 */
export function parseModelListByFormat(format, text) {
  if (format === 'id-label') return parseIdLabelList(text)
  return parseProviderTable(text)
}

/** 把一个清单里的值统一成 {provider, model} 形状。 */
function normalizeList(value) {
  if (typeof value === 'string') return null
  if (!Array.isArray(value)) return null
  return value.map((item) => {
    if (typeof item === 'string') return { provider: null, model: item }
    return { provider: item.provider ?? null, model: String(item.model ?? '') }
  })
}

/**
 * 取一个 runner 的模型清单。
 *
 * `modelsText` 有两种形状，一种给测试和离线用，一种给人手写：
 * - 纯文本：按 `defaultRunner` 的格式解析，只填这一个 runner。
 * - JSON 映射：`{"pi": [["provider","model"]...] | ["id"...] | "<原始文本>"}`，逐 runner 填。
 *
 * @param {object} input
 * @param {string[]} input.runners 要取的 runner 正名
 * @param {string} [input.defaultRunner] 纯文本形式归给谁
 * @param {string} [input.modelsText]
 * @param {string} [input.modelsPath] modelsText 的来源，只用于回报
 * @param {string} [input.bin] 覆盖二进制路径，应用于所有 runner
 * @param {(bin: string, args: string[]) => {stdout?: string, error?: string}} [input.run]
 * @returns {Record<string, {models: Array<{provider: string|null, model: string}>, format: string,
 *   source: string|null, error?: string}>}
 */
export function loadModelLists(input) {
  const { runners, defaultRunner, modelsText, modelsPath, bin, run } = input
  const lists = {}
  const wanted = [...new Set(runners)].filter((name) => CAPABILITIES[name])
  if (modelsText !== undefined && modelsText !== null && modelsText !== '') {
    const fromJson = readJsonMap(modelsText, wanted, modelsPath)
    if (fromJson) return fromJson
    const owner = CAPABILITIES[defaultRunner] ? defaultRunner : wanted[0]
    // 纯文本的 --models-file 一律按 pi 那种 `provider model` 表解析：手写和测试都用它，
    // 其他 runner 的清单走 JSON 映射形式。
    if (owner) {
      lists[owner] = {
        models: parseProviderTable(modelsText),
        format: 'provider-table',
        source: modelsPath || 'inline',
      }
    }
    // 没被 --models-file 覆盖到的 runner：它自己声明有清单就算“证据被抽走了”，
    // 声明没有清单的（codex）才标未核实。
    for (const name of wanted) {
      if (lists[name]) continue
      const declared = CAPABILITIES[name] && CAPABILITIES[name].modelList
      lists[name] = declared
        ? { models: [], format: formatOf(name), source: null, error: `--models-file 里没有 ${name} 的清单` }
        : { models: [], format: formatOf(name), source: null, declared: false }
    }
    return lists
  }
  for (const name of wanted) {
    lists[name] = readFromRunner(name, { bin, run })
  }
  return lists
}

function formatOf(name) {
  const declared = CAPABILITIES[name] && CAPABILITIES[name].modelList
  return declared ? declared.format : 'provider-table'
}

function readJsonMap(text, wanted, modelsPath) {
  const trimmed = String(text).trim()
  if (!trimmed.startsWith('{')) return null
  let parsed
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') return null
  const lists = {}
  for (const name of wanted) {
    const format = formatOf(name)
    if (!Object.hasOwn(parsed, name)) {
      lists[name] = { models: [], format, source: null }
      continue
    }
    const value = parsed[name]
    const normalized = normalizeList(value)
    lists[name] = {
      models: normalized || parseModelListByFormat(format, String(value)),
      format,
      source: modelsPath || 'inline-json',
    }
  }
  return lists
}

/** 有声明且有 run 就真去调一次；没声明就报“无清单”，这与调用失败是两件事。 */
function readFromRunner(name, { bin, run }) {
  const declared = CAPABILITIES[name] && CAPABILITIES[name].modelList
  const format = formatOf(name)
  if (!declared) return { models: [], format, source: null, declared: false }
  if (!run) return { models: [], format, source: null, error: `没有可用的执行器去取 ${name} 的模型清单` }
  const result = run(bin || name, declared.args)
  if (result.error || result.status) {
    return { models: [], format, source: null, error: result.error || `${bin || name} ${declared.args.join(' ')} 退出 ${result.status}` }
  }
  return { models: parseModelListByFormat(format, result.stdout || ''), format, source: `${bin || name} ${declared.args.join(' ')}` }
}
