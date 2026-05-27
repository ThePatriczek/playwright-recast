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
 * - Subtitles with non-positive duration are dropped.
 */
export function buildNarrationSubtitles(
  actions: ReadonlyArray<NarrationMarkerAction>,
  timeRemap: (traceMs: number) => number,
  traceEndMs: number,
): SubtitleEntry[] {
  const subtitles: SubtitleEntry[] = []

  for (let i = 0; i < actions.length; i++) {
    const current = actions[i]!
    const isVisible = current.title.startsWith(NARRATE_TITLE_PREFIX)
    const isHidden = current.title.startsWith(NARRATE_HIDDEN_TITLE_PREFIX)
    if (!isVisible && !isHidden) continue // marker that doesn't open a window
    if (isHidden) continue // hidden narrate: bounds neighbours only, no output

    const next = actions[i + 1]
    const startMs = timeRemap(current.startTime)
    const endMs = next ? timeRemap(next.startTime) : traceEndMs
    if (endMs <= startMs) continue

    const text = current.title.slice(NARRATE_TITLE_PREFIX.length)
    subtitles.push({
      index: subtitles.length + 1,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      text,
    })
  }

  return subtitles
}

/** True if `title` is any of the marker prefixes this builder cares about. */
export function isNarrationBoundaryTitle(title: string): boolean {
  return (
    title.startsWith(NARRATE_TITLE_PREFIX) ||
    title.startsWith(NARRATE_HIDDEN_TITLE_PREFIX) ||
    title === WAIT_FOR_NARRATION_TITLE_PREFIX
  )
}
