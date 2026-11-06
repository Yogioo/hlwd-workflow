export function parseA1(reference) {
  const match = /^([A-Za-z]+)(\d+)$/.exec(String(reference).trim())
  if (!match) throw new Error(`Invalid Excel cell reference: ${reference}`)
  const row = Number(match[2])
  if (row < 1) throw new Error(`Invalid Excel cell reference: ${reference}`)
  let column = 0
  for (const ch of match[1].toUpperCase()) {
    column = column * 26 + (ch.charCodeAt(0) - 64)
  }
  return { row, column }
}

export function formatA1(row, column) {
  if (row < 1 || column < 1) throw new Error('Excel row/column must be >= 1')
  let n = column
  let letters = ''
  while (n > 0) {
    n--
    letters = String.fromCharCode(65 + (n % 26)) + letters
    n = Math.floor(n / 26)
  }
  return `${letters}${row}`
}

export function columnLetters(column) {
  return formatA1(1, column).replace(/\d+$/, '')
}
