/**
 * agent runs 看板页面。只管 run 行、导航栈和深链；渲染积木来自 /assets/client.mjs。
 *
 * 详情是一个覆盖层弹窗（和 tapd-loop 同一套外壳），栈底是 run，往上叠子代理。
 * 从前详情是在表格下方整页展开的，那样每看一个 run 就把表推走一屏，也回不到上一手。
 */

import {
  describeEvent, dur, esc, loadJson, md, msText, paneHtml, project, rel, saveJson,
  timelineHtml, wireModal, wirePanes, wireTimeline,
} from '/assets/client.mjs'
import { fromProgress, fromProgressEvent } from '/assets/events.mjs'

const rowsEl = document.getElementById('rows')
const meta = document.getElementById('meta')
const warn = document.getElementById('warn')
const modalEl = document.getElementById('modal')
const mhead = document.getElementById('mhead')
const mbody = document.getElementById('mbody')
const mbackEl = document.getElementById('mback')

/** 导航栈：栈底永远是 run，往上叠子代理；栈空 = 弹窗关着。 */
let stack = []
/** 列表快照，用于头部用时每秒自走，不额外请求。 */
let liveRuns = []
/** 弹窗里那个 run 的详情快照：深链到窗口外的旧 run 时列表里没有它。 */
let openRun = null
/** 深链只在第一轮生效：run 得先出现在窗口里才点得开。 */
let pendingDeep = null

let view = { days: 7, onlyAlive: false }
const savedView = loadJson('agent-runs-view', null)
if (savedView && typeof savedView.days === 'number') view = { days: savedView.days, onlyAlive: !!savedView.onlyAlive }
const saveView = () => saveJson('agent-runs-view', view)

let openPanes = loadJson('agent-runs-inputs', {})
const savePanes = () => saveJson('agent-runs-inputs', openPanes)

let autoscroll = true
try { if (localStorage.getItem('agent-runs-autoscroll') === '0') autoscroll = false } catch {}
const saveAutoscroll = () => {
  try { localStorage.setItem('agent-runs-autoscroll', autoscroll ? '1' : '0') } catch {}
}

const scrollMemo = {}
/** runId / `runId|臂名` -> 上次画出来的签名，签名没变就不重画（否则每 2 秒重置滚动）。 */
const painted = {}
const armPainted = {}

/** 切层时必须让目标那层重画：签名缓存挡的是「同一层内容没变」，不是切回来。 */
function forgetPaint() {
  for (const key of Object.keys(painted)) delete painted[key]
  for (const key of Object.keys(armPainted)) delete armPainted[key]
}

try {
  const params = new URLSearchParams(location.search)
  const runId = params.get('run')
  if (runId) pendingDeep = { runId, arm: params.get('arm') }
} catch {}

function query() {
  return `days=${view.days}${view.onlyAlive ? '&alive=1' : ''}`
}

function runById(runId) {
  return liveRuns.find((run) => run.runId === runId) || null
}

function elapsedOf(run) {
  return dur(run.elapsedMs + (run.alive ? Date.now() - run._at : 0))
}

function promptText(input) {
  const text = String(input.prompt || '')
  const wrapped = text.match(/^<file name="[^"]*">\s*/)
  return wrapped ? text.slice(wrapped[0].length) : text
}

function armLine(arms) {
  if (!arms || !arms.length) return ''
  const seen = new Set()
  const out = []
  for (const arm of arms) {
    const bits = [arm.runner, arm.model, arm.thinking ? `thinking ${arm.thinking}` : ''].filter(Boolean).join(' · ')
    if (bits && !seen.has(bits)) {
      seen.add(bits)
      out.push(bits)
    }
  }
  if (!out.length) return ''
  return out.slice(0, 2).join(' ／ ') + (out.length > 2 ? ` 等 ${out.length} 种` : '')
}

function statusOf(run) {
  if (run.alive) return '<span class="ok">运行中</span>'
  if (run.crashed) return '<span class="bad">中断</span>'
  if (run.outcome === 'ok') return '<span class="ok">完成</span>'
  if (run.outcome === 'failed' || run.outcome === 'error') return '<span class="bad">失败</span>'
  return '<span class="dim">已结束</span>'
}

/** 头部「用时」和列表行共用同一份快照，所以每秒只动这几处文本。 */
function paintElapsed() {
  for (const tr of rowsEl.querySelectorAll('tr.run')) {
    const cell = tr.querySelector('td.el')
    if (tr._run && cell) cell.textContent = elapsedOf(tr._run)
  }
  const el = document.getElementById('d-elapsed')
  const run = stack.length ? (runById(stack[0].runId) || openRun) : null
  if (!el || !run) return
  el.textContent = (run.alive ? '已跑 ' : '用时 ') + elapsedOf(run)
}

