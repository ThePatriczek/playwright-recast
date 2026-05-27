import { CLICK_TITLE_PREFIX } from '../helpers.js'

/** A click marker parsed from a `__recast_click__` trace step. */
export interface ClickMarker {
  x: number
  y: number
  startTime: number
}

/** An auto-detected click action (click/selectOption with a point). */
export interface AutoClick {
  callId: string
  x: number
  y: number
  startTime: number
  endTime: number
}

/** A reconciled click: either a marker (marked) or an unmatched auto-click. */
export interface ResolvedClick {
  x: number
  y: number
  /** Trace time to render at: the marker's time, or the auto-click's endTime. */
  traceTimeMs: number
  marked: boolean
}

/** Parse `__recast_click__` marker steps out of a trace action list. */
export function parseClickMarkers(
  actions: ReadonlyArray<{ title?: unknown; startTime: number }>,
): ClickMarker[] {
  const markers: ClickMarker[] = []
  for (const a of actions) {
    if (typeof a.title !== 'string' || !a.title.startsWith(CLICK_TITLE_PREFIX)) continue
    try {
      const data = JSON.parse(a.title.slice(CLICK_TITLE_PREFIX.length)) as { x: number; y: number }
      if (typeof data.x === 'number' && typeof data.y === 'number') {
        markers.push({ x: data.x, y: data.y, startTime: a.startTime })
      }
    } catch {
      // skip malformed markers
    }
  }
  return markers
}

/**
 * Reconcile explicit click markers with auto-detected click actions.
 *
 * A marker matches an auto-click when their positions are within
 * `posTolerancePx` and the marker time falls within the action's
 * [startTime - preWindowMs, endTime + postWindowMs] window (the convenience
 * `click()` emits the marker just before the action, which may auto-wait for
 * seconds). Matched auto-clicks are suppressed — the marker drives them.
 * Unmatched markers still render; unmatched auto-clicks render as before.
 */
export function resolveClickMarkers(
  autoClicks: ReadonlyArray<AutoClick>,
  markers: ReadonlyArray<ClickMarker>,
  opts?: { posTolerancePx?: number; preWindowMs?: number; postWindowMs?: number },
): { resolved: ResolvedClick[]; consumedCallIds: Set<string> } {
  const posTol = opts?.posTolerancePx ?? 8
  const pre = opts?.preWindowMs ?? 300
  const post = opts?.postWindowMs ?? 300
  const consumed = new Set<string>()
  const resolved: ResolvedClick[] = []

  for (const m of markers) {
    let best: AutoClick | undefined
    let bestDelta = Infinity
    for (const a of autoClicks) {
      if (consumed.has(a.callId)) continue
      if (Math.abs(a.x - m.x) > posTol || Math.abs(a.y - m.y) > posTol) continue
      if (m.startTime < a.startTime - pre || m.startTime > a.endTime + post) continue
      const delta = Math.abs(m.startTime - a.startTime)
      if (delta < bestDelta) {
        best = a
        bestDelta = delta
      }
    }
    if (best) consumed.add(best.callId)
    resolved.push({ x: m.x, y: m.y, traceTimeMs: m.startTime, marked: true })
  }

  for (const a of autoClicks) {
    if (consumed.has(a.callId)) continue
    resolved.push({ x: a.x, y: a.y, traceTimeMs: a.endTime, marked: false })
  }

  resolved.sort((p, q) => p.traceTimeMs - q.traceTimeMs)
  return { resolved, consumedCallIds: consumed }
}
