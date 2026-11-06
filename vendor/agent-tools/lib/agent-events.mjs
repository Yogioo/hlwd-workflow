// Adapted from skills/exec-review/scripts/normalize-event.mjs.
// Self-contained: Node built-ins only, no AFK configuration or sibling imports.
import { readFileSync } from 'node:fs'

/**
 * Unified normalized event model for all agent-run runners.
 *
 * @typedef {object} NormalizedEvent
 * @property {string} kind - 'tool' | 'assistant' | 'assistant_partial' | 'thinking' | 'thinking_partial' | 'outcome' | 'raw'
 * @property {number} t
 * @property {string} [callId]
 * @property {string} [phase] - 'start' | 'done' for tool events
 * @property {string} [toolName]
 * @property {unknown} [args]
 * @property {unknown} [result]
 * @property {string} [text]
 * @property {unknown} [payload]
 */

/** @typedef {'agent' | 'codex' | 'pi'} RunnerSource */

/**
 * Single normalize entry for all runners. No runner name appears on output events.
 * @param {unknown} raw
 * @param {RunnerSource | 'auto'} [source]
 * @returns {NormalizedEvent}
 */
export function normalizeEvent(raw, source = 'auto') {
  const src = source === 'auto' ? detectSource(raw) : source
  switch (src) {
    case 'codex':
      return normalizeCodexEvent(raw)
    case 'pi':
      return normalizePiEvent(raw)
    case 'agent':
    default:
      return normalizeAgentEvent(raw)
  }
}

/**
 * @param {unknown} raw
 * @returns {RunnerSource}
 */
export function detectSource(raw) {
  if (!raw || typeof raw !== 'object') return 'agent'
  /** @type {Record<string, unknown>} */
  const ev = /** @type {Record<string, unknown>} */ (raw)
  const type = String(ev.type || '')

  if (type === 'assistant' || type === 'tool_call' || type === 'result' || type === 'thinking') {
    return 'agent'
  }
  if (type === 'session' || type === 'message_end' || type === 'tool_execution_start') return 'pi'
  if (
    type.startsWith('item.') ||
    type.startsWith('turn.') ||
    type.startsWith('thread.') ||
    type === 'error' ||
    ev.msg != null
  ) {
    return 'codex'
  }
  if (type === 'agent_start' || type === 'turn_start' || type === 'tool_execution_end') return 'pi'

  return 'agent'
}

/**
 * Map Cursor agent tool_call keys (e.g. readToolCall) to short names (read).
 * @param {string} raw
 */
export function mapAgentToolName(raw) {
  const name = String(raw || 'unknown')
  if (name.endsWith('ToolCall')) return name.slice(0, -'ToolCall'.length)
  return name
}

/**
 * @param {unknown} raw
 * @returns {NormalizedEvent}
 */
export function normalizeAgentEvent(raw) {
  const t = Date.now()
  if (!raw || typeof raw !== 'object') {
    return { kind: 'raw', t, payload: raw }
  }
  /** @type {Record<string, unknown>} */
  const ev = /** @type {Record<string, unknown>} */ (raw)
  const type = String(ev.type || '')

  if (type === 'thinking') {
    const subtype = String(ev.subtype || '')
    const text = typeof ev.text === 'string' ? ev.text : extractMessageContentText(ev)
    if (subtype === 'delta' || subtype === 'partial') {
      return { kind: 'thinking_partial', t, text, payload: raw }
    }
    // completed (and other terminals): close the streaming block; text may be empty
    return { kind: 'thinking', t, text, payload: raw }
  }

  if (type === 'assistant') {
    const text = extractMessageContentText(ev.message)
    const subtype = String(ev.subtype || '')
    if (subtype === 'partial' || ev.partial === true) {
      return { kind: 'assistant_partial', t, text, payload: raw }
    }
    return { kind: 'assistant', t, text, payload: raw }
  }

  if (type === 'tool_call') {
    const subtype = String(ev.subtype || '')
    const callId = String(ev.call_id || ev.callId || '')
    const toolCall = ev.tool_call && typeof ev.tool_call === 'object' ? ev.tool_call : {}
    const rawName = Object.keys(toolCall)[0] || 'unknown'
    const toolName = mapAgentToolName(rawName)
    // Cursor nests under readToolCall / grepToolCall — look up the raw key, not the short name.
    const toolBody =
      (toolCall[rawName] && typeof toolCall[rawName] === 'object' ? toolCall[rawName] : null) ||
      (toolCall[toolName] && typeof toolCall[toolName] === 'object' ? toolCall[toolName] : null) ||
      {}
    const phase = subtype === 'completed' ? 'done' : 'start'
    return {
      kind: 'tool',
      t,
      callId,
      phase,
      toolName,
      args: toolBody.args,
      result: toolBody.result,
      payload: raw,
    }
  }

  if (type === 'result') {
    const text = typeof ev.result === 'string' ? ev.result : ''
    return { kind: 'outcome', t, text, payload: raw }
  }

  return { kind: 'raw', t, payload: raw }
}

