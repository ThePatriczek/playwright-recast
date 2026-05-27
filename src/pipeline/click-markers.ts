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

/** Parse click markers that belong to the recording context. */
export function parseClickMarkersFromRecordingContext(
  actions: ReadonlyArray<{ title?: unknown; startTime: number }>,
  recordingStartMs: number,
): ClickMarker[] {
  return parseClickMarkers(actions.filter((a) => a.startTime >= recordingStartMs))
}

/**
 * Reconcile explicit click markers with auto-detected click actions.
 *
 * A marker matches an auto-click when their positions are within
 * `posTolerancePx` and the marker time falls within the action's
 * [startTime - preWindowMs, endTime + postWindowMs] window (the convenience
 * `click()` emits the marker just before the action, which may auto-wait for
 * seconds). Matched auto-clicks are suppressed — the marker drives them. When
 * multiple markers compete for one auto-click, the closest eligible marker wins
 * and the losing duplicates are dropped. Truly unmatched markers still render;
 * unmatched auto-clicks render as before.
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

  const candidates: Array<{ markerIndex: number; autoIndex: number; delta: number }> = []
  for (let markerIndex = 0; markerIndex < markers.length; markerIndex++) {
    const m = markers[markerIndex]!
    for (let autoIndex = 0; autoIndex < autoClicks.length; autoIndex++) {
      const a = autoClicks[autoIndex]!
      if (Math.abs(a.x - m.x) > posTol || Math.abs(a.y - m.y) > posTol) continue
      if (m.startTime < a.startTime - pre || m.startTime > a.endTime + post) continue
      const delta = Math.abs(m.startTime - a.startTime)
      candidates.push({ markerIndex, autoIndex, delta })
    }
  }

  candidates.sort((a, b) => {
    if (a.delta !== b.delta) return a.delta - b.delta
    const markerDelta = markers[a.markerIndex]!.startTime - markers[b.markerIndex]!.startTime
    if (markerDelta !== 0) return markerDelta
    return autoClicks[a.autoIndex]!.startTime - autoClicks[b.autoIndex]!.startTime
  })

  const markersWithCandidate = new Set(candidates.map((c) => c.markerIndex))
  const assignedMarkers = new Set<number>()
  const assignedAutos = new Set<number>()

  for (const c of candidates) {
    if (assignedMarkers.has(c.markerIndex) || assignedAutos.has(c.autoIndex)) continue
    assignedMarkers.add(c.markerIndex)
    assignedAutos.add(c.autoIndex)
    consumed.add(autoClicks[c.autoIndex]!.callId)
  }

  for (let markerIndex = 0; markerIndex < markers.length; markerIndex++) {
    if (!assignedMarkers.has(markerIndex) && markersWithCandidate.has(markerIndex)) continue
    const m = markers[markerIndex]!
    resolved.push({ x: m.x, y: m.y, traceTimeMs: m.startTime, marked: true })
  }

  for (let autoIndex = 0; autoIndex < autoClicks.length; autoIndex++) {
    if (assignedAutos.has(autoIndex)) continue
    const a = autoClicks[autoIndex]!
    resolved.push({ x: a.x, y: a.y, traceTimeMs: a.endTime, marked: false })
  }

  resolved.sort((p, q) => p.traceTimeMs - q.traceTimeMs)
  return { resolved, consumedCallIds: consumed }
}
