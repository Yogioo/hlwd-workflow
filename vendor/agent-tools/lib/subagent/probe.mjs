// 可用性实测。角色表能证明「这个模型 id 存在」，证明不了「它真能跑」。
//
// 实测反证：opencode-go/grok-4.7 和 openrouter/anthropic/claude-opus-5.5 都在
// `pi --list-models` 里，凭据也在 auth.json 里，真跑一个 read-only turn 却都是 403
// （没订阅 / 风控）。所以「可用」必须是一次真跑，而不是一份清单。
//
// 复用 runArms：一次探测就是一个极便宜的 arm。
import { runArms, resolveProvider, summarize } from './turns.mjs'
import { describeRunnerInRegistry, parseSlug, splitRunnerPrefix } from './roles.mjs'

/** 探测只需证明路由与凭据，不需要质量，所以提示词定了，档位也压到最低。 */
export const PROBE_PROMPT = 'Reply with exactly: PROBE-OK\n'

/** 探测默认用的思考档位。与质量无关，只是为了省钱。 */
export const PROBE_THINKING = 'low'

/**
 * 把候选值去重成待探测目标。同一个 (runner, provider, model) 只探一次，因为可用性与
 * 档位无关（档位由子进程夹紧，不决定能否路由）。
 * @param {object} input
 * @param {string[]} [input.values] 角色表取值，如 `cursor:gpt-5.3-codex-xhigh`
 * @param {Array<{runner?: string, provider?: string, model: string}>} [input.candidates] 显式候选
 * @param {Record<string, {models: Array<object>}>} [input.lists] 各 runner 的模型清单
 * @param {string} [input.defaultRunner='pi']
 * @param {string} [input.thinking=PROBE_THINKING]
 * @param {(name: string) => object|null} [input.describeRunner]
 * @returns {{targets: Array<object>, unresolved: Array<object>}}
 */
export function planProbes(input = {}) {
  const {
    values = [],
    candidates = [],
    models = [],
    lists,
    runner,
    defaultRunner = runner || 'pi',
    thinking = PROBE_THINKING,
    describeRunner = describeRunnerInRegistry,
  } = input
  // 兼容单一清单的调用：只填默认 runner 那一份。
  const runnerLists = lists || { [defaultRunner]: { models } }
  const targets = []
  const unresolved = []
  const seen = new Set()
  const add = (runnerName, provider, model, source, reasoning) => {
    if (!model) return
    const key = `${runnerName}|${provider || ''}|${model}`
    if (seen.has(key)) return
    seen.add(key)
    targets.push({
      label: `${provider ? `${provider}-` : ''}${model}`.replace(/[^A-Za-z0-9._-]+/g, '-'),
      runner: runnerName,
      provider,
      model,
      thinking: reasoning,
      source,
    })
  }
  /** 同一个解析链供角色表取值与显式候选用，差别只在 provider 从哪来。 */
  const consider = (rawModel, runnerName, givenProvider, source, aliasAllowed) => {
    const caps = describeRunner(runnerName)
    const effortParam = caps ? caps.effortParam : 'flag'
    const parsed = parseSlug(rawModel, { effortParam, aliasAllowed })
    if (parsed.alias) return
    const list = runnerLists[runnerName] || { models: [] }
    const resolved = resolveProvider({ model: parsed.model, provider: givenProvider, models: list.models })
    const providerAllowed = !caps || caps.providerParam !== false
    if (resolved.source === 'unknown' || (providerAllowed && !resolved.provider)) {
      unresolved.push({
        value: rawModel,
        runner: runnerName,
        model: parsed.model,
        reason: resolved.candidates ? 'ambiguous' : 'unknown',
        ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
      })
      return
    }
    // 探测只需证明路由与凭据能不能通，与档位无关，所以不沿用表里的档位，一律用最低档。
    // 至于强度写在模型 id 里的 runner，不能另传档位，否则会折成另一个模型，探测就白做了。
    const reasoning = caps && caps.effortParam === null ? undefined : thinking
    add(runnerName, providerAllowed ? resolved.provider : undefined, resolved.model ?? parsed.model, source, reasoning)
  }
  for (const raw of values) {
    const split = splitRunnerPrefix(raw, describeRunner)
    // 带前缀的值不走别名：`cursor:auto` 就是 Cursor 的 auto。
    consider(split.rest, split.runner || defaultRunner, undefined, 'role', !split.explicit)
  }
  for (const candidate of candidates) {
    const split = splitRunnerPrefix(candidate.model, describeRunner)
    // --model 是在指名一个模型，所以也按字面处理。
    consider(split.rest, candidate.runner || split.runner || defaultRunner, candidate.provider, 'flag', false)
  }
  return { targets, unresolved }
}

/**
 * 真跑一遍每个目标，用 status 判定可用性。
 * @param {object} input
 * @param {Array<object>} input.targets planProbes 的输出
 * @param {string} input.outDir 新建目录
 * @param {number} [input.concurrency=4]
 * @param {string} [input.workdir]
 * @param {number} [input.timeoutMs]
 * @param {string} [input.bin]
 * @param {Function} [input.runTurn] 注入用，测试里替掉 spawn
 */
export async function runProbes(input) {
  const { targets, outDir, concurrency = 4, workdir, timeoutMs, bin, runTurn } = input
  const arms = targets.map((target) => ({
    label: target.label,
    role: '(probe)',
    runner: target.runner,
    provider: target.provider,
    model: target.model,
    thinking: target.thinking,
    sandbox: 'read-only',
    workdir,
    prompt: PROBE_PROMPT,
  }))
  const results = await runArms({ arms, outDir, concurrency, timeoutMs, bin, runTurn })
  const report = results.map((record, index) => ({
    label: record.label,
    runner: record.runner,
    provider: record.provider,
    model: record.model,
    thinking: record.thinking,
    source: targets[index] ? targets[index].source : 'unknown',
    status: record.status,
    stopReason: record.stopReason,
    errorMessage: record.errorMessage,
    chars: record.chars,
    tokens: record.tokens,
    outputFile: record.outputFile,
  }))
  return {
    probes: report,
    usable: report.filter((item) => item.status === 'ok'),
    unusable: report.filter((item) => item.status !== 'ok'),
    summary: summarize(results),
  }
}
