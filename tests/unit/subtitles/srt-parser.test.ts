import { describe, it, expect } from 'vitest'
import { parseSrt } from '../../../src/subtitles/srt-parser'

describe('parseSrt', () => {
  it('parses valid SRT with multiple entries', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:04,500',
      'First subtitle line',
      '',
      '2',
      '00:00:05,200 --> 00:00:08,900',
      'Second subtitle line',
    ].join('\n')

    const entries = parseSrt(srt)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({
      index: 1,
      startMs: 1000,
      endMs: 4500,
      text: 'First subtitle line',
    })
    expect(entries[1]).toEqual({
      index: 2,
      startMs: 5200,
      endMs: 8900,
      text: 'Second subtitle line',
    })
  })

  it('parses SRT with hours', () => {
    const srt = [
      '1',
      '01:02:03,456 --> 02:30:00,000',
      'Over an hour in',
    ].join('\n')

    const entries = parseSrt(srt)

    expect(entries).toHaveLength(1)
    // 1*3600000 + 2*60000 + 3*1000 + 456 = 3723456
    expect(entries[0]!.startMs).toBe(3723456)
    // 2*3600000 + 30*60000 + 0 + 0 = 9000000
    expect(entries[0]!.endMs).toBe(9000000)
    expect(entries[0]!.text).toBe('Over an hour in')
  })

  it('handles empty input', () => {
    expect(parseSrt('')).toEqual([])
    expect(parseSrt('   ')).toEqual([])
    expect(parseSrt('\n\n')).toEqual([])
  })

  it('handles malformed time codes gracefully', () => {
    const srt = [
      '1',
      'not-a-time --> also-bad',
      'Some text',
    ].join('\n')

    const entries = parseSrt(srt)

    // Should still parse (though times will be NaN-based or 0)
    expect(entries).toHaveLength(1)
    expect(entries[0]!.text).toBe('Some text')
    // parseSrtTime will produce NaN for completely invalid parts
    expect(typeof entries[0]!.startMs).toBe('number')
  })

  it('preserves multiline text', () => {
    const srt = [
      '1',
      '00:00:00,000 --> 00:00:05,000',
      'Line one',
      'Line two',
      'Line three',
    ].join('\n')

    const entries = parseSrt(srt)

    expect(entries).toHaveLength(1)
    expect(entries[0]!.text).toBe('Line one\nLine two\nLine three')
  })

  it('handles entries separated by multiple blank lines', () => {
    const srt = [
      '1',
      '00:00:00,000 --> 00:00:02,000',
      'First',
      '',
      '',
      '',
      '2',
      '00:00:03,000 --> 00:00:05,000',
      'Second',
    ].join('\n')

    const entries = parseSrt(srt)

    expect(entries).toHaveLength(2)
    expect(entries[0]!.text).toBe('First')
    expect(entries[1]!.text).toBe('Second')
  })

  it('parses SRT with zero milliseconds', () => {
    const srt = [
      '1',
      '00:00:00,000 --> 00:00:10,000',
      'Ten seconds',
    ].join('\n')

    const entries = parseSrt(srt)

    expect(entries[0]!.startMs).toBe(0)
    expect(entries[0]!.endMs).toBe(10000)
  })
})
