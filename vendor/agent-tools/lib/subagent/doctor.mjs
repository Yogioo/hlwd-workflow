// 角色表的体检。纯函数：输入表文本与模型清单，输出 findings。不写文件，不改表。
//
// 这一层的存在理由：pstack 的 `/setup-pstack` 会「把每个角色写进去」，但写完没人核。
// 打错的模型 id、退役的角色名、同义重复的行都会静静地留着，直到某次扇出真跑起来
// 才发现有几臂挂了。检查必须跑在真跑之前，而且要拿 runner 真正用的那份模型清单去核。
import { BUDGET_EFFORT, CANONICAL_ROLES, EFFORT_LADDER, ROLE_ALIASES, describeRunnerInRegistry, parseSlug, splitRunnerPrefix } from './roles.mjs'
import { resolveProvider } from './turns.mjs'

const effortRank = (effort) => EFFORT_LADDER.indexOf(effort)

const finding = (level, code, message, extra = {}) => ({ level, code, message, ...extra })

/**
 * 体检一张角色表。
 * @param {object} input
 * @param {{budget: string|null, entries: Array<{names: string[], values: string[]}>}} input.table
 * @param {Array<{provider: string, model: string}>} input.models
 * @param {string} [input.runner='pi']
 * @param {string|null} [input.rolesFile]
 * @param {string|null} [input.modelsSource]
 * @param {string} [input.modelsError] 模型清单拉不回来时的原因
 * @param {string[]} [input.parseErrors] 表本身的坏行
 * @param {string[]} [input.triedPaths] 找不到表时试过的路径
 * @returns {object}
 */
