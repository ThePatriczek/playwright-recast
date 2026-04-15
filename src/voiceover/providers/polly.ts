import type { TtsProvider, TtsOptions, AudioSegment } from '../../types/voiceover.js'

export interface PollyProviderConfig {
  region?: string
  accessKeyId?: string
  secretAccessKey?: string
  sessionToken?: string
  /** Polly voice id (e.g. 'Joanna', 'Matthew'). Default: 'Joanna'. */
  voice?: string
  /** Polly has no 'model' concept; `model` in TtsOptions is ignored. */
  engine?: 'standard' | 'neural' | 'long-form' | 'generative'
  sampleRate?: '8000' | '16000' | '22050' | '24000'
  /** BCP-47 language code. */
  languageCode?: string
  textType?: 'text' | 'ssml'
}

const DEFAULT_VOICE = 'Joanna'
const DEFAULT_ENGINE: PollyProviderConfig['engine'] = 'neural'
const DEFAULT_SAMPLE_RATE: PollyProviderConfig['sampleRate'] = '24000'

interface PollyAudioStream {
  transformToByteArray(): Promise<Uint8Array>
}
interface PollyResponse { AudioStream?: PollyAudioStream }
interface PollyClient { send(command: unknown): Promise<PollyResponse> }
interface PollyClientCtor { new (config: Record<string, unknown>): PollyClient }
interface PollyCommandCtor { new (input: Record<string, unknown>): unknown }

/**
 * Amazon Polly TTS provider.
 * Requires `@aws-sdk/client-polly` as a peer dependency.
 *
 * Credentials fall back to the AWS SDK default chain when not passed explicitly.
 */
export function PollyProvider(config: PollyProviderConfig = {}): TtsProvider {
  const region = config.region
    ?? process.env.AWS_REGION
    ?? process.env.AWS_DEFAULT_REGION
    ?? 'us-east-1'
  const accessKeyId = config.accessKeyId ?? process.env.AWS_ACCESS_KEY_ID
  const secretAccessKey = config.secretAccessKey ?? process.env.AWS_SECRET_ACCESS_KEY
  const sessionToken = config.sessionToken ?? process.env.AWS_SESSION_TOKEN

  const defaults = {
    voice: config.voice ?? DEFAULT_VOICE,
    engine: config.engine ?? DEFAULT_ENGINE,
    sampleRate: config.sampleRate ?? DEFAULT_SAMPLE_RATE,
    languageCode: config.languageCode,
    textType: config.textType ?? 'text',
  }

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
      const voice = options?.voice ?? defaults.voice
      const languageCode = options?.languageCode ?? defaults.languageCode

      const input: Record<string, unknown> = {
        Text: text,
        OutputFormat: 'mp3',
        VoiceId: voice,
        Engine: defaults.engine,
        SampleRate: defaults.sampleRate,
        TextType: defaults.textType,
      }
      if (languageCode) input.LanguageCode = languageCode

      const command = new Cmd(input)
      const response = await polly.send(command)
      if (!response.AudioStream) {
        throw new Error('Amazon Polly returned no audio stream')
      }
      const data = Buffer.from(await response.AudioStream.transformToByteArray())

      return {
        data,
        durationMs: 0,
        format: { sampleRate: Number(defaults.sampleRate), channels: 1, codec: 'mp3' },
      }
    },

    estimateDurationMs(text: string, options?: TtsOptions): number {
      const spd = options?.speed ?? 1.0
      const words = text.split(/\s+/).length
      return (words / (150 * spd)) * 60_000
    },

    async isAvailable(): Promise<boolean> {
      return true
    },

    async dispose(): Promise<void> {
      client = null
      SynthesizeSpeechCommand = null
    },
  }
}
