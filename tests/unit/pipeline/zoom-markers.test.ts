import { describe, it, expect } from 'vitest'
import { cueForZoomMarker, moveZoomsToSpokenNarration } from '../../../src/pipeline/zoom-markers'
import type { SubtitleEntry } from '../../../src/types/subtitle'

// Two narrations, each ended by waitForNarration(), with a gap between them.
const cues = [
  { startMs: 1000, endMs: 4000 },
  { startMs: 5000, endMs: 8000 },
]

describe('cueForZoomMarker()', () => {
  it('picks the cue playing at the marker', () => {
    expect(cueForZoomMarker(cues, 2000)).toBe(cues[0])
  })

  it('picks the next cue for a marker set just before narrate()', () => {
    expect(cueForZoomMarker(cues, 4500)).toBe(cues[1])
    expect(cueForZoomMarker(cues, 500)).toBe(cues[0])
  })

  it('picks the next cue at a cue boundary', () => {
    expect(cueForZoomMarker(cues, 4000)).toBe(cues[1])
  })

  it('finds nothing after the last cue', () => {
    expect(cueForZoomMarker(cues, 9000)).toBeUndefined()
  })
})

describe('moveZoomsToSpokenNarration()', () => {
  // Narration 1 is spoken over a wait: its audio ends at 3000 but its
  // subtitle stays open until narration 2 starts at 10000.
  const setup = (zoomAt: number, ownZoomOn2 = false) => {
    const zoom = { x: 0.4, y: 0.6, level: 1.3 }
    const s1: SubtitleEntry = { index: 1, startMs: 1000, endMs: 10_000, text: 'planning', zoom: { ...zoom, startMs: zoomAt } }
    const s2: SubtitleEntry = { index: 2, startMs: 10_000, endMs: 14_000, text: 'answer', ...(ownZoomOn2 ? { zoom: { x: 0.1, y: 0.1, level: 2, startMs: 11_000 } } : {}) }
    // Silence pads narration 1's cue to 10000; the speech ends at 3000.
    const entries = [
      { subtitle: s1, outputStartMs: 1000, outputEndMs: 10_000, spokenEndMs: 3000 },
      { subtitle: s2, outputStartMs: 10_000, outputEndMs: 14_000, spokenEndMs: 14_000 },
    ]
    moveZoomsToSpokenNarration(entries)
    return { s1, s2 }
  }

  it('moves a zoom set after its narration was spoken to the next one', () => {
    const { s1, s2 } = setup(9_500)
    expect(s1.zoom).toBeUndefined()
    expect(s2.zoom).toEqual({ x: 0.4, y: 0.6, level: 1.3, startMs: 10_000 })
  })

  it('keeps a zoom set while its narration is spoken', () => {
    const { s1, s2 } = setup(2_000)
    expect(s1.zoom?.startMs).toBe(2_000)
    expect(s2.zoom).toBeUndefined()
  })

  it('leaves a narration its own zoom and drops the stale one', () => {
    const { s1, s2 } = setup(9_500, true)
    expect(s1.zoom).toBeUndefined()
    expect(s2.zoom?.level).toBe(2)
  })
})
