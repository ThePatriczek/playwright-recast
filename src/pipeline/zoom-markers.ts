import type { SubtitleEntry } from '../types/subtitle.js'
import { ownerNarration } from './narration-subtitles.js'

/**
 * The narration cue a `zoom()` marker at `tMs` belongs to: the one playing,
 * else the next one (a zoom set just before its `narrate()` falls between
 * two cues), both within the marker's scene (see sceneOf()). Undefined when
 * no cue of its scene plays or follows.
 */
export function cueForZoomMarker<T extends Pick<SubtitleEntry, 'startMs' | 'endMs' | 'sceneId'>>(
  subtitles: ReadonlyArray<T>,
  tMs: number,
  scene?: string,
): T | undefined {
  return ownerNarration(subtitles, tMs, scene, (s) => [s.startMs, s.endMs], (s) => s.sceneId)
}

/**
 * With a voiceover, move each zoom to the narration whose audio is playing at
 * its start, else to the next one - the rule `highlight({ duration:
 * 'narration' })` follows. A narration's subtitle stays open until the next
 * marker, so one spoken over a wait still owned a zoom set after its audio
 * had ended, and zoomed at the end of its window instead of during the line
 * the zoom was meant for. A narration that already has a zoom of its own
 * keeps it: that one was set later. A zoom with its own `endMs` (autoZoom())
 * follows the actions, not the narration, and stays, as does a zoom whose
 * owner is in another scene. Mutates the subtitles,
 * which the entries reference, like the voiceover stage itself.
 */
export function moveZoomsToSpokenNarration(
  entries: ReadonlyArray<{ subtitle: SubtitleEntry; outputStartMs: number; outputEndMs: number; spokenEndMs?: number }>,
): void {
  const sorted = [...entries].sort((a, b) => a.outputStartMs - b.outputStartMs)
  // Zooms only move forward; last first, so a narration whose own stale zoom
  // moves on is free for the one moving in.
  for (const entry of [...sorted].reverse()) {
    const zoom = entry.subtitle.zoom
    if (!zoom || zoom.endMs !== undefined) continue
    const t = zoom.startMs ?? entry.subtitle.startMs
    // The speech, not the cue's window: silence pads that to the next marker.
    // The zoom's own scene, not its cue's: an unscoped zoom may sit on a scene's cue
    const owner = ownerNarration(sorted, t, zoom.sceneId,
      (e) => [e.outputStartMs, e.spokenEndMs ?? e.outputEndMs], (e) => e.subtitle.sceneId)
    if (!owner || owner === entry) continue
    delete entry.subtitle.zoom
    if (owner.subtitle.zoom) continue
    owner.subtitle.zoom = { ...zoom, startMs: Math.max(t, owner.outputStartMs) }
  }
}
