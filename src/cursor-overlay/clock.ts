import { recordingFrame } from '../parse/recording-frame.js'
import { toMonotonic, type ScreencastFrame } from '../types/trace.js'
import type { SpeedMappedTrace } from '../types/speed.js'

/**
 * Trace time to output video ms, as the cursor and click stages time it:
 * through the speed map from the recording page's first frame, else from the
 * first frame of any page. Inputs drawn beside the cursor use the same clock.
 */
export function cursorClock(
  frames: ReadonlyArray<ScreencastFrame>,
  traceStartMs: number,
  speedMapped: Pick<SpeedMappedTrace, 'speedSegments' | 'timeRemap'> | undefined,
): (traceMs: number) => number {
  const firstFrameMs = frames.length > 0 ? (frames[0]!.timestamp as number) : traceStartMs
  if (speedMapped && speedMapped.speedSegments.length > 0) {
    const start = speedMapped.timeRemap(toMonotonic(recordingFrame(frames).firstFrameMs ?? firstFrameMs))
    return (t) => speedMapped.timeRemap(toMonotonic(t)) - start
  }
  return (t) => t - firstFrameMs
}
