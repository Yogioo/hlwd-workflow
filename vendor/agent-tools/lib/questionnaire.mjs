/**
 * Shared helpers for the questionnaire skill.
 *
 * Provenance: adapted from to-questionnaire-web/scripts/{serve,poll}.mjs.
 * The Markdown parsing, mobile form layout, draft behavior, token access and
 * one-shot submission artifacts are preserved. AFK inbox forwarding,
 * requirement routing, drain and notification are removed; every path is
 * explicit and all persistence is atomic. Node built-ins only.
 */

import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

/** Error carrying a CLI exit code (2 invalid input, 1 I/O). */
export class QuestionnaireError extends Error {
  constructor(message, exitCode = 2) {
    super(message)
    this.name = 'QuestionnaireError'
    this.exitCode = exitCode
  }
}

/**
 * Parse a questionnaire Markdown document.
 * `# Title` is the page title; `### Heading` are questions; the first `>`
 * line below a question is its initial answer. Paragraphs between the title
 * and the first question become the intro.
 */
export function parseQuestionnaire(markdown) {
  const lines = String(markdown).split(/\r?\n/)
  const titleIndex = lines.findIndex((line) => /^#\s+/.test(line))
  const title = (titleIndex === -1 ? '# Questionnaire' : lines[titleIndex]).replace(/^#\s+/, '').trim()
  const introEnd = lines.findIndex((line, index) => index > titleIndex && /^#{1,6}\s+/.test(line))
  const intro = lines.slice(titleIndex + 1, introEnd === -1 ? lines.length : introEnd).join('\n').trim()
  const questions = []
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(/^###\s+(.+?)\s*$/)
    if (!match) continue
    let answer = ''
    for (let j = i + 1; j < lines.length && !/^#{1,3}\s+/.test(lines[j]); j += 1) {
      if (lines[j].startsWith('>')) {
        answer = lines[j].replace(/^>\s?/, '')
        break
      }
    }
    questions.push({ id: `q${questions.length + 1}`, question: match[1], answer })
  }
  return { title, intro, questions }
}

/** Known question ids for a parsed model, including the free-form fallback. */
export function knownQuestions(model) {
  if (model.questions.length === 0) return new Map([['general', '回答']])
  return new Map(model.questions.map((item) => [item.id, item.question]))
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

/**
 * Derive explicit artifact paths from a questionnaire file, output directory
 * and optional session base name. Refuses ambiguous or colliding paths.
 */
export function artifactPaths({ file, outDir, session } = {}) {
  if (typeof file !== 'string' || file.trim() === '') throw new QuestionnaireError('questionnaire file is required')
  const absolute = resolve(file)
  const dir = outDir ? resolve(outDir) : dirname(absolute)
  const base = session === undefined || session === '' ? basename(absolute, extname(absolute)) : session
  if (typeof base !== 'string' || base.trim() === '' || base !== base.trim() ||
      base === '.' || base === '..' || /[\\/\0]/.test(base)) {
    throw new QuestionnaireError('invalid session name')
  }
  const paths = {
    dir,
    responseFile: join(dir, `${base}-response.json`),
    responseMarkdown: join(dir, `${base}-response.md`),
    statusFile: join(dir, `${base}-status.json`),
    lockFile: join(dir, `${base}-lock.json`),
  }
  const keys = [paths.responseFile, paths.responseMarkdown, paths.statusFile, paths.lockFile, absolute].map(pathKey)
  if (new Set(keys).size !== keys.length) throw new QuestionnaireError('questionnaire and artifact paths collide')
  return paths
}

/** Atomically replace `file` with `text`, cleaning the temp file on failure. */
export function writeFileAtomic(file, text) {
  const absolute = resolve(file)
  const temp = join(dirname(absolute), `.${basename(absolute)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(temp, text, { encoding: 'utf8', flag: 'wx' })
    renameSync(temp, absolute)
  } catch (error) {
    try { rmSync(temp, { force: true }) } catch { /* best effort */ }
    throw error
  }
}

export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`)
}

const STATUS_STATES = new Set(['waiting', 'submitted'])

/**
 * Describe why a parsed status object is not a usable session record.
 * Returns an empty string when the shape is valid. Arbitrary JSON objects
 * (for example `{"state":"bogus"}` or one missing `pid`) are corrupt state,
 * not an empty session.
 */
export function statusShapeError(status) {
  if (!status || typeof status !== 'object' || Array.isArray(status)) return 'status must be a JSON object'
  if (!STATUS_STATES.has(status.state)) return `unknown status state: ${JSON.stringify(status.state)}`
  if (!Number.isInteger(status.pid) || status.pid <= 0) return 'status.pid must be a positive integer'
  if (typeof status.file !== 'string' || status.file.trim() === '') return 'status.file must be a non-empty string'
  if (typeof status.statusFile !== 'string' || status.statusFile.trim() === '') return 'status.statusFile must be a non-empty string'
  if (status.state === 'submitted') {
    if (typeof status.submittedAt !== 'string' || status.submittedAt.trim() === '') return 'submitted status requires submittedAt'
    if (typeof status.responseFile !== 'string' || status.responseFile.trim() === '') return 'submitted status requires responseFile'
  }
  return ''
}

/**
 * Read a status file. Returns `{status}`, `{missing:true}` or
 * `{malformed:true, reason}` so callers can tell an absent session from a
 * corrupt or wrongly shaped one.
 */
export function readStatusFile(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true }
    throw new QuestionnaireError(`cannot read status file: ${error.message}`, 1)
  }
  let status
  try {
    status = JSON.parse(raw)
  } catch {
    return { malformed: true, reason: 'not valid JSON' }
  }
  const reason = statusShapeError(status)
  if (reason) return { malformed: true, reason }
  return { status }
}

/**
 * Validate a submission against the parsed questions.
 * Unknown ids and non-string answers are rejected; client-supplied question
 * text is ignored so answers cannot rewrite the questions.
 */
export function validateSubmission(model, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new QuestionnaireError('submission must be a JSON object')
  }
  const raw = payload.answers
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new QuestionnaireError('submission.answers must be an object')
  }
  const known = knownQuestions(model)
  const answers = {}
  for (const [id, value] of Object.entries(raw)) {
    if (!known.has(id)) throw new QuestionnaireError(`unknown question id: ${id}`)
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.answer !== 'string') {
      throw new QuestionnaireError(`answer for ${id} must be a string`)
    }
    answers[id] = { question: known.get(id), answer: value.answer }
  }
  return answers
}

