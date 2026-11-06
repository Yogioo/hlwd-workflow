#!/usr/bin/env node
/**
 * work-items CLI. Standalone over beads, GitHub Issues, and TAPD.
 * Extracted from the afk-run task-source adapters; no AFK loop or config.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createWorkSource, SOURCES, WorkItemsError } from '../../lib/work-items/index.mjs'

const USAGE = `work-items - read and mutate work items in beads, GitHub Issues, or TAPD

  capabilities --source <beads|gh|tapd>
  list  --source <...> [--workdir DIR] [--repo OWNER/NAME] [--config FILE]
        [--ready] [--ready-label L] [--exclude-label L] [--assignee USER]
        [--priority-max N] [--priority-min N] [--include-blocked]
        [--exclude-machine-labels] [--state open|all] [--limit N]
  get   --source <...> --id ID [--workdir DIR] [--repo ...] [--config ...]
        [--image-dir DIR] [--no-images] [--fail-on-image-error]
  claim --source <...> --id ID [--claim-label L] [--assignee USER]
        [--ready-label L] [--exclude-label L]
  comment --source <...> --id ID --message TEXT
  labels  --source <...> --id ID [--add L]... [--remove L]... [--set L]...
  close   --source <beads|gh> --id ID [--comment TEXT] [--reason TEXT]
  deliver --source tapd --id ID [--summary TEXT] [--commit SHA]

list returns facts without policy; add --ready for explicit selection.
--config is a JSON file with source options such as
{"workdir":"...","repo":"...","actor":"...","imageDir":"...",
 "tapd":{"assignee":"...","commentAuthor":"...","readyLabel":"..."}}.
Explicit flags override config. Credentials stay in the environment.
Exit: 0 success, 1 operational failure, 2 invalid arguments or records.
`

const COMMANDS = {
  capabilities: { allow: [], require: ['source'] },
  list: {
    allow: ['--ready', '--ready-label', '--exclude-label', '--assignee', '--priority-max', '--priority-min', '--include-blocked', '--exclude-machine-labels', '--state', '--limit'],
    require: ['source'],
  },
  get: { allow: ['--id', '--no-images', '--fail-on-image-error'], require: ['source', 'id'] },
  claim: { allow: ['--id', '--claim-label', '--assignee', '--ready-label', '--exclude-label'], require: ['source', 'id'] },
  comment: { allow: ['--id', '--message'], require: ['source', 'id', 'message'] },
  labels: { allow: ['--id', '--add', '--remove', '--set'], require: ['source', 'id'] },
  close: { allow: ['--id', '--comment', '--reason'], require: ['source', 'id'] },
  deliver: { allow: ['--id', '--summary', '--commit'], require: ['source', 'id'] },
}

const GLOBAL = ['--source', '--workdir', '--repo', '--config', '--actor', '--image-dir']
const BOOLEAN = new Set(['--ready', '--include-blocked', '--exclude-machine-labels', '--no-images', '--fail-on-image-error'])
const REPEATABLE = new Set(['--exclude-label', '--add', '--remove', '--set'])

function invalid(message) {
  throw new WorkItemsError(message, 2)
}

function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true }
  const [command, ...rest] = argv
  const spec = COMMANDS[command]
  if (!spec) invalid('Expected a subcommand; use --help')
  const allowed = new Set([...GLOBAL, ...spec.allow])
  const options = { command, excludeLabel: [], add: [], remove: [], set: [] }
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    if (!allowed.has(flag)) invalid(`Unknown option for ${command}: ${flag}`)
    if (BOOLEAN.has(flag)) {
      options[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true
      continue
    }
    const value = rest[++i]
    if (value === undefined || value.startsWith('--')) invalid(`Missing value for ${flag}`)
    if (REPEATABLE.has(flag)) {
      const key = flag === '--exclude-label' ? 'excludeLabel' : flag.slice(2)
      options[key].push(value)
    } else {
      const key = flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      if (Object.hasOwn(options, key)) invalid(`Duplicate option: ${flag}`)
      options[key] = value
    }
  }
  for (const key of spec.require) if (!options[key]) invalid(`Missing --${key}`)
  if (command === 'labels' && !options.set.length && !options.add.length && !options.remove.length) {
    invalid('labels requires --add, --remove, or --set')
  }
  const source = String(options.source).toLowerCase()
  if (!SOURCES.includes(source)) invalid(`Unknown --source: ${options.source} (use ${SOURCES.join(', ')})`)
  options.source = source
  if (options.state !== undefined && source !== 'gh') invalid('--state is supported only by gh')
  if (options.limit !== undefined && source !== 'gh') invalid('--limit is supported only by gh')
  if (options.excludeMachineLabels && source !== 'tapd') invalid('--exclude-machine-labels is supported only by tapd')
  if (options.includeBlocked && source === 'tapd') invalid('tapd has no dependency graph for --include-blocked')
  if (options.command === 'list' && options.assignee && source !== 'tapd' && !options.ready) {
    invalid('--assignee selection requires --ready for this source')
  }
  if (options.command === 'list' && options.assignee && source === 'gh') invalid('gh assignee selection is not supported')
  if (options.command === 'list' && !options.ready &&
      (options.readyLabel || options.excludeLabel.length || options.priorityMax !== undefined ||
       options.priorityMin !== undefined || options.includeBlocked || options.excludeMachineLabels)) {
    invalid('selection options require --ready')
  }
  for (const key of ['priorityMax', 'priorityMin', 'limit']) {
    if (options[key] !== undefined) {
      const number = Number(options[key])
      if (!Number.isInteger(number)) invalid(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} must be an integer`)
      options[key] = number
    }
  }
  if (options.state !== undefined && !['open', 'all', 'closed'].includes(options.state)) invalid('--state must be open, all, or closed')
  if (options.set.length && (options.add.length || options.remove.length)) invalid('--set cannot be combined with --add/--remove')
  return options
}

function loadConfig(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new WorkItemsError(`无法读取配置文件 ${path}: ${err.message}`, 2)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new WorkItemsError(`配置文件不是合法 JSON: ${err.message}`, 2)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) invalid('配置文件必须是 JSON 对象')
  return parsed
}

function buildSource(options) {
  const cfg = options.config ? loadConfig(options.config) : {}
  const tapd = cfg.tapd && typeof cfg.tapd === 'object' ? { ...cfg.tapd } : {}
  if (options.assignee) tapd.assignee = options.assignee
  const workdir = options.workdir || cfg.workdir
  const repo = options.repo || cfg.repo
  if (options.source === 'beads' && !workdir) invalid('beads requires --workdir (or config.workdir)')
  if (options.source === 'gh' && !repo && !workdir) invalid('gh requires --repo or --workdir')
  if (options.source === 'tapd' && !options.assignee && !tapd.assignee) {
    invalid('tapd requires --assignee or config.tapd.assignee')
  }
  const sourceOpts = {
    cwd: workdir,
    repo,
    actor: options.actor || cfg.actor,
    imageDir: options.imageDir || cfg.imageDir,
    tapd,
    command: cfg.command,
    commandPrefix: cfg.commandPrefix,
  }
  return createWorkSource(options.source, sourceOpts)
}

function selectionOptions(options) {
  return {
    readyLabel: options.readyLabel,
    excludeLabels: options.excludeLabel,
    assignee: options.assignee,
    priorityMax: options.priorityMax,
    priorityMin: options.priorityMin,
    includeBlocked: options.includeBlocked,
    excludeMachineLabels: options.excludeMachineLabels,
    state: options.state,
    limit: options.limit,
  }
}

async function execute(options) {
  if (options.command === 'capabilities') {
    return createWorkSource(options.source, {}).capabilities()
  }
  const source = buildSource(options)
  switch (options.command) {
    case 'list':
      return options.ready ? source.selectReady(selectionOptions(options)) : source.list(selectionOptions(options))
    case 'get':
      return source.get(options.id, {
        imageDir: options.noImages ? '' : options.imageDir,
        failOnImageError: options.failOnImageError,
      })
    case 'claim':
      return source.claim(options.id, {
        claimLabel: options.claimLabel,
        assignee: options.assignee,
        readyLabel: options.readyLabel,
        excludeLabels: options.excludeLabel,
      })
    case 'comment':
      return source.comment(options.id, options.message)
    case 'labels': {
      if (options.set.length) return source.setLabels(options.id, options.set)
      let out = { id: options.id }
      if (options.add.length) out = { ...out, ...source.addLabels(options.id, options.add) }
      if (options.remove.length) out = { ...out, ...source.removeLabels(options.id, options.remove) }
      return out
    }
    case 'close':
      return source.close(options.id, { comment: options.comment, reason: options.reason })
    case 'deliver':
      return source.deliver(options.id, { summary: options.summary, commit: options.commit })
    default:
      invalid(`Unhandled command: ${options.command}`)
  }
}

export async function run(argv, io = {}) {
  const stdout = io.stdout || ((text) => process.stdout.write(text))
  const stderr = io.stderr || ((text) => process.stderr.write(text))
  try {
    const options = parseArgs(argv)
    if (options.help) {
      stdout(USAGE)
      return 0
    }
    const result = await execute(options)
    if (result?.status === 'error') {
      stderr(`${JSON.stringify(result)}\n`)
      return 1
    }
    stdout(`${JSON.stringify(result)}\n`)
    return 0
  } catch (error) {
    stderr(`${JSON.stringify({ status: 'error', error: error.message })}\n`)
    return error.exitCode || 1
  }
}

let invokedDirectly = false
try {
  invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
} catch {
  // An importing host may use a non-file argv[1].
}
if (invokedDirectly) {
  process.exitCode = await run(process.argv.slice(2))
}
