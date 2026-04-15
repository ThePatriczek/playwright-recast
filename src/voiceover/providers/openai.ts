import type { TtsProvider, TtsOptions, AudioSegment } from '../../types/voiceover.js'

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

    async synthesize(text: string, options?: TtsOptions): Promise<AudioSegment> {
      const openai = await getClient()
      const params: Record<string, unknown> = {
        model: options?.model ?? defaults.model,
        voice: options?.voice ?? defaults.voice,
        speed: options?.speed ?? defaults.speed,
        input: text,
        response_format: 'mp3',
      }
      if (defaults.instructions) params.instructions = defaults.instructions

      const response = await openai.audio.speech.create(params)
      const data = Buffer.from(await response.arrayBuffer())

      return {
        data,
        durationMs: 0,
        format: { sampleRate: 24000, channels: 1, codec: 'mp3' },
      }
    },

    estimateDurationMs(text: string, options?: TtsOptions): number {
      const spd = options?.speed ?? defaults.speed
      const words = text.split(/\s+/).length
      return (words / (150 * spd)) * 60_000
    },

    async isAvailable(): Promise<boolean> {
      return !!apiKey
    },

    async dispose(): Promise<void> {
      client = null
    },
  }
}