/** Build the human-readable Markdown result from normalized answers. */
export function buildResponseMarkdown(model, result) {
  const lines = [`# ${model.title} - 回答`, '', `来源: ${result.questionnaireFile}`, `提交时间: ${result.submittedAt}`, '']
  for (const item of model.questions) {
    lines.push(`## ${item.question}`, '', result.answers[item.id]?.answer || '', '')
  }
  if (model.questions.length === 0 && result.answers.general) {
    lines.push('## 回答', '', result.answers.general.answer || '', '')
  }
  return `${lines.join('\n')}\n`
}

const VIRTUAL_ADAPTER = /vEthernet|WSL|Docker|VMware|VirtualBox|Hyper-?V|Loopback|Tailscale|ZeroTier|Radmin|SmartRoute|TAP|OpenVPN|WireGuard|Bluetooth|虚拟|tun/i

/** Non-internal IPv4 candidates, virtual adapters ranked last. */
export function lanAddresses() {
  const candidates = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('169.254.')) continue
      const virtual = VIRTUAL_ADAPTER.test(name) ? 1 : 0
      const rank = entry.address.startsWith('192.168.') ? 0 : entry.address.startsWith('10.') ? 1 : 2
      candidates.push({ name, address: entry.address, virtual, rank })
    }
  }
  candidates.sort((a, b) => a.virtual - b.virtual || a.rank - b.rank || a.name.localeCompare(b.name))
  return candidates
}

/** Signal-0 liveness check; EPERM means the process exists but is not ours. */
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}
