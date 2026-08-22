// Public API
export { Pipeline as Recast } from './pipeline/pipeline.js'

// Step helpers
export { setupRecast, narrate, zoom, pace, typeText, highlight, waitForNarration, markClick, click } from './helpers.js'
export type { SetupRecastOptions, TypeTextOptions } from './helpers.js'

// Suite orchestration
export { defineSuite, loadSuiteConfig, findConfigFile } from './suite/config.js'
export type { SuiteConfig, ClipTest } from './suite/config.js'
export { renderSuite } from './suite/orchestrator.js'
export type { RenderSuiteOptions, RenderSuiteResult } from './suite/orchestrator.js'
export { readManifest, writeManifest, parseManifest, filterTests, computeSummary } from './suite/manifest.js'
export { planSuite, resolveResultPolicy } from './suite/plan.js'
export type { PlanItem, ClipPlanItem, CardPlanItem } from './suite/plan.js'

export type {
  RunManifest,
  SuiteTest,
  SuiteTestStatus,
  SuiteSummary,
  SuiteResultPolicy,
  ResolvedSuiteResultPolicy,
  SuiteCardConfig,
  SuiteTransition,
  CardContent,
  FailurePolicy,
  SkippedPolicy,
  MissingTracePolicy,
} from './types/suite.js'

// Providers
export { OpenAIProvider } from './voiceover/providers/openai.js'
export { ElevenLabsProvider } from './voiceover/providers/elevenlabs.js'
export { PollyProvider } from './voiceover/providers/polly.js'
export type { OpenAIProviderConfig } from './voiceover/providers/openai.js'
export type { ElevenLabsProviderConfig, ElevenLabsVoiceSettings } from './voiceover/providers/elevenlabs.js'
export type { PollyProviderConfig } from './voiceover/providers/polly.js'
export { QwenTtsProvider, QwenSidecarError } from './voiceover/providers/qwen.js'
export type {
  QwenTtsProviderConfig,
  QwenCloneModeConfig,
  QwenDesignModeConfig,
} from './voiceover/providers/qwen.js'

// Voiceover post-processing
export { normalizeLoudness } from './voiceover/normalize.js'

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
  VoiceoverOptions,
  LoudnessNormalizeConfig,
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
