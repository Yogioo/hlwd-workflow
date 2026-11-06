#!/usr/bin/env node
/**
 * requirement-store: durable requirement records under an explicit directory.
 *
 * Extracted from skills/afk-run/scripts/requirement.mjs. The original resolved
 * an AFK home, inferred the project from the working directory, and tied
 * session lookup to checkin. This version takes an explicit --dir and
 * projectKey, and only stores records: no wake-up, no checkin, no owner
 * inference.
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

/** A heartbeat newer than this is considered fresh. */
export const DEFAULT_HEARTBEAT_MS = 2 * 60 * 1000

const MAX_ID_LENGTH = 64

/** Per-store writer lock. Live owners are never preempted. */
const LOCK_NAME = '.write.lock'

/** Thrown for invalid arguments/records (exit 2) and operational failures (exit 1). */
export class RequirementStoreError extends Error {
  constructor(message, exitCode = 2) {
    super(message)
    this.name = 'RequirementStoreError'
    this.exitCode = exitCode
  }
}

function usageError(message) {
  return new RequirementStoreError(message, 2)
}

function operationalError(message) {
  return new RequirementStoreError(message, 1)
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

export function assertRequirementId(id) {
  const text = String(id || '')
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(text) ||
    text.includes('..') ||
    text.length > MAX_ID_LENGTH
  ) {
    throw usageError(`需求 id 非法: ${JSON.stringify(id)}（只允许字母数字与 _ . -，最长 ${MAX_ID_LENGTH}）`)
  }
  return text
}

function recordFile(root, id) {
  return join(root, `${assertRequirementId(id)}.json`)
}

function localStamp(ts) {
  const d = new Date(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return (
    String(d.getFullYear()) +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes())
  )
}

function salt() {
  return randomBytes(4).toString('hex')
}

function allocateId(root, now = Date.now(), attempts = 16) {
  for (let i = 0; i < attempts; i += 1) {
    const id = `req-${localStamp(now)}-${salt()}`
    if (!existsSync(join(root, `${id}.json`))) return id
  }
  throw operationalError(`连续 ${attempts} 次生成的需求 id 冲突，未创建: ${root}`)
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
      throw operationalError(`无法创建需求存储写锁 ${file}: ${err && err.message}`)
    }
    const held = readLock(file)
    if (held && isProcessAlive(held.pid)) {
      throw operationalError(`需求存储正被写入（锁 ${file}，pid ${held.pid}），请稍后重试`)
    }
    throw operationalError(`需求存储写锁 ${file} 已存在；停止所有写入进程后检查并清理遗留锁`)
  }
}

/** Monotonic updatedAt within a process: two writes in the same ms stay ordered. */
let lastStamp = 0

function nextUpdatedAt(now = Date.now()) {
  lastStamp = now > lastStamp ? now : lastStamp + 1
  return lastStamp
}

/** Normalize a (taskSource, id) pair. Two sources may reuse the same id. */
export function workItemKey(taskSource, id) {
  return `${String(taskSource || '').toLowerCase()}:${String(id)}`
}

function normalizeWorkItems(workItems, { required = false } = {}) {
  if (workItems === undefined || workItems === null) {
    if (required) throw usageError('至少需要一个 work item')
    return []
  }
  if (!Array.isArray(workItems)) throw usageError('workItems 必须是数组')
  return workItems.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw usageError('workItems 的每一项必须是 { taskSource, id }')
    }
    if (!item.taskSource || item.id === undefined || item.id === null) {
      throw usageError('workItems 的每一项都需要 taskSource 和 id')
    }
    return { taskSource: String(item.taskSource).toLowerCase(), id: String(item.id) }
  })
}

function assertRecordWorkItems(workItems, file) {
  if (!Array.isArray(workItems)) throw usageError(`需求记录损坏: ${file}（workItems 不是数组）`)
  for (const item of workItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw usageError(`需求记录损坏: ${file}（workItems 项不是对象）`)
    }
    if (typeof item.taskSource !== 'string' || !item.taskSource || typeof item.id !== 'string') {
      throw usageError(`需求记录损坏: ${file}（workItems 项需要字符串 taskSource 与 id）`)
    }
  }
  return workItems
}

function assertRecordTimestamp(record, key, file) {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw usageError(`需求记录损坏: ${file}（${key} 非法）`)
  }
}

