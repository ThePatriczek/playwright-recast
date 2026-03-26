import { describe, it, expect } from 'vitest'
import { writeAss, hexToAss } from '../../../src/subtitles/ass-writer.js'
import type { SubtitleEntry } from '../../../src/types/subtitle.js'

const entry = (overrides: Partial<SubtitleEntry> = {}): SubtitleEntry => ({
  index: 1,
  startMs: 0,
  endMs: 5000,
  text: 'Hello world',
  ...overrides,
})

describe('hexToAss', () => {
  it('converts black fully opaque', () => {
    expect(hexToAss('#000000', 1.0)).toBe('&H00000000')
  })

  it('converts white fully opaque', () => {
    expect(hexToAss('#FFFFFF', 1.0)).toBe('&H00FFFFFF')
  })

  it('converts white 50% opaque', () => {
    // 50% transparent → alpha = 128 = 0x80
    expect(hexToAss('#FFFFFF', 0.5)).toBe('&H80FFFFFF')
  })

  it('converts white fully transparent', () => {
    expect(hexToAss('#ffffff', 0.0)).toBe('&HFFFFFFFF')
  })

  it('reverses RGB to BGR', () => {
    // #FF0000 (red) → BGR = 0000FF
    expect(hexToAss('#FF0000', 1.0)).toBe('&H000000FF')
  })

  it('handles mixed colors', () => {
    // #1a2b3c → BGR = 3c2b1a
    expect(hexToAss('#1a2b3c', 1.0)).toBe('&H003C2B1A')
  })

  it('clamps opacity to 0-1 range', () => {
    expect(hexToAss('#FFFFFF', 1.5)).toBe('&H00FFFFFF')
    expect(hexToAss('#FFFFFF', -0.5)).toBe('&HFFFFFFFF')
  })
})

