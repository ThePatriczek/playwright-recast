import type { MonotonicMs } from '../types/trace.js'
import type { SpeedSegment, TimeRemapFn } from '../types/speed.js'

/**
 * Compute cumulative output start/end times for each speed segment.
 * Returns a new array with outputStart/outputEnd filled in.
 */
export function computeOutputTimes(segments: SpeedSegment[]): SpeedSegment[] {
  let cursor = 0
  return segments.map((seg) => {
    const originalDuration =
      (seg.originalEnd as number) - (seg.originalStart as number)
    const outputDuration = originalDuration / seg.speed
    const outputStart = cursor
    const outputEnd = cursor + outputDuration
    cursor = outputEnd
    return { ...seg, outputStart, outputEnd }
  })
}

/**
 * Build a function that maps original trace time to output video time.
 * Interpolates within speed segments; times that fall inside a gap between
 * segments (e.g. a hideSteps() hidden range) snap to the next segment's
 * output start — gaps collapse to zero output duration, so the boundary
 * shared with the previous segment's outputEnd is the right answer.
 */
export function buildTimeRemap(segments: SpeedSegment[]): TimeRemapFn {
  return (originalTime: MonotonicMs): number => {
    const t = originalTime as number
    const first = segments[0]
    const last = segments[segments.length - 1]

    if (!first || !last) return 0
    if (t <= (first.originalStart as number)) return first.outputStart
    if (t >= (last.originalEnd as number)) return last.outputEnd

    for (const seg of segments) {
      const segStart = seg.originalStart as number
      const segEnd = seg.originalEnd as number

      // In a gap before this segment — snap forward to its start.
      if (t < segStart) return seg.outputStart
      if (t > segEnd) continue

      const elapsed = t - segStart
      return seg.outputStart + elapsed / seg.speed
    }

    return last.outputEnd
  }
}
