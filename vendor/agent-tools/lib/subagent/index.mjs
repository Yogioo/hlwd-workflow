// subagent 组件的公开入口。上层只 import 这里。
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export {
  EFFORT_LADDER,
  ROLE_ALIASES,
  CANONICAL_ROLES,
  CANONICAL_ROLE_GROUPS,
  BUDGET_EFFORT,
  SAFE_ROLE_VALUE,
  renderRoleTable,
  describeRunnerInRegistry,
  splitRunnerPrefix,
  parseSlug,
  parseRoleTable,
  roleLookup,
  roleNames,
  resolveArm,
} from './roles.mjs'

export { describeArmPrompt, parseModelList, resolveProvider, classifyTurn, runArms, summarize } from './turns.mjs'

export {
  parseProviderTable,
  parseIdLabelList,
  parseModelListByFormat,
  loadModelLists,
} from './model-lists.mjs'

export { diagnose, formatFindings } from './doctor.mjs'

export { PROBE_PROMPT, PROBE_THINKING, planProbes, runProbes } from './probe.mjs'

/** 角色表可能在这两个位置。Cursor 读 .mdc，其他 harness 读 .md。 */
export const ROLE_FILE_CANDIDATES = ['.agents/pstack-models.md', '.cursor/rules/pstack-models.mdc']

/**
 * 找角色表。显式路径优先，其次按候选顺序取第一个存在的。
 * @param {object} [input]
 * @param {string} [input.file] 显式路径
 * @param {string} [input.home] 家目录，默认取环境变量
 * @returns {{file: string|null, text: string, tried: string[]}}
 */
export function loadRoleTable(input = {}) {
  const home = input.home || process.env.USERPROFILE || process.env.HOME || ''
  const tried = []
  const candidates = input.file ? [input.file] : ROLE_FILE_CANDIDATES.map((rel) => join(home, rel))
  for (const file of candidates) {
    tried.push(file)
    if (!existsSync(file)) continue
    return { file, text: readFileSync(file, 'utf8'), tried }
  }
  return { file: null, text: '', tried }
}
