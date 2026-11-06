/** 时间和路径的显示格式。纯函数，Node 和浏览器共用。 */

export function dur(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${s % 60}s` : `${s}s`
}

export function clock(t) {
  if (!t) return ''
  const d = new Date(t)
  const p = (n) => (n < 10 ? '0' : '') + n
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function rel(t) {
  if (!t) return ''
  const s = Math.round((Date.now() - t) / 1000)
  return s < 2 ? '刚刚' : s < 60 ? `${s} 秒前` : `${dur(s * 1000)}前`
}

/** 21.4 秒的构建别写成 21400ms。 */
export function msText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  return ms < 1000 ? `${ms}ms` : `${Math.round(ms / 100) / 10}s`
}

/** 路径末段。两种分隔符都认，且不把反斜杠写进正则。 */
export function project(path) {
  const s = String(path || '')
  const parts = []
  let cur = ''
  for (const c of s) {
    if (c === '/' || c === '\\') {
      if (cur) {
        parts.push(cur)
        cur = ''
      }
    } else {
      cur += c
    }
  }
  if (cur) parts.push(cur)
  return parts.length ? parts[parts.length - 1] : s
}
