import { describe, it, expect } from 'vitest'
import { writeVtt } from '../../../src/subtitles/vtt-writer'
import type { SubtitleEntry } from '../../../src/types/subtitle'

describe('VTT Writer', () => {
  it('starts with WEBVTT header', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 0, endMs: 3200, text: 'Hello' },
    ]
    expect(writeVtt(entries)).toMatch(/^WEBVTT\n/)
  })

  it('uses dot as millisecond separator (not comma like SRT)', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 1234, endMs: 5678, text: 'Test' },
    ]
    const vtt = writeVtt(entries)
    expect(vtt).toContain('00:00:01.234 --> 00:00:05.678')
  })

  it('writes multiple cues', () => {
    const entries: SubtitleEntry[] = [
      { index: 1, startMs: 0, endMs: 3000, text: 'First' },
      { index: 2, startMs: 3000, endMs: 6000, text: 'Second' },
    ]
    const vtt = writeVtt(entries)
    expect(vtt).toContain('1\n00:00:00.000 --> 00:00:03.000\nFirst')
    expect(vtt).toContain('2\n00:00:03.000 --> 00:00:06.000\nSecond')
  })

  it('returns just header for empty entries', () => {
    expect(writeVtt([])).toBe('WEBVTT\n')
  })
})
