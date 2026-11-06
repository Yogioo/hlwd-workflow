/**
 * Git baseline checkpoint and explicit restore.
 *
 * `createCheckpoint` requires an existing Git worktree with a clean status and at
 * least one commit. It records the canonical root, common repository identity
 * (commonDir + repoHash), HEAD and ownership in an explicit state file that must
 * live outside the target worktree and must not already exist. It never runs
 * `git init`.
 *
 * `restoreCheckpoint` only restores to the recorded HEAD when the current
 * canonical root, common repository identity and HEAD still match, so concurrent
 * commits are never wiped. It resets tracked files; untracked removal
 * (`git clean -fd`) happens only when the caller explicitly asks for it.
 * Before any reset it refuses when an untracked or ignored path obstructs a
 * tracked path, because `git reset --hard` would delete that path regardless of
 * caller exclusions or ignore rules.
 *
 * Git is always run with an isolated environment (GIT_DIR/GIT_WORK_TREE/
 * GIT_INDEX_FILE/GIT_COMMON_DIR removed) so inherited Git state can never
 * redirect a destructive command.
 *
 * Rollback scope: tracked file contents inside the worktree, plus untracked
 * files when requested. It does NOT restore ignored files, files outside the
 * worktree, Git history, or any external side effect.
 *
 * Provenance: adapted from skills/afk-run/scripts/git.mjs (clean check, HEAD,
 * reset/clean with exclusions). Independent of AFK.
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { hostname } from 'node:os'
import { resolve } from 'node:path'

import {
  CliError,
  atomicWriteJson,
  canonicalPath,
  canonicalTargetPath,
  exists,
  isPathInside,
  workdirHash,
} from './util.mjs'

const ISOLATED_ENV_KEYS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR']

/** Environment with inherited Git redirection variables removed. */
export function gitEnv(base = process.env) {
  const env = { ...base }
  for (const key of ISOLATED_ENV_KEYS) delete env[key]
  return env
}

function gitRunRaw(workdir, args) {
  return execFileSync('git', ['-C', workdir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    env: gitEnv(),
  })
}

export function gitRun(workdir, args) {
  return gitRunRaw(workdir, args).trim()
}

function gitTry(workdir, args) {
  try {
    return { ok: true, value: gitRun(workdir, args) }
  } catch (err) {
    return { ok: false, error: String(err.stderr || err.message).trim() }
  }
}

/** Resolve root/HEAD/common identity for a real, non-bare Git worktree with a commit. */
export function requireGitRepo(workdir) {
  const inside = gitTry(workdir, ['rev-parse', '--is-inside-work-tree'])
  if (!inside.ok || inside.value !== 'true') {
    throw new CliError(`not a Git worktree: ${workdir}`, 1, 'NOT_A_REPO')
  }
  const root = gitRun(workdir, ['rev-parse', '--show-toplevel'])
  const headProbe = gitTry(workdir, ['rev-parse', 'HEAD'])
  if (!headProbe.ok) {
    throw new CliError(`Git repository has no commit (no HEAD): ${workdir}`, 1, 'NO_HEAD')
  }
  const common = gitTry(workdir, ['rev-parse', '--git-common-dir'])
  const gitDir = gitRun(workdir, ['rev-parse', '--absolute-git-dir'])
  let commonDir = null
  if (common.ok) {
    const raw = common.value
    const abs = /^([A-Za-z]:[\\/]|\/)/.test(raw) ? raw : resolve(workdir, raw)
    commonDir = canonicalPath(abs)
  }
  const repo = {
    root: canonicalPath(root),
    head: headProbe.value,
    gitDir: canonicalPath(gitDir),
    commonDir,
  }
  repo.repoHash = workdirHash(commonDir || repo.root)
  return repo
}

export function isWorktreeClean(workdir) {
  return gitRun(workdir, ['status', '--porcelain']) === ''
}

function invalidState(stateFile, detail) {
  return new CliError(`checkpoint state is not a valid run-runtime checkpoint: ${stateFile} (${detail})`, 2, 'STATE_INVALID')
}

