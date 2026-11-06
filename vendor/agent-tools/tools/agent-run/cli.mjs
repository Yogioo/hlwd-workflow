#!/usr/bin/env node
// Standalone agent invocation CLI. Adapted from the exec-review runner scripts,
// but with no AFK config, no workdir lock/serve, and no auto-commit.
// Self-contained: Node built-ins plus relative imports inside this skill.
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CAPABILITIES, RUNNERS, capabilities } from '../../lib/agent-run/runners/index.mjs'
import { normalizeEvent } from '../../lib/agent-events.mjs'
import { runAgentTurn } from '../../lib/agent-run/run-agent-turn.mjs'

const USAGE = `agent-run - run one role-neutral agent turn and normalize its events

  run --runner pi|codex|agent --workdir <dir> --prompt-file <file> --out-dir <new-dir>
      [--model <id>] [--provider <id>] [--thinking <level>]
      [--sandbox read-only|workspace-write|danger-full-access]
      [--session <ref>] [--schema-file <file>] [--timeout <ms>] [--bin <path>]
      [--no-approve] [--stream-partial-output]

  capabilities [--runner pi|codex|agent]

  normalize --runner pi|codex|agent --input <events.jsonl> --output <new-file>

--out-dir and normalize --output must be new; existing paths are never clobbered.
A successful normal run prints one JSON object with exitCode, timedOut, aborted,
outputFile, eventsFile and logFile. It never reports task success or acceptance.
A nonzero child exit makes the CLI exit 1; invalid arguments or records exit 2.
Exit: 0 success, 1 operational failure, 2 invalid arguments or records.
`

class UsageError extends Error {
  constructor(message) {
    super(message)
    this.exitCode = 2
  }
}

function invalid(message) {
  throw new UsageError(message)
}

export function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { command: 'help' }
  const [command, ...rest] = argv
  if (command === 'run') return parseRun(rest)
  if (command === 'capabilities') return parseCapabilities(rest)
  if (command === 'normalize') return parseNormalize(rest)
  invalid('Expected run, capabilities or normalize; use --help')
}

function takeValue(rest, i, flag) {
  const value = rest[i + 1]
  if (value === undefined || value.startsWith('--')) invalid(`Missing value for ${flag}`)
  return value
}

function parseRun(rest) {
  const options = { command: 'run', approve: true, streamPartialOutput: false }
  const booleans = new Map([
    ['--no-approve', ['approve', false]],
    ['--approve', ['approve', true]],
    ['--stream-partial-output', ['streamPartialOutput', true]],
  ])
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (booleans.has(flag)) {
      const [key, value] = booleans.get(flag)
      options[key] = value
      continue
    }
    const key = {
      '--runner': 'runner',
      '--workdir': 'workdir',
      '--prompt-file': 'promptFile',
      '--out-dir': 'outDir',
      '--model': 'model',
      '--provider': 'provider',
      '--thinking': 'thinking',
      '--sandbox': 'sandbox',
      '--session': 'session',
      '--schema-file': 'schemaFile',
      '--timeout': 'timeout',
      '--bin': 'bin',
    }[flag]
    if (!key) invalid(`Unknown option: ${flag}`)
    if (Object.hasOwn(options, key)) invalid(`Duplicate option: ${flag}`)
    options[key] = takeValue(rest, i, flag)
    i++
  }
  for (const key of ['runner', 'workdir', 'promptFile', 'outDir']) {
    if (!options[key]) invalid(`Missing --${key === 'promptFile' ? 'prompt-file' : key === 'outDir' ? 'out-dir' : key}`)
  }
  if (!RUNNERS.includes(options.runner)) invalid(`Invalid --runner: ${options.runner}`)
  if (options.timeout !== undefined) {
    const ms = Number(options.timeout)
    if (!Number.isInteger(ms) || ms <= 0) invalid('--timeout must be a positive integer of milliseconds')
    options.timeout = ms
  }
  return options
}

function parseCapabilities(rest) {
  const options = { command: 'capabilities' }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '--runner') invalid(`Unknown option: ${rest[i]}`)
    options.runner = takeValue(rest, i, '--runner')
    i++
  }
  if (options.runner !== undefined && !RUNNERS.includes(options.runner)) {
    invalid(`Invalid --runner: ${options.runner}`)
  }
  return options
}

function parseNormalize(rest) {
  const options = { command: 'normalize' }
  for (let i = 0; i < rest.length; i++) {
    const key = { '--runner': 'runner', '--input': 'input', '--output': 'output' }[rest[i]]
    if (!key) invalid(`Unknown option: ${rest[i]}`)
    if (Object.hasOwn(options, key)) invalid(`Duplicate option: ${rest[i]}`)
    options[key] = takeValue(rest, i, rest[i])
    i++
  }
  for (const key of ['runner', 'input', 'output']) if (!options[key]) invalid(`Missing --${key}`)
  if (!RUNNERS.includes(options.runner)) invalid(`Invalid --runner: ${options.runner}`)
  return options
}

