import { formatA1 } from './refs.mjs'
import { alignedSheet } from './profile.mjs'
import { displayText, isBlank } from './xlsx-read.mjs'

function sameValue(a, b) {
  return displayText(a) === displayText(b)
}

function valuePayload(value) {
  if (isBlank(value)) return { text: '', kind: 'empty', hasValue: false }
  return { text: value.text, kind: value.kind, hasValue: true }
}

function officePath(sheet, address) {
  if (!sheet || !address) return undefined
  return `/${sheet}/${address}`
}

function matchFilter(filters, workbook, sheet, row, column) {
  if (filters.workbooks?.length) {
    const hay = `${workbook}`.replaceAll('\\', '/')
    const base = hay.split('/').pop()
    if (!filters.workbooks.some((f) => hay.toLowerCase().includes(f.toLowerCase()) || base.toLowerCase().includes(f.toLowerCase()))) {
      return false
    }
  }
  if (filters.sheets?.length && !filters.sheets.some((f) => sheet.toLowerCase() === f.toLowerCase())) {
    return false
  }
  if (filters.keys?.length && !filters.keys.some((f) => String(row) === f)) return false
  if (filters.columns?.length && !filters.columns.some((f) => String(column).toLowerCase() === f.toLowerCase())) {
    return false
  }
  return true
}

function columnUnion(left, right) {
  const names = []
  const seen = new Set()
  for (const source of [left, right]) {
    for (const col of source.meta.columns) {
      if (seen.has(col.name)) continue
      seen.add(col.name)
      names.push(col.name)
    }
  }
  return names
}

function collectRowIdentities(aligned) {
  const header = []
  const data = []
  const seenData = new Set()
  for (const row of aligned.rows) {
    if (row.row <= aligned.meta.headerEnd) {
      header.push(row.identity)
      continue
    }
    if (seenData.has(row.identity)) continue
    seenData.add(row.identity)
    data.push(row.identity)
  }
  return { header, data }
}

function findRow(aligned, identity, header) {
  if (header) return aligned.rows.find((row) => row.identity === identity && row.row <= aligned.meta.headerEnd)
  if (aligned.byKey.has(identity)) return aligned.byKey.get(identity)
  return aligned.rows.find((row) => row.identity === identity && row.row > aligned.meta.headerEnd)
}

function diffSheets(leftSheet, rightSheet, profileMode, workbook, filters, out) {
  const left = leftSheet ? alignedSheet(leftSheet, profileMode) : null
  const right = rightSheet ? alignedSheet(rightSheet, profileMode) : null
  const sheetName = leftSheet?.name ?? rightSheet?.name
  for (const side of [left, right]) {
    const reason = side?.meta.keyFallback
    if (reason) out.warnings.push(`${workbook} / ${sheetName}：${reason}`)
  }

  if (!leftSheet) {
    out.structural.push({
      kind: 'sheet-added',
      workbook,
      sheet: sheetName,
    })
    return
  }
  if (!rightSheet) {
    out.structural.push({
      kind: 'sheet-removed',
      workbook,
      sheet: sheetName,
    })
    return
  }

  const columns = columnUnion(left, right)
  const leftCols = new Set(left.meta.columns.map((c) => c.name))
  const rightCols = new Set(right.meta.columns.map((c) => c.name))
  for (const name of columns) {
    if (!leftCols.has(name)) {
      out.structural.push({ kind: 'column-added', workbook, sheet: sheetName, column: name })
    } else if (!rightCols.has(name)) {
      out.structural.push({ kind: 'column-removed', workbook, sheet: sheetName, column: name })
    }
  }

  const leftIds = collectRowIdentities(left)
  const rightIds = collectRowIdentities(right)
  const dataIds = [...new Set([...leftIds.data, ...rightIds.data])]
  const headerIds = [...new Set([...leftIds.header, ...rightIds.header])]

  const walk = (identities, header) => {
    for (const identity of identities) {
      const lrow = findRow(left, identity, header)
      const rrow = findRow(right, identity, header)
      if (!lrow && rrow) {
        out.structural.push({
          kind: 'row-added',
          workbook,
          sheet: sheetName,
          row: identity,
          excelRow: rrow.row,
        })
        continue
      }
      if (lrow && !rrow) {
        out.structural.push({
          kind: 'row-removed',
          workbook,
          sheet: sheetName,
          row: identity,
          excelRow: lrow.row,
        })
        continue
      }
      for (const column of columns) {
        if (!leftCols.has(column) || !rightCols.has(column)) continue
        if (!matchFilter(filters, workbook, sheetName, identity, column)) continue
        const lv = lrow.cells.get(column)
        const rv = rrow.cells.get(column)
        if (sameValue(lv, rv)) continue
        const lcol = left.meta.byName.get(column)
        const rcol = right.meta.byName.get(column)
        const fromAddress = lcol ? formatA1(lrow.row, lcol.column) : undefined
        const address = rcol ? formatA1(rrow.row, rcol.column) : fromAddress
        const change = {
          workbook,
          sheet: sheetName,
          row: identity,
          column,
          address,
          path: officePath(sheetName, address),
          excelRow: rrow.row,
          old: valuePayload(lv),
          new: valuePayload(rv),
        }
        if (fromAddress && fromAddress !== address) change.fromAddress = fromAddress
        change.kind = isBlank(lv) ? 'added' : isBlank(rv) ? 'removed' : 'changed'
        out.cells.push(change)
      }
    }
  }

  walk(headerIds, true)
  walk(dataIds, false)
}

