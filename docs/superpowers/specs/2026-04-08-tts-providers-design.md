# TTS Providers Expansion Design

**Date:** 2026-04-08
**Status:** Draft

## Context

playwright-recast currently supports two TTS providers: OpenAI and ElevenLabs. Users need more options: Google Gemini (must-have), free providers (Edge TTS), cloud alternatives (Google Cloud, Amazon Polly), local/offline (Kokoro), and a custom escape hatch for any backend.

The existing `TtsProvider` interface is well-designed and all new providers will follow the established factory function pattern with lazy-loaded peer dependencies.

## Scope

Add 6 new TTS providers in a single release:

1. **GeminiProvider** — Google Gemini 2.5 TTS (MUST)
2. **EdgeTtsProvider** — Free Microsoft Edge TTS (no API key)
3. **GoogleCloudTtsProvider** — Google Cloud Text-to-Speech
4. **AmazonPollyProvider** — AWS Polly
5. **KokoroProvider** — Local offline TTS (82M param ONNX model)
6. **CustomProvider** — User-defined synthesize function

## Architecture

### Existing Interface (unchanged)

```typescript
// src/types/voiceover.ts — NO CHANGES
export interface TtsProvider {
  readonly name: string
  synthesize(text: string, options?: TtsOptions): Promise<AudioSegment>
  estimateDurationMs(text: string, options?: TtsOptions): number
  isAvailable(): Promise<boolean>
  dispose(): Promise<void>
}
```

### File Structure

```
src/voiceover/providers/
  openai.ts          (existing)
  elevenlabs.ts      (existing)
  gemini.ts          NEW
  edge-tts.ts        NEW
  google-cloud.ts    NEW
  amazon-polly.ts    NEW
  kokoro.ts          NEW
  custom.ts          NEW
```

All new providers exported from `src/index.ts`.

---

## Provider Specifications

### 1. GeminiProvider

**SDK:** `@google/genai` (peer dependency)
**Models:** `gemini-2.5-flash-preview-tts` (default), `gemini-2.5-pro-preview-tts`

```typescript
export interface GeminiProviderConfig {
  apiKey?: string          // GOOGLE_API_KEY or GEMINI_API_KEY env
  voice?: string           // Default: 'Kore'
  model?: string           // Default: 'gemini-2.5-flash-preview-tts'
  speed?: number           // Speech rate multiplier, default: 1.0
}

export function GeminiProvider(config?: GeminiProviderConfig): TtsProvider
```

**Implementation notes:**
- Lazy import `@google/genai`
- API key from `config.apiKey` ?? `process.env.GOOGLE_API_KEY` ?? `process.env.GEMINI_API_KEY`
- Call `generateContent` with `responseModalities: ['AUDIO']` and `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`
- Output is PCM 24000Hz (audio/L16) — convert to MP3 via ffmpeg before returning AudioSegment
- Conversion: write PCM to temp file, run `ffmpeg -f s16le -ar 24000 -ac 1 -i input.pcm -codec:a libmp3lame output.mp3`
- Return AudioSegment with `{ sampleRate: 24000, channels: 1, codec: 'mp3' }`

**Available voices:** Aoede, Charon, Fenrir, Kore, Puck (and more per Google docs)

---

### 2. EdgeTtsProvider

**SDK:** `@andresaya/edge-tts` (peer dependency)
**No API key required.**

```typescript
export interface EdgeTtsProviderConfig {
  voice?: string           // Default: 'en-US-AriaNeural'
  rate?: string            // Speed adjustment, e.g. '+20%', '-10%'
  pitch?: string           // Pitch adjustment, e.g. '+5Hz'
  volume?: string          // Volume adjustment, e.g. '+10%'
}

export function EdgeTtsProvider(config?: EdgeTtsProviderConfig): TtsProvider
```

**Implementation notes:**
- Lazy import `@andresaya/edge-tts`
- Create EdgeTTS instance, call synthesize method
- Output is MP3 directly
- Return AudioSegment with `{ sampleRate: 24000, channels: 1, codec: 'mp3' }`
- `isAvailable()` always returns `true` (no key needed)

**Caveat:** Unofficial API — uses Microsoft Edge's public endpoint. May break if Microsoft changes their API. Document this in the provider docs page.

---

### 3. GoogleCloudTtsProvider