function wireAutoscroll(runId) {
  const box = document.getElementById('tllist')
  if (!box) return
  const checkbox = document.getElementById('autoscroll')
  if (checkbox) {
    checkbox.checked = autoscroll
    checkbox.onchange = () => {
      autoscroll = checkbox.checked
      saveAutoscroll()
      if (autoscroll) box.scrollTop = box.scrollHeight
    }
  }
  box.onscroll = () => { scrollMemo[runId] = box.scrollTop }
  if (autoscroll) box.scrollTop = box.scrollHeight
  else if (scrollMemo[runId] != null) box.scrollTop = scrollMemo[runId]
}

/** 地址栏跟栈走：`?run=` 是栈底，`?arm=` 是栈顶那层子代理；栈空就回到干净地址。 */
function pushUrl() {
  const top = stack[stack.length - 1]
  let url = location.pathname
  if (top) {
    url += `?run=${encodeURIComponent(stack[0].runId)}`
    if (top.type === 'arm') url += `&arm=${encodeURIComponent(top.name)}`
  }
  try { history.replaceState(null, '', url) } catch {}
}

function open(runId) {
  stack = [{ type: 'run', runId }]
  forgetPaint()
  pushUrl()
  refresh()
  poll()
}

function openArm(name) {
  if (!stack.length) return
  const top = stack[stack.length - 1]
  if (top.type === 'arm' && top.name === name) return
  stack.push({ type: 'arm', name })
  forgetPaint()
  pushUrl()
  refresh()
}

function back() {
  if (!stack.length) return
  stack.pop()
  forgetPaint()
  if (!stack.length) {
    closeModal()
    return
  }
  pushUrl()
  refresh()
}

function closeModal() {
  stack = []
  openRun = null
  if (!modalEl) return
  // 清空加清缓存：关掉再打开同一个 run 要重画，否则签名没变会画不出东西。
  forgetPaint()
  mhead.innerHTML = ''
  mbody.innerHTML = ''
  modalEl.classList.remove('on')
  pushUrl()
}

function refresh() {
  // 常驻进程若还发着旧骨架（没有 #modal），点卡片只会白点一场：宁可把话说在页面上。
  if (!modalEl) return
  const top = stack[stack.length - 1]
  mbackEl.style.display = stack.length > 1 ? 'inline-block' : 'none'
  if (!top) {
    modalEl.classList.remove('on')
    return
  }
  modalEl.classList.add('on')
  if (top.type === 'run') loadRun(top)
  else loadArm(top)
}

function row(run) {
  const tr = document.createElement('tr')
  const opened = stack.length > 0 && stack[0].runId === run.runId
  tr.className = `run${run.alive ? '' : ' stale'}${opened ? ' sel' : ''}`
  run._at = Date.now()
  const now = describeEvent(fromProgressEvent(run.lastEvent))
  const label = run.labels && run.labels.length ? run.labels.join(',') : '—'
  const arms = armLine(run.arms)
  tr.innerHTML = `<td>${esc(project(run.workdir))}</td>` +
    `<td><div>${esc(label)}</div>${arms ? `<div class="dim" style="font-size:11px">${esc(arms)}</div>` : ''}</td>` +
    `<td><div class="what" title="${esc(now.text)}">${now.icon} ${esc(now.text)}` +
    `${typeof now.ms === 'number' ? ` <span class="dim">${esc(msText(now.ms))}</span>` : ''}</div>` +
    `<div class="dim" style="font-size:11px">${esc(rel(run.lastEvent && run.lastEvent.t || run.startedAt))}</div></td>` +
    '<td class="el"></td>' +
    `<td>${statusOf(run)}</td>`
  tr.onclick = () => open(run.runId)
  tr._run = run
  return tr
}

function render() {
  rowsEl.innerHTML = ''
  if (!liveRuns.length) {
    const empty = document.createElement('tr')
    empty.innerHTML = '<td colspan="5" class="dim" style="padding:18px 10px">这个窗口里没有 run。' +
      (view.days > 0 ? '试试「全部」或把筛选放宽。' : (view.onlyAlive ? '取消「只看运行中」。' : '')) + '</td>'
    rowsEl.appendChild(empty)
    return
  }
  for (const run of liveRuns) rowsEl.appendChild(row(run))
  paintElapsed()
}

