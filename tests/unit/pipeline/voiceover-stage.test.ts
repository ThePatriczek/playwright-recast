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
