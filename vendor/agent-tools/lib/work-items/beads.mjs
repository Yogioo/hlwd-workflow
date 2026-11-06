/**
 * beads work-item source.
 *
 * Extracted from skills/afk-run/scripts/task-sources/beads.mjs. Reads facts via
 * `bd list --json` and exposes mutations explicitly; readiness and label policy
 * are caller options, not defaults. Verified CLI facts (2026-08, Windows):
 * - `bd list --id <id> --json` is valid JSON (unlike `bd show`).
 * - `bd update <id> --claim` is atomic and in_progress items leave `bd ready`.
 * - npm's `bd` is a .cmd wrapper on Windows, so resolve @beads/bd/bin/bd.js.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { WorkItemsError, invalidRecord } from './errors.mjs'
import { filterByLabels, hasLabel, labelNames, priorityWithin, sortTasks } from './selection.mjs'

const DEFAULT_PRIORITY = 2
const FIELDS = 'id,title,description,status,priority,labels,parent,dependencies,updated_at'

function resolveBd() {
  const root = process.env.APPDATA || ''
  const js = join(root, 'npm', 'node_modules', '@beads', 'bd', 'bin', 'bd.js')
  if (js && existsSync(js)) return { command: process.execPath, prefix: [js] }
  return { command: 'bd', prefix: [] }
}

export function commandErrorText(err) {
  return [err?.stderr, err?.stdout, err?.message]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join(' ')
}

/** Collision-resistant actor from the full workdir identity, not a basename. */
export function actorFor(cwd) {
  const key = resolve(cwd)
  return `work-items@${createHash('sha1').update(key).digest('hex').slice(0, 12)}`
}

function makeRunner(opts, cwd, actor) {
  if (typeof opts.run === 'function') return (args) => opts.run(args)
  const base = opts.command ? { command: opts.command, prefix: opts.commandPrefix || [] } : resolveBd()
  const actorArgs = actor ? ['--actor', actor] : []
  return (args) =>
    execFileSync(base.command, [...base.prefix, ...actorArgs, ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
}

export function normalizeIssue(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = raw.id === undefined || raw.id === null ? '' : String(raw.id)
  if (!id) return null
  const priority = Number(raw.priority)
  return {
    id,
    title: raw.title ? String(raw.title) : id,
    body: String(raw.description ?? raw.body ?? ''),
    status: raw.status ? String(raw.status) : '',
    priority: Number.isFinite(priority) ? priority : DEFAULT_PRIORITY,
    labels: labelNames(raw.labels),
    assignee: raw.assignee ? String(raw.assignee) : '',
    parent: raw.parent ? String(raw.parent) : '',
    dependencies: Array.isArray(raw.dependencies) ? raw.dependencies : [],
    updatedAt: raw.updated_at || raw.updatedAt || '',
  }
}

function parseIssues(raw, context) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw invalidRecord(`${context} 返回非法 JSON: ${err.message}`)
  }
  if (!Array.isArray(parsed)) throw invalidRecord(`${context} 返回格式错误：预期 JSON 数组`)
  return parsed.map((row) => {
    const issue = normalizeIssue(row)
    if (!issue) throw invalidRecord(`${context}: work item is missing a valid id`)
    return issue
  })
}

export function blockersOf(issue, statusById) {
  const deps = Array.isArray(issue?.dependencies) ? issue.dependencies : []
  return deps
    .filter((dep) => dep && dep.type === 'blocks' && dep.depends_on_id)
    .map((dep) => String(dep.depends_on_id))
    .filter((id) => {
      const status = statusById.get(id)
      return status && status !== 'closed'
    })
}

