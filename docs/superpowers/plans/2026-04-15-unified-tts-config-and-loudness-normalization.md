# Unified TTS Provider Config & Loudness Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Standardize TTS provider config/options across ElevenLabs, OpenAI, and Polly so the `.voiceover(...)` API is consistent — and add an opt-in per-segment loudness normalization pass so raw TTS audio is level-matched before concat.

**Architecture:**
- Three TTS provider factories share common field names (`voice`, `model`, `languageCode`). Provider-specific knobs (`voiceSettings`, `instructions`, `engine`) live in the provider's own config. `TtsOptions` is a small per-call override struct — every provider merges `options` over factory `config` consistently.
- Loudness normalization is a pure post-synthesis filter: each segment returned by `provider.synthesize()` runs through a two-pass ffmpeg `loudnorm` before concat. Silence segments skip it. Enabled via `.voiceover(provider, { normalize: true | config })`.

**Tech Stack:** TypeScript (ES2022 modules), Vitest 4, Node `node:child_process` + ffmpeg/ffprobe (already required by the pipeline).

**Scope note:** This is a breaking change for the ElevenLabs provider (`voiceId` → `voice`, `modelId` → `model`). The consumer in `~/Work/cdx-daemon/frontend/apps/demo/utils/recast-pipeline.ts` is updated in **Task 10** (cross-repo commit).

---

## File Structure

**Modify:**
- `src/types/voiceover.ts` — extend `TtsOptions`; add `VoiceoverOptions`, `LoudnessNormalizeConfig`.
- `src/voiceover/providers/elevenlabs.ts` — rename fields; merge config+options; add `voiceSettings`.
- `src/voiceover/providers/openai.ts` — merge config+options consistently; add `languageCode` support.
- `src/voiceover/providers/polly.ts` — merge config+options consistently (esp. `languageCode` override).
- `src/voiceover/voiceover-processor.ts` — accept `VoiceoverOptions`, call normalize per segment when enabled.
- `src/pipeline/stages.ts` — `voiceover` descriptor carries `options?: VoiceoverOptions`.
- `src/pipeline/pipeline.ts` — `.voiceover(provider, options?)`.
- `src/pipeline/executor.ts` — pass `stage.options` to `generateVoiceover`.
- `src/index.ts` — export `VoiceoverOptions`, `LoudnessNormalizeConfig`.
- `CHANGELOG.md` — entry for 0.15.0 (breaking + feature).

**Create:**
- `src/voiceover/normalize.ts` — `normalizeLoudness(inputPath, outputPath, config?)` two-pass `loudnorm` utility.
- `tests/unit/voiceover/normalize.test.ts`
- `tests/unit/voiceover/providers.test.ts`
- `tests/unit/voiceover/voiceover-processor.test.ts`
- `tests/unit/pipeline/voiceover-stage.test.ts`

---

## Task 1: Extend `TtsOptions` + add `VoiceoverOptions` & `LoudnessNormalizeConfig` types

**Files:**
- Modify: `src/types/voiceover.ts`

- [ ] **Step 1: Replace the types file contents**

Path: `src/types/voiceover.ts`

```typescript
import type { SubtitleEntry, SubtitledTrace } from './subtitle.js'

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

/**
 * Per-call overrides for a single TTS synthesis call.
 * Provider factory config supplies defaults; options override them.
 */
export interface TtsOptions {
  /** Voice id/name override (provider-specific) */
  voice?: string
  /** Model id override (provider-specific; ignored by providers without a model concept) */
  model?: string
  /** BCP-47 language code override (e.g. 'cs', 'en-US') */
  languageCode?: string
  /** Playback speed multiplier (1.0 = natural). Providers without speed control ignore this. */
  speed?: number
  /** Output audio format hint */
  format?: 'mp3' | 'wav' | 'opus' | 'pcm'
}

/** The contract every TTS provider must implement */
export interface TtsProvider {
  readonly name: string
  synthesize(text: string, options?: TtsOptions): Promise<AudioSegment>
  estimateDurationMs(text: string, options?: TtsOptions): number
  isAvailable(): Promise<boolean>
  dispose(): Promise<void>
}

/** EBU R128 loudness normalization settings (two-pass `loudnorm`). */
export interface LoudnessNormalizeConfig {
  /** Integrated loudness target, LUFS. Default: -16. */
  targetLufs?: number
  /** True-peak ceiling, dBFS. Default: -1. */
  truePeakDb?: number
  /** Loudness range target, LU. Default: 11. */
  lra?: number
  /** Linear mode preserves dynamics (recommended for speech). Default: true. */
  linear?: boolean
  /** Output sample rate. Default: 44100. */
  sampleRate?: number
  /** Output bitrate for the re-encoded mp3. Default: '128k'. */
  bitrate?: string
}

/** Options passed to the `.voiceover(provider, options)` pipeline stage. */
export interface VoiceoverOptions {
  /** Normalize each synthesized segment to a common loudness before concat.
   *  `true` uses defaults (-16 LUFS / -1 dBFS TP / 11 LU, linear). */
  normalize?: boolean | LoudnessNormalizeConfig
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
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (downstream providers/processor may still compile because existing fields are backwards-compatible at the type level — they'll be refactored in later tasks).

- [ ] **Step 3: Commit**

```bash
git add src/types/voiceover.ts
git commit -m "feat(voiceover): extend TtsOptions and add VoiceoverOptions types"
```

---

## Task 2: Refactor ElevenLabs provider — unified field names + voiceSettings + options merging

**Files:**
- Modify: `src/voiceover/providers/elevenlabs.ts`
- Test: `tests/unit/voiceover/providers.test.ts`

- [ ] **Step 1: Create the test file with failing tests**

Path: `tests/unit/voiceover/providers.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ElevenLabsProvider } from '../../../src/voiceover/providers/elevenlabs'

