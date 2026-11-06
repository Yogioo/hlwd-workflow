#!/usr/bin/env node
// agent-tools: one dispatcher for the toolkit CLIs.
//
// Each component keeps its own Node CLI argument contract. This entry point
// only resolves the component to its installed tools/ script, forwards argv and
// stdio, and preserves the child exit code. Modules are resolved relative to
// this file (package root), never the current working directory.

import { spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const TOOL_COMMANDS = {
  'agent-run': ['tools/agent-run/cli.mjs'],
  subagent: ['tools/subagent/cli.mjs'],
  'work-items': ['tools/work-items/cli.mjs'],
  'run-runtime': ['tools/run-runtime/cli.mjs'],
  'workspace-diff': ['tools/workspace-diff/cli.mjs'],
  'prompt-compose': ['tools/prompt-compose/cli.mjs'],
  'event-inbox': ['tools/event-inbox/cli.mjs'],
  'requirement-store': ['tools/requirement-store/cli.mjs'],
  'xlsx-cell-diff': ['tools/xlsx-cell-diff/cli.mjs'],
}

const QUESTIONNAIRE_SUBCOMMANDS = {
  serve: 'tools/questionnaire/serve.mjs',
  poll: 'tools/questionnaire/poll.mjs',
}

const USAGE = `agent-tools - local agent workflow toolkit

Usage: agent-tools <command> [options]

Commands:
  agent-run          run one agent turn and normalize its events
  subagent           role-table agent turns: run, plan, roles, models, doctor, init, probe
  work-items         read and mutate beads, GitHub or TAPD work items
  run-runtime        leases, progress, config layers, checkpoints, children
  workspace-diff     snapshot and compare directory contents
  prompt-compose     compose a prompt from an explicit manifest
  event-inbox        persist, query and acknowledge events
  requirement-store  persist and look up requirement records
  questionnaire      serve|poll a local questionnaire web form
  xlsx-cell-diff     xlsx display-value diff and overlay merge

Run "agent-tools <command> --help" for a command's options and exit codes.
`

function printUsage(stream) {
  stream.write(USAGE)
}

// Resolve a component to its installed tools/ script. Questionnaire is the one
// component whose execution file depends on its first argument.
function resolveCommand(argv) {
  const [command, ...rest] = argv
  if (command === 'questionnaire') {
    const [subcommand, ...subRest] = rest
    if (subcommand === '--help' || subcommand === '-h') {
      return { help: true }
    }
    const script = Object.hasOwn(QUESTIONNAIRE_SUBCOMMANDS, subcommand) ? QUESTIONNAIRE_SUBCOMMANDS[subcommand] : null
    if (!script) {
      return { error: `questionnaire requires a subcommand: serve or poll` }
    }
    return { script, args: subRest }
  }
  const script = Object.hasOwn(TOOL_COMMANDS, command) ? TOOL_COMMANDS[command] : null
  if (!script) {
    return { error: `unknown command: ${command}` }
  }
  return { script: script[0], args: rest }
}

function terminateChild(child, signal) {
  if (child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32') {
    // taskkill /T kills exactly this child's tree; no other process is touched.
    try {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    } catch { /* best effort */ }
  } else {
    try {
      // Negative pid targets only the detached child's own process group.
      process.kill(-child.pid, signal)
    } catch { /* best effort */ }
  }
}

function signalExitCode(signal) {
  const numbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }
  const number = numbers[signal]
  return number ? 128 + number : 1
}

function runScript(relativePath, args) {
  const script = join(packageRoot, relativePath)
  if (!existsSync(script)) {
    process.stderr.write(`agent-tools: component implementation is missing: ${relativePath}\n`)
    process.exitCode = 1
    return
  }
  const child = spawn(process.execPath, [script, ...args], {
    stdio: 'inherit',
    windowsHide: true,
    detached: process.platform !== 'win32',
  })

  let interrupted = null
  let forcedCode = null
  const onSignal = (signal) => {
    interrupted = signal
    terminateChild(child, signal)
  }
  const onExit = () => {
    if (interrupted) terminateChild(child, interrupted)
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  process.on('exit', onExit)

  child.on('error', (error) => {
    process.stderr.write(`agent-tools: failed to start component: ${error.message}\n`)
    forcedCode = 1
  })
  child.on('close', (code, signal) => {
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
    process.removeListener('exit', onExit)
    if (forcedCode !== null) process.exitCode = forcedCode
    else if (code !== null) process.exitCode = code
    else if (signal) process.exitCode = signalExitCode(signal)
    else process.exitCode = interrupted ? signalExitCode(interrupted) : 0
  })
}

export function main(argv = process.argv.slice(2)) {
  if (argv.length === 0) {
    printUsage(process.stderr)
    process.exitCode = 2
  } else if (argv[0] === '--help' || argv[0] === '-h') {
    printUsage(process.stdout)
    process.exitCode = 0
  } else {
    const resolved = resolveCommand(argv)
    if (resolved.help) {
      printUsage(process.stdout)
      process.exitCode = 0
    } else if (resolved.error) {
      process.stderr.write(`agent-tools: ${resolved.error}\n\n`)
      printUsage(process.stderr)
      process.exitCode = 2
    } else {
      runScript(resolved.script, resolved.args)
    }
  }
}

let invokedDirectly = false
try {
  invokedDirectly = Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
} catch { /* An importing host may use a non-file argv[1]. */ }
if (invokedDirectly) main()