/**
 * @param {unknown} raw
 * @returns {NormalizedEvent}
 */
export function normalizeCodexEvent(raw) {
  const t = Date.now()
  if (!raw || typeof raw !== 'object') {
    return { kind: 'raw', t, payload: raw }
  }
  /** @type {Record<string, unknown>} */
  const ev = /** @type {Record<string, unknown>} */ (raw)

  const msg = ev.msg
  if (msg && typeof msg === 'object') {
    /** @type {Record<string, unknown>} */
    const m = /** @type {Record<string, unknown>} */ (msg)
    if (m.type === 'text' && m.content != null) {
      return { kind: 'assistant', t, text: String(m.content), payload: raw }
    }
  }

  const method = String(ev.method || '')
  if (method.startsWith('item/')) {
    const params = ev.params && typeof ev.params === 'object' ? ev.params : {}
    const item = params.item && typeof params.item === 'object' ? params.item : null
    if (item) return mapCodexItem(item, method.endsWith('completed') ? 'done' : 'start', t, raw)
  }

  const type = String(ev.type || '')
  if (type === 'item.completed' || type === 'item.started') {
    const item = ev.item && typeof ev.item === 'object' ? ev.item : null
    if (item) return mapCodexItem(item, type === 'item.completed' ? 'done' : 'start', t, raw)
  }

  if (type.startsWith('item.')) {
    const suffix = type.slice('item.'.length)
    const item = ev.item && typeof ev.item === 'object' ? ev.item : ev
    if (item && typeof item === 'object') {
      const phase = suffix === 'completed' || suffix.includes('completed') ? 'done' : 'start'
      return mapCodexItem(item, phase, t, raw)
    }
  }

  return { kind: 'raw', t, payload: raw }
}

/**
 * @param {Record<string, unknown>} item
 * @param {'start' | 'done'} phase
 * @param {number} t
 * @param {unknown} raw
 * @returns {NormalizedEvent}
 */
function mapCodexItem(item, phase, t, raw) {
  const itemType = String(item.type || '')
  const callId = String(item.id || item.item_id || '')

  if (itemType === 'agent_message' || itemType === 'agentMessage') {
    const text = String(item.text || item.content || '')
    if (phase === 'done' && text) {
      return { kind: 'assistant', t, text, payload: raw }
    }
    return { kind: 'raw', t, payload: raw }
  }

  if (itemType === 'command_execution' || itemType === 'commandExecution') {
    return {
      kind: 'tool',
      t,
      callId,
      phase,
      toolName: 'shell',
      args: { command: item.command },
      result:
        phase === 'done'
          ? { exit_code: item.exit_code ?? item.exitCode, output: item.output ?? item.aggregated_output }
          : undefined,
      payload: raw,
    }
  }

  if (itemType === 'file_change' || itemType === 'fileChange') {
    return {
      kind: 'tool',
      t,
      callId,
      phase,
      toolName: 'edit',
      args: { path: item.path, action: item.action },
      payload: raw,
    }
  }

  if (itemType === 'mcp_tool_call' || itemType === 'mcpToolCall') {
    return {
      kind: 'tool',
      t,
      callId,
      phase,
      toolName: String(item.tool_name || item.toolName || 'mcp'),
      args: item.arguments ?? item.args,
      result: phase === 'done' ? item.result : undefined,
      payload: raw,
    }
  }

  if (itemType) {
    return {
      kind: 'tool',
      t,
      callId,
      phase,
      toolName: itemType,
      args: item,
      payload: raw,
    }
  }

  return { kind: 'raw', t, payload: raw }
}

/**
 * @param {unknown} raw
 * @returns {NormalizedEvent}
 */
