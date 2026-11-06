/**
 * GitHub Issues work-item source.
 *
 * Extracted from skills/afk-run/scripts/task-sources/gh.mjs. `gh issue list`
 * fetches API pages when `--limit` exceeds a page, so one list call covers
 * large repositories. Readiness uses same-repository task-list references.
 */

import { execFileSync } from 'node:child_process'
import { WorkItemsError, invalidRecord } from './errors.mjs'
import { filterByLabels, hasLabel, labelNames, priorityWithin, sortTasks } from './selection.mjs'

const ISSUE_FIELDS = 'number,title,body,labels'
const VIEW_FIELDS = 'number,title,body,labels,comments'
const LIST_LIMIT = 1000
const DEFAULT_PRIORITY = 2
const DEFAULT_RETRIES = 3
const DEFAULT_RETRY_DELAY_MS = 100

function sleep(ms) {
  if (ms <= 0) return
  const buffer = new SharedArrayBuffer(4)
  Atomics.wait(new Int32Array(buffer), 0, 0, ms)
}

function errorText(err) {
  return [err?.stderr, err?.stdout, err?.message]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join(' ')
}

function isRetryableError(err) {
  return /network|timeout|timed out|timedout|connection|eai_again|econnreset|econnrefused|etimedout|enetunreach|ehostunreach|epipe|socket hang up|temporarily unavailable|rate limit|502|503|504|reset by peer|unexpected eof|\beof\b/.test(
    errorText(err).toLowerCase(),
  )
}

/** Run gh with a bounded retry for transient network failures. */
export function runGh(args, opts = {}) {
  if (typeof opts.run === 'function') return opts.run(args)
  const command = opts.command || 'gh'
  const commandPrefix = Array.isArray(opts.commandPrefix) ? opts.commandPrefix : []
  const retries = Number.isInteger(opts.retries) ? Math.max(0, opts.retries) : DEFAULT_RETRIES
  const retryDelayMs = Number.isFinite(opts.retryDelayMs)
    ? Math.max(0, Number(opts.retryDelayMs))
    : DEFAULT_RETRY_DELAY_MS
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync(command, [...commandPrefix, ...args], {
        cwd: opts.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      if (!isRetryableError(err) || attempt >= retries) {
        const detail = errorText(err)
        throw new WorkItemsError(
          `gh 命令失败: ${[...commandPrefix, ...args].join(' ')}${detail ? ` — ${detail}` : ''}`,
        )
      }
      sleep(retryDelayMs * 2 ** attempt)
    }
  }
}

/** Map P0-P4 labels to the loop priority scale. No P label means P2. */
export function priorityFromLabels(labels) {
  const priorities = labelNames(labels)
    .map((name) => name.match(/^P([0-4])$/i))
    .filter(Boolean)
    .map((match) => Number(match[1]))
  return priorities.length ? Math.min(...priorities) : DEFAULT_PRIORITY
}

