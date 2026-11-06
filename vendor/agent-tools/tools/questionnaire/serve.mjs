#!/usr/bin/env node
/**
 * Serve one questionnaire as a fillable local web page and accept exactly one
 * final submission. Emits JSONL lifecycle events on stdout; diagnostics go to
 * stderr. Provenance: adapted from to-questionnaire-web/scripts/serve.mjs with
 * AFK inbox forwarding, requirement routing and notifications removed.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomBytes } from 'node:crypto'
import {
  QuestionnaireError, artifactPaths, buildResponseMarkdown, isProcessAlive,
  lanAddresses, parseQuestionnaire, readStatusFile, validateSubmission,
  writeFileAtomic, writeJsonAtomic,
} from '../../lib/questionnaire.mjs'

const USAGE = `questionnaire serve - expose a questionnaire Markdown as a fillable page

  --file <questionnaire.md>   required questionnaire Markdown
  --out-dir <dir>             artifact directory (default: questionnaire directory)
  --session <base>            artifact base name (default: questionnaire basename)
  --host <addr>               bind address (default: 0.0.0.0)
  --port <n>                  bind port, 0 picks a free port (default: 0)
  --open                      open the local URL in this machine's browser
  --force                     replace completed/stale/malformed artifacts with no live owner

stdout is JSONL: questionnaire_started, questionnaire_submitted, questionnaire_error.
Exit: 0 after submission, 1 I/O or bind failure, 2 invalid arguments/session in use.

A live owner is never replaced, even with --force. An atomic <session>-lock.json
claim prevents two servers from sharing one session; a lock is released only by
the server that owns it. If that file is corrupt, delete it by hand after
confirming no server is running.
`

function parseArgs(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true }
  const options = { file: '', host: '0.0.0.0', port: 0, open: false, force: false }
  const allowed = new Set(['--file', '--out-dir', '--session', '--host', '--port'])
  const seen = new Set()
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    if (flag === '--open') { if (options.open) throw new QuestionnaireError('Duplicate option: --open'); options.open = true; continue }
    if (flag === '--force') { if (options.force) throw new QuestionnaireError('Duplicate option: --force'); options.force = true; continue }
    if (!allowed.has(flag)) throw new QuestionnaireError(`Unknown option: ${flag}`)
    if (seen.has(flag)) throw new QuestionnaireError(`Duplicate option: ${flag}`)
    seen.add(flag)
    const value = argv[++i]
    if (!value || value.startsWith('--')) throw new QuestionnaireError(`Missing value for ${flag}`)
    const key = flag === '--out-dir' ? 'outDir' : flag.slice(2)
    options[key] = value
  }
  if (!options.file) throw new QuestionnaireError('Missing --file')
  options.port = Number(options.port || 0)
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new QuestionnaireError('Invalid --port')
  }
  return options
}

/** Read a session lock file without throwing on corrupt content. */
function readLock(lockFile) {
  let raw
  try {
    raw = readFileSync(lockFile, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { missing: true }
    throw error
  }
  try {
    const lock = JSON.parse(raw)
    if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return { malformed: true }
    return { lock }
  } catch {
    return { malformed: true }
  }
}

/**
 * Atomically claim a per-session lock. Exactly one process can own it. A lock
 * whose pid is alive is never stolen; a stale lock is taken over with a single
 * atomic rename so two reclaimers cannot both proceed. Returns `{acquired}`
 * plus the live `holder` when another process owns the session.
 */
export function acquireSessionLock(lockFile, owner) {
  const payload = `${JSON.stringify(owner, null, 2)}\n`
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      writeFileSync(lockFile, payload, { encoding: 'utf8', flag: 'wx' })
      return { acquired: true }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    const existing = readLock(lockFile)
    if (existing.lock && isProcessAlive(existing.lock.pid)) {
      return { acquired: false, holder: existing.lock }
    }
    if (existing.malformed) {
      // A just-created lock can be observed mid-write; do not treat a fresh
      // corrupt lock as stale. An old corrupt lock needs a manual removal.
      let recent = true
      try { recent = Date.now() - statSync(lockFile).mtimeMs < 2000 } catch { recent = false }
      if (recent) return { acquired: false, holder: null, malformed: true }
    }
    const stale = `${lockFile}.stale.${process.pid}.${randomBytes(4).toString('hex')}`
    try {
      renameSync(lockFile, stale)
    } catch (error) {
      if (error.code === 'ENOENT') continue
      throw error
    }
    try { rmSync(stale, { force: true }) } catch { /* best effort */ }
  }
  return { acquired: false, holder: null }
}