**SDK:** `@google-cloud/text-to-speech` (peer dependency)

```typescript
export interface GoogleCloudTtsProviderConfig {
  credentials?: string     // Path to service account JSON, or GOOGLE_APPLICATION_CREDENTIALS env
  voice?: string           // Default: 'en-US-Neural2-F'
  languageCode?: string    // Default: 'en-US'
  speakingRate?: number    // 0.25 to 4.0, default: 1.0
  pitch?: number           // -20.0 to 20.0 semitones, default: 0
}

export function GoogleCloudTtsProvider(config?: GoogleCloudTtsProviderConfig): TtsProvider
```

**Implementation notes:**
- Lazy import `@google-cloud/text-to-speech`
- Create TextToSpeechClient with credentials
- Call `synthesizeSpeech` with `audioConfig: { audioEncoding: 'MP3', sampleRateHertz: 24000 }`
- Response contains `audioContent` as Buffer
- Return AudioSegment with `{ sampleRate: 24000, channels: 1, codec: 'mp3' }`
- `isAvailable()` checks `config.credentials` or `process.env.GOOGLE_APPLICATION_CREDENTIALS`

---

### 4. AmazonPollyProvider

**SDK:** `@aws-sdk/client-polly` (peer dependency)

```typescript
export interface AmazonPollyProviderConfig {
  region?: string          // Default: 'us-east-1', or AWS_REGION env
  credentials?: {          // Or standard AWS credential chain
    accessKeyId: string
    secretAccessKey: string
  }
  voice?: string           // Default: 'Joanna'
  engine?: 'neural' | 'standard' | 'long-form' | 'generative'  // Default: 'neural'
}

export function AmazonPollyProvider(config?: AmazonPollyProviderConfig): TtsProvider
```

**Implementation notes:**
- Lazy import `@aws-sdk/client-polly`
- Create PollyClient with region and optional credentials
- Call `SynthesizeSpeechCommand` with `OutputFormat: 'mp3'`, `SampleRate: '24000'`
- Response `AudioStream` is a Readable — collect into Buffer
- Return AudioSegment with `{ sampleRate: 24000, channels: 1, codec: 'mp3' }`
- `isAvailable()` checks for AWS credentials (env vars or explicit config)

---

### 5. KokoroProvider (local/offline)

**SDK:** `kokoro-js` (peer dependency)

```typescript
export interface KokoroProviderConfig {
  voice?: string           // Default: 'af_heart'
  dtype?: 'fp32' | 'fp16' | 'q8' | 'q4' | 'q4f16'  // Default: 'q8'
  device?: 'auto' | 'wasm' // Default: 'auto'
}

export function KokoroProvider(config?: KokoroProviderConfig): TtsProvider
```

**Implementation notes:**
- Lazy import `kokoro-js`
- Model downloads automatically on first use (~100MB for q8)
- Kokoro outputs WAV/PCM audio — convert to MP3 via ffmpeg
- Conversion: pipe WAV buffer through `ffmpeg -i pipe:0 -codec:a libmp3lame -f mp3 pipe:1`
- Return AudioSegment with `{ sampleRate: 24000, channels: 1, codec: 'mp3' }`
- `isAvailable()` always returns `true` (no key needed)
- `dispose()` releases the ONNX session to free memory
- Keep model instance alive between calls (lazy init, dispose on `.dispose()`)

**Note:** First call is slow (~5-10s) due to model download. Subsequent calls are fast.

---

### 6. CustomProvider (escape hatch)

```typescript
export interface CustomProviderConfig {
  /** The synthesis function — takes text, returns audio buffer */
  synthesize: (text: string, options?: TtsOptions) => Promise<Buffer>
  /** Provider name for logging */
  name?: string            // Default: 'custom'
  /** Audio format metadata */
  format?: {
    sampleRate?: number    // Default: 44100
    channels?: number      // Default: 1
    codec?: string         // Default: 'mp3'
  }
  /** Optional duration estimator */
  estimateDurationMs?: (text: string, options?: TtsOptions) => number
  /** Optional availability check */
  isAvailable?: () => Promise<boolean>
  /** Optional cleanup */
  dispose?: () => Promise<void>
}

export function CustomProvider(config: CustomProviderConfig): TtsProvider
```