function drawRun(run, events) {
  const start = events.find((event) => event.event === 'arm_start') || null
  const bits = [project(run.workdir)]
  const arms = armLine(run.arms)
  if (arms) bits.push(arms)
  else if (start) {
    if (start.runner) bits.push(start.runner)
    if (start.model) bits.push(start.model)
    if (start.thinking) bits.push(`thinking ${start.thinking}`)
  }
  const title = run.labels && run.labels.length ? run.labels.join(',') : run.runId
  mhead.innerHTML = `<h3>${esc(title)}</h3>` +
    `<div class="sub">${esc(bits.join('  ·  '))} · <span id="d-elapsed"></span><br>${esc(run.outDir)}</div>`

  const panes = []
  const inputs = run.inputs && run.inputs.length ? run.inputs.slice() : []
  if (!inputs.length) {
    for (const event of events) {
      if (event.event === 'arm_start' && (event.prompt || event.promptFile)) {
        inputs.push({ label: event.arm, prompt: event.prompt, promptChars: event.promptChars, promptFile: event.promptFile })
      }
    }
  }
  for (const input of inputs) {
    const parts = ['输入']
    if (input.label && inputs.length > 1) parts.unshift(input.label)
    if (input.promptChars) parts.push(`${input.promptChars} 字`)
    if (input.promptFile) parts.push(project(input.promptFile))
    const key = `${run.runId}|${input.label || 'input'}`
    const known = Object.prototype.hasOwnProperty.call(openPanes, key)
    const shouldOpen = known ? !!openPanes[key] : !!(input.promptChars && input.promptChars <= 320)
    panes.push(paneHtml(key, esc(parts.join('  ·  ')),
      `<div class="md">${md(promptText(input)) || '<span class="dim">（没读到输入正文）</span>'}</div>`, shouldOpen))
  }

  const armLabels = (run.arms || []).map((arm) => arm.label).filter(Boolean)
  const labels = armLabels.length ? armLabels : (run.labels || [])
  if (labels.length) {
    const rows = labels.map((label) => {
      const arm = (run.arms || []).find((entry) => entry.label === label) || {}
      const armBits = [arm.runner, arm.model, arm.thinking ? `thinking ${arm.thinking}` : ''].filter(Boolean).join(' · ')
      return `<div class="armrow" data-arm="${esc(label)}"><span class="nm">🤖 ${esc(label)}</span>` +
        `<span class="meta">${esc(armBits)}</span></div>`
    }).join('')
    const key = `${run.runId}|arms`
    const known = Object.prototype.hasOwnProperty.call(openPanes, key)
    panes.push(paneHtml(key, `子代理 · ${labels.length} 个`, rows, known ? !!openPanes[key] : false))
  }

  const items = fromProgress(events)
  mbody.innerHTML = `<div class="panes">${panes.join('')}</div>` +
    `<div class="tlbar"><span>时间线 · ${items.length} 条</span>` +
    '<label><input type="checkbox" id="autoscroll">自动滚到最新</label></div>' +
    '<div class="tlwrap"><div class="tlhead"><span>时间</span><span>起点+</span><span>动作</span><span>耗时</span></div>' +
    `<div class="tllist" id="tllist">${timelineHtml(items, { base: (start && start.t) || run.startedAt })}</div></div>`

  wirePanes(mbody, (key, isOpen) => {
    openPanes[key] = isOpen
    savePanes()
  })
  wireTimeline(mbody)
  for (const el of mbody.querySelectorAll('.armrow')) el.onclick = () => openArm(el.getAttribute('data-arm'))
  wireAutoscroll(run.runId)
}

function drawArm(runId, name, data) {
  const arm = data.arm || {}
  const bits = [arm.runner, arm.model, arm.thinking ? `thinking ${arm.thinking}` : ''].filter(Boolean).join(' · ')
  mhead.innerHTML = `<h3>子代理 ${esc(name)}</h3>` +
    `<div class="sub">${esc(bits || '没有记录运行器信息')} · <span id="d-elapsed"></span></div>`

  const panes = []
  if (data.output) {
    const key = `${runId}|${name}|output`
    panes.push(paneHtml(key, '输出', `<pre>${esc(data.output)}</pre>`, openPanes[key] !== false))
  }
  if (data.logTail) {
    const key = `${runId}|${name}|log`
    panes.push(paneHtml(key, '进程日志尾部', `<pre>${esc(data.logTail)}</pre>`, openPanes[key] === true))
  }

  const items = data.events || []
  mbody.innerHTML = `<div class="panes">${panes.join('')}</div>` +
    `<div class="tlbar"><span>子代理时间线 · ${items.length} 条</span>` +
    '<label><input type="checkbox" id="autoscroll">自动滚到最新</label></div>' +
    '<div class="tlwrap"><div class="tlhead"><span>时间</span><span>起点+</span><span>动作</span><span>耗时</span></div>' +
    `<div class="tllist" id="tllist">${timelineHtml(items)}</div></div>`

  wirePanes(mbody, (key, isOpen) => {
    openPanes[key] = isOpen
    savePanes()
  })
  wireTimeline(mbody)
  wireAutoscroll(runId)
}