function readRecordStrict(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    throw operationalError(`无法读取需求记录 ${file}: ${err.message}`)
  }
  let record
  try {
    record = JSON.parse(text)
  } catch (err) {
    throw usageError(`需求记录损坏: ${file}（${err.message}）`)
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw usageError(`需求记录损坏: ${file}（不是 JSON 对象）`)
  }
  if (typeof record.id !== 'string' || !record.id) {
    throw usageError(`需求记录损坏: ${file}（缺少 id）`)
  }
  const name = basename(file)
  if (name.endsWith('.json') && record.id !== name.slice(0, -'.json'.length)) {
    throw usageError(`需求记录损坏: ${file}（id 与文件名不一致）`)
  }
  for (const key of ['title', 'workdir', 'projectKey', 'runner', 'sessionRef']) {
    if (record[key] !== undefined && typeof record[key] !== 'string') {
      throw usageError(`需求记录损坏: ${file}（${key} 不是字符串）`)
    }
  }
  assertRecordWorkItems(record.workItems === undefined ? [] : record.workItems, file)
  assertRecordTimestamp(record, 'createdAt', file)
  assertRecordTimestamp(record, 'updatedAt', file)
  if (record.heartbeatAt !== undefined) assertRecordTimestamp(record, 'heartbeatAt', file)
  if (record.closedAt !== undefined && record.closedAt !== null) {
    assertRecordTimestamp(record, 'closedAt', file)
  }
  return record
}

function scanRecords(root) {
  const items = []
  const invalid = []
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      if (!name.endsWith('.json')) continue
      const file = join(root, name)
      try {
        const record = readRecordStrict(file)
        if (record.id !== name.slice(0, -'.json'.length)) throw new Error('文件名与 id 不一致')
        items.push(record)
      } catch (err) {
        invalid.push({ file, error: err.message })
      }
    }
  }
  return { items, invalid }
}

/** Read every requirement, but reject the whole store if any record is corrupt. */
function readAllStrict(root) {
  const { items, invalid } = scanRecords(root)
  if (invalid.length) {
    throw usageError(`需求记录损坏，无法安全判定归属: ${invalid[0].file}（${invalid[0].error}）`)
  }
  return items
}

function dedupeWorkItems(items) {
  const merged = []
  const seen = new Set()
  for (const item of items) {
    const key = workItemKey(item.taskSource, item.id)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(item)
  }
  return merged
}

/** Reject ownership over partial data: a corrupt record is an error, not a skip. */
function assertOwnershipFree(root, requesterId, items) {
  const owners = new Map()
  for (const record of readAllStrict(root)) {
    if (record.id === requesterId) continue
    for (const item of record.workItems || []) {
      const key = workItemKey(item.taskSource, item.id)
      if (!owners.has(key)) owners.set(key, record.id)
    }
  }
  const conflicts = items
    .map((item) => ({ item, owner: owners.get(workItemKey(item.taskSource, item.id)) }))
    .filter((entry) => entry.owner)
    .map((entry) => `${entry.item.taskSource}:${entry.item.id} (${entry.owner})`)
  if (conflicts.length) {
    throw usageError(`work item 已被其他需求认领: ${conflicts.join(', ')}（如确需共享请加 --allow-shared）`)
  }
}

/**
 * Create a requirement. An explicit id that already exists is an error and
 * never overwrites. projectKey is caller-supplied; it is not inferred.
 * Initial work items obey the same ownership rule as `link`; pass
 * `allowShared: true` to opt out explicitly.
 */
export function createRequirement(input = {}, { dir, now = Date.now(), allowShared = false } = {}) {
  const root = assertDir(dir)
  assertTimestamp(now, 'now')
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw usageError('需求必须是 JSON 对象')
  }
  const initialWorkItems = dedupeWorkItems(normalizeWorkItems(input.workItems))
  const requestedId = input.id ? assertRequirementId(input.id) : null

  const release = acquireLock(root)
  try {
    const id = requestedId || allocateId(root, now)
    const file = recordFile(root, id)
    if (existsSync(file)) throw usageError(`需求已存在: ${id}`)
    if (initialWorkItems.length && !allowShared) assertOwnershipFree(root, id, initialWorkItems)

    const record = {
      id,
      title: String(input.title || ''),
      workdir: String(input.workdir || ''),
      projectKey: String(input.projectKey || ''),
      runner: String(input.runner || ''),
      sessionRef: String(input.sessionRef || ''),
      workItems: initialWorkItems,
      createdAt: now,
      updatedAt: nextUpdatedAt(now),
      heartbeatAt: now,
      closedAt: null,
    }
    writeAtomic(file, record)
    return { ...record, file }
  } finally {
    release()
  }
}

/** Read one requirement. Missing returns null; a corrupt record throws. */
export function getRequirement(id, { dir } = {}) {
  const root = assertDir(dir)
  const file = recordFile(root, id)
  if (!existsSync(file)) return null
  const record = readRecordStrict(file)
  if (record.id !== assertRequirementId(id)) throw usageError(`需求记录损坏: ${file}（id 不一致）`)
  return { ...record, file }
}

/**
 * List requirements, oldest first. Unreadable `.json` files go to `invalid`.
 * `state` is open|closed|all; `heartbeatFresh` filters by heartbeat age.
 */
