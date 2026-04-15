// Public API
export { Pipeline as Recast } from './pipeline/pipeline.js'

// Step helpers (narrate, zoom, pace)
export { setupRecast, narrate, zoom, pace, highlight } from './helpers.js'

// Providers
export { OpenAIProvider } from './voiceover/providers/openai.js'
export { ElevenLabsProvider } from './voiceover/providers/elevenlabs.js'
export { PollyProvider } from './voiceover/providers/polly.js'

// Types
export type {
  ParsedTrace,
  FilteredTrace,
  TraceAction,
  TraceAnnotation,
  KnownAnnotationType,
  TraceResource,
  TraceEvent,
  ScreencastFrame,
  CursorPosition,
  FrameReader,
  MonotonicMs,
} from './types/trace.js'

export type {
  SpeedConfig,
  SpeedSegment,
  SpeedRule,
  SpeedRuleContext,
  ActivityType,
  TimeRemapFn,
  SpeedMappedTrace,
} from './types/speed.js'

export type {
  SubtitleEntry,
  SubtitleFormat,
  SubtitleOptions,
  SubtitledTrace,
} from './types/subtitle.js'

export type {
  TtsProvider,
  TtsOptions,
  AudioSegment,
  VoiceoverEntry,
  VoiceoveredTrace,
} from './types/voiceover.js'

export type { RenderConfig, SubtitleStyle, ZoomKeyframe } from './types/render.js'

// Text processing
export { processText } from './text-processing/text-processor.js'

export type {
  TextProcessingConfig,
  TextProcessingRule,
} from './types/text-processing.js'

// Click effect
export type { ClickEffectConfig, ClickEvent } from './types/click-effect.js'

// Cursor overlay
export type { CursorOverlayConfig, CursorKeyframe } from './types/cursor-overlay.js'

// Easing
export type { EasingSpec, EasingPreset } from './types/easing.js'

// Frame interpolation
export type { InterpolateConfig, InterpolateMode, InterpolateQuality } from './types/interpolate.js'

// Text highlight
export type { TextHighlightConfig, HighlightEvent } from './types/text-highlight.js'

// Intro/Outro
export type { IntroConfig, OutroConfig } from './types/intro-outro.js'

// Background music
export type { BackgroundMusicConfig } from './types/background-music.js'

// Subtitle writers & utilities
export { writeAss, hexToAss } from './subtitles/ass-writer.js'
export type { AssResolution } from './subtitles/ass-writer.js'
export { chunkSubtitles } from './subtitles/subtitle-chunker.js'
export type { ChunkOptions } from './subtitles/subtitle-chunker.js'
