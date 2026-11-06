#!/usr/bin/env node
// event-inbox command-line interface. The store API lives in lib/event-inbox.mjs;
// this module owns argument parsing, stdio and exit-code translation only.
import { readFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  EventInboxError,
  ackEvent,
  getEvent,
  listEvents,
  writeEvent,
} from '../../lib/event-inbox.mjs'

const COMMANDS = ['emit', 'list', 'get', 'ack']

const USAGE = `event-inbox - persist and acknowledge events in an explicit directory

  emit --dir DIR (--file FILE | --stdin)
  list --dir DIR [--state unread|seen|done] [--project KEY] [--requirement ID]
       [--kind KIND] [--unrouted]
  get  --dir DIR --id ID
  ack  --dir DIR --id ID --state seen|done [--note TEXT]

--file or --stdin supplies one JSON event object for emit.
Exit: 0 success (one JSON value on stdout), 1 operational failure,
2 invalid arguments or invalid/corrupt records.
`

function usageError(message) {
  return new EventInboxError(message, 2)
}

function operationalError(message) {
  return new EventInboxError(message, 1)
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { help: true }
  const command = argv[0]
  if (!COMMANDS.includes(command)) throw usageError(`未知子命令: ${command}（支持: ${COMMANDS.join(', ')}）`)
  const args = { command, items: [] }
  const values = new Set([
    '--dir', '--file', '--id', '--state', '--note', '--project', '--requirement', '--kind',
  ])
  const booleans = new Set(['--stdin', '--unrouted'])
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h') return { help: true }
    if (booleans.has(flag)) {
      args[flag.slice(2)] = true
      continue
    }
    if (!values.has(flag)) throw usageError(`未知选项: ${flag}`)
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw usageError(`选项 ${flag} 缺少值`)
    args[flag.slice(2)] = value
  }
  args.states = args.state ? args.state.split(',').map((s) => s.trim()).filter(Boolean) : undefined
  return args
}

function readEventInput(args) {
  let text
  if (args.stdin) {
    try {
      text = readFileSync(0, 'utf8')
    } catch (err) {
      throw operationalError(`无法读取标准输入: ${err.message}`)
    }
  } else if (args.file) {
    try {
      text = readFileSync(args.file, 'utf8')
    } catch (err) {
      throw operationalError(`无法读取输入文件 ${args.file}: ${err.message}`)
    }
  } else {
    throw usageError('emit 需要 --file 或 --stdin')
  }
  try {
    return JSON.parse(text)
  } catch (err) {
    throw usageError(`输入不是合法 JSON: ${err.message}`)
  }
}

export function main() {
  let args
  try {
    args = parseArgs(process.argv.slice(2))
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    return err.exitCode || 2
  }
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  try {
    if (args.command === 'emit') {
      const record = writeEvent(readEventInput(args), { dir: args.dir })
      process.stdout.write(`${JSON.stringify(record)}\n`)
      return 0
    }
    if (args.command === 'list') {
      const result = listEvents({
        dir: args.dir,
        states: args.states,
        projectKey: args.project,
        requirementId: args.requirement,
        kind: args.kind,
        unroutedOnly: Boolean(args.unrouted),
      })
      process.stdout.write(`${JSON.stringify(result)}\n`)
      return 0
    }
    if (args.command === 'get') {
      if (!args.id) throw usageError('get 需要 --id')
      const record = getEvent(args.id, { dir: args.dir })
      if (!record) {
        process.stderr.write(`事件不存在: ${args.id}\n`)
        return 1
      }
      process.stdout.write(`${JSON.stringify(record)}\n`)
      return 0
    }
    if (args.command === 'ack') {
      if (!args.id) throw usageError('ack 需要 --id')
      if (!args.state) throw usageError('ack 需要 --state seen|done')
      const record = ackEvent(args.id, { dir: args.dir, state: args.state, note: args.note || '' })
      process.stdout.write(`${JSON.stringify(record)}\n`)
      return 0
    }
    throw usageError(`未处理的子命令: ${args.command}`)
  } catch (err) {
    process.stderr.write(`${err.message}\n`)
    return err.exitCode || 1
  }
}

function isDirectMain() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isDirectMain()) {
  process.exitCode = main()
}
