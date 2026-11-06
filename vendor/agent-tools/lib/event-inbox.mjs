#!/usr/bin/env node
/**
 * event-inbox: a directory-backed event queue with explicit ack states.
 *
 * Narrowed from skills/afk-run/scripts/inbox.mjs. The original resolved an AFK
 * home, guessed a project from the working directory, and kicked a drain
 * process. This version does none of that: the caller passes --dir, records
 * are just metadata, and writing an event only writes the event.
 */

import { randomBytes } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'

/** Allowed states, in monotonic order. */
export const INBOX_STATES = ['unread', 'seen', 'done']

/** requirementId used by events that no requirement has claimed. */
export const UNROUTED = null

const STATE_RANK = { unread: 0, seen: 1, done: 2 }
const MAX_ID_LENGTH = 200

/** Per-store writer lock. Live owners are never preempted. */
const LOCK_NAME = '.write.lock'

/** Thrown for invalid arguments/records (exit 2) and operational failures (exit 1). */
export class EventInboxError extends Error {
  constructor(message, exitCode = 2) {
    super(message)
    this.name = 'EventInboxError'
    this.exitCode = exitCode
  }
}

function usageError(message) {
  return new EventInboxError(message, 2)
}

function operationalError(message) {
  return new EventInboxError(message, 1)
}

/** Caller-supplied timestamps must be finite and non-negative. */
function assertTimestamp(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw usageError(`${label} 必须是有限非负时间戳，收到 ${JSON.stringify(value)}`)
  }
  return value
}

function assertDir(dir) {
  const value = String(dir || '')
  if (!value.trim()) throw usageError('需要 --dir 指定存储根目录')
  return resolve(value)
}

function isIdentifier(text) {
  return (
    typeof text === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(text) &&
    !text.includes('..') &&
    text.length <= MAX_ID_LENGTH
  )
}

/** Identifier rule shared by event ids and requirementId metadata. */
export function assertIdentifier(value, label = 'id') {
  const text = String(value || '')
  if (!isIdentifier(text)) throw usageError(`${label} 非法: ${JSON.stringify(value)}`)
  return text
}

export function assertEventId(id) {
  return assertIdentifier(id, '事件 id')
}

function eventFile(root, id) {
  return join(root, `${assertEventId(id)}.json`)
}

/** Filename fragment: only used when building a generated id. */
function safePart(value) {
  const cleaned = String(value || '')
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return cleaned || 'event'
}

function localStamp(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    String(d.getFullYear()).slice(2) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  )
}

function salt() {
  return randomBytes(4).toString('hex')
}

function allocateId(root, makeId, attempts = 16) {
  for (let i = 0; i < attempts; i += 1) {
    const id = makeId()
    if (!existsSync(join(root, `${id}.json`))) return id
  }
  throw operationalError(`连续 ${attempts} 次生成的事件 id 冲突，未写入: ${root}`)
}

