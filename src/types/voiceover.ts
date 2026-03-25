import type { SubtitleEntry, SubtitledTrace } from './subtitle'

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

/** Options for a single TTS synthesis call */
export interface TtsOptions {
  voice?: string
  speed?: number
  format?: 'mp3' | 'wav' | 'opus' | 'pcm'
  locale?: string
}

/** The contract every TTS provider must implement */
export interface TtsProvider {
  readonly name: string
  synthesize(text: string, options?: TtsOptions): Promise<AudioSegment>
  estimateDurationMs(text: string, options?: TtsOptions): number
  isAvailable(): Promise<boolean>
  dispose(): Promise<void>
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
