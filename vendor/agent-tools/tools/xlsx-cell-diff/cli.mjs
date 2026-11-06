import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT } from '../../lib/xlsx-cell-diff/exit-codes.mjs'
import { diffWorkbooks, threeWayWorkbooks } from '../../lib/xlsx-cell-diff/diff.mjs'
import { findGitRoot, gitChangedXlsx, gitShow, listUntrackedXlsx } from '../../lib/xlsx-cell-diff/git.mjs'
import { maybeSpill, renderConflicts, renderDiff, renderMerge, renderStatus } from '../../lib/xlsx-cell-diff/report.mjs'
import { alignedSheet } from '../../lib/xlsx-cell-diff/profile.mjs'
import { displayText, loadWorkbookFromBuffer, loadWorkbookFromPath } from '../../lib/xlsx-cell-diff/xlsx-read.mjs'
import { overlayWorkbook } from '../../lib/xlsx-cell-diff/xlsx-write.mjs'

const DEFAULT_SOURCE_DIR = 'LubanData/Datas'

export const USAGE = `xlsx-cell-diff — compare xlsx by cell display values

Usage:
  node cli.mjs status [options]
  node cli.mjs diff [options]
  node cli.mjs conflicts --base <file> --local <file> --remote <file> [options]
  node cli.mjs merge --base <file> --local <file> --remote <file> --out <file> [options]
  node cli.mjs --help

Inputs (pick one):
  --left <file> --right <file>     two workbook paths
  --commit <rev>                   rev vs its parent (status/diff)
  --range <a..b>                   git range (status/diff)
  (none)                           working tree vs HEAD

DigitDoor source scan:
  status/diff default to LubanData/Datas when that directory exists.
  --source-dir <dir> overrides it. --no-source-dir scans git xlsx as listed.

Profile:
  --profile auto|luban|none        default auto (Luban headers when present)
  --no-luban                       alias for --profile none

Filters:
  --workbook <name>                repeatable
  --sheet <name>                   repeatable
  --key <row-identity>             repeatable
  --column <name>                  repeatable

Output:
  --json                           machine-readable JSON
  --out <file>                     merge output path
  --resolve take-local|take-remote|<json-file>
  --limit <bytes>                  spill oversized reports (default 16000)

Exit codes:
  0 ok
  2 usage
  3 input / missing git object / unreadable xlsx
  4 remaining display-value conflicts
  5 structural merge refusal
`

class CliError extends Error {
  constructor(message, code) {
    super(message)
    this.code = code
  }
}

function posix(path) {
  return path.split(sep).join('/')
}

function parseArgs(argv) {
  const args = [...argv]
  const options = {
    command: null,
    help: false,
    json: false,
    left: null,
    right: null,
    base: null,
    local: null,
    remote: null,
    out: null,
    commit: null,
    range: null,
    sourceDir: null,
    noSourceDir: false,
    profile: 'auto',
    workbooks: [],
    sheets: [],
    keys: [],
    columns: [],
    resolve: null,
    limit: 16000,
    cwd: process.cwd(),
  }

  const take = (flag) => {
    if (!args.length) throw new CliError(`Option ${flag} requires a value`, EXIT.usage)
    return args.shift()
  }

  while (args.length) {
    const arg = args.shift()
    switch (arg) {
      case '-h':
      case '--help':
        options.help = true
        break
      case '--json':
        options.json = true
        break
      case '--left':
        options.left = take(arg)
        break
      case '--right':
        options.right = take(arg)
        break
      case '--base':
        options.base = take(arg)
        break
      case '--local':
        options.local = take(arg)
        break
      case '--remote':
        options.remote = take(arg)
        break
      case '--out':
        options.out = take(arg)
        break
      case '--commit':
        options.commit = take(arg)
        break
      case '--range':
        options.range = take(arg)
        break
      case '--source-dir':
        options.sourceDir = take(arg)
        break
      case '--no-source-dir':
        options.noSourceDir = true
        break
      case '--profile':
        options.profile = take(arg)
        break
      case '--no-luban':
        options.profile = 'none'
        break
      case '--workbook':
        options.workbooks.push(take(arg))
        break
      case '--sheet':
        options.sheets.push(take(arg))
        break
      case '--key':
        options.keys.push(take(arg))
        break
      case '--column':
        options.columns.push(take(arg))
        break
      case '--resolve':
        options.resolve = take(arg)
        break
      case '--limit':
        options.limit = Number(take(arg))
        break
      case '--cwd':
        options.cwd = take(arg)
        break
      default:
        if (arg.startsWith('-')) throw new CliError(`Unknown option: ${arg}`, EXIT.usage)
        if (options.command) throw new CliError(`Unexpected argument: ${arg}`, EXIT.usage)
        options.command = arg
        break
    }
  }

  if (!options.help && !options.command) {
    throw new CliError('Missing command. Use status, diff, conflicts, or merge.', EXIT.usage)
  }
  if (options.command && !['status', 'diff', 'conflicts', 'merge'].includes(options.command)) {
    throw new CliError(`Unknown command: ${options.command}`, EXIT.usage)
  }
  if (options.profile && !['auto', 'luban', 'none'].includes(options.profile)) {
    throw new CliError('--profile must be auto, luban, or none', EXIT.usage)
  }
  if (!Number.isFinite(options.limit) || options.limit < 0) {
    throw new CliError('--limit must be a non-negative number', EXIT.usage)
  }
  return options
}