// Mock the ElevenLabs SDK
const convertMock = vi.fn()
vi.mock('@elevenlabs/elevenlabs-js', () => ({
  ElevenLabsClient: vi.fn().mockImplementation(() => ({
    textToSpeech: { convert: convertMock },
  })),
}))

function makeStream(bytes: Uint8Array): { getReader: () => unknown } {
  let done = false
  return {
    getReader: () => ({
      read: async () => (done ? { done: true, value: undefined } : ((done = true), { done: false, value: bytes })),
    }),
  }
}

describe('ElevenLabsProvider', () => {
  beforeEach(() => {
    convertMock.mockReset()
    convertMock.mockResolvedValue(makeStream(new Uint8Array([1, 2, 3])))
  })

  it('sends voice, model and languageCode from factory config', async () => {
    const p = ElevenLabsProvider({
      apiKey: 'k', voice: 'v1', model: 'm1', languageCode: 'cs',
    })
    await p.synthesize('hello')
    expect(convertMock).toHaveBeenCalledWith('v1', expect.objectContaining({
      text: 'hello', modelId: 'm1', languageCode: 'cs', outputFormat: 'mp3_44100_128',
    }))
  })

  it('options override factory config per call', async () => {
    const p = ElevenLabsProvider({ apiKey: 'k', voice: 'v1', model: 'm1', languageCode: 'cs' })
    await p.synthesize('hello', { voice: 'v2', model: 'm2', languageCode: 'en' })
    expect(convertMock).toHaveBeenCalledWith('v2', expect.objectContaining({
      modelId: 'm2', languageCode: 'en',
    }))
  })

  it('passes voiceSettings to the API call when provided', async () => {
    const p = ElevenLabsProvider({
      apiKey: 'k',
      voiceSettings: { stability: 0.75, similarityBoost: 0.8, style: 0.1, useSpeakerBoost: true },
    })
    await p.synthesize('x')
    expect(convertMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      voiceSettings: { stability: 0.75, similarityBoost: 0.8, style: 0.1, useSpeakerBoost: true },
    }))
  })

  it('omits voiceSettings when not provided', async () => {
    const p = ElevenLabsProvider({ apiKey: 'k' })
    await p.synthesize('x')
    const args = convertMock.mock.calls[0]![1] as Record<string, unknown>
    expect(args).not.toHaveProperty('voiceSettings')
  })
})
```

- [ ] **Step 2: Run the test — expect failures**

Run: `npm test -- tests/unit/voiceover/providers.test.ts`
Expected: FAIL — tests reference `voice`/`model` fields that don't exist yet (current provider has `voiceId`/`modelId`); `voiceSettings` isn't wired.

- [ ] **Step 3: Rewrite the ElevenLabs provider**

Path: `src/voiceover/providers/elevenlabs.ts`

```typescript
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
        durationMs: 0, // measured by voiceover-processor via ffprobe
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/voiceover/providers.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck whole project**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/voiceover/providers/elevenlabs.ts tests/unit/voiceover/providers.test.ts
git commit -m "feat(providers)!: unify ElevenLabs config to voice/model/languageCode + add voiceSettings

BREAKING CHANGE: ElevenLabsProviderConfig fields voiceId/modelId renamed to voice/model."
```

---

## Task 3: Refactor OpenAI provider — consistent options merging

**Files:**
- Modify: `src/voiceover/providers/openai.ts`
- Test: `tests/unit/voiceover/providers.test.ts`

- [ ] **Step 1: Append OpenAI tests to the same test file**

Append to `tests/unit/voiceover/providers.test.ts`:

```typescript
import { OpenAIProvider } from '../../../src/voiceover/providers/openai'

const openaiCreateMock = vi.fn()
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    audio: { speech: { create: openaiCreateMock } },
  })),
}))

describe('OpenAIProvider', () => {
  beforeEach(() => {
    openaiCreateMock.mockReset()
    openaiCreateMock.mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(3) })
  })

  it('sends voice, model, and speed from factory config', async () => {
    const p = OpenAIProvider({ apiKey: 'k', voice: 'nova', model: 'tts-1', speed: 1.1 })
    await p.synthesize('hi')
    expect(openaiCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      voice: 'nova', model: 'tts-1', speed: 1.1, input: 'hi', response_format: 'mp3',
    }))
  })

  it('options override factory config per call', async () => {
    const p = OpenAIProvider({ apiKey: 'k', voice: 'nova', model: 'tts-1', speed: 1.1 })
    await p.synthesize('hi', { voice: 'echo', model: 'tts-2', speed: 0.9 })
    expect(openaiCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      voice: 'echo', model: 'tts-2', speed: 0.9,
    }))
  })

  it('adds instructions from factory config when provided', async () => {
    const p = OpenAIProvider({ apiKey: 'k', instructions: 'be calm' })
    await p.synthesize('x')
    expect(openaiCreateMock).toHaveBeenCalledWith(expect.objectContaining({ instructions: 'be calm' }))
  })

  it('omits instructions when not provided', async () => {
    const p = OpenAIProvider({ apiKey: 'k' })
    await p.synthesize('x')
    const args = openaiCreateMock.mock.calls[0]![0] as Record<string, unknown>
    expect(args).not.toHaveProperty('instructions')
  })
})
```

- [ ] **Step 2: Run new tests — some already pass, some fail**

Run: `npm test -- tests/unit/voiceover/providers.test.ts`
Expected: OpenAI tests mostly PASS (current impl already merges most fields) — verify all four green; if any fail, the next step fixes them.

- [ ] **Step 3: Rewrite OpenAI provider for strict consistency with the new options contract**

Path: `src/voiceover/providers/openai.ts`

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/voiceover/providers.test.ts`
Expected: PASS (all 8 tests — 4 ElevenLabs + 4 OpenAI).

