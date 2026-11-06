#!/usr/bin/env node
// requirement-store command-line interface. The store API lives in
// lib/requirement-store.mjs; this module owns argument parsing, stdio and
// exit-code translation only.
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  RequirementStoreError,
  closeRequirement,
  createRequirement,
  getRequirement,
  heartbeat,
  linkWorkItems,
  listRequirements,
  setSession,
  whereWorkItem,
  workItemKey,
} from '../../lib/requirement-store.mjs'

const COMMANDS = ['create', 'get', 'list', 'link', 'set-session', 'heartbeat', 'close', 'where']

const USAGE = `requirement-store - durable requirement records under an explicit directory

  create      --dir DIR [--id ID] [--project KEY] [--title T] [--workdir W]
              [--runner R] [--ref REF] [--source S --item I]... [--allow-shared]
  get         --dir DIR --id ID
  list        --dir DIR [--project KEY] [--state open|closed|all]
  link        --dir DIR --id ID --source S --item I [--item I]... [--allow-shared]
  set-session --dir DIR --id ID [--runner R] [--ref REF]
  heartbeat   --dir DIR --id ID
  close       --dir DIR --id ID
  where       --dir DIR --source S --item I

projectKey is explicit metadata, never inferred from the cwd.
Exit: 0 success (one JSON value on stdout), 1 operational failure,
2 invalid arguments or invalid/corrupt records.
`

function usageError(message) {
  return new RequirementStoreError(message, 2)
}

function parseArgs(argv) {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { help: true }
  const command = argv[0]
  if (!COMMANDS.includes(command)) {
    throw usageError(`未知子命令: ${command}（支持: ${COMMANDS.join(', ')}）`)
  }
  const args = { command, items: [] }
  const values = new Set(['--dir', '--id', '--project', '--workdir', '--title', '--runner', '--ref', '--source', '--state'])
  const booleans = new Set(['--allow-shared'])
  for (let i = 1; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--help' || flag === '-h') return { help: true }
    if (booleans.has(flag)) {
      args[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = true
      continue
    }
    if (!values.has(flag) && flag !== '--item') throw usageError(`未知选项: ${flag}`)
    const value = argv[++i]
    if (value === undefined || value.startsWith('--')) throw usageError(`选项 ${flag} 缺少值`)
    if (flag === '--item') args.items.push(value)
    else args[flag.slice(2)] = value
  }
  return args
}

function requireId(args) {
  if (!args.id) throw usageError(`${args.command} 需要 --id`)
}

function requireSourceItems(args) {
  if (!args.source) throw usageError(`${args.command} 需要 --source`)
  if (args.items.length === 0) throw usageError(`${args.command} 需要至少一个 --item`)
}

function workItemsFrom(args) {
  if (args.items.length === 0) return []
  if (!args.source) throw usageError('给了 --item 就必须给 --source')
  return args.items.map((id) => ({ taskSource: args.source, id }))
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
    if (args.command === 'create') {
      const record = createRequirement(
        {
          id: args.id,
          title: args.title,
          workdir: args.workdir,
          projectKey: args.project,
          runner: args.runner,
          sessionRef: args.ref,
          workItems: workItemsFrom(args),
        },
        { dir: args.dir, allowShared: Boolean(args.allowShared) },
      )
      process.stdout.write(`${JSON.stringify(record)}\n`)
      return 0
    }
    if (args.command === 'list') {
      const result = listRequirements({ dir: args.dir, projectKey: args.project, state: args.state || 'all' })
      process.stdout.write(`${JSON.stringify(result)}\n`)
      return 0
    }
    if (args.command === 'where') {
      requireSourceItems(args)
      const result = whereWorkItem({ dir: args.dir, taskSource: args.source, id: args.items[0] })
      if (result.none) {
        process.stderr.write(`没有需求认领这个 work item: ${workItemKey(args.source, args.items[0])}\n`)
        return 1
      }
      process.stdout.write(`${JSON.stringify(result)}\n`)
      return 0
    }

    requireId(args)
    if (args.command === 'get') {
      const record = getRequirement(args.id, { dir: args.dir })
      if (!record) {
        process.stderr.write(`需求不存在: ${args.id}\n`)
        return 1
      }
      process.stdout.write(`${JSON.stringify(record)}\n`)
      return 0
    }
    if (args.command === 'link') {
      requireSourceItems(args)
      const record = linkWorkItems(args.id, workItemsFrom(args), {
        dir: args.dir,
        allowShared: Boolean(args.allowShared),
      })
      if (!record) {
        process.stderr.write(`需求不存在: ${args.id}\n`)
        return 1
      }
      process.stdout.write(`${JSON.stringify(record)}\n`)
      return 0
    }
    if (args.command === 'set-session') {
      if (args.runner === undefined && args.ref === undefined) {
        throw usageError('set-session 需要 --runner 或 --ref')
      }
      const record = setSession(args.id, { dir: args.dir, runner: args.runner, sessionRef: args.ref })
      if (!record) {
        process.stderr.write(`需求不存在: ${args.id}\n`)
        return 1
      }
      process.stdout.write(`${JSON.stringify(record)}\n`)
      return 0
    }
    if (args.command === 'heartbeat') {
      const record = heartbeat(args.id, { dir: args.dir })
      if (!record) {
        process.stderr.write(`需求不存在: ${args.id}\n`)
        return 1
      }
      process.stdout.write(`${JSON.stringify(record)}\n`)
      return 0
    }
    if (args.command === 'close') {
      const record = closeRequirement(args.id, { dir: args.dir })
      if (!record) {
        process.stderr.write(`需求不存在: ${args.id}\n`)
        return 1
      }
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
