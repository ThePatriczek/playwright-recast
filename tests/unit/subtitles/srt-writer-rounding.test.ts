import { describe, it, expect } from 'vitest'
import { writeSrt } from '../../../src/subtitles/srt-writer'
import type { SubtitleEntry } from '../../../src/types/subtitle'

describe('SRT Writer — fractional millisecond rounding', () => {
  it('rounds fractional ms down when below .5', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 1000.3, endMs: 2000.1, text: 'Test' },
    ]
    const srt = writeSrt(entries)
    // 1000.3 rounds to 1000 → 00:00:01,000
    // 2000.1 rounds to 2000 → 00:00:02,000
    expect(srt).toContain('00:00:01,000 --> 00:00:02,000')
  })

  it('rounds fractional ms up when at or above .5', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 1000.5, endMs: 2000.9, text: 'Test' },
    ]
    const srt = writeSrt(entries)
    // 1000.5 rounds to 1001 → 00:00:01,001
    // 2000.9 rounds to 2001 → 00:00:02,001
    expect(srt).toContain('00:00:01,001 --> 00:00:02,001')
  })

  it('handles sub-millisecond values near zero', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 0.4, endMs: 999.6, text: 'Test' },
    ]
    const srt = writeSrt(entries)
    // 0.4 rounds to 0 → 00:00:00,000
    // 999.6 rounds to 1000 → 00:00:01,000
    expect(srt).toContain('00:00:00,000 --> 00:00:01,000')
  })

  it('rounds fractional ms that change the seconds boundary', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 59999.7, endMs: 60000.3, text: 'Boundary' },
    ]
    const srt = writeSrt(entries)
    // 59999.7 rounds to 60000 → 00:01:00,000
    // 60000.3 rounds to 60000 → 00:01:00,000
    expect(srt).toContain('00:01:00,000 --> 00:01:00,000')
  })

  it('produces correct ms digits after rounding', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 1234.4999, endMs: 5678.5001, text: 'Precise' },
    ]
    const srt = writeSrt(entries)
    // 1234.4999 rounds to 1234 → 00:00:01,234
    // 5678.5001 rounds to 5679 → 00:00:05,679
    expect(srt).toContain('00:00:01,234 --> 00:00:05,679')
  })

  it('handles negative fractional part gracefully (Math.round behavior)', () => {
    // This tests that the implementation does not break with values
    // that are very close to a whole number
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 3000 - 0.0001, endMs: 4000 + 0.0001, text: 'Near-integer' },
    ]
    const srt = writeSrt(entries)
    // Both should round to their nearest integer
    expect(srt).toContain('00:00:03,000 --> 00:00:04,000')
  })
})
