import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { accessSync, constants, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

export const DEFAULT_SKIP = new Set(['.git', '.hg', '.svn'])

/** Skip entries are exact path segment names, not globs. */
export function resolveSkip(extra = []) {
  if (!Array.isArray(extra) && !(extra instanceof Set)) throw new TypeError('skip must be an array or Set of names')
  const skip = new Set(DEFAULT_SKIP)
  for (const name of extra) {
    if (typeof name !== 'string') throw new TypeError('skip entries must be strings')
    if (name.trim()) skip.add(name.trim())
  }
  return skip
}

export function blobFingerprint(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('blobFingerprint requires a Buffer')
  return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex')
}

function git(root, args, input) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' }
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']) delete env[key]
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', ...args], {
    cwd: root, env, input, encoding: 'utf8', windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 512 * 1024 * 1024,
  })
  if (result.error) throw result.error
  if (result.status !== 0 || (args[0] === 'status' && result.stderr.trim())) {
    const error = new Error(`Git ${args[0]} failed: ${result.stderr.trim() || result.signal || result.status}`)
    Object.assign(error, { status: result.status, stderr: result.stderr })
    throw error
  }
  return result.stdout
}

function isGit(root) {
  try {
    if (git(root, ['rev-parse', '--is-inside-work-tree']).trim() !== 'true') {
      throw new Error(`Unsupported Git directory outside a work tree: ${root}`)
    }
    return true
  } catch (error) {
    if (error.status === 128 && /fatal: not a git repository/.test(String(error.stderr))) return false
    throw error
  }
}

function fingerprint(path, info) {
  if (info.isSymbolicLink()) return blobFingerprint(readlinkSync(path, { encoding: 'buffer' }))
  if (info.isFile()) return blobFingerprint(readFileSync(path))
  throw new Error(`Unsupported file type: ${path}`)
}

function walk(root, skip, files, relative = '') {
  const path = join(root, relative)
  for (const name of readdirSync(path)) {
    if (skip.has(name)) continue
    const rel = relative ? `${relative}/${name}` : name
    const full = join(root, rel)
    const info = lstatSync(full)
    if (info.isDirectory()) walk(root, skip, files, rel)
    else files[rel] = fingerprint(full, info)
  }
}

function rejectFilters(root, paths) {
  if (!paths.size) return
  const attributes = git(root, ['check-attr', '-z', '--stdin', 'filter'], [...paths].join('\0') + '\0').split('\0')
  for (let i = 0; i < attributes.length - 1; i += 3) {
    if (!['unspecified', 'unset'].includes(attributes[i + 2])) {
      throw new Error(`Unsupported Git clean filter: ${attributes[i]}`)
    }
  }
}