- [ ] **Step 5: Commit**

```bash
git add src/voiceover/providers/openai.ts tests/unit/voiceover/providers.test.ts
git commit -m "refactor(providers): OpenAI provider merges config + per-call options consistently"
```

---

## Task 4: Refactor Polly provider — consistent options merging (voice + languageCode)

**Files:**
- Modify: `src/voiceover/providers/polly.ts`
- Test: `tests/unit/voiceover/providers.test.ts`

- [ ] **Step 1: Append Polly tests to the same test file**

Append to `tests/unit/voiceover/providers.test.ts`:

```typescript
import { PollyProvider } from '../../../src/voiceover/providers/polly'

const pollySendMock = vi.fn()
const pollyCommandCtor = vi.fn((input: Record<string, unknown>) => ({ input }))
vi.mock('@aws-sdk/client-polly', () => ({
  PollyClient: vi.fn().mockImplementation(() => ({ send: pollySendMock })),
  SynthesizeSpeechCommand: pollyCommandCtor,
}))

describe('PollyProvider', () => {
  beforeEach(() => {
    pollySendMock.mockReset()
    pollyCommandCtor.mockClear()
    pollySendMock.mockResolvedValue({
      AudioStream: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    })
  })

  it('sends voice, engine, and languageCode from factory config', async () => {
    const p = PollyProvider({
      region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 's',
      voice: 'Joanna', engine: 'neural', languageCode: 'en-US',
    })
    await p.synthesize('hi')
    expect(pollyCommandCtor).toHaveBeenCalledWith(expect.objectContaining({
      Text: 'hi', VoiceId: 'Joanna', Engine: 'neural', LanguageCode: 'en-US',
    }))
  })

  it('voice and languageCode options override config per call', async () => {
    const p = PollyProvider({
      region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 's',
      voice: 'Joanna', languageCode: 'en-US',
    })
    await p.synthesize('hi', { voice: 'Matthew', languageCode: 'en-GB' })
    expect(pollyCommandCtor).toHaveBeenCalledWith(expect.objectContaining({
      VoiceId: 'Matthew', LanguageCode: 'en-GB',
    }))
  })

  it('throws when Polly returns no AudioStream', async () => {
    pollySendMock.mockResolvedValueOnce({})
    const p = PollyProvider({ region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 's' })
    await expect(p.synthesize('x')).rejects.toThrow(/no audio stream/i)
  })
})
```

- [ ] **Step 2: Run the new tests — expect `languageCode` override to fail**

Run: `npm test -- tests/unit/voiceover/providers.test.ts`
Expected: one FAIL on the override test (current Polly impl reads `languageCode` from config only, ignores `options.languageCode`).

- [ ] **Step 3: Rewrite Polly provider**

Path: `src/voiceover/providers/polly.ts`

```typescript
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
```

- [ ] **Step 4: Run test to verify all pass**

Run: `npm test -- tests/unit/voiceover/providers.test.ts`
Expected: PASS (11 tests — 4 ElevenLabs + 4 OpenAI + 3 Polly).

- [ ] **Step 5: Commit**

```bash
git add src/voiceover/providers/polly.ts tests/unit/voiceover/providers.test.ts
git commit -m "refactor(providers): Polly provider merges config + per-call options (voice, languageCode)"
```

---

## Task 5: Create `normalizeLoudness` two-pass `loudnorm` utility

**Files:**
- Create: `src/voiceover/normalize.ts`
- Create: `tests/unit/voiceover/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `tests/unit/voiceover/normalize.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { normalizeLoudness } from '../../../src/voiceover/normalize'

const TMP_ROOT = path.join(os.tmpdir(), `recast-normalize-test-${process.pid}`)

/** Generate a 4-second 440Hz sine mp3 at a given gain (dB). ebur128 needs ≥3s
 *  of signal to compute integrated loudness reliably. */
function makeSineMp3(outPath: string, gainDb: number): void {
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', 'sine=frequency=440:sample_rate=44100:duration=4',
    '-af', `volume=${gainDb}dB`,
    '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k',
    outPath,
  ])
}

/** Parse ebur128 integrated loudness (LUFS) from ffmpeg stderr. */
function measureLufs(file: string): number {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file,
    '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], { encoding: 'utf8' })
  const m = (r.stderr ?? '').match(/Integrated loudness:[\s\S]*?I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/)
  if (!m) throw new Error(`Could not parse LUFS from ffmpeg output:\n${r.stderr}`)
  return Number(m[1])
}

describe('normalizeLoudness', () => {
  beforeAll(() => { fs.mkdirSync(TMP_ROOT, { recursive: true }) })
  afterAll(() => { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) })

  it('raises a quiet input to the target LUFS (within 1.5 LU tolerance)', async () => {
    const quiet = path.join(TMP_ROOT, 'quiet.mp3')
    const out = path.join(TMP_ROOT, 'quiet-norm.mp3')
    makeSineMp3(quiet, -30)
    await normalizeLoudness(quiet, out, { targetLufs: -16 })
    const i = measureLufs(out)
    expect(i).toBeGreaterThan(-17.5)
    expect(i).toBeLessThan(-14.5)
  })

  it('lowers a loud input to the target LUFS (within 1.5 LU tolerance)', async () => {
    const loud = path.join(TMP_ROOT, 'loud.mp3')
    const out = path.join(TMP_ROOT, 'loud-norm.mp3')
    makeSineMp3(loud, -6)
    await normalizeLoudness(loud, out, { targetLufs: -16 })
    const i = measureLufs(out)
    expect(i).toBeGreaterThan(-17.5)
    expect(i).toBeLessThan(-14.5)
  })

  it('writes a valid mp3 file', async () => {
    const src = path.join(TMP_ROOT, 'src.mp3')
    const out = path.join(TMP_ROOT, 'out.mp3')
    makeSineMp3(src, -20)
    await normalizeLoudness(src, out)
    expect(fs.existsSync(out)).toBe(true)
    expect(fs.statSync(out).size).toBeGreaterThan(1000)
  })
})
```

- [ ] **Step 2: Run the test — expect module-not-found failure**

Run: `npm test -- tests/unit/voiceover/normalize.test.ts`
Expected: FAIL — cannot resolve `../../../src/voiceover/normalize`.

- [ ] **Step 3: Implement `normalizeLoudness`**

Path: `src/voiceover/normalize.ts`

```typescript
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { LoudnessNormalizeConfig } from '../types/voiceover.js'

