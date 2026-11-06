import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_LIMIT = 16_000

function quote(value) {
  const text = String(value ?? '')
  if (text === '') return '(empty)'
  if (/[\t\n\r|]/.test(text)) return JSON.stringify(text)
  return text
}

function cellKind(change) {
  return change.kind ?? 'changed'
}

function cellAddress(change) {
  return change.address || change.fromAddress || ''
}

function cellPath(item) {
  return item.path || (cellAddress(item) ? `@${cellAddress(item)}` : '')
}

export function formatCellLine(change) {
  const loc = cellPath(change)
  const prefix = loc ? `${change.column} ${loc}  ` : `${change.column}  `
  return `${prefix}${quote(change.old?.text)} -> ${quote(change.new?.text)}`
}

export function formatConflictLine(item) {
  const loc = cellPath(item)
  const prefix = loc ? `${item.column} ${loc}  ` : `${item.column}  `
  return `${prefix}local=${quote(item.local.text)}  remote=${quote(item.remote.text)}`
}

export function formatStructuralLine(item) {
  const bits = [item.kind]
  if (item.sheet) bits.push(item.sheet)
  if (item.row) bits.push(item.row)
  if (item.column) bits.push(item.column)
  if (item.excelRow) bits.push(`Excel row ${item.excelRow}`)
  return bits.join(' ')
}

function groupBy(items, keyFn) {
  const map = new Map()
  for (const item of items) {
    const key = keyFn(item)
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(item)
  }
  return map
}

function workbookOf(item) {
  return item.workbook || ''
}

function sheetOf(item) {
  return item.sheet || ''
}

function rowOf(item) {
  return item.row || ''
}

function summarizeKinds(cells) {
  const counts = { changed: 0, added: 0, removed: 0 }
  for (const cell of cells) {
    const kind = cellKind(cell)
    if (kind in counts) counts[kind]++
    else counts.changed++
  }
  const bits = []
  if (counts.changed) bits.push(`${counts.changed} changed`)
  if (counts.added) bits.push(`${counts.added} added`)
  if (counts.removed) bits.push(`${counts.removed} removed`)
  return bits.join(', ') || `${cells.length} cell`
}

function rowSet(cells) {
  return new Set(cells.map(rowOf).filter(Boolean))
}

function warningLines(results) {
  const warnings = [...new Set(results.flatMap((item) => item.warnings ?? []))]
  return warnings.map((warning) => `注意：${warning}`)
}

export function renderStatus(results) {
  const lines = [...warningLines(results)]
  const changed = results.filter((item) => item.cells.length || item.structural.length)
  if (!changed.length) {
    lines.push('No display-value changes.')
    return lines.join('\n') + '\n'
  }
  lines.push(`Changed workbooks (${changed.length})`)
  for (const item of changed) {
    const extra = []
    if (item.cells.length) extra.push(summarizeKinds(item.cells))
    if (item.structural.length) extra.push(`${item.structural.length} structural`)
    const rows = rowSet(item.cells)
    if (rows.size) extra.push(`${rows.size} row${rows.size === 1 ? '' : 's'}`)
    lines.push(`${item.workbook}`)
    lines.push(`  ${extra.join(', ')}`)
    const sheets = [...groupBy(item.cells, sheetOf)]
    for (const [sheet, sheetItems] of sheets) {
      if (!sheet) continue
      const keys = [...rowSet(sheetItems)].slice(0, 8)
      const more = rowSet(sheetItems).size - keys.length
      const keyText = keys.join(', ') + (more > 0 ? `, +${more} more` : '')
      lines.push(`  ${sheet}: ${keyText}`)
    }
    for (const structural of item.structural) {
      lines.push(`  ${formatStructuralLine(structural)}`)
    }
  }
  return lines.join('\n') + '\n'
}

function renderGrouped(results, {
  cellsKey = 'cells',
  title,
  formatLine,
  empty,
}) {
  const lines = []
  const cells = results.flatMap((item) => item[cellsKey] ?? [])
  const structural = results.flatMap((item) => item.structural ?? [])
  if (!cells.length && !structural.length) return empty

  if (structural.length) {
    lines.push(`Structural (${structural.length})`)
    const byBook = groupBy(structural, workbookOf)
    for (const [workbook, items] of byBook) {
      if (workbook) lines.push(`${workbook}`)
      for (const item of items) lines.push(`  ${formatStructuralLine(item)}`)
    }
  }

  if (cells.length) {
    const rows = rowSet(cells)
    lines.push(`${title} (${cells.length} cell${cells.length === 1 ? '' : 's'}, ${rows.size} row${rows.size === 1 ? '' : 's'})`)
    const byBook = groupBy(cells, workbookOf)
    for (const [workbook, bookItems] of byBook) {
      if (workbook) lines.push(`${workbook}`)
      const bySheet = groupBy(bookItems, sheetOf)
      for (const [sheet, sheetItems] of bySheet) {
        const rowCount = rowSet(sheetItems).size
        lines.push(`  ${sheet}  ${summarizeKinds(sheetItems)} in ${rowCount} row${rowCount === 1 ? '' : 's'}`)
        const byRow = groupBy(sheetItems, rowOf)
        for (const [row, rowItems] of byRow) {
          const excelRow = rowItems[0]?.excelRow
          const rowLabel = excelRow ? `${row}  (Excel row ${excelRow})` : row
          lines.push(`    ${rowLabel}`)
          for (const item of rowItems) {
            lines.push(`      ${formatLine(item)}`)
          }
        }
      }
    }
  }
  return lines.join('\n') + '\n'
}