export function diagnose(input) {
  const {
    table,
    models = [],
    lists,
    runner = 'pi',
    rolesFile = null,
    modelsSource = null,
    modelsError,
    parseErrors = [],
    triedPaths = [],
    describeRunner = describeRunnerInRegistry,
  } = input
  const findings = []
  const budgetLabel = table.budget || null
  const budgetEffort = budgetLabel ? BUDGET_EFFORT[budgetLabel] : undefined

  // 表都不存在时，下面的检查全是空转，ok 会是假的，所以这里就拦下。
  if (!rolesFile) {
    findings.push(
      finding(
        'error',
        'no-role-file',
        `找不到角色表${triedPaths.length ? `，试过 ${triedPaths.join(' / ')}` : ''}。跑 /setup-pstack 生成它，或用 --roles-file 指定。`,
      ),
    )
  }

  for (const message of parseErrors) {
    findings.push(finding('error', 'bad-line', `表里有读不了的行：${message}`))
  }

  if (!budgetLabel) {
    findings.push(finding('warning', 'no-budget', '表里没有 `# budget:` 行，无法核对各角色的 effort 是否符合预算。'))
  } else if (!budgetEffort) {
    findings.push(
      finding('warning', 'unknown-budget', `预算标签 “${budgetLabel}” 不认识；应为 ${Object.keys(BUDGET_EFFORT).join(' / ')} 之一。`),
    )
  }

  // 每个 runner 各自的模型清单。声明了清单却拉不到 = error；声明“没有清单”（codex）
  // 只能标未核实，那类角色得靠 probe 验。一条故障不许派生出一堆假警报。
  const runnerLists = lists || { [runner]: { models, source: modelsSource, error: modelsError } }
  const listOf = (name) => runnerLists[name] || { models: [], source: null }

  // 角色名：重复的行是死行，规范名之外的是退役或拼错。
  const firstSeen = new Map()
  table.entries.forEach((entry, index) => {
    for (const name of entry.names) {
      const key = name.toLowerCase()
      if (firstSeen.has(key)) {
        findings.push(
          finding('warning', 'duplicate-role', `角色 “${name}” 在第 ${firstSeen.get(key) + 1} 行已经定义过，本行是死行。`, {
            role: name,
          }),
        )
      } else {
        firstSeen.set(key, index)
      }
      if (!CANONICAL_ROLES.includes(key)) {
        findings.push(
          finding('warning', 'unknown-role', `“${name}” 不在 pstack 的规范角色里，退役角色或拼错。`, { role: name }),
        )
      }
    }
  })

  // 逐个取值核对，解析链与真跑时完全一致（含值里的 runner 前缀）。某个 runner 的清单
  // 拿不到时，只校验与清单无关的项，否则一次故障会派生出一堆“模型不存在”的假警报。
  const roles = table.entries.map((entry) => ({
    names: entry.names,
    values: entry.values.map((value) => {
      const subject = entry.names.join(', ')
      const split = splitRunnerPrefix(value, describeRunner)
      const effective = split.runner || runner
      const caps = describeRunner(effective)
      const effortParam = caps ? caps.effortParam : 'flag'
      const parsed = parseSlug(split.rest, { effortParam })
      const list = listOf(effective)
      const modelsKnown = list.models.length > 0
      if (!modelsKnown) {
        if (list.error) {
          findings.push(
            finding('error', 'no-model-list', `${subject}：拿不到 runner ${effective} 的模型清单（${list.error}），无法核对模型 id。`,
              { role: subject, value }),
          )
        } else if (list.declared === false) {
          findings.push(
            finding(
              'warning',
              'unverified-runner',
              `${subject}：runner ${effective} 没有模型清单可核对，这一类角色只能靠 probe 验。`,
              { role: subject, value },
            ),
          )
        } else {
          findings.push(
            finding('error', 'no-model-list', `${subject}：runner ${effective} 的模型清单是空的，无法核对模型 id。`,
              { role: subject, value }),
          )
        }
      }
      // 枚举型 runner 里 auto 可能就是它自己的模型 id，而不是“跟父会话模型”那个别名。
      // 只有清单里真有这个 id 才算证据，否则不猜。
      if (caps && caps.effortParam === null && ROLE_ALIASES.includes(String(value).trim())) {
        const shadowed = list.models.some((item) => item.model === String(value).trim())
        if (shadowed) {
          findings.push(
            finding(
              'warning',
              'alias-shadowed',
              `${subject}：“${value}” 是 runner ${effective} 清单里的真实模型，但这里仍按别名处理（跑父会话模型）。要用那个模型就写 ${effective}:${value}。`,
              { role: subject, value },
            ),
          )
        }
      }
      if (parsed.alias) {
        return {
          value,
          runner: effective,
          alias: true,
          verified: modelsKnown,
          model: null,
          provider: null,
          thinking: undefined,
          verbatim: false,
        }
      }
      const resolved = modelsKnown ? resolveProvider({ model: parsed.model, models: list.models }) : null
      if (resolved && resolved.candidates) {
        // 真跑时多义会被拒绕（exit 2），所以这里是 error，不是提醒。
        findings.push(
          finding(
            'error',
            'ambiguous-provider',
            `${subject}：模型 “${parsed.model}” 在 ${resolved.candidates.join(', ')} 下都有，不写 provider 会被 fuzzy 匹配送到别的厂商。写成 <provider>/${parsed.model}。`,
            { role: subject, value, candidates: resolved.candidates },
          ),
        )
      } else if (resolved && resolved.source === 'unknown') {
        findings.push(
          finding('error', 'unknown-model', `${subject}：“${parsed.model}” 不在 runner ${effective} 的模型清单里。`, {
            role: subject,
            value,
          }),
        )
      }
      const providerAllowed = !caps || caps.providerParam !== false
      if (resolved && resolved.provider && !providerAllowed) {
        findings.push(
          finding(
            'error',
            'provider-unsupported',
            `${subject}：runner ${effective} 没有 provider 概念，去掉 ${resolved.provider}/ 前缀。`,
            { role: subject, value },
          ),
        )
      }
      if (parsed.fast && effortParam !== null) {
        findings.push(
          finding('warning', 'fast-unsupported', `${subject}：“${value}” 带 -fast，${effective} 没有速度档，这一位会被丢掉。`, {
            role: subject,
            value,
          }),
        )
      }
      // 强度写在模型 id 里的 runner，无法从表里拆出档位，所以不比较。
      if (budgetEffort && effortParam !== null && parsed.thinking && effortRank(parsed.thinking) > effortRank(budgetEffort)) {
        findings.push(
          finding(
            'warning',
            'below-budget',
            `${subject}：“${value}” 的 effort 是 ${parsed.thinking}，低于 budget ${budgetLabel} 要求的 ${budgetEffort}。`,
            { role: subject, value },
          ),
        )
      }
      return {
        value,
        runner: effective,
        alias: false,
        verified: modelsKnown && resolved.source !== 'unknown',
        model: resolved ? (resolved.model ?? parsed.model) : parsed.model,
        provider: providerAllowed ? (resolved && resolved.provider) || null : null,
        providerSource: resolved ? resolved.source : 'unverified',
        thinking: parsed.thinking,
        fast: parsed.fast,
        verbatim: parsed.verbatim === true,
      }
    }),
  }))

  // 面板角色：同一条线上重复的模型等于没有扇出多样性。
  for (const entry of roles) {
    if (entry.values.length < 2) continue
    const seenTargets = new Set()
    for (const value of entry.values) {
      const target = value.alias ? 'alias' : `${value.runner}/${value.provider || '-'}/${value.model}`
      if (seenTargets.has(target)) {
        findings.push(
          finding('warning', 'panel-duplicate', `${entry.names.join(', ')}：面板里有重复的 ${target}，扇出没有多样性。`, {
            role: entry.names.join(', '),
          }),
        )
      }
      seenTargets.add(target)
    }
    // 多模型面板的意义在于换厂商。能表达厂商就看 provider，否则看 runner。
    const real = entry.values.filter((value) => !value.alias)
    if (real.some((value) => !value.model)) continue
    const vendors = new Set(real.map((value) => value.provider || value.runner))
    if (vendors.size === 1 && real.length > 1) {
      findings.push(
        finding(
          'warning',
          'panel-same-vendor',
          `${entry.names.join(', ')}：面板全在 ${[...vendors][0]} 上，多模型面板的意义在于换厂商。`,
          { role: entry.names.join(', ') },
        ),
      )
    }
  }

  // 缺角色不算错：缺了就回落到技能默认值，只是要知道。
  const missingRoles = CANONICAL_ROLES.filter((role) => !firstSeen.has(role))
  if (missingRoles.length > 0) {
    findings.push(
      finding('info', 'missing-roles', `有 ${missingRoles.length} 个规范角色没在表里，这些会回落到技能默认模型。`, {
        roles: missingRoles,
      }),
    )
  }

  const errors = findings.filter((item) => item.level === 'error').length
  const warnings = findings.filter((item) => item.level === 'warning').length
  const infos = findings.filter((item) => item.level === 'info').length
  return {
    ok: errors === 0,
    runner,
    rolesFile,
    modelsSource: lists ? undefined : modelsSource,
    runners: [...new Set(roles.flatMap((entry) => entry.values.map((value) => value.runner)))].sort(),
    modelLists: Object.fromEntries(
      Object.entries(runnerLists).map(([name, list]) => [name, { source: list.source ?? null, count: list.models.length, error: list.error ?? null, declared: list.declared !== false }]),
    ),
    budget: budgetLabel ? { label: budgetLabel, effort: budgetEffort ?? null } : null,
    counts: { roles: roles.length, arms: roles.reduce((sum, entry) => sum + entry.values.length, 0), errors, warnings, infos },
    missingRoles,
    roles,
    findings,
  }
}

/** 体检报告的文本渲染，给不读 JSON 的人看。 */
export function formatFindings(report) {
  const lines = []
  const label = { error: '错误', warning: '警告', info: '提示' }
  for (const level of ['error', 'warning', 'info']) {
    for (const item of report.findings.filter((entry) => entry.level === level)) {
      lines.push(`[${label[level]}] ${item.code}: ${item.message}`)
    }
  }
  return lines
}
