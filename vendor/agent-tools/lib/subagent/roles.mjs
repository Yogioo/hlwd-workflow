// pstack 角色表与 slug 解析。纯函数，无 IO，无 spawn。
//
// 角色表就是 pstack 的模型设置文件：Cursor 读
// `~/.cursor/rules/pstack-models.mdc`，其他 harness 读
// `~/.agents/pstack-models.md`。两者格式相同，只有 frontmatter 差别。
//
//   # budget: large (xhigh)
//   feature, refactoring: grok-4.7-xhigh-fast
//   interrogate reviewers: claude-opus-5-5-xhigh, grok-4.7-xhigh-fast

import { CAPABILITIES, resolveRunnerName } from '../agent-run/runners/index.mjs'

export const EFFORT_LADDER = ['max', 'xhigh', 'high', 'medium', 'low']

/** 别名表示「用父会话的模型」，不是真实 slug。 */
export const ROLE_ALIASES = ['auto', 'inherit-parent']

/**
 * pstack 的规范角色，按 setup-pstack 第 5 步的分组给出。分组不是装饰：一条线上的
 * 多个名字共享同一份取值，所以写表、检查重复、报退役角色都靠这一份。
 */
export const CANONICAL_ROLE_GROUPS = [
  ['feature', 'refactoring'],
  ['bug-fix'],
  ['perf-issue'],
  ['hillclimb'],
  ['judgment and prose'],
  ['hardest tasks'],
  ['how explorer'],
  ['how explainer'],
  ['why investigators'],
  ['why synthesizer'],
  ['reflect tooling'],
  ['reflect judgment', 'reflect divergent', 'reflect synthesizer'],
  ['arena runners'],
  ['arena cross-judge pool'],
  ['swarm workers'],
  ['architect runners'],
  ['interrogate reviewers'],
]

/** 展平后的规范角色名，供 doctor 比对。 */
export const CANONICAL_ROLES = CANONICAL_ROLE_GROUPS.flat()

/** `# budget:` 的标签到目标 effort。setup-pstack 第 3 步的对应关系。 */
export const BUDGET_EFFORT = { unlimited: 'max', large: 'xhigh', medium: 'high', small: 'medium' }

/** 安全默认值：钉在父会话模型上。不需要探测，也不可能 403。 */
export const SAFE_ROLE_VALUE = 'inherit-parent'

/**
 * 生成一张合法的角色表。默认值是 inherit-parent，所以它开箱就是可用的，
 * 不必先知道这台机器上有哪些模型。具体角色要换成真实模型时，先拿 probe 验过。
 * @param {object} [input]
 * @param {string} [input.budget='large']
 * @param {string} [input.runner='pi']
 * @param {string} [input.value='inherit-parent']
 * @param {string[][]} [input.roles=CANONICAL_ROLE_GROUPS]
 * @returns {string}
 */
export function renderRoleTable(input = {}) {
  const { budget = 'large', runner = 'pi', value = SAFE_ROLE_VALUE, roles = CANONICAL_ROLE_GROUPS } = input
  const effort = BUDGET_EFFORT[budget]
  return [
    '# pstack model configuration. One line per role. Delete a line to fall back to the skill default.',
    '# A value is `<provider>/<model>-<effort>`, a bare model id, or inherit-parent / auto.',
    `# ${SAFE_ROLE_VALUE} runs the role on this chat's model: no probe needed, and it cannot 403.`,
    `# budget: ${budget}${effort ? ` (${effort})` : ''}`,
    `# runner: ${runner}`,
    ...roles.map((names) => `${names.join(', ')}: ${value}`),
    '',
  ].join('\n')
}

/**
 * 默认的 runner 描述器：向本仓库的 runner 注册表要能力。可注入，所以本模块自成一个
 * 引擎，不绑定某一套 runner 名字。
 * @param {string} name
 * @returns {object|null}
 */
export function describeRunnerInRegistry(name) {
  const key = resolveRunnerName(name)
  return key ? CAPABILITIES[key] : null
}

