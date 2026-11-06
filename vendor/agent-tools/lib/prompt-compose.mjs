/**
 * Compose a prompt from an explicit JSON manifest.
 *
 * Provenance: adapted from exec-review/scripts/prompt-overlays.mjs (layered
 * overlay loading, `{{var}}` rendering, whitespace-as-absent files). This
 * version drops AFK home lookup, fixed roles, the git footer and the output
 * acceptance policy, and adds strict variable/file errors, caller-defined
 * sources and machine-readable provenance. Node built-ins only.
 */

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

/** Error with a CLI exit code: 1 = I/O, 2 = invalid manifest. */
export class PromptComposeError extends Error {
  constructor(message, exitCode = 2) {
    super(message)
    this.name = 'PromptComposeError'
    this.exitCode = exitCode
  }
}

/** Replace `{{NAME}}`; an unsupplied name is an error, never an empty string. */
export function renderTemplate(text, variables = {}) {
  if (typeof text !== 'string') throw new PromptComposeError('Template must be a string')
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!Object.prototype.hasOwnProperty.call(variables, key)) {
      throw new PromptComposeError(`Unknown variable: {{${key}}}`)
    }
    return variables[key]
  })
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeSource(source, where) {
  if (typeof source === 'string') return { text: source }
  if (!isRecord(source)) throw new PromptComposeError(`${where} must be an object or string`)
  const allowed = new Set(['text', 'file'])
  for (const key of Object.keys(source)) {
    if (!allowed.has(key)) throw new PromptComposeError(`Unknown key in ${where}: ${key}`)
  }
  const hasText = Object.prototype.hasOwnProperty.call(source, 'text')
  const hasFile = Object.prototype.hasOwnProperty.call(source, 'file')
  if (hasText === hasFile) throw new PromptComposeError(`${where} must have exactly one of text or file`)
  if (hasText && typeof source.text !== 'string') throw new PromptComposeError(`${where}.text must be a string`)
  if (hasFile && (typeof source.file !== 'string' || source.file.trim() === '')) {
    throw new PromptComposeError(`${where}.file must be a non-empty string`)
  }
  return source
}

function readSource(source, baseDir) {
  if (source.file !== undefined) {
    const path = resolve(baseDir, source.file)
    let info
    try {
      info = statSync(path)
    } catch (error) {
      if (error.code === 'ENOENT') throw new PromptComposeError(`Missing source file: ${path}`, 1)
      throw error
    }
    if (!info.isFile()) throw new PromptComposeError(`Source is not a file: ${path}`, 1)
    return { text: readFileSync(path, 'utf8'), origin: 'file', path }
  }
  return { text: source.text, origin: 'inline', path: '' }
}

function normalizeVariables(raw) {
  if (raw === undefined) return {}
  if (!isRecord(raw)) throw new PromptComposeError('variables must be an object')
  const variables = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!/^\w+$/.test(key)) throw new PromptComposeError(`Invalid variable name: ${key}`)
    if (typeof value !== 'string') throw new PromptComposeError(`Variable ${key} must be a string`)
    variables[key] = value
  }
  return variables
}

function loadBlock(source, where, baseDir, variables) {
  const { text, origin, path } = readSource(normalizeSource(source, where), baseDir)
  const rendered = renderTemplate(text, variables)
  const included = rendered.trim() !== ''
  return { text: rendered, origin, path, included, bytes: Buffer.byteLength(text, 'utf8') }
}

function pickSource(value, where) {
  const source = {}
  if (Object.prototype.hasOwnProperty.call(value, 'text')) source.text = value.text
  if (Object.prototype.hasOwnProperty.call(value, 'file')) source.file = value.file
  if (source.text === undefined && source.file === undefined) {
    throw new PromptComposeError(`${where} must have exactly one of text or file`)
  }
  return source
}

function blockText(block, heading, variables) {
  const body = block.text.trim()
  if (!heading) return body
  const renderedHeading = renderTemplate(heading, variables).trim()
  return renderedHeading ? `## ${renderedHeading}\n\n${body}` : body
}

function describe(role, mode, label, block, heading) {
  return {
    role, mode, label: label || '', heading: heading || '',
    origin: block.origin, path: block.path, bytes: block.bytes, included: block.included,
  }
}

/**
 * Assemble a prompt from a manifest.
 * @param {object} manifest
 * @param {{baseDir?: string}} [options]
 * @returns {{text: string, sources: object[], variables: object}}
 */
export function assemblePrompt(manifest, options = {}) {
  if (!isRecord(manifest)) throw new PromptComposeError('Manifest must be a JSON object')
  const allowed = new Set(['base', 'layers', 'suffix', 'variables'])
  for (const key of Object.keys(manifest)) {
    if (!allowed.has(key)) throw new PromptComposeError(`Unknown manifest key: ${key}`)
  }
  const baseDir = resolve(options.baseDir || '.')
  const variables = normalizeVariables(manifest.variables)
  const layers = manifest.layers === undefined ? [] : manifest.layers
  if (!Array.isArray(layers)) throw new PromptComposeError('layers must be an array')

  const sources = []
  const blocks = []

  let base = null
  if (manifest.base !== undefined) {
    base = { block: loadBlock(manifest.base, 'base', baseDir, variables), label: '', heading: '', mode: 'base' }
  }

  const appends = []
  layers.forEach((layer, index) => {
    const where = `layers[${index}]`
    if (!isRecord(layer)) throw new PromptComposeError(`${where} must be an object`)
    const layerAllowed = new Set(['mode', 'label', 'heading', 'text', 'file'])
    for (const key of Object.keys(layer)) {
      if (!layerAllowed.has(key)) throw new PromptComposeError(`Unknown key in ${where}: ${key}`)
    }
    const mode = layer.mode === undefined ? 'append' : layer.mode
    if (mode !== 'append' && mode !== 'replace') throw new PromptComposeError(`${where}.mode must be append or replace`)
    if (layer.label !== undefined && typeof layer.label !== 'string') {
      throw new PromptComposeError(`${where}.label must be a string`)
    }
    if (layer.heading !== undefined && typeof layer.heading !== 'string') {
      throw new PromptComposeError(`${where}.heading must be a string`)
    }
    const block = loadBlock(pickSource(layer, where), where, baseDir, variables)
    if (mode === 'replace') {
      base = { block, label: layer.label || '', heading: layer.heading || '', mode: 'replace' }
    } else {
      appends.push({ block, label: layer.label || '', heading: layer.heading || '' })
    }
  })

  if (base) {
    const text = blockText(base.block, base.heading, variables)
    if (text) blocks.push(text)
    sources.push(describe('base', base.mode, base.label, base.block, base.heading))
  }
  for (const layer of appends) {
    const text = blockText(layer.block, layer.heading, variables)
    if (text) blocks.push(text)
    sources.push(describe('append', 'append', layer.label, layer.block, layer.heading))
  }
  if (manifest.suffix !== undefined) {
    const block = loadBlock(manifest.suffix, 'suffix', baseDir, variables)
    const text = blockText(block, '', variables)
    if (text) blocks.push(text)
    sources.push(describe('suffix', 'suffix', '', block, ''))
  }

  const text = blocks.length ? `${blocks.join('\n\n')}\n` : ''
  return { text, sources, variables }
}
