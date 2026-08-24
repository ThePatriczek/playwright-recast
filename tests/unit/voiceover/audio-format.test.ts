import { describe, it, expect } from 'vitest'
import { planAudioConcat, type AudioFormat } from '../../../src/voiceover/audio-format'

const f = (sampleRate: number, channels: number): AudioFormat => ({ sampleRate, channels })

describe('planAudioConcat', () => {
  it('keeps stream copy when every segment agrees', () => {
    // The common case: -c copy stays bit-identical to today's behaviour.
    expect(planAudioConcat([f(24000, 1), f(24000, 1), f(24000, 1)]))
      .toEqual({ normalise: false })
  })

  it('keeps stream copy for a single segment', () => {
    expect(planAudioConcat([f(48000, 2)])).toEqual({ normalise: false })
  })

  it('keeps stream copy for an empty list', () => {
    expect(planAudioConcat([])).toEqual({ normalise: false })
  })

  it('normalises to the majority format when sample rates disagree', () => {
    expect(planAudioConcat([f(24000, 1), f(44100, 1), f(24000, 1)]))
      .toEqual({ normalise: true, sampleRate: 24000, channels: 1 })
  })

  it('normalises when channel layouts disagree', () => {
    expect(planAudioConcat([f(24000, 1), f(24000, 2), f(24000, 1)]))
      .toEqual({ normalise: true, sampleRate: 24000, channels: 1 })
  })

  it('falls back to 44.1kHz mono when there is no majority', () => {
    expect(planAudioConcat([f(24000, 1), f(48000, 2)]))
      .toEqual({ normalise: true, sampleRate: 44100, channels: 1 })
  })

  it('normalises when any probe failed', () => {
    // Cannot prove they agree, so take the safe branch.
    const r = planAudioConcat([f(24000, 1), null, f(24000, 1)])
    expect(r.normalise).toBe(true)
  })
})
