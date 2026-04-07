import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { ResolvedBackgroundMusicConfig } from './defaults.js'

export interface VoiceoverSegment {
  startMs: number
  endMs: number
}

/**
 * Merge voiceover segments that are closer than `gapMs` apart.
 * Prevents rapid volume oscillation when segments are near-adjacent.
 */
export function mergeAdjacentSegments(
  segments: VoiceoverSegment[],
  gapMs: number,
): VoiceoverSegment[] {
  if (segments.length === 0) return []

  const sorted = [...segments].sort((a, b) => a.startMs - b.startMs)
  const merged: VoiceoverSegment[] = [{ ...sorted[0]! }]

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1]!
    const curr = sorted[i]!
    if (curr.startMs - prev.endMs < gapMs) {
      prev.endMs = Math.max(prev.endMs, curr.endMs)
    } else {
      merged.push({ ...curr })
    }
  }

  return merged
}

/**
 * Build an ffmpeg audio filter string that applies ducking during voiceover
 * segments with smooth fade transitions, plus a fade-out at the end.
 *
 * Pure function — testable without ffmpeg.
 *
 * @returns Array of ffmpeg audio filter expressions to chain with ','
 */
export function buildDuckingFilters(
  segments: VoiceoverSegment[],
  config: ResolvedBackgroundMusicConfig,
  videoDurationSec: number,
): string[] {
  const filters: string[] = []

  // Base volume
  filters.push(`volume=${config.volume}`)

  // Ducking: for each merged segment, apply a volume filter that lowers
  // the music during voiceover. The enable expression activates the filter
  // only during the ducking window (including fade transitions).
  if (config.ducking && segments.length > 0) {
    const merged = mergeAdjacentSegments(segments, config.duckFadeMs * 2)
    const fadeSec = config.duckFadeMs / 1000
    const ratio = config.duckLevel / config.volume

    for (const seg of merged) {
      const segStartSec = seg.startMs / 1000
      const segEndSec = seg.endMs / 1000

      // Window: fadeIn starts before segment, fadeOut ends after segment
      const windowStart = Math.max(0, segStartSec - fadeSec)
      const windowEnd = Math.min(videoDurationSec, segEndSec + fadeSec)

      // Volume expression that fades down, holds, and fades up.
      // t is the current time within the enable window.
      //
      // Phase 1 (fade down): windowStart → segStart
      //   volume lerps from 1.0 → ratio
      // Phase 2 (hold duck): segStart → segEnd
      //   volume = ratio
      // Phase 3 (fade up): segEnd → windowEnd
      //   volume lerps from ratio → 1.0
      const fadeDown = fadeSec > 0
        ? `if(lt(t,${segStartSec.toFixed(3)}),${ratio}+(1-${ratio})*(${segStartSec.toFixed(3)}-t)/${fadeSec.toFixed(3)},`
        : `if(lt(t,${segStartSec.toFixed(3)}),${ratio},`
      const holdDuck = `if(lt(t,${segEndSec.toFixed(3)}),${ratio},`
      const fadeUp = fadeSec > 0
        ? `${ratio}+(1-${ratio})*(t-${segEndSec.toFixed(3)})/${fadeSec.toFixed(3)}`
        : `1`

      const expr = `${fadeDown}${holdDuck}${fadeUp}))`

      filters.push(
        `volume='${expr}':eval=frame:enable='between(t,${windowStart.toFixed(3)},${windowEnd.toFixed(3)})'`,
      )
    }
  }

  // Fade out at end of video
  if (config.fadeOutMs > 0) {
    const fadeOutSec = config.fadeOutMs / 1000
    const fadeStart = Math.max(0, videoDurationSec - fadeOutSec)
    filters.push(`afade=t=out:st=${fadeStart.toFixed(3)}:d=${fadeOutSec.toFixed(3)}`)
  }

  return filters
}

/**
 * Generate a processed background music track ready for mixing.
 *
 * Steps:
 * 1. Loop/trim to match video duration
 * 2. Apply base volume + ducking filters
 * 3. Apply fade-out at end
 *
 * @returns Path to the processed music track
 */
export function generateMusicTrack(
  config: ResolvedBackgroundMusicConfig,
  videoDurationSec: number,
  voiceoverSegments: VoiceoverSegment[],
  tmpDir: string,
): string {
  const outputPath = path.join(tmpDir, 'music-track.mp3')

  const inputArgs: string[] = ['-y']

  // Loop if needed
  if (config.loop) {
    inputArgs.push('-stream_loop', '-1')
  }

  inputArgs.push('-i', config.path, '-t', videoDurationSec.toFixed(3))

  // Build audio filters
  const filters = buildDuckingFilters(voiceoverSegments, config, videoDurationSec)

  inputArgs.push('-af', filters.join(','))
  inputArgs.push('-c:a', 'libmp3lame', '-q:a', '2', outputPath)

  execFileSync('ffmpeg', inputArgs, { stdio: 'pipe' })

  return outputPath
}