function sheetOrder(workbook) {
  return workbook ? workbook.sheets.map((sheet) => sheet.name) : []
}

export function diffWorkbooks(left, right, options = {}) {
  const profileMode = options.profile ?? 'auto'
  const filters = options.filters ?? {}
  const workbook = options.workbookName ?? right?.sourcePath ?? left?.sourcePath ?? ''
  const out = { cells: [], structural: [], warnings: [] }

  if (!left && !right) return out
  if (!left) {
    out.structural.push({ kind: 'workbook-added', workbook })
    return out
  }
  if (!right) {
    out.structural.push({ kind: 'workbook-removed', workbook })
    return out
  }

  const names = [...new Set([...sheetOrder(left), ...sheetOrder(right)])]
  for (const name of names) {
    if (filters.sheets?.length && !filters.sheets.some((f) => name.toLowerCase() === f.toLowerCase())) {
      continue
    }
    diffSheets(
      left.sheetsByName.get(name),
      right.sheetsByName.get(name),
      profileMode,
      workbook,
      filters,
      out,
    )
  }
  out.warnings = [...new Set(out.warnings)]
  return out
}

function threeValue(base, local, remote) {
  const b = displayText(base)
  const l = displayText(local)
  const r = displayText(remote)
  if (l === r) {
    return { status: 'same', take: 'local', value: local ?? remote }
  }
  if (l === b) {
    return { status: 'auto', take: 'remote', value: remote }
  }
  if (r === b) {
    return { status: 'auto', take: 'local', value: local }
  }
  return { status: 'conflict', take: null, value: null, local, remote, base }
}

function indexCells(workbook, profileMode, warnings = []) {
  const map = new Map()
  if (!workbook) return map
  for (const sheet of workbook.sheets) {
    const aligned = alignedSheet(sheet, profileMode)
    if (aligned.meta.keyFallback) {
      const message = `${workbook.sourcePath || ''} / ${sheet.name}：${aligned.meta.keyFallback}`
      if (!warnings.includes(message)) warnings.push(message)
    }
    for (const row of aligned.rows) {
      for (const col of aligned.meta.columns) {
        const value = row.cells.get(col.name)
        map.set(`${sheet.name}\t${row.identity}\t${col.name}`, {
          sheet: sheet.name,
          row: row.identity,
          column: col.name,
          value,
          keyed: row.keyed,
          header: row.row <= aligned.meta.headerEnd,
          localRow: row.row,
          localColumn: col.column,
        })
      }
    }
  }
  return map
}