**Implementation notes:**
- No lazy imports — user provides everything
- Default `estimateDurationMs`: word-count heuristic `(words / 150) * 60_000`
- Default `isAvailable`: `() => true`
- Default `dispose`: noop
- Wraps user's `synthesize` fn, setting `durationMs: 0` (measured by voiceover-processor via ffprobe)

**Usage examples:**
```typescript
// Self-hosted Piper server
.voiceover(CustomProvider({
  name: 'piper',
  synthesize: async (text) => {
    const res = await fetch('http://localhost:5000/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: 'en_US-lessac-medium' }),
    })
    return Buffer.from(await res.arrayBuffer())
  },
  format: { sampleRate: 22050, channels: 1, codec: 'wav' },
}))

// Ollama LLM → local TTS pipeline
.voiceover(CustomProvider({
  name: 'ollama-piper',
  synthesize: async (text) => {
    // Optionally rewrite text via Ollama first
    const rewritten = await ollamaRewrite(text)
    // Then synthesize via local TTS
    return await localTts(rewritten)
  },
}))
```

---

## Peer Dependencies

```json
{
  "peerDependencies": {
    "openai": ">=4.0.0",
    "@elevenlabs/elevenlabs-js": ">=1.0.0",
    "@google/genai": ">=1.0.0",
    "@andresaya/edge-tts": ">=1.0.0",
    "@google-cloud/text-to-speech": ">=5.0.0",
    "@aws-sdk/client-polly": ">=3.0.0",
    "kokoro-js": ">=1.0.0"
  },
  "peerDependenciesMeta": {
    "openai": { "optional": true },
    "@elevenlabs/elevenlabs-js": { "optional": true },
    "@google/genai": { "optional": true },
    "@andresaya/edge-tts": { "optional": true },
    "@google-cloud/text-to-speech": { "optional": true },
    "@aws-sdk/client-polly": { "optional": true },
    "kokoro-js": { "optional": true }
  }
}
```

## Exports (src/index.ts additions)

```typescript
export { GeminiProvider } from './voiceover/providers/gemini.js'
export { EdgeTtsProvider } from './voiceover/providers/edge-tts.js'
export { GoogleCloudTtsProvider } from './voiceover/providers/google-cloud.js'
export { AmazonPollyProvider } from './voiceover/providers/amazon-polly.js'
export { KokoroProvider } from './voiceover/providers/kokoro.js'
export { CustomProvider } from './voiceover/providers/custom.js'
```

## Documentation

New docs pages in `website/content/docs/providers/`:

| File | Provider |
|------|----------|
| `gemini.mdx` | Gemini TTS setup, voices, config |
| `edge-tts.mdx` | Edge TTS setup, voices, caveats |
| `google-cloud.mdx` | Google Cloud TTS setup, credentials |
| `amazon-polly.mdx` | Amazon Polly setup, engines, voices |
| `kokoro.mdx` | Kokoro local TTS setup, model options |
| `custom.mdx` | Custom provider guide with examples |

Update existing:
- `website/content/docs/providers/meta.json` — add sidebar entries
- `website/public/llms.txt` — add provider links
- `website/public/llms-full.txt` — regenerate with new content

## Implementation Order

1. `custom.ts` — simplest, no SDK, validates the pattern
2. `gemini.ts` — highest priority
3. `edge-tts.ts` — free, high user value
4. `google-cloud.ts` — enterprise
5. `amazon-polly.ts` — enterprise
6. `kokoro.ts` — local, most complex (model management)
7. Update `src/index.ts` exports
8. Update `package.json` peer dependencies
9. Write all 6 docs pages
10. Update llms.txt files

## Testing

Each provider should have a unit test that:
- Verifies config defaults
- Verifies `isAvailable()` logic (key presence)
- Mocks the SDK call and verifies correct parameters
- Verifies AudioSegment format metadata

Integration testing (manual):
- Install each SDK, configure credentials, run a full pipeline with each provider
- Verify audio output plays correctly
- Verify voiceover timing synchronization works

## Verification

1. `npm run build` passes (TypeScript compiles)
2. `npm test` passes (unit tests)
3. Manual test: `Recast.from(trace).parse().subtitlesFromTrace().voiceover(GeminiProvider()).render().toFile('test.mp4')` produces valid video with audio
4. Docs build: `cd website && npm run build` succeeds
5. Each provider docs page renders correctly
