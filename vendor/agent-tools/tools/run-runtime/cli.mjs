#!/usr/bin/env node
/**
 * run-runtime CLI.
 *
 *   node scripts/cli.mjs lease acquire|status|release|recover ...
 *   node scripts/cli.mjs progress append|read ...
 *   node scripts/cli.mjs serve --events-file FILE [--host H] [--port N]
 *   node scripts/cli.mjs config merge|identity ...
 *   node scripts/cli.mjs checkpoint create|status|restore ...
 *
 * Successful commands print one JSON value to stdout. Diagnostics go to stderr.
 * Invalid arguments/records exit 2; operational failures exit 1.
 * Provenance: CLI/exit-code conventions follow skills/agent-run/scripts/cli.mjs.
 */

import { resolve } from 'node:path'

import { CliError, atomicWriteJson, boolFlag, flag, flagList, isDirectMain, parseArgs, writeStdout } from '../../lib/run-runtime/util.mjs'
import { acquireLease, isProcessAlive, recoverLease, releaseLease, statusLease } from '../../lib/run-runtime/lease.mjs'
import { appendEvent, readEvents } from '../../lib/run-runtime/progress.mjs'
import { createViewerServer } from '../../lib/run-runtime/viewer.mjs'
import { mergeConfigFiles, projectIdentity, redactSecrets } from '../../lib/run-runtime/config.mjs'
import { checkpointStatus, createCheckpoint, restoreCheckpoint } from '../../lib/run-runtime/checkpoint.mjs'
import { currentBoard, ensureBoard, readBoardState, startBoardServer, stopBoard } from '../../lib/run-runtime/board.mjs'
import { adoptRun, listRuns, pruneRuns, unregisterRun } from '../../lib/run-runtime/run-registry.mjs'

const BOOLEAN = new Set(['help', 'h', 'steal-stale', 'show-secrets', 'clean-untracked', 'version'])

const HELP = `run-runtime - local execution support (leases, progress, config, checkpoints)

Usage:
  node cli.mjs lease acquire  --registry-dir DIR --workdir DIR --pid LIVE_PID [--label L] [--steal-stale]
  node cli.mjs lease status   --registry-dir DIR --workdir DIR [--pid N]
  node cli.mjs lease release  --registry-dir DIR --workdir DIR --token TOKEN [--pid N]
  node cli.mjs lease recover  --registry-dir DIR --workdir DIR

  node cli.mjs progress append --file FILE --event NAME [--level N] [--data JSON] [--time MS]
  node cli.mjs progress read   --file FILE [--after N]
  node cli.mjs serve           --events-file FILE [--host 127.0.0.1] [--port 0]

  node cli.mjs board ensure    [--host 0.0.0.0]      幂等拉起常驻看板（没在跑就起）
  node cli.mjs board status                          在不在跑、地址是什么
  node cli.mjs board stop                            关掉常驻看板
  node cli.mjs board serve     [--host H] [--port N]  前台起看板（调试用）

  node cli.mjs runs list       [--days N] [--all] [--alive]   当前登记的 run（跨项目，默认全部）
  node cli.mjs runs adopt      --out-dir DIR [--workdir DIR]  把已跑完的目录补登记成历史
  node cli.mjs runs forget     --run-id ID                     显式删掉一条记录
  node cli.mjs runs prune      [--older-than N]                删 N 天前的已结束记录（默认 30）

  node cli.mjs config merge    --file A.json [--file B.json ...] [--output OUT.json] [--show-secrets]
  node cli.mjs config identity --workdir DIR

  node cli.mjs checkpoint create  --workdir DIR --state FILE [--exclude PATH ...]
  node cli.mjs checkpoint status  --state FILE [--workdir DIR]
  node cli.mjs checkpoint restore --state FILE [--workdir DIR] [--clean-untracked] [--exclude PATH ...]

Notes:
  - lease acquire requires --pid of a live owner process; the CLI process itself is short-lived.
  - lease acquire never replaces a live owner; stale/malformed leases need 'lease recover'.
  - lease release always requires the owner token; there is no force override.
  - config merge redacts secret-looking values unless --show-secrets; --output writes raw.
  - checkpoint restore refuses a HEAD mismatch; untracked cleanup requires --clean-untracked.
  - checkpoint state must be new and live outside the target worktree; restore refuses
    untracked/ignored paths that obstruct tracked paths (reset would delete them).
  - runs list reads the registry; the board page applies a 7-day window by default,
    but nothing is deleted by a window. Only 'runs forget' and 'runs prune' delete.
`