/** Remove the lock only when this process still owns it. */
export function releaseSessionLock(lockFile, token) {
  const existing = readLock(lockFile)
  if (existing.lock && existing.lock.token === token) {
    try { rmSync(lockFile, { force: true }) } catch { /* best effort */ }
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function renderPage(model, token) {
  const questions = model.questions.map((item) => `
    <label class="question" for="${escapeHtml(item.id)}">
      <span>${escapeHtml(item.question)}</span>
      <textarea id="${escapeHtml(item.id)}" data-question="${escapeHtml(item.question)}" rows="5">${escapeHtml(item.answer)}</textarea>
    </label>`).join('\n')
  const fallback = model.questions.length === 0 ? `
    <label class="question" for="general"><span>回答</span><textarea id="general" data-question="回答" rows="12"></textarea></label>` : ''
  const intro = model.intro ? `<p class="intro">${escapeHtml(model.intro)}</p>` : ''
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(model.title)}</title><style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;max-width:900px;margin:0 auto;padding:24px;color:#202124;background:#f7f8fa}
main{background:#fff;border:1px solid #dfe3e8;padding:24px}h1{margin-top:0;font-size:28px}p{white-space:pre-wrap;line-height:1.6}.question{display:block;margin:24px 0}.question span{display:block;font-weight:650;margin-bottom:8px}.question textarea{box-sizing:border-box;width:100%;min-height:100px;padding:10px;border:1px solid #b8c0cc;border-radius:6px;font:inherit;resize:vertical}button{padding:10px 16px;border:0;border-radius:6px;background:#1769e0;color:#fff;font:inherit;cursor:pointer}button.secondary{background:#5f6368;margin-left:8px}#status{margin-left:12px;color:#5f6368}
</style></head><body><main><h1>${escapeHtml(model.title)}</h1>${intro}<p>请填写或修改下面的回答。可以先保存草稿，确认无误后提交。</p><form id="form">${questions}${fallback}<p><button type="button" id="draft" class="secondary">保存草稿</button><button type="submit">提交回答</button><span id="status"></span></p></form></main>
<script>
const token=${JSON.stringify(token)}, key='questionnaire-draft-'+location.pathname;
const form=document.querySelector('#form'), status=document.querySelector('#status');
const fields=[...form.querySelectorAll('textarea')];
const saved=JSON.parse(localStorage.getItem(key)||'null');
if(saved) fields.forEach((field)=>{if(saved[field.id]!==undefined) field.value=saved[field.id]});
function values(){return Object.fromEntries(fields.map((field)=>[field.id,{question:field.dataset.question,answer:field.value}]));}
function saveDraft(){localStorage.setItem(key,JSON.stringify(Object.fromEntries(fields.map((field)=>[field.id,field.value]))));status.textContent='草稿已保存在本浏览器';}
document.querySelector('#draft').onclick=saveDraft;
form.onsubmit=async(event)=>{event.preventDefault();saveDraft();status.textContent='正在提交...';const response=await fetch('/submit?token='+encodeURIComponent(token),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({answers:values()})});const body=await response.json();status.textContent=response.ok?'已提交，可以关闭页面':(body.error||'提交失败');if(response.ok) fields.forEach((field)=>field.disabled=true)};
</script></body></html>`
}

function readBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
      if (body.length > 2 * 1024 * 1024) request.destroy(new QuestionnaireError('request too large'))
    })
    request.on('end', () => resolveBody(body))
    request.on('error', reject)
  })
}

function openBrowser(url) {
  // Lazy import keeps the module import side-effect free.
  import('node:child_process').then(({ spawn }) => {
    try {
      const [command, commandArgs] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
        : process.platform === 'darwin' ? ['open', [url]]
          : ['xdg-open', [url]]
      const child = spawn(command, commandArgs, { detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
    } catch { /* opening a browser is best effort */ }
  }).catch(() => {})
}

export async function run(argv, io = {}) {
  const stdout = io.stdout || ((text) => process.stdout.write(text))
  const stderr = io.stderr || ((text) => process.stderr.write(text))
  const emitEvent = (event) => stdout(`${JSON.stringify(event)}\n`)
  let options
  try {
    options = parseArgs(argv)
    if (options.help) { stdout(USAGE); return 0 }
  } catch (error) {
    stderr(`${JSON.stringify({ event: 'questionnaire_error', error: error.message })}\n`)
    return error.exitCode || 2
  }

  let paths
  let model
  try {
    const file = resolve(options.file)
    if (!existsSync(file)) throw new QuestionnaireError(`questionnaire file not found: ${file}`, 1)
    if (!statSync(file).isFile()) throw new QuestionnaireError(`questionnaire is not a file: ${file}`, 1)
    options.file = file
    model = parseQuestionnaire(readFileSync(file, 'utf8'))
    paths = artifactPaths({ file, outDir: options.outDir, session: options.session })
  } catch (error) {
    stderr(`${JSON.stringify({ event: 'questionnaire_error', error: error.message })}\n`)
    return error.exitCode || 2
  }

  try {
    mkdirSync(paths.dir, { recursive: true })
  } catch (error) {
    stderr(`${JSON.stringify({ event: 'questionnaire_error', error: `cannot create output directory: ${error.message}` })}\n`)
    return 1
  }

  const existing = readStatusFile(paths.statusFile)
  const livePid = existing.status && isProcessAlive(existing.status.pid) ? existing.status.pid : 0
  if (livePid) {
    stderr(`${JSON.stringify({ event: 'questionnaire_error', error: `session is live on ${paths.statusFile} (pid ${livePid})`, nextHint: 'use the running server; a live session is never replaced, not even with --force' })}\n`)
    return 2
  }
  const collisions = []
  if (existing.status || existing.malformed) collisions.push(paths.statusFile)
  for (const artifact of [paths.responseFile, paths.responseMarkdown]) {
    if (existsSync(artifact)) collisions.push(artifact)
  }
  if (collisions.length && !options.force) {
    const reason = existing.malformed ? `corrupt status (${existing.reason})` : 'existing session artifacts'
    stderr(`${JSON.stringify({ event: 'questionnaire_error', error: `refusing to replace ${reason}: ${collisions.join(', ')}`, nextHint: 'inspect the previous session, or pass --force to replace it' })}\n`)
    return 2
  }

  // Atomic per-session claim: only one server can own a session at a time,
  // even when two start simultaneously and even with --force.
  const lockToken = randomBytes(12).toString('hex')
  const lockOwner = {
    version: 1, pid: process.pid, token: lockToken,
    statusFile: paths.statusFile, file: options.file, startedAt: new Date().toISOString(),
  }
  const claim = acquireSessionLock(paths.lockFile, lockOwner)
  if (!claim.acquired) {
    const holder = claim.holder ? `pid ${claim.holder.pid}` : 'an unreadable lock'
    stderr(`${JSON.stringify({ event: 'questionnaire_error', error: `session lock is held by ${holder}: ${paths.lockFile}`, nextHint: 'use the running server; stop it to release the lock' })}\n`)
    return 2
  }
  const releaseLock = () => releaseSessionLock(paths.lockFile, lockToken)

  const token = randomBytes(18).toString('hex')
  const startedAt = new Date().toISOString()
  let currentPort = options.port
  let settled = false
  let submitted = false
  let reserving = false
  let inflight = 0
  let shutdownRequested = false

  const writeStatus = (extra) => writeJsonAtomic(paths.statusFile, {
    version: 1,
    file: options.file,
    pid: process.pid,
    startedAt,
    updatedAt: new Date().toISOString(),
    responseFile: paths.responseFile,
    responseMarkdown: paths.responseMarkdown,
    statusFile: paths.statusFile,
    ...extra,
  })

  const server = createServer(async (request, response) => {
    inflight += 1
    let counted = true
    const responseDone = () => {
      if (!counted) return
      counted = false
      inflight -= 1
      if (shutdownRequested && inflight === 0) shutdown()
    }
    response.on('finish', responseDone)
    response.on('close', responseDone)
    const sendJson = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
      response.end(JSON.stringify(value))
    }
    try {
      const url = new URL(request.url, 'http://localhost')
      const tokenOk = url.searchParams.get('token') === token
      if (url.pathname === '/' && request.method === 'GET') {
        if (!tokenOk) { sendJson(403, { error: 'invalid or missing token' }); return }
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(renderPage(model, token))
        return
      }
      if (url.pathname === '/submit' && request.method === 'POST') {
        if (!tokenOk) { sendJson(403, { error: 'invalid or missing token' }); return }
        // Reserve synchronously before the async body read so two concurrent
        // valid submissions cannot both reach the commit.
        if (submitted || reserving) {
          // Fully drain the rejected request body before replying so the client
          // reads the 409 instead of seeing a reset for an unread request.
          const reject = () => sendJson(409, { error: 'a submission has already been accepted or is in progress' })
          request.resume()
          request.on('error', () => {})
          if (request.complete) reject()
          else request.on('end', reject)
          return
        }
        reserving = true
        let committed = false
        try {
          let payload
          try {
            payload = JSON.parse(await readBody(request))
          } catch (error) {
            sendJson(400, { error: error.message })
            return
          }
          let answers
          try {
            answers = validateSubmission(model, payload)
          } catch (error) {
            sendJson(400, { error: error.message })
            return
          }
          const result = { questionnaireFile: options.file, submittedAt: new Date().toISOString(), answers }
          try {
            // Write both payload files first; the status file is the commit point.
            writeJsonAtomic(paths.responseFile, result)
            writeFileAtomic(paths.responseMarkdown, buildResponseMarkdown(model, result))
            writeJsonAtomic(paths.statusFile, {
              version: 1, file: options.file, pid: process.pid, startedAt,
              updatedAt: new Date().toISOString(),
              state: 'submitted', submittedAt: result.submittedAt,
              answeredCount: Object.values(answers).filter((item) => item.answer.trim() !== '').length,
              questionCount: model.questions.length,
              responseFile: paths.responseFile, responseMarkdown: paths.responseMarkdown,
              statusFile: paths.statusFile,
            })
          } catch (error) {
            // The status file was never committed, so the session stays waiting
            // and the reservation is released for an explicit retry.
            sendJson(500, { error: `failed to persist submission: ${error.message}`, retryable: true })
            return
          }
          submitted = true
          committed = true
          shutdownRequested = true
          setTimeout(() => shutdown(), 1500).unref()
          sendJson(200, { ok: true, responseFile: paths.responseFile, responseMarkdown: paths.responseMarkdown })
          emitEvent({
            event: 'questionnaire_submitted',
            responseFile: paths.responseFile,
            responseMarkdown: paths.responseMarkdown,
            statusFile: paths.statusFile,
            answeredCount: Object.values(answers).filter((item) => item.answer.trim() !== '').length,
            questionCount: model.questions.length,
          })
        } finally {
          if (!committed) reserving = false
        }
        return
      }
      sendJson(404, { error: 'not found' })
    } catch (error) {
      sendJson(400, { error: error.message })
    }
  })

  function shutdown() {
    if (settled) return
    settled = true
    releaseLock()
    // Keep the listener alive briefly so clients can finish reading a just-sent
    // response; new requests are refused by the submitted guard. Then close
    // every socket and exit.
    setTimeout(() => {
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
      server.close(() => process.exit(0))
      process.exit(0)
    }, 400).unref()
  }

  server.on('error', (error) => {
    releaseLock()
    stderr(`${JSON.stringify({ event: 'questionnaire_error', error: error.message })}\n`)
    process.exit(1)
  })

  return await new Promise((done) => {
    server.listen(currentPort, options.host, () => {
      try {
        const address = server.address()
        const port = typeof address === 'object' && address ? address.port : currentPort
        currentPort = port
        const lan = lanAddresses().map((item) => ({
          name: item.name, address: item.address,
          url: `http://${item.address}:${port}/?token=${token}`,
        }))
        const localUrl = `http://127.0.0.1:${port}/?token=${token}`
        writeStatus({
          state: 'waiting',
          host: options.host,
          port,
          localOrigin: `http://127.0.0.1:${port}`,
          lanOrigins: lan.map((item) => `http://${item.address}:${port}`),
          lanInterfaces: lan.map((item) => `${item.name} ${item.address}`),
        })
        emitEvent({
          event: 'questionnaire_started',
          file: options.file,
          url: localUrl,
          localUrl,
          lanUrls: lan.map((item) => item.url),
          lanInterfaces: lan.map((item) => `${item.name} ${item.address}`),
          host: options.host,
          port,
          statusFile: paths.statusFile,
          responseFile: paths.responseFile,
          responseMarkdown: paths.responseMarkdown,
        })
        if (options.open) openBrowser(localUrl)
      } catch (error) {
        releaseLock()
        stderr(`${JSON.stringify({ event: 'questionnaire_error', error: error.message })}\n`)
        server.close(() => process.exit(1))
      }
    })
    server.on('close', () => done(0))
  })
}

let invokedDirectly = false
try {
  invokedDirectly = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
} catch { /* An importing host may pass a non-file argv[1]. */ }
if (invokedDirectly) process.exitCode = await run(process.argv.slice(2))