function filtersOf(options) {
  return {
    workbooks: options.workbooks,
    sheets: options.sheets,
    keys: options.keys,
    columns: options.columns,
  }
}

function looksLikeDigitDoor(cwd) {
  return existsSync(join(cwd, DEFAULT_SOURCE_DIR))
}

function resolveSourceDir(options, cwd) {
  if (options.noSourceDir) return null
  if (options.sourceDir) return options.sourceDir.replaceAll('\\', '/')
  if (looksLikeDigitDoor(cwd)) return DEFAULT_SOURCE_DIR
  return null
}

function loadMaybe(path) {
  if (!path || !existsSync(path)) return null
  return loadWorkbookFromPath(path)
}

function loadBufferMaybe(buffer, label) {
  if (!buffer) return null
  return loadWorkbookFromBuffer(buffer, label)
}

function workbookName(path, root) {
  if (!path) return ''
  const abs = resolve(path)
  if (root) {
    const rel = posix(relative(root, abs))
    if (rel && !rel.startsWith('../')) return rel
  }
  return basename(abs)
}

function collectPathPair(options) {
  const left = resolve(options.cwd, options.left)
  const right = resolve(options.cwd, options.right)
  if (!existsSync(left) && !existsSync(right)) {
    throw new CliError(`Neither workbook exists:\n  ${left}\n  ${right}`, EXIT.input)
  }
  return [{
    workbook: workbookName(right, findGitRoot(options.cwd)),
    left: loadMaybe(left),
    right: loadMaybe(right),
    leftPath: existsSync(left) ? left : null,
    rightPath: existsSync(right) ? right : null,
  }]
}

function parseRange(range) {
  const match = /^(.*)\.\.(.*)$/.exec(range)
  if (!match) throw new CliError(`Invalid --range ${range}; expected a..b`, EXIT.usage)
  return { left: match[1] || 'HEAD', right: match[2] || 'HEAD' }
}

function collectGitPairs(options) {
  const cwd = resolve(options.cwd)
  const root = findGitRoot(cwd)
  if (!root) throw new CliError(`Not a git repository: ${cwd}`, EXIT.input)
  const sourceDir = resolveSourceDir(options, root)
  const names = new Set()

  let leftRev = 'HEAD'
  let rightRev = null

  if (options.commit) {
    leftRev = `${options.commit}^`
    rightRev = options.commit
    for (const name of gitChangedXlsx(root, `${options.commit}^..${options.commit}`, sourceDir)) {
      names.add(name)
    }
  } else if (options.range) {
    const parsed = parseRange(options.range)
    leftRev = parsed.left
    rightRev = parsed.right
    for (const name of gitChangedXlsx(root, options.range, sourceDir)) names.add(name)
  } else {
    leftRev = 'HEAD'
    rightRev = null
    for (const name of gitChangedXlsx(root, 'HEAD', sourceDir)) names.add(name)
    for (const name of listUntrackedXlsx(root, sourceDir)) names.add(name)
  }

  const filtered = [...names].filter((name) => {
    if (!options.workbooks.length) return true
    const base = basename(name)
    return options.workbooks.some((f) =>
      name.toLowerCase().includes(f.toLowerCase())
      || base.toLowerCase().includes(f.toLowerCase()),
    )
  })

  const pairs = []
  for (const name of filtered.sort()) {
    const abs = join(root, name)
    const leftBuf = gitShow(root, `${leftRev}:${name}`)
    const rightBuf = rightRev
      ? gitShow(root, `${rightRev}:${name}`)
      : (existsSync(abs) ? readFileSync(abs) : null)
    if (!leftBuf && !rightBuf) continue
    pairs.push({
      workbook: name,
      left: loadBufferMaybe(leftBuf, `${leftRev}:${name}`),
      right: loadBufferMaybe(rightBuf, rightRev ? `${rightRev}:${name}` : abs),
      leftPath: null,
      rightPath: rightRev ? null : (existsSync(abs) ? abs : null),
    })
  }
  return pairs
}