function requireEmptyPath(path, label) {
  if (existsSync(path)) invalid(`${label} already exists: ${path}`)
}

function requireDirectory(path, label) {
  let stat
  try {
    stat = statSync(path)
  } catch {
    invalid(`${label} is not accessible: ${path}`)
  }
  if (!stat.isDirectory()) invalid(`${label} is not a directory: ${path}`)
}

function validateRun(options) {
  const caps = CAPABILITIES[options.runner]
  requireDirectory(options.workdir, '--workdir')
  let prompt
  try {
    prompt = readFileSync(options.promptFile, 'utf8')
  } catch {
    invalid(`--prompt-file is not readable: ${options.promptFile}`)
  }
  if (options.sandbox !== undefined && !caps.sandboxModes.includes(options.sandbox)) {
    invalid(`runner ${options.runner} does not support --sandbox ${options.sandbox}`)
  }
  if (options.session !== undefined && caps.sessionMode === 'none') {
    invalid(`runner ${options.runner} has no verified resume interface; --session is not supported`)
  }
  if (options.runner === 'codex' && options.session !== undefined && options.sandbox !== undefined) {
    invalid('codex resume cannot apply --sandbox; it uses session settings')
  }
  if (options.provider !== undefined && options.runner !== 'pi') {
    invalid(`runner ${options.runner} does not support --provider`)
  }
  if (options.schemaFile !== undefined) {
    if (!caps.outputSchema) invalid(`runner ${options.runner} does not support --schema-file`)
    try {
      statSync(options.schemaFile)
    } catch {
      invalid(`--schema-file is not accessible: ${options.schemaFile}`)
    }
  }
  if (options.streamPartialOutput && !caps.streamPartialOutput) {
    invalid(`runner ${options.runner} does not support --stream-partial-output`)
  }
  return prompt
}

async function run(options) {
  const prompt = validateRun(options)
  const outDir = resolve(options.outDir)
  requireEmptyPath(outDir, '--out-dir')
  mkdirSync(outDir)
  const facts = await runAgentTurn({
    runner: options.runner,
    bin: options.bin,
    workdir: resolve(options.workdir),
    prompt,
    promptFile: resolve(options.promptFile),
    outFile: join(outDir, 'output.txt'),
    eventsFile: join(outDir, 'events.jsonl'),
    logFile: join(outDir, 'log.txt'),
    model: options.model,
    provider: options.provider,
    thinking: options.thinking,
    sandbox: options.sandbox,
    session: options.session,
    schemaFile: options.schemaFile ? realpathSync(options.schemaFile) : undefined,
    approve: options.approve,
    streamPartialOutput: options.streamPartialOutput,
    timeoutMs: options.timeout,
  })
  return { result: facts, exitCode: facts.exitCode === 0 ? 0 : 1 }
}

function normalize(options) {
  requireEmptyPath(options.output, '--output')
  let raw
  try {
    raw = readFileSync(options.input, 'utf8')
  } catch {
    const error = new Error(`--input is not readable: ${options.input}`)
    error.exitCode = 1
    throw error
  }
  const records = []
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    try {
      records.push(JSON.parse(line))
    } catch (error) {
      invalid(`Invalid JSONL at line ${i + 1}: ${error.message}`)
    }
  }
  if (records.length === 0) invalid('--input has no JSONL records')
  const normalized = records.map((record) => normalizeEvent(record, options.runner))
  const outputFile = resolve(options.output)
  writeFileSync(outputFile, `${normalized.map((event) => JSON.stringify(event)).join('\n')}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  })
  return {
    result: {
      runner: options.runner,
      inputFile: resolve(options.input),
      outputFile,
      eventCount: normalized.length,
    },
    exitCode: 0,
  }
}

export async function runCli(argv, io = {}) {
  const stdout = io.stdout || ((text) => process.stdout.write(text))
  const stderr = io.stderr || ((text) => process.stderr.write(text))
  try {
    const options = parseArgs(argv)
    if (options.command === 'help') {
      stdout(USAGE)
      return 0
    }
    if (options.command === 'capabilities') {
      stdout(`${JSON.stringify(capabilities(options.runner))}\n`)
      return 0
    }
    const outcome = options.command === 'run' ? await run(options) : normalize(options)
    stdout(`${JSON.stringify(outcome.result)}\n`)
    return outcome.exitCode
  } catch (error) {
    stderr(`${JSON.stringify({ status: 'error', error: error.message })}\n`)
    return error.exitCode || 1
  }
}

let invokedDirectly = false
try {
  invokedDirectly =
    Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
} catch {
  /* An importing host may use a non-file argv[1]. */
}
if (invokedDirectly) {
  process.exitCode = await runCli(process.argv.slice(2))
}
