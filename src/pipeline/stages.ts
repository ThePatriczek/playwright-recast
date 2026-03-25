import type { TraceAction } from '../types/trace'
import type { SpeedConfig } from '../types/speed'
import type { SubtitleOptions } from '../types/subtitle'
import type { TtsProvider } from '../types/voiceover'
import type { RenderConfig } from '../types/render'

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
