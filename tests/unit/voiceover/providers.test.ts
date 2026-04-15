import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ElevenLabsProvider } from '../../../src/voiceover/providers/elevenlabs'
import { OpenAIProvider } from '../../../src/voiceover/providers/openai'
import { PollyProvider } from '../../../src/voiceover/providers/polly'

// vi.mock is hoisted — use vi.hoisted() so the mock functions exist when the
// factory runs, and use `class` for constructable mocks (arrow functions are
// not constructable and `new ArrowFn()` throws "is not a constructor").
const mocks = vi.hoisted(() => ({
  convertMock: vi.fn(),
  openaiCreateMock: vi.fn(),
  pollySendMock: vi.fn(),
  pollyCommandCtor: vi.fn((input: Record<string, unknown>) => ({ input })),
}))

vi.mock('@elevenlabs/elevenlabs-js', () => ({
  ElevenLabsClient: class {
    textToSpeech = { convert: mocks.convertMock }
  },
}))

vi.mock('openai', () => ({
  default: class {
    audio = { speech: { create: mocks.openaiCreateMock } }
  },
}))

vi.mock('@aws-sdk/client-polly', () => ({
  PollyClient: class {
    send = mocks.pollySendMock
  },
  SynthesizeSpeechCommand: mocks.pollyCommandCtor,
}))

function makeStream(bytes: Uint8Array): { getReader: () => unknown } {
  let done = false
  return {
    getReader: () => ({
      read: async () => (done ? { done: true, value: undefined } : ((done = true), { done: false, value: bytes })),
    }),
  }
}

// --- ElevenLabs -----------------------------------------------------------

describe('ElevenLabsProvider', () => {
  beforeEach(() => {
    mocks.convertMock.mockReset()
    mocks.convertMock.mockResolvedValue(makeStream(new Uint8Array([1, 2, 3])))
  })

  it('sends voice, model and languageCode from factory config', async () => {
    const p = ElevenLabsProvider({
      apiKey: 'k', voice: 'v1', model: 'm1', languageCode: 'cs',
    })
    await p.synthesize('hello')
    expect(mocks.convertMock).toHaveBeenCalledWith('v1', expect.objectContaining({
      text: 'hello', modelId: 'm1', languageCode: 'cs', outputFormat: 'mp3_44100_128',
    }))
  })

  it('options override factory config per call', async () => {
    const p = ElevenLabsProvider({ apiKey: 'k', voice: 'v1', model: 'm1', languageCode: 'cs' })
    await p.synthesize('hello', { voice: 'v2', model: 'm2', languageCode: 'en' })
    expect(mocks.convertMock).toHaveBeenCalledWith('v2', expect.objectContaining({
      modelId: 'm2', languageCode: 'en',
    }))
  })

  it('passes voiceSettings to the API call when provided', async () => {
    const p = ElevenLabsProvider({
      apiKey: 'k',
      voiceSettings: { stability: 0.75, similarityBoost: 0.8, style: 0.1, useSpeakerBoost: true },
    })
    await p.synthesize('x')
    expect(mocks.convertMock).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      voiceSettings: { stability: 0.75, similarityBoost: 0.8, style: 0.1, useSpeakerBoost: true },
    }))
  })

  it('omits voiceSettings when not provided', async () => {
    const p = ElevenLabsProvider({ apiKey: 'k' })
    await p.synthesize('x')
    const args = mocks.convertMock.mock.calls[0]![1] as Record<string, unknown>
    expect(args).not.toHaveProperty('voiceSettings')
  })
})

// --- OpenAI ---------------------------------------------------------------

describe('OpenAIProvider', () => {
  beforeEach(() => {
    mocks.openaiCreateMock.mockReset()
    mocks.openaiCreateMock.mockResolvedValue({ arrayBuffer: async () => new ArrayBuffer(3) })
  })

  it('sends voice, model, and speed from factory config', async () => {
    const p = OpenAIProvider({ apiKey: 'k', voice: 'nova', model: 'tts-1', speed: 1.1 })
    await p.synthesize('hi')
    expect(mocks.openaiCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      voice: 'nova', model: 'tts-1', speed: 1.1, input: 'hi', response_format: 'mp3',
    }))
  })

  it('options override factory config per call', async () => {
    const p = OpenAIProvider({ apiKey: 'k', voice: 'nova', model: 'tts-1', speed: 1.1 })
    await p.synthesize('hi', { voice: 'echo', model: 'tts-2', speed: 0.9 })
    expect(mocks.openaiCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      voice: 'echo', model: 'tts-2', speed: 0.9,
    }))
  })

  it('adds instructions from factory config when provided', async () => {
    const p = OpenAIProvider({ apiKey: 'k', instructions: 'be calm' })
    await p.synthesize('x')
    expect(mocks.openaiCreateMock).toHaveBeenCalledWith(expect.objectContaining({ instructions: 'be calm' }))
  })

  it('omits instructions when not provided', async () => {
    const p = OpenAIProvider({ apiKey: 'k' })
    await p.synthesize('x')
    const args = mocks.openaiCreateMock.mock.calls[0]![0] as Record<string, unknown>
    expect(args).not.toHaveProperty('instructions')
  })
})

// --- Polly ---------------------------------------------------------------

describe('PollyProvider', () => {
  beforeEach(() => {
    mocks.pollySendMock.mockReset()
    mocks.pollyCommandCtor.mockClear()
    mocks.pollySendMock.mockResolvedValue({
      AudioStream: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) },
    })
  })

  it('sends voice, engine, and languageCode from factory config', async () => {
    const p = PollyProvider({
      region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 's',
      voice: 'Joanna', engine: 'neural', languageCode: 'en-US',
    })
    await p.synthesize('hi')
    expect(mocks.pollyCommandCtor).toHaveBeenCalledWith(expect.objectContaining({
      Text: 'hi', VoiceId: 'Joanna', Engine: 'neural', LanguageCode: 'en-US',
    }))
  })

  it('voice and languageCode options override config per call', async () => {
    const p = PollyProvider({
      region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 's',
      voice: 'Joanna', languageCode: 'en-US',
    })
    await p.synthesize('hi', { voice: 'Matthew', languageCode: 'en-GB' })
    expect(mocks.pollyCommandCtor).toHaveBeenCalledWith(expect.objectContaining({
      VoiceId: 'Matthew', LanguageCode: 'en-GB',
    }))
  })

  it('throws when Polly returns no AudioStream', async () => {
    mocks.pollySendMock.mockResolvedValueOnce({})
    const p = PollyProvider({ region: 'us-east-1', accessKeyId: 'a', secretAccessKey: 's' })
    await expect(p.synthesize('x')).rejects.toThrow(/no audio stream/i)
  })
})
