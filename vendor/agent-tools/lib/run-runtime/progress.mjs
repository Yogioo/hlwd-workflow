/**
 * Append-only progress JSONL with an explicit path.
 *
 * Minimal stable fields per record: `t` (epoch ms), `level` (integer, default
 * 1), `event` (non-empty string). Extra caller fields are allowed. Reads are
 * lossless: malformed lines are reported, never silently dropped.
 *
 * Provenance: generalised from skills/exec-review/scripts/progress.mjs.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { CliError } from './util.mjs'

export const DEFAULT_LEVEL = 1

/**
 * Append one progress event.
 * @param {string} file explicit JSONL path
 * @param {{event:string, level?:number, t?:number, data?:object, [key:string]:any}} input
 * @returns {object} the written record
 */
export function appendEvent(file, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new CliError('progress input must be an object', 2, 'INVALID_EVENT')
  }
  const event = input.event
  if (typeof event !== 'string' || event.trim() === '') {
    throw new CliError('progress event requires a non-empty "event" string', 2, 'INVALID_EVENT')
  }
  const level = input.level == null ? DEFAULT_LEVEL : Number(input.level)
  if (!Number.isInteger(level) || level < 0) {
    throw new CliError('progress "level" must be a non-negative integer', 2, 'INVALID_LEVEL')
  }
  const t = input.t == null ? Date.now() : Number(input.t)
  if (!Number.isFinite(t) || t <= 0) {
    throw new CliError('progress "t" must be a positive epoch-ms number', 2, 'INVALID_TIME')
  }
  const extra = input.data ?? {}
  if (typeof extra !== 'object' || Array.isArray(extra) ||
      ['t', 'level', 'event'].some((key) => Object.hasOwn(extra, key))) {
    throw new CliError('progress data must be an object without reserved t/level/event fields', 2, 'INVALID_DATA')
  }
  const record = { t, level, event, ...extra }
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
  return record
}

/**
 * Read all progress records.
 * @param {string} file
 * @param {{after?:number}} [opts] `after` = number of valid events already seen
 * @returns {{events:object[], malformed:{line:number, error:string, raw:string}[], lineCount:number, file:string}}
 */
export function readEvents(file, opts = {}) {
  if (!existsSync(file)) {
    return { events: [], malformed: [], lineCount: 0, file }
  }
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    throw new CliError(`progress file not readable: ${file} (${err.message})`, 1, 'READ_FAILED')
  }
  const events = []
  const malformed = []
  let lineCount = 0
  const rawLines = text.split('\n')
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]
    if (!raw.trim()) continue
    lineCount++
    try {
      const parsed = JSON.parse(raw)
      if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('record is not a JSON object')
      }
      if (typeof parsed.event !== 'string' || parsed.event.trim() === '') {
        throw new Error('record has no non-empty "event"')
      }
      if (typeof parsed.t !== 'number' || !Number.isFinite(parsed.t) || parsed.t <= 0 ||
          !Number.isInteger(parsed.level) || parsed.level < 0) {
        throw new Error('record has invalid t or level')
      }
      events.push(parsed)
    } catch (err) {
      malformed.push({ line: i + 1, error: err.message, raw: raw.length > 200 ? `${raw.slice(0, 200)}...` : raw })
    }
  }
  const after = Number.isInteger(opts.after) && opts.after > 0 ? opts.after : 0
  return { events: events.slice(after), malformed, lineCount, file }
}
