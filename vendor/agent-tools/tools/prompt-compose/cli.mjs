#!/usr/bin/env node
/**
 * CLI for prompt-compose. Writes the composed prompt atomically, refuses to
 * clobber an existing output unless --force, and prints provenance JSON.
 */

import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { assemblePrompt, PromptComposeError } from '../../lib/prompt-compose.mjs'

const USAGE = `prompt-compose - assemble a prompt from an explicit JSON manifest

  --manifest <manifest.json>   required manifest path
  --out <prompt.md>            required composed prompt destination
  --provenance <out.json>      optional provenance copy
  --force                      allow replacing an existing --out / --provenance

Success prints one provenance JSON object on stdout.
Exit: 0 success, 1 I/O or missing source, 2 invalid manifest or unknown variable.
`

export function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true }
  const options = { force: false }
  const allowed = new Set(['--manifest', '--out', '--provenance'])
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--force') {
      if (options.force) throw new PromptComposeError('Duplicate option: --force')
      options.force = true
      continue
    }
    if (!allowed.has(flag)) throw new PromptComposeError(`Unknown option: ${flag}`)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new PromptComposeError(`Missing value for ${flag}`)
    const key = flag.slice(2)
    if (Object.prototype.hasOwnProperty.call(options, key)) throw new PromptComposeError(`Duplicate option: ${flag}`)
    options[key] = value
  }
  if (!options.manifest) throw new PromptComposeError('Missing --manifest')
  if (!options.out) throw new PromptComposeError('Missing --out')
  return options
}

function writeAtomic(file, text) {
  const absolute = resolve(file)
  const dir = dirname(absolute)
  const temp = join(dir, `.${basename(absolute)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`)
  try {
    writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' })
    renameSync(temp, absolute)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

function ensureWritable(file, force) {
  const absolute = resolve(file)
  try {
    lstatSync(absolute)
  } catch (error) {
    if (error.code === 'ENOENT') return
    throw error
  }
  if (!force) throw new PromptComposeError(`Refusing to overwrite existing file (use --force): ${absolute}`, 1)
}

function pathKey(path) {
  let canonical = resolve(path)
  const tail = []
  for (;;) {
    try {
      canonical = join(realpathSync(canonical), ...tail.reverse())
      break
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      const parent = dirname(canonical)
      if (parent === canonical) throw error
      tail.push(basename(canonical))
      canonical = parent
    }
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical
}

export function compose(options) {
  const manifestFile = resolve(options.manifest)
  let raw
  try {
    raw = readFileSync(manifestFile, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') throw new PromptComposeError(`Manifest not found: ${manifestFile}`, 1)
    throw error
  }
  let manifest
  try {
    manifest = JSON.parse(raw)
  } catch (error) {
    throw new PromptComposeError(`Invalid manifest JSON: ${error.message}`)
  }
  const { text, sources, variables } = assemblePrompt(manifest, { baseDir: dirname(manifestFile) })

  const outFile = resolve(options.out)
  const provenanceFile = options.provenance ? resolve(options.provenance) : ''
  if (provenanceFile && pathKey(provenanceFile) === pathKey(outFile)) {
    throw new PromptComposeError('--provenance must differ from --out', 2)
  }
  // Inputs are never valid outputs: overwriting the manifest or a source would
  // destroy the composition inputs, and --force must not permit it.
  const protectedPaths = new Map([[pathKey(manifestFile), 'input manifest']])
  for (const source of [manifest.base, ...(manifest.layers || []), manifest.suffix]) {
    if (source && typeof source === 'object' && source.file) {
      protectedPaths.set(pathKey(resolve(dirname(manifestFile), source.file)), 'input source')
    }
  }
  for (const source of sources) {
    if (source.path) protectedPaths.set(pathKey(source.path), 'input source')
  }
  for (const [file, role] of [[outFile, '--out'], [provenanceFile, '--provenance']]) {
    if (!file) continue
    const owner = protectedPaths.get(pathKey(file))
    if (owner) throw new PromptComposeError(`Refusing to overwrite ${owner} with ${role}: ${file}`, 2)
  }
  ensureWritable(outFile, options.force)
  if (provenanceFile) ensureWritable(provenanceFile, options.force)
  const provenance = {
    status: 'composed',
    manifestFile,
    outFile,
    variables: Object.keys(variables).sort(),
    sources,
    textBytes: Buffer.byteLength(text, 'utf8'),
    textSha256: createHash('sha256').update(text).digest('hex'),
  }
  mkdirSync(dirname(outFile), { recursive: true })
  writeAtomic(outFile, text)
  if (provenanceFile) writeAtomic(provenanceFile, `${JSON.stringify(provenance, null, 2)}\n`)
  return provenance
}

export function run(argv, io = {}) {
  const stdout = io.stdout || ((text) => process.stdout.write(text))
  const stderr = io.stderr || ((text) => process.stderr.write(text))
  try {
    const options = parseArgs(argv)
    if (options.help) {
      stdout(USAGE)
      return 0
    }
    stdout(`${JSON.stringify(compose(options))}\n`)
    return 0
  } catch (error) {
    stderr(`${JSON.stringify({ status: 'error', error: error.message })}\n`)
    return error.exitCode || 2
  }
}

let invokedDirectly = false
try {
  invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
} catch { /* An importing host may pass a non-file argv[1]. */ }
if (invokedDirectly) process.exitCode = run(process.argv.slice(2))
