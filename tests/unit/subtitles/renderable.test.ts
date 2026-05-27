import { describe, it, expect } from 'vitest'
import { filterRenderableSubtitles } from '../../../src/subtitles/renderable'
import type { SubtitleEntry } from '../../../src/types/subtitle'

describe('filterRenderableSubtitles', () => {
  it('drops zero- and negative-duration entries, keeps positive ones', () => {
    const subs: SubtitleEntry[] = [
      { index: 1, startMs: 0, endMs: 0, text: 'zero' },
      { index: 2, startMs: 100, endMs: 2000, text: 'keep' },
      { index: 3, startMs: 5000, endMs: 5000, text: 'also zero' },
    ]
    expect(filterRenderableSubtitles(subs)).toEqual([
      { index: 2, startMs: 100, endMs: 2000, text: 'keep' },
    ])
  })

  it('returns all entries when every window is positive', () => {
    const subs: SubtitleEntry[] = [
      { index: 1, startMs: 0, endMs: 1000, text: 'a' },
      { index: 2, startMs: 1000, endMs: 2000, text: 'b' },
    ]
    expect(filterRenderableSubtitles(subs)).toEqual(subs)
  })
})