function readState(stateFile) {
  if (!exists(stateFile)) {
    throw new CliError(`checkpoint state not found: ${stateFile}`, 2, 'STATE_MISSING')
  }
  let parsed
  try {
    parsed = JSON.parse(readFileSync(stateFile, 'utf8'))
  } catch (err) {
    throw new CliError(`checkpoint state is not valid JSON: ${stateFile} (${err.message})`, 2, 'STATE_MALFORMED')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalidState(stateFile, 'not an object')
  if (parsed.tool !== 'run-runtime') throw invalidState(stateFile, 'wrong tool')
  if (parsed.version !== 1) throw invalidState(stateFile, 'unsupported version')
  if (typeof parsed.root !== 'string' || parsed.root === '') throw invalidState(stateFile, 'missing root')
  if (typeof parsed.head !== 'string' || parsed.head === '') throw invalidState(stateFile, 'missing head')
  if (typeof parsed.commonDir !== 'string' || parsed.commonDir === '') throw invalidState(stateFile, 'missing commonDir')
  if (typeof parsed.repoHash !== 'string' || parsed.repoHash === '') throw invalidState(stateFile, 'missing repoHash')
  if (!parsed.owner || typeof parsed.owner !== 'object') throw invalidState(stateFile, 'missing owner')
  if (parsed.excludePaths != null && !Array.isArray(parsed.excludePaths)) {
    throw invalidState(stateFile, 'excludePaths must be an array')
  }
  return parsed
}

/**
 * Record a clean baseline.
 * @param {{workdir:string, stateFile:string, excludePaths?:string[]}} opts
 */
export function createCheckpoint(opts) {
  if (!opts.stateFile) throw new CliError('createCheckpoint requires a stateFile', 2, 'MISSING_ARG')
  const repo = requireGitRepo(opts.workdir)
  if (existsSync(opts.stateFile)) {
    throw new CliError(`checkpoint state already exists; refusing to overwrite: ${opts.stateFile}`, 1, 'STATE_EXISTS')
  }
  const stateTarget = canonicalTargetPath(opts.stateFile)
  if (isPathInside(stateTarget, repo.root)) {
    throw new CliError(
      `checkpoint state must live outside the target worktree: ${opts.stateFile}`,
      1,
      'STATE_INSIDE_WORKTREE',
    )
  }
  if (!isWorktreeClean(repo.root)) {
    throw new CliError(`worktree is not clean; refusing to checkpoint: ${repo.root}`, 1, 'DIRTY_WORKTREE')
  }
  const createdAt = new Date().toISOString()
  const record = {
    tool: 'run-runtime',
    version: 1,
    root: repo.root,
    commonDir: repo.commonDir,
    repoHash: repo.repoHash,
    head: repo.head,
    excludePaths: (opts.excludePaths || []).map(String),
    owner: { pid: process.pid, host: hostname(), createdAt },
    createdAt,
  }
  atomicWriteJson(opts.stateFile, record)
  return {
    created: true,
    stateFile: resolve(opts.stateFile),
    root: record.root,
    head: record.head,
    repoHash: record.repoHash,
    excludePaths: record.excludePaths,
  }
}

/** Read a checkpoint and compare it with the current repository. */
export function checkpointStatus(opts) {
  const state = readState(opts.stateFile)
  const result = { stateFile: opts.stateFile, state, matches: null }
  const workdir = opts.workdir || state.root
  const repoProbe = gitTry(workdir, ['rev-parse', '--show-toplevel'])
  if (!repoProbe.ok) {
    result.matches = {
      isRepo: false,
      rootMatches: false,
      repoMatches: false,
      headMatches: false,
      clean: false,
    }
    return result
  }
  const root = canonicalPath(repoProbe.value)
  const headProbe = gitTry(workdir, ['rev-parse', 'HEAD'])
  const commonProbe = gitTry(workdir, ['rev-parse', '--git-common-dir'])
  let commonDir = null
  if (commonProbe.ok) {
    const raw = commonProbe.value
    const abs = /^([A-Za-z]:[\\/]|\/)/.test(raw) ? raw : resolve(workdir, raw)
    commonDir = canonicalPath(abs)
  }
  const repoHash = workdirHash(commonDir || root)
  result.matches = {
    isRepo: true,
    rootMatches: root === state.root,
    repoMatches: commonDir === state.commonDir && repoHash === state.repoHash,
    headMatches: headProbe.ok && headProbe.value === state.head,
    currentRoot: root,
    currentHead: headProbe.ok ? headProbe.value : null,
    currentRepoHash: repoHash,
    clean: isWorktreeClean(root),
  }
  return result
}

function nulList(workdir, args) {
  return gitRunRaw(workdir, args).split('\0').filter((entry) => entry !== '')
}

/**
 * Untracked or ignored worktree paths that lie on a path tracked by `head`.
 * `git reset --hard` would delete these even without `--clean-untracked`.
 */
export function findResetObstructions(workdir, head) {
  const tracked = nulList(workdir, ['ls-tree', '-r', '--name-only', '-z', head])
  const trackedSet = new Set(tracked)
  const trackedDirs = new Set()
  for (const path of tracked) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) trackedDirs.add(parts.slice(0, i).join('/'))
  }
  const candidates = new Set([
    ...nulList(workdir, ['ls-files', '--others', '--exclude-standard', '-z']),
    ...nulList(workdir, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']),
  ])
  const obstructions = new Set()
  for (const candidate of candidates) {
    if (trackedSet.has(candidate) || trackedDirs.has(candidate)) {
      obstructions.add(candidate)
      continue
    }
    let prefix = ''
    const parts = candidate.split('/')
    for (let i = 0; i < parts.length - 1; i++) {
      prefix = prefix ? `${prefix}/${parts[i]}` : parts[i]
      if (trackedSet.has(prefix)) {
        obstructions.add(candidate)
        break
      }
    }
  }
  return [...obstructions].sort()
}