function collectPairs(options) {
  if ((options.left && !options.right) || (!options.left && options.right)) {
    throw new CliError('--left and --right must be used together', EXIT.usage)
  }
  if (options.left && options.right) return collectPathPair(options)
  return collectGitPairs(options)
}

function runStatusOrDiff(options) {
  const pairs = collectPairs(options)
  const results = pairs.map((pair) => {
    const diff = diffWorkbooks(pair.left, pair.right, {
      profile: options.profile,
      filters: filtersOf(options),
      workbookName: pair.workbook,
    })
    return { workbook: pair.workbook, ...diff }
  })
  const payload = options.command === 'status'
    ? {
        workbooks: results
          .filter((item) => item.cells.length || item.structural.length)
          .map((item) => ({
            workbook: item.workbook,
            cells: item.cells.length,
            structural: item.structural.length,
            rows: [...new Set(item.cells.map((cell) => cell.row).filter(Boolean))],
            sheets: [...new Set(item.cells.map((cell) => cell.sheet).filter(Boolean))],
            ...(item.warnings?.length ? { warnings: item.warnings } : {}),
          })),
      }
    : { results }
  const text = options.command === 'status' ? renderStatus(results) : renderDiff(results)
  return { payload, text, code: EXIT.ok }
}

function loadThree(options) {
  if (!options.base || !options.local || !options.remote) {
    throw new CliError('conflicts/merge require --base --local --remote', EXIT.usage)
  }
  const basePath = resolve(options.cwd, options.base)
  const localPath = resolve(options.cwd, options.local)
  const remotePath = resolve(options.cwd, options.remote)
  for (const path of [basePath, localPath, remotePath]) {
    if (!existsSync(path)) throw new CliError(`Missing workbook: ${path}`, EXIT.input)
  }
  return {
    basePath,
    localPath,
    remotePath,
    base: loadWorkbookFromPath(basePath),
    local: loadWorkbookFromPath(localPath),
    remote: loadWorkbookFromPath(remotePath),
    workbook: workbookName(localPath, findGitRoot(options.cwd)),
  }
}

function loadResolutions(options, conflicts) {
  if (!options.resolve) return new Map()
  if (options.resolve === 'take-local' || options.resolve === 'take-remote') {
    const map = new Map()
    for (const item of conflicts) {
      map.set(`${item.sheet}\t${item.row}\t${item.column}`, options.resolve)
    }
    return map
  }
  const path = resolve(options.cwd, options.resolve)
  if (!existsSync(path)) throw new CliError(`Missing resolutions file: ${path}`, EXIT.input)
  let data
  try {
    data = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new CliError(`Invalid resolutions JSON: ${error.message}`, EXIT.input)
  }
  const list = Array.isArray(data) ? data : data.resolutions
  if (!Array.isArray(list)) {
    throw new CliError('Resolutions JSON must be an array or {resolutions: [...]}', EXIT.usage)
  }
  const map = new Map()
  for (const item of list) {
    const key = `${item.sheet}\t${item.row}\t${item.column}`
    if (item.take != null) map.set(key, item.take)
    else if (item.value !== undefined) map.set(key, item.value)
    else map.set(key, item)
  }
  return map
}

function applyResolution(item, resolution) {
  if (resolution === 'take-local' || resolution === 'local' || resolution?.take === 'local') {
    return item.local
  }
  if (resolution === 'take-remote' || resolution === 'remote' || resolution?.take === 'remote') {
    return item.remote
  }
  if (typeof resolution === 'string') {
    return { text: resolution, kind: 'string', hasValue: resolution !== '' }
  }
  if (resolution && typeof resolution === 'object' && 'text' in resolution) return resolution
  if (resolution?.value) {
    return typeof resolution.value === 'string'
      ? { text: resolution.value, kind: 'string', hasValue: resolution.value !== '' }
      : resolution.value
  }
  return null
}

function locateLocalCell(local, sheetName, rowIdentity, columnName, profile) {
  const sheet = local.sheetsByName.get(sheetName)
  if (!sheet) return null
  const aligned = alignedSheet(sheet, profile)
  const row = aligned.rows.find((item) => item.identity === rowIdentity)
  const col = aligned.meta.columns.find((item) => item.name === columnName)
  if (!row || !col) return null
  return {
    partName: sheet.partName,
    row: row.row,
    column: col.column,
    from: row.cells.get(columnName) ?? { text: '', kind: 'string', hasValue: false },
  }
}

