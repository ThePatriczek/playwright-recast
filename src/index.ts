// Public API
export { Pipeline as Recast } from './pipeline/pipeline'

// Step helpers (narrate, zoom, pace)
export { setupRecast, narrate, zoom, pace } from './helpers'

// Providers
export { OpenAIProvider } from './voiceover/providers/openai'
export { ElevenLabsProvider } from './voiceover/providers/elevenlabs'

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
} from './types/trace'

export type {
  SpeedConfig,
  SpeedSegment,
  SpeedRule,
  SpeedRuleContext,
  ActivityType,
  TimeRemapFn,
  SpeedMappedTrace,
} from './types/speed'

export type {
  SubtitleEntry,
  SubtitleFormat,
  SubtitleOptions,
  SubtitledTrace,
} from './types/subtitle'

export type {
  TtsProvider,
  TtsOptions,
  AudioSegment,
  VoiceoverEntry,
  VoiceoveredTrace,
} from './types/voiceover'

export type { RenderConfig, SubtitleStyle, ZoomKeyframe } from './types/render'