const execFileAsync = promisify(execFile)

const DEFAULTS = {
  targetLufs: -16,
  truePeakDb: -1,
  lra: 11,
  linear: true,
  sampleRate: 44100,
  bitrate: '128k',
} as const

interface Pass1Measurement {
  input_i: string
  input_tp: string
  input_lra: string
  input_thresh: string
  target_offset: string
}

/**
 * Two-pass EBU R128 loudness normalization via ffmpeg's `loudnorm` filter.
 *
 * Pass 1 measures the input, pass 2 applies linear gain with measured values
 * so the output exactly meets the target (within loudnorm's ±0.5 LU accuracy).
 * Linear mode preserves dynamics — recommended for speech.
 */
export async function normalizeLoudness(
  inputPath: string,
  outputPath: string,
  config: LoudnessNormalizeConfig = {},
): Promise<void> {
  const cfg = { ...DEFAULTS, ...config }

  const pass1Filter =
    `loudnorm=I=${cfg.targetLufs}:TP=${cfg.truePeakDb}:LRA=${cfg.lra}:print_format=json`

  // Pass 1: measure. ffmpeg writes the JSON block to stderr; exit 0.
  const { stderr: pass1Stderr } = await execFileAsync('ffmpeg', [
    '-hide_banner', '-nostats',
    '-i', inputPath,
    '-af', pass1Filter,
    '-f', 'null', '-',
  ], { maxBuffer: 10 * 1024 * 1024 })

  const measured = parseLoudnormJson(pass1Stderr)

  // Pass 2: apply measured values. `linear=true` must come BEFORE `offset` in
  // some ffmpeg builds — the expression parser otherwise consumes the following
  // option as part of the offset numeric expression.
  const pass2Filter = [
    'loudnorm',
    cfg.linear ? 'linear=true' : 'linear=false',
    `I=${cfg.targetLufs}`,
    `TP=${cfg.truePeakDb}`,
    `LRA=${cfg.lra}`,
    `measured_I=${measured.input_i}`,
    `measured_TP=${measured.input_tp}`,
    `measured_LRA=${measured.input_lra}`,
    `measured_thresh=${measured.input_thresh}`,
    `offset=${measured.target_offset}`,
    'print_format=summary',
  ].join(':')

  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', inputPath,
    '-af', pass2Filter,
    '-ar', String(cfg.sampleRate),
    '-ac', '1',
    '-c:a', 'libmp3lame',
    '-b:a', cfg.bitrate,
    outputPath,
  ], { maxBuffer: 10 * 1024 * 1024 })
}

/** Extract the JSON block printed by `loudnorm` pass 1. */
function parseLoudnormJson(stderr: string): Pass1Measurement {
  const start = stderr.lastIndexOf('{')
  const end = stderr.lastIndexOf('}')
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`loudnorm pass 1 produced no JSON output:\n${stderr}`)
  }
  const json = stderr.slice(start, end + 1)
  const parsed = JSON.parse(json) as Partial<Pass1Measurement>
  for (const k of ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const) {
    if (typeof parsed[k] !== 'string') {
      throw new Error(`loudnorm pass 1 JSON missing field '${k}':\n${json}`)
    }
  }
  return parsed as Pass1Measurement
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/voiceover/normalize.test.ts`
Expected: PASS (3 tests). Each test takes ~1–2 seconds (ffmpeg sine generation + two-pass normalize + measurement).

- [ ] **Step 5: Commit**

```bash
git add src/voiceover/normalize.ts tests/unit/voiceover/normalize.test.ts
git commit -m "feat(voiceover): add normalizeLoudness (two-pass EBU R128 loudnorm)"
```

---

## Task 6: Wire `VoiceoverOptions` into the pipeline stage descriptor and fluent builder

**Files:**
- Modify: `src/pipeline/stages.ts`
- Modify: `src/pipeline/pipeline.ts`
- Test: `tests/unit/pipeline/voiceover-stage.test.ts`

- [ ] **Step 1: Write the failing pipeline test**

Path: `tests/unit/pipeline/voiceover-stage.test.ts`

```typescript
import { describe, it, expect } from 'vitest'
import { Recast } from '../../../src/index'
import type { TtsProvider } from '../../../src/types/voiceover'

const fakeProvider: TtsProvider = {
  name: 'fake',
  async synthesize() { return { data: Buffer.alloc(0), durationMs: 0, format: { sampleRate: 44100, channels: 1, codec: 'mp3' } } },
  estimateDurationMs() { return 0 },
  async isAvailable() { return true },
  async dispose() {},
}

