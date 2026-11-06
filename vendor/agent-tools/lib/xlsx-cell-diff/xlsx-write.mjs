import {
  childrenByLocal,
  firstByLocal,
  getAttr,
  localName,
  parseXml,
  qnamePrefix,
  removeAttr,
  serializeDocument,
  setAttr,
} from './xml.mjs'
import { formatA1, parseA1 } from './refs.mjs'
import { readZip, writeZip } from './zip.mjs'
import { displayText, isBlank } from './xlsx-read.mjs'

function q(prefix, name) {
  return prefix ? `${prefix}:${name}` : name
}

function rowNumber(row) {
  return Number.parseInt(getAttr(row, 'r') ?? '', 10)
}

function cellColumn(cell) {
  const ref = getAttr(cell, 'r')
  return ref ? parseA1(ref).column : 0
}

function getOrCreateRow(sheetData, rows, rowIndex, prefix) {
  if (rows.has(rowIndex)) return rows.get(rowIndex)
  const row = {
    type: 'elem',
    name: q(prefix, 'row'),
    attrs: [{ name: 'r', value: String(rowIndex) }],
    children: [],
    selfClosing: false,
  }
  const elems = sheetData.children
  let inserted = false
  for (let i = 0; i < elems.length; i++) {
    const child = elems[i]
    if (child.type === 'elem' && localName(child.name) === 'row' && rowNumber(child) > rowIndex) {
      elems.splice(i, 0, row)
      inserted = true
      break
    }
  }
  if (!inserted) elems.push(row)
  rows.set(rowIndex, row)
  return row
}

function insertCell(row, cell, columnIndex) {
  const elems = row.children
  for (let i = 0; i < elems.length; i++) {
    const child = elems[i]
    if (child.type === 'elem' && localName(child.name) === 'c' && cellColumn(child) > columnIndex) {
      elems.splice(i, 0, cell)
      return
    }
  }
  elems.push(cell)
}

function stripValueNodes(cell) {
  cell.children = cell.children.filter(
    (child) => child.type !== 'elem' || !['f', 'v', 'is'].includes(localName(child.name)),
  )
}

function tElement(prefix, value) {
  const attrs = []
  if (value.length > 0 && (/\s/.test(value[0]) || /\s/.test(value[value.length - 1]))) {
    attrs.push({ name: 'xml:space', value: 'preserve' })
  }
  return {
    type: 'elem',
    name: q(prefix, 't'),
    attrs,
    children: [{ type: 'text', text: value }],
    selfClosing: false,
  }
}

function applyCellValue(cell, value, prefix) {
  stripValueNodes(cell)
  if (isBlank(value)) {
    removeAttr(cell, 't')
    if (cell.children.length === 0) cell.selfClosing = true
    return
  }
  cell.selfClosing = false
  switch (value.kind) {
    case 'formula': {
      const text = value.text.startsWith('=') ? value.text.slice(1) : value.text
      removeAttr(cell, 't')
      cell.children.unshift({
        type: 'elem',
        name: q(prefix, 'f'),
        attrs: [],
        children: [{ type: 'text', text }],
        selfClosing: false,
      })
      break
    }
    case 'number':
      removeAttr(cell, 't')
      cell.children.push({
        type: 'elem',
        name: q(prefix, 'v'),
        attrs: [],
        children: [{ type: 'text', text: value.text }],
        selfClosing: false,
      })
      break
    case 'boolean':
      setAttr(cell, 't', 'b')
      cell.children.push({
        type: 'elem',
        name: q(prefix, 'v'),
        attrs: [],
        children: [{ type: 'text', text: /^(1|true|yes)$/i.test(value.text) ? '1' : '0' }],
        selfClosing: false,
      })
      break
    case 'error':
      setAttr(cell, 't', 'e')
      cell.children.push({
        type: 'elem',
        name: q(prefix, 'v'),
        attrs: [],
        children: [{ type: 'text', text: value.text }],
        selfClosing: false,
      })
      break
    default:
      setAttr(cell, 't', 'inlineStr')
      cell.children.push({
        type: 'elem',
        name: q(prefix, 'is'),
        attrs: [],
        children: [tElement(prefix, value.text)],
        selfClosing: false,
      })
      break
  }
}

function indexSheet(doc) {
  const sheetData = firstByLocal(doc.root, 'sheetData')
  if (!sheetData) throw new Error('Worksheet has no sheetData')
  const prefix = qnamePrefix(sheetData.name) || qnamePrefix(doc.root.name)
  const rows = new Map()
  const cells = new Map()
  for (const row of childrenByLocal(sheetData, 'row')) {
    const n = rowNumber(row)
    if (Number.isInteger(n)) rows.set(n, row)
    for (const cell of childrenByLocal(row, 'c')) {
      const ref = getAttr(cell, 'r')
      if (ref) cells.set(ref.toUpperCase(), cell)
    }
  }
  return { sheetData, prefix, rows, cells }
}

export function overlayWorkbook(localBuffer, patches) {
  const zip = readZip(localBuffer)
  const patched = new Map()
  const byPart = new Map()
  for (const patch of patches) {
    if (!byPart.has(patch.partName)) byPart.set(patch.partName, [])
    byPart.get(patch.partName).push(patch)
  }

  for (const [partName, partPatches] of byPart) {
    const entry = zip.byName.get(partName)
    if (!entry) throw new Error(`LOCAL is missing worksheet part: ${partName}`)
    const doc = parseXml(entry.uncompressed.toString('utf8'))
    const index = indexSheet(doc)
    for (const patch of partPatches) {
      if (displayText(patch.from) === displayText(patch.to)) continue
      const reference = formatA1(patch.row, patch.column)
      let cell = index.cells.get(reference.toUpperCase())
      if (!cell) {
        if (isBlank(patch.to)) continue
        const row = getOrCreateRow(index.sheetData, index.rows, patch.row, index.prefix)
        cell = {
          type: 'elem',
          name: q(index.prefix, 'c'),
          attrs: [{ name: 'r', value: reference }],
          children: [],
          selfClosing: true,
        }
        insertCell(row, cell, patch.column)
        index.cells.set(reference.toUpperCase(), cell)
      }
      applyCellValue(cell, patch.to, qnamePrefix(cell.name) || index.prefix)
    }
    patched.set(partName, Buffer.from(serializeDocument(doc), 'utf8'))
  }

  const parts = zip.entries.map((entry) => {
    if (patched.has(entry.name)) {
      return { name: entry.name, uncompressed: patched.get(entry.name) }
    }
    return entry
  })
  return writeZip(parts)
}
