import * as os from 'node:os'
import type { TtsProvider, TtsOptions, AudioSegment } from '../../types/voiceover.js'
import { synthesizeWithCache } from './util/audio-cache.js'

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
  /**
   * Directory for disk caching of synthesized audio. When set, the provider
   * skips API calls for `(text, voice, model, languageCode, voiceSettings)`
   * tuples it has already synthesized. Omit to disable disk caching (the
   * provider still dedups within a single batch).
   */
  cacheDir?: string
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

    async synthesize(texts: string[], options?: TtsOptions): Promise<AudioSegment[]> {
      const el = await getClient()
      const voice = options?.voice ?? defaults.voice
      const model = options?.model ?? defaults.model
      const languageCode = options?.languageCode ?? defaults.languageCode
      const voiceSettings = defaults.voiceSettings
      // Stable JSON for the fingerprint — undefined collapses to ''.
      const voiceSettingsKey = voiceSettings ? JSON.stringify(voiceSettings) : ''

      async function generateOne(text: string): Promise<Buffer> {
        const params: Record<string, unknown> = {
          text,
          modelId: model,
          outputFormat: 'mp3_44100_128',
        }
        if (languageCode) params.languageCode = languageCode
        if (voiceSettings) params.voiceSettings = voiceSettings
        const audio = await el.textToSpeech.convert(voice, params)
        const reader = audio.getReader()
        const chunks: Uint8Array[] = []
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
        }
        return Buffer.concat(chunks)
      }

      return synthesizeWithCache({
        texts,
        workDir: options?.workDir ?? os.tmpdir(),
        cache: config.cacheDir ? { dir: config.cacheDir } : undefined,
        fingerprintFor: (text) => [
          'elevenlabs', text, voice, model, languageCode ?? '', voiceSettingsKey,
        ],
        generate: (missTexts) => Promise.all(missTexts.map(generateOne)),
        prefix: 'elevenlabs',
        format: { sampleRate: 44100, channels: 1, codec: 'mp3' },
      })
    },

    async isAvailable(): Promise<boolean> {
      if (!apiKey) return false
      try {
        await import('@elevenlabs/elevenlabs-js')
        return true
      } catch {
        return false
      }
    },

    async dispose(): Promise<void> {
      client = null
    },
  }
}
