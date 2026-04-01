import type { TtsProvider, TtsOptions, AudioSegment } from '../../types/voiceover.js'

export interface ElevenLabsProviderConfig {
  apiKey?: string
  voiceId?: string
  modelId?: string
  languageCode?: string
}

const DEFAULT_VOICE_ID = 'onwK4e9ZLuTAKqWW03F9' // Daniel
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2'

/** Minimal interface for the ElevenLabs client's textToSpeech.convert method */
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
  const voiceId = config.voiceId ?? DEFAULT_VOICE_ID
  const modelId = config.modelId ?? DEFAULT_MODEL_ID
  const languageCode = config.languageCode

  let client: ElevenLabsClient | null = null

  async function getClient(): Promise<ElevenLabsClient> {
    if (client) return client
    const { ElevenLabsClient: ELClient } = await import('@elevenlabs/elevenlabs-js')
    client = new ELClient({ apiKey }) as unknown as ElevenLabsClient
    return client
  }

  return {
    name: 'elevenlabs',

    async synthesize(text: string, _options?: TtsOptions): Promise<AudioSegment> {
      const el = await getClient()
      const audio = await el.textToSpeech.convert(voiceId, {
        text,
        modelId,
        outputFormat: 'mp3_44100_128',
        ...(languageCode ? { languageCode } : {}),
      })

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
        durationMs: 0, // Will be measured by voiceover-processor via ffprobe
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
