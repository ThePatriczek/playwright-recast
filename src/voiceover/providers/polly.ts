import * as os from 'node:os'
import type { TtsProvider, TtsOptions, AudioSegment } from '../../types/voiceover.js'
import { synthesizeWithCache } from './util/audio-cache.js'

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
  /**
   * Directory for disk caching of synthesized audio. When set, the provider
   * skips API calls for `(text, voice, engine, sampleRate, languageCode,
   * textType)` tuples it has already synthesized. Omit to disable disk
   * caching (intra-batch dedup still applies).
   */
  cacheDir?: string
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

    async synthesize(texts: string[], options?: TtsOptions): Promise<AudioSegment[]> {
      const polly = await getClient()
      const Cmd = SynthesizeSpeechCommand!
      const voice = options?.voice ?? defaults.voice
      const languageCode = options?.languageCode ?? defaults.languageCode
      const engine = defaults.engine!
      const sampleRate = defaults.sampleRate!
      const textType = defaults.textType

      async function generateOne(text: string): Promise<Buffer> {
        const input: Record<string, unknown> = {
          Text: text,
          OutputFormat: 'mp3',
          VoiceId: voice,
          Engine: engine,
          SampleRate: sampleRate,
          TextType: textType,
        }
        if (languageCode) input.LanguageCode = languageCode
        const command = new Cmd(input)
        const response = await polly.send(command)
        if (!response.AudioStream) {
          throw new Error('Amazon Polly returned no audio stream')
        }
        return Buffer.from(await response.AudioStream.transformToByteArray())
      }

      return synthesizeWithCache({
        texts,
        workDir: options?.workDir ?? os.tmpdir(),
        cache: config.cacheDir ? { dir: config.cacheDir } : undefined,
        fingerprintFor: (text) => [
          'polly', text, voice, engine, sampleRate, languageCode ?? '', textType,
        ],
        generate: (missTexts) => Promise.all(missTexts.map(generateOne)),
        prefix: 'polly',
        format: { sampleRate: Number(sampleRate), channels: 1, codec: 'mp3' },
      })
    },

    async isAvailable(): Promise<boolean> {
      try {
        await import('@aws-sdk/client-polly')
        return true
      } catch {
        return false
      }
    },

    async dispose(): Promise<void> {
      client = null
      SynthesizeSpeechCommand = null
    },
  }
}
