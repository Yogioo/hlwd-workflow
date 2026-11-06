/**
 * 只读看板：一台机器一个常驻进程，把 `<AFK home>/runs/` 里所有 run 摊开成一页。
 *
 * 为什么是「一个常驻页」而不是「每个 run 一个页面」：地址要能贴进 TAPD 评论、能被
 * 局域网里别人点开，所以它必须稳定、且不随 run 生灭。端口因此写进 state.json 并
 * 粘住；启动失败时顺延，但一旦定下来就复用，免得已经发出去的链接失效。
 *
 * 边界（与 afk-watch 总览页同一套规矩）：
 *   - 只读：没有任何能改变 run 的端点
 *   - 不读 config.json：凭据不会流进浏览器
 *   - 默认只听 loopback，`--host 0.0.0.0` 才出网，且页面顶部明示「无鉴权」
 *   - 拿不到的、坏掉的文件都降级成一条提示，不让整页 500
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { networkInterfaces } from 'node:os'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afkHomeRoot, isRunAlive, listRuns, readRun } from './run-registry.mjs'
import { readEvents } from './progress.mjs'
import { modalShell, pageHead, readAsset, sharedAsset } from '../web-ui/assets.mjs'
import { fromProgressEvent } from '../web-ui/events.mjs'

/** 默认端口取一个不常撞的值；被占就顺延，实际值记在 state.json 里。 */
export const DEFAULT_BOARD_PORT = 7717
const PORT_TRIES = 10
const DETAIL_EVENTS = 60
const HEALTH_TIMEOUT_MS = 4000

export function boardDir() {
  return join(afkHomeRoot(), 'board')
}

export function boardStateFile() {
  return join(boardDir(), 'state.json')
}

/** 启动日志落在 board 目录里，起不来时 `--status` 会把尾巴带出来。 */
export function boardLogFile() {
  return join(boardDir(), 'board.log')
}

export function readBoardState() {
  const file = boardStateFile()
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeBoardState(state) {
  mkdirSync(boardDir(), { recursive: true })
  const file = boardStateFile()
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(state)}\n`, 'utf8')
  renameSync(tmp, file)
}

/**
 * 局域网地址排序：虚拟网卡（WSL/Hyper-V/Tailscale/隧道）不能拿去发给别人，
 * 实测本机会把 `172.19.0.1`（SmartRouteTun）排在真实网卡前面，所以按名字和
 * 网段打分：192.168 > 10 > 172.16-31 > 其他，169.254 链路本地和虚拟名扣到底。
 */
const VIRTUAL_NAME = /(vethernet|wsl|virtual|vmware|vbox|hyper-?v|tailscale|zerotier|docker|loopback|\btun\b|\btap\b)/i

function scoreInterface(name, address) {
  if (address.startsWith('169.254.')) return -100
  let score = 0
  if (VIRTUAL_NAME.test(String(name))) score -= 50
  if (address.startsWith('192.168.')) score += 30
  else if (address.startsWith('10.')) score += 20
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 5
  return score
}

/** 全部候选局域网地址，已排序；`share` 取第一个。 */
export function lanCandidates() {
  const found = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      found.push({ name, address: entry.address, score: scoreInterface(name, entry.address) })
    }
  }
  return found.sort((a, b) => b.score - a.score)
}

/** 局域网地址：真实网卡优先，取不到返回 null。 */
export function lanAddress() {
  return lanCandidates()[0]?.address || null
}

/** 给人用的地址：监听在通配地址时优先给局域网 IP，否则 loopback。 */
export function boardUrls(port, host = '127.0.0.1') {
  const wildcard = host === '0.0.0.0' || host === '::'
  const candidates = wildcard ? lanCandidates() : []
  const lan = candidates[0]?.address || null
  const share = lan ? `http://${lan}:${port}/` : null
  return {
    local: `http://127.0.0.1:${port}/`,
    share,
    shareCandidates: candidates.map((entry) => `http://${entry.address}:${port}/`),
    lanBound: wildcard && Boolean(lan),
  }
}

/**
 * 起服务（阻塞，直到 close）。端口按「上次用的 → 默认 → 顺延 → 随机」的顺序挑。
 * @param {{port?:number, host?:string, preferred?:number}} opts
 */
