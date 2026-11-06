/**
 * Factory for work-item sources. Extracted from
 * skills/afk-run/scripts/task-sources/index.mjs, without the AFK loop.
 */

import { createBeadsSource } from './beads.mjs'
import { createGhSource } from './gh.mjs'
import { createTapdSource } from './tapd.mjs'
import { WorkItemsError } from './errors.mjs'

export const SOURCES = ['beads', 'gh', 'tapd']

export function createWorkSource(name, opts = {}) {
  const key = String(name || '').toLowerCase()
  switch (key) {
    case 'beads':
      return createBeadsSource(opts)
    case 'gh':
      return createGhSource(opts)
    case 'tapd':
      return createTapdSource(opts)
    default:
      throw new WorkItemsError(`未知任务源: ${name}（支持: ${SOURCES.join(', ')}）`, 2)
  }
}

export { createBeadsSource } from './beads.mjs'
export { createGhSource } from './gh.mjs'
export { createTapdSource } from './tapd.mjs'
export { WorkItemsError } from './errors.mjs'
