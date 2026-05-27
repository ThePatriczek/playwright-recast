import type { SubtitleEntry } from '../types/subtitle.js'

/**
 * Keep only subtitles with a positive duration. Narration lines whose trace
 * window collapsed to ~0 (fast trace + waitForNarration(), no autoWait) are
 * kept through subtitle assembly so voiceover can stretch them to the audio
 * length. When there is no voiceover to size them they stay zero-duration and
 * must not be written to the burned/embedded subtitle track — an SRT/ASS cue
 * with start == end is degenerate. This is the render-time gate that drops
 * them, matching the old build-time drop but applied after voiceover.
 */
export function filterRenderableSubtitles(
  subtitles: ReadonlyArray<SubtitleEntry>,
): SubtitleEntry[] {
  return subtitles.filter((s) => s.endMs > s.startMs)
}
