import type { SpeedSegment } from '../types/speed.js'
import type { SubtitleEntry } from '../types/subtitle.js'
import { isSpeedClockAuthority } from '../speed/clock-authority.js'

/**
 * Resolve how much blank lead-in the pipeline should compensate for, in
 * milliseconds.
 *
 * When the speed map is the clock authority the answer is always zero AND the
 * detection is skipped entirely. Two reasons:
 *
 *  1. Correctness. detectBlankLeadIn() measures source-video time, but under
 *     speed mapping every consumer's timestamps already live in the output
 *     clock produced by timeRemap(). Subtracting one from the other is a unit
 *     error — with duringIdle: 4, a 3s source prefix is ~0.75s of output, yet
 *     the full 3000ms was removed (issue #20).
 *  2. Cost. Detection shells out to ffmpeg up to 31 times.
 *
 * @param detect Returns the blank lead-in in SECONDS (detectBlankLeadIn's
 *               contract). Not called at all under speed authority.
 * @returns Milliseconds to compensate; 0 means "do nothing".
 */
export function resolveBlankLeadInMs(
  speedSegments: SpeedSegment[] | undefined,
  detect: () => number,
): number {
  if (isSpeedClockAuthority(speedSegments)) return 0
  return detect() * 1000
}

/**
 * Shift subtitle windows (and their zoom windows) back by the blank lead-in.
 * Times clamp at zero. A zero offset is a no-op.
 */
export function shiftSubtitlesForBlankLead(
  subtitles: SubtitleEntry[],
  offsetMs: number,
): void {
  if (offsetMs <= 0) return
  for (const sub of subtitles) {
    sub.startMs = Math.max(0, sub.startMs - offsetMs)
    sub.endMs = Math.max(0, sub.endMs - offsetMs)
    if (sub.zoom?.startMs !== undefined) {
      sub.zoom.startMs = Math.max(0, sub.zoom.startMs - offsetMs)
    }
    if (sub.zoom?.endMs !== undefined) {
      sub.zoom.endMs = Math.max(0, sub.zoom.endMs - offsetMs)
    }
  }
}

/**
 * Shift overlay event times (clicks, highlights) back by the blank lead-in.
 * Times are rounded to whole milliseconds and clamp at zero.
 */
export function shiftOverlayTimesForBlankLead(
  events: Array<{ videoTimeMs: number }>,
  offsetMs: number,
): void {
  if (offsetMs <= 0) return
  for (const event of events) {
    event.videoTimeMs = Math.max(0, Math.round(event.videoTimeMs - offsetMs))
  }
}
