/**
 * Ownership-based local workdir lease.
 *
 * A lease lives in an explicit registry directory keyed by the canonical
 * workdir hash. Only the token owner may release it; there is no force
 * override. A live owner is never replaced automatically. Stale (dead owner)
 * and malformed records can only be cleared through the explicit
 * `recoverLease` / `lease recover` action, which also recovers a crashed
 * on-disk mutex without ever breaking a mutex whose owner is alive.
 *
 * This module never kills processes and never inspects ports.
 * Provenance: adapted from skills/exec-review/scripts/workdir-session.mjs and
 * skills/afk-watch/scripts/watch-state.mjs. Independent of AFK.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { CliError, atomicWriteJson, canonicalPath, ensureDir, newToken, sleepMs, workdirHash } from './util.mjs'

const LOCK_WAIT_MS = 3000
const LOCK_IN_PROGRESS_MS = 1000

export function leasePath(registryDir, workdir) {
  return join(canonicalPath(registryDir), `${workdirHash(workdir)}.json`)
}

/** Cross-platform liveness check for a PID (no signal delivery). */
export function isProcessAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${n}`, '/NH', '/FO', 'CSV'], {
        encoding: 'utf8',
        windowsHide: true,
      })
      for (const line of out.split(/\r?\n/)) {
        if (!line || /^INFO:/i.test(line)) continue
        const cols = line.match(/"([^"]*)"/g)
        if (cols && cols.length > 1 && Number(cols[1].replace(/"/g, '')) === n) return true
      }
      return false
    }
    process.kill(n, 0)
    return true
  } catch {
    return false
  }
}

/**
 * True when the recorded owner should be treated as live. A recorded owner on
 * another host is always considered live (conservative; never auto-stolen).
 */
export function ownerAlive(record) {
  if (!record || !Number.isInteger(record.pid) || record.pid <= 0) return false
  if (record.host && record.host !== hostname()) return true
  return isProcessAlive(record.pid)
}

/**
 * Validate a lease record. An invalid PID is NOT safely stale; the whole record
 * is malformed and may only be cleared by explicit recovery.
 */
export function validateLeaseRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return { valid: false, error: 'lease record is not an object' }
  }
  if (typeof record.token !== 'string' || record.token === '') {
    return { valid: false, error: 'lease record has no owner token' }
  }
  if (!Number.isInteger(record.pid) || record.pid <= 0) {
    return { valid: false, error: 'lease record has an invalid owner pid' }
  }
  if (typeof record.host !== 'string' || record.host === '') {
    return { valid: false, error: 'lease record has no owner host' }
  }
  if (typeof record.workdir !== 'string' || record.workdir === '') {
    return { valid: false, error: 'lease record has no workdir' }
  }
  return { valid: true, error: null }
}

function readRecord(file) {
  if (!existsSync(file)) return { ok: true, value: null }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    return { ok: false, error: `lease unreadable: ${err.message}` }
  }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (err) {
    return { ok: false, error: `lease malformed JSON: ${err.message}` }
  }
}

export function lockPathFor(registryDir) {
  return join(canonicalPath(registryDir), '.lease.lock')
}

function lockOwnerFile(lockDir) {
  return join(lockDir, 'owner.json')
}

function readLockOwner(lockDir) {
  try {
    const parsed = JSON.parse(readFileSync(lockOwnerFile(lockDir), 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

/**
 * Classify an existing mutex directory.
 * @returns {{present:boolean, stale:boolean, reason:string|null, owner:object|null}}
 */
export function lockStatus(lockDir) {
  if (!existsSync(lockDir)) return { present: false, stale: false, reason: 'absent', owner: null }
  const owner = readLockOwner(lockDir)
  if (!owner) {
    let ageMs = Infinity
    try {
      ageMs = Date.now() - statSync(lockDir).mtimeMs
    } catch {
      ageMs = Infinity
    }
    if (ageMs < LOCK_IN_PROGRESS_MS) return { present: true, stale: false, reason: 'in-progress', owner: null }
    return { present: true, stale: true, reason: 'lock owner record missing/malformed', owner: null }
  }
  if (typeof owner.host === 'string' && owner.host !== hostname()) {
    return { present: true, stale: false, reason: 'foreign-host', owner }
  }
  if (!Number.isInteger(owner.pid) || owner.pid <= 0) {
    return { present: true, stale: true, reason: 'lock owner pid invalid', owner }
  }
  if (isProcessAlive(owner.pid)) return { present: true, stale: false, reason: 'alive', owner }
  return { present: true, stale: true, reason: 'lock owner dead', owner }
}

/**
 * Explicitly break a stale mutex. Refuses (throws) when the recorded owner is
 * alive or on another host, so a live owner is never interrupted.
 */
export function breakStaleLock(lockDir) {
  const status = lockStatus(lockDir)
  if (!status.present) return { broken: false, reason: 'absent', owner: null }
  if (!status.stale) {
    throw new CliError(`lease mutex owner is ${status.reason}; refusing to break`, 1, 'LOCK_HELD')
  }
  rmSync(lockDir, { recursive: true, force: true })
  return { broken: true, reason: status.reason, owner: status.owner }
}

/** Best-effort stale-mutex recovery used before an explicit recover operation. */
export function recoverStaleLock(lockDir) {
  const status = lockStatus(lockDir)
  if (!status.present || !status.stale) return false
  rmSync(lockDir, { recursive: true, force: true })
  return true
}

function withLock(lockDir, fn) {
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      mkdirSync(lockDir)
      break
    } catch (err) {
      if (err.code !== 'EEXIST') throw err
      if (Date.now() > deadline) {
        const status = lockStatus(lockDir)
        if (status.stale) {
          throw new CliError('lease mutex is stale; run `lease recover` to clear it', 1, 'LOCK_STALE')
        }
        throw new CliError(`lease mutex busy: ${lockDir}`, 1, 'LOCK_BUSY')
      }
      sleepMs(25)
    }
  }
  atomicWriteJson(lockOwnerFile(lockDir), {
    pid: process.pid,
    host: hostname(),
    at: new Date().toISOString(),
  })
  try {
    return fn()
  } finally {
    try {
      rmSync(lockDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

function freshRecord({ workdir, token, pid, label }) {
  const now = new Date().toISOString()
  return {
    tool: 'run-runtime',
    workdir: canonicalPath(workdir),
    token,
    pid: Number(pid),
    host: hostname(),
    label: label || '',
    createdAt: now,
    updatedAt: now,
  }
}

/**
 * Acquire the lease for a workdir.
 * The programmatic API defaults the owner PID to the current process; the CLI
 * requires an explicit live `--pid` because the CLI process itself exits.
 * @param {{registryDir:string, workdir:string, pid?:number, label?:string,
 *   stealStale?:boolean, token?:string}} opts
 * @returns {{ok:true, record:object, file:string}|{ok:false, reason:string, holder?:object, error?:string}}
 */
export function acquireLease(opts) {
  const dir = canonicalPath(opts.registryDir)
  ensureDir(dir)
  const file = leasePath(dir, opts.workdir)
  return withLock(lockPathFor(dir), () => {
    const existing = readRecord(file)
    if (!existing.ok) {
      return { ok: false, reason: 'malformed', error: existing.error }
    }
    if (existing.value) {
      const validation = validateLeaseRecord(existing.value)
      if (!validation.valid) {
        return { ok: false, reason: 'malformed', error: validation.error }
      }
      if (ownerAlive(existing.value)) {
        return { ok: false, reason: 'held', holder: existing.value }
      }
      if (!opts.stealStale) {
        return { ok: false, reason: 'stale', holder: existing.value }
      }
    }
    const record = freshRecord({
      workdir: opts.workdir,
      token: opts.token || newToken(),
      pid: opts.pid || process.pid,
      label: opts.label,
    })
    atomicWriteJson(file, record)
    return { ok: true, record, file }
  })
}

/**
 * Read-only lease status.
 * @returns {{present:boolean, held:boolean, alive:boolean, stale:boolean,
 *   malformed?:boolean, error?:string, owner?:object, self?:boolean, file:string}}
 */
export function statusLease(opts) {
  const dir = canonicalPath(opts.registryDir)
  const file = leasePath(dir, opts.workdir)
  if (!existsSync(file)) {
    return { present: false, held: false, alive: false, stale: false, file }
  }
  const existing = readRecord(file)
  if (!existing.ok) {
    return { present: true, held: true, alive: false, stale: false, malformed: true, error: existing.error, file }
  }
  const owner = existing.value
  const validation = validateLeaseRecord(owner)
  if (!validation.valid) {
    return {
      present: true,
      held: false,
      alive: false,
      stale: false,
      malformed: true,
      error: validation.error,
      owner,
      file,
    }
  }
  const alive = ownerAlive(owner)
  return {
    present: true,
    held: alive,
    alive,
    stale: !alive,
    owner,
    self: Number(owner.pid) === Number(opts.pid || process.pid),
    file,
  }
}

/**
 * Release the lease. Always requires the matching owner token; there is no
 * force override, so a live owner can never be released by a non-owner.
 */
export function releaseLease(opts) {
  const dir = canonicalPath(opts.registryDir)
  const file = leasePath(dir, opts.workdir)
  return withLock(lockPathFor(dir), () => {
    const existing = readRecord(file)
    if (!existing.ok) throw new CliError(existing.error, 1, 'MALFORMED_LEASE')
    if (!existing.value) throw new CliError('no lease to release', 1, 'NO_LEASE')
    if (existing.value.token !== opts.token) {
      throw new CliError('owner token mismatch; refusing to release', 1, 'NOT_OWNER')
    }
    rmSync(file, { force: true })
    return { released: true, previous: existing.value, file }
  })
}

/**
 * Explicit stale/malformed recovery. Refuses while a live owner holds the
 * lease. Also clears a crashed (verifiably stale) mutex so recovery can run.
 */
export function recoverLease(opts) {
  const dir = canonicalPath(opts.registryDir)
  const file = leasePath(dir, opts.workdir)
  const lockDir = lockPathFor(dir)
  recoverStaleLock(lockDir)
  return withLock(lockDir, () => {
    const existing = readRecord(file)
    if (!existing.ok) {
      rmSync(file, { force: true })
      return { recovered: true, previous: null, reason: 'malformed', file }
    }
    if (!existing.value) return { recovered: false, reason: 'absent', file }
    const validation = validateLeaseRecord(existing.value)
    if (!validation.valid) {
      rmSync(file, { force: true })
      return { recovered: true, previous: existing.value, reason: 'malformed', error: validation.error, file }
    }
    if (ownerAlive(existing.value)) {
      throw new CliError('lease is held by a live owner; refuse to recover', 1, 'LEASE_HELD')
    }
    rmSync(file, { force: true })
    return { recovered: true, previous: existing.value, reason: 'stale', file }
  })
}