function gitSnapshot(root, skip) {
  if (git(root, ['rev-parse', '--show-object-format']).trim() !== 'sha1') {
    throw new Error('Unsupported Git object format: expected sha1')
  }
  const prefix = git(root, ['rev-parse', '--show-prefix']).replace(/\r?\n$/, '')
  const repoRoot = git(root, ['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '')
  const localize = (path) => path.startsWith(prefix) ? path.slice(prefix.length) : null
  const files = Object.create(null)
  const tracked = new Set()
  const repositoryPaths = new Set()
  const pending = new Map()
  for (const entry of git(root, ['ls-files', '-v', '--stage', '-z', '--full-name', '--', ':/']).split('\0')) {
    if (!entry) continue
    const match = /^(\S) (\d+) ([a-f0-9]{40}) (\d)\t([\s\S]+)$/.exec(entry)
    if (!match) throw new Error('Unsupported Git index entry')
    const [, flag, mode, hash, stage, path] = match
    repositoryPaths.add(path)
    const rel = localize(path)
    if (!rel) continue
    if (flag !== 'H' || stage !== '0' || !['100644', '100755', '120000'].includes(mode)) {
      throw new Error(`Unsupported Git index state (conflict, submodule, sparse or assume-unchanged): ${rel}`)
    }
    tracked.add(rel)
    files[rel] = hash
  }
  // Status can run clean filters while refreshing any part of the repository index.
  rejectFilters(repoRoot, repositoryPaths)
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=none'])
  for (const entry of status.split('\0')) {
    if (!entry) continue
    if (entry.length < 4 || entry[2] !== ' ') throw new Error('Unsupported Git status entry')
    const code = entry.slice(0, 2)
    const rel = localize(entry.slice(3))
    if (!rel) continue
    if (code !== '??') tracked.add(rel)
    pending.set(rel, (pending.get(rel) ?? '') + code)
  }
  for (const [rel, code] of pending) {
    if (!tracked.has(rel) && rel.split('/').some((name) => skip.has(name))) pending.delete(rel)
    else if (code.includes('U')) throw new Error(`Unsupported Git conflict: ${rel}`)
  }
  const paths = new Set([...tracked, ...pending.keys()])
  rejectFilters(root, new Set(pending.keys()))
  const checkedDirectories = new Set([root])
  function checkParents(path) {
    const parent = dirname(path)
    if (checkedDirectories.has(parent)) return
    checkParents(parent)
    if (!lstatSync(parent).isDirectory()) throw new Error(`Unsupported Git parent path: ${parent}`)
    accessSync(parent, constants.R_OK | constants.X_OK)
    checkedDirectories.add(parent)
  }
  for (const rel of paths) {
    const path = join(root, rel)
    const code = pending.get(rel)
    let info
    try {
      checkParents(path)
      info = lstatSync(path)
    } catch (error) {
      if (error.code !== 'ENOENT' || !code?.includes('D')) throw error
      delete files[rel]
      continue
    }
    if (info.isDirectory() && code?.includes('D')) {
      delete files[rel]
      continue
    }
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`Unsupported Git file type: ${rel}`)
    if (info.isFile()) accessSync(path, constants.R_OK)
    if (!code) continue
    // Inspect disk even for staged deletions: the same path may have been recreated.
    files[rel] = info.isSymbolicLink()
      ? fingerprint(path, info)
      : git(root, ['hash-object', '--stdin', `--path=${rel}`], readFileSync(path)).trim()
  }
  return files
}

/** Git uses canonical blob contents; walk hashes raw bytes. Neither records permissions. */
export function captureWorkspace(dir, { mode = 'auto', skip: extra = [] } = {}) {
  const started = performance.now()
  if (typeof dir !== 'string' || !dir.trim()) throw new TypeError('Workspace root must be a non-empty directory path')
  if (!['auto', 'git', 'walk'].includes(mode)) throw new TypeError(`Invalid workspace mode: ${mode}`)
  const root = resolve(dir)
  if (!statSync(root).isDirectory()) throw new Error(`Workspace root is not a directory: ${root}`)
  accessSync(root, constants.R_OK | constants.X_OK)
  const skip = resolveSkip(extra)
  let actualMode = 'walk'
  if (mode !== 'walk') {
    let inside = false
    try {
      inside = isGit(root)
    } catch (error) {
      if (mode !== 'auto' || error.code !== 'ENOENT') throw error
    }
    if (inside) actualMode = 'git'
    else if (mode === 'git') throw new Error(`Workspace root is not a Git work tree: ${root}`)
  }
  const files = actualMode === 'git' ? gitSnapshot(root, skip) : Object.create(null)
  if (actualMode === 'walk') walk(root, skip, files)
  return { mode: actualMode, files, elapsedMs: performance.now() - started }
}

export function diff(beforeFiles, afterFiles) {
  const changed = [], added = [], removed = []
  for (const path of Object.keys(beforeFiles)) {
    if (!Object.hasOwn(afterFiles, path)) removed.push(path)
    else if (beforeFiles[path] !== afterFiles[path]) changed.push(path)
  }
  for (const path of Object.keys(afterFiles)) {
    if (!Object.hasOwn(beforeFiles, path)) added.push(path)
  }
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() }
}
