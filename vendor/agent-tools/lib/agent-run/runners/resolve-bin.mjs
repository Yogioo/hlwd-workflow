/**
 * Adapted from skills/exec-review/scripts/runners/resolve-bin.mjs.
 * Resolve npm-global CLI wrappers to a direct `node <js>` spawn on Windows.
 * Spawning `*.cmd` / `*.ps1` with piped stdio often yields EINVAL on modern Node.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

const KNOWN_JS = {
  codex: ['@openai', 'codex', 'bin', 'codex.js'],
  pi: ['@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'],
}

function appDataNpmJs(parts) {
  if (!process.env.APPDATA) return ''
  return join(process.env.APPDATA, 'npm', 'node_modules', ...parts)
}

/** Parse cursor-agent version dir names (YYYY.MM.DD[-HH-MM-SS]-hash) → sortable int. */
function cursorAgentVersionKey(name) {
  const datePart = String(name || '').split('-')[0]
  const parts = datePart.split('.')
  if (parts.length !== 3) return 0
  const [y, m, d] = parts
  if (!/^\d{4}$/.test(y) || !/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(d)) return 0
  return Number(y + m.padStart(2, '0') + d.padStart(2, '0'))
}

/**
 * Prefer `%LOCALAPPDATA%/cursor-agent/versions/<latest>/{node.exe,index.js}`
 * so we avoid the PowerShell wrapper + piped-stdio EINVAL on Windows.
 * @returns {{ command: string, argsPrefix: string[], shell: boolean } | null}
 */
function resolveCursorAgentInstall() {
  const base = process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'cursor-agent')
    : ''
  if (!base || !existsSync(base)) return null

  const rootNode = join(base, 'node.exe')
  const rootIndex = join(base, 'index.js')
  if (existsSync(rootNode) && existsSync(rootIndex)) {
    return { command: rootNode, argsPrefix: [rootIndex], shell: false }
  }

  const versionsDir = join(base, 'versions')
  if (!existsSync(versionsDir)) return null
  let dirs = []
  try {
    dirs = readdirSync(versionsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .filter((n) => cursorAgentVersionKey(n) > 0)
      .sort((a, b) => cursorAgentVersionKey(b) - cursorAgentVersionKey(a))
  } catch {
    return null
  }
  for (const name of dirs) {
    const dir = join(versionsDir, name)
    const nodePath = join(dir, 'node.exe')
    const indexJs = join(dir, 'index.js')
    if (existsSync(nodePath) && existsSync(indexJs)) {
      return { command: nodePath, argsPrefix: [indexJs], shell: false }
    }
  }
  return null
}

/**
 * @param {string} bin
 * @param {{ knownName?: string }} [opts]
 * @returns {{ command: string, argsPrefix: string[], shell: boolean, display: string }}
 */
export function resolveBin(bin, opts = {}) {
  const raw = String(bin || '').trim() || 'codex'
  const display = raw
  const knownName = opts.knownName || ''

  if (/\.m?js$/i.test(raw)) {
    return {
      command: process.execPath,
      argsPrefix: [resolve(raw)],
      shell: false,
      display,
    }
  }

  if (process.platform === 'win32') {
    const hasSep = /[\\/]/.test(raw)
    const hasExt = /\.(cmd|exe|bat|ps1)$/i.test(raw)
    const bare = !hasSep && !hasExt
    const baseName = bare
      ? raw.toLowerCase()
      : raw
          .replace(/\\/g, '/')
          .split('/')
          .pop()
          .replace(/\.(cmd|exe|bat|ps1)$/i, '')
          .toLowerCase()

    const knownParts = KNOWN_JS[knownName] || KNOWN_JS[baseName]
    if (knownParts) {
      const guess = appDataNpmJs(knownParts)
      if (guess && existsSync(guess)) {
        return {
          command: process.execPath,
          argsPrefix: [guess],
          shell: false,
          display,
        }
      }
    }

    if (
      knownName === 'agent' ||
      baseName === 'agent' ||
      baseName === 'cursor-agent'
    ) {
      const cursor = resolveCursorAgentInstall()
      if (cursor) {
        return { ...cursor, display }
      }
    }

    if (bare || /\.(cmd|bat|ps1)$/i.test(raw)) {
      const asCmd = bare ? `${raw}.cmd` : raw.replace(/\.ps1$/i, '.cmd')
      return {
        command: asCmd,
        argsPrefix: [],
        shell: true,
        display,
      }
    }
  }

  return {
    command: raw,
    argsPrefix: [],
    shell: false,
    display,
  }
}