export function createBeadsSource(opts = {}) {
  const cwd = opts.cwd || process.cwd()
  const actor = opts.actor || actorFor(cwd)
  const bd = makeRunner(opts, cwd, actor)
  const listArgs = (extra = []) => ['list', '--json', ...extra]

  function readIssues(extra) {
    return parseIssues(bd(listArgs(extra)), 'bd list')
  }

  function toFact(issue) {
    return {
      id: issue.id,
      title: issue.title,
      body: issue.body,
      status: issue.status,
      priority: issue.priority,
      labels: issue.labels,
      assignee: issue.assignee,
      parent: issue.parent,
      blockedBy: Array.isArray(issue.blockedBy) ? issue.blockedBy : [],
    }
  }

  function capabilities() {
    return {
      source: 'beads',
      claimMode: 'atomic',
      reads: ['list', 'get'],
      mutations: ['claim', 'comment', 'addLabels', 'removeLabels', 'close'],
      labels: { add: true, remove: true, set: false },
      close: true,
      deliver: false,
      selection: { readyLabel: true, excludeLabels: true, dependencies: 'blocks', priority: 'number 0..4' },
    }
  }

  return {
    name: 'beads',
    claimMode: 'atomic',
    actor,
    capabilities,

    /** All non-deleted issues, no label or readiness filtering. */
    list(options = {}) {
      const extra = options.id ? ['--id', String(options.id)] : []
      const issues = readIssues(extra)
      const statusById = new Map(issues.map((issue) => [issue.id, issue.status]))
      const withBlockers = issues.map((issue) => ({ ...issue, blockedBy: blockersOf(issue, statusById) }))
      const seen = options.status
        ? withBlockers.filter((issue) => String(issue.status) === String(options.status))
        : withBlockers
      return seen.map(toFact)
    },

    /**
     * Optional policy. No defaults beyond structural ones: pass `readyLabel`
     * or `excludeLabels` explicitly. `includeBlocked` keeps blocked items.
     */
    selectReady(options = {}) {
      const all = readIssues([])
      const statusById = new Map(all.map((issue) => [issue.id, issue.status]))
      const openChildren = new Set(
        all.filter((issue) => issue.parent && issue.status !== 'closed').map((issue) => issue.parent),
      )
      let rows = all.filter((issue) => issue.status !== 'closed')
      rows = filterByLabels(rows, (issue) => issue.labels, options)
      if (options.assignee) rows = rows.filter((issue) => String(issue.assignee || '') === options.assignee)
      if (options.excludeParentContainers !== false) {
        rows = rows.filter((issue) => !openChildren.has(issue.id))
      }
      rows = rows.map((issue) => ({ ...issue, blockedBy: blockersOf(issue, statusById) }))
      if (!options.includeBlocked) rows = rows.filter((issue) => issue.blockedBy.length === 0)
      rows = rows.filter((issue) => priorityWithin(issue, issue.priority, options))
      return sortTasks(rows, (issue) => issue.priority, (issue) => issue.id).map(toFact)
    },

    /** Complete content for one issue. Pure read; never mutates labels/comments. */
    get(id, _options = {}) {
      const issues = readIssues(['--id', String(id)])
      const issue = issues[0]
      if (!issue) throw new WorkItemsError(`工单不存在或无法读取: ${id}`)
      return { ...toFact(issue), requirements: '' }
    },

    claim(id, _options = {}) {
      try {
        bd(['update', String(id), '--claim'])
        return { id: String(id), status: 'claimed', claimMode: 'atomic' }
      } catch (err) {
        const message = commandErrorText(err)
        if (/already claimed/i.test(message)) {
          return { id: String(id), status: 'already-claimed', claimMode: 'atomic' }
        }
        return { id: String(id), status: 'error', claimMode: 'atomic', message }
      }
    },

    comment(id, text) {
      if (!String(text || '').trim()) throw new WorkItemsError('comment 需要非空正文', 2)
      bd(['comment', String(id), String(text)])
      return { id: String(id), status: 'commented' }
    },

    addLabels(id, labels) {
      const added = []
      for (const label of normalizeLabels(labels)) {
        bd(['label', 'add', String(id), label])
        added.push(label)
      }
      return { id: String(id), status: 'labels-updated', added }
    },

    removeLabels(id, labels) {
      const removed = []
      for (const label of normalizeLabels(labels)) {
        bd(['label', 'remove', String(id), label])
        removed.push(label)
      }
      return { id: String(id), status: 'labels-updated', removed }
    },

    setLabels() {
      throw new WorkItemsError('beads 不支持全量替换标签；请使用 addLabels/removeLabels')
    },

    close(id, options = {}) {
      const args = ['close', String(id)]
      if (options.comment) args.push('--reason', String(options.comment))
      bd(args)
      return { id: String(id), status: 'closed' }
    },

    deliver() {
      throw new WorkItemsError('beads 不支持 deliver；请使用 close')
    },
  }
}

function normalizeLabels(labels) {
  const list = Array.isArray(labels) ? labels : [labels]
  return [...new Set(list.map((label) => String(label || '').trim()).filter(Boolean))]
}

export { hasLabel }
