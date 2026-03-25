import type { TraceAction } from '../types/trace.js'
import type { SpeedConfig } from '../types/speed.js'
import type { SubtitleOptions } from '../types/subtitle.js'
import type { TtsProvider } from '../types/voiceover.js'
import type { RenderConfig } from '../types/render.js'

export type StageDescriptor =
  | { type: 'parse' }
  | { type: 'hideSteps'; predicate: (action: TraceAction) => boolean }
  | { type: 'speedUp'; config: SpeedConfig }
  | {
      type: 'subtitles'
      textFn: (action: TraceAction) => string | undefined
      options?: SubtitleOptions
    }
  | { type: 'subtitlesFromSrt'; srtPath: string }
  | { type: 'subtitlesFromTrace'; options?: SubtitleOptions }
  | { type: 'autoZoom'; config: AutoZoomConfig }
  | { type: 'enrichZoomFromReport'; steps: Array<{ zoom?: { x: number; y: number; level: number } | null }> }
  | { type: 'voiceover'; provider: TtsProvider }
  | { type: 'render'; config: RenderConfig }

/** Auto-zoom configuration */
export interface AutoZoomConfig {
  actionLevel?: number
  idleLevel?: number
  followCursor?: boolean
}
