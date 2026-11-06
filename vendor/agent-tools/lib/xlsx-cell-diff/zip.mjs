import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib'

const SIG_LOCAL = 0x04034b50
const SIG_CENTRAL = 0x02014b50
const SIG_EOCD = 0x06054b50

function u16(buf, offset) {
  return buf.readUInt16LE(offset)
}

function u32(buf, offset) {
  return buf.readUInt32LE(offset)
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff)
  for (let i = buf.length - 22; i >= min; i--) {
    if (u32(buf, i) === SIG_EOCD) {
      const commentLen = u16(buf, i + 20)
      if (i + 22 + commentLen === buf.length) {
        return i
      }
    }
  }
  throw new Error('Not a zip archive: missing EOCD')
}

function normalizeName(name) {
  return name.replaceAll('\\', '/')
}

export function readZip(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  const eocd = findEocd(buf)
  const diskEntries = u16(buf, eocd + 8)
  const totalEntries = u16(buf, eocd + 10)
  const dirSize = u32(buf, eocd + 12)
  const dirOffset = u32(buf, eocd + 16)
  if (diskEntries === 0xffff || totalEntries === 0xffff || dirSize === 0xffffffff || dirOffset === 0xffffffff) {
    throw new Error('ZIP64 xlsx is not supported')
  }

  const entries = []
  let p = dirOffset
  for (let i = 0; i < totalEntries; i++) {
    if (u32(buf, p) !== SIG_CENTRAL) {
      throw new Error('Corrupt zip: expected central directory header')
    }
    const flags = u16(buf, p + 8)
    const method = u16(buf, p + 10)
    const crc = u32(buf, p + 16)
    const compressedSize = u32(buf, p + 20)
    const uncompressedSize = u32(buf, p + 24)
    const nameLen = u16(buf, p + 28)
    const extraLen = u16(buf, p + 30)
    const commentLen = u16(buf, p + 32)
    const localOffset = u32(buf, p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    p += 46 + nameLen + extraLen + commentLen

    if (u32(buf, localOffset) !== SIG_LOCAL) {
      throw new Error(`Corrupt zip: missing local header for ${name}`)
    }
    const localNameLen = u16(buf, localOffset + 26)
    const localExtraLen = u16(buf, localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const compressed = buf.subarray(dataStart, dataStart + compressedSize)
    let uncompressed
    if (method === 0) {
      uncompressed = Buffer.from(compressed)
    } else if (method === 8) {
      uncompressed = Buffer.from(inflateRawSync(compressed))
    } else {
      throw new Error(`Unsupported zip compression ${method} for ${name}`)
    }
    if (uncompressed.length !== uncompressedSize) {
      throw new Error(`Zip size mismatch for ${name}`)
    }
    if ((crc32(uncompressed) >>> 0) !== crc) {
      throw new Error(`Zip CRC mismatch for ${name}`)
    }
    void flags
    entries.push({
      name: normalizeName(name),
      method,
      crc,
      compressed: Buffer.from(compressed),
      uncompressed,
    })
  }

  return {
    entries,
    byName: new Map(entries.map((entry) => [entry.name, entry])),
  }
}

export function writeZip(parts) {
  const records = parts.map((part) => {
    const name = Buffer.from(normalizeName(part.name), 'utf8')
    const uncompressed = Buffer.isBuffer(part.uncompressed)
      ? part.uncompressed
      : Buffer.from(part.uncompressed)
    const reuse = part.compressed && part.method !== undefined && part.crc !== undefined
    const method = reuse ? part.method : 8
    const compressed = reuse ? part.compressed : deflateRawSync(uncompressed)
    const crc = reuse ? part.crc : crc32(uncompressed) >>> 0
    return { name, uncompressed, compressed, method, crc }
  })

  const localOffsets = []
  const chunks = []
  let offset = 0
  for (const record of records) {
    localOffsets.push(offset)
    const utf8 = 1 << 11
    const local = Buffer.alloc(30)
    local.writeUInt32LE(SIG_LOCAL, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(utf8, 6)
    local.writeUInt16LE(record.method, 8)
    local.writeUInt32LE(record.crc, 14)
    local.writeUInt32LE(record.compressed.length, 18)
    local.writeUInt32LE(record.uncompressed.length, 22)
    local.writeUInt16LE(record.name.length, 26)
    chunks.push(local, record.name, record.compressed)
    offset += 30 + record.name.length + record.compressed.length
  }

  const dirStart = offset
  records.forEach((record, index) => {
    const utf8 = 1 << 11
    const central = Buffer.alloc(46)
    central.writeUInt32LE(SIG_CENTRAL, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(utf8, 8)
    central.writeUInt16LE(record.method, 10)
    central.writeUInt32LE(record.crc, 16)
    central.writeUInt32LE(record.compressed.length, 20)
    central.writeUInt32LE(record.uncompressed.length, 24)
    central.writeUInt16LE(record.name.length, 28)
    central.writeUInt32LE(localOffsets[index], 42)
    chunks.push(central, record.name)
    offset += 46 + record.name.length
  })

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(SIG_EOCD, 0)
  eocd.writeUInt16LE(records.length, 8)
  eocd.writeUInt16LE(records.length, 10)
  eocd.writeUInt32LE(offset - dirStart, 12)
  eocd.writeUInt32LE(dirStart, 16)
  chunks.push(eocd)
  return Buffer.concat(chunks)
}