function collectStructuralThree(base, local, remote, profileMode, workbook, inserted) {
  const structural = []
  const names = [...new Set([
    ...sheetOrder(base),
    ...sheetOrder(local),
    ...sheetOrder(remote),
  ])]
  for (const name of names) {
    const b = base?.sheetsByName.get(name)
    const l = local?.sheetsByName.get(name)
    const r = remote?.sheetsByName.get(name)
    const present = [Boolean(b), Boolean(l), Boolean(r)]
    if (present.some(Boolean) && !present.every(Boolean)) {
      structural.push({ kind: 'sheet', workbook, sheet: name, base: Boolean(b), local: Boolean(l), remote: Boolean(r) })
      continue
    }
    if (!l || !r || !b) continue
    const ba = alignedSheet(b, profileMode)
    const la = alignedSheet(l, profileMode)
    const ra = alignedSheet(r, profileMode)
    const cols = new Set([
      ...ba.meta.columns.map((c) => c.name),
      ...la.meta.columns.map((c) => c.name),
      ...ra.meta.columns.map((c) => c.name),
    ])
    for (const col of cols) {
      const nameOf = (aligned) => Boolean(aligned.meta.byName.get(col))
      const inBase = nameOf(ba)
      const inLocal = nameOf(la)
      const inRemote = nameOf(ra)

      // base 有而某一方没：删字段，不自动裁决。
      if (inBase && (!inLocal || !inRemote)) {
        structural.push({ kind: 'column', workbook, sheet: name, column: col })
        continue
      }

      // 只有本地有（我方新增）或三方都有：不用管。
      if (inLocal || !inRemote) continue

      // 只有远端有且 base 没有：对方新增字段（本 CLI 只报，不写）。
      inserted.columns.push({ workbook, sheet: name, column: col })
    }

    // 表头行形状两边必须一致（表头没法追加）。
    const headerSet = (aligned) => new Set(
      aligned.rows.filter((row) => row.row <= aligned.meta.headerEnd).map((row) => row.identity),
    )
    const headerLocal = headerSet(la)
    const headerRemote = headerSet(ra)
    const headerSame = headerLocal.size === headerRemote.size
      && [...headerLocal].every((identity) => headerRemote.has(identity))
    if (!headerSame) {
      structural.push({ kind: 'row', workbook, sheet: name, row: 'header' })
      continue
    }

    const rows = new Set([
      ...ba.rows.map((row) => row.identity),
      ...la.rows.map((row) => row.identity),
      ...ra.rows.map((row) => row.identity),
    ])
    const baseIds = new Set(ba.rows.map((row) => row.identity))
    const localIds = new Set(la.rows.map((row) => row.identity))
    const remoteIds = new Set(ra.rows.map((row) => row.identity))
    for (const row of rows) {
      const inBase = baseIds.has(row)
      const inLocal = localIds.has(row)
      const inRemote = remoteIds.has(row)
      if (inLocal && inRemote) continue
      if (!inLocal && !inRemote) continue
      if (inRemote) {
        // base 有、本地没有：本地删了（或远端改了 key）→ 不自动裁决。
        if (inBase) structural.push({ kind: 'row', workbook, sheet: name, row })
        else inserted.rows.push({ workbook, sheet: name, row })
        continue
      }
      // 远端没有、本地有：远端删了就要人看；我方新增则保留。
      if (inBase) structural.push({ kind: 'row', workbook, sheet: name, row })
    }
  }
  return structural
}

export function threeWayWorkbooks(base, local, remote, options = {}) {
  const profileMode = options.profile ?? 'auto'
  const filters = options.filters ?? {}
  const workbook = options.workbookName ?? local?.sourcePath ?? ''
  const inserted = { rows: [], columns: [] }
  const structural = collectStructuralThree(base, local, remote, profileMode, workbook, inserted)
  const warnings = []
  const bMap = indexCells(base, profileMode, warnings)
  const lMap = indexCells(local, profileMode, warnings)
  const rMap = indexCells(remote, profileMode, warnings)
  const keys = new Set([...bMap.keys(), ...lMap.keys(), ...rMap.keys()])
  const auto = []
  const conflicts = []
  const insertedRows = new Set(inserted.rows.map((item) => `${item.sheet}\t${item.row}`))
  const insertedColumns = new Set(inserted.columns.map((item) => `${item.sheet}\t${item.column}`))

  for (const key of keys) {
    const sample = lMap.get(key) ?? rMap.get(key) ?? bMap.get(key)
    // 追加行/列由写盘方（C# xlsx-merge）整行/整列写入，不算逐格改动。
    if (insertedRows.has(`${sample.sheet}\t${sample.row}`)) continue
    if (insertedColumns.has(`${sample.sheet}\t${sample.column}`)) continue
    if (!matchFilter(filters, workbook, sample.sheet, sample.row, sample.column)) continue
    const decision = threeValue(bMap.get(key)?.value, lMap.get(key)?.value, rMap.get(key)?.value)
    const address = formatA1(sample.localRow, sample.localColumn)
    const item = {
      workbook,
      sheet: sample.sheet,
      row: sample.row,
      column: sample.column,
      address,
      path: officePath(sample.sheet, address),
      excelRow: sample.localRow,
      base: valuePayload(bMap.get(key)?.value),
      local: valuePayload(lMap.get(key)?.value),
      remote: valuePayload(rMap.get(key)?.value),
      take: decision.take,
      value: valuePayload(decision.value),
    }
    if (decision.status === 'conflict') conflicts.push(item)
    else if (decision.status === 'auto') auto.push(item)
  }

  return { auto, conflicts, structural, inserted, warnings }
}
