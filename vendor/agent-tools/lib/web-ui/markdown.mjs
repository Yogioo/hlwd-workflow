/** 极简 markdown 与 HTML 转义。纯函数，Node 和浏览器共用。 */

const TICK = String.fromCharCode(96)

export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

const INLINE_CODE = new RegExp(`${TICK}([^${TICK}\\n]+)${TICK}`, 'g')

export function inlineM(text, opts = {}) {
  const tokens = []
  let out = esc(text)
  out = out.replace(INLINE_CODE, (_, code) => {
    tokens.push(code)
    return `@@C${tokens.length - 1}@@`
  })
  if (opts.images) out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img alt="$1" src="$2">')
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
  out = out.replace(/@@C(\d+)@@/g, (_, index) => `<code>${tokens[Number(index)]}</code>`)
  return out
}

/**
 * 标题/段落/列表/引用/分隔线/围栏代码 + 行内强调。
 * 不引外部依赖，因为页面要能离线打开；不开表格/图片语法，除非调用方要图片。
 */
export function md(src, opts = {}) {
  const text = String(src == null ? '' : src)
  if (!text.trim()) return ''
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const out = []
  let para = []
  let list = null
  let i = 0
  const fence = TICK + TICK + TICK

  const flush = () => {
    if (!para.length) return
    out.push(`<p>${inlineM(para.join(' '), opts)}</p>`)
    para = []
  }
  const closeList = () => {
    if (!list) return
    out.push(`</${list}>`)
    list = null
  }

  while (i < lines.length) {
    const line = lines[i]
    if (line.indexOf(fence) === 0) {
      closeList()
      flush()
      const buf = []
      i++
      while (i < lines.length && lines[i].indexOf(fence) !== 0) {
        buf.push(lines[i])
        i++
      }
      i++
      out.push(`<pre class="md-code"><code>${esc(buf.join('\n'))}</code></pre>`)
      continue
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      closeList()
      flush()
      const level = heading[1].length
      out.push(`<h${level}>${inlineM(heading[2], opts)}</h${level}>`)
      i++
      continue
    }
    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      flush()
      const want = /^\s*\d+[.)]\s+/.test(line) ? 'ol' : 'ul'
      if (list && list !== want) closeList()
      if (!list) {
        out.push(`<${want}>`)
        list = want
      }
      out.push(`<li>${inlineM(line.replace(/^\s*([-*+]|\d+[.)])\s+/, ''), opts)}</li>`)
      i++
      continue
    }
    if (/^\s*>\s?/.test(line)) {
      closeList()
      flush()
      out.push(`<blockquote>${inlineM(line.replace(/^\s*>\s?/, ''), opts)}</blockquote>`)
      i++
      continue
    }
    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      closeList()
      flush()
      out.push('<hr>')
      i++
      continue
    }
    if (!line.trim()) {
      closeList()
      flush()
      i++
      continue
    }
    para.push(line.trim())
    i++
  }
  closeList()
  flush()
  return out.join('\n')
}
