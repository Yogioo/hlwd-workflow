/**
 * 两个看板的静态资源入口。白名单是字面量，请求路径永远不参与拼文件路径。
 */

import { readFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
}

const SHARED = {
  'theme.css': join(here, 'theme.css'),
  'client.mjs': join(here, 'client.mjs'),
  'events.mjs': join(here, 'events.mjs'),
  'markdown.mjs': join(here, 'markdown.mjs'),
  'format.mjs': join(here, 'format.mjs'),
}

/** `null` 表示不在白名单里，调用方继续走自己的路由。 */
export function sharedAsset(name) {
  const file = SHARED[name]
  return file ? { file, ...readAsset(file) } : null
}

/** 页面自己的 app.js 也用它，省得每个服务各写一遍 mime。 */
export function readAsset(file) {
  return {
    body: readFileSync(file),
    type: TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
  }
}

export function pageHead(title, extraHead = '') {
  return '<!doctype html>\n<html lang="zh"><head><meta charset="utf-8"/>\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"/>\n' +
    `<title>${title}</title><link rel="stylesheet" href="/assets/theme.css"/>${extraHead}</head>`
}

/**
 * 下钻弹窗的骨架。两张页面必须一模一样地挂它（布局在 theme.css、行为在 wireModal），
 * 所以只在这里写一份：谁要改外壳，两边一起改。
 */
export function modalShell() {
  return '<div id="modal"><div class="box"><div class="mh"><div id="mhead"></div>' +
    '<div class="mactions"><button id="mback">返回</button></div></div><div id="mbody"></div></div></div>'
}
