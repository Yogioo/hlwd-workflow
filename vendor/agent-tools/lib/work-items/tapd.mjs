/**
 * TAPD work-item source.
 *
 * Extracted from skills/afk-run/scripts/task-sources/tapd.mjs.
 *
 * Domain rules preserved: tapd-cli parameters always use underscores (hyphen
 * forms are silently dropped); labels are pipe-separated and written by full
 * replacement with read-back verification; the `label` field must never use
 * commas (TAPD would create a new label name); embedded image links expire, so
 * images are localized only into an explicitly provided cache directory.
 *
 * Queue policy is caller-owned here: `list` reads by owner, `selectReady`
 * applies only the ready/exclude labels the caller passes. Reading or rejecting
 * a blank record never mutates labels or comments.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { WorkItemsError, invalidRecord } from './errors.mjs'
import { filterByLabels, hasLabel, priorityWithin, sortTasks } from './selection.mjs'
import { basename, join } from 'node:path'

export const DEFAULT_READY_LABEL = 'ready-for-agent'
export const DEFAULT_CLAIMED_LABEL = 'afk-claimed'
export const DEFAULT_DELIVERED_LABEL = 'afk-delivered'
export const DEFAULT_FAILED_LABEL = 'afk-failed'

/** TAPD `label` is multi-select; values are separated by a pipe, never a comma. */
export const LABEL_SEPARATOR = '|'

const PAGE_SIZE = 200
const MAX_PAGES = 20
const DEFAULT_RETRIES = 2
const DEFAULT_RETRY_DELAY_MS = 100
const COMMENT_PREFIX = '[AFK]'
const COMMENT_MAX = 2000
const UNPRIORITIZED = 1

const MAX_IMAGES = 20
const IMAGE_TIMEOUT_MS = 20000

const PRIORITY_BY_LABEL = { 高: 0, 中: 1, 低: 2 }

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

function isMissingCommandError(err) {
  return err?.code === 'ENOENT' || /enoent|not recognized|not found|不是内部或外部命令/.test(errorText(err).toLowerCase())
}

/** Call tapd-cli with bounded retries. A missing binary fails loudly. */
export function runTapd(args, opts = {}) {
  if (typeof opts.run === 'function') return opts.run(args)
  const command = opts.command || 'tapd-cli'
  const commandPrefix = Array.isArray(opts.commandPrefix) ? opts.commandPrefix : []
  const retries = Number.isInteger(opts.retries) ? Math.max(0, opts.retries) : DEFAULT_RETRIES
  const retryDelayMs = Number.isFinite(opts.retryDelayMs)
    ? Math.max(0, Number(opts.retryDelayMs))
    : DEFAULT_RETRY_DELAY_MS
  const full = [...commandPrefix, ...args].join(' ')
  for (let attempt = 0; ; attempt++) {
    try {
      return execFileSync(command, [...commandPrefix, ...args], {
        cwd: opts.cwd,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      if (isMissingCommandError(err)) {
        throw new WorkItemsError(`找不到 tapd-cli 命令（${command}）: ${full}`)
      }
      if (!isRetryableError(err) || attempt >= retries) {
        const detail = errorText(err)
        throw new WorkItemsError(`tapd-cli 命令失败: ${full}${detail ? ` — ${detail}` : ''}`)
      }
      sleep(retryDelayMs * 2 ** attempt)
    }
  }
}

/** Parse tapd-cli JSON; TAPD uses status=1 for success. */
export function parseTapdPayload(raw, context) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw invalidRecord(`${context} 返回非法 JSON: ${err.message}`)
  }
  if (parsed && typeof parsed === 'object' && parsed.status !== undefined && Number(parsed.status) !== 1) {
    throw new WorkItemsError(`${context} 失败: ${parsed.info || JSON.stringify(parsed).slice(0, 200)}`)
  }
  return parsed
}

export function storyRows(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : []
  return rows.map((row) => (row && row.Story) || row).filter((row) => row && row.id)
}