function loadRun(top) {
  const runId = top.runId
  fetch(`api/runs/${encodeURIComponent(runId)}`).then((r) => r.json()).then((data) => {
    // 读回来的时候人可能已经退到栈底之外了。
    if (!stack.length || stack[0].runId !== runId) return
    if (data.error) {
      mhead.innerHTML = `<h3>${esc(runId)}</h3>`
      mbody.innerHTML = `<div class="bad">读不到：${esc(data.error)}</div>`
      return
    }
    const run = data.run
    const events = data.events || []
    run._at = Date.now()
    openRun = run
    const sig = [run.alive, run.endedAt || '', run.outcome || '', events.length,
      events.length ? events[events.length - 1].t : '', JSON.stringify(run.inputs || null)].join('|')
    if (painted[runId] !== sig) {
      painted[runId] = sig
      drawRun(run, events)
    }
    paintElapsed()
  }).catch(() => { mbody.innerHTML = '<div class="bad">读取失败，重试中…</div>' })
}

function loadArm(top) {
  const runId = stack[0].runId
  const name = top.name
  const key = `${runId}|${name}`
  fetch(`api/runs/${encodeURIComponent(runId)}/arms/${encodeURIComponent(name)}`).then((r) => r.json()).then((data) => {
    const live = stack[stack.length - 1]
    if (!live || live.type !== 'arm' || live.name !== name) return
    if (data.error) {
      mhead.innerHTML = `<h3>子代理 ${esc(name)}</h3>`
      mbody.innerHTML = `<div class="bad">读不到：${esc(data.error)}</div>`
      return
    }
    const sig = [(data.events || []).length, (data.logTail || '').length, (data.output || '').length].join('|')
    if (armPainted[key] !== sig) {
      armPainted[key] = sig
      drawArm(runId, name, data)
    }
    paintElapsed()
  }).catch(() => { mbody.innerHTML = '<div class="bad">读取失败，重试中…</div>' })
}

function poll() {
  fetch(`api/runs?${query()}`).then((r) => r.json()).then((data) => {
    const runs = data.runs || []
    liveRuns = runs

    if (pendingDeep) {
      const want = pendingDeep
      pendingDeep = null
      if (runs.some((run) => run.runId === want.runId)) {
        stack = [{ type: 'run', runId: want.runId }]
        if (want.arm) stack.push({ type: 'arm', name: want.arm })
        pushUrl()
      }
    }
    // 打开着的 run 被筛掉（换窗口、过期）就别留一个关不掉的弹窗。
    if (stack.length && !runById(stack[0].runId)) closeModal()

    render()

    const scope = view.days > 0 ? `近 ${view.days} 天` : '全部历史'
    const aliveCount = runs.filter((run) => run.alive).length
    meta.textContent = `${scope} · ${runs.length} 个 run` +
      (aliveCount ? `（${aliveCount} 个运行中）` : '') +
      (data.malformed ? ` · ${data.malformed} 个记录损坏` : '') +
      ' · 切筛选不删记录 · 每 2 秒刷新'
    if (data.board && data.board.share) {
      warn.style.display = 'block'
      warn.textContent = `对外监听中（无鉴权，局域网内任何人可读）：${data.board.share}`
    }
    if (stack.length) refresh()
  }).catch(() => { meta.textContent = '连接断开，重试中…' })
}

function syncFilters() {
  for (const button of document.querySelectorAll('#filters button')) {
    button.className = Number(button.getAttribute('data-days')) === view.days ? 'on' : ''
  }
}

function wire() {
  for (const button of document.querySelectorAll('#filters button')) {
    button.onclick = () => {
      view.days = Number(button.getAttribute('data-days'))
      saveView()
      syncFilters()
      closeModal()
      poll()
    }
  }
  const aliveBox = document.getElementById('onlyAlive')
  aliveBox.checked = view.onlyAlive
  aliveBox.onchange = () => {
    view.onlyAlive = aliveBox.checked
    saveView()
    closeModal()
    poll()
  }
  syncFilters()
  if (!modalEl) {
    warn.style.display = 'block'
    warn.textContent = '页面骨架是旧版（看板进程还没重启），详情弹窗打不开 —— 重启后再刷一次：' +
      'node tools/run-runtime/cli.mjs board stop 然后 board ensure'
  }
  wireModal({ back, close: closeModal })
}

wire()
poll()
setInterval(poll, 2000)
setInterval(paintElapsed, 1000)
