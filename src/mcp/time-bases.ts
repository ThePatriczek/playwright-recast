import type { ParsedTrace } from '../types/trace.js'

/**
 * Maps the DOM recorder's Date.now() times into the trace via its
 * wall/monotonic pair; without it, or if that lands outside the trace, the
 * first recorded action counts as the trace start.
 */
export function wallToTrace(
  metadata: Pick<ParsedTrace['metadata'], 'startTime' | 'endTime' | 'wallTime' | 'wallMonotonicTime'>,
  firstRecordedMs: number,
): (wallMs: number) => number {
  const traceStart = metadata.startTime as number
  if (metadata.wallTime > 0 && metadata.wallMonotonicTime !== undefined) {
    const offset = metadata.wallMonotonicTime - metadata.wallTime
    const first = firstRecordedMs + offset
    // Outside: a mocked page clock or another run's recording
    if (first >= traceStart && first <= (metadata.endTime as number)) return (wallMs) => wallMs + offset
  }
  return (wallMs) => traceStart + (wallMs - firstRecordedMs)
}

/**
 * Trace times onto the pipeline's clocks: `speedUp({ segments })` counts from
 * the recording page's first frame, `subtitlesFromSrt()` from its first action.
 */
export function mcpTimeBases(
  parsed: Pick<ParsedTrace, 'frames' | 'actions' | 'metadata'>,
): { toVideo: (t: number) => number; toSrt: (t: number) => number; videoEndMs: number } {
  const traceStart = parsed.metadata.startTime as number
  const recPageId = parsed.frames[parsed.frames.length - 1]?.pageId
  const firstFrameMs = (parsed.frames.find((f) => f.pageId === recPageId)?.timestamp as number | undefined) ?? traceStart
  // No action with the page's id (pageId is optional): both clocks start at the frame
  const firstActionMs = (parsed.actions.find((a) => a.pageId === recPageId)?.startTime as number | undefined) ?? firstFrameMs
  return {
    toVideo: (t) => t - firstFrameMs,
    toSrt: (t) => t - firstActionMs,
    videoEndMs: (parsed.metadata.endTime as number) - firstFrameMs,
  }
}