function requireFlag(flags, name) {
  const value = flag(flags, name)
  if (value === undefined || value === true || value === '') {
    throw new CliError(`missing required --${name}`, 2, 'MISSING_ARG')
  }
  return String(value)
}

function optionalNumber(flags, name) {
  const value = flag(flags, name)
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) throw new CliError(`--${name} must be a number`, 2, 'INVALID_ARG')
  return n
}

function requireInt(flags, name) {
  const n = optionalNumber(flags, name)
  if (n === undefined || !Number.isInteger(n)) throw new CliError(`--${name} must be an integer`, 2, 'INVALID_ARG')
  return n
}

function parseData(flags) {
  const raw = flag(flags, 'data')
  if (raw === undefined) return {}
  if (typeof raw !== 'string') throw new CliError('--data requires a JSON object string', 2, 'INVALID_ARG')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new CliError(`--data is not valid JSON: ${err.message}`, 2, 'INVALID_ARG')
  }
  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('--data must be a JSON object', 2, 'INVALID_ARG')
  }
  return parsed
}

async function runLease(action, flags) {
  const registryDir = requireFlag(flags, 'registry-dir')
  const workdir = requireFlag(flags, 'workdir')
  if (action === 'acquire') {
    const pid = requireInt(flags, 'pid')
    if (pid <= 0) throw new CliError('--pid must be a positive process id', 2, 'INVALID_ARG')
    if (!isProcessAlive(pid)) {
      throw new CliError(`--pid ${pid} is not a live process on this host`, 2, 'PID_NOT_ALIVE')
    }
    const out = acquireLease({
      registryDir,
      workdir,
      label: flag(flags, 'label') || '',
      pid,
      stealStale: boolFlag(flags, 'steal-stale'),
    })
    return { ...out, registryDir: resolve(registryDir), workdir }
  }
  if (action === 'status') return statusLease({ registryDir, workdir, pid: optionalNumber(flags, 'pid') })
  if (action === 'release') {
    return releaseLease({
      registryDir,
      workdir,
      token: flag(flags, 'token'),
      pid: optionalNumber(flags, 'pid'),
    })
  }
  if (action === 'recover') return recoverLease({ registryDir, workdir })
  throw new CliError(`unknown lease action: ${action}`, 2, 'UNKNOWN_ACTION')
}

function runProgress(action, flags) {
  const file = requireFlag(flags, 'file')
  if (action === 'append') {
    return appendEvent(file, {
      event: requireFlag(flags, 'event'),
      level: optionalNumber(flags, 'level'),
      t: optionalNumber(flags, 'time'),
      data: parseData(flags),
    })
  }
  if (action === 'read') return readEvents(file, { after: optionalNumber(flags, 'after') })
  throw new CliError(`unknown progress action: ${action}`, 2, 'UNKNOWN_ACTION')
}