/** Local issue references from Markdown task-list lines (same repository only). */
export function parseTaskList(body) {
  const references = []
  for (const line of String(body || '').split(/\r?\n/)) {
    const match = line.match(/^\s*-\s+\[([ xX])\]\s+#(\d+)(?:\s|$)/)
    if (match) references.push({ number: Number(match[2]), checked: match[1].toLowerCase() === 'x' })
  }
  return references
}

function normalizeIssue(raw) {
  const number = Number(raw?.number)
  if (!Number.isSafeInteger(number) || number < 1) return null
  return {
    number,
    id: String(number),
    title: raw.title || String(number),
    body: raw.body || '',
    labels: Array.isArray(raw.labels) ? raw.labels : [],
    comments: Array.isArray(raw.comments) ? raw.comments : [],
    state: raw.state ? String(raw.state) : 'open',
  }
}

function parseArray(raw, context) {
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

function parseObject(raw, context) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw invalidRecord(`${context} 返回非法 JSON: ${err.message}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw invalidRecord(`${context} 返回格式错误：预期 JSON 对象`)
  }
  return parsed
}

export function parseRepoRemote(remote) {
  let value = String(remote || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '')
  if (!value) return ''
  let host = ''
  let path = ''
  const scp = !value.includes('://') && value.match(/^(?:[^@]+@)?([^:/]+):(.+)$/)
  if (scp) {
    host = scp[1]
    path = scp[2]
  } else {
    try {
      const url = new URL(value)
      host = url.host
      path = url.pathname.replace(/^\//, '')
    } catch {
      return ''
    }
  }
  const parts = path.split('/').filter(Boolean)
  if (parts.length < 2 || !host) return ''
  const repo = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
  return host.toLowerCase() === 'github.com' ? repo : `${host}/${repo}`
}

function inferRepo(cwd) {
  try {
    const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const repo = parseRepoRemote(remote)
    if (repo) return repo
  } catch {
    // Fall through to the actionable error.
  }
  throw new WorkItemsError('无法从 git remote 推断 GitHub 仓库，请显式提供 repo')
}

export function normalizeRepo(repo) {
  const value = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '')
  if (!/^(?:[^/]+\/)?[^/]+\/[^/]+$/.test(value)) {
    throw new WorkItemsError(`GitHub 仓库格式错误: ${repo || '(空)'}`, 2)
  }
  return value.replace(/\.git$/i, '')
}

function issueArgs(repo, args) {
  return repo ? [...args, '--repo', repo] : args
}

function toComment(raw) {
  return {
    id: raw?.id ? String(raw.id) : '',
    author: raw?.author?.login ? String(raw.author.login) : String(raw?.author || ''),
    body: String(raw?.body || ''),
    createdAt: raw?.createdAt ? String(raw.createdAt) : '',
  }
}

export function createGhSource(opts = {}) {
  const cwd = opts.cwd || process.cwd()
  let repo = opts.repo ? normalizeRepo(opts.repo) : null
  const run = (args) => {
    if (!repo) repo = normalizeRepo(inferRepo(cwd))
    return runGh(args.includes('--repo') ? args : [...args, '--repo', repo], { ...opts, cwd })
  }

  function loadIssues(options = {}) {
    const state = options.state || 'open'
    const raw = run(
      issueArgs(repo, [
        'issue',
        'list',
        '--state',
        state,
        '--limit',
        String(options.limit || LIST_LIMIT),
        '--json',
        ISSUE_FIELDS,
      ]),
    )
    return parseArray(raw, 'gh issue list')
  }

  function viewIssue(id) {
    let raw
    try {
      raw = run(issueArgs(repo, ['issue', 'view', String(id), '--json', VIEW_FIELDS]))
    } catch (err) {
      if (/not found|no issues found|could not resolve/i.test(err.message)) {
        throw new WorkItemsError(`GitHub issue 不存在或无法读取: ${id}`)
      }
      throw err
    }
    const issue = normalizeIssue(parseObject(raw, 'gh issue view'))
    if (!issue) throw new WorkItemsError(`GitHub issue 不存在或无法读取: ${id}`)
    return issue
  }

  function openSetOf(issues) {
    return new Set(issues.filter((issue) => issue.state !== 'closed').map((issue) => issue.number))
  }

  function blockersOf(issue, openSet) {
    return parseTaskList(issue.body)
      .filter((ref) => !ref.checked && openSet.has(ref.number))
      .map((ref) => String(ref.number))
  }

  function toFact(issue, blockedBy = []) {
    return {
      id: issue.id,
      title: issue.title,
      body: issue.body,
      labels: labelNames(issue.labels),
      priority: priorityFromLabels(issue.labels),
      state: issue.state,
      blockedBy,
    }
  }

  function capabilities() {
    return {
      source: 'gh',
      claimMode: 'best-effort',
      reads: ['list', 'get'],
      mutations: ['claim', 'comment', 'addLabels', 'removeLabels', 'close'],
      labels: { add: true, remove: true, set: false },
      close: true,
      deliver: false,
      selection: { readyLabel: true, excludeLabels: true, dependencies: 'task-list', priority: 'P0..P4 labels' },
    }
  }

  return {
    name: 'gh',
    claimMode: 'best-effort',
    get repo() { return repo },
    capabilities,

    list(options = {}) {
      const issues = loadIssues(options)
      const openSet = openSetOf(issues)
      return issues.map((issue) => toFact(issue, blockersOf(issue, openSet)))
    },

    selectReady(options = {}) {
      const issues = loadIssues(options)
      const openSet = openSetOf(issues)
      let rows = issues.map((issue) => ({ issue, blockedBy: blockersOf(issue, openSet) }))
      rows = rows.filter(({ issue }) => filterByLabels([issue], (item) => item.labels, options).length === 1)
      if (!options.includeBlocked && options.requireDependencies !== false) rows = rows.filter(({ blockedBy }) => blockedBy.length === 0)
      rows = rows
        .map(({ issue, blockedBy }) => ({ issue, blockedBy }))
        .filter(({ issue }) => priorityWithin(issue, priorityFromLabels(issue.labels), options))
      rows.sort(
        (a, b) =>
          priorityFromLabels(a.issue.labels) - priorityFromLabels(b.issue.labels) ||
          a.issue.number - b.issue.number,
      )
      return rows.map(({ issue, blockedBy }) => toFact(issue, blockedBy))
    },

    get(id, _options = {}) {
      const issue = viewIssue(id)
      return {
        ...toFact(issue),
        comments: issue.comments.map(toComment),
        requirements: '',
      }
    },

    claim(id, options = {}) {
      const claimMode = 'best-effort'
      const claimLabel = options.claimLabel || 'in-progress'
      let issues
      try {
        issues = loadIssues()
      } catch (err) {
        return { id: String(id), status: 'error', claimMode, message: err.message }
      }
      const issue = issues.find((candidate) => candidate.id === String(id))
      if (!issue) {
        return { id: String(id), status: 'error', claimMode, message: `GitHub issue 不存在或无法读取: ${id}` }
      }
      if (hasLabel(issue.labels, claimLabel)) {
        return { id: String(id), status: 'already-claimed', claimMode }
      }
      const args = ['issue', 'edit', String(id), '--add-label', claimLabel]
      if (options.assignee) args.push('--add-assignee', String(options.assignee))
      try {
        run(issueArgs(repo, args))
      } catch (err) {
        return { id: String(id), status: 'error', claimMode, message: err.message }
      }
      return { id: String(id), status: 'claimed', claimMode }
    },

    comment(id, text) {
      if (!String(text || '').trim()) throw new WorkItemsError('comment 需要非空正文', 2)
      run(issueArgs(repo, ['issue', 'comment', String(id), '--body', String(text)]))
      return { id: String(id), status: 'commented' }
    },

    addLabels(id, labels) {
      const added = normalizeLabels(labels)
      if (!added.length) throw new WorkItemsError('addLabels 需要至少一个标签', 2)
      const args = ['issue', 'edit', String(id)]
      for (const label of added) args.push('--add-label', label)
      run(issueArgs(repo, args))
      return { id: String(id), status: 'labels-updated', added }
    },

    removeLabels(id, labels) {
      const removed = normalizeLabels(labels)
      if (!removed.length) throw new WorkItemsError('removeLabels 需要至少一个标签', 2)
      const args = ['issue', 'edit', String(id)]
      for (const label of removed) args.push('--remove-label', label)
      run(issueArgs(repo, args))
      return { id: String(id), status: 'labels-updated', removed }
    },

    setLabels() {
      throw new WorkItemsError('gh 不支持全量替换标签；请使用 addLabels/removeLabels')
    },

    close(id, options = {}) {
      const args = ['issue', 'close', String(id)]
      if (options.comment) args.push('--comment', String(options.comment))
      if (options.reason) args.push('--reason', String(options.reason))
      run(issueArgs(repo, args))
      return { id: String(id), status: 'closed' }
    },

    deliver() {
      throw new WorkItemsError('gh 不支持 deliver；请使用 close')
    },
  }
}

function normalizeLabels(labels) {
  const list = Array.isArray(labels) ? labels : [labels]
  return [...new Set(list.map((label) => String(label || '').trim()).filter(Boolean))]
}
