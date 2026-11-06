#!/usr/bin/env node
/**
 * board 常驻进程入口：被 `ensureBoard()` detached 拉起，或人手工 `board serve`。
 *
 * 只做三件事：按 argv 起服务、把启动行打一行 JSON 到 stdout（供调用方日志读）、
 * 收到 SIGTERM/SIGINT 时关掉监听。没有任何任务副作用。
 */

import { startBoardServer } from './board.mjs'

function flagOf(name, fallback) {
  const argv = process.argv.slice(2)
  const index = argv.indexOf(`--${name}`)
  return index >= 0 && argv[index + 1] != null ? argv[index + 1] : fallback
}

const host = flagOf('host', '127.0.0.1')
const port = Number(flagOf('port', '0')) || 0

const board = await startBoardServer({ host, port, preferred: port })
process.stdout.write(
  `${JSON.stringify({
    event: 'board_started',
    pid: process.pid,
    host: board.host,
    port: board.port,
    url: board.local,
    share: board.share,
  })}\n`,
)

let closing = false
const shutdown = async () => {
  if (closing) return
  closing = true
  await board.close()
  process.exit(0)
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