export async function startBoardServer(opts = {}) {
  const host = opts.host || '127.0.0.1'
  const wanted = opts.preferred != null ? opts.preferred : opts.port != null ? opts.port : DEFAULT_BOARD_PORT
  const preferred = Number(wanted)
  const candidates = preferred > 0 ? [preferred] : []
  for (let i = 1; preferred > 0 && i < PORT_TRIES; i++) candidates.push(preferred + i)
  candidates.push(0)

  let lastError = null
  for (const port of candidates) {
    try {
      return await listenOn(port, host)
    } catch (err) {
      lastError = err
    }
  }
  throw lastError || new Error('board 无法监听任何端口')
}

function listenOn(port, host) {
  const server = createServer(handleRequest)
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const actual = server.address()
      const urls = boardUrls(actual.port, host)
      const state = {
        pid: process.pid,
        port: actual.port,
        host,
        ...urls,
        startedAt: Date.now(),
      }
      try {
        writeBoardState(state)
      } catch {
        /* 状态文件写不了也要把页面跑起来 */
      }
      resolvePromise({
        ...state,
        server,
        close: () =>
          new Promise((done) => {
            server.close(() => done())
            server.closeAllConnections?.()
          }),
      })
    })
  })
}

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(typeof body === 'string' ? body : JSON.stringify(body))
}

function sendAsset(res, asset) {
  res.writeHead(200, { 'content-type': asset.type, 'cache-control': 'no-store' })
  res.end(asset.body)
}

function handleRequest(req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  const path = url.pathname
  try {
    if (path === '/healthz') {
      send(res, 200, { ok: true, pid: process.pid, port: readBoardState()?.port })
      return
    }
    if (path === '/') {
      send(res, 200, pageHtml(), 'text/html; charset=utf-8')
      return
    }
    if (path.startsWith('/assets/')) {
      const asset = sharedAsset(path.slice('/assets/'.length))
      if (asset) {
        sendAsset(res, asset)
        return
      }
    }
    if (path === '/app.js') {
      sendAsset(res, readAsset(join(dirname(fileURLToPath(import.meta.url)), 'board-app.js')))
      return
    }
    if (path === '/api/runs') {
      const state = readBoardState()
      // 默认 7 天窗口：历史都在账上，页面只发这段；`days=0` 或 `all=1` 才是全部。
      // `alive=1` 只看在跑的。两个都是筛选，不会删任何东西。
      const daysParam = url.searchParams.get('days')
      const days = daysParam == null ? 7 : Number(daysParam)
      const since = Number.isFinite(days) && days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : 0
      const onlyAlive = url.searchParams.get('alive') === '1' || url.searchParams.get('alive') === 'true'
      const listed = listRuns({ since, includeFinished: !onlyAlive })
      send(res, 200, {
        runs: listed.runs.map(summarizeRun),
        finished: listed.finished,
        crashed: listed.crashed,
        malformed: listed.malformed,
        window: { days, since, onlyAlive },
        board: state ? { port: state.port, host: state.host, share: state.share, shareCandidates: state.shareCandidates } : null,
        now: Date.now(),
      })
      return
    }
    const armDetail = path.match(/^\/api\/runs\/([^/]+)\/arms\/([^/]+)$/)
    if (armDetail) {
      const runId = decodeURIComponent(armDetail[1])
      const label = decodeURIComponent(armDetail[2])
      const { record, error } = readRun(runId)
      if (!record) {
        send(res, 404, { error: error || 'not-found', runId })
        return
      }
      const arm = (record.arms || []).find((entry) => entry.label === label)
      if (!arm) {
        send(res, 404, { error: 'arm-not-found', runId, label })
        return
      }
      let events = []
      try {
        const all = readEvents(record.progressFile, {}).events
        events = all.filter((event) => String(event.arm || '') === label).slice(-120).map(fromProgressEvent)
      } catch {
        events = []
      }
      send(res, 200, {
        arm,
        events,
        logTail: tailFile(join(record.outDir, label, 'log.txt'), 4000),
        output: tailFile(join(record.outDir, label, 'output.txt'), 4000),
      })
      return
    }
    const detail = path.match(/^\/api\/runs\/([^/]+)$/)
    if (detail) {
      const runId = decodeURIComponent(detail[1])
      const { record, error } = readRun(runId)
      if (!record) {
        send(res, 404, { error: error || 'not-found', runId })
        return
      }
      // 活着的判定必须和列表同源，不能这里一律当真。
      const alive = isRunAlive(record)
      // 已结束的 run 的用时是定值：不能拿 now 去减 startedAt，否则历史越看越长。
      const endAt = Number(record.endedAt) || Date.now()
      send(res, 200, {
        run: summarizeRun({
          ...record,
          alive,
          crashed: !alive && !record.endedAt,
          elapsedMs: Number.isFinite(Number(record.elapsedMs))
            ? Number(record.elapsedMs)
            : Math.max(0, endAt - Number(record.startedAt || endAt)),
        }),
        events: tailEvents(record, DETAIL_EVENTS),
      })
      return
    }
    send(res, 404, { error: 'not-found', path })
  } catch (err) {
    send(res, 500, { error: err && err.message ? err.message : String(err) })
  }
}

