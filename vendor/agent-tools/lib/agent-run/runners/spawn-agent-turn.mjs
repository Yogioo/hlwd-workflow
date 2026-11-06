// Adapted from skills/exec-review/scripts/runners/spawn-agent-turn.mjs.
// Self-contained (Node built-ins + relative imports only); adds an owned-child
// timeout that reports timedOut rather than relying on AFK config.
import { execFile, spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { createWriteStream, writeFileSync, appendFileSync } from 'node:fs'
import { resolveBin } from './resolve-bin.mjs'
import { normalizeEvent, extractOutTextFromRaw } from '../../agent-events.mjs'

/**
 * @typedef {object} StreamTurnRequest
 * @property {string} bin
 * @property {string} [knownName]
 * @property {'agent' | 'codex' | 'pi'} runner
 * @property {string} workdir
 * @property {string[]} args
 * @property {string} [stdinText]
 * @property {string} outFile
 * @property {string} logFile
 * @property {string} eventsFile
 * @property {boolean} [writeOutFile] when false, CLI writes outFile (codex -o)
 * @property {boolean} [dryRun]
 * @property {string} [dryRunBody]
 * @property {number} [timeoutMs] abort and kill the owned child tree after this delay
 * @property {AbortSignal} [signal]
 * @property {(event: object) => void} [onEvent] 归一化事件回调；异常会被吞掉
 */

/** Kill the whole process tree (Windows: taskkill /T; else process group). */
function killTree(child) {
  if (!child || child.pid == null) return
  if (process.platform === 'win32') {
    try {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
      })
    } catch {
      /* ignore */
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGTERM')
    } catch {
      /* ignore */
    }
  }
}

/**
 * Parse NDJSON from stdout chunks.
 * @param {string} chunkText
 * @param {string} remainder
 * @param {'agent' | 'codex' | 'pi'} runner
 * @returns {{ remainder: string, rawEvents: object[], resultText: string }}
 */
export function parseStreamJsonChunk(chunkText, remainder = '', runner = 'agent') {
  const combined = remainder + chunkText
  const lines = combined.split('\n')
  const nextRemainder = lines.pop() || ''
  const rawEvents = []
  let resultText = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const raw = JSON.parse(trimmed)
      rawEvents.push(raw)
      const out = extractOutTextFromRaw(raw, runner)
      if (out) resultText = out
    } catch {
      /* ignore partial / non-json lines */
    }
  }
  return { remainder: nextRemainder, rawEvents, resultText }
}

/**
 * Spawn a turn with JSONL stdout parsing and normalized events file.
 * @param {StreamTurnRequest} req
 */
export function spawnStreamTurn(req) {
  const {
    bin,
    knownName,
    runner,
    workdir,
    args,
    stdinText,
    outFile,
    logFile,
    eventsFile,
    writeOutFile = true,
    dryRun = false,
    dryRunBody = '{"status":"blocked","note":"dry-run"}\n',
    timeoutMs,
    signal,
    onEvent,
  } = req

  const resolved = resolveBin(bin, { knownName })
  const spawnArgs = [...resolved.argsPrefix, ...args]
  const cmdline = `$ ${resolved.display} ${args.join(' ')}\n\n`

  if (dryRun) {
    writeFileSync(outFile, dryRunBody, 'utf8')
    writeFileSync(logFile, `[dry-run] ${cmdline}`, 'utf8')
    const dryRaw =
      runner === 'agent'
        ? { type: 'result', subtype: 'success', result: dryRunBody.trim() }
        : runner === 'pi'
          ? {
              type: 'message_end',
              message: { role: 'assistant', content: [{ type: 'text', text: dryRunBody.trim() }] },
            }
          : {
              type: 'item.completed',
              item: { id: 'dry', type: 'agent_message', text: dryRunBody.trim() },
            }
    writeFileSync(eventsFile, JSON.stringify(normalizeEvent(dryRaw, runner)) + '\n', 'utf8')
    return Promise.resolve({ code: 0, dryRun: true })
  }

  return new Promise((resolvePromise, reject) => {
    const logStream = createWriteStream(logFile, { flags: 'w' })
    logStream.write(cmdline)

    let ndjsonRemainder = ''
    const decoder = new StringDecoder('utf8')
    let finalResultText = ''

    const child = spawn(resolved.command, spawnArgs, {
      cwd: workdir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      shell: resolved.shell,
      detached: process.platform !== 'win32',
    })

    let settled = false
    let aborting = false
    let timedOut = false
    let timer
    let abortFallback
    const finishAbort = () => {
      if (settled) return
      settled = true
      if (abortFallback) clearTimeout(abortFallback)
      logStream.end()
      resolvePromise({ code: 124, aborted: true, timedOut })
    }
    const onAbort = () => {
      if (settled || aborting) return
      aborting = true
      if (timer) clearTimeout(timer)
      killTree(child)
      // Let `close` settle so the owned tree is gone before we report; fall
      // back only if the child never closes.
      abortFallback = setTimeout(finishAbort, 5000)
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        onAbort()
      }, timeoutMs)
    }

    const ingestRawEvents = (rawEvents, resultText) => {
      if (resultText) finalResultText = resultText
      for (const raw of rawEvents) {
        const normalized = normalizeEvent(raw, runner)
        appendFileSync(eventsFile, JSON.stringify(normalized) + '\n', 'utf8')
        // 观察端回调：抛异常绝不允许杀死这次执行，观察只是附属品。
        if (onEvent) {
          try {
            onEvent(normalized)
          } catch {
            /* 吞掉 */
          }
        }
      }
    }

    const handleChunk = (d) => {
      logStream.write(d)
      const parsed = parseStreamJsonChunk(decoder.write(d), ndjsonRemainder, runner)
      ndjsonRemainder = parsed.remainder
      ingestRawEvents(parsed.rawEvents, parsed.resultText)
    }

    child.stdout.on('data', handleChunk)
    child.stderr.on('data', (d) => logStream.write(d))
    child.on('error', (err) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (abortFallback) clearTimeout(abortFallback)
      logStream.end()
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (abortFallback) clearTimeout(abortFallback)
      signal?.removeEventListener('abort', onAbort)
      if (aborting) {
        logStream.end()
        resolvePromise({ code: 124, aborted: true, timedOut })
        return
      }
      ndjsonRemainder += decoder.end()
      if (ndjsonRemainder.trim()) {
        const parsed = parseStreamJsonChunk('\n', ndjsonRemainder, runner)
        ingestRawEvents(parsed.rawEvents, parsed.resultText)
      }
      if (writeOutFile) {
        writeFileSync(outFile, finalResultText, 'utf8')
      }
      logStream.end()
      resolvePromise({ code: code ?? 1, timedOut: false, aborted: false })
    })

    if (stdinText != null) {
      child.stdin.write(stdinText)
    }
    child.stdin.end()
  })
}

/** @param {StreamTurnRequest} req */
export function spawnAgentStreamTurn(req) {
  return spawnStreamTurn({ ...req, runner: 'agent', writeOutFile: true })
}
