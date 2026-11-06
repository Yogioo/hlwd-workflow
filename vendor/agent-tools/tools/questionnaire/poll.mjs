#!/usr/bin/env node
/**
 * Poll a questionnaire session in bounded segments. Always prints one JSON
 * value describing waiting / submitted / error. Provenance: adapted from
 * to-questionnaire-web/scripts/poll.mjs; explicit status/file paths only.
 *
 * Exit: 0 submitted, 3 still waiting after timeout, 2 no session/invalid args,
 *       1 malformed or unreadable state.
 */

import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  QuestionnaireError, artifactPaths, isProcessAlive, readStatusFile,
} from '../../lib/questionnaire.mjs'

const USAGE = `questionnaire poll - wait in bounded segments for a submission

  --file <questionnaire.md>   questionnaire used to derive the status path
  --status <status.json>      explicit status path (alternative to --file)
  --out-dir <dir>             artifact directory used to derive the status path
  --session <base>            artifact base name used to derive the status path
  --timeout <seconds>         total wait, 0 returns immediately (default: 0)
  --interval <seconds>        poll interval, minimum 1 (default: 2)

The status path must match the running server. Use the statusFile printed by
serve's questionnaire_started event, or repeat serve's --out-dir/--session
(and --file) so poll derives the same path. Exit: 0 submitted, 3 still waiting,
2 no/invalid session, 1 malformed or wrongly shaped state.
`

export function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true }
  const options = { file: '', status: '', outDir: '', session: '', timeout: 0, interval: 2 }
  const allowed = new Set(['--file', '--status', '--out-dir', '--session', '--timeout', '--interval'])
  const seen = new Set()
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (!allowed.has(flag)) throw new QuestionnaireError(`Unknown option: ${flag}`)
    if (seen.has(flag)) throw new QuestionnaireError(`Duplicate option: ${flag}`)
    seen.add(flag)
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw new QuestionnaireError(`Missing value for ${flag}`)
    const key = flag === '--out-dir' ? 'outDir' : flag.slice(2)
    options[key] = value
  }
  if (!options.file && !options.status) throw new QuestionnaireError('Missing --file or --status')
  options.timeout = Number(options.timeout)
  if (!Number.isFinite(options.timeout) || options.timeout < 0) throw new QuestionnaireError('Invalid --timeout')
  options.interval = Number(options.interval)
  if (!Number.isFinite(options.interval) || options.interval < 1) throw new QuestionnaireError('Invalid --interval')
  return options
}

export function statusPath(options) {
  if (options.status) return resolve(options.status)
  return artifactPaths({ file: options.file, outDir: options.outDir, session: options.session }).statusFile
}

function report(state, status, extra) {
  return {
    state,
    statusFile: status?.statusFile || '',
    questionnaireFile: status?.file || '',
    submittedAt: status?.submittedAt || '',
    answeredCount: status?.answeredCount,
    questionCount: status?.questionCount,
    responseFile: status?.responseFile || '',
    responseMarkdown: status?.responseMarkdown || '',
    serverAlive: status ? isProcessAlive(status.pid) : false,
    ...extra,
  }
}

export async function run(argv, io = {}) {
  const stdout = io.stdout || ((text) => process.stdout.write(text))
  const stderr = io.stderr || ((text) => process.stderr.write(text))
  let options
  try {
    options = parseArgs(argv)
    if (options.help) { stdout(USAGE); return 0 }
  } catch (error) {
    stderr(`${JSON.stringify({ state: 'error', error: error.message })}\n`)
    return error.exitCode || 2
  }

  let path
  try {
    path = statusPath(options)
  } catch (error) {
    stderr(`${JSON.stringify({ state: 'error', error: error.message })}\n`)
    return error.exitCode || 2
  }

  const deadline = Date.now() + options.timeout * 1000
  let waitedSeconds = 0
  for (;;) {
    const result = readStatusFile(path)
    if (result.missing) {
      stdout(`${JSON.stringify(report('error', null, {
        statusFile: path,
        error: `no questionnaire session found at ${path}`,
        nextHint: 'start serve.mjs first, or pass the correct --file/--status path',
      }))}\n`)
      return 2
    }
    if (result.malformed) {
      stdout(`${JSON.stringify(report('error', null, {
        statusFile: path,
        error: `malformed status file: ${path} (${result.reason})`,
        nextHint: 'inspect the file; a corrupt or wrongly shaped state is not treated as an empty session',
      }))}\n`)
      return 1
    }
    const status = result.status
    if (status.state === 'submitted') {
      stdout(`${JSON.stringify(report('submitted', status, { waitedSeconds }))}\n`)
      return 0
    }
    if (Date.now() >= deadline) {
      stdout(`${JSON.stringify(report('waiting', status, {
        statusFile: path,
        waitedSeconds,
        nextHint: 'not submitted yet; confirm the shared URL or poll again with --timeout',
      }))}\n`)
      return 3
    }
    await new Promise((done) => setTimeout(done, options.interval * 1000))
    waitedSeconds += options.interval
  }
}

let invokedDirectly = false
try {
  invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
} catch { /* An importing host may pass a non-file argv[1]. */ }
if (invokedDirectly) process.exitCode = await run(process.argv.slice(2))
