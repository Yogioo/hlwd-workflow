/**
 * Layered JSON configuration and project identity.
 *
 * `mergeConfigFiles` merges caller-supplied JSON files in order (later layers
 * win; objects merge deeply, arrays and scalars replace). There are no implicit
 * sections, no home lookup and no fixed AFK keys. Malformed or unreadable files
 * are reported, never treated as empty.
 *
 * `projectIdentity` returns the canonical workdir hash and, for Git, clearly
 * distinguishes a linked worktree path from the shared common repository.
 *
 * Provenance: generalised from skills/afk-run/scripts/afk-home.mjs. Independent
 * of AFK; it never loads ~/.afk or AFK sections.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

import { canonicalPath, workdirHash } from './util.mjs'

const SECRET_KEY = /(secret|token|password|passwd|api[_-]?key|credential|authorization|auth)/i

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Recursive merge: arrays and scalars are replaced by the later value. */
export function deepMerge(...objs) {
  const out = {}
  for (const obj of objs) {
    if (!isPlainObject(obj)) continue
    for (const [key, value] of Object.entries(obj)) {
      if (UNSAFE_KEYS.has(key)) continue
      out[key] = isPlainObject(value) && isPlainObject(out[key]) ? deepMerge(out[key], value) : value
    }
  }
  return out
}

/** Replace secret-looking values recursively. */
export function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets)
  if (!isPlainObject(value)) return value
  const out = {}
  for (const [key, val] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) continue
    if (SECRET_KEY.test(key) && val != null) {
      out[key] = '[redacted]'
    } else {
      out[key] = redactSecrets(val)
    }
  }
  return out
}

/** Load each file independently so all problems stay visible at once. */
export function loadConfigLayers(files) {
  return files.map((file) => {
    const path = resolve(String(file))
    if (!existsSync(path)) {
      return { file: path, ok: false, error: 'file does not exist' }
    }
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'))
      if (!isPlainObject(value)) {
        return { file: path, ok: false, error: 'top-level JSON value is not an object' }
      }
      return { file: path, ok: true, value }
    } catch (err) {
      return { file: path, ok: false, error: `not valid JSON: ${err.message}` }
    }
  })
}

/**
 * @returns {{ok:boolean, value:object, layers:object[], malformed:{file:string,error:string}[]}}
 */
export function mergeConfigFiles(files) {
  const layers = loadConfigLayers(files)
  const malformed = layers.filter((l) => !l.ok).map((l) => ({ file: l.file, error: l.error }))
  const value = deepMerge(...layers.filter((l) => l.ok).map((l) => l.value))
  return { ok: malformed.length === 0, value, layers, malformed }
}

function git(workdir, args) {
  return execFileSync('git', ['-C', workdir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim()
}

function tryGit(workdir, args) {
  try {
    return { ok: true, value: git(workdir, args) }
  } catch (err) {
    return { ok: false, error: err.message, value: null }
  }
}

/**
 * Canonical project identity.
 * @param {string} workdir
 * @returns {{workdir:string, workdirHash:string, git:null|object}}
 */
export function projectIdentity(workdir) {
  const canonical = canonicalPath(workdir)
  const identity = { workdir: canonical, workdirHash: workdirHash(canonical), git: null }
  const probe = tryGit(canonical, ['rev-parse', '--is-inside-work-tree'])
  if (!probe.ok || probe.value !== 'true') return identity

  const root = tryGit(canonical, ['rev-parse', '--show-toplevel'])
  const gitDirRaw = tryGit(canonical, ['rev-parse', '--absolute-git-dir'])
  const commonRaw = tryGit(canonical, ['rev-parse', '--git-common-dir'])
  let head = null
  const headProbe = tryGit(canonical, ['rev-parse', 'HEAD'])
  if (headProbe.ok) head = headProbe.value
  const gitDir = gitDirRaw.ok ? canonicalPath(gitDirRaw.value) : null
  let commonDir = null
  if (commonRaw.ok) {
    const raw = commonRaw.value
    commonDir = canonicalPath(isAbsolute(raw) ? raw : resolve(canonical, raw))
  }
  identity.git = {
    isRepo: true,
    worktreeRoot: root.ok ? canonicalPath(root.value) : null,
    gitDir,
    commonDir,
    isLinkedWorktree: Boolean(gitDir && commonDir && gitDir !== commonDir),
    repoHash: commonDir ? workdirHash(commonDir) : null,
    head,
  }
  return identity
}