describe('writeAss', () => {
  it('returns empty string for no entries', () => {
    expect(writeAss([])).toBe('')
  })

  it('produces valid ASS structure', () => {
    const result = writeAss([entry()])
    expect(result).toContain('[Script Info]')
    expect(result).toContain('ScriptType: v4.00+')
    expect(result).toContain('[V4+ Styles]')
    expect(result).toContain('[Events]')
    expect(result).toContain('Dialogue:')
  })

  it('sets PlayResX and PlayResY from resolution', () => {
    const result = writeAss([entry()], {}, { width: 1920, height: 1080 })
    expect(result).toContain('PlayResX: 1920')
    expect(result).toContain('PlayResY: 1080')
  })

  it('uses custom resolution', () => {
    const result = writeAss([entry()], {}, { width: 2560, height: 1440 })
    expect(result).toContain('PlayResX: 2560')
    expect(result).toContain('PlayResY: 1440')
  })

  it('formats time as H:MM:SS.CC (centiseconds)', () => {
    const result = writeAss([entry({ startMs: 65550, endMs: 125990 })])
    // 65550ms = 1:05.55 → 0:01:05.55
    // 125990ms = 2:05.99 → 0:02:05.99
    expect(result).toContain('0:01:05.55')
    expect(result).toContain('0:02:05.99')
  })

  it('formats hours correctly', () => {
    const result = writeAss([entry({ startMs: 3661000 })])
    // 3661000ms = 1h 1m 1s
    expect(result).toContain('1:01:01.00')
  })

  it('uses BorderStyle=3 (opaque box) by default', () => {
    const result = writeAss([entry()])
    // BorderStyle is field 16 in style line
    expect(result).toMatch(/Style:.*,3,/) // BorderStyle=3
  })

  it('applies default style values', () => {
    const result = writeAss([entry()])
    expect(result).toContain('Arial') // default font
    expect(result).toContain(',52,') // default fontSize
  })

  it('applies custom font and size', () => {
    const result = writeAss([entry()], { fontFamily: 'Roboto', fontSize: 64 })
    expect(result).toContain('Roboto')
    expect(result).toContain(',64,')
  })

  it('applies bold by default', () => {
    const result = writeAss([entry()])
    // Bold=-1 in ASS means bold
    expect(result).toMatch(/,-1,0,0,0,100/) // Bold,Italic,Underline,StrikeOut,ScaleX
  })

  it('disables bold when explicitly false', () => {
    const result = writeAss([entry()], { bold: false })
    expect(result).toMatch(/,0,0,0,0,100/) // Bold=0
  })

  it('sets bottom alignment by default', () => {
    const result = writeAss([entry()])
    // Alignment is near end of style: ...,Alignment,MarginL,MarginR,MarginV,...
    // Default alignment=2 (bottom center)
    const styleLine = result.split('\n').find((l) => l.startsWith('Style:'))!
    const fields = styleLine.split(',')
    // Alignment is field index 18 (0-based)
    expect(fields[18]).toBe('2')
  })

  it('sets top alignment when position=top', () => {
    const result = writeAss([entry()], { position: 'top' })
    const styleLine = result.split('\n').find((l) => l.startsWith('Style:'))!
    const fields = styleLine.split(',')
    expect(fields[18]).toBe('8')
  })

  it('applies custom margins', () => {
    const result = writeAss([entry()], { marginVertical: 100, marginHorizontal: 120 })
    const styleLine = result.split('\n').find((l) => l.startsWith('Style:'))!
    const fields = styleLine.split(',')
    // MarginL, MarginR, MarginV are last 3 before Encoding
    expect(fields[19]).toBe('120') // MarginL
    expect(fields[20]).toBe('120') // MarginR
    expect(fields[21]).toBe('100') // MarginV
  })

  it('applies custom padding via Outline field', () => {
    const result = writeAss([entry()], { padding: 25 })
    const styleLine = result.split('\n').find((l) => l.startsWith('Style:'))!
    const fields = styleLine.split(',')
    // Outline is field 16 (after BorderStyle at 15)
    expect(fields[16]).toBe('25')
  })

  it('applies custom background color and opacity', () => {
    const result = writeAss([entry()], {
      backgroundColor: '#FF0000',
      backgroundOpacity: 0.5,
    })
    // BackColour should be red at 50% opacity
    // &H800000FF (80=50% transparent, BGR of FF0000 = 0000FF)
    expect(result).toContain('&H800000FF')
  })

  it('applies custom text color', () => {
    const result = writeAss([entry()], { primaryColor: '#FF0000' })
    // Primary should be red, fully opaque
    expect(result).toContain('&H000000FF')
  })

  it('respects deprecated color alias', () => {
    const result = writeAss([entry()], { color: '#00FF00' })
    // Green text
    expect(result).toContain('&H0000FF00')
  })

  it('escapes special characters in text', () => {
    const result = writeAss([entry({ text: 'Hello {world} and \\back' })])
    expect(result).toContain('Hello \\{world\\} and \\\\back')
  })

  it('converts newlines to ASS line breaks', () => {
    const result = writeAss([entry({ text: 'Line one\nLine two' })])
    expect(result).toContain('Line one\\NLine two')
  })

  it('generates multiple dialogue lines', () => {
    const entries = [
      entry({ index: 1, startMs: 0, endMs: 3000, text: 'First' }),
      entry({ index: 2, startMs: 3000, endMs: 6000, text: 'Second' }),
      entry({ index: 3, startMs: 6000, endMs: 9000, text: 'Third' }),
    ]
    const result = writeAss(entries)
    const dialogues = result.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(dialogues).toHaveLength(3)
    expect(dialogues[0]).toContain('First')
    expect(dialogues[1]).toContain('Second')
    expect(dialogues[2]).toContain('Third')
  })

  it('sets WrapStyle from config', () => {
    expect(writeAss([entry()], { wrapStyle: 'smart' })).toContain('WrapStyle: 0')
    expect(writeAss([entry()], { wrapStyle: 'endOfLine' })).toContain('WrapStyle: 1')
    expect(writeAss([entry()], { wrapStyle: 'none' })).toContain('WrapStyle: 2')
  })

  it('handles zero-ms start time', () => {
    const result = writeAss([entry({ startMs: 0 })])
    expect(result).toContain('0:00:00.00')
  })

  it('rounds negative ms to zero', () => {
    const result = writeAss([entry({ startMs: -100, endMs: 5000 })])
    expect(result).toContain('0:00:00.00')
  })
})
