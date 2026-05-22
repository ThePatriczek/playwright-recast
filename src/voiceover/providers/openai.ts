import * as os from 'node:os'
import type { TtsProvider, TtsOptions, AudioSegment } from '../../types/voiceover.js'
import { synthesizeWithCache } from './util/audio-cache.js'

export interface OpenAIProviderConfig {
  apiKey?: string
  /** Voice name (e.g. 'nova', 'echo'). Default: 'nova'. */
  voice?: string
  /** Model id. Default: 'gpt-4o-mini-tts'. */
  model?: string
  /** BCP-47 language code — OpenAI TTS auto-detects, included for API symmetry. */
  languageCode?: string
  /** Playback speed multiplier. Default: 1.0. */
  speed?: number
  /** Free-form style instructions (GPT-4o-mini-tts family). */
  instructions?: string
  /**
   * Directory for disk caching of synthesized audio. When set, the provider
   * skips API calls for `(text, voice, model, speed, instructions)` tuples
   * it has already synthesized. Omit to disable disk caching (intra-batch
   * dedup still applies).
   */
  cacheDir?: string
}

const DEFAULT_VOICE = 'nova'
const DEFAULT_MODEL = 'gpt-4o-mini-tts'
const DEFAULT_SPEED = 1.0

interface OpenAIClient {
  audio: {
    speech: {
      create(params: Record<string, unknown>): Promise<{ arrayBuffer(): Promise<ArrayBuffer> }>
    }
  }
}

/**
 * OpenAI TTS provider.
 * Requires `openai` as a peer dependency.
 */
export function OpenAIProvider(config: OpenAIProviderConfig = {}): TtsProvider {
  const apiKey = config.apiKey ?? process.env.OPENAI_API_KEY
  const defaults = {
    voice: config.voice ?? DEFAULT_VOICE,
    model: config.model ?? DEFAULT_MODEL,
    speed: config.speed ?? DEFAULT_SPEED,
    instructions: config.instructions,
  }

  let client: OpenAIClient | null = null

  async function getClient(): Promise<OpenAIClient> {
    if (client) return client
    const OpenAI = (await import('openai')).default
    client = new OpenAI({ apiKey }) as unknown as OpenAIClient
    return client
  }

  return {
    name: 'openai',

    async synthesize(texts: string[], options?: TtsOptions): Promise<AudioSegment[]> {
      const openai = await getClient()
      const model = options?.model ?? defaults.model
      const voice = options?.voice ?? defaults.voice
      const speed = options?.speed ?? defaults.speed
      const instructions = defaults.instructions

      async function generateOne(text: string): Promise<Buffer> {
        const params: Record<string, unknown> = {
          model, voice, speed, input: text, response_format: 'mp3',
        }
        if (instructions) params.instructions = instructions
        const response = await openai.audio.speech.create(params)
        return Buffer.from(await response.arrayBuffer())
      }

      return synthesizeWithCache({
        texts,
        workDir: options?.workDir ?? os.tmpdir(),
        cache: config.cacheDir ? { dir: config.cacheDir } : undefined,
        fingerprintFor: (text) => [
          'openai', text, voice, model, speed, instructions ?? '',
        ],
        generate: (missTexts) => Promise.all(missTexts.map(generateOne)),
        prefix: 'openai',
        format: { sampleRate: 24000, channels: 1, codec: 'mp3' },
      })
    },

    async isAvailable(): Promise<boolean> {
      if (!apiKey) return false
      try {
        await import('openai')
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