function temporaryPath(file) {
  return `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
}

/** Atomic replace: unique temp file + rename, owned temp removed on failure. */
function writeAtomic(file, record) {
  const tmp = temporaryPath(file)
  try {
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    try {
      unlinkSync(tmp)
    } catch {
      // best-effort: the temp file was never ours or is already gone
    }
    throw err
  }
}

function lockFile(root) {
  return join(root, LOCK_NAME)
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return Boolean(err && err.code === 'EPERM')
  }
}

function readLock(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Acquire the per-store writer lock atomically. A lock held by a live process
 * is never removed; the caller gets an explicit busy error. Leftover locks
 * require offline cleanup with all writers stopped; acquisition never reclaims.
 */
function acquireLock(root) {
  mkdirSync(root, { recursive: true })
  const file = lockFile(root)
  const token = randomBytes(8).toString('hex')
  try {
    writeFileSync(file, `${JSON.stringify({ pid: process.pid, at: Date.now(), token })}\n`, {
      encoding: 'utf8',
      flag: 'wx',
    })
    let released = false
    return () => {
      if (released) return
      released = true
      const held = readLock(file)
      if (held && held.token === token) {
        try {
          unlinkSync(file)
        } catch {
          // another writer already replaced/removed it
        }
      }
    }
  } catch (err) {
    if (!err || err.code !== 'EEXIST') {
      throw operationalError(`无法创建收件箱写锁 ${file}: ${err && err.message}`)
    }
    const held = readLock(file)
    if (held && isProcessAlive(held.pid)) {
      throw operationalError(`收件箱正被写入（锁 ${file}，pid ${held.pid}），请稍后重试`)
    }
    throw operationalError(`收件箱写锁 ${file} 已存在；停止所有写入进程后检查并清理遗留锁`)
  }
}

function normalizeWorkItems(workItems) {
  if (workItems === undefined || workItems === null) return []
  if (!Array.isArray(workItems)) throw usageError('workItems 必须是数组')
  return workItems.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw usageError('workItems 的每一项必须是 { taskSource, id }')
    }
    if (!item.taskSource || item.id === undefined || item.id === null) {
      throw usageError('workItems 的每一项都需要 taskSource 和 id')
    }
    return { taskSource: String(item.taskSource), id: String(item.id) }
  })
}

function normalizeDetail(detail) {
  if (detail === undefined || detail === null) return {}
  if (typeof detail !== 'object' || Array.isArray(detail)) throw usageError('detail 必须是 JSON 对象')
  return detail
}

function assertRecordWorkItems(workItems, file) {
  if (!Array.isArray(workItems)) throw usageError(`事件记录损坏: ${file}（workItems 不是数组）`)
  for (const item of workItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw usageError(`事件记录损坏: ${file}（workItems 项不是对象）`)
    }
    if (typeof item.taskSource !== 'string' || !item.taskSource || typeof item.id !== 'string') {
      throw usageError(`事件记录损坏: ${file}（workItems 项需要字符串 taskSource 与 id）`)
    }
  }
  return workItems
}

function readRecordStrict(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    throw operationalError(`无法读取事件记录 ${file}: ${err.message}`)
  }
  let record
  try {
    record = JSON.parse(text)
  } catch (err) {
    throw usageError(`事件记录损坏: ${file}（${err.message}）`)
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw usageError(`事件记录损坏: ${file}（不是 JSON 对象）`)
  }
  if (typeof record.id !== 'string' || !record.id) {
    throw usageError(`事件记录损坏: ${file}（缺少 id）`)
  }
  const name = basename(file)
  if (name.endsWith('.json') && record.id !== name.slice(0, -'.json'.length)) {
    throw usageError(`事件记录损坏: ${file}（id 与文件名不一致）`)
  }
  if (typeof record.kind !== 'string' || !record.kind.trim()) {
    throw usageError(`事件记录损坏: ${file}（kind 非法）`)
  }
  if (!INBOX_STATES.includes(record.state)) {
    throw usageError(`事件记录损坏: ${file}（未知状态 ${JSON.stringify(record.state)}）`)
  }
  for (const key of ['createdAt', 'updatedAt']) {
    const value = record[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw usageError(`事件记录损坏: ${file}（${key} 非法）`)
    }
  }
  assertRecordWorkItems(record.workItems === undefined ? [] : record.workItems, file)
  for (const key of ['seenAt', 'doneAt']) {
    if (record[key] === undefined) continue
    const value = record[key]
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw usageError(`事件记录损坏: ${file}（${key} 非法）`)
    }
  }
  if (
    record.detail !== undefined &&
    (typeof record.detail !== 'object' || record.detail === null || Array.isArray(record.detail))
  ) {
    throw usageError(`事件记录损坏: ${file}（detail 非法）`)
  }
  if (record.requirementId !== null && record.requirementId !== undefined && !isIdentifier(record.requirementId)) {
    throw usageError(`事件记录损坏: ${file}（requirementId 非法）`)
  }
  return record
}

/**
 * Persist one event. This only writes the record; it never spawns, drains,
 * notifies, or touches other records.
 */
export function writeEvent(input = {}, { dir, now = Date.now() } = {}) {
  const root = assertDir(dir)
  assertTimestamp(now, 'now')
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw usageError('事件必须是 JSON 对象')
  }
  const kind = String(input.kind || '').trim()
  if (!kind) throw usageError('事件缺少 kind')
  const requirementId =
    input.requirementId === undefined || input.requirementId === null
      ? UNROUTED
      : assertIdentifier(input.requirementId, 'requirementId')
  const projectKey = String(input.projectKey || '')
  const workdir = String(input.workdir || '')
  const workItems = normalizeWorkItems(input.workItems)
  const detail = normalizeDetail(input.detail)

  const release = acquireLock(root)
  try {
    const scope = safePart(requirementId || projectKey || 'unscoped')
    const id = allocateId(root, () => `${localStamp(now)}-${safePart(kind)}-${scope}-${salt()}`)
    const file = join(root, `${id}.json`)
    const record = {
      id,
      kind,
      state: 'unread',
      createdAt: now,
      updatedAt: now,
      projectKey,
      workdir,
      requirementId,
      workItems,
      title: String(input.title || ''),
      detail,
      nextStep: String(input.nextStep || ''),
    }
    writeAtomic(file, record)
    return { ...record, file }
  } finally {
    release()
  }
}
/**
 * List events, oldest first. Unreadable `.json` files are returned in
 * `invalid` rather than silently dropped.
 */
export function listEvents({
  dir,
  state,
  states,
  projectKey,
  requirementId,
  kind,
  unroutedOnly = false,
} = {}) {
  const root = assertDir(dir)
  const wanted = states || (state ? [state] : undefined)
  if (wanted) {
    for (const value of wanted) {
      if (!INBOX_STATES.includes(value)) {
        throw usageError(`未知收件箱状态: ${value}（支持: ${INBOX_STATES.join(', ')}）`)
      }
    }
  }

  const items = []
  const invalid = []
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      if (!name.endsWith('.json')) continue
      const file = join(root, name)
      try {
        const record = readRecordStrict(file)
        if (record.id !== name.slice(0, -'.json'.length)) {
          throw new Error('文件名与 id 不一致')
        }
        items.push(record)
      } catch (err) {
        invalid.push({ file, error: err.message })
      }
    }
  }

  const filtered = items
    .filter((item) => !wanted || wanted.includes(item.state))
    .filter((item) => !projectKey || item.projectKey === projectKey)
    .filter((item) => !requirementId || item.requirementId === requirementId)
    .filter((item) => !kind || item.kind === kind)
    .filter((item) => !unroutedOnly || item.requirementId === UNROUTED)
  filtered.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)))
  return { items: filtered, invalid }
}

/** Read one event by id. Missing returns null; a corrupt record throws. */
export function getEvent(id, { dir } = {}) {
  const root = assertDir(dir)
  const file = eventFile(root, id)
  if (!existsSync(file)) return null
  const record = readRecordStrict(file)
  if (record.id !== assertEventId(id)) throw usageError(`事件记录损坏: ${file}（id 不一致）`)
  return { ...record, file }
}

/**
 * Move an event to seen/done. State is monotonic and repeated acks are
 * idempotent: timestamps only move on an actual transition.
 */
export function ackEvent(id, { dir, state = 'done', note = '', now = Date.now() } = {}) {
  const root = assertDir(dir)
  assertTimestamp(now, 'now')
  if (state === 'unread') throw usageError('ack 只接受 seen 或 done（不能改回 unread）')
  if (!INBOX_STATES.includes(state)) {
    throw usageError(`未知收件箱状态: ${state}（支持: seen, done）`)
  }
  const release = acquireLock(root)
  try {
    const file = eventFile(root, id)
    if (!existsSync(file)) throw operationalError(`事件不存在: ${id}`)

    const record = readRecordStrict(file)
    if (STATE_RANK[state] < STATE_RANK[record.state]) {
      throw usageError(`状态不能回退: ${record.state} → ${state}（只允许 ${INBOX_STATES.join(' < ')}）`)
    }

    const stateChanged = state !== record.state
    const noteText = note ? String(note) : ''
    const noteChanged = noteText !== '' && noteText !== String(record.note || '')
    if (!stateChanged && !noteChanged) return { ...record, file }

    const next = { ...record, state }
    if (noteText) next.note = noteText
    if (stateChanged) {
      if (state === 'seen') next.seenAt = now
      if (state === 'done') next.doneAt = now
    }
    next.updatedAt = Math.max(now, (Number.isFinite(record.updatedAt) ? record.updatedAt : 0) + 1)
    writeAtomic(file, next)
    return { ...next, file }
  } finally {
    release()
  }
}
