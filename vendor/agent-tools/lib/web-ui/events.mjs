/**
 * 两个看板共用的时间线事件形状。纯函数，Node 和浏览器都能 import。
 *
 * kind:
 *   say | think | tool | tool_end | arm_start | arm_end | note
 * 其余字段按 kind 出现：text, name, detail, ms, arm, status, reason, tokens。
 */

export function fromProgressEvent(record) {
  const base = { t: Number(record?.t) || 0 }
  if (record?.arm) base.arm = String(record.arm)
  switch (record?.event) {
    case 'say':
      return { ...base, kind: 'say', text: String(record.text || '') }
    case 'think':
      return { ...base, kind: 'think', text: String(record.text || '') }
    case 'tool':
      return { ...base, kind: 'tool', name: String(record.name || 'tool'), detail: String(record.detail || ''), ...(Number.isFinite(Number(record.ms)) ? { ms: Number(record.ms) } : {}) }
    case 'arm_start':
      return { ...base, kind: 'arm_start', text: [record.runner, record.model, record.thinking].filter(Boolean).join(' · ') }
    case 'arm_end':
      return { ...base, kind: 'arm_end', status: String(record.status || ''), ...(record.reason ? { reason: String(record.reason) } : {}), ...(record.tokens ? { tokens: Number(record.tokens) } : {}) }
    case 'malformed_lines':
      return { ...base, kind: 'note', text: `${record.count || 0} 行记录损坏` }
    default:
      return { ...base, kind: 'note', text: String(record?.event || '') }
  }
}

export function fromProgress(records) {
  return (Array.isArray(records) ? records : []).map(fromProgressEvent)
}

/** pi / codex / cursor 的原始事件流；`t` 由调用方按自己的时间规则算好。 */
export function fromPiEvent(event, t = 0) {
  if (event?.type === 'message_end' && event.message?.role === 'assistant') {
    const text = contentText(event.message.content)
    return text.trim() ? { t, kind: 'say', text } : null
  }
  if (event?.type === 'tool_execution_start') {
    return { t, kind: 'tool', name: String(event.toolName || 'tool'), detail: argsDetail(event.args) }
  }
  if (event?.type === 'tool_execution_end') {
    return {
      t,
      kind: 'tool_end',
      name: String(event.toolName || 'tool'),
      ...(Number.isFinite(Number(event.durationMs)) ? { ms: Number(event.durationMs) } : {}),
      ...(event.isError ? { error: true } : {}),
    }
  }
  if (event?.type === 'agent_settled') {
    return { t, kind: 'note', text: event.aborted ? '被中断' : '正常结束', icon: '■' }
  }
  return null
}

export function contentText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((part) => part?.type === 'text').map((part) => part.text).join('\n')
}

export function argsDetail(args) {
  if (!args || typeof args !== 'object') return ''
  const pick = args.command || args.path || args.file_path || args.pattern || args.query || args.url
  if (pick) return String(pick).slice(0, 220)
  return JSON.stringify(args).slice(0, 220)
}