describe('Pipeline.voiceover(provider, options)', () => {
  it('stores the provider without options when none are given', () => {
    const p = Recast.from('./t').parse().voiceover(fakeProvider)
    const stage = p.getStages().find((s) => s.type === 'voiceover')
    expect(stage?.type).toBe('voiceover')
    if (stage?.type === 'voiceover') {
      expect(stage.provider).toBe(fakeProvider)
      expect(stage.options).toBeUndefined()
    }
  })

  it('stores VoiceoverOptions including normalize: true', () => {
    const p = Recast.from('./t').parse().voiceover(fakeProvider, { normalize: true })
    const stage = p.getStages().find((s) => s.type === 'voiceover')
    if (stage?.type !== 'voiceover') throw new Error('missing stage')
    expect(stage.options).toEqual({ normalize: true })
  })

  it('stores VoiceoverOptions with a custom LoudnessNormalizeConfig', () => {
    const p = Recast.from('./t').parse().voiceover(fakeProvider, {
      normalize: { targetLufs: -18, truePeakDb: -1.5, linear: false },
    })
    const stage = p.getStages().find((s) => s.type === 'voiceover')
    if (stage?.type !== 'voiceover') throw new Error('missing stage')
    expect(stage.options).toEqual({
      normalize: { targetLufs: -18, truePeakDb: -1.5, linear: false },
    })
  })
})
```

- [ ] **Step 2: Run the test — expect failures**

Run: `npm test -- tests/unit/pipeline/voiceover-stage.test.ts`
Expected: FAIL — `.voiceover()` currently takes only `provider`; `options` does not exist on the stage.

- [ ] **Step 3: Update the stage descriptor**

In `src/pipeline/stages.ts`, change the `voiceover` case and add the import.

Find:
```typescript
import type { TtsProvider } from '../types/voiceover.js'
```
Replace with:
```typescript
import type { TtsProvider, VoiceoverOptions } from '../types/voiceover.js'
```

Find:
```typescript
  | { type: 'voiceover'; provider: TtsProvider }
```
Replace with:
```typescript
  | { type: 'voiceover'; provider: TtsProvider; options?: VoiceoverOptions }
```

- [ ] **Step 4: Update the fluent builder**

In `src/pipeline/pipeline.ts`, update the import and the `voiceover` method.

Find:
```typescript
import type { TtsProvider } from '../types/voiceover.js'
```
Replace with:
```typescript
import type { TtsProvider, VoiceoverOptions } from '../types/voiceover.js'
```

Find:
```typescript
  /** Generate voiceover audio from subtitles using a TTS provider */
  voiceover(provider: TtsProvider): Pipeline {
    return this.addStage({ type: 'voiceover', provider })
  }
