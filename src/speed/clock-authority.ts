import type { SpeedSegment } from '../types/speed.js'

/**
 * True when the speed map — not the source video — defines output time.
 *
 * In this mode the speed map already selects which source intervals are
 * retained, relative to the recording's first screencast frame, and every
 * consumer's timestamps (subtitles, zoom, voiceover, cursor, clicks) are
 * expressed in its output clock. Blank-lead trimming and blank-lead
 * compensation MUST be skipped: they operate in source-video time and would
 * introduce a second, incompatible origin.
 *
 * The 0.01 tolerance matches the inline checks this function replaces.
 */
export function isSpeedClockAuthority(
  speedSegments: SpeedSegment[] | undefined,
): boolean {
  return (
    speedSegments !== undefined &&
    speedSegments.length > 0 &&
    speedSegments.some((s) => Math.abs(s.speed - 1.0) > 0.01)
  )
}
