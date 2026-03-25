import type { TtsProvider, TtsOptions, AudioSegment } from '../../types/voiceover.js'

export interface OpenAIProviderConfig {
  apiKey?: string
  voice?: string
  model?: string
  speed?: number
  instructions?: string
}

/** Minimal interface for the OpenAI client's audio.speech.create method */
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
  const voice = config.voice ?? 'nova'
  const model = config.model ?? 'gpt-4o-mini-tts'
  const speed = config.speed ?? 1.0
  const instructions = config.instructions

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
        model,
        voice: options?.voice ?? voice,
        input: text,
        speed: options?.speed ?? speed,
        response_format: 'mp3',
      }
      if (instructions) params.instructions = instructions

      const response = await openai.audio.speech.create(params)
      const data = Buffer.from(await response.arrayBuffer())

      return {
        data,
        durationMs: 0,
        format: { sampleRate: 24000, channels: 1, codec: 'mp3' },
      }
    },

    estimateDurationMs(text: string, options?: TtsOptions): number {
      const spd = options?.speed ?? speed
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