```
Replace with:
```typescript
  /**
   * Generate voiceover audio from subtitles using a TTS provider.
   *
   * @param provider  TTS provider (OpenAIProvider, ElevenLabsProvider, PollyProvider, ...).
   * @param options   Optional post-synthesis processing. `normalize: true` runs
   *                  each synthesized segment through EBU R128 two-pass loudnorm
   *                  (default -16 LUFS / -1 dBFS TP / 11 LU) before concat, which
   *                  fixes per-segment loudness drift common in ElevenLabs + czech.
   */
  voiceover(provider: TtsProvider, options?: VoiceoverOptions): Pipeline {
    return this.addStage({ type: 'voiceover', provider, options })
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- tests/unit/pipeline/voiceover-stage.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/pipeline/stages.ts src/pipeline/pipeline.ts tests/unit/pipeline/voiceover-stage.test.ts
git commit -m "feat(pipeline): accept VoiceoverOptions in .voiceover(provider, options)"
```

---

## Task 7: Apply normalization per segment inside `generateVoiceover`

**Files:**
- Modify: `src/voiceover/voiceover-processor.ts`
- Create: `tests/unit/voiceover/voiceover-processor.test.ts`

- [ ] **Step 1: Write the failing test**

Path: `tests/unit/voiceover/voiceover-processor.test.ts`

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { generateVoiceover } from '../../../src/voiceover/voiceover-processor'
import type { TtsProvider } from '../../../src/types/voiceover'
import type { SubtitledTrace } from '../../../src/types/subtitle'

const TMP_ROOT = path.join(os.tmpdir(), `recast-vo-processor-test-${process.pid}`)

function makeSineBuffer(gainDb: number, durationSec = 4): Buffer {
  const out = path.join(TMP_ROOT, `sine-${gainDb}-${Math.random().toString(36).slice(2)}.mp3`)
  execFileSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi',
    '-i', `sine=frequency=440:sample_rate=44100:duration=${durationSec}`,
    '-af', `volume=${gainDb}dB`,
    '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k',
    out,
  ])
  const buf = fs.readFileSync(out)
  fs.rmSync(out)
  return buf
}

function measureLufs(file: string): number {
  const r = spawnSync('ffmpeg', [
    '-hide_banner', '-nostats', '-i', file,
    '-af', 'ebur128=peak=true', '-f', 'null', '-',
  ], { encoding: 'utf8' })
  const m = (r.stderr ?? '').match(/Integrated loudness:[\s\S]*?I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/)
  if (!m) throw new Error(`Could not parse LUFS:\n${r.stderr}`)
  return Number(m[1])
}

/** Provider that returns a pre-baked buffer per call, alternating quiet/loud. */
function levelAlternatingProvider(buffers: Buffer[]): TtsProvider {
  let i = 0
  return {
    name: 'fake-alt',
    async synthesize() {
      const data = buffers[i++ % buffers.length]!
      return { data, durationMs: 0, format: { sampleRate: 44100, channels: 1, codec: 'mp3' } }
    },
    estimateDurationMs() { return 0 },
    async isAvailable() { return true },
    async dispose() {},
  }
}

function makeTrace(subtitleCount: number): SubtitledTrace {
  const subs = Array.from({ length: subtitleCount }, (_, k) => ({
    index: k + 1,
    startMs: k * 6000,
    endMs: k * 6000 + 5000, // 5s windows — 4s sine fits without overflow
    text: `line ${k + 1}`,
    ttsText: undefined as string | undefined,
  }))
  // Minimal SubtitledTrace — the processor only uses `subtitles`
  return { subtitles: subs } as unknown as SubtitledTrace
}

describe('generateVoiceover with VoiceoverOptions.normalize', () => {
  beforeAll(() => { fs.mkdirSync(TMP_ROOT, { recursive: true }) })
  afterAll(() => { fs.rmSync(TMP_ROOT, { recursive: true, force: true }) })

  it('without normalize, per-segment levels differ widely', async () => {
    const quiet = makeSineBuffer(-30)
    const loud = makeSineBuffer(-6)
    const provider = levelAlternatingProvider([quiet, loud])
    const tmp = path.join(TMP_ROOT, 'no-norm')
    const trace = makeTrace(2)

    const result = await generateVoiceover(trace, provider, tmp)
    const seg1 = path.join(tmp, 'seg-1.mp3')
    const seg2 = path.join(tmp, 'seg-2.mp3')
    const l1 = measureLufs(seg1)
    const l2 = measureLufs(seg2)
    expect(Math.abs(l1 - l2)).toBeGreaterThan(10) // raw drift
    expect(result.voiceover.entries).toHaveLength(2)
  })

  it('with normalize: true, per-segment levels converge to target (within 2 LU)', async () => {
    const quiet = makeSineBuffer(-30)
    const loud = makeSineBuffer(-6)
    const provider = levelAlternatingProvider([quiet, loud])
    const tmp = path.join(TMP_ROOT, 'norm-on')
    const trace = makeTrace(2)

    await generateVoiceover(trace, provider, tmp, { normalize: true })
    const l1 = measureLufs(path.join(tmp, 'seg-1.mp3'))
    const l2 = measureLufs(path.join(tmp, 'seg-2.mp3'))
    expect(Math.abs(l1 - l2)).toBeLessThan(2)
    expect(l1).toBeGreaterThan(-18)
    expect(l1).toBeLessThan(-14)
  })

  it('respects custom targetLufs', async () => {
    const quiet = makeSineBuffer(-30)
    const provider = levelAlternatingProvider([quiet])
    const tmp = path.join(TMP_ROOT, 'norm-custom')
    const trace = makeTrace(1)

    await generateVoiceover(trace, provider, tmp, { normalize: { targetLufs: -22 } })
    const l = measureLufs(path.join(tmp, 'seg-1.mp3'))
    expect(l).toBeGreaterThan(-24)
    expect(l).toBeLessThan(-20)
  })
})
```

- [ ] **Step 2: Run the test — expect failures**

Run: `npm test -- tests/unit/voiceover/voiceover-processor.test.ts`
Expected: FAIL on the two `normalize:` cases — current `generateVoiceover` has no options parameter.

- [ ] **Step 3: Add options parameter + per-segment normalization**

Path: `src/voiceover/voiceover-processor.ts`

Replace the entire file with:

```typescript
import * as fs from 'node:fs'
import * as path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { SubtitledTrace } from '../types/subtitle.js'
import type {
  TtsProvider,
  VoiceoveredTrace,
  VoiceoverEntry,
  VoiceoverOptions,
  LoudnessNormalizeConfig,
} from '../types/voiceover.js'
import { normalizeLoudness } from './normalize.js'

function getAudioDurationMs(filePath: string): number {
  const output = execFileSync('ffprobe', [
    '-v', 'quiet',
    '-show_entries', 'format=duration',
    '-of', 'csv=p=0',
    filePath,
  ]).toString().trim()
  return Math.round(Number(output) * 1000)
}

function generateSilence(durationMs: number, outputPath: string, sampleRate = 24000): void {
  const durationSec = Math.max(0.01, durationMs / 1000)
  execFileSync('ffmpeg', [
    '-y', '-f', 'lavfi',
    '-i', `anullsrc=r=${sampleRate}:cl=mono`,
    '-t', String(durationSec),
    '-c:a', 'libmp3lame', '-q:a', '9',
    outputPath,
  ], { stdio: 'pipe' })
}

/** Resolve normalize option to a concrete config or `null` (disabled). */
function resolveNormalize(
  opt: VoiceoverOptions['normalize'] | undefined,
): LoudnessNormalizeConfig | null {
  if (!opt) return null
  if (opt === true) return {}
  return opt
}

/**
 * Generate voiceover audio from subtitles using a TTS provider.
 * Produces individual audio segments, optionally normalizes loudness per segment,
 * pads with silence to match timing, and concatenates into a single audio track.
 */
export async function generateVoiceover(
  trace: SubtitledTrace,
  provider: TtsProvider,
  tmpDir: string,
  options?: VoiceoverOptions,
): Promise<VoiceoveredTrace> {
  fs.mkdirSync(tmpDir, { recursive: true })
  const normalizeConfig = resolveNormalize(options?.normalize)

  const entries: VoiceoverEntry[] = []
  const segmentFiles: string[] = []
  let cursor = 0
  let timeShift = 0 // cumulative shift from TTS overflows

  for (let si = 0; si < trace.subtitles.length; si++) {
    const subtitle = trace.subtitles[si]!

    subtitle.startMs += timeShift
    subtitle.endMs += timeShift

    if (subtitle.startMs > cursor) {
      const silencePath = path.join(tmpDir, `silence-${subtitle.index}.mp3`)
      generateSilence(subtitle.startMs - cursor, silencePath)
      segmentFiles.push(silencePath)
    }

    // Synthesize raw TTS into a staging file, then (optionally) normalize into
    // the canonical seg-N.mp3 path. Downstream code (tests, debugging, inspection)
    // can always rely on seg-N.mp3 being the segment that landed in the concat.
    const segPath = path.join(tmpDir, `seg-${subtitle.index}.mp3`)
    const audio = await provider.synthesize(subtitle.ttsText ?? subtitle.text)

    if (normalizeConfig) {
      const rawPath = path.join(tmpDir, `raw-${subtitle.index}.mp3`)
      fs.writeFileSync(rawPath, audio.data)
      await normalizeLoudness(rawPath, segPath, normalizeConfig)
    } else {
      fs.writeFileSync(segPath, audio.data)
    }

    const audioDuration = getAudioDurationMs(segPath)
    const windowDuration = subtitle.endMs - subtitle.startMs

    if (windowDuration < 100) {
      cursor = subtitle.endMs
    } else if (audioDuration <= windowDuration) {
      segmentFiles.push(segPath)
      const pad = windowDuration - audioDuration
      if (pad > 50) {
        const padPath = path.join(tmpDir, `pad-${subtitle.index}.mp3`)
        generateSilence(pad, padPath)
        segmentFiles.push(padPath)
      }
      cursor = subtitle.endMs
    } else {
      const overflow = audioDuration - windowDuration
      segmentFiles.push(segPath)
      subtitle.endMs = subtitle.startMs + audioDuration
      timeShift += overflow
      cursor = subtitle.endMs
    }

    entries.push({
      subtitle,
      audio,
      outputStartMs: subtitle.startMs,
      outputEndMs: subtitle.endMs,
    })
  }

  const concatList = path.join(tmpDir, 'concat.txt')
  fs.writeFileSync(
    concatList,
    segmentFiles.map((f) => `file '${path.basename(f)}'`).join('\n'),
  )

  const audioTrackPath = path.join(tmpDir, 'voiceover.mp3')
  if (segmentFiles.length > 0) {
    execFileSync('ffmpeg', [
      '-y', '-f', 'concat', '-safe', '0',
      '-i', concatList,
      '-c', 'copy',
      audioTrackPath,
    ], { stdio: 'pipe' })
  }

  const totalDurationMs = segmentFiles.length > 0
    ? getAudioDurationMs(audioTrackPath)
    : 0

  return {
    ...trace,
    voiceover: {
      entries,
      audioTrackPath,
      totalDurationMs,
    },
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/unit/voiceover/voiceover-processor.test.ts`
Expected: PASS (3 tests). Each normalize test takes ~2–3 s.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/voiceover/voiceover-processor.ts tests/unit/voiceover/voiceover-processor.test.ts
git commit -m "feat(voiceover): per-segment loudness normalization via VoiceoverOptions.normalize"
```

---

## Task 8: Thread `VoiceoverOptions` through the executor

**Files:**
- Modify: `src/pipeline/executor.ts`

- [ ] **Step 1: Update the `voiceover` case in the executor to pass options**

In `src/pipeline/executor.ts`, find the `case 'voiceover':` block (around line 767) and update the `generateVoiceover` call.

Find:
```typescript
          const tmpDir = path.join(path.dirname(state.sourceVideoPath ?? '/tmp'), '.recast-vo-tmp')
          state.voiceovered = await generateVoiceover(state.subtitled, stage.provider, tmpDir)
          break
```
Replace with:
```typescript
          const tmpDir = path.join(path.dirname(state.sourceVideoPath ?? '/tmp'), '.recast-vo-tmp')
          state.voiceovered = await generateVoiceover(
            state.subtitled,
            stage.provider,
            tmpDir,
            stage.options,
          )
          break
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`
Expected: PASS (all existing tests + 11 provider + 3 normalize + 3 processor + 3 pipeline-stage tests).

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/executor.ts
git commit -m "feat(pipeline): executor forwards VoiceoverOptions to generateVoiceover"
```

---

## Task 9: Public API exports + CHANGELOG

**Files:**
- Modify: `src/index.ts`
- Modify: `CHANGELOG.md`

- [ ] **Step 1: Export the new types and the normalize helper**

In `src/index.ts`, find:
```typescript
export type {
  TtsProvider,
  TtsOptions,
  AudioSegment,
  VoiceoverEntry,
  VoiceoveredTrace,
} from './types/voiceover.js'
```
Replace with:
```typescript
export type {
  TtsProvider,
  TtsOptions,
  AudioSegment,
  VoiceoverEntry,
  VoiceoveredTrace,
  VoiceoverOptions,
  LoudnessNormalizeConfig,
} from './types/voiceover.js'

export { normalizeLoudness } from './voiceover/normalize.js'
```

Also, in the same file, re-export the ElevenLabs voice settings type for TypeScript users. Find:
```typescript
export { ElevenLabsProvider } from './voiceover/providers/elevenlabs.js'
```
Replace with:
```typescript
export { ElevenLabsProvider } from './voiceover/providers/elevenlabs.js'
export type { ElevenLabsProviderConfig, ElevenLabsVoiceSettings } from './voiceover/providers/elevenlabs.js'
export type { OpenAIProviderConfig } from './voiceover/providers/openai.js'
export type { PollyProviderConfig } from './voiceover/providers/polly.js'
```

Remove the duplicate `ElevenLabsProvider` export line if it already exists below; the replacement above should be the single source.

- [ ] **Step 2: Add CHANGELOG entry**

Prepend the following block under the top-most heading of `CHANGELOG.md`:

```markdown
## 0.15.0

### Breaking changes

- **ElevenLabs provider:** `ElevenLabsProviderConfig.voiceId` renamed to `voice`; `modelId` renamed to `model`. Migrate: `ElevenLabsProvider({ voiceId: 'abc', modelId: 'xyz' })` → `ElevenLabsProvider({ voice: 'abc', model: 'xyz' })`.

### Features

- **Unified TTS provider config:** All three providers (ElevenLabs, OpenAI, Polly) now share the same common field names (`voice`, `model`, `languageCode`) and consistently merge factory-config defaults with per-call `TtsOptions`. Provider-specific knobs (ElevenLabs `voiceSettings`, OpenAI `instructions`, Polly `engine`/`textType`) remain in the provider's own config.
- **ElevenLabs `voiceSettings`:** Optional `{ stability, similarityBoost, style, useSpeakerBoost }` can be passed in the factory config. Recommended for consistent loudness (raise `stability` to reduce per-segment volume drift).
- **Loudness normalization in `.voiceover(...)`:** New `VoiceoverOptions.normalize` runs each synthesized segment through a two-pass EBU R128 `loudnorm` pass (default `-16 LUFS` / `-1 dBFS TP` / `11 LU`, linear mode) before concat. Fixes large per-segment loudness drift common with ElevenLabs multilingual voices.

  ```ts
  .voiceover(ElevenLabsProvider({ voice: 'abc' }), { normalize: true })
  .voiceover(provider, { normalize: { targetLufs: -18, truePeakDb: -1.5 } })
  ```

- **`normalizeLoudness(input, output, config?)`** exported from the public API for standalone use.
```

- [ ] **Step 3: Typecheck + full test run**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: PASS — `tsc` emits to `dist/` with no errors.

- [ ] **Step 5: Bump version**

Edit `package.json`: `"version": "0.14.0"` → `"version": "0.15.0"`.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts CHANGELOG.md package.json
git commit -m "release: v0.15.0 — unified TTS config + loudness normalization"
```

---

## Task 10: Propagate to `cdx-daemon` demo consumer

**Cross-repo:** Steps here operate in a different working directory. All paths are absolute. Commits land in `~/Work/cdx-daemon`, not in this plan's repo.

**Prerequisite:** The new `playwright-recast` 0.15.0 is available (either published to the registry, or linked locally via `npm link` / `bun link` / `file:` dependency). If published, Task 10 upgrades the dep normally. If not yet published, Step 1 below uses a local file path.

**Files:**
- Modify: `/Users/thepatriczek/Work/cdx-daemon/frontend/apps/demo/package.json`
- Modify: `/Users/thepatriczek/Work/cdx-daemon/frontend/apps/demo/utils/recast-pipeline.ts`

- [ ] **Step 1: Bump the `playwright-recast` dependency**

In `/Users/thepatriczek/Work/cdx-daemon/frontend/apps/demo/package.json`, change the `playwright-recast` version.

Find:
```json
"playwright-recast": "^0.12.0",
```
Replace with:
```json
"playwright-recast": "^0.15.0",
```

(If 0.15.0 isn't published yet, temporarily use `"file:/Users/thepatriczek/Work/playwright-recast"` instead; revert once published.)

Run: `cd /Users/thepatriczek/Work/cdx-daemon/frontend/apps/demo && bun install`
Expected: no errors; the new version resolves.

- [ ] **Step 2: Rename ElevenLabs fields and add `voiceSettings`**

In `/Users/thepatriczek/Work/cdx-daemon/frontend/apps/demo/utils/recast-pipeline.ts`, update the provider factory.

Find:
```typescript
    case 'elevenlabs':
    default:
      return ElevenLabsProvider({
        voiceId: args.voice || '3HdFueVb2f3yUQzeEpyz',
        modelId: args.model || 'eleven_multilingual_v2',
        languageCode: 'cs',
      })
```
Replace with:
```typescript
    case 'elevenlabs':
    default:
      return ElevenLabsProvider({
        voice: args.voice || '3HdFueVb2f3yUQzeEpyz',
        model: args.model || 'eleven_multilingual_v2',
        languageCode: 'cs',
        // Higher stability reduces the per-segment loudness drift seen on
        // multilingual_v2 + czech. Combined with Task 3 post-normalization
        // below, it keeps the final voiceover level-consistent.
        voiceSettings: { stability: 0.75, similarityBoost: 0.75 },
      })
```

- [ ] **Step 3: Enable loudness normalization on the cached voiceover call**

Find:
```typescript
    pipeline = pipeline.voiceover(cachedProvider)
```
Replace with:
```typescript
    pipeline = pipeline.voiceover(cachedProvider, { normalize: true })
```

- [ ] **Step 4: Typecheck the demo app**

Run: `cd /Users/thepatriczek/Work/cdx-daemon/frontend/apps/demo && bun run tsc --noEmit`
Expected: PASS (no type errors — the field rename and the new options argument are both well-typed).

- [ ] **Step 5: Sanity-run the pipeline on cached TTS (skip regeneration)**

The cached `raw-*.mp3` from previous runs live in `test-results/<run>/.recast-tts-cache/`. The pipeline reuses them when present, so normalization runs on the existing cache — no ElevenLabs API calls, no cost.

Run: `cd /Users/thepatriczek/Work/cdx-daemon/frontend/apps/demo && bun run recast -- --no-speed --no-zoom`
Expected: pipeline completes; output `.mp4` plays back with level-consistent voiceover across all segments (previously problematic segments like `raw-6` now match the rest).

Quick acceptance measure (ffmpeg must be on PATH):
```bash
VO=$(find /Users/thepatriczek/Work/cdx-daemon/frontend/apps/demo/test-results -name "voiceover.mp3" -path "*/.recast-vo-tmp/*" | head -1)
ffmpeg -hide_banner -nostats -i "$VO" -af ebur128=peak=true -f null - 2>&1 | awk '/Integrated loudness:/,/True peak:/'
```
Expected: `I:` near `-16 LUFS`, `Peak:` near `-1 dBFS`.

- [ ] **Step 6: Commit**

```bash
cd /Users/thepatriczek/Work/cdx-daemon
git add frontend/apps/demo/package.json frontend/apps/demo/utils/recast-pipeline.ts bun.lockb 2>/dev/null || true
git add frontend/apps/demo/package.json frontend/apps/demo/utils/recast-pipeline.ts package-lock.json 2>/dev/null || true
git commit -m "chore(demo): upgrade playwright-recast to 0.15.0, enable voiceover normalization

- Rename ElevenLabs config fields: voiceId→voice, modelId→model.
- Add voiceSettings.stability=0.75 to reduce per-segment loudness drift.
- Enable { normalize: true } on .voiceover() for post-synthesis level matching."
```
