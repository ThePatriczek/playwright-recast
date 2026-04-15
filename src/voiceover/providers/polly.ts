import type { TtsProvider, TtsOptions, AudioSegment } from '../../types/voiceover.js'

export interface PollyProviderConfig {
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  voice?: string
  engine?: 'standard' | 'neural' | 'long-form' | 'generative'
  sampleRate?: '8000' | '16000' | '22050' | '24000'
  languageCode?: string
  textType?: 'text' | 'ssml'
}

const DEFAULT_VOICE = 'Joanna'
const DEFAULT_ENGINE: PollyProviderConfig['engine'] = 'neural'
const DEFAULT_SAMPLE_RATE: PollyProviderConfig['sampleRate'] = '24000'

/** Minimal interfaces for the @aws-sdk/client-polly types we touch */
interface PollyAudioStream {
  transformToByteArray(): Promise<Uint8Array>
}

interface PollyResponse {
  AudioStream?: PollyAudioStream
}

interface PollyClient {
  send(command: unknown): Promise<PollyResponse>
}

interface PollyClientCtor {
  new (config: Record<string, unknown>): PollyClient
}

interface PollyCommandCtor {
  new (input: Record<string, unknown>): unknown
}

/**
 * Amazon Polly TTS provider.
 * Requires `@aws-sdk/client-polly` as a peer dependency.
 *
 * Credentials are resolved via the AWS SDK default chain when not passed
 * explicitly — env vars, shared config (~/.aws/credentials), IAM role on
 * EC2/ECS/Lambda, SSO, etc.
 */
export function PollyProvider(config: PollyProviderConfig = {}): TtsProvider {
  const region = config.region
    ?? process.env.AWS_REGION
    ?? process.env.AWS_DEFAULT_REGION
    ?? 'us-east-1'
  const accessKeyId = config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY
  const sessionToken = config.sessionToken ?? process.env.AWS_SESSION_TOKEN
  const voice = config.voice ?? DEFAULT_VOICE
  const engine = config.engine ?? DEFAULT_ENGINE
  const sampleRate = config.sampleRate ?? DEFAULT_SAMPLE_RATE
  const languageCode = config.languageCode
  const textType = config.textType ?? 'text'

  let client: PollyClient | null = null
  let SynthesizeSpeechCommand: PollyCommandCtor | null = null

  async function getClient(): Promise<PollyClient> {
    if (client && SynthesizeSpeechCommand) return client
    const sdk = (await import('@aws-sdk/client-polly')) as unknown as {
      PollyClient: PollyClientCtor
      SynthesizeSpeechCommand: PollyCommandCtor
    }
    const clientConfig: Record<string, unknown> = { region }
    if (accessKeyId && secretAccessKey) {
      clientConfig.credentials = {
        accessKeyId,
        secretAccessKey,
        ...(sessionToken ? { sessionToken } : {}),
      }
    }
    client = new sdk.PollyClient(clientConfig)
    SynthesizeSpeechCommand = sdk.SynthesizeSpeechCommand
    return client
  }

  return {
    name: 'polly',

    async synthesize(text: string, options?: TtsOptions): Promise<AudioSegment> {
      const polly = await getClient()
      const Cmd = SynthesizeSpeechCommand!
      const command = new Cmd({
        Text: text,
        OutputFormat: 'mp3',
        VoiceId: options?.voice ?? voice,
        Engine: engine,
        SampleRate: sampleRate,
        TextType: textType,
        ...(languageCode ? { LanguageCode: languageCode } : {}),
      })

      const response = await polly.send(command)
      if (!response.AudioStream) {
        throw new Error('Amazon Polly returned no audio stream')
      }
      const data = Buffer.from(await response.AudioStream.transformToByteArray())

      return {
        data,
        durationMs: 0,
        format: { sampleRate: Number(sampleRate), channels: 1, codec: 'mp3' },
      }
    },

    estimateDurationMs(text: string, options?: TtsOptions): number {
      const spd = options?.speed ?? 1.0
      const words = text.split(/\s+/).length
      return (words / (150 * spd)) * 60_000
    },

    async isAvailable(): Promise<boolean> {
      // The default credential chain (IAM role, SSO, shared config) can't be
      // verified without making a call. Return true and surface auth errors
      // on the first synthesize() instead.
      return true
    },

    async dispose(): Promise<void> {
      client = null
      SynthesizeSpeechCommand = null
    },
  }
}
