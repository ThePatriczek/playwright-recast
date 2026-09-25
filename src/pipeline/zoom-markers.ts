import type { SubtitleEntry } from '../types/subtitle.js'

/**
 * The narration cue a `zoom()` marker at `tMs` belongs to: the one playing,
 * else the next one. A cue ends at `waitForNarration()`, so a zoom set just
 * before the `narrate()` it illustrates falls between two cues; matching only
 * the playing cue dropped it silently.
 */
export function cueForZoomMarker<T extends Pick<SubtitleEntry, 'startMs' | 'endMs'>>(
  subtitles: ReadonlyArray<T>,
  tMs: number,
): T | undefined {
  return subtitles.find((s) => tMs >= s.startMs && tMs < s.endMs)
    ?? subtitles.find((s) => s.startMs >= tMs)
}

/**
 * With a voiceover, move each zoom to the narration whose audio is playing at
 * its start, else to the next one - the rule `highlight({ duration:
 * 'narration' })` follows. A narration's subtitle stays open until the next
 * marker, so one spoken over a wait still owned a zoom set after its audio
 * had ended, and zoomed at the end of its window instead of during the line
 * the zoom was meant for. A narration that already has a zoom of its own
 * keeps it: that one was set later. A zoom with its own `endMs` (autoZoom())
 * follows the actions, not the narration, and stays. Mutates the subtitles,
 * which the entries reference, like the voiceover stage itself.
 */
export function moveZoomsToSpokenNarration(
  entries: ReadonlyArray<{ subtitle: SubtitleEntry; outputStartMs: number; outputEndMs: number; spokenEndMs?: number }>,
): void {
  const sorted = [...entries].sort((a, b) => a.outputStartMs - b.outputStartMs)
  for (const entry of sorted) {
    const zoom = entry.subtitle.zoom
    if (!zoom || zoom.endMs !== undefined) continue
    const t = zoom.startMs ?? entry.subtitle.startMs
    // The speech, not the cue's window: silence pads that to the next marker.
    const owner = sorted.find((e) => e.outputStartMs <= t && t < (e.spokenEndMs ?? e.outputEndMs))
      ?? sorted.find((e) => e.outputStartMs >= t)
    if (!owner || owner === entry) continue
    delete entry.subtitle.zoom
    if (owner.subtitle.zoom) continue
    owner.subtitle.zoom = { ...zoom, startMs: Math.max(t, owner.outputStartMs) }
  }
}
