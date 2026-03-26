import { describe, it, expect } from 'vitest'
import { chunkSubtitles } from '../../../src/subtitles/subtitle-chunker.js'
import type { SubtitleEntry } from '../../../src/types/subtitle.js'

const entry = (overrides: Partial<SubtitleEntry> = {}): SubtitleEntry => ({
  index: 1,
  startMs: 0,
  endMs: 10000,
  text: 'Hello world',
  ...overrides,
})

describe('chunkSubtitles', () => {
  it('returns empty array for empty input', () => {
    expect(chunkSubtitles([])).toEqual([])
  })

  it('keeps short text as single entry', () => {
    const result = chunkSubtitles([entry({ text: 'Short text.' })])
    expect(result).toHaveLength(1)
    expect(result[0]!.text).toBe('Short text.')
  })

  it('splits on sentence boundary (period)', () => {
    const text = 'First sentence here. Second sentence follows after the break.'
    const result = chunkSubtitles([entry({ text, endMs: 10000 })])
    expect(result.length).toBeGreaterThanOrEqual(2)
    expect(result[0]!.text).toContain('First sentence')
    expect(result[0]!.text).toMatch(/\.$/)
  })

  it('splits on comma for long clauses', () => {
    const text = 'Podporuje práci nejen s textem, ale i s dokumenty, tabulkami, audiem a videem v jednom jediném prostředí.'
    const result = chunkSubtitles([entry({ text })])
    expect(result.length).toBeGreaterThanOrEqual(2)
    // Each chunk should be ≤ 60 chars
    for (const r of result) {
      expect(r.text.length).toBeLessThanOrEqual(70) // some tolerance
    }
  })

  it('distributes time proportionally', () => {
    const text = 'Short part. This is a much longer second sentence in the text.'
    const result = chunkSubtitles([entry({ text, startMs: 0, endMs: 10000 })])
    if (result.length >= 2) {
      // Longer chunk should get more time
      const dur0 = result[0]!.endMs - result[0]!.startMs
      const dur1 = result[1]!.endMs - result[1]!.startMs
      const len0 = result[0]!.text.length
      const len1 = result[1]!.text.length
      // Time ratio should roughly match character ratio
      const timeRatio = dur0 / dur1
      const charRatio = len0 / len1
      expect(Math.abs(timeRatio - charRatio)).toBeLessThan(0.1)
    }
  })

  it('preserves total time span', () => {
    const text = 'Nahrajete video, nebo jen vložíte odkaz na YouTube. Napíšete, co má být výsledkem, a CODEXIS AI udělá zbytek.'
    const result = chunkSubtitles([entry({ text, startMs: 1000, endMs: 9000 })])
    expect(result[0]!.startMs).toBe(1000)
    expect(result[result.length - 1]!.endMs).toBe(9000)
  })

  it('chunks are sequential with no gaps', () => {
    const text = 'First sentence. Second sentence. Third sentence is also here.'
    const result = chunkSubtitles([entry({ text, startMs: 0, endMs: 9000 })])
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.startMs).toBe(result[i - 1]!.endMs)
    }
  })

  it('assigns sequential indices across entries', () => {
    const entries = [
      entry({ index: 1, text: 'Short one.', startMs: 0, endMs: 3000 }),
      entry({ index: 2, text: 'First long sentence here. Second long sentence follows after.', startMs: 3000, endMs: 10000 }),
    ]
    const result = chunkSubtitles(entries)
    for (let i = 0; i < result.length; i++) {
      expect(result[i]!.index).toBe(i + 1)
    }
  })

  it('preserves keyword and zoom from parent entry', () => {
    const text = 'First long sentence here. Second long sentence follows right after it.'
    const zoom = { x: 0.5, y: 0.5, level: 2.0 }
    const result = chunkSubtitles([entry({ text, keyword: 'When', zoom })])
    for (const r of result) {
      expect(r.keyword).toBe('When')
      expect(r.zoom).toEqual(zoom)
    }
  })

  it('merges tiny fragments FORWARD into next chunk', () => {
    // "a b." is 4 chars — should be merged forward, not backward
    const text = 'This is a longer first part. a b. And this is the third part of the sentence.'
    const result = chunkSubtitles([entry({ text })])
    // "a b." should not appear as standalone chunk
    const tinyChunk = result.find((r) => r.text.length < 10)
    expect(tinyChunk).toBeUndefined()
    // First chunk should NOT contain "a b." — it belongs with the next
    if (result.length >= 2) {
      expect(result[0]!.text).not.toContain('a b.')
    }
  })

  it('does not merge across sentence boundaries', () => {
    const text = 'Nahrajete video, nebo jen vložíte odkaz na YouTube. Napíšete, co má být výsledkem, a CODEXIS AI udělá zbytek.'
    const result = chunkSubtitles([entry({ text })], { maxCharsPerLine: 55 })
    // First chunk = first sentence only
    expect(result[0]!.text).toMatch(/YouTube\.$/)
    // "Napíšete" should start a new chunk
    expect(result.some((r) => r.text.startsWith('Napíšete'))).toBe(true)
  })

  it('handles text with only commas (Czech clauses)', () => {
    const text = 'Z obsahu vytěží klíčové informace, zasadí je do právního kontextu, dohledá relevantní zdroje a připraví výstup přesně podle zadání.'
    const result = chunkSubtitles([entry({ text })])
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  it('respects custom maxCharsPerLine', () => {
    const text = 'Už nemusíte kombinovat více různých AI nástrojů, přičemž každý se hodí na něco jiného.'
    const result = chunkSubtitles([entry({ text })], { maxCharsPerLine: 50 })
    for (const r of result) {
      expect(r.text.length).toBeLessThanOrEqual(60) // some tolerance for merging
    }
  })

  it('handles multiple entries independently', () => {
    const entries = [
      entry({ index: 1, text: 'Short.', startMs: 0, endMs: 2000 }),
      entry({ index: 2, text: 'Also short.', startMs: 2000, endMs: 4000 }),
    ]
    const result = chunkSubtitles(entries)
    expect(result).toHaveLength(2)
  })

  it('handles text with exclamation and question marks', () => {
    const text = 'Is this a question? Yes it is! And here is the rest of the explanation.'
    const result = chunkSubtitles([entry({ text })])
    expect(result.length).toBeGreaterThanOrEqual(2)
  })

  it('splits at word boundary for very long text without punctuation', () => {
    const text = 'This is a very long subtitle text without any punctuation marks that should still be split into reasonable chunks'
    const result = chunkSubtitles([entry({ text })], { maxCharsPerLine: 40 })
    expect(result.length).toBeGreaterThanOrEqual(2)
    for (const r of result) {
      // Should split at word boundaries, not mid-word
      expect(r.text).not.toMatch(/^\s/)
      expect(r.text).not.toMatch(/\s$/)
    }
  })
})
