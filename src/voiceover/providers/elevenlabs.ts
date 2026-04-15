import type { TtsProvider, TtsOptions, AudioSegment } from '../../types/voiceover.js'

export interface ElevenLabsVoiceSettings {
  stability?: number
  similarityBoost?: number
  style?: number
  useSpeakerBoost?: boolean
}

export interface ElevenLabsProviderConfig {
  apiKey?: string
  /** Voice id (required for synthesis; falls back to DEFAULT_VOICE). */
  voice?: string
  /** Model id. Default: 'eleven_multilingual_v2'. */
  model?: string
  /** BCP-47 language code (e.g. 'cs'). */
  languageCode?: string
  /** Per-voice synthesis parameters. Omit to use the voice's dashboard defaults. */
  voiceSettings?: ElevenLabsVoiceSettings
}

const DEFAULT_VOICE = 'onwK4e9ZLuTAKqWW03F9' // Daniel
const DEFAULT_MODEL = 'eleven_multilingual_v2'

interface ElevenLabsStream {
  getReader(): ReadableStreamDefaultReader<Uint8Array>
}

interface ElevenLabsClient {
  textToSpeech: {
    convert(voiceId: string, params: Record<string, unknown>): Promise<ElevenLabsStream>
  }
}

/**
 * ElevenLabs TTS provider.
 * Requires `@elevenlabs/elevenlabs-js` as a peer dependency.
 */
export function ElevenLabsProvider(config: ElevenLabsProviderConfig = {}): TtsProvider {
  const apiKey = config.apiKey ?? process.env.ELEVENLABS_API_KEY
  const defaults = {
    voice: config.voice ?? DEFAULT_VOICE,
    model: config.model ?? DEFAULT_MODEL,
    languageCode: config.languageCode,
    voiceSettings: config.voiceSettings,
  }

  let client: ElevenLabsClient | null = null

  async function getClient(): Promise<ElevenLabsClient> {
    if (client) return client
    const { ElevenLabsClient: ELClient } = await import('@elevenlabs/elevenlabs-js')
    client = new ELClient({ apiKey }) as unknown as ElevenLabsClient
    return client
  }

  return {
    name: 'elevenlabs',

    async synthesize(text: string, options?: TtsOptions): Promise<AudioSegment> {
      const el = await getClient()
      const voice = options?.voice ?? defaults.voice
      const model = options?.model ?? defaults.model
      const languageCode = options?.languageCode ?? defaults.languageCode

      const params: Record<string, unknown> = {
        text,
        modelId: model,
        outputFormat: 'mp3_44100_128',
      }
      if (languageCode) params.languageCode = languageCode
      if (defaults.voiceSettings) params.voiceSettings = defaults.voiceSettings

      const audio = await el.textToSpeech.convert(voice, params)

      const reader = audio.getReader()
      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }

      const data = Buffer.concat(chunks)
      return {
        data,
        durationMs: 0,
        format: { sampleRate: 44100, channels: 1, codec: 'mp3' },
      }
    },

    estimateDurationMs(text: string): number {
      const words = text.split(/\s+/).length
      return (words / 150) * 60_000
    },

    async isAvailable(): Promise<boolean> {
      return !!apiKey
    },

    async dispose(): Promise<void> {
      client = null
    },
  }
}