const PROGRESS_HEAD_BYTES = 64 * 1024
const progressMetaCache = new Map()

/**
 * 从 progress.jsonl 的**头部**补出每个臂的 cli/模型/思考等级和输入。
 *
 * 只读前 64KB：arm_start 永远写在最前面，而文件会一直往后长（长跑能有几百 KB），
 * 尾巴里早就没有它了 —— 「刚起的这轮用的是什么模型、要它干什么」正好在这时候问。
 * 按 runId+startedAt 缓存：arm_start 一旦写下就不会变，不像文件还在追加。
 * @param {object} run
 * @returns {{arms?:object[], inputs?:object[]}|null}
 */
function readProgressMeta(run) {
  const key = String(run.runId || run.progressFile) + ':' + String(run.startedAt || '')
  if (progressMetaCache.has(key)) return progressMetaCache.get(key)
  let meta = null
  const file = run.progressFile
  if (file && existsSync(file)) {
    try {
      const fd = openSync(file, 'r')
      let text = ''
      try {
        const buffer = Buffer.alloc(PROGRESS_HEAD_BYTES)
        text = buffer.subarray(0, readSync(fd, buffer, 0, PROGRESS_HEAD_BYTES, 0)).toString('utf8')
      } finally {
        closeSync(fd)
      }
      const arms = new Map()
      const inputs = new Map()
      for (const line of text.split(String.fromCharCode(10))) {
        if (!line.trim() || !line.includes('arm_start')) continue
        let event
        try {
          event = JSON.parse(line)
        } catch {
          continue
        }
        if (!event || event.event !== 'arm_start') continue
        const label = String(event.arm || '')
        const knob = { label }
        for (const field of ['runner', 'model', 'provider', 'thinking']) {
          if (event[field] != null && event[field] !== '') knob[field] = String(event[field])
        }
        arms.set(label, knob)
        const input = { label }
        if (event.prompt) input.prompt = String(event.prompt)
        if (Number.isFinite(Number(event.promptChars))) input.promptChars = Number(event.promptChars)
        if (event.promptFile) input.promptFile = String(event.promptFile)
        if (Object.keys(input).length > 1) inputs.set(label, input)
      }
      if (arms.size > 0 || inputs.size > 0) {
        meta = {
          ...(arms.size > 0 ? { arms: [...arms.values()] } : {}),
          ...(inputs.size > 0 ? { inputs: [...inputs.values()] } : {}),
        }
      }
    } catch {
      meta = null
    }
  }
  progressMetaCache.set(key, meta)
  return meta
}

export function summarizeRun(run) {
  const progress = tailEvents(run, 1)[0] || null
  // 记录里自带最好（不依赖 out-dir 还在）；否则从 progress 头部补 —— 正在跑的
  // run 就是这种情况：它登记得比这个字段早，但 arm_start 还在文件开头。
  const meta = readProgressMeta(run)
  return {
    runId: run.runId,
    workdir: run.workdir,
    outDir: run.outDir,
    labels: run.labels || [],
    arms: Array.isArray(run.arms) && run.arms.length > 0 ? run.arms : (meta?.arms || null),
    runner: run.runner,
    inputs: Array.isArray(run.inputs) && run.inputs.length > 0 ? run.inputs : (meta?.inputs || null),
    alive: run.alive !== false,
    // 历史行的三种结尾：正常收尾（endedAt+outcome）、崩了（crashed）、还在跑。
    endedAt: run.endedAt || null,
    outcome: run.outcome || null,
    crashed: run.crashed === true,
    elapsedMs: run.elapsedMs,
    startedAt: run.startedAt,
    phase: progress ? progress.event : 'starting',
    phaseDetail: progress ? compact(progress) : null,
    // 原始记录：页面据此写「正在读 xxx.cs」。不在这里拼成人话，因为人话要按工具族
    // 分颜色/动词，那是排版的事；API 保持可机读。
    lastEvent: progress,
  }
}

