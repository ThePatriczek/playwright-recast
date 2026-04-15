import type { SubtitleEntry, SubtitledTrace } from './subtitle.js'

/** A chunk of synthesized audio */
export interface AudioSegment {
  data: Buffer
  durationMs: number
  format: {
    sampleRate: number
    channels: number
    codec: string
  }
}

/**
 * Per-call overrides for a single TTS synthesis call.
 * Provider factory config supplies defaults; options override them.
 */
export interface TtsOptions {
  /** Voice id/name override (provider-specific) */
  voice?: string
  /** Model id override (provider-specific; ignored by providers without a model concept) */
  model?: string
  /** BCP-47 language code override (e.g. 'cs', 'en-US') */
  languageCode?: string
  /** Playback speed multiplier (1.0 = natural). Providers without speed control ignore this. */
  speed?: number
  /** Output audio format hint */
  format?: 'mp3' | 'wav' | 'opus' | 'pcm'
}

/** The contract every TTS provider must implement */
export interface TtsProvider {
  readonly name: string
  synthesize(text: string, options?: TtsOptions): Promise<AudioSegment>
  estimateDurationMs(text: string, options?: TtsOptions): number
  isAvailable(): Promise<boolean>
  dispose(): Promise<void>
}

/** EBU R128 loudness normalization settings (two-pass `loudnorm`). */
export interface LoudnessNormalizeConfig {
  /** Integrated loudness target, LUFS. Default: -16. */
  targetLufs?: number
  /** True-peak ceiling, dBFS. Default: -1. */
  truePeakDb?: number
  /** Loudness range target, LU. Default: 11. */
  lra?: number
  /** Linear mode preserves dynamics (recommended for speech). Default: true. */
  linear?: boolean
  /** Output sample rate. Default: 44100. */
  sampleRate?: number
  /** Output bitrate for the re-encoded mp3. Default: '128k'. */
  bitrate?: string
}

/** Options passed to the `.voiceover(provider, options)` pipeline stage. */
export interface VoiceoverOptions {
  /** Normalize each synthesized segment to a common loudness before concat.
   *  `true` uses defaults (-16 LUFS / -1 dBFS TP / 11 LU, linear). */
  normalize?: boolean | LoudnessNormalizeConfig
}

/** A voiceover entry matched to a subtitle */
export interface VoiceoverEntry {
  subtitle: SubtitleEntry
  audio: AudioSegment
  outputStartMs: number
  outputEndMs: number
}

/** Trace after voiceover has been generated */
export interface VoiceoveredTrace extends SubtitledTrace {
  voiceover: {
    entries: VoiceoverEntry[]
    audioTrackPath: string
    totalDurationMs: number
  }
}
