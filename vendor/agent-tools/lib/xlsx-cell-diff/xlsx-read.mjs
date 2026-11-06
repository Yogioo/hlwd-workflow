import { readFileSync } from 'node:fs'
import { parseA1, formatA1 } from './refs.mjs'
import {
  childrenByLocal,
  descendantsByLocal,
  firstByLocal,
  getAttr,
  parseXml,
  textContent,
} from './xml.mjs'
import { readZip } from './zip.mjs'

function part(zip, name) {
  return zip.byName.get(name.replaceAll('\\', '/'))
}

function xmlPart(zip, name) {
  const entry = part(zip, name)
  if (!entry) throw new Error(`Missing xlsx part: ${name}`)
  return parseXml(entry.uncompressed.toString('utf8'))
}

function normalizePartName(sourcePartName, target) {
  if (!target) throw new Error(`Empty relationship target from ${sourcePartName}`)
  const raw = target.replaceAll('\\', '/')
  const joined = raw.startsWith('/')
    ? raw.replace(/^\/+/, '')
    : `${sourcePartName.slice(0, Math.max(0, sourcePartName.lastIndexOf('/')))}/${raw}`
  const parts = []
  for (const piece of joined.split('/')) {
    if (!piece || piece === '.') continue
    if (piece === '..') parts.pop()
    else parts.push(piece)
  }
  return parts.join('/')
}

function readSharedStrings(zip) {
  const entry = part(zip, 'xl/sharedStrings.xml')
  if (!entry) return []
  const doc = parseXml(entry.uncompressed.toString('utf8'))
  return childrenByLocal(doc.root, 'si').map((si) =>
    descendantsByLocal(si, 't').map((t) => textContent(t)).join(''),
  )
}

function readCellValue(cell, sharedStrings) {
  const formula = firstByLocal(cell, 'f')
  const formulaText = formula ? textContent(formula) : ''
  if (formulaText) {
    return { text: `=${formulaText}`, kind: 'formula', hasValue: true }
  }

  const type = getAttr(cell, 't') ?? ''
  if (type === 'inlineStr') {
    const inline = firstByLocal(cell, 'is')
    if (!inline) return { text: '', kind: 'string', hasValue: false }
    const text = descendantsByLocal(inline, 't').map((t) => textContent(t)).join('')
    return { text, kind: 'string', hasValue: text.length > 0 }
  }

  const valueEl = firstByLocal(cell, 'v')
  if (!valueEl) return { text: '', kind: 'string', hasValue: false }
  const raw = textContent(valueEl)
  if (type === 's') {
    const index = Number.parseInt(raw, 10)
    const text = Number.isInteger(index) && index >= 0 && index < sharedStrings.length
      ? sharedStrings[index]
      : ''
    return { text, kind: 'string', hasValue: text.length > 0 }
  }
  if (type === 'b') return { text: raw, kind: 'boolean', hasValue: true }
  if (type === 'e') return { text: raw, kind: 'error', hasValue: true }
  if (type === 'str') return { text: raw, kind: 'string', hasValue: raw.length > 0 }
  return { text: raw, kind: 'number', hasValue: raw.length > 0 }
}

export function displayText(value) {
  return value?.hasValue ? value.text : ''
}

export function isBlank(value) {
  return displayText(value) === ''
}

function readSheetCells(sheetDoc, sharedStrings) {
  const cells = new Map()
  let maxRow = 0
  let maxColumn = 0
  const sheetData = firstByLocal(sheetDoc.root, 'sheetData')
  if (!sheetData) return { cells, maxRow, maxColumn }

  for (const row of childrenByLocal(sheetData, 'row')) {
    const rowNumber = Number.parseInt(getAttr(row, 'r') ?? '', 10)
    let inferredCol = 1
    for (const cell of childrenByLocal(row, 'c')) {
      const refAttr = getAttr(cell, 'r')
      let rowIndex = rowNumber
      let columnIndex
      if (refAttr) {
        const parsed = parseA1(refAttr)
        rowIndex = parsed.row
        columnIndex = parsed.column
        inferredCol = columnIndex + 1
      } else {
        if (!Number.isInteger(rowIndex) || rowIndex < 1) continue
        columnIndex = inferredCol
        inferredCol++
      }
      const reference = formatA1(rowIndex, columnIndex)
      const value = readCellValue(cell, sharedStrings)
      if (!isBlank(value)) {
        cells.set(reference, value)
        maxRow = Math.max(maxRow, rowIndex)
        maxColumn = Math.max(maxColumn, columnIndex)
      }
    }
  }
  return { cells, maxRow, maxColumn }
}

export function loadWorkbookFromBuffer(buffer, sourcePath = '') {
  let zip
  try {
    zip = readZip(buffer)
  } catch (error) {
    throw new Error(`Cannot read xlsx ${sourcePath || '(buffer)'}: ${error.message}`)
  }

  const workbookDoc = xmlPart(zip, 'xl/workbook.xml')
  const relsDoc = xmlPart(zip, 'xl/_rels/workbook.xml.rels')
  const relById = new Map()
  for (const rel of childrenByLocal(relsDoc.root, 'Relationship')) {
    const id = getAttr(rel, 'Id')
    const target = getAttr(rel, 'Target')
    if (id && target) {
      relById.set(id, normalizePartName('xl/workbook.xml', target))
    }
  }

  const sharedStrings = readSharedStrings(zip)
  const sheetsEl = firstByLocal(workbookDoc.root, 'sheets')
  if (!sheetsEl) throw new Error(`Workbook has no sheets: ${sourcePath}`)

  const sheets = []
  for (const sheetEl of childrenByLocal(sheetsEl, 'sheet')) {
    const name = getAttr(sheetEl, 'name')
    if (!name) throw new Error(`Workbook sheet has no name: ${sourcePath}`)
    const relId = getAttr(sheetEl, 'id') ?? getAttr(sheetEl, 'r:id')
    if (!relId || !relById.has(relId)) {
      throw new Error(`Workbook sheet has unknown relationship: ${name}`)
    }
    const partName = relById.get(relId)
    const sheetDoc = xmlPart(zip, partName)
    const { cells, maxRow, maxColumn } = readSheetCells(sheetDoc, sharedStrings)
    sheets.push({
      name,
      partName,
      state: getAttr(sheetEl, 'state') ?? 'visible',
      cells,
      maxRow,
      maxColumn,
    })
  }

  return {
    sourcePath,
    sheets,
    sheetsByName: new Map(sheets.map((sheet) => [sheet.name, sheet])),
    zip,
  }
}

export function loadWorkbookFromPath(path) {
  let buf
  try {
    buf = readFileSync(path)
  } catch (error) {
    throw new Error(`Cannot read xlsx ${path}: ${error.message}`)
  }
  return loadWorkbookFromBuffer(buf, path)
}
