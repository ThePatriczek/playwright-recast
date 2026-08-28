import type { HighlightEvent } from '../types/text-highlight.js'

/**
 * End each highlight when the next one begins, so only one is ever on screen.
 *
 * Durations are nominal wall-clock values while `videoTimeMs` is on the
 * speed-mapped output clock, so compressing idle time pulls marks closer
 * together than their durations. Every mark is then fitted to the window it
 * has — its own, or the one the next mark leaves it: `fadeOut` takes at most
 * half of it, so the mark is solid before it fades, and `swipeDuration` shrinks
 * to fit. A mark with no window at all — two on the same timestamp, an event
 * already clamped to nothing — is dropped.
 *
 * Fitting applies to every mark, not just clamped ones: the pipeline clamps a
 * highlight to its subtitle's end, which can already leave it shorter than its
 * configured `fadeOut`, and the renderer needs a positive pre-fade duration.
 */
export function makeHighlightsExclusive(
  events: ReadonlyArray<HighlightEvent>,
): HighlightEvent[] {
  const sorted = [...events].sort((a, b) => a.videoTimeMs - b.videoTimeMs)
  const exclusive: HighlightEvent[] = []

  for (let i = 0; i < sorted.length; i++) {
    const current = sorted[i]!
    const next = sorted[i + 1]
    const endTimeMs = next === undefined
      ? current.endTimeMs
      : Math.min(current.endTimeMs, next.videoTimeMs)
    const window = endTimeMs - current.videoTimeMs

    // No window at all: two marks on the same timestamp, or an empty event.
    // Either way there is nothing to render — ffmpeg rejects a zero-length clip.
    if (window <= 0) continue

    exclusive.push({
      ...current,
      endTimeMs,
      fadeOut: Math.min(current.fadeOut, Math.floor(window / 2)),
      swipeDuration: Math.min(current.swipeDuration, window),
    })
  }

  return exclusive
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
