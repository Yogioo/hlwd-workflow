#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { captureWorkspace, diff, resolveSkip } from '../../lib/workspace-diff.mjs'

const USAGE = `workspace-diff - compare directory contents before and after a task

  snapshot --workdir <directory> --out <new.json> [--mode auto|git|walk] [--skip <name> ...]
  compare --before <before.json> --after <after.json>

Snapshot files must be outside the captured directory, in an existing directory.
--skip adds directory names to .git/.hg/.svn; tracked Git files remain included.
Git mode compares Git-normalized contents; walk mode compares raw file bytes.
Snapshots compare only when root, actual mode and skip names match.
This records content fingerprints, not restorable backups or task acceptance.
Exit: 0 success (including differences), 1 I/O or capture error, 2 invalid input.
`

function invalid(message) {
  const error = new Error(message)
  error.exitCode = 2
  throw error
}

function validSkip(name) {
  return typeof name === 'string' && name.trim() === name && name.length > 0 &&
    name !== '.' && name !== '..' && !/[\\/\0]/.test(name)
}

function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true }
  const [command, ...rest] = argv
  const allowed = command === 'snapshot'
    ? new Set(['--workdir', '--out', '--mode', '--skip'])
    : command === 'compare' ? new Set(['--before', '--after']) : null
  if (!allowed) invalid('Expected snapshot or compare; use --help')
  const options = { command, skip: [] }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (!allowed.has(flag)) invalid(`Unknown option: ${flag}`)
    const value = rest[++i]
    if (!value || value.startsWith('--')) invalid(`Missing value for ${flag}`)
    const key = flag.slice(2)
    if (key === 'skip') {
      if (!validSkip(value)) invalid('--skip requires one directory name')
      options.skip.push(value)
    } else {
      if (Object.hasOwn(options, key)) invalid(`Duplicate option: ${flag}`)
      options[key] = value
    }
  }
  const required = command === 'snapshot' ? ['workdir', 'out'] : ['before', 'after']
  for (const key of required) if (!options[key]) invalid(`Missing --${key}`)
  if (options.mode && !['auto', 'git', 'walk'].includes(options.mode)) invalid('Invalid --mode')
  return options
}

function pathKey(path) {
  const absolute = resolve(path)
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute
}

function inside(root, path) {
  const rel = relative(pathKey(root), pathKey(path))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}

function capture(options) {
  const root = realpathSync(options.workdir)
  if (!statSync(root).isDirectory()) throw new Error('Workdir must be a directory')
  const requestedOut = resolve(options.out)
  const snapshotFile = join(realpathSync(dirname(requestedOut)), basename(requestedOut))
  if (inside(root, snapshotFile)) invalid('Snapshot output must be outside the captured directory')
  try {
    lstatSync(snapshotFile)
    throw new Error(`Snapshot output already exists: ${snapshotFile}`)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  const skip = [...resolveSkip(options.skip)].sort()
  const result = captureWorkspace(root, { mode: options.mode || 'auto', skip })
  const snapshot = { version: 1, root, mode: result.mode, skip, files: result.files }
  writeFileSync(snapshotFile, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  return { status: 'captured', snapshotFile, mode: result.mode, fileCount: Object.keys(result.files).length }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function loadSnapshot(file) {
  const raw = readFileSync(file, 'utf8')
  let value
  try { value = JSON.parse(raw) } catch { invalid(`Invalid snapshot JSON: ${file}`) }
  if (!record(value) || value.version !== 1 || typeof value.root !== 'string' ||
      !isAbsolute(value.root) || normalize(value.root) !== resolve(value.root) || value.root.includes('\0') ||
      !['git', 'walk'].includes(value.mode) || !Array.isArray(value.skip) ||
      !value.skip.every(validSkip) || new Set(value.skip).size !== value.skip.length ||
      !['.git', '.hg', '.svn'].every((name) => value.skip.includes(name)) || !record(value.files)) {
    invalid(`Invalid snapshot format: ${file}`)
  }
  for (const [path, hash] of Object.entries(value.files)) {
    if (!path || /[\\\0]/.test(path) || isAbsolute(path) || /^[a-z]:/i.test(path) ||
        path.split('/').some((part) => !part || part === '.' || part === '..') ||
        typeof hash !== 'string' || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(hash)) {
      invalid(`Invalid snapshot file entry: ${file}`)
    }
  }
  return value
}

function compare(options) {
  const before = loadSnapshot(options.before)
  const after = loadSnapshot(options.after)
  if (pathKey(before.root) !== pathKey(after.root) || before.mode !== after.mode ||
      JSON.stringify([...before.skip].sort()) !== JSON.stringify([...after.skip].sort())) {
    invalid('Snapshots must use the same root, mode and skip names')
  }
  return { status: 'compared', ...diff(before.files, after.files) }
}

export function run(argv, io = {}) {
  const stdout = io.stdout || ((text) => process.stdout.write(text))
  const stderr = io.stderr || ((text) => process.stderr.write(text))
  try {
    const options = parseArgs(argv)
    if (options.help) stdout(USAGE)
    else stdout(`${JSON.stringify(options.command === 'snapshot' ? capture(options) : compare(options))}\n`)
    return 0
  } catch (error) {
    stderr(`${JSON.stringify({ status: 'error', error: error.message })}\n`)
    return error.exitCode || 1
  }
}

let invokedDirectly = false
try {
  invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
} catch { /* An importing host may use a non-file argv[1]. */ }
if (invokedDirectly) {
  process.exitCode = run(process.argv.slice(2))
}