/**
 * 拆值里的 runner 前缀：`<runner>:<模型>`。只有首段是**认得出的** runner 名字（含别名）
 * 才算前缀，所以模型 id 自己带冒号（如 `anthropic/claude-opus-5.5:batch`）不会被误拆。
 * @param {string} value
 * @param {(name: string) => object|null} [describeRunner]
 * @returns {{runner: string|null, rest: string, explicit: boolean}}
 */
export function splitRunnerPrefix(value, describeRunner = describeRunnerInRegistry) {
  const text = String(value ?? '').trim()
  const colon = text.indexOf(':')
  if (colon <= 0) return { runner: null, rest: text, explicit: false }
  const caps = describeRunner(text.slice(0, colon))
  if (!caps) return { runner: null, rest: text, explicit: false }
  return { runner: caps.name, rest: text.slice(colon + 1), explicit: true }
}

/**
 * 拆一个 pstack slug：effort 是最后一段，或 `-fast` 之前那段。
 *
 * 例外（通用规则，不是给某个 CLI 打补丁）：如果这一档的推理强度**不能单独传参**
 * （`effortParam === null`，模型 id 自己就是枚举变体，如 Cursor 的
 * `gpt-5.3-codex-xhigh`），整串就是模型 id，原样传，连 `auto` 也当它自己的 id。
 * 拆了就等于拿钱去跑另一个模型。
 * @param {string} raw
 * @param {{effortParam?: 'flag'|'config'|null, aliasAllowed?: boolean}} [options]
 * @returns {{slug: string, alias: boolean, model: string, thinking?: string, fast: boolean, verbatim: boolean}}
 */
export function parseSlug(raw, options = {}) {
  const { effortParam = 'flag', aliasAllowed = true } = options
  const slug = String(raw ?? '').trim()
  // 别名是“跟父会话模型走”的说法。带了 runner 前缀的值不走别名：那是在指名某个
  // CLI 自己的模型，所以 `cursor:auto` 是 Cursor 的 auto，不是父会话模型。
  if (aliasAllowed && ROLE_ALIASES.includes(slug)) {
    return { slug, alias: true, model: '', thinking: undefined, fast: false, verbatim: false }
  }
  if (effortParam === null) {
    return { slug, alias: false, model: slug, thinking: undefined, fast: false, verbatim: true }
  }
  const tokens = slug.split('-')
  let fast = false
  if (tokens.length > 1 && tokens.at(-1) === 'fast') {
    fast = true
    tokens.pop()
  }
  let thinking
  if (tokens.length > 1 && EFFORT_LADDER.includes(tokens.at(-1))) {
    thinking = tokens.pop()
  }
  return { slug, alias: false, model: tokens.join('-'), thinking, fast, verbatim: false }
}

/**
 * 解析角色表文本。跳过 frontmatter、空行与注释，但把 `# budget:` 与
 * `# runner:` 留下（都是注释，pstack 不认也无害）。
 * @param {string} text
 * @returns {{budget: string|null, runner: string|null, entries: Array<{names: string[], values: string[]}>, errors: string[]}}
 */
export function parseRoleTable(text) {
  const errors = []
  const entries = []
  let budget = null
  let runner = null
  const lines = String(text ?? '').split(/\r?\n/)
  let inFrontmatter = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (line === '---') {
      inFrontmatter = !inFrontmatter
      continue
    }
    if (inFrontmatter || line === '') continue
    if (line.startsWith('#')) {
      const budgetMatch = line.match(/^#\s*budget:\s*(\S+)/)
      if (budgetMatch) budget = budgetMatch[1]
      const runnerMatch = line.match(/^#\s*runner:\s*(\S+)/)
      if (runnerMatch) runner = runnerMatch[1]
      continue
    }
    const colon = line.indexOf(':')
    if (colon < 0) {
      errors.push(`第 ${i + 1} 行不是 key: value：${line}`)
      continue
    }
    const names = line
      .slice(0, colon)
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
    const values = line
      .slice(colon + 1)
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean)
    if (names.length === 0) {
      errors.push(`第 ${i + 1} 行没有角色名：${line}`)
      continue
    }
    if (values.length === 0) {
      errors.push(`第 ${i + 1} 行没有取值：${line}`)
      continue
    }
    entries.push({ names, values })
  }
  return { budget, runner, entries, errors }
}