function valueArrow(item) {
  const loc = cellPath(item)
  const prefix = loc ? `${item.column} ${loc}  ` : `${item.column}  `
  return `${prefix}${quote(item.old?.text)} -> ${quote(item.new?.text)}`
}

function conflictArrow(item) {
  const loc = cellPath(item)
  const prefix = loc ? `${item.column} ${loc}  ` : `${item.column}  `
  const take = item.take ? `  take=${item.take}` : ''
  return `${prefix}local=${quote(item.local.text)}  remote=${quote(item.remote.text)}${take}`
}

function autoArrow(item) {
  const loc = cellPath(item)
  const prefix = loc ? `${item.column} ${loc}  ` : `${item.column}  `
  const take = item.take || 'auto'
  return `${prefix}${quote(item.base?.text)} -> ${quote(item.value?.text)}  (${take})`
}

export function renderDiff(results) {
  const warnings = warningLines(results)
  const body = renderGrouped(results, {
    cellsKey: 'cells',
    title: 'Cells',
    formatLine: valueArrow,
    empty: 'No display-value changes.\n',
  })
  return warnings.length ? `${warnings.join('\n')}\n${body}` : body
}

export function renderConflicts(results) {
  const warnings = warningLines(results)
  const prefix = warnings.length ? `${warnings.join('\n')}\n` : ''
  const auto = results.flatMap((item) => item.auto ?? [])
  const conflicts = results.flatMap((item) => item.conflicts ?? [])
  const structural = results.flatMap((item) => item.structural ?? [])
  const insertedRows = results.flatMap((item) => item.inserted?.rows ?? [])
  const insertedColumns = results.flatMap((item) => item.inserted?.columns ?? [])
  if (!conflicts.length && !structural.length && !auto.length && !insertedRows.length && !insertedColumns.length) {
    return `${prefix}No conflicts.\n`
  }
  const appendLines = []
  if (insertedColumns.length) {
    appendLines.push(`Append columns (${insertedColumns.length})`)
    for (const item of insertedColumns) appendLines.push(`  ${item.sheet}  ${item.column}`)
  }
  if (insertedRows.length) {
    appendLines.push(`Append rows (${insertedRows.length})`)
    for (const item of insertedRows) appendLines.push(`  ${item.sheet}  ${item.row}`)
  }

  const parts = []
  if (structural.length || conflicts.length) {
    parts.push(renderGrouped(results, {
      cellsKey: 'conflicts',
      title: 'Conflicts',
      formatLine: conflictArrow,
      empty: '',
    }).replace(/\n$/, ''))
  }
  if (auto.length) {
    parts.push(renderGrouped(
      results.map((item) => ({ workbook: item.workbook, cells: item.auto ?? [], structural: [] })),
      {
        cellsKey: 'cells',
        title: 'Auto',
        formatLine: autoArrow,
        empty: '',
      },
    ).replace(/\n$/, ''))
  }
  if (appendLines.length) parts.push(appendLines.join('\n'))
  if (!conflicts.length && !structural.length && !insertedRows.length && !insertedColumns.length && auto.length) {
    return `${prefix}No conflicts.\n${parts[parts.length - 1]}\n`
  }
  return prefix + parts.filter(Boolean).join('\n') + '\n'
}

export function renderMerge(result) {
  const lines = [`Merged ${result.patched} cell(s) onto local template: ${result.out}`]
  const accepted = result.accepted ?? []
  if (!accepted.length) return `${lines[0]}\n`
  const grouped = renderGrouped(
    [{ workbook: result.workbook, cells: accepted, structural: [] }],
    {
      cellsKey: 'cells',
      title: 'Wrote',
      formatLine: (item) => {
        const loc = cellPath(item)
        const prefix = loc ? `${item.column} ${loc}  ` : `${item.column}  `
        const take = item.take ? `  (${item.take})` : ''
        return `${prefix}${quote(item.local?.text)} -> ${quote(item.value?.text)}${take}`
      },
      empty: '',
    },
  )
  return `${lines[0]}\n${grouped}`
}

export function maybeSpill(text, json, options = {}) {
  const limit = options.limit ?? DEFAULT_LIMIT
  const payload = options.json ? JSON.stringify(json, null, 2) + '\n' : text
  if (Buffer.byteLength(payload, 'utf8') <= limit) {
    return { stdout: payload, spilled: false }
  }
  const dir = options.outDir ?? tmpdir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, options.fileName ?? `xlsx-cell-diff-${Date.now()}.txt`)
  writeFileSync(file, payload)
  const summary = options.json
    ? JSON.stringify({ spilled: true, path: file, bytes: Buffer.byteLength(payload, 'utf8') }, null, 2) + '\n'
    : `Report too large; wrote ${file}\n`
  return { stdout: summary, spilled: true, path: file }
}

export { DEFAULT_LIMIT }
