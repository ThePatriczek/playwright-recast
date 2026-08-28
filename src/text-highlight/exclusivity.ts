import type { HighlightEvent } from '../types/text-highlight.js'

/** Shortest window a clamped highlight may keep, in ms. */
export const MIN_HIGHLIGHT_WINDOW_MS = 200

/**
 * End each highlight when the next one begins, so only one is ever on screen.
 *
 * Durations are nominal wall-clock values while `videoTimeMs` is on the
 * speed-mapped output clock, so compressing idle time pulls marks closer
 * together than their durations. Shortens `endTimeMs` (and `fadeOut`, which
 * the renderer subtracts from the clip length) but never below
 * `MIN_HIGHLIGHT_WINDOW_MS`, so a crowded mark still flashes visibly.
 */
export function makeHighlightsExclusive(
  events: ReadonlyArray<HighlightEvent>,
): HighlightEvent[] {
  const sorted = [...events].sort((a, b) => a.videoTimeMs - b.videoTimeMs)

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i]!
    const next = sorted[i + 1]!
    if (current.endTimeMs <= next.videoTimeMs) continue

    const clampedEnd = Math.max(
      next.videoTimeMs,
      current.videoTimeMs + MIN_HIGHLIGHT_WINDOW_MS,
    )
    const window = clampedEnd - current.videoTimeMs
    // The renderer builds the clip as (end - start - fadeOut), so a fade longer
    // than the shortened window would produce a non-positive duration.
    const fadeOut = Math.min(current.fadeOut, Math.max(0, window - MIN_HIGHLIGHT_WINDOW_MS))
    sorted[i] = { ...current, endTimeMs: clampedEnd, fadeOut }
  }

  return sorted
}

/**
 * Move highlights onto the freeze-extended timeline, keeping each one's
 * configured duration.
 *
 * Only freezes *before* a mark shift it. Shifting its end independently would
 * also add the freezes inside its window, holding it on the frozen frame for
 * the whole spoken line.
 */
export function shiftHighlightsForFreezes(
  events: ReadonlyArray<HighlightEvent>,
  freezes: ReadonlyArray<{ atVideoMs: number; durationMs: number }>,
): HighlightEvent[] {
  return events.map((event) => {
    const durationMs = event.endTimeMs - event.videoTimeMs
    let shift = 0
    for (const freeze of freezes) {
      if (freeze.atVideoMs <= event.videoTimeMs) shift += freeze.durationMs
    }
    const videoTimeMs = event.videoTimeMs + shift
    return { ...event, videoTimeMs, endTimeMs: videoTimeMs + durationMs }
  })
}