function runConfig(action, flags) {
  if (action === 'merge') {
    const files = flagList(flags, 'file')
    if (!files.length) throw new CliError('config merge requires at least one --file', 2, 'MISSING_ARG')
    const result = mergeConfigFiles(files)
    if (!result.ok) {
      const lines = result.malformed.map((m) => `  ${m.file}: ${m.error}`).join('\n')
      throw new CliError(`malformed config layer(s):\n${lines}`, 2, 'CONFIG_MALFORMED')
    }
    const output = flag(flags, 'output')
    if (output) {
      const target = resolve(String(output))
      atomicWriteJson(target, result.value)
      return { output: target, files: result.layers.map((l) => l.file), keys: Object.keys(result.value) }
    }
    return boolFlag(flags, 'show-secrets') ? result.value : redactSecrets(result.value)
  }
  if (action === 'identity') return projectIdentity(requireFlag(flags, 'workdir'))
  throw new CliError(`unknown config action: ${action}`, 2, 'UNKNOWN_ACTION')
}

function runCheckpoint(action, flags) {
  if (action === 'create') {
    return createCheckpoint({
      workdir: requireFlag(flags, 'workdir'),
      stateFile: requireFlag(flags, 'state'),
      excludePaths: flagList(flags, 'exclude'),
    })
  }
  if (action === 'status') {
    return checkpointStatus({ stateFile: requireFlag(flags, 'state'), workdir: flag(flags, 'workdir') })
  }
  if (action === 'restore') {
    return restoreCheckpoint({
      stateFile: requireFlag(flags, 'state'),
      workdir: flag(flags, 'workdir'),
      cleanUntracked: boolFlag(flags, 'clean-untracked'),
      excludePaths: flagList(flags, 'exclude'),
    })
  }
  throw new CliError(`unknown checkpoint action: ${action}`, 2, 'UNKNOWN_ACTION')
}

/** 确保常驻看板在跑。幂等，输出单行 JSON（`url` 就是给人打开的地址）。 */
async function runBoard(action, flags) {
  if (action === 'ensure') {
    return await ensureBoard({ host: flag(flags, 'host') || undefined })
  }
  if (action === 'status') {
    const health = await currentBoard()
    const state = readBoardState()
    return { running: health.ok, ...(state || {}), ...(health.ok ? {} : { error: health.error }) }
  }
  if (action === 'stop') return stopBoard()
  throw new CliError(`unknown board action: ${action}`, 2, 'UNKNOWN_ACTION')
}