function runConflicts(options) {
  const three = loadThree(options)
  const result = threeWayWorkbooks(three.base, three.local, three.remote, {
    profile: options.profile,
    filters: filtersOf(options),
    workbookName: three.workbook,
  })
  const payload = { workbook: three.workbook, ...result }
  const appended = result.inserted.rows.length || result.inserted.columns.length
  return {
    payload,
    text: renderConflicts([payload]),
    code: result.structural.length || appended
      ? EXIT.structural
      : result.conflicts.length ? EXIT.conflict : EXIT.ok,
  }
}

function runMerge(options) {
  const three = loadThree(options)
  if (!options.out) throw new CliError('merge requires --out <file>', EXIT.usage)
  const result = threeWayWorkbooks(three.base, three.local, three.remote, {
    profile: options.profile,
    filters: filtersOf(options),
    workbookName: three.workbook,
  })
  // 行/列新增需要「插入行/列并复制样式」的写入能力；本 CLI 只做单元格 overlay，
  // 所以这里仍然拒绝，并由 DigitDoor 的 xlsx-merge（C#）接管。
  const appended = result.inserted.rows.length || result.inserted.columns.length
  if (result.structural.length || appended) {
    return {
      payload: { workbook: three.workbook, ...result },
      text: renderConflicts([{ workbook: three.workbook, ...result }]) + (appended
        ? '需要追加行/列：用 DigitDoor 的 LubanData/xlsx-merge.bat merge（本 CLI 不写结构变动）\n'
        : ''),
      code: EXIT.structural,
    }
  }

  const resolutions = loadResolutions(options, result.conflicts)
  const remaining = []
  const accepted = [...result.auto]
  for (const item of result.conflicts) {
    const key = `${item.sheet}\t${item.row}\t${item.column}`
    const resolution = resolutions.get(key)
    const value = resolution ? applyResolution(item, resolution) : null
    if (!value) remaining.push(item)
    else accepted.push({ ...item, value, take: resolution })
  }
  if (remaining.length) {
    const payload = { workbook: three.workbook, conflicts: remaining, auto: result.auto, structural: [] }
    return {
      payload,
      text: renderConflicts([payload]),
      code: EXIT.conflict,
    }
  }

  const patches = []
  for (const item of accepted) {
    if (displayText(item.local) === displayText(item.value)) continue
    const loc = locateLocalCell(three.local, item.sheet, item.row, item.column, options.profile)
    if (!loc) {
      throw new CliError(
        `Cannot overlay ${item.sheet} ${item.row} ${item.column} onto local template`,
        EXIT.structural,
      )
    }
    patches.push({
      partName: loc.partName,
      row: loc.row,
      column: loc.column,
      from: loc.from,
      to: item.value.hasValue === false
        ? { text: '', kind: 'string', hasValue: false }
        : item.value,
    })
  }

  const outPath = resolve(options.cwd, options.out)
  const buffer = overlayWorkbook(readFileSync(three.localPath), patches)
  writeFileSync(outPath, buffer)
  const payload = {
    workbook: three.workbook,
    out: outPath,
    patched: patches.length,
    auto: result.auto.length,
    accepted,
  }
  return { payload, text: renderMerge(payload), code: EXIT.ok }
}

export function run(argv, io = {}) {
  const stdout = io.stdout ?? ((text) => process.stdout.write(text))
  const stderr = io.stderr ?? ((text) => process.stderr.write(text))
  try {
    const options = parseArgs([...argv])
    if (options.help) {
      stdout(USAGE)
      return EXIT.ok
    }
    const result = options.command === 'status' || options.command === 'diff'
      ? runStatusOrDiff(options)
      : options.command === 'conflicts'
        ? runConflicts(options)
        : runMerge(options)
    const spilled = maybeSpill(result.text, result.payload, {
      json: options.json,
      limit: options.limit,
    })
    stdout(spilled.stdout)
    if (options.command === 'merge' || options.command === 'conflicts') return result.code
    return EXIT.ok
  } catch (error) {
    const code = error instanceof CliError ? error.code : EXIT.input
    stderr(`${error.message}\n`)
    return Number.isInteger(code) ? code : EXIT.input
  }
}

if (
  process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  process.exitCode = run(process.argv.slice(2))
}
