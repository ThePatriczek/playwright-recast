import type { HighlightEvent } from '../types/text-highlight.js'

/**
 * End each highlight when the next one begins, so only one is ever on screen.
 *
 * Durations are nominal wall-clock values while `videoTimeMs` is on the
 * speed-mapped output clock, so compressing idle time pulls marks closer
 * together than their durations. Every mark is then fitted to the window it
 * has — its own, or the one the next mark leaves it: `fadeOut` takes at most
 * half of it, so the mark is solid before it fades, and `swipeDuration` fits in
 * the solid part, so the rectangle is fully revealed before the fade starts. A mark with no window at all — two on the same timestamp, an event
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

    // The swipe has to finish before the fade starts, so it gets the solid
    // part of the window, not all of it.
    const fadeOut = Math.min(current.fadeOut, Math.floor(window / 2))
    exclusive.push({
      ...current,
      endTimeMs,
      fadeOut,
      swipeDuration: Math.min(current.swipeDuration, window - fadeOut),
    })
  }

  return exclusive
}

/**
 * End each `untilNarrationEnd` highlight when its narration's audio ends.
 *
 * A mark belongs to the narration being spoken when it appears, else to the
 * next one: `highlight()` usually runs just before the `narrate()` it
 * illustrates. "Spoken" is the speech itself, not the cue's window, which
 * silence pads out to the next marker. Both inputs must be on the output
 * (freeze-extended) timeline. Marks with no narration at or after them keep
 * their end.
 */
export function endHighlightsWithNarration(
  events: ReadonlyArray<HighlightEvent>,
  narrations: ReadonlyArray<{ outputStartMs: number; outputEndMs: number; spokenEndMs?: number }>,
): HighlightEvent[] {
  const sorted = [...narrations].sort((a, b) => a.outputStartMs - b.outputStartMs)
  const spokenEnd = (n: (typeof sorted)[number]) => n.spokenEndMs ?? n.outputEndMs
  return events.map((event) => {
    if (!event.untilNarrationEnd) return event
    const owner =
      sorted.find((n) => n.outputStartMs <= event.videoTimeMs && event.videoTimeMs < spokenEnd(n)) ??
      sorted.find((n) => n.outputStartMs >= event.videoTimeMs)
    return owner ? { ...event, endTimeMs: Math.round(spokenEnd(owner)) } : event
  })
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