export function listRequirements({
  dir,
  projectKey,
  state = 'all',
  heartbeatFresh,
  now = Date.now(),
  windowMs = DEFAULT_HEARTBEAT_MS,
} = {}) {
  const root = assertDir(dir)
  assertTimestamp(now, 'now')
  if (!['open', 'closed', 'all'].includes(state)) {
    throw usageError(`未知需求状态: ${state}（支持: open, closed, all）`)
  }
  const { items, invalid } = scanRecords(root)

  const filtered = items
    .filter((record) => !projectKey || record.projectKey === projectKey)
    .filter((record) => state === 'all' || (state === 'closed') === Boolean(record.closedAt))
    .filter((record) => {
      if (heartbeatFresh === undefined) return true
      return isHeartbeatFresh(record, { now, windowMs }) === Boolean(heartbeatFresh)
    })
  filtered.sort(
    (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || String(a.id).localeCompare(String(b.id)),
  )
  return { items: filtered.map((record) => ({ ...record, file: join(root, `${record.id}.json`) })), invalid }
}

function mutateLocked(id, root, updater, { now = Date.now() } = {}) {
  const file = recordFile(root, id)
  if (!existsSync(file)) return null
  const current = readRecordStrict(file)
  const next = updater(current)
  next.id = current.id
  next.createdAt = current.createdAt
  const floor = (Number.isFinite(current.updatedAt) ? current.updatedAt : 0) + 1
  next.updatedAt = nextUpdatedAt(Math.max(now, floor))
  writeAtomic(file, next)
  return { ...next, file }
}

function mutate(id, options, updater) {
  const root = assertDir(options.dir)
  return withLock(root, () => mutateLocked(id, root, updater, options))
}

function withLock(root, fn) {
  const release = acquireLock(root)
  try {
    return fn()
  } finally {
    release()
  }
}

/** Link work items; duplicates are dropped. Ownership conflicts are explicit. */
export function linkWorkItems(id, workItems, { dir, allowShared = false } = {}) {
  const root = assertDir(dir)
  const adding = normalizeWorkItems(workItems, { required: true })
  return withLock(root, () => {
    const file = recordFile(root, id)
    if (!existsSync(file)) return null
    if (!allowShared) assertOwnershipFree(root, id, adding)
    return mutateLocked(id, root, (current) => {
      const merged = [...(current.workItems || [])]
      const seen = new Set(merged.map((item) => workItemKey(item.taskSource, item.id)))
      for (const item of adding) {
        const key = workItemKey(item.taskSource, item.id)
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(item)
      }
      return { ...current, workItems: merged }
    })
  })
}

/** Set the opaque session reference and/or runner. Does not stamp heartbeat. */
export function setSession(id, { dir, runner, sessionRef } = {}) {
  return mutate(id, { dir }, (current) => ({
    ...current,
    runner: runner === undefined ? current.runner : String(runner),
    sessionRef: sessionRef === undefined ? current.sessionRef : String(sessionRef),
  }))
}

/** Stamp the heartbeat without touching any other field. */
export function heartbeat(id, { dir, at = Date.now() } = {}) {
  assertTimestamp(at, 'heartbeat.at')
  return mutate(id, { dir }, (current) => ({ ...current, heartbeatAt: at }))
}

/** Close the local record only. Repeated closes keep the first timestamp. */
export function closeRequirement(id, { dir, at = Date.now() } = {}) {
  assertTimestamp(at, 'close.at')
  return mutate(id, { dir }, (current) => ({ ...current, closedAt: current.closedAt || at }))
}

export function isHeartbeatFresh(record, { now = Date.now(), windowMs = DEFAULT_HEARTBEAT_MS } = {}) {
  if (!record || !record.heartbeatAt) return false
  return now - record.heartbeatAt < windowMs
}

/** Every requirement that links (taskSource, id). Order is by updatedAt desc. */
export function findRequirementsByWorkItem({ dir, taskSource, id } = {}) {
  if (!taskSource || id === undefined || id === null) {
    throw usageError('where 需要 taskSource 与 id')
  }
  const key = workItemKey(taskSource, id)
  const root = assertDir(dir)
  return readAllStrict(root)
    .filter((record) => (record.workItems || []).some((item) => workItemKey(item.taskSource, item.id) === key))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.id).localeCompare(String(b.id)))
}

/**
 * Resolve a work item's owner. `ambiguous` is true when more than one
 * requirement claims it; no owner is chosen automatically.
 * `none` is true when nothing matches.
 */
export function whereWorkItem({ dir, taskSource, id } = {}) {
  const matches = findRequirementsByWorkItem({ dir, taskSource, id })
  return {
    taskSource: String(taskSource),
    id: String(id),
    ambiguous: matches.length > 1,
    none: matches.length === 0,
    matches,
  }
}

/** All requirements registered with a session reference, newest first. */
export function findRequirementsBySession({ dir, sessionRef, runner = '' } = {}) {
  const ref = String(sessionRef || '')
  if (!ref) return []
  return listRequirements({ dir }).items
    .filter(
      (record) =>
        String(record.sessionRef || '') === ref && (!runner || !record.runner || record.runner === runner),
    )
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || String(b.id).localeCompare(String(a.id)))
}

/** The one newest requirement for a session, or null. */
export function findRequirementBySession(options = {}) {
  return findRequirementsBySession(options)[0] || null
}
