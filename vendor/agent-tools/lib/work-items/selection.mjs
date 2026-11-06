/**
 * Pure selection helpers shared by the work-item sources.
 *
 * These never touch the network or the filesystem, so callers can apply the
 * same readiness rules to cached facts. Source-specific priority scales and
 * dependency grammars stay in each adapter; this module only does labels and
 * stable ordering. Provenance: skills/afk-run/scripts/task-sources/*.mjs.
 */

/** Accept both `"name"` and `{ name }` label shapes (TAPD strings vs gh objects). */
export function labelName(label) {
  if (typeof label === 'string') return label
  return label && typeof label.name === 'string' ? label.name : ''
}

export function labelNames(labels) {
  return (Array.isArray(labels) ? labels : []).map(labelName).filter(Boolean)
}

export function hasLabel(labels, wanted) {
  if (!wanted) return false
  return labelNames(labels).some((name) => name === wanted)
}

export function hasAnyLabel(labels, wanted) {
  const set = new Set((Array.isArray(wanted) ? wanted : [wanted]).filter(Boolean))
  return labelNames(labels).some((name) => set.has(name))
}

/**
 * Stable ordering: lower priority number first, then id. `getPriority` may
 * return undefined/NaN, which sorts as 2 to match the legacy default.
 */
export function sortTasks(tasks, getPriority, getId) {
  const priorityOf = (task) => {
    const value = Number(getPriority(task))
    return Number.isFinite(value) ? value : 2
  }
  return [...tasks].sort(
    (a, b) => priorityOf(a) - priorityOf(b) || String(getId(a)).localeCompare(String(getId(b))),
  )
}

/**
 * Apply explicit label filters. Both lists are opt-in: an empty config keeps
 * every item, so a caller never silently loses unlabelled work.
 */
export function filterByLabels(items, getLabels, options = {}) {
  const readyLabel = options.readyLabel
  const excludeLabels = (options.excludeLabels || []).filter(Boolean)
  return items.filter((item) => {
    const labels = getLabels(item)
    if (readyLabel && !hasLabel(labels, readyLabel)) return false
    if (excludeLabels.length && hasAnyLabel(labels, excludeLabels)) return false
    return true
  })
}

export function priorityWithin(item, priority, options = {}) {
  const max = options.priorityMax
  const min = options.priorityMin
  if (max !== undefined && priority > max) return false
  if (min !== undefined && priority < min) return false
  return true
}