/**
 * Restore to the recorded HEAD. Refuses root/HEAD/repository mismatch and
 * untracked obstructions.
 * @param {{workdir?:string, stateFile:string, cleanUntracked?:boolean,
 *   excludePaths?:string[]}} opts
 */
export function restoreCheckpoint(opts) {
  const state = readState(opts.stateFile)
  const workdir = opts.workdir || state.root
  const repo = requireGitRepo(workdir)
  if (repo.root !== state.root) {
    throw new CliError(`checkpoint root mismatch: state=${state.root} current=${repo.root}`, 1, 'ROOT_MISMATCH')
  }
  if (repo.commonDir !== state.commonDir || repo.repoHash !== state.repoHash) {
    throw new CliError(
      `checkpoint repository mismatch: state=${state.repoHash} current=${repo.repoHash}`,
      1,
      'REPO_MISMATCH',
    )
  }
  if (repo.head !== state.head) {
    throw new CliError(
      `current HEAD ${repo.head} != checkpoint HEAD ${state.head}; refusing to wipe concurrent commits`,
      1,
      'HEAD_MISMATCH',
    )
  }
  const obstructions = findResetObstructions(repo.root, state.head)
  if (obstructions.length) {
    throw new CliError(
      `refusing restore: untracked/ignored paths obstruct tracked paths and would be deleted by reset: ${obstructions.join(', ')}`,
      1,
      'OBSTRUCTED',
    )
  }
  gitRun(repo.root, ['reset', '--hard', state.head])
  const excludes = [...new Set([...(state.excludePaths || []), ...(opts.excludePaths || [])].map(String))]
  let untrackedCleaned = false
  if (opts.cleanUntracked) {
    const args = ['clean', '-fd', '--', '.']
    for (const p of excludes) args.push(`:(exclude)${p}`)
    gitRun(repo.root, args)
    untrackedCleaned = true
  }
  return {
    restored: true,
    root: repo.root,
    head: repo.head,
    untrackedCleaned,
    excludePaths: excludes,
    rollbackCovers: 'tracked file contents in the worktree' + (untrackedCleaned ? ' plus untracked files' : ''),
    rollbackExcludes: 'ignored files, paths outside the worktree, Git history, external side effects',
  }
}
