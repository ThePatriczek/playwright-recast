import {
  NARRATE_TITLE_PREFIX,
  NARRATE_HIDDEN_TITLE_PREFIX,
  WAIT_FOR_NARRATION_TITLE_PREFIX,
} from '../helpers.js'
import type { SubtitleEntry } from '../types/subtitle.js'

/** Minimal projection of a trace action that this builder needs.
 *  Kept narrow so we can unit-test without constructing full TraceAction. */
export interface NarrationMarkerAction {
  title: string
  startTime: number
  /** See sceneOf() */
  sceneId?: string
}

/**
 * Build subtitle entries from a list of narrate / waitForNarration marker
 * actions in trace order.
 *
 * - A `narrate()` marker produces one subtitle whose window starts at its
 *   `startTime` and ends at the earliest of: the next narrate marker, the
 *   next waitForNarration marker, or `traceEndMs`.
 * - A `narrate({hidden:true})` marker still bounds the previous visible
 *   window but produces no subtitle of its own.
 * - A `waitForNarration()` marker bounds the previous visible window but
 *   produces no subtitle of its own.
 * - A narration whose trace window is non-positive is kept with `endMs` clamped
 *   to `startMs` (zero duration); voiceover later sizes it from the audio, and
 *   the renderer drops any still-zero-duration line before burn-in.
 */
export function buildNarrationSubtitles(
  actions: ReadonlyArray<NarrationMarkerAction>,
  timeRemap: (traceMs: number) => number,
  traceEndMs: number,
): SubtitleEntry[] {
  const subtitles: SubtitleEntry[] = []

  for (let i = 0; i < actions.length; i++) {
    const current = actions[i]!
    const isVisible = isNarrateTitle(current.title)
    const isHidden = current.title.startsWith(NARRATE_HIDDEN_TITLE_PREFIX)
    if (!isVisible && !isHidden) continue // marker that doesn't open a window
    if (isHidden) continue // hidden narrate: bounds neighbours only, no output

    const next = actions[i + 1]
    const startMs = timeRemap(current.startTime)
    const rawEndMs = next ? timeRemap(next.startTime) : traceEndMs
    // Keep the line even when its trace window is ~0 (fast trace + a near-
    // immediate waitForNarration() / next narrate()). Clamp so we never emit an
    // inverted window. Voiceover stretches such a line to its audio length and
    // freezes at the boundary; lines still at zero duration after voiceover (or
    // with no voiceover) are dropped before burn-in by the renderer.
    const endMs = Math.max(startMs, rawEndMs)

    const text = current.title.slice(NARRATE_TITLE_PREFIX.length)
    subtitles.push({
      index: subtitles.length + 1,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      text,
      ...(next ? { endTraceMs: next.startTime } : {}),
      ...(current.sceneId ? { sceneId: current.sceneId } : {}),
    })
  }

  return subtitles
}

/** True if `title` is a visible `narrate()` marker, the kind that gets a cue. */
export function isNarrateTitle(title: string): boolean {
  return title.startsWith(NARRATE_TITLE_PREFIX)
}

/** True if `title` is any of the marker prefixes this builder cares about. */
export function isNarrationBoundaryTitle(title: string): boolean {
  return (
    title.startsWith(NARRATE_TITLE_PREFIX) ||
    title.startsWith(NARRATE_HIDDEN_TITLE_PREFIX) ||
    title === WAIT_FOR_NARRATION_TITLE_PREFIX
  )
}

/**
 * The scene an action ran in: its outermost `test.step()` ancestor, if that
 * step holds a visible narration. Hook and fixture containers don't count,
 * so each `beforeEach` step is a scene of its own. Undefined in the test
 * body, in steps without narration (page-object helpers) and for a broken
 * parent chain: such overlays match any narration.
 */
export function sceneOf(
  actions: ReadonlyArray<{ callId: string; parentId?: string; method?: string; title?: string }>,
): (action: { callId?: string; parentId?: string }) => string | undefined {
  const byId = new Map(actions.map((a) => [a.callId, a]))
  const outermostStep = (action: { parentId?: string }): string | undefined => {
    let top: string | undefined
    const seen = new Set<string>()
    for (let id = action.parentId; id && !seen.has(id); id = byId.get(id)?.parentId) {
      seen.add(id)
      const parent = byId.get(id)
      if (!parent) return undefined
      if (parent.method === 'test.step') top = id
    }
    return top
  }
  const scenes = new Set<string>()
  for (const a of actions) {
    // Hidden narrations get no cue, so they make no scene
    if (typeof a.title !== 'string' || !isNarrateTitle(a.title)) continue
    const top = outermostStep(a)
    if (top) scenes.add(top)
  }
  return (action) => {
    const top = outermostStep(action)
    return top && scenes.has(top) ? top : undefined
  }
}

/** Two scenes match unless both are known and differ. */
export function sameScene(a: string | undefined, b: string | undefined): boolean {
  return a === undefined || b === undefined || a === b
}

/**
 * The narration an overlay at `t` belongs to: the one playing, else the next
 * one, each only if it is in the overlay's scene. One rule for zoom() and
 * highlight({ duration: 'narration' }).
 */
export function ownerNarration<T>(
  sorted: ReadonlyArray<T>,
  t: number,
  scene: string | undefined,
  span: (item: T) => [start: number, end: number],
  sceneOfItem: (item: T) => string | undefined,
): T | undefined {
  const playing = sorted.find((item) => { const [a, b] = span(item); return a <= t && t < b })
  if (playing && sameScene(scene, sceneOfItem(playing))) return playing
  const next = sorted.find((item) => span(item)[0] >= t)
  return next && sameScene(scene, sceneOfItem(next)) ? next : undefined
}
