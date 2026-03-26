import { describe, it, expect } from 'vitest'
import { writeVtt } from '../../../src/subtitles/vtt-writer'
import type { SubtitleEntry } from '../../../src/types/subtitle'

describe('VTT Writer — fractional millisecond rounding', () => {
  it('rounds fractional ms down when below .5', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 1000.3, endMs: 2000.1, text: 'Test' },
    ]
    const vtt = writeVtt(entries)
    // 1000.3 rounds to 1000 → 00:00:01.000
    // 2000.1 rounds to 2000 → 00:00:02.000
    expect(vtt).toContain('00:00:01.000 --> 00:00:02.000')
  })

  it('rounds fractional ms up when at or above .5', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 1000.5, endMs: 2000.9, text: 'Test' },
    ]
    const vtt = writeVtt(entries)
    // 1000.5 rounds to 1001 → 00:00:01.001
    // 2000.9 rounds to 2001 → 00:00:02.001
    expect(vtt).toContain('00:00:01.001 --> 00:00:02.001')
  })

  it('handles sub-millisecond values near zero', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 0.4, endMs: 999.6, text: 'Test' },
    ]
    const vtt = writeVtt(entries)
    // 0.4 rounds to 0 → 00:00:00.000
    // 999.6 rounds to 1000 → 00:00:01.000
    expect(vtt).toContain('00:00:00.000 --> 00:00:01.000')
  })

  it('rounds fractional ms that change the seconds boundary', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 59999.7, endMs: 60000.3, text: 'Boundary' },
    ]
    const vtt = writeVtt(entries)
    // 59999.7 rounds to 60000 → 00:01:00.000
    // 60000.3 rounds to 60000 → 00:01:00.000
    expect(vtt).toContain('00:01:00.000 --> 00:01:00.000')
  })

  it('produces correct ms digits after rounding', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 1234.4999, endMs: 5678.5001, text: 'Precise' },
    ]
    const vtt = writeVtt(entries)
    // 1234.4999 rounds to 1234 → 00:00:01.234
    // 5678.5001 rounds to 5679 → 00:00:05.679
    expect(vtt).toContain('00:00:01.234 --> 00:00:05.679')
  })

  it('uses dot separator (not comma) with rounded values', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 500.7, endMs: 1500.3, text: 'Dot check' },
    ]
    const vtt = writeVtt(entries)
    // VTT uses dot, SRT uses comma
    expect(vtt).toContain('00:00:00.501 --> 00:00:01.500')
    expect(vtt).not.toContain(',')
  })
})