/**
 * 读一个角色的取值列表。面板角色返回多个，普通角色返回一个。
 * @param {{entries: Array<{names: string[], values: string[]}>}} table
 * @param {string} role
 * @returns {string[]|undefined}
 */
export function roleLookup(table, role) {
  const wanted = String(role ?? '').trim().toLowerCase()
  for (const entry of table.entries) {
    if (entry.names.some((name) => name.toLowerCase() === wanted)) return entry.values
  }
  return undefined
}

/** 角色表里所有名字，用于报错时列出候选。 */
export function roleNames(table) {
  return table.entries.flatMap((entry) => entry.names)
}

/**
 * 把「角色表取值 + 臂级覆盖」合成本臂最终要传给 runner 的四元组。
 * 覆盖优先级：显式参数 > 值里的 runner 前缀 > 角色表默认 runner。
 * @param {object} input
 * @param {string} input.role
 * @param {string[]|undefined} input.values 角色表给这个角色的取值
 * @param {number} [input.index=0] 面板角色取第几个（一个取值一个子代理）
 * @param {object} [input.override] 臂级覆盖：runner/provider/model/thinking/sandbox
 * @param {string} [input.defaultRunner='agent']
 * @param {(name: string) => object|null} [input.describeRunner] 可注入，测试与扩展用
 * @returns {{role: string, slug: string|null, alias: boolean, fast: boolean, verbatim: boolean,
 *   runner: string, provider?: string, model?: string, thinking?: string, sandbox?: string,
 *   runnerExplicit: boolean, sources: Record<string, string>}}
 */
export function resolveArm(input) {
  const {
    role,
    values,
    index = 0,
    override = {},
    defaultRunner = 'agent',
    describeRunner = describeRunnerInRegistry,
  } = input
  const slug = values && values.length > 0 ? values[index % values.length] : null
  const split = slug ? splitRunnerPrefix(slug, describeRunner) : { runner: null, rest: '', explicit: false }
  const sources = {}
  const pick = (key, fromRole, fromOverride) => {
    if (fromOverride !== undefined && fromOverride !== '') {
      sources[key] = 'override'
      return fromOverride
    }
    if (fromRole !== undefined && fromRole !== '') {
      sources[key] = 'role'
      return fromRole
    }
    sources[key] = 'default'
    return undefined
  }
  const runner = pick('runner', split.runner ?? undefined, override.runner) || defaultRunner
  if (split.explicit) sources.runner = override.runner ? 'override' : 'value'
  const caps = describeRunner(runner)
  const parsed = slug
    ? parseSlug(split.rest, { effortParam: caps ? caps.effortParam : 'flag', aliasAllowed: !split.explicit })
    : { slug: null, alias: false, model: '', thinking: undefined, fast: false, verbatim: false }
  // 别名（auto / inherit-parent）= 不指定模型，跑父会话的模型。但显式覆盖比别名更强：
  // 调用方明说了 --model，就不该被表里一个别名呑掉。
  const roleModel = parsed.alias ? undefined : parsed.model
  const model = pick('model', roleModel, override.model)
  if (model === undefined && parsed.alias) sources.model = 'alias'
  // 枚举型 runner 忽略值里的 effort 后缀（那是 id 的一部分），但显式覆盖仍然作数。
  const thinkingFromRole = caps && caps.effortParam === null ? undefined : parsed.thinking
  const thinking = pick('thinking', thinkingFromRole, override.thinking)
  if (caps && caps.effortParam === null && thinking === undefined) sources.thinking = 'in-model-id'
  return {
    role,
    slug,
    alias: parsed.alias,
    fast: parsed.fast,
    verbatim: parsed.verbatim === true,
    runner,
    runnerExplicit: split.explicit,
    provider: pick('provider', undefined, override.provider),
    model,
    thinking,
    sandbox: pick('sandbox', undefined, override.sandbox),
    sources,
  }
}