export function labelList(raw) {
  return String(raw ?? '')
    .split(LABEL_SEPARATOR)
    .map((value) => value.trim())
    .filter(Boolean)
}

export function priorityValue(raw) {
  return PRIORITY_BY_LABEL[String(raw || '').trim()] ?? UNPRIORITIZED
}

export function normalizeTapdConfig(raw = {}) {
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const pick = (key, fallback) => String(cfg[key] ?? '').trim() || fallback
  return {
    assignee: String(cfg.assignee ?? '').trim(),
    readyLabel: pick('readyLabel', DEFAULT_READY_LABEL),
    claimedLabel: pick('claimedLabel', DEFAULT_CLAIMED_LABEL),
    deliveredLabel: pick('deliveredLabel', DEFAULT_DELIVERED_LABEL),
    failedLabel: pick('failedLabel', DEFAULT_FAILED_LABEL),
    commentAuthor: String(cfg.commentAuthor ?? '').trim(),
  }
}

export function machineLabels(config) {
  return [config.claimedLabel, config.deliveredLabel, config.failedLabel].filter(Boolean)
}

export function machineLabelOf(labels, config) {
  return machineLabels(config).find((label) => hasLabel(labels, label)) || ''
}

const HTML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" }

/** Best-effort HTML to text, preserving image links. */
export function htmlToText(html) {
  let text = String(html || '')
  if (!text) return ''
  text = text.replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
  text = text.replace(/<img\b[^>]*?\bsrc\s*=\s*["']?([^"'\s>]+)[^>]*>/gi, '\n[图片]($1)\n')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
  text = text.replace(/<[^>]+>/g, '')
  text = text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, name) => HTML_ENTITIES[String(name).toLowerCase()] ?? match)
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

export { COMMENT_PREFIX }

/** Only strip text that really contains HTML tags; `a < b` stays intact. */
export function commentText(raw) {
  const value = String(raw ?? '')
  if (/<\/?(p|div|br|span|img|a|ul|ol|li|strong|b|em|table|tr|td|h[1-6])(\s[^>]*)?\/?>/i.test(value)) {
    return htmlToText(value)
  }
  return value.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Description plus comments in ascending time order, no length/count cap. */
export function renderTaskBody(descriptionText, comments = []) {
  const rows = (Array.isArray(comments) ? comments : [])
    .map((comment) => ({
      created: String(comment?.created || '').trim(),
      author: String(comment?.author || '').trim(),
      text: commentText(comment?.description),
    }))
    .filter((comment) => comment.text)
  const head = String(descriptionText || '').trim()
  if (!rows.length) return head
  const lines = rows.map((comment) => `- ${[comment.created, comment.author].filter(Boolean).join(' ')}：${comment.text}`)
  return [head || '（需求描述为空）', '', `## 评论（TAPD，时间升序，共 ${rows.length} 条）`, '', ...lines].join('\n')
}

export function isBlankRequirement(descriptionText, comments = []) {
  if (String(descriptionText || '').trim()) return false
  return !(Array.isArray(comments) ? comments : []).some((comment) => commentText(comment?.description))
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function extractImagePaths(text) {
  const found = new Set()
  const source = String(text || '')
  for (const match of source.matchAll(/\]\(\s*(\/tfl\/[^)\s]+)\s*\)/g)) found.add(match[1])
  for (const match of source.matchAll(/(?:src|href)\s*=\s*["']?(\/tfl\/[^"'\s>]+)/gi)) found.add(match[1])
  for (const match of source.matchAll(/(\/tfl\/[^\s)"'<>]+)/g)) found.add(match[1])
  return [...found].slice(0, MAX_IMAGES)
}

export function replaceImagePath(text, path, replacement) {
  const pattern = new RegExp(`!?\\[[^\\]]*\\]\\(\\s*${escapeRegExp(path)}\\s*\\)`, 'g')
  return String(text).replace(pattern, replacement).split(path).join(replacement)
}

export function safeImageName(path) {
  return basename(String(path)).replace(/[^A-Za-z0-9._-]/g, '_') || 'image'
}

export function toLinkPath(value) {
  return String(value).replace(/\\/g, '/')
}

function normalizeStory(story) {
  return {
    id: String(story.id),
    title: story.name || String(story.id),
    labels: labelList(story.label),
    priority: priorityValue(story.priority),
    owner: String(story.owner || '').replace(/;/g, '').trim(),
    status: String(story.status || ''),
    workspaceId: String(story.workspace_id ?? story.workspaceId ?? ''),
    description: String(story.description ?? ''),
  }
}

function sameLabels(a, b) {
  const left = [...new Set(a)].sort()
  const right = [...new Set(b)].sort()
  return left.length === right.length && left.every((value, index) => value === right[index])
}

export function createTapdSource(opts = {}) {
  const cwd = opts.cwd || process.cwd()
  const config = normalizeTapdConfig(opts.tapd || opts.mapping || {})
  const defaultImageDir = opts.imageDir ? String(opts.imageDir) : ''
  const request = (args) => runTapd(args, { ...opts, cwd })
  const doFetch = typeof opts.fetch === 'function' ? opts.fetch : globalThis.fetch

  function assigneeOf(extra) {
    const assignee = String(extra || config.assignee || '').trim()
    if (!assignee) throw new WorkItemsError('TAPD 任务源缺少 assignee（用处理人限定「我的需求」）')
    return assignee
  }

  function fetchStories(extraArgs) {
    const rows = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const raw = request(['story', 'list', ...extraArgs, `limit=${PAGE_SIZE}`, `page=${page}`])
      const batch = storyRows(parseTapdPayload(raw, 'tapd-cli story list'))
      rows.push(...batch)
      if (batch.length < PAGE_SIZE) break
    }
    return rows
  }

  function fetchStory(id) {
    const rows = storyRows(parseTapdPayload(request(['story', 'list', `id=${id}`, 'limit=1']), 'tapd-cli story list'))
    const story = rows[0]
    if (!story) throw new WorkItemsError(`TAPD 需求不存在或无权读取: ${id}`)
    return normalizeStory(story)
  }

  function fetchComments(id) {
    const rows = []
    for (let page = 1; page <= MAX_PAGES; page++) {
      const raw = request(['comment', 'list', 'entry_type=stories', `entry_id=${id}`, `limit=${PAGE_SIZE}`, `page=${page}`])
      const batch = (parseTapdPayload(raw, 'tapd-cli comment list').data || [])
        .map((row) => (row && row.Comment) || row)
        .filter(Boolean)
      rows.push(...batch)
      if (batch.length < PAGE_SIZE) break
    }
    return rows.sort((a, b) => String(a.created || '').localeCompare(String(b.created || '')))
  }

  function toComment(raw) {
    return {
      id: raw?.id ? String(raw.id) : '',
      created: String(raw?.created || ''),
      author: String(raw?.author || ''),
      text: commentText(raw?.description),
    }
  }

  function requireCommentAuthor() {
    if (config.commentAuthor || process.env.TAPD_NPC_ROLE) return
    throw new WorkItemsError(
      'TAPD 写评论需要评论人：请在配置里设 commentAuthor，或设置环境变量 TAPD_NPC_ROLE',
    )
  }

  /** Full label replacement with read-back verification. */
  function setLabels(id, labels) {
    const unique = [...new Set((Array.isArray(labels) ? labels : [labels]).map((label) => String(label).trim()).filter(Boolean))]
    request(['story', 'update', `id=${id}`, `label=${unique.join(LABEL_SEPARATOR)}`])
    const stored = fetchStory(id).labels
    if (!sameLabels(stored, unique)) {
      throw new WorkItemsError(
        `TAPD 标签写入未被接受：期望 [${unique.join(', ')}]，回读得到 [${stored.join(', ')}]（多选分隔符必须是 ${LABEL_SEPARATOR}）`,
      )
    }
    return unique
  }

  function addComment(id, text) {
    const args = ['comment', 'add', 'entry_type=stories', `entry_id=${id}`, `description=${String(text).slice(0, COMMENT_MAX)}`]
    if (config.commentAuthor) args.push(`author=${config.commentAuthor}`)
    request(args)
  }

  function toFact(story) {
    return {
      id: story.id,
      title: story.title,
      labels: story.labels,
      priority: story.priority,
      owner: story.owner,
      status: story.status,
      workspaceId: story.workspaceId,
      description: story.description,
    }
  }

  async function ensureImage(story, imagePath, imageDir) {
    const target = join(imageDir, safeImageName(story.id), safeImageName(imagePath))
    if (existsSync(target) && statSync(target).size > 0) return target
    const args = ['attachment', 'get-image', `image_path=${imagePath}`]
    if (story.workspaceId) args.push(`workspaceid=${story.workspaceId}`)
    const payload = parseTapdPayload(request(args), 'tapd-cli attachment get-image')
    const url = payload?.data?.Attachment?.download_url || ''
    if (!url) throw new WorkItemsError(`get-image 未返回 download_url: ${imagePath}`)
    if (typeof doFetch !== 'function') throw new WorkItemsError('运行环境没有可用的 fetch，无法下载图片')
    const response = await doFetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) })
    if (!response.ok) throw new WorkItemsError(`图片下载失败 ${response.status}: ${imagePath}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (!bytes.length) throw new WorkItemsError(`图片为空: ${imagePath}`)
    mkdirSync(join(imageDir, safeImageName(story.id)), { recursive: true })
    const temporary = `${target}.tmp-${process.pid}`
    writeFileSync(temporary, bytes)
    renameSync(temporary, target)
    return target
  }

  async function localizeImages(body, story, imageDir, options) {
    let out = body
    const errors = []
    for (const imagePath of extractImagePaths(body)) {
      let replacement = `[图片下载失败: ${imagePath}]`
      try {
        replacement = `![图片](${toLinkPath(await ensureImage(story, imagePath, imageDir))})`
      } catch (err) {
        errors.push({ path: imagePath, message: err.message })
        if (options.failOnImageError) {
          throw new WorkItemsError(`图片下载失败: ${imagePath} — ${err.message}`)
        }
      }
      out = replaceImagePath(out, imagePath, replacement)
    }
    return { body: out, errors }
  }

  function capabilities() {
    return {
      source: 'tapd',
      claimMode: 'best-effort',
      reads: ['list', 'get'],
      mutations: ['claim', 'comment', 'addLabels', 'removeLabels', 'setLabels', 'deliver'],
      labels: { add: true, remove: true, set: true },
      close: false,
      deliver: true,
      selection: { readyLabel: true, excludeLabels: true, assignee: true, dependencies: 'none', priority: '高/中/低' },
    }
  }

  return {
    name: 'tapd',
    claimMode: 'best-effort',
    config,
    capabilities,

    /** Facts for the assignee's stories. No ready/machine label filtering. */
    list(options = {}) {
      const assignee = assigneeOf(options.assignee)
      const extra = [`owner=${assignee}`]
      if (options.serverLabel) extra.push(`label=${options.serverLabel}`)
      let rows = fetchStories(extra).map(normalizeStory)
      // Re-check locally: tapd-cli silently drops malformed filters.
      if (options.serverLabel) rows = rows.filter((story) => hasLabel(story.labels, options.serverLabel))
      return rows.map(toFact)
    },

    selectReady(options = {}) {
      const assignee = assigneeOf(options.assignee)
      const rows = this.list({ assignee, serverLabel: options.readyLabel })
      let filtered = filterByLabels(rows, (story) => story.labels, options)
      if (options.excludeMachineLabels) {
        const machines = machineLabels(config)
        filtered = filtered.filter((story) => !machineLabelOf(story.labels, config))
      }
      if (options.assignee) filtered = filtered.filter((story) => story.owner === options.assignee)
      filtered = filtered.filter((story) => priorityWithin(story, story.priority, options))
      return sortTasks(filtered, (story) => story.priority, (story) => story.id)
    },

    async get(id, options = {}) {
      const story = fetchStory(id)
      const rawComments = fetchComments(id)
      const comments = rawComments.map(toComment)
      let body = renderTaskBody(htmlToText(story.description), rawComments)
      const imageDir = options.imageDir !== undefined ? String(options.imageDir || '') : defaultImageDir
      const images = { cacheDir: imageDir || null, localized: false, errors: [] }
      if (imageDir) {
        const localized = await localizeImages(body, story, imageDir, options)
        body = localized.body
        images.localized = true
        images.errors = localized.errors
      }
      return { ...toFact(story), body, comments, requirements: '', images }
    },

    claim(id, options = {}) {
      const claimMode = 'best-effort'
      let story
      try {
        story = fetchStory(id)
      } catch (err) {
        return { id: String(id), status: 'error', claimMode, message: err.message }
      }
      if (options.readyLabel && !hasLabel(story.labels, options.readyLabel)) {
        return { id: String(id), status: 'error', claimMode, message: `TAPD 需求缺少 ${options.readyLabel} 标签: ${id}` }
      }
      const machine = options.excludeLabels
        ? options.excludeLabels.find((label) => hasLabel(story.labels, label))
        : ''
      if (machine) {
        return { id: String(id), status: 'already-claimed', claimMode, machineLabel: machine }
      }
      let comments
      try {
        comments = fetchComments(id)
      } catch (err) {
        return { id: String(id), status: 'error', claimMode, message: err.message }
      }
      if (isBlankRequirement(htmlToText(story.description), comments)) {
        return { id: String(id), status: 'error', claimMode, message: `需求描述与评论都为空，拒绝认领: ${id}` }
      }
      const claimLabel = options.claimLabel || config.claimedLabel
      try {
        const labels = setLabels(id, [...story.labels, claimLabel])
        return { id: String(id), status: 'claimed', claimMode, labels }
      } catch (err) {
        return { id: String(id), status: 'error', claimMode, message: err.message }
      }
    },

    comment(id, text) {
      if (!String(text || '').trim()) throw new WorkItemsError('comment 需要非空正文', 2)
      requireCommentAuthor()
      addComment(id, String(text))
      return { id: String(id), status: 'commented' }
    },

    setLabels(id, labels) {
      const stored = setLabels(id, labels)
      return { id: String(id), status: 'labels-updated', labels: stored }
    },

    addLabels(id, labels) {
      const story = fetchStory(id)
      const added = (Array.isArray(labels) ? labels : [labels]).map((label) => String(label).trim()).filter(Boolean)
      const stored = setLabels(id, [...story.labels, ...added])
      return { id: String(id), status: 'labels-updated', added, labels: stored }
    },

    removeLabels(id, labels) {
      const story = fetchStory(id)
      const removed = new Set((Array.isArray(labels) ? labels : [labels]).map((label) => String(label).trim()).filter(Boolean))
      const stored = setLabels(id, story.labels.filter((label) => !removed.has(label)))
      return { id: String(id), status: 'labels-updated', removed: [...removed], labels: stored }
    },

    /** TAPD delivery: swap claim label for delivered label, then comment. */
    deliver(id, options = {}) {
      requireCommentAuthor()
      const story = fetchStory(id)
      const delivered = story.labels.filter((label) => label !== config.claimedLabel)
      delivered.push(config.deliveredLabel)
      const labels = setLabels(id, delivered)
      const lines = [`${COMMENT_PREFIX} 开发完成，请验收。`]
      const summary = String(options.summary || '').trim()
      const commit = String(options.commit || '').trim()
      if (summary) lines.push(summary)
      if (commit) lines.push(`提交：${commit}`)
      addComment(id, lines.join('\n\n'))
      return { id: String(id), status: 'delivered', labels }
    },

    close() {
      throw new WorkItemsError('TAPD 需求不支持 close；交付请使用 deliver（写标签 + 评论）')
    },
  }
}

export { hasLabel }
