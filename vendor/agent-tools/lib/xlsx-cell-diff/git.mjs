import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function runGit(cwd, args, allowFail = false) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'buffer',
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  })
  if (result.error) {
    throw new Error(`git ${args.join(' ')} failed: ${result.error.message}`)
  }
  if (result.status !== 0 && !allowFail) {
    const err = (result.stderr ?? Buffer.alloc(0)).toString('utf8').trim()
    throw new Error(err || `git ${args.join(' ')} exited ${result.status}`)
  }
  return result
}

export function findGitRoot(start) {
  let dir = resolve(start)
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

export function gitShow(root, spec) {
  const result = runGit(root, ['show', spec], true)
  if (result.status !== 0) {
    const err = (result.stderr ?? Buffer.alloc(0)).toString('utf8').trim()
    const missing = /exists on disk, but not in|does not exist|pathspec|bad revision|unknown revision|Not a valid object|fatal:/i.test(err)
    if (missing || result.status === 128) return null
    throw new Error(err || `git show ${spec} exited ${result.status}`)
  }
  return result.stdout
}

function splitZ(buf) {
  if (!buf || !buf.length) return []
  return buf.toString('utf8').split('\0').filter(Boolean)
}

function isXlsx(name) {
  return name.toLowerCase().endsWith('.xlsx')
}

export function gitChangedXlsx(root, range, sourceDir) {
  const args = ['diff', '--name-only', '-z', '--diff-filter=ACDMRTUXB']
  if (range) args.push(range)
  args.push('--')
  args.push(sourceDir || '.')
  const result = runGit(root, args)
  return splitZ(result.stdout).filter(isXlsx)
}

export function listUntrackedXlsx(root, sourceDir) {
  const dir = sourceDir || '.'
  const result = runGit(root, [
    'ls-files',
    '-z',
    '--others',
    '--exclude-standard',
    '--',
    dir,
  ])
  return splitZ(result.stdout).filter(isXlsx)
}
