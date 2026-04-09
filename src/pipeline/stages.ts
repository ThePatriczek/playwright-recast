import type { TraceAction } from '../types/trace.js'
import type { SpeedConfig } from '../types/speed.js'
import type { SubtitleOptions } from '../types/subtitle.js'
import type { TtsProvider } from '../types/voiceover.js'
import type { RenderConfig } from '../types/render.js'
import type { TextProcessingConfig } from '../types/text-processing.js'
import type { ClickEffectConfig } from '../types/click-effect.js'
import type { CursorOverlayConfig } from '../types/cursor-overlay.js'
import type { EasingSpec } from '../types/easing.js'
import type { InterpolateConfig } from '../types/interpolate.js'
import type { TextHighlightConfig } from '../types/text-highlight.js'
import type { IntroConfig, OutroConfig } from '../types/intro-outro.js'
import type { BackgroundMusicConfig } from '../types/background-music.js'

export type StageDescriptor =
  | { type: 'parse' }
  | { type: 'injectActions'; actions: TraceAction[] }
  | { type: 'hideSteps'; predicate: (action: TraceAction) => boolean }
  | { type: 'speedUp'; config: SpeedConfig }
  | {
      type: 'subtitles'
      textFn: (action: TraceAction) => string | undefined
      options?: SubtitleOptions
    }
  | { type: 'subtitlesFromSrt'; srtPath: string }
  | { type: 'subtitlesFromTrace'; options?: SubtitleOptions }
  | { type: 'textProcessing'; config: TextProcessingConfig }
  | { type: 'autoZoom'; config: AutoZoomConfig }
  | { type: 'enrichZoomFromReport'; steps: Array<{ zoom?: { x: number; y: number; level: number } | null }> }
  | { type: 'cursorOverlay'; config: CursorOverlayConfig }
  | { type: 'clickEffect'; config: ClickEffectConfig }
  | { type: 'textHighlight'; config: TextHighlightConfig }
  | { type: 'intro'; config: IntroConfig }
  | { type: 'outro'; config: OutroConfig }
  | { type: 'interpolate'; config: InterpolateConfig }
  | { type: 'backgroundMusic'; config: BackgroundMusicConfig }
  | { type: 'voiceover'; provider: TtsProvider }
  | { type: 'render'; config: RenderConfig }

/** Auto-zoom configuration */
export interface AutoZoomConfig {
  /** Zoom level for click actions (default: 1.5) */
  clickLevel?: number
  /** Zoom level for fill/type actions (default: 1.6) */
  inputLevel?: number
  /** Zoom level for steps without user actions (default: 1.0 = no zoom) */
  idleLevel?: number
  /** Bias zoom center toward viewport center (0 = raw coords, 1 = always center). Default: 0.2 */
  centerBias?: number
  /** Transition duration in ms for zoom in/out easing (default: 400) */
  transitionMs?: number
  /** Easing function for zoom transitions (default: 'ease-in-out') */
  easing?: EasingSpec
  /** @deprecated Use clickLevel instead */
  actionLevel?: number
  followCursor?: boolean
}
