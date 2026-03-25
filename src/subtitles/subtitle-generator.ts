import type { TraceAction } from '../types/trace.js'
import type { SpeedMappedTrace } from '../types/speed.js'
import type { SubtitleEntry, SubtitleOptions, SubtitledTrace } from '../types/subtitle.js'

/**
 * Generate subtitle entries from trace actions using a text extraction function.
 * Timestamps are remapped through the speed processor's TimeRemapFn.
 */
export function generateSubtitles(
  trace: SpeedMappedTrace,
  textFn: (action: TraceAction) => string | undefined,
  _options?: SubtitleOptions,
): SubtitledTrace {
  const subtitles: SubtitleEntry[] = []
  let index = 1

  for (const action of trace.actions) {
    const text = textFn(action)
    if (!text) continue

    const startMs = trace.timeRemap(action.startTime)
    const endMs = trace.timeRemap(action.endTime)

    // Skip zero-duration entries
    if (endMs <= startMs) continue

    subtitles.push({
      index: index++,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      text,
      keyword: action.keyword,
    })
  }

  return {
    ...trace,
    subtitles,
  }
}
