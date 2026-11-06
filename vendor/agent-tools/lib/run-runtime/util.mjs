/**
 * run-runtime shared helpers: canonical paths, hashing, atomic writes and a
 * small argv parser. Provenance: path canonicalisation and workdir hashing are
 * adapted from skills/afk-run/scripts/afk-home.mjs (UID algorithm) and
 * skills/exec-review/scripts/workdir-session.mjs (hash). Independent of AFK.
 *
 * Node built-ins only.
 */

import { createHash, randomBytes } from 'node:crypto'
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Command-line error carrying an exit code. exit 2 = invalid input, 1 = operational. */
export class CliError extends Error {
  constructor(message, exitCode = 1, code = '') {
    super(message)
    this.name = 'CliError'
    this.exitCode = exitCode
    this.code = code
  }
}

/** Canonical absolute path: realpath when possible, forward slashes, upper-case drive. */
export function canonicalPath(input) {
  const abs = resolve(String(input))
  let real = abs
  try {
    real = realpathSync.native ? realpathSync.native(abs) : realpathSync(abs)
  } catch {
    real = abs
  }
  let out = real.replace(/\\/g, '/')
  out = out.replace(/^\/([A-Za-z]):/, (_, drive) => `${drive.toUpperCase()}:`)
  if (out.length > 3 && out.endsWith('/')) out = out.replace(/\/+$/, '')
  return out
}

/** Stable hash of a canonical workdir (sha256, first 16 hex chars). */
export function workdirHash(workdir) {
  return createHash('sha256').update(canonicalPath(workdir)).digest('hex').slice(0, 16)
}

/** Random ownership token. */
export function newToken() {
  return randomBytes(16).toString('hex')
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
}

/**
 * Canonical absolute target path for a file that may not exist yet. The parent
 * directory is realpath-resolved so junction/symlink aliases are detected.
 */
export function canonicalTargetPath(input) {
  const abs = resolve(String(input))
  let parent
  try {
    parent = realpathSync.native ? realpathSync.native(dirname(abs)) : realpathSync(dirname(abs))
  } catch {
    parent = dirname(abs)
  }
  return canonicalPath(join(canonicalPath(parent), basename(abs)))
}

/** True when `child` is `parent` or lies inside it (both canonical paths). */
export function isPathInside(child, parent) {
  const c = canonicalPath(child)
  const p = canonicalPath(parent)
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`)
}

/** Atomically replace a text file (write temp in the same dir, then rename). */
export function atomicWriteFile(file, content) {
  ensureDir(dirname(file))
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`
  const fd = openSync(tmp, 'w')
  try {
    writeFileSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
}

/** Atomically replace a JSON file. */
export function atomicWriteJson(file, value) {
  atomicWriteFile(file, `${JSON.stringify(value, null, 2)}\n`)
}

/** Remove a file if present; never throws on a missing file. */
export function removeIfExists(file) {
  try {
    rmSync(file, { force: true })
  } catch {
    /* best effort */
  }
}

export function exists(file) {
  return existsSync(file)
}

/** Read+parse JSON, throwing a visible CliError on missing/malformed input. */
export function readJsonStrict(file, label = 'JSON file') {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    throw new CliError(`${label} not readable: ${file} (${err.code || err.message})`, 2, 'READ_FAILED')
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    throw new CliError(`${label} is not valid JSON: ${file} (${err.message})`, 2, 'MALFORMED_JSON')
  }
}

/** Small blocking sleep, used for short cross-process contention windows. */
export function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

export function parseArgs(argv, spec = {}) {
  const boolean = spec.boolean || new Set()
  const positionals = []
  const flags = Object.create(null)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--') {
      positionals.push(...argv.slice(i + 1))
      break
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=')
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2)
      let value
      if (eq >= 0) {
        value = arg.slice(eq + 1)
      } else if (boolean.has(name) || name.startsWith('no-')) {
        value = true
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        value = argv[++i]
      } else {
        value = true
      }
      ;(flags[name] = flags[name] || []).push(value)
    } else {
      positionals.push(arg)
    }
  }
  return { positionals, flags }
}

/** Single value for a flag (last one wins). Returns undefined when absent. */
export function flag(flags, name) {
  const values = flags[name]
  return values && values.length ? values[values.length - 1] : undefined
}

/** All values for a repeatable flag. */
export function flagList(flags, name) {
  return flags[name] || []
}

/** Boolean flag: present and not explicitly `false`. */
export function boolFlag(flags, name) {
  const value = flag(flags, name)
  return value === true || value === 'true' || value === '1'
}

/** Direct-main guard that also works through a Windows directory junction. */
export function isDirectMain(metaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false
  let self
  try {
    self = realpathSync(fileURLToPath(metaUrl))
  } catch {
    self = resolve(fileURLToPath(metaUrl))
  }
  let arg
  try {
    arg = realpathSync(argv1)
  } catch {
    arg = resolve(argv1)
  }
  return self === arg
}

export function writeStdout(value) {
  process.stdout.write(typeof value === 'string' ? value : `${JSON.stringify(value)}\n`)
}
