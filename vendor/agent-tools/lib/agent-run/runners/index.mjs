// Adapted from skills/exec-review/scripts/runners/index.mjs.
// Self-contained registry + capability reporting. No AFK configuration.
import { createCodexRunner } from './codex.mjs'
import { createPiRunner } from './pi.mjs'
import { createAgentRunner } from './agent.mjs'

export const RUNNERS = ['codex', 'pi', 'agent']

/**
 * Runner 自己声明自己，上层（subagent、技能）不写死任何 runner 名字。
 * 新增一个 runner 只需改这里和 `createRunner`，其余功能自动跟上。
 *
 * - `aliases`：人能记住的别名（`cursor` → `agent`）。只在**值的首段**才会被当成 runner。
 * - `effortParam`：这一档怎么表达推理强度。`flag` / `config` 表示单独传参；`null` 表示
 *   强度就写在模型 id 里（Cursor 的 `gpt-5.3-codex-xhigh` 是枚举变体），所以角色表里
 *   写了什么就原样传什么，**不能拆后缀**，否则会拿钱去跑另一个模型。
 * - `providerParam`：是否有“厂商”这个概念。
 * - `modelList`：能否列出自己的模型以及输出格式。`null` 表示没有，这些角色只能靠 probe 验。
 */
export const CAPABILITIES = Object.freeze({
  pi: Object.freeze({
    name: 'pi',
    aliases: [],
    effortParam: 'flag',
    providerParam: true,
    modelList: { args: ['--list-models'], format: 'provider-table' },
    sessionMode: 'create-or-resume',
    sessionFlag: '--session-id',
    outputSchema: false,
    streamPartialOutput: false,
    sandboxModes: ['read-only', 'workspace-write'],
    limitations: [
      'read-only restricts tools to read/grep/find/ls and disables extensions/MCP; this is not a kernel sandbox',
      'no --output-schema; a requested schema is rejected, ask for JSON in the prompt instead',
    ],
  }),
  codex: Object.freeze({
    name: 'codex',
    aliases: [],
    effortParam: 'config',
    providerParam: false,
    modelList: null,
    sessionMode: 'resume',
    sessionFlag: 'exec resume',
    outputSchema: true,
    streamPartialOutput: false,
    sandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
    limitations: [
      'exec resume accepts neither -C nor -s nor --color; explicit sandbox overrides with resume are rejected',
      'resume can only continue an existing session, never create one',
    ],
  }),
  agent: Object.freeze({
    name: 'agent',
    aliases: ['cursor', 'cursor-agent'],
    effortParam: null,
    providerParam: false,
    modelList: { args: ['--list-models'], format: 'id-label' },
    sessionMode: 'none',
    sessionFlag: null,
    outputSchema: false,
    streamPartialOutput: true,
    sandboxModes: ['read-only', 'workspace-write', 'danger-full-access'],
    limitations: [
      'no verified resume interface; a requested session is rejected',
      'no --output-schema; a requested schema is rejected, ask for JSON in the prompt instead',
      'reasoning effort is part of the enumerated model id, so a model value is passed through verbatim',
    ],
  }),
})

/** 别名到正名。由 CAPABILITIES 推导，加 runner 时不用另外维护。 */
export const RUNNER_ALIASES = Object.freeze(
  Object.values(CAPABILITIES).reduce((map, caps) => {
    for (const alias of caps.aliases || []) map[alias] = caps.name
    return map
  }, {}),
)

/**
 * 把正名或别名解析成正名。认不出来就返回 null，由调用方报错。
 * @param {string} [name]
 * @returns {string|null}
 */
export function resolveRunnerName(name) {
  if (name === undefined || name === null || name === '') return null
  const key = String(name).trim().toLowerCase()
  if (Object.hasOwn(CAPABILITIES, key)) return key
  return Object.hasOwn(RUNNER_ALIASES, key) ? RUNNER_ALIASES[key] : null
}

/** 是否是认得出的 runner 名字（含别名）。给值前缀解析和参数校验用。 */
export function isRunnerName(name) {
  return resolveRunnerName(name) !== null
}

/** 正名与别名，用于报错时列出候选。 */
export function runnerNames() {
  return [...RUNNERS, ...Object.keys(RUNNER_ALIASES)]
}

/**
 * Session continuation capability:
 * - `create-or-resume`: given a reference, continue if it exists else create (pi)
 * - `resume`: only continue an existing session, never create (codex)
 * - `none`: no verified interface; the caller must rebuild context (agent)
 */
export const SESSION_MODES = ['create-or-resume', 'resume', 'none']

/**
 * Constructing a runner is pure (no spawn, no file reads).
 * @param {string} name
 * @param {object} [opts]
 */
export function createRunner(name, opts = {}) {
  const key = resolveRunnerName(name) || String(name || 'agent').toLowerCase()
  switch (key) {
    case 'codex':
      return createCodexRunner(opts)
    case 'pi':
      return createPiRunner(opts)
    case 'agent':
      return createAgentRunner(opts)
    default:
      throw new Error(`未知 runner: ${name}（支持: ${runnerNames().join(', ')}）`)
  }
}

export { createCodexRunner, createPiRunner, createAgentRunner }

/**
 * Ask a runner's session capability without building a turn.
 * @param {string} name
 * @returns {'create-or-resume' | 'resume' | 'none'}
 */
export function runnerSessionMode(name) {
  return createRunner(name).sessionMode || 'none'
}

/** Per-runner capability facts and enforcement limitations, for `capabilities`. */
/**
 * @param {string} [name]
 * @returns {{ runners: object[] }}
 */
export function capabilities(name) {
  if (name == null || name === '') {
    return { runners: RUNNERS.map((key) => CAPABILITIES[key]) }
  }
  const key = resolveRunnerName(name)
  if (!key) {
    throw new Error(`未知 runner: ${name}（支持: ${runnerNames().join(', ')}）`)
  }
  return { runners: [CAPABILITIES[key]] }
}
