import { describe, it, expect } from 'vitest'
import { planAudioConcat, type AudioFormat } from '../../../src/voiceover/audio-format'

const f = (sampleRate: number, channels: number): AudioFormat => ({ sampleRate, channels })

describe('planAudioConcat', () => {
  it('keeps the segments\' format when every segment agrees', () => {
    expect(planAudioConcat([f(24000, 1), f(24000, 1), f(24000, 1)]))
      .toEqual({ sampleRate: 24000, channels: 1, mismatch: false })
  })

  it('keeps the format of a single segment', () => {
    expect(planAudioConcat([f(48000, 2)])).toEqual({ sampleRate: 48000, channels: 2, mismatch: false })
  })

  it('has a format for an empty list', () => {
    expect(planAudioConcat([])).toEqual({ sampleRate: 44100, channels: 1, mismatch: false })
  })

  it('picks the majority format when sample rates disagree', () => {
    expect(planAudioConcat([f(24000, 1), f(44100, 1), f(24000, 1)]))
      .toEqual({ sampleRate: 24000, channels: 1, mismatch: true })
  })

  it('picks the majority format when channel layouts disagree', () => {
    expect(planAudioConcat([f(24000, 1), f(24000, 2), f(24000, 1)]))
      .toEqual({ sampleRate: 24000, channels: 1, mismatch: true })
  })

  it('falls back to 44.1kHz mono when there is no majority', () => {
    expect(planAudioConcat([f(24000, 1), f(48000, 2)]))
      .toEqual({ sampleRate: 44100, channels: 1, mismatch: true })
  })

  it('lets only the segments it could probe vote', () => {
    // Every segment is decoded to the plan format, so an unreadable header
    // must not resample the rest.
    expect(planAudioConcat([f(24000, 2), null, f(24000, 2)]))
      .toEqual({ sampleRate: 24000, channels: 2, mismatch: false })
  })

  it('falls back to 44.1kHz mono when no probe succeeded', () => {
    expect(planAudioConcat([null, null])).toEqual({ sampleRate: 44100, channels: 1, mismatch: false })
  })
})
