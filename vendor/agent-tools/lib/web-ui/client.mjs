/** 浏览器侧共用的渲染与 DOM 小工具。页面只组合，不重写。 */

import { esc, inlineM, md } from './markdown.mjs'
import { clock, dur, msText, project, rel } from './format.mjs'

export { clock, dur, esc, md, msText, project, rel }

const VERBS = {
  read: ['📖', '读'], write: ['📝', '写'], edit: ['✏️', '改'], bash: ['⚡', '命令'], shell: ['⚡', '命令'], run: ['⚡', '命令'],
  grep: ['🔍', '搜'], glob: ['🔍', '搜'], search: ['🔍', '搜'], find: ['🔍', '找'], list: ['📁', '列目录'], ls: ['📁', '列目录'],
  web_search: ['🌐', '搜网'], web_fetch: ['🌐', '取网页'], fetch_content: ['🌐', '取网页'], todo: ['☑', '待办'],
  task: ['🤖', '子代理'], agent: ['🤖', '子代理'], ask_user: ['❓', '问人'],
}

export function verbFor(name) {
  const key = String(name || 'tool')
  const hit = VERBS[key.toLowerCase()]
  if (hit) return hit
  if (key.indexOf('mcp__') === 0) return ['🔌', key.slice(5).replace(/__/g, '：')]
  const prefix = key.split('_')[0].toLowerCase()
  return VERBS[prefix] || ['⚙', key]
}

/** 一条规范化事件说成人话。列表页的「正在做什么」和时间线共用。 */
export function describeEvent(item) {
  if (!item) return { icon: '·', text: '等第一个事件', cls: 'dim' }
  if (item.kind === 'say') return { icon: '💬', text: String(item.text || ''), cls: 'say' }
  if (item.kind === 'think') return { icon: '🧠', text: String(item.text || ''), cls: 'think' }
  if (item.kind === 'tool') {
    const verb = verbFor(item.name)
    const rest = String(item.detail || '')
    return { icon: verb[0], text: verb[1] + (rest ? ` ${rest}` : ''), ms: item.ms, cls: 'tool' }
  }
  if (item.kind === 'tool_end') {
    return { icon: item.error ? '✕' : '✓', text: `${item.name || 'tool'} 结束`, ms: item.ms, cls: item.error ? 'bad' : 'tool' }
  }
  if (item.kind === 'arm_start') {
    return { icon: '▶', text: `开跑${item.text ? `　${item.text}` : ''}`, cls: 'dim' }
  }
  if (item.kind === 'arm_end') {
    let text = item.status === 'ok' ? '完成' : `结束（${item.status || '?'}）`
    if (item.reason) text += `：${item.reason}`
    if (item.tokens) text += `　${item.tokens} tok`
    return { icon: '■', text, cls: item.status === 'ok' ? 'ok' : 'bad' }
  }
  return { icon: item.icon || '·', text: String(item.text || ''), cls: 'dim' }
}

/**
 * 时间线行。`base` 是「起点+」的零点：看板传 run 开始时间，tapd 传第一条事件。
 * say/think 走 markdown；工具行保留纯文本，路径和命令里没有 markdown。
 */
export function timelineHtml(items, opts = {}) {
  const events = Array.isArray(items) ? items : []
  const base = Number(opts.base) || (events.length ? Number(events[0].t) || 0 : 0)
  if (!events.length) return '<div class="tl"><span></span><span></span><div class="act dim">还没有事件</div><span></span></div>'
  const out = []
  for (const item of events) {
    const view = describeEvent(item)
    const kind = item.kind === 'say' || item.kind === 'think' || item.kind === 'arm_start' || item.kind === 'arm_end'
      ? (item.kind === 'arm_start' || item.kind === 'arm_end' ? 'arm' : item.kind)
      : 'tool'
    // say/think 走 markdown，图标单独占一格，正文首行跟图标齐平（工具行本来就是一行）。
    const rich = view.cls === 'say' || view.cls === 'think'
    const body = rich
      ? `<div class="md">${md(view.text, { images: opts.images })}</div>`
      : esc(view.text)
    const offset = base ? Math.max(0, Number(item.t || 0) - base) : null
    const off = offset == null ? '' : offset < 1000 ? `${offset}ms` : dur(offset)
    out.push(
      `<div class="tl ${kind}" title="${esc(view.text)}">` +
      `<span class="dim">${clock(item.t)}</span>` +
      `<span class="dim">${off}</span>` +
      `<div class="act"><span class="ico">${esc(view.icon)}</span>${rich ? '' : ' '}${body}</div>` +
      `<span>${esc(msText(view.ms))}</span></div>`,
    )
  }
  return out.join('')
}

