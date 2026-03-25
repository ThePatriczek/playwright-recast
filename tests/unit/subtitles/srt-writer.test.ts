import { describe, it, expect } from 'vitest'
import { writeSrt } from '../../../src/subtitles/srt-writer'
import type { SubtitleEntry } from '../../../src/types/subtitle'

describe('SRT Writer', () => {
  it('writes a single subtitle entry', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 0, endMs: 3200, text: 'Hello world' },
    ]
    const srt = writeSrt(entries)
    expect(srt).toBe('1\n00:00:00,000 --> 00:00:03,200\nHello world\n')
  })

  it('writes multiple entries separated by blank lines', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 0, endMs: 3200, text: 'First subtitle' },
      { index: 2, startMs: 3200, endMs: 7500, text: 'Second subtitle' },
    ]
    const srt = writeSrt(entries)
    expect(srt).toBe(
      '1\n00:00:00,000 --> 00:00:03,200\nFirst subtitle\n\n' +
        '2\n00:00:03,200 --> 00:00:07,500\nSecond subtitle\n',
    )
  })

  it('formats hours correctly', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 3661234, endMs: 3665000, text: 'Over an hour in' },
    ]
    const srt = writeSrt(entries)
    expect(srt).toContain('01:01:01,234 --> 01:01:05,000')
  })

  it('handles zero-duration entries', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 1000, endMs: 1000, text: 'Instant' },
    ]
    const srt = writeSrt(entries)
    expect(srt).toContain('00:00:01,000 --> 00:00:01,000')
  })

  it('returns empty string for empty entries', () => {
    expect(writeSrt([])).toBe('')
  })

  it('preserves Czech characters', () => {
    const entries: SubtitleEntry[] = [
      {
        index: 1,
        startMs: 0,
        endMs: 4000,
        text: 'Otevřeme nastavení marketplace, kde můžeme přidávat pluginy.',
      },
    ]
    const srt = writeSrt(entries)
    expect(srt).toContain('Otevřeme nastavení marketplace')
  })
})
