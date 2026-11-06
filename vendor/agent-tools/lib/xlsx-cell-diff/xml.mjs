function isNameStart(ch) {
  return /[A-Za-z_:]/.test(ch)
}

function isNameChar(ch) {
  return /[A-Za-z0-9._:-]/.test(ch)
}

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/g, (match, ent) => {
    if (ent === 'amp') return '&'
    if (ent === 'lt') return '<'
    if (ent === 'gt') return '>'
    if (ent === 'quot') return '"'
    if (ent === 'apos') return "'"
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X'
        ? Number.parseInt(ent.slice(2), 16)
        : Number.parseInt(ent.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : match
    }
    return match
  })
}

export function encodeText(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

export function encodeAttr(text) {
  return encodeText(text).replaceAll('"', '&quot;')
}

export function localName(qname) {
  const i = qname.indexOf(':')
  return i === -1 ? qname : qname.slice(i + 1)
}

export function qnamePrefix(qname) {
  const i = qname.indexOf(':')
  return i === -1 ? '' : qname.slice(0, i)
}

function skipWs(s, i) {
  while (i < s.length && /\s/.test(s[i])) i++
  return i
}

function parseName(s, i) {
  if (!isNameStart(s[i])) {
    throw new Error(`Invalid XML name at ${i}`)
  }
  const start = i
  i++
  while (i < s.length && isNameChar(s[i])) i++
  return { name: s.slice(start, i), i }
}

function parseAttrs(s, i) {
  const attrs = []
  while (true) {
    i = skipWs(s, i)
    if (i >= s.length || s[i] === '/' || s[i] === '>') break
    const parsed = parseName(s, i)
    i = skipWs(s, parsed.i)
    if (s[i] !== '=') throw new Error(`Expected = after attribute ${parsed.name}`)
    i = skipWs(s, i + 1)
    const quote = s[i]
    if (quote !== '"' && quote !== "'") throw new Error('Expected quoted attribute')
    i++
    let value = ''
    while (i < s.length && s[i] !== quote) {
      value += s[i]
      i++
    }
    if (s[i] !== quote) throw new Error('Unterminated attribute')
    i++
    attrs.push({ name: parsed.name, value: decodeEntities(value) })
  }
  return { attrs, i }
}

function parseComment(s, i) {
  const end = s.indexOf('-->', i)
  if (end === -1) throw new Error('Unterminated comment')
  return { node: { type: 'comment', text: s.slice(i, end) }, i: end + 3 }
}

function parseCdata(s, i) {
  const end = s.indexOf(']]>', i)
  if (end === -1) throw new Error('Unterminated CDATA')
  return { node: { type: 'text', text: s.slice(i, end) }, i: end + 3 }
}

function parsePi(s, i) {
  const end = s.indexOf('?>', i)
  if (end === -1) throw new Error('Unterminated processing instruction')
  return { node: { type: 'pi', text: s.slice(i, end) }, i: end + 2 }
}

function parseDoctype(s, i) {
  const end = s.indexOf('>', i)
  if (end === -1) throw new Error('Unterminated doctype')
  return { node: { type: 'doctype', text: s.slice(i, end + 1) }, i: end + 1 }
}

function parseElement(s, i) {
  const parsedName = parseName(s, i)
  const parsedAttrs = parseAttrs(s, parsedName.i)
  i = parsedAttrs.i
  i = skipWs(s, i)
  if (s[i] === '/' && s[i + 1] === '>') {
    return {
      node: {
        type: 'elem',
        name: parsedName.name,
        attrs: parsedAttrs.attrs,
        children: [],
        selfClosing: true,
      },
      i: i + 2,
    }
  }
  if (s[i] !== '>') throw new Error(`Expected > after <${parsedName.name}`)
  i++
  const children = []
  const close = `</${parsedName.name}`
  while (i < s.length) {
    if (s.startsWith(close, i) && (s[i + close.length] === '>' || /\s/.test(s[i + close.length]))) {
      i += close.length
      i = skipWs(s, i)
      if (s[i] !== '>') throw new Error(`Expected > in closing tag ${parsedName.name}`)
      return {
        node: {
          type: 'elem',
          name: parsedName.name,
          attrs: parsedAttrs.attrs,
          children,
          selfClosing: false,
        },
        i: i + 1,
      }
    }
    if (s[i] === '<') {
      if (s.startsWith('<!--', i)) {
        const comment = parseComment(s, i + 4)
        children.push(comment.node)
        i = comment.i
      } else if (s.startsWith('<![CDATA[', i)) {
        const cdata = parseCdata(s, i + 9)
        children.push(cdata.node)
        i = cdata.i
      } else if (s.startsWith('<?', i)) {
        const pi = parsePi(s, i + 2)
        children.push(pi.node)
        i = pi.i
      } else if (s.startsWith('</', i)) {
        throw new Error(`Unexpected closing tag near ${s.slice(i, i + 32)}`)
      } else {
        const child = parseElement(s, i + 1)
        children.push(child.node)
        i = child.i
      }
    } else {
      const next = s.indexOf('<', i)
      const end = next === -1 ? s.length : next
      children.push({ type: 'text', text: decodeEntities(s.slice(i, end)) })
      i = end
    }
  }
  throw new Error(`Unterminated element ${parsedName.name}`)
}

export function parseXml(input) {
  const s = String(input).replace(/^\uFEFF/, '')
  let i = 0
  let decl = null
  const children = []
  i = skipWs(s, i)
  if (s.startsWith('<?xml', i)) {
    const end = s.indexOf('?>', i)
    if (end === -1) throw new Error('Unterminated XML declaration')
    decl = s.slice(i, end + 2)
    i = skipWs(s, end + 2)
  }
  while (i < s.length) {
    if (s.startsWith('<!--', i)) {
      const comment = parseComment(s, i + 4)
      children.push(comment.node)
      i = skipWs(s, comment.i)
    } else if (s.startsWith('<?', i)) {
      const pi = parsePi(s, i + 2)
      children.push(pi.node)
      i = skipWs(s, pi.i)
    } else if (s.startsWith('<!DOCTYPE', i) || s.startsWith('<!doctype', i)) {
      const doc = parseDoctype(s, i)
      children.push(doc.node)
      i = skipWs(s, doc.i)
    } else if (s[i] === '<') {
      const el = parseElement(s, i + 1)
      children.push(el.node)
      i = skipWs(s, el.i)
    } else if (/\s/.test(s[i])) {
      i = skipWs(s, i)
    } else {
      throw new Error(`Unexpected XML content at ${i}`)
    }
  }
  const root = children.find((node) => node.type === 'elem')
  if (!root) throw new Error('XML has no root element')
  return { decl, children, root }
}

export function getAttr(el, name) {
  const local = localName(name)
  const hit = el.attrs.find((attr) => attr.name === name || localName(attr.name) === local)
  return hit ? hit.value : undefined
}

export function setAttr(el, name, value) {
  const local = localName(name)
  const hit = el.attrs.find((attr) => attr.name === name || localName(attr.name) === local)
  if (hit) hit.value = String(value)
  else el.attrs.push({ name, value: String(value) })
}

export function removeAttr(el, name) {
  const local = localName(name)
  el.attrs = el.attrs.filter((attr) => attr.name !== name && localName(attr.name) !== local)
}

export function* walk(node) {
  if (node.type !== 'elem') return
  yield node
  for (const child of node.children) {
    if (child.type === 'elem') yield* walk(child)
  }
}

export function childrenByLocal(el, name) {
  return el.children.filter((child) => child.type === 'elem' && localName(child.name) === name)
}

export function firstByLocal(el, name) {
  return childrenByLocal(el, name)[0]
}

export function descendantsByLocal(el, name) {
  const out = []
  for (const node of walk(el)) {
    if (node !== el && localName(node.name) === name) out.push(node)
  }
  return out
}

export function textContent(el) {
  let text = ''
  const visit = (node) => {
    if (node.type === 'text') text += node.text
    else if (node.type === 'elem') node.children.forEach(visit)
  }
  visit(el)
  return text
}

export function elem(name, attrs = [], children = []) {
  return {
    type: 'elem',
    name,
    attrs: attrs.map((attr) =>
      Array.isArray(attr) ? { name: attr[0], value: String(attr[1]) } : { ...attr },
    ),
    children,
    selfClosing: children.length === 0,
  }
}

export function text(value) {
  return { type: 'text', text: String(value) }
}

export function serializeXml(doc) {
  const parts = []
  if (doc.decl) parts.push(doc.decl)
  const write = (node) => {
    if (node.type === 'text') {
      parts.push(encodeText(node.text))
      return
    }
    if (node.type === 'comment') {
      parts.push(`<!--${node.text}-->`)
      return
    }
    if (node.type === 'pi') {
      parts.push(`<?${node.text}?>`)
      return
    }
    if (node.type === 'doctype') {
      parts.push(node.text)
      return
    }
    const attrText = node.attrs
      .map((attr) => ` ${attr.name}="${encodeAttr(attr.value)}"`)
      .join('')
    if (node.selfClosing && node.children.length === 0) {
      parts.push(`<${node.name}${attrText}/>`)
      return
    }
    parts.push(`<${node.name}${attrText}>`)
    node.children.forEach(write)
    parts.push(`</${node.name}>`)
  }
  doc.children.forEach(write)
  return parts.join('')
}

export function serializeDocument(doc) {
  const xml = serializeXml(doc)
  return xml.startsWith('<?xml') ? xml : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${xml}`
}
