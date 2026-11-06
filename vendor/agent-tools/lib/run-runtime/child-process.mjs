/**
 * Owned child-process handles.
 *
 * A caller that starts a process through `startOwnedProcess` gets a handle; it
 * can cancel exactly that owned process tree or await its exit. Cancellation
 * waits for the owned child to actually terminate before resolving, and only
 * escalates the owned tree when a graceful signal is not enough. There is
 * deliberately no `kill(pid)` API: an unrelated PID is never signalled.
 *
 * Provenance: adapted from the tree-kill logic in
 * skills/exec-review/scripts/runners/spawn-turn.mjs.
 */

import { execFile, spawn } from 'node:child_process'

const GRACE_MS = 2000
const FORCE_MS = 3000

function abortError() {
  const err = new Error('startOwnedProcess was aborted before start')
  err.name = 'AbortError'
  return err
}

function waitFor(promise, ms) {
  return new Promise((resolvePromise) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolvePromise(false)
    }, ms)
    promise.then(() => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolvePromise(true)
    })
  })
}

/**
 * Signal the owned process tree. On Windows the tree is terminated directly
 * (taskkill /T) because a console child cannot be gracefully signalled. On
 * POSIX a process group is signalled, first SIGTERM then SIGKILL when forced.
 */
function signalOwnedTree(child, { force = false } = {}) {
  if (!child || child.pid == null) return false
  const settled = child.exitCode != null || child.signalCode != null
  if (settled) return false
  try {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
      return true
    }
    const signal = force ? 'SIGKILL' : 'SIGTERM'
    try {
      process.kill(-child.pid, signal)
    } catch {
      child.kill(signal)
    }
    return true
  } catch {
    return false
  }
}

/**
 * Start a child process and return an owned handle.
 * @param {{command:string, args?:string[], cwd?:string, env?:object,
 *   stdio?:any, windowsHide?:boolean, signal?:AbortSignal,
 *   killGraceMs?:number, killForceMs?:number}} opts
 * @returns {{pid:number|undefined, child:import('node:child_process').ChildProcess,
 *   stdout:any, stderr:any, exited:boolean, code:number|null, signal:string|null,
 *   error:string|null, cancel:()=>Promise<{cancelled:boolean, escalated:boolean}>,
 *   wait:()=>Promise<{code:number|null, signal:string|null, error?:string}>}}
 */
export function startOwnedProcess(opts = {}) {
  if (!opts.command) throw new Error('startOwnedProcess requires a command')
  if (opts.signal && opts.signal.aborted) throw abortError()

  const child = spawn(opts.command, opts.args || [], {
    cwd: opts.cwd,
    env: opts.env || process.env,
    windowsHide: opts.windowsHide !== false,
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  })

  let settled = false
  let result = { code: null, signal: null, error: null }
  const exitPromise = new Promise((resolvePromise) => {
    child.once('error', (err) => {
      if (settled) return
      settled = true
      result = { code: null, signal: null, error: err.message }
      resolvePromise(result)
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      result = { code: code ?? null, signal: signal || null, error: null }
      resolvePromise(result)
    })
  })

  const graceMs = Number.isFinite(opts.killGraceMs) ? opts.killGraceMs : GRACE_MS
  const forceMs = Number.isFinite(opts.killForceMs) ? opts.killForceMs : FORCE_MS

  let cancelPromise = null
  async function doCancel() {
    if (settled) return { cancelled: false, escalated: false }
    const signalled = signalOwnedTree(child, { force: false })
    if (!signalled) return { cancelled: false, escalated: false }
    if (await waitFor(exitPromise, graceMs)) return { cancelled: true, escalated: false }
    signalOwnedTree(child, { force: true })
    await waitFor(exitPromise, forceMs)
    return { cancelled: true, escalated: true }
  }

  const handle = {
    pid: child.pid,
    child,
    stdout: child.stdout,
    stderr: child.stderr,
    get exited() {
      return settled
    },
    get code() {
      return result.code
    },
    get signal() {
      return result.signal
    },
    get error() {
      return result.error
    },
    cancel() {
      if (!cancelPromise) cancelPromise = doCancel()
      return cancelPromise
    },
    wait() {
      return exitPromise
    },
  }

  if (opts.signal) {
    opts.signal.addEventListener('abort', () => {
      handle.cancel()
    }, { once: true })
  }

  return handle
}