/** 只取进度文件尾巴，且有上限 —— 一个臂能写几十万字节，整份读进来没意义。 */
function tailEvents(run, limit) {
  const file = run.progressFile
  if (!file || !existsSync(file)) return []
  try {
    const { events, malformed } = readEvents(file, {})
    const out = events.slice(-limit)
    if (malformed.length > 0) out.push({ t: Date.now(), level: 0, event: 'malformed_lines', count: malformed.length })
    return out
  } catch {
    return []
  }
}

function tailFile(file, limit) {
  if (!existsSync(file)) return ''
  try {
    const text = readFileSync(file, 'utf8')
    return text.length > limit ? text.slice(-limit) : text
  } catch {
    return ''
  }
}

function compact(record) {
  const { t, level, event, ...rest } = record
  const text = Object.entries(rest)
    .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join(' ')
  return text.length > 160 ? `${text.slice(0, 160)}…` : text
}

/**
 * 确保 board 在跑：活着的直接复用，没有就 detached 起一个并等它健康。
 * **永不抛**：观察端不许拖垮执行，失败就返回 `{ok:false, error}`。
 * @param {{host?:string, now?:number}} [opts]
 */
export async function ensureBoard(opts = {}) {
  const host = opts.host || process.env.AGENT_TOOLS_BOARD_HOST || '0.0.0.0'
  const healthy = await currentBoard()
  if (healthy.ok) return healthled(healthy)

  const preferred = Number(readBoardState()?.port || DEFAULT_BOARD_PORT)
  const child = spawn(
    process.execPath,
    [join(dirname(fileURLToPath(import.meta.url)), 'board-daemon.mjs'), '--host', host, '--port', String(preferred)],
    {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, AFK_HOME: afkHomeRoot() },
    },
  )
  child.unref()

  const deadline = Date.now() + HEALTH_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(150)
    const check = await currentBoard()
    if (check.ok) return healthled(check)
  }
  return { ok: false, error: 'board 未在超时内就绪', url: null, local: null, share: null, host }
}

function healthled(state) {
  const urls = boardUrls(state.port, state.host)
  return { ok: true, pid: state.pid, port: state.port, host: state.host, url: urls.share || urls.local, ...urls }
}

/** 当前 board 是否健康；只读 state.json 并打一次 /healthz。 */
export async function currentBoard() {
  const state = readBoardState()
  if (!state || !state.port) return { ok: false, error: 'not-running' }
  try {
    const res = await fetch(`http://127.0.0.1:${state.port}/healthz`, { signal: AbortSignal.timeout(1200) })
    if (!res.ok) return { ok: false, error: `healthz ${res.status}`, ...state }
    return { ok: true, ...state }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), ...state }
  }
}

export function stopBoard() {
  const state = readBoardState()
  if (!state || !state.pid) return { stopped: false, reason: 'not-running' }
  try {
    process.kill(state.pid, 'SIGTERM')
  } catch { /* 已经没了 */ }
  try {
    writeFileSync(`${boardStateFile()}.stopped`, String(Date.now()), 'utf8')
  } catch { /* 无所谓 */ }
  return { stopped: true, pid: state.pid }
}

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms))
}

// 只写这张页面的布局差异：看板自己的列宽与时间线里的段落行距。弹窗下钻布局在 theme.css。
const SHELL_CSS = `<style>.what{max-width:620px}.tl .md p{margin:.15em 0}.tl .md h1,.tl .md h2,.tl .md h3,.tl .md h4{margin:.2em 0 .15em;font-size:1em}</style>`

/**
 * 页面骨架每次请求现拼：app.js 与 assets 都是读盘的，HTML 要是模块级常量，
 * 改了外壳就得重启常驻进程，否则老进程发旧骨架、新 app.js 找不到 #modal —— 点卡片没反应。
 */
function pageHtml() {
  return `${pageHead('agent runs', SHELL_CSS)}
<body>
<h1>agent runs</h1><div id="meta">连接中…</div>
<div id="warn"></div>
<div id="filters">
  <button data-days="1">近 1 天</button>
  <button data-days="7" class="on">近 7 天</button>
  <button data-days="30">近 30 天</button>
  <button data-days="0">全部</button>
  <label><input type="checkbox" id="onlyAlive">只看运行中</label>
</div>
<table><thead><tr><th>项目</th><th>臂</th><th>正在做什么</th><th>用时</th><th>状态</th></tr></thead>
<tbody id="rows"></tbody></table>
${modalShell()}
<script type="module" src="/app.js"></script></body></html>`
}