/** 点一下收起/展开长文本。 */
export function wireTimeline(root) {
  const rows = root.querySelectorAll('.tl.say>.act,.tl.think>.act')
  for (const row of rows) row.onclick = () => row.parentNode.classList.toggle('open')
}

export function paneHtml(key, title, body, open) {
  return `<details class="pane" data-pane="${esc(key)}"${open ? ' open' : ''}>` +
    `<summary>${title}</summary><div class="body">${body}</div></details>`
}

export function wirePanes(root, onChange) {
  for (const el of root.querySelectorAll('details.pane')) {
    el.addEventListener('toggle', () => onChange(el.getAttribute('data-pane'), el.open))
  }
}

/** 单列/双列 diff。`text` 是 `git diff` 的原文。 */
export function diffHtml(text, mode) {
  let lines = String(text || '').split('\n')
  if (lines.length > 4000) lines = lines.slice(0, 4000).concat(['... 已截断'])
  const out = ['<div class="diff">']
  if (mode === 'dual') {
    let i = 0
    while (i < lines.length) {
      const line = lines[i]
      if (line.indexOf('@@') === 0) {
        out.push(`<div class="drow"><span class="lctx">${esc(line)}</span><span class="rctx">${esc(line)}</span></div>`)
        i++
        continue
      }
      if (line.charAt(0) === '-' && line.indexOf('---') !== 0) {
        const dels = []
        const adds = []
        while (i < lines.length && lines[i].charAt(0) === '-' && lines[i].indexOf('---') !== 0) dels.push(lines[i++])
        while (i < lines.length && lines[i].charAt(0) === '+') adds.push(lines[i++])
        const n = Math.max(dels.length, adds.length)
        for (let j = 0; j < n; j++) {
          const l = dels[j] || ''
          const r = adds[j] || ''
          out.push(`<div class="drow"><span class="${l ? 'ldel' : 'lctx'}">${esc(l)}</span><span class="${r ? 'radd' : 'rctx'}">${esc(r)}</span></div>`)
        }
        continue
      }
      if (line.charAt(0) === '+') {
        out.push(`<div class="drow"><span class="lctx"></span><span class="radd">${esc(line)}</span></div>`)
        i++
        continue
      }
      out.push(`<div class="drow"><span class="lctx">${esc(line)}</span><span class="rctx">${esc(line)}</span></div>`)
      i++
    }
  } else {
    for (const line of lines) {
      let cls = 'dctx'
      if (line.indexOf('@@') === 0) cls = 'dhunk'
      else if (line.indexOf('diff --git') === 0 || line.indexOf('index ') === 0 || line.indexOf('---') === 0 || line.indexOf('+++') === 0) cls = 'dmeta'
      else if (line.charAt(0) === '+') cls = 'dadd'
      else if (line.charAt(0) === '-') cls = 'ddel'
      out.push(`<div class="dline ${cls}">${esc(line)}</div>`)
    }
  }
  out.push('</div>')
  return out.join('')
}

/**
 * 弹窗外壳的唯一接法：返回按钮退一层，Esc 也走同一条路（栈底时页面自己关），
 * 点弹窗外直接关。栈的语义留在页面里，这里只管把用户动作翻成回调。
 */
export function wireModal({ back, close = () => {} }) {
  const modal = document.getElementById('modal')
  if (!modal) return
  const backBtn = document.getElementById('mback')
  if (backBtn) backBtn.onclick = () => back()
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close()
  })
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') back()
  })
}

export function loadJson(key, fallback) {
  try {
    const saved = JSON.parse(localStorage.getItem(key) || 'null')
    return saved == null ? fallback : saved
  } catch {
    return fallback
  }
}

export function saveJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 隐私模式/配额满了都不该让页面挂掉
  }
}