async function runBoardServe(flags) {
  const board = await startBoardServer({
    host: flag(flags, 'host') || '127.0.0.1',
    port: optionalNumber(flags, 'port') ?? 0,
  })
  writeStdout({ url: board.local, share: board.share, host: board.host, port: board.port })
  await new Promise((done) => {
    const stop = () => {
      board.close().then(done)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
}

/** 登记的 run；窗口与筛选只影响输出，不删任何记录。 */
function runRuns(action, flags) {
  if (action === 'prune') {
    const days = optionalNumber(flags, 'older-than')
    const pruned = pruneRuns(days === undefined ? {} : { olderThanMs: days * 24 * 60 * 60 * 1000 })
    return pruned
  }
  if (action === 'forget') {
    return unregisterRun(requireFlag(flags, 'run-id'))
  }
  if (action === 'adopt') {
    const outDir = requireFlag(flags, 'out-dir')
    const adopted = adoptRun({ outDir, workdir: flag(flags, 'workdir') || process.cwd() })
    if (!adopted.adopted) {
      throw new CliError(`无法补登记 ${outDir}: ${adopted.reason}`, 2, 'ADOPT_FAILED')
    }
    return { runId: adopted.record.runId, record: adopted.record }
  }
  if (action !== 'list') throw new CliError(`unknown runs action: ${action}`, 2, 'UNKNOWN_ACTION')
  const days = optionalNumber(flags, 'days')
  const since = boolFlag(flags, 'all') || days === 0 || days === undefined
    ? 0
    : Date.now() - days * 24 * 60 * 60 * 1000
  const listed = listRuns({ since, includeFinished: !boolFlag(flags, 'alive') })
  return {
    dir: listed.dir,
    finished: listed.finished,
    crashed: listed.crashed,
    malformed: listed.malformed,
    runs: listed.runs.map((run) => ({
      runId: run.runId,
      workdir: run.workdir,
      outDir: run.outDir,
      labels: run.labels,
      alive: run.alive,
      outcome: run.outcome,
      crashed: run.crashed,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      elapsedMs: run.elapsedMs,
      progressFile: run.progressFile,
    })),
  }
}

async function runServe(flags) {
  const eventsFile = requireFlag(flags, 'events-file')
  const viewer = await createViewerServer({
    eventsFile,
    host: flag(flags, 'host') || '127.0.0.1',
    port: optionalNumber(flags, 'port') ?? 0,
  })
  writeStdout({ url: viewer.url, host: viewer.host, port: viewer.port, eventsFile: viewer.eventsFile })
  await new Promise((resolvePromise) => {
    const stop = () => {
      viewer.close().then(resolvePromise)
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  return { stopped: true }
}
export async function main(argv = process.argv.slice(2)) {
  const { positionals, flags } = parseArgs(argv, { boolean: BOOLEAN })
  if (boolFlag(flags, 'help') || boolFlag(flags, 'h') || positionals[0] === 'help') {
    process.stdout.write(HELP)
    return 0
  }
  const group = positionals[0]
  const action = positionals[1]
  if (!group) {
    process.stderr.write(HELP)
    return 2
  }
  try {
    const allowed = {
      'lease acquire': ['registry-dir', 'workdir', 'pid', 'label', 'steal-stale'],
      'lease status': ['registry-dir', 'workdir', 'pid'],
      'lease release': ['registry-dir', 'workdir', 'token', 'pid'],
      'lease recover': ['registry-dir', 'workdir'],
      'progress append': ['file', 'event', 'level', 't', 'data'],
      'progress read': ['file', 'after'],
      'config merge': ['file', 'output', 'show-secrets'],
      'config identity': ['workdir'],
      'checkpoint create': ['workdir', 'state', 'exclude'],
      'checkpoint status': ['state', 'workdir'],
      'checkpoint restore': ['state', 'workdir', 'clean-untracked', 'exclude'],
      serve: ['events-file', 'host', 'port'],
      'board ensure': ['host'],
      'board status': [],
      'board stop': [],
      'board serve': ['host', 'port'],
      'runs list': ['days', 'all', 'alive'],
      'runs adopt': ['out-dir', 'workdir'],
      'runs forget': ['run-id'],
      'runs prune': ['older-than'],
    }[group === 'serve' ? group : `${group} ${action}`]
    if (!allowed || positionals.length !== (group === 'serve' ? 1 : 2)) {
      throw new CliError('unknown command or extra positional arguments', 2, 'INVALID_ARG')
    }
    for (const [name, values] of Object.entries(flags)) {
      if (!allowed.includes(name)) throw new CliError(`unknown option --${name}`, 2, 'INVALID_ARG')
      if (values.length > 1 && name !== 'exclude' && !(name === 'file' && group === 'config')) {
        throw new CliError(`duplicate option --${name}`, 2, 'INVALID_ARG')
      }
    }
    if (group === 'serve') {
      await runServe(flags)
      return 0
    }
    if (group === 'board' && action === 'serve') {
      await runBoardServe(flags)
      return 0
    }
    let out
    if (group === 'lease') out = await runLease(action, flags)
    else if (group === 'progress') out = runProgress(action, flags)
    else if (group === 'board') out = await runBoard(action, flags)
    else if (group === 'runs') out = runRuns(action, flags)
    else if (group === 'config') out = runConfig(action, flags)
    else if (group === 'checkpoint') out = runCheckpoint(action, flags)
    else throw new CliError(`unknown command group: ${group}`, 2, 'UNKNOWN_ACTION')
    writeStdout(out)
    return out?.ok === false ? 1 : 0
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`error: ${err.message}\n`)
      return err.exitCode
    }
    process.stderr.write(`error: ${err && err.message ? err.message : String(err)}\n`)
    return 1
  }
}

if (isDirectMain(import.meta.url)) {
  main().then((code) => {
    process.exitCode = code
  })
}
