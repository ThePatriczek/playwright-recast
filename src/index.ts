// Public API
export { Pipeline as Recast } from './pipeline/pipeline.js'

// Step helpers (narrate, zoom, pace)
export { setupRecast, narrate, zoom, pace } from './helpers.js'

// Providers
export { OpenAIProvider } from './voiceover/providers/openai.js'
export { ElevenLabsProvider } from './voiceover/providers/elevenlabs.js'

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