export function normalizePiEvent(raw) {
  const t = Date.now()
  if (!raw || typeof raw !== 'object') {
    return { kind: 'raw', t, payload: raw }
  }
  /** @type {Record<string, unknown>} */
  const ev = /** @type {Record<string, unknown>} */ (raw)
  const type = String(ev.type || '')

  // pi 的思考与正文都是流式的：`message_update.assistantMessageEvent` 里先来一串
  // delta，最后 `thinking_end` / `text_end` 会把**完整内容**一并给出（实测一轮
  // 51k 条 thinking_delta，而 end 只有 85 条）。只认 end 就能拿到全文，不必自己拼。
  if (type === 'message_update') {
    const inner = ev.assistantMessageEvent
    if (!inner || typeof inner !== 'object') return { kind: 'raw', t, payload: raw }
    /** @type {Record<string, unknown>} */
    const update = /** @type {Record<string, unknown>} */ (inner)
    const sub = String(update.type || '')
    const delta = typeof update.delta === 'string' ? update.delta : ''
    const content = typeof update.content === 'string' ? update.content : ''
    if (sub === 'thinking_delta') return { kind: 'thinking_partial', t, text: delta, payload: raw }
    if (sub === 'thinking_end') return { kind: 'thinking', t, text: content, payload: raw }
    if (sub === 'text_delta') return { kind: 'assistant_partial', t, text: delta, payload: raw }
    if (sub === 'text_end') return { kind: 'assistant', t, text: content, payload: raw }
    return { kind: 'raw', t, payload: raw }
  }

  if (type === 'message_end') {
    const text = extractPiMessageText(ev.message)
    if (text) return { kind: 'assistant', t, text, payload: raw }
    return { kind: 'raw', t, payload: raw }
  }

  if (type === 'tool_execution_start') {
    return {
      kind: 'tool',
      t,
      callId: String(ev.toolCallId || ''),
      phase: 'start',
      toolName: String(ev.toolName || 'tool'),
      args: ev.args,
      payload: raw,
    }
  }

  if (type === 'tool_execution_end') {
    return {
      kind: 'tool',
      t,
      callId: String(ev.toolCallId || ''),
      phase: 'done',
      toolName: String(ev.toolName || 'tool'),
      result: ev.result,
      payload: raw,
    }
  }

  if (type === 'turn_end' || type === 'agent_end') {
    const text = extractPiMessageText(ev.message) || extractPiAgentEndText(ev)
    if (text) {
      const parsed = extractJsonFromText(text)
      if (parsed && typeof parsed === 'object' && 'status' in parsed) {
        return { kind: 'outcome', t, text, payload: raw }
      }
      return { kind: 'assistant', t, text, payload: raw }
    }
  }

  return { kind: 'raw', t, payload: raw }
}

/**
 * @param {unknown} message
 */
function extractPiMessageText(message) {
  if (!message || typeof message !== 'object') return ''
  /** @type {Record<string, unknown>} */
  const msg = /** @type {Record<string, unknown>} */ (message)
  if (msg.role && msg.role !== 'assistant') return ''
  if (typeof msg.text === 'string' && msg.text) return msg.text
  return extractMessageContentText(message)
}

/**
 * @param {Record<string, unknown>} ev
 */
function extractPiAgentEndText(ev) {
  const messages = ev.messages
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const text = extractPiMessageText(messages[i])
    if (text) return text
  }
  return ''
}

/**
 * @param {unknown} msg
 */
function extractMessageContentText(msg) {
  if (!msg || typeof msg !== 'object') return ''
  /** @type {Record<string, unknown>} */
  const m = /** @type {Record<string, unknown>} */ (msg)
  if (typeof m.text === 'string') return m.text
  const content = m.content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (part && typeof part === 'object') {
        if ('text' in part) return String(part.text || '')
        if ('type' in part && part.type === 'text' && 'text' in part) return String(part.text || '')
      }
      return ''
    })
    .join('')
}

/**
 * Extract stdout out-file text from a raw runner event (best-effort).
 * @param {unknown} raw
 * @param {RunnerSource} runner
 * @returns {string}
 */
export function extractOutTextFromRaw(raw, runner) {
  if (!raw || typeof raw !== 'object') return ''
  /** @type {Record<string, unknown>} */
  const ev = /** @type {Record<string, unknown>} */ (raw)

  if (runner === 'agent') {
    if (ev.type === 'result' && typeof ev.result === 'string') return ev.result
    return ''
  }

  if (runner === 'pi') {
    if (ev.type === 'message_end') return extractPiMessageText(ev.message)
    if (ev.type === 'turn_end' || ev.type === 'agent_end') {
      return extractPiMessageText(ev.message) || extractPiAgentEndText(ev)
    }
    return ''
  }

  if (runner === 'codex') {
    const type = String(ev.type || '')
    if (type === 'item.completed' || type.startsWith('item.')) {
      const item = ev.item && typeof ev.item === 'object' ? ev.item : null
      if (item) {
        const itemType = String(item.type || '')
        if (itemType === 'agent_message' || itemType === 'agentMessage') {
          return String(item.text || item.content || '')
        }
      }
    }
  }

  return ''
}

/**
 * @param {string} text
 * @returns {object | null}
 */
export function extractJsonFromText(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const tryParse = (s) => {
    try {
      return JSON.parse(s)
    } catch {
      return null
    }
  }
  let v = tryParse(raw)
  if (v) return v
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence) {
    v = tryParse(fence[1].trim())
    if (v) return v
  }
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) {
    v = tryParse(raw.slice(start, end + 1))
    if (v) return v
  }
  return null
}

/**
 * Parse normalized events file and extract executor/reviewer JSON object.
 * @param {string} eventsFile
 * @returns {object | null}
 */
export function extractJsonFromEventsFile(eventsFile) {
  let text = ''
  try {
    text = readFileSync(eventsFile, 'utf8')
  } catch {
    return null
  }
  if (!text.trim()) return null

  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      /* skip bad lines */
    }
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev?.kind === 'outcome' && ev.text) {
      const parsed = extractJsonFromText(ev.text)
      if (parsed) return parsed
    }
  }

  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev?.kind === 'assistant' && ev.text) {
      const parsed = extractJsonFromText(ev.text)
      if (parsed) return parsed
    }
  }

  return null
}
